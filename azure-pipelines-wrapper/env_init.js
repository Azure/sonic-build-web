const spawnSync = require('child_process').spawnSync;
const execFile = require('child_process').execFile;
const akv = require('./keyvault.js');
const { App, createNodeMiddleware } = require("@octokit/app");
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const MsChecker = 'ms_checker'
const InProgress = 'in_progress'
const COMPLETED = 'completed'
const PRPrefix = 'https://dev.azure.com/msazure/One/_git/Networking-acs-buildimage/pullrequest/'

async function init(app){
    while ( true ){
        let run = spawnSync('./env_init.sh', { encoding: 'utf-8' })
        if (run.status == 0){
            app.log.info(`[ INIT ] succeed!!!`)
            return
        }
        app.log.info(`[ INIT ] ${run.status} ${run.output}`)
        const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
        await delay(3000)
    }
}

async function daemon_run(app){
    setInterval(async function() {
        const uuid = uuidv4();
        try {
            fs.mkdirSync('daemon_lock')
        } catch(e) {
            if(e.code == 'EEXIST') {
                let lock = fs.statSync('daemon_lock').ctimeMs
                let now = Date.now()
                if (now - lock > 25 * 60 * 1000){
                    app.log.info(`[ DAEMON ] [${uuid}] lock more than 30 minutes. release lock!`);
                    fs.rmdirSync("daemon_lock");
                    return
                } else {
                    app.log.info(`[ DAEMON ] [${uuid}] daemon process return!`);
                    return
                }
            } else {
                throw(e)
            }
        }
        const privateKey = await akv.getAppPrivateKey();
        const secret = await akv.getAppWebhookSecret();
        var ms_checker_flag = await akv.getSecretFromCache("mschecker")

        let appclinet = new App({
            appId: process.env.APP_ID,
            privateKey: privateKey,
            webhooks: {
                secret: secret,
            },
        })
        let data = await appclinet.octokit.request("/app");
        app.log.info(`[ DAEMON ] [${uuid}] START ${data.data.name}!`);
        let oct = await appclinet.getInstallationOctokit(26573885);
        execFile('bash', ['-c', `env_init_daemon.sh ${uuid} 2>&1 > env_init_daemon.stdout | while IFS= read -r line; do echo [$(date +%FT%TZ)] [${uuid}] $line >> env_init_daemon.stderr; done; cat env_init_daemon.stdout`], { uid: 0, encoding: 'utf-8' }, async (error, stdout, stderr)=>{
            for (const line of stdout.split(/\r?\n/)){
                if (line.includes("ms_checker.detail: ")){
                    let detail = line.split(' ').pop()
                    if (detail.split(',').length == 3){
                        let result = detail.split(',')[0]
                        let commit = detail.split(',')[1]
                        let prid = detail.split(',')[2]
                        app.log.info(`[ DAEMON ] [${uuid}] Result: ${PRPrefix}${prid} ${result} ${commit}`);
                        if (ms_checker_flag == commit || ms_checker_flag == "all"){
                            param={
                                owner: 'sonic-net',
                                repo: 'sonic-buildimage',
                                head_sha: commit,
                                name: MsChecker,
                                output: {
                                    title: "MS PR validation",
                                    summary: `Please check result in ${PRPrefix}${prid}`,
                                },
                            }
                            if ( result == InProgress ) {
                                param.status = result
                            } else {
                                param.conclusion = result
                                param.status = COMPLETED
                            }
                            app.log.info(`[ DAEMON ] [${uuid}] check_create ${PRPrefix}${prid} ${result}`)
                            let re = await oct.request("POST /repos/sonic-net/sonic-buildimage/check-runs", param);
                            app.log.info(`[ DAEMON ] [${uuid}] check_create ${JSON.stringify(re.data)}`)
                        }
                    }
                }
            }
            app.log.info(`[ DAEMON ] [${uuid}] END!`);
        })
    }, 30 * 60 * 1000);
};

module.exports = {
    init,
    daemon_run,
}