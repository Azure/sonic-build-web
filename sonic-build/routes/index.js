var express = require('express');
var router = express.Router();
const url = require('url'); 

/* GET home page. */
router.get('/', function(req, res, next) {
  //res.status(404).send('Not Found');
  res.redirect('/ui/sonic/pipelines');
});

// UI entry
router.get('/pipelines', function(req, res, next) {
  res.redirect('/ui/sonic/pipelines');
});

/* Get the SONiC build artifacts */
router.get('/sonic/artifacts', function(req, res, next) { // Deprecated
  res.redirect(url.format({
    pathname: '/api/sonic/artifacts',
    query: req.query,
  }));
});

module.exports = router;