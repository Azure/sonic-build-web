var express = require('express');
var router = express.Router();
const util = require('util');
var utils = require('./utils');
const request = utils.request;
const constants = require('./constants');

const succeededBuildUrlFormat = "https://dev.azure.com/%s/%s/_apis/build/builds?definitions=%s&branchName=refs/heads/%s&resultFilter=succeeded&statusFilter=completed&$top=1";
const artifactUrlFormat = "https://dev.azure.com/%s/%s/_apis/build/builds/%s/artifacts?artifactName=%s";
const buildResultUrlFormat = "https://dev.azure.com/%s/%s/_build/results?buildId=%s&view=results";

const platformMapping = constants.PLATFORMS;

async function GetLatestBuild(req) {
  var params = req.params;
  var query = req.query;
  var succeededBuildUrl = util.format(succeededBuildUrlFormat, params.organization, params.project, params.definitionId, query.branchName);
  var buildRes = await request('GET', succeededBuildUrl);
  var build = JSON.parse(buildRes);
  return build;
}

async function RedirectArtifacts(req, res, next) {
    var params = req.params;
    var query = req.query;
    var buildId = params.buildId;
    if (isNaN(parseInt(buildId))){
        if (buildId != 'latest'){
              var message = util.format("The parameter buildId '%s' is not correct, should be a number value or the value 'laster'.", buildId);
              return res.status(400).json({status: 400, message: message});
        }

        var build = await GetLatestBuild(req);
        var value = build.value[0];
        buildId = value.id;
    }
    
    var artifactUrl = util.format(artifactUrlFormat, params.organization, params.project, buildId, query.artifactName);
    var artifactRes = await request('GET', artifactUrl, {headers: {"Content-type": "application/json"}});
    var artifact = JSON.parse(artifactRes);
    var downloadUrl = artifact.resource.downloadUrl;
    if (query.subPath != null){
        if (query.format != "zip"){
            var queryFormat = query.format == null ? 'file' : query.format;
            downloadUrl = downloadUrl.replace('format=zip', util.format('format=%s', queryFormat));
        }
        var subPath = query.subPath;
        if (!subPath.startsWith('/')){
            subPath = '/' + subPath;
        }
        downloadUrl = downloadUrl + "&subPath=" + encodeURIComponent(subPath);
    }
    res.redirect(downloadUrl);
}

async function RedirectSonicArtifacts(req, res, next) {
    var params = req.params;
    var query = req.query;
    params['organization'] = 'mssonic';
    params['project'] = 'build';
    params['buildId'] = "latest";
    if (query['buildId'] != null) {
        params['buildId'] = query['buildId'];
    }

    var definitionId = query.definitionId;
    var platform = query.platform;
    if (definitionId == null){
        if (platform == null){
            var message = "The parameter platform is empty.";
            return res.status(400).json({status: 400, message: message});
        }
        definitionId = platformMapping[platform];
        if (definitionId == null){
            var message = util.format("The platform '%s' is not defined.", platform);
            return res.status(400).json({status: 400, message: message});
        }
    }

    params['definitionId'] = definitionId;
    if (query.target != null){
        query.subPath = query.target;
    }
    
    if (query['artifactName'] == null){
        query['artifactName'] = 'sonic-buildimage.' + platform; 
    }

    await RedirectArtifacts(req, res, next);
}

/* Get the build artifacts for all public projects
*/
router.get('/azp/:organization/:project/_apis/build/definition/:definitionId/build/:buildId/artifacts', RedirectArtifacts);

/* Get the SONiC build artifacts */
router.get('/sonic/artifacts', RedirectSonicArtifacts);

module.exports = router;