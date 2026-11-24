const { Octokit } = require("@octokit/rest");
const { parseMapping, coverage, qualifiedApprovalLabel, requestedReviewers, currentApprovers } = require("./qualified_approval_coverage");
const akv = require("./keyvault");
const actionQueue = require("./action_queue");
const { loadCodeowners } = require("./codeowners");
const { planAssignments } = require("./reviewer_assignment");
const { loadReviewerAccess, loadAdminApprovers } = require("./reviewer_access");
const mergeRiskAssessment = require("./merge_risk_assessment");

const repos = new Set([
    "sonic-net/sonic-bmp",
    "sonic-net/sonic-buildimage",
    "sonic-net/sonic-dash-api",
    "sonic-net/sonic-dash-ha",
    "sonic-net/sonic-dbsyncd",
    "sonic-net/sonic-dhcp-relay",
    "sonic-net/sonic-dhcpmon",
    "sonic-net/sonic-fips",
    "sonic-net/sonic-genl-packet",
    "sonic-net/sonic-gnmi",
    "sonic-net/sonic-host-services",
    "sonic-net/sonic-linkmgrd",
    "sonic-net/sonic-linux-kernel",
    "sonic-net/sonic-mgmt",
    "sonic-net/sonic-mgmt-common",
    "sonic-net/sonic-mgmt-framework",
    "sonic-net/sonic-platform-common",
    "sonic-net/sonic-platform-daemons",
    "sonic-net/sonic-platform-vpp",
    "sonic-net/sonic-py-swsssdk",
    "sonic-net/sonic-redfish",
    "sonic-net/sonic-restapi",
    "sonic-net/sonic-sairedis",
    "sonic-net/sonic-snmpagent",
    "sonic-net/sonic-stp",
    "sonic-net/sonic-swss",
    "sonic-net/sonic-swss-common",
    "sonic-net/sonic-utilities",
    "sonic-net/sonic-wpa-supplicant",
    "sonic-net/sonic-ztp",
]);
const mappingRepo = { owner: "sonic-net", repo: "sonic-tsc", ref: "master" };

async function removeBotAutomerge(octokit, owner, repo, number, log) {
    const params = { owner, repo, pull_number: number };
    const candidate = pr => {
        if (pr.state !== "open" || pr.base.ref !== "master" ||
            (pr.labels || []).some(label => label.name.toLowerCase() === qualifiedApprovalLabel.toLowerCase())) {
            return null;
        }
        return (pr.labels || []).find(label => label.name.toLowerCase() === "automerge");
    };
    const { data: pr } = await octokit.rest.pulls.get(params);
    if (!candidate(pr)) return;
    const issue = { owner, repo, issue_number: number };
    const events = await octokit.paginate(octokit.rest.issues.listEvents, { ...issue, per_page: 100 });
    const latest = events.filter(event =>
        ["labeled", "unlabeled"].includes(event.event) &&
        event.label && event.label.name.toLowerCase() === "automerge")
        .reduce((latest, event) => !latest || event.id > latest.id ? event : latest, null);
    if (!latest || latest.event !== "labeled" || !latest.actor ||
        latest.actor.login.toLowerCase() !== "mssonicbld") {
        log.info(`[ QUALIFIED APPROVAL ] ${owner}/${repo}#${number}: preserved automerge; latest addition is not confirmed as mssonicbld`);
        return;
    }
    const { data: current } = await octokit.rest.pulls.get(params);
    const label = candidate(current);
    if (!label) return;
    await octokit.rest.issues.removeLabel({ ...issue, name: label.name });
    log.info(`[ QUALIFIED APPROVAL ] ${owner}/${repo}#${number}: removed bot-added ${label.name} without ${qualifiedApprovalLabel}`);
}

