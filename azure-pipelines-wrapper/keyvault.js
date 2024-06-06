const { DefaultAzureCredential } = require("@azure/identity");
const { SecretClient } = require("@azure/keyvault-secrets");
const NodeCache = require( "node-cache" );
require('dotenv').config();

const keyVaultName = process.env["KEY_VAULT_NAME"];
const KVUri = "https://" + keyVaultName + ".vault.azure.net";
const credential = new DefaultAzureCredential();
const client = new SecretClient(KVUri, credential);
const SecretCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

SecretCache.on( "expired", async function( key, value ){
    var newValue = await client.getSecret(key);
    SecretCache.set(key, newValue.value);
});

async function getSecretFromCache(secretName){
    if (! process.env.KEY_VAULT_NAME){
        return process.env[secretName];
    }

    secretName = secretName.split('_').join('-');
    var value = SecretCache.get(secretName);
    if (value == undefined){
        var secret = await client.getSecret(secretName);
        SecretCache.set(secretName, secret.value);
        return secret.value;
    }
    return value;
}

async function getAppPrivateKey()
{
    return await getSecretFromCache("PRIVATE_KEY");
}

async function getAppWebhookSecret()
{
    return await getSecretFromCache("WEBHOOK_SECRET");
}
async function getAzDevOpsToken()
{
    return await getSecretFromCache("MSSONIC_TOKEN");
}
async function getGithubToken()
{
    return await getSecretFromCache("GITHUB_TOKEN");
}

async function getEventhubConnectionstring()
{
    return await getSecretFromCache("EVENTHUB_CONNECTIONSTRING");
}

module.exports = Object.freeze({
    getAppPrivateKey: getAppPrivateKey,
    getAppWebhookSecret: getAppWebhookSecret,
    getAzDevOpsToken: getAzDevOpsToken,
    getSecretFromCache: getSecretFromCache,
    getGithubToken: getGithubToken,
    getEventhubConnectionstring: getEventhubConnectionstring,
});
