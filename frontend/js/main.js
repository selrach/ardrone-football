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
var disableDetection = false;

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

  if (pickedColor && !disableDetection) {
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

    /* Input readout */
    (function () {
      var fontSize = 14;
      var bars = [
        {label: 'X', val: -client.frontBack, color: '255,0,0'},
        {label: 'Y', val: -client.upDown, color: '0,255,0'},
        {label: 'θ', val: -client.rotation, color: '0,0,255'}
      ];
      var bh = 10;
      var yo = h/2 - ((bh + fontSize + padding) * bars.length) / 2;

      bars.forEach(function (bar, i) {
        var y = yo + i * (bh + fontSize + padding);
        var bw = Math.abs(bar.val * 100);
        var x = 100;
        if (bar.val > 0) {
          x -= bw;
        }
        c.fillStyle = 'rgba(' + bar.color + ',' + opacity * 2 + ')';
        c.fillRect(x, y, bw, bh);

        c.fillStyle = 'rgba(255,255,255,' + opacity + ')';
        c.font = fontSize + 'px Arial';
        c.fillText(bar.label, 100, y - padding);
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

var turnaroundButton = document.getElementById('turnaround');
turnaroundButton.addEventListener('click', function(){
    client.turnaround();
});

var stopButton = document.getElementById('stop');
stopButton.addEventListener('click', function(){
  client.stop();
});

var disableButton = document.getElementById('disable');
disableButton.addEventListener('click', function(){
  if (this.textContent === 'Stop Tracking'){
    this.textContent = 'Enable Tracking';
    disableDetection = true;
  } else {
    this.textContent = 'Stop Tracking';
    client.stop();
    disableDetection = false;
  }
});

var flightButton = document.getElementById('flight');
flightButton.addEventListener('click', function () {
  if (this.textContent === 'Start') {
    setState('takeoff');
    client.on('altitudeChange', function (v) {
      if(disableDetection){
        return;
      }
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
  this.textContent = 'Land';
}
else
{
  setState('land');
  client.land(function () {
    setState('ground');
  });
  this.textContent = 'Start';
}
});

var keyModifier = 1;
var keyChange = function(old, increment){
  var dx = keyModifier * increment;
  var newVal = old + dx;
  if(increment > 0){
    newVal = Math.min(newVal, 1);
  } else {
    newVal = Math.max(newVal, -1);
  }
  if(keyModifier > 1 && old !== 0 && ((old > 0 && newVal < 0) || (old < 0 && newVal > 0))){
    return 0;
  }
  return newVal;
};
window.onkeydown = function(ev){
  if(ev.keyCode === 16){
    keyModifier = 10;
  }
  if(ev.keyCode === 81){
    client.up(keyChange(client.upDown, 0.1));
  }
  if(ev.keyCode === 90){
   client.up(keyChange(client.upDown, -0.1));
  }
  if(ev.keyCode === 39){
   client.clockwise(keyChange(client.rotation, 0.1));
  }
  if(ev.keyCode === 37){
   client.clockwise(keyChange(client.rotation, -0.1));
  }
  if(ev.keyCode === 40){
   client.front(keyChange(client.frontBack, -0.1));
  }
  if(ev.keyCode === 38){
    client.front(keyChange(client.frontBack, 0.1));
  }
};
window.onkeyup = function(ev){
  if(ev.keyCode === 16){
    keyModifier = 1;
  }
};
