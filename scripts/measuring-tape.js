// CPAL-1.0 License. See chaosaccelerator.com/license.html

// The map's Measuring Tape: drag across the map and the case shows the distance in meters.
(function (global) {
  "use strict";

  var SVG_NS = "http://www.w3.org/2000/svg";
  var gridView = document.getElementById("grid-view");
  var area = document.getElementById("grid-canvas-area");
  var canvas = document.getElementById("grid-canvas");
  var root = document.getElementById("measuring-tape");
  var svg = root.querySelector("svg");
  var readout = root.querySelector(".measuring-tape-readout");
  var lengthEl = root.querySelector(".measuring-tape-length");
  var scaleEl = root.querySelector(".measuring-tape-scale");

  // Drawn with the case's mouth at the origin and the tape along +x; y down, the case above the tape.
  var TAPE_W = 20;
  var CASE_W = 156, CASE_H = 150;
  var CASE_BOTTOM = TAPE_W / 2 + 7;
  var CASE_TOP = CASE_BOTTOM - CASE_H;
  var CASE_CX = -CASE_W / 2, CASE_CY = (CASE_TOP + CASE_BOTTOM) / 2;
  // The case's center stays this far inside the map, or the case goes to the other end of the tape.
  var FIT_MARGIN = 72;
  var TICK_PX = 8;
  var CLICK_PX = 3;
  var RETRACT_MS = 260, FADE_MS = 140;

  function roundedPath(x0, y0, x1, y1, tl, tr, br, bl) {
    return "M" + (x0 + tl) + " " + y0 + "H" + (x1 - tr) + "A" + tr + " " + tr + " 0 0 1 " + x1 + " " + (y0 + tr) +
      "V" + (y1 - br) + "A" + br + " " + br + " 0 0 1 " + (x1 - br) + " " + y1 +
      "H" + (x0 + bl) + "A" + bl + " " + bl + " 0 0 1 " + x0 + " " + (y1 - bl) +
      "V" + (y0 + tl) + "A" + tl + " " + tl + " 0 0 1 " + (x0 + tl) + " " + y0 + "Z";
  }

  // 32 px: the case, a stub of tape and the hook, with the hot spot on the hook's face.
  var CURSOR_SVG = "<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 32 32'>" +
    "<g stroke='#0c0d11' stroke-width='1.5' stroke-linejoin='round'>" +
    "<rect x='16' y='17.5' width='12' height='5' fill='#f2c94c'/>" +
    "<path d='M21 17.5v2M24.5 17.5v2.5' stroke-width='1'/>" +
    "<rect x='28' y='16.5' width='2.5' height='9' fill='#c9ced8'/>" +
    "<path d='" + roundedPath(1.5, 5, 19, 24, 8.5, 4, 1, 8.5) + "' fill='#1b1e27' stroke='#e6e8ef'/>" +
    "<rect x='7' y='3' width='7' height='3.5' rx='1.75' fill='#5b8cff' stroke='#e6e8ef'/>" +
    "</g></svg>";
  var TAPE_CURSOR = "url(\"data:image/svg+xml," + encodeURIComponent(CURSOR_SVG) + "\") 28 20, crosshair";

  function make(name, attrs, parent) {
    var node = document.createElementNS(SVG_NS, name);
    for (var k in attrs) node.setAttribute(k, attrs[k]);
    parent.appendChild(node);
    return node;
  }
  var group = make("g", {}, svg);
  var strip = make("rect", { class: "measuring-tape-strip", x: -14, y: -TAPE_W / 2, height: TAPE_W }, group);
  var ticks = make("path", { class: "measuring-tape-ticks" }, group);
  var hook = make("path", { class: "measuring-tape-hook" }, group);
  make("path", { class: "measuring-tape-case", d: roundedPath(-CASE_W, CASE_TOP, 0, CASE_BOTTOM, 72, 30, 5, 72) }, group);
  make("path", { class: "measuring-tape-rim", d: roundedPath(-CASE_W + 9, CASE_TOP + 9, -9, CASE_BOTTOM - 9, 63, 21, 2, 63) }, group);
  make("rect", { class: "measuring-tape-lock", x: -70, y: CASE_TOP - 7, width: 36, height: 12, rx: 6 }, group);
  make("rect", { class: "measuring-tape-mouth", x: -9, y: -TAPE_W / 2 - 5, width: 12, height: TAPE_W + 10, rx: 3 }, group);

  // Two significant figures, "3.4 x 10^-12 meters" with the exponent raised.
  function lengthHTML(meters) {
    if (!(meters > 0)) return "0 meters";
    var exp = Math.floor(Math.log10(meters));
    var mantissa = (meters / Math.pow(10, exp)).toFixed(1);
    if (mantissa === "10.0") { mantissa = "1.0"; exp += 1; }
    if (exp === 0) return mantissa + " meters";
    return mantissa + " × 10<sup>" + String(exp).replace("-", "−") + "</sup> meters";
  }

  // Ticks count from the hook at a fixed screen spacing, longer every 5 and 10.
  function tickPath(out) {
    var d = "";
    for (var i = 1, x = out - TICK_PX; x > 0; i++, x = out - i * TICK_PX) {
      d += "M" + x.toFixed(1) + " " + (-TAPE_W / 2) + "v" + (i % 10 === 0 ? 11 : i % 5 === 0 ? 7.5 : 4.5);
    }
    return d;
  }

  var active = false;
  var dragging = false;
  // start/end in CSS px of the map area; out is the fraction pulled out, below 1 while retracting.
  var tape = null;
  var frame = 0;
  var lastKey = "";

  function areaPoint(e) {
    var rect = area.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function tapeAngle(atStart) { return tape.angle + (atStart ? 0 : Math.PI); }
  function tapeOrigin(atStart) { return atStart ? tape.start : tape.end; }
  // Keeps the case's top up, with some slack about vertical so a straight drag doesn't flicker.
  function flipFor(angle, flip) {
    var c = Math.cos(angle);
    return c < -0.15 ? -1 : c > 0.15 ? 1 : flip;
  }
  function caseCenter(origin, angle, flip) {
    var c = Math.cos(angle), s = Math.sin(angle), y = CASE_CY * flip;
    return { x: origin.x + CASE_CX * c - y * s, y: origin.y + CASE_CX * s + y * c };
  }
  function fits(p) {
    return p.x >= FIT_MARGIN && p.x <= area.clientWidth - FIT_MARGIN &&
      p.y >= FIT_MARGIN && p.y <= area.clientHeight - FIT_MARGIN;
  }
  function placeCase() {
    tape.flip = flipFor(tapeAngle(tape.atStart), tape.flip);
    if (fits(caseCenter(tapeOrigin(tape.atStart), tapeAngle(tape.atStart), tape.flip))) return;
    var other = !tape.atStart, otherFlip = flipFor(tapeAngle(other), 1);
    if (fits(caseCenter(tapeOrigin(other), tapeAngle(other), otherFlip))) {
      tape.atStart = other;
      tape.flip = otherFlip;
    }
  }

  function render() {
    var mpp = global.FractalGrid.metersPerPixel();
    var full = Math.hypot(tape.end.x - tape.start.x, tape.end.y - tape.start.y);
    var key = [tape.start.x, tape.start.y, tape.end.x, tape.end.y, tape.out, mpp, area.clientWidth, area.clientHeight].join(" ");
    if (key === lastKey) return;
    lastKey = key;
    if (!tape.retractAt) {
      if (full >= CLICK_PX) tape.angle = Math.atan2(tape.end.y - tape.start.y, tape.end.x - tape.start.x);
      placeCase();
    }
    var origin = tapeOrigin(tape.atStart), angle = tapeAngle(tape.atStart);
    var out = full * tape.out;
    group.setAttribute("transform", "translate(" + origin.x + " " + origin.y + ") rotate(" + angle * 180 / Math.PI + ") scale(1 " + tape.flip + ")");
    strip.setAttribute("width", out + 14);
    hook.setAttribute("d", "M" + out + " " + (-TAPE_W / 2 - 2) + "h4v" + (TAPE_W + 10) + "h-4z" +
      "M" + (out - 9) + " -4a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0 -3.2 0" +
      "M" + (out - 9) + " 4a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0 -3.2 0");
    ticks.setAttribute("d", tickPath(out));
    var center = caseCenter(origin, angle, tape.flip);
    readout.style.left = center.x + "px";
    readout.style.top = center.y + "px";
    var meters = out * mpp;
    lengthEl.innerHTML = lengthHTML(meters);
    scaleEl.textContent = meters > 0 ? global.FractalGrid.lengthScaleLabel(meters) : "";
    root.hidden = false;
  }

  function clearTape() {
    tape = null;
    lastKey = "";
    root.hidden = true;
    root.style.opacity = "";
  }

  // Runs while a tape is out, so a zoom under it updates the reading.
  function tick(now) {
    frame = 0;
    if (!tape) return;
    if (tape.retractAt) {
      var t = Math.max(0, now - tape.retractAt) / RETRACT_MS;
      tape.out = Math.max(0, 1 - t * t);
      root.style.opacity = t <= 1 ? "" : String(Math.max(0, 1 - (t - 1) * RETRACT_MS / FADE_MS));
      if (t * RETRACT_MS >= RETRACT_MS + FADE_MS) { clearTape(); return; }
    }
    render();
    frame = requestAnimationFrame(tick);
  }
  function wake() { if (!frame) frame = requestAnimationFrame(tick); }

  function setActive(on) {
    if (on === active) return;
    var mpp = global.FractalGrid ? global.FractalGrid.metersPerPixel() : 0;
    if (on && !(mpp > 0 && isFinite(mpp))) return;
    active = on;
    dragging = false;
    canvas.style.cursor = on ? TAPE_CURSOR : "";
    if (!on && tape && !gridView.hidden) {
      tape.retractAt = performance.now();
      wake();
    } else clearTape();
  }

  // Capture phase, so the map's own pan never sees a tape drag.
  area.addEventListener("mousedown", function (e) {
    if (!active || e.button !== 0 || e.target !== canvas) return;
    e.stopPropagation();
    e.preventDefault();
    var p = areaPoint(e);
    clearTape();
    tape = { start: p, end: p, angle: 0, atStart: true, flip: 1, out: 1, retractAt: 0 };
    dragging = true;
    canvas.style.cursor = "crosshair";
    render();
    wake();
  }, true);
  global.addEventListener("mousemove", function (e) {
    if (!dragging) return;
    e.stopPropagation();
    tape.end = areaPoint(e);
  }, true);
  global.addEventListener("mouseup", function (e) {
    if (!dragging || e.button !== 0) return;
    dragging = false;
    canvas.style.cursor = TAPE_CURSOR;
    tape.end = areaPoint(e);
    if (Math.hypot(tape.end.x - tape.start.x, tape.end.y - tape.start.y) < CLICK_PX) clearTape();
  }, true);

  // Leaving the map puts the tape away.
  new MutationObserver(function () { if (gridView.hidden) setActive(false); })
    .observe(gridView, { attributes: true, attributeFilter: ["hidden"] });

  global.MeasuringTape = {
    toggle: function () { setActive(!active); },
    stop: function () { setActive(false); },
    isActive: function () { return active; },
  };
})(window);
