const { createTokenAuth } = require("@octokit/auth-token");
const { request } = require("@octokit/request");
const { Octokit } = require("@octokit/rest");
require('dotenv').config();
const azp = require('./azp');
const akv = require('./keyvault');
const check_run = require('./check_run');

const isDevEnv = process.env.WEBHOOK_PROXY_URL ? true : false;

function init(app) {
    app.log.info("Init issue_comment!");

    app.on("issue_comment.created", async (context) => {
        var payload = context.payload;
        if ('pull_request' in payload.issue){
            issue_user_login = payload.issue.user.login;
            comment_user_login = payload.comment.user.login;
            comment_body = payload.comment.body.trim();
            command = null;

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

            command = null;
            if (comment_body.toLowerCase().startsWith('/azurepipelineswrapper run')){
                if (issue_user_login == comment_user_login){
                    command = '/AzurePipelines run' + comment_body.substring(26);
                } else {
                    command = 'Only PR owner can use /azpw run';
                }
            }
            else if (comment_body.toLowerCase().startsWith('/azpw run')){
                if (issue_user_login == comment_user_login){
                    command = '/AzurePipelines run' + comment_body.substring(9);
                } else {
                    command = 'Only PR owner can use /azpw run';
                }
            }

            if (command){
                var token = await akv.getGithubToken();
                const octokit = new Octokit({
                    auth: token,
                });
                console.log(`Creating issue comment ${command}`);
                await octokit.rest.issues.createComment({
                    owner: payload.repository.owner.login,
                    repo: payload.repository.name,
                    issue_number: payload.issue.number,
                    body: command,
                });
                return;
            }
        }
  });
};

module.exports = Object.freeze({
    init: init,
});