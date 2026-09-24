// This file is part of Chaos Accelerator, licensed under the Common Public
// Attribution License, Version 1.0 (CPAL-1.0): see LICENSE in the project
// root, or https://chaosaccelerator.com/license for a hosted copy.

// ---- Global Stats: the analysis math ----
//
// Everything here is pure number crunching over ONE rectangular block of
// sampled output values: no DOM, no WebGL, no scene. The fractal grid
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
// normalized [0, 1] t the grid's own colorMap takes, so a "range" here is
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
// when `circular` is set, so the seam where mod() happened to cut the
// circle produces no gradient and no false edge in the orientation rose.
// Averages of circular data likewise go through
// the trigonometric moments rather than a plain mean, which would put the
// average of 0.99 and 0.01 at 0.5: the exact opposite side of the wheel
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
  // range: far finer than the two decimal places any of them is shown to.
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
  // a fraction of the whole wheel: the full circle minus its single
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
  // analysis is built as a LIST OF STEPS rather than one function: the
  // caller drives it from requestIdleCallback and can stop between any two
  // of them (see scheduleStatsSlice in fractal-grid.js).
  //
  // Every pass that walks the block is split by ROWS rather than being one
  // step of its own (see addRowPass). That is what lets the sample
  // resolution be a user setting: at the coarse end a pass is one step
  // either way, and at full resolution, where a single pass over several
  // million samples would be a visible frame hitch, however idle the page
  // was when it started, the same pass becomes a few dozen steps of
  // constant size.
  //
  // spec:
  //   width, height  - sample block dimensions
  //   t              - Float32Array(width * height), row-major, row 0 at the BOTTOM
  //   circular       - whether t = 0 and t = 1 are the same value
  //   groups         - { extremes, distribution, orientation, features },
  //                    only the true ones are computed, and each costs
  //                    nothing when off
  //   colSeam        - Uint8Array(width - 1) or null: colSeam[c] set means
  //                    the step from column c to c+1 crosses an INPUT seam
  //                    (see the host's own findInputSeams) and is not a real
  //                    neighbour comparison
  //   rowSeam        - Uint8Array(height - 1) or null, same for rows
  //   returnT        - the t of the Output's STARTING value (the scene as
  //                    authored), or null when the Output has none; the
  //                    features group traces the contour at that level

  // Roughly how many samples one step should touch. Every pass below costs
  // about the same per sample, so this is the whole of what keeps a step's
  // cost independent of the sample block: a few milliseconds at the top of
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
    var returnT = (typeof spec.returnT === "number" && isFinite(spec.returnT)) ? spec.returnT : null;
    var orientationBins = spec.orientationBins || 180;

    var out = {
      width: W, height: H, circular: circular,
      sampleCount: W * H,
      groups: {},
    };

    // Filled by the first passes and read by nearly every one after them.
    var valid = null;      // Uint8Array: a NaN pixel (a simulation that blew up) is not a measurement
    var validCount = 0;
    var mean = 0;          // linear mean, or the circular mean for a wrapping output
    var centered = null;   // Float32Array of delta(mean, t): the residual every second-order metric works from

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
        // carry (log2 of the bucket count), which is the version that
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
        // none, so a wrapping output gets the smallest containing arc
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
      // The same idea for the ridge LINES below, against the picture's own
      // curvature rather than its slope: a crest or trough has to curve at
      // least this much across itself to count as relief at all. Two per
      // cent of the mean second difference is far below any real crest,
      // a smooth band a thousand samples wide still curves a few thousand
      // times more than that at its top, and far above the rounding
      // texture of a float32 plateau, whose one-bit staircases would
      // otherwise read as perfectly straight, axis-aligned grooves running
      // the whole width of a flat region. The absolute floor is for a view
      // that is NOTHING but such a plateau, where two per cent of rounding
      // is still rounding: t is a float32 in [0, 1], so a bit is under 1e-7
      // and LINE_CUTOFF_FLOOR is a dozen of them.
      var LINE_CUTOFF_FLOOR = 1e-6;
      var curveSum = 0, curveN = 0, lineCutoff = LINE_CUTOFF_FLOOR;
      addRowPass(1, Math.max(1, H - 1), function measureScale(r0, r1) {
        if (out.empty) return;
        for (var r = r0; r < r1; r++) {
          for (var c = 1; c < W - 1; c++) {
            var i = r * W + c;
            if (!valid[i] || !valid[i + 1]) continue;
            scaleSum += Math.abs(delta(t[i], t[i + 1], circular));
            scaleN++;
            if (valid[i - 1]) {
              curveSum += Math.abs(delta(t[i], t[i + 1], circular) + delta(t[i], t[i - 1], circular));
              curveN++;
            }
            if (valid[i + W] && valid[i - W]) {
              curveSum += Math.abs(delta(t[i], t[i + W], circular) + delta(t[i], t[i - W], circular));
              curveN++;
            }
          }
        }
      }, function setCutoff() {
        flatCutoff = scaleN > 0 ? (scaleSum / scaleN) * 0.25 : 0;
        lineCutoff = Math.max(LINE_CUTOFF_FLOOR, curveN > 0 ? (curveSum / curveN) * 0.02 : 0);
      });

      var ridges = 0, valleys = 0, saddles = 0, flats = 0, inspected = 0;
      // Which samples lie ON a ridge line, a valley line or an edge, kept
      // rather than counted: the longest-of-each measurements below need
      // to know which samples those were, not how many.
      var RIDGE = 1, VALLEY = 2, EDGE = 3;
      var crest = null;   // Uint8Array: 0 none, RIDGE, VALLEY or EDGE
      // For the edges: the Sobel gradient magnitude at every sample, and
      // its direction as a byte (256 steps round the full circle), both
      // filled by the census pass and read by the edge pass after it.
      var grad = null, gradDir = null;
      // Whether an edge sample's step clears the SEED threshold (below) or
      // only the lower one it may be followed at.
      var edgeStrong = null;
      // For the contours: how much contour length each level carries
      // (the coarea formula: the gradient magnitude summed over the
      // samples at a level IS the total length of that level's contours),
      // and a fine value histogram for the median level.
      var COAREA_BINS = 128;
      var coarea = null, fineCounts = null;
      // And which of the pie's four classes each sample fell in, so the
      // panel can light up every sample of one class on the map when its
      // slice or legend line is hovered.
      var SHAPE_RIDGE = 1, SHAPE_VALLEY = 2, SHAPE_SADDLE = 3, SHAPE_FLAT = 4;
      var shapeMask = null;   // Uint8Array: 0 not inspected, else one of the four
      // Per-sample scratch for the ridge-line test below, allocated once:
      // for each of the four profiles through a sample (E-W, N-S, NE-SW,
      // NW-SE) the wrapped offset to its two neighbours, and its second
      // difference per unit length squared.
      var side0 = new Float64Array(4), side1 = new Float64Array(4), prof = new Float64Array(4);
      // The profile at right angles to each, and the two at 45 degrees.
      var ALONG = [1, 0, 3, 2];
      var DIAG = [[2, 3], [2, 3], [0, 1], [0, 1]];
      // Each profile's step as a sample offset, and its length squared.
      var STEP = [1, W, W + 1, W - 1];
      var STEP_LEN2 = [1, 1, 2, 2];
      // The second difference along profile `dir` through sample i, taken
      // two samples out on each side rather than one, per unit length
      // squared, or the one-sample figure when the wider one runs off the
      // block or onto a sample that isn't valid.
      //
      // Needed because a crest rarely falls on a sample: when it lies
      // between two, the sample nearest it has BOTH across-neighbours
      // nearly as high as itself, and the one-sample second difference
      // there says "barely curved" about the sharpest feature in the view.
      // Two samples out reaches the flanks and gives the crest its true
      // curvature, which is what the level-along-the-ridge test below has
      // to be measured against; without it that test throws out one sample
      // in every place a tilted crest shifts from one column to the next,
      // and the crest comes out as a string of short pieces.
      function curvatureWide(dir, i, c, r, fallback) {
        var dc = dir === 0 ? 2 : dir === 1 ? 0 : dir === 2 ? 2 : -2;
        var dr = dir === 0 ? 0 : 2;
        if (c + dc < 0 || c + dc >= W || c - dc < 0 || c - dc >= W || r + dr >= H || r - dr < 0) return fallback;
        var a = i + 2 * STEP[dir], b = i - 2 * STEP[dir];
        if (!valid[a] || !valid[b]) return fallback;
        return (delta(t[i], t[a], circular) + delta(t[i], t[b], circular)) / (4 * STEP_LEN2[dir]);
      }
      // Is the sample the extreme point (sign = -1 a maximum, +1 a minimum)
      // of profile `dir`, both neighbours strictly on the far side of it,
      // and of at least one of the two profiles 45 degrees off it? Strictly
      // on both sides: allowing a tie on one would make the foot of every
      // step a valley line and its top a ridge line, and a crest that falls
      // exactly between two float32 samples with identical values is rare
      // enough in real data to give up for that.
      function extremeAlong(dir, sign) {
        return side0[dir] * sign > 0 && side1[dir] * sign > 0;
      }
      function crestAcross(dir, sign) {
        return extremeAlong(dir, sign) && (extremeAlong(DIAG[dir][0], sign) || extremeAlong(DIAG[dir][1], sign));
      }
      steps.push(function allocateCrest() {
        if (out.empty) return;
        crest = new Uint8Array(W * H);
        shapeMask = new Uint8Array(W * H);
        grad = new Float32Array(W * H);
        gradDir = new Uint8Array(W * H);
        edgeStrong = new Uint8Array(W * H);
        coarea = new Float64Array(COAREA_BINS);
        fineCounts = new Float64Array(QUANTILE_BUCKETS);
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

            // All eight neighbours as wrapped offsets from the centre, so
            // nothing below straddles a circular Output's seam.
            var e = delta(t[i], t[i + 1], circular), w = delta(t[i], t[i - 1], circular);
            var n = delta(t[i], t[i + W], circular), so = delta(t[i], t[i - W], circular);
            var ne = delta(t[i], t[i + W + 1], circular), sw = delta(t[i], t[i - W - 1], circular);
            var nw = delta(t[i], t[i + W - 1], circular), se = delta(t[i], t[i - W + 1], circular);

            // Sobel gradient, for the edge pass below. Same stencil as the
            // orientation rose's.
            var gx = ((ne + 2 * e + se) - (nw + 2 * w + sw)) / 8;
            var gy = ((nw + 2 * n + ne) - (sw + 2 * so + se)) / 8;
            grad[i] = Math.sqrt(gx * gx + gy * gy);
            gradDir[i] = Math.round(Math.atan2(gy, gx) / TAU * 256) & 255;
            var tb = Math.floor(t[i] * COAREA_BINS);
            coarea[tb < 0 ? 0 : (tb >= COAREA_BINS ? COAREA_BINS - 1 : tb)] += grad[i];
            var fb = Math.floor(t[i] * QUANTILE_BUCKETS);
            fineCounts[fb < 0 ? 0 : (fb >= QUANTILE_BUCKETS ? QUANTILE_BUCKETS - 1 : fb)]++;

            // ---- What shape the surface is here (the pie) ----
            //
            // Discrete Hessian. Eigenvalue SIGNS classify the local shape:
            // both negative curves down every way (a crest or a peak), both
            // positive curves up every way (a trough or a pit), opposite
            // signs is a saddle, the pass where two basins meet.
            var txx = e + w, tyy = n + so;
            var txy = (ne - nw - se + sw) / 4;
            var trH = txx + tyy;
            var rad = Math.sqrt((txx - tyy) * (txx - tyy) + 4 * txy * txy);
            var e1 = (trH + rad) / 2, e2 = (trH - rad) / 2;
            if (Math.abs(e1) < flatCutoff && Math.abs(e2) < flatCutoff) { flats++; shapeMask[i] = SHAPE_FLAT; }
            else if (e1 < 0 && e2 < 0) { ridges++; shapeMask[i] = SHAPE_RIDGE; }
            else if (e1 > 0 && e2 > 0) { valleys++; shapeMask[i] = SHAPE_VALLEY; }
            else { saddles++; shapeMask[i] = SHAPE_SADDLE; }

            // ---- Is this sample ON a ridge line, or a valley line? ----
            //
            // The pie's classes are about area, and a ridge LINE is not an
            // area: the crest of a mountain range is one sample wide however
            // broad its flanks, and only the samples right on it should
            // count. So this is the topographer's definition instead: a
            // sample is on a ridge if, looking ACROSS the ridge, it is the
            // highest point, a local maximum along the direction the
            // surface curves down most steeply, and the surface runs on
            // roughly level ALONG the ridge, which is what tells a crest
            // from an isolated bump.
            //
            // The four profiles through the sample, E-W, N-S and the two
            // diagonals, each get their second difference, per unit length
            // squared so the root-two diagonal steps compare with the axis
            // ones. The most negative profile is the across-ridge one; the
            // profile at right angles to it is the along-ridge one; the two
            // at 45 degrees are the check against speckle below.
            side0[0] = e; side1[0] = w; prof[0] = e + w;
            side0[1] = n; side1[1] = so; prof[1] = n + so;
            side0[2] = ne; side1[2] = sw; prof[2] = (ne + sw) / 2;
            side0[3] = nw; side1[3] = se; prof[3] = (nw + se) / 2;
            var lo = prof[0], hi = prof[0], loDir = 0, hiDir = 0, d;
            for (d = 1; d < 4; d++) {
              if (prof[d] < lo) { lo = prof[d]; loDir = d; }
              if (prof[d] > hi) { hi = prof[d]; hiDir = d; }
            }
            // The 45-degree check is what stops the speckle of a chaotic
            // region reading as ridges: there every other sample is a bump,
            // a bump is a maximum across but rarely also along one of the
            // diagonals, and without the check enough of them touch to chain
            // into a false "ridge" right across the view. A real crest is a
            // maximum along every profile that is not nearly parallel to it,
            // and whichever way it runs at least one of the two 45-degree
            // profiles is at least 67.5 degrees off it.
            //
            // The across curvature is the stronger of the one- and two-
            // sample figures (see curvatureWide), so that the sample nearest
            // a crest that falls between samples is judged by the flanks it
            // actually has. The along curvature stays the one-sample figure:
            // the wider one picks up the slow rise and fall of a real crest
            // (and the height flicker of a thin line drifting between
            // columns) and threw away most of the crest for it.
            var acrossR;
            if (-lo >= lineCutoff && lo < 0 && crestAcross(loDir, -1)) {
              acrossR = Math.max(-lo, -curvatureWide(loDir, i, c, r, lo));
              if (Math.abs(prof[ALONG[loDir]]) <= 0.5 * acrossR) { crest[i] = RIDGE; continue; }
            }
            if (hi >= lineCutoff && hi > 0 && crestAcross(hiDir, 1)) {
              acrossR = Math.max(hi, curvatureWide(hiDir, i, c, r, hi));
              if (Math.abs(prof[ALONG[hiDir]]) <= 0.5 * acrossR) crest[i] = VALLEY;
            }
          }
        }
      }, function finishFeatures() {
        if (out.empty) return;
        out.groups.features = {
          inspected: inspected,
          shapeMask: shapeMask,
          shapeClasses: { ridge: SHAPE_RIDGE, valley: SHAPE_VALLEY, saddle: SHAPE_SADDLE, flat: SHAPE_FLAT },
          ridgeFraction: inspected > 0 ? ridges / inspected : 0,
          valleyFraction: inspected > 0 ? valleys / inspected : 0,
          saddleFraction: inspected > 0 ? saddles / inspected : 0,
          flatFraction: inspected > 0 ? flats / inspected : 0,
        };
      });

      // ---- Edges: where the picture jumps ----
      //
      // A ridge is where the value peaks; an edge is where it STEPS: one
      // colour on this side, another on that, and each side keeping its
      // colour. In these maps that is a basin boundary, and unlike a ridge
      // it stays exactly as sharp however far you zoom in. The definition
      // is Canny's, with one addition:
      //
      //  - the sample is the crest of the step: its gradient is the largest
      //    of the three along the gradient's own direction (non-maximum
      //    suppression, which thins a step to one sample);
      //  - the step is big: the change across it, over the two samples
      //    either side, is at least EDGE_STEP_FOLLOW of the colour range,
      //    and a piece of edge only counts at all if somewhere along it the
      //    step reaches EDGE_STEP_SEED (Canny's two thresholds, so a
      //    boundary that fades for a stretch stays one edge);
      //  - and it is a step, not a spike: the value keeps its new level on
      //    both sides, so the change from one sample out to two is small
      //    next to the change across the middle. This is what tells the
      //    flank of a step from the flank of a one-sample line, whose two
      //    flanks would otherwise be two edges.
      //
      // The second half of telling an edge from the speckle of a chaotic
      // region is in labelPieces: two neighbouring edge samples join the
      // same edge only if their gradients point nearly the same way. Along
      // a real boundary they do; in speckle they point everywhere, and the
      // chains that Canny alone would build across it fall apart.
      //
      // The two step thresholds are fractions of the colour range, not of
      // the picture: a true discontinuity has the same step at every zoom,
      // so a floor in range units means the same thing at every resolution,
      // where anything relative to the picture's own gradients would drown
      // real edges in a speckled view and promote faint ones in a smooth
      // one. Five per cent is comfortably above anything a smooth band does
      // between two samples and well below any boundary a reader would
      // call sharp.
      var EDGE_STEP_SEED = 0.05;
      var EDGE_STEP_FOLLOW = 0.025;
      // How much of the middle step the two outer steps may be, for the
      // shape to count as a step rather than a spike.
      var EDGE_PLATEAU_RATIO = 0.5;
      // Which profile a gradient direction byte snaps to: E-W for the
      // sectors round 0 and 180 degrees, N-S round 90 and 270, and the two
      // diagonals between.
      var SECTOR_PROFILE = [0, 2, 1, 3, 0, 2, 1, 3];
      // Are the samples of profile `dir` through (c, r), `reach` out each
      // way, all inside the block, all valid, and none of the steps between
      // them across an input seam?
      function profileClear(dir, i, c, r, reach) {
        var dc = dir === 0 ? 1 : dir === 1 ? 0 : dir === 2 ? 1 : -1;
        var dr = dir === 0 ? 0 : 1;
        var k;
        for (k = 1; k <= reach; k++) {
          if (c + k * dc < 0 || c + k * dc >= W || c - k * dc < 0 || c - k * dc >= W) return false;
          if (r + k * dr >= H || r - k * dr < 0) return false;
          if (!valid[i + k * STEP[dir]] || !valid[i - k * STEP[dir]]) return false;
        }
        if (dc !== 0) for (k = -reach; k < reach; k++) if (xSeam(Math.min(c + k * Math.abs(dc), c + (k + 1) * Math.abs(dc)))) return false;
        if (dr !== 0) for (k = -reach; k < reach; k++) if (ySeam(r + k)) return false;
        return true;
      }
      addRowPass(1, Math.max(1, H - 1), function findEdges(r0, r1) {
        if (out.empty) return;
        for (var r = r0; r < r1; r++) {
          for (var c = 1; c < W - 1; c++) {
            var i = r * W + c;
            if (crest[i] || !valid[i] || grad[i] <= 0) continue;
            var dir = SECTOR_PROFILE[Math.round(gradDir[i] / 32) & 7];
            var step = STEP[dir];
            if (!profileClear(dir, i, c, r, 1)) continue;
            // The crest of the step: largest gradient of the three along
            // the gradient's own line. A step that falls exactly between
            // two samples, which a discontinuity always does, puts the
            // same gradient on both, so a tie is allowed on the one side
            // only: of two tied samples the forward one is the edge, and
            // the edge stays one sample wide.
            if (!(grad[i] > grad[i + step] && grad[i] >= grad[i - step])) continue;
            var inner = Math.abs(delta(t[i - step], t[i + step], circular));
            if (inner < EDGE_STEP_FOLLOW) continue;
            // A step and not a spike, where there is room to tell.
            if (profileClear(dir, i, c, r, 2)) {
              var outerA = Math.abs(delta(t[i + step], t[i + 2 * step], circular));
              var outerB = Math.abs(delta(t[i - 2 * step], t[i - step], circular));
              if (outerA > EDGE_PLATEAU_RATIO * inner || outerB > EDGE_PLATEAU_RATIO * inner) continue;
            }
            crest[i] = EDGE;
            if (inner >= EDGE_STEP_SEED) edgeStrong[i] = 1;
          }
        }
      });

      // ---- The longest ridge, and the longest valley ----
      //
      // The fractions above say how MUCH of the view curves each way; they
      // say nothing about whether that curvature is organised. A picture
      // can be a third valley by area either as ten thousand unconnected
      // specks or as one canyon running corner to corner, and those are
      // completely different pictures. So: take the ridge-line samples as
      // one set and the valley-line samples as another, find their
      // 8-connected pieces, and measure the longest piece of each end to
      // end, the crest of the range, and the river's own course.
      //
      // "Length" here is the GEODESIC diameter, the distance from one end
      // of the piece to the other along the piece itself, not the straight
      // line between them, which is the honest answer for a feature that
      // curves. The naive way is a depth-first search for the longest chain
      // from every sample of the piece, which is quadratic in the piece;
      // the standard double sweep gets the same answer in two passes:
      // breadth-first from any member reaches one true end, and
      // breadth-first from THAT end reaches the other. Exact on a piece
      // with no loops, and within a sample or two on one that has them.
      //
      // Cost. Labelling is one union-find pass over the block, near linear.
      // The double sweep is quadratic in nothing, it is two passes over
      // ONE piece, but it is only run on a handful of candidate pieces
      // rather than all of them: the longest is always among the largest by
      // area or the largest by bounding box, and taking several of each
      // covers the case where a long thin piece loses on area to a fat
      // round one. Everything else is left unmeasured, which is what keeps
      // this affordable on a multi-megasample block.
      var parent = null;      // union-find, indexed by sample; only line samples take part
      var comps = null;       // root -> { size, minC, maxC, minR, maxR, cls, strong }
      // Two edge samples join the same edge only if their gradients agree
      // to within this many direction bytes: 21 of 256 is 30 degrees.
      var EDGE_TURN_MAX = 21;
      function sameWay(a, b) {
        var d = Math.abs(gradDir[a] - gradDir[b]);
        return Math.min(d, 256 - d) <= EDGE_TURN_MAX;
      }
      // Do neighbouring line samples i and j belong to one line? Same class
      // always; for edges, the same direction of step as well.
      function joined(i, j, s) {
        return crest[j] === s && (s !== EDGE || sameWay(i, j));
      }
      var candidates = null;  // the few roots worth a double sweep
      var members = null;     // root -> array of sample indices
      // How many pieces of each class, by each measure, get measured
      // properly. Four and four is well past the point where the longest
      // has ever not been among them, and each one is cheap.
      var LONGEST_CANDIDATES = 4;

      steps.push(function allocateLabels() {
        if (out.empty || !crest) return;
        parent = new Int32Array(W * H);
      });

      // Union with the four neighbours already walked (left, and the three
      // above), which is all it takes for 8-connectivity when the walk
      // goes in row order, and means a neighbour's own label is always set
      // by the time it is read.
      addRowPass(1, Math.max(1, H - 1), function labelPieces(r0, r1) {
        if (out.empty || !crest || !parent) return;
        for (var r = r0; r < r1; r++) {
          for (var c = 1; c < W - 1; c++) {
            var i = r * W + c, s = crest[i];
            if (!s) continue;
            parent[i] = i;
            if (c > 1 && joined(i, i - 1, s)) unite(i, i - 1);
            if (r > 1) {
              if (joined(i, i - W, s)) unite(i, i - W);
              if (c > 1 && joined(i, i - W - 1, s)) unite(i, i - W - 1);
              if (c < W - 2 && joined(i, i - W + 1, s)) unite(i, i - W + 1);
            }
          }
        }
      });

      addRowPass(1, Math.max(1, H - 1), function measurePieces(r0, r1) {
        if (out.empty || !crest || !parent) return;
        if (!comps) comps = new Map();
        for (var r = r0; r < r1; r++) {
          for (var c = 1; c < W - 1; c++) {
            var i = r * W + c, s = crest[i];
            if (!s) continue;
            var root = findRoot(i);
            var e = comps.get(root);
            if (!e) {
              comps.set(root, { size: 1, minC: c, maxC: c, minR: r, maxR: r, cls: s, strong: edgeStrong[i] === 1 });
            } else {
              e.size++;
              if (c < e.minC) e.minC = c; else if (c > e.maxC) e.maxC = c;
              if (r < e.minR) e.minR = r; else if (r > e.maxR) e.maxR = r;
              if (edgeStrong[i]) e.strong = true;
            }
          }
        }
      }, function choosePieces() {
        if (out.empty || !comps) return;
        // The longest piece is among the biggest by area or the biggest by
        // bounding box: a long thin one can lose the first contest badly
        // and win the second outright, which is exactly the shape this
        // whole measurement is looking for.
        var byClass = {};
        byClass[RIDGE] = [];
        byClass[VALLEY] = [];
        byClass[EDGE] = [];
        comps.forEach(function (e, root) {
          // An edge nowhere steeper than the follow threshold is not an
          // edge, only the faint continuation of one that never came.
          if (e.cls === EDGE && !e.strong) return;
          e.root = root;
          e.span = Math.sqrt((e.maxC - e.minC) * (e.maxC - e.minC) + (e.maxR - e.minR) * (e.maxR - e.minR));
          byClass[e.cls].push(e);
        });
        candidates = [];
        [RIDGE, VALLEY, EDGE].forEach(function (cls) {
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
            if (!crest[i]) continue;
            var list = members.get(findRoot(i));
            if (list) list.push(i);
          }
        }
      }, function sweepPieces() {
        if (out.empty || !out.groups.features) return;
        var best = {};
        best[RIDGE] = null;
        best[VALLEY] = null;
        best[EDGE] = null;
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
        f.longestEdge = best[EDGE];
        f.longestEdgeDiagonals = best[EDGE] ? best[EDGE].length / diagonal : 0;
        // Nothing below needs the labels any more, and they are the largest
        // thing this group allocates.
        parent = null; comps = null; members = null; candidates = null;
        grad = null; gradDir = null; edgeStrong = null;
      });


      // ---- Contours: the level sets, every level considered ----
      //
      // A contour at level v is the exact curve where the picture equals v:
      // no thresholds, no detection, just marching squares. "Every level"
      // is made affordable by the coarea histogram filled in the census:
      // the levels carrying the most total contour length are the only
      // ones where the longest single contour can be, so those few are
      // traced and the rest skipped. Two more levels are traced whatever
      // their length: the median (the one level that splits the view into
      // equal halves) and the Output's starting value (every start that
      // brings the body back exactly to where it began).
      //
      // Only OPEN contours compete across levels: pieces with an end, at
      // the block's border, at a sample that isn't valid, at an input seam,
      // or (on a wrapping Output) at the level's antipode. Closed loops are
      // not reported; the longest of them is routinely a hairpin up one
      // side of a thin band and back down the other, and no measure of them
      // tried here told a real loop from that reliably. The median and
      // return levels report their own longest piece, closed or open. Near
      // a basin boundary the contours pile up along it and inherit its
      // fractal wiggle, so an open contour's length grows with the sampling
      // resolution.
      //
      // Connectivity is by union-find over the CELL EDGES the contour
      // crosses, not over cells: a saddle cell carries two separate pieces
      // of contour, and uniting by cell would weld them into one.
      var CONTOUR_AUTO_LEVELS = 8;
      var contourLevels = [];          // { v, kind: "auto" | "median" | "return" }
      var cParent = null, cLen = null, cBorder = null;   // union-find over edge ids, 2 * W * H of them
      var bestOpen = null, medianContour = null, returnContour = null;
      var EDGE_COUNT = 2 * W * H;

      steps.push(function chooseContourLevels() {
        if (out.empty || !coarea) return;
        var order = [];
        for (var b = 0; b < COAREA_BINS; b++) if (coarea[b] > 0) order.push(b);
        order.sort(function (a, b) { return coarea[b] - coarea[a]; });
        for (var k = 0; k < Math.min(CONTOUR_AUTO_LEVELS, order.length); k++) {
          contourLevels.push({ v: (order[k] + 0.5) / COAREA_BINS, kind: "auto" });
        }
        // A wheel has no median: there is no smallest value to count up from.
        if (!circular && inspected > 0) contourLevels.push({ v: quantileFromCounts(fineCounts, inspected, 0.5), kind: "median" });
        if (returnT !== null && returnT >= 0 && returnT <= 1) contourLevels.push({ v: returnT, kind: "return" });
        coarea = null; fineCounts = null;
      });

      // How far a value sits from the level, signed: the short way round
      // for a wrapping Output, so a contour of a hue never appears at the
      // seam where mod() cut the wheel.
      function lev(tv, v) { return circular ? delta(v, tv, true) : tv - v; }
      // Does the contour cross between two neighbouring samples? Opposite
      // sides of the level, and, on a wheel, not by way of the antipode.
      function crosses(a, b) {
        return (a >= 0) !== (b >= 0) && (!circular || Math.abs(a) + Math.abs(b) < 0.5);
      }
      // Where along the edge from a's sample to b's it crosses, 0..1.
      function frac(a, b) {
        var d = Math.abs(a) + Math.abs(b);
        return d > 0 ? Math.abs(a) / d : 0.5;
      }
      // Edge ids: horizontal edge from (c, r) to (c+1, r) is r*W + c; vertical
      // edge from (c, r) to (c, r+1) is W*H + r*W + c.
      function cFind(e) {
        while (cParent[e] !== e) { cParent[e] = cParent[cParent[e]]; e = cParent[e]; }
        return e;
      }
      function cTouch(e) {
        if (cParent[e] === -1) { cParent[e] = e; cLen[e] = 0; cBorder[e] = 0; }
      }
      function cUnite(a, b) {
        cTouch(a); cTouch(b);
        a = cFind(a); b = cFind(b);
        if (a === b) return a;
        cParent[b] = a;
        cLen[a] += cLen[b];
        cBorder[a] |= cBorder[b];
        return a;
      }
      // The pairs of crossed edges joined inside cell (c, r) at level v,
      // written into `pairs` as up to two [edgeA, edgeB]; returns how many.
      // A cell with all four edges crossed is a saddle, and which way its
      // two pieces pair is decided by the value at the cell's centre.
      var cellPairsOut = [0, 0, 0, 0];
      function cellPairs(c, r, v) {
        var i00 = r * W + c, i10 = i00 + 1, i01 = i00 + W, i11 = i01 + 1;
        if (!valid[i00] || !valid[i10] || !valid[i01] || !valid[i11]) return 0;
        if (xSeam(c) || ySeam(r)) return 0;
        var d00 = lev(t[i00], v), d10 = lev(t[i10], v), d01 = lev(t[i01], v), d11 = lev(t[i11], v);
        var bottom = crosses(d00, d10), top = crosses(d01, d11), left = crosses(d00, d01), right = crosses(d10, d11);
        var eBottom = r * W + c, eTop = (r + 1) * W + c, eLeft = W * H + r * W + c, eRight = W * H + r * W + c + 1;
        var n = (bottom ? 1 : 0) + (top ? 1 : 0) + (left ? 1 : 0) + (right ? 1 : 0);
        if (n < 2) return 0;
        if (n === 4) {
          var centre = (d00 + d10 + d01 + d11) / 4 >= 0;
          if (centre === (d00 >= 0)) {
            cellPairsOut[0] = eBottom; cellPairsOut[1] = eRight; cellPairsOut[2] = eLeft; cellPairsOut[3] = eTop;
          } else {
            cellPairsOut[0] = eBottom; cellPairsOut[1] = eLeft; cellPairsOut[2] = eTop; cellPairsOut[3] = eRight;
          }
          return 2;
        }
        var k = 0;
        if (bottom) cellPairsOut[k++] = eBottom;
        if (top) cellPairsOut[k++] = eTop;
        if (left) cellPairsOut[k++] = eLeft;
        if (right) cellPairsOut[k++] = eRight;
        // On a linear Output the sign changes round a square, so k is 2
        // here. On a WRAPPING one it need not be: two neighbours can sit on
        // opposite sides of the level yet be nearer each other round the
        // far side of the wheel, through the level's antipode, and crosses()
        // rightly reports no crossing there. The contour then ENDS in this
        // cell, at the antipode's own line. cellLoose says how many crossed
        // edges were left unpaired (1 or 3); they are ends.
        if (k === 2) { cellLoose = 0; return 1; }
        cellLoose = k;
        for (var m = 0; m < k; m++) cellLooseOut[m] = cellPairsOut[m];
        return 0;
      }
      var cellLoose = 0, cellLooseOut = [0, 0, 0];
      // Is edge e joined to another inside cell (c, r)? Every edge of a
      // contour is, in exactly two cells; one where it is not is an end of
      // the contour, whether because the cell can't be traced through or
      // because the contour stops there at a wrap antipode.
      function pairedIn(e, c, r) {
        if (!cellUsable(c, r)) return false;
        var n = cellPairs(c, r, levelNow);
        for (var k = 0; k < n; k++) if (cellPairsOut[2 * k] === e || cellPairsOut[2 * k + 1] === e) return true;
        return false;
      }
      var levelNow = 0;   // the level being traced, for pairedIn
      function edgeIsEnd(e) {
        var cells = edgeCells(e);
        var c0 = cells[0], c1 = cells[1];
        if (c0 < 0 || c1 < 0) return true;
        return !pairedIn(e, c0 - ((c0 / W) | 0) * W, (c0 / W) | 0) || !pairedIn(e, c1 - ((c1 / W) | 0) * W, (c1 / W) | 0);
      }
      // Where edge e crosses level v, in sample coordinates.
      var edgePointOut = { x: 0, y: 0 };
      function edgePoint(e, v) {
        if (e < W * H) {
          var r = (e / W) | 0, c = e - r * W;
          var a = lev(t[r * W + c], v), b = lev(t[r * W + c + 1], v);
          edgePointOut.x = c + frac(a, b); edgePointOut.y = r;
        } else {
          var e2 = e - W * H, r2 = (e2 / W) | 0, c2 = e2 - r2 * W;
          var a2 = lev(t[r2 * W + c2], v), b2 = lev(t[r2 * W + c2 + W], v);
          edgePointOut.x = c2; edgePointOut.y = r2 + frac(a2, b2);
        }
        return edgePointOut;
      }
      // The two cells either side of an edge, as r*W + c of their lower-left
      // sample, or -1 where the edge is on the block's border.
      var edgeCellsOut = [-1, -1];
      function edgeCells(e) {
        if (e < W * H) {
          var r = (e / W) | 0, c = e - r * W;
          edgeCellsOut[0] = r > 0 ? (r - 1) * W + c : -1;
          edgeCellsOut[1] = r < H - 1 ? r * W + c : -1;
        } else {
          var e2 = e - W * H, r2 = (e2 / W) | 0, c2 = e2 - r2 * W;
          edgeCellsOut[0] = c2 > 0 ? r2 * W + c2 - 1 : -1;
          edgeCellsOut[1] = c2 < W - 1 ? r2 * W + c2 : -1;
        }
        return edgeCellsOut;
      }
      // Can a contour be traced through cell (c, r) at all? Not past the
      // block's edge, not through a sample that isn't valid, and not across
      // an input seam. A contour that reaches such a cell simply ENDS
      // there, and a piece with an end is open however far from the block's
      // border that end is: without this, a contour cut by a seam would be
      // filed as a loop, walked one way from an arbitrary point, and drawn
      // as an open line.
      function cellUsable(c, r) {
        if (c < 0 || r < 0 || c >= W - 1 || r >= H - 1) return false;
        var i00 = r * W + c;
        if (!valid[i00] || !valid[i00 + 1] || !valid[i00 + W] || !valid[i00 + W + 1]) return false;
        return !xSeam(c) && !ySeam(r);
      }
      // Does edge e, seen from cell `cell` (r*W + c), lead nowhere: is the
      // cell on its other side one it is not paired in?
      function edgeDangles(e, cell) {
        var cells = edgeCells(e);
        var other = cells[0] === cell ? cells[1] : cells[0];
        return other < 0 || !pairedIn(e, other - ((other / W) | 0) * W, (other / W) | 0);
      }
      // One cell's contribution to the level's union-find. The pairs join
      // the union-find with their lengths; an edge that dangles, or is left
      // loose, marks its piece as having an end, i.e. open.
      function contourCell(c, r, v) {
        levelNow = v;
        var n = cellPairs(c, r, v);
        var cell = r * W + c;
        if (n === 0) {
          for (var q = 0; q < cellLoose; q++) { var le = cellLooseOut[q]; cTouch(le); cBorder[cFind(le)] = 1; }
          return;
        }
        for (var k = 0; k < n; k++) {
          var e1 = cellPairsOut[2 * k], e2 = cellPairsOut[2 * k + 1];
          var p1 = edgePoint(e1, v), x1 = p1.x, y1 = p1.y;
          var p2 = edgePoint(e2, v), x2 = p2.x, y2 = p2.y;
          var root = cUnite(e1, e2);
          cLen[root] += Math.sqrt((x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1));
          // pairedIn overwrites cellPairsOut, so the pair's edges are read
          // out before it is asked.
          if (edgeDangles(e1, cell) || edgeDangles(e2, cell)) cBorder[root] = 1;
          n = cellPairs(c, r, v);
        }
      }
      // Follows one contour edge to edge from `start` and returns its
      // points. For an open contour `start` must be one of its ends, so
      // the walk runs one way to the other.
      var CONTOUR_PATH_POINTS_MAX = 6000;
      function walkContour(start, v) {
        var pts = [], e = start, prevCell = -1, guard = 0;
        var p = edgePoint(e, v);
        pts.push(p.x, p.y);
        while (guard++ < EDGE_COUNT) {
          var cells = edgeCells(e);
          var cell = (cells[0] >= 0 && cells[0] !== prevCell) ? cells[0] : ((cells[1] >= 0 && cells[1] !== prevCell) ? cells[1] : -1);
          if (cell < 0) break;
          var cr = (cell / W) | 0, cc = cell - cr * W;
          var n = cellPairs(cc, cr, v), partner = -1;
          for (var k = 0; k < n; k++) {
            if (cellPairsOut[2 * k] === e) { partner = cellPairsOut[2 * k + 1]; break; }
            if (cellPairsOut[2 * k + 1] === e) { partner = cellPairsOut[2 * k]; break; }
          }
          if (partner < 0) break;
          e = partner; prevCell = cell;
          p = edgePoint(e, v);
          pts.push(p.x, p.y);
          if (e === start) break;
        }
        // Thinned for drawing, which is all the path is for.
        if (pts.length / 2 > CONTOUR_PATH_POINTS_MAX) {
          var stride = Math.ceil(pts.length / 2 / CONTOUR_PATH_POINTS_MAX), thin = [];
          for (var q = 0; q < pts.length; q += 2 * stride) thin.push(pts[q], pts[q + 1]);
          thin.push(pts[pts.length - 2], pts[pts.length - 1]);
          pts = thin;
        }
        return pts;
      }
      // An END of the open contour `root`: one of its edges with nothing
      // traceable on one side, where the walk has to start so that it runs
      // the whole way to the other end.
      function endEdgeOf(root, v) {
        levelNow = v;
        for (var e = 0; e < EDGE_COUNT; e++) {
          if (cParent[e] === -1 || cFind(e) !== root) continue;
          if (edgeIsEnd(e)) return e;
        }
        return -1;
      }
      function contourRecord(root, level) {
        var closed = !cBorder[root];
        var start = closed ? root : endEdgeOf(root, level.v);
        var path = start >= 0 ? walkContour(start, level.v) : null;
        return {
          length: cLen[root],
          closed: closed,
          level: level.v,
          path: path,
        };
      }
      // One pass per level slot. The slots are fixed when the job is built
      // (the step list is), and a slot whose level was never chosen does
      // nothing.
      for (var slot = 0; slot < CONTOUR_AUTO_LEVELS + 2; slot++) {
        (function (k) {
          var level = null;
          addRowPass(0, Math.max(0, H - 1), function traceLevel(r0, r1) {
            if (out.empty) return;
            if (r0 === 0) {
              level = k < contourLevels.length ? contourLevels[k] : null;
              if (!level) return;
              if (!cParent) {
                cParent = new Int32Array(EDGE_COUNT);
                cLen = new Float32Array(EDGE_COUNT);
                cBorder = new Uint8Array(EDGE_COUNT);
              }
              cParent.fill(-1);
            }
            if (!level) return;
            for (var r = r0; r < r1; r++) {
              for (var c = 0; c < W - 1; c++) contourCell(c, r, level.v);
            }
          }, function finishLevel() {
            if (out.empty || !level) return;
            var openRoot = -1, openLen = 0;
            for (var e = 0; e < EDGE_COUNT; e++) {
              if (cParent[e] === e && cBorder[e] && cLen[e] > openLen) { openLen = cLen[e]; openRoot = e; }
            }
            var open = openRoot >= 0 && (!bestOpen || openLen > bestOpen.length) ? contourRecord(openRoot, level) : null;
            if (open) bestOpen = open;
            if (level.kind !== "auto") {
              // This level's own longest piece, closed or open, whichever
              // is longer, by LENGTH: recorded even when it is not the
              // overall best. Here the level is the point, not the shape.
              var loopRoot = -1, loopLen = 0;
              for (var e2 = 0; e2 < EDGE_COUNT; e2++) {
                if (cParent[e2] === e2 && !cBorder[e2] && cLen[e2] > loopLen) { loopLen = cLen[e2]; loopRoot = e2; }
              }
              var own = null;
              if (loopRoot >= 0 && loopLen >= openLen) own = contourRecord(loopRoot, level);
              else if (openRoot >= 0) own = open || contourRecord(openRoot, level);
              if (level.kind === "median") medianContour = own;
              else returnContour = own;
            }
            if (k === contourLevels.length - 1 || k === CONTOUR_AUTO_LEVELS + 1) {
              cParent = null; cLen = null; cBorder = null;
            }
          });
        })(slot);
      }

      steps.push(function finishContours() {
        if (out.empty || !out.groups.features) return;
        var f = out.groups.features;
        var diagonal = f.diagonalSamples;
        f.longestOpenContour = bestOpen;
        f.longestOpenContourDiagonals = bestOpen ? bestOpen.length / diagonal : 0;
        // undefined: no such level for this Output; null: the level has no
        // contour in this view.
        f.medianContour = circular ? undefined : medianContour;
        f.medianContourDiagonals = medianContour ? medianContour.length / diagonal : 0;
        f.returnContour = returnT === null ? undefined : returnContour;
        f.returnContourDiagonals = returnContour ? returnContour.length / diagonal : 0;
        f.returnT = returnT;
      });

      // ---- Watershed: the catchments, and the divides between them ----
      //
      // Read the picture as terrain: from every sample, water runs to its
      // lowest neighbour and on down until it reaches a low point it cannot
      // leave. Every sample that ends at the same low point is one
      // catchment, and the samples where two catchments meet are the
      // divides: the complete network of "mountain ranges", where the
      // ridge line above is only the longest single crest. Steepest descent
      // with path memoisation, so every sample is walked once: near linear.
      // Not for a wrapping Output, where "lower" means nothing on a wheel.
      // In a chaotic region every other sample is a low point of its own,
      // and the divides there are honest about it: a mesh.
      var wsLabel = null, wsDivides = null, wsBasins = 0;
      var wsPath = [];
      function lowestNeighbour(i, c, r) {
        var best = -1, bestT = t[i];
        for (var dr = -1; dr <= 1; dr++) {
          var rr = r + dr;
          if (rr < 0 || rr >= H) continue;
          if (dr === -1 && ySeam(r - 1)) continue;
          if (dr === 1 && ySeam(r)) continue;
          for (var dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue;
            var cc = c + dc;
            if (cc < 0 || cc >= W) continue;
            if (dc === -1 && xSeam(c - 1)) continue;
            if (dc === 1 && xSeam(c)) continue;
            var j = rr * W + cc;
            if (valid[j] && t[j] < bestT) { bestT = t[j]; best = j; }
          }
        }
        return best;
      }
      if (!circular) {
        steps.push(function watershedAllocate() {
          if (out.empty) return;
          wsLabel = new Int32Array(W * H);
          wsLabel.fill(-1);
        });
        addRowPass(0, H, function watershedFlow(r0, r1) {
          if (out.empty || !wsLabel) return;
          for (var r = r0; r < r1; r++) {
            for (var c = 0; c < W; c++) {
              var i = r * W + c;
              if (!valid[i] || wsLabel[i] !== -1) continue;
              wsPath.length = 0;
              var cur = i, cc = c, cr = r, label = -1;
              for (;;) {
                if (wsLabel[cur] !== -1) { label = wsLabel[cur]; break; }
                wsPath.push(cur);
                var next = lowestNeighbour(cur, cc, cr);
                if (next < 0) { label = cur; wsBasins++; break; }
                cur = next; cc = cur % W; cr = (cur - cc) / W;
              }
              for (var k = 0; k < wsPath.length; k++) wsLabel[wsPath[k]] = label;
            }
          }
        });
        addRowPass(0, H, function watershedDivides(r0, r1) {
          if (out.empty || !wsLabel) return;
          if (!wsDivides) wsDivides = new Uint8Array(W * H);
          for (var r = r0; r < r1; r++) {
            for (var c = 0; c < W; c++) {
              var i = r * W + c, a = wsLabel[i];
              if (a === -1) continue;
              if (c + 1 < W && wsLabel[i + 1] !== -1 && wsLabel[i + 1] !== a && !xSeam(c)) wsDivides[i] = 1;
              else if (r + 1 < H && wsLabel[i + W] !== -1 && wsLabel[i + W] !== a && !ySeam(r)) wsDivides[i] = 1;
            }
          }
        }, function finishWatershed() {
          if (out.empty) return;
          var f = out.groups.features;
          if (f) f.watershed = { basins: wsBasins, mask: wsDivides };
          wsLabel = null;
        });
      }

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
        // filled and returning the last sample reached, which, from any
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
    // summaries: the panel plots some of them, and the rest are what makes
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
    // closed-form answers: see the fractal-stats tests in physics-tests.js.
    delta: delta,
    circularSpreadFromCounts: circularSpreadFromCounts,
    quantileFromCounts: quantileFromCounts,
    QUANTILE_BUCKETS: QUANTILE_BUCKETS,
  };
})(window);
