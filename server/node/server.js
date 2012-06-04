var http = require('http');
var join = require('path').join;

//make sure we're in the right directory (for static file serving to work)
process.chdir(join(__dirname, '../..'));

var BodyParser = require('./lib/body_parser');
var StaticServer = require('./lib/static_server');

var static = new StaticServer('./client');

var server = http.createServer(function (req, res) {
  var url = req.url.toLowerCase().split('?')[0];
  //remove trailing slash if present
  url = url.replace(/(.+)\/$/, '$1');
  //redirect to demo page
  if (url == '/') {
    res.writeHead('302', {'Location': '/demo.htm'});
    res.end();
    return;
  }
  //handle file upload (demo.htm posts to do-nothing.htm so we accept that too)
  if (url == '/server/upload' || url == '/do-nothing.htm') {
    handleUpload(req, res);
    return;
  }
  //try to serve a static file
  static.serve(req, res, function(err) {
    var status = err && err.status;
    if (status && status !== 200) {
      res.writeHead(status);
      res.end();
    }
  });
});

var handleUpload = function(req, res) {
  var parser = new BodyParser(req, res);
  parser.on('error', function(err) {
    if (typeof err == 'number') {
      res.writeHead(err);
      res.end();
    } else {
      throw err;
    }
  });
  parser.on('fileStart', function(file) {
    file.saveTo(join(__dirname, '../uploads'));
  });
  parser.on('end', function() {
    res.writeHead(200, {'Content-Type': 'text/plain'});
    res.write(JSON.stringify({success: true, parsed: this.parsed}));
    res.end();
  });
};

server.listen(3000, '0.0.0.0', function() {
  console.log('Server running at http://localhost:3000/');
});
