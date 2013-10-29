#!/usr/bin/env node

var http = require("http")
  , url  = require("url")
  , fs   = require("fs")
  , path = require("path")
  , util = require("util")
  , crypto = require("crypto")
  , formidable = require('formidable');

var server = http.createServer(handleRequest);
var config = JSON.parse(fs.readFileSync("config.json"));

console.log("listening on port " + config['port']);
server.listen(config['port']);

function handleRequest(req, res) {
  try {
    if (req.method == "GET") {
      var parts = url.parse(req.url);
      if (parts.pathname == "/ping")
        handlePing(req, res);
      else
        handleDownload(req, res);
    }
    else if (req.method == "POST") {
      handleUpload(req, res);
    }
    else if (req.method == "OPTIONS") {
      res.writeHead(200, {
        "Access-Control-Allow-Origin": config["tracker"]
      });
      res.end();
    }
    else {
      throw "unknown error"
    }
  }
  catch (err) {
    handleError(res, err);
  }
}

function decodeToken(token) {
  if (!token)
    throw "token is required";

  var token_parts = new Buffer(token, "base64").toString().match(/^([^:]+):(.+)/);
  var hmac = crypto.createHmac("sha1", config["token"]);
  hmac.update(token_parts[2]);
  var valid = hmac.digest('hex');

  if (valid != token_parts[1])
    throw "invalid token";

  return JSON.parse(token_parts[2]);
}

function handleUpload(req, res) {
  var form = new formidable.IncomingForm({uploadDir: config['data_root']});
  form.hash = "sha1";
  form.parse(req, function(err, fields, files) {
    if (err) return handleError(res, err);
    if (!files.file) return handleError(res, "no file");    

    var data = decodeToken(fields.token);
    var upload = files.file;
    var dest = path.join(config['data_root'], upload.hash);
      
    function done () {
      var sha = crypto.createHash("sha1");
      sha.update([config['token'], upload.size, upload.hash].join(""));
      var sig = sha.digest("hex");
      var res_data = {
        hash: upload.hash,
        size: upload.size,
        filename: upload.name,
        server: config['id'],
        tags: fields.tags,
        sig: sig
      };
      var body = encodeURIComponent(
        (new Buffer(JSON.stringify(res_data))).toString("base64")
      );
      if (fields.is_js) {
        res.writeHead(200, {
          "Content-Type": "text/javascript",
          "Access-Control-Allow-Origin": config['tracker']
        });
        res.end(JSON.stringify({location: fields['return'] + "?" + body}));
      }
      else {
        res.writeHead(301, {"Location": fields['return'] + "?" + body});
        res.end();
      }
    }

    if (!fs.existsSync(dest)) {
      fs.rename(upload.path, dest, function(err) {
        if (err)
          handleError(res, err);
        else
          done();
      });
    }
    else {
      done();
    }
  });
}

function handlePing(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/javascript",
    "Access-Control-Allow-Origin": config['tracker']
  });
  res.end(JSON.stringify({success: "ok"}));
}

function handleDownload(req, res) {
  var parts = url.parse(req.url, true);
  var match = parts.pathname.match(/^\/download\/([^\/]+)/i);

  if (!match || !match.length)
    return handleError(res, "missing hash");

  var hash = match[1];
  var data = decodeToken(parts.query.token);
  var required = ['filename', 'time', 'size'];

  for (var i=0; i < required.length; i++) {
    if (!data[required[i]])
      throw required[i] + " is missing";
  }

  var time = (new Date()).getTime() / 1000;
  if (time - data['time'] > (60 * 10))
    throw "token is expired";

  var file = path.join(config['data_root'], hash);
  var stat = fs.stat(file, function(err, stat) {
    if (err)
      return handleError(res, "unable to find file");

    if (stat['size'] != data['size'])
      return handleError(res, "size does not match");

    if (parts.query.exists) {
      res.writeHead(200, {
        "Content-Type": "text/javascript",
        "Access-Control-Allow-Origin": config["tracker"]
      });
      res.end(JSON.stringify({success: "ok"}));
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="' + data['filename'] + '"',
      'Content-Length': stat.size
    });

    var stream = fs.createReadStream(file);
    stream.pipe(res);
  });
}

function handleError (res, error) {
  res.writeHead(200, {
    "Content-Type": "text/javascript",
    "Access-Control-Allow-Origin": config["tracker"]
  });
  res.end(JSON.stringify({error: error}));
}