async function sync(octokit, owner, repo, number, assign = false, log = console, comment = !assign) {
    const params = { owner, repo, pull_number: number };
    const { data: pr } = await octokit.rest.pulls.get(params);
    if (pr.state !== "open" || pr.base.ref !== "master") {
        return;
    }
    const mappingPath = `pr_reviewer/${repo}/pr_reviewer-by-files.yml`;
    const [{ data: source }, files, reviews, codeowners] = await Promise.all([
        octokit.rest.repos.getContent({ ...mappingRepo, path: mappingPath }),
        octokit.paginate(octokit.rest.pulls.listFiles, { ...params, per_page: 100 }),
        octokit.paginate(octokit.rest.pulls.listReviews, { ...params, per_page: 100 }),
        loadCodeowners(octokit, owner, repo, pr.base.sha, log),
    ]);
    if (source.type !== "file" || source.encoding !== "base64" || !source.content) {
        throw new Error(`Reviewer mapping is not a readable file: ${mappingPath}`);
    }
    const mapping = parseMapping(Buffer.from(source.content, "base64").toString("utf8"));
    const mappingLink = `https://github.com/${mappingRepo.owner}/${mappingRepo.repo}/blob/${mappingRepo.ref}/${mappingPath}`;
    const admins = await loadAdminApprovers(octokit, owner, repo, currentApprovers(reviews, pr));
    const result = coverage(files, mapping, reviews, pr, mappingLink, codeowners, admins);
    async function freshPull() {
        const { data: current } = await octokit.rest.pulls.get(params);
        if (current.state !== "open" || current.head.sha !== pr.head.sha ||
            current.base.sha !== pr.base.sha || current.base.ref !== pr.base.ref ||
            requestedReviewers(current).join(",") !== requestedReviewers(pr).join(",")) {
            throw new Error("PR changed while calculating qualified approval coverage; skipping stale summary");
        }
        return current;
    }
    let current = await freshPull();
    if (comment && result.body.length > 60000) {
        throw new Error("Qualified approval summary exceeds the comment size limit");
    }
    const label = (current.labels || []).find(item => item.name.toLowerCase() === qualifiedApprovalLabel.toLowerCase());
    const issue = { owner, repo, issue_number: number };
    if (result.qualified && !label) {
        await octokit.rest.issues.addLabels({ ...issue, labels: [qualifiedApprovalLabel] });
        log.info(`[ QUALIFIED APPROVAL ] ${owner}/${repo}#${number}: added ${qualifiedApprovalLabel}`);
    } else if (!result.qualified && label) {
        await octokit.rest.issues.removeLabel({ ...issue, name: label.name });
        log.info(`[ QUALIFIED APPROVAL ] ${owner}/${repo}#${number}: removed ${qualifiedApprovalLabel}`);
    }
    if (!result.qualified && label && (current.labels || []).some(label => label.name.toLowerCase() === "automerge")) {
        await removeBotAutomerge(octokit, owner, repo, number, log);
    }
    let plan = null;
    if (assign && !current.draft) {
        const access = await loadReviewerAccess(octokit, owner, repo, codeowners, log);
        current = await freshPull();
        if (!current.draft) {
            plan = planAssignments(files, mapping, reviews, current, codeowners, Math.random, access, admins);
        }
    }
    if (plan) {
        const label = `${owner}/${repo}#${number}`;
        if (plan.excluded.length) {
            log.warn(`[ REVIEWER ASSIGNMENT ] ${label}: excluded non-collaborators: ${plan.excluded.join(", ")}`);
        }
        log.info(`[ REVIEWER ASSIGNMENT ] ${label}: reviewers=${JSON.stringify(plan.reviewers)}, teams=${JSON.stringify(plan.team_reviewers)}, total=${plan.requestedTotal}`);
        if (plan.reviewers.length || plan.team_reviewers.length) {
            await octokit.rest.pulls.requestReviewers({
                ...params, reviewers: plan.reviewers, team_reviewers: plan.team_reviewers,
            });
            log.info(`[ REVIEWER ASSIGNMENT ] ${label}: review requests accepted`);
        } else {
            log.info(`[ REVIEWER ASSIGNMENT ] ${label}: no new review requests needed or eligible`);
        }
        if (plan.rows.length && plan.requestedTotal < 3) {
            log.warn(`[ REVIEWER ASSIGNMENT ] ${label}: fewer than three eligible review requests available`);
        }
    }
    if (comment) {
        await octokit.rest.issues.createComment({ ...issue, body: result.body });
    }
    if (result.qualified) {
        await mergeRiskAssessment.submit(octokit, owner, repo, current, log);
    }
}

function init(app) {
    app.on([
        "pull_request_review.submitted",
        "pull_request_review.dismissed",
        "pull_request.opened", "pull_request.reopened", "pull_request.synchronize",
        "pull_request.edited",
        "pull_request.ready_for_review",
        "pull_request.review_requested", "pull_request.review_request_removed",
        "pull_request.unlabeled",
    ], async context => {
        const { repository, pull_request: pr, action, changes, review } = context.payload;
        const assign = ["opened", "reopened", "ready_for_review", "synchronize"].includes(action) ||
            (action === "edited" && Boolean(changes && changes.base));
        const approval = action === "submitted" && review && review.state.toUpperCase() === "APPROVED";
        const lostApproval = action === "dismissed" ||
            (action === "submitted" && review && review.state.toUpperCase() === "CHANGES_REQUESTED");
        const reviewRequestChanged = action === "review_requested" || action === "review_request_removed";
        const qualificationRemoved = action === "unlabeled" && context.payload.label &&
            context.payload.label.name.toLowerCase() === qualifiedApprovalLabel.toLowerCase();
        if (!repos.has(repository.full_name) || pr.state !== "open" || pr.base.ref !== "master" ||
            (!assign && !approval && !lostApproval && !reviewRequestChanged && !qualificationRemoved)) {
            return;
        }
        return actionQueue.enqueueAction(async () => {
            const token = await akv.getGithubToken();
            const octokit = new Octokit({ auth: token });
            if (qualificationRemoved) {
                await removeBotAutomerge(octokit, repository.owner.login, repository.name, pr.number, app.log);
            } else {
                await sync(octokit, repository.owner.login, repository.name, pr.number, assign, app.log, approval);
            }
        }, `qualified approvals ${repository.full_name}#${pr.number}`, app);
    });
}

module.exports = Object.freeze({ init, sync });
