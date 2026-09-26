// CPAL-1.0 License. See chaosaccelerator.com/license.html

// A movie's camera: keyframes in, one view per frame out. Pure arithmetic, no DOM or GL.
// A keyframe is { center: {x, xLo, y, yLo}, scale, step, seconds }: a map view, its simulation
// frame, and how long the move ARRIVING at it takes (null: autoSeconds).
(function (global) {
  "use strict";

  var FPS = 30;
  var RHO = Math.SQRT2; // van Wijk & Nuij's recommended trade-off between zooming and panning

  var QUALITIES = [
    { label: "1/8 resolution", divisor: 8, antialias: false },
    { label: "1/4 resolution", divisor: 4, antialias: false },
    { label: "1/2 resolution", divisor: 2, antialias: false },
    { label: "Full resolution", divisor: 1, antialias: false },
    { label: "Full + antialiasing", divisor: 1, antialias: true },
  ];

  var SECONDS_PER_PATH_UNIT = 1.4;
  var STEPS_PER_SECOND = 120;
  var MIN_SECONDS = 1;
  var MAX_SECONDS = 60;

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  function twoSum(a, b) {
    var s = a + b, bb = s - a;
    return [s, (a - (s - bb)) + (b - bb)];
  }
  function ddAdd(hi, lo, delta) {
    var s = twoSum(hi, delta);
    return twoSum(s[0], s[1] + lo);
  }
  function offsetCenter(center, dx, dy) {
    var x = ddAdd(center.x, center.xLo || 0, dx), y = ddAdd(center.y, center.yLo || 0, dy);
    return { x: x[0], xLo: x[1], y: y[0], yLo: y[1] };
  }

  // Quintic Hermite from speed m0 to m1 (1 = the move's average, 0 = rest), no acceleration at either end.
  var MAX_END_SPEED = 2.5;
  function ease(t, m0, m1) {
    t = clamp(t, 0, 1);
    m0 = clamp(m0 || 0, 0, MAX_END_SPEED);
    m1 = clamp(m1 || 0, 0, MAX_END_SPEED);
    var t2 = t * t, t3 = t2 * t, t4 = t3 * t, t5 = t4 * t;
    return (6 * t5 - 15 * t4 + 10 * t3) + m0 * (t - 6 * t3 + 8 * t4 - 3 * t5) + m1 * (-4 * t3 + 7 * t4 - 3 * t5);
  }

  // Unit direction at one end of a move, in van Wijk & Nuij's measure, so arriving and leaving compare.
  function direction(route, key, atStart) {
    var e = 1e-3;
    var p = route.at(atStart ? 0 : 1 - e), q = route.at(atStart ? e : 1);
    var v = [
      RHO * ((q.center.x - p.center.x) + ((q.center.xLo || 0) - (p.center.xLo || 0))) / key.scale,
      RHO * ((q.center.y - p.center.y) + ((q.center.yLo || 0) - (p.center.yLo || 0))) / key.scale,
      Math.log(q.scale / p.scale) / RHO,
    ];
    var n = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    return n > 0 ? [v[0] / n, v[1] / n, v[2] / n] : [0, 0, 0];
  }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

  // End speeds per move (multiples of its average): a keyframe's velocity is the mean of arriving and leaving.
  function endSpeeds(list, keyframes, loop) {
    var n = keyframes.length;
    var velocity = keyframes.map(function (key, i) {
      var arriving = i > 0 ? list[i - 1] : (loop && n > 1 ? list[list.length - 1] : null);
      var leaving = i < list.length ? list[i] : null;
      if (!arriving || !leaving || !(arriving.route.length > 0) || !(leaving.route.length > 0)) return [0, 0, 0];
      var vin = direction(arriving.route, key, false), vout = direction(leaving.route, key, true);
      var sin = arriving.route.length / arriving.seconds, sout = leaving.route.length / leaving.seconds;
      return [0, 1, 2].map(function (c) { return (vin[c] * sin + vout[c] * sout) / 2; });
    });
    return list.map(function (move, j) {
      var length = move.route.length;
      if (!(length > 0)) return { m0: 0, m1: 0 };
      var perUnit = move.seconds / length;
      return {
        m0: Math.max(0, dot(velocity[j], direction(move.route, move.from, true)) * perUnit),
        m1: Math.max(0, dot(velocity[(j + 1) % n], direction(move.route, move.to, false)) * perUnit),
      };
    });
  }

  // van Wijk & Nuij's path (2003) from a to b: { length, at(u) }, u along the PATH, not through time.
  function path(a, b) {
    var dx = (b.center.x - a.center.x) + ((b.center.xLo || 0) - (a.center.xLo || 0));
    var dy = (b.center.y - a.center.y) + ((b.center.yLo || 0) - (a.center.yLo || 0));
    var d = Math.sqrt(dx * dx + dy * dy);
    var w0 = a.scale, w1 = b.scale;

    // No pan: a plain geometric zoom (the general formulas divide by d).
    if (d <= 1e-9 * Math.min(w0, w1)) {
      var direction = w1 >= w0 ? 1 : -1;
      var zoomLength = Math.abs(Math.log(w1 / w0)) / RHO;
      return {
        length: zoomLength,
        at: function (u) {
          u = clamp(u, 0, 1);
          return u < 0.5
            ? { center: offsetCenter(a.center, u * dx, u * dy), scale: w0 * Math.exp(direction * RHO * zoomLength * u) }
            : { center: offsetCenter(b.center, -(1 - u) * dx, -(1 - u) * dy), scale: w1 * Math.exp(-direction * RHO * zoomLength * (1 - u)) };
        },
      };
    }

    // asinh, not the textbook log form, which cancels; and each half is measured from its own
    // end, so a fraction good to 1e-16 still lands exactly at zooms past 1e20.
    var r0 = -Math.asinh((w1 * w1 - w0 * w0 + 4 * d * d) / (4 * w0 * d));
    var r1 = -Math.asinh((w1 * w1 - w0 * w0 - 4 * d * d) / (4 * w1 * d));
    var length = (r1 - r0) / RHO;

    function fromEnd(w, start, s) {
      var c = Math.cosh(RHO * s + start);
      return { fraction: (w / (2 * d)) * Math.sinh(RHO * s) / c, scale: w * Math.cosh(start) / c };
    }
    return {
      length: length,
      at: function (u) {
        u = clamp(u, 0, 1);
        var near;
        if (u < 0.5) {
          near = fromEnd(w0, r0, u * length);
          return { center: offsetCenter(a.center, near.fraction * dx, near.fraction * dy), scale: near.scale };
        }
        near = fromEnd(w1, -r1, (1 - u) * length);
        return { center: offsetCenter(b.center, -near.fraction * dx, -near.fraction * dy), scale: near.scale };
      },
    };
  }

  function autoSeconds(a, b) {
    var seconds = Math.max(MIN_SECONDS, path(a, b).length * SECONDS_PER_PATH_UNIT, Math.abs(b.step - a.step) / STEPS_PER_SECOND);
    return Math.round(clamp(seconds, MIN_SECONDS, MAX_SECONDS) * 10) / 10;
  }

  // [{ from, to, seconds }]; `loop` adds a move from the last keyframe back to the first. A move's time is its DESTINATION's.
  function moves(keyframes, loop) {
    var list = [];
    for (var i = 1; i < keyframes.length; i++) list.push({ from: keyframes[i - 1], to: keyframes[i] });
    if (loop && keyframes.length > 1) list.push({ from: keyframes[keyframes.length - 1], to: keyframes[0] });
    list.forEach(function (move) {
      var asked = Number(move.to.seconds);
      move.seconds = asked > 0 ? clamp(asked, 0.1, MAX_SECONDS) : autoSeconds(move.from, move.to);
    });
    return list;
  }

  function totalSeconds(keyframes, loop) {
    return moves(keyframes, loop).reduce(function (sum, move) { return sum + move.seconds; }, 0);
  }

  // Every frame: each move contributes its start up to, not including, its end; a non-looping movie then gets its last keyframe.
  function frames(keyframes, loop) {
    var out = [];
    var list = moves(keyframes, loop);
    list.forEach(function (move) { move.route = path(move.from, move.to); });
    var speeds = endSpeeds(list, keyframes, loop);
    list.forEach(function (move, j) {
      var route = move.route;
      var count = Math.max(1, Math.round(move.seconds * FPS));
      for (var k = 0; k < count; k++) {
        var u = ease(k / count, speeds[j].m0, speeds[j].m1);
        var view = route.at(u);
        out.push({ center: view.center, scale: view.scale, step: Math.round(move.from.step + (move.to.step - move.from.step) * u) });
      }
    });
    if (keyframes.length && !(loop && keyframes.length > 1)) {
      var last = keyframes[keyframes.length - 1];
      out.push({
        center: { x: last.center.x, xLo: last.center.xLo || 0, y: last.center.y, yLo: last.center.yLo || 0 },
        scale: last.scale, step: Math.round(last.step),
      });
    }
    return out;
  }

  global.MoviePath = {
    FPS: FPS,
    QUALITIES: QUALITIES,
    ease: ease,
    path: path,
    autoSeconds: autoSeconds,
    moves: moves,
    totalSeconds: totalSeconds,
    frames: frames,
  };
})(typeof window !== "undefined" ? window : globalThis);
