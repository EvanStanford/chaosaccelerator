// CPAL-1.0 License. See chaosaccelerator.com/license.html

// Challenges: lists read from trick-shot.json and analysis-maxing.json, and play mode, which loads
// chaos.html in a frame.
//   Trick Shot: ?goal=<bounce order>, so the map paints the goal region clear (challenge-frame.css and, in
//   fractal-grid.js, challengeGoalOrder). A plain click on the map asks the frame whether the pixel under it
//   is a goal pixel (FractalGrid.goalAt): yes wins, there is no closest-so-far.
//   Analysis Maxing: ?rose=1. The target is handed to the frame's stats panel (FractalStatsPanel
//   .setRoseChallenge), which draws it over the Rose Plot and reports each measurement back here. The score
//   is the share of the rose outside the target; the best score and its map link are kept per challenge.
(function () {
  "use strict";

  var APP = "../chaos.html";
  var SOLVED_KEY = "chaosChallengesSolved";
  var BEST_KEY = "chaosChallengesBest";
  var CLICK_SLOP_PX = 5;
  var ROSE_WIN = 0.0005;

  function $(id) { return document.getElementById(id); }
  var listPage = $("list-page"), listEl = $("challenge-list"), roseListEl = $("rose-list");
  var playPage = $("play-page"), playTitle = $("play-title"), engine = $("engine");
  var targetPanel = $("target-panel"), targetVideo = $("target-video"), targetRose = $("target-rose");
  var targetOrder = $("target-order"), targetHelp = $("target-help"), btnTarget = $("btn-target");
  var scoreEl = $("score"), btnBest = $("btn-best"), bestPanel = $("best-panel"), bestRose = $("best-rose");
  var bestText = $("best-text"), bestLink = $("best-link");
  var toast = $("toast"), winPanel = $("win-panel"), winText = $("win-text"), winLink = $("win-link");

  var challenges = [];
  var current = -1;
  var watch = null;

  function readStore(key) {
    try { return JSON.parse(localStorage.getItem(key) || "{}") || {}; } catch (err) { return {}; }
  }
  function writeStore(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (err) { /* private mode */ }
  }
  function markSolved(id) {
    var set = readStore(SOLVED_KEY);
    set[id] = true;
    writeStore(SOLVED_KEY, set);
  }
  function bestOf(id) { return readStore(BEST_KEY)[id] || null; }
  function saveBest(id, entry) {
    var all = readStore(BEST_KEY);
    all[id] = entry;
    writeStore(BEST_KEY, all);
  }

  function orderText(goal) {
    return "Bounce order: " + goal.map(function (b) { return "body " + b; }).join(", ");
  }
  function percent(v) { return (v * 100).toFixed(1) + "%"; }

  // ---- A small rose: the target as a gold outline, a plot (shares per slice) as the blue fill ----
  function drawRoseShape(canvas, target, plot) {
    var ctx = canvas.getContext("2d");
    var w = canvas.width, h = canvas.height, cx = w / 2, cy = h / 2, radius = Math.min(cx, cy) - 14;
    ctx.clearRect(0, 0, w, h);
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
    if (plot) {
      polygon(plot, 1);
      ctx.fillStyle = "rgba(91, 140, 255, 0.28)";
      ctx.fill();
      ctx.strokeStyle = "#5b8cff";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    polygon(target, 0.01);
    ctx.strokeStyle = "#c9a227";
    ctx.lineWidth = 2;
    ctx.stroke();
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
  function outsideShare(plot, target) {
    var s = 0;
    for (var i = 0; i < target.length; i++) s += Math.max(0, plot[i] - target[i] / 100);
    return s;
  }

  // ---- The lists ----

  function card(c, i, solved) {
    var el = document.createElement("article");
    el.className = "challenge-card";
    var text = document.createElement("div");
    var h = document.createElement("h3");
    h.textContent = c.title;
    if (solved) {
      var badge = document.createElement("span");
      badge.className = "solved";
      badge.textContent = "Solved";
      h.appendChild(badge);
    }
    var p = document.createElement("p");
    p.textContent = c.blurb;
    var note = document.createElement("p");
    note.className = "order";
    var btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = solved ? "Play again" : "Play";
    btn.addEventListener("click", function () { play(i); });
    text.appendChild(h); text.appendChild(p); text.appendChild(note); text.appendChild(btn);
    el.appendChild(text);
    return { el: el, note: note };
  }

  function renderLists() {
    var solved = readStore(SOLVED_KEY);
    listEl.textContent = "";
    roseListEl.textContent = "";
    challenges.forEach(function (c, i) {
      var made = card(c, i, !!solved[c.id]);
      if (c.kind === "trick") {
        made.note.textContent = orderText(c.goal);
        var video = document.createElement("video");
        video.src = c.video; video.muted = true; video.loop = true; video.autoplay = true; video.playsInline = true;
        made.el.appendChild(video);
        listEl.appendChild(made.el);
      } else {
        var best = bestOf(c.id);
        made.note.textContent = best ? "Best so far: " + percent(best.outside) + " outside the target" : "Not attempted yet";
        var canvas = document.createElement("canvas");
        canvas.className = "card-rose";
        canvas.width = 240; canvas.height = 240;
        drawRoseShape(canvas, c.target, best ? best.plot : null);
        made.el.appendChild(canvas);
        roseListEl.appendChild(made.el);
      }
    });
  }

  // ---- Play mode ----

  function frameAddress(c) {
    if (c.kind === "trick") return APP + "?goal=" + c.goal.join(".") + "#map/" + c.scene;
    return APP + "?rose=1#bldr/" + c.scene;
  }

  function showToast(text) {
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(function () { toast.hidden = true; }, 2200);
  }

  function play(index) {
    current = index;
    var c = challenges[index];
    playTitle.textContent = c.title;
    winPanel.hidden = true;
    toast.hidden = true;
    setBestShown(false);
    if (c.kind === "trick") {
      targetVideo.hidden = false;
      targetVideo.src = c.video;
      targetRose.hidden = true;
      targetOrder.textContent = orderText(c.goal);
      targetHelp.innerHTML = "Find the starting point where the ball bounces in this order. Zoom in on the map until a <b>GOAL!</b> patch appears, then click it.";
      scoreEl.hidden = true;
      btnBest.hidden = true;
    } else {
      targetVideo.hidden = true;
      targetVideo.removeAttribute("src");
      targetRose.hidden = false;
      drawRoseShape(targetRose, c.target, null);
      targetOrder.textContent = "The target, in gold";
      targetHelp.innerHTML = "Build a scene, open its map, and shape the view until the whole <b>Rose Plot</b> sits inside the gold outline. The Analysis card measures each view.";
      scoreEl.hidden = false;
      btnBest.hidden = false;
      updateScore(null);
    }
    setTargetShown(true);
    listPage.hidden = true;
    playPage.hidden = false;
    document.title = c.title + ": Chaos Accelerator";
    engine.src = frameAddress(c);
  }

  function leave() {
    stopWatch();
    playPage.hidden = true;
    listPage.hidden = false;
    engine.src = "about:blank";
    targetVideo.removeAttribute("src");
    document.title = "Challenges: Chaos Accelerator";
    renderLists();
  }

  function setTargetShown(shown) {
    targetPanel.hidden = !shown;
    btnTarget.textContent = shown ? "Hide target" : "Show target";
    btnTarget.setAttribute("aria-pressed", shown ? "true" : "false");
  }
  function setBestShown(shown) {
    var c = challenges[current], best = c && bestOf(c.id);
    if (shown && !best) { showToast("No attempt measured yet."); shown = false; }
    bestPanel.hidden = !shown;
    btnBest.textContent = shown ? "Hide best" : "Show best";
    btnBest.setAttribute("aria-pressed", shown ? "true" : "false");
    if (shown) {
      drawRoseShape(bestRose, c.target, best.plot);
      bestText.textContent = "Best: " + percent(best.outside) + " outside the target";
      bestLink.href = best.link;
    }
  }
  btnTarget.addEventListener("click", function () { setTargetShown(targetPanel.hidden); });
  btnBest.addEventListener("click", function () { setBestShown(bestPanel.hidden); });
  $("btn-back").addEventListener("click", leave);
  $("win-list").addEventListener("click", leave);
  $("win-close").addEventListener("click", function () { winPanel.hidden = true; });
  $("win-next").addEventListener("click", function () { play((current + 1) % challenges.length); });

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

  function win(text) {
    var c = challenges[current];
    markSolved(c.id);
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

  // ---- Analysis Maxing ----

  function updateScore(outside) {
    var c = challenges[current], best = bestOf(c.id);
    var html = outside === null ? "Outside the target: <b>not measured yet</b>" : "Outside the target: <b>" + percent(outside) + "</b>";
    if (best) html += " &middot; Best: <b>" + percent(best.outside) + "</b>";
    scoreEl.innerHTML = html;
    scoreEl.classList.toggle("score-win", outside !== null && outside <= ROSE_WIN);
  }

  function onRoseResult(orient) {
    var c = challenges[current];
    if (!c || c.kind !== "rose") return;
    var plot = coarseRose(orient, c.target.length);
    if (!plot) return;
    var outside = outsideShare(plot, c.target);
    var best = bestOf(c.id);
    if (!best || outside < best.outside) {
      var link = currentMapLink();
      if (link) {
        saveBest(c.id, { outside: outside, plot: plot, link: link });
        if (!bestPanel.hidden) setBestShown(true);
      }
    }
    updateScore(outside);
    if (outside <= ROSE_WIN && winPanel.hidden && !readStore(SOLVED_KEY)[c.id]) {
      win("The whole Rose Plot fits inside the target.");
    }
  }

  // The Analysis card measures only while it is open: open it each time the map comes up.
  function startWatch(w) {
    stopWatch();
    var wasGrid = false;
    watch = setInterval(function () {
      var gridView, isGrid;
      try {
        gridView = w.document.getElementById("grid-view");
        isGrid = !!gridView && !gridView.hidden && w.AppShell && !w.AppShell.debugIsRunning();
      } catch (err) { return; }
      if (isGrid && !wasGrid) {
        var item = w.document.getElementById("menu-stats"), btn = w.document.getElementById("grid-btn-stats");
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
    startWatch(w);
  }

  // Listeners are bound inside the frame's document once it loads; the map's canvas is in its markup from
  // the start, so nothing waits on the map.
  engine.addEventListener("load", function () {
    var c = challenges[current];
    var doc = engine.contentDocument;
    if (!c || !doc || !doc.getElementById) return;
    if (c.kind === "trick") bindTrickShot(doc);
    else bindRose(engine.contentWindow);
  });

  // ---- Start ----

  function fetchJSON(name) {
    return fetch(name, { cache: "no-cache" }).then(function (r) { return r.json(); });
  }
  Promise.all([fetchJSON("trick-shot.json"), fetchJSON("analysis-maxing.json")]).then(function (data) {
    challenges = (data[0].challenges || []).map(function (c) { c.kind = "trick"; return c; })
      .concat((data[1].challenges || []).map(function (c) { c.kind = "rose"; return c; }));
    renderLists();
  }).catch(function () {
    listEl.textContent = "The challenge list couldn't be loaded.";
  });
})();
