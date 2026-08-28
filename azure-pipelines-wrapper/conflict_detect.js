const { Octokit } = require('@octokit/rest');
const util = require('util');
const actionQueue = require('./action_queue');
const eventhub = require('./eventhub');
const akv = require('./keyvault');
const adoauth = require('./adoauth');
const { EmailClient } = require("@azure/communication-email");
const InProgress = 'in_progress'
const MsConflict = 'ms_conflict'
const MsChecker = 'ms_checker'
const { v4: uuidv4 } = require('uuid');
const COMPLETED = 'completed'
const FAILURE = 'failure'
const SUCCESS = 'success'
const AUTO_COMMENT_DELAY_MS = 10000
const AUTO_COMMENT_RETRY_DELAY_MS = 1000
const STALE_COMMENT_RETRY_DELAY_MS = 15000
const SENT_AUTO_COMMENT_TTL_MS = 5 * 60 * 1000
const AZURE_PIPELINES_STALE_MESSAGE =
    'pull request was updated after the run command was issued'
const pending_auto_comments = new Map()
const sent_auto_comments = new Map()

function delay(ms) {
    return new Promise(resolve => global.setTimeout(resolve, ms))
}

async function get_current_pull_request(octokit, params, app, label) {
    try {
        return await octokit.rest.pulls.get(params)
    } catch (error) {
        app.log.error(`[ AUTO COMMENT ] Failed to refresh ${label}, retrying: ${error}`)
        await delay(AUTO_COMMENT_RETRY_DELAY_MS)
        return octokit.rest.pulls.get(params)
    }
}

function auto_comment_label(owner, repo, issue_number) {
    return `${owner}/${repo}#${issue_number}`
}

function remember_sent_auto_comment(label, comment) {
    const now = Date.now()
    for (const [key, value] of sent_auto_comments) {
        if (now - value.sent_at >= SENT_AUTO_COMMENT_TTL_MS) {
            sent_auto_comments.delete(key)
        }
    }
    const previous = sent_auto_comments.get(label)
    const same_revision = previous &&
        previous.expected_head_sha === comment.expected_head_sha &&
        previous.expected_base_sha === comment.expected_base_sha
    sent_auto_comments.set(label, {
        ...comment,
        retry_used: comment.is_retry ||
            Boolean(same_revision && previous.retry_used),
        retry_scheduled: Boolean(!comment.is_retry &&
            same_revision &&
            previous.retry_scheduled),
        sent_at: now,
    })
}

function is_conflicting(pull_request) {
    return pull_request.data.mergeable === false ||
        pull_request.data.mergeable_state === 'dirty'
}

async function validation_started_after(
    octokit,
    owner,
    repo,
    head_sha,
    started_after
) {
    const params = {
        owner,
        repo,
        ref: head_sha,
        per_page: 100,
    }
    const response = await octokit.rest.checks.listForRef(params)
    const retry_time = Date.parse(started_after)
    return response.data.check_runs.some(check => {
        const started_at = Date.parse(check.started_at)
        return check.app &&
            check.app.slug === 'azure-pipelines' &&
            check.conclusion !== 'action_required' &&
            Number.isFinite(started_at) &&
            started_at >= retry_time
    })
}

async function post_validation_comment(
    app,
    owner,
    repo,
    issue_number,
    body,
    expected_head_sha,
    expected_base_sha,
    is_retry,
    retry_started_after
) {
    const gh_token = await akv.getGithubToken()
    const octokit = new Octokit({
        auth: gh_token,
    })
    const label = `${repo}#${issue_number}`
    const pull_request_params = {
        owner,
        repo,
        pull_number: issue_number,
    }
    const current_pull_request = await get_current_pull_request(
        octokit,
        pull_request_params,
        app,
        label
    )
    if (current_pull_request.data.state !== 'open') {
        app.log.info(
            `[ AUTO COMMENT ] Skip ${label}: PR is ${current_pull_request.data.state}`
        )
        return
    }
    if (current_pull_request.data.head.sha !== expected_head_sha) {
        app.log.info(
            `[ AUTO COMMENT ] Skip stale event for ${label}: ` +
            `expected ${expected_head_sha}, current ${current_pull_request.data.head.sha}`
        )
        return
    }
    if (expected_base_sha &&
        current_pull_request.data.base &&
        current_pull_request.data.base.sha !== expected_base_sha) {
        app.log.info(
            `[ AUTO COMMENT ] Skip stale base for ${label}: ` +
            `expected ${expected_base_sha}, current ${current_pull_request.data.base.sha}`
        )
        return
    }
    if (is_conflicting(current_pull_request)) {
        app.log.info(`[ AUTO COMMENT ] Skip ${label}: PR has merge conflicts`)
        return
    }
    if (is_retry && await validation_started_after(
        octokit,
        owner,
        repo,
        expected_head_sha,
        retry_started_after
    )) {
        app.log.info(`[ AUTO COMMENT ] Skip retry for ${label}: validation already started`)
        return
    }
    const response = await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number,
        body,
    })
    remember_sent_auto_comment(auto_comment_label(owner, repo, issue_number), {
        body,
        expected_head_sha,
        expected_base_sha,
        is_retry,
    })
    app.log.info(`[ AUTO COMMENT ] Comment created: ${response.data}`)
}

