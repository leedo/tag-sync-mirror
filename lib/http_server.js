var http = require("http")
  , url  = require("url")
  , fs   = require("fs")
  , path = require("path")
  , util = require("util")
  , crypto = require("crypto")
  , formidable = require('formidable')
  , child_process = require("child_process")
  , config = require("./config");

function start() {
  var server = http.createServer(handleRequest);
  console.log("listening on port " + config.port);
  server.listen(config.port);
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
  var hmac = crypto.createHmac("sha1", config.token);
  hmac.update(json);
  var sig = hmac.digest('hex');
  return new Buffer([sig, json].join(":")).toString("base64");
}

function decodeToken(token) {
  if (!token)
    throw "token is required";

  var token_parts = new Buffer(token, "base64").toString("utf8").match(/^([^:]+):(.+)/);
  var hmac = crypto.createHmac("sha1", config.token);
  hmac.update(token_parts[2], "utf8");
  var valid = hmac.digest('hex');

  if (valid != token_parts[1])
    throw "invalid token";

  return JSON.parse(token_parts[2]);
}

function handleUpload(req, res) {
  var form = new formidable.IncomingForm({uploadDir: path.join(config.data_root, "tmp")})
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
      , dest = path.join(config.data_root, upload.hash);
      
    function done (streaming) {
      var sha = crypto.createHash("sha1");
      sha.update([config.token, upload.size, upload.hash].join(""));
      var sig = sha.digest("hex");
      var res_data = {
        hash: upload.hash,
        size: upload.size,
        filename: upload.name,
        streaming: streaming,
        server: config.id,
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
        fs.stat(dest, function(err, stat) {
          if (err) return handleError(req, res, err);
          done(stat.isDirectory());
        });
      });
    }
    else {
      if (config.cmd.zip && upload.name.match(/\.zip$/i)) {
        var unzip = child_process.spawn(config.cmd.zip, [upload.path, "-d", dest]);
        unzip.on("close", function() {
          fs.unlink(upload.path, function(err) {
            if (err) console.log(err);
            done(true);
          });
        });
        unzip.on("error", function(err) {
          handleError(req, res, err);
        });
      }
      else if (config.cmd.unrar && upload.name.match(/\.rar$/i)) {
        fs.mkdir(dest, function(err) {
          if (err) return handleError(req, res, err);
          var unrar = child_process.spawn(config.cmd.unrar, ["x", upload.path, dest]);
          unrar.on("close", function() {
            fs.unlink(upload.path, function(err) {
              if (err) console.log(err);
              done(true);
            });
          });
          unrar.on("error", function(err) {
            handleError(req, res, err);
          });
        });
      }
      else {
        fs.rename(upload.path, dest, function(err) {
          if (err)
            return handleError(req, res, err);
          done(false);
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
    , data = decodeToken(parts.query.token);

  ['filename', 'time', 'size'].forEach(function(field) {
    if (!data[field])
      throw filed + " is missing";
  });

  var time = (new Date()).getTime() / 1000;
  if (time - data['time'] > (60 * 10))
    throw "token is expired";

  var file = path.join(config.data_root, hash);
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
      var tar = child_process.spawn(config.cmd.tar, ["-cvf", "-", "."], {cwd: file});
      tar.on("error", function(err) {
        console.log(err);
      });
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
    var options = {};
    var status = 200;
    var headers = {
      "Content-Type": "audio/mp3",
      "Access-Control-Allow-Origin": corsHeader(req),
      "Accept-Ranges": "bytes",
      "Content-Length": data['size']
    };
    if (req.headers['range']) {
      var parts = req.headers['range'].split("=");
      if (parts[0] == "bytes") {
        var range = parts[1].split("-");
        if (range.length) {
          if (range[0] == "") {
            options['start'] = data['size'] - range[0];
            options['end'] = parseInt(data['size']) - 1;
          }
          else if (range[1] == "") {
            options['start'] = parseInt(range[0]);
            options['end'] = parseInt(data['size']) - 1;
          }
          else {
            options['start'] = parseInt(range[0]);
            options['end'] = parseInt(range[1]);
          }
          // skip 206 response if the range was 0- (full file)
          if (!(options['start'] == 0 && options['end'] == data['size'] - 1)) {
            status = 206;
            headers['Content-Length'] = (options['end'] - options['start']) + 1;
            headers['Content-Range'] = "bytes " + options['start']
              + "-" + options['end'] + "/" + data['size'];
          }
        }
      }
    }
    var stream = fs.createReadStream(data['track'], options);
    res.writeHead(status, headers);
    stream.pipe(res);
    return;
  }

  // handle playlist
  var dir = path.join(config.data_root, hash);
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
  if (req.headers['accept'].split(",").indexOf("text/html") > -1) {
    res.writeHead(200, {"Content-Type": "text/html"});
    res.end("<html><body><h1>Error</h1><p>" + error + "</p></body</html>");
  }
  else {
    res.writeHead(200, {
      "Content-Type": "text/javascript",
      "Access-Control-Allow-Origin": corsHeader(req)
    });
    res.end(JSON.stringify({error: error}));
  }
}

function corsHeader (req) {
  if (!req.headers['origin'])
    return config.tracker;

  var origin = url.parse(req.headers['origin']);
  var tracker_parts = url.parse(config.tracker);
  tracker_parts['protocol'] = origin['protocol'];
  return url.format(tracker_parts).replace(/\/$/, "");
}

module.exports = {
  start: start
};
