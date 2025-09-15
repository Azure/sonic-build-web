var express = require('express');
var router = express.Router();
var utils = require('./utils');
const request = utils.request;
const constants = require('./constants');
const kusto = require('./kusto');
const util = require('util');

const navigator_pipelines = [{name:'Pipelines', href:'/ui/sonic/Pipelines'}];

const buildUrlFormat = "https://dev.azure.com/mssonic/build/_apis/build/builds?definitions=%s&branchName=refs/heads/%s&statusFilter=completed";
const buildResultUrlFormat = "https://dev.azure.com/mssonic/build/_build/results?buildId=%s&view=artifacts&pathAsName=false&type=publishedArtifacts";
const artifactUrlFormat = "https://dev.azure.com/mssonic/build/_apis/build/builds/%s/artifacts";

const query_sonicimagebuilds = 'GetSonicImageBuilds() | project Sequence=row_number(), DefinitionId, DefinitionName, Platform, SourceBranch'
const query_sonicbuilds = 'GetSonicBuilds() | project Sequence=row_number(), DefinitionId, DefinitionName, Platform, SourceBranch'

function GetArtifactItems(items){
  var results = [];
  if (items == null){
    return results;
  }
  for(var i= 0; i < items.length; i++){
    var item = items[i];
    if (item.name.startsWith("/target/versions")
     || item.name.startsWith('/target/baseimage')){
      continue;
    }

    results.push(item);
    var itemResults = GetArtifactItems(item.items);
    item['items'] = null;
    results.push(...itemResults);
  }

  return results;
}

function GetArtifacts(artifacts){
    for(var item in artifacts.item);
}

/* Get SONiC pipelines */
router.get('/sonic/pipelines', async function(req, res, next) {
    var queryCommand = query_sonicimagebuilds;
    if (req.query.buildType == 'all'){
      queryCommand = query_sonicbuilds;
    }

    var fromAzureAPI = req.query.fromAzureAPI == 'true';
    var results = await kusto.query(queryCommand, 1000 * 20, fromAzureAPI=fromAzureAPI);
    if (results instanceof Error){
      res.status(500).json(results)
    } else {
      res.render('pipelines', { title: 'Pipelines',
        rows: results['_rows'],
        fromAzureAPI: fromAzureAPI,
        buildType: req.query.buildType,
        navigators:[] });
    }
})

/* Get SONiC builds. */
router.get('/sonic/pipelines/:definitionId/builds', async function(req, res, next) {
  var params = req.params;
  var query = req.query;
  var url = util.format(buildUrlFormat, params.definitionId, query.branchName);
  var buildsRes = await request('GET', url);
  var builds = JSON.parse(buildsRes);
  res.render('builds', { title: 'Builds',
      rows: builds['value'],
      branchName: query.branchName,
      navigators:navigator_pipelines });
});

/* Get SONiC artifacts. */
router.get('/sonic/pipelines/:definitionId/builds/:buildId/artifacts', async function(req, res, next) {
  var params = req.params;
  var query = req.query;
  var url = util.format(artifactUrlFormat, params.buildId);
  var navigator_builds = navigator_pipelines.concat([{name:'Builds', href:`/ui/sonic/pipelines/${params.definitionId}/builds?branchName=${query.branchName}`}]);
  var artifactsRes = await request('GET', url);
  var artifacts = JSON.parse(artifactsRes);
  for(var i=0; i<artifacts['value'].length; i++){
    var row = artifacts['value'][i];
    row["seq"] = i + 1;
    row["definitionId"] = params.definitionId;
    row["buildId"] = params.buildId;
  }
  res.render('artifact-names', { title: 'Artifacts',
      rows: artifacts['value'],
      branchName: query.branchName,
      navigators: navigator_builds});
  });

/* Get SONiC artifact files. */
router.get('/sonic/pipelines/:definitionId/builds/:buildId/artifacts/:artifactId', async function(req, res, next) {
    var params = req.params;
    var query = req.query;
    var sourceUrl = util.format(buildResultUrlFormat, params.buildId);
    var navigator_artifacts = navigator_pipelines.concat([{name:'Builds', href:`/sonic/pipelines/${params.definitionId}/builds?branchName=${query.branchName}`},
    {name:'Artifacts', href:`/ui/sonic/pipelines/${params.definitionId}/builds/${params.buildId}/artifacts?branchName=${query.branchName}`},
    ]);
    var url = 'https://dev.azure.com/mssonic/_apis/Contribution/HierarchyQuery/project/be1b070f-be15-4154-aade-b1d3bfb17054';
    var body = {"contributionIds":["ms.vss-build-web.run-artifacts-data-provider"],
    "dataProviderContext":{"properties":{
      "artifactId":params.artifactId,
      "buildId":params.buildId,
      "sourcePage":{
        "url": sourceUrl,
        "routeValues":{"project":"build","action":"Execute"}
      }}}};
    var options = {
      headers: {'accept': 'application/json;api-version=5.0-preview.1',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    };
    var artifactsRes = await request('POST', url,  options);
    var artifacts = JSON.parse(artifactsRes);
    var dataProvider = artifacts['dataProviders']['ms.vss-build-web.run-artifacts-data-provider'];
    var items = GetArtifactItems(dataProvider.items);
    for (var i=0; i<items.length; i++){
        items[i]['seq'] = i + 1;
    }
    var platform = constants.DEFINITIONS[params.definitionId];
    var artifactUrl = "/api/sonic/artifacts?branchName=" + query.branchName;
    if (platform != null){
        artifactUrl = artifactUrl + "&platform=" + platform;
    }
    else{
        artifactUrl = artifactUrl + "&definitionId=" + params.definitionId + "&artifactName=" + query.artifactName;
    }
    res.render('artifacts', { title: 'Artifact ' + query.artifactName,
      rows: items,
      artifactUrl: artifactUrl,
      buildId: params.buildId,
      navigators: navigator_artifacts});
});

module.exports = router;