function schedule_validation_comment(
    app,
    owner,
    repo,
    issue_number,
    body,
    expected_head_sha,
    expected_base_sha,
    delay_ms = AUTO_COMMENT_DELAY_MS,
    is_retry = false,
    retry_started_after = null
) {
    const attempt = is_retry ? 'retry' : 'initial'
    const key = `${auto_comment_label(owner, repo, issue_number)}` +
        `@${expected_head_sha}:${expected_base_sha}:${attempt}`
    if (pending_auto_comments.has(key)) {
        app.log.info(`[ AUTO COMMENT ] Already scheduled ${key}`)
        return
    }

    const timer = global.setTimeout(() => {
        post_validation_comment(
            app,
            owner,
            repo,
            issue_number,
            body,
            expected_head_sha,
            expected_base_sha,
            is_retry,
            retry_started_after
        ).catch(error => {
            app.log.error(`[ AUTO COMMENT ] Comment error: ${error}`)
        }).finally(() => {
            pending_auto_comments.delete(key)
        })
    }, delay_ms)
    pending_auto_comments.set(key, timer)
}

function is_azure_pipelines_stale_comment(payload) {
    if (!payload.comment || !payload.comment.user) {
        return false
    }
    const login = payload.comment.user.login
    return (login === 'azure-pipelines' || login === 'azure-pipelines[bot]') &&
        payload.comment.body.toLowerCase().includes(AZURE_PIPELINES_STALE_MESSAGE)
}

function schedule_stale_comment_retry(app, owner, repo, payload) {
    const issue_number = payload.issue.number.toString()
    const label = auto_comment_label(owner, repo, issue_number)
    const sent_comment = sent_auto_comments.get(label)
    if (!sent_comment ||
        Date.now() - sent_comment.sent_at >= SENT_AUTO_COMMENT_TTL_MS) {
        sent_auto_comments.delete(label)
        app.log.info(`[ AUTO COMMENT ] Skip stale retry for ${label}: no matching auto comment`)
        return
    }
    if (sent_comment.retry_used || sent_comment.retry_scheduled) {
        app.log.info(`[ AUTO COMMENT ] Skip stale retry for ${label}: retry already used`)
        return
    }

    sent_comment.retry_scheduled = true
    schedule_validation_comment(
        app,
        owner,
        repo,
        issue_number,
        sent_comment.body,
        sent_comment.expected_head_sha,
        sent_comment.expected_base_sha,
        STALE_COMMENT_RETRY_DELAY_MS,
        true,
        payload.comment.created_at
    )
    app.log.info(`[ AUTO COMMENT ] Scheduled stale retry for ${label}`)
}

async function is_msft_user(octokit, username) {
    // Check Microsoft GitHub org membership using the bot token
    try {
        const resp = await octokit.rest.orgs.checkMembershipForUser({
            org: 'microsoft',
            username,
        });
        // 204 = member, 302 = not a member (redirect)
        if (resp.status === 204) return true;
    } catch (e) {
        // 404 = not a member, or token lacks org:read scope
    }    

    // Check public GitHub email
    try {
        const { data } = await octokit.rest.users.getByUsername({ username });
        if (data.email && data.email.toLowerCase().endsWith('@microsoft.com')) return true;
    } catch (e) {
        // Fall through
    }

    // Check commit emails
    try {
        const { data: searchResult } = await octokit.rest.search.commits({
            q: `author:${username}`,
            sort: 'author-date',
            order: 'desc',
            per_page: 10,
        });
        for (const item of searchResult.items) {
            const email = item.commit && item.commit.author && item.commit.author.email;
            if (email && email.toLowerCase().endsWith('@microsoft.com')) {
                return true;
            }
            if (item.commit && item.commit.message) {
                const signOffMatch = item.commit.message.match(/Signed-off-by:.*<([^>]+)>/gi);
                if (signOffMatch) {
                    for (const line of signOffMatch) {
                        const emailMatch = line.match(/<([^>]+)>/);
                        if (emailMatch && emailMatch[1].toLowerCase().endsWith('@microsoft.com')) {
                            return true;
                        }
                    }
                }
            }
        }
    } catch (e) {
        // Fall through
    }

    return false;
}

