var poller = require("./lib/poller")
  , http_server = require("./lib/http_server");

poller.start();
http_server.start(); // blocks
