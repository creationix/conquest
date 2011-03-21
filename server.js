
var PORT = process.env.PORT || 8086;

// Serve static files and log requests to the server
require('http').createServer(require('stack')(
  require('creationix/log')(),
  require('creationix/static')('/', 'web', 'index.html')
)).listen(PORT);

console.log("Exploder server running at http://localhost:%s", PORT);

