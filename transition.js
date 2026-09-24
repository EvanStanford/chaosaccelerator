// This file is part of Chaos Accelerator, licensed under the Common Public
// Attribution License, Version 1.0 (CPAL-1.0): see LICENSE in the project
// root, or https://chaosaccelerator.com/license for a hosted copy.

// The app shell: which of chaos.html's two views is on screen, the
// animated explainer that runs between them, and the address bar that says
// which one (and what is in it), see "The address bar" at the end.
//
// Both views exist in one document (see chaos.html and app-shell.css) so
// this can show them AT ONCE, which is the whole point: the transition has
// to make the editor's scene visibly collapse into a single pixel of the
// fractal grid, and that needs the outgoing and incoming views alive
// together. A cross-document navigation could only ever cross-fade a dead
// screenshot of the old page: no physics still playing inside it, no zoom
// staying in lockstep with the grid underneath.
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
  // The editor's own left (or, in portrait, bottom) toolbar and the box the
  // scene is actually drawn in: both read for their on-screen RECT, not
  // just grabbed for hiding. See "Where the zoom starts" below.
  var editorPanel = document.getElementById("panel");
  var editorCanvasArea = document.getElementById("canvas-area");
  // And the box the MAP is drawn in, read for its rect the same way: see
  // gridCenter below.
  var gridCanvasArea = document.getElementById("grid-canvas-area");

  var current = "editor";

  // ---- Has the long version been seen? ----
  //
  // Same storage shape as the tip dismissals (see showTip in
  // fractal-grid.js): one localStorage key, read defensively, a failed
  // write meaning only that it may play again rather than breaking
  // anything. The full explainer is a one-time thing: it earns ten
  // seconds once, and would be an imposition every time after.
  // A map, not a flag: each DIRECTION earns its own first showing. Zooming
  // out of the scene into the grid and zooming back into one cell are two
  // different things to be shown once, having watched one does not explain
  // the other.
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
      // Storage full or unavailable: the explainer may play again, which
      // is a far better failure than not transitioning at all.
    }
  }

  function forgetIntro() {
    try {
      localStorage.removeItem(INTRO_SEEN_KEY);
    } catch (err) {}
  }

  // ---- Timings ----
  //
  // Two genuinely different animations, not one played at two speeds. The
  // long one tiles a single frozen frame of the scene across the grid; the
  // short one does not, because at half a second nobody can read a tiled
  // grid anyway and stamping one would be pure cost. What survives into the
  // short version is the ZOOM, which is the part that carries the meaning.
  // Neither version simulates: the scene is drawn exactly as it stood when
  // the transition started, which is what keeps this quick and legible: no
  // physics to wait on, no motion inside a tile competing with the zoom.
  var FULL_MS = 2400;
  var QUICK_MS = 500;
  // Below this many device pixels per cell, a drawn scene is a smudge and
  // the tile count starts climbing quadratically, so the long version
  // finishes cross-fading to the grid before the cells get this small, and
  // the rest of the zoom is the grid alone.
  var MIN_LEGIBLE_CELL_PX = 22;

  function prefersReducedMotion() {
    return global.matchMedia && global.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  // Slight ease-in-out, as asked. Smoothstep rather than a cubic bezier:
  // it is symmetric, has zero velocity at both ends (so neither the start
  // nor the landing snaps), and is one line.
  function ease(u) {
    return u * u * (3 - 2 * u);
  }

  // ---- The zoom ----
  //
  // One number drives both halves of the animation, which is what keeps
  // them locked together: cellPx is how many device pixels one copy of the
  // editor scene occupies. It runs from "one cell fills the viewport" down
  // to "one cell is one pixel", and the grid is simultaneously held at the
  // zoom where one of ITS pixels is that same size.
  //
  // Geometric, not linear: equal times give equal RATIOS of zoom, which is
  // what reads as a steady pull-back. A linear ramp would appear to rush
  // the start and crawl at the end.
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
    // Undoes the per-frame opacity renderAt was driving on the toolbar (see
    // runTransition), settling here whether a run just finished or was
    // never animated at all (prefersReducedMotion's instant path calls
    // straight in here without ever touching the panel's style).
    if (editorPanel) {
      editorPanel.style.opacity = "";
    }
    current = which;
    // The one Settings body there is, into the page now on screen (see "One
    // settings body" in fractal-grid.js).
    if (global.FractalGrid.placeSettings) global.FractalGrid.placeSettings(which);
    nudgeLayout();
    // Straight away rather than on the next tick of the sync timer: which
    // page this is happens to be the first thing the address says.
    syncAddress();
  }

  // ---- The tiled editor scene ----
  //
  // The scene is a frozen frame, so it is rendered into an offscreen canvas
  // exactly ONCE per run, not once per frame, and then stamped across the
  // viewport with drawImage for every frame after. Drawing the scene itself
  // per tile would be thousands of path operations a frame; stamping one
  // small bitmap is a few thousand blits, which is a different order of
  // cost entirely and the only reason the tiling is affordable at all.
  var CELL_RENDER_PX = 256;
  // Width, in device pixels, of the white line stamped between every pair
  // of adjacent tiles: the "grout" that makes the grid of duplicates read
  // as a grid rather than a blur of repeats.
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

  // Stamps the cell across the whole viewport at `cellPx` per copy, but only
  // paints inside `clip`: the toolbar's own screen rect, left untouched
  // rather than papered over (see its computation in runTransition). Tiles
  // are centered on (centerX, centerY): the point that should read as world
  // (0, 0), i.e. the exact, unperturbed scene, rather than on a tile's own
  // boundary, so it's really that point converging on the grid's own center
  // (see zoomOrigin's comment) driving the lattice, not some corner of it.
  // Each tile is backed by a white rect slightly larger than the inset
  // image, so every shared edge between neighbours gets a white seam: a
  // crosshatch grid separating the copies rather than one continuous smear.
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

  // ---- Where the zoom starts ----
  //
  // The first tile drawn has to land exactly on top of the editor's own
  // canvas, not the viewport's center, or the very first frame jumps: an
  // instant before the transition starts, that rect is the whole picture,
  // and #panel (docked beside it, or below it in portrait) takes up real
  // space the tile must NOT claim. Read fresh every run rather than cached,
  // since the panel can be resized (or the layout can flip to portrait)
  // between one transition and the next.
  //
  // centerX/centerY is canvasArea's own on-screen CENTRE, the point that
  // reads as world (0, 0), the exact unperturbed scene (see
  // physics-grid-codegen.js's resolveOffsetTargets: worldX/worldY are
  // ADDED to the scene's own authored position, so (0, 0) is "no offset at
  // all", and that's rendered at the center of whatever frame the scene's
  // own canvas fills, which IS canvasArea, since resizeCanvas sizes it to
  // exactly canvasArea's box). stampTiles centers its tiling lattice there
  // (see its own comment for why that has to be the tile's CENTRE and not a
  // boundary) rather than at canvasArea's corner, so the point the zoom is
  // actually landing on is the one that's SUPPOSED to end up centered, not
  // some arbitrary tile edge a half-cell-width away from it.
  //
  // startPx is canvasArea's WIDTH, not height, despite feeding a variable
  // everywhere else read as if it were a generic "size": stampTiles sets
  // `cw = cellPx` directly and derives `ch` from it via the cell bitmap's
  // fixed aspect ratio (== canvasArea's own aspect ratio, since that's what
  // resizeCanvas sizes the scene's frame to). Seed cellPx from the width and
  // both cw AND the derived ch land on canvasArea's real dimensions; seed it
  // from the height (as this used to) and only ch would.
  //
  // The grid has no such offset, its own menu column FLOATS over its
  // canvas (see #grid-menu-column in fractal-grid.css), so it always fills the
  // full viewport, and it never pans (transition.js only ever calls
  // setScale, never touches center), world (0, 0) sits at the viewport's
  // own center for the ENTIRE run, start to finish. That's the far end
  // (centerX, centerY) walks toward, LINEARLY in `u`, across the whole run
  // (see `centerT` in renderAt for why linear, not eased): the point
  // standing in for world (0, 0) glides from where it actually starts to
  // where the grid has had it centered all along, landing exactly on the
  // center PIXEL, not whichever one happened to be nearest a corner, the
  // instant the tiles hand off to the grid.
  //
  // left/top/right/bottom describe the same rect and feed a SEPARATE thing
  // - the fixed clip in runTransition that keeps stampTiles off the
  // toolbar's own strip of the screen: kept in absolute-edge form since
  // that's what a clip rect wants, rather than re-deriving edges from a
  // width/height every frame.
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

  // Where the zoom ENDS: the map's own on-screen centre, which is where the
  // grid has world (0, 0) for the whole run. In the desktop layout that is
  // simply the middle of the window, the grid's menus float over a canvas
  // that fills it, but in the small-window layout the map shares the window
  // with the dock (see "The dock" in fractal-grid.js), so its centre is not
  // the window's, and tiles converging on the window's would slide off the
  // picture they are supposed to be dissolving into.
  //
  // Read every frame rather than once per run: a forward run starts in the
  // same task that opens the grid's Inspect card, and the dock only settles
  // its size (and with it the map's) at the end of that task.
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
  // What the most recent rendered frame was, for debugRenderAt to report.
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
    // Both views are on screen for the whole run: the grid is what shows
    // through as the tiles fade, and the editor is what the tiles ARE, so
    // neither may be display:none.
    //
    // Un-hidden BEFORE measuring anything below, for the same reason twice
    // over: a display:none element reports an all-zero
    // getBoundingClientRect/clientWidth. #transition-layer first (see
    // sizeTransitionCanvas's call below, a 1x1 canvas put every tile in a
    // single corner pixel), and, easy to miss, since forward starts with
    // #editor-view ALREADY visible and so never exercised this path:
    // #editor-view too: zoomOrigin reads #canvas-area's rect, and a reverse
    // run starts with #editor-view still hidden. Left un-hidden until after
    // that read, canvasArea's rect came back all zeros, which zeroed out
    // startPx, the pan, and the clip rect together, not a wrong zoom, no
    // zoom at all, on every reverse run.
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
    // Fixed for the whole run, not grown frame to frame: the toolbar no
    // longer shrinks (see the panel-opacity comment in renderAt), so there's
    // no vacated space for stampTiles/the plain fade to sweep into, the
    // strip they're kept off of is just always exactly the editor canvas's
    // own rect.
    var clip = origin;
    var defaultScale = global.FractalGrid.defaultScale();

    // The scene the tiles show: a single frozen frame, drawn once below.
    // See the timings comment above: neither version simulates.
    if (opts.tiled) drawCell(opts.scene);

    // The grid owns the picture underneath; the editor's own canvas is
    // covered by the transition layer, so it does not matter what it shows.
    skipBtn.hidden = durationMs < 2000;

    // Elapsed-time driven, not clock driven: renderAt(ms) fully determines
    // what frame that instant looks like, and the rAF loop below only
    // decides WHEN to call it. That split is what makes the animation
    // inspectable, AppShell.debugRenderAt(ms) can put it at any instant
    // without waiting for one, and it is also the only way to verify it at
    // all in a context where rAF is throttled to nothing (a hidden tab).

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
      // Reverse runs the same curve backwards, so the two directions are
      // guaranteed to retrace each other rather than being two hand-tuned
      // animations that nearly match.
      var u = forward ? raw : 1 - raw;
      var cellPx = cellPxAt(u, startPx);

      // The grid, held at the zoom where one of its pixels is exactly one
      // cell wide: this is the lockstep.
      global.FractalGrid.setScale(defaultScale / Math.max(1, cellPx));
      global.FractalGrid.renderNow();

      // Faded out by the time the cells stop being legible: past that the
      // tiling is both unreadable and quadratically expensive, and the grid
      // underneath is already saying the same thing. Computed unconditionally
      // (not just for the tiled version) because it also drives the panel
      // fade below, which both versions do.
      var fade = Math.min(1, Math.max(0, (cellPx - MIN_LEGIBLE_CELL_PX) / (startPx * 0.25)));

      // Walks the point standing in for world (0, 0) from where it actually
      // sits at the start (canvasArea's own on-screen center) to where the
      // grid has it centered for the WHOLE run (the viewport's own center):
      // see zoomOrigin's comment for why these two points differ.
      //
      // Driven by `u` directly, LINEARLY, not eased, rather than by fade
      // (tried first): fade sits pinned at 1 for most of the run and only
      // starts falling near the end, so tying the pan to it left this
      // frozen while the cell-size shrink (cellPxAt, below) was already well
      // underway, then suddenly catching up. Anything not exactly at the
      // frame's own center reads that mismatch as a reversal: on screen it's
      // centerX/Y PLUS an offset scaled by the current cell size, and early
      // on, with the pan frozen, that offset term is all that moves it,
      // shrinking fast, in whichever direction the offset points. Once the
      // pan starts, it pulls the opposite way (centerX/Y is walking toward
      // the viewport's center, typically the other direction), hard enough
      // to overturn the drift already in progress.
      //
      // ease(u) alone doesn't fix this: it has zero velocity at u = 0 too
      // (that's what makes it an EASE), so the pan still contributes nothing
      // at the exact moment the shrink term is largest. Plain `u` gives the
      // pan a constant, nonzero rate from the very first frame instead,
      // which cancels far more of that early drift: worked through the
      // actual curve numerically and confirmed the peak deviation drops
      // substantially versus ease(u). It's not a mathematical guarantee of
      // zero reversal for every possible layout (an object sitting far
      // enough off the frame's own center could still show a faint, smooth
      // change of direction), but what made the old version look BROKEN
      // wasn't the reversal existing at all, it was fade's frozen-then-
      // catch-up curve turning it into a sudden kink. A linear pan has no
      // such kink: velocity is constant throughout, so any residual turning
      // point is a gentle apex, not a visible snap.
      var centerT = u;
      var end = gridCenter(dims);
      var centerX = origin.centerX + (end.x - origin.centerX) * centerT;
      var centerY = origin.centerY + (end.y - origin.centerY) * centerT;

      if (opts.tiled) {
        // cellPx is ALREADY in device pixels (it descends from startPx =
        // the editor canvas's own backing width), and stampTiles draws in
        // canvas space, which is the same units. Scaling by dpr again drew
        // every tile at twice its size and put the tiling out of lockstep
        // with the grid underneath, which uses cellPx unscaled. The border
        // width is the one thing that DOES want an explicit dpr scale, so
        // it stays a crisp, constant physical width rather than shrinking
        // to sub-pixel on a high-dpi screen.
        stampTiles(cellPx, fade, dims.w, dims.h, dims.dpr, centerX, centerY, clip);
      } else {
        // The short version: no tiles, no simulation. A plain fade over the
        // zoom, which is the part that carries the meaning.
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.globalAlpha = forward ? 1 - raw : raw;
        ctx.fillStyle = "#0c0d11";
        ctx.fillRect(clip.left, clip.top, clip.right - clip.left, clip.bottom - clip.top);
        ctx.globalAlpha = 1;
      }

      // The toolbar just fades, rather than shrinking with everything else:
      // this is a zoom OUT, and shrinking only reads as "getting out of the
      // way" for a zoom IN, where a shrinking object also moves toward
      // vanishing off-frame. Zooming out, a shrinking #panel would just
      // become a smaller rectangle sitting in the exact same place, so a
      // plain opacity fade, tied to the same `fade` the tile (or the short
      // version's background) is riding, is what actually reads as
      // consistent with everything else dimming into the grid.
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
    // Going to the other page by the app's own buttons is a NAVIGATION, and
    // gets a history entry of its own (see "The address bar"). First the
    // page being left writes itself down one last time, so that Back returns
    // to it as it was left rather than as it was half a second before, and
    // before anything below resets its view for the animation.
    syncAddress();
    pushPending = true;
    var instant = prefersReducedMotion();
    var direction = which === "grid" ? "forward" : "reverse";
    var full = !introSeen(direction);
    if (which === "grid") {
      global.FractalGrid.start(scene);
      // Started from far inside a single pixel, so the first frame the grid
      // paints already matches the cell the tiles are showing.
      global.FractalGrid.setScale(global.FractalGrid.defaultScale() / Math.max(2, layer.clientHeight));
    } else {
      // Going back always retraces the SAME path that led into the grid,
      // the cell the scene actually lives at, world (0, 0), never wherever
      // the user has since panned or zoomed off to. renderAt's per-frame
      // setScale (see runTransition) only ever touches scale, not pan, so
      // without this a pan left over from browsing the grid would have the
      // whole zoom-in animate centered on the wrong spot for the entire run,
      // only snapping to the right one at the very last instant (finish()
      // calls resetView() too, but that's the far end of the animation, not
      // the frame it starts from). Scale gets reset here as a side effect:
      // harmless, since the very first renderAt call overwrites it anyway.
      global.FractalGrid.resetView();
      // The hover/Inspect preview's own playback (and any bounce/edge sound
      // it's looping) has no idea #grid-view is about to be hidden: left
      // running, it just keeps animating and playing sound from a page the
      // user can no longer see. Same stop the grid's own Pause button does.
      global.FractalGrid.pausePlayback();
    }
    if (instant) {
      // No animation to land the zoom back on the default framing (see
      // finish), so it is put there directly, without this the grid opened
      // on whatever scale the setScale above left it at.
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
    // For a page about to navigate away (the Movie card's Done): the address
    // it leaves behind is what Back returns to, so it should be current.
    syncAddress: function () { syncAddress(); },
    goToGrid: function (scene) { transitionTo("grid", scene); },
    goToEditor: function () { transitionTo("editor", null); },
    replayIntro: forgetIntro,
    // Puts a running transition at a given instant without waiting for it.
    // Exposed so the animation can be inspected and reported on precisely
    // ("at 4s the tiles are still solid") rather than described from memory,
    // and so it can be verified where requestAnimationFrame does not run.
    debugRenderAt: function (elapsedMs) {
      if (!active) return null;
      var durationMs = active.durationMs;
      var done = active.renderAt(elapsedMs);
      // Lands exactly as the real loop would, so stepping to the end is a
      // faithful rehearsal of it rather than only of its middle. Read
      // durationMs first, finishing clears `active`. The real loop's own
      // pending frame is cancelled with it: left scheduled, it found `active`
      // gone, threw on every frame until the run's time was up, and then
      // finished the transition a SECOND time, switching views again under
      // whatever had happened since.
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
      // Bypasses transitionTo/goToEditor (no zoom animation makes sense from
      // this empty, nothing-hovered state), so it needs the same pause that
      // path applies for itself: see the matching call and its own comment
      // in transitionTo.
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

  // ---- The address bar ----
  //
  // The whole state of the app is in the URL fragment: which page, the
  // scene, and on the map the view of it (share-url.js is the format). So
  // sharing anything is sharing the address, and opening an address rebuilds
  // what it describes.
  //
  // Two kinds of write. Moving BETWEEN the two pages with the app's own
  // buttons (Fractal-ize, Back to scene editor) is a navigation: it pushes a
  // new history entry, so the browser's Back and Forward buttons walk between
  // the builder and the map the way they would between two real pages. Coming
  // back that way has no animation, the explainer is about sending a scene
  // to the map, and Back is not that, it simply opens what the entry
  // describes, through the same path a pasted link takes (the hashchange
  // listener below). Everything that changes WITHIN a page only ever replaces
  // the current entry:
  //
  // WRITTEN on a timer rather than from every place state can change. There
  // are dozens of those across two large modules, a missed one would be a
  // link that silently lies, and the whole state serializes in microseconds
  // - so twice a second this asks both pages what is true and rewrites the
  // address if that has changed. replaceState, never pushState or
  // location.hash: a session of editing must not become four hundred Back
  // presses, and replaceState alone does not fire hashchange, which leaves
  // that event meaning exactly one thing, below. Twice a second is also well
  // inside the rate at which browsers start refusing history writes (Safari:
  // a hundred per thirty seconds).
  //
  // READ on load, and again whenever the fragment changes under a page that
  // is already up: a link pasted over the address, or Back to one. That is
  // a navigation within the same document, so nothing reloads and this is
  // the only thing that will act on it.
  var ADDRESS_SYNC_MS = 500;
  // What the address last said on this page's own account (written, or
  // loaded from), so a change can be told from no change.
  var lastFragment = null;
  // Set by a navigation between the pages (see transitionTo): the next
  // address written is a NEW history entry rather than a rewrite of this one.
  // It waits for that write, which, mid-transition, is a few seconds off.
  var pushPending = false;

  function currentFragment() {
    // Mid-transition neither page's state is settled: the grid's zoom is
    // being driven by the animation, and `current` still names the page
    // being left.
    if (active) return null;
    if (current === "grid") {
      var state = global.FractalGrid.shareState();
      if (!state) return null;
      return global.ShareUrl.encode({
        page: global.ShareUrl.PAGE_MAP,
        // The grid runs the scene in engine space, in the frame it was sent
        // in; a link describes it from the center of that same frame.
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
    // (A navigation that ended up where it started has nothing to push.)
    if (fragment === lastFragment) { pushPending = false; return; }
    try {
      if (pushPending) global.history.pushState(null, "", "#" + fragment);
      else global.history.replaceState(null, "", "#" + fragment);
      pushPending = false;
      lastFragment = fragment;
    } catch (err) {
      // Refused (rate limit, or a sandboxed frame): the address is stale
      // until the next tick gets through, and nothing else is affected.
    }
  }

  // Opens whatever the address describes. `onLoad` is the one difference
  // between the two times this runs: on load the editor has already taken
  // the scene for itself (it has to, before its first render, see
  // loadSceneFromLink in physics-ui.js), so here it is only checked.
  // Whether two scenes are the same scene, by the only definition that
  // matters here: they would be written into an address identically.
  function sameScene(a, b) {
    try {
      var P = global.ShareUrl.PAGE_BUILDER;
      return !!a && !!b && global.ShareUrl.encode({ page: P, scene: a }) === global.ShareUrl.encode({ page: P, scene: b });
    } catch (err) {
      return false;
    }
  }

  function openAddress(onLoad) {
    // Whatever this opens is being opened by the ADDRESS, typed, pasted, or
    // reached with Back or Forward, so the entry for it already exists, and
    // a push still waiting from an interrupted transition must not add one.
    pushPending = false;
    var link;
    try {
      link = global.ShareUrl.decode(global.location.hash);
    } catch (err) {
      global.PhysicsUI.reportLinkProblem("This link's scene couldn't be read: " + err.message);
      return;
    }
    // Not a link to a scene: the page opens the way it always has.
    if (!link || !link.scene) return;
    // A movie's link, opened on the wrong page: it belongs to the player.
    if (link.page === global.ShareUrl.PAGE_MOVIE) {
      global.location.replace("chaosplayback.html" + global.location.hash);
      return;
    }
    // The editor takes the scene whichever page the link is for: it is
    // where the map's own Back leads.
    // Back and Forward mostly arrive at a scene the editor is already
    // holding, it is the one that was sent to the map in the first place,
    // and loading it again would cost the editor its selection, and flag a
    // scene the user built as one that arrived by link.
    var editorHasIt = !onLoad && sameScene(global.PhysicsUI.shareScene(), link.scene);
    var problem = onLoad ? global.PhysicsUI.sharedSceneProblem(link.scene)
      : editorHasIt ? null : global.PhysicsUI.loadSharedScene(link.scene);
    if (problem) {
      global.PhysicsUI.reportLinkProblem("This link's scene couldn't be loaded: " + problem);
      return;
    }
    stopActive(true);
    if (link.page === global.ShareUrl.PAGE_MAP) {
      // Likewise the map: Forward to the map that Back just left finds its
      // scene still compiled, and starting it again would mean rebuilding
      // every shader, seconds, on a phone, to arrive at what is already
      // there. Only the view has to be put back.
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
        // The scene itself is fine, so it stays open in the builder.
        global.PhysicsUI.reportLinkProblem("This link's map couldn't be opened: " + err.message);
      }
      if (gridScene) {
        // Straight there, no explainer: the animation is about a scene
        // collapsing into one pixel of its map, and someone arriving by
        // link never saw the scene.
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
  // Set by chaos.html's own inline script for a map link, to keep the editor
  // from flashing up before this script has had its turn.
  document.documentElement.classList.remove("opening-map");
  syncAddress();
  setInterval(syncAddress, ADDRESS_SYNC_MS);
  global.addEventListener("hashchange", function () {
    if (global.ShareUrl.cleanFragment(global.location.hash) === lastFragment) return;
    openAddress(false);
    // Whatever came of that, the address goes back to describing what is
    // actually on screen: the link as this page would write it, or, for one
    // that couldn't be opened, the state it was refused in favor of.
    lastFragment = null;
    syncAddress();
  });

  // Both Settings panels carry the same reset, since either view can be the
  // one you are looking at when you decide you want the explainer back. The
  // two buttons don't necessarily share a label (the grid page's reads
  // "Reset Intro Animation"; the editor's own copy may not): each restores
  // its OWN original text rather than a string shared between them.
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
