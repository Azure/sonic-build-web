const spawnSync = require('child_process').spawnSync;
const akv = require('./keyvault');
const repos = ["sonic-net/sonic-utilities", "sonic-net/sonic-swss", "sonic-net/sonic-sairedis", "sonic-net/sonic-swss-common", "sonic-net/sonic-dbsyncd", "sonic-net/sonic-gnmi", "sonic-net/sonic-host-services",
              "sonic-net/sonic-linkmgrd", "sonic-net/sonic-linux-kernel", "sonic-net/sonic-mgmt-common", "sonic-net/sonic-mgmt-framework", "sonic-net/sonic-platform-common", "sonic-net/sonic-platform-daemons",
              "sonic-net/sonic-py-swsssdk", "sonic-net/sonic-restapi", "sonic-net/sonic-snmpagent", "sonic-net/sonic-wpa-supplicant", "sonic-net/sonic-buildimage"];

function init(app) {
    app.log.info("[ AUTO CHERRY PICK ] Init auto cherry pick");

    app.on( ["pull_request.synchronize", "pull_request.labeled", "pull_request.closed"] , async (context) => {
        var payload = context.payload;

        let full_name = payload.repository.full_name
        var merged = payload.pull_request.merged
        let org = full_name.split('/')[0]
        let repo = full_name.split('/')[1]
        if (!repos.includes(full_name)) {
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
        param.push(`PR_COMMIT_SHA=${payload.pull_request.merge_commit_sha}`)
        param.push(`PR_MERGED=${merged}`)
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
            app.log.error(`[ AUTO CHERRY PICK ] Unexpected error! path: ${repo}/${run.output}`)
            return
        }
        app.log.info("[ AUTO CHERRY PICK ] finished.")
    });
};

module.exports = Object.freeze({
    init: init,
});
