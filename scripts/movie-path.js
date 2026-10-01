// CPAL-1.0 License. See chaosaccelerator.com/license.html

// A movie's camera: keyframes in, one view per frame out. Pure arithmetic, no DOM or GL.
// A keyframe is { center: {x, xLo, y, yLo}, scale, step, seconds }: a map view, its simulation
// frame, and how long the move ARRIVING at it takes (null: autoSeconds).
(function (global) {
  "use strict";

  var FPS = 30;
  var RHO = Math.SQRT2; // van Wijk & Nuij's recommended trade-off between zooming and panning

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

  // The quintic's end-speed terms: zero, with no acceleration, at both ends; slope 1 at one end, 0 at the other.
  function startSlope(t) { var t3 = t * t * t; return t - 6 * t3 + 8 * t3 * t - 3 * t3 * t * t; }
  function endSlope(t) { var t3 = t * t * t; return -4 * t3 + 7 * t3 * t - 3 * t3 * t * t; }

  function smootherstep(t) { var t3 = t * t * t; return t3 * (10 - 15 * t + 6 * t * t); }

  // Quintic Hermite from speed m0 to m1 (1 = the move's average, 0 = rest), no acceleration at either end.
  var MAX_END_SPEED = 2.5;
  function ease(t, m0, m1) {
    t = clamp(t, 0, 1);
    return smootherstep(t) + clamp(m0 || 0, 0, MAX_END_SPEED) * startSlope(t) + clamp(m1 || 0, 0, MAX_END_SPEED) * endSlope(t);
  }

  // ---- Smooth through keyframes ---- velocities are [views across, views up, ln of the zoom], per
  // second unless said otherwise. Every keyframe gets one velocity, and both moves meeting there leave and
  // arrive with it: the part along a move's route rides its ease, the rest is an offset zero at both ends.

  // View q relative to view p, measured at `scale`.
  function screenDelta(p, q, scale) {
    return [
      ((q.center.x - p.center.x) + ((q.center.xLo || 0) - (p.center.xLo || 0))) / scale,
      ((q.center.y - p.center.y) + ((q.center.yLo || 0) - (p.center.yLo || 0))) / scale,
      Math.log(q.scale / p.scale),
    ];
  }

  // A route's velocity at one end, per unit of path.
  function endVelocity(route, atStart) {
    var e = 1e-3;
    var p = route.at(atStart ? 0 : 1 - e), q = route.at(atStart ? e : 1);
    return screenDelta(p, q, atStart ? p.scale : q.scale).map(function (v) { return v / e; });
  }

  // van Wijk & Nuij's measure, so panning and zooming compare.
  function wijkDot(a, b) { return RHO * RHO * (a[0] * b[0] + a[1] * b[1]) + a[2] * b[2] / (RHO * RHO); }

  // The mean of the moves arriving and leaving, axis by axis, steps included; zero on an axis where they
  // disagree in sign (the camera turns round there, so it rests), at a movie's ends, and beside a hold.
  function keyframeVelocities(list, keyframes, loop) {
    return keyframes.map(function (key, i) {
      var arriving = i > 0 ? list[i - 1] : (loop && list.length ? list[list.length - 1] : null);
      var leaving = i < list.length ? list[i] : null;
      var out = { view: [0, 0, 0], steps: 0 };
      if (!arriving || !leaving) return out;
      if (arriving.route.length > 0 && leaving.route.length > 0) {
        out.view = [0, 1, 2].map(function (c) {
          var a = arriving.end[c] / arriving.seconds, b = leaving.start[c] / leaving.seconds;
          return a * b < 0 ? 0 : (a + b) / 2;
        });
      }
      // Steps: at most MAX_END_SPEED times the slower side, so neither move overshoots its keyframes.
      var rin = arriving.stepRate, rout = leaving.stepRate;
      if (rin * rout > 0) out.steps = Math.sign(rin) * Math.min(Math.abs(rin + rout) / 2, MAX_END_SPEED * Math.min(Math.abs(rin), Math.abs(rout)));
      return out;
    });
  }

  // `velocity` split for one end of a move, per unit of its time: m, the speed along its route for ease,
  // and the rest, for the offset.
  function splitVelocity(velocity, routeVelocity, seconds) {
    var want = velocity.map(function (v) { return v * seconds; });
    var norm = wijkDot(routeVelocity, routeVelocity);
    var m = norm > 0 ? clamp(wijkDot(want, routeVelocity) / norm, 0, MAX_END_SPEED) : 0;
    return { m: m, rest: want.map(function (w, c) { return w - m * routeVelocity[c]; }) };
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

  // ---- Whole simulation frames ---- a frame shows a whole simulation frame, so following a smooth rate
  // of 0.5 per frame would show 0, 1, 0, 1: a stutter. Between -2 and 2 the rate is held at a whole number
  // for runs instead; faster, it may vary frame to frame. Viterbi picks the whole steps with the least squared
  // drift from the smooth ones plus SWITCH_COST per unit a slow rate changes by, through every keyframe's step.
  var SWITCH_COST = 1200;  // in squared steps of drift: runs of about a second at a rate of 0.5
  var MAX_DRIFT = 24;      // steps a frame may stray from the smooth curve
  var SLOW_RATE = 2;

  function switchCost(a, b) {
    if (a === b || (a * b > 0 && Math.abs(a) >= SLOW_RATE && Math.abs(b) >= SLOW_RATE)) return 0;
    return SWITCH_COST * Math.abs(a - b);
  }

  // smooth[k]: the step frame k would show; keyed[k]: the whole step a keyframe pins it to, if one does.
  function wholeSteps(smooth, keyed, lowest, highest) {
    var layers = [], prev = null;
    smooth.forEach(function (want, k) {
      var pinned = keyed[k] !== undefined;
      var lo = pinned ? keyed[k] : Math.max(lowest, Math.floor(want) - MAX_DRIFT);
      var hi = pinned ? keyed[k] : Math.min(highest, Math.ceil(want) + MAX_DRIFT);
      // A state is a step and the rate that arrived at it: within one of the smooth rate.
      var rate = k > 0 ? want - smooth[k - 1] : 0;
      var rLo = k > 0 ? Math.floor(rate) - 1 : 0, rates = k > 0 ? Math.ceil(rate) + 2 - rLo : 1;
      var layer = { lo: lo, size: hi - lo + 1, rLo: rLo, rates: rates, cost: new Float64Array((hi - lo + 1) * rates).fill(Infinity) };
      layer.from = new Int32Array(layer.cost.length);
      for (var p = lo; p <= hi; p++) {
        for (var r = rLo; r < rLo + rates; r++) {
          var i = (p - lo) * rates + (r - rLo), q = p - r;
          if (!prev) layer.cost[i] = 0;
          else if (q >= prev.lo && q < prev.lo + prev.size) {
            for (var r2 = 0; r2 < prev.rates; r2++) {
              var j = (q - prev.lo) * prev.rates + r2;
              var c = prev.cost[j] + (k > 1 ? switchCost(prev.rLo + r2, r) : 0);
              if (c < layer.cost[i]) { layer.cost[i] = c; layer.from[i] = j; }
            }
          }
          layer.cost[i] += (p - want) * (p - want);
        }
      }
      if (prev) prev.cost = null;
      layers.push(layer);
      prev = layer;
    });
    var best = 0, n = layers.length, out = new Array(n);
    for (var e = 1; e < prev.cost.length; e++) if (prev.cost[e] < prev.cost[best]) best = e;
    if (!isFinite(prev.cost[best])) return smooth.map(Math.round); // no path: rounding still meets the keyframes
    for (var k = n - 1; k >= 0; k--) {
      out[k] = layers[k].lo + Math.floor(best / layers[k].rates);
      best = layers[k].from[best];
    }
    return out;
  }

  // Every frame: each move contributes its start up to, not including, its end; a non-looping movie then gets its last keyframe.
  function frames(keyframes, loop) {
    var out = [], smooth = [], keyed = [];
    var list = moves(keyframes, loop);
    list.forEach(function (move) {
      move.route = path(move.from, move.to);
      move.start = endVelocity(move.route, true);
      move.end = endVelocity(move.route, false);
      move.stepRate = (move.to.step - move.from.step) / move.seconds;
    });
    var velocities = keyframeVelocities(list, keyframes, loop);
    list.forEach(function (move, j) {
      var v0 = velocities[j], v1 = velocities[(j + 1) % keyframes.length];
      var a = splitVelocity(v0.view, move.start, move.seconds), b = splitVelocity(v1.view, move.end, move.seconds);
      var count = Math.max(1, Math.round(move.seconds * FPS));
      keyed[out.length] = Math.round(move.from.step);
      for (var k = 0; k < count; k++) {
        var t = k / count, s0 = startSlope(t), s1 = endSlope(t);
        var view = move.route.at(ease(t, a.m, b.m));
        var offset = [0, 1, 2].map(function (c) { return s0 * a.rest[c] + s1 * b.rest[c]; });
        out.push({
          center: offsetCenter(view.center, offset[0] * view.scale, offset[1] * view.scale),
          scale: view.scale * Math.exp(offset[2]),
        });
        // Steps on a quintic of their own, leaving and arriving at their keyframes' step velocities.
        smooth.push(move.from.step + (move.to.step - move.from.step) * smootherstep(t) + move.seconds * (s0 * v0.steps + s1 * v1.steps));
      }
    });
    if (keyframes.length && !(loop && keyframes.length > 1)) {
      var last = keyframes[keyframes.length - 1];
      keyed[out.length] = Math.round(last.step);
      out.push({ center: { x: last.center.x, xLo: last.center.xLo || 0, y: last.center.y, yLo: last.center.yLo || 0 }, scale: last.scale });
      smooth.push(last.step);
    }
    if (!out.length) return out;
    var steps = keyframes.map(function (key) { return Math.round(key.step); });
    var whole = wholeSteps(smooth, keyed, Math.min.apply(null, steps), Math.max.apply(null, steps));
    out.forEach(function (frame, k) { frame.step = whole[k]; });
    return out;
  }

  global.MoviePath = {
    FPS: FPS,
    ease: ease,
    path: path,
    autoSeconds: autoSeconds,
    moves: moves,
    totalSeconds: totalSeconds,
    frames: frames,
  };
})(typeof window !== "undefined" ? window : globalThis);
