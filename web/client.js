/*global PalmSystem rectify deepCopy ajax */

function Country(x, y, grid) {
  this.grid = grid;
  this.owner = null;
  this.resource = null;
  this.city = false;
  this.stockpile = false;
  this.horse = false;
  this.weapon = false;
  this.boats = 0;
  this.x = x;
  this.y = y;
  this.mx = 100;
  this.rects = rectify(grid);
  this.renderDiv();
}

Country.prototype.renderDiv = function () {
  var div = this.div = document.createElement('div');
  div.style.top = (this.y * 24) + "px";
  div.style.left = (this.x * 24) + "px";
  div.sprite = this;
  this.setOwner(this.owner);
  this.renderLand();
  this.renderIcons();
  Country.container.appendChild(div);
};

Country.prototype.setOwner = function (owner) {
  this.owner = owner;
  var img = 'country';
  if (this.owner) {
    img += " " + this.owner.color;
  }
  this.div.setAttribute('class', img);
};

Country.prototype.setCity = function (city) {
  this.city = city;
  this.landDiv.setAttribute('class', 'land' + (city ? ' city' : ''));
};
Country.prototype.setWeapon = function (weapon) {
  this.weapon = weapon;
  this.renderIcons();
};
Country.prototype.setHorse = function (horse) {
  this.horse = horse;
  this.renderIcons();
};
Country.prototype.setStockpile = function (stockpile) {
  this.stockpile = stockpile;
  this.renderIcons();
};

Country.prototype.renderLand = function () {
  var land = document.createElement('div');
  land.setAttribute('class', 'land');
  this.rects.forEach(function (rect) {
    var chunk = document.createElement('div');
    chunk.setAttribute('class', 'bordered');
    chunk.style.top = (rect.y * 24 + 1) + "px";
    chunk.style.left = (rect.x * 24 + 1) + "px";
    chunk.style.width = (rect.w * 24 - 6) + "px";
    chunk.style.height = (rect.h * 24 - 6) + "px";
    land.appendChild(chunk);
  });
  this.rects.forEach(function (rect) {
    var chunk = document.createElement('div');
    chunk.style.top = (rect.y * 24 + 3) + "px";
    chunk.style.left = (rect.x * 24 + 3) + "px";
    chunk.style.width = (rect.w * 24 - 6) + "px";
    chunk.style.height = (rect.h * 24 - 6) + "px";
    land.appendChild(chunk);
  });
  if (this.landDiv) {
    this.div.replaceChild(land, this.landDiv);
  } else {
    this.div.appendChild(land);
  }
  this.landDiv = land;
};

Country.prototype.renderIcons = function () {
  var icons = document.createElement('div');
  icons.setAttribute('class', 'icons');
  var self = this; 
  var clone = deepCopy(this.grid);
  var n = 0;
  function findSpace() {
    n++;
    if (n > 1000) { 
      return { x: 0, y: 0 };
    }
    var y = Math.floor(Math.random() * clone.length);
    var row = clone[y];
    var x = Math.floor(Math.random() * row.length);
    if (row[x]) {
      row[x] = 0;
      return {x: x, y: y};
    }
    return findSpace();
  }
  function addIcon(name) {
    var icon = document.createElement('div');
    icon.setAttribute('class', name);
    var pos = findSpace();
    icon.style.top = (pos.y * 24 + 2) + "px";
    icon.style.left = (pos.x * 24 + 2) + "px";
    icons.appendChild(icon);
  }
  if (this.resource) {
    addIcon(this.resource);
  }
  if (this.horse) {
    addIcon('horse');
  }
  if (this.weapon) {
    addIcon('weapon');
  }
  if (this.stockpile) {
    addIcon('stockpile');
  }


  if (this.iconsDiv) {
    this.div.replaceChild(icons, this.iconsDiv);
  } else {
    this.div.appendChild(icons);
  }
  this.iconsDiv = icons;
};

function Player(name, color) {
  this.name = name;
  this.color = color;
}


window.addEventListener('load', function () {

  Country.container = document.getElementById('map');

  var people = ['blue', 'brown', 'green', 'orange', 'purple', 'red', 'yellow'
  ].map(function (color) {
    return new Player(color, color);
  });
  var countries;

  function loadLevel(url, callback) {
    ajax(url, function (err, level) {
      if (err) { return callback(err); }
      var countries = level.map(function (data) {
        var country = new Country(data[0], data[1], data[2]);
        return country;
      });
      callback(null, countries);
    });
  }
  loadLevel("maps/first.json", function (err, data) {
    if (err) { console.error(err.stack); return; }
    countries = data;

    ['gold', 'gold', 'tree', 'tree', 'iron', 'iron',
     'coal', 'coal', 'pasture', 'pasture', 'pasture'
    ].forEach(function (resource) {
      var country = countries.choose();
      while (country.resource) {
        country = countries.choose();
      }
      country.resource = resource;
      country.renderIcons();
    });

  });
    
  Array.prototype.choose = function () { 
    return this[Math.floor(Math.random() * this.length)];
  };

  function change(country) {
    var person = people.choose();
    if (country.owner === person) {
      switch (Math.floor(Math.random() * 4)) {
      case 0:
        country.setCity(true);
        break;
      case 1:
        country.setWeapon(true);
        break;
      case 2:
        country.setHorse(true);
        break;
      case 3:
        country.setStockpile(true);
        break;
      }
      country.setCity(true);
    } else {
      country.setOwner(person);
      country.setCity(false);
      country.setStockpile(false);
    }
  }

  window.addEventListener('click', onClick);

  function onClick(evt) {
    var target = evt.target;
    while (!target.sprite) {
      console.log(target);
      target = target.parentNode;
      if (target === document) {
        return;
      }
    }
    change(target.sprite);
  }
  
  // Start the palm system if we're in a webOS app
  if (typeof PalmSystem !== 'undefined') {
    PalmSystem.stageReady();
    if (PalmSystem.enableFullScreenMode) {
      PalmSystem.enableFullScreenMode(true);
    }
  }

});