async function send_conflict_email(app, uuid, url, number, owner, mspr, conflict_ai_result, conflict_ai_description) {
    try {
        const acs_connection_string = await akv.getSecretFromCache("ACS_EMAIL_CONNECTION_STRING");
        const sender_email = await akv.getSecretFromCache("CONFLICT_EMAIL_SENDER");
        const notification_email = await akv.getSecretFromCache("CONFLICT_NOTIFICATION_EMAIL");

        if (!acs_connection_string || !notification_email || !sender_email) {
            app.log.error(`[ CONFLICT DETECT ] [${uuid}] Missing email configuration: ` +
                `ACS_EMAIL_CONNECTION_STRING=${!!acs_connection_string}, NOTIFICATION_EMAIL=${!!notification_email}, CONFLICT_EMAIL_SENDER=${!!sender_email}`);
            return;
        }

        const email_client = new EmailClient(acs_connection_string);

        const message = {
            senderAddress: sender_email,
            recipients: {
                to: notification_email.split(',').map(e => ({ address: e.trim() })),
            },
            content: {
                subject: `[CODE CONFLICT] Code Conflict Detected - PR #${number}`,
                plainText: [
                    `A code conflict has been detected for an approved community PR.`,
                    ``,
                    `PR #${number}: ${url}`,
                    `PR Owner: ${owner}`,
                    `MS Internal PR: ${mspr}`,
                    ``,
                    `The community PR is conflict with the MS internal repo.`,
                    `Please resolve this conflict in the internal branch: sonicbld/precheck/head/${number}`,
                    ``,
                    `${conflict_ai_result}`,
                    `${conflict_ai_description}`,
                    `If the fix commit pushed by Copilot does not correctly resolve the conflict or Copilot failed to push a fix commit, Please follow these steps to resolve:`,
                    `1. Go to Networking-acs-buildimage repo: https://dev.azure.com/msazure/One/_git/Networking-acs-buildimage and "git fetch origin"`,
                    `2. Checkout the branch: "git checkout sonicbld/precheck/head/${number}"`,
                    `3. Resolve the conflict manually and push the fix commit to the same branch`,
                    `4. Approve the MS internal PR ${mspr}`,
                    `5. Comment "/azpw ms_conflict" in the original GitHub PR to trigger MS conflict detect again`,
                ].join('\n'),
                html: [
                    `<h3>Code Conflict Detected - Community PR</h3>`,
                    `<p>A code conflict has been detected for an approved community PR.</p>`,
                    `<table border="0" cellpadding="4">`,
                    `<tr><td><strong>PR</strong></td><td><a href="${url}">#${number}</a></td></tr>`,
                    `<tr><td><strong>PR Owner</strong></td><td>${owner}</td></tr>`,
                    `<tr><td><strong>MS Internal PR</strong></td><td><a href="${mspr}">${mspr}</a></td></tr>`,
                    `</table>`,
                    `<p>The community PR is conflict with the MS internal repo.<br>`,
                    `Please resolve this conflict in the internal branch: <code>sonicbld/precheck/head/${number}</code></p>`,
                    `<p>${conflict_ai_result.replace(/\n/g, '<br>')}</p>`,
                    `<p>${conflict_ai_description.replace(/\n/g, '<br>')}</p>`,
                    `<h4>If the fix commit pushed by Copilot does not correctly resolve the conflict or Copilot failed to push a fix commit, Please follow these steps to resolve::</h4>`,
                    `<ol>`,
                    `<li>Go to <a href="https://dev.azure.com/msazure/One/_git/Networking-acs-buildimage">Networking-acs-buildimage repo</a> and <code>git fetch origin</code></li>`,
                    `<li>Checkout the branch: <code>git checkout sonicbld/precheck/head/${number}</code></li>`,
                    `<li>Resolve the conflict manually and push the fix commit to the same branch</li>`,
                    `<li>Approve the MS internal PR <a href="${mspr}">${mspr}</a></li>`,
                    `<li>Comment <code>/azpw ms_conflict</code> in the GitHub PR to trigger MS conflict detect again</li>`,
                    `</ol>`,
                ].join('\n'),
            },
        };

        const poller = await email_client.beginSend(message);
        const result = await poller.pollUntilDone();
        app.log.info(`[ CONFLICT DETECT ] [${uuid}] Conflict email sent to ${notification_email} for PR #${number}, status: ${result.status}`);
    } catch (error) {
        app.log.error(`[ CONFLICT DETECT ] [${uuid}] Failed to send conflict email: ${error}`);
    }
}

