const https = require("https");
const { ManagedIdentityCredential } = require("@azure/identity");
const { requestedReviewers } = require("./qualified_approval_coverage");

const endpoint = "https://sonic-elastictest-prod-scheduler-backend-webapp.azurewebsites.net/v1/task-plans/github-app";
const scope = "api://sonic-testbed-tools-prod/.default";
const pbiId = "40516754";
const maxBatchPrs = 7;
let credential;

async function submitTask(description) {
    const clientId = (process.env.ADO_MI_CLIENT_ID || "").trim();
    if (!clientId) {
        throw new Error("Set ADO_MI_CLIENT_ID to the attached managed identity client ID before submitting merge risk assessments");
    }
    if (!credential) {
        credential = new ManagedIdentityCredential({ clientId });
    }
    const token = await credential.getToken(scope);
    if (!token || !token.token) {
        throw new Error("Merge risk assessment authentication returned no access token");
    }
    const body = JSON.stringify({
        type: "MERGE_RISK_ASSESSMENT",
        pbi_id: pbiId,
        description,
    });
    await new Promise((resolve, reject) => {
        const request = https.request(endpoint, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token.token}`,
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(body),
            },
        }, response => {
            const failed = response.statusCode < 200 || response.statusCode >= 300;
            const chunks = [];
            const maxResponseBytes = 8192;
            let responseBytes = 0;
            let truncated = false;
            response.on("data", chunk => {
                if (!failed) return;
                const remaining = maxResponseBytes - responseBytes;
                if (remaining > 0) {
                    const part = chunk.subarray(0, remaining);
                    chunks.push(part);
                    responseBytes += part.length;
                }
                if (chunk.length > remaining) truncated = true;
            });
            response.on("error", reject);
            response.on("aborted", () => reject(new Error("Merge risk assessment response aborted")));
            response.on("end", () => {
                if (failed) {
                    const detail = Buffer.concat(chunks).toString("utf8")
                        .split(token.token).join("[REDACTED]").replace(/[\r\n]+/g, " ").trim();
                    reject(new Error(`Merge risk assessment request failed with HTTP ${response.statusCode}` +
                        (detail ? `: ${detail}` : " (empty response body)") +
                        (truncated ? " [response truncated at 8192 bytes]" : "")));
                    return;
                }
                resolve();
            });
            response.resume();
        });
        request.setTimeout(60000, () => {
            request.destroy(new Error("Merge risk assessment request timed out; submission status is unknown"));
        });
        request.on("error", reject);
        request.end(body);
    });
}

async function needsSubmission(octokit, owner, repo, pr) {
    const issue = { owner, repo, issue_number: pr.number };
    const marker = `<!-- sonic-merge-risk-assessment:${pr.head.sha} -->`;
    const comments = await octokit.paginate(octokit.rest.issues.listComments, { ...issue, per_page: 100 });
    if (comments.some(comment => comment.user && comment.user.login.toLowerCase() === "mssonicbld" &&
        (comment.body || "").split("\n").includes(marker))) {
        return false;
    }
    const { data: current } = await octokit.rest.pulls.get({ owner, repo, pull_number: pr.number });
    if (current.state !== "open" || current.head.sha !== pr.head.sha ||
        current.base.sha !== pr.base.sha || current.base.ref !== pr.base.ref ||
        requestedReviewers(current).join(",") !== requestedReviewers(pr).join(",")) {
        throw new Error("PR changed before submitting merge risk assessment; skipping stale request");
    }
    return true;
}

async function submitBatch(octokit, candidates, log = console) {
    const pending = [];
    const seen = new Set();
    for (const candidate of candidates) {
        const { owner, repo, pr } = candidate;
        const key = `${owner}/${repo}#${pr.number}`.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        if (await needsSubmission(octokit, owner, repo, pr)) {
            pending.push(candidate);
            if (pending.length === maxBatchPrs) break;
        }
    }
    if (!pending.length) return;
    await submitTask(pending.map(({ owner, repo, pr }) =>
        `Assess merge risk for https://github.com/${owner}/${repo}/pull/${pr.number} at head commit ${pr.head.sha}.`,
    ).join("\n"));
    const receipts = await Promise.allSettled(pending.map(async ({ owner, repo, pr }) => {
        log.info(`[ MERGE RISK ASSESSMENT ] ${owner}/${repo}#${pr.number}: submitted head ${pr.head.sha}, PBI ${pbiId}`);
        await octokit.rest.issues.createComment({
            owner, repo, issue_number: pr.number,
            body: `<!-- sonic-merge-risk-assessment:${pr.head.sha} -->\nMerge risk assessment requested for head commit \`${pr.head.sha}\`. This confirms submission only, not completion or approval to merge.`,
        });
    }));
    const failures = receipts.filter(result => result.status === "rejected");
    if (failures.length) {
        throw new Error(`Merge risk assessment receipt writes failed: ${failures.map(result => result.reason).join("; ")}`);
    }
}

async function submit(octokit, owner, repo, pr, log = console) {
    return submitBatch(octokit, [{ owner, repo, pr }], log);
}

module.exports = Object.freeze({ submit, submitBatch });
