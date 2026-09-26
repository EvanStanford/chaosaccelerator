// CPAL-1.0 License. See chaosaccelerator.com/license.html

// Challenges: a list read from trick-shot.json, and play mode, which loads chaos.html in a frame with
// ?goal=<bounce order> so the map paints the goal region clear (see challenge-frame.css and, in
// fractal-grid.js, challengeGoalOrder). A plain click on the map asks the frame whether the pixel under
// it is a goal pixel (FractalGrid.goalAt): yes wins, there is no closest-so-far.
(function () {
  "use strict";

  var APP = "../chaos.html";
  var SOLVED_KEY = "chaosChallengesSolved";
  var CLICK_SLOP_PX = 5;

  function $(id) { return document.getElementById(id); }
  var listPage = $("list-page"), listEl = $("challenge-list");
  var playPage = $("play-page"), playTitle = $("play-title"), engine = $("engine");
  var targetPanel = $("target-panel"), targetVideo = $("target-video"), targetOrder = $("target-order"), btnTarget = $("btn-target");
  var toast = $("toast"), winPanel = $("win-panel"), winText = $("win-text"), winLink = $("win-link");

  var challenges = [];
  var current = -1;

  function solvedSet() {
    try { return JSON.parse(localStorage.getItem(SOLVED_KEY) || "{}") || {}; } catch (err) { return {}; }
  }
  function markSolved(id) {
    var set = solvedSet();
    set[id] = true;
    try { localStorage.setItem(SOLVED_KEY, JSON.stringify(set)); } catch (err) { /* private mode */ }
  }

  function orderText(goal) {
    return "Bounce order: " + goal.map(function (b) { return "body " + b; }).join(", ");
  }

  // ---- The list ----

  function renderList() {
    var solved = solvedSet();
    listEl.textContent = "";
    challenges.forEach(function (c, i) {
      var card = document.createElement("article");
      card.className = "challenge-card";
      var text = document.createElement("div");
      var h = document.createElement("h3");
      h.textContent = c.title;
      if (solved[c.id]) {
        var badge = document.createElement("span");
        badge.className = "solved";
        badge.textContent = "Solved";
        h.appendChild(badge);
      }
      var p = document.createElement("p");
      p.textContent = c.blurb;
      var order = document.createElement("p");
      order.className = "order";
      order.textContent = orderText(c.goal);
      var btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = solved[c.id] ? "Play again" : "Play";
      btn.addEventListener("click", function () { play(i); });
      text.appendChild(h); text.appendChild(p); text.appendChild(order); text.appendChild(btn);
      var video = document.createElement("video");
      video.src = c.video; video.muted = true; video.loop = true; video.autoplay = true; video.playsInline = true;
      card.appendChild(text); card.appendChild(video);
      listEl.appendChild(card);
    });
  }

  // ---- Play mode ----

  function frameAddress(c) {
    return APP + "?goal=" + c.goal.join(".") + "#map/" + c.scene;
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
    targetVideo.src = c.video;
    targetOrder.textContent = orderText(c.goal);
    winPanel.hidden = true;
    toast.hidden = true;
    setTargetShown(true);
    listPage.hidden = true;
    playPage.hidden = false;
    document.title = c.title + ": Chaos Accelerator";
    engine.src = frameAddress(c);
  }

  function leave() {
    playPage.hidden = true;
    listPage.hidden = false;
    engine.src = "about:blank";
    targetVideo.removeAttribute("src");
    document.title = "Challenges: Chaos Accelerator";
    renderList();
  }

  function setTargetShown(shown) {
    targetPanel.hidden = !shown;
    btnTarget.textContent = shown ? "Hide target" : "Show target";
    btnTarget.setAttribute("aria-pressed", shown ? "true" : "false");
  }
  btnTarget.addEventListener("click", function () { setTargetShown(targetPanel.hidden); });
  $("btn-back").addEventListener("click", leave);
  $("win-list").addEventListener("click", leave);
  $("win-next").addEventListener("click", function () { play((current + 1) % challenges.length); });

  // The frame's own map link, for the win screen (the address bar of a frame is not visible).
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

  function guess(clientX, clientY) {
    var w = engine.contentWindow;
    var hit = null;
    try { hit = w.FractalGrid && w.FractalGrid.goalAt ? w.FractalGrid.goalAt(clientX, clientY) : null; } catch (err) { hit = null; }
    if (hit === null) { showToast("Still preparing the map. Try again in a moment."); return; }
    if (!hit) { showToast("Not there. Keep looking."); return; }
    var c = challenges[current];
    markSolved(c.id);
    winText.textContent = "You found the " + c.title + " starting point.";
    var link = currentMapLink();
    winLink.hidden = !link;
    if (link) winLink.href = link;
    winPanel.hidden = false;
  }

  // A press that does not turn into a pan is a guess. Listeners are bound inside the frame's document
  // once it loads; the canvas is in its markup from the start, so nothing waits on the map.
  engine.addEventListener("load", function () {
    var doc = engine.contentDocument;
    if (!doc || !doc.getElementById) return;
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
  });

  // ---- Start ----

  fetch("trick-shot.json", { cache: "no-cache" }).then(function (r) { return r.json(); }).then(function (data) {
    challenges = data.challenges || [];
    renderList();
  }).catch(function () {
    listEl.textContent = "The challenge list couldn't be loaded.";
  });
})();
