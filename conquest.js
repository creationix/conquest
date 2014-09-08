#!js
var bundler = require('./lib/wheaty-cjs-bundler/bundler.js');
module.exports = bundler("src/main.js", ["lib"]);