const spawnSync = require('child_process').spawnSync;
const akv = require('./keyvault');

function init(app) {
    app.log.info("[ AUTO CHERRY PICK ] Init auto cherry pick");

    app.on( ["pull_request.synchronize", "pull_request.labeled", "pull_request.closed"] , async (context) => {
        var payload = context.payload;

        let full_name = payload.repository.full_name
        var merged = payload.pull_request.merged
        let org = full_name.split('/')[0]
        let repo = full_name.split('/')[1]
        if (full_name != "sonic-net/sonic-utilities") {
            app.log.info("[ AUTO CHERRY PICK ] repo not match!")
            return
        }
        if (payload.action == 'closed') {
            if (merged != true) {
                app.log.info("[ AUTO CHERRY PICK ] PR not merged!")
                return
            }
        }

        let gh_token = await akv.getGithubToken()
        let script_url = await akv.getSecretFromCache("AUTO_CHERRYPICK_SCRIPT_URL")

        var param = Array()
        param.push(`ACTION=${payload.action}`)
        param.push(`REPO=${repo}`)
        param.push(`ORG=${org}`)
        param.push(`GH_TOKEN=${gh_token}`)
        param.push(`SCRIPT_URL=${script_url}`)
        param.push(`PR_NUMBER=${payload.number.toString()}`)
        param.push(`PR_URL=${payload.pull_request.html_url}`)
        param.push(`PR_OWNER=${payload.pull_request.user.login}`)
        param.push(`PR_BASE_BRANCH=${payload.pull_request.base.ref}`)
        param.push(`PR_PATCH_URL=${payload.pull_request.patch_url}`)
        var labels = Array()
        for (const label of payload.pull_request.labels) {
            labels.push(label.name)
        }
        param.push(`PR_LABELS="${labels.join(',')}"`)
        if (payload.action == 'labeled') {
            param.push(`ACTION_LABEL="${payload.label.name}"`)
        }

        app.log.info(["[ AUTO CHERRY PICK ]"].concat(param).join(" "))

        var run = spawnSync('./auto_cherrypick.sh', param, { encoding: 'utf-8' })
        if (run.status != 0){
            app.log.error("[ AUTO CHERRY PICK ] Unexpected error: " + run.stdout)
            return
        }
        app.log.info("[ AUTO CHERRY PICK ] finished.")
    });
};

module.exports = Object.freeze({
    init: init,
});
