#!/usr/bin/env node

var http = require("http")
  , url = require("url")
  , crypto = require("crypto")
  , fs = require("fs")
  , path = require("path")
  , util = require("util")
  , formidable = require('formidable');

var server = http.createServer(handleRequest);
var config = JSON.parse(fs.readFileSync("config.json"));

console.log("listening on port " + config['port']);

server.listen(config['port']);

function handleRequest(req, res) {
  if (req.method == "GET") {
    var parts = url.parse(req.url);
    if (parts.pathname == "/ping") {
      handlePing(req, res);
    }
    else {
      handleDownload(req, res);
    }
  }
  else if (req.method == "POST") {
    handleUpload(req, res);
  }
  handleError(res, "unknown error");
}

function handleUpload(req, res) {
  var parts = url.parse(req.url);
  var token = parts.query.token;

  if (!token)
    return handleError(res, "token is required");

  var token_parts = new Buffer(token, "base64").toString().split(":");
  var hmac = crypto.createHmac("sha1", config["token"]);
  hmac.update(token[1]);
  var valid = hmac.digest();

  if (valid != token_parts[0])
    return handleError(res, "invalid token");

  var data = JSON.parse(token_parts[1]);
  var form = new Formidable.IncomingForm();

  form.parse(req, function(err, fields, files) {
    if (err) return handleError(res, err);
    if (!files.length) return handleError(res, "no file");    

    var upload = files[0];
    var stream = fs.createReadStream(upload.path);
    var sha = crypto.createHash("sha1");
    sha.setEncoding("hex");

    function error(err) {
      handleError(res, err);
    }

    stream.on('error', error);
    stream.on('end', function () {
      sha.end();

      var hash = sha.read();
      var dest = fs.join(config['data'], hash);
      
      function done () {
        var sig = sha.update([config['token'], upload.size, hash].join(""));
        var res_data = {
          hash: hash,
          size: upload.size,
          filename: upload.name,
          server: config['id'],
          tags: parts.query.tags,
          sig: sig
        };
        res.writeHead(200, {
          "Content-Type": "text/javascript",
          "Access-Control-Allow-Origin": config['tracker']
        });
        res.end(JSON.stringify(res_data));
      }

      if (!fs.existsSync(dest)) {
        var source_stream = fs.createReadStream(upload.path);
        var dest_stream = fs.createReadStream(dest);
        source_stream.pipe(dest_stream);
        source_stream.on("end", done);
        source_stream.on("error", error);
      }
      else {
        done();
      }
    });

    stream.pipe(sha);
  });

  return;
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
  var token = parts.query.token;

  if (!token)
    return handleError(res, "token is required");

  var token_parts = new Buffer(token, "base64").toString().match(/^([^:]+):(.+)/);
  var hmac = crypto.createHmac("sha1", config["token"]);
  hmac.update(token_parts[2]);
  var valid = hmac.digest('hex');

  if (valid != token_parts[1])
    return handleError(res, "invalid token");

  var data = JSON.parse(token_parts[2]);
  var required = ['filename', 'time', 'size'];

  for (var i=0; i < required.length; i++) {
    if (!data[required[i]])
      return handleError(required[i] + " is missing");
  }

  var time = (new Date()).getTime() / 1000;
  if (time - data['time'] > (60 * 10)) {
    return handleError(res, "token is expired");
  }

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
