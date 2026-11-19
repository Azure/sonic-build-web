const { createTokenAuth } = require("@octokit/auth-token");
const { request } = require("@octokit/request");
const { Octokit } = require("@octokit/rest");
const https = require('https');
require('dotenv').config();
const azp = require('./azp');
const akv = require('./keyvault');
const adoauth = require('./adoauth');
const check_run = require('./check_run');
const actionQueue = require('./action_queue');
const { retry } = require("@azure/core-amqp");

const isDevEnv = process.env.WEBHOOK_PROXY_URL ? true : false;

async function canRetryBuilds(context, app, octokit) {
    const payload = context.payload;
    const username = payload.comment.user && payload.comment.user.login;
    if (!username) {
        throw new Error("Cannot authorize retry command without a comment author");
    }
    if (payload.comment.author_association === "CONTRIBUTOR") {
        return true;
    }

    try {
        const response = await octokit.rest.repos.checkCollaborator({
            owner: payload.repository.owner.login,
            repo: payload.repository.name,
            username: username,
        });
        if (response.status === 204) {
            return true;
        }

        throw new Error(`Unexpected collaborator lookup status ${response.status} for ${username}`);
    } catch (error) {
        if (error.status === 404) {
            app.log.info(`[ ISSUE COMMENT ] Denied retry command from non-collaborator ${username}`);
            return false;
        }
        throw error;
    }
}

function adoRequest(method, url, token, body) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const headers = {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json",
        };
        if (data) {
            headers["Content-Length"] = Buffer.byteLength(data);
        }

        const req = https.request(url, { method, headers }, response => {
            let responseBody = '';
            response.on('error', reject);
            response.on('aborted', () => reject(new Error("ADO response aborted")));
            response.setEncoding('utf8');
            response.on('data', chunk => {
                responseBody += chunk;
            });
            response.on('end', () => {
                if (response.statusCode < 200 || response.statusCode >= 300) {
                    reject(Object.assign(new Error(`ADO request failed with ${response.statusCode}: ${responseBody}`), {
                        status: response.statusCode,
                    }));
                    return;
                }
                resolve(responseBody);
            });
        });
        req.setTimeout(60000, () => {
            req.destroy(new Error("ADO request timed out"));
        });
        req.on('error', reject);
        if (data) {
            req.write(data);
        }
        req.end();
    });
}

function init(app) {
    app.log.info("Init issue_comment!");

    app.on("issue_comment.created", async (context) => {
        var payload = context.payload;
        if ('pull_request' in payload.issue){
            let comment_body = payload.comment.body.trim();
            let command = null;

            if (comment_body.toLowerCase().startsWith('/azpw ms_conflict') ){ return };
            console.log(`issue_comment.created, ${payload.comment.id}`);
            if (isDevEnv){
                if (comment_body.toLowerCase().startsWith('/azpwd comment')){
                    await context.octokit.rest.issues.createComment({
                        owner: payload.repository.owner.login,
                        repo: payload.repository.name,
                        issue_number: payload.issue.number,
                        body: comment_body.substring(14).trim(),
                    });
                    return;
                }

                if (comment_body.toLowerCase().startsWith('/azpwd')){
                    console.log(`Comment /azpwd added: ${comment_body}`)
                    comment_body = '/azpw' + comment_body.substring(6);
                }
            }

            if (comment_body.toLowerCase().startsWith('/azpw check')){
                await check_run.create_checks_by_comment(context);
                return;
            }

            if (comment_body.toLowerCase().startsWith('/azurepipelineswrapper retry') ||
                comment_body.toLowerCase().startsWith('/azpw retry')){
                command = "Retrying failed(or canceled) jobs...";
            }
            else if (comment_body.toLowerCase().startsWith('/azurepipelineswrapper run') || 
                comment_body.toLowerCase().startsWith('/azpw run')){
                command = '⚠️ **Notice**: `/azpw run` only runs failed jobs now. If you want to trigger a whole pipline run, please rebase your branch or close and reopen the PR.\n💡 **Tip**: You can also use `/azpw retry` to retry failed jobs directly.\n\nRetrying failed(or canceled) jobs...';
            }

            if (command){
                var github_token = await akv.getGithubToken();
                const octokit = new Octokit({
                    auth: github_token,
                });

                let authorized;
                try {
                    authorized = await canRetryBuilds(context, app, octokit);
                } catch (error) {
                    app.log.error(`[ ISSUE COMMENT ] Failed to authorize retry command for ${payload.repository.full_name}#${payload.issue.number}, comment ${payload.comment.id}, user ${payload.comment.user && payload.comment.user.login}: ${error}`);
                    await octokit.rest.issues.createComment({
                        owner: payload.repository.owner.login,
                        repo: payload.repository.name,
                        issue_number: payload.issue.number,
                        body: "⚠️ Retry not queued because the bot could not verify your repository access. This does not mean you lack permission. Please try again later; if this persists, ask a repository maintainer to check the bot's GitHub access and authorization logs.",
                    });
                    return;
                }

                if (!authorized) {
                    await octokit.rest.issues.createComment({
                        owner: payload.repository.owner.login,
                        repo: payload.repository.name,
                        issue_number: payload.issue.number,
                        body: "⚠️ Retry not queued. Only repository collaborators and GitHub-recognized contributors with previous commits to this repository can retry Azure Pipelines jobs.",
                    });
                    return;
                }

                try {
                    actionQueue.enqueueAction(async () => {
                        console.log(`Creating issue comment ${command}`);
                        await octokit.rest.issues.createComment({
                            owner: payload.repository.owner.login,
                            repo: payload.repository.name,
                            issue_number: payload.issue.number,
                            body: command,
                        });
                        await retryFailedBuilds(context);
                    }, `retry failed builds ${payload.repository.full_name}#${payload.issue.number}`, app);
                } catch (error) {
                    await octokit.rest.issues.createComment({
                        owner: payload.repository.owner.login,
                        repo: payload.repository.name,
                        issue_number: payload.issue.number,
                        body: "⚠️ Unable to queue the retry because the action queue is full. Please try again later.",
                    });
                }
                return;
            }
        }
  });
};

