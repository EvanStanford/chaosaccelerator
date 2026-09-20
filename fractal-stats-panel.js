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
// into a real Output value, into that value's color, into world
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
      key: "orientation",
      title: "Rose Plot",
      // No hint: the plot is the explanation, and the one line under it
      // says what it is. Anything longer was text in front of a picture.
      defaultOn: true,
    },
    {
      key: "distribution",
      title: "Value Distribution",
    },
    {
      key: "roughness",
      title: "Gradient & Roughness",
      hint: "How fast the picture changes from one place to the next - three standard measures of how much fine detail there is.",
    },
    {
      key: "features",
      title: "Feature Census",
      hint: "How many distinct peaks and pits there are, what shape the surface takes around a typical point, and how far the longest single ridge and valley run.",
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

  // ---- Number lines ----
  //
  // A number on this panel has nothing to read itself against: "gradient
  // energy 0.0008" tells a reader who hasn't memorised the formula nothing
  // at all about whether this view is smooth or busy. So every stat with a
  // SCENE-INDEPENDENT range - one fixed by the maths alone, depending at
  // most on whether the Output wraps, and never on the fractal, the zoom or
  // the sample count - gets a line with both ends named and an arrow where
  // this view falls. Stats without such a range (anything that scales with
  // zoom) stay plain text on purpose: an invented axis reads exactly like a
  // real one and would be worse than no axis at all.
  //
  // Built from DOM and CSS rather than a canvas. Every part is positioned
  // as a percentage of the track, so it reflows with the card at any width
  // and needs no measurement - which also keeps these clear of the deferred
  // pendingDraws dance that the canvases need in order to size themselves.

  // Where `value` sits along the track, 0..1, or null when it can't be
  // placed at all (missing, NaN, an empty view). Clamped rather than
  // dropped: a value past the end is still worth showing, and it shows as
  // an arrow pinned to that end.
  function numberLinePosition(value, opts) {
    if (value === null || value === undefined || !isFinite(value)) return null;
    if (!(opts.max > opts.min)) return null;
    var f;
    if (opts.scale === "log") {
      // A log track's low end is a real number, never zero. A perfectly
      // flat view measures exactly 0 on every one of these stats, which is
      // off the bottom of any log axis - so it pins to the left end, which
      // is precisely where the word "flat" is written.
      if (value <= 0) return 0;
      f = (Math.log(value) - Math.log(opts.min)) / (Math.log(opts.max) - Math.log(opts.min));
    } else if (opts.scale === "sqrt") {
      f = Math.sqrt(Math.max(0, (value - opts.min) / (opts.max - opts.min)));
    } else {
      f = (value - opts.min) / (opts.max - opts.min);
    }
    if (!isFinite(f)) return null;
    return f < 0 ? 0 : (f > 1 ? 1 : f);
  }

  // A label centred on its own tick hangs off the end of the track when
  // that tick is at one of the ends, so the outermost ones anchor to the
  // end they are nearest instead of straddling it.
  function anchorClass(pos) {
    if (pos < 0.15) return "stat-numline-at-lo";
    if (pos > 0.85) return "stat-numline-at-hi";
    return "";
  }

  // Two labels closer together than this (as a fraction of the track) would
  // overlap at the card's narrowest, so the later one keeps its tick mark
  // and its tooltip but loses its written name.
  var NUMBER_LINE_LABEL_GAP = 0.2;

  // One number line. Passing null for `label` makes it a bare track with no row
  // of its own, which is how two related rows (average and steepest) come
  // to share one line.
  //
  // opts: { value | markers, min, max, scale, ticks, endLabels }
  //   markers  - [{ at, label, title, weak }]; `value` is shorthand for one
  //   ticks    - [{ at, label, title }] reference points, named above
  //   endLabels- [low, high]; what the two ends of the track MEAN
  function numberLine(parent, label, valueText, noteText, opts) {
    var owner = parent;
    if (label !== null && label !== undefined) owner = row(parent, label, valueText, noteText);

    var wrap = el("div", "stat-numline");
    if (noteText && owner === parent) wrap.title = noteText;

    // Reference ticks, named above the track. A tick outside the track's
    // own range is dropped rather than clamped: clamping would write a name
    // at a place the scale doesn't actually reach, which is a lie about the
    // axis rather than a rounding of it.
    var marks = el("div", "stat-numline-marks");
    var ticks = opts.ticks || [];
    var placed = [], i, pos, lastLabelled = -1;
    for (i = 0; i < ticks.length; i++) {
      if (ticks[i].at < opts.min || ticks[i].at > opts.max) continue;
      pos = numberLinePosition(ticks[i].at, opts);
      if (pos !== null) placed.push({ pos: pos, tick: ticks[i] });
    }
    placed.sort(function (a, b) { return a.pos - b.pos; });
    for (i = 0; i < placed.length; i++) {
      var labelled = placed[i].pos - lastLabelled >= NUMBER_LINE_LABEL_GAP;
      if (labelled && placed[i].tick.label) {
        var mk = el("span", "stat-numline-mark " + anchorClass(placed[i].pos), placed[i].tick.label);
        mk.style.left = (placed[i].pos * 100).toFixed(2) + "%";
        if (placed[i].tick.title) mk.title = placed[i].tick.title;
        marks.appendChild(mk);
        lastLabelled = placed[i].pos;
      }
    }
    if (marks.firstChild) wrap.appendChild(marks);

    var track = el("div", "stat-numline-track");
    for (i = 0; i < placed.length; i++) {
      var tk = el("span", "stat-numline-tick");
      tk.style.left = (placed[i].pos * 100).toFixed(2) + "%";
      tk.title = placed[i].tick.title || placed[i].tick.label || "";
      track.appendChild(tk);
    }
    wrap.appendChild(track);

    // The arrows, under the track, pointing up at it.
    var markers = opts.markers || (opts.value === undefined ? [] : [{ at: opts.value }]);
    var arrows = el("div", "stat-numline-arrows");
    var anyArrow = false;
    for (i = 0; i < markers.length; i++) {
      pos = numberLinePosition(markers[i].at, opts);
      if (pos === null) continue;   // no data: the track still shows what the range IS
      anyArrow = true;
      var m = el("div", "stat-numline-arrow" + (markers[i].weak ? " stat-numline-arrow-weak" : ""));
      m.style.left = (pos * 100).toFixed(2) + "%";
      if (markers[i].title) m.title = markers[i].title;
      m.appendChild(el("span", "stat-numline-point"));
      if (markers[i].label) m.appendChild(el("span", "stat-numline-arrow-label " + anchorClass(pos), markers[i].label));
      arrows.appendChild(m);
    }
    if (!anyArrow) arrows.appendChild(el("span", "stat-numline-empty", "no data"));
    wrap.appendChild(arrows);

    var ends = el("div", "stat-numline-ends");
    ends.appendChild(el("span", "stat-numline-end", (opts.endLabels && opts.endLabels[0]) || ""));
    ends.appendChild(el("span", "stat-numline-end stat-numline-end-hi", (opts.endLabels && opts.endLabels[1]) || ""));
    wrap.appendChild(ends);

    owner.appendChild(wrap);
    return wrap;
  }

  // ---- What the roughness numbers can possibly be ----
  //
  // Every roughness stat is built out of delta()s of t, so the largest step
  // between two neighbouring samples is the whole of what bounds them: s =
  // 1 for a linear Output (0 next to 1), and s = 0.5 for a circular one,
  // where delta() folds a step into [-0.5, 0.5] and half a turn is as far
  // apart as two hues can be. Every minimum is 0, a flat image.
  //
  // The maxima below are attained by a one-sample checkerboard, which is
  // the busiest picture a sample grid can hold:
  //
  //   meanGradient, maxGradient  sqrt(2)*s   |grad| = sqrt(s^2 + s^2)
  //   gradientEnergy             2*s^2       mean of |grad|^2
  //   totalVariation             2*s         |dx| + |dy|, both maxed
  //   meanAbsDx, meanAbsDy       s each      (one-sample stripes max one)
  //   laplacianVariance          16*s^2      see below
  //
  // Laplacian variance: the five-point Laplacian here is a sum of four
  // delta()s from the centre, so it lies in [-4s, 4s] and Popoviciu's
  // inequality caps its variance at (8s)^2/4 = 16*s^2. That analytic bound
  // is also ATTAINED - a checkerboard sends every term the same way at
  // once, giving lap = +4s and -4s on alternating samples, mean 0 and
  // variance exactly 16*s^2. Verified by exhaustive search over all 2^16
  // periodic 4x4 binary grids (max 16.000000*s^2, argmax the checkerboard)
  // and by hill-climbing 6x6 grids with continuous values, which found
  // nothing above it. So the bound used here is the true maximum, not a
  // loose analytic ceiling.
  function roughnessBounds(circular) {
    var s = circular ? 0.5 : 1;
    return {
      s: s,
      meanGradient: Math.SQRT2 * s,
      gradientEnergy: 2 * s * s,
      totalVariation: 2 * s,
      absDelta: s,
      laplacianVariance: 16 * s * s,
      // Where UNIFORM WHITE NOISE lands on each of these - the far more
      // useful reference than the checkerboard, since it is what "no
      // structure at all" measures rather than what the worst case does.
      // Computed, not guessed. For a circular Output each wrapped
      // difference is exactly uniform on [-0.5, 0.5] and independent of the
      // others, which makes all five closed-form; for a linear one dx and
      // dy share their centre sample and so are correlated, and the mean
      // gradient is the one that has no tidy closed form - 0.51786660 is a
      // Simpson integration of E[sqrt((b-a)^2 + (c-a)^2)] over the unit
      // cube, confirmed by Monte Carlo.
      noiseGradient: circular ? s * (Math.SQRT2 + Math.log(1 + Math.SQRT2)) / 3 : 0.51786660 * s,
      noiseEnergy: circular ? 2 * s * s / 3 : s * s / 3,
      noiseTotalVariation: circular ? s : 2 * s / 3,
      noiseAbsDelta: circular ? s / 2 : s / 3,
      noiseLaplacianVariance: circular ? 4 * s * s / 3 : 5 * s * s / 3,
    };
  }

  // How many decades of log scale a roughness number line covers.
  //
  // Real fractal views sit at a per-cent or two of the checkerboard
  // maximum, so a linear track would pin every arrow to the left edge and
  // show nothing. Four decades puts a typical view near the middle and
  // still reaches white noise (a third to a half of maximum) without
  // crowding the top.
  //
  // The SQUARED stats - gradient energy and Laplacian variance - get eight,
  // for the same reason a squared quantity needs twice the decades to cover
  // the same ground: it keeps a view's arrow in the same place on the
  // energy track as on the gradient track instead of half as far along.
  var NUMBER_LINE_DECADES = 4;
  var NUMBER_LINE_DECADES_SQUARED = 8;
  function logFloor(max, decades) { return max * Math.pow(10, -decades); }

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

  var CHART_FONT = "10px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
  function axisLabel(ctx, text, x, y, align, color) {
    ctx.fillStyle = color;
    ctx.font = CHART_FONT;
    ctx.textAlign = align || "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(text, x, y);
  }

  // ---- The color histogram ----
  //
  // X is the color itself, not a number: each bar is filled with the exact
  // color the grid paints that bucket's values, so the plot reads as "how
  // much of each color is on screen" without needing an axis at all.
  // Linear, always: a log height axis answers a question nobody was asking
  // here, and the switch for it cost a click and a line of chrome on every
  // reading of a plot whose whole job is to be glanced at.
  //
  // Under the bars sit two pointers - where the median falls, and where the
  // mean does. The gap between them IS the shape of the distribution: none
  // at all means symmetric, and a mean pulled away from the median means a
  // tail running that way. That is what the row of moment numbers under
  // this plot used to say, shown instead of tabulated.
  function drawHistogram(canvas, dist, host) {
    var p = readPalette();
    // Room under the axis for a pointer and one line of text - one line,
    // however many pointers there are.
    var padBottom = 28, padTop = 4;
    var c = prepareCanvas(canvas, 132);
    var ctx = c.ctx;
    var counts = dist.histogram, n = dist.buckets;
    var plotH = c.h - padBottom - padTop;
    var max = 0;
    for (var i = 0; i < n; i++) max = Math.max(max, counts[i]);
    if (max <= 0) return;
    var barW = c.w / n;
    for (var b = 0; b < n; b++) {
      var h = (counts[b] / max) * plotH;
      ctx.fillStyle = host.colorForT((b + 0.5) / n);
      ctx.fillRect(b * barW, padTop + plotH - h, Math.max(1, barW + 0.5), h);
    }
    var baseY = padTop + plotH + 0.5;
    ctx.strokeStyle = p.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, baseY);
    ctx.lineTo(c.w, baseY);
    ctx.stroke();

    // White for the median, grey for the mean, in the pointer and in the
    // word alike - which is the whole of the legend this needs.
    var MEDIAN_COLOR = "#ffffff", MEAN_COLOR = "#9399ad";
    var marks = [];
    // A circular Output has no median (there is no smallest value on a
    // wheel to count up from), so it gets the one pointer it can honestly
    // have. Its mean is the circular mean, which is the right place anyway.
    if (dist.median !== undefined && isFinite(dist.median)) {
      marks.push({ t: dist.median, text: "median", color: MEDIAN_COLOR });
    }
    if (dist.mean !== undefined && isFinite(dist.mean)) {
      marks.push({ t: dist.mean, text: "mean", color: MEAN_COLOR });
    }
    if (marks.length === 0) return;

    var k, m;
    for (k = 0; k < marks.length; k++) {
      m = marks[k];
      m.x = Math.min(c.w, Math.max(0, m.t * c.w));
      ctx.fillStyle = m.color;
      ctx.beginPath();
      ctx.moveTo(m.x, baseY + 1);
      ctx.lineTo(m.x - 4.5, baseY + 8);
      ctx.lineTo(m.x + 4.5, baseY + 8);
      ctx.closePath();
      ctx.fill();
    }

    // The words are nudged apart only as far as it takes to stop them
    // touching, and only the words: the POINTERS stay exactly where the
    // data is, so a label that had to move never moves the reading with it.
    ctx.font = CHART_FONT;
    for (k = 0; k < marks.length; k++) {
      marks[k].w = ctx.measureText(marks[k].text).width;
      marks[k].lx = marks[k].x;
    }
    if (marks.length === 2) {
      var left = marks[0].x <= marks[1].x ? marks[0] : marks[1];
      var right = left === marks[0] ? marks[1] : marks[0];
      var need = (left.w + right.w) / 2 + 8;
      var gap = right.lx - left.lx;
      if (gap < need) {
        var push = (need - gap) / 2;
        left.lx -= push;
        right.lx += push;
      }
    }
    for (k = 0; k < marks.length; k++) {
      m = marks[k];
      axisLabel(ctx, m.text, Math.min(c.w - m.w / 2, Math.max(m.w / 2, m.lx)), c.h - 3, "center", m.color);
    }
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
    // Wider margin than the plot itself needs: the degree labels ring the
    // circle now, so the gap has to hold one at every heading.
    var radius = Math.min(cx, cy) - 22;
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
    // Spokes every 45 degrees rather than a plain cross: they are what the
    // labels below are attached to, and a diagonal lobe is far easier to
    // read against a line than against empty space.
    ctx.beginPath();
    for (var d = 0; d < 180; d += 45) {
      var sa = d * Math.PI / 180;
      ctx.moveTo(cx - Math.cos(sa) * radius, cy + Math.sin(sa) * radius);
      ctx.lineTo(cx + Math.cos(sa) * radius, cy - Math.sin(sa) * radius);
    }
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

    // All eight headings, not the four the symmetry strictly needs: the
    // plot is mirrored, but someone reading a lobe in the lower half should
    // not have to add 180 in their head to name what they are looking at.
    for (var deg = 0; deg < 360; deg += 45) {
      var la = deg * Math.PI / 180;
      axisLabel(ctx, deg + "°",
        cx + Math.cos(la) * (radius + 12),
        cy - Math.sin(la) * (radius + 12) + 3, "center", p.dim);
    }
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
  // result, and the host (for turning t into values, colors and world
  // coordinates). ctxInfo carries what the numbers need to be expressed in
  // the reader's own units: how big one sample is on screen and in the
  // world, and what the Output property is called.

  function renderDistribution(body, g, host) {
    var holder = el("div", "stat-chart");
    var canvas = document.createElement("canvas");
    holder.appendChild(canvas);
    body.appendChild(holder);
    // No numbers under it on purpose: the picture already says where the
    // colors are, and the two pointers say what the moments used to.
    return function () { drawHistogram(canvas, g, host); };
  }

  function renderRoughness(body, g, host, info) {
    // The ends every number line below is drawn against depend only on
    // whether the Output wraps - see roughnessBounds for where each one
    // comes from.
    var b = roughnessBounds(info.circular);
    // The gentlest picture that still uses the whole colour range: one
    // straight ramp from end to end of the view. Unlike the two ends of
    // these lines it does depend on the sample count, which is why it is a
    // reference TICK and not an end of the axis - but it is the one place
    // on the line a reader can recognise by eye, so it earns its place.
    var rampStep = 1 / Math.max(1, info.sampleWidth - 1);

    numberLine(body, "Gradient energy", compact(g.gradientEnergy),
      "The mean of the squared slope. Unlike the average slope it is dominated by the sharp places, which is what makes it the usual measure of how busy a picture is.",
      {
        value: g.gradientEnergy,
        min: logFloor(b.gradientEnergy, NUMBER_LINE_DECADES_SQUARED), max: b.gradientEnergy, scale: "log",
        ticks: [
          { at: rampStep * rampStep, label: "smooth ramp", title: "One straight ramp across the whole view." },
          { at: b.noiseEnergy, label: "noise", title: "Where uniform random noise lands." },
        ],
        endLabels: ["flat", "checkerboard"],
      });

    numberLine(body, "Total variation", compact(g.totalVariation) + " per sample",
      "Add up every left-right and up-down change and divide by the sample count. Roughly, how much total contour there is to cross.",
      {
        value: g.totalVariation,
        min: logFloor(b.totalVariation, NUMBER_LINE_DECADES), max: b.totalVariation, scale: "log",
        ticks: [
          { at: rampStep, label: "smooth ramp", title: "One straight ramp across the whole view." },
          { at: b.noiseTotalVariation, label: "noise", title: "Where uniform random noise lands." },
        ],
        endLabels: ["flat", "checkerboard"],
      });

    // No "smooth ramp" tick: a straight ramp has zero second derivative
    // everywhere, so it sits at the flat end of this one rather than
    // somewhere recognisable along it.
    numberLine(body, "Laplacian variance", compact(g.laplacianVariance),
      "The classic sharpness measure: high means lots of fine detail, low means broad smooth washes.",
      {
        value: g.laplacianVariance,
        min: logFloor(b.laplacianVariance, NUMBER_LINE_DECADES_SQUARED), max: b.laplacianVariance, scale: "log",
        ticks: [{ at: b.noiseLaplacianVariance, label: "noise", title: "Where uniform random noise lands." }],
        endLabels: ["flat or a plain ramp", "checkerboard"],
      });

    note(body, "The scales above run from a flat image to a one-sample checkerboard, which is the busiest picture this sampling can hold" +
      (info.circular ? " - and this Output wraps, so its largest possible step is half the colour wheel rather than the whole of it" : "") +
      ". They are logarithmic: a real view sits a long way below the checkerboard, and on a linear scale every arrow would be pinned to the left.");
    note(body, "Measured on " + info.sampleWidth + "×" + info.sampleHeight + " samples of the view, one sample every " +
      compact(info.worldPerSample) + " world units (about " + fixed(info.screenPixelsPerSample, 1) +
      " screen pixels). Detail finer than that spacing is not counted - zoom in and these numbers grow.");
  }

  function renderOrientation(body, g, host) {
    var holder = el("div", "stat-chart");
    var canvas = document.createElement("canvas");
    holder.appendChild(canvas);
    body.appendChild(holder);
    note(body, "Directions of the lines in the map");
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
    numberLine(body, "Frequency-domain anisotropy", fixed(g.angularAnisotropy, 3) + "  (" + describeCoherence(g.angularAnisotropy) + ")",
      "An independent check on Direction of Lines, measured in the frequency domain rather than from gradients, and on the same 0-to-1 scale as that section's coherence. Each frequency is weighed against others the same distance from the origin, so this describes the spectrum's shape rather than which scales happen to be loudest.",
      {
        value: g.angularAnisotropy, min: 0, max: 1, scale: "linear",
        ticks: [
          { at: 0.25, label: "a lean", title: "Above this the spectrum has a slight preferred direction." },
          { at: 0.5, label: "directional", title: "Above this the spectrum is clearly directional." },
          { at: 0.8, label: "strongly", title: "Above this the spectrum is almost entirely one direction." },
        ],
        endLabels: ["the same in every direction", "one direction only"],
      });
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
        "The distance at which two samples stop resembling each other - the typical size of one patch of similar color.");
    }
    row(body, "Moran's I", fixed(g.moransI, 3) + "  (" + describeMoran(g.moransI) + ")",
      "Clustering of neighbouring samples. Near " + fixed(g.moransExpected, 3) + " would mean no clustering at all; 1 is perfectly smooth; below that baseline is checkerboard-like.");
    if (g.planeR2 !== undefined) {
      numberLine(body, "Flat-ramp fit (R²)", percent(g.planeR2, 1) + "  (" + describeR2(g.planeR2) + ")",
        "How much of the whole view a single straight gradient - one color ramp across the screen - already explains. The rest is structure.",
        {
          // A coefficient of determination is a fraction of variance
          // explained, so 0 and 1 are both real ends of it.
          value: g.planeR2, min: 0, max: 1, scale: "linear",
          endLabels: ["position predicts nothing", "exactly one flat ramp"],
        });
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

  // ---- The shape census, as a pie ----
  //
  // Four numbers that add up to one whole are a pie chart's one genuinely
  // good use: the question a reader has here is "what is most of this
  // view made of", which is a question about proportions of a whole and
  // not about comparing four independent quantities.
  //
  // Ridge and valley take the same two colours the map overlay draws them
  // in, so the switch below this joins up with the chart above it without
  // needing a sentence to say so.
  var SHAPE_COLORS = {
    ridge: "#ffd479",
    valley: "#7fd4ff",
    saddle: "#c58cff",
    flat: "#6b7280",
  };

  function drawShapePie(canvas, g) {
    var p = readPalette();
    var c = prepareCanvas(canvas, 150);
    var ctx = c.ctx;
    var cx = c.w / 2, cy = c.h / 2;
    var radius = Math.min(cx, cy) - 6;
    var slices = [
      { f: g.ridgeFraction, color: SHAPE_COLORS.ridge },
      { f: g.valleyFraction, color: SHAPE_COLORS.valley },
      { f: g.saddleFraction, color: SHAPE_COLORS.saddle },
      { f: g.flatFraction, color: SHAPE_COLORS.flat },
    ];
    var total = 0, i;
    for (i = 0; i < slices.length; i++) total += slices[i].f;
    if (!(total > 0)) return;
    // From twelve o'clock, clockwise - where a reader's eye starts on a
    // pie whether or not the code agrees.
    var at = -Math.PI / 2;
    for (i = 0; i < slices.length; i++) {
      var sweep = (slices[i].f / total) * Math.PI * 2;
      if (sweep <= 0) continue;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, radius, at, at + sweep);
      ctx.closePath();
      ctx.fillStyle = slices[i].color;
      ctx.fill();
      // A hairline between slices, in the card's own background: two
      // adjacent slices of similar weight otherwise read as one.
      ctx.strokeStyle = p.inputBg;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      at += sweep;
    }
  }

  // One legend line: swatch, name, share. Reuses .stat-row so it lines up
  // with every other label/value pair on the card.
  function legendRow(parent, color, label, value, note) {
    var r = el("div", "stat-row");
    var swatch = el("span", "stat-swatch");
    swatch.style.background = color;
    r.appendChild(swatch);
    r.appendChild(el("span", "stat-label", label));
    r.appendChild(el("span", "stat-value", value));
    if (note) r.title = note;
    parent.appendChild(r);
    return r;
  }

  function renderFeatures(body, g, host, info, state) {
    row(body, "Peaks / pits", g.peaks.toLocaleString() + " / " + g.pits.toLocaleString(),
      "Samples that are strictly higher (or lower) than all eight of their neighbours - one count of how many distinct features are on screen.");
    row(body, "Local extrema", fixed(g.extremaPerThousand, 1) + " per 1,000 samples",
      "The same count as a density, so it is comparable between views at the same sample resolution. It falls as that resolution rises: a coarse pass reads a whole cluster of nearby features as one.");

    var holder = el("div", "stat-chart");
    var canvas = document.createElement("canvas");
    holder.appendChild(canvas);
    body.appendChild(holder);
    legendRow(body, SHAPE_COLORS.ridge, "Ridges", percent(g.ridgeFraction, 1),
      "Curving down in every direction - the crests of the picture.");
    legendRow(body, SHAPE_COLORS.valley, "Valleys", percent(g.valleyFraction, 1),
      "Curving up in every direction - the troughs.");
    legendRow(body, SHAPE_COLORS.saddle, "Saddles", percent(g.saddleFraction, 1),
      "Curving up one way and down another - the passes between two basins. A high share means a tangled, interleaved structure.");
    legendRow(body, SHAPE_COLORS.flat, "Flat", percent(g.flatFraction, 1),
      "Curving negligibly compared with how much this view varies overall.");

    // ---- How far the longest one of each actually runs ----
    //
    // The shares above say how much of the view curves each way and
    // nothing about whether it is organised: a third of the view can be
    // valley as ten thousand specks or as one canyon crossing it corner to
    // corner. These two measure the biggest connected piece of each, end to
    // end ALONG itself, and report it in screen diagonals so the number
    // means the same thing at any sampling resolution or window size.
    function longest(label, diagonals, piece, colorNote) {
      row(body, label,
        piece && diagonals > 0 ? fixed(diagonals, 2) + " screen diagonals" : "none found",
        "The longest unbroken " + colorNote + " in the view, measured along itself rather than end to end in a straight line. 1.00 would reach corner to corner.");
    }
    longest("Longest ridge", g.longestRidgeDiagonals, g.longestRidge, "crest");
    longest("Longest valley", g.longestValleyDiagonals, g.longestValley, "trough");

    // The switch that draws them. Worth having because a length in screen
    // diagonals is a claim about the picture that a reader cannot check
    // against the picture - until it is drawn on it.
    var canOverlay = !!host.setFeatureOverlay && !!(g.longestRidge || g.longestValley);
    if (canOverlay) {
      var toggleRow = el("div", "stat-row");
      var lab = el("label", "stat-overlay-toggle");
      var box = document.createElement("input");
      box.type = "checkbox";
      box.checked = !!state.featureOverlay;
      lab.appendChild(box);
      lab.appendChild(el("span", null, "Draw them on the map"));
      lab.title = "Draws the longest ridge and the longest valley over the fractal itself. Panning or zooming switches this back off - the paths are drawn in the coordinates of the block that was measured, so they stop meaning anything the moment the view moves.";
      toggleRow.appendChild(lab);
      body.appendChild(toggleRow);
      box.addEventListener("change", function () {
        state.featureOverlay = box.checked;
        applyOverlay();
      });
    }

    function applyOverlay() {
      if (!host.setFeatureOverlay) return;
      if (!state.featureOverlay) { host.setFeatureOverlay(null); return; }
      host.setFeatureOverlay({
        width: info.sampleWidth,
        height: info.sampleHeight,
        ridge: g.longestRidge ? g.longestRidge.path : null,
        valley: g.longestValley ? g.longestValley.path : null,
      });
    }
    // A fresh measurement means fresh paths, so a switch already on gets
    // redrawn from the new ones rather than left pointing at the old.
    applyOverlay();

    return function () { drawShapePie(canvas, g); };
  }

  var RENDERERS = {
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
    var onSampleResolutionChange = options.onSampleResolutionChange || function () {};

    var enabled = {};       // key -> bool; every section starts off, deliberately
    var sections = {};      // key -> { wrap, body, input }
    var lastResult = null;
    var lastInfo = null;
    var uiState = { featureOverlay: false };
    // Chart draws deferred until after the whole body is in the DOM - a
    // canvas measures its parent to size itself, and a parent that hasn't
    // been laid out yet reports zero.
    var pendingDraws = [];

    // Takes the map overlay off and puts its switch back, wherever the
    // request came from: the section being closed, the card being cleared,
    // or the grid telling us the view has moved out from under it.
    function featureOverlayOff() {
      if (!uiState.featureOverlay) return;
      uiState.featureOverlay = false;
      if (host.setFeatureOverlay) host.setFeatureOverlay(null);
      var s = sections.features;
      if (!s) return;
      var box = s.body.querySelector(".stat-overlay-toggle input");
      if (box) box.checked = false;
    }

    var statusEl = el("p", "stats-status", "");
    bodyEl.appendChild(statusEl);

    // ---- How finely to sample the view ----
    //
    // First control on the card, because it sets what every number below it
    // is a measurement OF. The block is a re-render of the view at its own
    // resolution rather than the screen's, so without this the card would
    // silently be describing a 256-wide thumbnail of a multi-megapixel
    // picture - and a reader looking at the gradient numbers has no way to
    // tell. The readout says the block size and the cost outright.
    // Rebuilt on every relayout, not captured once: its top stop is "one
    // sample per rendered pixel", so resizing the window changes both what
    // that means and how many stops sit below it.
    var ladder = host.sampleLadder();
    var resField = el("label", "stats-field");
    var resLabel = el("span", "stats-field-label", "");
    resField.appendChild(resLabel);
    var resInput = document.createElement("input");
    resInput.type = "range";
    resInput.min = "0";
    resInput.step = "1";
    resInput.setAttribute("aria-label", "Sampling resolution");
    resField.appendChild(resInput);
    bodyEl.appendChild(resField);

    // Snaps the slider to whichever stop the host is currently set to,
    // against a freshly read ladder. 0 (one per rendered pixel) is always
    // the last stop, so a setting whose own stop has disappeared under a
    // smaller window lands there - which is what it now resolves to anyway,
    // since statsSampleBlock clamps it to the same place.
    function syncSampleSlider() {
      ladder = host.sampleLadder();
      resInput.max = String(ladder.length - 1);
      var want = host.sampleLongSide();
      var best = ladder.length - 1;
      for (var i = 0; i < ladder.length; i++) {
        if (ladder[i] === want) { best = i; break; }
      }
      resInput.value = String(best);
    }

    function updateSampleReadout() {
      var d = host.describeSample(ladder[Number(resInput.value)]);
      resLabel.textContent = "Sampling resolution: " + d.width + " × " + d.height;
    }
    syncSampleSlider();
    updateSampleReadout();
    // Dragging only re-labels; the measurement restarts on release, so
    // sweeping the slider doesn't start (and abandon) a run per notch.
    resInput.addEventListener("input", updateSampleReadout);
    resInput.addEventListener("change", function () {
      updateSampleReadout();
      onSampleResolutionChange(ladder[Number(resInput.value)]);
    });

    SECTIONS.forEach(function (section) {
      var wrap = el("section", "stats-section");
      var head = el("label", "stats-section-head");
      var sw = el("span", "toggle-switch");
      var input = document.createElement("input");
      input.type = "checkbox";
      input.checked = !!section.defaultOn;
      sw.appendChild(input);
      sw.appendChild(el("span", "toggle-slider"));
      head.appendChild(el("span", "stats-section-title", section.title));
      head.appendChild(sw);
      wrap.appendChild(head);

      // A section whose picture explains itself carries no blurb at all -
      // see the Rose Plot and Value Distribution above.
      var hint = null;
      if (section.hint) {
        hint = el("p", "stats-section-hint", section.hint);
        hint.hidden = !section.defaultOn;
        wrap.appendChild(hint);
      }

      var body = el("div", "stats-section-body");
      body.hidden = !section.defaultOn;
      wrap.appendChild(body);

      if (section.defaultOn) enabled[section.key] = true;

      input.addEventListener("change", function () {
        enabled[section.key] = input.checked;
        if (hint) hint.hidden = !input.checked;
        body.hidden = !input.checked;
        // Anything already measured stays on screen; a section only just
        // switched on has nothing yet, and says so until the next run.
        if (input.checked) { renderSection(section.key); flushDraws(); }
        else {
          // Closing Feature Census takes its drawing off the map with it -
          // the switch that turned it on has just gone away.
          if (section.key === "features") featureOverlayOff();
          body.innerHTML = "";
        }
        onEnabledChange();
      });

      sections[section.key] = { wrap: wrap, body: body, hint: hint, input: input };
      bodyEl.appendChild(wrap);
    });

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
        statusEl.className = "stats-status" + (kind ? " stats-status-" + kind : "");
        statusEl.innerHTML = "";
        // "loading" gets a spinner next to the text - reserved for "nothing
        // to show yet, but something is coming" (the view moved and the
        // fractal is still rendering), as opposed to "working", which is
        // already mid-measurement and has its own percent-complete text.
        if (kind === "loading") {
          statusEl.appendChild(el("span", "stats-spinner"));
          statusEl.appendChild(el("span", "stats-status-text", text));
        } else {
          statusEl.textContent = text;
        }
        // A finished, seam-free measurement passes "" - nothing wrong to
        // report - and an empty <p> would otherwise still sit there as a
        // blank gap above Sampling resolution.
        statusEl.hidden = !text;
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
        featureOverlayOff();
        lastResult = null;
        lastInfo = null;
        bodyEl.classList.remove("stats-stale");
        redrawCharts();
      },
      // The panel's own size changed (it opened, or the window resized), so
      // every canvas needs re-measuring against its parent - and the top
      // notch of the resolution slider is "match the grid", which a resize
      // has just changed the meaning of.
      relayout: function () {
        syncSampleSlider();
        updateSampleReadout();
        redrawCharts();
      },
      // The slider alone. Separate from relayout because the canvas can
      // resize while the card is CLOSED - the top stop is "one sample per
      // rendered pixel", so what it means and how many stops sit below it
      // have both just changed - and redrawing charts into a card with no
      // laid-out width would only have to be undone when it opens.
      refreshSampleReadout: function () {
        syncSampleSlider();
        updateSampleReadout();
      },
      // Called by the grid from statsOnViewChanged, i.e. on every pan,
      // zoom and resize. The overlay's paths are in the coordinates of the
      // block that was measured, so they stop describing anything the
      // instant the view they were measured from moves.
      featureOverlayOff: featureOverlayOff,
      sections: SECTIONS,
    };
  }

  global.FractalStatsPanel = { create: create, SECTIONS: SECTIONS };
})(window);
