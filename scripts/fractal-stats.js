// CPAL-1.0 License. See chaosaccelerator.com/license.html

// ---- Global Stats: the analysis math ----
// Pure number crunching over one block of sampled t values, kept DOM-free so
// physics-tests.html can check it against closed-form answers. Conventions:
// values are the colorMap's [0, 1] t; row 0 is the BOTTOM row (gl.readPixels
// order, so angles are screen-oriented: 0 east, 90 north); circular outputs
// (t = 0 is t = 1) take every difference through delta().
(function (global) {
  "use strict";

  var TAU = Math.PI * 2;

  // b - a folded into [-0.5, 0.5] for a circular output: the short way round.
  function delta(a, b, circular) {
    var d = b - a;
    if (!circular) return d;
    if (d > 0.5) return d - 1;
    if (d < -0.5) return d + 1;
    return d;
  }

  // Quantiles come from a 4096-bucket count, not a sort: one interruptible pass, 32KB, within 1/4096.
  var QUANTILE_BUCKETS = 4096;

  function quantileFromCounts(counts, total, q) {
    if (total <= 0) return NaN;
    var target = q * total, cum = 0;
    for (var i = 0; i < counts.length; i++) {
      if (counts[i] > 0 && cum + counts[i] >= target) {
        return (i + (target - cum) / counts[i]) / counts.length;
      }
      cum += counts[i];
    }
    return 1;
  }

  // Smallest arc holding every sample: 1 minus the longest empty run, wrapping round the end.
  function circularSpreadFromCounts(counts) {
    var n = counts.length, occupied = -1, i;
    for (i = 0; i < n; i++) if (counts[i] > 0) { occupied = i; break; }
    if (occupied < 0) return 0;
    var longestGap = 0, gap = 0;
    for (i = 0; i < n * 2; i++) {
      if (counts[i % n] > 0) gap = 0;
      else { gap++; if (gap > longestGap) longestGap = gap; }
    }
    return Math.max(0, 1 - Math.min(longestGap, n) / n);
  }

  // ---- The job: a LIST OF STEPS driven from requestIdleCallback ----
  // (scheduleStatsSlice in fractal-grid.js). Each pass is split by rows
  // (addRowPass) so a step costs about the same at any sample resolution.
  // spec: width, height, t (Float32Array, row-major, row 0 at the BOTTOM),
  // circular, groups { extremes, distribution, orientation, features } (only
  // true ones computed), colSeam / rowSeam (Uint8Array or null: the step to
  // the next column / row crosses an INPUT seam), returnT (t of the Output's
  // starting value, or null).
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

    var valid = null;      // Uint8Array: a NaN pixel (a simulation that blew up) is not a measurement
    var validCount = 0;
    var mean = 0;          // linear mean, or the circular mean for a wrapping output
    var centered = null;   // Float32Array of delta(mean, t): the residual every second-order metric works from

    function xSeam(c) { return colSeam ? colSeam[c] === 1 : false; }
    function ySeam(r) { return rowSeam ? rowSeam[r] === 1 : false; }

    var steps = [];
    var rowsPerStep = Math.max(1, Math.ceil(SAMPLES_PER_STEP / Math.max(1, W)));

    // Splits rows [from, to) into steps of rowsPerStep; finish() runs in the last chunk's step.
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
        // Mardia's circular std in t units; R = 0 (uniform) is genuinely unbounded.
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
        // A wheel has no smallest value, so a wrapping output gets the containing arc, not quantiles.
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

      // Moments of the CENTERED values: for wrapping data, about the circular mean.
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
    // Sobel gradients feed a rose (|grad| binned by EDGE direction, 90 degrees
    // off the gradient, so horizontal stripes pile up at 0) and the structure
    // tensor J = mean [[gx^2, gxgy], [gxgy, gy^2]] (eigenvalues: coherence and
    // dominant direction). Bins span 180 degrees: a line has no head or tail.
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
            var nw = delta(t[i], t[i + W - 1], circular), nn = delta(t[i], t[i + W], circular), ne = delta(t[i], t[i + W + 1], circular);
            var ww = delta(t[i], t[i - 1], circular), ee = delta(t[i], t[i + 1], circular);
            var sw = delta(t[i], t[i - W - 1], circular), ss = delta(t[i], t[i - W], circular), se = delta(t[i], t[i - W + 1], circular);
            var gx = ((ne + 2 * ee + se) - (nw + 2 * ww + sw)) / 8;
            var gy = ((nw + 2 * nn + ne) - (sw + 2 * ss + se)) / 8;
            var mag = Math.sqrt(gx * gx + gy * gy);
            Jxx += gx * gx; Jxy += gx * gy; Jyy += gy * gy; tensorN++;
            if (mag <= 0) continue;
            // atan2(gx, -gy) is the gradient rotated +90: the edge direction, folded into [0, pi).
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
        var tr = jxx + jyy;
        var diff = Math.sqrt((jxx - jyy) * (jxx - jyy) + 4 * jxy * jxy);
        var lambda1 = (tr + diff) / 2, lambda2 = (tr - diff) / 2;
        // Dominant gradient direction +90: the direction the edges run.
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
          // (l1 - l2) / (l1 + l2): 0 when edges point every way, 1 when all one way.
          coherence: tr > 0 ? (lambda1 - lambda2) / tr : 0,
          dominantEdgeDegrees: edgeAngle * 180 / Math.PI,
          lambda1: lambda1,
          lambda2: lambda2,
          samples: tensorN,
        };
      });
    }

    // ---- Features: how many distinct things are in the picture, and what shape ----
    if (groups.features) {
      var scaleSum = 0, scaleN = 0, flatCutoff = 0;
      // Cutoffs are relative to the picture's own slope and curvature; the absolute
      // floor (a dozen float32 bits) keeps a plateau's rounding from reading as grooves.
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
      var RIDGE = 1, VALLEY = 2, EDGE = 3;
      var crest = null;   // Uint8Array: 0 none, RIDGE, VALLEY or EDGE
      // Per-sample Sobel magnitude and direction byte (256 steps round the circle).
      var grad = null, gradDir = null;
      var edgeStrong = null;
      // Coarea: gradient magnitude summed per level IS that level's total contour length.
      var COAREA_BINS = 128;
      var coarea = null, fineCounts = null;
      var SHAPE_RIDGE = 1, SHAPE_VALLEY = 2, SHAPE_SADDLE = 3, SHAPE_FLAT = 4;
      var shapeMask = null;   // Uint8Array: 0 not inspected, else one of the four
      // Ridge-line scratch per profile (E-W, N-S, NE-SW, NW-SE); ALONG is the perpendicular one, DIAG the two at 45 degrees.
      var side0 = new Float64Array(4), side1 = new Float64Array(4), prof = new Float64Array(4);
      var ALONG = [1, 0, 3, 2];
      var DIAG = [[2, 3], [2, 3], [0, 1], [0, 1]];
      var STEP = [1, W, W + 1, W - 1];
      var STEP_LEN2 = [1, 1, 2, 2];
      // Second difference along profile dir two samples out (per unit length squared), or
      // fallback where that runs off the block: a crest between two samples needs the flanks.
      function curvatureWide(dir, i, c, r, fallback) {
        var dc = dir === 0 ? 2 : dir === 1 ? 0 : dir === 2 ? 2 : -2;
        var dr = dir === 0 ? 0 : 2;
        if (c + dc < 0 || c + dc >= W || c - dc < 0 || c - dc >= W || r + dr >= H || r - dr < 0) return fallback;
        var a = i + 2 * STEP[dir], b = i - 2 * STEP[dir];
        if (!valid[a] || !valid[b]) return fallback;
        return (delta(t[i], t[a], circular) + delta(t[i], t[b], circular)) / (4 * STEP_LEN2[dir]);
      }
      // Extreme (sign -1 max, +1 min) of profile dir, strictly on both sides (a tie
      // would make every step's foot a line), and of one of the two 45-degree profiles?
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

            var e = delta(t[i], t[i + 1], circular), w = delta(t[i], t[i - 1], circular);
            var n = delta(t[i], t[i + W], circular), so = delta(t[i], t[i - W], circular);
            var ne = delta(t[i], t[i + W + 1], circular), sw = delta(t[i], t[i - W - 1], circular);
            var nw = delta(t[i], t[i + W - 1], circular), se = delta(t[i], t[i - W + 1], circular);

            var gx = ((ne + 2 * e + se) - (nw + 2 * w + sw)) / 8;
            var gy = ((nw + 2 * n + ne) - (sw + 2 * so + se)) / 8;
            grad[i] = Math.sqrt(gx * gx + gy * gy);
            gradDir[i] = Math.round(Math.atan2(gy, gx) / TAU * 256) & 255;
            var tb = Math.floor(t[i] * COAREA_BINS);
            coarea[tb < 0 ? 0 : (tb >= COAREA_BINS ? COAREA_BINS - 1 : tb)] += grad[i];
            var fb = Math.floor(t[i] * QUANTILE_BUCKETS);
            fineCounts[fb < 0 ? 0 : (fb >= QUANTILE_BUCKETS ? QUANTILE_BUCKETS - 1 : fb)]++;

            // ---- Local shape (the pie): Hessian eigenvalue signs ----
            // Both negative is a ridge/peak, both positive a valley/pit, mixed a saddle.
            var txx = e + w, tyy = n + so;
            var txy = (ne - nw - se + sw) / 4;
            var trH = txx + tyy;
            var rad = Math.sqrt((txx - tyy) * (txx - tyy) + 4 * txy * txy);
            var e1 = (trH + rad) / 2, e2 = (trH - rad) / 2;
            if (Math.abs(e1) < flatCutoff && Math.abs(e2) < flatCutoff) { flats++; shapeMask[i] = SHAPE_FLAT; }
            else if (e1 < 0 && e2 < 0) { ridges++; shapeMask[i] = SHAPE_RIDGE; }
            else if (e1 > 0 && e2 > 0) { valleys++; shapeMask[i] = SHAPE_VALLEY; }
            else { saddles++; shapeMask[i] = SHAPE_SADDLE; }

            // ---- Is this sample ON a ridge line or valley line? ----
            // A local extreme ACROSS the line (the most curved of the four profiles) and roughly level ALONG it.
            side0[0] = e; side1[0] = w; prof[0] = e + w;
            side0[1] = n; side1[1] = so; prof[1] = n + so;
            side0[2] = ne; side1[2] = sw; prof[2] = (ne + sw) / 2;
            side0[3] = nw; side1[3] = se; prof[3] = (nw + se) / 2;
            var lo = prof[0], hi = prof[0], loDir = 0, hiDir = 0, d;
            for (d = 1; d < 4; d++) {
              if (prof[d] < lo) { lo = prof[d]; loDir = d; }
              if (prof[d] > hi) { hi = prof[d]; hiDir = d; }
            }
            // The 45-degree check stops chaotic speckle chaining into false ridges. Across
            // takes the wider curvature (curvatureWide); along stays one-sample on purpose.
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
      // Canny plus a plateau test: the sample is the crest of the step (non-maximum
      // suppression along the gradient), the step over two samples clears
      // EDGE_STEP_FOLLOW with EDGE_STEP_SEED somewhere along the piece, and the outer
      // steps stay small. Thresholds are fractions of the colour range, same at every zoom.
      var EDGE_STEP_SEED = 0.05;
      var EDGE_STEP_FOLLOW = 0.025;
      var EDGE_PLATEAU_RATIO = 0.5;
      // Profile for each 45-degree sector of the gradient direction byte.
      var SECTOR_PROFILE = [0, 2, 1, 3, 0, 2, 1, 3];
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
            // Crest of the step. A discontinuity puts the same gradient on two samples,
            // so a tie is allowed on one side only and the edge stays one sample wide.
            if (!(grad[i] > grad[i + step] && grad[i] >= grad[i - step])) continue;
            var inner = Math.abs(delta(t[i - step], t[i + step], circular));
            if (inner < EDGE_STEP_FOLLOW) continue;
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
      // 8-connected pieces by union-find; a piece's length is its GEODESIC diameter by
      // the double sweep (BFS from any member finds one end, BFS from there the other).
      // Only a few candidates are swept: the longest is among the largest by area or by box.
      var parent = null;      // union-find, indexed by sample; only line samples take part
      var comps = null;       // root -> { size, minC, maxC, minR, maxR, cls, strong }
      // Edge samples join only if their direction bytes agree within this: 21/256 is 30 degrees.
      var EDGE_TURN_MAX = 21;
      function sameWay(a, b) {
        var d = Math.abs(gradDir[a] - gradDir[b]);
        return Math.min(d, 256 - d) <= EDGE_TURN_MAX;
      }
      function joined(i, j, s) {
        return crest[j] === s && (s !== EDGE || sameWay(i, j));
      }
      var candidates = null;  // the few roots worth a double sweep
      var members = null;     // root -> array of sample indices
      var LONGEST_CANDIDATES = 4;

      steps.push(function allocateLabels() {
        if (out.empty || !crest) return;
        parent = new Int32Array(W * H);
      });

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
        var byClass = {};
        byClass[RIDGE] = [];
        byClass[VALLEY] = [];
        byClass[EDGE] = [];
        comps.forEach(function (e, root) {
          // An edge nowhere above the follow threshold is not an edge.
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
        f.longestRidgeDiagonals = best[RIDGE] ? best[RIDGE].length / diagonal : 0;
        f.longestValleyDiagonals = best[VALLEY] ? best[VALLEY].length / diagonal : 0;
        f.longestEdge = best[EDGE];
        f.longestEdgeDiagonals = best[EDGE] ? best[EDGE].length / diagonal : 0;
        parent = null; comps = null; members = null; candidates = null;
        grad = null; gradDir = null; edgeStrong = null;
      });

      // ---- Contours: the level sets ----
      // Marching squares at the levels carrying the most coarea (only they can hold
      // the longest contour), plus the median and return levels. Only OPEN pieces
      // (an end at the border, an invalid sample, a seam or a wrap antipode) compete
      // across levels. Union-find is over CELL EDGES, not cells: a saddle cell holds two pieces.
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

      function lev(tv, v) { return circular ? delta(v, tv, true) : tv - v; }
      // Opposite sides of the level and, on a wheel, not by way of the antipode.
      function crosses(a, b) {
        return (a >= 0) !== (b >= 0) && (!circular || Math.abs(a) + Math.abs(b) < 0.5);
      }
      function frac(a, b) {
        var d = Math.abs(a) + Math.abs(b);
        return d > 0 ? Math.abs(a) / d : 0.5;
      }
      // Edge ids: horizontal (c, r)-(c+1, r) is r*W + c; vertical (c, r)-(c, r+1) is W*H + r*W + c.
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
      // Pairs of crossed edges joined inside cell (c, r), up to two; a saddle pairs by the centre value.
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
        // On a wrapping output k can be 1 or 3: neighbours nearer each other via the
        // antipode have no crossing, so the contour ENDS here; cellLoose holds the unpaired.
        if (k === 2) { cellLoose = 0; return 1; }
        cellLoose = k;
        for (var m = 0; m < k; m++) cellLooseOut[m] = cellPairsOut[m];
        return 0;
      }
      var cellLoose = 0, cellLooseOut = [0, 0, 0];
      // Every contour edge is paired in exactly two cells; one where it is not is an end.
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
      // Not past the border, an invalid sample or a seam: a contour reaching such a
      // cell ENDS there, so the piece is open however far inside the block it is.
      function cellUsable(c, r) {
        if (c < 0 || r < 0 || c >= W - 1 || r >= H - 1) return false;
        var i00 = r * W + c;
        if (!valid[i00] || !valid[i00 + 1] || !valid[i00 + W] || !valid[i00 + W + 1]) return false;
        return !xSeam(c) && !ySeam(r);
      }
      function edgeDangles(e, cell) {
        var cells = edgeCells(e);
        var other = cells[0] === cell ? cells[1] : cells[0];
        return other < 0 || !pairedIn(e, other - ((other / W) | 0) * W, (other / W) | 0);
      }
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
          // pairedIn overwrites cellPairsOut, so the pair is read out before asking.
          if (edgeDangles(e1, cell) || edgeDangles(e2, cell)) cBorder[root] = 1;
          n = cellPairs(c, r, v);
        }
      }
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
        if (pts.length / 2 > CONTOUR_PATH_POINTS_MAX) {
          var stride = Math.ceil(pts.length / 2 / CONTOUR_PATH_POINTS_MAX), thin = [];
          for (var q = 0; q < pts.length; q += 2 * stride) thin.push(pts[q], pts[q + 1]);
          thin.push(pts[pts.length - 2], pts[pts.length - 1]);
          pts = thin;
        }
        return pts;
      }
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
        // undefined: no such level for this Output; null: no contour at it in this view.
        f.medianContour = circular ? undefined : medianContour;
        f.medianContourDiagonals = medianContour ? medianContour.length / diagonal : 0;
        f.returnContour = returnT === null ? undefined : returnContour;
        f.returnContourDiagonals = returnContour ? returnContour.length / diagonal : 0;
        f.returnT = returnT;
      });

      // ---- Watershed: the catchments, and the divides between them ----
      // Steepest descent with path memoisation (each sample walked once); samples
      // draining to one low point are a catchment, and where two meet is a divide.
      // Not for a wrapping Output: "lower" means nothing on a wheel.
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
      function findRoot(a) {
        while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; }
        return a;
      }

      function geodesicDiameter(list) {
        if (!list || list.length === 0) return null;
        var n = list.length;
        var local = new Map();
        for (var i = 0; i < n; i++) local.set(list[i], i);
        var dist = new Int32Array(n), prev = new Int32Array(n), queue = new Int32Array(n);
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
        // A diagonal step is root two long, not one.
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

    var index = 0;
    return {
      result: out,
      totalSteps: steps.length,
      get doneSteps() { return index; },
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
    // Exported for the regression page (fractal-stats tests in physics-tests.js).
    delta: delta,
    circularSpreadFromCounts: circularSpreadFromCounts,
    quantileFromCounts: quantileFromCounts,
    QUANTILE_BUCKETS: QUANTILE_BUCKETS,
  };
})(window);
