var http = require("http")
  , url  = require("url")
  , fs   = require("fs")
  , path = require("path")
  , util = require("util")
  , crypto = require("crypto")
  , child_process = require("child_process")
  , formidable = require('formidable');


var server = http.createServer(handleRequest)
  , config = JSON.parse(fs.readFileSync("config.json"));

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

  var server = servers.pop()
    , parts = url.parse(server.url);

  // skip server if it is ourself
  if (server.id == config['id'])
    return downloadFile(download, servers);

  console.log("attempting to download " + download.filename + " from " + server.name);

  var req = http.request({
    method: "GET",
    hostname: parts['hostname'],
    port: parts['port'],
    path: "/download/" + download.hash + "?token=" + encodeURIComponent(server.token),
    headers: {"User-Agent": "server-" + config['id']}
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
    headers: {
      "X-Server-Auth": config['token'],
      "User-Agent": "server-" + config['id']
    }
  }, function(res) {
    var body = "";
    res.on('data', function(chunk) {
      body += chunk;
    });
    res.on('error', function(e) {
      console.log("error reading server list response from tracker: " + e);
    });
    res.on('end', function() {
      try {
        var data = JSON.parse(body);
        if (!data.servers)
          throw "no servers in response";
        downloadFile(download, data.servers);
      }
      catch (e) {
        console.log(e);
      }
    });
  });
  req.on("error", function(e) {
    console.log("erroring fetching server list from tracker: " . e);
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
    headers: {
      "X-Server-Auth": config['token'],
      "User-Agent": "server-" + config['id']
    }
  }, function(res) {
    var body = "";
    res.on('data', function(chunk) {
      body += chunk;
    });
    res.on("error", function(e) {
      console.log("error reading poll response from tracker: " + e);
    });
    res.on('end', function() {
      try {
        var data = JSON.parse(body);
        if (!data.downloads)
          throw "no downloads";
      }
      catch(e) {
        console.log(e);
        return;
      }

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
  req.on("error", function(e) {
    console.log("error polling tracker: " + e);
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
      else if (parts.pathname.match(/^\/streamer\//))
        handleStreamer(req, res);
      else
        handleDownload(req, res);
    }
    else if (req.method == "POST") {
      handleUpload(req, res);
    }
    else if (req.method == "OPTIONS") {
      res.writeHead(200, {
        "Access-Control-Allow-Origin": corsHeader(req)
      });
      res.end();
    }
    else {
      throw "unknown error"
    }
  }
  catch (err) {
    handleError(req, res, err);
  }
}

function buildToken(data) {
  var json = JSON.stringify(data);
  var hmac = crypto.createHmac("sha1", config['token']);
  hmac.update(json);
  var sig = hmac.digest('hex');
  return new Buffer([sig, json].join(":")).toString("base64");
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
  var form = new formidable.IncomingForm({uploadDir: path.join(config['data_root'], "tmp")})
    , tags = [];

  form.hash = "sha1";
  form.addListener("field", function(field, value) {
    if (field == "tags")
      tags.push(value);
  });

  form.parse(req, function(err, fields, files) {
    if (err) return handleError(req, res, err);
    if (!files.file || files.file.size == 0)
      return handleError(req, res, "no file");    

    var data = decodeToken(fields.token)
      , upload = files.file
      , dest = path.join(config['data_root'], upload.hash);
      
    function done (filename) {
      var sha = crypto.createHash("sha1");
      sha.update([config['token'], upload.size, upload.hash].join(""));
      var sig = sha.digest("hex");
      var res_data = {
        hash: upload.hash,
        size: upload.size,
        filename: filename,
        server: config['id'],
        tags: tags,
        sig: sig
      };
      var body = encodeURIComponent(
        (new Buffer(JSON.stringify(res_data))).toString("base64")
      );
      if (fields.is_js) {
        res.writeHead(200, {
          "Content-Type": "text/javascript",
          "Access-Control-Allow-Origin": corsHeader(req)
        });
        res.end(JSON.stringify({location: fields['return'] + "?" + body}));
      }
      else {
        res.writeHead(301, {"Location": fields['return'] + "?" + body});
        res.end();
      }
    }

    if (fs.existsSync(dest)) {
      fs.unlink(upload.path, function(err) {
        if (err) console.log(err); // non-fatal
        done(upload.name);
      });
    }
    else {
      if (upload.name.match(/\.zip$/i)) {
        var unzip = child_process.spawn("unzip", [upload.path, "-d", dest]);
        unzip.on("close", function() {
          fs.unlink(upload.path, function(err) {
            if (err) console.log(err);
            done("");
          });
        });
        unzip.on("error", function() {
          handleError(req, res, err);
        });
      }
      else {
        fs.rename(upload.path, dest, function(err) {
          if (err)
            return handleError(req, res, err);
          done(upload.name);
        });
      }
    }
  });
}

function handlePing(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/javascript",
    "Access-Control-Allow-Origin": corsHeader(req)
  });
  res.end(JSON.stringify({success: "ok"}));
}

function handleDownload(req, res) {
  var parts = url.parse(req.url, true)
    , match = parts.pathname.match(/^\/download\/([^\/]+)/i);

  if (!match || !match.length)
    return handleError(req, res, "missing hash");

  var hash = match[1]
    , data = decodeToken(parts.query.token)
    , required = ['filename', 'time', 'size'];

  for (var i=0; i < required.length; i++) {
    if (!data[required[i]])
      throw required[i] + " is missing";
  }

  var time = (new Date()).getTime() / 1000;
  if (time - data['time'] > (60 * 10))
    throw "token is expired";

  var file = path.join(config['data_root'], hash);
  fs.stat(file, function(err, stat) {
    if (err)
      return handleError(req, res, "unable to find file");

    if (stat.isFile() && stat['size'] != data['size'])
      return handleError(req, res, "size does not match");

    if (parts.query.exists) {
      res.writeHead(200, {
        "Content-Type": "text/javascript",
        "Access-Control-Allow-Origin": corsHeader(req)
      });
      res.end(JSON.stringify({success: "ok"}));
      return;
    }

    if (stat.isFile()) {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="' + data['filename'] + '"',
        'Content-Length': stat.size
      });
      var stream = fs.createReadStream(file);
      stream.pipe(res);
    }
    else {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="' + data['filename'] + '.tar"',
      });
      var tar = child_process.spawn("tar", ["-cvf", "-", "."], {cwd: file});
      tar.stdout.pipe(res);
    }
  });
}

