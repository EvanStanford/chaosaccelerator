// CPAL-1.0 License. See chaosaccelerator.com/license.html

// App shell: which of chaos.html's two views is on screen, the animated
// explainer between them, and the address-bar sync ("The address bar" below).
// Both views live in one document so the transition can show them at once.
(function (global) {
  "use strict";

  var editorView = document.getElementById("editor-view");
  var gridView = document.getElementById("grid-view");
  var layer = document.getElementById("transition-layer");
  var canvas = document.getElementById("transition-canvas");
  var skipBtn = document.getElementById("transition-skip");
  var backLink = document.getElementById("back-link");
  var emptyStateLink = document.getElementById("empty-state-link");
  var ctx = canvas.getContext("2d");
  var editorPanel = document.getElementById("panel");
  var editorCanvasArea = document.getElementById("canvas-area");
  var gridCanvasArea = document.getElementById("grid-canvas-area");

  var current = "editor";

  // ---- Intro seen? ---- one localStorage key, a map by DIRECTION: each direction plays once.
  var INTRO_SEEN_KEY = "physicsAppSeenIntro";

  function loadSeen() {
    try {
      return JSON.parse(localStorage.getItem(INTRO_SEEN_KEY)) || {};
    } catch (err) {
      return {};
    }
  }

  function introSeen(direction) {
    return !!loadSeen()[direction];
  }

  function markIntroSeen(direction) {
    var seen = loadSeen();
    seen[direction] = true;
    try {
      localStorage.setItem(INTRO_SEEN_KEY, JSON.stringify(seen));
    } catch (err) {
    }
  }

  function forgetIntro() {
    try {
      localStorage.removeItem(INTRO_SEEN_KEY);
    } catch (err) {}
  }

  // ---- Timings ---- the long version tiles a frozen frame of the scene; the short one only zooms and fades.
  var FULL_MS = 2400;
  var QUICK_MS = 500;
  var MIN_LEGIBLE_CELL_PX = 22;

  function prefersReducedMotion() {
    return global.matchMedia && global.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  // Settings > Performance Settings > Disable transitions. The control holds the value whether or not the map has started.
  var transitionsCheckbox = document.getElementById("perf-transitions-checkbox");
  function transitionsDisabled() {
    return !!(transitionsCheckbox && transitionsCheckbox.checked);
  }

  function ease(u) {
    return u * u * (3 - 2 * u);
  }

  // ---- The zoom ---- cellPx (device px per copy of the scene) drives both the
  // tiling and the grid scale, held so one grid pixel is one cell. Geometric, not linear.
  function cellPxAt(u, startPx) {
    return Math.pow(startPx, 1 - ease(u));
  }

  function nudgeLayout() {
    global.dispatchEvent(new Event("resize"));
  }

  function showOnly(which) {
    editorView.hidden = which !== "editor";
    gridView.hidden = which !== "grid";
    editorView.classList.remove("is-transitioning");
    gridView.classList.remove("is-transitioning");
    if (editorPanel) {
      editorPanel.style.opacity = "";
    }
    current = which;
    if (global.FractalGrid.placeSettings) global.FractalGrid.placeSettings(which);
    nudgeLayout();
    syncAddress();
  }

  // ---- Tiled scene ---- rendered ONCE per run into an offscreen canvas, then stamped per frame.
  var CELL_RENDER_PX = 256;
  var TILE_BORDER_PX = 3;
  var cellCanvas = null;
  var cellCtx = null;

  function ensureCellCanvas(scene) {
    var aspect = (scene.frameWidth || 1) / (scene.frameHeight || 1);
    var w = Math.max(1, Math.round(CELL_RENDER_PX * Math.min(1, aspect)));
    var h = Math.max(1, Math.round(CELL_RENDER_PX / Math.max(1, aspect)));
    if (!cellCanvas) {
      cellCanvas = document.createElement("canvas");
      cellCtx = cellCanvas.getContext("2d");
    }
    if (cellCanvas.width !== w || cellCanvas.height !== h) {
      cellCanvas.width = w;
      cellCanvas.height = h;
    }
    return cellCanvas;
  }

  function drawCell(scene) {
    var fw = scene.frameWidth || 1, fh = scene.frameHeight || 1;
    ensureCellCanvas(scene);
    var s = Math.min(cellCanvas.width / fw, cellCanvas.height / fh);
    cellCtx.setTransform(1, 0, 0, 1, 0, 0);
    cellCtx.fillStyle = "#0c0d11";
    cellCtx.fillRect(0, 0, cellCanvas.width, cellCanvas.height);
    cellCtx.setTransform(s, 0, 0, s, 0, 0);
    global.PhysicsUI.drawSceneBodies(cellCtx, scene.bodies);
    global.PhysicsUI.drawSceneSprings(cellCtx, scene);
  }

  // Lattice centered on (centerX, centerY) = world (0, 0); a white backing rect gives every shared edge a seam.
  function stampTiles(cellPx, alpha, viewW, viewH, dpr, centerX, centerY, clip) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (alpha <= 0) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(clip.left, clip.top, clip.right - clip.left, clip.bottom - clip.top);
    ctx.clip();
    ctx.globalAlpha = alpha;
    var cw = cellPx, ch = cellPx * (cellCanvas.height / cellCanvas.width);
    var cx = centerX - cw / 2, cy = centerY - ch / 2;
    var firstX = cx - Math.ceil((cx + cw) / cw) * cw;
    var firstY = cy - Math.ceil((cy + ch) / ch) * ch;
    var border = Math.min(TILE_BORDER_PX * (dpr || 1), cw / 2, ch / 2);
    ctx.fillStyle = "#ffffff";
    for (var y = firstY; y < viewH; y += ch) {
      for (var x = firstX; x < viewW; x += cw) {
        if (border > 0) ctx.fillRect(x, y, cw, ch);
        ctx.drawImage(cellCanvas, x + border, y + border, Math.max(0, cw - border * 2), Math.max(0, ch - border * 2));
      }
    }
    ctx.restore();
  }

  function sizeTransitionCanvas() {
    var dpr = Math.min(global.devicePixelRatio || 1, 2);
    var w = Math.max(1, Math.round(layer.clientWidth * dpr));
    var h = Math.max(1, Math.round(layer.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    return { w: w, h: h, dpr: dpr };
  }

  // ---- Where the zoom starts ---- the editor canvas's rect, read fresh each run. Its center is
  // world (0, 0) and walks linearly to gridCenter. startPx is the WIDTH: stampTiles derives ch from cw.
  function zoomOrigin(dims) {
    var layerRect = layer.getBoundingClientRect();
    var caRect = editorCanvasArea.getBoundingClientRect();
    var left = (caRect.left - layerRect.left) * dims.dpr;
    var top = (caRect.top - layerRect.top) * dims.dpr;
    var width = caRect.width * dims.dpr;
    var height = caRect.height * dims.dpr;
    return {
      left: left,
      top: top,
      right: left + width,
      bottom: top + height,
      centerX: left + width / 2,
      centerY: top + height / 2,
      startPx: Math.max(2, width),
    };
  }

  // Where the zoom ENDS: the map's own centre, not the window's. Read per frame: the dock settles late.
  function gridCenter(dims) {
    var rect = gridCanvasArea ? gridCanvasArea.getBoundingClientRect() : null;
    if (!rect || rect.width <= 0 || rect.height <= 0) return { x: dims.w / 2, y: dims.h / 2 };
    var layerRect = layer.getBoundingClientRect();
    return {
      x: (rect.left - layerRect.left + rect.width / 2) * dims.dpr,
      y: (rect.top - layerRect.top + rect.height / 2) * dims.dpr,
    };
  }

  // ---- Running one ----
  var active = null;
  var lastFrameInfo = null;

  function stopActive(jumpToEnd) {
    if (!active) return;
    var a = active;
    active = null;
    if (a.raf) cancelAnimationFrame(a.raf);
    layer.hidden = true;
    if (jumpToEnd) a.finish();
  }

  function runTransition(opts) {
    stopActive(true);
    // Un-hide BEFORE measuring: display:none rects are zero, and a reverse run starts with #editor-view hidden.
    layer.hidden = false;
    editorView.hidden = false;
    gridView.hidden = false;
    editorView.classList.add("is-transitioning");
    gridView.classList.add("is-transitioning");
    var dims = sizeTransitionCanvas();
    var durationMs = opts.durationMs;
    var forward = opts.forward;
    var origin = zoomOrigin(dims);
    var startPx = origin.startPx;
    var clip = origin;
    var defaultScale = global.FractalGrid.defaultScale();

    if (opts.tiled) drawCell(opts.scene);

    skipBtn.hidden = durationMs < 2000;

    function finish() {
      layer.hidden = true;
      skipBtn.hidden = true;
      global.FractalGrid.resetView();
      global.FractalGrid.renderNow();
      showOnly(forward ? "grid" : "editor");
      if (opts.onDone) opts.onDone();
    }

    function renderAt(elapsedMs) {
      var raw = Math.min(1, elapsedMs / durationMs);
      var u = forward ? raw : 1 - raw;
      var cellPx = cellPxAt(u, startPx);

      global.FractalGrid.setScale(defaultScale / Math.max(1, cellPx));
      global.FractalGrid.renderNow();

      var fade = Math.min(1, Math.max(0, (cellPx - MIN_LEGIBLE_CELL_PX) / (startPx * 0.25)));

      // Pan is LINEAR in u, not eased or tied to fade: otherwise it sits frozen
      // while the shrink is already underway, then catches up in a visible kink.
      var centerT = u;
      var end = gridCenter(dims);
      var centerX = origin.centerX + (end.x - origin.centerX) * centerT;
      var centerY = origin.centerY + (end.y - origin.centerY) * centerT;

      if (opts.tiled) {
        // cellPx is already device px: no dpr scale here, only on the border.
        stampTiles(cellPx, fade, dims.w, dims.h, dims.dpr, centerX, centerY, clip);
      } else {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.globalAlpha = forward ? 1 - raw : raw;
        ctx.fillStyle = "#0c0d11";
        ctx.fillRect(clip.left, clip.top, clip.right - clip.left, clip.bottom - clip.top);
        ctx.globalAlpha = 1;
      }

      if (editorPanel) {
        editorPanel.style.opacity = String(fade);
      }

      lastFrameInfo = { raw: raw, cellPx: cellPx, gridScale: defaultScale / Math.max(1, cellPx) };
      return raw >= 1;
    }

    var startedAt = performance.now();
    function frame(now) {
      if (renderAt(now - startedAt)) { active = null; finish(); return; }
      active.raf = requestAnimationFrame(frame);
    }

    active = { finish: finish, raf: 0, renderAt: renderAt, durationMs: durationMs };
    active.raf = requestAnimationFrame(frame);
  }

  function transitionTo(which, scene) {
    // A navigation: the page being left writes itself down, then gets a new history entry.
    syncAddress();
    pushPending = true;
    var instant = prefersReducedMotion() || transitionsDisabled();
    var direction = which === "grid" ? "forward" : "reverse";
    var full = !introSeen(direction);
    if (which === "grid") {
      global.FractalGrid.start(scene);
      global.FractalGrid.setScale(global.FractalGrid.defaultScale() / Math.max(2, layer.clientHeight));
    } else {
      // Retrace from world (0, 0), not from wherever the user panned: renderAt only sets scale.
      global.FractalGrid.resetView();
      // The Inspect preview's playback (and sound) would otherwise run on a hidden page.
      global.FractalGrid.pausePlayback();
    }
    if (instant) {
      if (which === "grid") global.FractalGrid.resetView();
      showOnly(which);
      return;
    }
    runTransition({
      forward: which === "grid",
      durationMs: full ? FULL_MS : QUICK_MS,
      tiled: full,
      scene: scene || (global.PhysicsUI && global.PhysicsUI.currentScene()),
      onDone: full ? function () { markIntroSeen(direction); } : null,
    });
  }

  global.AppShell = {
    currentView: function () { return current; },
    syncAddress: function () { syncAddress(); },
    goToGrid: function (scene) { transitionTo("grid", scene); },
    goToEditor: function () { transitionTo("editor", null); },
    replayIntro: forgetIntro,
    debugRenderAt: function (elapsedMs) {
      if (!active) return null;
      var durationMs = active.durationMs;
      var done = active.renderAt(elapsedMs);
      // Cancel the real loop's frame too, or it finishes the transition a SECOND time.
      if (done) { var a = active; active = null; if (a.raf) cancelAnimationFrame(a.raf); a.finish(); }
      return {
        elapsedMs: elapsedMs, durationMs: durationMs, done: done,
        cellPx: lastFrameInfo && Math.round(lastFrameInfo.cellPx * 100) / 100,
        gridScale: lastFrameInfo && lastFrameInfo.gridScale,
        view: current,
      };
    },
    debugIsRunning: function () { return !!active; },
  };

  if (backLink) {
    backLink.addEventListener("click", function (e) {
      e.preventDefault();
      global.AppShell.goToEditor();
    });
  }
  if (emptyStateLink) {
    emptyStateLink.addEventListener("click", function (e) {
      e.preventDefault();
      global.FractalGrid.pausePlayback();
      syncAddress();
      pushPending = true; // a navigation, like transitionTo's
      showOnly("editor");
    });
  }
  skipBtn.addEventListener("click", function () { stopActive(true); });
  global.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && active) stopActive(true);
  });
  global.addEventListener("resize", function () {
    if (active) sizeTransitionCanvas();
  });

  // ---- The address bar ---- the whole app state is in the URL fragment (share-url.js).
  // Navigating BETWEEN pages pushes a history entry; changes WITHIN a page replace it on a
  // timer (replaceState never fires hashchange, and stays under Safari's rate limit).
  var ADDRESS_SYNC_MS = 500;
  var lastFragment = null;
  // A navigation is pending: the next address write is a NEW history entry.
  var pushPending = false;

  function currentFragment() {
    if (active) return null;
    if (current === "grid") {
      var state = global.FractalGrid.shareState();
      if (!state) return null;
      return global.ShareUrl.encode({
        page: global.ShareUrl.PAGE_MAP,
        scene: global.PhysicsCoords.toAuthoredJSON(state.scene),
        view: state.view,
      });
    }
    var scene = global.PhysicsUI.shareScene();
    return scene ? global.ShareUrl.encode({ page: global.ShareUrl.PAGE_BUILDER, scene: scene }) : null;
  }

  function syncAddress() {
    var fragment = currentFragment();
    if (fragment === null) return;
    if (fragment === lastFragment) { pushPending = false; return; }
    try {
      if (pushPending) global.history.pushState(null, "", "#" + fragment);
      else global.history.replaceState(null, "", "#" + fragment);
      pushPending = false;
      lastFragment = fragment;
    } catch (err) {
      // Refused (rate limit, sandboxed frame): stale until the next tick.
    }
  }

  function sameScene(a, b) {
    try {
      var P = global.ShareUrl.PAGE_BUILDER;
      return !!a && !!b && global.ShareUrl.encode({ page: P, scene: a }) === global.ShareUrl.encode({ page: P, scene: b });
    } catch (err) {
      return false;
    }
  }

  function openAddress(onLoad) {
    // The address's entry already exists: no pending push. On load the editor already took the scene.
    pushPending = false;
    var link;
    try {
      link = global.ShareUrl.decode(global.location.hash);
    } catch (err) {
      global.PhysicsUI.reportLinkProblem("This link's scene couldn't be read: " + err.message);
      return;
    }
    if (!link || !link.scene) return;
    if (link.page === global.ShareUrl.PAGE_MOVIE) {
      global.location.replace("chaosplayback.html" + global.location.hash);
      return;
    }
    // Skipped when the editor already holds it: reloading would cost the selection.
    var editorHasIt = !onLoad && sameScene(global.PhysicsUI.shareScene(), link.scene);
    var problem = onLoad ? global.PhysicsUI.sharedSceneProblem(link.scene)
      : editorHasIt ? null : global.PhysicsUI.loadSharedScene(link.scene);
    if (problem) {
      global.PhysicsUI.reportLinkProblem("This link's scene couldn't be loaded: " + problem);
      return;
    }
    stopActive(true);
    if (link.page === global.ShareUrl.PAGE_MAP) {
      // Same scene already compiled: only the view is put back (a restart rebuilds every shader).
      var gridState = !onLoad && global.FractalGrid.isStarted() ? global.FractalGrid.shareState() : null;
      if (gridState && sameScene(global.PhysicsCoords.toAuthoredJSON(gridState.scene), link.scene)) {
        global.FractalGrid.applyShareView(link.view);
        showOnly("grid");
        return;
      }
      var gridScene = null;
      try {
        gridScene = global.PhysicsUI.gridSceneFromShared(link.scene);
      } catch (err) {
        global.PhysicsUI.reportLinkProblem("This link's map couldn't be opened: " + err.message);
      }
      if (gridScene) {
        // No explainer for someone who never saw the scene.
        global.FractalGrid.start(gridScene);
        global.FractalGrid.applyShareView(link.view);
        showOnly("grid");
        return;
      }
    }
    if (current !== "editor") {
      global.FractalGrid.pausePlayback();
      showOnly("editor");
    }
  }

  openAddress(true);
  // Set by chaos.html's inline script for a map link, so the editor does not flash first.
  document.documentElement.classList.remove("opening-map");
  syncAddress();
  setInterval(syncAddress, ADDRESS_SYNC_MS);
  global.addEventListener("hashchange", function () {
    if (global.ShareUrl.cleanFragment(global.location.hash) === lastFragment) return;
    openAddress(false);
    lastFragment = null;
    syncAddress();
  });

  ["btn-replay-intro", "grid-btn-replay-intro"].forEach(function (id) {
    var btn = document.getElementById(id);
    if (!btn) return;
    var original = btn.textContent;
    btn.addEventListener("click", function () {
      forgetIntro();
      btn.textContent = "Intro will replay next time";
      setTimeout(function () { btn.textContent = original; }, 2200);
    });
  });
})(window);