async function check_create(app, context, uuid, owner, repo, url, commit, check_name, result, status, output_title, output_summary){
    if (! result) {
        app.log.error(`[ CONFLICT DETECT ] [${uuid}] check_create: result=BLANK`)
        result = SUCCESS
    }
    param={
        owner: owner,
        repo: repo,
        head_sha: commit,
        name: check_name,
        status: status,
        conclusion: result,
        output: {
            title: output_title,
            summary: output_summary,
        },
    }
    app.log.info([`[ CONFLICT DETECT ] [${uuid}] check_create`, result, status, output_title, output_summary].join(" "))
    let check = await context.octokit.rest.checks.create(param);
    let eventDatas = [];
    let dateString = new Date().toISOString()
    let payload = {
        "action": status,
        "pr_url": url,
        "output": output_summary,
        "result": result,
    };
    let eventData = {
        body: {"Timestamp": dateString, "Name": check_name, "Action": status, "Payload": payload}
    };
    eventDatas.push(eventData);
    eventhub.sendEventBatch(eventDatas, app).catch(error => {
        app.log.error(`[ CONFLICT DETECT ] [${uuid}] Failed to send EventHub result: ${error}`);
    });
    if (check.status/10 >= 30 || check.status/10 < 20){
        app.log.error([`[ CONFLICT DETECT ] [${uuid}] check_create`, util.inspect(check, {depth: null})].join(" "))
    } else {
        app.log.info([`[ CONFLICT DETECT ] [${uuid}] check_create`, check.status].join(" "))
    }
}