function handleStreamer (req, res) {
  var parts = url.parse(req.url, true)
    , match = parts.pathname.match(/^\/streamer\/([^\/]+)/i)
    , data = decodeToken(parts.query.token)
    , time = (new Date()).getTime() / 1000;

  if (!match || !match.length)
    return handleError(req, res, "missing hash");

  var hash = match[1];

  if (time - data['time'] > (60 * 10))
    throw "token is expired";

  // handle single track
  if (data['track']) {
    var stream = fs.createReadStream(data['track']);
    res.writeHead(200, {
      "Content-Type": "audio/mp3",
      "Access-Control-Allow-Origin": corsHeader(req),
      "Content-Length": data['size']
    });
    stream.pipe(res);
    return;
  }

  // handle playlist
  var dir = path.join(config['data_root'], hash);
  findAudio(dir, function(err, files) {
    if (err) return handleError(req, res, err);

    var urls = []
      , base = url.parse("http://" + req.headers['host'] + parts.pathname, true);

    files.forEach(function(file) {
      base.query.token = buildToken({
        time: ((new Date()).getTime() / 1000),
        size: file.size,
        track: file.path
      });

      urls.push({
        name: file.name,
        url: url.format(base)
      });
    });

    res.writeHead(200, {
      "Content-Type": "text/javascript",
      "Access-Control-Allow-Origin": corsHeader(req)
    });

    res.end(JSON.stringify({success: true, tracks: urls}));
  });
}

function findAudio (dir, done) {
  var pattern = /\/([^.][^\/]*)\.(mp3|aac|mp4|ogg)$/i
    , matches = [];
  fs.readdir(dir, function(err, files) {
    if (err) return done(err);
    var pending = files.length;
    files.forEach(function(file) {
      file = path.join(dir, file);
      fs.stat(file, function (err, stat) {
        if (err) return done(err);
        if (stat && stat.isDirectory()) {
          findAudio(file, function(err, res) {
            if (err) return done(err);
            matches = matches.concat(res);
            if (!--pending) done(null, matches);
          });
        }
        else {
          var match = file.match(pattern);
          if (match && match.length)
            matches.push({
              path: file,
              name: match[1],
              size: stat.size
            });
          if (!--pending) done(null, matches);
        }
      });
    });
  });
}

function handleError (req, res, error) {
  res.writeHead(200, {
    "Content-Type": "text/javascript",
    "Access-Control-Allow-Origin": corsHeader(req)
  });
  res.end(JSON.stringify({error: error}));
}

function corsHeader (req) {
  if (!req.headers['origin'])
    return config['tracker'];

  var origin = url.parse(req.headers['origin']);
  var tracker_parts = url.parse(config['tracker']);
  tracker_parts['protocol'] = origin['protocol'];
  return url.format(tracker_parts).replace(/\/$/, "");
}
