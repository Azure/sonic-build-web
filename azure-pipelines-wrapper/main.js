const { Server, Probot } = require("probot");
const app = require("./index.js");
const akv = require('./keyvault.js');

async function startServer() {
    var privateKey = await akv.getAppPrivateKey();
    var secret = await akv.getAppWebhookSecret();
    const server = new Server({
        Probot: Probot.defaults({
        appId: process.env.APP_ID,
        privateKey: privateKey,
        secret: secret,
        }),
        port: 8080,
        webhookPath: process.env.WEBHOOK_PATH,
        webhookProxy: process.env.WEBHOOK_PROXY_URL,
    });

    server.expressApp.get("/", (req, res) => res.end("Welcome GitHub Application: Azure Pipelines Wrapper"));
    await server.load(app);

    server.start();
}


(async () => {
    const txt = await startServer();
    console.log(txt);
})();