function init(app) {
    app.log.info("[ CONFLICT DETECT ] Init conflict detect");

    app.on( ["pull_request.opened", "pull_request.synchronize", "pull_request.reopened", "issue_comment.created"] , async (context) => {
        var payload = context.payload;
        const uuid = uuidv4()
        var full_name = payload.repository.full_name
        var owner = full_name.split('/')[0]
        var repo = full_name.split('/')[1]
        if (payload.issue &&
            payload.issue.pull_request &&
            payload.action == "created" &&
            is_azure_pipelines_stale_comment(payload)) {
            schedule_stale_comment_retry(app, owner, repo, payload)
            return
        }
        // comment to start PR validation.
        if (payload.pull_request) {
            var body = ''
            var issue_number = payload.number.toString()
            var pr_owner = payload.pull_request.user.login
            const expected_head_sha = payload.pull_request.head.sha
            const expected_base_sha = payload.pull_request.base.sha
            if ("sonic-net/sonic-buildimage" != full_name) {
                body='/azp run'
            } else {
                body='/azp run Azure.sonic-buildimage'
            }
            app.log.info(`[ AUTO COMMENT ] repo: ${repo}, PR: ${issue_number}, body: ${body}`)
            schedule_validation_comment(
                app,
                owner,
                repo,
                issue_number,
                body,
                expected_head_sha,
                expected_base_sha
            )
        }
        if ("sonic-net/sonic-buildimage" != full_name) {
            app.log.info(`[ CONFLICT DETECT ] [${uuid}] repo not match!`)
            return
        }

        var url, number, commit, base_branch, pr_owner, check_suite
        var param = Array()
        param.push(`FOLDER=conflict`)
        if (payload.issue && payload.action == "created") {
            // issue_comment.created
            let comment_body = payload.comment.body.trim().toLowerCase()
            if (!payload.issue.pull_request) {
                app.log.error(`[ CONFLICT DETECT ] [${uuid}] no PR found, exit!`)
                return
            }
            url = payload.issue.html_url
            number = payload.issue.number.toString()
            let pr = await context.octokit.rest.pulls.get({
                owner: owner,
                repo: repo,
                pull_number: number,
            });
            commit = pr.data.head.sha
            base_branch = pr.data.base.ref
            pr_owner = pr.data.head.user.login
            if (comment_body.startsWith(`/azpw ${MsConflict}`)) {
                check_suite = MsConflict
                if (comment_body.includes(" -f ") || comment_body.endsWith(" -f")){
                    param.push("FORCE_PUSH=true")
                    check_suite = "ALL"
                } else {
                    param.push("FORCE_PUSH=false")
                }
            } else if (comment_body.startsWith(`/azpw ${MsChecker}`)) {
                check_suite = MsChecker
            } else {
                app.log.info(`[ CONFLICT DETECT ] [${uuid}] comment: ${comment_body}, exit!`)
                return
            }
            comment_body=comment_body.replace('/azpw ', '')
            param.push(`ACTION="${check_suite}"`)
        } else {
            // pull_request.opened/synchronize/reopend
            url = payload.pull_request.html_url
            number = payload.number.toString()
            commit = payload.pull_request.head.sha
            base_branch = payload.pull_request.base.ref
            pr_owner = payload.pull_request.user.login
            param.push("FORCE_PUSH=true")
            param.push(`ACTION=ALL`)
            check_suite = "ALL"
            if (payload.pull_request.title.startsWith("[submodule]") && pr_owner == "mssonicbld") {
                app.log.info(`[ CONFLICT DETECT ] [${uuid}] submodule update PR, return!`)
                return
            }
        }

        app.log.info([`[ CONFLICT DETECT ] [${uuid}]`, url, number, commit, base_branch, pr_owner, check_suite].join(" "))
        param.push(`UUID=${uuid}`)
        param.push(`REPO=${repo}`)
        param.push(`PR_NUMBER=${number}`)
        param.push(`PR_URL=${url}`)
        param.push(`PR_OWNER=${pr_owner}`)
        param.push(`PR_BASE_BRANCH=${base_branch}`)
        param.push(`PR_HEAD_COMMIT=${commit}`)

        actionQueue.enqueueBashAction(async () => {
            const queued_gh_token = await akv.getGithubToken()
            const script_branch = await akv.getSecretFromCache("CONFLICT_SCRIPT_BRANCH")
            const msazure_token = await adoauth.getAdoAadToken()
            const copilot_token = await akv.getSecretFromCache("GITHUB_COPILOT_TOKEN") || ''
            return param.concat([
                `GH_TOKEN=${queued_gh_token}`,
                `MSAZURE_TOKEN=x-access-token:${msazure_token}`,
                `SCRIPT_URL=https://mssonicbld:${queued_gh_token}@raw.githubusercontent.com/Azure/sonic-pipelines-internal/${script_branch}/azure-pipelines/ms_conflict_detect.sh`,
                `GITHUB_COPILOT_TOKEN=${copilot_token}`,
            ])
        }, `conflict detect ${repo}#${number}`, app, async run => {
            // If it belongs to ms, comment on PR.
            var description = '', comment_at = '', mspr = '', tmp = '', ms_conflict_result = '', ms_checker_result = '', conflict_ai_result = '', conflict_ai_description = '', output = ''
            for (const line of run.stdout.split(/\r?\n/)){
            output = line
            if (line.includes("pr_owner: ")){
                comment_at = line.split(' ').pop()
            }
            if (line.includes("ms_pr: ") && mspr == ''){
                mspr = line.split(' ').pop()
            }
            if (line.includes("ms_pr_new: ") && ! line.endsWith('null') ){
                mspr = line.split(' ').pop()
            }
            if (line.includes("tmp dir: ")){
                tmp = line.split(' ').pop()
            }
            if (line.includes("ms_conflict.result: ")){
                ms_conflict_result = line.split(' ').pop()
            }
            if (line.includes("ms_checker.result: ")){
                ms_checker_result = line.split(' ').pop()
            }
            if (line.includes("conflict_ai: ")){
                conflict_ai_result += line.substring(line.indexOf("conflict_ai: ") + "conflict_ai: ".length) + '\n'
            }
            if (line.includes("conflict_ai_description: ")){
                conflict_ai_description += line.substring(line.indexOf("conflict_ai_description: ") + "conflict_ai_description: ".length) + '\n'
            }
        }
        app.log.info(`[ CONFLICT DETECT ] [${uuid}] ${mspr}, ${tmp}`)
        if ( ['ALL',MsConflict].includes(check_suite) ) {
            if (run.status == 254) {
                app.log.info([`[ CONFLICT DETECT ] [${uuid}] Conflict detected!`, url].join(" "))
                const is_msft = await is_msft_user(context.octokit, pr_owner);
                if (is_msft) {
                    description = `@${comment_at} PR: ${url} is conflict with MS internal repo<br><br>MS internal PR: ${mspr}<br>${conflict_ai_result}${conflict_ai_description}<br>If the fix commit pushed by Copilot does not correctly resolve the conflict or Copilot failed to push a fix commit, Please follow the instructions to resolve the conflict:<br>1. Go to Networking-acs-buildimage repo: https://dev.azure.com/msazure/One/_git/Networking-acs-buildimage and \`git fetch origin\`<br>2. Checkout the branch: \`git checkout sonicbld/precheck/head/${number}\`<br>3. Resolve the conflict manually and push the fix commit to the same branch<br>4. Approve the MS internal PR ${mspr}<br>5. Comment \`/azpw ${MsConflict}\` in your GitHub PR to trigger MS conflict detect again.`
                } else {
                    // Only send conflict email if the PR has been approved
                    let is_approved = false;
                    try {
                        const reviews = await context.octokit.rest.pulls.listReviews({
                            owner,
                            repo,
                            pull_number: parseInt(number),
                        });
                        is_approved = reviews.data.some(review => review.state === 'APPROVED');
                    } catch (error) {
                        app.log.error(`[ CONFLICT DETECT ] [${uuid}] Failed to check PR approval status: ${error}`);
                    }
                    if (is_approved) {
                        description = `@${comment_at} PR: ${url} is conflict with MS internal repo<br><br>The MSFT team will take care of this conflict.<br>A notification email has been sent to sonicelastictest@microsoft.com.`
                        await send_conflict_email(app, uuid, url, number, pr_owner, mspr, conflict_ai_result, conflict_ai_description);
                    } else {
                        description = `@${comment_at} PR: ${url} is conflict with MS internal repo<br><br>The MSFT team will take care of this conflict.<br>Once the PR is approved, please comment \`/azpw ${MsConflict}\` in your GitHub PR to trigger MS conflict detect again and an notification email will be sent to MSFT team.`
                        app.log.info(`[ CONFLICT DETECT ] [${uuid}] PR not approved yet, skipping email notification`);
                    }
                }
            } else if (run.status == 253){
                app.log.info([`[ CONFLICT DETECT ] [${uuid}] Conflict already exists!`, url].join(" "))
                description = `@${comment_at} Conflict already exists in ${base_branch}<br>The MSFT team will take care of this conflict.<br>Please wait a few hours to trigger ms_conflict again by commenting \`/azpw ${MsConflict}\` in your GitHub PR!`
            } else if (run.status == 252){
                app.log.info([`[ CONFLICT DETECT ] [${uuid}] Github Branch Error!`, url].join(" "))
                description = `@${comment_at} Github Branch not ready<br>Please wait a few minutes to run again!<br>'/azpw ${MsConflict}'`
            } else if (run.status != 0){
                app.log.info([`[ CONFLICT DETECT ] [${uuid}] Unknown error liushilongbuaa need to check! ${output}`, url].join(" "))
                description = `@liushilongbuaa Please help check!<br>${mspr}<br>${tmp}`
            } else {
                app.log.info([`[ CONFLICT DETECT ] [${uuid}] Exit: 0`, url].join(" "))
                description = `${SUCCESS}<br>${mspr}`
            }
            await check_create(app, context, uuid, owner, repo, url, commit, MsConflict, ms_conflict_result, COMPLETED, "MS conflict detect", `${ms_conflict_result}: ${description}`)
        }
        if ( ['ALL',MsChecker].includes(check_suite) ) {
            description = `inprogress: ${mspr}`
            await check_create(app, context, uuid, owner, repo, url, commit, MsChecker, SUCCESS, COMPLETED, "MS PR validation", description)
            //  check_create(app, context, uuid, owner, repo, url, commit, MsChecker, null, InProgress, "MS PR validation", description)
        }
            app.log.error(`[ CONFLICT DETECT ] [${uuid}] Exit Code: ${run.status}`)
        });
    });
};

module.exports = Object.freeze({
    init: init,
});
