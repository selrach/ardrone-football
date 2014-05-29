(function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);throw new Error("Cannot find module '"+o+"'")}var f=n[o]={exports:{}};t[o][0].call(f.exports,function(e){var n=t[o][1][e];return s(n?n:e)},f,f.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
"use strict";
module.exports = Histogram;
function Histogram(histogramSize) {
  this._prev = Date.now();
  this._histogram = [];
  for (var i = 0; i < histogramSize; i++) {
    this._histogram.push(0);
  }
}

Histogram.prototype.tick = function() {
  var latency = Date.now() - this._prev;
  this._histogram.push(latency);
  this._histogram.shift();
  this._prev = Date.now();
};

Histogram.prototype.values = function() {
  return this._histogram;
};

},{}],2:[function(require,module,exports){
/* global document, NodecopterStream, window, requestAnimationFrame, Uint8Array */
"use strict";
var Histogram = require('./histogram');
var WsClient = require('./ws_client');
var PID = require('./pid');

var videoDiv = document.getElementById('video');
var ns = new NodecopterStream(videoDiv, {port: 3001});
var videoCanvas = videoDiv.querySelector('canvas');
var aspectRatio = videoCanvas.width / videoCanvas.height;
var overlayCanvas = document.getElementById('overlay');
var overlayContext = overlayCanvas.getContext('2d');
var frameBuffer = new Uint8Array(videoCanvas.width * videoCanvas.height * 4);
var videoHistogram = new Histogram(200);
var navdataHistogram = new Histogram(200);
var render = renderer();
var detect = detector({maxDiff: 0.05});
var lastNavdata;
var pickedColor;
var detected;
var xPID = new PID({pGain: 0.15, iGain: 0, dGain: 0});
var yPID = new PID({pGain: 0.15, iGain: 0, dGain: 0});
var client = new WsClient();
var state;
setState('ground');

// main gets this party started.
(function main() {
  maximizeVideo();
  renderLoop();
  ns.onNextFrame(frameLoop);
  client.on('navdata', function (data) {
    lastNavdata = data;
    navdataHistogram.tick();
  });
})();

// renderLoop drives the renderer.
function renderLoop() {
  render();
  requestAnimationFrame(renderLoop);
}

// frameLoop analyzes incoming video frames.
function frameLoop() {
  videoHistogram.tick();

  if (pickedColor) {
    detect();
  }

  ns.onNextFrame(frameLoop);
}

// detector returns a function that tries to find a colored object in the image.
function detector(options) {
  var maxDiff = options.maxDiff;
  var w = videoCanvas.width;
  var h = videoCanvas.height;
  var b = frameBuffer;

  var missCnt = 0;
  var hitCnt = 0;

  return function detect() {
    ns.getImageData(b);

    var count = 0;
    var xSum = 0;
    var ySum = 0;
//    var newColor = [0,0,0,0];
    for (var x = 1; x < w - 1; x++) {
      for (var y = 1; y < h - 1; y++) {
        var match = true;
        for (var xj = -1; xj <= 1 && match; xj++) {
          for (var yj = -1; yj <= 1 && match; yj++) {
            var o = (x + xj) * 4 + (h - (y + yj)) * w * 4;
            for (var i = 0; i < pickedColor.length && match; i++) {
              var diffPercent = Math.abs(b[o + i] - pickedColor[i]) / 255;
              if (diffPercent > maxDiff) {
                match = false;
              }
//              else {
//                newColor[i] += b[o+i];
//              }
            }
          }
        }

        if (match) {
          count++;
          xSum += x;
          ySum += y;
        }
      }
    }

    if(count < 5) {
      detected = false;
      count = 1;
    } else {
//      for(var k=0;k<newColor.length; k++) {
//        pickedColor[k] = Math.floor((pickedColor[k] + Math.floor(newColor[k]  / count)) / 2);
//      }
      detected = {x: xSum / count, y: ySum / count};
      var xVal = (detected.x - w / 2) / (w / 2);
      var yVal = (detected.y - h / 2) / (h / 2);
      xPID.update(xVal);
      yPID.update(yVal);
    }

    if (state === 'follow') {
      if (detected === false) {
        missCnt++;
        if(missCnt < 2) {
          client.stop();
          hitCnt = 0;
        }
        if (missCnt % 300 === 100) {
          client.animate('turnaround',250);
        }
      } else {
        missCnt = 0;
        hitCnt++;
        if(hitCnt > 5) {
          client.right(-xPID.pid().sum);
        }
        if(hitCnt > 30) {
          client.front(0.2);
        }
      }
    } else {
      client.stop();
    }
  };
}

// renderer returns a function to render the overlay canvas. The coordinate
// system is set up so that (0,0) is the top left of the canvas.
function renderer() {
  var padding = 10;
  var spacing = 20;
  var c = overlayContext;
  var w = overlayCanvas.width;
  var h = overlayCanvas.height;
  var opacity = 0.3;

  function renderHistograms(histograms) {
    var offset = 0;
    histograms.forEach(function (h) {
      renderHistogram(h.label, h.values, h.limit, offset);
      offset += h.values.length + spacing;
    });
  }

  function renderHistogram(label, values, limit, offset) {
    // offset is number of pixels from right to offset the histogram.
    offset = offset || 0;
    var fontSize = 20;

    c.fillStyle = 'rgba(255,255,255,' + opacity + ')';
    c.font = fontSize + 'px Arial';
    var labelWidth = c.measureText(label).width;
    c.fillText(label, w - (labelWidth / 2) - (values.length / 2) - padding - offset, h - padding);

    for (var i = 0; i < values.length; i++) {
      var x = w - i - padding - offset;
      c.beginPath();
      c.moveTo(x, h - fontSize - padding);
      c.lineTo(x, h - values[i] - fontSize - padding);
      c.strokeStyle = 'rgba(255,255,255,' + opacity + ')';
      c.stroke();
    }

    var limitY = h - fontSize - padding - limit;
    c.beginPath();
    c.moveTo(w - padding - values.length - offset, limitY);
    c.lineTo(w - padding - offset, limitY);
    c.strokeStyle = 'rgba(255,0,0,' + opacity + ')';
    c.stroke();
  }

  return function render() {
    c.clearRect(0, 0, w, h);

    // detected object
    (function () {
      if (!detected) {
        return;
      }

      var x = videoToOverlayX(detected.x);
      var y = videoToOverlayY(detected.y);

      c.beginPath();
      c.moveTo(x, 0);
      c.lineTo(x, overlayCanvas.height);
      c.strokeStyle = 'rgba(255,0,0,1)';
      c.stroke();

      c.beginPath();
      c.moveTo(0, y);
      c.lineTo(overlayCanvas.width, y);
      c.strokeStyle = 'rgba(255,0,0,1)';
      c.stroke();
    })();

    // xPID
    (function () {
      var pid = xPID.pid();
      var fontSize = 14;
      var bars = [
        {label: 'p', val: pid.p, color: '255,0,0'},
        {label: 'i', val: pid.i, color: '0,255,0'},
        {label: 'd', val: pid.d, color: '0,0,255'},
        {label: 'pid', val: pid.sum, color: '255,255,255'}
      ];
      var bh = 10;
      var yo = h / 2 - ((bh + fontSize + padding) * bars.length) / 2;

      bars.forEach(function (bar, i) {
        var y = yo + i * (bh + fontSize + padding);
        var bw = Math.abs(bar.val * w / 2);
        var x = w / 2;
        if (bar.val > 0) {
          x -= bw;
        }
        c.fillStyle = 'rgba(' + bar.color + ',' + opacity * 2 + ')';
        c.fillRect(x, y, bw, bh);

        c.fillStyle = 'rgba(255,255,255,' + opacity + ')';
        c.font = fontSize + 'px Arial';
        c.fillText(bar.label, w / 2, y - padding);
      });

    })();

    renderHistograms([
      {label: 'video', values: videoHistogram.values(), limit: 1000 / 30},
      {label: 'navdata', values: navdataHistogram.values(), limit: 1000 / 15}
    ]);

    // battery meter
    (function () {
      var value;
      try {
        value = lastNavdata.demo.batteryPercentage;
      } catch (err) {
        value = 0;
      }
      var fullWidth = 70;
      var fullHeight = 24;
      var fontSize = 14;
      var width = (fullWidth - 2) * value / 100;
      var label = value + ' %';
      var x = w - fullWidth - padding;
      var y = padding;

      c.fillStyle = 'rgba(255,255,255,' + opacity + ')';
      c.fillRect(x, y, fullWidth, fullHeight);
      if (value < 30) {
        c.fillStyle = 'rgba(255,0,0,' + opacity + ')';
      } else if (value < 50) {
        c.fillStyle = 'rgba(255,255,0,' + opacity + ')';
      } else {
        c.fillStyle = 'rgba(0,255,0,' + opacity + ')';
      }
      c.fillRect(x + 1, y + 1, width, fullHeight - 2);

      c.fillStyle = 'rgba(0,0,0,' + opacity + ')';
      c.font = fontSize + 'px Arial';
      var labelWidth = c.measureText(label).width;
      c.fillText(label, x + (fullWidth / 2) - (labelWidth / 2), y + (fullHeight / 2) + (fontSize / 2) - 1);
    })();

    // color picker
    (function () {
      var x = padding;
      var y = padding;
      var size = 50;
      c.fillStyle = 'rgba(255,255,255,' + opacity + ')';
      c.fillRect(x, y, size, size);

      if (pickedColor) {
        c.fillStyle = 'rgba(' + pickedColor[0] + ',' + pickedColor[1] + ',' + pickedColor[2] + ',1)';
        c.fillRect(x + 1, y + 1, size - 2, size - 2);
      }
    })();
  };
}

// Keep video maximized within browser window while keeping the aspect ratio
// intact.
window.addEventListener('resize', maximizeVideo);
function maximizeVideo() {
  var width, height;
  var windowRatio = window.innerWidth / window.innerHeight;
  if (windowRatio > aspectRatio) {
    height = window.innerHeight;
    width = height * aspectRatio;
  } else {
    width = window.innerWidth;
    height = width / aspectRatio;
  }
  [videoCanvas, overlayCanvas].forEach(function (canvas) {
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    canvas.style.marginTop = ((window.innerHeight - height) / 2) + 'px';
    canvas.style.marginLeft = ((window.innerWidth - width) / 2) + 'px';
  });
}

overlayCanvas.addEventListener('click', function (event) {
  var x = overlayToVideoX(event.offsetX);
  var y = overlayToVideoY(event.offsetY);
  pickedColor = pickedColor || new Uint8Array(4);
  ns.getImageData(pickedColor, x, videoCanvas.height - y, 1, 1);
});

function overlayToVideoX(x) {
  return Math.round((x / parseFloat(videoCanvas.style.width)) * videoCanvas.width);
}

function overlayToVideoY(y) {
  return Math.round((y / parseFloat(videoCanvas.style.height)) * videoCanvas.height);
}

function videoToOverlayX(x) {
  return Math.round(x / videoCanvas.width * overlayCanvas.width);
}

function videoToOverlayY(y) {
  return Math.round(y / videoCanvas.height * overlayCanvas.height);
}

function setState(val) {
  console.log('new state: ' + val);
  state = val;
}

var flightButton = document.getElementById('flight');
flightButton.addEventListener('click', function () {
  if (this.textContent === 'Start') {
    setState('takeoff');
    client.on('altitudeChange', function (v) {
        console.log(v);
      if (v < 0.2) {
        this.down(0.001);
        this.up(0.1);
      } else if (v < 0.3 && v > 0.25) {
        this.down(0.05);
      } else if (v > 0.6) {
        this.down(0.4);
      } else if (v > 0.5) {
        this.down(0.3);
      } else if (v > 0.4) {
        this.down(0.2);
      }
    }
  );
  client.takeoff(function () {
    setState('follow');
    client.down(0.1);
  });
  this.textContent = 'Stop';
}
else
{
  setState('land');
  client.land(function () {
    setState('ground');
  });
  this.textContent = 'Start';
}
})
;

},{"./histogram":1,"./pid":3,"./ws_client":4}],3:[function(require,module,exports){
"use strict";

module.exports = PID;
function PID(options) {
  this._pGain = options.pGain || 0;
  this._iGain = options.iGain || 0;
  this._dGain = options.dGain || 0;
  this._min = options.min || -1;
  this._max = options.max || 1;
  this._zero = options.zero || 0;

  this._p = 0;
  this._i = 0;
  this._d = 0;
  this._sum = 0;

  this._target = 0;
  this._sumErr = 0;
  this._lastErr = 0;
  this._lastTime = null;

  this.target(0);
}

PID.prototype.target = function(val) {
  if (val === undefined) {
    return this._target;
  }
  this._sumErr = 0;
  this._lastErr = 0;
  this._lastTime = null;
  this._sum = this._p = this._i = this._d = this._zero;
  this._target = val;
  return this._target;
};

PID.prototype.update = function(val) {
  var now = Date.now();
  var dt = 0;
  if (this._lastTime !== null) {
    dt = (now - this._lastTime) / 1000;
  }
  this._lastTime = now;

  var err = this._target - val;
  var dErr = (err - this._lastErr)*dt;
  this._sumErr += err * dt;
  this._lastErr = err;

  this._p = this._pGain*err;
  this._i = this._iGain*this._sumErr;
  this._d = this._dGain*dErr;
  this._sum = this._p+this._i+this._d;
  if (this._sum < this._min) {
    this._sum = this._min;
  } else if (this._sum > this._max) {
    this._sum = this._max;
  }
};

PID.prototype.pid = function() {
  return {p: this._p, i: this._i, d: this._d, sum: this._sum};
};

},{}],4:[function(require,module,exports){
/* global window, WebSocket */ 
"use strict";
module.exports = WsClient;
function WsClient() {
  this._conn = null;
  this._connected = false;
  this._queue = [];
  this._listeners = {};
  this._takeoffCbs = [];
  this._landCbs = [];
  this._connect();
}

WsClient.prototype._connect = function() {
  var self = this;
  self._conn = new WebSocket('ws://'+window.location.host);
  self._conn.onopen = function() {
    self._connected = true;
    self._queue.forEach(function(msg) {
      self._conn.send(msg);
    });
    self._queue = [];

    self._conn.onmessage = function(msg) {
      try {
        msg = JSON.parse(msg.data);
      } catch (err) {
        console.error(err);
        return;
      }
      var kind = msg.shift();
      switch (kind) {
        case 'takeoff':
          self._takeoffCbs.forEach(function(cb) {
            cb();
          });
          self._takeoffCbs = [];
          break;
        case 'land':
          self._landCbs.forEach(function(cb) {
            cb();
          });
          self._landCbs = [];
          break;
        case 'on':
          var event = msg.shift();
          self._listeners[event].forEach(function(cb) {
            cb.apply(self, msg);
          });
          break;
        default:
          console.error('unknown message: '+kind);
      }
    };
  };

};

WsClient.prototype._send = function(msg) {
  msg = JSON.stringify(msg);
  if (!this._connected) {
    this._queue.push(msg);
    return;
  }
  this._conn.send(msg);
};

WsClient.prototype.on = function(event, cb) {
  var cbs = this._listeners[event] = this._listeners[event] || [];
  cbs.push(cb);
  if (cbs.length === 1) {
    this._send(['on', event]);
  }
};

WsClient.prototype.takeoff = function(cb) {
  this._send(['takeoff']);
  if (cb) {
    this._takeoffCbs.push(cb);
  }
};

WsClient.prototype.land = function(cb) {
  this._send(['land']);
  if (cb) {
    this._landCbs.push(cb);
  }
};

WsClient.prototype.right = function(val) {
  this._send(['right', val]);
};

WsClient.prototype.clockwise = function(val) {
  this._send(['clockwise', val]);
};

WsClient.prototype.down = function(val) {
  this._send(['down', val]);
};

WsClient.prototype.up = function(val) {
  this._send(['up', val]);
};

WsClient.prototype.front = function(val) {
  this._send(['front', val]);
};

WsClient.prototype.clockwise = function(val) {
  this._send(['clockwise', val]);
};

WsClient.prototype.animate = function(val, time) {
  this._send(['animate', val, time]);
};

WsClient.prototype.stop = function() {
  this._send(['stop']);
};

},{}]},{},[2])
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZ2VuZXJhdGVkLmpzIiwic291cmNlcyI6WyIvaG9tZS9jaHVjay9kZXYvd29ya3NwYWNlL2FyZHJvbmUtZm9vdGJhbGwvbm9kZV9tb2R1bGVzL2Jyb3dzZXJpZnkvbm9kZV9tb2R1bGVzL2Jyb3dzZXItcGFjay9fcHJlbHVkZS5qcyIsIi9ob21lL2NodWNrL2Rldi93b3Jrc3BhY2UvYXJkcm9uZS1mb290YmFsbC9mcm9udGVuZC9qcy9oaXN0b2dyYW0uanMiLCIvaG9tZS9jaHVjay9kZXYvd29ya3NwYWNlL2FyZHJvbmUtZm9vdGJhbGwvZnJvbnRlbmQvanMvbWFpbi5qcyIsIi9ob21lL2NodWNrL2Rldi93b3Jrc3BhY2UvYXJkcm9uZS1mb290YmFsbC9mcm9udGVuZC9qcy9waWQuanMiLCIvaG9tZS9jaHVjay9kZXYvd29ya3NwYWNlL2FyZHJvbmUtZm9vdGJhbGwvZnJvbnRlbmQvanMvd3NfY2xpZW50LmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBO0FDQUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3BCQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3hYQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUMvREE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EiLCJzb3VyY2VzQ29udGVudCI6WyIoZnVuY3Rpb24gZSh0LG4scil7ZnVuY3Rpb24gcyhvLHUpe2lmKCFuW29dKXtpZighdFtvXSl7dmFyIGE9dHlwZW9mIHJlcXVpcmU9PVwiZnVuY3Rpb25cIiYmcmVxdWlyZTtpZighdSYmYSlyZXR1cm4gYShvLCEwKTtpZihpKXJldHVybiBpKG8sITApO3Rocm93IG5ldyBFcnJvcihcIkNhbm5vdCBmaW5kIG1vZHVsZSAnXCIrbytcIidcIil9dmFyIGY9bltvXT17ZXhwb3J0czp7fX07dFtvXVswXS5jYWxsKGYuZXhwb3J0cyxmdW5jdGlvbihlKXt2YXIgbj10W29dWzFdW2VdO3JldHVybiBzKG4/bjplKX0sZixmLmV4cG9ydHMsZSx0LG4scil9cmV0dXJuIG5bb10uZXhwb3J0c312YXIgaT10eXBlb2YgcmVxdWlyZT09XCJmdW5jdGlvblwiJiZyZXF1aXJlO2Zvcih2YXIgbz0wO288ci5sZW5ndGg7bysrKXMocltvXSk7cmV0dXJuIHN9KSIsIlwidXNlIHN0cmljdFwiO1xubW9kdWxlLmV4cG9ydHMgPSBIaXN0b2dyYW07XG5mdW5jdGlvbiBIaXN0b2dyYW0oaGlzdG9ncmFtU2l6ZSkge1xuICB0aGlzLl9wcmV2ID0gRGF0ZS5ub3coKTtcbiAgdGhpcy5faGlzdG9ncmFtID0gW107XG4gIGZvciAodmFyIGkgPSAwOyBpIDwgaGlzdG9ncmFtU2l6ZTsgaSsrKSB7XG4gICAgdGhpcy5faGlzdG9ncmFtLnB1c2goMCk7XG4gIH1cbn1cblxuSGlzdG9ncmFtLnByb3RvdHlwZS50aWNrID0gZnVuY3Rpb24oKSB7XG4gIHZhciBsYXRlbmN5ID0gRGF0ZS5ub3coKSAtIHRoaXMuX3ByZXY7XG4gIHRoaXMuX2hpc3RvZ3JhbS5wdXNoKGxhdGVuY3kpO1xuICB0aGlzLl9oaXN0b2dyYW0uc2hpZnQoKTtcbiAgdGhpcy5fcHJldiA9IERhdGUubm93KCk7XG59O1xuXG5IaXN0b2dyYW0ucHJvdG90eXBlLnZhbHVlcyA9IGZ1bmN0aW9uKCkge1xuICByZXR1cm4gdGhpcy5faGlzdG9ncmFtO1xufTtcbiIsIi8qIGdsb2JhbCBkb2N1bWVudCwgTm9kZWNvcHRlclN0cmVhbSwgd2luZG93LCByZXF1ZXN0QW5pbWF0aW9uRnJhbWUsIFVpbnQ4QXJyYXkgKi9cblwidXNlIHN0cmljdFwiO1xudmFyIEhpc3RvZ3JhbSA9IHJlcXVpcmUoJy4vaGlzdG9ncmFtJyk7XG52YXIgV3NDbGllbnQgPSByZXF1aXJlKCcuL3dzX2NsaWVudCcpO1xudmFyIFBJRCA9IHJlcXVpcmUoJy4vcGlkJyk7XG5cbnZhciB2aWRlb0RpdiA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCd2aWRlbycpO1xudmFyIG5zID0gbmV3IE5vZGVjb3B0ZXJTdHJlYW0odmlkZW9EaXYsIHtwb3J0OiAzMDAxfSk7XG52YXIgdmlkZW9DYW52YXMgPSB2aWRlb0Rpdi5xdWVyeVNlbGVjdG9yKCdjYW52YXMnKTtcbnZhciBhc3BlY3RSYXRpbyA9IHZpZGVvQ2FudmFzLndpZHRoIC8gdmlkZW9DYW52YXMuaGVpZ2h0O1xudmFyIG92ZXJsYXlDYW52YXMgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgnb3ZlcmxheScpO1xudmFyIG92ZXJsYXlDb250ZXh0ID0gb3ZlcmxheUNhbnZhcy5nZXRDb250ZXh0KCcyZCcpO1xudmFyIGZyYW1lQnVmZmVyID0gbmV3IFVpbnQ4QXJyYXkodmlkZW9DYW52YXMud2lkdGggKiB2aWRlb0NhbnZhcy5oZWlnaHQgKiA0KTtcbnZhciB2aWRlb0hpc3RvZ3JhbSA9IG5ldyBIaXN0b2dyYW0oMjAwKTtcbnZhciBuYXZkYXRhSGlzdG9ncmFtID0gbmV3IEhpc3RvZ3JhbSgyMDApO1xudmFyIHJlbmRlciA9IHJlbmRlcmVyKCk7XG52YXIgZGV0ZWN0ID0gZGV0ZWN0b3Ioe21heERpZmY6IDAuMDV9KTtcbnZhciBsYXN0TmF2ZGF0YTtcbnZhciBwaWNrZWRDb2xvcjtcbnZhciBkZXRlY3RlZDtcbnZhciB4UElEID0gbmV3IFBJRCh7cEdhaW46IDAuMTUsIGlHYWluOiAwLCBkR2FpbjogMH0pO1xudmFyIHlQSUQgPSBuZXcgUElEKHtwR2FpbjogMC4xNSwgaUdhaW46IDAsIGRHYWluOiAwfSk7XG52YXIgY2xpZW50ID0gbmV3IFdzQ2xpZW50KCk7XG52YXIgc3RhdGU7XG5zZXRTdGF0ZSgnZ3JvdW5kJyk7XG5cbi8vIG1haW4gZ2V0cyB0aGlzIHBhcnR5IHN0YXJ0ZWQuXG4oZnVuY3Rpb24gbWFpbigpIHtcbiAgbWF4aW1pemVWaWRlbygpO1xuICByZW5kZXJMb29wKCk7XG4gIG5zLm9uTmV4dEZyYW1lKGZyYW1lTG9vcCk7XG4gIGNsaWVudC5vbignbmF2ZGF0YScsIGZ1bmN0aW9uIChkYXRhKSB7XG4gICAgbGFzdE5hdmRhdGEgPSBkYXRhO1xuICAgIG5hdmRhdGFIaXN0b2dyYW0udGljaygpO1xuICB9KTtcbn0pKCk7XG5cbi8vIHJlbmRlckxvb3AgZHJpdmVzIHRoZSByZW5kZXJlci5cbmZ1bmN0aW9uIHJlbmRlckxvb3AoKSB7XG4gIHJlbmRlcigpO1xuICByZXF1ZXN0QW5pbWF0aW9uRnJhbWUocmVuZGVyTG9vcCk7XG59XG5cbi8vIGZyYW1lTG9vcCBhbmFseXplcyBpbmNvbWluZyB2aWRlbyBmcmFtZXMuXG5mdW5jdGlvbiBmcmFtZUxvb3AoKSB7XG4gIHZpZGVvSGlzdG9ncmFtLnRpY2soKTtcblxuICBpZiAocGlja2VkQ29sb3IpIHtcbiAgICBkZXRlY3QoKTtcbiAgfVxuXG4gIG5zLm9uTmV4dEZyYW1lKGZyYW1lTG9vcCk7XG59XG5cbi8vIGRldGVjdG9yIHJldHVybnMgYSBmdW5jdGlvbiB0aGF0IHRyaWVzIHRvIGZpbmQgYSBjb2xvcmVkIG9iamVjdCBpbiB0aGUgaW1hZ2UuXG5mdW5jdGlvbiBkZXRlY3RvcihvcHRpb25zKSB7XG4gIHZhciBtYXhEaWZmID0gb3B0aW9ucy5tYXhEaWZmO1xuICB2YXIgdyA9IHZpZGVvQ2FudmFzLndpZHRoO1xuICB2YXIgaCA9IHZpZGVvQ2FudmFzLmhlaWdodDtcbiAgdmFyIGIgPSBmcmFtZUJ1ZmZlcjtcblxuICB2YXIgbWlzc0NudCA9IDA7XG4gIHZhciBoaXRDbnQgPSAwO1xuXG4gIHJldHVybiBmdW5jdGlvbiBkZXRlY3QoKSB7XG4gICAgbnMuZ2V0SW1hZ2VEYXRhKGIpO1xuXG4gICAgdmFyIGNvdW50ID0gMDtcbiAgICB2YXIgeFN1bSA9IDA7XG4gICAgdmFyIHlTdW0gPSAwO1xuLy8gICAgdmFyIG5ld0NvbG9yID0gWzAsMCwwLDBdO1xuICAgIGZvciAodmFyIHggPSAxOyB4IDwgdyAtIDE7IHgrKykge1xuICAgICAgZm9yICh2YXIgeSA9IDE7IHkgPCBoIC0gMTsgeSsrKSB7XG4gICAgICAgIHZhciBtYXRjaCA9IHRydWU7XG4gICAgICAgIGZvciAodmFyIHhqID0gLTE7IHhqIDw9IDEgJiYgbWF0Y2g7IHhqKyspIHtcbiAgICAgICAgICBmb3IgKHZhciB5aiA9IC0xOyB5aiA8PSAxICYmIG1hdGNoOyB5aisrKSB7XG4gICAgICAgICAgICB2YXIgbyA9ICh4ICsgeGopICogNCArIChoIC0gKHkgKyB5aikpICogdyAqIDQ7XG4gICAgICAgICAgICBmb3IgKHZhciBpID0gMDsgaSA8IHBpY2tlZENvbG9yLmxlbmd0aCAmJiBtYXRjaDsgaSsrKSB7XG4gICAgICAgICAgICAgIHZhciBkaWZmUGVyY2VudCA9IE1hdGguYWJzKGJbbyArIGldIC0gcGlja2VkQ29sb3JbaV0pIC8gMjU1O1xuICAgICAgICAgICAgICBpZiAoZGlmZlBlcmNlbnQgPiBtYXhEaWZmKSB7XG4gICAgICAgICAgICAgICAgbWF0Y2ggPSBmYWxzZTtcbiAgICAgICAgICAgICAgfVxuLy8gICAgICAgICAgICAgIGVsc2Uge1xuLy8gICAgICAgICAgICAgICAgbmV3Q29sb3JbaV0gKz0gYltvK2ldO1xuLy8gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpZiAobWF0Y2gpIHtcbiAgICAgICAgICBjb3VudCsrO1xuICAgICAgICAgIHhTdW0gKz0geDtcbiAgICAgICAgICB5U3VtICs9IHk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZihjb3VudCA8IDUpIHtcbiAgICAgIGRldGVjdGVkID0gZmFsc2U7XG4gICAgICBjb3VudCA9IDE7XG4gICAgfSBlbHNlIHtcbi8vICAgICAgZm9yKHZhciBrPTA7azxuZXdDb2xvci5sZW5ndGg7IGsrKykge1xuLy8gICAgICAgIHBpY2tlZENvbG9yW2tdID0gTWF0aC5mbG9vcigocGlja2VkQ29sb3Jba10gKyBNYXRoLmZsb29yKG5ld0NvbG9yW2tdICAvIGNvdW50KSkgLyAyKTtcbi8vICAgICAgfVxuICAgICAgZGV0ZWN0ZWQgPSB7eDogeFN1bSAvIGNvdW50LCB5OiB5U3VtIC8gY291bnR9O1xuICAgICAgdmFyIHhWYWwgPSAoZGV0ZWN0ZWQueCAtIHcgLyAyKSAvICh3IC8gMik7XG4gICAgICB2YXIgeVZhbCA9IChkZXRlY3RlZC55IC0gaCAvIDIpIC8gKGggLyAyKTtcbiAgICAgIHhQSUQudXBkYXRlKHhWYWwpO1xuICAgICAgeVBJRC51cGRhdGUoeVZhbCk7XG4gICAgfVxuXG4gICAgaWYgKHN0YXRlID09PSAnZm9sbG93Jykge1xuICAgICAgaWYgKGRldGVjdGVkID09PSBmYWxzZSkge1xuICAgICAgICBtaXNzQ250Kys7XG4gICAgICAgIGlmKG1pc3NDbnQgPCAyKSB7XG4gICAgICAgICAgY2xpZW50LnN0b3AoKTtcbiAgICAgICAgICBoaXRDbnQgPSAwO1xuICAgICAgICB9XG4gICAgICAgIGlmIChtaXNzQ250ICUgMzAwID09PSAxMDApIHtcbiAgICAgICAgICBjbGllbnQuYW5pbWF0ZSgndHVybmFyb3VuZCcsMjUwKTtcbiAgICAgICAgfVxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgbWlzc0NudCA9IDA7XG4gICAgICAgIGhpdENudCsrO1xuICAgICAgICBpZihoaXRDbnQgPiA1KSB7XG4gICAgICAgICAgY2xpZW50LnJpZ2h0KC14UElELnBpZCgpLnN1bSk7XG4gICAgICAgIH1cbiAgICAgICAgaWYoaGl0Q250ID4gMzApIHtcbiAgICAgICAgICBjbGllbnQuZnJvbnQoMC4yKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICBjbGllbnQuc3RvcCgpO1xuICAgIH1cbiAgfTtcbn1cblxuLy8gcmVuZGVyZXIgcmV0dXJucyBhIGZ1bmN0aW9uIHRvIHJlbmRlciB0aGUgb3ZlcmxheSBjYW52YXMuIFRoZSBjb29yZGluYXRlXG4vLyBzeXN0ZW0gaXMgc2V0IHVwIHNvIHRoYXQgKDAsMCkgaXMgdGhlIHRvcCBsZWZ0IG9mIHRoZSBjYW52YXMuXG5mdW5jdGlvbiByZW5kZXJlcigpIHtcbiAgdmFyIHBhZGRpbmcgPSAxMDtcbiAgdmFyIHNwYWNpbmcgPSAyMDtcbiAgdmFyIGMgPSBvdmVybGF5Q29udGV4dDtcbiAgdmFyIHcgPSBvdmVybGF5Q2FudmFzLndpZHRoO1xuICB2YXIgaCA9IG92ZXJsYXlDYW52YXMuaGVpZ2h0O1xuICB2YXIgb3BhY2l0eSA9IDAuMztcblxuICBmdW5jdGlvbiByZW5kZXJIaXN0b2dyYW1zKGhpc3RvZ3JhbXMpIHtcbiAgICB2YXIgb2Zmc2V0ID0gMDtcbiAgICBoaXN0b2dyYW1zLmZvckVhY2goZnVuY3Rpb24gKGgpIHtcbiAgICAgIHJlbmRlckhpc3RvZ3JhbShoLmxhYmVsLCBoLnZhbHVlcywgaC5saW1pdCwgb2Zmc2V0KTtcbiAgICAgIG9mZnNldCArPSBoLnZhbHVlcy5sZW5ndGggKyBzcGFjaW5nO1xuICAgIH0pO1xuICB9XG5cbiAgZnVuY3Rpb24gcmVuZGVySGlzdG9ncmFtKGxhYmVsLCB2YWx1ZXMsIGxpbWl0LCBvZmZzZXQpIHtcbiAgICAvLyBvZmZzZXQgaXMgbnVtYmVyIG9mIHBpeGVscyBmcm9tIHJpZ2h0IHRvIG9mZnNldCB0aGUgaGlzdG9ncmFtLlxuICAgIG9mZnNldCA9IG9mZnNldCB8fCAwO1xuICAgIHZhciBmb250U2l6ZSA9IDIwO1xuXG4gICAgYy5maWxsU3R5bGUgPSAncmdiYSgyNTUsMjU1LDI1NSwnICsgb3BhY2l0eSArICcpJztcbiAgICBjLmZvbnQgPSBmb250U2l6ZSArICdweCBBcmlhbCc7XG4gICAgdmFyIGxhYmVsV2lkdGggPSBjLm1lYXN1cmVUZXh0KGxhYmVsKS53aWR0aDtcbiAgICBjLmZpbGxUZXh0KGxhYmVsLCB3IC0gKGxhYmVsV2lkdGggLyAyKSAtICh2YWx1ZXMubGVuZ3RoIC8gMikgLSBwYWRkaW5nIC0gb2Zmc2V0LCBoIC0gcGFkZGluZyk7XG5cbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IHZhbHVlcy5sZW5ndGg7IGkrKykge1xuICAgICAgdmFyIHggPSB3IC0gaSAtIHBhZGRpbmcgLSBvZmZzZXQ7XG4gICAgICBjLmJlZ2luUGF0aCgpO1xuICAgICAgYy5tb3ZlVG8oeCwgaCAtIGZvbnRTaXplIC0gcGFkZGluZyk7XG4gICAgICBjLmxpbmVUbyh4LCBoIC0gdmFsdWVzW2ldIC0gZm9udFNpemUgLSBwYWRkaW5nKTtcbiAgICAgIGMuc3Ryb2tlU3R5bGUgPSAncmdiYSgyNTUsMjU1LDI1NSwnICsgb3BhY2l0eSArICcpJztcbiAgICAgIGMuc3Ryb2tlKCk7XG4gICAgfVxuXG4gICAgdmFyIGxpbWl0WSA9IGggLSBmb250U2l6ZSAtIHBhZGRpbmcgLSBsaW1pdDtcbiAgICBjLmJlZ2luUGF0aCgpO1xuICAgIGMubW92ZVRvKHcgLSBwYWRkaW5nIC0gdmFsdWVzLmxlbmd0aCAtIG9mZnNldCwgbGltaXRZKTtcbiAgICBjLmxpbmVUbyh3IC0gcGFkZGluZyAtIG9mZnNldCwgbGltaXRZKTtcbiAgICBjLnN0cm9rZVN0eWxlID0gJ3JnYmEoMjU1LDAsMCwnICsgb3BhY2l0eSArICcpJztcbiAgICBjLnN0cm9rZSgpO1xuICB9XG5cbiAgcmV0dXJuIGZ1bmN0aW9uIHJlbmRlcigpIHtcbiAgICBjLmNsZWFyUmVjdCgwLCAwLCB3LCBoKTtcblxuICAgIC8vIGRldGVjdGVkIG9iamVjdFxuICAgIChmdW5jdGlvbiAoKSB7XG4gICAgICBpZiAoIWRldGVjdGVkKSB7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgdmFyIHggPSB2aWRlb1RvT3ZlcmxheVgoZGV0ZWN0ZWQueCk7XG4gICAgICB2YXIgeSA9IHZpZGVvVG9PdmVybGF5WShkZXRlY3RlZC55KTtcblxuICAgICAgYy5iZWdpblBhdGgoKTtcbiAgICAgIGMubW92ZVRvKHgsIDApO1xuICAgICAgYy5saW5lVG8oeCwgb3ZlcmxheUNhbnZhcy5oZWlnaHQpO1xuICAgICAgYy5zdHJva2VTdHlsZSA9ICdyZ2JhKDI1NSwwLDAsMSknO1xuICAgICAgYy5zdHJva2UoKTtcblxuICAgICAgYy5iZWdpblBhdGgoKTtcbiAgICAgIGMubW92ZVRvKDAsIHkpO1xuICAgICAgYy5saW5lVG8ob3ZlcmxheUNhbnZhcy53aWR0aCwgeSk7XG4gICAgICBjLnN0cm9rZVN0eWxlID0gJ3JnYmEoMjU1LDAsMCwxKSc7XG4gICAgICBjLnN0cm9rZSgpO1xuICAgIH0pKCk7XG5cbiAgICAvLyB4UElEXG4gICAgKGZ1bmN0aW9uICgpIHtcbiAgICAgIHZhciBwaWQgPSB4UElELnBpZCgpO1xuICAgICAgdmFyIGZvbnRTaXplID0gMTQ7XG4gICAgICB2YXIgYmFycyA9IFtcbiAgICAgICAge2xhYmVsOiAncCcsIHZhbDogcGlkLnAsIGNvbG9yOiAnMjU1LDAsMCd9LFxuICAgICAgICB7bGFiZWw6ICdpJywgdmFsOiBwaWQuaSwgY29sb3I6ICcwLDI1NSwwJ30sXG4gICAgICAgIHtsYWJlbDogJ2QnLCB2YWw6IHBpZC5kLCBjb2xvcjogJzAsMCwyNTUnfSxcbiAgICAgICAge2xhYmVsOiAncGlkJywgdmFsOiBwaWQuc3VtLCBjb2xvcjogJzI1NSwyNTUsMjU1J31cbiAgICAgIF07XG4gICAgICB2YXIgYmggPSAxMDtcbiAgICAgIHZhciB5byA9IGggLyAyIC0gKChiaCArIGZvbnRTaXplICsgcGFkZGluZykgKiBiYXJzLmxlbmd0aCkgLyAyO1xuXG4gICAgICBiYXJzLmZvckVhY2goZnVuY3Rpb24gKGJhciwgaSkge1xuICAgICAgICB2YXIgeSA9IHlvICsgaSAqIChiaCArIGZvbnRTaXplICsgcGFkZGluZyk7XG4gICAgICAgIHZhciBidyA9IE1hdGguYWJzKGJhci52YWwgKiB3IC8gMik7XG4gICAgICAgIHZhciB4ID0gdyAvIDI7XG4gICAgICAgIGlmIChiYXIudmFsID4gMCkge1xuICAgICAgICAgIHggLT0gYnc7XG4gICAgICAgIH1cbiAgICAgICAgYy5maWxsU3R5bGUgPSAncmdiYSgnICsgYmFyLmNvbG9yICsgJywnICsgb3BhY2l0eSAqIDIgKyAnKSc7XG4gICAgICAgIGMuZmlsbFJlY3QoeCwgeSwgYncsIGJoKTtcblxuICAgICAgICBjLmZpbGxTdHlsZSA9ICdyZ2JhKDI1NSwyNTUsMjU1LCcgKyBvcGFjaXR5ICsgJyknO1xuICAgICAgICBjLmZvbnQgPSBmb250U2l6ZSArICdweCBBcmlhbCc7XG4gICAgICAgIGMuZmlsbFRleHQoYmFyLmxhYmVsLCB3IC8gMiwgeSAtIHBhZGRpbmcpO1xuICAgICAgfSk7XG5cbiAgICB9KSgpO1xuXG4gICAgcmVuZGVySGlzdG9ncmFtcyhbXG4gICAgICB7bGFiZWw6ICd2aWRlbycsIHZhbHVlczogdmlkZW9IaXN0b2dyYW0udmFsdWVzKCksIGxpbWl0OiAxMDAwIC8gMzB9LFxuICAgICAge2xhYmVsOiAnbmF2ZGF0YScsIHZhbHVlczogbmF2ZGF0YUhpc3RvZ3JhbS52YWx1ZXMoKSwgbGltaXQ6IDEwMDAgLyAxNX1cbiAgICBdKTtcblxuICAgIC8vIGJhdHRlcnkgbWV0ZXJcbiAgICAoZnVuY3Rpb24gKCkge1xuICAgICAgdmFyIHZhbHVlO1xuICAgICAgdHJ5IHtcbiAgICAgICAgdmFsdWUgPSBsYXN0TmF2ZGF0YS5kZW1vLmJhdHRlcnlQZXJjZW50YWdlO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIHZhbHVlID0gMDtcbiAgICAgIH1cbiAgICAgIHZhciBmdWxsV2lkdGggPSA3MDtcbiAgICAgIHZhciBmdWxsSGVpZ2h0ID0gMjQ7XG4gICAgICB2YXIgZm9udFNpemUgPSAxNDtcbiAgICAgIHZhciB3aWR0aCA9IChmdWxsV2lkdGggLSAyKSAqIHZhbHVlIC8gMTAwO1xuICAgICAgdmFyIGxhYmVsID0gdmFsdWUgKyAnICUnO1xuICAgICAgdmFyIHggPSB3IC0gZnVsbFdpZHRoIC0gcGFkZGluZztcbiAgICAgIHZhciB5ID0gcGFkZGluZztcblxuICAgICAgYy5maWxsU3R5bGUgPSAncmdiYSgyNTUsMjU1LDI1NSwnICsgb3BhY2l0eSArICcpJztcbiAgICAgIGMuZmlsbFJlY3QoeCwgeSwgZnVsbFdpZHRoLCBmdWxsSGVpZ2h0KTtcbiAgICAgIGlmICh2YWx1ZSA8IDMwKSB7XG4gICAgICAgIGMuZmlsbFN0eWxlID0gJ3JnYmEoMjU1LDAsMCwnICsgb3BhY2l0eSArICcpJztcbiAgICAgIH0gZWxzZSBpZiAodmFsdWUgPCA1MCkge1xuICAgICAgICBjLmZpbGxTdHlsZSA9ICdyZ2JhKDI1NSwyNTUsMCwnICsgb3BhY2l0eSArICcpJztcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGMuZmlsbFN0eWxlID0gJ3JnYmEoMCwyNTUsMCwnICsgb3BhY2l0eSArICcpJztcbiAgICAgIH1cbiAgICAgIGMuZmlsbFJlY3QoeCArIDEsIHkgKyAxLCB3aWR0aCwgZnVsbEhlaWdodCAtIDIpO1xuXG4gICAgICBjLmZpbGxTdHlsZSA9ICdyZ2JhKDAsMCwwLCcgKyBvcGFjaXR5ICsgJyknO1xuICAgICAgYy5mb250ID0gZm9udFNpemUgKyAncHggQXJpYWwnO1xuICAgICAgdmFyIGxhYmVsV2lkdGggPSBjLm1lYXN1cmVUZXh0KGxhYmVsKS53aWR0aDtcbiAgICAgIGMuZmlsbFRleHQobGFiZWwsIHggKyAoZnVsbFdpZHRoIC8gMikgLSAobGFiZWxXaWR0aCAvIDIpLCB5ICsgKGZ1bGxIZWlnaHQgLyAyKSArIChmb250U2l6ZSAvIDIpIC0gMSk7XG4gICAgfSkoKTtcblxuICAgIC8vIGNvbG9yIHBpY2tlclxuICAgIChmdW5jdGlvbiAoKSB7XG4gICAgICB2YXIgeCA9IHBhZGRpbmc7XG4gICAgICB2YXIgeSA9IHBhZGRpbmc7XG4gICAgICB2YXIgc2l6ZSA9IDUwO1xuICAgICAgYy5maWxsU3R5bGUgPSAncmdiYSgyNTUsMjU1LDI1NSwnICsgb3BhY2l0eSArICcpJztcbiAgICAgIGMuZmlsbFJlY3QoeCwgeSwgc2l6ZSwgc2l6ZSk7XG5cbiAgICAgIGlmIChwaWNrZWRDb2xvcikge1xuICAgICAgICBjLmZpbGxTdHlsZSA9ICdyZ2JhKCcgKyBwaWNrZWRDb2xvclswXSArICcsJyArIHBpY2tlZENvbG9yWzFdICsgJywnICsgcGlja2VkQ29sb3JbMl0gKyAnLDEpJztcbiAgICAgICAgYy5maWxsUmVjdCh4ICsgMSwgeSArIDEsIHNpemUgLSAyLCBzaXplIC0gMik7XG4gICAgICB9XG4gICAgfSkoKTtcbiAgfTtcbn1cblxuLy8gS2VlcCB2aWRlbyBtYXhpbWl6ZWQgd2l0aGluIGJyb3dzZXIgd2luZG93IHdoaWxlIGtlZXBpbmcgdGhlIGFzcGVjdCByYXRpb1xuLy8gaW50YWN0Llxud2luZG93LmFkZEV2ZW50TGlzdGVuZXIoJ3Jlc2l6ZScsIG1heGltaXplVmlkZW8pO1xuZnVuY3Rpb24gbWF4aW1pemVWaWRlbygpIHtcbiAgdmFyIHdpZHRoLCBoZWlnaHQ7XG4gIHZhciB3aW5kb3dSYXRpbyA9IHdpbmRvdy5pbm5lcldpZHRoIC8gd2luZG93LmlubmVySGVpZ2h0O1xuICBpZiAod2luZG93UmF0aW8gPiBhc3BlY3RSYXRpbykge1xuICAgIGhlaWdodCA9IHdpbmRvdy5pbm5lckhlaWdodDtcbiAgICB3aWR0aCA9IGhlaWdodCAqIGFzcGVjdFJhdGlvO1xuICB9IGVsc2Uge1xuICAgIHdpZHRoID0gd2luZG93LmlubmVyV2lkdGg7XG4gICAgaGVpZ2h0ID0gd2lkdGggLyBhc3BlY3RSYXRpbztcbiAgfVxuICBbdmlkZW9DYW52YXMsIG92ZXJsYXlDYW52YXNdLmZvckVhY2goZnVuY3Rpb24gKGNhbnZhcykge1xuICAgIGNhbnZhcy5zdHlsZS53aWR0aCA9IHdpZHRoICsgJ3B4JztcbiAgICBjYW52YXMuc3R5bGUuaGVpZ2h0ID0gaGVpZ2h0ICsgJ3B4JztcbiAgICBjYW52YXMuc3R5bGUubWFyZ2luVG9wID0gKCh3aW5kb3cuaW5uZXJIZWlnaHQgLSBoZWlnaHQpIC8gMikgKyAncHgnO1xuICAgIGNhbnZhcy5zdHlsZS5tYXJnaW5MZWZ0ID0gKCh3aW5kb3cuaW5uZXJXaWR0aCAtIHdpZHRoKSAvIDIpICsgJ3B4JztcbiAgfSk7XG59XG5cbm92ZXJsYXlDYW52YXMuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCBmdW5jdGlvbiAoZXZlbnQpIHtcbiAgdmFyIHggPSBvdmVybGF5VG9WaWRlb1goZXZlbnQub2Zmc2V0WCk7XG4gIHZhciB5ID0gb3ZlcmxheVRvVmlkZW9ZKGV2ZW50Lm9mZnNldFkpO1xuICBwaWNrZWRDb2xvciA9IHBpY2tlZENvbG9yIHx8IG5ldyBVaW50OEFycmF5KDQpO1xuICBucy5nZXRJbWFnZURhdGEocGlja2VkQ29sb3IsIHgsIHZpZGVvQ2FudmFzLmhlaWdodCAtIHksIDEsIDEpO1xufSk7XG5cbmZ1bmN0aW9uIG92ZXJsYXlUb1ZpZGVvWCh4KSB7XG4gIHJldHVybiBNYXRoLnJvdW5kKCh4IC8gcGFyc2VGbG9hdCh2aWRlb0NhbnZhcy5zdHlsZS53aWR0aCkpICogdmlkZW9DYW52YXMud2lkdGgpO1xufVxuXG5mdW5jdGlvbiBvdmVybGF5VG9WaWRlb1koeSkge1xuICByZXR1cm4gTWF0aC5yb3VuZCgoeSAvIHBhcnNlRmxvYXQodmlkZW9DYW52YXMuc3R5bGUuaGVpZ2h0KSkgKiB2aWRlb0NhbnZhcy5oZWlnaHQpO1xufVxuXG5mdW5jdGlvbiB2aWRlb1RvT3ZlcmxheVgoeCkge1xuICByZXR1cm4gTWF0aC5yb3VuZCh4IC8gdmlkZW9DYW52YXMud2lkdGggKiBvdmVybGF5Q2FudmFzLndpZHRoKTtcbn1cblxuZnVuY3Rpb24gdmlkZW9Ub092ZXJsYXlZKHkpIHtcbiAgcmV0dXJuIE1hdGgucm91bmQoeSAvIHZpZGVvQ2FudmFzLmhlaWdodCAqIG92ZXJsYXlDYW52YXMuaGVpZ2h0KTtcbn1cblxuZnVuY3Rpb24gc2V0U3RhdGUodmFsKSB7XG4gIGNvbnNvbGUubG9nKCduZXcgc3RhdGU6ICcgKyB2YWwpO1xuICBzdGF0ZSA9IHZhbDtcbn1cblxudmFyIGZsaWdodEJ1dHRvbiA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCdmbGlnaHQnKTtcbmZsaWdodEJ1dHRvbi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGZ1bmN0aW9uICgpIHtcbiAgaWYgKHRoaXMudGV4dENvbnRlbnQgPT09ICdTdGFydCcpIHtcbiAgICBzZXRTdGF0ZSgndGFrZW9mZicpO1xuICAgIGNsaWVudC5vbignYWx0aXR1ZGVDaGFuZ2UnLCBmdW5jdGlvbiAodikge1xuICAgICAgICBjb25zb2xlLmxvZyh2KTtcbiAgICAgIGlmICh2IDwgMC4yKSB7XG4gICAgICAgIHRoaXMuZG93bigwLjAwMSk7XG4gICAgICAgIHRoaXMudXAoMC4xKTtcbiAgICAgIH0gZWxzZSBpZiAodiA8IDAuMyAmJiB2ID4gMC4yNSkge1xuICAgICAgICB0aGlzLmRvd24oMC4wNSk7XG4gICAgICB9IGVsc2UgaWYgKHYgPiAwLjYpIHtcbiAgICAgICAgdGhpcy5kb3duKDAuNCk7XG4gICAgICB9IGVsc2UgaWYgKHYgPiAwLjUpIHtcbiAgICAgICAgdGhpcy5kb3duKDAuMyk7XG4gICAgICB9IGVsc2UgaWYgKHYgPiAwLjQpIHtcbiAgICAgICAgdGhpcy5kb3duKDAuMik7XG4gICAgICB9XG4gICAgfVxuICApO1xuICBjbGllbnQudGFrZW9mZihmdW5jdGlvbiAoKSB7XG4gICAgc2V0U3RhdGUoJ2ZvbGxvdycpO1xuICAgIGNsaWVudC5kb3duKDAuMSk7XG4gIH0pO1xuICB0aGlzLnRleHRDb250ZW50ID0gJ1N0b3AnO1xufVxuZWxzZVxue1xuICBzZXRTdGF0ZSgnbGFuZCcpO1xuICBjbGllbnQubGFuZChmdW5jdGlvbiAoKSB7XG4gICAgc2V0U3RhdGUoJ2dyb3VuZCcpO1xuICB9KTtcbiAgdGhpcy50ZXh0Q29udGVudCA9ICdTdGFydCc7XG59XG59KVxuO1xuIiwiXCJ1c2Ugc3RyaWN0XCI7XG5cbm1vZHVsZS5leHBvcnRzID0gUElEO1xuZnVuY3Rpb24gUElEKG9wdGlvbnMpIHtcbiAgdGhpcy5fcEdhaW4gPSBvcHRpb25zLnBHYWluIHx8IDA7XG4gIHRoaXMuX2lHYWluID0gb3B0aW9ucy5pR2FpbiB8fCAwO1xuICB0aGlzLl9kR2FpbiA9IG9wdGlvbnMuZEdhaW4gfHwgMDtcbiAgdGhpcy5fbWluID0gb3B0aW9ucy5taW4gfHwgLTE7XG4gIHRoaXMuX21heCA9IG9wdGlvbnMubWF4IHx8IDE7XG4gIHRoaXMuX3plcm8gPSBvcHRpb25zLnplcm8gfHwgMDtcblxuICB0aGlzLl9wID0gMDtcbiAgdGhpcy5faSA9IDA7XG4gIHRoaXMuX2QgPSAwO1xuICB0aGlzLl9zdW0gPSAwO1xuXG4gIHRoaXMuX3RhcmdldCA9IDA7XG4gIHRoaXMuX3N1bUVyciA9IDA7XG4gIHRoaXMuX2xhc3RFcnIgPSAwO1xuICB0aGlzLl9sYXN0VGltZSA9IG51bGw7XG5cbiAgdGhpcy50YXJnZXQoMCk7XG59XG5cblBJRC5wcm90b3R5cGUudGFyZ2V0ID0gZnVuY3Rpb24odmFsKSB7XG4gIGlmICh2YWwgPT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybiB0aGlzLl90YXJnZXQ7XG4gIH1cbiAgdGhpcy5fc3VtRXJyID0gMDtcbiAgdGhpcy5fbGFzdEVyciA9IDA7XG4gIHRoaXMuX2xhc3RUaW1lID0gbnVsbDtcbiAgdGhpcy5fc3VtID0gdGhpcy5fcCA9IHRoaXMuX2kgPSB0aGlzLl9kID0gdGhpcy5femVybztcbiAgdGhpcy5fdGFyZ2V0ID0gdmFsO1xuICByZXR1cm4gdGhpcy5fdGFyZ2V0O1xufTtcblxuUElELnByb3RvdHlwZS51cGRhdGUgPSBmdW5jdGlvbih2YWwpIHtcbiAgdmFyIG5vdyA9IERhdGUubm93KCk7XG4gIHZhciBkdCA9IDA7XG4gIGlmICh0aGlzLl9sYXN0VGltZSAhPT0gbnVsbCkge1xuICAgIGR0ID0gKG5vdyAtIHRoaXMuX2xhc3RUaW1lKSAvIDEwMDA7XG4gIH1cbiAgdGhpcy5fbGFzdFRpbWUgPSBub3c7XG5cbiAgdmFyIGVyciA9IHRoaXMuX3RhcmdldCAtIHZhbDtcbiAgdmFyIGRFcnIgPSAoZXJyIC0gdGhpcy5fbGFzdEVycikqZHQ7XG4gIHRoaXMuX3N1bUVyciArPSBlcnIgKiBkdDtcbiAgdGhpcy5fbGFzdEVyciA9IGVycjtcblxuICB0aGlzLl9wID0gdGhpcy5fcEdhaW4qZXJyO1xuICB0aGlzLl9pID0gdGhpcy5faUdhaW4qdGhpcy5fc3VtRXJyO1xuICB0aGlzLl9kID0gdGhpcy5fZEdhaW4qZEVycjtcbiAgdGhpcy5fc3VtID0gdGhpcy5fcCt0aGlzLl9pK3RoaXMuX2Q7XG4gIGlmICh0aGlzLl9zdW0gPCB0aGlzLl9taW4pIHtcbiAgICB0aGlzLl9zdW0gPSB0aGlzLl9taW47XG4gIH0gZWxzZSBpZiAodGhpcy5fc3VtID4gdGhpcy5fbWF4KSB7XG4gICAgdGhpcy5fc3VtID0gdGhpcy5fbWF4O1xuICB9XG59O1xuXG5QSUQucHJvdG90eXBlLnBpZCA9IGZ1bmN0aW9uKCkge1xuICByZXR1cm4ge3A6IHRoaXMuX3AsIGk6IHRoaXMuX2ksIGQ6IHRoaXMuX2QsIHN1bTogdGhpcy5fc3VtfTtcbn07XG4iLCIvKiBnbG9iYWwgd2luZG93LCBXZWJTb2NrZXQgKi8gXG5cInVzZSBzdHJpY3RcIjtcbm1vZHVsZS5leHBvcnRzID0gV3NDbGllbnQ7XG5mdW5jdGlvbiBXc0NsaWVudCgpIHtcbiAgdGhpcy5fY29ubiA9IG51bGw7XG4gIHRoaXMuX2Nvbm5lY3RlZCA9IGZhbHNlO1xuICB0aGlzLl9xdWV1ZSA9IFtdO1xuICB0aGlzLl9saXN0ZW5lcnMgPSB7fTtcbiAgdGhpcy5fdGFrZW9mZkNicyA9IFtdO1xuICB0aGlzLl9sYW5kQ2JzID0gW107XG4gIHRoaXMuX2Nvbm5lY3QoKTtcbn1cblxuV3NDbGllbnQucHJvdG90eXBlLl9jb25uZWN0ID0gZnVuY3Rpb24oKSB7XG4gIHZhciBzZWxmID0gdGhpcztcbiAgc2VsZi5fY29ubiA9IG5ldyBXZWJTb2NrZXQoJ3dzOi8vJyt3aW5kb3cubG9jYXRpb24uaG9zdCk7XG4gIHNlbGYuX2Nvbm4ub25vcGVuID0gZnVuY3Rpb24oKSB7XG4gICAgc2VsZi5fY29ubmVjdGVkID0gdHJ1ZTtcbiAgICBzZWxmLl9xdWV1ZS5mb3JFYWNoKGZ1bmN0aW9uKG1zZykge1xuICAgICAgc2VsZi5fY29ubi5zZW5kKG1zZyk7XG4gICAgfSk7XG4gICAgc2VsZi5fcXVldWUgPSBbXTtcblxuICAgIHNlbGYuX2Nvbm4ub25tZXNzYWdlID0gZnVuY3Rpb24obXNnKSB7XG4gICAgICB0cnkge1xuICAgICAgICBtc2cgPSBKU09OLnBhcnNlKG1zZy5kYXRhKTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBjb25zb2xlLmVycm9yKGVycik7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIHZhciBraW5kID0gbXNnLnNoaWZ0KCk7XG4gICAgICBzd2l0Y2ggKGtpbmQpIHtcbiAgICAgICAgY2FzZSAndGFrZW9mZic6XG4gICAgICAgICAgc2VsZi5fdGFrZW9mZkNicy5mb3JFYWNoKGZ1bmN0aW9uKGNiKSB7XG4gICAgICAgICAgICBjYigpO1xuICAgICAgICAgIH0pO1xuICAgICAgICAgIHNlbGYuX3Rha2VvZmZDYnMgPSBbXTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgY2FzZSAnbGFuZCc6XG4gICAgICAgICAgc2VsZi5fbGFuZENicy5mb3JFYWNoKGZ1bmN0aW9uKGNiKSB7XG4gICAgICAgICAgICBjYigpO1xuICAgICAgICAgIH0pO1xuICAgICAgICAgIHNlbGYuX2xhbmRDYnMgPSBbXTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgY2FzZSAnb24nOlxuICAgICAgICAgIHZhciBldmVudCA9IG1zZy5zaGlmdCgpO1xuICAgICAgICAgIHNlbGYuX2xpc3RlbmVyc1tldmVudF0uZm9yRWFjaChmdW5jdGlvbihjYikge1xuICAgICAgICAgICAgY2IuYXBwbHkoc2VsZiwgbXNnKTtcbiAgICAgICAgICB9KTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICBjb25zb2xlLmVycm9yKCd1bmtub3duIG1lc3NhZ2U6ICcra2luZCk7XG4gICAgICB9XG4gICAgfTtcbiAgfTtcblxufTtcblxuV3NDbGllbnQucHJvdG90eXBlLl9zZW5kID0gZnVuY3Rpb24obXNnKSB7XG4gIG1zZyA9IEpTT04uc3RyaW5naWZ5KG1zZyk7XG4gIGlmICghdGhpcy5fY29ubmVjdGVkKSB7XG4gICAgdGhpcy5fcXVldWUucHVzaChtc2cpO1xuICAgIHJldHVybjtcbiAgfVxuICB0aGlzLl9jb25uLnNlbmQobXNnKTtcbn07XG5cbldzQ2xpZW50LnByb3RvdHlwZS5vbiA9IGZ1bmN0aW9uKGV2ZW50LCBjYikge1xuICB2YXIgY2JzID0gdGhpcy5fbGlzdGVuZXJzW2V2ZW50XSA9IHRoaXMuX2xpc3RlbmVyc1tldmVudF0gfHwgW107XG4gIGNicy5wdXNoKGNiKTtcbiAgaWYgKGNicy5sZW5ndGggPT09IDEpIHtcbiAgICB0aGlzLl9zZW5kKFsnb24nLCBldmVudF0pO1xuICB9XG59O1xuXG5Xc0NsaWVudC5wcm90b3R5cGUudGFrZW9mZiA9IGZ1bmN0aW9uKGNiKSB7XG4gIHRoaXMuX3NlbmQoWyd0YWtlb2ZmJ10pO1xuICBpZiAoY2IpIHtcbiAgICB0aGlzLl90YWtlb2ZmQ2JzLnB1c2goY2IpO1xuICB9XG59O1xuXG5Xc0NsaWVudC5wcm90b3R5cGUubGFuZCA9IGZ1bmN0aW9uKGNiKSB7XG4gIHRoaXMuX3NlbmQoWydsYW5kJ10pO1xuICBpZiAoY2IpIHtcbiAgICB0aGlzLl9sYW5kQ2JzLnB1c2goY2IpO1xuICB9XG59O1xuXG5Xc0NsaWVudC5wcm90b3R5cGUucmlnaHQgPSBmdW5jdGlvbih2YWwpIHtcbiAgdGhpcy5fc2VuZChbJ3JpZ2h0JywgdmFsXSk7XG59O1xuXG5Xc0NsaWVudC5wcm90b3R5cGUuY2xvY2t3aXNlID0gZnVuY3Rpb24odmFsKSB7XG4gIHRoaXMuX3NlbmQoWydjbG9ja3dpc2UnLCB2YWxdKTtcbn07XG5cbldzQ2xpZW50LnByb3RvdHlwZS5kb3duID0gZnVuY3Rpb24odmFsKSB7XG4gIHRoaXMuX3NlbmQoWydkb3duJywgdmFsXSk7XG59O1xuXG5Xc0NsaWVudC5wcm90b3R5cGUudXAgPSBmdW5jdGlvbih2YWwpIHtcbiAgdGhpcy5fc2VuZChbJ3VwJywgdmFsXSk7XG59O1xuXG5Xc0NsaWVudC5wcm90b3R5cGUuZnJvbnQgPSBmdW5jdGlvbih2YWwpIHtcbiAgdGhpcy5fc2VuZChbJ2Zyb250JywgdmFsXSk7XG59O1xuXG5Xc0NsaWVudC5wcm90b3R5cGUuY2xvY2t3aXNlID0gZnVuY3Rpb24odmFsKSB7XG4gIHRoaXMuX3NlbmQoWydjbG9ja3dpc2UnLCB2YWxdKTtcbn07XG5cbldzQ2xpZW50LnByb3RvdHlwZS5hbmltYXRlID0gZnVuY3Rpb24odmFsLCB0aW1lKSB7XG4gIHRoaXMuX3NlbmQoWydhbmltYXRlJywgdmFsLCB0aW1lXSk7XG59O1xuXG5Xc0NsaWVudC5wcm90b3R5cGUuc3RvcCA9IGZ1bmN0aW9uKCkge1xuICB0aGlzLl9zZW5kKFsnc3RvcCddKTtcbn07XG4iXX0=
