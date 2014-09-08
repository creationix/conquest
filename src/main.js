"use strict";

var run = require('gen-run');

run(function* () {
  var json = yield getUrl("maps/first.json");
  console.log(json.split("\n").slice(1, 6).join("\n"));
  var map = JSON.parse(json);
  var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute("viewBox", "0 0 400 200");
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "100%");
  svg.setAttribute("id", "map");
  map.forEach(function (item) {
    var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute("d", renderCountry.apply(null, item));
    path.setAttribute("class", "country");
    svg.appendChild(path);
  });
  document.body.appendChild(svg);

});

// These are the vector tiles for the various corner shapes.
var combos = {
  o: ["h",8,"v",8,"h", -8,"v",-8],
  ul: ["q",[0,-1,-1,-1]],
  uu: ["v",-10],
  ur: ["v",-5,"q",[0,-4,4,-4],"h",5],
  ud: ["v",-5,"c",[0,-5,8,-5,8,0],"v",5],
  ru: ["q",[1,0,1,-1]],
  rr: ["h",10],
  rd: ["h",5,"q",[4,0,4,4],"v",5],
  rl: ["h",5,"c",[5,0,5,8,0,8],"h",-5],
  dr: ["q",[0,1,1,1]],
  dd: ["v",10],
  dl: ["v",5,"q",[0,4,-4,4],"h",-5],
  du: ["v",5,"c",[0,5,-8,5,-8,0],"v",-5],
  ld: ["q",[-1,0,-1,1]],
  ll: ["h",-10],
  lu: ["h",-5,"q",[-4,0,-4,-4],"v",-5],
  lr: ["h",-5,"c",[-5,0,-5,-8,0,-8],"h",5],
};

var letters = ["u", "r", "d", "l"];

function renderCountry(gx, gy, grid) {

  // Assume the first row will contain at least one positive square.
  // Find it and start tracing the outline.
  var x = -1, y = 0;
  while (grid[y][++x] === 0);

  var sx = x, sy = y;
  // d = 1 - right, 2 - down, 3 - left, 0 - up
  var d = 1; // We're moving right
  var od = -1; // We don't know where we came from yet
  var path = [];
  // ╔══ "lr"
  // ╚══
  // ╔═╗ "ud"
  // ║ ║
  // ╔══ "ur"
  // ║
  var first = null;
  while (true) {
    // Find the direction for the next segment
    if (d === 0) {
      if (grid[y][x - 1]) d = 3;
      else if (grid[y - 1] && grid[y - 1][x]) d = 0;
      else if (grid[y][x + 1]) d = 1;
      else if (grid[y + 1] && grid[y + 1][x]) d = 2;
      else d = -1;
    }
    else if (d === 1) {
      if (grid[y - 1] && grid[y - 1][x]) d = 0;
      else if (grid[y][x + 1]) d = 1;
      else if (grid[y + 1] && grid[y + 1][x]) d = 2;
      else if (grid[y][x - 1]) d = 3;
      else d = -1;
    }
    else if (d === 2) {
      if (grid[y][x + 1]) d = 1;
      else if (grid[y + 1] && grid[y + 1][x]) d = 2;
      else if (grid[y][x - 1]) d = 3;
      else if (grid[y - 1] && grid[y - 1][x]) d = 0;
      else d = -1;
    }
    else if (d === 3) {
      if (grid[y + 1] && grid[y + 1][x]) d = 2;
      else if (grid[y][x - 1]) d = 3;
      else if (grid[y - 1] && grid[y - 1][x]) d = 0;
      else if (grid[y][x + 1]) d = 1;
      else d = -1;
    }

    if (first === null) {
      first = d;
      if (d < 0) {
        path = combos.o;
        break;
      }
    }
    else {
      var turn = letters[od] + letters[d];
      var combo = combos[turn];
      path = path.concat(combo);
      if (d === first && x === sx && y === sy) {
        break;
      }
    }
    od = d;
    if (d === 0) y--;
    else if (d === 1) x++;
    else if (d === 2) y++;
    else if (d === 3) x--;
  }

  var m = "h", n = 0;
  var px = (sx + gx) * 10;
  var py = gy * 10;
  if (d === -1) { // o
    px += 1;
    py += 1;
  }
  else if (d === 2) { // ud
    px += 9;
    py += 10;
  }
  else {
    px += 10;
    py += 1;
  }

  // Build the path string, combine concurrent straight lines.
  var out = ["m" + px + " " + py];
  for (var i = 0; i < path.length; i += 2) {
    if (path[i] === m && typeof path[i + 1] === "number") {
      n += path[i + 1];
      continue;
    }
    if (n) out.push(m + n);
    m = path[i];
    n = path[i + 1];
    if (Array.isArray(n)) {
      out.push(m + n.join(" "));
      n = 0;
    }
  }
  if (n) out.push(m + n);
  out.push("z");

  return out.join(" ");
}

// Continuable based XHR GET request.
// Returns a string on 200, nothing on 404 and error on anything else.
function getUrl(url) {
  return function (callback) {
    var xhr = new XMLHttpRequest();
    xhr.open("GET", url, true);
    xhr.onreadystatechange = function () {
      if (this.readyState === 4) {
        if (this.status === 200) {
          callback(null, this.responseText);
        }
        else if (this.status === 404) {
          callback();
        }
        else {
          var err = new Error(this.responseText);
          err.status = this.status;
          callback(err);
        }
      }
    };
    xhr.send();
  };
}