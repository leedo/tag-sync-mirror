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

var sync = {
  size   : 3,
  poller : setInterval(pollTracker, 1000 * 60 * 10),
  syncer : setInterval(checkSyncQueue, 1000 * 5),
  queue  : [],
  jobs   : {}
};

pollTracker();

console.log("listening on port " + config['port']);
server.listen(config['port']);

//
// Try to download a file from each server until it succeeds
// or there are no servers left to try.
//
function downloadFile(download, servers) {
  // no servers left, give up
  if (!servers.length) {
    delete sync.jobs[download.hash];
    return;
  }

  var server = servers.pop();
  var parts = url.parse(server.url);

  // skip server if it is ourself
  if (server.id == config['id'])
    return downloadFile(download, servers);

  console.log("attempting to download " + download.filename + " from " + server.name);

  var req = http.request({
    method: "GET",
    hostname: parts['hostname'],
    port: parts['port'],
    path: "/download/" + download.hash + "?token=" + encodeURIComponent(server.token),
  }, function(res) {
    // error response
    if (res.headers["content-type"] == "text/javascript") {
      console.log(server.name + " did not have " + download.filename);
      var body = "";
      res.on('data', function(chunk) {
        body += chunk;
      });
      res.on('end', function() {
        var data = JSON.parse(body);
        downloadFile(download, servers);
      });
      return;
    }

    console.log("downloading " + download.filename + " from " + server.name);

    // data response
    var temp = path.join(config["data_root"], "tmp", download.hash);
    var write = fs.createWriteStream(temp);
    res.on('end', function() {
      var dest = path.join(config["data_root"], download.hash);
      fs.rename(temp, dest, function(err) {
        if (err) {
          console.log(err);
          delete sync.jobs[download.hash];
          return;
        }
        console.log("finished " + download.filename + " from " + server.name);
        delete sync.jobs[download.hash];
      });
    });
    // try another server
    res.on('error', function() {
      downloadFile(download, servers);
    });
    res.pipe(write);
  });

  req.on("error", function(e) {
    console.log("error from " + server.name + ": " + e);
    downloadFile(download, servers);
  });

  req.end();
}

//
// If there are downloads and open download slots, start one.
// This is called every minute.
//
function checkSyncQueue() {
  if (sync.queue.length == 0 || Object.keys(sync.jobs).length >= sync.size)
    return;

  var download = sync.queue.pop();
  var dest = path.join(config['data_root'], download.hash);
  if (fs.existsSync(dest) || sync.jobs[download.hash])
    return;

  var parts = url.parse(config['tracker']);
  var req = sync.jobs[download.hash] = http.request({
    method: "GET",
    hostname: parts['hostname'],
    port: parts['port'],
    path: "/tracker/api/upload/" + download.id + "/servers",
    headers: { "X-Server-Auth": config['token'] }
  }, function(res) {
    var body = "";
    res.on('data', function(chunk) {
      body += chunk;
    });
    res.on('end', function() {
      var data = JSON.parse(body);
      downloadFile(download, data.servers);
    });
  });
  req.end();
}

//
// Query the tracker for the most recent downloads
// that the server subscribes to (tags or users)
// This is called every 15 minutes.
//
function pollTracker() {
  var parts = url.parse(config['tracker']);
  var req = http.request({
    method: "GET",
    hostname: parts['hostname'],
    port: parts['port'],
    path: "/tracker/api/my/downloads",
    headers: { "X-Server-Auth": config['token'] }
  }, function(res) {
    var body = "";
    res.on('data', function(chunk) {
      body += chunk;
    });
    res.on('end', function() {
      var data = JSON.parse(body);
      for (var i=0; i < data.downloads.length; i++) {
        var download = data.downloads[i];
        var dest = path.join(config['data_root'], download.hash);
        if (!fs.existsSync(dest) && !sync.jobs[download.hash]) {
          console.log("enqueued " + download.filename);
          sync.queue.push(download);
        }
      }
    });
  });
  req.end();
}

//
// HTTP handlers
//
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

    if (fs.existsSync(dest)) {
      fs.unlinkPath(upload.path);
      done();
    }
    else {
      fs.rename(upload.path, dest, function(err) {
        if (err)
          handleError(res, err);
        else
          done();
      });
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
