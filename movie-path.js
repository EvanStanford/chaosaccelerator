// This file is part of Chaos Accelerator, licensed under the Common Public
// Attribution License, Version 1.0 (CPAL-1.0): see LICENSE in the project
// root, or https://chaosaccelerator.com/license for a hosted copy.

// A movie's camera: keyframes in, one view per frame out. Pure arithmetic,
// no DOM, no GL, so the Movie card (which shows how long a movie will run)
// and the playback page (which renders it) cannot disagree about what the
// keyframes mean, and so it can be tested where neither exists.
//
// A KEYFRAME is a view of the map and a moment of its simulation:
//
//   { center: { x, xLo, y, yLo }, scale, step, seconds }
//
// center and scale are fractal-grid.js's own view (a double-double center,
// and world units per view height); `step` is the simulation frame the map
// is showing, the Map Evolution timeline, so a movie can run the physics
// forward, hold it, or wind it back while the camera moves; `seconds` is how
// long the move that ARRIVES at this keyframe takes, or null to let
// autoSeconds decide.
//
// THE MOVE BETWEEN TWO KEYFRAMES is the path of van Wijk & Nuij, "Smooth and
// Efficient Zooming and Panning" (2003): the one d3's interpolateZoom made
// familiar. Interpolating the center in a straight line while the zoom
// changes geometrically looks terrible across any real zoom: measured
// against what is on screen, the pan crawls at the wide end and whips past
// at the deep end. Theirs is the path along which the picture appears to
// move at a constant rate the whole way, pulling back first when the two
// views are far apart.
//
// Two things here differ from the textbook form, both because this map
// zooms past 1e20 where a UI transition zooms past 10:
//
//  - The textbook position is cosh(r0) * tanh(rho*s + r0) - sinh(r0), a
//    difference of two numbers that grow like the zoom ratio while the
//    answer stays near 1: garbage by a ratio of 1e8. It is the same thing
//    as sinh(rho*s) / cosh(rho*s + r0), which has no subtraction in it.
//
//  - The position is a FRACTION of the whole displacement, and a fraction
//    good to one part in 1e16 is not good enough at the deep end: panning
//    by a thousand starting-views while zooming in 1e12 leaves an error of
//    a whole final view. So each half of the path is measured from its own
//    end, the distance still to go is computed directly, never as one
//    minus the distance covered, and both ends land exactly on their
//    keyframes.
//
// EASING is applied to where along that path a moment falls; the simulation
// frame rides the same curve. A movie starts and ends at rest, but it does
// NOT stop at every keyframe in between: a keyframe passed on the way from
// 1x to 10000x is passed at speed, where one the camera turns round at (in
// at 1e8x, back out to 1e4x) is where it slows to a halt. Each keyframe is
// given a velocity: the average of the move arriving and the move leaving,
// as vectors, so continuing cancels nothing and reversing cancels everything
// - and each move is a quintic Hermite curve between its two ends' speeds
// along it, with no acceleration at either end, so nothing ever jerks. With
// both ends at rest the curve is smootherstep.
(function (global) {
  "use strict";

  var FPS = 30;
  var RHO = Math.SQRT2; // van Wijk & Nuij's recommended trade-off between zooming and panning

  // What the Movie card's Resolution slider's five stops mean: here rather
  // than in the card, because the player is what acts on them. `divisor` is
  // how much smaller than the player's own stage each frame is rendered;
  // only the top stop antialiases, since averaging several samples of every
  // pixel is most of what a frame costs.
  var QUALITIES = [
    { label: "1/8 resolution", divisor: 8, antialias: false },
    { label: "1/4 resolution", divisor: 4, antialias: false },
    { label: "1/2 resolution", divisor: 2, antialias: false },
    { label: "Full resolution", divisor: 1, antialias: false },
    { label: "Full + antialiasing", divisor: 1, antialias: true },
  ];

  // How long a move takes when its keyframe doesn't say: long enough for
  // the camera (SECONDS_PER_PATH_UNIT of path length, about 0.7s per
  // doubling of zoom, 1.7s to pan one view across) and long enough for the
  // simulation (STEPS_PER_SECOND, twice the speed the physics runs at in
  // real time), and never a flicker.
  var SECONDS_PER_PATH_UNIT = 1.4;
  var STEPS_PER_SECOND = 120;
  var MIN_SECONDS = 1;
  var MAX_SECONDS = 60;

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  function twoSum(a, b) {
    var s = a + b, bb = s - a;
    return [s, (a - (s - bb)) + (b - bb)];
  }
  // (hi + lo) + delta, as a double-double again.
  function ddAdd(hi, lo, delta) {
    var s = twoSum(hi, delta);
    return twoSum(s[0], s[1] + lo);
  }
  function offsetCenter(center, dx, dy) {
    var x = ddAdd(center.x, center.xLo || 0, dx), y = ddAdd(center.y, center.yLo || 0, dy);
    return { x: x[0], xLo: x[1], y: y[0], yLo: y[1] };
  }

  // How far along a move at time t in [0, 1], setting off at speed m0 and
  // arriving at m1 (1 is the move's average speed, 0 is at rest), with no
  // acceleration at either end. Quintic Hermite; at rest both ends it is
  // smootherstep, at 1 both ends it is a straight line. Monotone up to
  // MAX_END_SPEED at both ends: faster is clamped.
  var MAX_END_SPEED = 2.5;
  function ease(t, m0, m1) {
    t = clamp(t, 0, 1);
    m0 = clamp(m0 || 0, 0, MAX_END_SPEED);
    m1 = clamp(m1 || 0, 0, MAX_END_SPEED);
    var t2 = t * t, t3 = t2 * t, t4 = t3 * t, t5 = t4 * t;
    return (6 * t5 - 15 * t4 + 10 * t3) + m0 * (t - 6 * t3 + 8 * t4 - 3 * t5) + m1 * (-4 * t3 + 7 * t4 - 3 * t5);
  }

  // The direction a move is going at one end: a unit vector in van Wijk &
  // Nuij's own measure (pans in view heights at that end's zoom, the zoom
  // logarithmically, weighted as their path length weights them), which is
  // what lets the arriving and leaving directions at a keyframe be compared.
  // `atStart` is the direction it sets off in, else the direction it
  // arrives from.
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

  // The speed each move leaves its start and arrives at its end, as a
  // multiple of its own average speed (see ease): [{ m0, m1 }] for `list`
  // from moves(), each move given its `route`. A keyframe's velocity is the
  // mean of the velocity arriving and the velocity leaving; the first and
  // last of a movie that doesn't loop, and any keyframe with a hold on one
  // side of it, are at rest.
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
      var perUnit = move.seconds / length; // seconds per unit of path: turns a speed into a multiple of this move's average
      return {
        m0: Math.max(0, dot(velocity[j], direction(move.route, move.from, true)) * perUnit),
        m1: Math.max(0, dot(velocity[(j + 1) % n], direction(move.route, move.to, false)) * perUnit),
      };
    });
  }

  // The move from keyframe a to keyframe b: { length, at(u) } where u in
  // [0, 1] is how far ALONG THE PATH (not through time, see ease) and at()
  // returns { center, scale }.
  function path(a, b) {
    // The high and low halves differenced separately: two centers a deep
    // zoom apart can be the very same float64.
    var dx = (b.center.x - a.center.x) + ((b.center.xLo || 0) - (a.center.xLo || 0));
    var dy = (b.center.y - a.center.y) + ((b.center.yLo || 0) - (a.center.yLo || 0));
    var d = Math.sqrt(dx * dx + dy * dy);
    var w0 = a.scale, w1 = b.scale;

    // No pan to speak of (under a billionth of the tighter view): a plain
    // geometric zoom, the limit the general path goes to, and the general
    // formulas divide by d.
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

    // rho^2 = 2 and rho^4 = 4 throughout. asinh rather than the textbook
    // log(sqrt(b*b + 1) - b), which is the same number computed by
    // cancellation.
    var r0 = -Math.asinh((w1 * w1 - w0 * w0 + 4 * d * d) / (4 * w0 * d));
    var r1 = -Math.asinh((w1 * w1 - w0 * w0 - 4 * d * d) / (4 * w1 * d));
    var length = (r1 - r0) / RHO;

    // From one end: the fraction of the displacement covered after path
    // length s, and the scale there. `start` is that end's own r - r0 for
    // a, and -r1 for b, which is what r0 becomes with the two views swapped.
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

  // The moves a list of keyframes makes, in order: [{ from, to, seconds }].
  // `loop` closes the movie with one more move, from the last keyframe back
  // to the first, so that played on repeat it never jumps. Every move's time
  // is its DESTINATION's, which gives the first keyframe's a meaning in a
  // looping movie (the move that closes it) and none otherwise.
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

  // Every frame of the movie: [{ center, scale, step }]. Each move
  // contributes its start and everything up to, not including, its end,
  // which is the next move's start; a movie that doesn't loop then gets its
  // final keyframe as one last frame, where a looping one has frame 0.
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
