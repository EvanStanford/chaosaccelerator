// This file is part of Chaos Accelerator, licensed under the Common Public
// Attribution License, Version 1.0 (CPAL-1.0) - see LICENSE in the project
// root, or https://chaosaccelerator.com/license for a hosted copy.

// ---- Global Stats: the panel ----
//
// The floating card under the gear button on the fractal page. It owns the
// section list, the accordion that opens one of them, and every chart; it
// owns none of the measuring. fractal-stats.js does the arithmetic and
// fractal-grid.js does the sampling and the scheduling - this file is the
// seam between them, which is why it takes a `host` of callbacks (turn a t
// into a real Output value, into that value's color, into world
// coordinates) rather than reaching for any of that itself.
//
// Exactly one section is open at a time - never none, never two - and only
// the open one is measured: the accordion is not a display filter, it is
// the compute budget. Each section is a full extra pass over the sampled
// view, so "closed" has to mean "not computed," not "computed and hidden."
(function (global) {
  "use strict";

  // Each section is one heading and one renderer - no blurb: every one of
  // these is a picture that explains itself, and any text was text in front
  // of it. The `key` is what fractal-stats.js's own `groups` flags are
  // named, so enabledGroups() below is a direct copy of whichever one is
  // open.
  var SECTIONS = [
    {
      key: "orientation",
      title: "Rose Plot",
      defaultOpen: true,
    },
    {
      key: "distribution",
      title: "Value Distribution",
    },
    {
      key: "features",
      title: "Topography",
    },
  ];

  // ---- Number formatting ----
  //
  // Everything on this panel is read at a glance next to other numbers, so
  // these two keep column widths stable rather than each value choosing
  // its own precision.
  function fixed(v, places) {
    if (v === null || v === undefined || !isFinite(v)) return "-";
    return v.toFixed(places === undefined ? 3 : places);
  }
  function percent(v, places) {
    if (v === null || v === undefined || !isFinite(v)) return "-";
    return (v * 100).toFixed(places === undefined ? 1 : places) + "%";
  }
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  // One label/value line. `note` becomes the row's tooltip - the numbers on
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
  // ---- Chart plumbing ----
  //
  // Three small canvases, all 2-D, all drawn from scratch on every result -
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

  function renderOrientation(body, g, host) {
    var holder = el("div", "stat-chart");
    var canvas = document.createElement("canvas");
    holder.appendChild(canvas);
    body.appendChild(holder);
    return function () { drawRose(canvas, g); };
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
    // end ALONG itself, and report it in screens - one screen being the
    // view's own diagonal, corner to corner - so the number means the same
    // thing at any sampling resolution or window size.
    function longest(label, diagonals, piece, colorNote) {
      row(body, label,
        piece && diagonals > 0 ? fixed(diagonals, 2) + " screens" : "none found",
        "The longest unbroken " + colorNote + " in the view, measured along itself rather than end to end in a straight line. 1.00 would reach corner to corner of the screen.");
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
    orientation: renderOrientation,
    features: renderFeatures,
  };

  // ---- The panel object ----

  function create(options) {
    var bodyEl = options.body;
    var host = options.host;
    var onSectionChange = options.onSectionChange || function () {};

    var activeKey = null;   // the one open section; never null once built
    var sections = {};      // key -> { wrap, body, head }
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

    // An accordion: one heading per section, and clicking a heading opens
    // that section and closes whichever one was open. Clicking the open one
    // does nothing - there is always exactly one open, so there is no
    // "close" to offer.
    SECTIONS.forEach(function (section) {
      var wrap = el("section", "stats-section");
      var head = el("button", "stats-section-head");
      head.type = "button";
      head.appendChild(el("span", "stats-section-title", section.title));
      head.appendChild(el("span", "stats-section-caret"));
      wrap.appendChild(head);

      var body = el("div", "stats-section-body");
      wrap.appendChild(body);

      head.addEventListener("click", function () { setActive(section.key); });

      sections[section.key] = { wrap: wrap, body: body, head: head };
      bodyEl.appendChild(wrap);
    });

    // Opens `key` and closes the rest. Anything already measured for the
    // newly opened section is drawn at once; otherwise it shows a spinner
    // until the host's next measurement arrives.
    function setActive(key) {
      if (key === activeKey || !sections[key]) return;
      var previous = activeKey;
      activeKey = key;
      SECTIONS.forEach(function (section) {
        var s = sections[section.key];
        var open = section.key === key;
        s.wrap.classList.toggle("stats-section-open", open);
        s.head.setAttribute("aria-expanded", open ? "true" : "false");
        s.body.hidden = !open;
        if (!open) s.body.innerHTML = "";
      });
      // Closing Topography takes its drawing off the map with it - the
      // switch that turned it on has just gone away.
      if (previous === "features") featureOverlayOff();
      renderSection(key);
      flushDraws();
      if (previous !== null) onSectionChange();
    }

    // Declared after the handler that calls it: a function declaration, so
    // it is hoisted to the top of create() and the handler above closes
    // over it fine. Kept down here with the other rendering rather than
    // moved up, since that is what it is.
    function renderSection(key) {
      var s = sections[key];
      if (!s || key !== activeKey) return;
      s.body.innerHTML = "";
      var g = lastResult ? lastResult.groups[key] : null;
      // Nothing to show yet - either nothing has been measured at all, or
      // this section wasn't part of the last measurement. Either way one is
      // on its way (the host measures whichever section is open), so a
      // spinner says exactly that where a sentence would have to explain.
      if (!g) {
        var wait = el("div", "stat-loading");
        wait.appendChild(el("span", "stats-spinner"));
        wait.setAttribute("aria-label", "Measuring");
        s.body.appendChild(wait);
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
      renderSection(activeKey);
      flushDraws();
    }

    // Open the default section. Done last, once every section exists, so
    // setActive can close the others - and with no host callback, since
    // the host hasn't got the panel object back yet to act on one.
    var initial = SECTIONS[0].key;
    SECTIONS.forEach(function (s) { if (s.defaultOpen) initial = s.key; });
    setActive(initial);

    return {
      // Exactly the flags fractal-stats.js's createJob wants, so nothing in
      // between has to translate between two lists of section names.
      enabledGroups: function () {
        var g = {};
        g[activeKey] = true;
        return g;
      },
      // Does the open section have nothing to show? Opening a section the
      // last measurement already covered needs no new run, so the host asks
      // this rather than re-measuring the view on every click.
      needsMeasurement: function () {
        return !lastResult || !lastResult.groups[activeKey];
      },
      setStatus: function (text, kind) {
        statusEl.className = "stats-status" + (kind ? " stats-status-" + kind : "");
        statusEl.innerHTML = "";
        // Both "something is coming" states get a spinner next to the
        // text: "loading" (a run is about to start) and "working" (one is
        // under way, with its own percent-complete text). Text alone read
        // as inert, easy to mistake for a dead end rather than a wait.
        if (kind === "loading" || kind === "working") {
          statusEl.appendChild(el("span", "stats-spinner"));
          statusEl.appendChild(el("span", "stats-status-text", text));
        } else {
          statusEl.textContent = text;
        }
        // A finished, seam-free measurement passes "" - nothing wrong to
        // report - and an empty <p> would otherwise still sit there as a
        // blank gap above the first section.
        statusEl.hidden = !text;
      },
      // A fresh measurement: keep it, and redraw the open section against
      // it. With `merge` set the new groups are added to the ones already
      // held rather than replacing them - the host passes that when the
      // view hasn't moved since the last result, so that opening a section
      // measured earlier shows it at once instead of measuring it again.
      showResult: function (result, info, merge) {
        if (merge && lastResult) {
          for (var key in result.groups) {
            if (Object.prototype.hasOwnProperty.call(result.groups, key)) lastResult.groups[key] = result.groups[key];
          }
        } else {
          lastResult = result;
        }
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
      // every canvas needs re-measuring against its parent.
      relayout: redrawCharts,
      // Called by the grid from statsOnViewChanged, i.e. on every pan,
      // zoom and resize. The overlay's paths are in the coordinates of the
      // block that was measured, so they stop describing anything the
      // instant the view they were measured from moves.
      featureOverlayOff: featureOverlayOff,
    };
  }

  global.FractalStatsPanel = { create: create, SECTIONS: SECTIONS };
})(window);
