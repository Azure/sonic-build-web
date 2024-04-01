const spawnSync = require('child_process').spawnSync;
const { Octokit } = require('@octokit/rest');
const akv = require('./keyvault');
const InProgress = 'in_progress'
const MsConflict = 'ms_conflict'
const { v4: uuidv4 } = require('uuid');

function init(app) {
    app.log.info("[ CONFLICT DETECT ] Init conflict detect");

    app.on( ["pull_request.opened", "pull_request.synchronize", "pull_request.reopened", "issue_comment.created"] , async (context) => {
        var payload = context.payload;
        const uuid = uuidv4()
        let full_name = payload.repository.full_name
        let owner = full_name.split('/')[0]
        let repo = full_name.split('/')[1]
        if ("sonic-net/sonic-buildimage" != full_name) {
            app.log.info(`[ CONFLICT DETECT ] [${uuid}] repo not match!`)
            return
        }

        var url, number, commit, base_branch, pr_owner
        let gh_token = await akv.getSecretFromCache("GH_TOKEN")
        let script_url = await akv.getSecretFromCache("CONFLICT_SCRIPT_URL")
        let msazure_token = await akv.getSecretFromCache("MSAZURE_TOKEN")

        if (payload.issue && payload.action == "created") {
            // issue_comment.created
            let comment_body = payload.comment.body.trim()
            if (comment_body.toLowerCase() != '/azpw ' + MsConflict) {
                return
            }
            if (!payload.issue.pull_request) {
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
        } else {
            // pull_request.opened/synchronize/reopend
            url = payload.pull_request.html_url
            number = payload.number.toString()
            commit = payload.pull_request.head.sha
            base_branch = payload.pull_request.base.ref
            pr_owner = payload.pull_request.user.login
        }
        app.log.info([`[ CONFLICT DETECT ] [${uuid}]`, url, number, commit, base_branch, pr_owner].join(" "))
        if (pr_owner == "mssonicbld"){
            return
        }

        context.octokit.rest.checks.create({
            owner: owner,
            repo: repo,
            head_sha: commit,
            name: MsConflict,
            status: InProgress,
        });
        // If it belongs to ms, comment on PR.
        let result = 'success'
        let description = '', comment_at = '', mspr = '', tmp = ''
        let run = spawnSync('./conflict_detect.sh', [repo, url, gh_token, msazure_token, script_url, pr_owner, number, base_branch], { encoding: 'utf-8' })
        if (run.status == 254) {
            result = 'failure'
        } else if (run.status == 253){
            description = `Conflict already exists in ${base_branch}`
            app.log.error(`[ CONFLICT DETECT ] [${uuid}] Conflict already exists!`)
        } else if (run.status != 0){
            app.log.info(`[ CONFLICT DETECT ] [${uuid}] Exit Code: ${run.status}`)
        } else {
            app.log.info(`[ CONFLICT DETECT ] [${uuid}] No Conflict or Resolved!`)
        }
        for (const line of run.stdout.split(/\r?\n/)){
            if (line.includes("pr_owner: ")){
                comment_at = line.split(' ').pop()
            }
            if (line.includes("ms_pr: ")){
                mspr = line.split(' ').pop()
            }
            if (line.includes("ms_pr_new: ")){
                mspr = line.split(' ').pop()
            }
            if (line.includes("tmp dir: ")){
                tmp = line.split(' ').pop()
            }
        }
        app.log.info(`[ CONFLICT DETECT ] [${uuid}] ${mspr}, ${tmp}`)
        if (run.status == 254){
            app.log.info([`[ CONFLICT DETECT ] [${uuid}] Conflict detected!`, url].join(" "))
            if (comment_at == '' || mspr == ''){
                app.log.error(`[ CONFLICT DETECT ] [${uuid}] Error output by conflict_detect.sh`)
            }
            description = `@${comment_at} PR: ${url} is conflict with MS internal repo<br>Please push fix commit to sonicbld/precheck/head/${number} and approve<br>${mspr}<br>After ms PR is merged, comment "/azpw ms_conflict" to rerun PR checker.`
            let mssonicbld_ghclient = new Octokit({
                auth: gh_token,
            });
            let now = new Date()
            now.setDate(now.getDate() -3)
            let comments = await mssonicbld_ghclient.rest.issues.listComments({
                owner: owner,
                repo: repo,
                issue_number: number,
                since : now.toISOString(),
                per_page: 100,
            });
            let need_comment = true
            if ( Object.values(comments.data).length > 0){
                for (const comment of Object.values(comments.data)) {
                    if ( comment.body == description ) {
                        need_comment = false
                        break
                    }
                }
            }

            if (need_comment) {
                let re = await mssonicbld_ghclient.rest.issues.createComment({
                    owner: owner,
                    repo: repo,
                    issue_number: number,
                    body: description,
                });
                app.log.info([`[ CONFLICT DETECT ] [${uuid}]`, re.body].join(" "))
            }
        }

        var check = await context.octokit.rest.checks.create({
            owner: owner,
            repo: repo,
            head_sha: commit,
            name: MsConflict,
            conclusion: result,
            status: 'completed',
            output: {
                title: "ms code conflict",
                summary: description,
            },
        });
        app.log.info([`[ CONFLICT DETECT ] [${uuid}]`,result , check.body].join(" "))
        if (check.status != 201 && check.status != 202 && check.status != 200) { app.log.error(check) }
    });
};

module.exports = Object.freeze({
    init: init,
});
