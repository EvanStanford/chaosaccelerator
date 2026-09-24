// This file is part of Chaos Accelerator, licensed under the Common Public
// Attribution License, Version 1.0 (CPAL-1.0) - see LICENSE in the project
// root, or https://chaosaccelerator.com/license for a hosted copy.

// ---- Global Stats: the analysis math ----
//
// Everything here is pure number crunching over ONE rectangular block of
// sampled output values - no DOM, no WebGL, no scene. The fractal grid
// renders that block with its own shader (see sampleValueGrid in
// fractal-grid.js) and hands it here; fractal-stats-panel.js draws whatever
// comes back. Kept DOM-free for the same reason physics-engine.js and
// physics-hinge-geometry.js are: it can then be loaded straight into the
// regression page (physics-tests.html) and checked against closed-form
// answers, which is the only practical way to know a structure tensor or a
// circular mean is right rather than merely plausible.
//
// ---- Two conventions everything below depends on ----
//
// VALUES ARE t, NOT THE OUTPUT PROPERTY. Every sample is the same
// normalized [0, 1] t the grid's own colorMap takes - so a "range" here is
// a fraction of the whole rainbow, and the caller converts back to degrees/
// steps/units for display. That is deliberate: t is what the picture on
// screen is actually made of, and it's the only representation in which a
// wrapped output's two ends are known to meet.
//
// ROW 0 IS THE BOTTOM ROW. That's gl.readPixels' own order (and
// sampleCoordToWorld's, which maps these same indices back to world
// coordinates), so a +row step is UP on screen and every angle computed
// here is already in the reader's own screen orientation: 0 degrees east,
// 90 degrees north, counterclockwise.
//
// ---- Circular outputs ----
//
// Rotation, and x/y under Pac-Man Warp, wrap: t = 0 and t = 1 are the same
// physical value, one step apart, not a full range apart. Every difference
// taken here therefore goes through delta(), which folds into [-0.5, 0.5]
// when `circular` is set - so the seam where mod() happened to cut the
// circle produces no gradient and no false edge in the orientation rose.
// Averages of circular data likewise go through
// the trigonometric moments rather than a plain mean, which would put the
// average of 0.99 and 0.01 at 0.5 - the exact opposite side of the wheel
// from the truth.
(function (global) {
  "use strict";

  var TAU = Math.PI * 2;

  // b - a, folded into [-0.5, 0.5] for a circular output: the SHORT way
  // round the wheel, which is the only difference between two hues that
  // means anything.
  function delta(a, b, circular) {
    var d = b - a;
    if (!circular) return d;
    if (d > 0.5) return d - 1;
    if (d < -0.5) return d + 1;
    return d;
  }

  // ---- Order statistics from a fine histogram, not from a sort ----
  //
  // A sorted copy of the samples is the textbook way to take a median, and
  // it is the wrong one here: the caller can now ask for a full-resolution
  // measurement, and sorting several million floats is both a multi-second
  // step that cannot be broken up and a second copy of the whole block in
  // memory. Counting into 4096 buckets is one pass that CAN be broken up
  // (it rides along with the display histogram), needs 32KB whatever the
  // sample count, and pins every quantile to within 1/4096 of the color
  // range - far finer than the two decimal places any of them is shown to.
  var QUANTILE_BUCKETS = 4096;

  function quantileFromCounts(counts, total, q) {
    if (total <= 0) return NaN;
    var target = q * total, cum = 0;
    for (var i = 0; i < counts.length; i++) {
      if (counts[i] > 0 && cum + counts[i] >= target) {
        // Straight-line within the bucket, so a quantile falling inside a
        // busy bucket doesn't snap to its edge.
        return (i + (target - cum) / counts[i]) / counts.length;
      }
      cum += counts[i];
    }
    return 1;
  }

  // The smallest arc of the color wheel containing every sampled value, as
  // a fraction of the whole wheel - the full circle minus its single
  // largest gap. A plain max-minus-min can't see that 0.97 and 0.02 are
  // neighbours. Read off the same bucket counts as the quantiles: the
  // largest gap is the longest run of empty buckets, wrapping round the end
  // of the array because the two ends of a circular output are the same
  // place.
  function circularSpreadFromCounts(counts) {
    var n = counts.length, occupied = -1, i;
    for (i = 0; i < n; i++) if (counts[i] > 0) { occupied = i; break; }
    if (occupied < 0) return 0;
    var longestGap = 0, gap = 0;
    // Twice round, so a run straddling the wrap point is measured whole.
    for (i = 0; i < n * 2; i++) {
      if (counts[i % n] > 0) gap = 0;
      else { gap++; if (gap > longestGap) longestGap = gap; }
    }
    return Math.max(0, 1 - Math.min(longestGap, n) / n);
  }

  // ---- The job ----
  //
  // Global stats run alongside the fractal's own rendering and the hover
  // replay, and must never make either of them stutter. So the whole
  // analysis is built as a LIST OF STEPS rather than one function - the
  // caller drives it from requestIdleCallback and can stop between any two
  // of them (see scheduleStatsSlice in fractal-grid.js).
  //
  // Every pass that walks the block is split by ROWS rather than being one
  // step of its own (see addRowPass). That is what lets the sample
  // resolution be a user setting: at the coarse end a pass is one step
  // either way, and at full resolution - where a single pass over several
  // million samples would be a visible frame hitch, however idle the page
  // was when it started - the same pass becomes a few dozen steps of
  // constant size.
  //
  // spec:
  //   width, height  - sample block dimensions
  //   t              - Float32Array(width * height), row-major, row 0 at the BOTTOM
  //   circular       - whether t = 0 and t = 1 are the same value
  //   groups         - { extremes, distribution, orientation, features } -
  //                    only the true ones are computed, and each costs
  //                    nothing when off
  //   colSeam        - Uint8Array(width - 1) or null: colSeam[c] set means
  //                    the step from column c to c+1 crosses an INPUT seam
  //                    (see the host's own findInputSeams) and is not a real
  //                    neighbour comparison
  //   rowSeam        - Uint8Array(height - 1) or null, same for rows

  // Roughly how many samples one step should touch. Every pass below costs
  // about the same per sample, so this is the whole of what keeps a step's
  // cost independent of the sample block - a few milliseconds at the top of
  // the resolution slider just as at the bottom.
  var SAMPLES_PER_STEP = 60000;

  function createJob(spec) {
    var W = spec.width | 0, H = spec.height | 0;
    var t = spec.t;
    var circular = !!spec.circular;
    var groups = spec.groups || {};
    var colSeam = spec.colSeam || null;
    var rowSeam = spec.rowSeam || null;
    var histogramBuckets = spec.histogramBuckets || 96;
    var orientationBins = spec.orientationBins || 180;

    var out = {
      width: W, height: H, circular: circular,
      sampleCount: W * H,
      groups: {},
    };

    // Filled by the first passes and read by nearly every one after them.
    var valid = null;      // Uint8Array - a NaN pixel (a simulation that blew up) is not a measurement
    var validCount = 0;
    var mean = 0;          // linear mean, or the circular mean for a wrapping output
    var centered = null;   // Float32Array of delta(mean, t) - the residual every second-order metric works from

    function xSeam(c) { return colSeam ? colSeam[c] === 1 : false; }
    function ySeam(r) { return rowSeam ? rowSeam[r] === 1 : false; }

    var steps = [];
    var rowsPerStep = Math.max(1, Math.ceil(SAMPLES_PER_STEP / Math.max(1, W)));

    // Splits a loop over rows [from, to) into as many steps as it takes at
    // rowsPerStep each. `body(r0, r1)` walks one chunk; `finish()` runs
    // once, immediately after the last chunk, in the same step.
    function addRowPass(from, to, body, finish) {
      var state = { row: from, finished: false };
      var chunks = Math.max(1, Math.ceil(Math.max(0, to - from) / rowsPerStep));
      for (var i = 0; i < chunks; i++) {
        steps.push(function rowChunk() {
          if (state.finished) return;
          var end = Math.min(to, state.row + rowsPerStep);
          if (end > state.row) body(state.row, end);
          state.row = end;
          if (state.row >= to) {
            state.finished = true;
            if (finish) finish();
          }
        });
      }
    }

    // `centered` is a whole extra copy of the block, so it is only built
    // when the one group that needs a residual (the distribution's moments)
    // is wanted.
    var needsCentered = !!groups.distribution;

    // ---- Validity, and the mean every second-order metric is measured from ----
    var sum = 0, cosSum = 0, sinSum = 0;
    steps.push(function allocate() {
      valid = new Uint8Array(W * H);
    });
    addRowPass(0, H, function countValid(r0, r1) {
      for (var r = r0; r < r1; r++) {
        for (var c = 0; c < W; c++) {
          var i = r * W + c, v = t[i];
          if (!isFinite(v)) continue;
          valid[i] = 1;
          validCount++;
          sum += v;
          if (circular) {
            cosSum += Math.cos(TAU * v);
            sinSum += Math.sin(TAU * v);
          }
        }
      }
    }, function finishMean() {
      out.validCount = validCount;
      out.invalidCount = W * H - validCount;
      if (validCount === 0) { out.empty = true; return; }
      if (circular) {
        var C = cosSum / validCount, S = sinSum / validCount;
        var R = Math.sqrt(C * C + S * S);
        mean = ((Math.atan2(S, C) / TAU) % 1 + 1) % 1;
        out.resultantLength = R;      // 0 = values spread all round the wheel, 1 = all identical
        out.circularMean = mean;
        // Mardia's circular standard deviation, in t units (the 1/TAU puts
        // it on the same [0, 1] scale as everything else here). R = 0 is a
        // perfectly uniform spread, whose deviation is genuinely unbounded.
        out.circularStd = R > 0 ? Math.sqrt(-2 * Math.log(R)) / TAU : Infinity;
      } else {
        mean = sum / validCount;
      }
      if (needsCentered) centered = new Float32Array(W * H);
    });

    if (needsCentered) {
      addRowPass(0, H, function buildCentered(r0, r1) {
        if (out.empty) return;
        for (var r = r0; r < r1; r++) {
          for (var c = 0; c < W; c++) {
            var i = r * W + c;
            centered[i] = valid[i] ? delta(mean, t[i], circular) : 0;
          }
        }
      });
    }

    // ---- Extremes and range ----
    if (groups.extremes) {
      var minV = Infinity, maxV = -Infinity, minI = -1, maxI = -1;
      addRowPass(0, H, function scanExtremes(r0, r1) {
        if (out.empty) return;
        for (var r = r0; r < r1; r++) {
          for (var c = 0; c < W; c++) {
            var i = r * W + c;
            if (!valid[i]) continue;
            var v = t[i];
            if (v < minV) { minV = v; minI = i; }
            if (v > maxV) { maxV = v; maxI = i; }
          }
        }
      }, function finishExtremes() {
        if (out.empty) return;
        out.groups.extremes = {
          min: { t: minV, col: minI % W, row: (minI / W) | 0 },
          max: { t: maxV, col: maxI % W, row: (maxI / W) | 0 },
          range: maxV - minV,
        };
      });
    }

    // ---- Distribution: histogram, moments, entropy, quantiles ----
    if (groups.distribution) {
      var counts = null, fine = null;
      steps.push(function allocateHistograms() {
        counts = new Float64Array(histogramBuckets);   // what the plot draws
        fine = new Float64Array(QUANTILE_BUCKETS);     // what the quantiles are read off
      });
      addRowPass(0, H, function countBuckets(r0, r1) {
        if (out.empty) return;
        for (var r = r0; r < r1; r++) {
          for (var c = 0; c < W; c++) {
            var i = r * W + c;
            if (!valid[i]) continue;
            var v = t[i];
            var b = Math.floor(v * histogramBuckets);
            counts[b < 0 ? 0 : (b >= histogramBuckets ? histogramBuckets - 1 : b)]++;
            var f = Math.floor(v * QUANTILE_BUCKETS);
            fine[f < 0 ? 0 : (f >= QUANTILE_BUCKETS ? QUANTILE_BUCKETS - 1 : f)]++;
          }
        }
      }, function finishHistogram() {
        if (out.empty) return;
        // Shannon entropy of the bucketed distribution, in bits, plus the
        // same figure as a fraction of the most a histogram this size can
        // carry (log2 of the bucket count) - which is the version that
        // means something without knowing how many buckets there were.
        var bits = 0, peak = 0, occupied = 0;
        for (var b = 0; b < histogramBuckets; b++) {
          var p = counts[b] / validCount;
          if (p > 0) { bits -= p * Math.log2(p); occupied++; }
          if (counts[b] > peak) peak = counts[b];
        }
        var d = out.groups.distribution = out.groups.distribution || {};
        d.histogram = counts;
        d.histogramPeak = peak;
        d.buckets = histogramBuckets;
        d.entropyBits = bits;
        d.entropyNormalized = bits / Math.log2(histogramBuckets);
        d.occupiedBuckets = occupied;
        // Quantiles need a "smallest" to count up from, and a circle has
        // none - so a wrapping output gets the smallest containing arc
        // instead, which is the honest answer to "how spread out is this."
        if (circular) {
          d.circularSpread = circularSpreadFromCounts(fine);
        } else {
          d.quantiles = {
            p1: quantileFromCounts(fine, validCount, 0.01),
            p5: quantileFromCounts(fine, validCount, 0.05),
            p25: quantileFromCounts(fine, validCount, 0.25),
            p50: quantileFromCounts(fine, validCount, 0.5),
            p75: quantileFromCounts(fine, validCount, 0.75),
            p95: quantileFromCounts(fine, validCount, 0.95),
            p99: quantileFromCounts(fine, validCount, 0.99),
          };
          d.median = d.quantiles.p50;
          d.iqr = d.quantiles.p75 - d.quantiles.p25;
        }
      });

      // Second through fourth moments of the CENTERED values, so a circular
      // output's own wrap is already folded out of them: for wrapping data
      // these are the moments about the circular mean, which is the
      // standard way to keep skew and kurtosis meaningful there.
      var m2 = 0, m3 = 0, m4 = 0;
      addRowPass(0, H, function accumulateMoments(r0, r1) {
        if (out.empty) return;
        for (var r = r0; r < r1; r++) {
          for (var c = 0; c < W; c++) {
            var i = r * W + c;
            if (!valid[i]) continue;
            var z = centered[i], z2 = z * z;
            m2 += z2; m3 += z2 * z; m4 += z2 * z2;
          }
        }
      }, function finishMoments() {
        if (out.empty) return;
        var d = out.groups.distribution = out.groups.distribution || {};
        var v2 = m2 / validCount, v3 = m3 / validCount, v4 = m4 / validCount;
        var sd = Math.sqrt(v2);
        d.mean = mean;
        d.std = sd;
        d.variance = v2;
        d.skewness = sd > 0 ? v3 / (sd * sd * sd) : 0;
        d.kurtosisExcess = v2 > 0 ? v4 / (v2 * v2) - 3 : 0;
      });
    }

    // ---- Orientation: which way do the sharp lines run ----
    //
    // Sobel gradients (a central difference pre-smoothed across the
    // perpendicular axis) feed two things at once:
    //
    //  - a rose: every sample drops |grad| into the bin for the direction
    //    its EDGE runs, which is 90 degrees off the gradient's own. So a
    //    picture of horizontal stripes piles up at 0 degrees, which is what
    //    a reader expects "the lines run east-west" to look like.
    //  - the global structure tensor J = mean of [[gx^2, gxgy], [gxgy, gy^2]],
    //    whose eigenvalues give one number for how directional the whole
    //    view is (coherence) and one angle for which way.
    //
    // Directions are binned over 180 degrees, not 360: a line has no head
    // or tail, and a gradient and its negative describe the same edge.
    if (groups.orientation) {
      var bins = null, binCounts = null;
      var Jxx = 0, Jxy = 0, Jyy = 0, tensorN = 0;
      var binScale = orientationBins / Math.PI;
      steps.push(function allocateRose() {
        bins = new Float64Array(orientationBins);
        binCounts = new Float64Array(orientationBins);
      });
      addRowPass(1, Math.max(1, H - 1), function accumulateOrientation(r0, r1) {
        if (out.empty) return;
        for (var r = r0; r < r1; r++) {
          if (ySeam(r - 1) || ySeam(r)) continue;
          for (var c = 1; c < W - 1; c++) {
            if (xSeam(c - 1) || xSeam(c)) continue;
            var i = r * W + c;
            var ok = true;
            for (var dr = -1; dr <= 1 && ok; dr++) {
              for (var dc = -1; dc <= 1; dc++) {
                if (!valid[i + dr * W + dc]) { ok = false; break; }
              }
            }
            if (!ok) continue;
            // Every neighbour expressed as a wrapped offset from the
            // center, so the Sobel sums below never straddle the seam.
            var nw = delta(t[i], t[i + W - 1], circular), nn = delta(t[i], t[i + W], circular), ne = delta(t[i], t[i + W + 1], circular);
            var ww = delta(t[i], t[i - 1], circular), ee = delta(t[i], t[i + 1], circular);
            var sw = delta(t[i], t[i - W - 1], circular), ss = delta(t[i], t[i - W], circular), se = delta(t[i], t[i - W + 1], circular);
            var gx = ((ne + 2 * ee + se) - (nw + 2 * ww + sw)) / 8;
            var gy = ((nw + 2 * nn + ne) - (sw + 2 * ss + se)) / 8;
            var mag = Math.sqrt(gx * gx + gy * gy);
            Jxx += gx * gx; Jxy += gx * gy; Jyy += gy * gy; tensorN++;
            if (mag <= 0) continue;
            // atan2(gx, -gy) is atan2(gy, gx) rotated by +90 degrees: the
            // edge's own direction, folded into [0, pi).
            var ang = Math.atan2(gx, -gy);
            if (ang < 0) ang += Math.PI;
            if (ang >= Math.PI) ang -= Math.PI;
            var b = Math.floor(ang * binScale);
            if (b < 0) b = 0;
            if (b >= orientationBins) b = orientationBins - 1;
            bins[b] += mag;
            binCounts[b]++;
          }
        }
      }, function finishOrientation() {
        if (out.empty) return;
        var jxx = Jxx, jxy = Jxy, jyy = Jyy;
        if (tensorN > 0) { jxx /= tensorN; jxy /= tensorN; jyy /= tensorN; }
        // Eigenvalues of the 2x2 symmetric tensor, closed form.
        var tr = jxx + jyy;
        var diff = Math.sqrt((jxx - jyy) * (jxx - jyy) + 4 * jxy * jxy);
        var lambda1 = (tr + diff) / 2, lambda2 = (tr - diff) / 2;
        // The dominant GRADIENT direction; +90 degrees is the direction the
        // edges themselves run, which is what gets reported.
        var edgeAngle = 0.5 * Math.atan2(2 * jxy, jxx - jyy) + Math.PI / 2;
        edgeAngle = ((edgeAngle % Math.PI) + Math.PI) % Math.PI;

        var peakBin = 0, total = 0;
        for (var b = 0; b < orientationBins; b++) {
          if (bins[b] > bins[peakBin]) peakBin = b;
          total += bins[b];
        }
        out.groups.orientation = {
          bins: bins,                 // edge "volume" (summed gradient magnitude) per direction
          binCounts: binCounts,
          binCount: orientationBins,
          totalWeight: total,
          peakBinDegrees: (peakBin + 0.5) * (180 / orientationBins),
          // (l1 - l2) / (l1 + l2): 0 when edges point every way equally,
          // 1 when they all point one way.
          coherence: tr > 0 ? (lambda1 - lambda2) / tr : 0,
          dominantEdgeDegrees: edgeAngle * 180 / Math.PI,
          lambda1: lambda1,
          lambda2: lambda2,
          samples: tensorN,
        };
      });
    }

    // ---- Features: how many distinct things are in the picture, and what
    // shape they are ----
    if (groups.features) {
      // Everything below is measured against the picture's own scale, so
      // "flat" means flat relative to how much this view varies at all
      // rather than against some absolute number of color units.
      var scaleSum = 0, scaleN = 0, flatCutoff = 0;
      addRowPass(1, Math.max(1, H - 1), function measureScale(r0, r1) {
        if (out.empty) return;
        for (var r = r0; r < r1; r++) {
          for (var c = 1; c < W - 1; c++) {
            var i = r * W + c;
            if (!valid[i] || !valid[i + 1]) continue;
            scaleSum += Math.abs(delta(t[i], t[i + 1], circular));
            scaleN++;
          }
        }
      }, function setCutoff() {
        flatCutoff = scaleN > 0 ? (scaleSum / scaleN) * 0.25 : 0;
      });

      var ridges = 0, valleys = 0, saddles = 0, flats = 0, inspected = 0;
      // Which way each sample curves, kept rather than only counted:
      // the longest-ridge and longest-valley measurements below need
      // to know WHICH samples were which, not just how many.
      var RIDGE = 1, VALLEY = 2;
      var shape = null;   // Uint8Array: 0 unclassified, RIDGE, or VALLEY
      steps.push(function allocateShape() {
        if (out.empty) return;
        shape = new Uint8Array(W * H);
      });
      addRowPass(1, Math.max(1, H - 1), function census(r0, r1) {
        if (out.empty) return;
        for (var r = r0; r < r1; r++) {
          if (ySeam(r - 1) || ySeam(r)) continue;
          for (var c = 1; c < W - 1; c++) {
            if (xSeam(c - 1) || xSeam(c)) continue;
            var i = r * W + c;
            var ok = true;
            for (var dr = -1; dr <= 1 && ok; dr++) {
              for (var dc = -1; dc <= 1; dc++) {
                if (!valid[i + dr * W + dc]) { ok = false; break; }
              }
            }
            if (!ok) continue;
            inspected++;

            // Discrete Hessian, every term a wrapped offset from the
            // center. Eigenvalue SIGNS are what classify the local shape:
            // both negative is a ridge/peak, both positive a valley/pit,
            // opposite signs a saddle - the pass where two basins meet.
            var txx = delta(t[i], t[i + 1], circular) + delta(t[i], t[i - 1], circular);
            var tyy = delta(t[i], t[i + W], circular) + delta(t[i], t[i - W], circular);
            var txy = (delta(t[i], t[i + W + 1], circular) - delta(t[i], t[i + W - 1], circular) -
                       delta(t[i], t[i - W + 1], circular) + delta(t[i], t[i - W - 1], circular)) / 4;
            var trH = txx + tyy;
            var rad = Math.sqrt((txx - tyy) * (txx - tyy) + 4 * txy * txy);
            var e1 = (trH + rad) / 2, e2 = (trH - rad) / 2;
            if (Math.abs(e1) < flatCutoff && Math.abs(e2) < flatCutoff) flats++;
            else if (e1 < 0 && e2 < 0) { ridges++; if (shape) shape[i] = RIDGE; }
            else if (e1 > 0 && e2 > 0) { valleys++; if (shape) shape[i] = VALLEY; }
            else saddles++;
          }
        }
      }, function finishFeatures() {
        if (out.empty) return;
        out.groups.features = {
          inspected: inspected,
          ridgeFraction: inspected > 0 ? ridges / inspected : 0,
          valleyFraction: inspected > 0 ? valleys / inspected : 0,
          saddleFraction: inspected > 0 ? saddles / inspected : 0,
          flatFraction: inspected > 0 ? flats / inspected : 0,
        };
      });

      // ---- The longest ridge, and the longest valley ----
      //
      // The fractions above say how MUCH of the view curves each way; they
      // say nothing about whether that curvature is organised. A picture
      // can be a third valley by area either as ten thousand unconnected
      // specks or as one canyon running corner to corner, and those are
      // completely different pictures. So: take the ridge samples as one
      // set and the valley samples as another, find their connected pieces,
      // and measure the longest piece of each end to end.
      //
      // "Length" here is the GEODESIC diameter - the distance from one end
      // of the piece to the other along the piece itself, not the straight
      // line between them - which is the honest answer for a feature that
      // curves. It is found by the standard double sweep: breadth-first
      // from any member reaches one true end, and breadth-first from THAT
      // end reaches the other. Exact on a piece with no loops, and within a
      // sample or two on one that has them.
      //
      // Cost. Labelling is one union-find pass over the block, near linear.
      // The double sweep is quadratic in nothing - it is two passes over
      // ONE piece - but it is only run on a handful of candidate pieces
      // rather than all of them: the longest is always among the largest by
      // area or the largest by bounding box, and taking several of each
      // covers the case where a long thin piece loses on area to a fat
      // round one. Everything else is left unmeasured, which is what keeps
      // this affordable on a multi-megasample block.
      var parent = null;      // union-find, indexed by sample; only shaped samples take part
      var comps = null;       // root -> { size, minC, maxC, minR, maxR, cls }
      var candidates = null;  // the few roots worth a double sweep
      var members = null;     // root -> array of sample indices
      // How many pieces of each class, by each measure, get measured
      // properly. Four and four is well past the point where the longest
      // has ever not been among them, and each one is cheap.
      var LONGEST_CANDIDATES = 4;

      steps.push(function allocateLabels() {
        if (out.empty || !shape) return;
        parent = new Int32Array(W * H);
      });

      // Union with the four neighbours already walked (left, and the three
      // above) - which is all it takes for 8-connectivity when the walk
      // goes in row order, and means a neighbour's own label is always set
      // by the time it is read.
      addRowPass(1, Math.max(1, H - 1), function labelPieces(r0, r1) {
        if (out.empty || !shape || !parent) return;
        for (var r = r0; r < r1; r++) {
          for (var c = 1; c < W - 1; c++) {
            var i = r * W + c, s = shape[i];
            if (!s) continue;
            parent[i] = i;
            if (c > 1 && shape[i - 1] === s) unite(i, i - 1);
            if (r > 1) {
              if (shape[i - W] === s) unite(i, i - W);
              if (c > 1 && shape[i - W - 1] === s) unite(i, i - W - 1);
              if (c < W - 2 && shape[i - W + 1] === s) unite(i, i - W + 1);
            }
          }
        }
      });

      addRowPass(1, Math.max(1, H - 1), function measurePieces(r0, r1) {
        if (out.empty || !shape || !parent) return;
        if (!comps) comps = new Map();
        for (var r = r0; r < r1; r++) {
          for (var c = 1; c < W - 1; c++) {
            var i = r * W + c, s = shape[i];
            if (!s) continue;
            var root = findRoot(i);
            var e = comps.get(root);
            if (!e) {
              comps.set(root, { size: 1, minC: c, maxC: c, minR: r, maxR: r, cls: s });
            } else {
              e.size++;
              if (c < e.minC) e.minC = c; else if (c > e.maxC) e.maxC = c;
              if (r < e.minR) e.minR = r; else if (r > e.maxR) e.maxR = r;
            }
          }
        }
      }, function choosePieces() {
        if (out.empty || !comps) return;
        // The longest piece is among the biggest by area or the biggest by
        // bounding box - a long thin one can lose the first contest badly
        // and win the second outright, which is exactly the shape this
        // whole measurement is looking for.
        var byClass = {};
        byClass[RIDGE] = [];
        byClass[VALLEY] = [];
        comps.forEach(function (e, root) {
          e.root = root;
          e.span = Math.sqrt((e.maxC - e.minC) * (e.maxC - e.minC) + (e.maxR - e.minR) * (e.maxR - e.minR));
          byClass[e.cls].push(e);
        });
        candidates = [];
        [RIDGE, VALLEY].forEach(function (cls) {
          var list = byClass[cls], picked = {};
          function take(key) {
            list.sort(function (a, b) { return b[key] - a[key]; });
            for (var i = 0; i < Math.min(LONGEST_CANDIDATES, list.length); i++) {
              if (!picked[list[i].root]) { picked[list[i].root] = true; candidates.push(list[i]); }
            }
          }
          take("size");
          take("span");
        });
        members = new Map();
        for (var i = 0; i < candidates.length; i++) members.set(candidates[i].root, []);
      });

      addRowPass(1, Math.max(1, H - 1), function collectMembers(r0, r1) {
        if (out.empty || !members || members.size === 0) return;
        for (var r = r0; r < r1; r++) {
          for (var c = 1; c < W - 1; c++) {
            var i = r * W + c;
            if (!shape[i]) continue;
            var list = members.get(findRoot(i));
            if (list) list.push(i);
          }
        }
      }, function sweepPieces() {
        if (out.empty || !out.groups.features) return;
        var best = {};
        best[RIDGE] = null;
        best[VALLEY] = null;
        for (var k = 0; candidates && k < candidates.length; k++) {
          var comp = candidates[k];
          var found = geodesicDiameter(members.get(comp.root));
          if (found && (!best[comp.cls] || found.length > best[comp.cls].length)) best[comp.cls] = found;
        }
        var diagonal = Math.sqrt(W * W + H * H);
        var f = out.groups.features;
        f.diagonalSamples = diagonal;
        f.longestRidge = best[RIDGE];
        f.longestValley = best[VALLEY];
        // What the panel actually shows: a length that means the same thing
        // whatever the sampling resolution is, since both it and the
        // diagonal are counted in the same samples.
        f.longestRidgeDiagonals = best[RIDGE] ? best[RIDGE].length / diagonal : 0;
        f.longestValleyDiagonals = best[VALLEY] ? best[VALLEY].length / diagonal : 0;
        // Nothing below needs the labels any more, and they are the largest
        // thing this group allocates.
        parent = null; comps = null; members = null; candidates = null;
      });

      function unite(a, b) {
        a = findRoot(a); b = findRoot(b);
        if (a !== b) parent[b] = a;
      }
      // Path halving: every lookup flattens the branch it walked, which is
      // what keeps the pass near linear without a rank array.
      function findRoot(a) {
        while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; }
        return a;
      }

      // Both ends of one connected piece, and the path between them.
      // `list` is every sample index in the piece.
      function geodesicDiameter(list) {
        if (!list || list.length === 0) return null;
        var n = list.length;
        var local = new Map();
        for (var i = 0; i < n; i++) local.set(list[i], i);
        var dist = new Int32Array(n), prev = new Int32Array(n), queue = new Int32Array(n);
        // Breadth-first over the piece from `start`, leaving dist/prev
        // filled and returning the last sample reached - which, from any
        // start, is one end of the piece.
        function sweep(start) {
          dist.fill(-1); prev.fill(-1);
          var head = 0, tail = 0;
          dist[start] = 0; queue[tail++] = start;
          var last = start;
          while (head < tail) {
            var cur = queue[head++];
            last = cur;
            var gi = list[cur], gc = gi % W, gr = (gi - gc) / W;
            for (var dr = -1; dr <= 1; dr++) {
              for (var dc = -1; dc <= 1; dc++) {
                if (dr === 0 && dc === 0) continue;
                if (gc + dc < 1 || gc + dc > W - 2 || gr + dr < 1 || gr + dr > H - 2) continue;
                var nb = local.get(gi + dr * W + dc);
                if (nb === undefined || dist[nb] >= 0) continue;
                dist[nb] = dist[cur] + 1;
                prev[nb] = cur;
                queue[tail++] = nb;
              }
            }
          }
          return last;
        }
        var far = sweep(0);
        var other = sweep(far);
        // Walk the path back and measure it properly: a diagonal step is
        // root two samples long, not one, and a feature that runs at 45
        // degrees is made almost entirely of them.
        var path = [], length = 0, at = other, prevC = -1, prevR = -1;
        while (at >= 0) {
          var g = list[at], c = g % W, r = (g - c) / W;
          if (prevC >= 0) length += (c !== prevC && r !== prevR) ? Math.SQRT2 : 1;
          path.push(c, r);
          prevC = c; prevR = r;
          at = prev[at];
        }
        return { length: length, path: path };
      }
    }

    // Each group returns its raw per-bin arrays (the histogram, the
    // orientation bins) and the tensor eigenvalues behind its summary
    // numbers, not only the
    // summaries - the panel plots some of them, and the rest are what makes
    // a summary number checkable against the data it came from rather than
    // having to be taken on trust.
    var index = 0;
    return {
      result: out,
      totalSteps: steps.length,
      get doneSteps() { return index; },
      // Runs exactly one step. Returns true while there is more to do, so
      // the caller's loop reads `while (job.step() && budgetLeft)`.
      step: function () {
        if (index >= steps.length) return false;
        steps[index++]();
        return index < steps.length;
      },
      done: function () { return index >= steps.length; },
    };
  }

  global.FractalStats = {
    createJob: createJob,
    // Exported for the regression page, which checks them directly against
    // closed-form answers - see the fractal-stats tests in physics-tests.js.
    delta: delta,
    circularSpreadFromCounts: circularSpreadFromCounts,
    quantileFromCounts: quantileFromCounts,
    QUANTILE_BUCKETS: QUANTILE_BUCKETS,
  };
})(window);
