// CPAL-1.0 License. See chaosaccelerator.com/license.html

// Challenges: lists read from trick-shot.json, analysis-maxing.json and lyapunov.json, and play mode, which
// loads chaos.html in a frame.
//   Trick Shot: ?goal=<events>, so the map paints the goal region clear (challenge-frame.css and, in
//   fractal-grid.js, challengeGoalOrder). A plain click on the map asks the frame whether the pixel under it
//   is a goal pixel (FractalGrid.goalAt): yes wins, there is no closest-so-far.
//   Rose Plot Targets: ?rose=1. The target is handed to the frame's stats panel (FractalStatsPanel
//   .setRoseChallenge), which draws it over the Rose Plot and reports each measurement back here. The score
//   is the share of the rose inside the target, the higher the better; the best score and its map link are
//   kept per challenge.
//   Lyapunov: ?lyap=1 (&fric=0 without friction, &vin=1 velocity inputs only). The frame reports the inspected
//   runs' exponent (FractalGrid.setLyapunovChallenge); below zero wins, and the most negative is kept.
(function () {
  "use strict";

  var APP = "../chaos.html";
  var SOLVED_KEY = "chaosChallengesSolved";
  var BEST_KEY = "chaosChallengesBest";
  var CELEBRATED_KEY = "chaosChallengesCelebrated";
  var CLICK_SLOP_PX = 5;
  // Shows as 100.0%.
  var ROSE_WIN = 0.9995;
  // Exponents show to 3 places; this is the first that shows as negative.
  var LYAP_WIN = -0.0005;
  // A level with "above" is won by an exponent over it, and keeps the highest; the rest win below zero.
  function lyapWins(c, lambda) { return typeof c.above === "number" ? lambda > c.above : lambda <= LYAP_WIN; }
  function lyapBetter(c, a, b) { return typeof c.above === "number" ? a > b : a < b; }
  var LYAP_PLOT_SAMPLES = 120;
  // "nearby": the two furthest runs start no further apart than a hundredth of the zoom 1 view's height.
  var NEARBY_GAP = (200 / 0.17) / 100;

  function $(id) { return document.getElementById(id); }
  var listPage = $("list-page"), listEl = $("challenge-list"), roseListEl = $("rose-list"), lyapListEl = $("lyap-list");
  var btnResetAll = $("btn-reset-all");
  var confirmDialog = $("confirm-dialog"), confirmTitle = $("confirm-title"), confirmText = $("confirm-text"), confirmOk = $("confirm-ok");
  var playPage = $("play-page"), playTitle = $("play-title"), engine = $("engine");
  var targetPanel = $("target-panel"), targetVideo = $("target-video"), targetRose = $("target-rose");
  var targetPlot = $("target-plot"), targetImage = $("target-image");
  var targetOrder = $("target-order"), targetHelp = $("target-help"), btnTarget = $("btn-target");
  var scoreEl = $("score"), btnBest = $("btn-best"), bestPanel = $("best-panel"), bestRose = $("best-rose");
  var bestPlot = $("best-plot"), bestText = $("best-text"), bestLink = $("best-link");
  var toast = $("toast"), winPanel = $("win-panel"), winText = $("win-text"), winLink = $("win-link");

  var challenges = [];
  var current = -1;
  var watch = null;
  // History entries {challenge, link, depth, view} for the frame's builder/map moves; frameStops: the frame's address at each depth.
  var frameDepth = 0;
  var frameStops = [];
  // Runs on the next popstate in place of the usual handling, after a step back this page took itself.
  var afterBack = null;
  var wonThisPlay = false;
  // A best loaded without a picture of its scene gets one from the frame's first result.
  var pictureWanted = false;
  var PICTURE_LONG_SIDE = 480;

  function readStore(key) {
    try { return JSON.parse(localStorage.getItem(key) || "{}") || {}; } catch (err) { return {}; }
  }
  function writeStore(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (err) { return false; }
  }
  function markSolved(id) {
    var set = readStore(SOLVED_KEY);
    set[id] = true;
    writeStore(SOLVED_KEY, set);
  }
  function bestOf(id) { return readStore(BEST_KEY)[id] || null; }
  // Pictures are the bulk of the store: when it is full they go before the bests do.
  function saveBest(id, entry) {
    var all = readStore(BEST_KEY);
    all[id] = entry;
    if (writeStore(BEST_KEY, all)) return;
    Object.keys(all).forEach(function (k) { delete all[k].picture; });
    writeStore(BEST_KEY, all);
  }
  function keepsBest(c) { return c.kind !== "trick"; }
  // "after": the challenge that must be solved first; until then this one shows its lockedTitle and can't be played.
  function isLocked(c) { return !!c.after && !readStore(SOLVED_KEY)[c.after]; }
  // A reset clears the best and the Solved mark.
  function resetChallenge(id) {
    var bests = readStore(BEST_KEY), solved = readStore(SOLVED_KEY);
    delete bests[id];
    delete solved[id];
    writeStore(BEST_KEY, bests);
    writeStore(SOLVED_KEY, solved);
  }

  // A goal event is a body number (a bounce off it) or "w" and a portal's number (in through it).
  function portalColors(scene) {
    var m = /(?:^|,)body:([^,]*)/.exec(scene), colors = {};
    (m ? m[1].split(";") : []).forEach(function (b, i) {
      if (/^po:/.test(b)) colors[i] = "orange";
      else if (/^pg:/.test(b)) colors[i] = "green";
    });
    return colors;
  }
  function eventText(token, colors) {
    if (token.charAt(0) !== "w") return token;
    var name = ColorBlind.palette().portalName;
    return colors[Number(token.slice(1))] === "green" ? name.green + " to " + name.orange : name.orange + " to " + name.green;
  }
  function orderText(c) {
    var goal = c.goal.map(String), colors = portalColors(c.scene);
    var repeated = goal.length > 1 && goal.every(function (t) { return t === goal[0]; });
    if (repeated && goal[0].charAt(0) === "w") return "Through the portals " + eventText(goal[0], colors) + ", " + goal.length + " times";
    if (repeated) return "Bounce on body " + goal[0] + ", " + goal.length + " times";
    return "Bounce order: " + goal.map(function (t) { return eventText(t, colors); }).join(", ");
  }
  function percent(v) { return (v * 100).toFixed(1) + "%"; }
  function exponentText(v) { return (Math.abs(v) < 5e-4 ? 0 : v).toFixed(3); }

  // The small charts are laid out 240 units wide and drawn at their canvas's own resolution.
  var CHART_UNITS = 240;
  function chartContext(canvas) {
    var ctx = canvas.getContext("2d"), k = canvas.width / CHART_UNITS;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(k, 0, 0, k, 0, 0);
    return { ctx: ctx, w: CHART_UNITS, h: canvas.height / k };
  }
  // Top right, only on a chart that shows an attempt.
  function drawLegend(ctx, w) {
    ctx.font = "10px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    var x = w - 6, y = 9;
    var p = ColorBlind.palette();
    [["yours", p.accent], ["goal", p.gold]].forEach(function (item) {
      x -= ctx.measureText(item[0]).width;
      ctx.fillStyle = "#9399ad";
      ctx.fillText(item[0], x, y);
      ctx.fillStyle = item[1];
      ctx.beginPath();
      ctx.arc(x - 6, y, 3, 0, Math.PI * 2);
      ctx.fill();
      x -= 16;
    });
  }

  // ---- A small rose: the target as a gold outline, a plot (shares per slice) as the blue fill over it ----
  function drawRoseShape(canvas, target, plot) {
    var chart = chartContext(canvas), ctx = chart.ctx;
    var w = chart.w, h = chart.h, cx = w / 2, cy = h / 2, radius = Math.min(cx, cy) - 14;
    ctx.strokeStyle = "#2c3040";
    ctx.lineWidth = 1;
    [0.5, 1].forEach(function (f) { ctx.beginPath(); ctx.arc(cx, cy, radius * f, 0, Math.PI * 2); ctx.stroke(); });
    ctx.beginPath();
    for (var d = 0; d < 180; d += 45) {
      var a = d * Math.PI / 180;
      ctx.moveTo(cx - Math.cos(a) * radius, cy + Math.sin(a) * radius);
      ctx.lineTo(cx + Math.cos(a) * radius, cy - Math.sin(a) * radius);
    }
    ctx.stroke();
    var n = target.length, max = 0, i;
    for (i = 0; i < n; i++) max = Math.max(max, target[i] / 100, plot ? plot[i] : 0);
    if (!(max > 0)) return;
    function polygon(values, scale) {
      ctx.beginPath();
      for (var s = 0; s < n * 2; s++) {
        var bin = s % n;
        var ang = (bin + 0.5) * Math.PI / n + (s >= n ? Math.PI : 0);
        var r = values[bin] * scale / max * radius;
        var x = cx + Math.cos(ang) * r, y = cy - Math.sin(ang) * r;
        if (s === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
    }
    var p = ColorBlind.palette();
    polygon(target, 0.01);
    ctx.strokeStyle = p.gold;
    ctx.lineWidth = 2;
    ctx.stroke();
    if (plot) {
      polygon(plot, 1);
      ctx.fillStyle = p.accentWash;
      ctx.fill();
      ctx.strokeStyle = p.accent;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      drawLegend(ctx, w);
    }
  }

  // The frame's 180 fine bins folded into the target's slices, as shares of the whole.
  function coarseRose(orient, n) {
    var out = [], i;
    for (i = 0; i < n; i++) out.push(0);
    var total = 0;
    for (i = 0; i < orient.binCount; i++) total += orient.bins[i];
    if (!(total > 0)) return null;
    for (i = 0; i < orient.binCount; i++) out[Math.floor(i * n / orient.binCount)] += orient.bins[i] / total;
    return out;
  }
  function insideShare(plot, target) {
    var s = 0;
    for (var i = 0; i < target.length; i++) s += Math.min(plot[i], target[i] / 100);
    return s;
  }

  // ---- A small separation plot: a falling gold line for the goal, a run's log10 separation in blue ----
  // rising: the gold goal line climbs, for a level won above zero.
  function drawLyapShape(canvas, plot, rising) {
    var chart = chartContext(canvas), ctx = chart.ctx, w = chart.w, h = chart.h, pad = 14, inset = 8;
    ctx.strokeStyle = "#2c3040";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad + 0.5, pad);
    ctx.lineTo(pad + 0.5, h - pad + 0.5);
    ctx.lineTo(w - pad, h - pad + 0.5);
    ctx.stroke();
    var x0 = pad + inset, x1 = w - pad - inset, y0 = pad + inset, y1 = h - pad - inset;
    ctx.setLineDash([6, 5]);
    ctx.strokeStyle = ColorBlind.palette().gold;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x0, rising ? y1 : y0);
    ctx.lineTo(x1, rising ? y0 : y1);
    ctx.stroke();
    ctx.setLineDash([]);
    if (!plot) return;
    drawLegend(ctx, w);
    var lo = Infinity, hi = -Infinity;
    plot.forEach(function (v) { if (v !== null) { lo = Math.min(lo, v); hi = Math.max(hi, v); } });
    if (!(hi >= lo)) return;
    if (hi - lo < 1) { lo = (hi + lo) / 2 - 0.5; hi = lo + 1; }
    ctx.strokeStyle = ColorBlind.palette().accent;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    var pen = false;
    plot.forEach(function (v, i) {
      if (v === null) { pen = false; return; }
      var x = x0 + (plot.length > 1 ? i / (plot.length - 1) : 0.5) * (x1 - x0), y = y0 + (hi - v) / (hi - lo) * (y1 - y0);
      if (pen) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      pen = true;
    });
    ctx.stroke();
  }

  // A run's separation, shortened for storage: log10 at evenly spaced steps, null where it is zero.
  function logSamples(distance) {
    var n = Math.min(LYAP_PLOT_SAMPLES, distance.length), out = [];
    for (var i = 0; i < n; i++) {
      var v = distance[n > 1 ? Math.round(i * (distance.length - 1) / (n - 1)) : 0];
      out.push(v > 0 && isFinite(v) ? Math.round(Math.log10(v) * 1000) / 1000 : null);
    }
    return out;
  }

  // ---- The lists ----

  // The top row: title, a note and Play on the left (the chart goes on the right). An attempted challenge's
  // Solved mark and best move into bestBox under it.
  function card(c, i, solved, locked) {
    var el = document.createElement("article");
    el.className = "challenge-card";
    var best = keepsBest(c) && !locked ? bestOf(c.id) : null;
    var text = document.createElement("div");
    var h = document.createElement("h3");
    h.textContent = locked ? c.lockedTitle || c.title : c.title;
    if (solved && !best) {
      var badge = document.createElement("span");
      badge.className = "solved";
      badge.textContent = "Solved";
      h.appendChild(badge);
    }
    text.appendChild(h);
    var rules = c.kind === "lyap" && !locked ? rulesText(c) : "";
    if (rules) {
      var rulesLine = document.createElement("p");
      rulesLine.className = "order";
      rulesLine.textContent = rules;
      text.appendChild(rulesLine);
    }
    var note = document.createElement("p");
    note.className = "order";
    if (!best) text.appendChild(note);
    var btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = solved ? "Play again" : "Play";
    btn.disabled = locked;
    btn.addEventListener("click", function () { play(i); });
    text.appendChild(btn);
    el.appendChild(text);
    return { el: el, note: note, best: best, locked: locked };
  }

  // The best attempt: the result and its buttons on the left, its scene as the builder showed it on the right.
  function bestBox(c, i, best, solved, summary) {
    var box = document.createElement("div");
    box.className = "best-box";
    var text = document.createElement("div");
    if (solved) {
      var mark = document.createElement("p");
      mark.className = "best-solved";
      mark.textContent = "Solved!";
      text.appendChild(mark);
    }
    var line = document.createElement("p");
    line.className = "order";
    line.textContent = summary;
    text.appendChild(line);
    var actions = document.createElement("div");
    actions.className = "card-actions";
    var load = document.createElement("button");
    load.type = "button";
    load.className = "secondary";
    load.textContent = "Load best";
    load.addEventListener("click", function () { play(i, best.link); });
    var reset = document.createElement("button");
    reset.type = "button";
    reset.className = "danger";
    reset.textContent = "Reset";
    reset.addEventListener("click", function () {
      askConfirm("Reset " + c.title + "?", "Your best attempt and its Solved mark will be cleared.", "Reset", function () {
        resetChallenge(c.id);
        renderLists();
      });
    });
    actions.appendChild(load);
    actions.appendChild(reset);
    text.appendChild(actions);
    box.appendChild(text);
    if (best.picture) {
      var img = document.createElement("img");
      img.className = "card-scene";
      img.src = best.picture;
      img.alt = "The scene of your best attempt";
      box.appendChild(img);
      box.classList.add("has-scene");
    }
    return box;
  }

  function sideCanvas(className, height) {
    var canvas = document.createElement("canvas");
    canvas.className = className;
    canvas.width = 2 * CHART_UNITS; canvas.height = 2 * height;
    return canvas;
  }

  // "N/M completed" for the page and each section.
  function renderProgress(solved) {
    var all = 0, done = 0, kinds = {};
    challenges.forEach(function (c) {
      var k = kinds[c.kind] = kinds[c.kind] || { all: 0, done: 0 };
      k.all++; all++;
      if (solved[c.id]) { k.done++; done++; }
    });
    function show(el, n, of) {
      el.textContent = of ? n + "/" + of + " completed" : "";
      el.classList.toggle("progress-done", of > 0 && n === of);
    }
    show($("progress-total"), done, all);
    if (all > 0 && done === all) $("progress-total").textContent = "\uD83C\uDFC6 " + done + "/" + all + " complete! \uD83C\uDFC6";
    ["trick", "rose", "lyap"].forEach(function (kind) { show($("progress-" + kind), kinds[kind] ? kinds[kind].done : 0, kinds[kind] ? kinds[kind].all : 0); });
  }

  function celebrate() {
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    var canvas = document.createElement("canvas"), ctx = canvas.getContext("2d"), dpr = window.devicePixelRatio || 1;
    canvas.className = "confetti";
    document.body.appendChild(canvas);
    var w = window.innerWidth, h = window.innerHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    var colors = ColorBlind.palette().confetti, pieces = [];
    for (var i = 0; i < 240; i++) {
      var fromLeft = i % 2 === 0, angle = (fromLeft ? -1 : 1) * (0.35 + Math.random() * 0.5);
      var speed = 600 + Math.random() * 700;
      pieces.push({
        x: fromLeft ? 0 : w, y: h * (0.55 + Math.random() * 0.25),
        vx: -Math.sin(angle) * speed, vy: -Math.cos(angle) * speed,
        size: 6 + Math.random() * 7, spin: (Math.random() - 0.5) * 12, turn: Math.random() * Math.PI,
        wobble: Math.random() * Math.PI * 2, color: colors[i % colors.length],
      });
    }
    var start = null, last = null, LIFE = 5000;
    function frame(t) {
      if (start === null) { start = last = t; }
      var dt = Math.min(0.05, (t - last) / 1000), age = t - start;
      last = t;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.globalAlpha = Math.max(0, Math.min(1, (LIFE - age) / 1000));
      pieces.forEach(function (p) {
        p.vy += 900 * dt; p.vx *= 1 - 1.2 * dt; p.vy *= 1 - 0.9 * dt;
        p.x += p.vx * dt; p.y += p.vy * dt; p.turn += p.spin * dt; p.wobble += 6 * dt;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.turn);
        ctx.scale(1, Math.cos(p.wobble));
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        ctx.restore();
      });
      if (age < LIFE) requestAnimationFrame(frame); else canvas.remove();
    }
    requestAnimationFrame(frame);
  }

  function renderLists() {
    var solved = readStore(SOLVED_KEY);
    renderProgress(solved);
    btnResetAll.disabled = !Object.keys(solved).length && !Object.keys(readStore(BEST_KEY)).length;
    listEl.textContent = "";
    roseListEl.textContent = "";
    lyapListEl.textContent = "";
    challenges.forEach(function (c, i) {
      var made = card(c, i, !!solved[c.id], isLocked(c)), best = made.best, canvas, summary;
      if (c.kind === "trick") {
        made.note.textContent = orderText(c);
        if (c.image) {
          var still = document.createElement("img");
          still.className = "card-still";
          still.src = c.image;
          still.alt = "The scene at the start";
          made.el.appendChild(still);
        } else {
          var video = document.createElement("video");
          video.src = c.video; video.muted = true; video.loop = true; video.autoplay = true; video.playsInline = true;
          made.el.appendChild(video);
        }
        listEl.appendChild(made.el);
      } else if (c.kind === "rose") {
        made.note.textContent = "Not attempted yet";
        canvas = sideCanvas("card-rose", 240);
        drawRoseShape(canvas, c.target, best ? best.plot : null);
        made.el.appendChild(canvas);
        if (best) made.el.classList.add("has-best");
        if (best) made.el.appendChild(bestBox(c, i, best, !!solved[c.id], "Best so far: " + percent(best.inside) + " inside the target"));
        roseListEl.appendChild(made.el);
      } else {
        made.note.textContent = made.locked ? "Not available until the previous challenge is complete" : "Not attempted yet";
        canvas = sideCanvas("card-plot", 160);
        drawLyapShape(canvas, best ? best.plot : null, typeof c.above === "number");
        made.el.appendChild(canvas);
        if (best) made.el.classList.add("has-best");
        if (best) made.el.appendChild(bestBox(c, i, best, !!solved[c.id], "Best so far: " + exponentText(best.lambda)));
        lyapListEl.appendChild(made.el);
      }
    });
  }

  // ---- Play mode ----

  // A Lyapunov level with no best of its own starts from the previous level's best scene, fitted to its rules.
  function inheritedStart(c) {
    var prev = c.kind === "lyap" && c.after && !bestOf(c.id) ? bestOf(c.after) : null;
    if (!prev || !window.ShareUrl) return null;
    var shared;
    try { shared = ShareUrl.decode(prev.link.slice(prev.link.indexOf("#"))); } catch (err) { return null; }
    if (!shared || !shared.scene) return null;
    return "#" + ShareUrl.encode({ page: ShareUrl.PAGE_BUILDER, scene: fitToRules(shared.scene, c) });
  }

  // A copy of an authored scene that meets a level's rules: friction off, velocity inputs, runs at least so
  // long, and at most so many bodies.
  function fitToRules(scene, c) {
    var r = c.rules || {}, s = JSON.parse(JSON.stringify(scene));
    if (c.noFriction) s.friction = 0;
    if (r.velocityInputs) {
      if (s.xInput) s.xInput.property = "vx";
      if (s.yInput) s.yInput.property = "vy";
    }
    if (r.minSteps && !(s.simulationSteps >= r.minSteps)) s.simulationSteps = r.minSteps;
    if (r.noWrap && s.edgeMode === "wrap") s.edgeMode = "sticky";
    if (r.maxBodies && s.bodies.length > r.maxBodies) keepBodies(s, r.maxBodies);
    return s;
  }

  // Keeps `max` bodies, the ones the inputs and output use first, and drops whatever pointed at the rest.
  function keepBodies(s, max) {
    var keep = [], i;
    [s.xInput, s.yInput, s.output].forEach(function (m) {
      [m && m.body, m && m.bodyB].forEach(function (b) {
        if (typeof b === "number" && keep.indexOf(b) === -1 && keep.length < max) keep.push(b);
      });
    });
    // Portals come in pairs: both or neither.
    var pair = s.bodies.map(function (b, k) { return b.type === "portal" ? k : -1; }).filter(function (k) { return k !== -1; });
    for (i = 0; i < s.bodies.length && keep.length < max; i++) {
      if (keep.indexOf(i) !== -1) continue;
      if (pair.indexOf(i) === -1) keep.push(i);
      else if (pair.length === 2 && keep.indexOf(pair[0]) === -1 && keep.indexOf(pair[1]) === -1 && keep.length + 2 <= max) keep.push(pair[0], pair[1]);
    }
    keep.sort(function (a, b) { return a - b; });
    function at(b) { var k = keep.indexOf(b); return k === -1 ? null : k; }
    function mapping(m) {
      if (!m || typeof m.body !== "number") return m;
      if (at(m.body) === null) return null;
      var out = { body: at(m.body), property: m.property };
      if (typeof m.bodyB === "number") {
        if (at(m.bodyB) === null) return m.property === "distance" ? null : out;
        out.bodyB = at(m.bodyB);
      }
      return out;
    }
    function links(list) {
      return (list || []).filter(function (h) {
        return (typeof h.bodyA !== "number" || at(h.bodyA) !== null) && at(h.bodyB) !== null;
      }).map(function (h) {
        var out = JSON.parse(JSON.stringify(h));
        if (typeof h.bodyA === "number") out.bodyA = at(h.bodyA);
        out.bodyB = at(h.bodyB);
        return out;
      });
    }
    s.bodies = keep.map(function (b) { return s.bodies[b]; });
    s.xInput = mapping(s.xInput);
    s.yInput = mapping(s.yInput);
    s.output = mapping(s.output);
    s.hinges = links(s.hinges);
    s.springs = links(s.springs);
  }

  // hash: a map link's "#map/..." to open in place of the challenge's own start. The id gives each challenge
  // its own address: two that differ only after the "#" would not reload the frame.
  function frameAddress(c, hash) {
    var query = c.kind === "trick" ? "?goal=" + c.goal.join(".")
      : c.kind === "rose" ? "?rose=1"
        : "?lyap=1" + (c.noFriction ? "&fric=0" : "") + (c.rules && c.rules.velocityInputs ? "&vin=1" : "");
    var start = c.kind === "trick" ? "#map/" + c.scene : hash || "#bldr/" + c.scene;
    return APP + query + "&challenge=" + c.id + start;
  }

  function showToast(text) {
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(function () { toast.hidden = true; }, 2200);
  }

  // link: a kept best's map link, opened in the challenge frame.
  function play(index, link) {
    if (!playPage.hidden && frameDepth > 0) {
      var back = frameDepth;
      frameDepth = 0;
      afterBack = function () { play(index, link); };
      history.go(-back);
      return;
    }
    var state = { challenge: challenges[index].id, link: link || null };
    try {
      if (playPage.hidden) history.pushState(state, "");
      else history.replaceState(state, "");
    } catch (err) { /* no entry: All challenges then calls leave() */ }
    show(index, link);
  }

  function show(index, link) {
    current = index;
    frameDepth = (history.state && history.state.depth) || 0;
    frameStops = [];
    var c = challenges[index];
    // A loaded best reporting its own exponent again is no new win, unless it never won.
    wonThisPlay = !!link && !!readStore(SOLVED_KEY)[c.id];
    pictureWanted = !!link;
    playTitle.textContent = c.title;
    winPanel.hidden = true;
    toast.hidden = true;
    setBestShown(false);
    setTargetMedia(c);
    targetRose.hidden = c.kind !== "rose";
    targetPlot.hidden = c.kind !== "lyap";
    scoreEl.hidden = c.kind !== "lyap";
    btnBest.hidden = !keepsBest(c);
    if (c.kind === "trick") {
      targetOrder.textContent = orderText(c);
      targetHelp.innerHTML = "Find the starting point that does this. Zoom in on the map until a <b>GOAL!</b> patch appears, then click it.";
    }
    if (c.kind === "rose") {
      drawRoseShape(targetRose, c.target, null);
      targetOrder.textContent = "The target, in gold";
      targetHelp.innerHTML = "Build a scene, open its map, and shape the view until the whole <b>Rose Plot</b> sits inside the gold outline. The Analysis card measures each view.";
      updateRoseScore(null);
    }
    if (c.kind === "lyap") {
      drawLyapShape(targetPlot, null, typeof c.above === "number");
      targetOrder.textContent = "Goal: Lyapunov exponent " + (typeof c.above === "number" ? "above " + c.above : "below 0");
      targetHelp.textContent = "Build a scene, open its map and inspect a line to show the Lyapunov exponent. " +
        (typeof c.above === "number" ? "A scene with a large positive Lyapunov exponent pulls nearby runs apart fast."
          : "A scene with a negative Lyapunov exponent will reduce separation over time.") +
        (rulesText(c) ? " " + rulesText(c) : "");
      updateLyapScore(null);
    }
    setTargetShown(true);
    listPage.hidden = true;
    playPage.hidden = false;
    document.title = c.title + ": Chaos Accelerator";
    // replace(): a frame load must not add a history entry of its own.
    engine.contentWindow.location.replace(frameAddress(c, link ? link.slice(link.indexOf("#")) : inheritedStart(c)));
  }

  function backToList() {
    var state = history.state;
    if (state && state.challenge) history.go(-frameDepth - 1);
    else leave();
  }

  // A frame move: Back to scene editor after a Fractal-ize steps back, any other move adds an entry.
  function onFrameNavigate(which) {
    var state = history.state;
    if (playPage.hidden || !state || !state.challenge) return;
    try { frameStops[frameDepth] = engine.contentWindow.location.hash; } catch (err) { /* stays unknown */ }
    if (which === "editor" && state.view === "grid") {
      frameDepth--;
      afterBack = function () {};
      history.back();
      return;
    }
    frameStops.length = frameDepth + 1;
    try {
      history.pushState({ challenge: state.challenge, link: state.link, depth: frameDepth + 1, view: which }, "");
      frameDepth++;
    } catch (err) { /* no entry for this step */ }
  }

  // Back or Forward to another entry of this play: the frame follows through its own address, as chaos.html does.
  function steerFrame(depth) {
    var w = engine.contentWindow, from = frameDepth;
    frameDepth = depth;
    try {
      w.AppShell.syncAddress();
      frameStops[from] = w.location.hash;
      if (frameStops[depth] !== frameStops[from]) w.location.replace(w.location.pathname + w.location.search + frameStops[depth]);
    } catch (err) { /* the frame isn't up */ }
  }

  function leave() {
    stopWatch();
    playPage.hidden = true;
    listPage.hidden = false;
    engine.contentWindow.location.replace("about:blank");
    targetVideo.removeAttribute("src");
    document.title = "Challenges: Chaos Accelerator";
    renderLists();
  }

  // A trick shot's video, or for one whose video would give the answer away ("image"), a still of its start.
  function setTargetMedia(c) {
    var video = c.kind === "trick" && !c.image, still = c.kind === "trick" && !!c.image;
    targetVideo.hidden = !video;
    targetImage.hidden = !still;
    if (video) targetVideo.src = c.video; else targetVideo.removeAttribute("src");
    if (still) targetImage.src = c.image; else targetImage.removeAttribute("src");
  }
  function setTargetShown(shown) {
    targetPanel.hidden = !shown;
    btnTarget.textContent = shown ? "Hide target" : "Show target";
    btnTarget.setAttribute("aria-pressed", shown ? "true" : "false");
  }
  function setBestShown(shown) {
    var c = challenges[current], best = c && keepsBest(c) ? bestOf(c.id) : null;
    if (shown && !best) { showToast("No attempt measured yet."); shown = false; }
    bestPanel.hidden = !shown;
    btnBest.textContent = shown ? "Hide best" : "Show best";
    btnBest.setAttribute("aria-pressed", shown ? "true" : "false");
    if (!shown) return;
    bestRose.hidden = c.kind !== "rose";
    bestPlot.hidden = c.kind !== "lyap";
    if (c.kind === "rose") {
      drawRoseShape(bestRose, c.target, best.plot);
      bestText.textContent = "Best: " + percent(best.inside) + " inside the target";
    } else {
      drawLyapShape(bestPlot, best.plot, typeof c.above === "number");
      bestText.textContent = "Best exponent: " + exponentText(best.lambda);
    }
    bestLink.href = best.link;
  }
  btnTarget.addEventListener("click", function () { setTargetShown(targetPanel.hidden); });
  btnBest.addEventListener("click", function () { setBestShown(bestPanel.hidden); });
  $("best-close").addEventListener("click", function () { setBestShown(false); });
  $("best-load").addEventListener("click", function () {
    var best = bestOf(challenges[current].id);
    if (best) play(current, best.link);
  });
  $("btn-back").addEventListener("click", backToList);
  btnResetAll.addEventListener("click", function () {
    askConfirm("Reset all challenges?", "Every best attempt and Solved mark will be cleared.", "Reset all", function () {
      writeStore(BEST_KEY, {});
      writeStore(SOLVED_KEY, {});
      writeStore(CELEBRATED_KEY, {});
      renderLists();
    });
  });

  // Yes or no in the page's own dialog: Cancel, Escape or a click outside the card says no.
  var confirmYes = null;
  function askConfirm(title, text, action, onYes) {
    confirmTitle.textContent = title;
    confirmText.textContent = text;
    confirmOk.textContent = action;
    confirmYes = onYes;
    confirmDialog.showModal();
  }
  confirmDialog.addEventListener("close", function () { confirmYes = null; });
  confirmDialog.addEventListener("click", function (e) { if (e.target === confirmDialog) confirmDialog.close(); });
  $("confirm-cancel").addEventListener("click", function () { confirmDialog.close(); });
  confirmOk.addEventListener("click", function () {
    var yes = confirmYes;
    confirmDialog.close();
    if (yes) yes();
  });
  $("win-list").addEventListener("click", backToList);
  $("win-close").addEventListener("click", function () { winPanel.hidden = true; });
  $("win-next").addEventListener("click", function () {
    var next = (current + 1) % challenges.length;
    while (isLocked(challenges[next]) && next !== current) next = (next + 1) % challenges.length;
    play(next);
  });

  // The frame's own map link, for the win screen and the best (the address bar of a frame is not visible).
  function currentMapLink() {
    var w = engine.contentWindow;
    try {
      var state = w.FractalGrid.shareState();
      if (!state) return null;
      return APP + "#" + w.ShareUrl.encode({
        page: w.ShareUrl.PAGE_MAP,
        scene: w.PhysicsCoords.toAuthoredJSON(state.scene),
        view: state.view,
      });
    } catch (err) {
      return null;
    }
  }

  // The frame's scene drawn by its builder code, as a JPEG data URL; null if the frame can't.
  function scenePicture() {
    var w = engine.contentWindow;
    try {
      var state = w.FractalGrid.shareState(), scene = state && state.scene;
      if (!scene || !w.PhysicsUI) return null;
      var fw = scene.frameWidth || 1, fh = scene.frameHeight || 1, k = PICTURE_LONG_SIDE / Math.max(fw, fh);
      var canvas = document.createElement("canvas");
      canvas.width = Math.round(fw * k);
      canvas.height = Math.round(fh * k);
      var ctx = canvas.getContext("2d");
      ctx.fillStyle = "#14161c";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(k, 0, 0, k, 0, 0);
      w.PhysicsUI.drawGridOver(ctx, fw, fh, 0, 0, fw, fh);
      w.PhysicsUI.drawSceneBodies(ctx, scene.bodies);
      w.PhysicsUI.drawSceneSprings(ctx, scene);
      w.PhysicsUI.drawSceneHinges(ctx, scene);
      return canvas.toDataURL("image/jpeg", 0.85);
    } catch (err) {
      return null;
    }
  }
  // After a Load best, the first result comes from the best's own scene.
  function fillPicture(c) {
    if (!pictureWanted) return;
    pictureWanted = false;
    var best = bestOf(c.id);
    if (!best || best.picture) return;
    best.picture = scenePicture();
    if (best.picture) saveBest(c.id, best);
  }

  function win(text) {
    var c = challenges[current];
    markSolved(c.id);
    var solved = readStore(SOLVED_KEY), allDone = challenges.every(function (ch) { return solved[ch.id]; });
    if (allDone && !readStore(CELEBRATED_KEY).done) {
      writeStore(CELEBRATED_KEY, { done: true });
      celebrate();
    }
    winText.textContent = text;
    var link = currentMapLink();
    winLink.hidden = !link;
    if (link) winLink.href = link;
    winPanel.hidden = false;
  }

  // ---- Trick Shot: a press that does not turn into a pan is a guess ----

  function guess(clientX, clientY) {
    var w = engine.contentWindow;
    var hit = null;
    try { hit = w.FractalGrid && w.FractalGrid.goalAt ? w.FractalGrid.goalAt(clientX, clientY) : null; } catch (err) { hit = null; }
    if (hit === null) { showToast("Still preparing the map. Try again in a moment."); return; }
    if (!hit) { showToast("Not there. Keep looking."); return; }
    win("You found the " + challenges[current].title + " starting point.");
  }

  function bindTrickShot(doc) {
    var canvas = doc.getElementById("grid-canvas");
    if (!canvas) return;
    var down = null;
    canvas.addEventListener("mousedown", function (e) { if (e.button === 0) down = { x: e.clientX, y: e.clientY }; });
    canvas.addEventListener("mouseup", function (e) {
      if (!down || e.button !== 0) return;
      var moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved <= CLICK_SLOP_PX) guess(e.clientX, e.clientY);
    });
    canvas.addEventListener("touchstart", function (e) {
      down = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
    }, { passive: true });
    canvas.addEventListener("touchend", function (e) {
      if (!down || e.changedTouches.length !== 1 || e.touches.length) { down = null; return; }
      var t = e.changedTouches[0];
      var moved = Math.hypot(t.clientX - down.x, t.clientY - down.y);
      down = null;
      if (moved <= CLICK_SLOP_PX) guess(t.clientX, t.clientY);
    }, { passive: true });
  }

  // ---- Rose Plot Targets ----

  // Shown under the rose in the frame's Analysis card.
  function updateRoseScore(inside) {
    var text = "Inside the target: " + (inside === null ? "not measured yet" : percent(inside));
    try { engine.contentWindow.FractalStatsPanel.setRoseChallengeText(text); } catch (err) { /* the frame isn't up yet */ }
  }

  function onRoseResult(orient) {
    var c = challenges[current];
    if (!c || c.kind !== "rose") return;
    var plot = coarseRose(orient, c.target.length);
    if (!plot) return;
    var inside = insideShare(plot, c.target);
    fillPicture(c);
    var best = bestOf(c.id);
    if (!best || !(inside <= best.inside)) {
      var link = currentMapLink();
      if (link) {
        saveBest(c.id, { inside: inside, plot: plot, link: link, picture: scenePicture() });
        if (!bestPanel.hidden) setBestShown(true);
      }
    }
    updateRoseScore(inside);
    if (inside >= ROSE_WIN && winPanel.hidden && !readStore(SOLVED_KEY)[c.id]) {
      win("The whole Rose Plot fits inside the target.");
    }
  }

  // A card measures only while it is open: open it each time the map comes up.
  function startWatch(w, menuId, buttonId) {
    stopWatch();
    var wasGrid = false;
    watch = setInterval(function () {
      var gridView, isGrid;
      try {
        gridView = w.document.getElementById("grid-view");
        isGrid = !!gridView && !gridView.hidden && w.AppShell && !w.AppShell.debugIsRunning();
      } catch (err) { return; }
      if (isGrid && !wasGrid) {
        var item = w.document.getElementById(menuId), btn = w.document.getElementById(buttonId);
        if (item && btn && !item.classList.contains("is-open")) btn.click();
      }
      wasGrid = isGrid;
    }, 400);
  }
  function stopWatch() {
    if (watch) clearInterval(watch);
    watch = null;
  }

  function bindRose(w) {
    var c = challenges[current];
    if (!w.FractalStatsPanel) return;
    w.FractalStatsPanel.setRoseChallenge({ target: c.target, onResult: onRoseResult });
    updateRoseScore(null);
    startWatch(w, "menu-stats", "grid-btn-stats");
  }

  // ---- Lyapunov ----

  // status: what to show without an exponent.
  function updateLyapScore(lambda, status) {
    var c = challenges[current], best = bestOf(c.id);
    var html = "Lyapunov exponent: <b>" + (lambda === null ? status || "inspect a line" : exponentText(lambda)) + "</b>";
    if (best) html += " &middot; Best: <b>" + exponentText(best.lambda) + "</b>";
    scoreEl.innerHTML = html;
    scoreEl.classList.toggle("score-win", lambda !== null && lyapWins(c, lambda));
  }

  // A Lyapunov level's extra rules ("rules" in lyapunov.json, plus noFriction), as one line.
  function rulesText(c) {
    var r = c.rules || {}, parts = [];
    if (c.noFriction) parts.push("no friction");
    if (r.velocityInputs) parts.push("both inputs are velocities");
    if (r.maxBodies) parts.push("at most " + r.maxBodies + " objects");
    if (r.noWrap) parts.push("no Pac-Man Warp edges");
    if (r.minSteps) parts.push("every run lasts at least " + r.minSteps + " steps, none stopping at an edge");
    if (r.nearby) parts.push("a short line (no longer than the screen's height at 100x zoom)");
    // The section's intro asks for a negative exponent; a level won above a number says so itself.
    var goal = typeof c.above === "number" ? "Make the exponent above " + c.above + ". " : "";
    return goal + (parts.length ? "Rules: " + parts.join(", ") + "." : "");
  }
  function isVelocity(mapping) { return !!mapping && (mapping.property === "vx" || mapping.property === "vy"); }
  // Why a result breaks the level's rules, or null. Every level inspects lines only.
  function ruleProblem(c, result) {
    var w = engine.contentWindow, state, scene, r = c.rules || {};
    try { state = w.FractalGrid.shareState(); scene = state.scene; } catch (err) { return null; }
    if (state.view.inspect.some(function (g) { return g.type !== "line"; })) return "Inspect with a line for this one.";
    if (c.noFriction && w.PhysicsEngine.frictionOf(scene) > 0) return "Friction has to stay off for this one.";
    if (r.velocityInputs && !(isVelocity(scene.xInput) && isVelocity(scene.yInput))) return "Both inputs have to be velocities for this one.";
    if (r.maxBodies && scene.bodies.length > r.maxBodies) return "Use at most " + r.maxBodies + " objects for this one.";
    if (r.noWrap && scene.edgeMode === "wrap") return "Pac-Man Warp edges aren't allowed for this one.";
    if (r.minSteps && !(result.shortest >= r.minSteps)) return "Every run has to last at least " + r.minSteps + " steps, none stopping at an edge, for this one.";
    if (r.nearby && !(result.gap <= NEARBY_GAP)) return "Draw a shorter line, no longer than the screen's height at 100x zoom.";
    return null;
  }

  function onLyapResult(result) {
    var c = challenges[current];
    if (!c || c.kind !== "lyap") return;
    var lambda = result && typeof result.lambda === "number" && isFinite(result.lambda) ? result.lambda : null;
    var separates = !!result && Array.prototype.some.call(result.distance, function (v) { return v > 0; });
    var status = !result ? null : separates ? "too short to measure" : "none, the runs never separate";
    var problem = lambda !== null ? ruleProblem(c, result) : null;
    if (problem) {
      showToast(problem);
      lambda = null;
      status = "not counted, see the rules";
    }
    if (lambda !== null) {
      fillPicture(c);
      var best = bestOf(c.id);
      if (!best || lyapBetter(c, lambda, best.lambda)) {
        var link = currentMapLink();
        if (link) {
          saveBest(c.id, { lambda: lambda, plot: logSamples(result.distance), link: link, picture: scenePicture() });
          if (!bestPanel.hidden) setBestShown(true);
        }
      }
    }
    updateLyapScore(lambda, status);
    if (lambda !== null && lyapWins(c, lambda) && !wonThisPlay) {
      wonThisPlay = true;
      win(typeof c.above === "number" ? "The runs fly apart: a Lyapunov exponent above " + c.above + "." : "The runs draw together: a negative Lyapunov exponent.");
    }
  }

  function bindLyap(w) {
    if (!w.FractalGrid || !w.FractalGrid.setLyapunovChallenge) return;
    w.FractalGrid.setLyapunovChallenge({ onResult: onLyapResult });
    startWatch(w, "menu-inspect", "grid-btn-inspect");
  }

  // Listeners are bound inside the frame's document once it loads; the map's canvas is in its markup from
  // the start, so nothing waits on the map.
  engine.addEventListener("load", function () {
    var c = challenges[current];
    var doc = engine.contentDocument;
    if (!c || !doc || !doc.getElementById) return;
    if (engine.contentWindow.AppShell) engine.contentWindow.AppShell.onNavigate = onFrameNavigate;
    if (c.kind === "trick") bindTrickShot(doc);
    else if (c.kind === "rose") bindRose(engine.contentWindow);
    else bindLyap(engine.contentWindow);
  });

  window.addEventListener("popstate", function (e) {
    if (afterBack) {
      var then = afterBack;
      afterBack = null;
      then();
      return;
    }
    var index = playIndex(e.state), depth = (e.state && e.state.depth) || 0;
    var thisPlay = index !== -1 && index === current && !playPage.hidden;
    if (index === -1) {
      if (!playPage.hidden) leave();
    } else if (thisPlay && frameStops[depth]) {
      steerFrame(depth);
    } else if (thisPlay && depth < frameDepth) {
      // An entry from before the frame last loaded (a reload): Back goes on to the list.
      history.go(-depth - 1);
    } else {
      show(index, e.state.link);
    }
  });
  function playIndex(state) {
    for (var i = 0; state && state.challenge && i < challenges.length; i++) {
      if (challenges[i].id === state.challenge) return isLocked(challenges[i]) ? -1 : i;
    }
    return -1;
  }

  // ---- Start ----

  function fetchJSON(name) {
    return fetch(name, { cache: "no-cache" }).then(function (r) { return r.json(); });
  }
  function ofKind(data, kind) {
    return (data.challenges || []).map(function (c) { c.kind = kind; return c; });
  }
  Promise.all([fetchJSON("trick-shot.json"), fetchJSON("analysis-maxing.json"), fetchJSON("lyapunov.json")]).then(function (data) {
    challenges = ofKind(data[0], "trick").concat(ofKind(data[1], "rose"), ofKind(data[2], "lyap"));
    renderLists();
    // Every visit with everything solved gets the confetti.
    var solved = readStore(SOLVED_KEY);
    if (challenges.length && challenges.every(function (c) { return solved[c.id]; })) celebrate();
    // A reload on a challenge's entry opens it again.
    var index = playIndex(history.state);
    if (index !== -1) show(index, history.state.link);
  }).catch(function () {
    listEl.textContent = "The challenge list couldn't be loaded.";
  });
})();
