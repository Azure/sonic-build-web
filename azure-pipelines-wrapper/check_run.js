const azp = require('./azp');
require('dotenv').config();

const converage_property_prefix = "codediff.";
const check_prefix = 'coverage.';

// The context can be issue_comment or check_run
async function  create_checks_by_azp_check_run(context, azp_check_run){
    if (azp_check_run.app.name != "Azure Pipelines"){
        console.log(`Skip the check_run:${azp_check_run.id}, for the app name: ${azp_check_run.app.name}`);
        return null;
    }

    var properties = await azp.getProperties(azp_check_run);
    if (! properties){
        console.log(`Skipped the check_run:${azp_check_run.id}, for no properties`);
        return null;
    }

    var coverages = {};
    for (const [key, value] of Object.entries(properties)) {
        if (key.startsWith(converage_property_prefix)){
            coverages[key] = value;
        }
    }
    if (! coverages){
        console.log(`Skipped for no coverages`);
        return null;
    }

    // Query existing checks by commit id
    var checkUrl = new URL(azp_check_run.url);
    var urlPaths = checkUrl.pathname.split('/');
    var owner = urlPaths[2];
    var repo = urlPaths[3];
    var check_runs = await context.octokit.checks.listForRef({
        owner: owner,
        repo: repo,
        ref: azp_check_run.head_sha,
        app_id: process.env.APP_ID,
    });
    if (check_runs.status != 200){
        console.error(`Failed to list checks of ${owner}/${repo}/${azp_check_run.head_sha} for app ${process.env.APP_ID}`);
        return null;
    }

    console.log(`Succeeded to list checks for of ${owner}/${repo}/${azp_check_run.head_sha} for app ${process.env.APP_ID}`);
    var checks = {};
    for (check of check_runs.data.check_runs){
        if (!check.started_at){
            continue;
        }
        if (check.name in checks){
            var existingCheck = checks[check.name];
            if (check.started_at > existingCheck.started_at){
                checks[check.name] = check;
            }
        }
        else{
            checks[check.name] = check;
        }
    }

    var created_checks = [];
    console.log(`Found coverages count ${Object.keys(coverages).length}`);
    for (const [key, value] of Object.entries(coverages)){
        var coverageInfo = JSON.parse(value);
        var definitionName = coverageInfo.definitionName;
        var jobName = coverageInfo.jobName;
        var checkName = `${check_prefix}${definitionName}.${jobName}`;
        var pullRequestId = coverageInfo.pullRequestId;
        var jobId = coverageInfo.jobId;
        var external_id = `${pullRequestId}|${coverageInfo.timestamp}`;
        if (checkName in checks){
            var check = checks[checkName];
            if (check.external_id == external_id){
                console.log(`Skipped the check ${checkName}, for external_id ${external_id} existing.`);
                continue;
            }
        }

        var info = azp.getAzDevInfoFromCheckPayload(azp_check_run);
        var details_url = `https://dev.azure.com/${info.org}/${info.projectId}/_build/results?buildId=${info.buildId}&view=logs&jobId=${jobId}`;
        var coverage_url = `https://dev.azure.com/${info.org}/${info.projectId}/_build/results?buildId=${info.buildId}&view=codecoverage-tab`;
        console.log(`Creating check ${checkName}`);
        var num_lines = coverageInfo["cover.num_lines"];
        var num_violations = coverageInfo["cover.num_violations"];
        var percent_covered = coverageInfo["cover.percent_covered"];
        var threshold = coverageInfo["cover.threshold"];
        if (threshold > 100){
            threshold = 100;
        }
        if (threshold < 0){
            threshold = 0;
        }
        var conclusion = percent_covered >= threshold ? 'success' : 'failure';
        var check = await context.octokit.rest.checks.create({
            owner: owner,
            repo: repo,
            head_sha: azp_check_run.head_sha,
            name: checkName,
            conclusion: conclusion,
            status: 'completed',
            external_id: external_id,
            details_url: details_url,
            output: {
                title: "Pull Request Coverage",
                summary: `Total:   ${num_lines} lines\nMissing: ${num_violations} lines\nCoverage: ${percent_covered}%\nThreshold: ${threshold}%\n[Diff coverage](${coverage_url})`,

            }
        });
        if (check.status != 200 && check.status != 201){
            console.error(`Return ${check.status}, failed to create the check for ${owner}/${repo}/commit/${azp_check_run.head_sha}`);
            continue;
        }
        created_checks.push(check.data);
        console.log(`Created check ${checkName}, id: ${check.data.id}`);
    }

    return created_checks;
}

