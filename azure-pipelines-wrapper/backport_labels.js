const { Octokit } = require("@octokit/rest");
const akv = require("./keyvault");
const actionQueue = require("./action_queue");
const repos = ["sonic-net/sonic-utilities", "sonic-net/sonic-swss", "sonic-net/sonic-sairedis", "sonic-net/sonic-swss-common", "sonic-net/sonic-dbsyncd", "sonic-net/sonic-gnmi", "sonic-net/sonic-host-services",
              "sonic-net/sonic-linkmgrd", "sonic-net/sonic-linux-kernel", "sonic-net/sonic-mgmt-common", "sonic-net/sonic-mgmt-framework", "sonic-net/sonic-platform-common", "sonic-net/sonic-platform-daemons",
              "sonic-net/sonic-py-swsssdk", "sonic-net/sonic-restapi", "sonic-net/sonic-snmpagent", "sonic-net/sonic-wpa-supplicant", "sonic-net/sonic-buildimage", "sonic-net/sonic-ztp", "sonic-net/sonic-dhcp-relay",
              "sonic-net/sonic-mgmt", "sonic-net/sonic-dhcpmon", "sonic-net/sonic-dash-api", "sonic-net/sonic-dash-ha", "sonic-net/sonic-bmp", "sonic-net/sonic-stp", "sonic-net/sonic-platform-vpp", "sonic-net/sonic-redfish"];
const labelPattern = /^(Request|Tested) for ((?:msft-)?\d{6}) Branch$/i;
const watermark = '<div align="right"><sub>---Powered by SONiC BuildBot</sub></div>';

