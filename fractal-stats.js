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
// answers, which is the only practical way to know a structure tensor or an
// FFT is right rather than merely plausible.
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
// circle produces no gradient, no false edge in the orientation rose, and
// no spike in the spectrum. Averages of circular data likewise go through
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

  // ---- Fast Fourier transform ----
  //
  // Iterative radix-2 Cooley-Tukey, in place over separate real/imaginary
  // arrays. `n` must be a power of two; the only caller crops to one.
  // Written out rather than pulled from a library for the same reason the
  // rest of this project has no dependencies - it is thirty lines, and a
  // build step would cost more than it saves.
  function fftInPlace(re, im, n) {
    for (var i = 1, j = 0; i < n; i++) {
      var bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        var tr = re[i]; re[i] = re[j]; re[j] = tr;
        var ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
    }
    for (var len = 2; len <= n; len <<= 1) {
      var ang = -TAU / len;
      var wr = Math.cos(ang), wi = Math.sin(ang);
      for (var start = 0; start < n; start += len) {
        var cr = 1, ci = 0;
        for (var k = 0; k < len / 2; k++) {
          var ar = re[start + k], ai = im[start + k];
          var br = re[start + k + len / 2], bi = im[start + k + len / 2];
          var pr = br * cr - bi * ci;
          var pi = br * ci + bi * cr;
          re[start + k] = ar + pr;
          im[start + k] = ai + pi;
          re[start + k + len / 2] = ar - pr;
          im[start + k + len / 2] = ai - pi;
          var ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = ncr;
        }
      }
    }
  }

  // Separable 2-D transform: every row, then every column. Power is
  // accumulated by the caller, so this leaves the spectrum in place.
  function fft2dInPlace(re, im, n) {
    var rowRe = new Float64Array(n), rowIm = new Float64Array(n);
    var i, k, base;
    for (i = 0; i < n; i++) {
      base = i * n;
      for (k = 0; k < n; k++) { rowRe[k] = re[base + k]; rowIm[k] = im[base + k]; }
      fftInPlace(rowRe, rowIm, n);
      for (k = 0; k < n; k++) { re[base + k] = rowRe[k]; im[base + k] = rowIm[k]; }
    }
    for (i = 0; i < n; i++) {
      for (k = 0; k < n; k++) { rowRe[k] = re[k * n + i]; rowIm[k] = im[k * n + i]; }
      fftInPlace(rowRe, rowIm, n);
      for (k = 0; k < n; k++) { re[k * n + i] = rowRe[k]; im[k * n + i] = rowIm[k]; }
    }
  }

  // ---- Small shared helpers ----

  // Largest power of two <= v (and at least 1).
  function floorPow2(v) {
    var p = 1;
    while (p * 2 <= v) p *= 2;
    return p;
  }

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  // Least-squares slope/intercept of y against x, ignoring any non-finite
  // pair. Used for the spectral slope fit, where a zero-power annulus (and
  // so a -Infinity log) is perfectly possible.
  function linearFit(xs, ys) {
    var n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (var i = 0; i < xs.length; i++) {
      if (!isFinite(xs[i]) || !isFinite(ys[i])) continue;
      n++; sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i];
    }
    if (n < 2) return null;
    var den = n * sxx - sx * sx;
    if (Math.abs(den) < 1e-30) return null;
    var slope = (n * sxy - sx * sy) / den;
    return { slope: slope, intercept: (sy - slope * sx) / n, count: n };
  }

  // ---- Order statistics from a fine histogram, not from a sort ----
  //
  // A sorted copy of the samples is the textbook way to take a median, and
  // it is the wrong one here: the caller can now ask for a full-resolution
  // measurement, and sorting several million floats is both a multi-second
  // step that cannot be broken up and a second copy of the whole block in
  // memory. Counting into 4096 buckets is one pass that CAN be broken up
  // (it rides along with the display histogram), needs 32KB whatever the
  // sample count, and pins every quantile to within 1/4096 of the colour
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

  // The smallest arc of the colour wheel containing every sampled value, as
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
  // Global stats are explicitly the lowest-priority work on this page: the
  // user asked for them to wait until the fractal itself is fully rendered
  // and the hover replay is running properly. So the whole analysis is
  // built as a LIST OF STEPS rather than one function - the caller drives
  // it from requestIdleCallback and can stop between any two of them (see
  // scheduleStatsRun in fractal-grid.js).
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
  //   groups         - { extremes, distribution, roughness, orientation,
  //                      spectrum, correlation, features } - only the true
  //                    ones are computed, and each costs nothing when off
  //   colSeam        - Uint8Array(width - 1) or null: colSeam[c] set means
  //                    the step from column c to c+1 crosses an INPUT seam
  //                    (see the host's own findInputSeams) and is not a real
  //                    neighbour comparison
  //   rowSeam        - Uint8Array(height - 1) or null, same for rows

  // Roughly how many samples one step should touch. Every pass below costs
  // about the same per sample, so this is the whole of what keeps a step's
  // cost independent of the sample block - a few milliseconds at the top of
  // the resolution slider just as at the bottom.
  var SAMPLES_PER_STEP = 120000;

  // The transform runs on blocks of this size at most, however large the
  // sample block is. Past 512 the extra frequency bins are finer than the
  // plot can show, while the cost and the memory keep doubling; covering a
  // large block is done by averaging over MANY such blocks instead (see the
  // spectrum section), which costs the same per sample and gives a cleaner
  // spectrum than one enormous transform would.
  var FFT_BLOCK_MAX = 512;

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
    // for the groups that actually need a residual.
    var needsCentered = !!(groups.distribution || groups.correlation);

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

    // ---- Roughness: how fast the picture changes from one sample to the
    // next ----
    //
    // Forward differences, not Sobel: this is measuring the actual step
    // between adjacent samples, and any smoothing would report a gentler
    // picture than the one on screen. (The orientation pass below wants the
    // opposite and uses Sobel for exactly that reason.)
    if (groups.roughness) {
      var sumAbsX = 0, sumAbsY = 0, pairsX = 0, pairsY = 0;
      var sumMag = 0, sumMag2 = 0, magCount = 0, maxMag = 0;
      var sumLap = 0, sumLap2 = 0, lapCount = 0;

      addRowPass(0, H, function accumulateGradient(r0, r1) {
        if (out.empty) return;
        for (var r = r0; r < r1; r++) {
          for (var c = 0; c < W; c++) {
            var i = r * W + c;
            if (!valid[i]) continue;
            var haveX = c + 1 < W && valid[i + 1] && !xSeam(c);
            var haveY = r + 1 < H && valid[i + W] && !ySeam(r);
            var dx = haveX ? delta(t[i], t[i + 1], circular) : 0;
            var dy = haveY ? delta(t[i], t[i + W], circular) : 0;
            if (haveX) { sumAbsX += Math.abs(dx); pairsX++; }
            if (haveY) { sumAbsY += Math.abs(dy); pairsY++; }
            if (haveX && haveY) {
              var mag = Math.sqrt(dx * dx + dy * dy);
              sumMag += mag; sumMag2 += mag * mag; magCount++;
              if (mag > maxMag) maxMag = mag;
            }
          }
        }
      });

      // Five-point Laplacian, every term taken as a wrapped difference FROM
      // THE CENTRE - so it stays seam-free on a circular output in the same
      // way the gradient does.
      addRowPass(1, Math.max(1, H - 1), function accumulateLaplacian(r0, r1) {
        if (out.empty) return;
        for (var r = r0; r < r1; r++) {
          if (ySeam(r - 1) || ySeam(r)) continue;
          for (var c = 1; c < W - 1; c++) {
            if (xSeam(c - 1) || xSeam(c)) continue;
            var i = r * W + c;
            if (!valid[i] || !valid[i - 1] || !valid[i + 1] || !valid[i - W] || !valid[i + W]) continue;
            var lap = delta(t[i], t[i - 1], circular) + delta(t[i], t[i + 1], circular) +
                      delta(t[i], t[i - W], circular) + delta(t[i], t[i + W], circular);
            sumLap += lap; sumLap2 += lap * lap; lapCount++;
          }
        }
      }, function finishRoughness() {
        if (out.empty) return;
        var meanMag = magCount > 0 ? sumMag / magCount : 0;
        var lapMean = lapCount > 0 ? sumLap / lapCount : 0;
        out.groups.roughness = {
          // The headline number: how much of the colour range one sample
          // step moves through, on average.
          meanGradient: meanMag,
          maxGradient: maxMag,
          // Mean of |grad|^2. Weighted towards the sharp places in a way
          // the plain mean isn't, which is what makes it the standard
          // "is this picture busy" measure rather than a second copy of it.
          gradientEnergy: magCount > 0 ? sumMag2 / magCount : 0,
          // Anisotropic total variation, per sample: |dx| + |dy|. Its two
          // halves are reported separately as well, since a picture built
          // of vertical bands has all of its variation in one of them.
          totalVariation: (pairsX > 0 ? sumAbsX / pairsX : 0) + (pairsY > 0 ? sumAbsY / pairsY : 0),
          meanAbsDx: pairsX > 0 ? sumAbsX / pairsX : 0,
          meanAbsDy: pairsY > 0 ? sumAbsY / pairsY : 0,
          // Variance of the Laplacian - the classic focus measure. High
          // means lots of fine detail; low means broad smooth washes.
          laplacianVariance: lapCount > 0 ? sumLap2 / lapCount - lapMean * lapMean : 0,
          comparedPairs: magCount,
        };
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
            // centre, so the Sobel sums below never straddle the seam.
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

    // ---- Spectrum: which spatial scales carry the picture ----
    //
    // Runs on POWER-OF-TWO SQUARE blocks, so the radial frequency bins are
    // isotropic - a rectangle stretched to a square would report a
    // directional bias that is purely an artifact of the stretching, right
    // next to a section whose whole job is measuring directional bias.
    //
    // As many such blocks as fit, tiled over the sample block and their
    // power spectra averaged (Welch's method in two dimensions). One
    // enormous transform would cost the same per sample but need the whole
    // thing in memory at once, and would give a NOISIER spectrum: averaging
    // independent blocks is what trades the frequency resolution nobody can
    // read off a 300-pixel-wide plot for a curve whose shape can actually
    // be trusted.
    //
    // A circular output can't be transformed directly (the mod() seam is a
    // step edge with a spectrum of its own, and it isn't in the picture).
    // cos(2*pi*t) and sin(2*pi*t) are both continuous across that seam, and
    // the sum of their two power spectra is the standard seam-free stand-in.
    if (groups.spectrum) {
      var S = Math.min(FFT_BLOCK_MAX, floorPow2(Math.min(W, H)));
      var tilesX = S >= 8 ? Math.max(1, Math.floor(W / S)) : 0;
      var tilesY = S >= 8 ? Math.max(1, Math.floor(H / S)) : 0;
      var tileCount = tilesX * tilesY;
      var spec = null;

      if (tileCount > 0) {
        steps.push(function spectrumPrepare() {
          if (out.empty) return;
          // Separable Hann window. Without it each block's own four edges
          // are a step discontinuity whose spectrum (a bright cross through
          // the origin) would swamp the picture's.
          var win = new Float64Array(S);
          for (var k = 0; k < S; k++) win[k] = 0.5 - 0.5 * Math.cos(TAU * k / (S - 1));
          spec = {
            win: win,
            power: new Float64Array(S * S),
            re: new Float64Array(S * S),
            im: new Float64Array(S * S),
            // The tiling is centred, so an odd leftover row or column is
            // split between the two edges rather than all falling off one.
            originX: Math.floor((W - tilesX * S) / 2),
            originY: Math.floor((H - tilesY * S) / 2),
            blocks: 0,
          };
        });

        // One step per tile: at S = 512 that is about two million butterfly
        // operations, which is the same order as one of the row passes
        // above and so keeps every step the same size.
        for (var tile = 0; tile < tileCount; tile++) {
          steps.push((function (index) {
            return function spectrumTile() {
              if (!spec || out.empty) return;
              var tx = index % tilesX, ty = (index / tilesX) | 0;
              var c0 = spec.originX + tx * S, r0 = spec.originY + ty * S;
              var channels = circular ? 2 : 1;
              for (var ch = 0; ch < channels; ch++) {
                var re = spec.re, im = spec.im, k, rr, cc, v;
                var sum = 0;
                for (rr = 0; rr < S; rr++) {
                  for (cc = 0; cc < S; cc++) {
                    var src = (r0 + rr) * W + (c0 + cc);
                    v = valid[src] ? t[src] : mean;
                    v = circular ? (ch === 0 ? Math.cos(TAU * v) : Math.sin(TAU * v)) : v;
                    re[rr * S + cc] = v;
                    sum += v;
                  }
                }
                // Remove the mean before windowing: DC carries no shape
                // information and would otherwise sit orders of magnitude
                // above everything the plot is about.
                var avg = sum / (S * S);
                for (rr = 0; rr < S; rr++) {
                  for (cc = 0; cc < S; cc++) {
                    k = rr * S + cc;
                    re[k] = (re[k] - avg) * spec.win[rr] * spec.win[cc];
                    im[k] = 0;
                  }
                }
                fft2dInPlace(re, im, S);
                for (k = 0; k < S * S; k++) spec.power[k] += re[k] * re[k] + im[k] * im[k];
              }
              spec.blocks++;
            };
          })(tile));
        }

        steps.push(function spectrumReduce() {
          if (!spec || out.empty || spec.blocks === 0) return;
          var half = S / 2, maxK = half;
          var radial = new Float64Array(maxK + 1), radialN = new Float64Array(maxK + 1);
          var ry, rx, ky, kx, kr, bin, b;
          for (ry = 0; ry < S; ry++) {
            // Frequencies above Nyquist are the negative ones; fold them.
            ky = ry <= half ? ry : ry - S;
            for (rx = 0; rx < S; rx++) {
              kx = rx <= half ? rx : rx - S;
              if (kx === 0 && ky === 0) continue;
              kr = Math.sqrt(kx * kx + ky * ky);
              bin = Math.round(kr);
              if (bin > maxK) continue;
              radial[bin] += spec.power[ry * S + rx];
              radialN[bin]++;
            }
          }
          var meanPower = new Float64Array(maxK + 1);
          for (b = 0; b <= maxK; b++) meanPower[b] = radialN[b] > 0 ? radial[b] / radialN[b] / spec.blocks : 0;

          // Slope of log(mean power) against log(k), fitted away from both
          // ends: k < 2 is a handful of bins dominated by the window, and
          // the top quarter runs into the block's own Nyquist corner where
          // only the diagonal directions still have any bins at all.
          var loK = 2, hiK = Math.max(loK + 2, Math.floor(maxK * 0.75));
          var xs = [], ys = [];
          for (var f = loK; f <= hiK; f++) {
            if (meanPower[f] <= 0) continue;
            xs.push(Math.log(f)); ys.push(Math.log(meanPower[f]));
          }
          var fit = linearFit(xs, ys);

          // ---- Is there a dominant scale at all? ----
          //
          // Deliberately NOT the frequency carrying the most energy: on a
          // power-law spectrum - which is what a self-similar picture has,
          // and most of these are - that answer is decided entirely by the
          // slope and lands at one end of the axis or the other whatever
          // the picture actually looks like. What makes a scale dominant is
          // sticking OUT of the trend, so this measures each bin's excess
          // over the fitted line and reports the largest, or reports none
          // at all when nothing rises far enough above it.
          var dominantK = null, bestExcess = 0, excesses = null;
          if (fit) {
            excesses = new Float64Array(hiK + 1);
            for (var f2 = loK; f2 <= hiK; f2++) {
              if (meanPower[f2] <= 0) continue;
              excesses[f2] = Math.log(meanPower[f2]) - (fit.intercept + fit.slope * Math.log(f2));
              if (excesses[f2] > bestExcess) bestExcess = excesses[f2];
            }
          }
          // Twice the trend. Below that a "peak" is the ordinary bin-to-bin
          // scatter of a smooth spectrum, not a feature size.
          if (bestExcess >= Math.LN2) {
            // The peak of the LOWEST run of bins that stands out - not the
            // tallest peak anywhere.
            //
            // Lowest run, because anything periodic puts harmonics at 2x,
            // 3x, ... its own frequency, and against a steep fitted line a
            // harmonic can easily stand further above the trend than the
            // fundamental that produced it; the feature a reader can
            // actually see is the fundamental, always the lowest of the
            // family. Peak WITHIN the run, because the Hann window spreads
            // every real peak across its two neighbouring bins, so the
            // first bin over the threshold is routinely one short of the
            // real one.
            var cutoff = Math.max(Math.LN2, 0.6 * bestExcess);
            for (var f3 = loK; f3 <= hiK; f3++) {
              if (excesses[f3] < cutoff) continue;
              dominantK = f3;
              for (var f4 = f3 + 1; f4 <= hiK && excesses[f4] >= cutoff; f4++) {
                if (excesses[f4] > excesses[dominantK]) dominantK = f4;
              }
              break;
            }
          }

          // ---- Directionality, measured in the frequency domain ----
          //
          // Each cell is divided by the mean power of its own radial ring
          // before being binned by angle, so this describes the SHAPE of
          // the spectrum rather than its radial falloff. Without that
          // division the handful of cells nearest the origin - which on a
          // steep spectrum outweigh everything else by orders of magnitude,
          // and which fall into whichever few angle bins they happen to
          // fall into - would set the answer on their own.
          var ANG_BINS = 72;
          var angular = new Float64Array(ANG_BINS);
          var wSum = 0, wCos = 0, wSin = 0;
          for (ry = 0; ry < S; ry++) {
            ky = ry <= half ? ry : ry - S;
            for (rx = 0; rx < S; rx++) {
              kx = rx <= half ? rx : rx - S;
              if (kx === 0 && ky === 0) continue;
              kr = Math.sqrt(kx * kx + ky * ky);
              bin = Math.round(kr);
              if (bin < loK || bin > hiK || meanPower[bin] <= 0) continue;
              var w = spec.power[ry * S + rx] / spec.blocks / meanPower[bin];
              // The structure a frequency describes runs PERPENDICULAR to
              // that frequency's own direction, so this is rotated 90
              // degrees to match the orientation rose above and share its
              // reading.
              var ang = Math.atan2(kx, -ky);
              if (ang < 0) ang += Math.PI;
              if (ang >= Math.PI) ang -= Math.PI;
              var ab = Math.floor(ang * ANG_BINS / Math.PI);
              if (ab >= ANG_BINS) ab = ANG_BINS - 1;
              angular[ab] += w;
              // Doubled angle, because an orientation repeats every 180
              // degrees - the same trick the circular mean uses, one octave
              // up.
              wSum += w;
              wCos += w * Math.cos(2 * ang);
              wSin += w * Math.sin(2 * ang);
            }
          }
          var anisotropy = wSum > 0 ? Math.sqrt(wCos * wCos + wSin * wSin) / wSum : 0;
          var peakAngle = 0.5 * Math.atan2(wSin, wCos);
          if (peakAngle < 0) peakAngle += Math.PI;

          out.groups.spectrum = {
            size: S,
            blocks: spec.blocks,
            radialPower: meanPower,
            maxK: maxK,
            slope: fit ? -fit.slope : null,      // P ~ k^-slope
            fitFrom: loK, fitTo: hiK,
            dominantK: dominantK,
            // In samples. The caller turns this into screen pixels and
            // world units, which are the two forms a reader can act on.
            // null means the spectrum is a smooth power law with no one
            // scale standing out - which is itself the interesting answer.
            dominantWavelength: dominantK ? S / dominantK : null,
            dominantExcess: bestExcess,
            angularPower: angular,
            angularBins: ANG_BINS,
            angularPeakDegrees: peakAngle * 180 / Math.PI,
            // Comparable with the orientation section's coherence: same
            // [0, 1] scale, same meaning, measured a completely different
            // way.
            angularAnisotropy: anisotropy,
          };
          spec = null;
        });
      }
    }

    // ---- Correlation: how far one sample's value reaches ----
    if (groups.correlation) {
      // How far out to measure. Fixed at 32 samples this used to mean 32
      // screen pixels at the old sample resolution and rather less than
      // that at a finer one, so the range it covers now scales with the
      // block - a correlation length is only meaningful against a distance
      // the reader can see.
      var lags = clamp(spec.maxLag || Math.round(Math.min(W, H) / 5), 8, 64);
      lags = Math.max(1, Math.min(lags, Math.floor(Math.min(W, H) / 2) - 1));
      var corr = new Float64Array(lags + 1);
      // Running seam totals, so "is there a seam anywhere between column c
      // and column c + h" is one subtraction rather than a scan - which is
      // what keeps a lag pass linear instead of quadratic.
      var colSeamPrefix = null, rowSeamPrefix = null;
      // Every lag walks the block again, so at a high sample resolution the
      // lags together would cost more than everything else here put
      // together. They don't need to: a correlation is an average, and
      // scanning every Nth line rather than every line changes only how
      // many pairs it is averaged over - which stays in the hundreds of
      // thousands even at the coarsest stride this picks.
      var scanLines = clamp(Math.floor(SAMPLES_PER_STEP / Math.max(1, W + H)), 8, Math.min(W, H));
      var rowStep = Math.max(1, Math.floor(H / scanLines));
      var colStep = Math.max(1, Math.floor(W / scanLines));

      steps.push(function correlationPrepare() {
        if (out.empty) return;
        corr[0] = 1;
        colSeamPrefix = new Int32Array(W);
        for (var c = 1; c < W; c++) colSeamPrefix[c] = colSeamPrefix[c - 1] + (xSeam(c - 1) ? 1 : 0);
        rowSeamPrefix = new Int32Array(H);
        for (var r = 1; r < H; r++) rowSeamPrefix[r] = rowSeamPrefix[r - 1] + (ySeam(r - 1) ? 1 : 0);
      });

      for (var lag = 1; lag <= lags; lag++) {
        steps.push((function (h) {
          return function correlationLag() {
            if (out.empty) return;
            var num = 0, den = 0, n = 0;
            var c, r, i, j;
            for (r = 0; r < H; r += rowStep) {
              for (c = 0; c + h < W; c++) {
                if (colSeamPrefix[c + h] !== colSeamPrefix[c]) continue;
                i = r * W + c; j = i + h;
                if (!valid[i] || !valid[j]) continue;
                num += centered[i] * centered[j];
                den += centered[i] * centered[i] + centered[j] * centered[j];
                n += 2;
              }
            }
            for (c = 0; c < W; c += colStep) {
              for (r = 0; r + h < H; r++) {
                if (rowSeamPrefix[r + h] !== rowSeamPrefix[r]) continue;
                i = r * W + c; j = i + h * W;
                if (!valid[i] || !valid[j]) continue;
                num += centered[i] * centered[j];
                den += centered[i] * centered[i] + centered[j] * centered[j];
                n += 2;
              }
            }
            // Normalised by the variance of the pairs actually compared
            // (both halves of each pair), not by the whole block's - the
            // usual correction that keeps a lag correlation inside [-1, 1]
            // when the compared subset isn't the full picture.
            corr[h] = n > 0 && den > 0 ? 2 * num / den : 0;
          };
        })(lag));
      }

      // Moran's I over rook neighbours: lag 1 read as a clustering
      // statistic. ~1 is smooth patches, ~0 is noise, negative is a
      // checkerboard. Its own no-clustering baseline is -1/(n-1), which is
      // reported alongside rather than folded in.
      var moranNum = 0, moranDen = 0, moranW = 0;
      addRowPass(0, H, function accumulateMoran(r0, r1) {
        if (out.empty) return;
        for (var r = r0; r < r1; r++) {
          for (var c = 0; c < W; c++) {
            var i = r * W + c;
            if (!valid[i]) continue;
            moranDen += centered[i] * centered[i];
            if (c + 1 < W && !xSeam(c) && valid[i + 1]) { moranNum += 2 * centered[i] * centered[i + 1]; moranW += 2; }
            if (r + 1 < H && !ySeam(r) && valid[i + W]) { moranNum += 2 * centered[i] * centered[i + W]; moranW += 2; }
          }
        }
      }, function finishCorrelation() {
        if (out.empty) return;
        // Correlation length: where the curve first falls to 1/e, linearly
        // interpolated between the two lags that straddle it.
        var THRESHOLD = 1 / Math.E;
        var length = null;
        for (var h = 1; h <= lags; h++) {
          if (corr[h] < THRESHOLD) {
            var prev = corr[h - 1];
            length = prev > corr[h] ? (h - 1) + (prev - THRESHOLD) / (prev - corr[h]) : h;
            break;
          }
        }
        out.groups.correlation = out.groups.correlation || {};
        out.groups.correlation.curve = corr;
        out.groups.correlation.maxLag = lags;
        out.groups.correlation.correlationLength = length;   // in samples; null = still correlated at maxLag
        out.groups.correlation.moransI = moranDen > 0 && moranW > 0 ? (validCount / moranW) * (moranNum / moranDen) : 0;
        out.groups.correlation.moransExpected = validCount > 1 ? -1 / (validCount - 1) : 0;
      });

      // ---- How close is the whole view to one flat ramp? ----
      //
      // Least squares of value against (x, y) over the block. R^2 near 1
      // means the picture is essentially a single smooth gradient with
      // detail on top; near 0 means position alone predicts nothing, which
      // is what a fully developed fractal looks like.
      var pn = 0, psx = 0, psy = 0, psz = 0, psxx = 0, psxy = 0, psyy = 0, psxz = 0, psyz = 0, pszz = 0;
      addRowPass(0, H, function accumulatePlane(r0, r1) {
        if (out.empty) return;
        for (var r = r0; r < r1; r++) {
          for (var c = 0; c < W; c++) {
            var i = r * W + c;
            if (!valid[i]) continue;
            // Normalised to [-1, 1] on the longer axis so the fit is
            // numerically well behaved whatever the block size is.
            var x = (c - (W - 1) / 2) / Math.max(W, H);
            var y = (r - (H - 1) / 2) / Math.max(W, H);
            var z = centered[i];
            pn++; psx += x; psy += y; psz += z;
            psxx += x * x; psxy += x * y; psyy += y * y;
            psxz += x * z; psyz += y * z; pszz += z * z;
          }
        }
      }, function finishPlane() {
        if (out.empty || pn < 3) return;
        var mx = psx / pn, my = psy / pn, mz = psz / pn;
        var cxx = psxx - pn * mx * mx, cxy = psxy - pn * mx * my, cyy = psyy - pn * my * my;
        var cxz = psxz - pn * mx * mz, cyz = psyz - pn * my * mz, czz = pszz - pn * mz * mz;
        var det = cxx * cyy - cxy * cxy;
        var r2 = 0, bx = 0, by = 0;
        if (Math.abs(det) > 1e-30 && czz > 0) {
          bx = (cyy * cxz - cxy * cyz) / det;
          by = (cxx * cyz - cxy * cxz) / det;
          r2 = clamp((bx * cxz + by * cyz) / czz, 0, 1);
        }
        out.groups.correlation = out.groups.correlation || {};
        out.groups.correlation.planeR2 = r2;
        out.groups.correlation.planeSlopeX = bx;
        out.groups.correlation.planeSlopeY = by;
      });
    }

    // ---- Features: how many distinct things are in the picture, and what
    // shape they are ----
    if (groups.features) {
      // Everything below is measured against the picture's own scale, so
      // "flat" means flat relative to how much this view varies at all
      // rather than against some absolute number of colour units.
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

      var peaks = 0, pits = 0, ridges = 0, valleys = 0, saddles = 0, flats = 0, inspected = 0;
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

            // Strict local extremum over all eight neighbours - the count
            // of distinct peaks and pits, which is the simplest honest
            // answer to "how many features are there".
            var isPeak = true, isPit = true;
            for (var dr2 = -1; dr2 <= 1; dr2++) {
              for (var dc2 = -1; dc2 <= 1; dc2++) {
                if (dr2 === 0 && dc2 === 0) continue;
                var d = delta(t[i], t[i + dr2 * W + dc2], circular);
                if (d >= 0) isPeak = false;
                if (d <= 0) isPit = false;
              }
            }
            if (isPeak) peaks++;
            if (isPit) pits++;

            // Discrete Hessian, every term a wrapped offset from the
            // centre. Eigenvalue SIGNS are what classify the local shape:
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
            else if (e1 < 0 && e2 < 0) ridges++;
            else if (e1 > 0 && e2 > 0) valleys++;
            else saddles++;
          }
        }
      }, function finishFeatures() {
        if (out.empty) return;
        out.groups.features = {
          inspected: inspected,
          peaks: peaks,
          pits: pits,
          extremaPerThousand: inspected > 0 ? 1000 * (peaks + pits) / inspected : 0,
          ridgeFraction: inspected > 0 ? ridges / inspected : 0,
          valleyFraction: inspected > 0 ? valleys / inspected : 0,
          saddleFraction: inspected > 0 ? saddles / inspected : 0,
          flatFraction: inspected > 0 ? flats / inspected : 0,
        };
      });
    }

    // Each group returns its raw per-bin arrays (the histogram, the
    // orientation bins, the radial and angular power, the lag curve) and
    // the tensor eigenvalues behind its summary numbers, not only the
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
    fftInPlace: fftInPlace,
    fft2dInPlace: fft2dInPlace,
    delta: delta,
    circularSpreadFromCounts: circularSpreadFromCounts,
    quantileFromCounts: quantileFromCounts,
    linearFit: linearFit,
    floorPow2: floorPow2,
    QUANTILE_BUCKETS: QUANTILE_BUCKETS,
  };
})(window);