async function check_run_completed_handler(context) {
    var payload = context.payload;
    if (!'check_run' in payload){
        return null;
    }

    var check_run = payload.check_run;
    var checkUrl = new URL(check_run.url);
    var urlPaths = checkUrl.pathname.split('/');
    var owner = urlPaths[2];
    var repo = urlPaths[3];
    await create_checks_by_azp_check_run(context, check_run);
}

async function  create_checks_by_pullRequest(context, owner, repo, pullRequestId){
    var payload = context.payload;
    var pullRequest = await context.octokit.pulls.get({
        owner: owner,
        repo: repo,
        pull_number: pullRequestId,
    });
    if (pullRequest.status != 200){
        console.error(`Failed to get pull request for ${owner}/${repo}/${pullRequestId}`);
        return null;
    }

    console.log(`Succeeded to get pull request for ${owner}/${repo}/${pullRequestId}`);
    var check_runs = await context.octokit.checks.listForRef({
        owner: owner,
        repo: repo,
        ref: pullRequest.data.head.sha,
        app_id: process.env.AZP_APP_ID,
    });

    if (check_runs.status != 200){
        console.error(`Failed to list checks for ${owner}/${repo}/${payload.check_run.head_sha} for app ${process.env.AZP_APP_ID}`);
        return null;
    }
    if (check_runs.data.check_runs.length <= 0){
        console.log(`No checks found for ${owner}/${repo}/${payload.check_run.head_sha} for app ${process.env.AZP_APP_ID}`);
        return null;
    }

    console.log(`Succeeded to list checks for ${owner}/${repo}/${pullRequest.data.head.sha}, checks count: ${check_runs.data.check_runs.length}`);
    var azp_check_run = check_runs.data.check_runs[0];
    await create_checks_by_azp_check_run(context, azp_check_run);    
}

async function  create_checks_by_comment(context){
    var payload = context.payload;
    if (!'issue' in payload){
        return null;
    }

    if (!'pull_request' in payload.issue){
        return null;
    }

    if (!'url' in payload.issue.pull_request){
        return null;
    }

    var owner = payload.repository.owner.login;
    var repo = payload.repository.name;
    return create_checks_by_pullRequest(context, owner, repo, payload.issue.number);
}

async function  create_checks_by_rerequested(context){
    var payload = context.payload;
    if (!'check_run' in payload){
        return null;
    }

    var check_run = payload.check_run;
    if (check_run.app.id != process.env.APP_ID){
        console.log(`Skip the check_run:${check_run.id}, for the app name: ${check_run.app.name}`);
        return null;
    }
    
    var owner = payload.repository.owner.login;
    var repo = payload.repository.name;
    var pullRequestId = check_run.external_id.split('|')[0];
    return create_checks_by_pullRequest(context, owner, repo, pullRequestId);
}


function init(app) {
    app.log.info("Init check_run!");
  
    app.on("check_run.completed", async (context) => {
        console.log("check run completed");
        await check_run_completed_handler(context);
      });
    app.on("check_run.rerequested", async (context) => {
        console.log("check run rerequested");
        await create_checks_by_rerequested(context);
      });
  };
  
  module.exports = Object.freeze({
      init: init,
      create_checks_by_comment: create_checks_by_comment,
  });