function section(body, heading) {
    const lines = body.split(/\r?\n/);
    const start = lines.findIndex(line => /^#{3,}/.test(line) && heading.test(line));
    if (start === -1) {
        return "";
    }
    const end = lines.findIndex((line, index) => index > start && /^#{3,}/.test(line));
    return lines.slice(start + 1, end === -1 ? undefined : end).join("\n");
}

function branches(text, pattern) {
    const result = new Set();
    let match;
    while ((match = pattern.exec(text)) !== null) {
        result.add(match[1]);
    }
    return result;
}

function parseBody(body) {
    const visible = (body || "").replace(/<!--[\s\S]*?(?:-->|$)/g, "");
    const requested = branches(section(visible, /back\s?port/i),
        /^\s*(?:-\s*\[[xX]\]\s*)?(\d{6})\s*$/gm);
    const checked = branches(section(visible, /tested branch/i),
        /^\s*-\s*\[[xX]\]\s*(?:msft-)?(\d{6})(?=\s|$)/gm);
    const results = section(visible, /test result/i);
    const tested = new Set();
    const entries = results.split(/(?=^[ \t]*(?:[-*][ \t]+)?(?:msft-)?\d{6}\b)/m);
    for (const entry of entries) {
        const match = entry.match(/^[ \t]*(?:[-*][ \t]+)?(?:msft-)?(\d{6})\b[ \t]*:?[ \t]*([\s\S]*)$/);
        if (!match || !checked.has(match[1])) {
            continue;
        }
        const evidence = match[2]
            .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
            .replace(/<(?!https?:\/\/)[^>]*>/gi, "")
            .replace(/^[ \t]*```[^\r\n]*$/gm, "")
            .replace(/[`*_]/g, "").trim();
        if (/[\p{L}\p{N}]/u.test(evidence) &&
            !/^(?:todo|tbd|tba|n\/a|pending|not tested|link to test results or summary with logs)[.!]?$/i.test(evidence)) {
            tested.add(match[1]);
        }
    }
    return { requested, tested };
}

function branchName(branch) {
    return /(?:05|11)$/.test(branch) ? branch : `msft-${branch}`;
}

async function sync(octokit, owner, repo, number) {
    const params = { owner, repo, issue_number: number };
    const { data: pr } = await octokit.rest.pulls.get({
        owner, repo, pull_number: number,
    });
    const currentLabels = await octokit.paginate(
        octokit.rest.issues.listLabelsOnIssue, { ...params, per_page: 100 },
    );
    const labels = new Map(currentLabels.map(label => [label.name.toLowerCase(), label.name]));
    const managed = currentLabels.filter(label => labelPattern.test(label.name));
    const owned = new Set();
    if (managed.length) {
        const events = await octokit.paginate(
            octokit.rest.issues.listEvents, { ...params, per_page: 100 },
        );
        // A later manual application supersedes an earlier bot application.
        for (const event of events) {
            if (!["labeled", "unlabeled"].includes(event.event) || !event.label) {
                continue;
            }
            const name = event.label.name.toLowerCase();
            owned.delete(name);
            if (event.event === "labeled" && event.actor && event.actor.login === "mssonicbld") {
                owned.add(name);
            }
        }
    }

    const eligible = (pr.state === "open" || pr.merged) &&
        ["main", "master"].includes(pr.base.ref) && pr.user.login !== "mssonicbld";
    const parsed = parseBody(eligible ? pr.body : "");
    const remove = new Map();
    const removedForMissingTests = new Set();
    for (const { name } of managed) {
        const [, kind, branch] = name.match(labelPattern);
        const raw = branch.replace(/^msft-/i, "");
        if (eligible && owned.has(name.toLowerCase())) {
            if (!parsed.requested.has(raw)) {
                remove.set(name, `Branch \`${raw}\` is no longer listed in the **Backport** section of the PR description. Add it back there if you still need this backport.`);
            } else if (kind.toLowerCase() === "tested" && !parsed.tested.has(raw)) {
                remove.set(name, `Branch \`${raw}\` no longer has both a checked checkbox in **Tested branch** and branch-specific evidence in **Test result**.`);
            }
        }
    }
    const testedToAdd = [];
    for (const raw of parsed.requested) {
        const name = `Tested for ${branchName(raw)} Branch`;
        if (parsed.tested.has(raw) && !labels.has(name.toLowerCase())) {
            testedToAdd.push(name);
        }
    }
    if (testedToAdd.length) {
        await octokit.rest.issues.addLabels({ ...params, labels: testedToAdd });
        testedToAdd.forEach(name => labels.set(name.toLowerCase(), name));
    }
    for (const { name } of managed) {
        const [, kind, branch] = name.match(labelPattern);
        if (kind.toLowerCase() === "request") {
            const tested = labels.get(`tested for ${branch} branch`.toLowerCase());
            if ((!tested || remove.has(tested)) && !remove.has(name)) {
                const prerequisite = tested || `Tested for ${branch} Branch`;
                const reason = tested
                    ? `The matching \`${prerequisite}\` label is also being removed for the reason listed below.`
                    : `The matching \`${prerequisite}\` label is missing. This requirement also applies to manually added request labels.`;
                const raw = branch.replace(/^msft-/i, "");
                remove.set(name, reason);
                if (!parsed.tested.has(raw)) {
                    removedForMissingTests.add(raw);
                }
            }
        }
    }
    // Remove requests before removing the tested labels they depend on.
    const removed = [...remove.keys()].sort((a, b) =>
        Number(/^Tested/i.test(a)) - Number(/^Tested/i.test(b)));
    for (const name of removed) {
        await octokit.rest.issues.removeLabel({ ...params, name });
        labels.delete(name.toLowerCase());
    }

    const requestsToAdd = [];
    const missing = new Set(removedForMissingTests);
    for (const raw of parsed.requested) {
        const branch = branchName(raw);
        if (!labels.has(`tested for ${branch} branch`.toLowerCase())) {
            missing.add(raw);
        } else if (!["Request for", "Included in", "Created PR to"].some(prefix =>
            labels.has(`${prefix} ${branch} Branch`.toLowerCase()))) {
            requestsToAdd.push(`Request for ${branch} Branch`);
        }
    }
    if (requestsToAdd.length) {
        await octokit.rest.issues.addLabels({ ...params, labels: requestsToAdd });
    }

    const messages = [];
    if (testedToAdd.length) {
        messages.push(`Added tested label(s): ${testedToAdd.join(", ")}. The corresponding branches are checked in the **Tested branch** section and have branch-specific test information in the **Test result** section of the PR description.`);
    }
    if (requestsToAdd.length) {
        messages.push(`Added request label(s): ${requestsToAdd.join(", ")}. These branches are requested in the **Backport** section of the PR description, and their matching **Tested for** labels are now present.`);
    }
    if (removed.length) {
        messages.push([
            "Removed label(s):",
            ...removed.map(name => `- \`${name}\`: ${remove.get(name)}`),
        ].join("\n"));
    }
    if (missing.size) {
        const comments = await octokit.paginate(
            octokit.rest.issues.listComments, { ...params, per_page: 100 },
        );
        const reminded = new Set();
        for (const comment of comments) {
            if (!comment.user || comment.user.login !== "mssonicbld") {
                continue;
            }
            const reminder = (comment.body || "").match(/^This PR (?:requests backports|has backport request label\(s\)) for branch\(es\): ((?:msft-)?\d{6}(?:,\s*(?:msft-)?\d{6})*), but is missing required test information\./im);
            if (reminder) {
                reminder[1].split(/,\s*/).forEach(branch => reminded.add(branch.replace(/^msft-/i, "")));
            }
        }
        const uncovered = [...missing].filter(branch =>
            removedForMissingTests.has(branch) || !reminded.has(branch));
        if (uncovered.length) {
            messages.push([
                `This PR requests backports for branch(es): ${uncovered.join(", ")}, but is missing required test information.`,
                "",
                "**Update the PR description, not a PR comment:**",
                "1. List each requested branch under **Backport**.",
                "2. After testing on each branch, tick its checkbox (`- [x]`) under **Tested branch**. An unchecked box (`- [ ]`) does not count.",
                "3. Under **Test result**, start a separate entry with each branch number, followed by its test evidence on the same line or the following lines, such as a test-run link or a summary with logs. A branch number alone, placeholders, and results for another branch do not count.",
                "",
                "Please make sure you have done all three steps above.",
                "Example format for the branches above (replace every placeholder with your actual test evidence; only check branches you have tested):",
                "```markdown",
                "### Backport",
                ...uncovered,
                "",
                "### Tested branch",
                ...uncovered.map(branch => `- [x] ${branch}`),
                "",
                "### Test result",
                ...uncovered.map(branch => `${branch}: <link to test results or summary with logs>`),
                "```",
                "",
                "Keep this information outside HTML comments (`<!-- ... -->`) so it can be read.",
                "After you save the PR description, I will check it again and add the matching `Tested for <branch> Branch` labels first, then the `Request for <branch> Branch` labels. Request labels remain blocked until their matching tested labels are present.",
            ].join("\n"));
        }
    }
    if (messages.length) {
        await octokit.rest.issues.createComment({
            ...params, body: `${messages.join("\n\n")}\n\n${watermark}`,
        });
    }
}

function init(app) {
    app.on([
        "pull_request.opened", "pull_request.edited", "pull_request.reopened",
        "pull_request.synchronize", "pull_request.closed",
        "pull_request.labeled", "pull_request.unlabeled",
    ], async context => {
        const { repository, number, action, label, changes, pull_request: pr } = context.payload;
        if (!repos.includes(repository.full_name) ||
            (action === "closed" && !pr.merged) ||
            (action === "edited" && changes && !changes.body && !changes.base) ||
            (["labeled", "unlabeled"].includes(action) && !labelPattern.test(label.name))) {
            return;
        }
        actionQueue.enqueueAction(async () => {
            const token = await akv.getGithubToken();
            const octokit = new Octokit({ auth: token });
            await sync(octokit, repository.owner.login, repository.name, number);
        }, `backport labels ${repository.full_name}#${number}`, app);
    });
}

module.exports = Object.freeze({ init, sync });
