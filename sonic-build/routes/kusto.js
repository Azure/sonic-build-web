const KustoClient = require("azure-kusto-data").Client;
const KustoConnectionStringBuilder = require("azure-kusto-data").KustoConnectionStringBuilder;
const ClientRequestProperties = require("azure-kusto-data").ClientRequestProperties;
const uuidv4 = require("uuid/v4");
const NodeCache = require( "node-cache" );
var utils = require('./utils');
const request = utils.request;

const clusterConectionString = "https://sonic.westus2.kusto.windows.net";
const database = "build";

const kcs = KustoConnectionStringBuilder.withAadManagedIdentities(clusterConectionString);
const kustoClient = new KustoClient(kcs);
const TEST = false;

/* Query builds from Azure Pipelines, only for test
   Only support to list the default branch for a definition, it is hard to list all the branches for Azure Pipelines API in a single query*/
async function test_queryBuilds(){
    var url = "https://dev.azure.com/mssonic/build/_apis/build/definitions?api-version=6.0&includeAllProperties=true";
    var definitionsRes = await request('GET', url);
    var definitions = JSON.parse(definitionsRes);
    var results = {};
    //Sequence, DefinitionId, DefinitionName, Platform, SourceBranch
    var rows = [];
    for (var i=0; i<definitions.value.length; i++){
        var row = [];
        var definition = definitions.value[i];
        if (definition.path.startsWith("\\selftest") || definition.path.startsWith("\\fips")){
            continue;
        }

        var platform =definition.name.startsWith("Azure.sonic-buildimage.official.") ? definition.name.substring(32) : "";
        row.push(rows.length+1);
        row.push(definition.id);
        row.push(definition.name);
        row.push(platform);
        row.push(definition.repository.defaultBranch);
        rows.push(row);
    }
    rows.sort((a, b) => a[2].localeCompare(b[2]));
    for (var i=0; i<rows.length; i++){
        rows[i][0] = i+1;
    }
    results['_rows'] = rows;
    return results;
}

async function query(queryString, timoutInSeconds = 1000 * 20, fromAzureAPI = false) {
    let clientRequestProps = new ClientRequestProperties();
    clientRequestProps.setTimeout(timoutInSeconds);
    clientRequestProps.clientRequestId = `MyApp.MyActivity;${uuidv4()}`;

    if (TEST || fromAzureAPI){
        return await test_queryBuilds();
    }

    try {
        results = await kustoClient.execute(database, queryString, clientRequestProps);
        var data = [];
        return results.primaryResults[0];
    }
    catch (error) {
        console.log(error);
        return error;
    }
}

function parseQueryResults(items){
    var columns = items['columns'];
    var rows = items['_rows'];
    var results = [];
    for (var i=0; i<rows.length; i++){
        var row = rows[i];
        var result = {};
        for (var j=0; j<columns.length; j++){
            result[columns[j].name]=row[j];
        }
        results.push(result);
    }

    return results;
}

function getColumnNames(items){
    var columns = items['columns'];
    var results = [];
    for (var i=0; i<columns.length; i++){
        results.push(columns[i].name);
    }
    return results;
}

module.exports = Object.freeze({
    query: query,
    parseQueryResults: parseQueryResults,
    getColumnNames: getColumnNames,
});