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
//   Lyapunov: ?lyap=1 (&fric=0 without friction). The frame reports each inspected pair's exponent
//   (FractalGrid.setLyapunovChallenge); below zero wins, and the most negative is kept.
(function () {
  "use strict";

  var APP = "../chaos.html";
  var SOLVED_KEY = "chaosChallengesSolved";
  var BEST_KEY = "chaosChallengesBest";
  var CLICK_SLOP_PX = 5;
  // Shows as 100.0%.
  var ROSE_WIN = 0.9995;
  // Exponents show to 3 places; this is the first that shows as negative.
  var LYAP_WIN = -0.0005;
  var LYAP_PLOT_SAMPLES = 120;

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

  // A goal event is a body number (a bounce off it) or "w" and a port hole's number (in through it).
  function portholeColors(scene) {
    var m = /(?:^|,)body:([^,]*)/.exec(scene), colors = {};
    (m ? m[1].split(";") : []).forEach(function (b, i) {
      if (/^po:/.test(b)) colors[i] = "orange";
      else if (/^pg:/.test(b)) colors[i] = "green";
    });
    return colors;
  }
  function eventText(token, colors) {
    if (token.charAt(0) !== "w") return token;
    return colors[Number(token.slice(1))] === "green" ? "green to orange" : "orange to green";
  }
  function orderText(c) {
    var goal = c.goal.map(String), colors = portholeColors(c.scene);
    var repeated = goal.length > 1 && goal.every(function (t) { return t === goal[0]; });
    if (repeated && goal[0].charAt(0) === "w") return "Through the port holes " + eventText(goal[0], colors) + ", " + goal.length + " times";
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
    [["yours", "#5b8cff"], ["goal", "#c9a227"]].forEach(function (item) {
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
    polygon(target, 0.01);
    ctx.strokeStyle = "#c9a227";
    ctx.lineWidth = 2;
    ctx.stroke();
    if (plot) {
      polygon(plot, 1);
      ctx.fillStyle = "rgba(91, 140, 255, 0.28)";
      ctx.fill();
      ctx.strokeStyle = "#5b8cff";
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
  function drawLyapShape(canvas, plot) {
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
    ctx.strokeStyle = "#c9a227";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    ctx.setLineDash([]);
    if (!plot) return;
    drawLegend(ctx, w);
    var lo = Infinity, hi = -Infinity;
    plot.forEach(function (v) { if (v !== null) { lo = Math.min(lo, v); hi = Math.max(hi, v); } });
    if (!(hi >= lo)) return;
    if (hi - lo < 1) { lo = (hi + lo) / 2 - 0.5; hi = lo + 1; }
    ctx.strokeStyle = "#5b8cff";
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

  function renderLists() {
    var solved = readStore(SOLVED_KEY);
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
        drawLyapShape(canvas, best ? best.plot : null);
        made.el.appendChild(canvas);
        if (best) made.el.classList.add("has-best");
        if (best) made.el.appendChild(bestBox(c, i, best, !!solved[c.id], "Best so far: " + exponentText(best.lambda)));
        lyapListEl.appendChild(made.el);
      }
    });
  }

  // ---- Play mode ----

  // hash: a map link's "#map/..." to open in place of the challenge's own start. The id gives each challenge
  // its own address: two that differ only after the "#" would not reload the frame.
  function frameAddress(c, hash) {
    var query = c.kind === "trick" ? "?goal=" + c.goal.join(".")
      : c.kind === "rose" ? "?rose=1" : "?lyap=1" + (c.noFriction ? "&fric=0" : "");
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
    current = index;
    // A loaded best reporting its own exponent again is no new win.
    wonThisPlay = !!link;
    pictureWanted = !!link;
    var c = challenges[index];
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
      drawLyapShape(targetPlot, null);
      targetOrder.textContent = "Goal: Lyapunov exponent below 0";
      targetHelp.innerHTML = "Build a scene, open its map and inspect a line to show the Lyapunov exponent. A scene with a negative Lyapunov exponent will reduce separation over time.";
      updateLyapScore(null);
    }
    setTargetShown(true);
    listPage.hidden = true;
    playPage.hidden = false;
    document.title = c.title + ": Chaos Accelerator";
    engine.src = frameAddress(c, link ? link.slice(link.indexOf("#")) : null);
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
      drawLyapShape(bestPlot, best.plot);
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
  $("btn-back").addEventListener("click", leave);
  btnResetAll.addEventListener("click", function () {
    askConfirm("Reset all challenges?", "Every best attempt and Solved mark will be cleared.", "Reset all", function () {
      writeStore(BEST_KEY, {});
      writeStore(SOLVED_KEY, {});
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
  $("win-list").addEventListener("click", leave);
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
    var html = "Lyapunov exponent: <b>" + (lambda === null ? status || "inspect two points" : exponentText(lambda)) + "</b>";
    if (best) html += " &middot; Best: <b>" + exponentText(best.lambda) + "</b>";
    scoreEl.innerHTML = html;
    scoreEl.classList.toggle("score-win", lambda !== null && lambda <= LYAP_WIN);
  }

  function frameFriction() {
    var w = engine.contentWindow;
    try { return w.PhysicsEngine.frictionOf(w.FractalGrid.shareState().scene); } catch (err) { return 0; }
  }

  function onLyapResult(result) {
    var c = challenges[current];
    if (!c || c.kind !== "lyap") return;
    var lambda = result && typeof result.lambda === "number" && isFinite(result.lambda) ? result.lambda : null;
    var separates = !!result && Array.prototype.some.call(result.distance, function (v) { return v > 0; });
    var status = !result ? null : separates ? "too short to measure" : "none, the runs never separate";
    if (lambda !== null && c.noFriction && frameFriction() > 0) {
      showToast("Friction has to stay off for this one.");
      lambda = null;
      status = "not counted with friction on";
    }
    if (lambda !== null) {
      fillPicture(c);
      var best = bestOf(c.id);
      if (!best || lambda < best.lambda) {
        var link = currentMapLink();
        if (link) {
          saveBest(c.id, { lambda: lambda, plot: logSamples(result.distance), link: link, picture: scenePicture() });
          if (!bestPanel.hidden) setBestShown(true);
        }
      }
    }
    updateLyapScore(lambda, status);
    if (lambda !== null && lambda <= LYAP_WIN && !wonThisPlay) {
      wonThisPlay = true;
      win("The two runs draw together: a negative Lyapunov exponent.");
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
    if (c.kind === "trick") bindTrickShot(doc);
    else if (c.kind === "rose") bindRose(engine.contentWindow);
    else bindLyap(engine.contentWindow);
  });

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
  }).catch(function () {
    listEl.textContent = "The challenge list couldn't be loaded.";
  });
})();
