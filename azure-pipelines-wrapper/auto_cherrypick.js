const akv = require('./keyvault');
const actionQueue = require('./action_queue');
const { Octokit } = require('@octokit/rest');
const repos = ["sonic-net/sonic-utilities", "sonic-net/sonic-swss", "sonic-net/sonic-sairedis", "sonic-net/sonic-swss-common", "sonic-net/sonic-dbsyncd", "sonic-net/sonic-gnmi", "sonic-net/sonic-host-services",
              "sonic-net/sonic-linkmgrd", "sonic-net/sonic-linux-kernel", "sonic-net/sonic-mgmt-common", "sonic-net/sonic-mgmt-framework", "sonic-net/sonic-platform-common", "sonic-net/sonic-platform-daemons",
              "sonic-net/sonic-py-swsssdk", "sonic-net/sonic-restapi", "sonic-net/sonic-snmpagent", "sonic-net/sonic-wpa-supplicant", "sonic-net/sonic-buildimage", "sonic-net/sonic-ztp", "sonic-net/sonic-dhcp-relay",
              "sonic-net/sonic-mgmt", "sonic-net/sonic-dhcpmon", "sonic-net/sonic-dash-api", "sonic-net/sonic-dash-ha", "sonic-net/sonic-bmp", "sonic-net/sonic-stp", "sonic-net/sonic-platform-vpp", "sonic-net/sonic-redfish"];

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

        actionQueue.enqueueAction(async () => {
            const gh_token = await akv.getGithubToken()
            let currentLabels = payload.pull_request.labels
            const requestPattern = /^Request for ((?:msft-)?\d{6}) Branch$/i
            if (payload.action == 'synchronize' ||
                (payload.action == 'labeled' && requestPattern.test(payload.label.name))) {
                const octokit = new Octokit({ auth: gh_token })
                currentLabels = await octokit.paginate(octokit.rest.issues.listLabelsOnIssue, {
                    owner: org, repo, issue_number: payload.number, per_page: 100,
                })
                const names = new Set(currentLabels.map(label => label.name.toLowerCase()))
                const hasTestedLabel = name => {
                    const match = name.match(requestPattern)
                    return !match || names.has(`tested for ${match[1]} branch`.toLowerCase())
                }
                if (payload.action == 'labeled' &&
                    (!names.has(payload.label.name.toLowerCase()) || !hasTestedLabel(payload.label.name))) {
                    app.log.info("[ AUTO CHERRY PICK ] Skip request without a current matching tested label")
                    return
                }
                // Newly added requests are handled by their own labeled webhooks.
                const eventLabels = new Set(payload.pull_request.labels.map(label => label.name.toLowerCase()))
                currentLabels = currentLabels.filter(label => hasTestedLabel(label.name) &&
                    (payload.action != 'synchronize' || !requestPattern.test(label.name) ||
                        eventLabels.has(label.name.toLowerCase())))
            }
            var param = Array()
            param.push(`FOLDER=cherrypick`)
            param.push(`ACTION=${payload.action}`)
            param.push(`REPO=${repo}`)
            param.push(`ORG=${org}`)
            param.push(`PR_NUMBER=${payload.number.toString()}`)
            param.push(`PR_URL=${payload.pull_request.html_url}`)
            param.push(`PR_OWNER=${payload.pull_request.user.login}`)
            param.push(`PR_BASE_BRANCH=${payload.pull_request.base.ref}`)
            param.push(`PR_PATCH_URL=${payload.pull_request.patch_url}`)
            param.push(`PR_COMMIT_SHA=${payload.pull_request.merge_commit_sha}`)
            param.push(`PR_MERGED=${merged}`)
            var labels = Array()
            for (const label of currentLabels) {
                labels.push(label.name)
            }
            param.push(`PR_LABELS="${labels.join(',')}"`)
            if (payload.action == 'labeled') {
                param.push(`ACTION_LABEL="${payload.label.name}"`)
                param.push(`ACTION_SENDER="${payload.sender.login}"`)
            }

            app.log.info(["[ AUTO CHERRY PICK ]"].concat(param).join(" "))

            const script_url = await akv.getSecretFromCache("AUTO_CHERRYPICK_SCRIPT_URL")
            const run = await actionQueue.runBashAction(param.concat([
                `GH_TOKEN=${gh_token}`,
                `SCRIPT_URL=${script_url}`,
            ]))
            if (run.status != 0){
                app.log.error(`[ AUTO CHERRY PICK ] Unexpected error! path: ${repo}/${run.output}`)
                return
            }
            app.log.info("[ AUTO CHERRY PICK ] finished.")
        }, `auto cherry pick ${repo}#${payload.number}`, app);
    });
};

module.exports = Object.freeze({
    init: init,
});
