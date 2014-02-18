var which = require("which")
  , fs   = require("fs");

var cmd = {
  unrar: find_cmd("unrar"),
  tar: find_cmd("tar"),
  unzip: find_cmd("unzip")
};

function find_cmd(cmd) {
  var path = false;
  try {
    path = which.sync(cmd);
  }
  catch(e) {
    path = false;
  }
  return path;
}

if (!cmd.tar)
  throw "tar is required";

var config = JSON.parse(fs.readFileSync("config.json"));
config.cmd = cmd;

module.exports = config;
