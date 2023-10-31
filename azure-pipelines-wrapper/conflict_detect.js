const spawnSync = require('child_process').spawnSync;
const { Octokit } = require('@octokit/rest');
const akv = require('./keyvault');
const fs = require('fs');
const { stderr } = require('process');
const InProgress = 'in_progress'
const MsConflict = 'ms_conflict'
var commentid = ''

function init(app) {
    app.log.info("Init conflict detect");

    app.on( ["pull_request.opened", "pull_request.synchronize", "pull_request.reopened", "issue_comment.created"] , async (context) => {
        var payload = context.payload;

        let full_name = payload.repository.full_name
        let owner = full_name.split('/')[0]
        let repo = full_name.split('/')[1]
        // TODO: change to full_name != "sonic-net/sonic-buildimage"
        if ("sonic-buildimage" != repo) {
            app.log.info("repo not match!")
            return
        }
        if (payload.issue) {
            if ( commentid == payload.comment.id.toString() ) { return } else { commentid = payload.comment.id.toString() }
            app.log.info("conflict_detect " + "issue_comment.created " + payload.comment.user.login + " " + payload.comment.id.toString() + ' "' + payload.comment.body + '"')
        } else {
            if ( commentid == payload.number.toString() + payload.pull_request.updated_at.toString() ) { return } else { commentid == payload.number.toString() + payload.pull_request.updated_at.toString() }
            app.log.info("conflict_detect " + "pull_request." + payload.action + " " + payload.pull_request.user.login + " " + payload.pull_request.html_url)
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
        app.log.info(["Conflict Detect Begin:", url, number, commit, base_branch, pr_owner].join(" "))

        context.octokit.rest.checks.create({
            owner: owner,
            repo: repo,
            head_sha: commit,
            name: MsConflict,
            status: InProgress,
        });
        // If it belongs to ms, comment on PR.
        var result = 'failure'
        let run = spawnSync('bash', ['-c', ['./conflict_detect.sh', repo, url, gh_token, msazure_token, script_url, pr_owner, number, base_branch].join(" ") ], { encoding: 'utf-8' })
        if (run.status == 254) {
            app.log.info("Conflict detected! PR is not completed.")
        } else if (run.status != 0){
            app.log.error(run.stderr)
            app.log.error(run.stdout)
        } else {
            app.log.info("No Conflict.")
            result = 'success'
        }

        let description = '', comment_at = '', mspr = ''
        if (run.status == 254 || run.status == 253 || run.status == 252){
            for (const line of run.stdout.split(/\r?\n/)){
                if (line.startsWith("pr_owner: ")){
                    comment_at = line.replace("pr_owner: ", "")
                }
                if (line.startsWith("ms_pr: ")){
                    mspr = line.replace("ms_pr: ", "")
                }
                if (line.startsWith("ms_pr_new: ")){
                    mspr = line.replace("ms_pr_new: ", "")
                }
            }
            if (comment_at == '' || mspr == ''){
                app.log.error("Error output by conflict_detect.sh")
            }
            description = `@${comment_at} PR: ${url} is conflict with MS internal repo<br>Please complete the following PR by pushing fix commit to sonicbld/conflict_prefix/${number}-fix<br>${mspr}<br>Then comment "/azpw ms_conflict" to rerun PR checker.`
            let mssonicbld_ghclient = new Octokit({
                auth: gh_token,
            });
            let now = new Date()
            now.setDate(now.getDate() -1)
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
                mssonicbld_ghclient.rest.issues.createComment({
                    owner: owner,
                    repo: repo,
                    issue_number: number,
                    body: description,
                });
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
        if (check.status != 201 && check.status != 202 && check.status != 200) { app.log.error(check) }
    });
};

module.exports = Object.freeze({
    init: init,
});