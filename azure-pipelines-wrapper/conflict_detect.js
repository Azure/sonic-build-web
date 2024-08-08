const spawnSync = require('child_process').spawnSync;
const { Octokit } = require('@octokit/rest');
const util = require('util');
const akv = require('./keyvault');
const InProgress = 'in_progress'
const MsConflict = 'ms_conflict'
const MsChecker = 'ms_checker'
const { v4: uuidv4 } = require('uuid');
const COMPLETED = 'completed'
const FAILURE = 'failure'
const SUCCESS = 'success'

async function check_create(app, context, uuid, owner, repo, commit, check_name, result, status, output_title, output_summary){
    if (result == '') {
        app.log.info(`[ CONFLICT DETECT ] [${uuid}] check_create: result=BLANK`)
        return
    }
    param={
        owner: owner,
        repo: repo,
        head_sha: commit,
        name: check_name,
        status: status,
        output: {
            title: output_title,
            summary: output_summary,
        },
    }
    if ( result != null ){ param.conclusion = result }
    app.log.info([`[ CONFLICT DETECT ] [${uuid}] check_create`, result, status, output_title, output_summary].join(" "))
    let check = await context.octokit.rest.checks.create(param);
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
        if ("sonic-net/sonic-buildimage" != full_name) {
            app.log.info(`[ CONFLICT DETECT ] [${uuid}] repo not match!`)
            return
        }

        var url, number, commit, base_branch, pr_owner, check_suite
        var gh_token = await akv.getSecretFromCache("GH_TOKEN")
        var script_branch = await akv.getSecretFromCache("CONFLICT_SCRIPT_BRANCH")
        var msazure_token = await akv.getSecretFromCache("MSAZURE_TOKEN")

        var param = Array()
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
            param.push(`ACTION="${comment_body}"`)
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
        param.push(`GH_TOKEN=${gh_token}`)
        param.push(`MSAZURE_TOKEN=${msazure_token}`)
        param.push(`SCRIPT_BRANCH=${script_branch}`)
        param.push(`SCRIPT_NAME=ms_conflict_detect.sh`)
        param.push(`PR_NUMBER=${number}`)
        param.push(`PR_URL=${url}`)
        param.push(`PR_OWNER=${pr_owner}`)
        param.push(`PR_BASE_BRANCH=${base_branch}`)
        param.push(`PR_HEAD_COMMIT=${commit}`)

        // If it belongs to ms, comment on PR.
        var description = '', comment_at = '', mspr = '', tmp = '', ms_conflict_result = '', ms_checker_result = ''
        var run = spawnSync('./conflict_detect.sh', param, { encoding: 'utf-8' })
        for (const line of run.stdout.split(/\r?\n/)){
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
        }
        app.log.info(`[ CONFLICT DETECT ] [${uuid}] ${mspr}, ${tmp}`)
        if ( ['ALL',MsConflict].includes(check_suite) ) {
            if (run.status == 254) {
                app.log.info([`[ CONFLICT DETECT ] [${uuid}] Conflict detected!`, url].join(" "))
                description = `@${comment_at} PR: ${url} is conflict with MS internal repo<br>${mspr}<br>Please push fix commit to sonicbld/precheck/head/${number}<br>Then approve PR and comment "/azpw ${MsConflict}" in github PR.`
            } else if (run.status == 253){
                app.log.info([`[ CONFLICT DETECT ] [${uuid}] Conflict already exists!`, url].join(" "))
                description = `@${comment_at} Conflict already exists in ${base_branch}<br>Please wait a few hours to run ms_conflict again!<br>'/azpw ${MsConflict}'`
            } else if (run.status == 252){
                app.log.info([`[ CONFLICT DETECT ] [${uuid}] Github Branch Error!`, url].join(" "))
                description = `@${comment_at} Github Branch not ready<br>Please wait a few minutes to run again!<br>'/azpw ${MsConflict}'`
            } else if (run.status != 0){
                app.log.info([`[ CONFLICT DETECT ] [${uuid}] Unknown error liushilongbuaa need to check!`, url].join(" "))
                description = `@liushilongbuaa Please help check!<br>${mspr}<br>${tmp}`
            } else {
                app.log.info([`[ CONFLICT DETECT ] [${uuid}] Exit: 0`, url].join(" "))
                description = `${SUCCESS}<br>${mspr}`
            }
            check_create(app, context, uuid, owner, repo, commit, MsConflict, ms_conflict_result, COMPLETED, "MS conflict detect", description)
        }
        if ( ['ALL',MsChecker].includes(check_suite) ) {
            description = `Please check result in ${mspr}`
            if (ms_checker_result == InProgress){
                check_create(app, context, uuid, owner, repo, commit, MsChecker, null, InProgress, "MS PR validation", description)
            } else {
                check_create(app, context, uuid, owner, repo, commit, MsChecker, ms_checker_result, COMPLETED, "MS PR validation", description)
            }
        }
        app.log.error(`[ CONFLICT DETECT ] [${uuid}] Exit Code: ${run.status}`)
    });
};

module.exports = Object.freeze({
    init: init,
});
