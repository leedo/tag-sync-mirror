var http = require("http")
  , url  = require("url")
  , fs   = require("fs")
  , path = require("path")
  , child_process = require("child_process")
  , config = require("./config");

var sync = {
  size   : 3,
  poller : null, 
  syncer : null, 
  queue  : [],
  jobs   : {}
};

function start() {
  sync.poller = setInterval(pollTracker, 1000 * 60 * 10);
  sync.syncer = setInterval(checkSyncQueue, 1000 * 5);
  pollTracker();
}

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
  if (server.id == config.id)
    return downloadFile(download, servers);

  console.log("attempting to download " + download.hash + " from " + server.name);

  var req = http.request({
    method: "GET",
    hostname: parts['hostname'],
    port: parts['port'],
    path: "/download/" + download.hash + "?token=" + encodeURIComponent(server.token),
    headers: {"User-Agent": "server-" + config.id}
  }, function(res) {
    // error response
    if (res.headers["content-type"] == "text/javascript") {
      console.log(server.name + " did not have " + download.hash);
      req.abort();
      downloadFile(download, servers);
      return;
    }

    console.log("downloading " + download.hash + " from " + server.name);

    // data response
    var temp = path.join(config.data_root, "tmp", download.hash);
    var write = fs.createWriteStream(temp);

    res.on('end', function() {
      var dest = path.join(config.data_root, download.hash);
      var cleanup = function(err) {
        delete sync.jobs[download.hash];
        if (err) console.log(err);
        fs.exists(temp, function(exists) {
          if (!exists) return;
          fs.unlink(temp, function(err) {
            if (err) console.log(err);
          });
        });
      };

      if (download.streaming) {
        fs.mkdir(dest, function(err) {
          if (err) return cleanup(err);
          var untar = child_process.spawn(config.cmd.tar, ["-xvf", path.resolve(temp)], {cwd: dest});
          untar.on("error", cleanup);
          untar.on("close", function() {
            console.log("finished " + download.hash + " from " + server.name);
            cleanup();
          });
        });
      } else {
        fs.rename(temp, dest, function(err) {
          if (err) return cleanup(err);
          console.log("finished " + download.hash + " from " + server.name);
          cleanup();
        });
      }
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
  var dest = path.join(config.data_root, download.hash);
  if (fs.existsSync(dest) || sync.jobs[download.hash])
    return;

  var parts = url.parse(config.tracker);
  var req = sync.jobs[download.hash] = http.request({
    method: "GET",
    hostname: parts['hostname'],
    port: parts['port'],
    path: "/config.api/upload/" + download.id + "/servers",
    headers: {
      "X-Server-Auth": config.token,
      "User-Agent": "server-" + config.id
    }
  }, function(res) {
    var body = "";
    res.on('data', function(chunk) {
      body += chunk;
    });
    res.on('error', function(e) {
      console.log("error reading server list response from config. " + e);
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
    console.log("erroring fetching server list from config. " . e);
  });
  req.end();
}

//
// Query the config.for the most recent downloads
// that the server subscribes to (tags or users)
// This is called every 15 minutes.
//
function pollTracker() {
  var parts = url.parse(config.tracker);
  var req = http.request({
    method: "GET",
    hostname: parts['hostname'],
    port: parts['port'],
    path: "/config.api/my/downloads",
    headers: {
      "X-Server-Auth": config.token,
      "User-Agent": "server-" + config.id
    }
  }, function(res) {
    var body = "";
    res.on('data', function(chunk) {
      body += chunk;
    });
    res.on("error", function(e) {
      console.log("error reading poll response from config. " + e);
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

      data.downloads.forEach(function(download) {
        var dest = path.join(config.data_root, download.hash);
        if (!fs.existsSync(dest) && !sync.jobs[download.hash]) {
          console.log("enqueued " + download.hash);
          sync.queue.push(download);
        }
      });
    });
  });
  req.on("error", function(e) {
    console.log("error polling config. " + e);
  });
  req.end();
}


module.exports = {
  start: start
}
