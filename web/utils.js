/*global XMLHttpRequest*/

// Deep Copy for nested arrays
function deepCopy(array) {
  return array.map(function (part) {
    if (typeof part === 'object') {
      return deepCopy(part);
    }
    return part;
  });
}

// Takes a grid and returns an optimal set of rectangles that fills that grid
function rectify(grid) {
  var rects = {};
  function findRect1(x, y) {
    var sx = x, sy = y, ex = x, ey = y;
    while (grid[sy - 1] && grid[sy - 1][x]) {
      sy--;
    }
    while (grid[ey + 1] && grid[ey + 1][x]) {
      ey++;
    }
    var good = true;
    var ty;
    while (good) {
      for (ty = sy; ty < ey + 1; ty++) {
        if (!grid[ty][sx - 1]) {
          good = false;
          break;
        }
      }
      if (good) {
        sx--;
      }
    }
    good = true;
    while (good) {
      for (ty = sy; ty < ey + 1; ty++) {
        if (!grid[ty][ex + 1]) {
          good = false;
          break;
        }
      }
      if (good) {
        ex++;
      }
    }
    return {
      x: sx,
      y: sy,
      w: ex - sx + 1,
      h: ey - sy + 1
    };
  }
  function findRect2(x, y) {
    var sx = x, sy = y, ex = x, ey = y;
    while (grid[y][sx - 1]) {
      sx--;
    }
    while (grid[y][ex + 1]) {
      ex++;
    }
    var good = true;
    var tx;
    while (good) {
      for (tx = sx; tx < ex + 1; tx++) {
        if (!(grid[sy - 1] && grid[sy - 1][tx])) {
          good = false;
          break;
        }
      }
      if (good) {
        sy--;
      }
    }
    good = true;
    while (good) {
      for (tx = sx; tx < ex + 1; tx++) {
        if (!(grid[ey + 1] && grid[ey + 1][tx])) {
          good = false;
          break;
        }
      }
      if (good) {
        ey++;
      }
    }
    return {
      x: sx,
      y: sy,
      w: ex - sx + 1,
      h: ey - sy + 1
    };
  }
  
  for (var y = 0, l1 = grid.length; y < l1; y++) {
    for (var x = 0, l2 = grid[y].length; x < l2; x++) {
      if (grid[y][x]) {
        rects[JSON.stringify(findRect1(x, y))] = true;
        rects[JSON.stringify(findRect2(x, y))] = true;
      }
    }
  }
  // TODO: Remove redundant rectangles
  return Object.keys(rects).map(function (json) {
    return JSON.parse(json);
  });
}

function ajax(url, callback) {
  var req = new XMLHttpRequest();
  req.onreadystatechange = function () {
    if (req.readyState === 4) {
      if (req.status === 200) {
        try {
          var data = JSON.parse(req.responseText);
          callback(null, data);
        } catch (err) {
          callback(err);
        }
      } else {
        callback(new Error(req.statusText));
      }
    }
  };
  req.open("GET", url, true);
  req.send("");
}