async function retryFailedBuilds(context) {
    var payload = context.payload;
    var owner = payload.repository.owner.login;
    var repo = payload.repository.name;
    var pullRequestNumber = payload.issue.number;    
    var github_token = await akv.getGithubToken();
    const octokit = new Octokit({
        auth: github_token,
    });

    // Get the PR head SHA
    var pullRequest = await context.octokit.pulls.get({
        owner: owner,
        repo: repo,
        pull_number: pullRequestNumber,
    });
    if (pullRequest.status != 200) {
        console.error(`Failed to get pull request for ${owner}/${repo}/${pullRequestNumber}`);
        await octokit.rest.issues.createComment({
            owner: owner,
            repo: repo,
            issue_number: pullRequestNumber,
            body: `Failed to get pull request for ${owner}/${repo}/${pullRequestNumber}.`,
        });
        return;
    }

    var headSha = pullRequest.data.head.sha;

    // List check runs from the Azure Pipelines GitHub app
    var checkRunsResponse = await context.octokit.checks.listForRef({
        owner: owner,
        repo: repo,
        ref: headSha,
        app_id: process.env.AZP_APP_ID,
    });
    if (checkRunsResponse.status != 200) {
        console.error(`Failed to list check runs for ${owner}/${repo}/${headSha}`);
        await octokit.rest.issues.createComment({
            owner: owner,
            repo: repo,
            issue_number: pullRequestNumber,
            body: `Failed to fetch pipeline information. Please close and reopen the PR or rebase your branch to trigger a new pipeline.`,
        });
        return;
    }

    var latestBuild = null;
    var latestStartedAt = null;
    for (var cr of checkRunsResponse.data.check_runs) {
        var info = azp.getAzDevInfoFromCheckPayload(cr);
        if (info && info.buildId) {
            var startedAt = cr.started_at ? new Date(cr.started_at) : new Date(0);
            if (!latestBuild || startedAt > latestStartedAt) {
                latestBuild = info;
                latestStartedAt = startedAt;
            }
        }
    }

    if (!latestBuild) {
        await octokit.rest.issues.createComment({
            owner: owner,
            repo: repo,
            issue_number: pullRequestNumber,
            body: `No Azure DevOps builds found for ${owner}/${repo}#${pullRequestNumber}.`,
        });
        return;
    }

    var az_token = await adoauth.getAdoAadToken();

    const unavailableMessage = [
        `⚠️ Cannot retry Azure DevOps build ${latestBuild.buildId}: the build or its timeline is no longer available.`,
        "It may have been deleted by the pipeline's 2-week retention policy (14 days after completion).",
        "`/azpw retry` and `/azpw run` can only retry existing builds; they cannot recreate a deleted build.",
        "Please close and reopen the PR or push a new commit (for example, rebase your branch) to trigger a new pipeline run.",
    ].join("\n\n");
    var timelineUrl = `https://dev.azure.com/${latestBuild.org}/${latestBuild.projectId}/_apis/build/builds/${latestBuild.buildId}/timeline?api-version=7.1`;
    var timeline;
    try {
        var timelineOutput = await adoRequest("GET", timelineUrl, az_token);
        timeline = JSON.parse(timelineOutput);
    } catch (error) {
        const unavailable = error.status === 404 || error.status === 410;
        await octokit.rest.issues.createComment({
            owner: owner,
            repo: repo,
            issue_number: pullRequestNumber,
            body: unavailable ? unavailableMessage :
                `Could not retry Azure DevOps build ${latestBuild.buildId} because its timeline could not be read${error.status ? ` (HTTP ${error.status})` : ""}. No stages were retried. Please try again later or ask a repository maintainer to check the bot's Azure DevOps access and logs.`,
        });
        if (unavailable) return;
        throw error;
    }

    if (!timeline || !Array.isArray(timeline.records)) {
        await octokit.rest.issues.createComment({
            owner: owner,
            repo: repo,
            issue_number: pullRequestNumber,
            body: `Could not retry Azure DevOps build ${latestBuild.buildId}: Azure DevOps returned a timeline without a valid records list. No stages were retried. Please ask a repository maintainer to check the build and the bot's logs.`,
        });
        throw new Error(`Invalid timeline records for build ${latestBuild.buildId}`);
    }

    var failedStages = [], failedJobs = [], inProgressStages = [];
    for (var record of timeline.records) {
        if (record.type === 'Stage' &&
            (record.result === 'failed' || record.result === 'canceled')) {
            failedStages.push(record);
        }
        if (record.type === 'Job' &&
            (record.result === 'failed' || record.result === 'canceled')) {
            failedJobs.push(record);
        }
        if (record.type === 'Stage' && record.state === 'inProgress') {
            inProgressStages.push(record);
        }
    }

    if (failedStages.length === 0 && failedJobs.length === 0) {
        await octokit.rest.issues.createComment({
            owner: owner,
            repo: repo,
            issue_number: pullRequestNumber,
            body: `No failed(or canceled) stages or jobs found in the most recent build ${latestBuild.buildId}.`,
        });
        return;
    }
    
    if (failedStages.length == 0 && failedJobs.length > 0 && inProgressStages.length > 0){
        await octokit.rest.issues.createComment({
            owner: owner,
            repo: repo,
            issue_number: pullRequestNumber,
            body: `No failed(or canceled) jobs found in completed stages. Only failed(or canceled) jobs in completed stages can be retried.\n\nStages in progress: ${inProgressStages.map(s => s.name).join(', ')}. Please wait for the stages to complete and then retry again.`,
        });
        return;
    }

    if (failedStages.length == 0 && failedJobs.length > 0){
        var comment_body = `The following failed(or canceled) jobs were not retried:\n`;
        comment_body += failedJobs.map(j => `- ${j.name}`).join('\n');
        for (var job of failedJobs) {
            if (job.name === 'Cancel previous test plans for same PR' || job.name.includes('[OPTIONAL]') || job.name.includes('vulnerability scan')) {
                comment_body += `\n\nJob ${job.name} is an optional job and does not block the PR merge, so it will not be retried.`;
            }
        }
        await octokit.rest.issues.createComment({
            owner: owner,
            repo: repo,
            issue_number: pullRequestNumber,
            body: comment_body,
        });
        return;
    }

    // Retry each failed stage individually
    var summaryLines = [`Retrying failed(or canceled) stages in build ${latestBuild.buildId}:`];
    var data = { state: 1, forceRetryAllJobs: false, retryDependencies: true };
    for (var stage of failedStages) {
        try {
            var url = `https://dev.azure.com/${latestBuild.org}/${latestBuild.projectId}/_apis/build/builds/${latestBuild.buildId}/stages/${stage.identifier}?api-version=7.1`;
            var output = await adoRequest("PATCH", url, az_token, data);
            console.log(`Retried stage '${stage.identifier}' in build ${latestBuild.buildId}: ${output}`);
            summaryLines.push(`\n\n✅Stage **${stage.identifier}**:`);
            for (var job of failedJobs.filter(j => j.identifier.startsWith(stage.identifier))) {
                if (job.name === 'Cancel previous test plans for same PR' || job.name.includes('[OPTIONAL]') || job.name.includes('vulnerability scan')) {
                    summaryLines.push(`- Job ${job.name}: skipped (optional job and does not block the PR merge).`);
                } else {
                    summaryLines.push(`- Job ${job.name}: retried.`);
                }
            }
        } catch (e) {
            console.error(`Failed to retry stage '${stage.identifier}' in build ${latestBuild.buildId}: ${e.message}`);
            if (e.status === 404 || e.status === 410) {
                summaryLines.push(`\n\n${unavailableMessage} Stage **${stage.identifier}** was not retried; no further stages will be attempted.`);
                break;
            }
            summaryLines.push(`❌ Stage **${stage.identifier}**: error — ${e.message}`);
        }
    }

    await octokit.rest.issues.createComment({
        owner: owner,
        repo: repo,
        issue_number: pullRequestNumber,
        body: summaryLines.join('\n'),
    });
}

module.exports = Object.freeze({
    init: init,
});
