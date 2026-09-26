// CPAL-1.0 License. See chaosaccelerator.com/license.html

// ---- Global Stats: the panel ----
// The floating card on the fractal page: section list, accordion and charts.
// Measuring is fractal-stats.js's job and sampling fractal-grid.js's; the `host`
// callbacks bridge them. Exactly one section is open, and only it is measured.
(function (global) {
  "use strict";

  // One heading and one renderer each; `key` matches fractal-stats.js's groups flags.
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

  function row(parent, label, value, note) {
    var r = el("div", "stat-row");
    r.appendChild(el("span", "stat-label", label));
    var v = el("span", "stat-value", value);
    r.appendChild(v);
    if (note) r.title = note;
    parent.appendChild(r);
    return r;
  }
  // ---- Chart plumbing: small 2-D canvases redrawn from scratch on every result ----
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

  // Sizes the backing store to the CSS size at the device pixel ratio; the context is scaled to CSS pixels.
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

  // ---- The color histogram: each bar filled with its bucket's own color ----
  // Two pointers under it, median and mean: the gap between them shows the skew.
  function drawHistogram(canvas, dist, host) {
    var p = readPalette();
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

    var MEDIAN_COLOR = "#ffffff", MEAN_COLOR = "#9399ad";
    var marks = [];
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

    // Labels are nudged apart only as far as needed; the POINTERS stay on the data.
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

  // Analysis Maxing (challenges/): { target, onResult }. target is a share of the rose's weight per equal
  // slice of the 180 degrees, in percent; it is drawn as an outline over the rose, on the same radial scale.
  var roseChallenge = null;

  // ---- The orientation rose ----
  // 180 bins drawn twice (theta and theta + 180): a line has no direction. Screen orientation: right 0, up 90.
  function drawRose(canvas, orient) {
    var p = readPalette();
    var c = prepareCanvas(canvas, 190);
    var ctx = c.ctx;
    var cx = c.w / 2, cy = c.h / 2;
    var radius = Math.min(cx, cy) - 22;
    var bins = orient.bins, n = orient.binCount;

    // Light smoothing for display only; the reported peak uses the raw bins.
    var smooth = new Float64Array(n);
    var half = Math.max(1, Math.round(n / 60));
    for (var i = 0; i < n; i++) {
      var sum = 0, count = 0;
      for (var k = -half; k <= half; k++) { sum += bins[(i + k + n) % n]; count++; }
      smooth[i] = sum / count;
    }
    var max = 0;
    for (var m = 0; m < n; m++) max = Math.max(max, smooth[m]);
    // With a target both are shares of the whole per bin, and the larger of the two sets the radius.
    var target = roseChallenge ? roseChallenge.target : null;
    var targetFine = null;
    if (target) {
      var total = 0;
      for (var q = 0; q < n; q++) total += bins[q];
      targetFine = new Float64Array(n);
      var fineMax = 0;
      for (var f = 0; f < n; f++) {
        targetFine[f] = target[Math.floor(f * target.length / n)] / 100 * (target.length / n);
        fineMax = Math.max(fineMax, targetFine[f]);
      }
      for (var s2 = 0; s2 < n; s2++) smooth[s2] = total > 0 ? smooth[s2] / total : 0;
      max = Math.max(fineMax, total > 0 ? max / total : 0);
    }

    ctx.strokeStyle = p.border;
    ctx.lineWidth = 1;
    [0.5, 1].forEach(function (f) {
      ctx.beginPath();
      ctx.arc(cx, cy, radius * f, 0, Math.PI * 2);
      ctx.stroke();
    });
    ctx.beginPath();
    for (var d = 0; d < 180; d += 45) {
      var sa = d * Math.PI / 180;
      ctx.moveTo(cx - Math.cos(sa) * radius, cy + Math.sin(sa) * radius);
      ctx.lineTo(cx + Math.cos(sa) * radius, cy - Math.sin(sa) * radius);
    }
    ctx.stroke();

    if (max > 0) {
      ctx.beginPath();
      for (var s = 0; s < n * 2; s++) {
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
    if (targetFine && max > 0) {
      ctx.beginPath();
      for (var ts = 0; ts < n * 2; ts++) {
        var tb = ts % n;
        var ta = (tb + 0.5) * Math.PI / n + (ts >= n ? Math.PI : 0);
        var tr = (targetFine[tb] / max) * radius;
        var tx = cx + Math.cos(ta) * tr, ty = cy - Math.sin(ta) * tr;
        if (ts === 0) ctx.moveTo(tx, ty); else ctx.lineTo(tx, ty);
      }
      ctx.closePath();
      ctx.strokeStyle = "#c9a227";
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    for (var deg = 0; deg < 360; deg += 45) {
      var la = deg * Math.PI / 180;
      axisLabel(ctx, deg + "°",
        cx + Math.cos(la) * (radius + 12),
        cy - Math.sin(la) * (radius + 12) + 3, "center", p.dim);
    }
  }

  // ---- Section renderers: (body, group result, host[, info, state]) -> draw callback run after layout ----

  function renderDistribution(body, g, host) {
    var holder = el("div", "stat-chart");
    var canvas = document.createElement("canvas");
    holder.appendChild(canvas);
    body.appendChild(holder);
    return function () { drawHistogram(canvas, g, host); };
  }

  function renderOrientation(body, g, host) {
    var holder = el("div", "stat-chart");
    var canvas = document.createElement("canvas");
    holder.appendChild(canvas);
    body.appendChild(holder);
    return function () { drawRose(canvas, g); };
  }

  // ---- The shape census, as a pie: warm for ridge, cool for valley ----
  var SHAPES = [
    { key: "ridge", title: "Ridges", color: "#ffd479", fraction: "ridgeFraction",
      note: "Curving down in every direction: the crests of the picture." },
    { key: "valley", title: "Valleys", color: "#7fd4ff", fraction: "valleyFraction",
      note: "Curving up in every direction: the troughs." },
    { key: "saddle", title: "Saddles", color: "#c58cff", fraction: "saddleFraction",
      note: "Curving up one way and down another: the passes between two basins. A high share means a tangled, interleaved structure." },
    { key: "flat", title: "Flat", color: "#6b7280", fraction: "flatFraction",
      note: "Curving negligibly compared with how much this view varies overall." },
  ];

  // Draws the pie and returns its geometry (centre, radius, slice spans) for hit testing; `hot` is raised.
  function drawShapePie(canvas, g, hot) {
    var p = readPalette();
    var c = prepareCanvas(canvas, 150);
    var ctx = c.ctx;
    var cx = c.w / 2, cy = c.h / 2;
    var radius = Math.min(cx, cy) - 8;
    var geom = { cx: cx, cy: cy, radius: radius, slices: [] };
    var total = 0, i;
    for (i = 0; i < SHAPES.length; i++) total += g[SHAPES[i].fraction];
    if (!(total > 0)) return geom;
    var at = -Math.PI / 2;
    for (i = 0; i < SHAPES.length; i++) {
      var sweep = (g[SHAPES[i].fraction] / total) * Math.PI * 2;
      if (sweep <= 0) continue;
      geom.slices.push({ key: SHAPES[i].key, from: at, to: at + sweep });
      var isHot = SHAPES[i].key === hot;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, radius + (isHot ? 4 : 0), at, at + sweep);
      ctx.closePath();
      ctx.fillStyle = SHAPES[i].color;
      ctx.fill();
      ctx.strokeStyle = isHot ? "#ffffff" : p.inputBg;
      ctx.lineWidth = isHot ? 2 : 1.5;
      ctx.stroke();
      at += sweep;
    }
    return geom;
  }

  function pieSliceAt(geom, x, y) {
    if (!geom) return null;
    var dx = x - geom.cx, dy = y - geom.cy;
    if (dx * dx + dy * dy > (geom.radius + 4) * (geom.radius + 4)) return null;
    var a = Math.atan2(dy, dx);
    for (var i = 0; i < geom.slices.length; i++) {
      var sl = geom.slices[i];
      // Spans start at -pi/2 and run clockwise past +pi, where atan2 wraps.
      if ((a >= sl.from && a < sl.to) || (a + 2 * Math.PI >= sl.from && a + 2 * Math.PI < sl.to)) return sl.key;
    }
    return null;
  }

  function legendRow(parent, color, label, value, note) {
    var r = el("div", "stat-row stat-legend");
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
    var legend = {};
    SHAPES.forEach(function (shape) {
      legend[shape.key] = legendRow(body, shape.color, shape.title, percent(g[shape.fraction], 1), shape.note);
    });

    // ---- Hovering a class lights its legend line, its slice, and its samples on the map ----
    var geom = null, hot = null;
    function setHot(key) {
      if (state.stale) key = null;
      if (key === hot) return;
      hot = key;
      SHAPES.forEach(function (shape) {
        legend[shape.key].classList.toggle("stat-row-hot", shape.key === key);
      });
      geom = drawShapePie(canvas, g, hot);
      if (!host.setFeatureHighlight) return;
      host.setFeatureHighlight(key && g.shapeMask ? {
        width: info.sampleWidth,
        height: info.sampleHeight,
        mask: g.shapeMask,
        cls: g.shapeClasses[key],
      } : null);
    }
    SHAPES.forEach(function (shape) {
      legend[shape.key].addEventListener("mouseenter", function () { setHot(shape.key); });
      legend[shape.key].addEventListener("mouseleave", function () { setHot(null); });
    });
    canvas.addEventListener("mousemove", function (ev) {
      var box = canvas.getBoundingClientRect();
      setHot(pieSliceAt(geom, ev.clientX - box.left, ev.clientY - box.top));
    });
    canvas.addEventListener("mouseleave", function () { setHot(null); });

    // ---- Longest line of each kind, as a share of the view's diagonal ----
    // Hovering a row draws its path over the fractal; ridge and valley share one row, whichever is longer.
    body.appendChild(el("div", "stat-divider"));
    // One hover row showing `show` ({ path } or { mask }) on the map. A path row can be
    // PINNED by click, one at a time, remembered by `key` since rows are rebuilt on redraw.
    function hoverRow(label, valueText, note, show, key) {
      var canPin = !!(show && show.path && key && host.setPinnedOverlay);
      var r = row(body, label, valueText, note);
      if (!show) return r;
      r.classList.add("stat-legend");
      if (canPin) r.classList.add("stat-legend-pinnable");
      function place() { return { width: info.sampleWidth, height: info.sampleHeight }; }
      function showOnMap() {
        if (show.path && host.setFeatureOverlay) {
          var o = place(); o.path = show.path; host.setFeatureOverlay(o);
        }
        if (show.mask && host.setFeatureHighlight) {
          var h = place(); h.mask = show.mask; h.cls = 1; host.setFeatureHighlight(h);
        }
      }
      function hideFromMap() {
        if (show.path && host.setFeatureOverlay) host.setFeatureOverlay(null);
        if (show.mask && host.setFeatureHighlight) host.setFeatureHighlight(null);
      }
      function pinned() { return canPin && state.pinnedKey === key; }
      function pin() {
        unpin();
        state.pinnedKey = key;
        r.classList.add("stat-row-pinned", "stat-row-hot");
        var o = place(); o.path = show.path; host.setPinnedOverlay(o);
      }
      r.addEventListener("mouseenter", function () {
        if (state.stale) return;
        r.classList.add("stat-row-hot");
        showOnMap();
      });
      r.addEventListener("mouseleave", function () {
        if (!pinned()) r.classList.remove("stat-row-hot");
        hideFromMap();
      });
      if (canPin) {
        r.addEventListener("click", function () {
          if (state.stale) return;
          if (pinned()) unpin();
          else pin();
        });
        // Rebuilt while pinned: the pin carries over to the new row.
        if (pinned()) pin();
      }
      return r;
    }
    function screens(diagonals, piece) {
      return piece && diagonals > 0 ? Math.round(diagonals * 100) + "% screen length" : "none found";
    }
    function pathOf(piece) { return piece && piece.path ? { path: piece.path } : null; }

    var ridgeWins = g.longestRidgeDiagonals >= g.longestValleyDiagonals;
    var longestLine = ridgeWins ? g.longestRidge : g.longestValley;
    hoverRow("Longest Open Contour", screens(g.longestOpenContourDiagonals, g.longestOpenContour),
      "The longest contour at any level that runs from one edge of the view to another rather than closing on itself. Near a sharp boundary the contours follow it and inherit its wiggle, so this grows with the sampling resolution.",
      pathOf(g.longestOpenContour), "open");
    hoverRow("Longest Ridge/Valley", screens(ridgeWins ? g.longestRidgeDiagonals : g.longestValleyDiagonals, longestLine),
      "The longest unbroken crest or trough in the view" + (longestLine ? (ridgeWins ? " (a crest)." : " (a trough).") : "."),
      pathOf(longestLine), "ridgeValley");
    if (g.returnContour !== undefined) {
      hoverRow("Return Line", screens(g.returnContourDiagonals, g.returnContour),
        "The longest piece of the contour at the Output's starting value: every start in the view that brings the body back exactly to where it began, as the scene is authored.",
        pathOf(g.returnContour), "return");
    }
    hoverRow("Longest Sharp Edge", screens(g.longestEdgeDiagonals, g.longestEdge),
      "The longest unbroken sharp boundary: a line along which the colour steps from one value to another and stays there, by at least 5% of the range somewhere along it.",
      pathOf(g.longestEdge), "edge");
    if (g.medianContour !== undefined) {
      hoverRow("Median Contour", screens(g.medianContourDiagonals, g.medianContour),
        "The longest piece of the contour at the median value, the one level that splits the view into two equal halves by area.",
        pathOf(g.medianContour), "median");
    }
    if (g.watershed) {
      hoverRow("Catchments", g.watershed.basins.toLocaleString() + (g.watershed.basins === 1 ? " basin" : " basins"),
        "Read as terrain, how many separate low points the view drains to. Hovering shows the divides between them, the complete network of ranges, where Longest Ridge/Valley is only the single longest crest. In a chaotic region every other sample is a low point of its own, and the divides there are honestly a mesh.",
        g.watershed.mask ? { mask: g.watershed.mask } : null);
    }
    // A pinned row whose line is gone from this result has nothing to keep.
    if (state.pinnedKey && !body.querySelector(".stat-row-pinned")) unpin();

    function unpin() {
      if (!state.pinnedKey) return;
      state.pinnedKey = null;
      var was = body.querySelectorAll(".stat-row-pinned");
      for (var k = 0; k < was.length; k++) was[k].classList.remove("stat-row-pinned", "stat-row-hot");
      if (host.setPinnedOverlay) host.setPinnedOverlay(null);
    }

    return function () { geom = drawShapePie(canvas, g, hot); };
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
    // `stale` is set from a view move until the next result; hover rows and the pie do nothing while it is.
    var panelState = { stale: false, pinnedKey: null };
    var lastInfo = null;
    // Draws wait until the body is in the DOM: a canvas sizes itself from a laid-out parent.
    var pendingDraws = [];

    // Hover drawings off (section closing); the pinned line stays.
    function hoverOverlaysOff() {
      if (host.setFeatureHighlight) host.setFeatureHighlight(null);
      if (host.setFeatureOverlay) host.setFeatureOverlay(null);
    }
    // Everything off, pinned line included: the view moved, so the coordinates are gone.
    function featureOverlayOff() {
      hoverOverlaysOff();
      unpin();
    }
    function unpin() {
      if (!panelState.pinnedKey) return;
      panelState.pinnedKey = null;
      var was = bodyEl.querySelectorAll(".stat-row-pinned");
      for (var k = 0; k < was.length; k++) was[k].classList.remove("stat-row-pinned", "stat-row-hot");
      if (host.setPinnedOverlay) host.setPinnedOverlay(null);
    }

    var statusEl = el("p", "stats-status", "");
    bodyEl.appendChild(statusEl);

    // Accordion: a heading opens its section and closes the open one; clicking the open one does nothing.
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
      // Closing Topography takes its hover drawings with it; a pinned line stays.
      if (previous === "features") hoverOverlaysOff();
      renderSection(key);
      flushDraws();
      if (previous !== null) onSectionChange();
    }

    function renderSection(key) {
      var s = sections[key];
      if (!s || key !== activeKey) return;
      s.body.innerHTML = "";
      var g = lastResult ? lastResult.groups[key] : null;
      if (!g) {
        var wait = el("div", "stat-loading");
        wait.appendChild(el("span", "stats-spinner"));
        wait.setAttribute("aria-label", "Measuring");
        s.body.appendChild(wait);
        return;
      }
      var draw = RENDERERS[key](s.body, g, host, lastInfo, panelState);
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

    var initial = SECTIONS[0].key;
    SECTIONS.forEach(function (s) { if (s.defaultOpen) initial = s.key; });
    setActive(initial);

    return {
      enabledGroups: function () {
        var g = {};
        g[activeKey] = true;
        return g;
      },
      // Lets the host skip re-measuring when the last result already covers the open section.
      needsMeasurement: function () {
        return !lastResult || !lastResult.groups[activeKey];
      },
      setStatus: function (text, kind) {
        statusEl.className = "stats-status" + (kind ? " stats-status-" + kind : "");
        statusEl.innerHTML = "";
        // "loading" and "working" both get a spinner: text alone read as a dead end.
        if (kind === "loading" || kind === "working") {
          statusEl.appendChild(el("span", "stats-spinner"));
          statusEl.appendChild(el("span", "stats-status-text", text));
        } else {
          statusEl.textContent = text;
        }
        // "" means nothing to report; hide so no blank gap sits above the sections.
        statusEl.hidden = !text;
      },
      // With `merge`, new groups are added to the held ones (view unchanged since
      // the last result) so a section measured earlier shows at once.
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
        if (roseChallenge && roseChallenge.onResult && lastResult.groups.orientation) {
          try { roseChallenge.onResult(lastResult.groups.orientation); } catch (err) { /* the page's problem */ }
        }
      },
      // The view moved: dim rather than clear, since a blank panel mid-pan is worse.
      markStale: function () {
        panelState.stale = true;
        bodyEl.classList.add("stats-stale");
        // Unlight hovered rows, whose map drawing is gone; the pinned row keeps its look.
        var lit = bodyEl.querySelectorAll(".stat-row-hot:not(.stat-row-pinned)");
        for (var i = 0; i < lit.length; i++) lit[i].classList.remove("stat-row-hot");
      },
      markFresh: function () {
        panelState.stale = false;
        bodyEl.classList.remove("stats-stale");
      },
      // A different scene: the numbers are in units the host can't format now, so they go.
      clearResult: function () {
        featureOverlayOff();
        lastResult = null;
        lastInfo = null;
        panelState.stale = false;
        bodyEl.classList.remove("stats-stale");
        redrawCharts();
      },
      relayout: redrawCharts,
      featureOverlayOff: featureOverlayOff,
      hoverOverlaysOff: hoverOverlaysOff,
      // The grid calls this when the pinned line is clicked on the map.
      unpin: unpin,
    };
  }

  global.FractalStatsPanel = {
    create: create,
    SECTIONS: SECTIONS,
    setRoseChallenge: function (challenge) { roseChallenge = challenge || null; },
  };
})(window);
