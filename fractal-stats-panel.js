// This file is part of Chaos Accelerator, licensed under the Common Public
// Attribution License, Version 1.0 (CPAL-1.0) - see LICENSE in the project
// root, or https://chaosaccelerator.com/license for a hosted copy.

// ---- Global Stats: the panel ----
//
// The floating card under the gear button on the fractal page. It owns the
// section list, the per-section on/off switches, and every chart; it owns
// none of the measuring. fractal-stats.js does the arithmetic and
// fractal-grid.js does the sampling and the scheduling - this file is the
// seam between them, which is why it takes a `host` of callbacks (turn a t
// into a real Output value, into that value's colour, into world
// coordinates) rather than reaching for any of that itself.
//
// Every section starts OFF, and nothing is measured for a section that is
// off: the switches are not a display filter, they are the compute budget.
// Each one is a full extra pass over the sampled view, and the user asked
// for this to be the lowest-priority work on the page - so "off" has to
// mean "not computed," not "computed and hidden."
(function (global) {
  "use strict";

  // Each section is one switch, one explanation, and one renderer. The
  // `key` is what fractal-stats.js's own `groups` flags are named, so
  // enabledGroups() below is a direct copy of whatever is switched on.
  var SECTIONS = [
    {
      key: "extremes",
      title: "Extremes & Range",
      hint: "The highest and lowest Output value anywhere in the current view, where each one is, and how far apart they are.",
    },
    {
      key: "distribution",
      title: "Value Distribution",
      hint: "How the visible Output values are spread across the colour range - the shape of the picture's histogram, and the summary numbers that describe that shape.",
    },
    {
      key: "roughness",
      title: "Gradient & Roughness",
      hint: "How fast the picture changes from one place to the next: the average slope, and three standard measures of how much fine detail there is.",
    },
    {
      key: "orientation",
      title: "Direction of Lines",
      hint: "Which way the sharp lines in this view run. The rose shows how much edge there is pointing in each direction; a long spike means many lines share that heading.",
    },
    {
      key: "spectrum",
      title: "Spatial Scale",
      hint: "Which sizes of feature this view is built from - broad washes, fine grain, or a particular repeating scale.",
    },
    {
      key: "correlation",
      title: "Spatial Correlation",
      hint: "How far one sample's value tells you about its neighbours, and how much of the whole view is explained by a single smooth ramp.",
    },
    {
      key: "features",
      title: "Feature Census",
      hint: "How many distinct peaks and pits there are, and what shape the surface takes around a typical point.",
    },
  ];

  // ---- Number formatting ----
  //
  // Everything on this panel is read at a glance next to other numbers, so
  // these three keep column widths stable rather than each value choosing
  // its own precision.
  function fixed(v, places) {
    if (v === null || v === undefined || !isFinite(v)) return "-";
    return v.toFixed(places === undefined ? 3 : places);
  }
  function percent(v, places) {
    if (v === null || v === undefined || !isFinite(v)) return "-";
    return (v * 100).toFixed(places === undefined ? 1 : places) + "%";
  }
  function compact(v) {
    if (v === null || v === undefined || !isFinite(v)) return "-";
    var a = Math.abs(v);
    if (a !== 0 && (a < 1e-3 || a >= 1e5)) return v.toExponential(2);
    if (a >= 100) return v.toFixed(1);
    if (a >= 1) return v.toFixed(3);
    return v.toFixed(4);
  }
  function degrees(v) {
    if (v === null || v === undefined || !isFinite(v)) return "-";
    return v.toFixed(1) + "°";
  }

  // Which way a line at this angle actually runs, in words - the rose is
  // read far more often as "mostly vertical" than as "mostly 88 degrees."
  function compassFor(deg) {
    var d = ((deg % 180) + 180) % 180;
    if (d < 15 || d >= 165) return "horizontal";
    if (d < 37.5) return "shallow diagonal (up to the right)";
    if (d < 52.5) return "diagonal (up to the right)";
    if (d < 75) return "steep diagonal (up to the right)";
    if (d < 105) return "vertical";
    if (d < 127.5) return "steep diagonal (up to the left)";
    if (d < 142.5) return "diagonal (up to the left)";
    return "shallow diagonal (up to the left)";
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  // One label/value line. `note` becomes the row's tooltip AND, when the
  // caller marks it important, a wrapped line underneath - the numbers on
  // this panel are only worth anything if the reader knows what they mean.
  function row(parent, label, value, note) {
    var r = el("div", "stat-row");
    r.appendChild(el("span", "stat-label", label));
    var v = el("span", "stat-value", value);
    r.appendChild(v);
    if (note) r.title = note;
    parent.appendChild(r);
    return r;
  }
  function note(parent, text) {
    parent.appendChild(el("p", "stat-note", text));
  }

  // ---- Chart plumbing ----
  //
  // Four small canvases, all 2-D, all drawn from scratch on every result -
  // they are at most a few hundred points each, so there is nothing here
  // worth keeping between draws.
  function readPalette() {
    var cs = getComputedStyle(document.documentElement);
    function pick(name, fallback) {
      var v = cs.getPropertyValue(name);
      return v && v.trim() ? v.trim() : fallback;
    }
    return {
      text: pick("--text", "#e6e8ef"),
      dim: pick("--text-dim", "#9399ad"),
      border: pick("--border", "#2c3040"),
      accent: pick("--accent", "#5b8cff"),
      inputBg: pick("--bg-input", "#0f1116"),
    };
  }

  // Matches the backing store to the element's real CSS size at the current
  // device pixel ratio and returns a context already scaled to CSS pixels,
  // so every draw below can work in the units the layout is written in.
  function prepareCanvas(canvas, cssHeight) {
    var width = canvas.parentNode ? canvas.parentNode.clientWidth : 0;
    if (width <= 0) width = 280;
    var dpr = window.devicePixelRatio || 1;
    canvas.style.width = "100%";
    canvas.style.height = cssHeight + "px";
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(cssHeight * dpr));
    var ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, cssHeight);
    return { ctx: ctx, w: width, h: cssHeight };
  }

  function axisLabel(ctx, text, x, y, align, color) {
    ctx.fillStyle = color;
    ctx.font = "10px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
    ctx.textAlign = align || "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(text, x, y);
  }

  // ---- The colour histogram ----
  //
  // X is the colour itself, not a number: each bar is filled with the exact
  // colour the grid paints that bucket's values, so the plot reads as "how
  // much of each colour is on screen" without needing an axis at all. The
  // log switch is there because a fractal's histogram is routinely one
  // spike and a long tail, which on a linear axis is one spike and nothing.
  function drawHistogram(canvas, dist, host, useLog) {
    var p = readPalette();
    var c = prepareCanvas(canvas, 120);
    var ctx = c.ctx;
    var counts = dist.histogram, n = dist.buckets;
    var padBottom = 14, padTop = 4;
    var plotH = c.h - padBottom - padTop;
    var max = 0;
    for (var i = 0; i < n; i++) max = Math.max(max, counts[i]);
    if (max <= 0) return;
    var scale = function (v) {
      if (!useLog) return v / max;
      return Math.log1p(v) / Math.log1p(max);
    };
    var barW = c.w / n;
    for (var b = 0; b < n; b++) {
      var t = (b + 0.5) / n;
      var h = scale(counts[b]) * plotH;
      ctx.fillStyle = host.colorForT(t);
      ctx.fillRect(b * barW, padTop + plotH - h, Math.max(1, barW + 0.5), h);
    }
    ctx.strokeStyle = p.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, padTop + plotH + 0.5);
    ctx.lineTo(c.w, padTop + plotH + 0.5);
    ctx.stroke();
    axisLabel(ctx, host.labelForT(0), 0, c.h - 3, "left", p.dim);
    axisLabel(ctx, host.labelForT(1), c.w, c.h - 3, "right", p.dim);
    axisLabel(ctx, (useLog ? "log " : "") + "count, peak " + max.toLocaleString(), c.w / 2, c.h - 3, "center", p.dim);
  }

  // ---- The orientation rose ----
  //
  // 180 one-degree bins, drawn twice (theta and theta + 180) because a line
  // has no direction, only a heading - the mirrored petal is the same
  // measurement, and drawing it is what makes the plot read as an
  // orientation rose rather than half of one. Screen orientation
  // throughout: right is 0 degrees, up is 90.
  function drawRose(canvas, orient) {
    var p = readPalette();
    var c = prepareCanvas(canvas, 190);
    var ctx = c.ctx;
    var cx = c.w / 2, cy = c.h / 2;
    var radius = Math.min(cx, cy) - 16;
    var bins = orient.bins, n = orient.binCount;

    // Light circular smoothing for display only (the reported peak comes
    // from the raw bins): at one degree per bin the rose of a real fractal
    // is a comb, and the shape is the point.
    var smooth = new Float64Array(n);
    var half = Math.max(1, Math.round(n / 60));
    for (var i = 0; i < n; i++) {
      var sum = 0, count = 0;
      for (var k = -half; k <= half; k++) { sum += bins[(i + k + n) % n]; count++; }
      smooth[i] = sum / count;
    }
    var max = 0;
    for (var m = 0; m < n; m++) max = Math.max(max, smooth[m]);

    ctx.strokeStyle = p.border;
    ctx.lineWidth = 1;
    [0.5, 1].forEach(function (f) {
      ctx.beginPath();
      ctx.arc(cx, cy, radius * f, 0, Math.PI * 2);
      ctx.stroke();
    });
    ctx.beginPath();
    ctx.moveTo(cx - radius, cy); ctx.lineTo(cx + radius, cy);
    ctx.moveTo(cx, cy - radius); ctx.lineTo(cx, cy + radius);
    ctx.stroke();

    if (max > 0) {
      ctx.beginPath();
      for (var s = 0; s <= n * 2; s++) {
        var bin = s % n;
        var ang = (bin + 0.5) * Math.PI / n;   // radians, screen orientation
        if (s >= n) ang += Math.PI;            // the mirrored half
        var r = (smooth[bin] / max) * radius;
        // Canvas y grows downward and the data's does not, hence -sin.
        var x = cx + Math.cos(ang) * r, y = cy - Math.sin(ang) * r;
        if (s === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fillStyle = "rgba(91, 140, 255, 0.28)";
      ctx.fill();
      ctx.strokeStyle = p.accent;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    axisLabel(ctx, "0°", cx + radius + 3, cy + 3, "left", p.dim);
    axisLabel(ctx, "90°", cx, cy - radius - 5, "center", p.dim);
    axisLabel(ctx, "135°", cx - radius * 0.72, cy - radius * 0.72, "right", p.dim);
    axisLabel(ctx, "45°", cx + radius * 0.72, cy - radius * 0.72, "left", p.dim);
  }

  // ---- The radial power spectrum ----
  //
  // Log-log, because that is the axis pair on which a self-similar picture
  // is a straight line - and whether it IS a straight line is most of what
  // this plot is for. The fitted slope is drawn over the data so a reader
  // can see how well it actually fits rather than trusting the one number.
  function drawSpectrum(canvas, spec) {
    var p = readPalette();
    var c = prepareCanvas(canvas, 130);
    var ctx = c.ctx;
    var padL = 6, padR = 6, padB = 14, padT = 6;
    var plotW = c.w - padL - padR, plotH = c.h - padB - padT;
    var power = spec.radialPower, maxK = spec.maxK;
    var minLogP = Infinity, maxLogP = -Infinity, k;
    for (k = 1; k <= maxK; k++) {
      if (power[k] <= 0) continue;
      var lp = Math.log(power[k]);
      if (lp < minLogP) minLogP = lp;
      if (lp > maxLogP) maxLogP = lp;
    }
    if (!isFinite(minLogP) || maxLogP <= minLogP) return;
    var logKMin = Math.log(1), logKMax = Math.log(maxK);
    function px(kk) { return padL + (Math.log(kk) - logKMin) / (logKMax - logKMin) * plotW; }
    function py(pp) { return padT + plotH - (Math.log(pp) - minLogP) / (maxLogP - minLogP) * plotH; }

    ctx.strokeStyle = p.border;
    ctx.lineWidth = 1;
    ctx.strokeRect(padL + 0.5, padT + 0.5, plotW - 1, plotH - 1);

    ctx.beginPath();
    var started = false;
    for (k = 1; k <= maxK; k++) {
      if (power[k] <= 0) continue;
      var x = px(k), y = py(power[k]);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = p.accent;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    if (spec.slope !== null && isFinite(spec.slope)) {
      var kA = spec.fitFrom, kB = spec.fitTo;
      var refLog = Math.log(power[Math.max(1, Math.round((kA + kB) / 2))] || 1);
      var midLogK = Math.log((kA + kB) / 2);
      ctx.beginPath();
      ctx.moveTo(px(kA), py(Math.exp(refLog - spec.slope * (Math.log(kA) - midLogK))));
      ctx.lineTo(px(kB), py(Math.exp(refLog - spec.slope * (Math.log(kB) - midLogK))));
      ctx.strokeStyle = p.dim;
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);
    }

    axisLabel(ctx, "broad", padL, c.h - 3, "left", p.dim);
    axisLabel(ctx, "← feature size →", c.w / 2, c.h - 3, "center", p.dim);
    axisLabel(ctx, "fine", c.w - padR, c.h - 3, "right", p.dim);
  }

  // ---- Correlation against lag ----
  //
  // The 1/e line is drawn because that is where the correlation length is
  // read off, and a number quoted without the curve it came from is very
  // easy to over-trust on a picture whose correlation doesn't decay
  // monotonically at all.
  function drawCorrelation(canvas, corr) {
    var p = readPalette();
    var c = prepareCanvas(canvas, 110);
    var ctx = c.ctx;
    var padL = 6, padR = 6, padB = 14, padT = 6;
    var plotW = c.w - padL - padR, plotH = c.h - padB - padT;
    var curve = corr.curve, maxLag = corr.maxLag;
    var lo = 0, hi = 1, i;
    for (i = 0; i <= maxLag; i++) lo = Math.min(lo, curve[i]);
    function px(l) { return padL + (l / maxLag) * plotW; }
    function py(v) { return padT + plotH - (v - lo) / (hi - lo) * plotH; }

    ctx.strokeStyle = p.border;
    ctx.lineWidth = 1;
    ctx.strokeRect(padL + 0.5, padT + 0.5, plotW - 1, plotH - 1);
    if (lo < 0) {
      ctx.beginPath();
      ctx.moveTo(padL, py(0)); ctx.lineTo(c.w - padR, py(0));
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(padL, py(1 / Math.E)); ctx.lineTo(c.w - padR, py(1 / Math.E));
    ctx.strokeStyle = p.dim;
    ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
    axisLabel(ctx, "1/e", c.w - padR - 2, py(1 / Math.E) - 3, "right", p.dim);

    ctx.beginPath();
    for (i = 0; i <= maxLag; i++) {
      var x = px(i), y = py(curve[i]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = p.accent;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    axisLabel(ctx, "0", padL, c.h - 3, "left", p.dim);
    axisLabel(ctx, "distance between samples →", c.w / 2, c.h - 3, "center", p.dim);
    axisLabel(ctx, maxLag + "", c.w - padR, c.h - 3, "right", p.dim);
  }

  // ---- Section renderers ----
  //
  // Each takes the body element it may fill, that section's slice of the
  // result, and the host (for turning t into values, colours and world
  // coordinates). ctxInfo carries what the numbers need to be expressed in
  // the reader's own units: how big one sample is on screen and in the
  // world, and what the Output property is called.

  function renderExtremes(body, g, host, info) {
    function point(which, label) {
      var e = g[which];
      var world = host.worldAt(e.col, e.row);
      var wrap = el("div", "stat-extreme");
      var head = el("div", "stat-extreme-head");
      var swatch = el("span", "stat-swatch");
      swatch.style.background = host.colorForT(e.t);
      head.appendChild(swatch);
      head.appendChild(el("span", "stat-extreme-title", label));
      head.appendChild(el("span", "stat-extreme-value", host.formatValue(host.valueForT(e.t))));
      wrap.appendChild(head);
      row(wrap, "Position", "X " + world.x.toFixed(5) + ", Y " + world.y.toFixed(5),
        "Where in the fractal's own coordinates this sample sits - the same X/Y the hover readout shows.");
      row(wrap, "Colour", host.colorForT(e.t), "The exact colour the grid paints this sample.");
      row(wrap, "Position on the colour range", percent(e.t), "0% is one end of the rainbow, 100% the other.");
      body.appendChild(wrap);
    }
    point("max", "Maximum");
    point("min", "Minimum");
    row(body, "Range (max − min)", host.formatValue(host.valueForT(g.max.t) - host.valueForT(g.min.t)) +
      "  (" + percent(g.range) + " of the colour range)",
      "How much of the Output's full span this view covers.");
    if (info.circular) {
      note(body, "This Output wraps, so its largest and smallest values are two points on a colour wheel rather than two ends of a line - see the circular spread under Value Distribution for the spread that accounts for that.");
    }
  }

  function renderDistribution(body, g, host, info, state, rerender) {
    var holder = el("div", "stat-chart");
    var canvas = document.createElement("canvas");
    holder.appendChild(canvas);
    body.appendChild(holder);

    var toggleRow = el("div", "stat-chart-actions");
    var logBtn = el("button", "secondary stat-mini-btn", state.histogramLog ? "Linear scale" : "Log scale");
    logBtn.type = "button";
    logBtn.addEventListener("click", function () {
      state.histogramLog = !state.histogramLog;
      rerender();
    });
    toggleRow.appendChild(logBtn);
    body.appendChild(toggleRow);

    note(body, "Every visible sample dropped into " + g.buckets + " colour buckets. The height of a bar is how many pixels on screen carry that colour.");

    if (info.circular) {
      row(body, "Mean (circular)", host.formatValue(host.valueForT(g.mean)),
        "Averaged around the colour wheel, so values either side of the wrap average to the point between them rather than to the opposite side.");
      row(body, "Concentration", fixed(info.resultantLength, 3),
        "0 means the values are spread evenly right round the wheel; 1 means they are all the same.");
      row(body, "Std deviation (circular)", isFinite(info.circularStd) ? percent(info.circularStd) : "unbounded",
        "As a fraction of the full colour range.");
      row(body, "Circular spread", percent(g.circularSpread),
        "The smallest arc of the colour wheel that still contains every visible value.");
    } else {
      row(body, "Mean", host.formatValue(host.valueForT(g.mean)));
      row(body, "Median", host.formatValue(host.valueForT(g.median)));
      row(body, "Std deviation", percent(g.std) + " of range",
        "How far a typical sample sits from the mean, as a fraction of the full colour range.");
      row(body, "Interquartile range", percent(g.iqr) + " of range",
        "The span the middle half of the samples falls in.");
    }
    row(body, "Skewness", fixed(g.skewness, 2),
      "0 is symmetric. Positive means a long tail towards the high end, negative towards the low end.");
    row(body, "Excess kurtosis", fixed(g.kurtosisExcess, 2),
      "0 matches a normal distribution. Positive means values cluster tightly with rare far outliers; negative means they spread out flatly.");
    row(body, "Entropy", fixed(g.entropyBits, 2) + " bits  (" + percent(g.entropyNormalized) + ")",
      "How evenly the colours are used. 100% would mean every bucket is equally occupied - the busiest a view of this many buckets can be.");
    row(body, "Buckets in use", g.occupiedBuckets + " / " + g.buckets,
      "How much of the rainbow appears on screen at all.");
    if (!info.circular && g.quantiles) {
      row(body, "5th / 95th percentile",
        host.formatValue(host.valueForT(g.quantiles.p5)) + "  –  " + host.formatValue(host.valueForT(g.quantiles.p95)),
        "The band 90% of the visible samples fall inside.");
    }

    return function () {
      drawHistogram(canvas, g, host, state.histogramLog);
    };
  }

  function renderRoughness(body, g, host, info) {
    // The measured step is between two SAMPLES, which are coarser than
    // screen pixels - so both figures are given rather than silently
    // reporting one as the other. The per-screen-pixel one is what a reader
    // means by "how fast does the colour change as I move the mouse"; the
    // per-sample one is the number actually measured.
    var perPixel = g.meanGradient * info.screenPixelsPerSampleRecip;
    row(body, "Average slope", percent(perPixel, 2) + " of the colour range per screen pixel",
      "Move one pixel in the steepest direction and the Output moves this far through its colour range, on average.");
    row(body, "  in Output units", host.formatValue(g.meanGradient * info.valuePerT / info.worldPerSample) + " per world unit",
      "The same slope in the Output's own units, per unit of the fractal's own coordinates.");
    row(body, "Steepest step", percent(g.maxGradient, 1) + " of the range between neighbouring samples",
      "The single sharpest jump anywhere in the view.");
    row(body, "Gradient energy", compact(g.gradientEnergy),
      "The mean of the squared slope. Unlike the average slope it is dominated by the sharp places, which is what makes it the usual measure of how busy a picture is.");
    row(body, "Total variation", compact(g.totalVariation) + " per sample",
      "Add up every left-right and up-down change and divide by the sample count. Roughly, how much total contour there is to cross.");
    row(body, "  horizontal / vertical", compact(g.meanAbsDx) + " / " + compact(g.meanAbsDy),
      "The two halves of total variation. A picture of vertical bands puts nearly all of its variation in the horizontal half.");
    row(body, "Laplacian variance", compact(g.laplacianVariance),
      "The classic sharpness measure: high means lots of fine detail, low means broad smooth washes.");
    note(body, "Measured on " + info.sampleWidth + "×" + info.sampleHeight + " samples of the view, one sample every " +
      compact(info.worldPerSample) + " world units (about " + fixed(info.screenPixelsPerSample, 1) +
      " screen pixels). Detail finer than that spacing is not counted - zoom in and these numbers grow.");
  }

  function renderOrientation(body, g, host) {
    var holder = el("div", "stat-chart");
    var canvas = document.createElement("canvas");
    holder.appendChild(canvas);
    body.appendChild(holder);
    note(body, "Each direction's spoke is the total edge strength of every sample whose line runs that way. Right is 0°, up is 90°; the plot is symmetric because a line has a heading, not a direction.");
    row(body, "Dominant direction", degrees(g.dominantEdgeDegrees) + "  (" + compassFor(g.dominantEdgeDegrees) + ")",
      "From the structure tensor over the whole view - the single heading the edges favour on balance.");
    row(body, "Strongest single bin", degrees(g.peakBinDegrees) + "  (" + compassFor(g.peakBinDegrees) + ")",
      "The one-degree bin carrying the most edge. It can differ from the dominant direction when there are two competing families of lines.");
    row(body, "Coherence", fixed(g.coherence, 3) + "  (" + describeCoherence(g.coherence) + ")",
      "0 means edges run every way equally; 1 means every edge in the view shares one heading.");
    row(body, "Samples measured", g.samples.toLocaleString());
    return function () { drawRose(canvas, g); };
  }

  function describeCoherence(v) {
    if (v < 0.1) return "no preferred direction";
    if (v < 0.25) return "a slight lean";
    if (v < 0.5) return "clearly directional";
    if (v < 0.8) return "strongly directional";
    return "almost entirely one direction";
  }

  function describeSlope(beta) {
    if (beta === null || !isFinite(beta)) return "";
    if (beta < 0.5) return "near-white: fine grain at every scale, little large-scale structure";
    if (beta < 1.5) return "pink: detail at every scale, the hallmark of a self-similar picture";
    if (beta < 2.5) return "brown: dominated by broad smooth structure, fine detail falling away fast";
    return "very smooth: almost all of the energy is in large features";
  }

  function renderSpectrum(body, g, host, info) {
    var holder = el("div", "stat-chart");
    var canvas = document.createElement("canvas");
    holder.appendChild(canvas);
    body.appendChild(holder);
    note(body, "How much of the picture is built at each size of feature, on a log-log plot. A straight line here means the view looks equally detailed however far you zoom - the dashed line is the fitted straight one.");
    row(body, "Spectral slope", g.slope === null ? "-" : fixed(g.slope, 2),
      "Power falls off as (feature size) to this power. See the reading below it.");
    if (g.slope !== null) note(body, describeSlope(g.slope) + ".");
    if (g.dominantWavelength) {
      row(body, "Dominant feature size",
        fixed(g.dominantWavelength * info.screenPixelsPerSample, 1) + " screen px  (" +
        compact(g.dominantWavelength * info.worldPerSample) + " world units)",
        "One scale carries noticeably more than the straight-line trend predicts - a repeating structure about this big.");
    } else {
      row(body, "Dominant feature size", "none",
        "No one scale stands out above the trend: the view is built the same way at every size, which is what a self-similar picture looks like.");
    }
    row(body, "Frequency-domain anisotropy", fixed(g.angularAnisotropy, 3) + "  (" + describeCoherence(g.angularAnisotropy) + ")",
      "An independent check on Direction of Lines, measured in the frequency domain rather than from gradients, and on the same 0-to-1 scale as that section's coherence. Each frequency is weighed against others the same distance from the origin, so this describes the spectrum's shape rather than which scales happen to be loudest.");
    if (g.angularAnisotropy >= 0.1) {
      row(body, "  strongest at", degrees(g.angularPeakDegrees) + "  (" + compassFor(g.angularPeakDegrees) + ")",
        "Already rotated to the direction the structure runs, so it should agree with the rose above.");
    }
    note(body, "Measured on the central " + g.size + "×" + g.size + " block of samples, windowed - a square keeps the frequency bins the same size in every direction, which is what makes the anisotropy number above mean anything.");
    return function () { drawSpectrum(canvas, g); };
  }

  function renderCorrelation(body, g, host, info) {
    var holder = el("div", "stat-chart");
    var canvas = document.createElement("canvas");
    holder.appendChild(canvas);
    body.appendChild(holder);
    note(body, "How alike two samples are as they get further apart. A curve that falls away immediately is noise; one that stays high for a long way is made of big smooth regions.");
    if (g.correlationLength === null) {
      row(body, "Correlation length", "over " + g.maxLag + " samples",
        "Still correlated at the furthest distance measured - the structures here are larger than the measured window.");
    } else {
      row(body, "Correlation length",
        fixed(g.correlationLength, 2) + " samples  (" + fixed(g.correlationLength * info.screenPixelsPerSample, 1) + " screen px)",
        "The distance at which two samples stop resembling each other - the typical size of one patch of similar colour.");
    }
    row(body, "Moran's I", fixed(g.moransI, 3) + "  (" + describeMoran(g.moransI) + ")",
      "Clustering of neighbouring samples. Near " + fixed(g.moransExpected, 3) + " would mean no clustering at all; 1 is perfectly smooth; below that baseline is checkerboard-like.");
    if (g.planeR2 !== undefined) {
      row(body, "Flat-ramp fit (R²)", percent(g.planeR2, 1) + "  (" + describeR2(g.planeR2) + ")",
        "How much of the whole view a single straight gradient - one colour ramp across the screen - already explains. The rest is structure.");
    }
    return function () { drawCorrelation(canvas, g); };
  }

  function describeMoran(v) {
    if (v > 0.9) return "very smooth";
    if (v > 0.5) return "strongly clustered";
    if (v > 0.15) return "mildly clustered";
    if (v > -0.05) return "essentially random";
    return "alternating, checkerboard-like";
  }
  function describeR2(v) {
    if (v > 0.9) return "almost entirely a simple ramp";
    if (v > 0.5) return "a ramp with structure on top";
    if (v > 0.15) return "a faint overall trend";
    return "no simple trend - position alone predicts nothing";
  }

  function renderFeatures(body, g, host, info) {
    row(body, "Peaks / pits", g.peaks.toLocaleString() + " / " + g.pits.toLocaleString(),
      "Samples that are strictly higher (or lower) than all eight of their neighbours - one count of how many distinct features are on screen.");
    row(body, "Local extrema", fixed(g.extremaPerThousand, 1) + " per 1,000 samples",
      "The same count, as a density, so it is comparable between views and zoom levels.");
    note(body, "The four figures below classify the surface's shape at every sample, from the signs of its curvature.");
    row(body, "Ridges", percent(g.ridgeFraction, 1), "Curving down in every direction - the crests of the picture.");
    row(body, "Valleys", percent(g.valleyFraction, 1), "Curving up in every direction - the troughs.");
    row(body, "Saddles", percent(g.saddleFraction, 1), "Curving up one way and down another - the passes between two basins. A high share means a tangled, interleaved structure.");
    row(body, "Flat", percent(g.flatFraction, 1), "Curving negligibly compared with how much this view varies overall.");
  }

  var RENDERERS = {
    extremes: renderExtremes,
    distribution: renderDistribution,
    roughness: renderRoughness,
    orientation: renderOrientation,
    spectrum: renderSpectrum,
    correlation: renderCorrelation,
    features: renderFeatures,
  };

  // ---- The panel object ----

  function create(options) {
    var bodyEl = options.body;
    var host = options.host;
    var onEnabledChange = options.onEnabledChange || function () {};

    var enabled = {};       // key -> bool; every section starts off, deliberately
    var sections = {};      // key -> { wrap, body, input }
    var lastResult = null;
    var lastInfo = null;
    var uiState = { histogramLog: false };
    // Chart draws deferred until after the whole body is in the DOM - a
    // canvas measures its parent to size itself, and a parent that hasn't
    // been laid out yet reports zero.
    var pendingDraws = [];

    var statusEl = el("p", "stats-status", "");
    bodyEl.appendChild(statusEl);

    var actions = el("div", "stats-actions");
    var allOn = el("button", "secondary stat-mini-btn", "Turn all on");
    var allOff = el("button", "secondary stat-mini-btn", "Turn all off");
    allOn.type = "button"; allOff.type = "button";
    actions.appendChild(allOn);
    actions.appendChild(allOff);
    bodyEl.appendChild(actions);

    SECTIONS.forEach(function (section) {
      var wrap = el("section", "stats-section");
      var head = el("label", "stats-section-head");
      var sw = el("span", "toggle-switch");
      var input = document.createElement("input");
      input.type = "checkbox";
      input.checked = false;
      sw.appendChild(input);
      sw.appendChild(el("span", "toggle-slider"));
      head.appendChild(el("span", "stats-section-title", section.title));
      head.appendChild(sw);
      wrap.appendChild(head);

      var hint = el("p", "stats-section-hint", section.hint);
      hint.hidden = true;
      wrap.appendChild(hint);

      var body = el("div", "stats-section-body");
      body.hidden = true;
      wrap.appendChild(body);

      input.addEventListener("change", function () {
        enabled[section.key] = input.checked;
        hint.hidden = !input.checked;
        body.hidden = !input.checked;
        // Anything already measured stays on screen; a section only just
        // switched on has nothing yet, and says so until the next run.
        if (input.checked) { renderSection(section.key); flushDraws(); }
        else body.innerHTML = "";
        onEnabledChange();
      });

      sections[section.key] = { wrap: wrap, body: body, hint: hint, input: input };
      bodyEl.appendChild(wrap);
    });

    function setAll(on) {
      var changed = false;
      SECTIONS.forEach(function (section) {
        var s = sections[section.key];
        if (s.input.checked === on) return;
        s.input.checked = on;
        enabled[section.key] = on;
        s.hint.hidden = !on;
        s.body.hidden = !on;
        if (!on) s.body.innerHTML = "";
        changed = true;
      });
      if (!changed) return;
      if (on) {
        SECTIONS.forEach(function (section) { renderSection(section.key); });
        flushDraws();
      }
      onEnabledChange();
    }
    allOn.addEventListener("click", function () { setAll(true); });
    allOff.addEventListener("click", function () { setAll(false); });

    // Declared after the switches that call them: both are function
    // declarations, so they are hoisted to the top of create() and the
    // handlers above close over them fine. Kept down here with the other
    // rendering rather than moved up, since that is what they are.
    function renderSection(key) {
      var s = sections[key];
      if (!s || !s.input.checked) return;
      s.body.innerHTML = "";
      if (!lastResult) {
        s.body.appendChild(el("p", "stat-note", "Nothing measured yet."));
        return;
      }
      var g = lastResult.groups[key];
      if (!g) {
        s.body.appendChild(el("p", "stat-note", "Not in the last measurement - it will appear after the next one."));
        return;
      }
      var draw = RENDERERS[key](s.body, g, host, lastInfo, uiState, function () { renderSection(key); });
      if (typeof draw === "function") pendingDraws.push(draw);
    }

    function flushDraws() {
      var queued = pendingDraws;
      pendingDraws = [];
      queued.forEach(function (fn) {
        try { fn(); } catch (err) { /* a chart that can't measure itself yet simply doesn't draw */ }
      });
    }

    function redrawCharts() {
      SECTIONS.forEach(function (section) {
        if (sections[section.key].input.checked) renderSection(section.key);
      });
      flushDraws();
    }

    return {
      // Exactly the flags fractal-stats.js's createJob wants, so nothing in
      // between has to translate between two lists of section names.
      enabledGroups: function () {
        var g = {};
        SECTIONS.forEach(function (s) { if (enabled[s.key]) g[s.key] = true; });
        return g;
      },
      anyEnabled: function () {
        for (var i = 0; i < SECTIONS.length; i++) if (enabled[SECTIONS[i].key]) return true;
        return false;
      },
      // Is there a switched-on section with nothing to show? Switching one
      // OFF leaves every other section's numbers exactly as valid as they
      // were, so the host asks this rather than re-measuring the whole view
      // every time a switch moves in either direction.
      needsMeasurement: function () {
        for (var i = 0; i < SECTIONS.length; i++) {
          var key = SECTIONS[i].key;
          if (!enabled[key]) continue;
          if (!lastResult || !lastResult.groups[key]) return true;
        }
        return false;
      },
      setStatus: function (text, kind) {
        statusEl.textContent = text;
        statusEl.className = "stats-status" + (kind ? " stats-status-" + kind : "");
      },
      // A fresh measurement: keep it, and redraw every switched-on section
      // against it.
      showResult: function (result, info) {
        lastResult = result;
        lastInfo = info;
        redrawCharts();
      },
      // The view moved. The numbers on screen describe somewhere else now,
      // so they are dimmed rather than cleared - a blank panel mid-pan is
      // worse than a visibly stale one.
      markStale: function () {
        bodyEl.classList.add("stats-stale");
      },
      markFresh: function () {
        bodyEl.classList.remove("stats-stale");
      },
      // A different scene arrived. Not the same thing as a stale view: the
      // numbers are not merely about somewhere else, they are in units the
      // host no longer knows how to format, so they go rather than dim.
      clearResult: function () {
        lastResult = null;
        lastInfo = null;
        bodyEl.classList.remove("stats-stale");
        redrawCharts();
      },
      // The panel's own size changed (it opened, or the window resized), so
      // every canvas needs re-measuring against its parent.
      relayout: function () {
        redrawCharts();
      },
      sections: SECTIONS,
    };
  }

  global.FractalStatsPanel = { create: create, SECTIONS: SECTIONS };
})(window);
