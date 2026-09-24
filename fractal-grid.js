// This file is part of Chaos Accelerator, licensed under the Common Public
// Attribution License, Version 1.0 (CPAL-1.0) - see LICENSE in the project
// root, or https://chaosaccelerator.com/license for a hosted copy.

// Renders every pixel's offset scene run forward a fixed number of steps,
// colored by the Output property's value at the END of that run. The scene
// is handed over by the app shell (from #editor-view's "Send to Fractal
// Grid" button, or from a shared link - see transition.js) and compiled into
// WebGL2 shaders - there's no live editing here, unlike the physics simulator.
// Each render (on load, pan, zoom, or resize) redoes the full offset +
// simulation for every pixel from scratch, for however many steps the
// timeline currently shows - which is the Settings panel's Simulation
// Duration unless the timeline has been moved. Playing that timeline is the
// one thing that can't afford to start from scratch, and doesn't: see the
// Playback section near the end.
(function (global) {
  "use strict";

  // ---- Started on demand, not at load ----
  //
  // Both views live in one document now (chaos.html), and the grid has no
  // scene to compile until the editor hands one over. So the whole module
  // body below is a function: nothing touches WebGL, reads the handoff or
  // binds a listener until FractalGrid.start(scene) runs, which the app
  // shell calls the first time you Fractal-ize.
  //
  // Started ONCE and then kept alive, rather than torn down and rebooted
  // per visit. Every window-level listener it binds is already guarded by
  // its own state (a drag that isn't happening, a tip that isn't showing),
  // so a hidden grid's listeners are inert - whereas unbinding 37 of them
  // and reliably dropping a WebGL context would be a lot of machinery to
  // get exactly right for no visible difference. Re-entering with a
  // different scene goes through setScene() instead (see the end of boot).
  var started = false;
  global.FractalGrid = {
    start: function (scene) {
      if (started) { global.FractalGrid.setScene(scene); return; }
      started = true;
      boot(scene);
    },
    isStarted: function () { return started; },
    // Replaced by boot() with the real implementations once it has run;
    // these stubs only exist so a caller can't hit `undefined` before then.
    setScene: function () {},
    shareState: function () { return null; },
    applyShareView: function () {},
    renderStill: function () {},
  };

  // ---- One settings body ----
  //
  // Both pages have a Settings panel, and they are the same panel: there is
  // exactly one set of controls in the document (#shared-settings-body) and
  // it is MOVED into whichever page is on screen - the builder's panel or the
  // map's card - by placeSettings, which the app shell calls as it switches
  // pages (see showOnly in transition.js). Nothing is copied, so nothing can
  // fall out of step.
  //
  // Most of those controls steer the map's renderer, which does not exist
  // until the first Fractal-ize (see "Started on demand", above). Until then
  // the controls themselves are the record of what was chosen: the little
  // below keeps them coherent with each other - the preset slider sets the
  // others and follows them, the two resolution handles don't cross, the
  // readouts read - and boot() takes its starting values from them
  // (readPerf, readPrecision) instead of from constants. Once the map has
  // started, its own wiring of these same elements takes over and everything
  // here stands down (`started`).
  var PERF_PRESETS = {
    low: { endStride: 2, antialias: false, reuse: true, maxDpr: 2, frameMs: 50, drawMs: 20, playbackMB: 96, gestureFirst: true },
    high: { endStride: 1, antialias: true, reuse: true, maxDpr: 0, frameMs: 0, drawMs: 5, playbackMB: 256, gestureFirst: false },
  };
  // A phone or tablet starts at Low, everything else at High (see
  // LayoutMode.isConstrained). Page state: every visit starts from the
  // device's own preset again.
  var perfDefaultPreset = global.LayoutMode && global.LayoutMode.isConstrained() ? "low" : "high";

  var sharedSettings = (function () {
    function $(id) { return document.getElementById(id); }
    var body = $("shared-settings-body");
    var el = {
      preset: $("perf-preset-slider"), precision: $("precision-select"),
      resMin: $("resolution-min-slider"), resMax: $("resolution-max-slider"),
      resFill: $("resolution-range-fill"), resReadout: $("resolution-bounds-readout"),
      antialias: $("antialias-checkbox"), reuse: $("reuse-picture-checkbox"), gesture: $("perf-gesture-checkbox"),
      dpr: $("perf-dpr-select"), frame: $("perf-frame-select"), draw: $("perf-draw-select"), memory: $("perf-playback-memory-select"),
      lineCount: $("inspect-line-sample-count-slider"), lineCountReadout: $("inspect-line-sample-count-readout"),
      gridSize: $("inspect-grid-size-slider"), gridSizeReadout: $("inspect-grid-size-readout"),
      volume: $("grid-sound-volume-slider"), volumeIcon: $("grid-sound-volume-icon"),
      resetTips: $("grid-btn-reset-tips"), resetAll: $("grid-btn-reset-all"),
    };
    var labels = Array.prototype.slice.call(document.querySelectorAll(".perf-preset-labels [data-preset]"));
    var STOPS = { low: 0, custom: 1, high: 2 };
    var NAMES = { low: "Low Performance Devices", custom: "Custom", high: "High Performance Devices" };
    // Where the right-hand resolution handle sits for each preset's endStride
    // (boot's RESOLUTION_SLIDER_FOR_STRIDE says why 90).
    var RES_MAX = { 1: "100", 2: "90" };

    function readPerf() {
      return {
        antialias: el.antialias.checked, maxDpr: Number(el.dpr.value), frameMs: Number(el.frame.value),
        drawMs: Number(el.draw.value), playbackMB: Number(el.memory.value), gestureFirst: el.gesture.checked,
      };
    }
    function readPrecision(ladder) {
      var v = el.precision.value;
      return v === "auto" || ladder.indexOf(v) !== -1 ? v : "auto";
    }
    function writePreset(name) {
      var p = PERF_PRESETS[name];
      el.resMin.value = "0";
      el.resMax.value = RES_MAX[p.endStride];
      el.antialias.checked = p.antialias;
      el.reuse.checked = p.reuse;
      el.gesture.checked = p.gestureFirst;
      el.dpr.value = String(p.maxDpr);
      el.frame.value = String(p.frameMs);
      if (!el.draw.disabled) el.draw.value = String(p.drawMs);
      el.memory.value = String(p.playbackMB);
    }
    function presetNow() {
      var names = ["low", "high"];
      for (var i = 0; i < names.length; i++) {
        var p = PERF_PRESETS[names[i]];
        if (el.resMin.value === "0" && el.resMax.value === RES_MAX[p.endStride] && el.antialias.checked === p.antialias &&
            el.reuse.checked === p.reuse && el.gesture.checked === p.gestureFirst && Number(el.dpr.value) === p.maxDpr &&
            Number(el.frame.value) === p.frameMs && Number(el.memory.value) === p.playbackMB &&
            (el.draw.disabled || Number(el.draw.value) === p.drawMs)) return names[i];
      }
      return "custom";
    }
    function syncPreset() {
      var preset = presetNow();
      el.preset.value = String(STOPS[preset]);
      el.preset.setAttribute("aria-valuetext", NAMES[preset]);
      labels.forEach(function (l) { l.classList.toggle("is-current", l.getAttribute("data-preset") === preset); });
    }
    function syncReadouts() {
      el.lineCountReadout.textContent = el.lineCount.value;
      el.gridSizeReadout.textContent = el.gridSize.value + "\u00d7" + el.gridSize.value;
      el.resFill.style.left = el.resMin.value + "%";
      el.resFill.style.width = Math.max(0, Number(el.resMax.value) - Number(el.resMin.value)) + "%";
      // In pixels it depends on the map's canvas, which isn't there yet.
      el.resReadout.textContent = el.resMax.value === "100" ? "down to 1 sim/px" : el.resMax.value === "90" ? "down to 2px" : "set";
    }

    // Everything below is the pre-map half, and stands down once it starts.
    function early(fn) { return function (e) { if (!started) fn(e); }; }
    el.preset.addEventListener("input", early(function () {
      var stop = Number(el.preset.value);
      if (stop === STOPS.low) writePreset("low"); else if (stop === STOPS.high) writePreset("high");
      syncReadouts();
    }));
    el.preset.addEventListener("change", early(syncPreset));
    el.preset.addEventListener("keydown", early(function (e) {
      var toward = { ArrowLeft: "low", ArrowDown: "low", Home: "low", ArrowRight: "high", ArrowUp: "high", End: "high" }[e.key];
      if (!toward) return;
      e.preventDefault();
      writePreset(toward); syncReadouts(); syncPreset();
    }));
    labels.forEach(function (l) {
      var name = l.getAttribute("data-preset");
      if (name !== "custom") l.addEventListener("click", early(function () { writePreset(name); syncReadouts(); syncPreset(); }));
    });
    body.addEventListener("input", early(function (e) {
      if (e.target === el.preset) return;
      if (Number(el.resMin.value) > Number(el.resMax.value)) {
        if (e.target === el.resMin) el.resMin.value = el.resMax.value; else el.resMax.value = el.resMin.value;
      }
      syncReadouts(); syncPreset();
    }));
    body.addEventListener("change", early(function (e) { if (e.target !== el.preset) syncPreset(); }));

    // These three need nothing of the map's, so they are wired here once
    // and for all rather than inside boot.
    function volumeIcon(volume) {
      var muted = volume <= 0;
      el.volumeIcon.querySelector(".vol-arc-1").style.display = muted ? "none" : "inline";
      el.volumeIcon.querySelector(".vol-arc-2").style.display = (muted || volume <= 0.5) ? "none" : "inline";
      el.volumeIcon.querySelector(".vol-mute-x").style.display = muted ? "inline" : "none";
      el.volume.value = String(Math.round(volume * 100));
    }
    el.volume.addEventListener("input", function () { PhysicsSound.setVolume(Number(el.volume.value) / 100); });
    PhysicsSound.onVolumeChange(volumeIcon);
    volumeIcon(PhysicsSound.getVolume());
    el.resetTips.addEventListener("click", function () {
      try { localStorage.removeItem("physicsAppDismissedTips"); } catch (err) { /* never reachable: nothing to clear */ }
      var original = el.resetTips.textContent;
      el.resetTips.textContent = "Tips reset";
      setTimeout(function () { el.resetTips.textContent = original; }, 1500);
    });
    // "Deletes all cookies for the page" per the user's ask - this app keeps
    // its state in localStorage, not cookies, so that (plus any cookies this
    // origin might still pick up some day) is what actually needs clearing.
    // A hard reload after wiping is the simplest way to put every module back
    // in its true first-run state, rather than hand-resetting each one here.
    el.resetAll.addEventListener("click", function () {
      if (!global.confirm("Reset all saved data for this page? This clears your saved scene, dismissed tips, and intro animation state, then reloads.")) return;
      try { localStorage.clear(); } catch (err) { /* nothing to clear */ }
      try {
        document.cookie.split(";").forEach(function (pair) {
          var name = pair.split("=")[0].trim();
          if (name) document.cookie = name + "=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/";
        });
      } catch (err) { /* same */ }
      // The scene is in the address bar too (see share-url.js), and a plain
      // reload would load it straight back in - so the address is cleared
      // first, which is what makes this the reset it says it is.
      try { global.history.replaceState(null, "", global.location.pathname + global.location.search); } catch (err) { /* reloads where it is */ }
      global.location.reload();
    });

    // The page as it loads: the device's preset, Auto precision (explicitly
    // - browsers restore form controls across a reload), and the builder's
    // panel as the body's home, since the builder is the page that is up.
    // An Apple GPU holds the draw length at its first stop (boot's
    // drawLengthLocked, which also knows the GPU's name, says why); by
    // platform alone is as much as can be known before there is a context.
    if (/Mac|iPhone|iPad|iPod/.test((global.navigator && (global.navigator.platform || global.navigator.userAgent)) || "")) el.draw.disabled = true;
    el.precision.value = "auto";
    writePreset(perfDefaultPreset);
    syncReadouts();
    syncPreset();

    function place(view) {
      var home = view === "grid" ? $("grid-settings-panel") : $("editor-settings-mount");
      if (home && body.parentNode !== home) home.appendChild(body);
    }
    place("editor");
    return { readPerf: readPerf, readPrecision: readPrecision, place: place };
  })();
  global.FractalGrid.placeSettings = sharedSettings.place;

  function boot(bootScene) {

  var DEFAULT_CENTER = { x: 0, y: 0 };
  // How much world the view spans across its reference height on load -
  // and, because the readout reports DEFAULT_SCALE / view.scale, also
  // whatever the readout calls 1.00x. The two are the same number on
  // purpose: the framing you land on IS the origin of the zoom scale.
  //
  // Was 200. The starting framing is now the one that used to read 0.17x -
  // wider, showing the whole structure on load instead of opening part-way
  // into it - and raising this rebases the readout in the same move, so
  // that framing reads 1.00x rather than 0.17x. Written as the derivation
  // rather than the product (1176.47) so the relationship to the old
  // framing stays legible.
  var DEFAULT_SCALE = 200 / 0.17;
  // The zoom readout's 1e26x, written as the zoom it is rather than as the
  // scale that happens to produce it (~1.18e-23).
  //
  // Deliberately PAST the last precision's limit, not at it. Each
  // multi-float precision (physics-df.js) buys about seven more digits -
  // ~14 at two words, ~21 at three, ~28 at four - and the last of them has
  // its full margin (64 of its own smallest steps per pixel, the same
  // margin every switch on the way down is made at) until about 1e24x. By
  // 1e26x a pixel is down to a step or less, so neighbouring pixels start
  // from the same world point and the picture goes to blocks: the wall
  // float32 hits at ~1e5x, met again 21 digits later. Stopping short of it
  // would make the limit look arbitrary; letting the last decade or two
  // show is what explains it. (Going further would take a fifth word, and
  // a view centre held to more than the ~32 digits it has now.) The
  // precision readout in the Settings panel says which one is running.
  var MIN_SCALE = DEFAULT_SCALE / 1e26;
  var MAX_SCALE = 1e6;

  // How far each pixel's own simulation is run before its Output value is
  // read. Settings > Simulation Duration. Seeded from the sent scene's own
  // simulationSteps (the same slider, authored on #editor-view) so a scene
  // arrives showing what it was authored to show - but it's still freely
  // adjustable from here afterward, purely for this page's own session, the
  // same way pan/zoom is: exploring a different depth doesn't rewrite what
  // was sent, since there's no path back to #editor-view's saved copy.
  //
  // It's a plain uniform rather than something baked into the shader -
  // GLSL ES 3.00 dropped ES 1.00's constant-loop-bound rule, so the step
  // loop can just read it. That keeps the slider instant (no recompile of
  // four programs per notch) and, measured, the dynamic bound is if
  // anything marginally faster than the unrolled constant one.
  var DEFAULT_SIMULATION_STEPS = 500;
  // Slider notches are hundreds of steps: 1 -> 100, 50 -> 5000. Every
  // position lands on a round number, and 50 stops is ample for a control
  // whose cost is exactly linear in its value.
  var SIMULATION_STEPS_PER_NOTCH = 100;
  var simulationSteps = DEFAULT_SIMULATION_STEPS;

  var menuColumn = document.getElementById("grid-menu-column");
  var menuStack = document.getElementById("grid-menu-stack");
  var panelResizer = document.getElementById("panel-resizer");
  var canvasArea = document.getElementById("grid-canvas-area");
  var canvas = document.getElementById("grid-canvas");
  var emptyState = document.getElementById("empty-state");
  var statusEl = document.getElementById("grid-status");
  var zoomReadout = document.getElementById("zoom-readout");
  var btnResetView = document.getElementById("btn-reset-view");
  var resolutionMinSlider = document.getElementById("resolution-min-slider");
  var resolutionMaxSlider = document.getElementById("resolution-max-slider");
  var resolutionRangeFill = document.getElementById("resolution-range-fill");
  var resolutionBoundsReadout = document.getElementById("resolution-bounds-readout");
  var renderProgressRingCoarse = document.getElementById("render-progress-ring-coarse");
  var renderProgressRingAa = document.getElementById("render-progress-ring-aa");
  var renderProgressRingCoarseOpen = document.getElementById("render-progress-ring-coarse-open");
  var renderProgressRingAaOpen = document.getElementById("render-progress-ring-aa-open");
  var renderProgressLabel = document.getElementById("render-progress-label");
  var colorZoomCheckbox = document.getElementById("color-zoom-checkbox");
  var colorZoomField = document.getElementById("color-zoom-field");
  var displayModePanelBody = document.getElementById("grid-display-mode-list");
  var btnInspectPoint = document.getElementById("btn-inspect-point");
  var btnInspectLine = document.getElementById("btn-inspect-line");
  var btnInspectGrid = document.getElementById("btn-inspect-grid");
  var btnInspectClearAll = document.getElementById("btn-inspect-clear-all");
  var btnSuperlativeLargest = document.getElementById("btn-superlative-largest");
  var btnSuperlativeSmallest = document.getElementById("btn-superlative-smallest");
  var btnSuperlativeEdge = document.getElementById("btn-superlative-edge");
  var btnSuperlativeRarest = document.getElementById("btn-superlative-rarest");
  var inspectMenuEl = document.getElementById("menu-inspect");
  var inspectListEl = document.getElementById("inspect-list");
  var inspectPreviewSvg = document.getElementById("inspect-preview");
  var inspectToastEl = document.getElementById("inspect-toast");
  var tipPopover = document.getElementById("tip-popover");
  var tipPopoverText = document.getElementById("tip-popover-text");
  var tipPopoverOk = document.getElementById("tip-popover-ok");
  var tipPopoverDismiss = document.getElementById("tip-popover-dismiss");
  var statsPanelBodyEl = document.getElementById("grid-stats-panel-body");
  var stepsSlider = document.getElementById("steps-slider");
  var stepsReadout = document.getElementById("steps-readout");
  var precisionReadout = document.getElementById("precision-readout");
  var precisionSelect = document.getElementById("precision-select");
  var reusePictureCheckbox = document.getElementById("reuse-picture-checkbox");
  var inspectLineSampleCountSlider = document.getElementById("inspect-line-sample-count-slider");
  var inspectLineSampleCountReadout = document.getElementById("inspect-line-sample-count-readout");
  var inspectGridSizeSlider = document.getElementById("inspect-grid-size-slider");
  var inspectGridSizeReadout = document.getElementById("inspect-grid-size-readout");
  var inspectGridTwoPartCheckbox = document.getElementById("inspect-grid-two-part-checkbox");
  var gridPlayPauseBtn = document.getElementById("grid-play-pause");
  var gridRestartBtn = document.getElementById("grid-restart");
  var gridTimelineSlider = document.getElementById("grid-timeline-slider");
  var gridTimelineReadout = document.getElementById("grid-timeline-readout");
  var gridSpeedBtn = document.getElementById("grid-speed-btn");
  var gridSpeedPopup = document.getElementById("grid-speed-popup");
  var gridSpeedSlider = document.getElementById("grid-speed-slider");
  var gridSpeedValueEl = document.getElementById("grid-speed-value");
  var hoverMuteBtn = document.getElementById("hover-mute");
  var gridSoundVolumeSlider = document.getElementById("grid-sound-volume-slider");
  var gridSoundVolumeIcon = document.getElementById("grid-sound-volume-icon");

  function setStatus(ok, message) {
    statusEl.textContent = message;
    statusEl.className = ok ? "status-ok" : "status-error";
  }

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  // Play and pause as small drawings rather than the characters they used
  // to be. U+23F8 has an emoji form, and a phone with no plain-text glyph
  // for it draws that: an orange tile in a row of white icons. A path looks
  // the same everywhere. (Same two in physics-ui.js, for the editor's
  // transport.) Skipped when the button already shows the right one - the
  // timeline's is refreshed every frame of playback.
  var PLAY_ICON_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M8 5.14v13.72a.6.6 0 0 0 .92.5l10.55-6.86a.6.6 0 0 0 0-1L8.92 4.64a.6.6 0 0 0-.92.5z"></path></svg>';
  var PAUSE_ICON_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"></rect><rect x="14" y="5" width="4" height="14" rx="1"></rect></svg>';
  function setPlayPauseIcon(button, playing) {
    var want = playing ? "pause" : "play";
    if (button.getAttribute("data-icon") === want) return;
    button.setAttribute("data-icon", want);
    button.innerHTML = playing ? PAUSE_ICON_SVG : PLAY_ICON_SVG;
  }

  // ---- Performance settings: the values ----
  //
  // Every knob that trades the picture's quality, or the page's smoothness,
  // against how soon the picture is finished - gathered under Settings >
  // Performance Settings, where a three-stop slider sets them all at once.
  // (The controls and the slider are wired near the end of boot, under
  // "Performance settings: the controls"; this is only the state, up here
  // because the first things to read it run long before that.)
  //
  // Two presets. HIGH is this page as it was tuned on a desktop, every value
  // what it used to be as a constant. LOW is everything known to help a GPU
  // that cannot keep up - a phone first of all, but just as much an old
  // laptop, which is why none of this asks what kind of device it is on: the
  // device only decides which preset the page STARTS at.
  //
  // (Numeric precision is NOT one of them, though it costs more than all of
  // them put together: it is about how deep a zoom stays sharp rather than
  // about the device, the deep-zoom tip offers it at the zoom where it starts
  // to matter, and it sits just above this section in the card.)
  //
  //   endStride   - where refinement stops: 1 is a simulation per canvas
  //                 pixel, 2 is one per 2x2 block - a quarter of the work,
  //                 and on a phone's pixel pitch still a sharp picture.
  //   antialias   - three more full-resolution passes after the picture is
  //                 complete. Four times the work of not doing it.
  //   reuse       - Reuse Last Picture (see "Picture reuse"): a pan keeps the
  //                 pixels it already has instead of starting over. On in
  //                 both, like precision: it is here to sit with the others
  //                 and to be switched off, not because the presets differ.
  //   maxDpr      - the most canvas pixels per CSS pixel (0: no cap). A phone
  //                 reports 3, which is 2.25 times the simulations of 2, and
  //                 every full-size float target is sized by it too.
  //   frameMs     - how long a frame of rendering may take (0: one display
  //                 refresh). See frameBaseMs.
  //   drawMs      - how long ONE draw may run. See sliceTargetMs.
  //   playbackMB  - Map Evolution's state budget. See playbackStateMaxBytes.
  //   gestureFirst - while the map is being dragged or pinched, render
  //                 NOTHING: only move the picture already on screen. See
  //                 "Gestures first". Off on a GPU quick enough to redraw the
  //                 map under the finger, which looks better than moving an
  //                 old picture does; on where it is not, because there the
  //                 redraw is what makes the finger feel ignored.
  // (PERF_PRESETS itself, and which one a device starts at, are declared
  // outside boot - see "One settings body" - because the Settings controls
  // exist, and can be worked, before the map has ever been started.)
  //
  // The settings that are nothing BUT a number live here; reuse and the
  // resolution handles keep the variables and controls they always had
  // (reuseEnabled, the two sliders), which the rest of the file already
  // reads. They start as whatever the CONTROLS say: the controls were put at
  // the device's preset when the page loaded, and the builder page shows
  // them too, so by now they may have been changed.
  var perf = sharedSettings.readPerf();

  // What the performance readout reports (see "The performance readout",
  // near the end of boot). Kept whether or not the readout is showing - each
  // of these is an assignment or an addition on a path that was already
  // running - so switching it on shows the run in progress, not a blank.
  var perfStats = {
    gpuMs: 0,              // last GPU-timed frame, where there are timer queries
    workFrameMs: 0,        // smoothed interval between frames that did work
    workFrameMaxMs: 0,     // ...and the longest, since the run began
    drawsThisFrame: 0, drawsLastFrame: 0,
    sliceStepMs: 0,        // what calibrateSliceSteps measured a step at
    calibrationMs: 0,      // page time spent in calibrations, this scene
    builds: 0, buildMs: 0, lastBuildMs: 0,
    run: null,             // the refinement run in progress or last finished
    presentOnlyAt: -1e9,   // when a frame last only moved the picture (see "Gestures first")
    busyWaits: 0,          // frames that sat out because the GPU had not finished the last one
  };

  // How many of the canvas's own pixels there are to a CSS pixel: the
  // display's ratio, up to the Canvas pixel density setting (perf.maxDpr).
  // Everything that sizes the backing store, or reasons about how fine "one
  // pixel" is, asks this rather than window.devicePixelRatio - capped, the
  // two differ, and the backing store is the one the simulations are counted
  // in.
  function gridDpr() {
    var dpr = window.devicePixelRatio || 1;
    return perf.maxDpr > 0 ? Math.min(dpr, perf.maxDpr) : dpr;
  }

  // ---- Reusable tip popover ----
  //
  // One shared instance, repointed and reworded per call - not specific to
  // Color Zoom. To add another tip anywhere else in the app, just call
  // showTip(id, anchorEl, text) from wherever its condition is detected; id
  // is only ever used as the "don't tell me again" localStorage key, so
  // pick a short, stable, unique one for each distinct tip.
  // Shared (not view-specific) - #editor-view's Settings panel Reset Tool
  // Tips button clears this exact key too, so it works for tips shown on
  // either view from one place.
  var TIP_DISMISSED_KEY = "physicsAppDismissedTips";
  var activeTipId = null;

  function loadDismissedTips() {
    try {
      return JSON.parse(localStorage.getItem(TIP_DISMISSED_KEY)) || {};
    } catch (err) {
      return {};
    }
  }

  function isTipDismissed(id) {
    return !!loadDismissedTips()[id];
  }

  function dismissTipForever(id) {
    var dismissed = loadDismissedTips();
    dismissed[id] = true;
    try {
      localStorage.setItem(TIP_DISMISSED_KEY, JSON.stringify(dismissed));
    } catch (err) {
      // Full/unavailable storage just means it may show again later - the
      // tip itself still gets dismissed for now either way.
    }
  }

  var activeTipAnchor = null;
  var activeTipNoArrowAbove = false;
  // What OK does for the tip currently showing, when "just close it" isn't
  // the whole story - see showTip's own comment.
  var activeTipOnOk = null;

  function hideTip() {
    tipPopover.hidden = true;
    activeTipId = null;
    activeTipAnchor = null;
    activeTipOnOk = null;
  }

  // Below anchorEl's bottom-left corner, clamped so it doesn't run off the
  // right edge. Pulled out of showTip so repositionActiveTip can call it
  // again whenever the anchor itself might have moved (dragging the panel
  // resizer changes where every sidebar element sits, without the anchor
  // element ever firing an event of its own about it).
  // Whether a tip's anchor is actually on screen to be pointed at. Every
  // anchor now lives inside the menu column, where it can be in a collapsed
  // card (no box at all) or scrolled out of the stack - and a popover
  // pointing at either is a popover parked in a corner, explaining
  // something the user cannot see.
  function tipAnchorVisible(anchorEl) {
    if (!anchorEl) return false;
    var rect = anchorEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    return rect.bottom > 0 && rect.top < window.innerHeight;
  }

  function positionTip(anchorEl) {
    var rect = anchorEl.getBoundingClientRect();
    var width = tipPopover.offsetWidth;
    var height = tipPopover.offsetHeight;
    var left = clamp(rect.left, 12, window.innerWidth - width - 12);
    // Below the anchor, unless that would run off the bottom of the window
    // and there is room above it instead - which is every anchor in the
    // small-window layout's dock, since the dock IS the bottom of the window.
    // Clamped to the window only tucks the popover over the very control it
    // is about, with its arrow pointing away from it. (.tip-above moves the
    // arrow to the popover's bottom edge - see mobile.css.)
    var above = rect.bottom + 10 + height > window.innerHeight - 12 && rect.top - 10 - height >= 12;
    tipPopover.classList.toggle("tip-above", above);
    // See showTip's opts.noArrowAbove.
    tipPopover.classList.toggle("tip-no-arrow", above && activeTipNoArrowAbove);
    // Vertically clamped for the same reason the horizontal clamp exists,
    // and newly necessary: an anchor part-way out of the scrolling menu
    // column would otherwise put the whole popover above the top of the
    // window.
    tipPopover.style.top = clamp(above ? rect.top - 10 - height : rect.bottom + 10, 12, Math.max(12, window.innerHeight - height - 12)) + "px";
    tipPopover.style.left = left + "px";
    // Aim the arrow at the middle of the anchor rather than leaving it at a
    // fixed spot on the popover: the clamp above can push the body far from
    // the control it's about (most visibly for the Settings gear, which sits
    // at the right edge - the body lands to its left, so a left-side arrow
    // pointed at nothing). ARROW_SIZE/2 centers the rotated square on the
    // anchor; the clamp keeps it clear of the rounded corners at either end.
    var ARROW_SIZE = 10, CORNER_INSET = 10;
    var arrowLeft = rect.left + rect.width / 2 - left - ARROW_SIZE / 2;
    tipPopover.style.setProperty("--tip-arrow-left",
      clamp(arrowLeft, CORNER_INSET, Math.max(CORNER_INSET, width - CORNER_INSET - ARROW_SIZE)) + "px");
  }

  // Points the shared popover at anchorEl and shows `text`. No-ops (and
  // returns false) if this exact id was already permanently dismissed, or is
  // already the one currently showing.
  //
  // opts.onOk (optional): what the OK button does, for a tip that walks the
  // user somewhere instead of only telling them something. It takes over
  // completely - closing the tip afterwards (hideTip) is its own job.
  // Without it, OK just closes.
  function showTip(id, anchorEl, text, opts) {
    if (isTipDismissed(id) || activeTipId === id) return false;
    // Nothing to point at - don't burn the tip's one showing on a card the
    // user has collapsed. It offers itself again next time the view
    // settles, by which point the card may well be open.
    if (!bringTipAnchorIntoView(anchorEl)) return false;
    activeTipId = id;
    activeTipAnchor = anchorEl;
    activeTipOnOk = (opts && opts.onOk) || null;
    // opts.noArrowAbove: drop the arrow when the popover has had to go ABOVE
    // its anchor - which is the dock, where the anchor is a tab at the very
    // bottom of the screen. For a tip about a control that arrow is the
    // point; for one that explains the PICTURE it points down, away from the
    // picture, at a tab the tip is not about.
    activeTipNoArrowAbove = !!(opts && opts.noArrowAbove);
    // "OK" is right for a tip that suggests doing something; a tip that only
    // explains what the user is already looking at has nothing to agree to,
    // so it can ask for "Dismiss" instead. Assigned every time rather than
    // only when overridden, or one relabelling tip would rename the button
    // for every tip shown after it.
    tipPopoverOk.textContent = (opts && opts.okLabel) || "OK";
    tipPopoverText.textContent = text;
    tipPopover.hidden = false;
    positionTip(anchorEl);
    return true;
  }

  // Scrolls an anchor back into the menu column if it has drifted out of
  // it, and reports whether it is pointable-at afterwards. Only called when
  // a tip first appears - NOT from repositionActiveTip,
  // which runs on every panel resize and would otherwise yank the column's
  // scroll out from under the user while they read.
  function bringTipAnchorIntoView(anchorEl) {
    if (!anchorEl) return false;
    var rect = anchorEl.getBoundingClientRect();
    // A zero box means a collapsed card, which scrolling cannot fix.
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (!tipAnchorVisible(anchorEl) && anchorEl.scrollIntoView) {
      anchorEl.scrollIntoView({ block: "nearest" });
    }
    return tipAnchorVisible(anchorEl);
  }

  // Called from anything that can move an anchor without the anchor itself
  // knowing it moved - the panel resizer drag, and a window resize.
  function repositionActiveTip() {
    if (activeTipAnchor) positionTip(activeTipAnchor);
  }
  window.addEventListener("resize", repositionActiveTip);

  tipPopoverOk.addEventListener("click", function () {
    // Read before calling: a handler that advances to the next step replaces
    // activeTipOnOk with that step's own.
    var onOk = activeTipOnOk;
    if (onOk) onOk();
    else hideTip();
  });
  tipPopoverDismiss.addEventListener("click", function () {
    if (activeTipId) dismissTipForever(activeTipId);
    hideTip();
  });

  // ---- The menus ----
  //
  // Inspect, Analysis and Display Mode in the column upper left, Settings
  // and Map Evolution in the column upper right, and the rendering-progress
  // gauge lower left (grouped with the left column - see its own comment at
  // the renderProgressMenu call below) - each a square icon button until it
  // is opened, at which point the button leaves the layout and its card
  // takes the space. One accordion per side, not one across the whole
  // screen: opening a left-side menu closes whichever OTHER left-side menu
  // was open, and likewise for the right side, but a left and a right menu
  // (e.g. Inspect and Settings) can be open together (see menuGroups
  // below). Zero open on a side is still fine - closing the last one there
  // just leaves the collapsed buttons.
  //
  // The open/shut state lives HERE rather than being read back off a class,
  // so the one thing that can vary (which of the button and the card is in
  // the layout) has exactly one owner.
  //
  // Every menu this factory builds registers itself in its side's group, so
  // opening one can close the others on that side without each menu having
  // to know them by name at its own construction time (settingsMenu/
  // inspectMenu/statsMenu are still being built when the first of them runs
  // this).
  // "movie" is a group of one: the Movie card stays open alongside Map
  // Evolution, whose frame its keyframes are taken at - and which puts the
  // map back to its last frame the moment it is closed (see playbackMenu).
  var menuGroups = { left: [], right: [], movie: [] };
  // Set by the dock (see "The dock", at the end of boot) once it exists:
  // called after any menu opens or shuts, with that menu, so the small-window
  // layout can re-fit its sheet around whatever is open now. Null until then,
  // and a no-op in the desktop layout.
  var onDockedMenuChange = null;
  function makeMenu(itemId, toggleId, side, onChange) {
    var item = document.getElementById(itemId);
    var toggle = document.getElementById(toggleId);
    var card = item.querySelector(".menu-card");
    var header = card.querySelector(".menu-card-header");
    var group = menuGroups[side];
    var open = false;
    function set(next) {
      next = !!next;
      if (next === open) return;
      open = next;
      if (open) {
        group.forEach(function (other) {
          if (other === api || !other.isOpen()) return;
          // While the dock holds the menus, the rendering-progress gauge is
          // the one menu still floating over the map, and no longer shares a
          // corner with anything: opening it must not shut the card in the
          // dock (which would resize the map to show a one-line label), nor
          // the other way round.
          if (other.docked !== api.docked) return;
          other.set(false);
        });
        // And in the dock the sides mean nothing: it is a tab bar, and a tab
        // bar shows one card. Half a phone's screen holds one card, and two
        // open at once put the second below a fold nobody scrolls to.
        if (api.docked) {
          Object.keys(menuGroups).forEach(function (side) {
            menuGroups[side].forEach(function (other) {
              if (other !== api && other.docked && other.isOpen()) other.set(false);
            });
          });
        }
      }
      item.classList.toggle("is-open", open);
      card.hidden = !open;
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      // Nothing to drag when every menu is shut - see #panel-resizer.
      menuColumn.classList.toggle("has-open-menu",
        !!document.querySelector("#grid-menu-stack .menu-item.is-open"));
      if (onDockedMenuChange) onDockedMenuChange(api);
      // A tip anchored to something inside a card that has just appeared or
      // vanished is pointing at a rect that no longer describes anything.
      repositionActiveTip();
      if (onChange) onChange(open);
    }
    // A toggle, not only "open": in the desktop layout the button leaves the
    // layout the moment its card opens, so it can only ever be clicked shut
    // and the two are the same thing - but in the dock the button stays put
    // as a tab, and pressing the tab of an open card is how it is put away.
    toggle.addEventListener("click", function () { set(!open); });
    // The whole header line collapses the card, not just the caret button -
    // the button (.menu-collapse) is still its own focusable element inside
    // the header, so Tab/Enter/Space keep working, and the click it
    // produces just bubbles up to this same listener.
    header.addEventListener("click", function () { set(false); });
    var api = {
      isOpen: function () { return open; },
      set: set,
      // Whichever of the button and the card is actually on screen, for a
      // tip to point at - the other one has display: none and a rect of
      // zeros, which would park the popover in the corner.
      anchor: function () { return open ? card : toggle; },
      // The three elements themselves, for the dock: it moves the button and
      // the card out of `item` and back (see "The dock").
      item: item,
      toggle: toggle,
      card: card,
      // True while the dock is holding this menu's button and card.
      docked: false,
    };
    group.push(api);
    return api;
  }

  var settingsMenu = makeMenu("menu-settings", "grid-btn-settings", "right");

  // Inspect holds the hover preview, its transport, the view controls and
  // the locked-point list - the workspace for reading the fractal rather
  // than for configuring it, which is why it is the one that starts open
  // (see the setInspectOpen call at the end of this file).
  //
  // Collapsing it genuinely stops the work, rather than only hiding it. The
  // preview is an animation with SOUND: left running behind a shut card it
  // would keep computing a trajectory per hovered cell and keep playing
  // bounce tones from a panel nobody can see, which on a page whose whole
  // point is an unobstructed fractal is the wrong way round.
  //
  // The locked points themselves are a different story: collapsing the card
  // hides their on-grid markers/mesh (updateInspectMarkers reads
  // inspectMenu.isOpen() itself - see its own comment) but never touches
  // inspectedGroups, so reopening brings back exactly what was there before.
  // disarmInspect matters here too - without it, Line/Grid left armed when
  // the card closes would still turn the next click or drag on the grid
  // into a new inspection, which is exactly what a collapsed Inspect card
  // is supposed to mean "not right now" to.
  var inspectMenu = makeMenu("menu-inspect", "grid-btn-inspect", "left",
    function (open) {
      if (open) {
        // Pick up whatever should be on screen now - the locked points if
        // there are any, the placeholder otherwise. Not the last hovered
        // cell: the cursor has been elsewhere since.
        if (inspectedGroups.length > 0) beginInspectOnlySession();
        else showHoverEmpty();
      } else {
        // End the session, don't just pause it: with the card shut there is
        // nothing for the map to be in lockstep WITH, so showHoverEmpty's
        // own releaseMapFollow is what puts the map back on the finished
        // field (and it clears hoverKey, so re-entering the same cell later
        // still previews it).
        showHoverEmpty();
        disarmInspect();
      }
      updateInspectMarkers();
    });
  function setInspectOpen(open) {
    inspectMenu.set(open);
  }

  var statsMenu = makeMenu("menu-stats", "grid-btn-stats", "left",
    function (open) {
      setStatsPanelOpen(open);
    });

  // Display has nothing to start or stop when it opens - the rows are
  // built once and the mode itself lives on whether the card is up or not -
  // so unlike Inspect and Analysis it needs no onChange at all. Kept (unlike the
  // old discarded return value) because checkColorSpreadAndMaybeSuggestColorZoom
  // needs to open this card itself before pointing the Color Zoom tip at the
  // toggle now living inside it.
  var displayMenu = makeMenu("menu-display", "grid-btn-display", "left");

  // The map's own transport plus the Simulation Duration slider that sets
  // where its timeline ends - see updateTimelineUI.
  //
  // This card being OPEN is the whole of what used to be Inspect's "Play
  // back in map" checkbox: while it is up, the map plays whatever step the
  // Inspect preview is showing (see followInspection), and shut, the map is
  // frozen at the finished field. A card you open to see the map evolve and
  // a switch that says "also evolve the map" were two ways of saying the
  // same thing, so there is now one.
  var playbackMenu = makeMenu("menu-playback", "grid-btn-playback", "right",
    function (open) {
      if (open) {
        // Opening it changes nothing on screen: the map stays exactly where
        // it was - at the end, scrubber parked on the last frame - and
        // stays there, hovering included, until the user works one of the
        // transport controls (see mapLinked).
        pauseTimeline();
        mapLinked = false;
      } else {
        freezeMapAtEnd();
      }
    });

  // The rendering-progress gauge (see updateRenderProgressRing further
  // down) doubles as another accordion menu - registering it here is the
  // whole of what that takes, since makeMenu only needs the two elements'
  // ids and doesn't care that this one lives in the lower left instead of
  // a column. It joins the LEFT group since that's the corner it actually
  // sits in, even though it isn't part of #grid-menu-stack. Nothing to
  // start or stop on open/close, same as displayMenu.
  var renderProgressMenu = makeMenu("menu-render-progress", "grid-btn-render-progress", "left");
  // The Output property's own exact range, used to color the whole [0, max]
  // span across the full rainbow rather than guessing at one: a non-anchored
  // body's x/y is already wrapped into exactly [0, frameWidth)/[0,
  // frameHeight) (see PhysicsEngine.step's frame wrap), so those bounds ARE
  // the true range, not an estimate - no need to pad a guess around the
  // authored layout and hope a pixel's actual range falls inside it (that
  // guess is what previously left most scenes showing only a narrow sliver
  // of hue, since real values rarely approached the padding). angle has no
  // positional bound, but it has an exact bound of its own: mod(angle, TAU)
  // is which way the body is *currently* facing, independent of how many
  // full turns it took to get there, so the color still runs the whole
  // spectrum every rotation instead of slowly saturating over many of them.
  var TAU = Math.PI * 2;
  function outputRangeMax(sceneForRange, property) {
    if (property === "x") return sceneForRange.frameWidth;
    if (property === "y") return sceneForRange.frameHeight;
    // The furthest two bodies can get. On a wrapped world that is the
    // antipode - half a frame on each axis, not a whole one - and it is a
    // value the pair can legitimately sit at, so it clamps rather than
    // mod()-ing (see buildFragmentShader's own t computation).
    if (property === "distance") return PhysicsEngine.outputDistanceMax(sceneForRange);
    // "Scene lifespan" isn't circular like x/y/angle (mod()-wrapping a value
    // that can legitimately equal its own max, "ran the full simulation,"
    // onto 0 would make that look identical to "crossed immediately") - see
    // buildFragmentShader's own t computation, which clamps instead of
    // mod()-ing for this property specifically.
    if (property === "lifespan") return simulationSteps;
    return TAU;
  }

  function showEmptyState(message) {
    canvas.hidden = true;
    emptyState.hidden = false;
    if (message) emptyState.querySelector("p").textContent = message;
  }

  // bootScene is what the app shell handed over - through JSON, so this
  // page holds a copy of its own rather than an object the editor might
  // still be holding too.
  var raw = bootScene ? JSON.stringify(bootScene) : null;
  var scene = null;
  if (raw) {
    try {
      scene = JSON.parse(raw);
      if (!scene || typeof scene !== "object") throw new Error("not an object");
      if (!Array.isArray(scene.bodies) || !Array.isArray(scene.hinges)) throw new Error("missing bodies/hinges");
      // Every shape this page knows how to compile, in one check - see
      // PhysicsEngine.outputMappingError. It names what is actually wrong
      // rather than reporting every malformed mapping as a missing one,
      // which is all the old test could say about a mapping that named no
      // body and no run tally.
      var outputProblem = PhysicsEngine.outputMappingError(scene.output, scene.bodies.length);
      if (outputProblem) throw new Error(outputProblem);
    } catch (err) {
      setStatus(false, "Invalid scene");
      showEmptyState("The scene couldn't be read (" + (err.message || err) + "). Go back and send it again.");
      scene = null;
    }
  }

  if (!scene) {
    if (!raw) {
      setStatus(true, "No scene");
      showEmptyState();
    }
    return;
  }

  // Adopt the sent scene's own duration - always one of the editor slider's
  // notches, which this page's identical slider can show as it is.
  // Named rather than an inline IIFE so setScene() can re-run it for a
  // scene arriving after boot.
  function adoptSceneDuration() {
    simulationSteps = scene.simulationSteps;
    // The Settings card has a slider on this exact value. Adopting a
    // duration without moving it is what used to leave this page rendering
    // at the scene's duration while its own panel still showed the one from
    // the visit before.
    syncStepsUI();
  }
  adoptSceneDuration();

  // ---- Shader assembly: pan/zoom -> world (X, Y) -> the shared per-pixel
  // offset+cascade codegen -> Output extraction -> step loop (wrapping the
  // Output body's position at the frame edges, if this scene has one) ->
  // the project's rainbow color formula (see colorMap below). ----

  // precision is "f32" or "df". The two shaders are the same program with
  // the same physics, carried at a different precision from end to end: the
  // world X/Y that seeds a pixel, its starting-state cascade, every step of
  // the simulation (collisions, both solvers, gravity) and the Output read
  // at the end. See physics-df.js and physics-gpu-df.js for the df
  // libraries; see pickPrecision() below for when each one is used.
  // variant is "standard" or "derived" - see the bottom of
  // compileScenePieces for what each holds.
  function buildFragmentShader(sceneToCompile, precision, variant) {
    var pieces = compileScenePieces(sceneToCompile, precision);
    return variant === "derived" ? pieces.derivedSource : pieces.gridSource;
  }

  // Everything one scene compiles to, in named pieces: the grid's own
  // program (gridSource), plus the parts playback's two programs are
  // assembled from (see buildPlaybackStepShader/buildPlaybackColorShader).
  // One function builds both, so playback can't drift from the physics,
  // Output reading and color ramp the grid itself runs.
  function compileScenePieces(sceneToCompile, precision) {
    // "df" here, as everywhere in the code generators, means "any of the
    // multi-float precisions" - double-, triple- or quad-float. They are
    // spelled identically (see PhysicsDF); only the word count differs.
    var df = PhysicsDF.isExtended(precision);
    var B = PhysicsGridCodegen.backendFor(precision);
    var initial = PhysicsGridCodegen.generateGridInitialStateGLSL(sceneToCompile, precision);
    var outProp = sceneToCompile.output.property; // "x" | "y" | "angle" | "distance" | "lifespan" | "bounces"
    var isLifespan = outProp === "lifespan";
    var isDistance = outProp === "distance";
    // One or two authored bodies - see PhysicsEngine.outputBodyIndices.
    var outputBodies = PhysicsEngine.outputBodyIndices(sceneToCompile.output);
    var isBounces = outProp === "bounces";
    // Neither of these two reads a body-state field at the end of the run -
    // both are whole-run tallies the step loop itself accumulates, as a plain
    // float in both precisions (a step count and a bounce count are small
    // integers; there is nothing for df to preserve). So they share a path
    // here that skips OUTPUT_BODY, OUTPUT_RANGE_MAX and the per-body output
    // read entirely.
    var isRunTally = isLifespan || isBounces;
    // A position with nothing to bound it - see the t computation below.
    // Distance joins x/y here: with no edges there is nothing bounding how
    // far apart two bodies can drift, so it takes the same squash rather
    // than a range it can run off the end of.
    var isInfinitePosition = sceneToCompile.edgeMode === "infinite" && (outProp === "x" || outProp === "y" || isDistance);
    var rangeMax = outputRangeMax(sceneToCompile, outProp);
    // A truly wrapping/circular quantity (angle always; x/y specifically
    // in Pac-Man Warp, where they actually cross the frame edge and wrap,
    // rather than freezing the sim there) uses the full 360° so hue 0°/360°
    // reads as the same color at the wrap point (see colorMap's own
    // comment on why). Anything that's really a capped, non-wrapping range
    // instead - lifespan always, or x/y under Sticky Edges (frozen at an
    // whatever edge they reached instead of letting them cross it - stops
    // short of 360° so its two ends don't visually read as the same color.
    var isCircularOutput = outProp === "angle" || ((outProp === "x" || outProp === "y") && sceneToCompile.edgeMode === "wrap");
    var hueRangeMax = isCircularOutput ? 360 : 300;
    // Read from the canonical bodyN struct, not initial.bodyState[i] - the
    // step loop below mutates bodyN in place, so bodyState's expressions
    // (the state BEFORE any step ran) no longer describe the current value
    // once the step loop has run. Scene lifespan has no body of
    // its own - its value is lifespanValue, set by the step loop below.
    // The output is read at the pass's own precision and only collapsed
    // after the mod() below - an angle output can be tens of thousands of
    // radians after 500 steps, and folding that to one turn in float32
    // throws away everything the df path just spent its budget preserving.
    // One authored body's Output value, at the pass's own precision - its
    // lineage average when the scene has a splitter (a ball that has split
    // into four still counts ONCE, so a pair mean stays a mean of two
    // bodies), and a plain read otherwise. GLSL twin of
    // PhysicsEngine.computeOutputLineageAverage.
    function emitBodyValue(name, bodyIdx, prop) {
      var bodyVar = df ? "dbody" : "body";
      var hasSpawn = initial.spawnBase !== null && initial.spawnBase !== undefined;
      var out = ["  " + B.scalar + " " + name + " = " + bodyVar + bodyIdx + "." + prop + ";"];
      if (!hasSpawn) return out;
      out.push("  float " + name + "_n = 1.0;");
      for (var sp = initial.spawnBase; sp < initial.n; sp++) {
        out.push("  if (alive" + sp + " && lineage" + sp + " == " + bodyIdx + ") { " +
          name + " = " + B.add(name, bodyVar + sp + "." + prop) + "; " + name + "_n += 1.0; }");
      }
      out.push("  " + name + " = " + B.div(name, B.fromFloat(name + "_n")) + ";");
      return out;
    }

    var outputLines;
    if (isLifespan) {
      outputLines = ["  outputValue = lifespanValue;"];
    } else if (isBounces) {
      outputLines = ["  outputValue = bounceCount;"];
    } else if (isDistance) {
      // How far apart the two are, the short way round when the frame wraps
      // - the GLSL twin of PhysicsEngine.shortestSeparation, and there for
      // the same reason: without it a Pac-Man scene's distance would jump
      // the width of the frame the instant either body crossed an edge, for
      // a pair that never moved apart.
      //
      // Kept at the pass's precision all the way through the length(). The
      // colour ramp itself needs nothing like this many digits, but the
      // derived display modes DIFFERENCE this value between neighbouring
      // pixels, and at a deep zoom those differ by far less than one
      // float32 ULP of a distance of order 100 - so a float32 length() here
      // handed them quantization steps to take the gradient of.
      outputLines = [];
      emitBodyValue("outAx", outputBodies[0], "x").forEach(function (l) { outputLines.push(l); });
      emitBodyValue("outAy", outputBodies[0], "y").forEach(function (l) { outputLines.push(l); });
      emitBodyValue("outBx", outputBodies[1], "x").forEach(function (l) { outputLines.push(l); });
      emitBodyValue("outBy", outputBodies[1], "y").forEach(function (l) { outputLines.push(l); });
      outputLines.push("  " + B.scalar + " outDx = " + B.sub("outBx", "outAx") + ";");
      outputLines.push("  " + B.scalar + " outDy = " + B.sub("outBy", "outAy") + ";");
      if (PhysicsEngine.wrapsAtEdges(sceneToCompile)) {
        // floor(x + 0.5), not round(): GLSL's round() breaks ties to even,
        // JS's Math.round breaks them upward, and the two engines have to
        // fold the same way at exactly half a frame. The fold COUNT is a
        // small whole number, so float32 decides it; what it is multiplied
        // back out against, and subtracted from, stays at full precision.
        var fw = PhysicsGPU.fnum(sceneToCompile.frameWidth), fh = PhysicsGPU.fnum(sceneToCompile.frameHeight);
        outputLines.push("  outDx = " + B.sub("outDx", B.mul(B.lit(sceneToCompile.frameWidth), B.fromFloat("floor(" + B.toFloat("outDx") + " / " + fw + " + 0.5)"))) + ";");
        outputLines.push("  outDy = " + B.sub("outDy", B.mul(B.lit(sceneToCompile.frameHeight), B.fromFloat("floor(" + B.toFloat("outDy") + " / " + fh + " + 0.5)"))) + ";");
      }
      outputLines.push("  outputValue = " + (df ? "dv2Length(dv2(outDx, outDy))" : "length(vec2(outDx, outDy))") + ";");
    } else if (outputBodies.length === 2) {
      // The mean of the two, each already its own lineage average.
      outputLines = [];
      emitBodyValue("outA", outputBodies[0], outProp).forEach(function (l) { outputLines.push(l); });
      emitBodyValue("outB", outputBodies[1], outProp).forEach(function (l) { outputLines.push(l); });
      outputLines.push("  outputValue = " + B.mul(B.add("outA", "outB"), B.lit(0.5)) + ";");
    } else {
      outputLines = emitBodyValue("outOne", outputBodies[0], outProp);
      outputLines.push("  outputValue = outOne;");
    }
    // undefined in Infinite Space: no frame means the step loop emits no
    // wrap at all, which is exactly what that mode is.
    var frame = PhysicsEngine.wrapsAtEdges(sceneToCompile)
      ? { width: sceneToCompile.frameWidth, height: sceneToCompile.frameHeight } : undefined;
    var stepOnceSource = PhysicsGPU.generateStepOnceGLSL(initial.n, initial.consts, initial.pairs, initial.hingeAnchors, frame, precision, sceneToCompile.mutualGravity, PhysicsEngine.collisionsEnabled(sceneToCompile), initial.spawnBase, initial.springs);
    var stepOnceCall = "stepOnce(" + PhysicsGPU.stepOnceCallArgs(initial.n, initial.hingeAnchors, precision, initial.spawnBase, initial.springs) + ");";

    // "Stop on wrap": every pixel is its own independent simulation, so
    // there's no single moment "the sim stopped" the way there is on
    // #editor-view's Play button - each pixel just freezes the instant ITS
    // OWN copy would first see ANY watched body cross a frame edge
    // (PhysicsHingeGeometry.wrapWatchedBodyIndices - every non-static,
    // non-hinge-child body, not just Output's own), regardless of what any
    // other pixel is doing. Since OUTPUT_BODY (when Output isn't Scene
    // Lifespan) is a compile-time constant here (unlike the single-scene/
    // hover-replay JS paths, which discover it by scanning an already-
    // logged trajectory), the wrap check can be inlined directly into the
    // step loop instead of post-processed. Every watched body needs its own
    // frozen/prevFrozen tracking (frozenX0/frozenX1/... below) since any of
    // them could be the one that crosses first; Output's own body is
    // tracked the same way even when it isn't itself watched (e.g. it's a
    // hinge child), purely so its position can still be extrapolated to the
    // exact stopping instant. Same "delta near half the frame size"
    // signature as PhysicsHingeGeometry.findWrapStopStep (see its comment
    // for why it's not exactly frameWidth/height), just evaluated per-step
    // in GLSL instead of post-hoc over a JS array.
    //
    // Freezing at frozenX/Y/Angle outright (this step's own comment used to
    // stop there) is only a discrete, once-per-step sample - WHICH step
    // first notices the crossing is an integer that jumps by 1 exactly when
    // a pixel's starting conditions sweep past a step boundary, producing a
    // real, large, spurious discontinuity even with no collision involved
    // at all (confirmed empirically: a lone free-falling circle shows a
    // clean jump of about one step's fall distance, at regular intervals
    // matching that same distance). The fix mirrors collideCircleCircle's
    // own CCD: solve for the exact sub-step instant the crossing axis
    // reaches the boundary using its OWN velocity (already exactly what
    // stepOnce() used to move position this step - nothing after
    // position-integration inside stepOnce() touches velocity), then
    // extrapolate EVERY property back one whole step-duration from that
    // continuous instant using ITS OWN velocity, reconstructed from the two
    // preceding frozen samples. One step before the crossing (not AT the
    // crossing) because "at" is trivially always exactly the boundary for
    // whichever property is doing the wrapping - collapsing to a constant
    // for the common case of Output being that same property - while "one
    // step before" keeps this feature's actual intent (a snapshot of where
    // things were, right before they would've wrapped) as a genuinely
    // continuous function of the starting conditions instead. Scene
    // Lifespan reads differently: it wants the crossing instant itself
    // (float(i) + tFrac/DT, a continuous step count), not one step earlier
    // - "one step before" only ever mattered for making a position/angle
    // snapshot look pre-wrap, which doesn't apply to a duration.
    var watchedIndices = PhysicsHingeGeometry.wrapWatchedBodyIndices(sceneToCompile);
    // Bounce Count needs its body only to read that body's contact flag each
    // step - never for the wrap-stop position extrapolation below, which is
    // about a positional Output's final value, so it stays out of
    // outputBodyIdx/trackedIndices.
    // Every authored body the Output reads - one, or both halves of a pair.
    // All of them need the wrap-stop reconstruction below, or a pixel that
    // stops early would average one continuous value with one discrete one.
    var outputIndices = isRunTally ? [] : outputBodies;
    // "Started touching something this step, having not been last step" - one
    // bounce. See PhysicsGPU.generateStepOnceGLSL's g_contactN globals for
    // where the flag comes from, and PhysicsEngine.runBounceCounts (the JS
    // twin used by the hover panel) for why it's the false->true edge and not
    // every step of contact.
    var bounceInitLines = isBounces ? ["  float bounceCount = 0.0;", "  bool bounceTouching = false;"] : [];
    var bounceStepLines = isBounces ? [
      "    bool bounceNow = g_contact" + sceneToCompile.output.body + ";",
      "    if (bounceNow && !bounceTouching) bounceCount += 1.0;",
      "    bounceTouching = bounceNow;",
    ] : [];
    var trackedIndices = watchedIndices.slice();
    outputIndices.forEach(function (idx) {
      if (trackedIndices.indexOf(idx) === -1) trackedIndices.push(idx);
    });
    // ---- The step loop, for either of the two programs that run it ----
    //
    // The grid's own program runs every step from 0 to u_maxSteps in one
    // draw. Playback's step pass runs only the next few, picking up from
    // state it read back (see buildPlaybackStepShader). The loop is the same
    // either way; `loop` names the three spellings that differ:
    //   bound     - how many steps THIS draw runs
    //   stepIndex - iteration i's step number counted from the start of the
    //               whole run, not of this draw: a wrap-stop's lifespan is
    //               recorded against it
    //   budget    - the lifespan of a pixel that never stops, i.e. the total
    //               step count once this draw is done
    // Returned as the locals the loop needs and the loop itself, separately,
    // so playback can restore saved state in between the two.
    var isStickyLoop = sceneToCompile.edgeMode === "sticky" && frame && watchedIndices.length > 0;
    function stepLoop(loop) {
      var declarations = [];
      var lines = [];
      if (isStickyLoop) {
        var halfW = PhysicsGPU.fnum(frame.width / 2), halfH = PhysicsGPU.fnum(frame.height / 2);
        var fullW = PhysicsGPU.fnum(frame.width), fullH = PhysicsGPU.fnum(frame.height);
        // The frozen samples ARE the reported output on any pixel that stops,
        // so they are tracked at the pass's own precision: collapsing them to
        // float32 here would quantize the answer for exactly the pixels this
        // feature exists to serve, no matter how precise the step loop that
        // produced them was.
        var bodyVar = df ? "dbody" : "body";
        trackedIndices.forEach(function (idx) {
          declarations.push("  " + B.scalar + " frozenX" + idx + " = " + bodyVar + idx + ".x;");
          declarations.push("  " + B.scalar + " frozenY" + idx + " = " + bodyVar + idx + ".y;");
          declarations.push("  " + B.scalar + " frozenAngle" + idx + " = " + bodyVar + idx + ".angle;");
          declarations.push("  " + B.scalar + " prevFrozenX" + idx + " = " + B.zero + ";");
          declarations.push("  " + B.scalar + " prevFrozenY" + idx + " = " + B.zero + ";");
          declarations.push("  " + B.scalar + " prevFrozenAngle" + idx + " = " + B.zero + ";");
        });
        declarations.push("  bool hasPrevFrozen = false;");
        declarations.push("  bool wrapStopped = false;");
        // Default: never crosses within the budget, so it "lasts" the whole
        // thing - matches outputRangeMax's own ceiling, which is this same
        // step budget.
        declarations.push("  float lifespanValue = " + loop.budget + ";");
        bounceInitLines.forEach(function (l) { declarations.push(l); });
        lines.push("  for (int i = 0; i < " + loop.bound + "; i++) {");
        lines.push("    if (wrapStopped) break;");
        lines.push("    " + stepOnceCall);
        bounceStepLines.forEach(function (l) { lines.push(l); });
        // DT+1.0 sentinel: strictly greater than any real tFrac (which is
        // clamped into [0, DT]), so the first real crossing this step always
        // wins the comparison below regardless of watch order.
        //
        // tFrac is carried at the pass's precision (tFracHi below), with a
        // float32 shadow (bestTFrac) for the two places that only ever
        // needed one: picking the earliest crossing, and the lifespan. The
        // extrapolated OUTPUT is tFrac times a velocity of order 1e2-1e3, so
        // a float32 tFrac put a ~1e-6px quantization on it - nothing the
        // colour ramp can see, and exactly what the derived display modes
        // difference between neighbouring pixels at a deep zoom.
        lines.push("    float bestTFrac = DT + 1.0;");
        lines.push("    " + B.scalar + " bestTFracHi = " + B.zero + ";");
        watchedIndices.forEach(function (idx) {
          lines.push("    {");
          // The crossing TEST is coarse by nature (did this step move most of
          // a frame width?), so it collapses to float32 - but the numerator
          // of tFrac below does not: it is a distance-to-the-edge of order
          // one step's travel, and it sets where the extrapolated output
          // lands.
          lines.push("      float wrapDx = " + B.toFloat(B.sub(bodyVar + idx + ".x", "frozenX" + idx)) + ";");
          lines.push("      float wrapDy = " + B.toFloat(B.sub(bodyVar + idx + ".y", "frozenY" + idx)) + ";");
          lines.push("      if (abs(wrapDx) > " + halfW + " || abs(wrapDy) > " + halfH + ") {");
          lines.push("        bool xCrossed = abs(wrapDx) > " + halfW + ";");
          lines.push("        float span = xCrossed ? " + fullW + " : " + fullH + ";");
          lines.push("        " + B.scalar + " vAxisHi = xCrossed ? " + bodyVar + idx + ".vx : " + bodyVar + idx + ".vy;");
          lines.push("        float vAxis = " + B.toFloat("vAxisHi") + ";");
          lines.push("        " + B.scalar + " prevAxis = xCrossed ? frozenX" + idx + " : frozenY" + idx + ";");
          lines.push("        float boundary = vAxis > 0.0 ? span : 0.0;");
          if (df) {
            lines.push("        MF tFracHi = dfClamp(dfDiv(dfSub(dfFromFloat(boundary), prevAxis), vAxisHi), DF_ZERO, DF_DT);");
            lines.push("        float tFrac = dfToFloat(tFracHi);");
          } else {
            lines.push("        float tFrac = clamp(((boundary) - (prevAxis)) / vAxis, 0.0, DT);");
            lines.push("        float tFracHi = tFrac;");
          }
          // Earliest continuous crossing wins when more than one watched body
          // registers a crossing on the same discrete step.
          lines.push("        if (tFrac < bestTFrac) { bestTFrac = tFrac; bestTFracHi = tFracHi; }");
          lines.push("      }");
          lines.push("    }");
        });
        lines.push("    if (bestTFrac <= DT) {");
        lines.push("      " + B.scalar + " tTarget = " + B.sub("bestTFracHi", df ? "DF_DT" : "DT") + ";");
        lines.push("      lifespanValue = " + loop.stepIndex + " + bestTFrac / DT;");
        outputIndices.forEach(function (out) {
          // frozen + (frozen - prevFrozen)/DT * tTarget, kept whole at the
          // pass's precision: the reconstructed velocity is a difference of
          // two consecutive samples (small, so precise either way), but the
          // base it is added onto is a full-magnitude coordinate that must
          // not be rounded.
          function extrapolate(axis) {
            // 1/DT is 60 exactly, so the literal carries it without the
            // float32 division the old "(1.0 / DT)" spent on it.
            var vel = B.mul(B.sub("frozen" + axis + out, "prevFrozen" + axis + out), df ? B.lit(1 / PhysicsGPU.FIXED_DT) : "(1.0 / DT)");
            return B.add("frozen" + axis + out, B.mul(vel, "tTarget"));
          }
          lines.push("      if (hasPrevFrozen) {");
          lines.push("        " + bodyVar + out + ".x = " + extrapolate("X") + ";");
          lines.push("        " + bodyVar + out + ".y = " + extrapolate("Y") + ";");
          lines.push("        " + bodyVar + out + ".angle = " + extrapolate("Angle") + ";");
          lines.push("      } else {");
          lines.push("        " + bodyVar + out + ".x = frozenX" + out + "; " + bodyVar + out + ".y = frozenY" + out + "; " + bodyVar + out + ".angle = frozenAngle" + out + ";");
          lines.push("      }");
        });
        lines.push("      wrapStopped = true;");
        lines.push("    } else {");
        trackedIndices.forEach(function (idx) {
          lines.push("      prevFrozenX" + idx + " = frozenX" + idx + "; prevFrozenY" + idx + " = frozenY" + idx + "; prevFrozenAngle" + idx + " = frozenAngle" + idx + ";");
          lines.push("      frozenX" + idx + " = " + bodyVar + idx + ".x; frozenY" + idx + " = " + bodyVar + idx + ".y; frozenAngle" + idx + " = " + bodyVar + idx + ".angle;");
        });
        lines.push("      hasPrevFrozen = true;");
        lines.push("    }");
        lines.push("  }");
        return { declarations: declarations, loop: lines };
      }
      // No watched bodies at all (every body is static or a hinge child) -
      // Sticky Edges has nothing to trigger on, so lifespan is trivially
      // always the full run length.
      declarations.push("  float lifespanValue = " + loop.budget + ";");
      bounceInitLines.forEach(function (l) { declarations.push(l); });
      lines.push("  for (int i = 0; i < " + loop.bound + "; i++) {");
      lines.push("    " + stepOnceCall);
      bounceStepLines.forEach(function (l) { lines.push(l); });
      lines.push("  }");
      return { declarations: declarations, loop: lines };
    }
    var gridLoop = stepLoop({ bound: "u_maxSteps", stepIndex: "float(i)", budget: "float(u_maxSteps)" });
    var stepLoopLines = gridLoop.declarations.concat(gridLoop.loop).join("\n");

    // The half of the loop's bookkeeping that outlives a draw, which playback
    // carries between draws alongside the physics state itself (see
    // PhysicsGridCodegen.playbackStateVariables). Lifespan is only state in
    // the sticky loop: nowhere else can a pixel stop early, so its lifespan
    // is simply however many steps have run.
    //
    // Only the half that cannot be had any other way, though, because every
    // float carried is paid for twice over: in bandwidth, and - past the 32
    // floats one draw can write - in whole extra draws, each re-running the
    // same steps to keep a different slice of the result (see
    // advanceSliceJob). The df double pendulum carried 55 floats, so every
    // slice of it was simulated twice; it needs 31. What is NOT carried:
    //   frozenX/Y/Angle - between two steps of a pixel still running they
    //     are simply the body's own x, y and angle (the loop's last act
    //     each step is to copy them), and a pixel that has stopped never
    //     reads them again. Re-derived on load.
    //   prevFrozen* for a body, or a field of one, that the Output does not
    //     read: they exist only to extrapolate the Output's body to the
    //     stopping instant, and the extrapolated value of a field nothing
    //     reads is dead. (Output reads fields as plain "body.field" text -
    //     see emitBodyValue - which is what is searched for.)
    //   hasPrevFrozen - true from the first step on for a pixel still
    //     running, i.e. u_baseStep > 0, and unread once it has stopped.
    //   lifespanValue - unless it IS the Output.
    // loopStateRestoreLines puts the re-derived ones back after a load.
    var loopStateVariables = [];
    var loopStateRestoreLines = [];
    if (isStickyLoop) {
      var stickyBodyVar = df ? "dbody" : "body";
      var outputText = outputLines.join("\n");
      function outputReads(idx, field) {
        return new RegExp("\\b" + stickyBodyVar + idx + "\\." + field + "\\b").test(outputText);
      }
      trackedIndices.forEach(function (idx) {
        [["X", "x"], ["Y", "y"], ["Angle", "angle"]].forEach(function (f) {
          loopStateRestoreLines.push("frozen" + f[0] + idx + " = " + stickyBodyVar + idx + "." + f[1] + ";");
          if (outputIndices.indexOf(idx) !== -1 && outputReads(idx, f[1])) {
            loopStateVariables.push({ name: "prevFrozen" + f[0] + idx, type: df ? "df" : "float" });
          }
        });
      });
      loopStateRestoreLines.push("hasPrevFrozen = u_baseStep > 0;");
      loopStateVariables.push({ name: "wrapStopped", type: "bool" });
      if (/\blifespanValue\b/.test(outputText)) loopStateVariables.push({ name: "lifespanValue", type: "float" });
    }
    if (isBounces) {
      loopStateVariables.push({ name: "bounceCount", type: "float" }, { name: "bounceTouching", type: "bool" });
    }
    PhysicsGridCodegen.withWords(loopStateVariables, precision);

    // ---- Derived display modes ----
    //
    // Standard mode paints the field itself. The other three paint a
    // DERIVATIVE of it, computed by re-running the whole per-pixel
    // simulation at a small stencil of neighbouring starting points and
    // differencing the results - which is why the per-pixel body below is
    // a function (sampleOutput) rather than inlined straight into main()
    // the way it used to be.
    //
    // Why a stencil in WORLD space rather than a post-process over the
    // rendered image: the ladder's accumulators hold 8-bit color that has
    // already been through a hue ramp, so differencing them would report a
    // false edge at every one of the ramp's RGB breakpoints and go blind
    // wherever the field steps a whole hue wrap - the same reason Global
    // Stats re-renders into a float target instead of reading the canvas
    // back (see its own comment). Differencing the values directly costs
    // more simulations and gets the right answer.
    // The Output value's own arithmetic. Identical to B except for the two
    // run tallies, which are plain floats in BOTH passes (a step count and
    // a bounce count are small integers - there is nothing for df to
    // preserve), so differencing them uses plain float operators whatever
    // precision the rest of the pass is running at.
    var OB = isRunTally ? PhysicsGridCodegen.backendFor("f32") : B;
    var outScalar = OB.scalar;
    var outZero = OB.zero;
    // Turns a RAW output difference into a t-space one. Deliberately the
    // field's own LINEAR range in every case - including Infinite Space,
    // whose t goes through frameSigmoid: that squash is a display transform
    // for an unbounded quantity, not a property of the field, and
    // differencing through it would report the sigmoid's own flattening
    // far from center as the field itself going smooth.
    var deltaDenom = isBounces ? "max(u_bounceMax, 1.0)"
      : isLifespan ? "float(u_durationSteps)"
        : "OUTPUT_RANGE_MAX";
    // Contours needs the gradient of t ITSELF, and deltaT deliberately does
    // not give it that: deltaT reports the field's own linear rate of change
    // (see its comment), which for every output but one IS t's, because t is
    // a linear function of the value. Infinite Space position is the
    // exception - its t goes through frameSigmoid - so there the two differ
    // by that sigmoid's derivative, and contourColor has to put it back.
    //
    // Leaving it out is not a rounding error, it is the difference between a
    // correct picture and a wrong one. distInLevels is measured in SIGMOID
    // space and slope would be measured in LINEAR space; dividing one by the
    // other mixes units. Far out in the sigmoid's tails t saturates to
    // exactly 0.0 or 1.0 while the value underneath is still a healthy
    // linear ramp, so the numerator goes to exactly zero against a
    // perfectly ordinary denominator - and every pixel out there reports
    // itself as sitting dead on a level set, painting the whole region solid.
    //
    // d/dv sigmoid(v) = k * t * (1 - t) for this sigmoid, which is why this
    // is expressible from t alone without re-deriving v.
    var contourSlopeGain = isInfinitePosition
      ? " * (" + PhysicsGPU.fnum(PhysicsEngine.OUTPUT_SIGMOID_STEEPNESS) + " * t * (1.0 - t))"
      : "";

    // ---- Raw Output value -> the t the color ramp reads ----
    var tLine =
    // OUTPUT_RANGE_MAX is the Output property's own exact range (see
    // outputRangeMax) - a wrapped x/y is already guaranteed inside it, and
    // mod() folds an angle's however-many-full-turns value down to just
    // "which way is it facing right now" - so this reaches the full [0,1)
    // color range using the property's real bounds, not a padded guess,
    // and never depends on the current pan/zoom. Lifespan isn't circular
    // like those, though - it can legitimately equal its own max (ran the
    // whole simulation), and mod()-ing that back to 0 would make it look
    // identical to "crossed immediately," so it clamps instead.
    // The mod() happens at the pass's precision and only then collapses:
    // t itself is in [0, 1) so float32 is plenty for it, but folding a
    // large angle (or a coordinate) down to one period in float32 first
    // would round away the distinction between neighbouring pixels
    // before it ever reached t.
    // Bounce Count is scaled against the busiest pixel in view rather than
    // any fixed ceiling, so a scene where nothing bounces more than 3 times
    // still uses the whole rainbow. Deliberately NOT clamped: the max comes
    // from a coarse sample (see findBounceMax), so a pixel between samples
    // can legitimately come out slightly over 1, and the readback path
    // below reads this same expression with u_bounceMax = 1 to recover the
    // raw count - clamping would flatten every count above 1 to 1 there.
    // Infinite Space has no wrap to fold a coordinate back into the frame,
    // so there is no range to divide it into - mod() would report a body
    // two frames out as if it were barely off-center, and dividing without
    // one would run t past 1 and off the end of the color range. The
    // sigmoid squashes the whole infinite line into [0,1] instead: dead
    // center is 0.5, the frame's own edges 0.076 and 0.924, two frames out
    // 0.9995 - arbitrarily distant still lands inside the range, just ever
    // closer to its end. Only x/y take it; angle is genuinely circular
    // whatever the edges do, and the two run tallies aren't positions.
    isBounces
      ? "  float t = u_bounceMax > 0.0 ? outputValue / u_bounceMax : 0.0;"
      : isLifespan
        ? "  float t = clamp(outputValue / float(u_durationSteps), 0.0, 1.0);"
        : isInfinitePosition
          ? "  float t = frameSigmoid(" + B.toFloat(B.div("outputValue", B.fromFloat("OUTPUT_RANGE_MAX"))) + ");"
          // Distance clamps for the same reason lifespan does: its maximum
          // is a value the pair can legitimately sit at (exact antipodes),
          // and mod()-ing that back to 0 would paint "as far apart as this
          // world allows" the same color as "touching".
          : isDistance
            ? "  float t = clamp(" + B.toFloat(B.div("outputValue", B.fromFloat("OUTPUT_RANGE_MAX"))) + ", 0.0, 1.0);"
            : "  float t = " + B.toFloat(B.div(B.mod("outputValue", "OUTPUT_RANGE_MAX"), B.fromFloat("OUTPUT_RANGE_MAX"))) + ";";

    // A pixel's starting state from its world X/Y, and the locals stepOnce()
    // is threaded through - the same three blocks in every program that
    // simulates.
    var physicsDeclarationLines = [
      initial.declarationLines.map(function (l) { return "  " + l; }).join("\n"),
      "  " + PhysicsGridCodegen.generateCanonicalBodyDeclarationsGLSL(initial).split("\n").join("\n  "),
      "  " + PhysicsGPU.generateHingeAnchorLocalsGLSL(initial.hingeAnchors, precision).split("\n").join("\n  "),
    ];

    // Which world point a pixel simulates. Shared with playback's step pass,
    // whose pixels have to land on exactly the points the grid's own would.
    var worldCoordLines = [
      // gl_FragCoord.xy - 0.5 is the integer index of the pixel being
      // shaded in THIS draw's target; mapping it through the stride/origin
      // gives the index of the full-res pixel it stands for, and the final
      // + 0.5 puts it back at that pixel's center. At stride 1, origin 0
      // this collapses to (x - 0.5) + 0.5, which is exact for every pixel
      // index a canvas can hold - so the full-res pass computes precisely
      // the coordinates it always did, to the bit.
      "  vec2 fullCoord = (gl_FragCoord.xy - 0.5) * u_gridStride + u_gridOrigin + 0.5;",
      "  vec2 uv = (fullCoord - 0.5 * u_resolution) / u_resolution.y;",
      // uv * u_scale stays a plain float32 product on purpose. Its relative
      // error is ~1e-7 of a quantity that is itself at most u_scale, i.e.
      // ~1e-4 of ONE PIXEL's worth of world distance - far below anything
      // visible. The catastrophic step is the ADD onto the center, and
      // that is the one done in df.
      df ? "  MF worldX = dfAddFloat(" + PhysicsDF.wordUniformValue("u_center", "x", precision) + ", uv.x * u_scale);" : "  float worldX = u_centerHi.x + uv.x * u_scale;",
      df ? "  MF worldY = dfAddFloat(" + PhysicsDF.wordUniformValue("u_center", "y", precision) + ", uv.y * u_scale);" : "  float worldY = u_centerHi.y + uv.y * u_scale;",
    ];

    // The same mapping for the two STATE-CARRYING programs (playback's step
    // pass, which is also what draws the grid itself at df and above - see
    // "Sliced rendering"). Two things the grid program's own version has no
    // need of:
    //   u_tileOrigin - the state texture holds one TILE of a lattice, so
    //                  texel (0, 0) is lattice pixel u_tileOrigin.
    //   u_stencil    - 1, or 5 for the derived display modes: each lattice
    //                  pixel then owns five neighbouring texels, its own
    //                  starting point and the four a full-res pixel away from
    //                  it, in STATE_STENCIL's order. That is the same
    //                  five-point stencil shadeDerived() re-simulates inline;
    //                  here the five are simply simulated side by side.
    // With u_stencil 1 and u_tileOrigin (0, 0) this is worldCoordLines to the
    // bit: texel index, times stride, plus origin, plus a half.
    var stateWorldCoordLines = [
      "  ivec2 stateTexel = ivec2(gl_FragCoord.xy);",
      "  int stencilIndex = stateTexel.x % u_stencil;",
      "  vec2 latticeIndex = vec2(float(stateTexel.x / u_stencil), float(stateTexel.y)) + u_tileOrigin;",
      "  vec2 fullCoord = latticeIndex * u_gridStride + u_gridOrigin + 0.5;",
      "  vec2 uv = (fullCoord - 0.5 * u_resolution) / u_resolution.y;",
      "  vec2 stencilOffset = STATE_STENCIL[stencilIndex] * (u_scale / u_resolution.y);",
      df ? "  MF worldX = dfAddFloat(dfAddFloat(" + PhysicsDF.wordUniformValue("u_center", "x", precision) + ", uv.x * u_scale), stencilOffset.x);"
         : "  float worldX = (u_centerHi.x + uv.x * u_scale) + stencilOffset.x;",
      df ? "  MF worldY = dfAddFloat(dfAddFloat(" + PhysicsDF.wordUniformValue("u_center", "y", precision) + ", uv.y * u_scale), stencilOffset.y);"
         : "  float worldY = (u_centerHi.y + uv.y * u_scale) + stencilOffset.y;",
    ];

    var gridHeaderLines = [
      "#version 300 es",
      "precision highp float;",
      // The FULL-resolution canvas dimensions - deliberately not the
      // dimensions of whatever target is currently being drawn into. The
      // progressive renderer (see the "Progressive refinement" section) is
      // always shading some sub-lattice of the final full-res pixel grid,
      // into a target far smaller than that grid, and every world
      // coordinate has to come out identical to what a single full-res
      // render would have produced for that same pixel - otherwise the
      // coarse levels wouldn't be honest previews of the fine one, and the
      // sub-lattices that get interleaved together at the end would
      // disagree along their shared edges.
      "uniform vec2 u_resolution;",
      // Which sub-lattice of that full-res grid this draw covers:
      // rendered pixel (i, j) stands for full-res pixel
      // (i * u_gridStride + u_gridOrigin.x, j * u_gridStride + u_gridOrigin.y).
      // Stride 1 / origin (0,0) is the identity - and is EXACTLY
      // bit-identical to the pre-progressive formula, which is what makes
      // the finished image unchanged by any of this.
      "uniform float u_gridStride;",
      "uniform vec2 u_gridOrigin;",
      // The view center arrives pre-split into float32 WORDS, one uniform
      // per word (u_centerHi, u_centerLo, u_centerLo2, u_centerLo3 - see
      // PhysicsDF.wordUniformDecls). The page holds the center to ~106 bits
      // (see view.center); uploading it as a single float32 uniform was
      // throwing all but 24 of them away at the door, which no amount of
      // care later in the shader could get back. Every program declares all
      // four and reads as many as its precision carries, so they all take
      // the same uniforms.
    ].concat(PhysicsDF.wordUniformDecls("u_center"), [
      "uniform float u_scale;",
      "uniform bool u_colorZoom;",
      // How many steps each pixel runs. A uniform rather than a baked
      // constant so the Settings slider doesn't recompile four programs per
      // notch - GLSL ES 3.00 allows a non-constant loop bound (ES 1.00
      // didn't), and measured, the dynamic bound costs nothing.
      "uniform int u_maxSteps;",
      // The Simulation Duration, i.e. the far end of the playback timeline -
      // which is what Scene Lifespan is measured against, including while
      // u_maxSteps above is showing some step short of it. Measuring against
      // the step shown instead would recolor every pixel that stopped long
      // ago on every frame of playback. The two are equal whenever the
      // timeline sits at its end, which is the only place it ever sat before
      // playback existed.
      "uniform int u_durationSteps;",
      // Bounce Count only: the largest bounce count currently in view, which
      // is what a pixel's own count is scaled against (see findBounceMax).
      // A uniform, not a baked constant, because it's a property of where
      // you're looking rather than of the scene - it's re-measured on every
      // render, so panning into a busier region rescales the whole picture
      // instead of saturating.
      "uniform float u_bounceMax;",
      // Which picture to paint: the field, or one of the three derivatives
      // of it (see DISPLAY_MODES on the JS side). A uniform rather than
      // four more compiled programs - the switch is a dropdown the user
      // flicks back and forth, and recompiling a scene's physics to answer
      // it would stall the page every time. Every pixel in a draw reads the
      // same value, so the branches below never diverge within a warp.
      "uniform int u_displayMode;",
      "out vec4 fragColor;",
      "",
      PhysicsGPU.libraryGLSL(precision, PhysicsEngine.speedCapFor(sceneToCompile)),
      "",
    ]);

    // Everything that turns a t - or a derivative of one - into a color.
    // Playback's color pass includes this same block, so a value can't look
    // different depending on which of the two drew it.
    var colorLibraryLines = [
      "vec3 hsl2rgb(float h, float s, float l) {",
      "  float c = (1.0 - abs(2.0 * l - 1.0)) * s;",
      "  float hp = h / 60.0;",
      "  float x = c * (1.0 - abs(mod(hp, 2.0) - 1.0));",
      "  vec3 rgb;",
      "  if (hp < 1.0) rgb = vec3(c, x, 0.0);",
      "  else if (hp < 2.0) rgb = vec3(x, c, 0.0);",
      "  else if (hp < 3.0) rgb = vec3(0.0, c, x);",
      "  else if (hp < 4.0) rgb = vec3(0.0, x, c);",
      "  else if (hp < 5.0) rgb = vec3(x, 0.0, c);",
      "  else rgb = vec3(c, 0.0, x);",
      "  return rgb + vec3(l - c * 0.5);",
      "}",
      "",
      // t is guaranteed in [0, 1) by construction below (mod() always
      // returns a result in [0, RANGE_MAX) for the positive RANGE_MAX this
      // project always uses). HUE_RANGE_MAX is 360° when outputValue is a
      // genuinely wrapped, circular quantity (a frame-wrapped x/y, or an
      // angle folded to one turn) - t=0 and t=1 are then the same
      // underlying point, just before/after the wrap, so the full 360° runs
      // between them: hue 0°/360° are the same rendered color, reading as
      // one continuous loop instead of jumping across whatever gap a
      // partial hue range would leave. It's 300° instead whenever
      // outputValue is really a capped, non-wrapping range (Scene lifespan
      // always; x/y once "Stop when any object reaches the frame edge"
      // freezes them at whatever edge they reached instead of letting them
      // wrap) - t=0 and t=1 are different values there, not the same
      // point, so stopping short of 360° keeps them visually distinct
      // instead of also reading as a seamless loop (see buildFragmentShader
      // for exactly which cases this applies to).
      // Color Zoom (off by default, u_colorZoom, Standard mode only):
      // repeats that same hue ramp 10 times across the range instead of
      // once, for scenes whose
      // whole range needs to be seen at once but where one single rainbow
      // sweep isn't enough resolution to tell nearby values apart. Since
      // hue alone would then look identical across all 10 repeats,
      // saturation also ramps 40%-100% across the FULL (non-repeating) t -
      // low saturation (paler, closer to gray) near t=0, full saturation
      // near t=1 - so which of the 10 repeats a color belongs to is still
      // visible.
      "const float HUE_RANGE_MAX = " + PhysicsGPU.fnum(hueRangeMax) + ";",
      // The GLSL twin of PhysicsEngine.frameSigmoid - same constant, so the
      // grid and the hover panel beside it agree on the color.
      "float frameSigmoid(float v) {",
      "  return 1.0 / (1.0 + exp(" + PhysicsGPU.fnum(-PhysicsEngine.OUTPUT_SIGMOID_STEEPNESS) + " * (v - 0.5)));",
      "}",
      "",
      // The plain sweep, with no Color Zoom in it. Split out from colorMap
      // so a mode that wants the project's rainbow WITHOUT Color Zoom's
      // repeats can have it: Contours draws its level sets in this, because
      // Color Zoom is a Standard-mode control (see colorMap below).
      "vec3 rainbow(float t) {",
      // A no-op for every output whose t is already in [0,1) by construction;
      // it's Bounce Count's deliberately-unclamped t (see its own comment
      // below) that can arrive a hair over 1 and would otherwise wrap round
      // to a negative hue.
      "  t = clamp(t, 0.0, 1.0);",
      "  float hue = HUE_RANGE_MAX * (1.0 - t);",
      "  return hsl2rgb(hue, 1.0, 0.5);",
      "}",
      "",
      // Standard mode's ramp, and the ONLY place u_colorZoom is read. Color
      // Zoom exists to tell nearby values apart in one sweep of the plain
      // rainbow, which is a question only Standard's filled picture poses -
      // Contours already separates its values into discrete lines, and the
      // other two modes are not coloring the value at all. Toggling it
      // also switches the display back to Standard (see its change handler)
      // so that flipping it always does something visible.
      "vec3 colorMap(float t) {",
      "  if (u_colorZoom) {",
      "    t = clamp(t, 0.0, 1.0);",
      "    float tZoom = mod(t * 10.0, 1.0);",
      "    float hue = HUE_RANGE_MAX * (1.0 - tZoom);",
      "    float sat = t * 0.6 + 0.4;",
      "    return hsl2rgb(hue, sat, 0.5);",
      "  }",
      "  return rainbow(t);",
      "}",
      "",

      // ---- The derived modes' own color formulas ----
      "const int MODE_STANDARD = 0;",
      "const int MODE_GRADIENT = 1;",
      "const int MODE_LAPLACIAN = 2;",
      "const int MODE_CONTOURS = 3;",
      // Every derived quantity below is in "t units per full-res pixel",
      // and that quantity spans several DECADES across one picture: a
      // folded difference cannot exceed 0.5 (half the color range is as
      // far apart as two values on a circular output can get), a chaotic
      // filament runs close to that ceiling, and a broad smooth wash is a
      // few thousandths. Which decade dominates depends on the zoom, too -
      // deep in, a chaotic field is locally smooth and everything is small;
      // far out, everything is sharp.
      //
      // So this is a log ramp, not a linear one with a gain. A linear ramp
      // shows one decade and paints everything below it black, and the gain
      // that picks the right decade is different for every view - there is
      // no constant that works. A log ramp shows about four decades at
      // once, which is enough that ONE constant covers the whole zoom
      // range. DERIVED_FLOOR is where the ramp bottoms out, i.e. the
      // difference-per-pixel this calls flat.
      "const float DERIVED_FLOOR = 1e-4;",
      "const float DERIVED_CEIL = 0.5;",
      "float magnitudeLift(float m) {",
      // max() rather than letting log2(0) return -infinity: the clamp would
      // handle the infinity itself, but a driver that produces a NaN from
      // it instead would carry that all the way out to the pixel.
      "  float lifted = log2(max(m, 1e-30) / DERIVED_FLOOR) / log2(DERIVED_CEIL / DERIVED_FLOOR);",
      "  return clamp(lifted, 0.0, 1.0);",
      "}",
      "",
      // Direction is circular and so is hue - the one place in this project
      // where the two match exactly, so the full wheel carries it with no
      // seam and no need for HUE_RANGE_MAX's 300-degree compromise.
      // Magnitude rides lightness instead of saturation: a smooth region
      // goes black, which reads as "nothing is happening here" rather than
      // as a pale color of its own.
      "vec3 gradientColor(vec2 g) {",
      // atan(0, 0) is undefined in GLSL, and a NaN hue would come out of
      // hsl2rgb as a NaN color rather than as the black this should be -
      // an exactly flat neighbourhood is common on the two integer-valued
      // outputs (a step count is the same on both sides of a pixel almost
      // everywhere), so this is the ordinary case, not a corner one.
      "  float m = magnitudeLift(length(g));",
      "  if (m <= 0.0) return vec3(0.0);",
      "  float hue = degrees(atan(g.y, g.x));",
      "  if (hue < 0.0) hue += 360.0;",
      "  return hsl2rgb(hue, 1.0, 0.5 * m);",
      "}",
      "",
      // Signed, so a diverging ramp rather than the rainbow: the sign says
      // whether the pixel sits in a dip of the field or on a ridge of it,
      // and a cyclic hue ramp would paint those two opposite extremes the
      // same color. The 0.5 is because a five-point Laplacian sums four
      // differences, so its natural scale is that much larger than the
      // single differences DERIVED_GAIN is calibrated against.
      "vec3 laplacianColor(float lap) {",
      "  return hsl2rgb(lap < 0.0 ? 205.0 : 25.0, 0.9, 0.5 * magnitudeLift(abs(lap) * 0.5));",
      "}",
      "",
      // Isolines of the field at CONTOUR_LEVELS evenly spaced values: the
      // field is painted in its own Standard color ON its level sets, and
      // everything between them is black. So this shows the same picture
      // Standard does, but sampled down to a set of curves instead of
      // filling the plane - and each line carries the value it is a level
      // of, which is what makes a line's own color readable as its height.
      //
      // Each line is a constant width on SCREEN rather than a constant
      // width in t: its thickness in pixels is its distance-to-the-level
      // divided by how fast the field is moving there, which is exactly
      // what the gradient measures. Without that division the lines would
      // be invisible hairlines across the steep parts of the picture and
      // broad washes across the flat parts.
      //
      // Lines then fade out at BOTH ends of the slope range, because a level
      // set stops meaning anything in two opposite ways.
      //
      // Too steep (the upper fade): past about half a level per pixel there
      // is more than one contour inside every pixel and no amount of care
      // draws them - the Nyquist limit for this lattice, not a judgement
      // call. On black this reads as the chaotic regions going dark rather
      // than (as it did when the lines were drawn dark OVER the field) as
      // the plain field showing through.
      //
      // Too flat (the lower fade): where t is CONSTANT there is no crossing
      // to draw, but distInLevels alone cannot say so. A saturated sigmoid
      // pins t at exactly 1.0 or exactly 0.0, both of which are integer
      // multiples of a level, so distInLevels is exactly zero - and with
      // contourSlopeGain also driving slope to zero there, distInPixels is
      // a 0/0 that max()'s epsilon resolves to 0, i.e. to FULL coverage.
      // Requiring a minimum slope is what rejects that degenerate case and
      // asks for a genuine crossing nearby instead.
      //
      // (A constant field's level set really is the whole region rather
      // than a curve, so painting it solid is arguably not even wrong. It
      // is still an artifact: the real field only APPROACHES the sigmoid's
      // limit, and it is float32 saturation that makes it arrive.)
      //
      // The floor sits well clear of both cases it separates. A
      // legitimately gentle contour on a full-resolution canvas has its
      // neighbours a few hundred pixels away, a slope of ~5e-3 and up; a
      // saturated region's is 0. 1e-3 rejects only slopes so small that
      // adjacent levels would be more than a screen apart.
      "const float CONTOUR_LEVELS = 24.0;",
      "const float CONTOUR_WIDTH_PX = 1.4;",
      "const float CONTOUR_SLOPE_FLOOR = 1e-3;",
      "vec3 contourColor(float t, vec2 g) {",
      "  float f = t * CONTOUR_LEVELS;",
      "  float distInLevels = abs(f - floor(f + 0.5));",
      "  float slope = length(g)" + contourSlopeGain + " * CONTOUR_LEVELS;",
      "  float distInPixels = distInLevels / max(slope, 1e-12);",
      "  float alpha = 1.0 - smoothstep(0.0, CONTOUR_WIDTH_PX, distInPixels);",
      "  alpha *= 1.0 - smoothstep(0.5, 1.5, slope);",
      "  alpha *= smoothstep(CONTOUR_SLOPE_FLOOR, CONTOUR_SLOPE_FLOOR * 3.0, slope);",
      "  return rainbow(t) * alpha;",
      "}",
      "",
    ];

    var gridPhysicsLines = [
      // Scene lifespan's range IS the Simulation Duration and Bounce Count's
      // is u_bounceMax, so both read a uniform instead of a baked-in constant;
      // every other property's range is a fixed property of the scene.
      isRunTally ? "" : "const float OUTPUT_RANGE_MAX = " + PhysicsGPU.fnum(rangeMax) + ";",
      "",
      stepOnceSource,
      "",
    ];

    // Everything from here to gridTailLines belongs to the DERIVED program
    // only - see the variants at the bottom of this function.
    var sampleOutputLines = [
      // ---- One pixel's whole simulation ----
      //
      // From a starting (worldX, worldY) to the raw Output value at the end
      // of the run. A function rather than straight-line code inside main()
      // (which is what this was before the derived display modes existed)
      // because those modes call it several times per pixel, at a stencil
      // of neighbouring starting points.
      //
      // Re-entering it is safe: stepOnce()'s g_contactN globals are
      // ASSIGNED on every call rather than accumulated (see their own
      // comment in physics-gpu.js), so a second call starts from the same
      // state the first one did, and everything else in here is a local.
      //
      // Called through a single call site (see shadeDerived's loop) rather
      // than once per stencil point on purpose: the generated step function
      // is large, and letting the compiler inline a copy of it per point
      // would multiply the whole shader by the stencil size - slow to
      // compile on a big scene, and on an unlucky driver enough to hit a
      // program-size limit.
      outScalar + " sampleOutput(" + B.scalar + " worldX, " + B.scalar + " worldY) {",
      initial.declarationLines.map(function (l) { return "  " + l; }).join("\n"),
      "  " + PhysicsGridCodegen.generateCanonicalBodyDeclarationsGLSL(initial).split("\n").join("\n  "),
      "  " + PhysicsGPU.generateHingeAnchorLocalsGLSL(initial.hingeAnchors, precision).split("\n").join("\n  "),
      stepLoopLines,

      // A step count or a bounce count is always a plain float, in both passes.
      "  " + outScalar + " outputValue = " + outZero + ";",
      outputLines.join("\n"),
      "  return outputValue;",
      "}",
      "",
    ];

    var deltaTLines = [
      // ---- b - a, in t units ----
      //
      // The subtraction happens at the pass's OWN precision and only then
      // collapses. Differencing two already-normalized floats instead would
      // be catastrophic cancellation exactly where the df pass exists to
      // help: two neighbouring pixels at a deep zoom can differ by far less
      // than one float32 ULP of a t in [0, 1), so their difference would
      // quantize to zero across whole smooth regions and every derived mode
      // would show flat banding no simulation produced.
      //
      // The fold is the GLSL twin of fractal-stats.js's delta(): on a
      // circular output two values a whole range apart are the SAME point,
      // so the short way round the wheel is the only difference that means
      // anything. It is applied to the RAW difference rather than to t,
      // which is the same fold (dividing by the range afterwards commutes
      // with it) but leaves the df subtraction above intact. k is a small
      // exact integer, so multiplying the range back out is exact too.
      "float deltaT(" + outScalar + " a, " + outScalar + " b) {",
      "  " + outScalar + " d = " + OB.sub("b", "a") + ";",
      isCircularOutput
        ? "  float k = floor(" + OB.toFloat("d") + " / OUTPUT_RANGE_MAX + 0.5);\n" +
          "  d = " + OB.sub("d", OB.mul(OB.fromFloat("OUTPUT_RANGE_MAX"), OB.fromFloat("k"))) + ";"
        : "",
      "  return " + OB.toFloat("d") + " / " + deltaDenom + ";",
      "}",
      "",
    ];

    var gridTailLines = [
      // The four axial neighbours, in units of one full-res pixel. Every
      // derived mode is a five-point stencil (these four plus the center),
      // so this is the whole footprint any of them reads.
      "const vec2 STENCIL[4] = vec2[4](",
      "  vec2( 1.0,  0.0), vec2(-1.0,  0.0), vec2( 0.0,  1.0), vec2( 0.0, -1.0)",
      ");",
      "",

      // ---- The derived modes ----
      //
      // Only ever reached when the mode is NOT Standard: main() keeps its
      // original straight-line path for that one (see its own comment), so
      // nothing here is on the default mode's critical path.
      "vec3 shadeDerived(" + B.scalar + " worldX, " + B.scalar + " worldY, " + outScalar + " outputValue, float t) {",
      // One FULL-RES pixel of world distance, whatever level of the
      // refinement ladder is currently drawing. Deliberately NOT one
      // rendered pixel of the current sub-lattice: the whole progressive
      // design rests on a coarse level being an honest preview of the
      // finished image, and a stencil that widened with the stride would
      // make each level the derivative of a different picture - the image
      // would visibly change character as refinement ran, not just sharpen.
      // At stride 1 the two are the same thing anyway.
      "  float eps = u_scale / u_resolution.y;",
      // Every neighbour as a wrapped difference FROM THE CENTRE, which is
      // what keeps both of the stencils below seam-free on a circular
      // output - the same arrangement fractal-stats.js uses for its own
      // Laplacian sum, and for the same reason.
      "  float d[4];",
      "  for (int k = 0; k < 4; k++) {",
      "    vec2 o = STENCIL[k] * eps;",
      "    d[k] = deltaT(outputValue, sampleOutput(" +
        B.add("worldX", B.fromFloat("o.x")) + ", " + B.add("worldY", B.fromFloat("o.y")) + "));",
      "  }",
      "",
      // Five-point Laplacian: every term a wrapped difference from the
      // center, summed. Positive where the pixel sits in a dip of the
      // field, negative where it sits on a ridge.
      "  if (u_displayMode == MODE_LAPLACIAN) return laplacianColor(d[0] + d[1] + d[2] + d[3]);",
      "",
      // Central differences, in t per full-res pixel. d[0] and d[1] are the
      // two opposite neighbours each one pixel from the center, so their
      // difference spans two pixels and the 0.5 is the whole correction.
      // Taken as a difference of two center-relative deltas rather than
      // directly between the two neighbours, which is what keeps it
      // seam-free: either neighbour can be a whole range away from the
      // other on a circular output without the center being.
      "  vec2 g = vec2(d[0] - d[1], d[2] - d[3]) * 0.5;",
      "  if (u_displayMode == MODE_CONTOURS) return contourColor(t, g);",
      // Gradient is the last mode, so it is the fall-through rather than a
      // test of its own - there is nothing left for an unrecognised
      // u_displayMode to mean.
      "  return gradientColor(g);",
      "}",
      "",
      "void main() {",
    ];

    var gridMainLines = [
      // Standard mode's whole path, inline and character-for-character what
      // it was before the derived modes existed - NOT a call to
      // sampleOutput(), even though that function holds an identical copy of
      // it and calling it would halve the size of this shader.
      //
      // Measured, not assumed: routing the center sample through the
      // function changed 3.5% of the pixels of a colliding scene. The
      // generated GLSL is identical either way, so the cause is the driver,
      // which is free to contract and schedule float arithmetic differently
      // across a function boundary than it does inline - worth about one ULP
      // on the starting coordinate. One ULP is nothing anywhere else, and
      // everything here: a pixel whose ball lands a ULP nearer the edge of a
      // bumper leaves on a visibly different trajectory, which is the entire
      // premise of this page. So the default mode keeps the arithmetic it
      // has always had, to the bit, and the duplicated body is the price.
      initial.declarationLines.map(function (l) { return "  " + l; }).join("\n"),
      "  " + PhysicsGridCodegen.generateCanonicalBodyDeclarationsGLSL(initial).split("\n").join("\n  "),
      "  " + PhysicsGPU.generateHingeAnchorLocalsGLSL(initial.hingeAnchors, precision).split("\n").join("\n  "),
      stepLoopLines,
      "  " + outScalar + " outputValue = " + outZero + ";",
      outputLines.join("\n"),
      tLine,
    ];

    // ---- Two programs from the same pieces ----
    //
    // STANDARD is what the grid shows by default, and the only thing most
    // sessions ever draw: the header, the color ramp, ONE copy of the step
    // function (inline in main(), see gridMainLines' comment) and nothing
    // else. It doubles as the sampler: with u_sampleField set it writes the
    // raw t into a float target instead of a color, so every measurement of
    // the field (Color Zoom's spread check, the bounce-count divisor, the
    // superlatives, Global Stats) reads the very program that drew the
    // picture rather than a second compile of it.
    //
    // DERIVED adds sampleOutput() - a second copy of the whole simulation -
    // plus the stencil and the three derived color formulas. It is built only
    // when a derived display mode is first picked.
    //
    // They used to be one program, which meant every compile - and in df
    // every multi-second pipeline build on the first draw - paid for two
    // copies of the step function to serve a mode most views never enter,
    // and the sampler paid for them a second time over.
    var standardTailLines = [
      "  if (u_sampleField) { fragColor = vec4(t, 0.0, 0.0, 1.0); return; }",
      "  fragColor = vec4(colorMap(t), 1.0);",
      "}",
    ];
    var derivedTailLines = [
      "  if (u_displayMode != MODE_STANDARD) {",
      "    fragColor = vec4(shadeDerived(worldX, worldY, outputValue, t), 1.0);",
      "    return;",
      "  }",
      "  fragColor = vec4(colorMap(t), 1.0);",
      "}",
    ];

    return {
      gridSource: [].concat(gridHeaderLines, ["uniform bool u_sampleField;", ""], colorLibraryLines, gridPhysicsLines,
        ["void main() {"], worldCoordLines, gridMainLines, standardTailLines).join("\n"),
      derivedSource: [].concat(gridHeaderLines, colorLibraryLines, gridPhysicsLines, sampleOutputLines, deltaTLines,
        gridTailLines, worldCoordLines, gridMainLines, derivedTailLines).join("\n"),
      precision: df ? "df" : "f32",
      initial: initial,
      outScalar: outScalar,
      outZero: outZero,
      outputLines: outputLines,
      tLine: tLine,
      // Output bodies the color pass reads - carried in playback's state
      // even when anchored, since that pass has no starting state of its own.
      outputBodyIndices: outputIndices,
      stepOnceSource: stepOnceSource,
      stepLoop: stepLoop,
      loopStateVariables: loopStateVariables,
      loopStateRestoreLines: loopStateRestoreLines,
      physicsDeclarationLines: physicsDeclarationLines,
      worldCoordLines: worldCoordLines,
      stateWorldCoordLines: stateWorldCoordLines,
      colorLibraryLines: colorLibraryLines,
      deltaTLines: deltaTLines,
      libraryLines: [PhysicsGPU.libraryGLSL(precision, PhysicsEngine.speedCapFor(sceneToCompile))],
      constantLines: [
        isRunTally ? "" : "const float OUTPUT_RANGE_MAX = " + PhysicsGPU.fnum(rangeMax) + ";",
      ],
    };
  }

  // antialias:false is load-bearing, not a micro-optimization. The
  // progressive renderer finishes each frame by blitting its accumulator
  // straight onto the canvas, and blitFramebuffer into a MULTISAMPLED draw
  // framebuffer is an INVALID_OPERATION in ES 3.0 - which is exactly what
  // the default (antialias:true) would give us. Nothing here wants MSAA
  // anyway: the only geometry ever drawn is a fullscreen quad, so there are
  // no polygon edges to smooth, and every pixel is a point sample of a
  // chaotic field that must not be blended with its neighbours.
  var gl = canvas.getContext("webgl2", { antialias: false });
  if (!gl) {
    setStatus(false, "WebGL2 unavailable");
    showEmptyState("This browser/device doesn't support WebGL2, which the physics grid needs.");
    return;
  }

  var vs, quadBuffer;
  try {
    vs = PhysicsGPU.compileShader(gl, gl.VERTEX_SHADER, PhysicsGPU.VERTEX_SOURCE);
  } catch (err) {
    setStatus(false, "Compile error");
    showEmptyState("Couldn't build the grid shader: " + (err.message || err));
    return;
  }

  // ---- Building a program without stalling the page ----
  //
  // A df program is expensive to build twice over. The GLSL compile and link
  // are the small part; on ANGLE's Metal backend the real cost lands on the
  // program's FIRST DRAW, when the pipeline is finally compiled for the
  // target it is drawing into - measured at 0.5 to 11 seconds for a df
  // physics shader, against ~0.1s for the link. Done the obvious way (link,
  // check the status, draw) both halves block the page outright, which is
  // the freeze that used to greet the first zoom past the float32 wall.
  //
  // So a build is a small state machine that is only ever POLLED:
  //   linking - compile + link issued, status not asked for. With
  //             KHR_parallel_shader_compile the driver works on it in the
  //             background and COMPLETION_STATUS_KHR says when it is done
  //             without waiting for it. (Without the extension the first
  //             poll blocks for the link, which is the old behaviour.)
  //   warming - linked. A 1x1 draw per target format has been queued to
  //             force the pipeline build, with a fence behind it. Draws are
  //             asynchronous to the page, so the GPU process chews on that
  //             while the page carries on; the fence says when it is through.
  //   ready / failed
  // Until a program is ready the grid keeps drawing with the one it has.
  var parallelCompileExt = gl.getExtension("KHR_parallel_shader_compile");

  function startProgramBuild(fragmentSource) {
    var shader = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(shader, fragmentSource);
    gl.compileShader(shader);
    var program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, shader);
    gl.linkProgram(program);
    return { status: "linking", program: program, shader: shader, sync: null, error: null, startedAt: performance.now() };
  }

  function discardProgramBuild(build) {
    if (!build) return;
    if (build.sync) gl.deleteSync(build.sync);
    if (build.shader) gl.deleteShader(build.shader);
    if (build.program) gl.deleteProgram(build.program);
    build.sync = null; build.shader = null; build.program = null;
  }

  // One 1x1 draw per format this program will ever render into, so the
  // pipeline for each is built now rather than on the first real frame.
  // Every uniform is still at its default, so the step loop runs zero steps:
  // the draw itself is free, only the compile behind it is not. Leaves the
  // framebuffer, viewport, scissor and 2D texture binding as it found them -
  // the bound program is the caller's to restore (see useCurrentPass).
  function warmUpProgram(program, formats) {
    if (gl.isContextLost()) return;
    var prevViewport = gl.getParameter(gl.VIEWPORT);
    var prevFramebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    var prevTexture = gl.getParameter(gl.TEXTURE_BINDING_2D);
    var hadScissor = gl.isEnabled(gl.SCISSOR_TEST);
    if (hadScissor) gl.disable(gl.SCISSOR_TEST);
    gl.useProgram(program);
    bindQuad(gl.getAttribLocation(program, "a_position"));
    gl.viewport(0, 0, 1, 1);
    formats.forEach(function (entry) {
      // A bare format is one attachment; { format, count } is a program that
      // writes `count` outputs at once (playback's state pass) - the number
      // of attachments is part of the pipeline, so it has to match too.
      var format = entry.format || entry, count = entry.count || 1;
      // Blending is part of the pipeline too: antialiasing averages its
      // samples in with exactly this blend function (see drawAaBand).
      if (entry.blend) { gl.enable(gl.BLEND); gl.blendFunc(gl.CONSTANT_ALPHA, gl.ONE_MINUS_CONSTANT_ALPHA); }
      var textures = [], attachments = [];
      var fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      for (var k = 0; k < count; k++) {
        var texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texStorage2D(gl.TEXTURE_2D, 1, format, 1, 1);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + k, gl.TEXTURE_2D, texture, 0);
        textures.push(texture);
        attachments.push(gl.COLOR_ATTACHMENT0 + k);
      }
      gl.drawBuffers(attachments);
      // Deliberately no checkFramebufferStatus: it is a round trip to the GPU
      // process, which by the second format is busy with the first one's
      // pipeline build - so it would block the page for exactly the stall
      // this whole arrangement exists to avoid. Both formats are ones this
      // context is known to render to (RGBA8 always; RGBA32F only when the
      // caller has checked for EXT_color_buffer_float), and a draw into an
      // incomplete framebuffer is simply dropped.
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      if (entry.blend) gl.disable(gl.BLEND);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fbo);
      textures.forEach(function (t) { gl.deleteTexture(t); });
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFramebuffer);
    gl.bindTexture(gl.TEXTURE_2D, prevTexture);
    if (prevViewport) gl.viewport(prevViewport[0], prevViewport[1], prevViewport[2], prevViewport[3]);
    if (hadScissor) gl.enable(gl.SCISSOR_TEST);
  }

  // Moves a build one stage along if it can, without ever waiting - unless
  // `wait` is set, which is for the programs the page cannot draw anything
  // without (the float32 ones): those block for the link exactly as they
  // always did and skip the warm-up, since there is nothing to show meanwhile.
  function pumpProgramBuild(build, warmFormats, wait) {
    if (build.status === "linking") {
      if (!wait && parallelCompileExt &&
          !gl.getProgramParameter(build.program, parallelCompileExt.COMPLETION_STATUS_KHR)) return build.status;
      if (!gl.getProgramParameter(build.program, gl.LINK_STATUS)) {
        // A failed compile surfaces as a failed link; the shader's own log is
        // the one that says why.
        build.error = gl.getShaderInfoLog(build.shader) || gl.getProgramInfoLog(build.program) || "unknown shader error";
        discardProgramBuild(build);
        build.status = "failed";
        return build.status;
      }
      // A linked program keeps what it needs; the shader object would
      // otherwise stay alive for the life of the context, one per build.
      gl.deleteShader(build.shader);
      build.shader = null;
      if (wait) { build.status = "ready"; noteBuildDone(build); return build.status; }
      warmUpProgram(build.program, warmFormats);
      build.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      build.status = "warming";
      return build.status;
    }
    if (build.status === "warming") {
      if (wait || gl.getSyncParameter(build.sync, gl.SYNC_STATUS) === gl.SIGNALED) {
        gl.deleteSync(build.sync);
        build.sync = null;
        build.status = "ready";
        noteBuildDone(build);
      }
    }
    return build.status;
  }
  // For the performance readout: how long programs take to build here, from
  // the compile being issued to the program being usable.
  function noteBuildDone(build) {
    if (!build.startedAt) return;
    var ms = performance.now() - build.startedAt;
    build.startedAt = 0;
    perfStats.builds += 1;
    perfStats.buildMs += ms;
    perfStats.lastBuildMs = ms;
  }

  // ---- The grid's programs ----
  //
  // One per (precision, variant): "f32"/"df" by "standard"/"derived" - see
  // the bottom of compileScenePieces for the two variants. Which one is
  // bound is a function of the zoom (pickPrecision) and the display mode
  // (wantedVariant), and nothing else in the page has to know.
  //
  // The float32 programs are the ones the page falls back on, so they are
  // built on the spot, blocking, the first time they are needed. The df ones
  // build in the background (see above) while the float32 one of the same
  // variant keeps drawing; when one comes ready the view is simply redrawn
  // with it. Because both precisions are the same physics, at any zoom just
  // ABOVE the float32 wall the two must render identically - which is the
  // cheapest correctness check this code has, and what makes showing
  // float32 for the moment it takes df to build an honest stand-in.
  var passes = {};
  function passKey(precision, variant) { return precision + ":" + variant; }

  function finalizePass(pass) {
    var prog = pass.build.program;
    pass.program = prog;
    pass.build = null;
    pass.posLoc = gl.getAttribLocation(prog, "a_position");
    pass.uniforms = {
      resolution: gl.getUniformLocation(prog, "u_resolution"),
      gridStride: gl.getUniformLocation(prog, "u_gridStride"),
      gridOrigin: gl.getUniformLocation(prog, "u_gridOrigin"),
      centerHi: gl.getUniformLocation(prog, "u_centerHi"),
      centerLo: gl.getUniformLocation(prog, "u_centerLo"),
      centerLo2: gl.getUniformLocation(prog, "u_centerLo2"),
      centerLo3: gl.getUniformLocation(prog, "u_centerLo3"),
      scale: gl.getUniformLocation(prog, "u_scale"),
      colorZoom: gl.getUniformLocation(prog, "u_colorZoom"),
      maxSteps: gl.getUniformLocation(prog, "u_maxSteps"),
      durationSteps: gl.getUniformLocation(prog, "u_durationSteps"),
      bounceMax: gl.getUniformLocation(prog, "u_bounceMax"),
      displayMode: gl.getUniformLocation(prog, "u_displayMode"),
      // Standard variant only (null, and so ignored, on the derived one).
      sampleField: gl.getUniformLocation(prog, "u_sampleField"),
    };
    pass.status = "ready";
  }

  function pumpPass(pass, wait) {
    if (pass.status !== "building") return;
    // A standard program draws the picture (RGBA8) and measures it (RGBA32F,
    // see currentSampler); a derived one only ever draws.
    var formats = [gl.RGBA8];
    if (pass.variant === "standard" && hasFloatColorBuffer) formats.push(gl.RGBA32F);
    if (antialiasSupported()) formats.push({ format: gl.RGBA16F, blend: true });
    var status = pumpProgramBuild(pass.build, formats, wait);
    if (status === "ready") {
      finalizePass(pass);
      onPassReady(pass);
    } else if (status === "failed") {
      pass.status = "failed";
      pass.error = pass.build.error;
      pass.build = null;
      if (pass.precision !== "f32") setStatus(false, "High-precision shader unavailable: " + pass.error);
      updatePrecisionReadout();
    }
  }

  // The pass if it is ready, otherwise null - having made sure a build for
  // it is under way. `wait` blocks until that build finishes.
  function requestPass(precision, variant, wait) {
    var key = passKey(precision, variant);
    if (!passes[key]) {
      var pass = { key: key, precision: precision, variant: variant, status: "building", build: null,
        program: null, posLoc: -1, uniforms: null, error: null };
      try {
        pass.build = startProgramBuild(buildFragmentShader(scene, precision, variant));
      } catch (err) {
        // Thrown by the code generator itself, before any GLSL existed.
        pass.status = "failed";
        pass.error = err.message || String(err);
        if (precision !== "f32") setStatus(false, "High-precision shader unavailable: " + pass.error);
      }
      passes[key] = pass;
    }
    if (wait) pumpPass(passes[key], true);
    return passes[key].status === "ready" ? passes[key] : null;
  }

  // Every frame, from the render loop: moves each build in flight along.
  // Done here rather than inside requestPass so a warm-up draw can never
  // land in the middle of the ladder's own draw sequence.
  function pumpPassBuilds() {
    Object.keys(passes).forEach(function (k) { pumpPass(passes[k], false); });
  }

  function onPassReady(pass) {
    // The very first program is built before the page has an active pass, a
    // view or a precision mode - there is nothing yet to update or redraw.
    if (!activePass) return;
    updatePrecisionReadout();
    // If this is the program the current view has been waiting for, draw the
    // view again with it. (activePass is still the stand-in at this point.)
    if (pass.precision === pickPrecision() && pass.variant === wantedVariant() && pass !== activePass) markDirty();
  }

  // Every frame, from the render loop - the step + color programs' twin of
  // pumpPassBuilds. When a set the view has been waiting for comes ready, the
  // view is redrawn with it.
  function pumpPlaybackBuilds() {
    Object.keys(playbackGpu.programs).forEach(function (precision) {
      var entry = playbackGpu.programs[precision];
      if (entry.status !== "building") return;
      pumpPlaybackBuild(entry, false);
      if (entry.status === "ready" && precision === effectivePrecision() && (precision !== "f32" || f32NeedsSlicing())) {
        updatePrecisionReadout();
        markDirty();
      }
    });
  }

  // The status line while something the view is waiting on is still
  // building, and "Ready" again once nothing is. Every frame, from the render
  // loop - which is what makes it correct however the wait ends: the program
  // arriving, the view zooming back out to where it is no longer wanted, or
  // Play being paused.
  var buildStatusShowing = false;
  function refreshBuildStatus() {
    var message = null;
    if (pickPrecision() !== "f32" && precisionPending(pickPrecision())) message = "Preparing high precision\u2026";
    else if (f32SlicedPending()) message = "Preparing a heavy scene\u2026";
    else if (timeline.playing && playbackProgramsPending(effectivePrecision())) message = "Preparing playback\u2026";
    if (message) {
      setStatus(true, message);
      buildStatusShowing = true;
    } else if (buildStatusShowing) {
      setStatus(true, "Ready");
      buildStatusShowing = false;
    }
  }

  function discardAllPasses() {
    Object.keys(passes).forEach(function (k) {
      var pass = passes[k];
      if (pass.build) discardProgramBuild(pass.build);
      if (pass.program) gl.deleteProgram(pass.program);
      delete passes[k];
    });
  }

  if (!requestPass("f32", "standard", true)) {
    setStatus(false, "Compile error");
    showEmptyState("Couldn't build the grid shader: " + (passes[passKey("f32", "standard")].error || "unknown error"));
    return;
  }
  var activePass = passes[passKey("f32", "standard")];
  gl.useProgram(activePass.program);
  var isBouncesOutput = scene.output.property === "bounces";
  // Page-level twin of buildFragmentShader's isInfinitePosition, for the
  // hover panel's own copy of the color formula.
  var isInfinitePositionOutput = scene.edgeMode === "infinite" &&
    (scene.output.property === "x" || scene.output.property === "y");
  // The divisor every pixel's bounce count is scaled by - the largest count
  // currently in view, re-measured by findBounceMax on every render. 1 until
  // the first measurement (and for every other Output, where it's unused), so
  // a pixel's t is never divided by zero.
  var bounceMaxValue = 1;
  // Same fixed range the shader bakes in as OUTPUT_RANGE_MAX - kept here too
  // so the hover-replay panel (further below) can color its own frames with
  // the exact same formula the grid itself uses for that pixel.
  // Recomputed on read rather than cached: "Scene lifespan"'s range is the
  // step budget, which the Settings slider can change at any time.
  function currentOutputRangeMax() { return outputRangeMax(scene, scene.output.property); }
  // Same condition as buildFragmentShader's own isCircularOutput - see its
  // comment for exactly which cases this covers. Reused below both for
  // hueRangeMaxValue (the hover panel's own color formula) and for
  // superlative-finding's neighbor-distance metric (a genuinely circular
  // quantity needs a wraparound-aware distance, not a plain difference).
  // Named rather than an inline IIFE so setScene() can re-run it for a
  // scene arriving after boot (same reason as adoptSceneDuration above).
  function computeIsCircularOutput() {
    var prop = scene.output.property;
    return prop === "angle" || ((prop === "x" || prop === "y") && scene.edgeMode === "wrap");
  }
  var isCircularOutput = computeIsCircularOutput();
  var hueRangeMaxValue = isCircularOutput ? 360 : 300;
  quadBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  // Re-pointed whenever the bound pass changes - the attribute index is
  // per-program, so it can't be set once and left alone the way it could
  // when there was only ever one program.
  function bindQuad(posLoc) {
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
  }
  bindQuad(activePass.posLoc);

  // The view center's float32 words - four per axis, from the double-double
  // the page holds it as (see view.center). This is where precision that a
  // single float32 uniform would throw away at upload is actually handed
  // over. A program that carries fewer words never declared the uniforms
  // for the rest, so their locations are null and setting them is a no-op.
  function setCenterUniforms(u) {
    var words = PhysicsDF.wordUniformValues(view.center.x, view.center.xLo, view.center.y, view.center.yLo);
    gl.uniform2f(u.centerHi, words[0][0], words[1][0]);
    gl.uniform2f(u.centerLo, words[0][1], words[1][1]);
    gl.uniform2f(u.centerLo2, words[0][2], words[1][2]);
    gl.uniform2f(u.centerLo3, words[0][3], words[1][3]);
  }

  // ---- Measuring the field: the standard program, in sample mode ----
  //
  // Everything that reads the picture back as numbers - the Color Zoom
  // suggestion, the bounce-count divisor, the superlatives, Global Stats -
  // draws the STANDARD program into an RGBA32F target with u_sampleField set,
  // which makes it write the raw pre-color t into the red channel instead of
  // a color (see compileScenePieces). Reading t needs no reverse color math
  // and none of the 8-bit quantization noise that would introduce near hue
  // boundaries - and because it is the very program that draws the grid,
  // there is no second compile of the scene's physics to wait for, and no
  // way for the measurement to disagree with the picture.
  //
  // Always the standard variant, whatever display mode is showing: every
  // number on the Global Stats card is described in terms of the Output
  // property, and the card's own gradient/orientation sections would
  // otherwise be reporting the derivative of a derivative.
  var SAMPLE_SIZE = 24;
  var hasFloatColorBuffer = !!gl.getExtension("EXT_color_buffer_float");
  // Null when there is nothing to measure with right now: no float render
  // targets on this device, or the grid is showing a df picture whose
  // standard program is still building. Never falls back across precisions -
  // a sampler reading the f32 shader while the grid displays the df one
  // would answer questions about a picture nobody is looking at. Every
  // caller already treats null as "no measurement this time".
  function currentSampler() {
    if (!hasFloatColorBuffer) return null; // heuristic only - skip quietly if this GPU/browser can't render float textures
    // Above float32 the field is measured by the sliced renderer's own
    // programs instead (see drawSampleBandSliced), so this is only ever the
    // float32 grid program - and only while float32 is what is on screen.
    if (effectivePrecision() !== "f32" || f32NeedsSlicing()) return null;
    return requestPass("f32", "standard", true);
  }

  // Can the field be measured right now, by either route?
  function canSampleField() {
    return !!(hasFloatColorBuffer && (slicedProgramsForGrid() || currentSampler()));
  }

  setStatus(true, "Ready");

  // center.x/.y are the view centre as they always were. xLo/yLo are the
  // rest of it: past about 1e-13 a float64 can no longer tell one pixel's
  // world coordinate from the next, so the centre is held as a
  // DOUBLE-DOUBLE - x + xLo, ~106 bits - which is more than the deepest
  // precision the shaders have (four float32 words, ~96 bits) can use.
  // Everything that only needs to know roughly where the view is (the
  // readouts, the float64 hover preview) goes on reading .x/.y; everything
  // that has to land on the right PIXEL goes through the helpers below.
  var view = { center: { x: DEFAULT_CENTER.x, y: DEFAULT_CENTER.y, xLo: 0, yLo: 0 }, scale: DEFAULT_SCALE };

  // (hi + lo) + delta, renormalized - one axis of a pan. delta is a float64
  // and small, which is the easy case for a double-double: twoSum keeps
  // exactly what adding it to `hi` alone would have rounded away.
  function ddAddNumber(hi, lo, delta) {
    var s = PhysicsDF.twoSum64(hi, delta);
    return PhysicsDF.twoSum64(s[0], s[1] + lo);
  }
  function shiftViewCenter(dx, dy) {
    var nx = ddAddNumber(view.center.x, view.center.xLo, dx);
    var ny = ddAddNumber(view.center.y, view.center.yLo, dy);
    view.center.x = nx[0]; view.center.xLo = nx[1];
    view.center.y = ny[0]; view.center.yLo = ny[1];
  }
  // The same, by the exact products ax*bx and ay*by. For a shift that has to
  // be right to far more digits than a float64 product keeps - see
  // zoomAtClientPoint.
  function shiftViewCenterByProducts(ax, bx, ay, by) {
    var px = PhysicsDF.twoProd64(ax, bx), py = PhysicsDF.twoProd64(ay, by);
    shiftViewCenter(px[0], py[0]);
    shiftViewCenter(px[1], py[1]);
  }
  function setViewCenter(x, y) {
    view.center.x = x; view.center.xLo = 0;
    view.center.y = y; view.center.yLo = 0;
  }
  // Every digit of the centre, for the keys that decide whether saved state
  // still belongs to the view on screen. With only .x/.y in them, a pan at a
  // deep zoom - which moves nothing but the low halves - looked like no
  // move at all.
  function viewCenterKey() {
    return [view.center.x, view.center.xLo, view.center.y, view.center.yLo].join(" ");
  }
  // The world point `uvx, uvy` view-heights from the centre, as a
  // double-double: { x, y, xLo, yLo }. A plain { x, y } is still a valid
  // world point everywhere one is accepted - its low halves read as zero.
  function worldPointAtUV(uvx, uvy) {
    var px = ddAddNumber(view.center.x, view.center.xLo, uvx * view.scale);
    var py = ddAddNumber(view.center.y, view.center.yLo, uvy * view.scale);
    return { x: px[0], y: py[0], xLo: px[1], yLo: py[1] };
  }
  // The inverse: how many view-heights from the centre a world point is,
  // as [u, v]. The high and low differences are taken separately and only
  // then added - subtracting two nearly equal 1e3-sized numbers first would
  // leave nothing of a difference that lives entirely in the low halves.
  function worldPointToUV(point) {
    return [
      ((point.x - view.center.x) + ((point.xLo || 0) - view.center.xLo)) / view.scale,
      ((point.y - view.center.y) + ((point.yLo || 0) - view.center.yLo)) / view.scale,
    ];
  }
  // The CENTRE of the rendered cell a view-relative point falls in, by the
  // shader's own mapping (pixel index, plus a half, over the canvas height)
  // - so a snapped point is exactly a point some pixel simulates. `cell`
  // names that pixel, for callers that only want to know whether the cursor
  // has moved to a different one.
  function snappedWorldPointAtUV(uvx, uvy) {
    var col = Math.floor(uvx * canvas.height + 0.5 * canvas.width);
    var row = Math.floor(uvy * canvas.height + 0.5 * canvas.height);
    var point = worldPointAtUV((col + 0.5 - 0.5 * canvas.width) / canvas.height, (row + 0.5 - 0.5 * canvas.height) / canvas.height);
    point.cell = col + "," + row;
    return point;
  }
  // b - a along one axis, for two double-double world points. The high and
  // low halves are differenced separately: at a deep zoom the whole
  // difference lives in the low halves.
  function worldPointDelta(a, b, axis) {
    return (b[axis] - a[axis]) + ((b[axis + "Lo"] || 0) - (a[axis + "Lo"] || 0));
  }
  // a + (b - a) * t per axis, staying a double-double.
  function lerpWorldPoint(ax, bx, tx, ay, by, ty) {
    var px = ddAddNumber(ax.x, ax.xLo || 0, worldPointDelta(ax, bx, "x") * tx);
    var py = ddAddNumber(ay.y, ay.yLo || 0, worldPointDelta(ay, by, "y") * ty);
    return { x: px[0], y: py[0], xLo: px[1], yLo: py[1] };
  }

  // ---- Progressive refinement state ----
  //
  // Declared up here, next to `view`, rather than down beside the rest of
  // the progressive machinery: markDirty() is reachable from setup code
  // that runs long before that section's own `var`s are initialised (var
  // bindings aren't hoisted with their values, unlike the function
  // declarations that operate on them), and a half-built state object is
  // the kind of thing that only breaks on some paths.
  //
  // `stride` is the sub-lattice spacing, in full-res pixels, of the level
  // currently being worked on: it starts at the coarsest level's spacing
  // and halves until it reaches the end level's. `sublattice` is which of
  // that level's three new sub-lattices (see stepProgressive) is being
  // drawn, or 0 for the base level; `band` is how far down its own draw
  // has got. `complete` means there is nothing left to refine.
  var progressive = {
    stride: 0,          // 0 = nothing started yet; set on the first step after a reset
    sublattice: 1,      // 1..3 - which of the level's three new sub-lattices is next
    band: 0,            // next un-drawn row of the current sub-lattice's target
    complete: false,
    accumStride: 0,     // spacing of the data currently sitting in the accumulator
    // Antialiasing: 0 while the ladder is still running (or on a device
    // that can't average at all); from 1 up, how many whole-screen samples
    // have been averaged together so far.
    aaSample: 0,
    // Sliced rendering only (see that section): the tile whose steps are
    // still being run, and how far along the current row it starts when a
    // tile is narrower than the level.
    tile: null,
    tileX: 0,
  };

  // ---- Picture reuse (Settings > Performance Settings > Reuse Last Picture;
  // on by default) ----
  //
  // Every view change used to throw the picture away and start the ladder
  // again from its coarsest level, which above float32 means seconds to a
  // minute of looking at blocks. But the last picture is still sitting in a
  // texture, and most of a pan or a zoom is a view of the same world points
  // it already shows. So, with the setting on, a full-resolution copy of the
  // best picture so far is kept (`source`, with the view it is a picture
  // OF), and each new run works out how it maps onto the view being
  // rendered (`run` - see reusePlanRun). That buys two different things:
  //
  //   A PREVIEW, for any view change. Until the ladder has a finished level
  //   at least as fine as the old picture looks from here, the screen shows
  //   the old picture moved and magnified into place (presentWithSource),
  //   and the ladder's output where the old picture has nothing - a pan's
  //   newly exposed edge, the border of a zoom out. Zoom in 2x and the
  //   screen is at half resolution at once, where the ladder alone would
  //   have been at a 32nd. Nothing is saved: every pixel is still rendered.
  //
  //   EXACT reuse, for a pan. Pans are snapped to whole device pixels while
  //   the setting is on (panByClientDelta), so a panned view's pixels are
  //   the old view's pixels, moved - the same world points, to within the
  //   ~1e-4 of a pixel that any two renders differ by. Those are copied into
  //   each level (reuseFillCovered) instead of being simulated, and only the
  //   strips the pan exposed are drawn (levelSimRegion). This one IS a
  //   saving, and it is permanent: a small pan at quad-float costs its strip
  //   rather than the whole screen again.
  //
  // What is reused is COLORS, so the source is only used for a run that
  // would color the same world point the same way - reuseLookKey is
  // everything that goes into that besides the view. The derived display
  // modes difference neighbouring pixels, which makes their colors depend on
  // the zoom too, so they get the pan reuse and not the zoom preview.
  //
  // Declared up here for the same reason `progressive` is: resetProgressive
  // reads it, and that is reachable long before the ladder's own section.
  var reuseEnabled = false;
  var reuse = {
    source: null,        // {tex, fbo, width, height}, full resolution
    center: null,        // the view the source is a picture of...
    scale: 0,
    stride: 0,           // ...the spacing of its samples, in its own pixels...
    // ...which of its pixels antialiasing had FINISHED with, as {x0, y0, x1,
    // y1} in its own pixels, or null for none. Usually all or nothing, but a
    // pan that interrupts antialiasing leaves a picture that is both: the
    // pixels it copied from a finished source are finished, and the strip
    // it drew itself is plain samples still waiting for theirs...
    aaRect: null,
    look: "",            // ...and the look and precision it was rendered with
    precision: "",
    // What the accumulator currently holds a picture OF, noted as each run
    // starts - by the time a run is abandoned the view has already moved
    // on. null when it is not the ladder's picture (playback painted it).
    image: null,
    // How the source maps onto the run in progress; null when it doesn't.
    run: null,
    // The fractions of a device pixel that snapping a pan has set aside.
    panCarryX: 0,
    panCarryY: 0,
  };
  var sceneGeneration = 0;
  // Below this much of the screen, a source the ladder has not yet bettered
  // is dropped for the ladder's own picture anyway: it is mostly off screen.
  var REUSE_KEEP_COVERAGE = 0.15;
  // What a level with nothing to simulate reports as its cost - not 0, which
  // the budget loop reads as "nothing left to draw".
  var REUSE_FREE_COST = 1e-6;

  // ---- The playback timeline ----
  //
  // Declared up here for the same reason `progressive` is: the progress ring
  // (updateRenderProgressRing) reads it, and that is reachable from setup
  // code long before the Playback section further down has run.
  //
  // `step` is the step the grid shows: every render and every measurement
  // of the picture simulates to it (see renderedSteps), and Settings'
  // Simulation Duration is where the timeline ends. It rests AT that end,
  // which is all the grid ever showed before it had a timeline. The other
  // fields are the Playback section's own bookkeeping - see there.
  var timeline = {
    step: simulationSteps,
    playing: false,
    // Steps the playback clock has asked for but no draw has run yet.
    carry: 0,
    lastTickAt: 0,
    // Which view the CURRENT state texture was built for (null: nothing
    // valid in it), and how many steps it holds.
    stateKey: null,
    stateStep: 0,
    // A write into the OTHER state texture that is still in flight, or null.
    pass: null,
    // The last view seen, and when it changed - playback waits for the
    // view to hold still before rebuilding state for it.
    seenKey: null,
    seenAt: 0,
    // What the playback color pass last put in the accumulator, so a pause
    // can tell whether that image is still the one it would ask the ladder
    // to refine.
    presentedKey: null,
    // Whether playback drew the most recent frame (rather than handing it to
    // the ladder), and if so what it was doing - read by the progress ring
    // and the timeline readout.
    drawing: false,
    catchingUp: false,
    catchUpFraction: 0,
    stride: 1,
    // While `following`, the step comes from the Inspect preview's clock
    // rather than this timeline's own - see followInspection, and the Map
    // Evolution card whose being open turns that on. followTarget is the
    // step that clock is showing, followPlaying whether it is advancing.
    following: false,
    followTarget: 0,
    followPlaying: false,
  };
  function renderedSteps() { return Math.min(timeline.step, simulationSteps); }

  var dirty = true;
  // Every caller means the same thing by this: "what's on screen no longer
  // reflects the view." That has always invalidated the rendered image; now
  // it also invalidates every partially-accumulated refinement level, since
  // those are samples of the OLD view and blending them into the new one
  // would composite two different pictures together.
  // statsOnViewChanged is the third thing that means: a view change
  // invalidates the rendered image, every partially-accumulated refinement
  // level, and every Global Stats number - all three are measurements of
  // the OLD view.
  function markDirty() { dirty = true; resetProgressive(); scheduleColorSpreadCheck(); statsOnViewChanged(); }

  // ---- Choosing a precision ----
  //
  // The float32 wall isn't at a fixed zoom: it's wherever one pixel's worth
  // of world distance drops below the ULP of the coordinates that pixel's
  // starting scene is built from. Those coordinates are the view center
  // plus the scene's own authored positions, so the largest magnitude among
  // them is what sets the ULP - pan somewhere with bigger numbers and the
  // wall arrives sooner.
  // Named for the same reason adoptSceneDuration is - setScene() recomputes
  // it, since a different scene has a different largest coordinate and so a
  // different float32 wall.
  function computeSceneCoordinateSpan() {
    var m = 1;
    scene.bodies.forEach(function (b) {
      m = Math.max(m, Math.abs(b.x || 0), Math.abs(b.y || 0));
    });
    return Math.max(m, scene.frameWidth || 0, scene.frameHeight || 0);
  }
  var sceneCoordinateSpan = computeSceneCoordinateSpan();
  // Switch to df once one pixel's world distance is under this many
  // float32 ULPs. Measured on the samples, float32 is still clean at ~3
  // ULPs per pixel (0.4% of neighbouring pixel pairs identical) and gone by
  // ~0.3 (77%), so the wall really is at about 1 - this leaves a 20x
  // margin. Not larger: a df pixel costs 5x to 25x a float32 one (measured
  // per scene - hinges at the low end, swept collisions and gravity at the
  // high end), which is paid for in how far down the refinement ladder a
  // view gets before the user moves again, so switching hundreds of times
  // earlier than necessary is not free. Not smaller: the
  // crossover wants to happen while both passes still agree, which is what
  // makes comparing them (Settings > Numeric precision) a real check.
  var DF_SWITCH_MARGIN_ULPS = 64;
  // Every precision the grid can draw at, coarsest first: float32, then
  // two, three and four float32 words per number (see physics-df.js). The
  // rungs above df need exact constants this page builds with BigInt, so on
  // a browser without it the ladder simply stops at df.
  var PRECISION_LADDER = ["f32", "df", "tf", "qf"].filter(function (precision) {
    return PhysicsDF.isSupported(precision);
  });
  var PRECISION_LABELS = {
    f32: "float32 (~7 digits)",
    df: "double-float (~15 digits)",
    tf: "triple-float (~21 digits)",
    qf: "quad-float (~28 digits)",
  };
  // Per scene, per precision, filled in by calibrateSliceSteps: how many
  // steps one sliced draw runs, and which precisions turned out to need
  // longer for a single step than the GPU will allow a draw at all.
  var sliceSteps = {};
  var sliceCalibrated = {};
  var sliceTooHeavy = {};
  // "auto" or one of PRECISION_LADDER - the latter being the Settings
  // panel's manual override, for comparing two passes at the same view.
  //
  // Starts at Auto, and (being page state, never persisted) is back at
  // Auto every time this page is opened - including on the way back from
  // the physics editor. Auto only reaches for the costlier df/tf/qf passes
  // once the zoom is deep enough that float32 visibly falls apart (see
  // precisionForSpacing), so a shallow session pays nothing for it; the
  // Force rungs remain for comparing two passes at the same view. The
  // deep-zoom tip below offers Auto to whoever has forced float32 and then
  // zoomed past where it holds up.
  // ...unless it was changed on the builder page first - it is the same
  // dropdown there (see "One settings body"), which was put at Auto when
  // the page loaded.
  var precisionMode = sharedSettings.readPrecision(PRECISION_LADDER);

  function float32UlpAt(magnitude) {
    return Math.pow(2, Math.ceil(Math.log2(Math.max(magnitude, 1e-30))) - 24);
  }
  // The full-resolution device height - which, now that the backing store
  // is always full resolution, is simply the canvas's own height; the
  // Math.max is left in place only to keep this honest while canvasArea is
  // hidden and reports 0. It is deliberately the FINEST spacing the view
  // can reach rather than the spacing of whichever refinement level happens
  // to be on screen: the precision choice has to be stable across a
  // refinement run, or the coarse and fine levels of one picture would be
  // computed by two different shaders and disagree with each other.
  function referenceHeightPx() {
    return Math.max(canvasArea.clientHeight * gridDpr(), canvas.height, 1);
  }
  // The distance in world units between two adjacent simulated points.
  function worldPixelSpacing() { return view.scale / referenceHeightPx(); }
  // The smallest step a coordinate of this size can take at `precision`:
  // each float32 word carries 24 bits, and a multi-float number's words do
  // not overlap, so N words is 24N bits. (Measured rather than assumed - the
  // arithmetic's worst relative error is 1.8e-22 at three words and 6.6e-30
  // at four, within a bit or two of 2^-72 and 2^-96; see the multi-float
  // arithmetic test.)
  function precisionUlpAt(precision, magnitude) {
    return float32UlpAt(magnitude) * Math.pow(2, -24 * (PhysicsDF.wordsFor(precision) - 1));
  }
  // The coarsest rung that still has DF_SWITCH_MARGIN_ULPS of its own ULPs
  // per `spacing` - the same margin at every rung, for the same reason it
  // is the margin at the first. Past the last rung there is nothing finer
  // to switch to, and the last rung it is.
  function precisionForSpacing(spacing) {
    var magnitude = Math.max(Math.abs(view.center.x), Math.abs(view.center.y), sceneCoordinateSpan);
    for (var i = 0; i < PRECISION_LADDER.length; i++) {
      if (spacing >= precisionUlpAt(PRECISION_LADDER[i], magnitude) * DF_SWITCH_MARGIN_ULPS) return PRECISION_LADDER[i];
    }
    return PRECISION_LADDER[PRECISION_LADDER.length - 1];
  }
  function autoPrecision() { return precisionForSpacing(worldPixelSpacing()); }
  function pickPrecision() {
    return precisionMode === "auto" ? autoPrecision() : precisionMode;
  }

  function updatePrecisionReadout() {
    if (!precisionReadout || !activePass) return;
    var active = effectivePrecision(), wanted = pickPrecision();
    var text = PRECISION_LABELS[active];
    // A coarser rung standing in for programs that are still on their way
    // (or that this device couldn't build, or can't run fast enough) says
    // so, rather than reading as a choice.
    if (active !== wanted) {
      var name = PRECISION_LABELS[wanted].replace(/ \(.*$/, "");
      text += " \u2014 " + name + (precisionPending(wanted) ? " compiling\u2026" : sliceTooHeavy[wanted] ? " too slow for this scene on this GPU" : " unavailable");
    }
    precisionReadout.textContent = text;
  }
  if (precisionSelect) {
    // Explicit, rather than trusting the markup's own `selected`: browsers
    // restore form-control values across a reload or a Back navigation, which
    // would otherwise leave the dropdown showing whatever it was set to last
    // visit while precisionMode had genuinely reset to Auto.
    precisionSelect.value = precisionMode;
    // A rung this browser cannot build (see PRECISION_LADDER) is not offered.
    Array.prototype.slice.call(precisionSelect.options).forEach(function (option) {
      if (option.value !== "auto" && PRECISION_LADDER.indexOf(option.value) === -1) precisionSelect.removeChild(option);
    });
    precisionSelect.addEventListener("change", function () {
      precisionMode = precisionSelect.value;
      markDirty();
    });
  }

  // Picture reuse (see `reuse`). Page state like the precision above - and,
  // since it became part of both performance presets, ON on every arrival
  // (it used to start off, as something that changes what the screen shows
  // while a render is under way and so ought to be asked for; in use it
  // turned out to be what anyone would ask for). It is switched on at the end
  // of boot rather than here, by the preset the page starts at - see
  // applyPerfValues - because the machinery it switches on is further down.
  // Shared by the checkbox and the performance presets (see applyPerfValues).
  function setReuseEnabled(on) {
    on = !!on;
    if (reusePictureCheckbox) reusePictureCheckbox.checked = on;
    if (on === reuseEnabled) return;
    reuseEnabled = on;
    reuse.panCarryX = reuse.panCarryY = 0;
    if (reuseEnabled) {
      // The picture on screen is of this view, if a run has got anywhere
      // with it - so the very next pan or zoom has something to reuse.
      if (!dirty && progressive.stride > 0) reuseNoteImage();
      return;
    }
    // Off mid-run: a run that was reusing pixels has only drawn part of
    // each level, so it cannot simply carry on without them.
    reuse.image = null;
    reuseDropSource();
    markDirty();
  }
  if (reusePictureCheckbox) {
    // (The checkbox is NOT put at reuseEnabled here: it may have been set
    // from the builder page before the map existed, and the end of boot
    // takes reuseEnabled from IT - see "Performance settings: the controls".)
    reusePictureCheckbox.addEventListener("change", function () {
      setReuseEnabled(reusePictureCheckbox.checked);
      syncPerfPresetUI();
    });
  }

  // ---- "Those radial lines aren't real" ----
  //
  // Zoomed far enough out with BOTH axes driven by one body's starting
  // velocity, the picture fills with rays converging on the origin, and they
  // look like structure. They are not: every body's speed is clamped to
  // PhysicsEngine.speedCapFor, and a clamp keeps a vector's DIRECTION while
  // discarding its length. So outside a disc of radius = the cap, every
  // pixel's simulation starts from the same speed and differs only in which
  // way it was pointed - that whole region collapses onto one angular
  // coordinate, and a function of angle alone drawn in a plane is a fan of
  // rays. Zooming out is what brings the region past the cap into frame.
  //
  // Both inputs, on the SAME body, one of each component: the cap is on the
  // magnitude of one body's velocity VECTOR, so that is the only mapping
  // that makes this plane a velocity plane and the artifact radial. Split
  // the two components across different bodies and each gets clamped against
  // its own (authored, constant) other component instead, which puts a
  // straight edge in the picture rather than a fan - a different artifact,
  // and not the one this sentence explains.
  var VELOCITY_CAP_TIP_ID = "velocity-speed-cap";
  var VELOCITY_CAP_TIP_MAX_ZOOM = 0.1;
  function usesVelocityPlaneInput() {
    var xi = scene && scene.xInput, yi = scene && scene.yInput;
    if (!xi || !yi) return false;
    if (xi.body !== yi.body) return false;
    return [xi.property, yi.property].sort().join(",") === "vx,vy";
  }
  function maybeShowVelocityCapTip() {
    if (!usesVelocityPlaneInput()) return false;
    // Same quantity the readout shows, so the threshold reads in the units
    // the user sees: 0.1x means a tenth the default width across the frame.
    if (DEFAULT_SCALE / view.scale > VELOCITY_CAP_TIP_MAX_ZOOM) return false;
    // The zoom readout is what the trigger is about, so point at it when the
    // Display card is open. Shut, that readout has no box at all - and this
    // tip is purely an explanation, with nothing in the card to go and
    // click, so it points at the collapsed menu button rather than prising
    // the card open the way the Color Zoom suggestion legitimately does for
    // a control the user actually has to reach.
    var anchor = tipAnchorVisible(zoomReadout) ? zoomReadout : displayMenu.anchor();
    return showTip(VELOCITY_CAP_TIP_ID, anchor,
      "Radial lines are an artifact of the maximum speed cap.",
      { okLabel: "Dismiss", noArrowAbove: true });
  }

  // Which of a scene's two programs the display mode calls for.
  function wantedVariant() {
    return displayMode && displayMode.id !== 0 ? "derived" : "standard";
  }

  // Is the machinery that draws the grid at `precision` built and ready?
  // Above float32 that is the sliced renderer's step + color programs (see
  // "Sliced rendering") - or, on a device with no float render targets to
  // carry state in, the single-draw grid program at that precision, which is
  // the only way left to draw it. Asking also STARTS the build if there is
  // none, so this doubles as the way to request one.
  function precisionReady(precision) {
    if (precision === "f32") return true;
    if (sliceTooHeavy[precision]) return false;
    if (hasFloatColorBuffer) return !!playbackProgramsFor(precision);
    return !!requestPass(precision, wantedVariant(), false);
  }
  // The same question WITHOUT starting anything - for the rungs below the
  // one the view wants, which are worth using if the user has already been
  // through them and not worth a seconds-long build just to stand in.
  function precisionBuilt(precision) {
    if (precision === "f32") return true;
    if (sliceTooHeavy[precision]) return false;
    if (hasFloatColorBuffer) {
      var entry = playbackGpu.programs[precision];
      return !!entry && entry.status === "ready";
    }
    var pass = passes[passKey(precision, wantedVariant())];
    return !!pass && pass.status === "ready";
  }
  function precisionPending(precision) {
    if (precision === "f32") return false;
    if (hasFloatColorBuffer) return playbackProgramsPending(precision);
    var pass = passes[passKey(precision, wantedVariant())];
    return !!pass && pass.status === "building";
  }

  // The precision the grid is ACTUALLY drawing with right now: what the zoom
  // calls for, unless that is still building (or couldn't be built), in
  // which case the finest rung below it that is already built stands in -
  // float32 if there is none. Everything that has to agree with the picture
  // - the hover replay, playback, the samplers - asks this rather than
  // pickPrecision().
  function effectivePrecision() {
    var wanted = pickPrecision();
    if (precisionReady(wanted)) return wanted;
    for (var i = PRECISION_LADDER.indexOf(wanted) - 1; i > 0; i--) {
      if (precisionBuilt(PRECISION_LADDER[i])) return PRECISION_LADDER[i];
    }
    return "f32";
  }

  // How much earlier than a switch to START building the next rung's
  // programs, as a multiple of DF_SWITCH_MARGIN_ULPS. A wheel notch zooms by
  // well under 2x, so 16x is several notches of warning - usually enough for
  // them to be ready by the time the view actually needs them.
  var DF_PREWARM_FACTOR = 16;
  function prewarmPasses() {
    if (precisionMode !== "auto") return;
    precisionReady(precisionForSpacing(worldPixelSpacing() / DF_PREWARM_FACTOR));
  }

  // Binds the single-draw grid program the current view calls for. Returns
  // the pass actually bound, or null if this scene has no usable program at
  // all. Above float32 the grid is normally drawn by the sliced renderer
  // instead and this is never asked for that precision; the exception is a
  // device that cannot carry state in float textures (see precisionReady).
  function useCurrentPass() {
    var variant = wantedVariant();
    var precision = effectivePrecision();
    var pass = null;
    if (precision !== "f32" && !hasFloatColorBuffer) pass = requestPass(precision, variant, false);
    if (!pass) pass = requestPass("f32", variant, true);
    // A derived program that won't build still leaves the field itself.
    if (!pass) pass = requestPass("f32", "standard", true);
    if (!pass) return null;
    if (pass !== activePass) {
      activePass = pass;
      updatePrecisionReadout();
    }
    gl.useProgram(pass.program);
    bindQuad(pass.posLoc);
    return pass;
  }

  // A view-only rendering preference, same footing as the resolution slider -
  // not part of the scene, never saved/serialized, just a uniform flipped and
  // redrawn, not something that needs the shader itself recompiled.
  var colorZoomEnabled = false;

  // ---- Display mode ----
  //
  // Standard paints the Output field itself. The other three paint a
  // derivative of that same field, computed per pixel by re-running the
  // simulation at a stencil of neighbouring starting points - so switching
  // mode changes nothing about the physics, the Output mapping, or the
  // view, only what is drawn from them. See buildFragmentShader's own
  // "Derived display modes" section for the shader side.
  //
  // `samples` is how many simulations one pixel costs in that mode,
  // including the center one every mode needs. It is what the refinement
  // ladder will feel: the adaptive pixel budget absorbs it automatically
  // (a 5x mode simply settles about five times slower), and it is also the
  // last line of every row in the Display Mode menu, since it is the one
  // thing choosing a mode costs.
  //
  // `value` doubles as the thumbnail's filename (assets/<value>.jpg), so a
  // mode cannot be listed without a picture of itself.
  //
  // A blurb only has to be SHORT enough: the row is a flex line with
  // align-items: center and a fixed-aspect thumbnail, so the thumbnail sets
  // the row's height and a shorter sentence just centers against it with
  // more air. Rows therefore stay the same height as each other whatever
  // the blurbs do, and they need not match each other in length. What they
  // must not do is run LONGER than the thumbnail is tall, which at the
  // card's default width means keeping under about five wrapped lines -
  // past that the text starts driving the row height instead.
  //
  // The ids are the GLSL MODE_* constants and must stay in step with them.
  var DISPLAY_MODES = [
    { id: 0, value: "standard", label: "Standard", samples: 1,
      blurb: "The Output value itself, straight through the rainbow ramp." },
    { id: 1, value: "gradient", label: "Gradient", samples: 5,
      blurb: "Steepness and direction of change, as brightness and hue." },
    { id: 2, value: "laplacian", label: "Laplacian", samples: 5,
      blurb: "Ridges and dips by sign as hue." },
    { id: 3, value: "contours", label: "Contours", samples: 5,
      blurb: "Concentric lines of equal magnitude." },
  ];
  function displayModeByValue(value) {
    for (var i = 0; i < DISPLAY_MODES.length; i++) {
      if (DISPLAY_MODES[i].value === value) return DISPLAY_MODES[i];
    }
    return DISPLAY_MODES[0];
  }
  var displayMode = DISPLAY_MODES[0];

  // Renders the current view into a temporary w×h offscreen texture and
  // reads its raw t values back (see setUpColorSpreadSampler for why t, not
  // color, and why this is safe to treat as read-only measurement). Used
  // both by the periodic Color Zoom suggestion check below (always a fixed
  // SAMPLE_SIZE×SAMPLE_SIZE - cheap enough to run after every view change)
  // and by the superlative-finding buttons further down (sized to roughly
  // match the current view's aspect ratio instead, for better precision on
  // that one-off, user-triggered scan). Creating and tearing down the
  // texture/FBO on every call (rather than keeping one around) is simplest
  // and is cheap at these sizes - this never runs on a hot per-frame path.
  // Temporarily takes over the viewport and framebuffer binding, so it
  // restores both before returning: render() doesn't set either itself
  // per-call, only resizeCanvas does, so leaving them changed would misdraw
  // the next real frame.
  // rawBounces: only meaningful when Output is Bounce Count. The sampled t is
  // then count/u_bounceMax, so passing 1 for that divisor makes the readback
  // the raw bounce count itself - which is exactly what findBounceMax needs
  // to work out what the divisor should be. Every other caller wants the
  // normalized t the grid is actually showing, so it leaves this off.
  function createSampleTarget(w, h) {
    var texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    var fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { texture: texture, fbo: fbo, width: w, height: h };
  }

  // Shades rows [rowStart, rowStart + rowCount) of a blockWidth x
  // blockHeight sampling grid into the FIRST rowCount rows of `target`, and
  // returns how many it drew. `target` only has to be as tall as one band.
  //
  // Split out of sampleValueGrid so Global Stats can cover a block far
  // larger than the screen across several idle slices - the same reason the
  // refinement ladder bands its own draws: one draw covering millions of
  // full simulations is exactly the kind of long single dispatch that janks
  // a frame, and on an unlucky machine trips the GPU watchdog.
  //
  // The band is selected with u_gridOrigin - the very same uniform the
  // ladder uses to place its sub-lattices - rather than by scissoring a
  // block-sized target, so a full-resolution block never has to EXIST as a
  // texture. At one sample per rendered pixel that texture would be several
  // million pixels of RGBA32F, which is a lot of video memory to hold only
  // to read straight back; only one band is ever allocated.
  //
  // Leaves the viewport, framebuffer, scissor and bound program exactly as
  // it found them, because unlike the ladder's own banding this can run
  // BETWEEN two of the ladder's frames.
  function drawSampleBand(target, blockWidth, blockHeight, rowStart, rowCount, rawBounces) {
    var slicedPrograms = hasFloatColorBuffer ? slicedProgramsForGrid() : null;
    var sampler = slicedPrograms ? null : currentSampler();
    if (!slicedPrograms && !sampler) return 0;
    rowCount = Math.min(rowCount, target.height, blockHeight - rowStart);
    if (rowCount <= 0) return 0;
    // Every gl.getParameter returns null once the context is lost, and this
    // is the one call site reached from a timer rather than from the render
    // loop - so without this a lost context surfaces as an uncaught
    // TypeError on prevViewport[0] rather than as the caller's own "nothing
    // sampled" path. Nothing here attempts to RECOVER a lost context (the
    // page has never had a handler for that); it just declines to be the
    // thing that throws.
    var prevViewport = gl.isContextLost() ? null : gl.getParameter(gl.VIEWPORT);
    if (!prevViewport) return 0;
    if (slicedPrograms) {
      drawSampleBandSliced(slicedPrograms, target, blockWidth, blockHeight, rowStart, rowCount, rawBounces);
      gl.viewport(prevViewport[0], prevViewport[1], prevViewport[2], prevViewport[3]);
      useCurrentPass(); // same contract as below: the ladder's own program/attribute state, restored
      return rowCount;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, target.width, target.height);
    // Only the rows actually wanted: the quad covers the whole target, and
    // on the last (short) band the rows past the end would otherwise run a
    // full simulation each for values nothing reads.
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, blockWidth, rowCount);
    gl.useProgram(sampler.program);
    gl.uniform1i(sampler.uniforms.sampleField, 1);
    // The FULL block, not the band - this is what the shader divides by to
    // get uv, so it has to describe the grid being sampled rather than the
    // slice of it being drawn (exactly as u_resolution is always the
    // full-res canvas for the ladder's own sub-lattice draws).
    gl.uniform2f(sampler.uniforms.resolution, blockWidth, blockHeight);
    gl.uniform1f(sampler.uniforms.gridStride, 1);
    gl.uniform2f(sampler.uniforms.gridOrigin, 0, rowStart);
    setCenterUniforms(sampler.uniforms);
    gl.uniform1f(sampler.uniforms.scale, view.scale);
    // What's on screen - the timeline's step - for every measurement of the
    // picture. The one exception is the bounce-count divisor (rawBounces,
    // see findBounceMax), which is taken over the whole Simulation Duration
    // so that colors stay put while the timeline plays toward it.
    gl.uniform1i(sampler.uniforms.maxSteps, rawBounces ? simulationSteps : renderedSteps());
    gl.uniform1i(sampler.uniforms.durationSteps, simulationSteps);
    gl.uniform1f(sampler.uniforms.bounceMax, rawBounces ? 1 : bounceMaxValue);
    bindQuad(sampler.posLoc);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(prevViewport[0], prevViewport[1], prevViewport[2], prevViewport[3]);
    useCurrentPass(); // render() assumes its own program/attribute state is already bound
    return rowCount;
  }

  // Reads the first rowCount rows of a drawn band into `into` (RGBA, four
  // floats per sample). The caller owns the buffer and reuses it across
  // bands, which is what keeps a full-resolution measurement from
  // allocating the whole block twice over.
  //
  // gl.readPixels is a hard CPU-waits-for-GPU sync. That is a cost, but it
  // is also the thing that makes banding here self-regulating: the wall
  // clock after this call has genuinely absorbed the band's GPU work, so an
  // idle deadline measured around it means something (a draw call on its
  // own returns long before the work behind it does).
  function readSampleBand(target, rowCount, into) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.readPixels(0, 0, target.width, rowCount, gl.RGBA, gl.FLOAT, into);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  function freeSampleTarget(target) {
    if (!target) return;
    gl.deleteFramebuffer(target.fbo);
    gl.deleteTexture(target.texture);
  }

  // One shot, for the small fixed-size scans (the Color Zoom suggestion,
  // the bounce-count divisor, the superlative buttons). Global Stats, whose
  // block can be orders of magnitude larger, drives drawSampleBand itself.
  function sampleValueGrid(w, h, rawBounces) {
    if (!canSampleField()) return null;
    var target = createSampleTarget(w, h);
    // A refused draw would leave the target untouched, and reading it back
    // would hand every caller a grid of zeros as though it were a
    // measurement - so it takes the same "no sampler here" path they all
    // already handle.
    if (drawSampleBand(target, w, h, 0, h, rawBounces) === 0) {
      freeSampleTarget(target);
      return null;
    }
    var values = new Float32Array(w * h * 4);
    readSampleBand(target, h, values);
    freeSampleTarget(target);
    return { width: w, height: h, values: values };
  }

  // ---- Superlatives: find the largest/smallest/rarest/sharpest-edge point
  // (or point pair) in the currently visible view, and lock it as an
  // Inspect point - see the panel's own buttons further down. ----
  //
  // All four work off one sampleValueGrid call at a resolution matching the
  // current view's aspect ratio (so the sampled rectangle in world-space
  // actually matches what's on screen, rather than being stretched/
  // squashed by a mismatched aspect ratio) - bigger than the Color Zoom
  // suggestion's SAMPLE_SIZE since this is a one-off, user-triggered scan
  // rather than something re-run after every pan/zoom tick.
  var SUPERLATIVE_SAMPLE_LONG_SIDE = 200;

  function tAt(grid, col, row) {
    return grid.values[(row * grid.width + col) * 4];
  }

  // A genuinely circular output (see isCircularOutput above) needs a
  // wraparound-aware distance - t=0.99 and t=0.02 are actually close
  // together there, not far apart - while a capped, non-wrapping one
  // (Scene lifespan; x/y under Sticky Edges or Infinite Space) uses a
  // plain difference, since its two ends are genuinely different values,
  // not the same wrapped point.
  function valueDistance(a, b) {
    var d = Math.abs(a - b);
    return isCircularOutput ? Math.min(d, 1 - d) : d;
  }

  // Only meaningful for a genuinely circular output - t=0 and t=1 are the
  // same physical point there (the Pac-Man wrap), so a value sitting right
  // at either end is an inherently ambiguous representation of it: which
  // side it reads as can flip on essentially no real difference in the
  // underlying position. Sharpest Pair and Rarest both skip any comparison
  // straddling that seam (one point near t=0, the other near t=1) rather
  // than trusting valueDistance's own wraparound math to always
  // de-prioritize it - the check is only ever "opposite sides," never
  // "close to either end" on its own, so it doesn't bias for or against
  // border-adjacent pixels in general, just rules out comparing a boundary
  // point against itself. 0.15 (not a much tighter 0.01) because the
  // sample grid is coarse - two ADJACENT samples straddling a real wrap
  // point can easily land well away from the literal t=0/1 edge (e.g.
  // t=0.05 and t=0.95) while still being the same wrap artifact, not two
  // genuinely different values that happen to be near opposite ends.
  var WRAP_BORDER_EPSILON = 0.15;
  function wrapBorderSide(t) {
    if (!isCircularOutput) return null;
    if (t < WRAP_BORDER_EPSILON) return "low";
    if (t > 1 - WRAP_BORDER_EPSILON) return "high";
    return null;
  }
  function pairCrossesWrapBorder(a, b) {
    var sideA = wrapBorderSide(a), sideB = wrapBorderSide(b);
    return sideA !== null && sideB !== null && sideA !== sideB;
  }

  // Mirrors buildFragmentShader's own uv/world formula exactly (gl_FragCoord
  // has a bottom-left origin with Y increasing upward, matching WebGL's own
  // readPixels row order - so no Y-flip is needed here, unlike
  // worldToCanvasAreaPixel's CSS-pixel conversion elsewhere, which does need
  // one for the DOM's top-left origin).
  function sampleCoordToWorld(grid, col, row) {
    var uvx = (col + 0.5 - 0.5 * grid.width) / grid.height;
    var uvy = (row + 0.5 - 0.5 * grid.height) / grid.height;
    return worldPointAtUV(uvx, uvy);
  }

  // A SEPARATE wrap seam from valueDistance/pairCrossesWrapBorder's - that
  // one is about the OUTPUT value wrapping; this one is about the INPUT:
  // whatever body property X/Y Input is linked to gets its STARTING
  // position settled back into the frame (see generateGridInitialStateGLSL)
  // before the simulation even runs. As world-X/Y sweeps continuously, that
  // settling is a sawtooth - two adjacent samples straddling one of its
  // reset points get initial conditions roughly a full frame-dimension
  // apart, even though they're neighboring pixels representing nearly the
  // same offset. For a chaotic scene that can produce a wildly different
  // outcome that has nothing to do with any real local structure - exactly
  // the false "sharpest pair"/"rarest" this was reported against, and it
  // affects every output property (Scene Lifespan included), not just
  // circular ones, since it changes which physical starting scenario is
  // even being simulated. Detected directly from the actual computed
  // initial state (same computeOffsetSceneNumeric the instant hover preview
  // already uses) rather than re-deriving X/Y Input's own sign convention
  // by hand.
  function initialStateAt(worldX, worldY) {
    try {
      return PhysicsGridCodegen.computeOffsetSceneNumeric(scene, worldX, worldY);
    } catch (err) {
      return null;
    }
  }

  // Computed once per superlative scan (not per comparison) since every
  // sample gets compared against multiple neighbors.
  function precomputeInitialStates(grid) {
    var states = new Array(grid.width * grid.height);
    for (var row = 0; row < grid.height; row++) {
      for (var col = 0; col < grid.width; col++) {
        var w = sampleCoordToWorld(grid, col, row);
        states[row * grid.width + col] = initialStateAt(w.x, w.y);
      }
    }
    return states;
  }

  function stateAt(states, grid, col, row) {
    return states[row * grid.width + col];
  }

  // A genuine difference between two ADJACENT samples' starting positions
  // is bounded by how much world-X/Y actually changes between them - tiny
  // at any reasonable zoom. A jump anywhere near a full frame dimension can
  // only be the initial-state settle-into-frame wrap resetting where a
  // body starts, never two genuinely different nearby scenarios.
  function inputStateCrossesSeam(a, b) {
    if (!a || !b) return false;
    for (var i = 0; i < a.bodies.length; i++) {
      var ba = a.bodies[i], bb = b.bodies[i];
      if (scene.frameWidth && Math.abs(ba.x - bb.x) > scene.frameWidth / 2) return true;
      if (scene.frameHeight && Math.abs(ba.y - bb.y) > scene.frameHeight / 2) return true;
    }
    return false;
  }

  function findExtremeT(grid, wantMax) {
    var best = wantMax ? -Infinity : Infinity;
    var bestCol = 0, bestRow = 0;
    for (var row = 0; row < grid.height; row++) {
      for (var col = 0; col < grid.width; col++) {
        var v = tAt(grid, col, row);
        if (wantMax ? v > best : v < best) {
          best = v;
          bestCol = col;
          bestRow = row;
        }
      }
    }
    return { col: bestCol, row: bestRow };
  }

  // "Rarest" = least like its own neighborhood: the average distance (see
  // valueDistance) to all 8 surrounding samples, maximized. A neighbor on
  // the opposite side of the wrap border (see pairCrossesWrapBorder) is
  // skipped entirely - not just down-weighted - same as Sharpest Pair:
  // comparing across that seam isn't a meaningful "this neighborhood is
  // different" signal, it's an artifact of where mod() happened to cut the
  // circle, so a pixel's rarity is judged only against the neighbors
  // actually on its own side.
  function findRarest(grid, states) {
    var bestScore = -Infinity, bestCol = 0, bestRow = 0;
    for (var row = 0; row < grid.height; row++) {
      for (var col = 0; col < grid.width; col++) {
        var v = tAt(grid, col, row);
        var sum = 0, count = 0;
        for (var dr = -1; dr <= 1; dr++) {
          for (var dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue;
            var nc = col + dc, nr = row + dr;
            if (nc < 0 || nc >= grid.width || nr < 0 || nr >= grid.height) continue;
            var nv = tAt(grid, nc, nr);
            if (pairCrossesWrapBorder(v, nv)) continue;
            if (inputStateCrossesSeam(stateAt(states, grid, col, row), stateAt(states, grid, nc, nr))) continue;
            sum += valueDistance(v, nv);
            count++;
          }
        }
        var score = count > 0 ? sum / count : 0;
        if (score > bestScore) { bestScore = score; bestCol = col; bestRow = row; }
      }
    }
    return { col: bestCol, row: bestRow };
  }

  // The single most different ADJACENT pair anywhere in the grid (as
  // opposed to "rarest," which averages over a whole neighborhood) - only
  // checking each pixel's right and down neighbor visits every edge in the
  // grid exactly once.
  function findSharpestEdge(grid, states) {
    var bestScore = -Infinity, bestA = null, bestB = null;
    for (var row = 0; row < grid.height; row++) {
      for (var col = 0; col < grid.width; col++) {
        var v = tAt(grid, col, row);
        if (col + 1 < grid.width) {
          var vRight = tAt(grid, col + 1, row);
          if (!pairCrossesWrapBorder(v, vRight) && !inputStateCrossesSeam(stateAt(states, grid, col, row), stateAt(states, grid, col + 1, row))) {
            var dRight = valueDistance(v, vRight);
            if (dRight > bestScore) { bestScore = dRight; bestA = { col: col, row: row }; bestB = { col: col + 1, row: row }; }
          }
        }
        if (row + 1 < grid.height) {
          var vDown = tAt(grid, col, row + 1);
          if (!pairCrossesWrapBorder(v, vDown) && !inputStateCrossesSeam(stateAt(states, grid, col, row), stateAt(states, grid, col, row + 1))) {
            var dDown = valueDistance(v, vDown);
            if (dDown > bestScore) { bestScore = dDown; bestA = { col: col, row: row }; bestB = { col: col, row: row + 1 }; }
          }
        }
      }
    }
    return [bestA, bestB];
  }

  function runSuperlative(kind) {
    var aspect = canvasArea.clientHeight > 0 ? canvasArea.clientWidth / canvasArea.clientHeight : 1;
    var w = aspect >= 1 ? SUPERLATIVE_SAMPLE_LONG_SIDE : Math.max(1, Math.round(SUPERLATIVE_SAMPLE_LONG_SIDE * aspect));
    var h = aspect >= 1 ? Math.max(1, Math.round(SUPERLATIVE_SAMPLE_LONG_SIDE / aspect)) : SUPERLATIVE_SAMPLE_LONG_SIDE;
    var grid = sampleValueGrid(w, h);
    if (!grid) return; // heuristic-only sampler unavailable (see setUpColorSpreadSampler) - nothing to do
    if (kind === "largest") {
      var largest = findExtremeT(grid, true);
      lockPointAt(sampleCoordToWorld(grid, largest.col, largest.row));
    } else if (kind === "smallest") {
      var smallest = findExtremeT(grid, false);
      lockPointAt(sampleCoordToWorld(grid, smallest.col, smallest.row));
    } else if (kind === "rarest") {
      var rarest = findRarest(grid, precomputeInitialStates(grid));
      lockPointAt(sampleCoordToWorld(grid, rarest.col, rarest.row));
    } else if (kind === "edge") {
      var pair = findSharpestEdge(grid, precomputeInitialStates(grid));
      lockPointAt(sampleCoordToWorld(grid, pair[0].col, pair[0].row));
      lockPointAt(sampleCoordToWorld(grid, pair[1].col, pair[1].row));
    }
  }

  // The smallest arc (as a fraction of the full circle) that contains every
  // sampled t. t=0 and t=1 are the same point on the color wheel (see
  // colorMap's own comment on why), so this can't just take max-min - the
  // values could straddle the wrap point (e.g. mostly 0.97-0.02) and still
  // occupy a tiny arc that a naive max-min would report as nearly the whole
  // range. The smallest arc is the full circle minus its single largest gap.
  function circularSpread(values) {
    if (values.length === 0) return 0;
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    var maxGap = 1 - sorted[sorted.length - 1] + sorted[0]; // the gap that wraps through t=1/t=0
    for (var i = 1; i < sorted.length; i++) {
      maxGap = Math.max(maxGap, sorted[i] - sorted[i - 1]);
    }
    return 1 - maxGap;
  }

  var COLOR_SPREAD_SUGGEST_THRESHOLD = 0.2; // 20% of the full output range
  var COLOR_SPREAD_CHECK_DELAY_MS = 500; // debounced off markDirty - only check once the view settles, not on every drag tick
  var colorSpreadCheckTimer = null;

  function checkColorSpreadAndMaybeSuggestColorZoom() {
    if (colorZoomEnabled) return; // nothing to suggest - it's already on
    // Only about the finished picture. Partway along the timeline a narrow
    // spread is often just early - step 0 of a Scene Lifespan scene is one
    // flat color by definition - and Color Zoom is no answer to that.
    if (timeline.playing || renderedSteps() < simulationSteps) return;
    var grid = sampleValueGrid(SAMPLE_SIZE, SAMPLE_SIZE);
    if (!grid) return;
    var values = [];
    for (var i = 0; i < grid.values.length; i += 4) values.push(grid.values[i]);
    // Once dismissed, showTip below would no-op anyway - but only after
    // already forcing the Display card open, which is the bug: a dismissed
    // tip should stop touching the UI at all, not just stop being visible.
    if (isTipDismissed("color-zoom")) return;
    if (circularSpread(values) <= COLOR_SPREAD_SUGGEST_THRESHOLD) {
      // Color Zoom now lives inside the Display card's Standard row (see
      // the DISPLAY_MODES loop below) - opening the card is what makes the
      // toggle an actual, non-zero-size anchor for showTip to point at.
      displayMenu.set(true);
      showTip("color-zoom", colorZoomCheckbox, "Try Color Zoom to highlight subtle color differences");
    }
  }

  // Everything worth offering the user once the view stops moving. There is
  // only one popover, so these run in priority order and the first one to
  // take it wins: the speed cap goes ahead of Color Zoom because a picture
  // whose color spread has collapsed into a fan of rays has a cause, and
  // "try Color Zoom" is not it.
  function checkSettledViewTips() {
    if (maybeShowVelocityCapTip()) return;
    checkColorSpreadAndMaybeSuggestColorZoom();
  }

  function scheduleColorSpreadCheck() {
    if (colorSpreadCheckTimer) clearTimeout(colorSpreadCheckTimer);
    colorSpreadCheckTimer = setTimeout(function () {
      colorSpreadCheckTimer = null;
      checkSettledViewTips();
    }, COLOR_SPREAD_CHECK_DELAY_MS);
  }

  // The largest bounce count in the current view, which is what every pixel's
  // own count is colored relative to. Measured from a small offscreen sample
  // rather than the real render, which is 8-bit color and can't be read back
  // as a number. Measured over the whole Simulation Duration whatever step
  // the timeline shows (see drawSampleBand's rawBounces), so a pixel's
  // color only ever moves when its own count does.
  // Never returns 0: an all-quiet view would otherwise divide by zero, and
  // "nothing bounced anywhere" and "everything bounced 0 times" want the same
  // flat color anyway.
  //
  // Called once per VIEW change (from beginProgressive), not once per draw.
  // It used to run on every render() and that was survivable when a render
  // was the whole image; under progressive refinement it would be
  // catastrophic in two separate ways. It ends in a gl.readPixels, which is
  // a hard CPU-waits-for-GPU sync - running it per level would put a
  // pipeline stall between every one of a dozen-odd draws per frame. And
  // it's a measurement of the CURRENT view sampled on a fixed 32x32 grid,
  // so re-running it mid-refinement can return a slightly different max,
  // which is the divisor every pixel's color is scaled by - the whole image
  // would shift hue partway through sharpening. Pinning it for the lifetime
  // of one refinement run is what makes the coarse levels honest previews
  // of the fine one rather than differently-colored pictures of it.
  var BOUNCE_MAX_SAMPLE_SIZE = 32;

  // ASYNCHRONOUS, unlike every other measurement here. This one runs on every
  // view change - every frame of a drag - and a gl.readPixels is a hard
  // CPU-waits-for-GPU sync: in float32 the 1024 samples behind it cost
  // nothing worth noticing, but at df prices that sync was a fixed stall
  // stapled to the front of every frame of every gesture.
  //
  // So the samples are drawn as before, read into a pixel-pack buffer (which
  // does not wait), and a fence says when that buffer can be mapped without
  // waiting either. Until then the picture keeps the divisor it had. When the
  // measurement lands and the divisor really has changed, the view is redrawn
  // with it - one restart, a frame or two after the view stopped moving,
  // instead of a stall on every frame while it moved. The pinning described
  // above still holds: the divisor only ever changes BETWEEN refinement runs.
  var bounceMaxProbe = { target: null, pbo: null, sync: null, key: null, measuredKey: null,
    values: new Float32Array(BOUNCE_MAX_SAMPLE_SIZE * BOUNCE_MAX_SAMPLE_SIZE * 4) };

  function bounceMaxViewKey() {
    return [viewCenterKey(), view.scale, canvas.width, canvas.height, simulationSteps, effectivePrecision()].join(" ");
  }

  function requestBounceMax() {
    var key = bounceMaxViewKey();
    // Already measured, or already being measured, for exactly this view.
    if (key === bounceMaxProbe.measuredKey || (bounceMaxProbe.sync && key === bounceMaxProbe.key)) return;
    if (!canSampleField()) return; // no float targets to measure into - keep what we had
    var n = BOUNCE_MAX_SAMPLE_SIZE;
    if (!bounceMaxProbe.target) bounceMaxProbe.target = createSampleTarget(n, n);
    if (drawSampleBand(bounceMaxProbe.target, n, n, 0, n, true) === 0) return;
    if (bounceMaxProbe.sync) { gl.deleteSync(bounceMaxProbe.sync); bounceMaxProbe.sync = null; }
    if (!bounceMaxProbe.pbo) {
      bounceMaxProbe.pbo = gl.createBuffer();
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, bounceMaxProbe.pbo);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, bounceMaxProbe.values.byteLength, gl.STREAM_READ);
    } else {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, bounceMaxProbe.pbo);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, bounceMaxProbe.target.fbo);
    gl.readPixels(0, 0, n, n, gl.RGBA, gl.FLOAT, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    bounceMaxProbe.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    bounceMaxProbe.key = key;
    gl.flush();
  }

  // Every frame, from the render loop.
  function pollBounceMax() {
    if (!bounceMaxProbe.sync) return;
    if (gl.getSyncParameter(bounceMaxProbe.sync, gl.SYNC_STATUS) !== gl.SIGNALED) return;
    gl.deleteSync(bounceMaxProbe.sync);
    bounceMaxProbe.sync = null;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, bounceMaxProbe.pbo);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, bounceMaxProbe.values);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    // A measurement of a view that has since moved on says nothing about the
    // one on screen; the move already queued its own.
    if (bounceMaxProbe.key !== bounceMaxViewKey()) return;
    bounceMaxProbe.measuredKey = bounceMaxProbe.key;
    var max = 0, values = bounceMaxProbe.values;
    for (var i = 0; i < values.length; i += 4) max = Math.max(max, values[i]);
    // Never 0: an all-quiet view would otherwise divide by zero, and "nothing
    // bounced anywhere" and "everything bounced 0 times" want the same flat
    // color anyway.
    max = Math.max(1, max);
    if (max !== bounceMaxValue) {
      bounceMaxValue = max;
      markDirty();
    }
  }

  // The blocking form, for the one caller that cannot draw a first frame
  // without it (see its call site). Same samples, same answer.
  function findBounceMax() {
    var grid = sampleValueGrid(BOUNCE_MAX_SAMPLE_SIZE, BOUNCE_MAX_SAMPLE_SIZE, true);
    if (!grid) return bounceMaxValue; // no float-texture support - keep whatever we had
    var max = 0;
    for (var i = 0; i < grid.values.length; i += 4) max = Math.max(max, grid.values[i]);
    return Math.max(1, max);
  }

  // Shades one sub-lattice of the full-res pixel grid into the currently
  // bound framebuffer: rendered pixel (i, j) carries the world coordinate
  // full-res pixel (i * stride + originX, j * stride + originY) would have
  // had. The caller owns the framebuffer, viewport and scissor; this only
  // sets the uniforms the physics pass itself reads and issues the draw.
  //
  // u_resolution is always the FULL-res canvas size, never the size of the
  // target being drawn into - see the shader's own comment on why.
  function drawSublattice(stride, originX, originY, steps) {
    var pass = useCurrentPass();
    if (!pass) return;
    gl.uniform1i(pass.uniforms.sampleField, 0);
    gl.uniform2f(pass.uniforms.resolution, canvas.width, canvas.height);
    gl.uniform1f(pass.uniforms.gridStride, stride);
    gl.uniform2f(pass.uniforms.gridOrigin, originX, originY);
    setCenterUniforms(pass.uniforms);
    gl.uniform1f(pass.uniforms.scale, view.scale);
    gl.uniform1i(pass.uniforms.colorZoom, colorZoomEnabled ? 1 : 0);
    gl.uniform1i(pass.uniforms.maxSteps, steps === undefined ? renderedSteps() : steps);
    gl.uniform1i(pass.uniforms.durationSteps, simulationSteps);
    gl.uniform1f(pass.uniforms.bounceMax, bounceMaxValue);
    gl.uniform1i(pass.uniforms.displayMode, displayMode.id);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  // ---- Inspect: locking reference points to play back alongside whatever
  // is currently hovered ----
  //
  // Three kinds of entry, all stored the same shape (a "group" holding one
  // or more point-entries) so add/remove/clear/draw never has to
  // special-case "how many points is this really":
  //   "point" - one point-entry: a plain click/tap (see endDrag), or one of
  //             the superlative buttons below.
  //   "line"  - inspectLineSampleCount point-entries evenly spaced along a
  //             dragged segment (Inspect (Line) armed - see
  //             lockLineOfPoints), each still drawn as its own full set of
  //             bodies, hue-cycled the same way a "point" is.
  //   "grid"  - a Grid Settings-sized (see computeGridLayout) set of
  //             point-entries evenly spaced over a dragged rectangle
  //             (Inspect (Grid) armed - see lockGridOfPoints). Drawn
  //             completely differently from the other two: not as bodies at
  //             all, but as a connected mesh of lines through each point's
  //             own Output position - see drawInspectedAtStep and
  //             updateInspectMarkers.
  // A point-entry itself is always { worldPoint, trajectory, effectiveMaxStep,
  // wrapOverride, lifespanValue, color: {fill, stroke} } - exactly what
  // computeTrajectoryEntry returns, plus a color - regardless of which kind
  // of group it ends up in.
  // The largest a single grid can ask for is Grid Size 8 with Two Part Line
  // on: computeGridLayout gives denseSize = 2*8-1 = 15, and a 15x15 grid
  // excludes only the (15-8)² = 49 points off every drawn axis, leaving 176
  // - so this needs real headroom above the old flat-array-era cap, not
  // just a bump, or the biggest grid the settings allow would silently
  // refuse to ever complete.
  var MAX_INSPECT_POINTS = 300;
  // Grid Settings (the Settings card in the menu column) - how many lines
  // Inspect (Grid) draws per axis, and whether each one gets a midpoint to
  // kink at. Read fresh by lockGridOfPoints on every drag (see
  // computeGridLayout); their own change listeners live down by the rest of
  // the Settings wiring, next to stepsSlider/colorZoomCheckbox.
  var inspectGridSize = Number(document.getElementById("inspect-grid-size-slider").value) || 3;
  var inspectGridTwoPart = document.getElementById("inspect-grid-two-part-checkbox").checked;
  var inspectedGroups = []; // each: { type, points: [...], startWorld, endWorld (line/grid), cols, rows, segments, meshLineEls, outputBodyIndex (grid only) }
  function totalInspectedPointCount() {
    var total = 0;
    for (var i = 0; i < inspectedGroups.length; i++) total += inspectedGroups[i].points.length;
    return total;
  }

  // Which drag gesture the next one commits to - set by clicking Inspect
  // (Line) or Inspect (Grid), cleared once that drag actually produces a
  // group (see lockLineOfPoints/lockGridOfPoints) or Clear All is pressed.
  // A plain click/tap needs neither: with neither armed it always locks a
  // single point (see endDrag), and WITH one armed it's not a drag at all -
  // just a reminder (see showInspectToast) to drag instead, since only a
  // real drag can mean something other than panning.
  //
  // "point" is the touch-only third (see #btn-inspect-point in chaos.html):
  // a finger's tap locks a point only once it has been armed, because a
  // finger has no hover to preview with and its taps share the map with
  // one-finger pans and pinches. Unlike the other two it never takes the
  // drag away from panning - a tap and a drag are already different
  // gestures, so an armed Point leaves the map as movable as it was.
  var inspectArmMode = null; // null | "point" | "line" | "grid"
  function inspectArmTakesDrag() {
    return inspectArmMode === "line" || inspectArmMode === "grid";
  }
  function disarmInspect() {
    inspectArmMode = null;
    btnInspectPoint.classList.remove("inspect-armed");
    btnInspectLine.classList.remove("inspect-armed");
    btnInspectGrid.classList.remove("inspect-armed");
  }

  // colorIndex is assigned once, at lock time, and never reassigned - so
  // removing one locked point doesn't shift the colors of the others (per
  // the user's ask: "the others DON'T get new colors, they just continue the
  // pattern"). It only resets to 0 once every group is gone, so a fresh
  // inspection always starts back at red. Only "point" groups consume this -
  // a dragged line (see lockLineOfPoints) uses its own fixed hue split
  // instead, and a dragged grid (see lockGridOfPoints) its own x/y-position
  // scheme, independent of this sequence.
  var nextColorIndex = 0;
  // Golden-angle hue step: successive points land far apart around the hue
  // wheel (0, 137.5, 275, 52.5, ...) instead of drifting slowly through
  // neighboring hues, so even adjacent-index points stay visually distinct.
  var INSPECT_HUE_STEP = 137.5;
  function lockedPointColor(colorIndex) {
    var hue = (colorIndex * INSPECT_HUE_STEP) % 360;
    return { fill: "hsl(" + hue + ", 100%, 50%)", stroke: "#000000" };
  }

  // Dragging while Inspect (Line) is armed locks this many points at once,
  // evenly spaced along the dragged segment - one at each end, the rest
  // spaced in between - colored as an even split across
  // [0, INSPECT_LINE_MAX_HUE] rather than continuing the golden-angle
  // sequence above, so a dragged line reads as its own connected group.
  // Settings-controlled (Inspection Line Sample Count, 5-60) - see its own
  // wiring down by the rest of the Settings controls. The preview/locked-dot
  // pool below is still built once at INSPECT_LINE_SAMPLE_MAX, the slider's
  // own ceiling, so changing this never has to grow or shrink that pool -
  // only how many of it are shown.
  var INSPECT_LINE_SAMPLE_MAX = 60;
  var inspectLineSampleCount = Number(document.getElementById("inspect-line-sample-count-slider").value) || 30;
  // Stops short of 360 (== 0 on the hue wheel) so the last point never ends
  // up looking near-identical to the first - the interval is [0, 324], not
  // [0, 360), regardless of inspectLineSampleCount.
  var INSPECT_LINE_MAX_HUE = 324;
  // `count` is the line's own sample count - the panel's current setting
  // for one being dragged out now, but a line restored from a link brings
  // the count it was made with (see restoreInspectGroups).
  function inspectLinePointColor(i, count) {
    count = count || inspectLineSampleCount;
    var hue = count > 1 ? i * (INSPECT_LINE_MAX_HUE / (count - 1)) : 0;
    return { fill: "hsl(" + hue + ", 100%, 50%)", stroke: "#000000" };
  }
  function evenlySpacedPoints(start, end, count) {
    var points = [];
    for (var i = 0; i < count; i++) {
      var t = count > 1 ? i / (count - 1) : 0;
      points.push(lerpWorldPoint(start, end, t, start, end, t));
    }
    return points;
  }

  // Dragging while Inspect (Grid) is armed locks a cols×rows grid of points
  // evenly spaced over the axis-aligned box the drag spans (corner1/corner2
  // in either order - sorted into min/max here), row-major so a later
  // filter/lookup (see below) can still find points by (row,col). Each
  // point keeps its own col/row for inspectGridPointColor.
  function evenlySpacedGrid(corner1, corner2, cols, rows) {
    // Which corner is the low one per axis - decided on the double-double
    // difference, since at a deep zoom the two corners' .x can be the very
    // same float64.
    var xFirst = worldPointDelta(corner1, corner2, "x") >= 0;
    var yFirst = worldPointDelta(corner1, corner2, "y") >= 0;
    var minXc = xFirst ? corner1 : corner2, maxXc = xFirst ? corner2 : corner1;
    var minYc = yFirst ? corner1 : corner2, maxYc = yFirst ? corner2 : corner1;
    var points = [];
    for (var row = 0; row < rows; row++) {
      var ty = rows > 1 ? row / (rows - 1) : 0;
      for (var col = 0; col < cols; col++) {
        var tx = cols > 1 ? col / (cols - 1) : 0;
        var point = lerpWorldPoint(minXc, maxXc, tx, minYc, maxYc, ty);
        point.col = col; point.row = row;
        points.push(point);
      }
    }
    return points;
  }
  // Turns the Grid Settings (grid size N, two-part line on/off - see their
  // own DOM lookups and change listeners below) into the actual dense
  // dot-grid a drag builds. N is "how many lines the user sees per axis";
  // it needs at least 2 to read as a grid at all (a single line can't form
  // one), so anything below that is silently clamped up to 2 - the size-1
  // and size-2 settings end up drawing the same thing, a plain bounding
  // rectangle, and that's intentional, not a bug.
  //
  // Without a two-part line, an N-line axis needs exactly N dots - one per
  // line, evenly spread including both edges (N=2 is just the two edges,
  // e.g. a plain box) - so `size` is simply nEff and every axis position is
  // "on" a line already; there's nothing left over to exclude.
  //
  // With a two-part line, every one of the (nEff-1) gaps between adjacent
  // lines gets one extra dot in the middle, so each line can bend there
  // instead of running arrow-straight - nEff lines plus (nEff-1) midpoints
  // is `2*nEff - 1` dots per axis. Those extra midpoints ARE genuine grid
  // rows/columns of their own now (not just points sitting on a line), so
  // lockGridOfPoints' own off-axis filter (any point whose row AND column
  // both land between two chosen lines) still applies exactly as before to
  // drop the interior dots no line ever reaches.
  function computeGridLayout(n, twoPart) {
    var nEff = Math.max(n, 2);
    var size = twoPart ? (2 * nEff - 1) : nEff;
    var axes = [];
    for (var i = 0; i < nEff; i++) {
      axes.push(Math.round(i * (size - 1) / (nEff - 1)));
    }
    return { size: size, axes: axes };
  }
  function isAxisIn(list, i) { return list.indexOf(i) !== -1; }
  // color(x,y) = RGB(x,y,0.5) in each point's own (col,row), normalized to
  // [0,1] against THIS grid's own denseSize (fixed at creation time - see
  // lockGridOfPoints - so a later Grid Settings change can't repaint a
  // grid that already exists) - fixed and position-only (not hue-cycled
  // like point/line colors), so a grid's coloring stays legible entirely on
  // its own: one corner reads blue, the opposite red-ish, the other two
  // green and yellow, fading between - independent of anything the
  // underlying scene does. Which grid axis is x vs. y doesn't matter, so
  // col is simply x (R) and row is y (G) here. Keeps the raw 0-255
  // components alongside the ready CSS string so averageRgbFill below has
  // numbers to average rather than needing to re-parse its own output.
  function inspectGridPointColor(col, row, denseSize) {
    var x = denseSize > 1 ? col / (denseSize - 1) : 0;
    var y = denseSize > 1 ? row / (denseSize - 1) : 0;
    var r = Math.round(x * 255), g = Math.round(y * 255), b = Math.round(0.5 * 255);
    return { r: r, g: g, b: b, fill: "rgb(" + r + "," + g + "," + b + ")", stroke: "#000000" };
  }
  function averageRgbFill(colorA, colorB) {
    return "rgb(" + Math.round((colorA.r + colorB.r) / 2) + "," + Math.round((colorA.g + colorB.g) / 2) + "," + Math.round((colorA.b + colorB.b) / 2) + ")";
  }
  // Connects each drawn row and drawn column (lineAxes, from
  // computeGridLayout - fixed per grid at creation time, same reasoning as
  // inspectGridPointColor's own denseSize) into its own point-per-axis-slot
  // chain - a sparse "hash mark" rather than the dense "every adjacent
  // pair" adjacency a full grid mesh would use, since only lineAxes' own
  // rows/columns are ever drawn (see lockGridOfPoints' own filter, which
  // already dropped every other point before this runs). Each line still
  // gets every dot along its own length rather than being reduced to just
  // its two endpoints, so a two-part line can visibly kink at its interior
  // dot(s) instead of drawing as one straight corner-to-corner guess.
  // `points` must be that already-filtered list, in the row-major order the
  // filter preserves, so a plain (row,col) lookup is enough to find each
  // chain's members by index.
  function buildGridMeshSegments(points, lineAxes, denseSize) {
    var indexAt = {};
    points.forEach(function (p, i) { indexAt[p.row + "," + p.col] = i; });
    var segments = [];
    function addChain(cells) {
      for (var i = 0; i + 1 < cells.length; i++) {
        segments.push([indexAt[cells[i]], indexAt[cells[i + 1]]]);
      }
    }
    lineAxes.forEach(function (row) {
      var cells = [];
      for (var col = 0; col < denseSize; col++) cells.push(row + "," + col);
      addChain(cells);
    });
    lineAxes.forEach(function (col) {
      var cells = [];
      for (var row = 0; row < denseSize; row++) cells.push(row + "," + col);
      addChain(cells);
    });
    return segments;
  }

  // Which body's x/y a grid point plots as its own position - every Output
  // property but Scene Lifespan already names one (scene.output.body);
  // Lifespan has none (see physics-ui.js: `{ body: null, ... }`), so this
  // falls back to the lowest-indexed non-anchored body instead, per the
  // user's own rule for that case. Depends only on the authored scene (not
  // on which pixel), so it's resolved once per grid group, not per point.
  function inspectGridOutputBodyIndex() {
    if (scene.output.property !== "lifespan") return scene.output.body;
    for (var i = 0; i < scene.bodies.length; i++) {
      if (!scene.bodies[i].isAnchored) return i;
    }
    return scene.bodies.length > 0 ? 0 : null;
  }

  // Inverse of pixelToUV + the shader's own world<-uv mapping: given a world
  // point, where does it land in CSS pixels relative to #canvas-area's own
  // box (which is what an .inspect-marker's left/top, and every
  // #inspect-preview coordinate, are positioned against). gl_FragCoord has
  // a bottom-left origin (Y increases upward); CSS/DOM coordinates have a
  // top-left origin, hence the height-flip on fy below.
  // worldXLo/worldYLo are the low halves of a double-double point (see
  // worldPointAtUV) - optional, zero for a plain float64 one.
  function worldToCanvasAreaPixel(worldX, worldY, worldXLo, worldYLo) {
    var uv = worldPointToUV({ x: worldX, y: worldY, xLo: worldXLo, yLo: worldYLo });
    var fx = uv[0] * canvas.height + 0.5 * canvas.width;
    var fy = 0.5 * canvas.height - uv[1] * canvas.height;
    var canvasRect = canvas.getBoundingClientRect();
    var areaRect = canvasArea.getBoundingClientRect();
    var cssX = fx * (canvasRect.width / canvas.width) + (canvasRect.left - areaRect.left);
    var cssY = fy * (canvasRect.height / canvas.height) + (canvasRect.top - areaRect.top);
    return { x: cssX, y: cssY };
  }

  // One .inspect-marker div per "point"/"line" point, pooled and reused
  // across updates rather than torn down and rebuilt. "grid" groups draw no
  // dots at all here - their permanent mesh lines (group.meshLineEls,
  // created once in lockGridOfPoints) just get repositioned below, same
  // "recompute screen position on every pan/zoom" need as the dots, for a
  // fixed set of line endpoints instead of a fixed set of points.
  //
  // Clicking a marker removes its WHOLE group - the same thing the list's
  // own × button does (see updateInspectList/removeInspectedGroup) - rather
  // than trying to pull just that one point out of a locked line, which
  // nothing else in this file (colors, hue spacing, segment indices) is
  // built to do. inspectMarkerGroupIndex is the parallel array a marker's
  // click handler reads its own group index back out of; it has to be a
  // variable the closure below can see fresh on every click (not a value
  // baked in when the element was created), since which group a given pool
  // slot belongs to changes as points are added and removed.
  var inspectMarkerEls = [];
  var inspectMarkerGroupIndex = [];
  function updateInspectMarkers() {
    // Collapsing Inspect stops the work (see its own makeMenu comment) but
    // never touches inspectedGroups - so a still-open card's worth of
    // points is sitting right there, just not drawn, ready to reappear
    // exactly as it was the moment the card reopens.
    var visible = inspectMenu.isOpen();
    var flatPoints = [];
    inspectMarkerGroupIndex = [];
    inspectedGroups.forEach(function (group, groupIndex) {
      if (group.type === "grid") return;
      group.points.forEach(function (point) {
        flatPoints.push(point);
        inspectMarkerGroupIndex.push(groupIndex);
      });
    });
    while (inspectMarkerEls.length < flatPoints.length) {
      var el = document.createElement("div");
      el.className = "inspect-marker";
      el.title = "Click to remove";
      el.addEventListener("click", function () {
        var slot = inspectMarkerEls.indexOf(el);
        if (slot === -1) return;
        removeInspectedGroup(inspectMarkerGroupIndex[slot]);
      });
      // The dot sits on top of the canvas, so the canvas's own wheel
      // listener never sees a scroll made while hovering it - zoom from
      // here too, or a marker under the cursor blocks zooming entirely.
      el.addEventListener("wheel", onWheelZoom, { passive: false });
      canvasArea.appendChild(el);
      inspectMarkerEls.push(el);
    }
    while (inspectMarkerEls.length > flatPoints.length) {
      inspectMarkerEls.pop().remove();
    }
    flatPoints.forEach(function (entry, i) {
      var p = worldToCanvasAreaPixel(entry.worldPoint.x, entry.worldPoint.y, entry.worldPoint.xLo, entry.worldPoint.yLo);
      var el = inspectMarkerEls[i];
      el.style.left = p.x + "px";
      el.style.top = p.y + "px";
      // A custom property, not el.style.background directly - background
      // itself is set in CSS from var(--marker-color), which is what lets
      // .inspect-marker:hover's own plain background rule (see
      // fractal-grid.css) win on hover without an !important fight against
      // an inline style set here on every update.
      el.style.setProperty("--marker-color", entry.color.fill);
      el.hidden = !visible;
    });

    inspectedGroups.forEach(function (group) {
      if (group.type !== "grid") return;
      group.segments.forEach(function (pair, i) {
        var a = worldToCanvasAreaPixel(group.points[pair[0]].worldPoint.x, group.points[pair[0]].worldPoint.y, group.points[pair[0]].worldPoint.xLo, group.points[pair[0]].worldPoint.yLo);
        var b = worldToCanvasAreaPixel(group.points[pair[1]].worldPoint.x, group.points[pair[1]].worldPoint.y, group.points[pair[1]].worldPoint.xLo, group.points[pair[1]].worldPoint.yLo);
        var lineEl = group.meshLineEls[i];
        lineEl.setAttribute("x1", a.x); lineEl.setAttribute("y1", a.y);
        lineEl.setAttribute("x2", b.x); lineEl.setAttribute("y2", b.y);
        if (visible) lineEl.removeAttribute("hidden");
        else lineEl.setAttribute("hidden", "");
      });
    });
  }

  // The dashed connecting line plus up to INSPECT_LINE_SAMPLE_MAX dots shown
  // while dragging Inspect (Line) - built once here, at the slider's own
  // ceiling, and just repositioned on every update rather than recreated,
  // same pooling idea as inspectMarkerEls. Only the first
  // inspectLineSampleCount of the pool are ever shown at once (see
  // updateInspectLinePreview) - that is what lets the Settings slider change
  // the count without growing or shrinking this pool. Colored with
  // inspectLinePointColor so the preview matches exactly what
  // lockLineOfPoints will actually place. Hidden/shown on its own (not via
  // #inspect-preview's own hidden attribute, which - now that the same SVG
  // also permanently hosts completed grids' mesh lines - must stay unhidden
  // regardless of whether a preview is active).
  var SVG_NS = "http://www.w3.org/2000/svg";
  var inspectLinePreviewLine = document.createElementNS(SVG_NS, "line");
  inspectLinePreviewLine.setAttribute("stroke", "rgba(255,255,255,0.7)");
  inspectLinePreviewLine.setAttribute("stroke-width", "2");
  inspectLinePreviewLine.setAttribute("stroke-dasharray", "6,4");
  inspectLinePreviewLine.setAttribute("hidden", "");
  inspectPreviewSvg.appendChild(inspectLinePreviewLine);
  var inspectLinePreviewDots = [];
  for (var cli = 0; cli < INSPECT_LINE_SAMPLE_MAX; cli++) {
    var dot = document.createElementNS(SVG_NS, "circle");
    dot.setAttribute("r", "6");
    dot.setAttribute("stroke", "#000000");
    dot.setAttribute("stroke-width", "2");
    dot.setAttribute("hidden", "");
    inspectPreviewSvg.appendChild(dot);
    inspectLinePreviewDots.push(dot);
  }

  function updateInspectLinePreview(startWorld, endWorld) {
    var startPx = worldToCanvasAreaPixel(startWorld.x, startWorld.y, startWorld.xLo, startWorld.yLo);
    var endPx = worldToCanvasAreaPixel(endWorld.x, endWorld.y, endWorld.xLo, endWorld.yLo);
    inspectLinePreviewLine.setAttribute("x1", startPx.x);
    inspectLinePreviewLine.setAttribute("y1", startPx.y);
    inspectLinePreviewLine.setAttribute("x2", endPx.x);
    inspectLinePreviewLine.setAttribute("y2", endPx.y);
    var points = evenlySpacedPoints(startWorld, endWorld, inspectLineSampleCount);
    points.forEach(function (worldPoint, i) {
      var px = worldToCanvasAreaPixel(worldPoint.x, worldPoint.y, worldPoint.xLo, worldPoint.yLo);
      inspectLinePreviewDots[i].setAttribute("cx", px.x);
      inspectLinePreviewDots[i].setAttribute("cy", px.y);
      inspectLinePreviewDots[i].setAttribute("fill", inspectLinePointColor(i).fill);
    });
    // Not `.hidden = false` - the hidden IDL property is reliably defined on
    // HTMLElement but not consistently on SVGElement, so setting it can
    // silently no-op instead of touching the actual attribute. The
    // attribute methods work identically regardless of element/namespace.
    inspectLinePreviewLine.removeAttribute("hidden");
    for (var i = 0; i < inspectLinePreviewDots.length; i++) {
      if (i < points.length) inspectLinePreviewDots[i].removeAttribute("hidden");
      else inspectLinePreviewDots[i].setAttribute("hidden", "");
    }
  }
  function hideInspectLinePreview() {
    inspectLinePreviewLine.setAttribute("hidden", "");
    inspectLinePreviewDots.forEach(function (d) { d.setAttribute("hidden", ""); });
  }

  // The dashed rectangle outline shown while dragging Inspect (Grid) -
  // corners are simply wherever the drag currently starts/is, the same
  // min/max sorting evenlySpacedGrid itself does, so the preview always
  // matches the grid that would actually be locked if released right now.
  var inspectGridPreviewRect = document.createElementNS(SVG_NS, "rect");
  inspectGridPreviewRect.setAttribute("fill", "none");
  inspectGridPreviewRect.setAttribute("stroke", "rgba(255,255,255,0.7)");
  inspectGridPreviewRect.setAttribute("stroke-width", "2");
  inspectGridPreviewRect.setAttribute("stroke-dasharray", "6,4");
  inspectGridPreviewRect.setAttribute("hidden", "");
  inspectPreviewSvg.appendChild(inspectGridPreviewRect);

  function updateInspectGridPreview(startWorld, endWorld) {
    var startPx = worldToCanvasAreaPixel(startWorld.x, startWorld.y, startWorld.xLo, startWorld.yLo);
    var endPx = worldToCanvasAreaPixel(endWorld.x, endWorld.y, endWorld.xLo, endWorld.yLo);
    inspectGridPreviewRect.setAttribute("x", Math.min(startPx.x, endPx.x));
    inspectGridPreviewRect.setAttribute("y", Math.min(startPx.y, endPx.y));
    inspectGridPreviewRect.setAttribute("width", Math.abs(endPx.x - startPx.x));
    inspectGridPreviewRect.setAttribute("height", Math.abs(endPx.y - startPx.y));
    inspectGridPreviewRect.removeAttribute("hidden");
  }
  function hideInspectGridPreview() {
    inspectGridPreviewRect.setAttribute("hidden", "");
  }
  function hideInspectPreview() {
    hideInspectLinePreview();
    hideInspectGridPreview();
  }

  // "Drag to inspect a line/grid" - shown when Inspect (Line)/(Grid) is
  // armed and the grid gets a plain click instead of the drag it's waiting
  // for (see endDrag). Restarting the timer on every call (rather than
  // leaving an earlier one to fire) means a second click while it's still
  // showing just holds it up instead of letting it flicker hidden-then-
  // shown again a moment later.
  //
  // Never [hidden] (display:none) - same reasoning as .settings-panel's own
  // "Always in the DOM" comment: a display change and an opacity transition
  // can't reliably combine in the same frame (removing display:none leaves
  // nothing for the transition to animate FROM), so the resting state is
  // just opacity:0 with pointer-events:none instead, and only the class
  // toggles.
  var INSPECT_TOAST_VISIBLE_MS = 2200;
  var inspectToastHideTimer = null;
  function showInspectToast(message) {
    if (inspectToastHideTimer) clearTimeout(inspectToastHideTimer);
    inspectToastEl.textContent = message;
    inspectToastEl.classList.add("visible");
    inspectToastHideTimer = setTimeout(function () {
      inspectToastHideTimer = null;
      inspectToastEl.classList.remove("visible");
    }, INSPECT_TOAST_VISIBLE_MS);
  }

  // "line"/"grid" rows lead with this instead of the small .inspect-dot a
  // "point" row uses - large enough to stand as its own column beside the
  // two-line start/end coordinates, and shaped like what it represents (a
  // dashed line for "line", a grid square for "grid") so that shape is
  // what says "this is a line/grid entry" now, freeing the two coordinate
  // rows beside it to just be the raw numbers instead of needing their own
  // "Line start:"/"Line end:" labels to say the same thing in words.
  var INSPECT_ROW_GROUP_GLYPH = { line: "┊", grid: "⊞" };

  function updateInspectList() {
    inspectListEl.innerHTML = "";
    inspectedGroups.forEach(function (group, i) {
      var li = document.createElement("li");
      li.className = "inspect-row";
      var removeBtn = document.createElement("button");
      removeBtn.className = "inspect-row-remove";
      removeBtn.textContent = "×";
      removeBtn.addEventListener("click", function () { removeInspectedGroup(i); });

      if (group.type === "point") {
        var swatch = document.createElement("span");
        swatch.className = "inspect-dot";
        swatch.style.background = group.points[0].color.fill;
        removeBtn.title = "Remove this point";
        var coords = document.createElement("span");
        coords.className = "inspect-coords";
        coords.textContent = group.points[0].worldPoint.x.toFixed(6) + ", " + group.points[0].worldPoint.y.toFixed(6);
        li.appendChild(swatch);
        li.appendChild(coords);
        li.appendChild(removeBtn);
      } else {
        var icon = document.createElement("span");
        icon.className = "inspect-row-icon";
        icon.textContent = INSPECT_ROW_GROUP_GLYPH[group.type];
        icon.setAttribute("aria-hidden", "true");
        removeBtn.title = "Remove this " + group.type;
        var coordsGroup = document.createElement("div");
        coordsGroup.className = "inspect-coords-group";
        var startLine = document.createElement("div");
        startLine.textContent = group.startWorld.x.toFixed(6) + ", " + group.startWorld.y.toFixed(6);
        var endLine = document.createElement("div");
        endLine.textContent = group.endWorld.x.toFixed(6) + ", " + group.endWorld.y.toFixed(6);
        coordsGroup.appendChild(startLine);
        coordsGroup.appendChild(endLine);
        li.appendChild(icon);
        li.appendChild(coordsGroup);
        li.appendChild(removeBtn);
      }
      inspectListEl.appendChild(li);
    });
  }

  // Restarts whatever the hover preview panel is currently showing, from
  // scratch. Used whenever the inspected set changes (add/remove/clear -
  // see updateInspectUI): a point added from a slow batch (a big dragged
  // line or grid can take a real, visible moment to GPU-compile all of
  // them) must never join a replay that's already mid-progress by the time
  // it's ready - restarting is what guarantees everyone starts at step 0
  // together, "fully loaded" by construction rather than by timing it.
  function restartCurrentPreview() {
    // inspectedGroups wins over a live hover, not the other way round - once
    // at least one point/line/grid is locked, the panel is showing THEM
    // (see the mousemove handler's own comment on why hovering elsewhere no
    // longer swaps in a preview of its own trajectory alongside them), so
    // there is nothing left for a hover to interrupt here either.
    if (inspectedGroups.length > 0) {
      beginInspectOnlySession();
    } else if (isHoveringGrid && hoverWorldPoint) {
      runHoverAt(hoverWorldPoint);
    } else {
      showHoverEmpty();
    }
  }

  function updateInspectUI() {
    updateInspectMarkers();
    updateInspectList();
    var full = totalInspectedPointCount() >= MAX_INSPECT_POINTS;
    btnInspectPoint.disabled = full;
    btnInspectLine.disabled = full;
    btnInspectGrid.disabled = full;
    btnInspectClearAll.hidden = inspectedGroups.length === 0;
    restartCurrentPreview();
  }

  // Computes and caches everything drawing a locked point later needs - the
  // same GPU replay + wrap-stop work runHoverAt does for the hovered point,
  // just run once up front and kept around instead of recomputed every
  // frame. Shared by lockPointAt, lockLineOfPoints and lockGridOfPoints;
  // returns null on failure (e.g. a point outside where the compiled scene
  // is valid), leaving it up to the caller to decide whether that should
  // abort the rest of a batch.
  function computeTrajectoryEntry(worldPoint) {
    var compiled, trajectory;
    var steps = hoverStepCount();
    try {
      // Compiled at whatever precision the grid itself is currently
      // showing, so the replay is of the pixel actually under the cursor
      // rather than of a float32 approximation to it.
      compiled = PhysicsGridCodegen.compileHoverTrajectoryGLSL(scene, worldPoint.x, worldPoint.y, steps, effectivePrecision(), worldPoint.xLo, worldPoint.yLo);
      trajectory = PhysicsGPU.runCompiledTrajectoryOnGPU(compiled, steps);
    } catch (err) {
      return null;
    }
    var isLifespan = scene.output.property === "lifespan";
    var effectiveMaxStep = trajectory.length, wrapOverride = null, lifespanValue = simulationSteps;
    if (scene.edgeMode === "sticky") {
      var initialAtPoint = PhysicsGridCodegen.computeOffsetSceneNumeric(scene, worldPoint.x, worldPoint.y);
      var watchedIndices = PhysicsHingeGeometry.wrapWatchedBodyIndices(scene);
      // Same reasoning as runHoverAt's: neither Scene Lifespan nor Bounce
      // Count has an output body whose final position needs reconstructing.
      var targetBodyIndex = (isLifespan || isBouncesOutput) ? null : scene.output.body;
      var wrapStop = PhysicsHingeGeometry.findWrapStopStep(trajectory, watchedIndices, targetBodyIndex, scene.frameWidth, scene.frameHeight, initialAtPoint.bodies, PhysicsGPU.FIXED_DT);
      if (wrapStop !== null) {
        effectiveMaxStep = Math.max(1, Math.min(trajectory.length, wrapStop.step));
        wrapOverride = wrapStop;
        lifespanValue = wrapStop.step + wrapStop.tFrac / PhysicsGPU.FIXED_DT;
      }
    }
    return {
      worldPoint: worldPoint,
      trajectory: trajectory,
      effectiveMaxStep: effectiveMaxStep,
      wrapOverride: wrapOverride,
      lifespanValue: isLifespan ? lifespanValue : null,
      bounceEvents: bounceEventsAt(worldPoint, steps),
    };
  }

  function lockPointAt(worldPoint) {
    if (totalInspectedPointCount() >= MAX_INSPECT_POINTS) return;
    var entry = computeTrajectoryEntry(worldPoint);
    if (!entry) return; // leave whatever was inspected before (if anything) alone
    entry.color = lockedPointColor(nextColorIndex);
    nextColorIndex++;
    inspectedGroups.push({ type: "point", points: [entry] });
    // A superlative button can fire while Line/Grid is armed and waiting
    // for a drag - this is a different, complete action instead, so cancel
    // that wait rather than leave the button looking armed for a drag that
    // (per endDrag) a plain click like this one no longer starts anyway.
    disarmInspect();
    updateInspectUI();
  }

  // Dragging while Inspect (Line) is armed calls this instead of
  // lockPointAt - see evenlySpacedPoints/inspectLinePointColor above. If
  // fewer than inspectLineSampleCount slots remain before
  // MAX_INSPECT_POINTS, only the first `available` (start-ward) get added
  // rather than re-spacing/re-coloring a smaller set - simpler, and the cap
  // is high enough (300) that this only bites right at the edge.
  function lockLineOfPoints(startWorld, endWorld, sampleCount) {
    sampleCount = sampleCount || inspectLineSampleCount;
    var available = MAX_INSPECT_POINTS - totalInspectedPointCount();
    if (available <= 0) return; // stays armed - Clear All (or removing a point) might free up room to retry
    var worldPoints = evenlySpacedPoints(startWorld, endWorld, sampleCount);
    var count = Math.min(worldPoints.length, available);
    var points = [];
    for (var i = 0; i < count; i++) {
      var entry = computeTrajectoryEntry(worldPoints[i]);
      if (!entry) continue; // don't let one bad point abort the rest of the line
      entry.color = inspectLinePointColor(i, sampleCount);
      points.push(entry);
    }
    disarmInspect();
    if (points.length > 0) inspectedGroups.push({ type: "line", points: points, startWorld: startWorld, endWorld: endWorld, sampleCount: sampleCount });
    updateInspectUI();
  }

  // Dragging while Inspect (Grid) is armed calls this instead of
  // lockPointAt. All-or-nothing, unlike a line's partial fill above: a grid
  // missing some of its points would leave gaps in the mesh (see
  // drawInspectedAtStep) that read as broken rather than "a smaller grid,"
  // so this only commits once every point it actually needs both fits under
  // MAX_INSPECT_POINTS and compiles - and stays armed on either kind of
  // failure, so a rectangle that didn't work can just be redragged without
  // re-clicking the button.
  //
  // The layout (denseSize/lineAxes) is read from the current Grid Settings
  // ONCE, right here, and then belongs to this grid alone - see
  // inspectGridSize/inspectGridTwoPart's own comment for why a later
  // settings change must never reach back into an already-made grid.
  //
  // Only the points on a drawn row OR a drawn column are kept: one on
  // neither (see isAxisIn) would never appear in any line, so it's dropped
  // before a single trajectory is even compiled for it.
  //
  // inspectGridSize/inspectGridTwoPart (Grid Settings, in the settings
  // panel - see their own change listeners far below) are read fresh at the
  // top of every lockGridOfPoints call, never stored on the group itself
  // except as the already-resolved layout - so changing them only ever
  // changes what the NEXT drag makes; an existing grid's own points/mesh
  // were already committed and don't move or recolor retroactively.
  function lockGridOfPoints(startWorld, endWorld, gridSize, twoPart) {
    // The panel's current Grid Settings, unless the caller is rebuilding a
    // grid that was made under others (see restoreInspectGroups).
    if (gridSize === undefined) { gridSize = inspectGridSize; twoPart = inspectGridTwoPart; }
    var layout = computeGridLayout(gridSize, twoPart);
    var worldPoints = evenlySpacedGrid(startWorld, endWorld, layout.size, layout.size)
      .filter(function (p) { return isAxisIn(layout.axes, p.row) || isAxisIn(layout.axes, p.col); });
    if (MAX_INSPECT_POINTS - totalInspectedPointCount() < worldPoints.length) return;
    var points = [];
    for (var i = 0; i < worldPoints.length; i++) {
      var entry = computeTrajectoryEntry(worldPoints[i]);
      if (!entry) return;
      entry.color = inspectGridPointColor(worldPoints[i].col, worldPoints[i].row, layout.size);
      points.push(entry);
    }
    var segments = buildGridMeshSegments(worldPoints, layout.axes, layout.size);
    var meshLineEls = segments.map(function (pair) {
      var lineEl = document.createElementNS(SVG_NS, "line");
      lineEl.setAttribute("stroke-width", "2");
      lineEl.setAttribute("stroke", averageRgbFill(points[pair[0]].color, points[pair[1]].color));
      inspectPreviewSvg.appendChild(lineEl);
      return lineEl;
    });
    inspectedGroups.push({
      type: "grid",
      points: points,
      cols: layout.size,
      rows: layout.size,
      segments: segments,
      meshLineEls: meshLineEls,
      outputBodyIndex: inspectGridOutputBodyIndex(),
      startWorld: startWorld,
      endWorld: endWorld,
      // What it was made with, which the resolved layout above can't be
      // read back into (5 dots a side is 5 plain lines or 3 two-part ones) -
      // kept for the one thing that has to say it again, a shared link.
      gridSize: gridSize,
      twoPart: !!twoPart,
    });
    disarmInspect();
    updateInspectUI();
  }

  function removeInspectedGroup(index) {
    var group = inspectedGroups[index];
    if (group.type === "grid") group.meshLineEls.forEach(function (el) { el.remove(); });
    inspectedGroups.splice(index, 1);
    if (inspectedGroups.length === 0) {
      nextColorIndex = 0; // nothing left to continue the sequence from - start over at red
      disarmInspect();
    }
    updateInspectUI();
  }

  function clearInspected() {
    inspectedGroups.forEach(function (group) {
      if (group.type === "grid") group.meshLineEls.forEach(function (el) { el.remove(); });
    });
    inspectedGroups = [];
    pendingInspect = null;
    nextColorIndex = 0;
    disarmInspect();
    updateInspectUI();
  }

  // Clicking the already-armed button cancels it (a plain toggle) rather
  // than just re-arming a no-op state - otherwise there'd be no way back to
  // "neither armed" short of dragging one to completion or clearing
  // everything. Grey means "idle, click me"; the blue .inspect-armed look
  // (see fractal-grid.css) means "now go drag the grid" - the same
  // gray-idle/blue-active convention the first page's own .tool-btn uses,
  // so the color signals which button (if either) is waiting the same way
  // it does everywhere else in the app.
  function armInspect(mode) {
    if (inspectArmMode === mode) { disarmInspect(); return; }
    inspectArmMode = mode;
    btnInspectPoint.classList.toggle("inspect-armed", mode === "point");
    btnInspectLine.classList.toggle("inspect-armed", mode === "line");
    btnInspectGrid.classList.toggle("inspect-armed", mode === "grid");
  }
  btnInspectPoint.addEventListener("click", function () {
    if (totalInspectedPointCount() >= MAX_INSPECT_POINTS) return;
    armInspect("point");
  });
  btnInspectLine.addEventListener("click", function () {
    if (totalInspectedPointCount() >= MAX_INSPECT_POINTS) return;
    armInspect("line");
  });
  btnInspectGrid.addEventListener("click", function () {
    if (totalInspectedPointCount() >= MAX_INSPECT_POINTS) return;
    armInspect("grid");
  });

  btnInspectClearAll.addEventListener("click", clearInspected);

  btnSuperlativeLargest.addEventListener("click", function () { runSuperlative("largest"); });
  btnSuperlativeSmallest.addEventListener("click", function () { runSuperlative("smallest"); });
  btnSuperlativeEdge.addEventListener("click", function () { runSuperlative("edge"); });
  btnSuperlativeRarest.addEventListener("click", function () { runSuperlative("rarest"); });

  // "Largest Point"/"Smallest Point" fit every output type, but read more
  // naturally with wording (and, for x/y, an order) specific to what's
  // actually being searched - btn-superlative-largest always finds the max
  // t and -smallest always finds the min t no matter what it's labeled or
  // where it sits, so this only ever changes their text and DOM position,
  // never which button does which search.
  //
  // Named rather than an inline IIFE so setScene() can re-run it for a
  // scene arriving after boot (same reason as adoptSceneDuration above).
  function relabelSuperlativeExtremeButtons() {
    var prop = scene.output.property;
    var largestLabel = "Largest Point", smallestLabel = "Smallest Point", smallestFirst = false;
    if (prop === "x") {
      // Larger x is further right; this project's world-X isn't flipped.
      largestLabel = "Rightest";
      smallestLabel = "Leftest";
      smallestFirst = true;
    } else if (prop === "y") {
      // Larger y is LOWER on screen here (screen/physics convention, not
      // math convention - see PhysicsGridCodegen's own Y-flip comment), so
      // the largest-value search is "Lowest," not "Highest."
      largestLabel = "Lowest";
      smallestLabel = "Highest";
      smallestFirst = true;
    } else if (prop === "angle") {
      largestLabel = "Highest";
      smallestLabel = "Lowest";
    } else if (prop === "bounces") {
      largestLabel = "Most Bounces";
      smallestLabel = "Least Bounces";
    } else if (prop === "distance") {
      largestLabel = "Furthest";
      smallestLabel = "Closest";
    } else if (prop === "lifespan") {
      largestLabel = "Longest Lived";
      smallestLabel = "Shortest Lived";
    }
    btnSuperlativeLargest.textContent = largestLabel;
    btnSuperlativeSmallest.textContent = smallestLabel;
    // Restores natural (largest-first) DOM order before possibly reversing
    // it, so re-running this for a later scene with a different property
    // never leaves a stale order from an earlier one.
    if (smallestFirst) {
      btnSuperlativeLargest.parentNode.insertBefore(btnSuperlativeSmallest, btnSuperlativeLargest);
    } else {
      btnSuperlativeSmallest.parentNode.insertBefore(btnSuperlativeLargest, btnSuperlativeSmallest);
    }
  }
  relabelSuperlativeExtremeButtons();


  // ---- Progressive refinement ----
  //
  // The grid is never rendered in one go. It is built up as a sequence of
  // ever-finer sub-lattices of the final full-resolution pixel grid, each
  // level doubling the linear resolution of the one before it, until every
  // pixel has had its own simulation run. The canvas backing store is
  // always the full device-pixel resolution; what changes between levels is
  // how many of those pixels carry a genuinely simulated value, with the
  // rest showing the nearest coarser sample until their own turn comes.
  //
  // This replaces what used to be here: a startup benchmark that measured
  // the GPU, predicted a per-pixel cost, and picked one fixed resolution to
  // render at while panning (plus a second, higher one to swap to once the
  // view went idle). That approach had to GUESS, and could guess wrong in
  // both directions - too fine and every frame janked, too coarse and the
  // view stayed needlessly blurry with nothing to correct it. Refinement
  // can only ever guess in ONE direction: it starts from the cheapest
  // possible level and stops when it runs out of time, so a slow machine
  // gets a coarser picture rather than a stuttering one. Nothing has to
  // know in advance how fast anything is.
  //
  // Three properties fall out of that, all of which the old code needed
  // special machinery for:
  //
  //  - No calibration, so no benchmark at startup, and none of the
  //    "measured while the canvas was display:none" failure modes that
  //    machinery had to defend against.
  //  - Every level is a separate small draw, so a view that takes seconds
  //    to resolve never blocks the page inside one enormous draw call, and
  //    can be abandoned the instant the user pans again. (Long single draws
  //    are also what trips a GPU watchdog into killing the context, which
  //    this page has no handler for and could not recover from.)
  //  - The same code path serves panning and sitting still. Panning simply
  //    never gets past the early levels before the next frame resets it.

  // How many full-res pixels apart the samples of the very coarsest level
  // are. The ladder is powers of two, so this is only ever used to derive
  // the level count; startStride() below clamps it to the canvas.
  var COARSEST_STRIDE = 4096;

  // Rows of a sub-lattice target to draw per band. A whole sub-lattice is
  // one draw at its natural size; banding splits that draw into chunks so
  // the budget loop below can stop partway through a level instead of being
  // committed to however long the whole thing takes. This is the knob that
  // bounds the worst-case hitch, and it is deliberately expressed in ROWS
  // rather than pixels so a band's cost scales with the width of the thing
  // being drawn, the same way the budget does.
  var MIN_BAND_ROWS = 1;

  // ---- The per-frame work budget ----
  //
  // Purely a feedback loop against wall-clock frame time. There is no way
  // to ask WebGL how long a draw actually took - the timer-query extension
  // is unavailable in most browsers, and the alternative (a readPixels
  // after each draw, which is what the old calibration code did) is itself
  // a pipeline stall, i.e. exactly the cost being measured. So instead of
  // measuring the GPU, this watches how long frames are taking to come
  // back and moves the budget until they land where they should.
  //
  // Reactive rather than predictive: a frame that overshoots has already
  // overshot by the time it's noticed. That is fine here precisely because
  // the failure mode is bounded - the budget only ever controls how much
  // refinement happens per frame, never whether the image is correct.
  //
  // Crucially, the thresholds are relative to the DISPLAY's own cadence,
  // not to a hardcoded 16ms. Frame intervals under vsync are quantised to
  // whole multiples of the refresh period, so the only thing an interval
  // really tells you is how many refreshes a frame's work spilled across:
  // one means it fit, two or more means it didn't. Measuring that against
  // a fixed 16ms silently assumes a 60Hz display, and anywhere slower -
  // a 30Hz panel, a throttled or backgrounded tab, an embedded webview, a
  // laptop in a power-saving mode - EVERY frame reads as too slow, the
  // budget shrinks on every single one, and it pins itself to the floor
  // and stays there. The grid would sit at its coarsest level forever with
  // nothing to indicate why.
  var displayPeriodMs = 16.7;
  // Tracks the shortest interval seen lately: a running minimum with a
  // slow upward leak, so it settles onto the true refresh period but can
  // still climb if the page moves to a slower display. Fed by EVERY frame,
  // including idle ones - an idle frame is the only clean observation of
  // the period there is, since no work is competing with it.
  var DISPLAY_PERIOD_LEAK = 1.01;
  function noteFrameCadence(now) {
    if (lastFrameAt > 0) {
      var dt = now - lastFrameAt;
      // Ignore absurd gaps: a backgrounded tab, a breakpoint, or a machine
      // coming back from sleep says nothing about the refresh rate.
      if (dt > 0 && dt < 200) displayPeriodMs = Math.min(displayPeriodMs * DISPLAY_PERIOD_LEAK, dt);
    }
    lastFrameAt = now;
  }
  var lastFrameAt = 0;

  // How long a frame of rendering is meant to take - the period everything
  // below measures a frame against. One display refresh, unless Settings >
  // Performance Settings > Work per frame asks for longer (perf.frameMs).
  //
  // One refresh is what keeps the page perfectly smooth while it renders, and
  // on a GPU with time to spare it costs nothing. On one without, it costs
  // most of the GPU. Every frame carries a fixed charge that has nothing to
  // do with how much it simulates - the browser compositing the page, this
  // page's own present pass, the state a sliced draw loads and stores - and
  // at 120Hz a frame is 8ms, of which a phone can spend the better part on
  // that charge alone. Worse, the feedback loop below can only tell whether a
  // frame FIT its period: where even a nearly empty work frame takes two
  // refreshes to come back (a busy mobile compositor, a browser that halves
  // its frame rate under GPU load), every frame reads as an overrun, the
  // budget is cut on every one of them, and it ends up pinned at its floor -
  // a tile advanced a step or two per frame, a picture that takes minutes.
  // Against a 50ms frame the same charge is a few percent, and a frame that
  // took two refreshes simply fit.
  //
  // The cost is the page's frame rate while a render is under way, which is
  // why this is a setting and not a fact. While the user is doing something
  // the longer frame is halved, the same give-way the GPU-timed path already
  // makes (see GPU_SHARE_INTERACTING).
  function frameBaseMs() { return Math.max(displayPeriodMs, perf.frameMs || 0); }
  function userIsInteracting(now) { return now - lastInteractionAt < INTERACTION_HOLD_MS; }
  function frameTargetMs(now) {
    var base = frameBaseMs();
    return base > displayPeriodMs && userIsInteracting(now) ? Math.max(displayPeriodMs, base / 2) : base;
  }

  // Correcting down is a measurement; probing up is a guess. That asymmetry
  // is forced by vsync, and it is worth being explicit about because it
  // shapes the whole loop.
  //
  // Frame intervals are quantised to whole refresh periods, so a frame that
  // used 5% of its period and one that used 95% of it are indistinguishable
  // - both come back as exactly one period. A frame that took TWO periods,
  // though, is a real measurement: this many pixels took that long, so the
  // GPU's actual throughput is (pixels / periods) per period, and the
  // budget can be set straight to it instead of groped toward. Without that
  // arm the loop can only hill-climb blindly, and it limit-cycles: grow
  // until it overshoots, shrink, grow again, with a visible hitch on every
  // cycle.
  //
  // So: overshoot once and the budget lands on the measured truth in a
  // single frame; sit at one period and it creeps upward looking for the
  // ceiling it cannot otherwise see.
  var BUDGET_SAFETY = 0.85;   // aim just under measured capacity, not at it
  var BUDGET_GROW = 1.1;      // gentle upward probe when a frame fit
  // How far past one refresh period a frame has to run before it counts as
  // an overrun worth measuring rather than jitter worth ignoring.
  var OVERRUN_RATIO = 1.15;
  // ...and how far past it before the measurement is taken at face value
  // instead of being smoothed in. See noteFrameTiming.
  var HARD_OVERRUN_RATIO = 2.5;
  var BUDGET_SMOOTHING = 0.35; // weight of each new measurement
  // Enough to be worth a frame on anything, small enough not to jank a
  // phone on the first frame before any feedback exists.
  var INITIAL_PIXEL_BUDGET = 120000;
  // Deliberately far below one frame's worth of work on any machine. This
  // is a floor on the FEEDBACK, not on throughput - forward progress is
  // guaranteed separately, by the "always draw at least one band" rule in
  // stepProgressive - so setting it near a real frame's cost would peg the
  // loop above its target and it could never regulate back down. A heavy
  // scene on a modest GPU can be as slow as a few thousand simulated
  // pixels per frame, and the budget has to be able to follow it there.
  var MIN_PIXEL_BUDGET = 1000;
  var MAX_PIXEL_BUDGET = 32000000;

  // ---- ...and, where the browser offers it, measuring the GPU after all ----
  //
  // EXT_disjoint_timer_query_webgl2 reports how long the GPU spent on a span
  // of commands, a few frames later and without a stall. Chrome on desktop
  // has it; Safari does not, so everything above stays and is what runs
  // there. Where it IS available the ladder's budget is steered by it
  // instead (see noteGpuTime), because the feedback loop above can only
  // find the ceiling by hitting it: measured with these same queries, a
  // float32 render overran its frame on 38% of frames and a df one on
  // 30-40%, with 20ms of GPU work queued into a 16.7ms period as the steady
  // state. That is the page stuttering at 30-40fps for the length of every
  // render - the sliders and panels with it, since the browser draws them
  // on the same GPU.
  //
  // The query says how many ms a frame's pixels took, so the budget can be
  // set straight to the number that takes the time wanted, with no probing
  // and no overshoot. What is wanted depends on who is watching: most of
  // the period while the page is left alone to render, about half of it
  // while the user is doing something (moving the pointer counts - hovering
  // the grid replays a simulation per move), so that what they are doing
  // stays smooth and the render gives way rather than the reverse.
  var GPU_SHARE_IDLE = 0.85;
  var GPU_SHARE_INTERACTING = 0.5;
  var INTERACTION_HOLD_MS = 300;
  var lastInteractionAt = -1e9;
  ["pointerdown", "pointermove", "wheel", "keydown", "touchstart", "touchmove"].forEach(function (type) {
    window.addEventListener(type, function () { lastInteractionAt = performance.now(); }, { passive: true, capture: true });
  });
  var gpuTimer = { ext: gl.getExtension("EXT_disjoint_timer_query_webgl2"), active: null, pending: [] };

  function gpuTimerBegin() {
    if (!gpuTimer.ext || gpuTimer.active || gpuTimer.pending.length > 8) return;
    gpuTimer.active = gl.createQuery();
    gl.beginQuery(gpuTimer.ext.TIME_ELAPSED_EXT, gpuTimer.active);
  }
  // `spent` of budget `b`'s units were dispatched inside the span.
  function gpuTimerEnd(b, spent) {
    if (!gpuTimer.active) return;
    gl.endQuery(gpuTimer.ext.TIME_ELAPSED_EXT);
    gpuTimer.pending.push({ query: gpuTimer.active, b: b, spent: spent, budget: b.budget });
    gpuTimer.active = null;
  }
  function gpuTimerPoll(now) {
    while (gpuTimer.pending.length && gl.getQueryParameter(gpuTimer.pending[0].query, gl.QUERY_RESULT_AVAILABLE)) {
      var rec = gpuTimer.pending.shift();
      // A disjoint reading (the GPU was reset or throttled mid-span) is void.
      var ok = !gl.getParameter(gpuTimer.ext.GPU_DISJOINT_EXT);
      var ms = gl.getQueryParameter(rec.query, gl.QUERY_RESULT) / 1e6;
      gl.deleteQuery(rec.query);
      if (ok) noteGpuTime(rec.b, rec.spent, rec.budget, ms, now);
    }
  }
  function noteGpuTime(b, spent, budgetThen, ms, now) {
    var share = userIsInteracting(now) ? GPU_SHARE_INTERACTING : GPU_SHARE_IDLE;
    var targetMs = frameBaseMs() * share;
    perfStats.gpuMs = ms;
    // Only a frame that spent most of its budget says what a budget's worth
    // costs. One cut short - the last band of a level, or a sliced frame
    // that stopped at its slice-time cap with pixels to spare - is mostly
    // fixed costs, and would read as a GPU many times slower than it is.
    // Unless it ran LONG anyway: then whatever it spent was too much, and
    // that is never to be ignored.
    if (!(ms > 0.2) || (spent < budgetThen * 0.5 && ms < targetMs)) return;
    var perMs = spent / ms;
    // Too slow is believed at once; faster is eased into.
    b.gpuPerMs = b.gpuPerMs > 0 && perMs > b.gpuPerMs ? b.gpuPerMs * (1 - BUDGET_SMOOTHING) + perMs * BUDGET_SMOOTHING : perMs;
    b.budget = clamp(b.gpuPerMs * targetMs, b.min, b.max);
    // What one period holds - the figure other budgets are seeded from.
    b.throughput = b.gpuPerMs * frameBaseMs();
  }

  // One work budget and the measurements that steer it. There are two: the
  // refinement ladder's (counted in simulated pixels) and playback's
  // (counted in pixel-steps, since a playback draw costs its step count as
  // well - see the Playback section). Each is only ever compared against
  // itself, so its unit is simply whatever its owner charges.
  //
  // growMinUse is the share of its budget a frame must actually have spent
  // before fitting inside one period counts as a reason to grow - see
  // noteFrameTiming.
  function makeWorkBudget(initial, min, max, growMinUse) {
    return {
      budget: initial,
      min: min,
      max: max,
      growMinUse: growMinUse || 0,
      // How much work fits in one refresh period, as last measured.
      throughput: 0,
      // The same from GPU timer queries, per millisecond; 0 until one has
      // reported, and for good where there are none - see noteGpuTime.
      gpuPerMs: 0,
      // Work dispatched during the previous work frame - the other half of
      // the measurement, since the interval alone says nothing without
      // knowing what was being timed.
      lastSpent: 0,
      // Wall-clock timestamp of the last frame that actually dispatched
      // work. Frames with nothing to do are NOT fed back into the budget:
      // an idle rAF returns in one refresh period no matter how slow the
      // GPU is, so counting those would ratchet the budget up without limit
      // and guarantee a stutter on the next view change.
      lastWorkAt: 0,
    };
  }
  // One per program the ladder can draw with, keyed like `passes` - so
  // switching precision or display mode picks up where that program last
  // left off instead of spending an f32-sized budget on a df frame (or a
  // standard-sized one on a five-simulation derived frame) and then walking
  // it down over several slow frames. `ladderBudget` is whichever belongs to
  // the active pass; useCurrentPass swaps it.
  //
  // A program that has never drawn is seeded from float32-standard's
  // measured throughput and a prior for how much dearer this one is. The
  // prior is deliberately pessimistic - measured, a df pixel costs 5x to
  // 60x a float32 one depending on the scene (trig-heavy hinges at the low
  // end, swept collisions at the high end), and this takes the high end.
  // Guessing too dear only means the first few frames refine a little less
  // than they could have while the budget climbs 10% a frame; guessing too
  // cheap queues more GPU work than fits and the canvas visibly hangs for
  // however many frames that was - 600ms, the first time this was tried
  // with a prior of 12.
  var DF_COST_PRIOR = 64;
  // The rungs above df, as multiples of df's prior. Measured on the three
  // samples (512x512 pixels, 8 steps a draw, so the GPU is saturated and no
  // run is long): three words cost 3.4x to 5.0x what two do, and four words
  // 6.5x to 7.9x - the hinged double pendulum at the high end of both, as
  // it is for df itself. These take the high end for the reason above, and
  // like DF_COST_PRIOR they only seed the first frames: the budget is
  // steered by measured frame times from then on.
  var PRECISION_COST_PRIOR = { df: DF_COST_PRIOR, tf: DF_COST_PRIOR * 5, qf: DF_COST_PRIOR * 8 };
  var DERIVED_COST_PRIOR = 5;
  var ladderBudgets = {};
  // `key` is precision:variant, as in `passes` - for whatever is about to
  // draw, which above float32 is the sliced renderer rather than a pass.
  function budgetFor(precision, variant) {
    // Sliced rendering has its own floor and growth rule, and float32 can be
    // on either side of it depending on the scene (see f32NeedsSlicing).
    var sliced = precision !== "f32" || f32NeedsSlicing();
    var key = passKey(precision, variant) + (sliced && precision === "f32" ? ":sliced" : "");
    if (!ladderBudgets[key]) {
      var floor = sliced ? SLICE_MIN_PIXEL_BUDGET : MIN_PIXEL_BUDGET;
      var seed = INITIAL_PIXEL_BUDGET;
      var reference = ladderBudgets[passKey("f32", "standard")];
      if (reference && reference.throughput > 0) {
        var ratio = (sliced ? PRECISION_COST_PRIOR[precision] || DF_COST_PRIOR : 1) * (variant === "derived" ? DERIVED_COST_PRIOR : 1);
        seed = clamp(reference.throughput * BUDGET_SAFETY / ratio, floor, MAX_PIXEL_BUDGET);
      } else if (sliced) {
        seed = INITIAL_PIXEL_BUDGET / (PRECISION_COST_PRIOR[precision] || DF_COST_PRIOR);
      }
      // Sliced frames can stop at their slice-time cap with most of the
      // budget unspent (see SLICE_FRAME_SHARE); fitting says nothing then.
      ladderBudgets[key] = makeWorkBudget(seed, floor, MAX_PIXEL_BUDGET, sliced ? 0.5 : 0);
    }
    return ladderBudgets[key];
  }
  var ladderBudget = budgetFor("f32", "standard");

  // Returns how many refresh periods the previous work frame took (0 when
  // there was none to time), for the one caller that steers something
  // besides the budget by it - see adaptSliceSteps.
  function noteFrameTiming(b, now) {
    var tookPeriods = 0;
    if (b.lastWorkAt > 0 && b.lastSpent > 0) {
      var dt = now - b.lastWorkAt;
      // Deliberately NOT rounded to whole periods. Under strict vsync an
      // interval really is a whole multiple of the refresh period and
      // rounding is harmless, but plenty of contexts don't present that
      // cleanly - an embedded webview, a compositor under load, a browser
      // pane rendering into another surface - and there a frame that ran
      // 1.3 periods long rounds down to "1", i.e. reads as having fit
      // comfortably, and the budget grows on the strength of a frame that
      // actually overran. Left continuous, the same interval is a straight
      // measurement of how much work fits in one period.
      // "Period" is the frame's target length (see frameBaseMs), which is one
      // display refresh unless the Work per frame setting says otherwise.
      var periods = Math.max(1, dt / frameTargetMs(now));
      tookPeriods = periods;
      perfStats.workFrameMs = perfStats.workFrameMs > 0 ? perfStats.workFrameMs * 0.8 + dt * 0.2 : dt;
      perfStats.workFrameMaxMs = Math.max(perfStats.workFrameMaxMs, dt);
      // Steered by measured GPU time instead (noteGpuTime): a long interval
      // then is the page's own doing - a compile, a garbage collection -
      // and no reason to touch the budget.
      if (b.gpuPerMs > 0) {
        b.lastWorkAt = now;
        return tookPeriods;
      }
      if (periods > OVERRUN_RATIO) {
        // A real measurement of how much work fits in one period.
        var measured = b.lastSpent / periods;
        // A frame that ran several periods long is not noise to be averaged
        // away - it is an unambiguous statement that the budget is far too
        // big, and smoothing it would spend the next several frames
        // overshooting by less and less while the user watches. This is
        // what the start of a gesture looks like when the previous budget
        // was set by settled work: antialiasing measures its capacity on
        // plain full-screen passes, then the first pan frame restarts the
        // ladder and pays a dozen extra composites out of the same budget.
        // Small overruns still get smoothed, because there they really are
        // jitter.
        var blend = periods > HARD_OVERRUN_RATIO ? 1 : BUDGET_SMOOTHING;
        b.throughput = b.throughput > 0
          ? b.throughput * (1 - blend) + measured * blend
          : measured;
        b.budget = b.throughput * BUDGET_SAFETY;
      } else if (b.lastSpent >= b.budget * b.growMinUse) {
        // Fit inside one period, by an unknowable margin. Creep upward.
        //
        // The ladder grows on every such frame (growMinUse 0) - it draws
        // until its budget runs out, so a frame that fit really was a full
        // one. Playback at a modest speed spends only what its clock asks
        // for, though, and a frame that used a tenth of its budget says
        // nothing about where the ceiling is: growing on those would leave
        // the budget far too big the moment the work rose to meet it.
        b.budget *= BUDGET_GROW;
        b.throughput = Math.max(b.throughput, b.budget / BUDGET_SAFETY);
      }
      b.budget = clamp(b.budget, b.min, b.max);
    }
    b.lastWorkAt = now;
    return tookPeriods;
  }

  // ---- Where the user's two resolution handles land on the ladder ----
  //
  // The Resolution Bounds control is no longer a pair of clamps on an
  // automatic choice - there is no automatic choice left to clamp. The two
  // handles now name the two ENDS of the refinement ladder directly: the
  // left one is where refinement starts (0% = a single sample for the whole
  // screen), the right one is where it stops (100% = one simulation per
  // device pixel). Leaving both at their defaults means "start as coarse as
  // possible, finish at full resolution," which is what the great majority
  // of viewing wants and is why those are the defaults.
  //
  // Both map onto the same power-of-two ladder the refinement itself walks,
  // so a handle can only ever select a level that actually exists - there
  // is no rounding between what the slider says and what gets drawn.
  function strideLadderLength() {
    // Number of halvings from COARSEST_STRIDE down to 1, capped so the
    // coarsest level is never coarser than "one sample for the whole
    // canvas" - past that point extra levels would all render the same 1x1
    // image and just cost draw calls.
    var longest = Math.max(canvas.width, canvas.height, 1);
    var coarsest = Math.min(COARSEST_STRIDE, Math.pow(2, Math.ceil(Math.log2(longest))));
    return Math.max(1, Math.round(Math.log2(coarsest)));
  }
  // 0 -> the coarsest stride on the ladder, 100 -> stride 1 (full res).
  function sliderValueToStride(sliderValue) {
    var levels = strideLadderLength();
    var step = Math.round((sliderValue / 100) * levels);
    return Math.pow(2, levels - step);
  }
  function startStride() {
    // A still being rendered for a movie (see renderStill) has no use for
    // the coarse levels - they exist to put SOMETHING on screen quickly, and
    // each costs a whole run's latency - so its ladder is its last rung.
    if (stillJob) return endStride();
    return Math.max(sliderValueToStride(Number(resolutionMinSlider.value)), endStride());
  }
  function endStride() {
    // A movie's frames are finished pictures at the movie's own quality (see
    // renderStill), whatever this page's Resolution Limits - which in the
    // player's frame are simply the device's default preset - happen to say.
    if (stillJob) return 1;
    return sliderValueToStride(Number(resolutionMaxSlider.value));
  }
  // Settings > Performance Settings > Antialiasing - except for a movie's
  // frame, which says for itself whether it is antialiased.
  function antialiasWanted() { return stillJob ? stillJob.antialias : perf.antialias; }

  // ---- GPU resources ----
  //
  // Two full-res accumulators (ping-ponged, because a composite reads the
  // previous state while writing the next one) and three half-res
  // sub-lattice targets. Everything is allocated at the largest size it
  // will ever need and then used at whatever sub-rectangle a given level
  // calls for - texelFetch reads explicit integer coordinates, so an
  // over-large texture costs memory and nothing else, and reallocating per
  // level would mean a dozen texture reallocations on every single pan.
  var accum = [null, null];   // {tex, fbo}
  var accumIndex = 0;         // which of the two currently holds the live image
  var sublattices = [];       // three {tex, fbo}, indexed 0..2 for sub-lattices 1..3
  var allocatedFor = { w: 0, h: 0 };
  var compositeProgram = null;

  // internalFormat/type default to plain 8-bit color, which is what every
  // ladder target wants; the antialiasing accumulator passes RGBA16F
  // instead, because it holds a running average rather than a finished
  // color (see antialiasSupported for why 8 bits is not enough for that).
  function makeTarget(w, h, internalFormat, type) {
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat || gl.RGBA8, w, h, 0,
      gl.RGBA, type || gl.UNSIGNED_BYTE, null);
    // NEAREST throughout, and never mipmapped: every sample in here is a
    // point sample of a chaotic field, and interpolating between two of
    // them would invent a color that belongs to no simulation at all.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    var fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex: tex, fbo: fbo, width: w, height: h };
  }
  function freeTarget(t) {
    if (!t) return;
    gl.deleteFramebuffer(t.fbo);
    gl.deleteTexture(t.tex);
  }

  // ---- The composite ----
  //
  // Folds the accumulator (every level finished so far) and the current
  // level's three new sub-lattices into one image at the NEW level's
  // resolution.
  //
  // Running at the new level's resolution rather than at full resolution is
  // the difference between this being free and this dominating everything.
  // A full-res composite costs a whole screen of texels no matter how
  // coarse the level being composited is - and a single panning frame walks
  // a dozen levels, so it would pay that whole-screen cost a dozen times
  // over to produce a few thousand actual simulated samples. Sized to the
  // level instead, the composites across an entire run from 1 pixel to full
  // resolution add up to 4/3 of one screen, total.
  //
  // The gather is what makes the ladder a strict partition rather than a
  // pyramid of redundant re-renders. Going from stride s to s/2 quadruples
  // the sample count; one of every four new samples is one the accumulator
  // ALREADY holds (the sub-lattice-0 position), so only the other three are
  // ever simulated. Every pixel is simulated exactly once across the whole
  // ladder, which is why reaching full resolution costs one full-resolution
  // render rather than the 4/3 that re-rendering each level would.
  var COMPOSITE_FRAGMENT_SOURCE = [
    "#version 300 es",
    "precision highp float;",
    // The previous, coarser level. Its sample (i, j) is the new level's
    // sample (2i, 2j) - the one position of each new quadruple that does
    // not have to be simulated again.
    "uniform sampler2D u_accum;",
    "uniform sampler2D u_subA;",
    "uniform sampler2D u_subB;",
    "uniform sampler2D u_subC;",
    // How many of the three new sub-lattices have actually been drawn
    // (0..3). The rest fall back to the coarser level, so a half-finished
    // level shows as a partly-refined image rather than reading whatever
    // a stale target happens to still hold.
    "uniform int u_shown;",
    "out vec4 fragColor;",
    "void main() {",
    "  ivec2 q = ivec2(gl_FragCoord.xy);",   // index in the NEW level's grid
    "  ivec2 g = q >> 1;",                   // the coarser level's sample it came from
    "  int sel = (q.y & 1) * 2 + (q.x & 1);",
    "  if (sel == 0 || sel > u_shown) {",
    "    fragColor = texelFetch(u_accum, g, 0);",
    "  } else if (sel == 1) {",
    "    fragColor = texelFetch(u_subA, g, 0);",
    "  } else if (sel == 2) {",
    "    fragColor = texelFetch(u_subB, g, 0);",
    "  } else {",
    "    fragColor = texelFetch(u_subC, g, 0);",
    "  }",
    "}",
  ].join("\n");

  function buildCompositeProgram() {
    var prog = PhysicsGPU.linkProgram(gl, vs,
      PhysicsGPU.compileShader(gl, gl.FRAGMENT_SHADER, COMPOSITE_FRAGMENT_SOURCE));
    return {
      program: prog,
      posLoc: gl.getAttribLocation(prog, "a_position"),
      uniforms: {
        accum: gl.getUniformLocation(prog, "u_accum"),
        subA: gl.getUniformLocation(prog, "u_subA"),
        subB: gl.getUniformLocation(prog, "u_subB"),
        subC: gl.getUniformLocation(prog, "u_subC"),
        shown: gl.getUniformLocation(prog, "u_shown"),
      },
    };
  }

  // Allocates (or reallocates) every target to match the current canvas.
  // Returns false if anything could not be built, which is the signal for
  // the caller to leave the canvas alone rather than draw a broken frame.
  //
  // Everything is allocated at the largest size it will ever need and used
  // at whatever sub-rectangle a given level calls for - texelFetch reads
  // explicit integer coordinates, so an over-large texture costs memory and
  // nothing else, and reallocating per level would mean a dozen texture
  // reallocations on every single pan.
  function ensureTargets() {
    if (canvas.width <= 0 || canvas.height <= 0) return false;
    if (allocatedFor.w === canvas.width && allocatedFor.h === canvas.height && accum[0]) return true;
    releaseTargets();
    try {
      if (!compositeProgram) compositeProgram = buildCompositeProgram();
      // Full res: the final level's composite output is the whole grid.
      accum[0] = makeTarget(canvas.width, canvas.height);
      accum[1] = makeTarget(canvas.width, canvas.height);
      // Half the full-res grid each way is the largest a sub-lattice target
      // ever needs: the finest level's three new sub-lattices each sample
      // every other full-res pixel. ceil, not floor, so an odd canvas
      // dimension doesn't lose its last row or column.
      var sw = Math.max(1, Math.ceil(canvas.width / 2));
      var sh = Math.max(1, Math.ceil(canvas.height / 2));
      sublattices = [makeTarget(sw, sh), makeTarget(sw, sh), makeTarget(sw, sh)];
      allocatedFor = { w: canvas.width, h: canvas.height };
      return true;
    } catch (err) {
      releaseTargets();
      return false;
    }
  }

  function releaseTargets() {
    freeTarget(accum[0]); freeTarget(accum[1]);
    accum[0] = accum[1] = null;
    sublattices.forEach(freeTarget);
    sublattices = [];
    freeTarget(aaAccum);
    aaAccum = null;
    allocatedFor = { w: 0, h: 0 };
  }

  // ---- Antialiasing ----
  //
  // The last stage of every settled view, and not optional. There is no
  // setting for it: it was briefly a checkbox, and the comparison was
  // lopsided enough that offering the worse image as a choice was not worth
  // the control.
  //
  // Everything above stops at one simulation per pixel, which is one point
  // sample of a continuous field per pixel - so hard edges come out as
  // stair-steps, and they shimmer when the view moves, because a one-pixel
  // pan re-rolls which side of the edge each sample lands on. This keeps
  // going past that: extra whole-screen passes, each offset by a fraction
  // of a pixel, averaged together. That is an estimate of each pixel's true
  // area average rather than a guess at what lies between samples - no
  // interpolation is involved and nothing is invented, which matters here
  // because interpolating a chaotic field would produce colors belonging
  // to no simulation at all.
  //
  // What it does is not uniform across the image, and it is worth knowing
  // which of the three regimes you are looking at:
  //
  //  - Across the smooth gradients that make up most of a typical view, the
  //    field is locally linear, so the samples average to almost exactly
  //    the one in the middle. No visible change for the work.
  //  - At coherent edges it is a real win, and this is what it is for.
  //  - In regions that are chaotic below pixel scale, neighbouring samples
  //    are uncorrelated, so the average converges on the mean of the whole
  //    output range. Because output is mapped through a HUE ramp before any
  //    averaging happens, averaging opposing hues in RGB tends toward gray,
  //    and those regions visibly calm down. That is the truthful rendering
  //    - it says "there is nothing resolvable here", the same thing the
  //    precision readout says in words - rather than a bug to be tuned out.
  //
  // Two things keep this from ever costing the user anything. It runs only
  // once the ladder has fully settled, so it never competes with panning;
  // and sample 0 is the pixel center, i.e. exactly the image the ladder
  // already produced, so it starts from the finished render and adds to it
  // rather than restarting anything.
  var MAX_AA_SAMPLES = 4;
  var aaAccum = null;       // RGBA16F, full res - the running average
  var presentProgram = null;

  // Whether antialiasing can run at all. It needs a float render target for
  // the running average: at 8 bits per channel, blending a 1/n contribution
  // rounds most of the later samples away entirely, so the average would
  // stop improving after about four of them while still costing a full
  // render each.
  function antialiasSupported() { return hasFloatColorBuffer; }

  // The R2 low-discrepancy sequence - the 2D generalisation of the golden
  // ratio. Successive points spread themselves evenly over the pixel
  // without the clumping a random jitter gives or the axis-alignment a
  // regular grid gives (a regular grid is the worst case for exactly the
  // near-horizontal and near-vertical edges antialiasing is meant to fix).
  // i=0 returns (0,0), the pixel center.
  var R2_A1 = 0.7548776662466927;   // 1/phi2,   phi2 = the plastic number
  var R2_A2 = 0.5698402909980532;   // 1/phi2^2
  function aaOffset(i) {
    if (i === 0) return { x: 0, y: 0 };
    return {
      x: ((0.5 + R2_A1 * i) % 1) - 0.5,
      y: ((0.5 + R2_A2 * i) % 1) - 0.5,
    };
  }

  // Copies a texture to whatever framebuffer is bound, one texel to one
  // pixel. Needed because blitFramebuffer refuses to convert between a
  // floating-point read buffer and a fixed-point draw buffer, which is
  // exactly the conversion getting the float average onto the canvas needs.
  var PRESENT_FRAGMENT_SOURCE = [
    "#version 300 es",
    "precision highp float;",
    "uniform sampler2D u_src;",
    "out vec4 fragColor;",
    "void main() {",
    "  fragColor = vec4(texelFetch(u_src, ivec2(gl_FragCoord.xy), 0).rgb, 1.0);",
    "}",
  ].join("\n");

  function buildPresentProgram() {
    var prog = PhysicsGPU.linkProgram(gl, vs,
      PhysicsGPU.compileShader(gl, gl.FRAGMENT_SHADER, PRESENT_FRAGMENT_SOURCE));
    return {
      program: prog,
      posLoc: gl.getAttribLocation(prog, "a_position"),
      src: gl.getUniformLocation(prog, "u_src"),
    };
  }

  function drawPresent(srcTex, w, h) {
    gl.viewport(0, 0, w, h);
    gl.disable(gl.SCISSOR_TEST);
    gl.useProgram(presentProgram.program);
    bindQuad(presentProgram.posLoc);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform1i(presentProgram.src, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  // Allocated lazily, the first time antialiasing actually reaches its
  // phase - a session that never switches the checkbox on never pays the
  // memory, which at full resolution is not small.
  function ensureAaTarget() {
    if (aaAccum) return true;
    if (!antialiasSupported()) return false;
    try {
      if (!presentProgram) presentProgram = buildPresentProgram();
      aaAccum = makeTarget(canvas.width, canvas.height, gl.RGBA16F, gl.HALF_FLOAT);
      return true;
    } catch (err) {
      freeTarget(aaAccum);
      aaAccum = null;
      return false;
    }
  }

  // Seeds the running average with the finished ladder render - sample 0,
  // the pixel center - and hands the AA phase something to build on.
  function beginAntialias() {
    if (!ensureAaTarget()) return false;
    gl.bindFramebuffer(gl.FRAMEBUFFER, aaAccum.fbo);
    gl.disable(gl.BLEND);
    drawPresent(accum[accumIndex].tex, canvas.width, canvas.height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    progressive.aaSample = 1;
    return true;
  }

  // Draws up to `maxRows` more rows of the AA sample currently in progress,
  // blended into the running average.
  //
  // The blend does the averaging in the framebuffer rather than in a shader
  // over a ping-pong pair: with a constant alpha of 1/n, the hardware
  // computes new*(1/n) + old*(1 - 1/n), which is precisely the running mean
  // after n samples. That keeps this to ONE full-res float target instead of
  // two, and costs no extra pass.
  function drawAaBand(pixelsAvailable) {
    // The whole screen, unless a pan reused pixels that had ALREADY been
    // antialiased - those arrived with the accumulator this average was
    // seeded from, and are left as they are. (A sample's sub-pixel offset
    // doesn't move it to another pixel, so the region is the pixel's own.)
    var region = levelSimRegion(1, 0, 0, true);
    if (region.rows === 0 && progressive.band === 0) return REUSE_FREE_COST;
    var at = locateBand(region, progressive.band);
    if (!at) return 0;
    var n = progressive.aaSample + 1;         // the sample being added
    var off = aaOffset(progressive.aaSample); // 0-based index of that sample
    var slicedPrograms = slicedProgramsForGrid();
    if (slicedPrograms) {
      return drawSlicedTile(slicedPrograms, { target: aaAccum, w: canvas.width, h: canvas.height, stride: 1,
        originX: off.x, originY: off.y, blend: n, region: region }, pixelsAvailable);
    }
    var rect = at.rect;
    var rows = Math.min(Math.max(MIN_BAND_ROWS, Math.floor(pixelsAvailable / Math.max(rect.w, 1))), rect.h - at.row);
    gl.bindFramebuffer(gl.FRAMEBUFFER, aaAccum.fbo);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(rect.x, rect.y + at.row, rect.w, rows);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.CONSTANT_ALPHA, gl.ONE_MINUS_CONSTANT_ALPHA);
    gl.blendColor(0, 0, 0, 1 / n);
    drawSublattice(1, off.x, off.y);
    perfStats.drawsThisFrame += 1;
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    progressive.band += rows;
    return rows * rect.w;
  }

  // How many sample points a level of the given stride has, in each
  // direction. ceil so the right and bottom edges are always covered: with
  // floor, a canvas whose width isn't a multiple of the stride would leave
  // its last partial cell unsampled and therefore unpainted.
  function levelWidth(stride) { return Math.max(1, Math.ceil(canvas.width / stride)); }
  function levelHeight(stride) { return Math.max(1, Math.ceil(canvas.height / stride)); }

  // ---- Rendering progress ring ----
  //
  // Two stacked circle outlines in the lower right (#render-progress-ring in
  // chaos.html/fractal-grid.css) tracking this same progressive state,
  // translated into a continuous 0..1 fraction rather than the coarse,
  // per-level jumps the text readout above uses - so the ring visibly creeps
  // forward band by band instead of snapping in a handful of big steps.
  //
  // The gray ring's checkpoints are pinned to specific strides (32px down to
  // 1 sim/px, one fifth of the ring per halving) rather than to wherever the
  // resolution sliders currently sit - everything coarser than 32px reads as
  // 0%, since on a standard scene that phase is a handful of cheap levels
  // over almost instantly, and the ring has nothing worth showing yet. A run
  // that stops before reaching full resolution (the max slider pulled in)
  // still ends up full once `progressive.complete` says there is nothing
  // left to do, rather than stranding the ring wherever it happened to be.
  var RENDER_RING_STRIDE_CHECKPOINTS = [32, 16, 8, 4, 2];
  var RENDER_RING_CIRCUMFERENCE = 2 * Math.PI * 17; // matches the r=17 circles in chaos.html

  // Fraction (0..1) through whichever sub-lattice/band is currently being
  // drawn at progressive.stride - the finest-grained unit of progress this
  // state machine exposes, whether that's one of the three refining
  // sub-lattices or (only for the very first, coarsest level of a run) the
  // single base draw.
  function renderRingSublatticeFraction() {
    var height = Math.max(1, currentPassRows());
    var bandFraction = Math.min(1, progressive.band / height);
    if (progressive.sublattice <= 0) return bandFraction;
    return Math.min(1, ((progressive.sublattice - 1) + bandFraction) / 3);
  }

  function renderRingGreyFraction() {
    if (progressive.complete) return 1;
    if (progressive.accumStride === 1) return 1;
    var idx = RENDER_RING_STRIDE_CHECKPOINTS.indexOf(progressive.accumStride);
    if (idx < 0) return 0; // coarser than 32px, or nothing accumulated yet
    return Math.min(1, (idx + renderRingSublatticeFraction()) / RENDER_RING_STRIDE_CHECKPOINTS.length);
  }

  function renderRingAaFraction() {
    if (progressive.aaSample <= 0) return 0;
    if (progressive.complete) return 1;
    var bandFraction = Math.min(1, progressive.band / Math.max(1, currentPassRows()));
    return Math.min(1, ((progressive.aaSample - 1) + bandFraction) / MAX_AA_SAMPLES);
  }

  function setRenderRingFraction(circle, fraction) {
    circle.style.strokeDasharray = RENDER_RING_CIRCUMFERENCE;
    circle.style.strokeDashoffset = RENDER_RING_CIRCUMFERENCE * (1 - fraction);
  }

  // The same numbers the ring draws, spelled out for the open menu's own
  // one-line readout - "1 sim per Npx" while the ladder is running, then
  // antialiasing's own count once that phase starts (see finishRun for why
  // aaSample is already MAX_AA_SAMPLES, not one short of it, by the time
  // the run is complete).
  function renderProgressLabelText() {
    if (progressive.aaSample > 0) {
      return "Antialiasing Progress: " + Math.min(progressive.aaSample, MAX_AA_SAMPLES) +
        " of " + MAX_AA_SAMPLES + " samples per pixel";
    }
    var stride = progressive.accumStride || progressive.stride || startStride();
    return "Rendering Progress: " + (stride <= 1 ? "1 sim/px" : "1 sim per " + stride + "px");
  }

  // Called from presentFrame - every path that can change what's on screen,
  // which includes both ends of a run (resetProgressive right below, and
  // finishRun further down, which calls presentFrame itself) - so the ring
  // is never more than one frame stale. Updates both copies of the ring
  // (the collapsed toggle's and the open menu's own) unconditionally rather
  // than checking which is actually visible - four style writes a frame is
  // free, and it's one less thing to keep in sync with is-open.
  //
  // While playback is drawing the frames (see stepPlayback), the ring
  // reports playback instead: how far a catch-up has got, or otherwise the
  // ladder level playback's lattice sits at - which is also the level a
  // pause will refine on from.
  function playbackRingFraction() {
    if (timeline.catchingUp) return timeline.catchUpFraction;
    if (timeline.stride <= 1) return 1;
    var idx = RENDER_RING_STRIDE_CHECKPOINTS.indexOf(timeline.stride);
    return idx < 0 ? 0 : idx / RENDER_RING_STRIDE_CHECKPOINTS.length;
  }
  function playbackProgressLabelText() {
    if (timeline.catchingUp) {
      return "Playback: catching up to frame " + timeline.step.toLocaleString() +
        " (" + Math.floor(timeline.catchUpFraction * 100) + "%)";
    }
    return "Playback: " + (timeline.stride <= 1 ? "1 sim/px" : "1 sim per " + timeline.stride + "px");
  }
  function updateRenderProgressRing() {
    var playback = timeline.playing && timeline.drawing;
    var gray = playback ? playbackRingFraction() : renderRingGreyFraction();
    var aa = playback ? 0 : renderRingAaFraction();
    setRenderRingFraction(renderProgressRingCoarse, gray);
    setRenderRingFraction(renderProgressRingAa, aa);
    setRenderRingFraction(renderProgressRingCoarseOpen, gray);
    setRenderRingFraction(renderProgressRingAaOpen, aa);
    renderProgressLabel.textContent = playback ? playbackProgressLabelText() : renderProgressLabelText();
  }

  // Abandon whatever refinement is in flight. Deliberately does NOT touch
  // the accumulator or the canvas: the picture on screen stays up until
  // something better replaces it, which is what makes a pan look like the
  // image being dragged and re-resolved rather than flickering through
  // black between frames.
  function resetProgressive() {
    // Picture reuse: first, while the run's state still says what it had
    // reached, decide whether its picture is the one to keep.
    if (reuseEnabled) reuseCapture();
    reuse.run = null;
    progressive.stride = 0;
    progressive.sublattice = 1;
    progressive.band = 0;
    progressive.complete = false;
    progressive.accumStride = 0;
    progressive.aaSample = 0;
    // A half-simulated tile belongs to the view that was just abandoned.
    progressive.tile = null;
    progressive.tileX = 0;
    updateRenderProgressRing();
  }

  // Starts a refinement run for the current view. Only sets up state - the
  // coarsest level is drawn through the same banded path as every other
  // level, because "coarsest" is whatever the left-hand slider says and the
  // user is entitled to drag it all the way to the right, which would
  // otherwise make the first level a single unbanded full-resolution draw:
  // precisely the seconds-long blocking call this whole design exists to
  // avoid.
  //
  // This is also the one place per view change where the view-dependent
  // bounce-count divisor is measured - see findBounceMax for why it must
  // not happen again until the next view change.
  function beginProgressive() {
    if (reuseEnabled) { reuseNoteImage(); reusePlanRun(); }
    if (isBouncesOutput) requestBounceMax();
    progressive.stride = startStride();
    // See SLICE_FIRST_LEVEL_SAMPLES: under sliced rendering the coarsest
    // levels cost as much as a useful one and show nothing.
    if (slicedProgramsForGrid()) {
      while (progressive.stride > endStride() &&
             levelWidth(progressive.stride) * levelHeight(progressive.stride) < SLICE_FIRST_LEVEL_SAMPLES) {
        progressive.stride /= 2;
      }
    }
    progressive.sublattice = 0;   // 0 = the base level, drawn straight into the accumulator
    progressive.band = 0;
    progressive.complete = false;
    progressive.accumStride = 0;
    // Both of these describe the view rather than the image, so they belong
    // with the start of a run, not with every level inside it.
    updateInspectMarkers();
    updatePrecisionReadout();
    beginPerfRun();
  }

  // Puts a level-sized image on the canvas, magnified by its own stride.
  //
  // The destination rectangle is w*stride x h*stride, NOT the canvas size,
  // and deliberately so. levelWidth rounds UP, so w*stride is >= the canvas
  // width and usually a little past it; blitting to the canvas size instead
  // would scale by canvas.width/w, which equals `stride` only when the
  // canvas divides evenly, and everywhere else would stretch each sample
  // across slightly less than its own block - leaving the picture subtly
  // squashed, by a differing amount at each level, so the image would creep
  // sideways as it sharpened. GL clips the overhanging part of the
  // destination rect for free, which keeps the magnification exact.
  function presentLevel(target, w, h, stride) {
    // blitFramebuffer honours the scissor box, so a band left enabled from
    // a partially-drawn level would silently blit only that band.
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, target.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.blitFramebuffer(0, 0, w, h, 0, 0, w * stride, h * stride, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  }

  // ---- Picture reuse: the machinery (see the state's own comment, above) ----

  // Everything besides the view that decides what color a world point is
  // drawn. Two pictures with the same key are pictures of the same thing.
  function reuseLookKey() {
    return [sceneGeneration, renderedSteps(), simulationSteps, displayMode ? displayMode.id : 0,
      colorZoomEnabled ? 1 : 0, bounceMaxValue, canvas.width, canvas.height].join(" ");
  }

  function reuseDropSource() {
    freeTarget(reuse.source);
    reuse.source = null;
    reuse.run = null;
  }

  // Called as a run starts: the accumulator is about to become a picture of
  // THIS view. Not while the timeline is moving - a run drawn across several
  // steps is a picture of no one step.
  function reuseNoteImage() {
    if (timeline.playing || timeline.following) { reuse.image = null; return; }
    reuse.image = {
      center: { x: view.center.x, xLo: view.center.xLo, y: view.center.y, yLo: view.center.yLo },
      scale: view.scale, look: reuseLookKey(), precision: effectivePrecision(),
    };
  }

  // to - from along one axis of two double-double centres, keeping the
  // digits a plain (hi - hi) + (lo - lo) rounds away: at the zoom limit a
  // whole pan lives in the low halves, and whether it was a whole number of
  // pixels is exactly what is being asked.
  function reuseCentreDelta(from, to, axis) {
    var lows = PhysicsDF.twoSum64(to[axis + "Lo"], -from[axis + "Lo"]);
    return ((to[axis] - from[axis]) + lows[0]) + lows[1];
  }

  // Works out how the source maps onto the view about to be rendered.
  //
  // A pixel p of this view (its center at p + 0.5, which is what
  // gl_FragCoord reports) shows the source's texel floor(a * (p + 0.5) + b):
  // both views place pixel centers at centre + ((p + 0.5 - size/2) / height)
  // * scale, so a is the ratio of the scales and b is what is left over.
  function reusePlanRun() {
    reuse.run = null;
    if (!reuse.source || timeline.playing || timeline.following) return;
    var W = canvas.width, H = canvas.height;
    if (reuse.source.width !== W || reuse.source.height !== H) { reuseDropSource(); return; }
    if (reuse.look !== reuseLookKey()) return;
    var a = view.scale / reuse.scale;
    if (!(a > 0) || !isFinite(a)) return;
    // See the state's comment: their colors depend on the zoom.
    if (displayMode.id !== 0 && a !== 1) return;
    var perWorld = H / reuse.scale;
    var bx = 0.5 * W * (1 - a) + perWorld * reuseCentreDelta(reuse.center, view.center, "x");
    var by = 0.5 * H * (1 - a) + perWorld * reuseCentreDelta(reuse.center, view.center, "y");
    var samePrecision = reuse.precision === effectivePrecision();
    // The same view at a different precision is the user asking what the
    // OTHER arithmetic makes of it; the old answer is no preview of that.
    if (a === 1 && bx === 0 && by === 0 && !samePrecision) return;
    // Exact when every sample this run will want is one the source HAS: the
    // source holds a true sample at every reuse.stride-th pixel (its blocks
    // are that sample, magnified - see reuseCapture), this run samples pixels
    // that are multiples of its own last stride, and the pan between them is
    // a whole number of source samples. At one simulation per pixel that is
    // "a pan by whole pixels", which is all this used to allow; stopping the
    // ladder at 2px (the Low preset) it is a pan by whole 2x2 blocks - and
    // without it that preset, the one that can least afford to, re-simulated
    // the entire screen after every pan.
    var sourceStride = reuse.stride;
    var snappedX = Math.round(bx / sourceStride) * sourceStride, snappedY = Math.round(by / sourceStride) * sourceStride;
    var exact = a === 1 && sourceStride >= 1 && sourceStride <= endStride() && samePrecision &&
      Math.abs(bx - snappedX) < 1e-4 && Math.abs(by - snappedY) < 1e-4;
    if (exact) { bx = snappedX; by = snappedY; }
    // The pixels of this view the source has something for.
    var x0 = clamp(Math.ceil(-bx / a - 0.5), 0, W), x1 = clamp(Math.ceil((W - bx) / a - 0.5), 0, W);
    var y0 = clamp(Math.ceil(-by / a - 0.5), 0, H), y1 = clamp(Math.ceil((H - by) / a - 0.5), 0, H);
    if (x1 <= x0 || y1 <= y0) return;
    // Of those, the ones whose source texel (p + b, for an exact run) had
    // been antialiased - see levelSimRegion.
    var aa = null, r = reuse.aaRect;
    if (exact && r) {
      aa = { x0: Math.max(x0, r.x0 - bx), y0: Math.max(y0, r.y0 - by), x1: Math.min(x1, r.x1 - bx), y1: Math.min(y1, r.y1 - by) };
      if (aa.x1 <= aa.x0 || aa.y1 <= aa.y0) aa = null;
    }
    reuse.run = {
      a: a, bx: bx, by: by, exact: exact, aa: aa,
      // How coarse the source looks from here, in this view's pixels.
      effStride: reuse.stride / a,
      x0: x0, y0: y0, x1: x1, y1: y1,
      coverage: ((x1 - x0) * (y1 - y0)) / (W * H),
      ladderWon: false,
    };
  }

  // Whether the ladder's own picture should be on screen rather than the
  // source: once it has a finished level at least as fine as the source
  // looks from here. Ties go to the ladder - its samples sit exactly on this
  // view's pixels, where the source's were resampled - and so does reaching
  // the end of the ladder, which is as good as this view gets.
  function reuseLadderWins() {
    var run = reuse.run;
    if (!run) return true;
    if (run.ladderWon) return true;
    if (progressive.accumStride > 0 && progressive.accumStride <= Math.max(run.effStride, endStride())) run.ladderWon = true;
    return run.ladderWon;
  }

  // Called as a run is abandoned, BEFORE its state is cleared: decides
  // whether the picture the ladder had reached should replace the source.
  // It does when the ladder had bettered the source (or there was none), and
  // when the source has slid mostly off screen; otherwise the source is
  // still the best picture there is of this neighbourhood, and stays.
  function reuseCapture() {
    var image = reuse.image;
    if (!image || !accum[accumIndex]) return;
    var fromAa = progressive.complete && progressive.aaSample > 0 && !!aaAccum;
    var stride = fromAa ? 1 : progressive.accumStride;
    if (!(stride > 0)) return;
    var run = reuse.run;
    if (run && !reuseLadderWins() && run.coverage >= REUSE_KEEP_COVERAGE) return;
    var W = canvas.width, H = canvas.height;
    if (reuse.source && (reuse.source.width !== W || reuse.source.height !== H)) reuseDropSource();
    try {
      if (!reuse.source) reuse.source = makeTarget(W, H);
      if (!presentProgram) presentProgram = buildPresentProgram();
    } catch (err) {
      reuseDropSource();
      return;
    }
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    if (fromAa) {
      // The finished average. A float target, so not something a blit can
      // read - the same reason presentFrame draws it rather than blits it.
      gl.bindFramebuffer(gl.FRAMEBUFFER, reuse.source.fbo);
      drawPresent(aaAccum.tex, W, H);
    } else {
      // The last finished level, magnified exactly as presentLevel puts it
      // on the canvas. While antialiasing is still under way this is the
      // accumulator rather than the half-built average: pure pixel-center
      // samples, which a pan can reuse and antialias afresh.
      var w = levelWidth(stride), h = levelHeight(stride);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, accum[accumIndex].fbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, reuse.source.fbo);
      gl.blitFramebuffer(0, 0, w, h, 0, 0, w * stride, h * stride, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    reuse.center = image.center;
    reuse.scale = image.scale;
    reuse.look = image.look;
    reuse.precision = image.precision;
    reuse.stride = stride;
    // Finished everywhere if the run was (either the average is in, or this
    // run had none to do). Otherwise only where this run's own pixels were
    // copies of finished ones - which, the picture being this run's view,
    // is just the rectangle it skipped.
    reuse.aaRect = progressive.complete ? { x0: 0, y0: 0, x1: W, y1: H }
      : (stride === 1 && run && run.exact ? run.aa : null);
    reuse.image = null;
  }

  // The part of a level that still has to be SIMULATED, as rectangles in the
  // level's own coordinates, plus the one rectangle the source covers.
  // Without exact reuse that is simply the whole level.
  //
  // Sample i of a level stands for full-resolution pixel i * stride + origin
  // (see worldCoordLines), so it is covered when that pixel is. The covered
  // samples of any level form a rectangle, and what is left around it is at
  // most four more: below, left, right, above.
  function levelSimRegion(stride, originX, originY, forAntialias) {
    var w = levelWidth(stride), h = levelHeight(stride);
    var whole = { rects: [{ x: 0, y: 0, w: w, h: h }], covered: null, rows: h };
    var run = reuse.run;
    if (!run || !run.exact) return whole;
    // An antialiasing pass is only skipped where the source's pixels had
    // already been antialiased; its other pixels are plain samples like any
    // the ladder draws, and get their average the usual way.
    var have = forAntialias ? run.aa : run;
    if (!have) return whole;
    var cx0 = clamp(Math.ceil((have.x0 - originX) / stride), 0, w);
    var cx1 = clamp(Math.floor((have.x1 - 1 - originX) / stride) + 1, 0, w);
    var cy0 = clamp(Math.ceil((have.y0 - originY) / stride), 0, h);
    var cy1 = clamp(Math.floor((have.y1 - 1 - originY) / stride) + 1, 0, h);
    if (cx1 <= cx0 || cy1 <= cy0) return whole;
    var rects = [];
    if (cy0 > 0) rects.push({ x: 0, y: 0, w: w, h: cy0 });
    if (cx0 > 0) rects.push({ x: 0, y: cy0, w: cx0, h: cy1 - cy0 });
    if (cx1 < w) rects.push({ x: cx1, y: cy0, w: w - cx1, h: cy1 - cy0 });
    if (cy1 < h) rects.push({ x: 0, y: cy1, w: w, h: h - cy1 });
    var rows = 0;
    rects.forEach(function (r) { rows += r.h; });
    return { rects: rects, covered: { x: cx0, y: cy0, w: cx1 - cx0, h: cy1 - cy0 }, rows: rows };
  }

  // progressive.band counts rows through a region's rectangles one after
  // another, so that "band = 0" still means "start of the pass" and "band =
  // rows" still means "done" whatever shape the region is. This is which
  // rectangle a band falls in and how far down it, or null past the end.
  function locateBand(region, band) {
    for (var i = 0; i < region.rects.length; i++) {
      if (band < region.rects[i].h) return { rect: region.rects[i], row: band };
      band -= region.rects[i].h;
    }
    return null;
  }

  // Where sub-lattice k of a step from `stride` to stride/2 sits: the new
  // sample positions the coarser grid didn't already cover - offset by half
  // a cell across, down, or both. (0 is the base level, at no offset.)
  function sublatticeOrigin(k, stride) {
    var half = stride / 2;
    return { x: (k === 0 || k === 2) ? 0 : half, y: (k === 0 || k === 1) ? 0 : half };
  }

  // How many rows the pass in progress has to draw - what progressive.band
  // is counting towards.
  function currentPassRows() {
    if (progressive.aaSample > 0) return levelSimRegion(1, 0, 0, true).rows;
    var stride = progressive.stride || startStride();
    var origin = sublatticeOrigin(progressive.sublattice, stride);
    return levelSimRegion(stride, origin.x, origin.y, false).rows;
  }

  var REUSE_FILL_FRAGMENT_SOURCE = [
    "#version 300 es",
    "precision highp float;",
    "uniform sampler2D u_source;",
    "uniform int u_stride;",
    "uniform ivec2 u_origin;",   // the level's origin plus the pan, in source texels
    "out vec4 fragColor;",
    "void main() {",
    "  fragColor = texelFetch(u_source, ivec2(gl_FragCoord.xy) * u_stride + u_origin, 0);",
    "}",
  ].join("\n");
  // The screen while the source is still the better picture: the source
  // wherever it has a texel for the pixel, the ladder's latest level where
  // it has not, and a dim smear of the source's edge where neither has
  // anything yet.
  var REUSE_PRESENT_FRAGMENT_SOURCE = [
    "#version 300 es",
    "precision highp float;",
    "uniform sampler2D u_source;",
    "uniform sampler2D u_ladder;",
    "uniform int u_ladderStride;",   // 0: the ladder has no finished level yet
    "uniform float u_a;",
    "uniform vec2 u_b;",
    "uniform ivec2 u_sourceSize;",
    "out vec4 fragColor;",
    "void main() {",
    "  ivec2 q = ivec2(floor(u_a * gl_FragCoord.xy + u_b));",
    "  if (all(greaterThanEqual(q, ivec2(0))) && all(lessThan(q, u_sourceSize))) {",
    "    fragColor = vec4(texelFetch(u_source, q, 0).rgb, 1.0);",
    "  } else if (u_ladderStride > 0) {",
    "    fragColor = vec4(texelFetch(u_ladder, ivec2(gl_FragCoord.xy) / u_ladderStride, 0).rgb, 1.0);",
    "  } else {",
    // Neither picture has this pixel yet - the strip a drag has just pulled
    // into view, before anything has been rendered for it. The source's
    // nearest edge, well dimmed: plainly a placeholder, but one that belongs
    // to the picture beside it, where solid black read as the map tearing.
    "    ivec2 edge = clamp(q, ivec2(0), u_sourceSize - 1);",
    "    fragColor = vec4(texelFetch(u_source, edge, 0).rgb * 0.3, 1.0);",
    "  }",
    "}",
  ].join("\n");
  var reusePrograms = null;
  function ensureReusePrograms() {
    if (reusePrograms) return reusePrograms;
    function build(source, names) {
      var prog = PhysicsGPU.linkProgram(gl, vs, PhysicsGPU.compileShader(gl, gl.FRAGMENT_SHADER, source));
      var out = { program: prog, posLoc: gl.getAttribLocation(prog, "a_position"), uniforms: {} };
      names.forEach(function (n) { out.uniforms[n] = gl.getUniformLocation(prog, "u_" + n); });
      return out;
    }
    reusePrograms = {
      fill: build(REUSE_FILL_FRAGMENT_SOURCE, ["source", "stride", "origin"]),
      present: build(REUSE_PRESENT_FRAGMENT_SOURCE, ["source", "ladder", "ladderStride", "a", "b", "sourceSize"]),
    };
    return reusePrograms;
  }

  // Exact reuse: writes the source's pixels into the covered part of a
  // level's target, in place of simulating them.
  function reuseFillCovered(target, stride, originX, originY, region) {
    if (!region.covered) return;
    var prog = ensureReusePrograms().fill, c = region.covered;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, levelWidth(stride), levelHeight(stride));
    gl.disable(gl.BLEND);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(c.x, c.y, c.w, c.h);
    gl.useProgram(prog.program);
    bindQuad(prog.posLoc);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, reuse.source.tex);
    gl.uniform1i(prog.uniforms.source, 0);
    gl.uniform1i(prog.uniforms.stride, stride);
    gl.uniform2i(prog.uniforms.origin, originX + reuse.run.bx, originY + reuse.run.by);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // `level` is what presentLevel would have been handed, or null when the
  // ladder has nothing finished yet.
  function presentWithSource(level) {
    var prog = ensureReusePrograms().present, run = reuse.run;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.useProgram(prog.program);
    bindQuad(prog.posLoc);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, level ? level.target.tex : reuse.source.tex);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, reuse.source.tex);
    gl.uniform1i(prog.uniforms.source, 0);
    gl.uniform1i(prog.uniforms.ladder, 1);
    gl.uniform1i(prog.uniforms.ladderStride, level ? level.stride : 0);
    gl.uniform1f(prog.uniforms.a, run.a);
    gl.uniform2f(prog.uniforms.b, run.bx, run.by);
    gl.uniform2i(prog.uniforms.sourceSize, reuse.source.width, reuse.source.height);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  // Draws about `pixelsAvailable` simulated pixels' worth more of whatever
  // is currently in progress - either the base level (sub-lattice 0,
  // straight into the accumulator) or one of the three sub-lattices that
  // refine it. Returns what it actually cost, in those same pixels, so the
  // budget loop can charge itself the real figure rather than what it asked
  // for; 0 means the level has nothing left to draw.
  //
  // The three sub-lattices of a step from stride s to s/2 are exactly the
  // new sample positions the coarser grid didn't already cover: offset by
  // half a cell across, down, or both.
  function drawSublatticeBand(pixelsAvailable) {
    var k = progressive.sublattice;
    var w = levelWidth(progressive.stride);
    var h = levelHeight(progressive.stride);
    var target = k === 0 ? accum[accumIndex] : sublattices[k - 1];
    var origin = sublatticeOrigin(k, progressive.stride), originX = origin.x, originY = origin.y;
    // The whole level, unless a pan is reusing the last picture's pixels -
    // then only what it exposed, the rest being copied in as the pass starts.
    var region = levelSimRegion(progressive.stride, originX, originY, false);
    if (progressive.band === 0 && progressive.tileX === 0 && !progressive.tile) {
      reuseFillCovered(target, progressive.stride, originX, originY, region);
      if (region.rows === 0) return REUSE_FREE_COST;
    }
    var at = locateBand(region, progressive.band);
    if (!at) return 0;
    // Above float32: a slice of a tile rather than a band of whole
    // simulations - see "Sliced rendering".
    var slicedPrograms = slicedProgramsForGrid();
    if (slicedPrograms) {
      return drawSlicedTile(slicedPrograms, { target: target, w: w, h: h, stride: progressive.stride,
        originX: originX, originY: originY, blend: 0, region: region }, pixelsAvailable);
    }
    var rect = at.rect;
    var rows = Math.min(Math.max(MIN_BAND_ROWS, Math.floor(pixelsAvailable / Math.max(rect.w, 1))), rect.h - at.row);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, w, h);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(rect.x, rect.y + at.row, rect.w, rows);
    drawSublattice(progressive.stride, originX, originY);
    perfStats.drawsThisFrame += 1;
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    progressive.band += rows;
    return rows * rect.w;
  }

  // Gathers the accumulator plus `shown` of the current level's sub-lattices
  // into the spare accumulator, at the finer level's size. Returns that
  // target so the caller can decide whether to adopt it (the level is
  // finished and this is now the authoritative picture) or merely show it
  // (a mid-level preview, where the real accumulator must be kept intact
  // because the next composite still has to read it).
  function runComposite(shown) {
    var dst = accum[1 - accumIndex];
    var fineW = levelWidth(progressive.stride / 2);
    var fineH = levelHeight(progressive.stride / 2);
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.viewport(0, 0, fineW, fineH);
    gl.disable(gl.SCISSOR_TEST);
    gl.useProgram(compositeProgram.program);
    bindQuad(compositeProgram.posLoc);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, accum[accumIndex].tex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, sublattices[0].tex);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, sublattices[1].tex);
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, sublattices[2].tex);
    gl.uniform1i(compositeProgram.uniforms.accum, 0);
    gl.uniform1i(compositeProgram.uniforms.subA, 1);
    gl.uniform1i(compositeProgram.uniforms.subB, 2);
    gl.uniform1i(compositeProgram.uniforms.subC, 3);
    gl.uniform1i(compositeProgram.uniforms.shown, shown);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { target: dst, w: fineW, h: fineH, stride: progressive.stride / 2 };
  }

  // Exactly one canvas update per frame, at the end of it.
  //
  // Not one per composite: a single panning frame walks a dozen levels, and
  // every blit to the canvas writes a full screen of pixels regardless of
  // how coarse the level behind it was. Blitting each intermediate level
  // would cost a dozen screen-sized writes to show twelve pictures in
  // 16ms, of which the user can see exactly one - the last.
  function presentFrame() {
    updateRenderProgressRing();
    if (progressive.aaSample > 0 && aaAccum) {
      drawPresent(aaAccum.tex, canvas.width, canvas.height);
      return;
    }
    var level = null;
    if (progressive.sublattice > 1) {
      // Mid-level: show a preview that includes the sub-lattices finished
      // so far, without disturbing the accumulator the next composite reads.
      level = runComposite(progressive.sublattice - 1);
    } else if (progressive.accumStride > 0) {
      level = { target: accum[accumIndex], w: levelWidth(progressive.accumStride),
        h: levelHeight(progressive.accumStride), stride: progressive.accumStride };
    }
    // Picture reuse: until the ladder has bettered it, the last picture
    // stays up, with the ladder's output only where it has nothing.
    if (!reuseLadderWins()) presentWithSource(level);
    else if (level) presentLevel(level.target, level.w, level.h, level.stride);
  }

  // One frame's worth of refinement. Spends up to the current pixel budget
  // and returns, leaving whatever is left for the next frame.
  function stepProgressive(now) {
    if (!ensureTargets()) return;
    if (progressive.stride === 0) beginProgressive();
    if (progressive.complete) {
      // Genuinely idle - nothing left to refine until the view changes.
      // Forgetting the timestamp here (rather than in finishRun) is what
      // keeps the budget honest during a drag: every frame of a drag
      // restarts AND completes a whole run, so clearing it on completion
      // meant noteFrameTiming saw no previous work frame on any of them
      // and the budget got no feedback for the entire gesture - it kept
      // whatever value the last settled refinement had left it at, which
      // is a frame's worth of work for a run that RESUMES, and several
      // frames' worth for one that starts over from the coarsest level.
      ladderBudget.lastWorkAt = 0;
      ladderBudget.lastSpent = 0;
      return;
    }

    // Each (precision, display mode) has its own measured throughput - a df
    // pixel costs many times a float32 one, and a derived mode five times a
    // standard one - so each keeps its own budget rather than inheriting one
    // tuned to something else and spending its first frames finding out.
    var drawingWith = budgetFor(effectivePrecision(), wantedVariant());
    if (drawingWith !== ladderBudget) {
      ladderBudget = drawingWith;
      ladderBudget.lastWorkAt = 0;
      ladderBudget.lastSpent = 0;
    }
    // See f32SlicedPending: nothing safe to draw yet.
    if (f32SlicedPending()) return;
    // See "...and never more than a frame behind". Before the timing below,
    // deliberately: the interval it measures should run from one frame of
    // work being issued to the GPU being free for the next.
    if (lastFrameStillRunning(now)) { perfStats.busyWaits += 1; return; }
    gpuTimerPoll(now);
    adaptSliceSteps(noteFrameTiming(ladderBudget, now));
    sliceFrameMs = 0;
    perfStats.drawsThisFrame = 0;
    var pixelBudget = ladderBudget.budget;
    gpuTimerBegin();
    try {
      stepProgressiveWork(pixelBudget);
    } finally {
      gpuTimerEnd(ladderBudget, ladderBudget.lastSpent);
      noteFrameIssued(now);
      perfStats.drawsLastFrame = perfStats.drawsThisFrame;
      notePerfRunProgress(now);
    }
  }

  function stepProgressiveWork(pixelBudget) {
    var spent = 0;

    // Antialiasing runs on the same budget, banding and present path as
    // everything else - a whole-screen sample is as expensive as the entire
    // ladder that preceded it, so it emphatically cannot be one draw.
    if (progressive.aaSample > 0) {
      while (spent < pixelBudget || spent === 0) {
        var aaCost = drawAaBand(pixelBudget - spent);
        if (aaCost === 0) break;
        spent += aaCost;
        if (progressive.band < currentPassRows()) continue;
        progressive.aaSample += 1;
        progressive.band = 0;
        updateResolutionBoundsUI();
        if (progressive.aaSample >= MAX_AA_SAMPLES) return finishRun(spent);
      }
      ladderBudget.lastSpent = spent;
      presentFrame();
      return;
    }

    var width = levelWidth(progressive.stride);
    var levelChanged = false;

    // Always draw at least one band per frame, however tight the budget: a
    // budget small enough to afford nothing would stall refinement
    // completely, and forward progress matters more than hitting the frame
    // target exactly on a machine that cannot.
    while (spent < pixelBudget || spent === 0) {
      var bandCost = drawSublatticeBand(pixelBudget - spent);
      if (bandCost === 0) break;
      spent += bandCost;
      if (progressive.band < currentPassRows()) continue;

      if (progressive.sublattice === 0) {
        // The base level just landed; it IS the accumulator already.
        progressive.accumStride = progressive.stride;
        progressive.sublattice = 1;
        progressive.band = 0;
        levelChanged = true;
        if (progressive.stride <= endStride()) return finishRun(spent);
        continue;
      }

      if (progressive.sublattice < 3) {
        progressive.sublattice += 1;
        progressive.band = 0;
        continue;
      }

      // All three sub-lattices are in: fold them into the accumulator and
      // drop to the next level down the ladder.
      runComposite(3);
      accumIndex = 1 - accumIndex;
      progressive.stride /= 2;
      progressive.accumStride = progressive.stride;
      progressive.sublattice = 1;
      progressive.band = 0;
      levelChanged = true;
      if (progressive.stride <= endStride()) return finishRun(spent);
      width = levelWidth(progressive.stride);
    }
    ladderBudget.lastSpent = spent;
    presentFrame();
    if (levelChanged) updateResolutionBoundsUI();
  }

  // `spent` is what this frame dispatched before finishing. It has to be
  // recorded here too, not just on the ordinary path: during a drag EVERY
  // frame both restarts and finishes a run, so if the finishing path
  // forgot its pixel count the budget would be handed an interval with
  // nothing to attribute it to and would never adapt during a gesture -
  // exactly the case where adapting matters most.
  function finishRun(spent) {
    ladderBudget.lastSpent = spent || 0;
    // The ladder is done. If antialiasing is on, this isn't the end of the
    // work, just the end of the first sample - and only when the ladder
    // actually reached one simulation per pixel, since averaging offset
    // samples of a deliberately coarse render would just blur the blocks.
    if (progressive.aaSample === 0 && endStride() <= 1 && antialiasWanted() &&
        progressive.accumStride === 1 && beginAntialias()) {
      progressive.band = 0;
      presentFrame();
      updateResolutionBoundsUI();
      return;
    }
    progressive.complete = true;
    progressive.sublattice = 1; // so presentFrame shows the accumulator, not a preview
    presentFrame();
    updateResolutionBoundsUI();
    deliverStill();
  }

  // The canvas backing store is now always the full device-pixel
  // resolution - the refinement ladder, not the canvas size, is what
  // adapts to how much the machine can afford. A resize throws away every
  // target (they are all sized to the old canvas) and restarts refinement.
  //
  // canvasArea can be display:none here: the app shell shares one document
  // with the editor, so this is a real and frequent case rather than a
  // theoretical one. A hidden area has clientWidth/clientHeight of 0, which
  // would floor to a 1x1 canvas and throw away the real image for nothing,
  // so skip entirely and let the ResizeObserver below call back once it has
  // a size again.
  //
  // What the VIEW does about a resize depends on what resized it. view.scale
  // is the world the canvas spans top to bottom, so left alone it keeps the
  // same world in a canvas of any height: drag a window taller and the
  // picture grows with it, centre held. Right for a window - and wrong for
  // the small-window layout's dock, which opens a sheet over the bottom half
  // of the screen: the half of the map still showing would shrink to half
  // size and slide up. For that one case (pinViewCornerOnResize, set by the
  // dock and spent on the very next resize) the picture stays exactly where
  // it is instead: same world per pixel, same world point in the top-left
  // corner, the sheet simply covering or uncovering what is beneath it.
  var pinViewCornerOnResize = false;
  function pinViewTopLeft(oldW, oldH, newW, newH) {
    if (!(oldW > 1 && oldH > 1)) return; // never sized before: nothing on screen to hold still
    var oldScale = view.scale;
    var newScale = clamp(oldScale * newH / oldH, MIN_SCALE, MAX_SCALE);
    // The corner is centre + (-W/2H, +1/2) view-heights; holding it still
    // while W, H and the scale change gives these two shifts. As exact
    // products, for zoomAtClientPoint's reason: at a deep zoom a rounded one
    // is a permanent error in where the centre is.
    shiftViewCenterByProducts(0.5 * (newW - oldW) / oldH, oldScale, 0.5, oldScale - newScale);
    view.scale = newScale;
    updateZoomReadout();
  }
  function resizeCanvas() {
    if (canvasArea.clientWidth <= 0 || canvasArea.clientHeight <= 0) return;
    var dpr = gridDpr();
    // A capped backing store is stretched to the display by a ratio that is
    // not a whole number (2 -> 3 is 1.5), and nearest-neighbour at such a
    // ratio makes every other pixel twice the width of its neighbours. The
    // stylesheet's pixelated rendering is right for the uncapped canvas it
    // was written for; this hands the stretched one back to smooth scaling.
    canvas.classList.toggle("is-upscaled", dpr < (window.devicePixelRatio || 1));
    var w = Math.max(1, Math.round(canvasArea.clientWidth * dpr));
    var h = Math.max(1, Math.round(canvasArea.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      if (pinViewCornerOnResize) pinViewTopLeft(canvas.width, canvas.height, w, h);
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
      markDirty();
      // The Analysis card's charts size themselves to the card, and the
      // sampling readout in Settings is a fraction of THIS size - so both
      // are told, whether or not anyone is looking at them. (The
      // measurement itself reads the canvas when it runs and is never
      // stale; it is only the readout that would be.)
      if (statsPanel) {
        if (statsOpen) statsPanel.relayout();
        updateStatsSampleReadout();
      }
    }
    // Spent whether or not the size changed: it was about THIS resize.
    pinViewCornerOnResize = false;
  }

  function formatZoom(z) {
    if (z >= 1e4 || (z > 0 && z < 1e-2)) return z.toExponential(2) + "×";
    return z.toFixed(2) + "×";
  }
  function updateZoomReadout() {
    zoomReadout.textContent = "Zoom: " + formatZoom(DEFAULT_SCALE / view.scale);
  }

  function pixelToUV(clientX, clientY) {
    var rect = canvas.getBoundingClientRect();
    var fx = (clientX - rect.left) * (canvas.width / rect.width);
    var fy = (clientY - rect.top) * (canvas.height / rect.height);
    return {
      uvx: (fx - 0.5 * canvas.width) / canvas.height,
      uvy: (0.5 * canvas.height - fy) / canvas.height,
    };
  }

  // Rescales the view so whatever world point currently sits under
  // (clientX, clientY) still sits there afterward - "zoom toward the
  // pointer," the same anchor math a trackpad/mouse wheel zoom and a touch
  // pinch both need. Shared by the wheel handler below and the pinch-zoom
  // touch handler further down, rather than kept as two copies of the same
  // three lines.
  function zoomAtClientPoint(clientX, clientY, factor) {
    var uv = pixelToUV(clientX, clientY);
    var oldScale = view.scale;
    view.scale = clamp(view.scale * factor, MIN_SCALE, MAX_SCALE);
    // The anchored point is center + uv*oldScale before and center' +
    // uv*newScale after, so center' = center + uv*(oldScale - newScale) -
    // written as that SHIFT rather than by forming the world point and
    // subtracting again, which would round the point to a float64.
    //
    // And the shift is formed EXACTLY, not as a float64 product. A rounded
    // product is off by ~1e-16 of itself, which is nothing at the zoom where
    // it happens (1e-13 of a pixel) - but it is a permanent error in where
    // the centre is, and every later notch magnifies it. Measured with the
    // cursor held still: the point under it had slid half a pixel after
    // zooming in by 2e13, and two million pixels after 1e20 - exactly the
    // range the precisions above double-float exist for. (oldScale -
    // newScale is itself exact: the two are within a factor of two.)
    shiftViewCenterByProducts(uv.uvx, oldScale - view.scale, uv.uvy, oldScale - view.scale);
  }

  // ---- Gestures first ----
  //
  // There is no such thing as priority on a GPU a page can reach. WebGL has
  // one queue: draws run in the order they were issued, each to completion,
  // and nothing - not a newer draw, not the browser's own compositor - gets
  // in ahead of one that is already there. "Prioritise the pan over the
  // render" can therefore only mean one thing: while a pan is happening,
  // don't ISSUE the render. Whatever is in the queue when a finger moves is
  // what the finger waits behind.
  //
  // That wait is what a drag felt like on a phone. Every frame of a drag
  // restarted the ladder and spent a frame's budget on it - 25ms of
  // simulation by design, several times that when the budget had been set by
  // settled rendering - and the browser lets a page run two or three frames
  // ahead of the screen. The picture followed the finger by the sum.
  //
  // So, with Settings > Performance Settings > Prioritize panning and zooming
  // on, a frame in the middle of a gesture simulates nothing. It draws the
  // last picture moved and scaled to where the view is NOW
  // (presentWithSource - one textured quad, a fraction of a millisecond), and
  // that is the whole frame. The ladder starts again the moment the gesture
  // stops: the finger lifting, or holding still for GESTURE_SETTLE_MS. What a
  // drag pulls into view shows the source's dimmed edge until then (see
  // REUSE_PRESENT_FRAGMENT_SOURCE), and what it leaves alone is never redrawn
  // at all, settled or not (see reusePlanRun on exact reuse).
  //
  // It needs a picture to move, so it needs Reuse Last Picture; without one
  // (the setting off, nothing finished yet, a derived display mode mid-zoom,
  // the timeline playing) presentGestureFrame declines and the frame is an
  // ordinary one.
  //
  // A finger that has only just LANDED counts as a gesture too, before it has
  // moved at all: a touch precedes its first movement by a few frames, and
  // those are exactly the frames in which the queue can drain, so that the
  // first movement has nothing to wait behind.
  var GESTURE_SETTLE_MS = 140;
  var gesture = { down: false, downAt: -1e9, movedAt: -1e9, wheelAt: -1e9 };
  function noteGestureDown() { gesture.down = true; gesture.downAt = performance.now(); }
  function noteGestureUp() { gesture.down = false; }
  function noteGestureMoved() { gesture.movedAt = performance.now(); }
  function gestureInProgress(now) {
    if (!perf.gestureFirst) return false;
    // A wheel has no "down": it is a gesture for as long as notches keep coming.
    if (now - gesture.wheelAt < GESTURE_SETTLE_MS) return true;
    return gesture.down && now - Math.max(gesture.downAt, gesture.movedAt) < GESTURE_SETTLE_MS;
  }
  // The whole of a gesture's frame, when it can be: returns false when this
  // frame should be an ordinary one instead.
  function presentGestureFrame(now) {
    if (!reuseEnabled || stillJob || !gestureInProgress(now)) return false;
    // Either way the ladder is sitting this frame out, and an interval with
    // no work in it must not be read as a slow frame (see stepProgressive's
    // own note on why idle frames are forgotten).
    function sitOut() {
      ladderBudget.lastWorkAt = 0;
      ladderBudget.lastSpent = 0;
      perfStats.presentOnlyAt = now;
      return true;
    }
    // A run is in progress or finished, so the view has not moved since it
    // began (moving it resets the run): the right picture is already up.
    if (progressive.stride !== 0 || progressive.complete) return sitOut();
    if (!ensureTargets()) return false;
    reusePlanRun();
    if (!reuse.run) return false;
    presentWithSource(null);
    // What beginProgressive would have done for a run that began this frame:
    // the markers are positioned against the view, which has just moved.
    updateInspectMarkers();
    return sitOut();
  }

  // ---- ...and never more than a frame behind ----
  //
  // The other half of the same problem. With Work per frame set long, a frame
  // of rendering is 50ms of GPU time by design, and a browser that lets the
  // page get two or three of those ahead has put a sixth of a second between
  // anything the user does and the screen - before the first frame of a
  // gesture can even be presented. So in that mode a frame of work is only
  // issued once the GPU has FINISHED the last one: a fence goes in behind
  // each frame's draws, and until it signals, animation frames simply pass.
  // The GPU idles for the fraction of a refresh between finishing and the
  // next animation frame, which is the price; the intervals noteFrameTiming
  // measures become true measurements of a frame's GPU time, which is a
  // bonus. With Work per frame at one display refresh nothing here runs.
  var frameInFlight = { sync: null, at: 0 };
  var FRAME_IN_FLIGHT_TIMEOUT_MS = 1500; // a fence that never signals must not end rendering
  function lastFrameStillRunning(now) {
    if (!frameInFlight.sync) return false;
    var done = perf.frameMs <= 0 || now - frameInFlight.at > FRAME_IN_FLIGHT_TIMEOUT_MS || gl.isContextLost() ||
      gl.getSyncParameter(frameInFlight.sync, gl.SYNC_STATUS) === gl.SIGNALED;
    if (!done) return true;
    gl.deleteSync(frameInFlight.sync);
    frameInFlight.sync = null;
    return false;
  }
  function noteFrameIssued(now) {
    if (perf.frameMs <= 0 || gl.isContextLost()) return;
    if (frameInFlight.sync) gl.deleteSync(frameInFlight.sync);
    frameInFlight.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    frameInFlight.at = now;
    // A fence is only ever seen to signal once the commands ahead of it have
    // actually been sent.
    gl.flush();
  }

  // A named function rather than an inline one because it is registered
  // twice: here on the canvas, and on every .inspect-marker dot as it is
  // created (see updateInspectMarkers). The dots are siblings of the canvas
  // stacked on top of it, so a wheel over one never reaches this listener
  // through the canvas - without their own registration, hovering a marker
  // silently blocked zooming.
  function onWheelZoom(e) {
    e.preventDefault();
    gesture.wheelAt = performance.now();
    zoomAtClientPoint(e.clientX, e.clientY, Math.pow(1.0016, e.deltaY));
    updateZoomReadout();
    markDirty();
  }
  canvas.addEventListener("wheel", onWheelZoom, { passive: false });

  // Pans the view by a raw pixel delta in CLIENT (CSS) pixels - "drag the
  // content by this many screen pixels." Shared by the mouse-drag pan below
  // and both touch gestures further down (a one-finger drag, and a
  // two-finger pinch's own midpoint motion), instead of three copies of the
  // same conversion from screen pixels to world units.
  function panByClientDelta(dxPix, dyPix) {
    var scaleFactor = canvas.width / canvas.getBoundingClientRect().width;
    if (reuseEnabled) {
      // Picture reuse: a pan by a WHOLE number of device pixels lands every
      // pixel of the new view on a pixel of the old one, which is what lets
      // the old one's be reused as they are. The fraction set aside is
      // carried into the next move, so a slow drag still adds up.
      //
      // "Pixel" meaning one of the picture's own samples: with Resolution
      // Limits stopping the ladder at one simulation per 2x2 block, it is a
      // pan by whole BLOCKS that lands samples on samples (see reusePlanRun).
      // Only while a block is too small to see the snapping, though: with the
      // right-hand resolution handle dragged down to 64px, a map that moved
      // in 64-pixel jumps would be a high price for reusing so few samples.
      var REUSE_SNAP_MAX_STRIDE = 4;
      var snap = endStride() <= REUSE_SNAP_MAX_STRIDE ? endStride() : 1;
      var wantX = dxPix * scaleFactor + reuse.panCarryX, wantY = dyPix * scaleFactor + reuse.panCarryY;
      var wholeX = Math.round(wantX / snap) * snap, wholeY = Math.round(wantY / snap) * snap;
      reuse.panCarryX = wantX - wholeX;
      reuse.panCarryY = wantY - wholeY;
      var worldPerDevicePixel = view.scale / canvas.height;
      shiftViewCenter(-wholeX * worldPerDevicePixel, wholeY * worldPerDevicePixel);
      return;
    }
    var worldPerPixel = (view.scale / canvas.height) * scaleFactor;
    shiftViewCenter(-dxPix * worldPerPixel, dyPix * worldPerPixel);
  }

  var dragging = false, lastClientX = 0, lastClientY = 0, dragDistance = 0;
  // Below this many total pixels of movement between mousedown and mouseup,
  // treat it as a click (lock a single Inspect point, or - with Line/Grid
  // armed - just show the "drag instead" toast) rather than a pan or an
  // Inspect drag - a real drag easily exceeds it within the first couple of
  // mousemoves.
  var CLICK_DRAG_THRESHOLD = 4;
  // A finger is not a mouse: it rolls a few pixels on the glass during a tap
  // that was never meant to move anything, and here every one of those
  // pixels is a pan - which throws away the picture and starts the
  // refinement ladder again. So a touch moves nothing at all until it has
  // travelled this far from where it landed, and one that never does is a
  // tap. Measured as distance from the press point, not as the path length
  // dragDistance adds up: a finger held still still jitters, and a jitter's
  // path length grows for as long as the finger rests there.
  var TOUCH_SLOP_PX = 10;
  var dragIsTouch = false, dragStartClientX = 0, dragStartClientY = 0;
  // False only for a touch that has not yet left its slop radius.
  var dragPastSlop = true;
  // The world point an Inspect-armed drag started at - see beginDrag below.
  // Only meaningful while inspectArmTakesDrag() && dragging.
  var inspectDragStartWorld = null;

  // Snapped to the same grid-cell resolution the hover preview itself
  // samples at (see handleDragMove below) - a locked point then corresponds
  // to an actual rendered cell, not an arbitrary sub-pixel float. Takes a
  // plain {clientX, clientY} rather than a real event, since a Touch object
  // carries exactly those same two fields and needs no adapting.
  function snappedWorldPointFromEvent(e) {
    var uv = pixelToUV(e.clientX, e.clientY);
    return snappedWorldPointAtUV(uv.uvx, uv.uvy);
  }

  // ---- One-finger drag: mouse and single-touch share this exact logic ----
  //
  // beginDrag/handleDragMove/endDrag take plain (clientX, clientY) pairs,
  // not an event, so both the mouse listeners below and the touch listeners
  // further down can call the same three functions instead of keeping two
  // hand-synced copies of "pan, or preview/commit an Inspect line or grid."
  function beginDrag(clientX, clientY, isTouch) {
    dragging = true;
    dragIsTouch = !!isTouch;
    dragStartClientX = lastClientX = clientX;
    dragStartClientY = lastClientY = clientY;
    dragDistance = 0;
    dragPastSlop = !dragIsTouch;
    if (inspectArmTakesDrag()) {
      // Don't pan while armed - see handleDragMove below. Recorded now (not
      // just at the end of the drag) so the line/rectangle preview starts
      // from the actual press point.
      inspectDragStartWorld = snappedWorldPointFromEvent({ clientX: clientX, clientY: clientY });
    } else {
      canvas.classList.add("dragging");
    }
  }
  function handleDragMove(clientX, clientY) {
    if (!dragPastSlop) {
      if (Math.hypot(clientX - dragStartClientX, clientY - dragStartClientY) < TOUCH_SLOP_PX) return;
      dragPastSlop = true;
      // Picked up from HERE, not from the press point: the slop is discarded
      // rather than delivered all at once as a jump. And whatever else comes
      // of this gesture, it is no longer a tap.
      lastClientX = clientX;
      lastClientY = clientY;
      dragDistance = CLICK_DRAG_THRESHOLD;
    }
    var dxPix = clientX - lastClientX;
    var dyPix = clientY - lastClientY;
    dragDistance += Math.abs(dxPix) + Math.abs(dyPix);
    lastClientX = clientX;
    lastClientY = clientY;
    if (inspectArmTakesDrag()) {
      // A click/tap doesn't start a line or grid at all (see endDrag) -
      // only once the drag is unambiguous does it commit to previewing one,
      // so a slightly-shaky press doesn't flash the preview for a moment.
      if (dragDistance >= CLICK_DRAG_THRESHOLD) {
        var current = snappedWorldPointFromEvent({ clientX: clientX, clientY: clientY });
        if (inspectArmMode === "line") updateInspectLinePreview(inspectDragStartWorld, current);
        else updateInspectGridPreview(inspectDragStartWorld, current);
      }
      return;
    }
    panByClientDelta(dxPix, dyPix);
    noteGestureMoved();
    markDirty();
  }
  function endDrag(clientX, clientY) {
    if (dragging) {
      var current = snappedWorldPointFromEvent({ clientX: clientX, clientY: clientY });
      // Hidden BEFORE lockLineOfPoints/lockGridOfPoints, not after: each one
      // synchronously compiles and runs a GPU trajectory per point (up to 21
      // of them for a grid), which is not instant - leaving the dashed
      // preview up until they return would freeze it on screen for that
      // entire stretch, reading as stuck/buggy rather than as "still
      // working." Releasing the drag should always retire the preview
      // immediately; the real mesh/line then appears whenever it's ready.
      hideInspectPreview();
      var wasTap = dragIsTouch ? !dragPastSlop : dragDistance < CLICK_DRAG_THRESHOLD;
      if (wasTap) {
        // A plain CLICK with nothing armed always locks a single Inspect
        // point - no button needed for this. With Line or Grid armed, a
        // plain click isn't enough to mean "make one of those" (a real drag
        // still has to default to panning, so that meaning needs an
        // unambiguous drag, not just a click), so it just reminds instead of
        // silently doing nothing, and leaves the mode armed for the drag
        // it's actually waiting for.
        if (inspectArmMode === "line") showInspectToast("Drag to inspect a line");
        else if (inspectArmMode === "grid") showInspectToast("Drag to inspect a grid");
        // Neither arms without the Inspect card open (their buttons live
        // inside it), so a collapsed card always reaches this branch with
        // nothing armed - exactly where a plain click otherwise locks a new
        // point. Collapsed means "not right now" (see makeMenu's own
        // comment), so this is the one thing that has to check for it
        // explicitly rather than relying on disarmInspect leaving nothing
        // else to do.
        else if (inspectMenu.isOpen()) {
          // A finger's TAP is the exception to "no button needed": it only
          // locks a point once Inspect (Point) has been armed (see
          // inspectArmMode's own comment). Unarmed it does nothing, and says
          // nothing - the card's own empty preview already says how, and a
          // toast for every stray touch of a map that is touched all the
          // time was more noise than help.
          if (inspectArmMode === "point" || !dragIsTouch) lockPointAt(current);
        }
      } else if (inspectArmMode === "line") {
        lockLineOfPoints(inspectDragStartWorld, current);
      } else if (inspectArmMode === "grid") {
        lockGridOfPoints(inspectDragStartWorld, current);
      }
      inspectDragStartWorld = null;
    }
    dragging = false;
    canvas.classList.remove("dragging");
  }

  canvas.addEventListener("mousedown", function (e) { noteGestureDown(); beginDrag(e.clientX, e.clientY, false); });
  window.addEventListener("mousemove", function (e) { if (dragging) handleDragMove(e.clientX, e.clientY); });
  window.addEventListener("mouseup", function (e) { noteGestureUp(); endDrag(e.clientX, e.clientY); });

  // ---- Touch: one finger pans (same beginDrag/handleDragMove/endDrag as
  // the mouse), two fingers pinch-zoom-and-pan at once ----
  //
  // #grid-canvas has touch-action:none (see fractal-grid.css) so the browser
  // never starts its own page-level scroll/pinch-zoom on these touches -
  // without that, the two would fight over the same gesture, which is
  // exactly "the whole UI moving around" instead of just the grid. Every
  // listener here is {passive:false} and calls preventDefault() so that
  // stays true even where touch-action alone isn't enough (some browsers
  // still fire a default action on multi-touch unless a handler cancels it
  // explicitly).
  //
  // A pinch is tracked by its two fingers' MIDPOINT and DISTANCE only, not
  // a full two-point affine fit - simpler, and indistinguishable in
  // practice from the full version for how a real pinch gesture moves.
  // Each frame does two composed steps against the CURRENT (already
  // touch-action:none-protected) view: panByClientDelta moves the view by
  // however far the midpoint itself travelled (a two-finger drag, e.g.
  // panning while pinching), then zoomAtClientPoint - anchored at the NEW
  // midpoint - applies whatever the pinch distance's change implies. Doing
  // the pan first and anchoring the zoom on the post-pan midpoint is what
  // keeps the pinch feeling anchored under the fingers even while they're
  // also translating.
  var pinchDistance = 0, pinchMidX = 0, pinchMidY = 0;

  function touchMidpoint(t0, t1) {
    return { x: (t0.clientX + t1.clientX) / 2, y: (t0.clientY + t1.clientY) / 2 };
  }
  function touchDistance(t0, t1) {
    return Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
  }

  canvas.addEventListener("touchstart", function (e) {
    e.preventDefault();
    noteGestureDown();
    if (e.touches.length === 1) {
      beginDrag(e.touches[0].clientX, e.touches[0].clientY, true);
    } else if (e.touches.length === 2) {
      // A second finger landing mid-drag supersedes whatever the first one
      // was doing (a pan, or an Inspect line/grid preview) - a pinch is never
      // an Inspect gesture.
      dragging = false;
      canvas.classList.remove("dragging");
      hideInspectPreview();
      inspectDragStartWorld = null;
      pinchDistance = touchDistance(e.touches[0], e.touches[1]);
      var mid = touchMidpoint(e.touches[0], e.touches[1]);
      pinchMidX = mid.x; pinchMidY = mid.y;
    }
  }, { passive: false });

  window.addEventListener("touchmove", function (e) {
    if (e.touches.length === 2) {
      e.preventDefault();
      var mid = touchMidpoint(e.touches[0], e.touches[1]);
      var dist = touchDistance(e.touches[0], e.touches[1]);
      panByClientDelta(mid.x - pinchMidX, mid.y - pinchMidY);
      // Inverted (old/new, not new/old): view.scale is world units per
      // screen pixel, so spreading fingers apart (dist increases) needs
      // view.scale to DECREASE - zooming in, the same direction as the
      // wheel handler's factor<1 branch - not increase. Two fingers reported
      // at one spot (it happens, as one of them lifts) have no ratio to
      // offer, and dividing by their zero would send the view to its limit.
      if (pinchDistance > 0 && dist > 0) zoomAtClientPoint(mid.x, mid.y, pinchDistance / dist);
      pinchMidX = mid.x; pinchMidY = mid.y; pinchDistance = dist;
      updateZoomReadout();
      noteGestureMoved();
      markDirty();
    } else if (e.touches.length === 1 && dragging) {
      e.preventDefault();
      handleDragMove(e.touches[0].clientX, e.touches[0].clientY);
    }
  }, { passive: false });

  function onTouchEnd(e) {
    if (e.touches.length === 0) {
      noteGestureUp();
      if (e.type === "touchcancel") {
        // The browser took the gesture away (an incoming call, a system
        // swipe): nothing the finger was part-way through gets committed.
        dragging = false;
        canvas.classList.remove("dragging");
        hideInspectPreview();
        inspectDragStartWorld = null;
        pinchDistance = 0;
        return;
      }
      // changedTouches, not the now-empty e.touches, has the lifted
      // finger's last known position - needed either to commit a one-finger
      // drag's Inspect tap/line/grid (endDrag) or, if this touch just ended a
      // pinch instead (dragging is already false then), to harmlessly reset
      // the "dragging" CSS class.
      var last = e.changedTouches[0];
      endDrag(last.clientX, last.clientY);
      pinchDistance = 0;
    } else if (e.touches.length === 2) {
      // Three fingers down to two: whichever two are left are not
      // necessarily the two the pinch was measured between, so it is
      // measured again from them rather than jumping by the difference.
      pinchDistance = touchDistance(e.touches[0], e.touches[1]);
      var mid = touchMidpoint(e.touches[0], e.touches[1]);
      pinchMidX = mid.x; pinchMidY = mid.y;
    } else if (e.touches.length === 1) {
      // Two fingers down to one: let the remaining finger keep panning
      // without needing to lift and re-touch, matching how a real map app
      // feels. Skipped entirely while Inspect (Line)/(Grid) is armed - this
      // finger was never the one whose touchstart armed that gesture
      // (inspectDragStartWorld was cleared when the pinch began), so
      // resuming as a plain pan here would go on to preview/commit an
      // Inspect line/grid from a null start point the next time
      // handleDragMove runs. Lifting the rest of the way and tapping again
      // starts a clean Inspect gesture instead.
      pinchDistance = 0;
      if (!inspectArmTakesDrag()) {
        dragging = true;
        dragIsTouch = true;
        lastClientX = e.touches[0].clientX;
        lastClientY = e.touches[0].clientY;
        // Already a drag, and never a tap: the two fingers of a pinch never
        // lift in the same instant, so EVERY pinch ends as one finger resting
        // on the glass for a moment - and read as a tap, that moment locked
        // an Inspect point under it at the end of every zoom.
        dragPastSlop = true;
        dragDistance = CLICK_DRAG_THRESHOLD;
        canvas.classList.add("dragging");
      }
    }
  }
  window.addEventListener("touchend", onTouchEnd, { passive: false });
  window.addEventListener("touchcancel", onTouchEnd, { passive: false });

  btnResetView.addEventListener("click", function () {
    setViewCenter(DEFAULT_CENTER.x, DEFAULT_CENTER.y);
    view.scale = DEFAULT_SCALE;
    colorZoomEnabled = false;
    colorZoomCheckbox.checked = false;
    setDisplayMode(DISPLAY_MODES[0]);
    updateZoomReadout();
    markDirty();
  });

  // Keeps the fill bar and the readout in sync with the two handles, and
  // reports them in the terms that now actually apply: where refinement
  // starts and where it stops, as real sample counts rather than bare
  // percentages. "1 sim/px" is the right-hand default and the finest the
  // ladder goes; anything coarser is quoted as the size of the block each
  // simulation is painted across, which is what the user sees on screen.
  //
  // Also reports live progress while a refinement run is in flight, since
  // the whole point of the control is now the journey rather than a
  // clamp - "8px → 1 sim/px · at 4px" says more about what is happening
  // than any static pair of numbers could.
  function describeStride(stride) {
    return stride <= 1 ? "1 sim/px" : stride + "px";
  }
  function updateResolutionBoundsUI() {
    var minV = Number(resolutionMinSlider.value);
    var maxV = Number(resolutionMaxSlider.value);
    resolutionRangeFill.style.left = minV + "%";
    resolutionRangeFill.style.width = Math.max(0, maxV - minV) + "%";
    var text = describeStride(startStride()) + " → " + describeStride(endStride());
    if (progressive.aaSample > 0) {
      // Averaging is the finished state once it stops, not a stalled
      // progress bar - so say what the picture IS, not what it was doing.
      text += progressive.complete
        ? " · " + progressive.aaSample + " samples/px"
        : " · averaging " + progressive.aaSample + "/" + MAX_AA_SAMPLES;
    } else if (progressive.stride > 0 && !progressive.complete) {
      text += " · at " + describeStride(progressive.stride);
    }
    resolutionBoundsReadout.textContent = text;
  }
  updateResolutionBoundsUI();

  // Moving either handle restarts refinement from the (possibly new)
  // starting level - markDirty is the whole of what that takes now. It can
  // fire on every "input" tick while dragging without piling anything up,
  // because a reset is just a few fields and the rAF loop still only does
  // one frame's work per frame. The two handles are only ever allowed to
  // touch, never cross, by clamping whichever just moved against the other.
  function onResolutionBoundInput() {
    if (Number(resolutionMinSlider.value) > Number(resolutionMaxSlider.value)) {
      resolutionMinSlider.value = resolutionMaxSlider.value;
    }
    if (Number(resolutionMaxSlider.value) < Number(resolutionMinSlider.value)) {
      resolutionMaxSlider.value = resolutionMinSlider.value;
    }
    updateResolutionBoundsUI();
    markDirty();
    syncPerfPresetUI();
  }
  resolutionMinSlider.addEventListener("input", onResolutionBoundInput);
  resolutionMaxSlider.addEventListener("input", onResolutionBoundInput);

  // ---- Simulation steps per pixel ----
  //
  // Split across "input" and "change" on purpose. Dragging updates only the
  // readout, because at the far end of this slider a single frame is a
  // few hundred milliseconds and every intermediate notch would have to be
  // rendered (and, with Inspect points locked, would recompile a trajectory
  // shader per point). Releasing applies it.
  function stepsFromSlider() { return Number(stepsSlider.value) * SIMULATION_STEPS_PER_NOTCH; }
  // Slider position, readout and hint, all from whatever simulationSteps
  // currently is - so there is one way to put this control back in step with
  // the value behind it, used both at boot and on every scene adoption.
  //
  // The number beside the slider can be typed, to any whole frame the slider
  // could reach - so the duration is not always a notch, and the slider just
  // rests on the nearest one.
  function syncStepsUI() {
    stepsSlider.value = String(clamp(Math.round(simulationSteps / SIMULATION_STEPS_PER_NOTCH), Number(stepsSlider.min), Number(stepsSlider.max)));
    updateStepsUI(simulationSteps);
  }
  function updateStepsUI(value) {
    if (stepsReadout.value !== String(value)) stepsReadout.value = String(value);
  }
  // Every inspected point cached a trajectory of the OLD length, so after a
  // change they'd replay against a grid that no longer agrees with them.
  // Recompiled in place, keeping each point's own color. A "point" group is
  // simply removed if its one point fails to recompile (mirrors the old
  // flat-array behavior); a "line"/"grid" group's point instead just keeps
  // its stale trajectory on failure, since splicing it away would shift a
  // line's start/end or break a grid's fixed segment indices - losing a
  // hand-placed inspection to a settings change would be worse than one
  // point briefly disagreeing with the others. updateInspectUI() ends in
  // restartCurrentPreview(), so this is also what gets the hover panel going
  // again.
  function recomputeLockedTrajectories() {
    for (var g = inspectedGroups.length - 1; g >= 0; g--) {
      var group = inspectedGroups[g];
      if (group.type === "point") {
        var next = computeTrajectoryEntry(group.points[0].worldPoint);
        if (!next) { inspectedGroups.splice(g, 1); continue; }
        next.color = group.points[0].color;
        group.points[0] = next;
      } else {
        for (var i = 0; i < group.points.length; i++) {
          var recomputed = computeTrajectoryEntry(group.points[i].worldPoint);
          if (!recomputed) continue; // keep the stale trajectory rather than reshuffle a fixed line/grid shape
          recomputed.color = group.points[i].color;
          group.points[i] = recomputed;
        }
      }
    }
    updateInspectUI();
  }
  syncStepsUI();
  stepsSlider.addEventListener("input", function () { updateStepsUI(stepsFromSlider()); });
  stepsSlider.addEventListener("change", function () { applySimulationSteps(stepsFromSlider()); });
  // Typed: on commit (Enter, or leaving the field), never per keystroke -
  // every intermediate number would be a full re-render. Anything unusable
  // puts the current value back.
  stepsReadout.addEventListener("change", function () {
    var typed = Math.round(Number(stepsReadout.value));
    if (isFinite(typed) && typed >= 1) {
      applySimulationSteps(Math.min(typed, Number(stepsSlider.max) * SIMULATION_STEPS_PER_NOTCH));
    }
    syncStepsUI();
  });
  stepsReadout.addEventListener("keydown", function (e) {
    if (e.key === "Enter") stepsReadout.blur();
    e.stopPropagation(); // digits and arrows here are not the map's shortcuts
  });
  function applySimulationSteps(next) {
    if (next === simulationSteps) return;
    // The timeline ends at the duration. One resting at its end moves with
    // it, which is all this slider ever did before there was a timeline; one
    // partway along keeps its step, unless the new duration ends before it.
    var timelineAtEnd = timeline.step >= simulationSteps;
    simulationSteps = next;
    if (timelineAtEnd || timeline.step > next) {
      stopTimelineClock();
      timeline.step = next;
    }
    if (timeline.stateStep > timeline.step) timeline.stateKey = null;
    updateTimelineUI();
    updateStepsUI(simulationSteps);
    // Duration is a property of the SCENE, not of this page's view of it,
    // and the editor has the same slider on the same value. Writing it into
    // both is what keeps the two from drifting: without this the change
    // lived only in this module, so the editor still showed the old number
    // and the next Fractal-ize handed it straight back.
    scene.simulationSteps = next;
    if (global.PhysicsUI && global.PhysicsUI.setSimulationSteps) {
      global.PhysicsUI.setSimulationSteps(next);
    }
    // The per-pixel cost just changed by up to 10x. Nothing has to be told:
    // markDirty restarts refinement from the coarsest level, and the
    // per-frame budget re-converges on its own within a few frames.
    markDirty();
    if (inspectedGroups.length > 0) recomputeLockedTrajectories();
    else restartCurrentPreview();
  }

  colorZoomCheckbox.addEventListener("change", function () {
    colorZoomEnabled = colorZoomCheckbox.checked;
    if (colorZoomEnabled && activeTipId === "color-zoom") hideTip(); // they took the suggestion (or just found the checkbox themselves) - either way it's moot now
    // Color Zoom only changes Standard's ramp (see colorMap vs rainbow in
    // the shader), so flipping it from any other mode would be a control
    // with no visible effect. Switching to Standard is what makes the
    // toggle mean something wherever the user reaches it from - and it is
    // in Standard's own row in the Display menu, so landing on Standard is
    // also what the row it lives in implies.
    //
    // In the change event rather than on the row's click: this fires for
    // the keyboard (Space on a focused toggle) as well as the mouse, and
    // programmatic flips like Reset View's go through it too.
    setDisplayMode(DISPLAY_MODES[0]);
    markDirty();
  });

  // ---- The Display Mode menu's rows ----
  //
  // Built from DISPLAY_MODES rather than written out in chaos.html, so the
  // GLSL MODE_* constants, the sample counts, the thumbnails and this list
  // cannot drift apart.
  //
  // Each row is a button in a radiogroup: a thumbnail of what that mode
  // actually looks like, then the sentence and the sample cost. The picture
  // is doing most of the work - the difference between these four is
  // entirely visual, and a name on its own ("Laplacian") tells you nothing
  // about what you are about to see.
  var displayModeRows = [];
  DISPLAY_MODES.forEach(function (mode) {
    // Standard's row hosts the Color Zoom toggle in place of its own blurb
    // sentence (see colorZoomField below), and a checkbox is interactive
    // content that <button> isn't allowed to contain - a <div> plus the
    // role/tabIndex/click wiring every row already gets below reproduces a
    // button's behavior without the invalid nesting.
    var isStandard = mode.value === "standard";
    var row = document.createElement(isStandard ? "div" : "button");
    if (!isStandard) row.type = "button";
    row.className = "display-mode-row";
    row.setAttribute("role", "radio");
    row.dataset.mode = mode.value;

    var img = document.createElement("img");
    // Not lazy: the card is one screenful of four small images, and a row
    // whose picture arrives after the menu opens is the one thing that
    // would make this list feel worse than the dropdown it replaced.
    img.src = "assets/" + mode.value + ".jpg";
    img.width = 400;
    img.height = 364;
    // The label and the sentence beside it already say what this is, and a
    // screen reader reading the same thing twice per row is worse than it
    // not describing the picture at all.
    img.alt = "";
    row.appendChild(img);

    var text = document.createElement("span");
    text.className = "display-mode-text";
    var name = document.createElement("b");
    name.className = "display-mode-name";
    name.textContent = mode.label;
    text.appendChild(name);
    // Color Zoom only ever repeats/re-saturates the same plain rainbow ramp
    // Standard paints (see colorMap's u_colorZoom branch), so it reads as
    // this row's own control rather than a separate settings-panel toggle -
    // colorZoomField is the exact <input id="color-zoom-checkbox"> element
    // from chaos.html, moved here (not cloned), so every existing
    // change-event/tip listener on it keeps working untouched.
    if (isStandard) text.appendChild(colorZoomField);
    else text.appendChild(document.createTextNode(mode.blurb));
    var cost = document.createElement("span");
    cost.className = "display-mode-cost";
    cost.textContent = mode.samples === 1
      ? "1 simulation per pixel"
      : mode.samples + " simulations per pixel";
    text.appendChild(cost);
    row.appendChild(text);

    row.addEventListener("click", function () { setDisplayMode(mode); });
    displayModePanelBody.appendChild(row);
    displayModeRows.push({ mode: mode, row: row });
  });

  function syncDisplayModeUI() {
    displayModeRows.forEach(function (entry) {
      var on = entry.mode === displayMode;
      entry.row.setAttribute("aria-checked", on ? "true" : "false");
      // Only the selected row is a tab stop, which is how a radiogroup is
      // meant to behave - five rows of Tab to get past this card is not.
      entry.row.tabIndex = on ? 0 : -1;
    });
  }

  function setDisplayMode(mode) {
    if (mode === displayMode) return;
    displayMode = mode;
    syncDisplayModeUI();
    // A full restart, not a resume: every level already in the accumulator
    // is the old mode's picture, and compositing the two together would
    // blend two different images the way a mid-pan level change would.
    markDirty();
  }

  // Left/Right/Up/Down move between rows, per the radiogroup pattern - and
  // because the whole point of this card is comparing the four, which is
  // much easier when they can be stepped through than clicked one at a time.
  displayModePanelBody.addEventListener("keydown", function (event) {
    var delta = (event.key === "ArrowDown" || event.key === "ArrowRight") ? 1
      : (event.key === "ArrowUp" || event.key === "ArrowLeft") ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    var i = DISPLAY_MODES.indexOf(displayMode);
    var next = DISPLAY_MODES[(i + delta + DISPLAY_MODES.length) % DISPLAY_MODES.length];
    setDisplayMode(next);
    displayModeRows.forEach(function (entry) {
      if (entry.mode === next) entry.row.focus();
    });
  });

  syncDisplayModeUI();

  // ---- Inspection Line Sample Count ----
  //
  // Just updates the plain state evenlySpacedPoints reads on the NEXT
  // Inspect (Line) drag - same "settings change, nothing already on screen
  // is touched" rule as Grid Settings just below.
  inspectLineSampleCountSlider.value = String(inspectLineSampleCount);
  inspectLineSampleCountReadout.textContent = String(inspectLineSampleCount);
  inspectLineSampleCountSlider.addEventListener("input", function () {
    inspectLineSampleCount = Number(inspectLineSampleCountSlider.value);
    inspectLineSampleCountReadout.textContent = String(inspectLineSampleCount);
  });

  // ---- Grid Settings (Grid Size, Two Part Line) ----
  //
  // Both just update the plain state lockGridOfPoints reads on the NEXT
  // drag (see computeGridLayout) - no recompute of anything already on
  // screen, since an existing grid is never affected by a later settings
  // change (per the user's own ask). The Inspect (Grid) button's own
  // tooltip is kept in sync too, so it never quotes a stale size.
  function updateInspectGridSettingsUI() {
    var label = inspectGridSize + "×" + inspectGridSize;
    inspectGridSizeReadout.textContent = label;
    btnInspectGrid.title = "Drag the grid to inspect a " + label + " grid of points";
  }
  inspectGridSizeSlider.value = String(inspectGridSize);
  inspectGridTwoPartCheckbox.checked = inspectGridTwoPart;
  updateInspectGridSettingsUI();
  inspectGridSizeSlider.addEventListener("input", function () {
    inspectGridSize = Number(inspectGridSizeSlider.value);
    updateInspectGridSettingsUI();
  });
  inspectGridTwoPartCheckbox.addEventListener("change", function () {
    inspectGridTwoPart = inspectGridTwoPartCheckbox.checked;
  });

  // ---- Sound volume (mute button + settings slider) ----
  //
  // PhysicsSound's volume is shared, module-level state - the physics
  // editor's identical controls (see physics-ui.js's own copy of this
  // exact pattern) read and write the very same value, so the one
  // onVolumeChange listener below is what keeps every location (this
  // page's mute button AND its settings slider, whether it was one of
  // THEM or the editor page's own pair that actually changed it) in sync,
  // continuously - not just at some particular moment like panel-open.
  function setVolumeIconState(container, volume) {
    var muted = volume <= 0;
    // Explicit "inline"/"none" on both sides, not "" for the visible case -
    // .vol-mute-x's own CSS default (see app-shell.css) IS display:none, so
    // clearing back to "just use the stylesheet" would leave it hidden
    // instead of showing it.
    container.querySelector(".vol-arc-1").style.display = muted ? "none" : "inline";
    container.querySelector(".vol-arc-2").style.display = (muted || volume <= 0.5) ? "none" : "inline";
    container.querySelector(".vol-mute-x").style.display = muted ? "inline" : "none";
  }
  function updateVolumeUI(volume) {
    setVolumeIconState(hoverMuteBtn, volume);
    setVolumeIconState(gridSoundVolumeIcon, volume);
    gridSoundVolumeSlider.value = String(Math.round(volume * 100));
    var label = volume <= 0 ? "Unmute" : "Mute";
    hoverMuteBtn.title = label;
    hoverMuteBtn.setAttribute("aria-label", label);
  }
  hoverMuteBtn.addEventListener("click", function () { PhysicsSound.toggleMute(); });
  gridSoundVolumeSlider.addEventListener("input", function () {
    PhysicsSound.setVolume(Number(gridSoundVolumeSlider.value) / 100);
  });
  PhysicsSound.onVolumeChange(updateVolumeUI);
  updateVolumeUI(PhysicsSound.getVolume());

  // ---- Hover-to-replay ----
  //
  // Two-stage so a fast-moving cursor never queues up a backlog of expensive
  // WebGL recompiles: the instant a new cell is under the cursor, draw its
  // step-0 state directly with PhysicsGridCodegen.computeOffsetSceneNumeric
  // - pure JS/numbers, no shader compile, cheap enough to run on every
  // qualifying mousemove. Only once the cursor has sat on that same cell for
  // HOVER_UPGRADE_DELAY_MS do we pay for the real thing: re-running the
  // grid's WebGL code WITH LOGGING for that exact pixel
  // (PhysicsGridCodegen.compileHoverTrajectoryGLSL - the same offset+cascade
  // math as the grid shader and the instant preview, but combined with the
  // single-scene player's trajectory-logging convention instead of "just
  // the final step"), then replaying the resulting trajectory here: actual
  // shapes moving, background recoloring by Output - the same idea as
  // #editor-view's own Play button, just fed by a freshly-logged trajectory
  // for one point instead of the live editor's own scene. The instant
  // preview's frame and the replay's first frame are both "this pixel's
  // offset scene" one physics step apart (the preview is t=0, the replay's
  // first logged row is t=1-step) - a natural, expected handoff, not a bug.

  var HOVER_UPGRADE_DELAY_MS = 500; // cursor dwell time before the cheap preview is upgraded to the real WebGL replay
  // How long each simulation step is held on screen during a replay. A flat
  // per-frame duration, so a replay's length is simply this times the number
  // of steps in it: doubling the step count doubles how long it takes to
  // watch, which is what makes the step-count setting legible.
  //
  // This used to be a speed (a multiple of real time) with a ceiling on the
  // TOTAL duration, which meant any run past about 720 steps was sped up to
  // fit the same 8 seconds - so every long replay took exactly as long as
  // every other one and the step count stopped being visible in the
  // playback at all. 11ms is about what the old speed worked out to per
  // step (1.5x real time), so the familiar 500-step replay is close to
  // unchanged; a 2500-step one now honestly takes 2500 x 11ms instead of
  // being compressed.
  var HOVER_MS_PER_FRAME = 11;

  // The replay logs EVERY step into a (numBodies x steps) texture, so its
  // length is bounded by the GPU's maximum texture dimension. WebGL2 only
  // guarantees 2048 (real hardware is 8k-16k), so cap rather than fail: a
  // replay that stops short of the grid's own budget is much better than a
  // hover panel that throws.
  var MAX_TEXTURE_SIZE = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  function hoverStepCount() { return Math.min(simulationSteps, MAX_TEXTURE_SIZE); }

  var hoverCanvas = document.getElementById("hover-canvas");
  var hoverCtx = hoverCanvas.getContext("2d");
  var hoverEmptyState = document.getElementById("hover-empty-state");
  var hoverReadout = document.getElementById("hover-readout");
  var hoverPlayPauseBtn = document.getElementById("hover-play-pause");
  var hoverProgressSlider = document.getElementById("hover-progress-slider");
  var hoverSpeedBtn = document.getElementById("hover-speed-btn");
  var hoverSpeedPopup = document.getElementById("hover-speed-popup");
  var hoverSpeedSlider = document.getElementById("hover-speed-slider");
  var hoverSpeedValueEl = document.getElementById("hover-speed-value");
  var hoverResetBtn = document.getElementById("hover-reset");
  var hoverPlaybackControlsEl = document.getElementById("hover-playback-controls");

  var hoverRafId = null;
  // How long a finished replay (playbackTick, whether driving a hovered
  // point, Inspect, or both together) holds on its final frame before
  // looping back to the start - applies uniformly to every animation this
  // panel ever plays, Inspect or not.
  var REPLAY_LOOP_DELAY_MS = 1500;
  var hoverLoopTimer = null;
  var hoverUpgradeTimer = null;
  var hoverKey = null; // last (snapped) world point currently shown (instant preview or replay) - skips redundant work while the cursor sits still or jitters within one cell
  var hoverWorldPoint = null; // the actual {x,y} behind hoverKey - kept alongside it so restartCurrentPreview can re-run runHoverAt without needing the cursor to still be there
  var isHoveringGrid = false; // true between the canvas's own mousemove and mouseleave - lets a locked-point edit made from the sidebar (while the cursor is over it, not the grid) refresh beginInspectOnlySession instead of leaving it showing a stale frame

  // ---- Playback controls (Play/Pause, Progress, Reset) ----
  //
  // One player drives whatever this panel is currently showing: a hovered
  // point's own replay, that replay plus inspected points animating
  // alongside it, or (mouse off the grid, at least one point inspected)
  // inspected points on their own - see renderPlaybackFrame. playbackStep is
  // the single shared clock everything on screen reads from, each entry
  // clamped to its own effectiveMaxStep exactly as before this control
  // existed (a point that stopped early just holds its final frame while
  // everything else keeps going).
  //
  // activeReplay is the hovered point's own data (trajectory + everything
  // runHoverAt worked out about it), or null while there's no hovered
  // point to show - either the true empty state or Inspect-only preview,
  // told apart by inspectedGroups.length (see renderPlaybackFrame).
  var activeReplay = null;
  // 0-indexed step currently shown - a float while auto-advancing (see
  // playbackTick), floored wherever it's actually used as an index. May sit
  // past any one entry's own effectiveMaxStep when dragged there by hand.
  var playbackStep = 0;
  var playbackPlaying = false;
  var playbackLastTickTime = 0;
  // hoverStepCount() at the moment the CURRENT session began (see
  // beginPlaybackSession) - deliberately fixed for that session's whole
  // lifetime rather than read live, and deliberately NOT
  // playbackClockCeiling() (which a sticky-edge stop can make smaller): the
  // slider's own length is meant to always read as "the configured
  // Simulation Duration," so a run that stopped early is visible as a
  // thumb resting short of the far end, not a shorter bar.
  var playbackConfiguredMax = 1;
  // False only in the true empty state (nothing hovered, nothing locked) -
  // disables all three controls, since there's nothing for them to act on.
  var playbackHasSession = false;
  // Stamped whenever code - not the user's own click - transitions playback
  // into the playing state: the dwell-then-autoplay upgrade, entering
  // Inspect-only preview, or the end-of-run loop restarting from 0. A Pause
  // click landing within PLAY_PAUSE_GRACE_MS of that moment is dropped
  // rather than honored: the user almost certainly meant "start playing,"
  // which just happened on its own, so stopping it immediately afterward
  // would read as broken rather than responsive.
  var playbackAutoStartedAt = -Infinity;
  var PLAY_PAUSE_GRACE_MS = 300;

  function updatePlayPauseButtonUI() {
    setPlayPauseIcon(hoverPlayPauseBtn, playbackPlaying);
    hoverPlayPauseBtn.title = playbackPlaying ? "Pause" : "Play";
    hoverPlayPauseBtn.setAttribute("aria-label", playbackPlaying ? "Pause" : "Play");
  }

  // ---- Playback speed ----
  //
  // A multiplier on hoverStepsPerSecond()'s own base rate, read fresh every
  // tick - see playbackTick - so dragging the slider takes effect
  // immediately on whatever's already animating rather than only on the
  // next hover. Not part of setPlaybackControlsEnabled below: it's a
  // standing preference (like the Simulation Duration setting beside the
  // timeline), useful to set before ever hovering a pixel, not a transport
  // control that needs something loaded to act on. Defaults to 1x, the
  // same real-time default physics-ui.js's own copy of this control uses.
  //
  // ONE speed, two buttons. Inspect's preview transport and the Map
  // Evolution timeline both ask the same question - how fast should
  // playback run - so the value lives here and each button is only a view
  // of it, exactly as this page's two sound controls are two views of
  // PhysicsSound's one volume (see updateVolumeUI). Setting 4x in the
  // preview and finding the map still at 1x was the whole complaint: two
  // controls that look identical and read the same word have to mean the
  // same thing. The two popups stay separate elements (each is positioned
  // against its own button - see position() below); it's the value behind
  // them that is shared.
  //
  // The multiplier means different absolute rates in the two places, and
  // that is the point: 2x is twice HOVER_MS_PER_FRAME's base rate in the
  // preview and twice PLAYBACK_STEPS_PER_SECOND on the timeline. "Twice as
  // fast as normal" is what the user set, in both.
  var SPEED_MIN = 0.5, SPEED_MAX = 16;
  // The slider itself moves in log2(speed) space, not speed - see
  // sliderValueToSpeed/speedToSliderValue. A linear 0.5-16 slider spends
  // almost no travel on 0.5-2 (where a small change is a huge relative
  // speed difference) and most of it on 8-16 (where it barely matters);
  // log space instead gives 0.5->1, 1->2, 2->4, 4->8 and 8->16 each the
  // same amount of the slider's length, since each is the same ×2 step.
  // step="1" in this same space is what actually restricts the control to
  // just those six whole-power-of-two speeds - an integer log2(speed) is
  // exactly a power of two, so there's nothing extra to round here.
  var SPEED_LOG_MIN = Math.log2(SPEED_MIN), SPEED_LOG_MAX = Math.log2(SPEED_MAX);
  function sliderValueToSpeed(v) { return Math.pow(2, v); }
  function speedToSliderValue(speed) { return Math.log2(speed); }

  // "2x"/"16x" (no decimal) once a whole step no longer reads as a
  // meaningfully different speed; "0.5x"/"1.3x" below that, where a tenth
  // is still a noticeable fraction of the current value.
  function formatSpeed(v) {
    return (v < 2 ? v.toFixed(1) : String(Math.round(v))) + "x";
  }

  // The one value both controls show and both playback loops read. Read
  // fresh by whoever uses it, never cached, which is what lets a drag take
  // effect mid-run - on the preview and the timeline at once.
  var playbackSpeed = 1;
  // Every makeSpeedControl instance registers its own render function
  // here, so setPlaybackSpeed can repaint all of them without knowing how
  // many there are or which one the user actually dragged - the same shape
  // as PhysicsSound.onVolumeChange driving updateVolumeUI above.
  var speedRenderers = [];
  function updateSpeedUI() {
    speedRenderers.forEach(function (render) { render(); });
  }
  function setPlaybackSpeed(v) {
    playbackSpeed = clamp(v, SPEED_MIN, SPEED_MAX);
    updateSpeedUI();
  }

  // A speed button, the popup slider it opens, and the readout under that
  // slider - a view of playbackSpeed, not a value of its own.
  function makeSpeedControl(button, popup, slider, valueEl) {
    // The HTML hardcodes matching min/max/step (see #hover-speed-slider's own
    // comment) for a flash-free first paint before this runs - set from the
    // same constants here so the two can never quietly drift apart.
    slider.min = String(SPEED_LOG_MIN);
    slider.max = String(SPEED_LOG_MAX);
    slider.step = "1";

    speedRenderers.push(function () {
      var text = formatSpeed(playbackSpeed);
      button.textContent = text;
      valueEl.textContent = text;
      slider.value = String(speedToSliderValue(playbackSpeed));
    });

    // Fixed positioning (see #hover-speed-popup's own HTML comment) means
    // this has to be placed by hand, the same way positionTip places this
    // file's own tip popover: measured against the button's live position
    // rather than laid out declaratively, since nothing here is a
    // normal-flow descendant of it. Centered above the button, clamped so a
    // button near either edge doesn't push the popup off-screen - and below
    // it instead if there is no room above, which a button near the top of
    // the window would otherwise push off the top edge.
    function position() {
      var rect = button.getBoundingClientRect();
      var width = popup.offsetWidth, height = popup.offsetHeight;
      var left = clamp(rect.left + rect.width / 2 - width / 2, 8, window.innerWidth - width - 8);
      var top = rect.top - height - 8;
      if (top < 8) top = rect.bottom + 8;
      popup.style.left = left + "px";
      popup.style.top = top + "px";
    }
    function open() {
      popup.hidden = false;
      button.setAttribute("aria-expanded", "true");
      position();
      slider.focus();
    }
    function close() {
      if (popup.hidden) return;
      popup.hidden = true;
      button.setAttribute("aria-expanded", "false");
    }

    button.addEventListener("click", function (e) {
      e.stopPropagation(); // otherwise the document click listener below sees this same click as "outside" and immediately closes what it just opened
      if (popup.hidden) open(); else close();
    });
    slider.addEventListener("input", function () {
      // Not control.update() - setPlaybackSpeed repaints the OTHER button
      // too, so a drag here shows up there immediately rather than the
      // next time that card happens to be rebuilt.
      setPlaybackSpeed(sliderValueToSpeed(Number(slider.value)));
    });
    document.addEventListener("click", function (e) {
      if (popup.hidden) return;
      if (button.contains(e.target) || popup.contains(e.target)) return;
      close();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !popup.hidden) { close(); button.focus(); }
    });
    window.addEventListener("resize", function () {
      if (!popup.hidden) position();
    });
  }
  makeSpeedControl(hoverSpeedBtn, hoverSpeedPopup, hoverSpeedSlider, hoverSpeedValueEl);

  function setPlaybackControlsEnabled(enabled) {
    playbackHasSession = enabled;
    hoverPlayPauseBtn.disabled = !enabled;
    hoverProgressSlider.disabled = !enabled;
    hoverResetBtn.disabled = !enabled;
  }

  function updateProgressSliderPosition() {
    hoverProgressSlider.value = String(Math.floor(playbackStep));
  }

  // The clock's own ceiling for auto-advance - the latest final frame among
  // everything currently on screen (the hovered replay, if any, and every
  // inspected point, including each point inside a line/grid group).
  // Recomputed on every call rather than cached, since inspected points can
  // change out from under an animating session (added or removed from the
  // sidebar) - see restartCurrentPreview's own comment on why that already
  // has to re-enter from scratch rather than patch state.
  function playbackClockCeiling() {
    var ceiling = activeReplay ? activeReplay.effectiveMaxStep : 0;
    for (var g = 0; g < inspectedGroups.length; g++) {
      var points = inspectedGroups[g].points;
      for (var i = 0; i < points.length; i++) {
        ceiling = Math.max(ceiling, points[i].effectiveMaxStep);
      }
    }
    return Math.max(1, ceiling);
  }

  // Mirrors buildFragmentShader's colorMap exactly (kept as a separate JS
  // copy rather than shared code, matching how this project already
  // duplicates this exact formula per page) - hueRangeMaxValue is 360° for
  // a genuinely wrapping/circular output (the wrap point's t=0/t=1 are the
  // same underlying position, so the same hue there reads as one
  // continuous loop instead of a seam) and 300° for a capped, non-wrapping
  // one (Scene lifespan always; x/y under Sticky Edges, frozen at an
  // edge) so its two different ends don't also read as identical - see
  // buildFragmentShader's own comment for exactly which cases get which.
  // OKLCH, not HSL, for this animated hover-replay window (unlike the main
  // grid's static per-pixel image, colorMap below, which stays HSL since
  // nothing there changes over time) - HSL's lightness isn't perceptually
  // uniform, so a value changing quickly reads as flashing light/dark as
  // the hue sweeps. Fixed lightness/chroma keeps every hue the same
  // apparent brightness; only the hue carries the value, same as before.
  // Mirrors colorMap's u_colorZoom branch for hue, but - per that branch's
  // own comment on why HSL adds a saturation ramp there - deliberately
  // skips any equivalent here: chroma/lightness stay fixed either way, so
  // OKLCH never needs to get "darker" to tell the 10 repeats apart.
  function hoverOutputColor(t) {
    var hue = colorZoomEnabled ? hueRangeMaxValue * (1 - (t * 10 % 1)) : hueRangeMaxValue * (1 - t);
    return "oklch(60% 0.136 " + hue.toFixed(2) + ")";
  }

  // The exact color this pixel renders as on the grid itself (colorMap's
  // own HSL formula, not the OKLCH toned-down version above) - used only
  // for the replay's FINAL, frozen frame: once it's holding still instead
  // of animating, there's no more flashing to avoid, and showing the real
  // full-brightness color lets this preview double as "exactly what this
  // pixel looks like on the grid," not just an approximation of its hue.
  //
  // In Standard mode, that is. A derived display mode paints a DERIVATIVE
  // of the field, so no single pixel's own Output value determines its
  // color there and this swatch cannot match the grid whatever it does -
  // it deliberately keeps showing the Output value's own color, since that
  // is what the panel around it is about (the value, its trajectory, its
  // place in the range) rather than the derivative on screen.
  function hoverOutputColorFinal(t) {
    if (colorZoomEnabled) {
      var hueZoom = hueRangeMaxValue * (1 - (t * 10 % 1));
      var sat = t * 60 + 40;
      return "hsl(" + hueZoom.toFixed(2) + ", " + sat.toFixed(2) + "%, 50%)";
    }
    var hue = hueRangeMaxValue * (1 - t);
    return "hsl(" + hue.toFixed(2) + ", 100%, 50%)";
  }

  // Mirrors buildFragmentShader's own "mod(outputValue, OUTPUT_RANGE_MAX) /
  // OUTPUT_RANGE_MAX" exactly, using PhysicsHingeGeometry's existing
  // always-positive mod (the shared JS/GLSL wrap rule this whole project
  // already uses) instead of JS's own %, which can return negative.
  function outputColorT(v) {
    // Lifespan isn't circular like x/y/angle - it can legitimately equal
    // its own max (ran the whole simulation), and wrapping that back to 0
    // would make it look identical to "crossed immediately" - see
    // buildFragmentShader's matching clamp-instead-of-mod comment.
    // Bounce Count scales against the busiest pixel in view, not against any
    // fixed range - the same u_bounceMax the grid itself is currently drawn
    // with, so a hovered pixel's replay ends on the color that pixel has.
    if (isBouncesOutput) return Math.min(1, Math.max(0, v / bounceMaxValue));
    var rangeMax = currentOutputRangeMax();
    if (scene.output.property === "lifespan") return Math.min(1, Math.max(0, v / rangeMax));
    // Under Infinite Space a coordinate is unbounded, so it gets squashed
    // rather than wrapped - the same curve the shader uses, so this panel
    // and the pixel behind it end on the same color.
    if (isInfinitePositionOutput) return PhysicsEngine.frameSigmoid(v / rangeMax);
    return PhysicsHingeGeometry.wrapIntoRange(v, rangeMax) / rangeMax;
  }

  // Stops any active animation without otherwise touching what's being
  // shown - a prelude to something else immediately taking over (a fresh
  // session in beginPlaybackSession, or the empty/instant-preview states
  // below setting their own paused/disabled look), never a state on its
  // own.
  function stopHoverReplay() {
    if (hoverRafId) cancelAnimationFrame(hoverRafId);
    hoverRafId = null;
    // Otherwise a replay that finished right before the cursor moved on
    // would still fire its queued restart later, drawing over whatever's
    // showing by then.
    if (hoverLoopTimer) clearTimeout(hoverLoopTimer);
    hoverLoopTimer = null;
    playbackPlaying = false;
  }

  function showHoverEmpty(message) {
    stopHoverReplay();
    // Nothing left playing for the map to follow.
    releaseMapFollow();
    if (hoverUpgradeTimer) { clearTimeout(hoverUpgradeTimer); hoverUpgradeTimer = null; }
    hoverKey = null;
    activeReplay = null;
    playbackStep = 0;
    setPlaybackControlsEnabled(false);
    updatePlayPauseButtonUI();
    updateProgressSliderPosition();
    hoverEmptyState.hidden = false;
    // Asked fresh each time rather than decided once: a tablet can gain or
    // lose a mouse while the page is open.
    hoverEmptyState.textContent = message || (global.LayoutMode && !global.LayoutMode.canHover()
      ? "Press Inspect (Point), then tap the map to see that spot\u2019s simulation"
      : "Hover the grid to preview a pixel");
    // A placeholder, not blank - leaving this empty let the whole line
    // collapse and reflow everything below it every time hovering starts
    // or stops.
    hoverReadout.textContent = "X: 0, Y: 0";
    hoverCanvas.style.backgroundColor = "";
    hoverCtx.setTransform(1, 0, 0, 1, 0, 0);
    hoverCtx.clearRect(0, 0, hoverCanvas.width, hoverCanvas.height);
  }

  // Fixed once from the scene exactly as authored (not per-hover-point, and
  // not re-fit to wherever a given replay's bodies happen to swing to) -
  // the same "camera" for every point, so different hover points are
  // visually comparable and a big swing just moves off-canvas rather than
  // the whole view zooming out to chase it. Bounding box is padded by each
  // body's own rendered half-extent.
  var hoverFit = (function computeFixedHoverFit() {
    var minX, maxX, minY, maxY;
    if (scene.frameWidth && scene.frameHeight) {
      // A locked frame defines a real boundary bodies wrap at (see
      // PhysicsEngine.step) - fit that exactly, not just wherever the
      // authored bodies happen to sit, so a wrap is visible on-canvas as a
      // body reappearing on the opposite edge, instead of just vanishing.
      minX = 0; maxX = scene.frameWidth;
      minY = 0; maxY = scene.frameHeight;
    } else {
      minX = Infinity; maxX = -Infinity; minY = Infinity; maxY = -Infinity;
      scene.bodies.forEach(function (b) {
        var half = b.type === "circle" ? b.radius : b.length / 2;
        var pad = half + PhysicsEngine.LINE_THICKNESS / 2;
        minX = Math.min(minX, b.x - pad); maxX = Math.max(maxX, b.x + pad);
        minY = Math.min(minY, b.y - pad); maxY = Math.max(maxY, b.y + pad);
      });
    }
    var w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY);
    var scale = 0.85 * Math.min(hoverCanvas.width / w, hoverCanvas.height / h);
    return {
      scale: scale,
      offsetX: hoverCanvas.width / 2 - scale * (minX + maxX) / 2,
      offsetY: hoverCanvas.height / 2 - scale * (minY + maxY) / 2,
    };
  })();

  // body's type/isAnchored never change via a link (only position/size/angle
  // can), so those always come straight from the authored scene; x/y/angle
  // and the actual rendered half-size (which CAN change, for a resize-linked
  // body) come from this step's logged trajectory row. colorOverride (when
  // given) replaces the normal isAnchored-based fill/stroke entirely - used to
  // draw an inspected point's bodies in one fixed, distinct color
  // regardless of static/dynamic, so they read as "the other scene" at a
  // glance instead of blending into the hovered scene's own bodies.
  // Matches physics-ui.js's MIN_PLAYBACK_DISPLAY_RADIUS - the same floor on
  // the same kind of view, kept as a separate copy the way this project
  // already keeps each page's own drawing code. Everything drawn in this
  // panel is a replay, so unlike the editor there is no authoring case here
  // that wants the true size instead.
  //
  // It earns its keep most on this page: X/Y Input can be linked to a body's
  // radius, so the radius is a function of which pixel you are hovering and
  // routinely lands near zero.
  var MIN_DISPLAY_RADIUS = 15;

  // Arrows for X/Y Input and Output bodies that have left the frame, pointing
  // at where they went. The twin of physics-ui.js's - same shared geometry
  // (PhysicsHingeGeometry.offscreenPointer) and the same
  // fraction-of-the-frame sizing, so it reads the same in this small panel as
  // it does at full size in the editor. Earns its keep most under Infinite
  // Space, where a body genuinely leaves and never comes back.
  //
  // One arrow per BODY, not per mapping: a body that is both an input and the
  // output is still one object in one place, and the arrow's job is to say
  // where it went.
  var OFFSCREEN_ARROW_MAX_FRACTION = 0.12;

  // colorOverride, when given, is an inspected point's own {fill, stroke}
  // - the arrow then matches that playback's bodies instead of the hovered
  // scene's default coloring, exactly as drawHoverBody does.
  function drawOffscreenMappingArrows(row, colorOverride) {
    var mapped = {};
    [scene.xInput, scene.yInput, scene.output].forEach(function (m) {
      if (m && typeof m.body === "number" && row[m.body]) mapped[m.body] = true;
    });
    var maxLength = OFFSCREEN_ARROW_MAX_FRACTION * Math.min(scene.frameWidth || 0, scene.frameHeight || 0);
    Object.keys(mapped).forEach(function (key) {
      var at = row[key];
      var pointer = PhysicsHingeGeometry.offscreenPointer(
        at.x, at.y, scene.frameWidth, scene.frameHeight, maxLength);
      if (!pointer) return;
      var color = colorOverride ? colorOverride.fill
        : (scene.bodies[key].isAnchored ? "#7a8199" : "#7ea0ff");
      drawHoverOffscreenArrow(pointer, color, colorOverride ? colorOverride.stroke : null);
    });
  }

  function drawHoverOffscreenArrow(pointer, color, outline) {
    // Line widths are in SCENE units here because the panel's transform
    // scales everything down - dividing by that scale keeps the arrow the
    // same apparent weight as the rest of the panel's furniture.
    var s = 1 / hoverFit.scale;
    var dirX = pointer.dirX, dirY = pointer.dirY, length = pointer.length;
    var inset = 3 * s;
    var tx = pointer.tipX - dirX * inset, ty = pointer.tipY - dirY * inset;
    var head = Math.min(13 * s, Math.max(7 * s, length * 0.35));
    var perpX = -dirY, perpY = dirX;

    function shaft() {
      hoverCtx.beginPath();
      hoverCtx.moveTo(tx - dirX * length, ty - dirY * length);
      hoverCtx.lineTo(tx - dirX * head * 0.6, ty - dirY * head * 0.6);
      hoverCtx.stroke();
    }
    function headTriangle() {
      hoverCtx.beginPath();
      hoverCtx.moveTo(tx, ty);
      hoverCtx.lineTo(tx - dirX * head + perpX * head * 0.5, ty - dirY * head + perpY * head * 0.5);
      hoverCtx.lineTo(tx - dirX * head - perpX * head * 0.5, ty - dirY * head - perpY * head * 0.5);
      hoverCtx.closePath();
    }

    hoverCtx.save();
    hoverCtx.lineCap = "round";
    // An inspected point's own outline, drawn underneath and wider - the same
    // "colored body, dark outline" treatment drawHoverBody gives that
    // point's bodies, so the arrow belongs to the same playback visually.
    if (outline) {
      hoverCtx.strokeStyle = outline;
      hoverCtx.fillStyle = outline;
      hoverCtx.lineWidth = 5.5 * s;
      shaft();
      headTriangle();
      hoverCtx.lineJoin = "round";
      hoverCtx.lineWidth = 3 * s;
      hoverCtx.stroke();
      hoverCtx.fill();
    }
    hoverCtx.strokeStyle = color;
    hoverCtx.fillStyle = color;
    hoverCtx.lineWidth = 3 * s;
    shaft();
    headTriangle();
    hoverCtx.fill();
    hoverCtx.restore();
  }

  // A splitter scene's trajectory rows are always MAX_SIMULATION_BODIES
  // wide - see PhysicsGPU.padSceneForSplitting - so a row can carry slots
  // the authored scene has no entry for. A slot past the authored bodies is
  // always a ball some split woke up, and reports half = 0 until it has
  // been: that's the flag for "there is nothing here yet", and the one for
  // "draw an ordinary circle" once there is.
  function hoverBodySpec(i) {
    return scene.bodies[i] || { type: "circle", isAnchored: false };
  }
  function hoverRowIsLive(i, row) {
    return i < scene.bodies.length || row[i].half > 0;
  }

  function isTrapezoidType(type) { return type === "funnel" || type === "splitter"; }

  // The four corners of a funnel/splitter, in outline order, from the same
  // geometry the engine collides against - reconstructed from the row's own
  // (x, y, angle) and `half`, since `half` for a trapezoid IS size/2.
  function traceTrapezoid(row) {
    var e = PhysicsEngine.getFunnelEdges({ x: row.x, y: row.y, angle: row.angle, size: row.half * 2 });
    var corners = [e.mouth[0], e.mouth[1], e.throat[1], e.throat[0]];
    hoverCtx.beginPath();
    hoverCtx.moveTo(corners[0].x, corners[0].y);
    for (var i = 1; i < corners.length; i++) hoverCtx.lineTo(corners[i].x, corners[i].y);
    hoverCtx.closePath();
  }

  // ---- Solid for the Output's body, an outline for everything else ----
  //
  // The panel's background is the Output's color, so the body it is read
  // from is the one to follow - and two identical balls passing through each
  // other are otherwise impossible to tell apart: did they swap sides, or
  // bounce? Drawn solid, the tracked one answers that at a glance.
  //
  // Which body slots are "the Output's": its one or two authored bodies, or
  // with a splitter every slot in their lineage (see outputLineageSlotsAt) -
  // the same set the background color is averaged over. Null when the Output
  // names no body at all (Scene Lifespan), and then nothing is hollowed:
  // with nothing singled out there is nothing to tell apart from.
  function trackedBodySlots(lineageSlots) {
    var heads = PhysicsEngine.outputBodyIndices(scene.output);
    if (!heads.length) return null;
    var tracked = {};
    (lineageSlots ? [].concat.apply([], lineageSlots) : heads).forEach(function (slot) { tracked[slot] = true; });
    return tracked;
  }
  function isHollow(tracked, i) { return !!tracked && !tracked[i]; }

  var HOLLOW_OUTLINE_WIDTH = 2.5;
  // Under every outline, a slightly wider dark one. The background here is
  // the Output's color and runs the whole hue wheel, so a lone light-blue
  // ring vanishes whenever the Output happens to be blue; light-on-dark
  // reads against anything.
  var HOLLOW_UNDERLAY = "rgba(0, 0, 0, 0.6)";
  var HOLLOW_UNDERLAY_EXTRA = 2.5;

  // A thick stroked shape (a line, a trapezoid's walls) as an outline: the
  // stroke itself, then its inside taken back out. What shows through is the
  // canvas's own CSS background - the Output color - which is exactly what a
  // hollow body should be filled with; the cost is that it also clears
  // anything already drawn underneath, which for bodies crossing is a few
  // pixels of another outline.
  function strokeHollow(trace, color) {
    hoverCtx.lineWidth = PhysicsEngine.LINE_THICKNESS + HOLLOW_UNDERLAY_EXTRA;
    hoverCtx.strokeStyle = HOLLOW_UNDERLAY;
    trace();
    hoverCtx.stroke();
    hoverCtx.lineWidth = PhysicsEngine.LINE_THICKNESS;
    hoverCtx.strokeStyle = color;
    trace();
    hoverCtx.stroke();
    hoverCtx.save();
    hoverCtx.globalCompositeOperation = "destination-out";
    hoverCtx.lineWidth = PhysicsEngine.LINE_THICKNESS - 2 * HOLLOW_OUTLINE_WIDTH;
    hoverCtx.strokeStyle = "#000";
    trace();
    hoverCtx.stroke();
    hoverCtx.restore();
  }

  function drawHoverBody(spec, row, colorOverride, hollow) {
    var fill = colorOverride ? colorOverride.fill : (spec.isAnchored ? "#5a6178" : "#3a63d1");
    var stroke = colorOverride ? colorOverride.stroke : (spec.type === "circle" ? (spec.isAnchored ? "#7a8199" : "#7ea0ff") : (spec.isAnchored ? "#5a6178" : "#3a63d1"));
    hoverCtx.fillStyle = fill;
    if (hollow) {
      // In the body's own identifying color - an inspected point's hue, not
      // the black it outlines its solid bodies with.
      var outline = colorOverride ? colorOverride.fill : stroke;
      hoverCtx.lineCap = "round";
      hoverCtx.lineJoin = "round";
      if (spec.type === "circle") {
        hoverCtx.beginPath();
        hoverCtx.arc(row.x, row.y, Math.max(row.half, MIN_DISPLAY_RADIUS), 0, Math.PI * 2);
        hoverCtx.strokeStyle = HOLLOW_UNDERLAY;
        hoverCtx.lineWidth = HOLLOW_OUTLINE_WIDTH + HOLLOW_UNDERLAY_EXTRA;
        hoverCtx.stroke();
        hoverCtx.strokeStyle = outline;
        hoverCtx.lineWidth = HOLLOW_OUTLINE_WIDTH;
        hoverCtx.stroke();
      } else if (isTrapezoidType(spec.type)) {
        strokeHollow(function () { traceTrapezoid(row); }, outline);
      } else {
        var ox = Math.cos(row.angle) * row.half, oy = Math.sin(row.angle) * row.half;
        strokeHollow(function () {
          hoverCtx.beginPath();
          hoverCtx.moveTo(row.x - ox, row.y - oy);
          hoverCtx.lineTo(row.x + ox, row.y + oy);
        }, outline);
      }
      return;
    }
    if (spec.type === "circle") {
      hoverCtx.strokeStyle = stroke;
      hoverCtx.lineWidth = 2;
      hoverCtx.beginPath();
      // Display floor only - the simulation behind this ran on the real
      // radius. See MIN_DISPLAY_RADIUS above; a line's `half` is its
      // half-LENGTH, a different quantity, so it is left alone.
      hoverCtx.arc(row.x, row.y, Math.max(row.half, MIN_DISPLAY_RADIUS), 0, Math.PI * 2);
      hoverCtx.fill();
      hoverCtx.stroke();
    } else if (isTrapezoidType(spec.type)) {
      // Deliberately one flat color for the whole outline. #editor-view
      // colors each of the four edges by its ROLE - which side teleports,
      // which side splits, which are plain walls - because that is the view
      // where you build the thing. This panel is a thumbnail of one pixel's
      // starting state; the edge roles aren't what you're reading it for,
      // and four colors at this size is just noise.
      hoverCtx.lineCap = "round";
      hoverCtx.lineJoin = "round";
      if (colorOverride) {
        // Same two-pass outline a line gets under an inspected color, and for
        // the same reason - see the line branch below.
        hoverCtx.strokeStyle = colorOverride.stroke;
        hoverCtx.lineWidth = PhysicsEngine.LINE_THICKNESS + 2;
        traceTrapezoid(row);
        hoverCtx.stroke();
        hoverCtx.strokeStyle = colorOverride.fill;
      } else {
        hoverCtx.strokeStyle = stroke;
      }
      hoverCtx.lineWidth = PhysicsEngine.LINE_THICKNESS;
      traceTrapezoid(row);
      hoverCtx.stroke();
    } else {
      var hx = Math.cos(row.angle) * row.half;
      var hy = Math.sin(row.angle) * row.half;
      hoverCtx.lineCap = "round";
      if (colorOverride) {
        // A stroked line has no separate fill to carry the hue the way a
        // circle's does - echo the same "colored body, black outline" look
        // by stroking it twice: a wider black pass underneath, then the
        // actual hue on top and slightly thinner, so it reads as outlined
        // rather than just recoloring the whole line solid black.
        hoverCtx.strokeStyle = colorOverride.stroke;
        hoverCtx.lineWidth = PhysicsEngine.LINE_THICKNESS + 2;
        hoverCtx.beginPath();
        hoverCtx.moveTo(row.x - hx, row.y - hy);
        hoverCtx.lineTo(row.x + hx, row.y + hy);
        hoverCtx.stroke();
        hoverCtx.strokeStyle = colorOverride.fill;
        hoverCtx.lineWidth = PhysicsEngine.LINE_THICKNESS;
        hoverCtx.beginPath();
        hoverCtx.moveTo(row.x - hx, row.y - hy);
        hoverCtx.lineTo(row.x + hx, row.y + hy);
        hoverCtx.stroke();
      } else {
        hoverCtx.lineWidth = PhysicsEngine.LINE_THICKNESS;
        hoverCtx.strokeStyle = stroke;
        hoverCtx.beginPath();
        hoverCtx.moveTo(row.x - hx, row.y - hy);
        hoverCtx.lineTo(row.x + hx, row.y + hy);
        hoverCtx.stroke();
      }
    }
  }

  // The scene's springs, over a set of bodies this panel has just drawn.
  // `rows` is indexed by AUTHORED body ({ x, y, angle, half }, as a
  // trajectory row is), which is all a spring ever refers to - a ball that
  // splits keeps its spring on the half that kept its slot.
  //
  // An end's place on its body is not always what was authored: X/Y Input
  // can be linked to a size, and the grid rescales a spring's anchor with the
  // body it sits on (see physics-grid-codegen.js). The row's own `half` over
  // the authored one is that same ratio, read back off the trajectory.
  function drawHoverSprings(rows, colorOverride) {
    PhysicsEngine.sceneSprings(scene).forEach(function (sp) {
      function end(bodyIndex, anchor) {
        if (bodyIndex === null) return anchor; // a fixed point on the background
        var row = rows[bodyIndex];
        if (!row) return null;
        var authoredHalf = PhysicsGPU.shapeHalf(scene.bodies, bodyIndex);
        var ratio = authoredHalf > 0 ? row.half / authoredHalf : 1;
        var isLine = scene.bodies[bodyIndex].type === "line";
        var r = PhysicsEngine.rotateVec({ x: anchor.x * ratio, y: anchor.y * (isLine ? 1 : ratio) }, row.angle);
        return { x: row.x + r.x, y: row.y + r.y };
      }
      var a = end(sp.bodyA, sp.localAnchorA), b = end(sp.bodyB, sp.localAnchorB);
      if (!a || !b) return;
      PhysicsUI.drawSpringBetween(hoverCtx, a, b, sp.stiffness, sp.restLength, colorOverride ? colorOverride.fill : undefined);
    });
  }

  // Draws every inspected point's bodies at `step` (each capped to its own
  // effectiveMaxStep, independently of however far the hovered scene's own
  // replay has gotten) - called from both the instant preview (step 0) and
  // the animated replay tick, so an inspected point is visible in either
  // mode, "playing back on top of" whatever's currently hovered. Each point
  // draws in its own entry.color (see the Inspect section above), not a
  // single shared color, so points stay distinguishable from each other.
  //
  // "grid" groups are deliberately excluded from this pass - per the user's
  // own requirement, a grid never renders its output bodies at all (only
  // their implied position matters), and its mesh must sit on top of every
  // other group regardless of draw order among groups. See the mesh pass
  // below, which runs after every group here has had its own bodies drawn.
  var INSPECT_GRID_MESH_LINE_WIDTH = 2.5;
  function drawInspectedAtStep(step) {
    inspectedGroups.forEach(function (group) {
      if (group.type === "grid") return;
      group.points.forEach(function (entry) {
        var s = Math.min(step, entry.effectiveMaxStep - 1);
        var isFinalFrame = s >= entry.effectiveMaxStep - 1;
        var row = entry.trajectory[s];
        var color = entry.color;
        var effective = [], shown = [], tracked = trackedBodySlots(entry.lineageSlots);
        for (var i = 0; i < row.length; i++) {
          var bodyRow = (isFinalFrame && entry.wrapOverride && entry.wrapOverride.bodyIndex === i)
            ? { x: entry.wrapOverride.x, y: entry.wrapOverride.y, angle: entry.wrapOverride.angle, half: row[i].half }
            : row[i];
          if (!hoverRowIsLive(i, row)) continue;
          effective.push(bodyRow);
          shown[i] = bodyRow;
          drawHoverBody(hoverBodySpec(i), bodyRow, color, isHollow(tracked, i));
        }
        // From where each body was DRAWN (the wrap-corrected row on a frozen
        // final frame), so a spring still ends on its body there.
        drawHoverSprings(shown, color);
        // Each inspected point gets its own off-screen arrow in its own hue,
        // so a dozen inspected playbacks that have all left the frame still
        // read as a dozen distinguishable runs rather than one anonymous
        // cluster.
        drawOffscreenMappingArrows(effective, color);
      });
    });

    // The grid mesh pass: for each "grid" group, plot its points at the
    // OUTPUT body's own (x, y) at this step - never the output body itself,
    // just its implied position, per the user's explicit ask - then connect
    // them along each drawn row/column with buildGridMeshSegments' pairs. A
    // separate pass (not interleaved into the loop above) so every grid's
    // mesh always paints over every other group's bodies, "regardless of
    // which point it's from," exactly as asked; also over an earlier grid's
    // mesh, since there's no ordering requirement between multiple grids.
    // Gradient per segment (not lockGridOfPoints' flat averageRgbFill, which
    // only needs to color a short straight SVG line once at creation time)
    // reads just as well here and needs no re-derivation as the two
    // endpoints drift apart during playback.
    inspectedGroups.forEach(function (group) {
      if (group.type !== "grid" || group.outputBodyIndex === null) return;
      var positions = group.points.map(function (entry) {
        var s = Math.min(step, entry.effectiveMaxStep - 1);
        var isFinalFrame = s >= entry.effectiveMaxStep - 1;
        var row = entry.trajectory[s];
        var outputRow = (isFinalFrame && entry.wrapOverride && entry.wrapOverride.bodyIndex === group.outputBodyIndex)
          ? { x: entry.wrapOverride.x, y: entry.wrapOverride.y }
          : row[group.outputBodyIndex];
        return { x: outputRow.x, y: outputRow.y };
      });
      hoverCtx.lineCap = "round";
      hoverCtx.lineWidth = INSPECT_GRID_MESH_LINE_WIDTH / hoverFit.scale;
      group.segments.forEach(function (pair) {
        var a = positions[pair[0]], b = positions[pair[1]];
        var gradient = hoverCtx.createLinearGradient(a.x, a.y, b.x, b.y);
        gradient.addColorStop(0, group.points[pair[0]].color.fill);
        gradient.addColorStop(1, group.points[pair[1]].color.fill);
        hoverCtx.strokeStyle = gradient;
        hoverCtx.beginPath();
        hoverCtx.moveTo(a.x, a.y);
        hoverCtx.lineTo(b.x, b.y);
        hoverCtx.stroke();
      });
    });
  }

  // Draws the wrap boundary itself (see PhysicsEngine.step) so a body
  // crossing it and reappearing on the opposite side reads as "wrapped",
  // not as a glitch - a no-op for a scene with no locked frame, since
  // there's no fixed edge to draw.
  function drawFrameBoundary() {
    if (!scene.frameWidth || !scene.frameHeight) return;
    hoverCtx.strokeStyle = "rgba(255,255,255,0.25)";
    hoverCtx.lineWidth = 1.5 / hoverFit.scale;
    hoverCtx.strokeRect(0, 0, scene.frameWidth, scene.frameHeight);
  }

  // Cheap pure-JS path: no simulation, just this pixel's offset scene at
  // t=0, computed with the same hinge-preserving math the grid shader uses
  // but without touching WebGL. Fires synchronously on every qualifying
  // mousemove, so it has to stay fast. Colors with the exact same fixed
  // baseline+scale formula the grid and the full replay use (not a
  // per-trajectory min/max - there's no trajectory yet, just this one
  // frame) - meaningful and stable the instant it appears, since t=0 of
  // this offset scene is exactly what the eventual replay's first frame
  // will show too.
  // Where an Input is a body's starting VELOCITY, moving across the map
  // changes nothing the instant preview could otherwise show: every pixel's
  // scene starts in the same place, and only how hard the body is thrown
  // differs. So the instant preview - and only it - draws that throw, as the
  // editor's own velocity arrow (same color, same one-pixel-per-unit length,
  // same head), on each body an Input's vx or vy lands on. It follows the
  // hover because the instant preview is redrawn for every hovered pixel; and
  // it is gone the moment the real replay takes over, where the motion itself
  // says the same thing and an arrow frozen at t=0 would contradict it.
  var HOVER_VELOCITY_ARROW_COLOR = "#e06bff"; // physics-ui.js's VELOCITY_ARROW_COLOR
  function drawHoverInputVelocityArrows(offsetScene) {
    var targets = {};
    [scene.xInput, scene.yInput].forEach(function (input) {
      if (input && (input.property === "vx" || input.property === "vy")) targets[input.body] = true;
    });
    var px = 1 / hoverFit.scale; // one preview-canvas pixel, in scene units
    Object.keys(targets).forEach(function (index) {
      var body = offsetScene.bodies[index];
      if (!body) return;
      var vx = body.vx || 0, vy = body.vy || 0;
      var speed = Math.sqrt(vx * vx + vy * vy);
      if (!(speed >= 1) || !isFinite(speed)) return;
      // What the engine will actually start it at: it clamps on the first step.
      var cap = PhysicsEngine.speedCapFor(offsetScene);
      var len = cap > 0 ? Math.min(speed, cap) : speed;
      var ux = vx / speed, uy = vy / speed;
      var tipX = body.x + ux * len, tipY = body.y + uy * len;
      // Sized in preview pixels, not scene units: the preview is the scene
      // shrunk several times over, and a 2.5-unit shaft would vanish.
      var head = Math.min(9 * px, Math.max(5 * px, len * 0.25));
      hoverCtx.save();
      hoverCtx.strokeStyle = HOVER_VELOCITY_ARROW_COLOR;
      hoverCtx.fillStyle = HOVER_VELOCITY_ARROW_COLOR;
      hoverCtx.lineWidth = 2 * px;
      hoverCtx.lineCap = "round";
      hoverCtx.beginPath();
      hoverCtx.moveTo(body.x, body.y);
      hoverCtx.lineTo(tipX - ux * head * 0.6, tipY - uy * head * 0.6);
      hoverCtx.stroke();
      hoverCtx.beginPath();
      hoverCtx.moveTo(tipX, tipY);
      hoverCtx.lineTo(tipX - ux * head - uy * head * 0.45, tipY - uy * head + ux * head * 0.45);
      hoverCtx.lineTo(tipX - ux * head + uy * head * 0.45, tipY - uy * head - ux * head * 0.45);
      hoverCtx.closePath();
      hoverCtx.fill();
      hoverCtx.restore();
    });
  }

  function showHoverInstant(worldPoint) {
    var offsetScene;
    try {
      offsetScene = PhysicsGridCodegen.computeOffsetSceneNumeric(scene, worldPoint.x, worldPoint.y);
    } catch (err) {
      showHoverEmpty("Couldn't preview this point: " + (err.message || err));
      return;
    }
    // No real trajectory exists yet at this instant - just this one JS frame
    // - so the controls show paused-at-the-start and stay disabled until
    // the upgrade below lands and beginPlaybackSession takes over. The
    // slider's range is set here anyway (even disabled, so it isn't stale
    // for the instant it takes the thumb to visually settle there).
    activeReplay = null;
    playbackStep = 0;
    playbackConfiguredMax = hoverStepCount();
    hoverProgressSlider.min = "0";
    hoverProgressSlider.max = String(Math.max(0, playbackConfiguredMax - 1));
    updateProgressSliderPosition();
    setPlaybackControlsEnabled(false);
    playbackPlaying = false;
    updatePlayPauseButtonUI();

    hoverEmptyState.hidden = true;
    hoverCtx.setTransform(1, 0, 0, 1, 0, 0);
    hoverCtx.clearRect(0, 0, hoverCanvas.width, hoverCanvas.height);
    hoverCtx.setTransform(hoverFit.scale, 0, 0, hoverFit.scale, hoverFit.offsetX, hoverFit.offsetY);
    drawFrameBoundary();
    var previewTracked = trackedBodySlots(null);
    offsetScene.bodies.forEach(function (body, i) {
      drawHoverBody(hoverBodySpec(i), {
        x: body.x,
        y: body.y,
        angle: body.angle,
        // PhysicsGPU.shapeHalf, not a local ternary: this is the same
        // quantity the shader packs into the trajectory's alpha channel, so
        // asking the one function for it is what keeps the instant preview
        // and the GPU replay that replaces it drawing the same sizes. The
        // local version got it wrong for a trapezoid, which has no `length`
        // at all - undefined/2 is NaN, and a NaN coordinate draws nothing,
        // which is why a funnel or splitter was invisible until the replay
        // loaded and supplied a real number.
        half: PhysicsGPU.shapeHalf([body], 0),
      }, undefined, isHollow(previewTracked, i));
    });
    drawHoverSprings(offsetScene.bodies.map(function (body) {
      return { x: body.x, y: body.y, angle: body.angle, half: PhysicsGPU.shapeHalf([body], 0) };
    }));
    drawHoverInputVelocityArrows(offsetScene);
    // The inspected point's own t=0 state - "both play on top of each other"
    // starts here, before either has even upgraded to a real replay.
    drawInspectedAtStep(0);
    if (inspectedGroups.length > 0) {
      // Reconciling multiple scenes' Output values into one background
      // color isn't attempted - see drawInspectedAtStep's own comment
      // for how each scene is told apart instead (its own color, not
      // background).
      hoverCanvas.style.backgroundColor = "";
    } else {
      // Scene Lifespan has no meaningful value before the real replay has
      // even run - show it as "hasn't crossed yet" (the same value a run
      // that never crosses settles on) until the upgrade below corrects it.
      // Bounce Count is 0 here by definition - this is the scene's starting
      // state, before any step has run, so nothing has bounced yet.
      var v0 = scene.output.property === "lifespan" ? simulationSteps
        : isBouncesOutput ? 0
        : PhysicsEngine.computeOutputValue(offsetScene, scene.output);
      hoverCanvas.style.backgroundColor = hoverOutputColor(outputColorT(v0));
    }
    hoverReadout.textContent = "X: " + worldPoint.x.toFixed(5) + ", Y: " + worldPoint.y.toFixed(5) + " - loading replay…";
  }

  // Steps per real second the replay plays back at. Derived from the
  // per-frame duration and NOTHING else - in particular not from how many
  // steps the run has, which is what makes a replay's length proportional to
  // its step count - scaled by the user's own playbackSpeed (shared with the
  // Map Evolution timeline - see the Playback speed section) on top of that
  // fixed base rate. Expressed as a rate rather than "steps per
  // callback" because the tick is driven by wall-clock elapsed time (see
  // playbackTick for why that distinction matters).
  function hoverStepsPerSecond() {
    return (1000 / HOVER_MS_PER_FRAME) * playbackSpeed;
  }

  // One frame of whatever is currently showing, at `playbackStep` - the
  // shared body between auto-play's rAF loop and a manual slider drag, so
  // scrubbing while paused draws exactly the frame playing would have
  // shown at that point. activeReplay's own effectiveMaxStep (or, in
  // Inspect-only mode, each inspected point's) mirrors physics-ui.js's
  // effectiveMaxSteps: when Sticky Edges found the Output body wrapping
  // partway through a trajectory (see runHoverAt/computeTrajectoryEntry),
  // that entry freezes there instead of continuing through the teleport -
  // the readout keeps showing the FULL trajectory.length as "/ N" (the run
  // really was only ever logged that far) rather than silently changing
  // the denominator, while everything else on screen keeps going until ITS
  // own final frame.
  function renderPlaybackFrame() {
    var step = Math.floor(playbackStep);
    hoverCtx.setTransform(1, 0, 0, 1, 0, 0);
    hoverCtx.clearRect(0, 0, hoverCanvas.width, hoverCanvas.height);
    hoverCtx.setTransform(hoverFit.scale, 0, 0, hoverFit.scale, hoverFit.offsetX, hoverFit.offsetY);
    drawFrameBoundary();

    var row, hoveredStep, isFinalFrame;
    if (activeReplay) {
      var effectiveMaxStep = activeReplay.effectiveMaxStep;
      hoveredStep = Math.min(effectiveMaxStep - 1, step);
      row = activeReplay.trajectory[hoveredStep];
      isFinalFrame = hoveredStep >= effectiveMaxStep - 1;
      var effectiveRow = [], shownRows = [], replayTracked = trackedBodySlots(activeReplay.lineageSlots);
      for (var i = 0; i < row.length; i++) {
        // wrapOverride has no `half` (a resize-link's rendered size is
        // unaffected by this x/y/angle correction) - keep this step's own.
        var bodyRow = (isFinalFrame && activeReplay.wrapOverride && i === activeReplay.wrapOverride.bodyIndex)
          ? { x: activeReplay.wrapOverride.x, y: activeReplay.wrapOverride.y, angle: activeReplay.wrapOverride.angle, half: row[i].half }
          : row[i];
        if (!hoverRowIsLive(i, row)) continue;
        effectiveRow.push(bodyRow);
        shownRows[i] = bodyRow;
        drawHoverBody(hoverBodySpec(i), bodyRow, undefined, isHollow(replayTracked, i));
      }
      // Indexed by body, and from where each was drawn - see drawInspectedAtStep.
      drawHoverSprings(shownRows);
      // The corrected row, not the raw one, so an arrow points at where its
      // body was actually drawn on a wrap-stopped final frame.
      drawOffscreenMappingArrows(effectiveRow);
    }

    // step (not activeReplay's own capped hoveredStep) drives this - an
    // inspected point keeps playing even after the hovered scene above has
    // frozen.
    drawInspectedAtStep(step);

    if (inspectedGroups.length > 0) {
      // Reconciling multiple scenes' Output values into one background
      // color isn't attempted - see drawInspectedAtStep's own comment
      // for how each scene is told apart instead (its own color, not
      // background).
      hoverCanvas.style.backgroundColor = "";
    } else if (activeReplay) {
      // Lifespan is a single fact about the whole run (when did some body
      // first cross an edge), not a per-step positional readout - it's
      // already fully known once runHoverAt's own findWrapStopStep call
      // ran, so it just holds at lifespanValue for every frame instead of
      // varying as the animation plays.
      var v = activeReplay.lifespanValue !== null ? activeReplay.lifespanValue
        : activeReplay.bounceCounts ? activeReplay.bounceCounts[Math.min(hoveredStep, activeReplay.bounceCounts.length - 1)]
        : hoverOutputValue(row, activeReplay.lineageSlots, activeReplay.wrapOverride, isFinalFrame, activeReplay.extraWrapOverrides);
      // Every frame but the last uses the toned-down OKLCH color (see
      // hoverOutputColor) since it's still animating; the last one holds
      // still from here on, so it switches to the grid's own real HSL
      // color instead - the flashing concern doesn't apply to something
      // that's no longer changing, and this way the frozen frame shows
      // exactly what this pixel looks like on the grid itself.
      hoverCanvas.style.backgroundColor = isFinalFrame ? hoverOutputColorFinal(outputColorT(v)) : hoverOutputColor(outputColorT(v));
    }

    if (activeReplay) {
      hoverReadout.textContent = "X: " + activeReplay.worldPoint.x.toFixed(5) + ", Y: " + activeReplay.worldPoint.y.toFixed(5) +
        " - step " + (hoveredStep + 1) + " / " + activeReplay.trajectory.length;
    } else {
      var overallMaxStep = playbackClockCeiling();
      var inspectedCount = totalInspectedPointCount();
      hoverReadout.textContent = "Inspecting " + inspectedCount + " point" + (inspectedCount === 1 ? "" : "s") +
        " - step " + (Math.min(overallMaxStep - 1, step) + 1) + " / " + overallMaxStep;
    }
    updateProgressSliderPosition();
    // Every frame the preview shows - playing, scrubbed, reset or looped -
    // passes through here, so this one call is the whole of what keeps the
    // map in lockstep with it. Unconditional: with Map Evolution shut,
    // followInspection is itself a no-op, so there is nothing here for a
    // caller to have to opt out of.
    syncMapToInspection();
  }

  // Every trajectory-bearing thing currently on screen, in the exact order
  // its own bounce/edge sound should be pitched - the hovered scene first
  // (if any), then each Inspect point/line/grid point in the same order
  // they're listed (#inspect-list), and within a line/grid group, in that
  // group's own point order (a line along its length, a grid row-major) -
  // since inspectedGroups already stores groups and points in exactly those
  // orders, flattening it in place preserves them for free.
  function activeVoiceEntries() {
    var entries = activeReplay ? [activeReplay] : [];
    inspectedGroups.forEach(function (group) { entries = entries.concat(group.points); });
    return entries;
  }

  // Bounce/edge sounds for whatever advanced between the last frame and
  // this one - called only from playbackTick's own auto-advance, never from
  // scrubbing the progress slider or Reset, which jump the shared clock
  // without it having actually "played" anything in between. fromStep was
  // already shown (by the previous call, or the session's own initial
  // synchronous render), toStep is about to be; a step index e therefore
  // counts as newly reached exactly when fromStep < e <= toStep - an
  // INCLUSIVE upper bound, not e < toStep, because playbackTick's own clock
  // caps at ceiling-1 (see playbackClockCeiling), never ceiling itself. An
  // entry whose own effectiveMaxStep-1 equals that shared ceiling-1 would
  // otherwise never satisfy a strict "<", since toStep can never exceed the
  // very value being compared against - silently dropping every edge sound
  // (always exactly at that boundary) and any bounce unlucky enough to land
  // on an entry's own last reachable step.
  function checkPlaybackSounds(fromStep, toStep) {
    if (PhysicsSound.isMuted() || toStep <= fromStep) return;
    var entries = activeVoiceEntries();
    var freqs = PhysicsSound.chordFrequencies(entries.length);
    entries.forEach(function (entry, i) {
      // bounceEvents was computed over the point's full configured step
      // count, independent of whether THIS entry stopped early on a sticky
      // edge - so it can hold events past this entry's own effectiveMaxStep
      // that its display (frozen at effectiveMaxStep-1, see
      // renderPlaybackFrame's own clamp) never actually reaches, even while
      // the shared clock keeps advancing for other, longer-lived entries.
      var lastVisibleStep = entry.effectiveMaxStep - 1;
      var bounced = false;
      for (var e = 0; e < entry.bounceEvents.length; e++) {
        var ev = entry.bounceEvents[e];
        if (ev > lastVisibleStep) break; // sorted ascending - nothing further is reachable either
        if (ev > fromStep && ev <= toStep) { bounced = true; break; }
      }
      if (bounced) PhysicsSound.playBounce(freqs[i]);
      // The sticky-edge stop is a single terminal event, the same one that
      // already freezes this entry's own display at effectiveMaxStep - only
      // fires the instant playback first reaches it, and only when it's a
      // genuine edge stop (wrapOverride set), not just this entry's own
      // trajectory running out.
      var finalStep = entry.effectiveMaxStep - 1;
      if (entry.wrapOverride && finalStep > fromStep && finalStep <= toStep) {
        PhysicsSound.playEdge(freqs[i]);
      }
    });
  }

  // Driven by elapsed wall-clock time, not "advance N steps per callback":
  // requestAnimationFrame fires whenever the browser is ready to paint -
  // nominally the display's refresh interval, but not a fixed timer, so it
  // stretches under system load or background-tab throttling. Always
  // advancing by the same amount per callback would let the whole replay
  // silently slow down along with it; instead every callback adds however
  // much real time just passed (scaled to steps) onto the accumulator and
  // jumps straight to its floor, so total replay duration stays tied to
  // hoverStepsPerSecond() regardless of how often callbacks actually land.
  // Unlike the old wall-clock-since-start version this replaced, that
  // accumulator (playbackStep) can be paused (stop adding to it), seeked
  // (set it directly), and resumed (keep adding from wherever it is) - see
  // pausePlayback/resumePlayback and the control listeners below.
  function playbackTick() {
    // An inspected point can be cleared out from under an already-running
    // Inspect-only preview (see removeInspectedGroup/clearInspected, which
    // both route through restartCurrentPreview) - bail to the real empty
    // state rather than animate nothing. In practice this never actually
    // fires (that same call chain already stops this loop first), but it's
    // the same insurance the old per-mode tick had.
    if (!activeReplay && inspectedGroups.length === 0) { hoverRafId = null; showHoverEmpty(); return; }
    var now = performance.now();
    var dt = (now - playbackLastTickTime) / 1000;
    playbackLastTickTime = now;
    var ceiling = playbackClockCeiling();
    var prevStep = Math.floor(playbackStep);
    playbackStep = Math.min(ceiling - 1, playbackStep + dt * hoverStepsPerSecond());
    checkPlaybackSounds(prevStep, Math.floor(playbackStep));
    renderPlaybackFrame();
    if (playbackStep >= ceiling - 1) {
      hoverRafId = null;
      // With Map Evolution open this clock is the MAP's clock too, and a
      // map run ends at its last frame rather than starting over - so it
      // stops here, frozen on the final frame, and Play from there begins
      // again at 0 (see resumePlayback). Inspect on its own still loops.
      if (playbackMenu.isOpen()) {
        playbackPlaying = false;
        updatePlayPauseButtonUI();
        syncMapToInspection();
        return;
      }
      // Everything on screen has reached its final logged frame - hold
      // there for a beat, then play the whole thing again from the start
      // unless the user paused during the hold.
      hoverLoopTimer = setTimeout(function () {
        hoverLoopTimer = null;
        if (!playbackPlaying) return;
        // Opening Map Evolution during the hold turns this run into a map
        // run, which doesn't start over - the same rule as above, applied
        // to a loop that was already queued when the card came up.
        if (playbackMenu.isOpen()) { playbackPlaying = false; updatePlayPauseButtonUI(); syncMapToInspection(); return; }
        playbackStep = 0;
        playbackLastTickTime = performance.now();
        playbackAutoStartedAt = performance.now();
        renderPlaybackFrame();
        hoverRafId = requestAnimationFrame(playbackTick);
      }, REPLAY_LOOP_DELAY_MS);
      return;
    }
    hoverRafId = requestAnimationFrame(playbackTick);
  }

  function ensurePlaybackAdvancing() {
    if (hoverRafId) return; // already ticking
    playbackLastTickTime = performance.now();
    hoverRafId = requestAnimationFrame(playbackTick);
  }

  function pausePlayback() {
    playbackPlaying = false;
    if (hoverRafId) cancelAnimationFrame(hoverRafId);
    hoverRafId = null;
    if (hoverLoopTimer) clearTimeout(hoverLoopTimer);
    hoverLoopTimer = null;
    updatePlayPauseButtonUI();
    // Pausing doesn't draw a frame, so the map has to be told separately.
    syncMapToInspection();
  }

  function resumePlayback() {
    // Resuming after the end (or being paused right there) restarts from
    // the top, same as the auto-loop in playbackTick above.
    if (playbackStep >= playbackClockCeiling() - 1) playbackStep = 0;
    playbackPlaying = true;
    updatePlayPauseButtonUI();
    ensurePlaybackAdvancing();
    syncMapToInspection();
  }

  // The one entry point for "start showing something new": a fresh hover
  // point (runHoverAt) or Inspect-only preview (beginInspectOnlySession).
  // Always starts at step 0 and, unless autoplay is explicitly suppressed,
  // auto-plays - restarting from 0 is what guarantees a newly-added
  // inspected point starts in sync with everything already on screen (see
  // restartCurrentPreview) - and always stops whatever was animating
  // before it, so a slow point that finishes compiling after the cursor
  // has moved on can't draw over a session that has since moved on to
  // something else.
  function beginPlaybackSession(replay, autoplay) {
    if (autoplay === undefined) autoplay = true;
    stopHoverReplay();
    unlinkMapWhereItIs();
    activeReplay = replay || null;
    playbackStep = 0;
    playbackConfiguredMax = hoverStepCount();
    hoverProgressSlider.min = "0";
    hoverProgressSlider.max = String(Math.max(0, playbackConfiguredMax - 1));
    setPlaybackControlsEnabled(true);
    playbackPlaying = autoplay;
    playbackAutoStartedAt = performance.now();
    updatePlayPauseButtonUI();
    if (autoplay) ensurePlaybackAdvancing();
    renderPlaybackFrame();
    hoverEmptyState.hidden = true;
  }

  hoverPlayPauseBtn.addEventListener("click", function () {
    if (!playbackHasSession) return;
    if (playbackPlaying) {
      // See PLAY_PAUSE_GRACE_MS above - a click landing this soon after
      // playback started on its own almost certainly meant to start it,
      // which already happened.
      if (performance.now() - playbackAutoStartedAt < PLAY_PAUSE_GRACE_MS) return;
      linkMapToPreview();
      pausePlayback();
    } else {
      linkMapToPreview();
      resumePlayback();
    }
  });

  hoverProgressSlider.addEventListener("input", function () {
    if (!playbackHasSession) return;
    linkMapToPreview();
    pausePlayback();
    playbackStep = Number(hoverProgressSlider.value);
    renderPlaybackFrame();
  });

  hoverResetBtn.addEventListener("click", function () {
    if (!playbackHasSession) return;
    linkMapToPreview();
    pausePlayback();
    playbackStep = 0;
    renderPlaybackFrame();
  });

  // Bounce Count's per-step running totals for one point, from the JS engine
  // running the same offset scene the GPU pixel does (see renderPlaybackFrame
  // for why the GPU trajectory can't supply this). The two engines agree to well
  // under a pixel over these step counts, and a bounce count is a small
  // integer rather than a continuous readout, so the JS answer matches the
  // pixel's own except in the rare case where a grazing contact lands on
  // opposite sides of the threshold in the two.
  function bounceCountsAt(worldPoint, steps) {
    try {
      var offsetScene = PhysicsGridCodegen.computeOffsetSceneNumeric(scene, worldPoint.x, worldPoint.y);
      return PhysicsEngine.runBounceCounts(offsetScene, scene.output.body, steps, PhysicsGPU.FIXED_DT);
    } catch (err) {
      return null; // same "a preview must never break the page" rule as showHoverInstant's own catch
    }
  }

  // The bounce sound effect's own event source for one point (see
  // PhysicsEngine.runBounceEvents and checkPlaybackSounds below) - another
  // JS re-simulation of the same offset scene, same reasoning as
  // bounceCountsAt just above: a GPU trajectory logs positions only,
  // nothing about contact. Failure here never costs the point/line/grid
  // entry it's attached to - an empty event list (that one point just never
  // plays a bounce sound) is a far smaller loss than dropping it outright.
  function bounceEventsAt(worldPoint, steps) {
    try {
      var offsetScene = PhysicsGridCodegen.computeOffsetSceneNumeric(scene, worldPoint.x, worldPoint.y);
      return PhysicsEngine.runBounceEvents(offsetScene, steps, PhysicsGPU.FIXED_DT);
    } catch (err) {
      return [];
    }
  }

  // Which body slots end up in the Output's lineage for one point - null for
  // any scene without a splitter, where the answer is always just the Output
  // body itself and nothing needs averaging.
  //
  // The grid shader colors a splitter scene's pixel by the AVERAGE over the
  // lineage (see buildFragmentShader), so the replay has to as well or the
  // panel's background stops being the color of the pixel it is replaying -
  // the one property this feature exists to have. A GPU trajectory has no
  // spare channel to carry a lineage tag in (x, y and angle fill RGB, the
  // rendered half fills alpha), so it comes from the JS engine running the
  // same offset scene, exactly like bounceCountsAt above: the two agree on
  // WHICH slot a split wakes, which is all that's read here - the values
  // averaged are still the GPU's own, so the color stays derived from the
  // positions actually being drawn.
  function outputLineageSlotsAt(worldPoint, steps) {
    var heads = PhysicsEngine.outputBodyIndices(scene.output);
    if (!PhysicsGPU.sceneHasSplitter(scene) || !heads.length) return null;
    try {
      var offsetScene = PhysicsGridCodegen.computeOffsetSceneNumeric(scene, worldPoint.x, worldPoint.y);
      var rows = PhysicsEngine.runTrajectory(offsetScene, steps, PhysicsGPU.FIXED_DT);
      var last = rows[rows.length - 1];
      // Grouped BY HEAD, not flattened: a pair Output is the mean of two
      // bodies, each of which is its own lineage average - flattening would
      // weight the half that happened to split more times.
      var groups = heads.map(function (head) {
        var slots = [];
        for (var b = 0; b < last.length; b++) if (last[b].lineage === head) slots.push(b);
        return slots.length ? slots : [head];
      });
      return groups;
    } catch (err) {
      return null;
    }
  }

  // The Output value for one replay frame. Without a lineage (every scene
  // that has no splitter) this is the single read it always was. With one,
  // it is the mean over whichever members have actually been woken by this
  // step - a slot reports half = 0 until a split fills it, so the average
  // grows from one ball to two to four exactly as the shader's does.
  function hoverOutputValue(row, lineageGroups, wrapOverride, isFinalFrame, extraWrapOverrides) {
    var prop = scene.output.property;
    var heads = PhysicsEngine.outputBodyIndices(scene.output);
    // Every reconstruction available for this stopping frame, keyed by the
    // body it describes - the primary one plus a pair's second half.
    var overrides = {};
    if (isFinalFrame && wrapOverride) overrides[wrapOverride.bodyIndex] = wrapOverride;
    (extraWrapOverrides || []).forEach(function (o) { if (isFinalFrame && o) overrides[o.bodyIndex] = o; });
    // One value per authored head: its lineage average when the scene
    // splits, its own reading otherwise - and on a wrap-stopped final frame,
    // the continuous reconstruction instead of the discrete sample.
    function valueFor(headPos, axis) {
      var slots = lineageGroups ? lineageGroups[headPos] : [heads[headPos]];
      var sum = 0, count = 0;
      for (var i = 0; i < slots.length; i++) {
        var idx = slots[i];
        if (!row[idx]) continue;
        if (idx >= scene.bodies.length && !(row[idx].half > 0)) continue; // not woken yet at this step
        sum += overrides[idx] ? overrides[idx][axis] : row[idx][axis];
        count++;
      }
      return count > 0 ? sum / count : 0;
    }
    if (prop === "distance") {
      var d = PhysicsEngine.shortestSeparation(scene,
        valueFor(1, "x") - valueFor(0, "x"), valueFor(1, "y") - valueFor(0, "y"));
      return Math.sqrt(d.x * d.x + d.y * d.y);
    }
    var total = 0;
    for (var h = 0; h < heads.length; h++) total += valueFor(h, prop);
    return heads.length ? total / heads.length : 0;
  }

  function runHoverAt(worldPoint) {
    var compiled, trajectory;
    var steps = hoverStepCount();
    try {
      // Compiled at whatever precision the grid itself is currently
      // showing, so the replay is of the pixel actually under the cursor
      // rather than of a float32 approximation to it.
      compiled = PhysicsGridCodegen.compileHoverTrajectoryGLSL(scene, worldPoint.x, worldPoint.y, steps, effectivePrecision(), worldPoint.xLo, worldPoint.yLo);
      trajectory = PhysicsGPU.runCompiledTrajectoryOnGPU(compiled, steps);
    } catch (err) {
      showHoverEmpty("Couldn't replay this point: " + (err.message || err));
      return;
    }
    if (trajectory.length === 0) { showHoverEmpty("This scene has no bodies to replay."); return; }
    var isLifespan = scene.output.property === "lifespan";
    var stopStep = null, wrapOverride = null, lifespanValue = simulationSteps;
    var extraWrapOverrides = [];
    if (scene.edgeMode === "sticky") {
      // The exact same JS-numeric initial state showHoverInstant already
      // uses for this point - needed here only as findWrapStopStep's
      // pre-simulation baseline (see its own comment on why traj[0] alone
      // isn't enough).
      var initialAtPoint = PhysicsGridCodegen.computeOffsetSceneNumeric(scene, worldPoint.x, worldPoint.y);
      var watchedIndices = PhysicsHingeGeometry.wrapWatchedBodyIndices(scene);
      // Bounce Count, like Scene Lifespan, isn't a position - there's no
      // output body whose final coordinates need reconstructing, so
      // findWrapStopStep picks the body that actually crossed instead.
      var heads = (isLifespan || isBouncesOutput) ? [] : PhysicsEngine.outputBodyIndices(scene.output);
      var targetBodyIndex = heads.length ? heads[0] : null;
      var wrapStop = PhysicsHingeGeometry.findWrapStopStep(trajectory, watchedIndices, targetBodyIndex, scene.frameWidth, scene.frameHeight, initialAtPoint.bodies, PhysicsGPU.FIXED_DT);
      if (wrapStop !== null) {
        stopStep = Math.max(1, wrapStop.step);
        wrapOverride = wrapStop;
        lifespanValue = wrapStop.step + wrapStop.tFrac / PhysicsGPU.FIXED_DT;
        // A pair Output needs BOTH halves reconstructed on the stopping
        // frame - the shader does both (see outputIndices in
        // buildFragmentShader), so averaging one continuous value with one
        // discrete sample here would make the panel disagree with the very
        // pixel it is replaying. Same scan, different target: the stopping
        // step is a property of the run, only the reconstruction differs.
        extraWrapOverrides = heads.slice(1).map(function (idx) {
          return PhysicsHingeGeometry.findWrapStopStep(trajectory, watchedIndices, idx, scene.frameWidth, scene.frameHeight, initialAtPoint.bodies, PhysicsGPU.FIXED_DT);
        }).filter(Boolean);
      }
    }
    var effectiveMaxStep = stopStep != null ? Math.min(trajectory.length, stopStep) : trajectory.length;
    beginPlaybackSession({
      trajectory: trajectory,
      worldPoint: worldPoint,
      effectiveMaxStep: effectiveMaxStep,
      wrapOverride: wrapOverride,
      lifespanValue: isLifespan ? lifespanValue : null,
      bounceCounts: isBouncesOutput ? bounceCountsAt(worldPoint, steps) : null,
      lineageSlots: isLifespan || isBouncesOutput ? null : outputLineageSlotsAt(worldPoint, steps),
      extraWrapOverrides: extraWrapOverrides,
      bounceEvents: bounceEventsAt(worldPoint, steps),
      // Open Map Evolution means the map is playing this same clock, and
      // a map run is something the user starts - so a hover lands on the
      // replay's first frame (which IS this point's starting state, the
      // same picture the instant preview just drew) and waits there.
    }, /* autoplay */ !playbackMenu.isOpen());
  }

  // Shown instead of the ordinary "hover the grid to preview a pixel" empty
  // state whenever the cursor leaves the grid while one or more points are
  // inspected - there's already something worth looking at, so it keeps
  // playing back every inspected point together (no extra hovered scene,
  // same as while actively inspecting) rather than going blank. Just
  // beginPlaybackSession with no hovered replay of its own - renderPlaybackFrame
  // and playbackTick already read inspectedGroups fresh every frame, so
  // removing a point (or clearing all) while this is showing is picked up
  // immediately, including falling back to the real empty state if that
  // empties the array entirely.
  function beginInspectOnlySession() {
    beginPlaybackSession(null, /* autoplay */ !playbackMenu.isOpen());
  }

  canvas.addEventListener("mousemove", function (e) {
    isHoveringGrid = true;
    if (dragging) return; // don't fight panning - only preview while not dragging the view
    // Nowhere to draw a preview, and nobody to hear its bounce tones - see
    // the Inspect menu's own comment on why a shut card stops the work
    // instead of hiding it.
    if (!inspectMenu.isOpen()) return;
    var uv = pixelToUV(e.clientX, e.clientY);
    // Snap to the nearest backing-store pixel's world size so tiny cursor
    // jitter within the same rendered grid cell doesn't trigger redundant
    // work - matches the actual resolution the main view is sampling at, so
    // "the cell under the cursor" is well-defined.
    var world = snappedWorldPointAtUV(uv.uvx, uv.uvy);
    // Which CELL of which view, not the point's own digits: past float64's
    // resolution every cell on screen prints the same six decimals.
    var key = world.cell + " " + viewCenterKey() + " " + view.scale;
    if (key === hoverKey) return; // already showing (or about to show) this exact cell
    hoverKey = key;
    hoverWorldPoint = world;
    // Kept updating above regardless - so that removing the last inspected
    // point (which itself calls restartCurrentPreview) can fall straight
    // back to previewing whatever cell the cursor is already sitting over,
    // no extra move needed - but once at least one point/line/grid is
    // locked, the panel belongs to THEM: it no longer swaps in a preview of
    // the currently-hovered cell's own trajectory alongside whatever is
    // already playing back.
    if (inspectedGroups.length > 0) return;
    stopHoverReplay(); // a previous cell's replay may still be animating - don't let it keep drawing over the new cell's preview
    if (hoverUpgradeTimer) clearTimeout(hoverUpgradeTimer);
    showHoverInstant(world);
    hoverUpgradeTimer = setTimeout(function () {
      if (key !== hoverKey) return; // cursor moved on before the dwell delay elapsed - superseded
      runHoverAt(world);
    }, HOVER_UPGRADE_DELAY_MS);
  });
  canvas.addEventListener("mouseleave", function (e) {
    // The playback controls sit in the floating panel, not on the canvas -
    // reaching them to pause, scrub, reset, or adjust speed necessarily
    // crosses OUT of the canvas first, which would otherwise fire this same
    // handler and blow away the very session the click was meant to
    // control. Moving onto them isn't "done looking at this," so leave
    // everything exactly as it is; there's no matching re-entry needed
    // since nothing here touches the display until the grid itself is
    // hovered or clicked again. hoverSpeedPopup is checked separately from
    // hoverPlaybackControlsEl: it's a fixed-position element living outside
    // the row (see its own HTML comment), so it can visually sit right over
    // the canvas without being one of that row's DOM descendants.
    if (e.relatedTarget && (hoverPlaybackControlsEl.contains(e.relatedTarget) || hoverSpeedPopup.contains(e.relatedTarget))) return;
    isHoveringGrid = false;
    // Moving onto the Inspect bar itself (the sidebar list of locked
    // points, its buttons, etc.) isn't "done looking at this" either - if a
    // locked-group session is already playing, leave it running right where
    // it is instead of restarting it from step 0.
    // (The card is asked as well as the menu it belongs to: while the dock
    // holds it, the card is not inside #menu-inspect - see "The dock".)
    if (e.relatedTarget && (inspectMenuEl.contains(e.relatedTarget) || inspectMenu.card.contains(e.relatedTarget)) && inspectedGroups.length > 0 && playbackHasSession) return;
    if (inspectedGroups.length > 0) { beginInspectOnlySession(); } else { showHoverEmpty(); }
  });

  // ---- Global Stats ----
  //
  // The card under the gear button measures the fractal CURRENTLY ON
  // SCREEN: not the scene, not the whole fractal, just whichever rectangle
  // of it the view is framing right now. Every number in it therefore stops
  // being true the moment the user pans or zooms, which shapes everything
  // below.
  //
  // Three rules, all of them the user's own: nothing is measured unless the
  // card is open; only the one section that is open on it is measured; and
  // the measuring starts as soon as the view stops moving, without waiting
  // for the refinement ladder to finish - the card should fill in while the
  // picture is still sharpening, not after. It still never runs on the
  // render path: a short settle after the last view change, then the work
  // goes through requestIdleCallback slices - the GPU sampling banded
  // against the same adaptive pixel budget the ladder uses, and the
  // arithmetic split into steps by fractal-stats.js. Any view change at all
  // abandons whatever is in flight, mid-slice, and the card dims to say the
  // numbers on it are about somewhere else now.
  //
  // What gets measured is a re-render of the view into an offscreen float
  // target (the same drawSampleRows the superlative buttons use), NOT a
  // readback of the canvas. The canvas is 8-bit color that has already
  // been through a hue ramp; turning that back into values would be lossy
  // where the ramp is steep, ambiguous under Color Zoom's repeats, and
  // wrong wherever antialiasing averaged two hues into a third that no
  // pixel actually holds. Sampling t directly avoids all three.

  // ---- How finely to sample the view ----
  //
  // The block the whole card is measured from is a re-render of the view at
  // its own resolution, which need not be the screen's: one simulation per
  // rendered pixel measures exactly what is on screen, at several million
  // simulations a go, and one per 8 pixels each way describes the broad
  // shape of the picture at a sixty-fourth of the cost. Which of those the
  // user wants depends on the device as much as on what they are looking
  // for, so it is a slider under Settings > Performance Settings > Advanced
  // (#stats-sample-slider) rather than a constant here. Full is the default:
  // the connected-feature measurements (longest ridge and longest valley)
  // find real structure at full resolution where a coarse block finds
  // specks, and the work only happens while the Analysis card is open.
  var STATS_SAMPLE_FRACTIONS = [
    { fraction: 1 / 8, label: "1/8" },
    { fraction: 1 / 4, label: "1/4" },
    { fraction: 1 / 2, label: "1/2" },
    { fraction: 1, label: "Full" },
  ];
  var statsSampleStop = STATS_SAMPLE_FRACTIONS.length - 1;

  // The block the current stop asks for, in samples: the canvas scaled by
  // the fraction, so the sampled rectangle is the one on screen rather than
  // a stretched version of it - which matters here far more than it does
  // for the superlative buttons, since the Rose Plot is about direction.
  // Never past one sample per rendered pixel (two samples would run the
  // same simulation the grid ran once) and never past what one texture can
  // hold.
  function statsSampleBlock() {
    var f = STATS_SAMPLE_FRACTIONS[statsSampleStop].fraction;
    var cw = Math.max(1, canvas.width), ch = Math.max(1, canvas.height);
    return {
      width: Math.min(MAX_TEXTURE_SIZE, Math.max(8, Math.round(cw * f))),
      height: Math.min(MAX_TEXTURE_SIZE, Math.max(8, Math.round(ch * f))),
      full: f >= 1,
    };
  }

  // How long after the last view change before measuring. Long enough that
  // a pan which pauses briefly and resumes never triggers a run at all.
  var STATS_SETTLE_DELAY_MS = 400;
  // requestIdleCallback's own deadline. Reached, it fires anyway on a busy
  // page - which is handled by doing a single step in that case (see
  // runStatsSlice) rather than a whole slice, so progress continues without
  // competing with whatever is keeping the page busy.
  var STATS_IDLE_TIMEOUT_MS = 2000;
  // One degree per bin, as asked - the rose smooths for display but the
  // reported peak direction comes from these.
  var STATS_ORIENTATION_BINS = 180;
  var STATS_HISTOGRAM_BUCKETS = 96;
  // Ceiling on one band's readback buffer, in samples - four floats each,
  // so this is a 4MB Float32Array however far the resolution slider is
  // pushed.
  var STATS_MAX_BAND_SAMPLES = 262144;

  var statsPanel = null;        // the FractalStatsPanel instance, once built
  var statsSampleSlider = document.getElementById("stats-sample-slider");
  var statsSampleReadout = document.getElementById("stats-sample-readout");
  // "Full (1920 × 1080)": the stop's name and the block it comes to on this
  // screen, since a fraction alone says nothing about the cost.
  function updateStatsSampleReadout() {
    if (!statsSampleReadout) return;
    var block = statsSampleBlock();
    statsSampleReadout.textContent = STATS_SAMPLE_FRACTIONS[statsSampleStop].label +
      " (" + block.width + " × " + block.height + ")";
  }
  var statsOpen = false;
  var statsRun = null;          // the measurement in flight, if any
  // Bumped by every view change. A slice belonging to an older generation
  // is measuring a view that no longer exists and stops immediately - which
  // is what makes abandoning a run mid-slice safe without any other state.
  var statsGeneration = 0;
  var statsSliceHandle = null;
  var statsSettleTimer = null;
  var statsHasResult = false;
  // Whether that result describes the view currently on screen, as opposed
  // to one the user has since panned away from.
  var statsResultIsCurrent = false;
  // The "here is what was measured" line, kept so a switch moved after the
  // fact can restore it rather than leaving the card reading "measuring…"
  // when nothing is being measured.
  var statsLastStatus = "";
  // Remembered rather than read from statsRun: the panel re-renders its
  // sections (a chart redraw, the histogram's own log/linear switch) long
  // after the run that produced them has been torn down, and those renders
  // still have to turn a sample's column/row back into world coordinates.
  var statsLastWidth = 1, statsLastHeight = 1;

  var hasIdleCallback = typeof window.requestIdleCallback === "function";
  function requestStatsSlice(fn) {
    if (hasIdleCallback) return window.requestIdleCallback(fn, { timeout: STATS_IDLE_TIMEOUT_MS });
    // Safari before 16.4 has no idle callback at all. A plain timeout on a
    // frame-ish cadence is the honest fallback: it can't know whether the
    // page is busy, so each slice is kept short instead.
    return setTimeout(function () { fn(null); }, 32);
  }
  function cancelStatsSlice(handle) {
    if (handle === null) return;
    if (hasIdleCallback) window.cancelIdleCallback(handle);
    else clearTimeout(handle);
  }

  function outputPropertyLabel() {
    var prop = scene.output.property;
    if (prop === "x") return "Center X";
    if (prop === "y") return "Center Y";
    if (prop === "angle") return "Rotation";
    if (prop === "distance") return "Distance Apart";
    if (prop === "lifespan") return "Scene lifespan";
    if (prop === "bounces") return "Bounce Count";
    return prop;
  }

  // How many Output units one whole unit of t is worth. Exact for every
  // property whose t is a plain division; for Infinite Space (where t comes
  // out of a sigmoid) it is the frame dimension, which is the right scale
  // but not a constant ratio - the one place this is used says so.
  function statsValueSpan() {
    return isBouncesOutput ? bounceMaxValue : currentOutputRangeMax();
  }

  // Every number this page REPORTS is in the coordinate system the scene is
  // authored and read in - origin at the frame's center, +y up, and so
  // +rotation counter-clockwise (see physics-coords.js) - while everything
  // upstream of here, the shader included, is still engine space. This is
  // the single step between the two, so the colours and the labels stay two
  // views of one measurement rather than two measurements.
  //
  // Distance Apart, Scene lifespan and Bounce Count pass straight through:
  // a separation, a step count and a tally have no origin to be measured
  // from and no direction to reverse.
  function authoredOutputValue(v) {
    var prop = scene.output.property;
    if (prop === "x") return PhysicsCoords.toAuthoredX(v, scene);
    if (prop === "y") return PhysicsCoords.toAuthoredY(v, scene);
    if (prop === "angle") return PhysicsCoords.flipAngle(v);
    return v;
  }

  // The inverse of outputColorT: a sampled t back into the Output's own
  // units. Every branch mirrors one of that function's, in the same order.
  //
  // Note that this is not monotonic in t for every Output any more: with +y
  // up, t = 0 is the TOP of the frame and so the largest Center Y. Callers
  // that want a span or an ordered pair out of two of these have to say so
  // themselves rather than assume t's own order carries over - see the
  // Range and percentile rows in fractal-stats-panel.js.
  function statsValueForT(t) {
    if (isBouncesOutput) return authoredOutputValue(t * bounceMaxValue);
    var rangeMax = currentOutputRangeMax();
    if (scene.output.property === "lifespan") return authoredOutputValue(t * rangeMax);
    if (isInfinitePositionOutput) {
      // frameSigmoid's own inverse. Clamped off both ends first: the
      // sigmoid only reaches 0 and 1 at infinity, so a t that has rounded
      // onto either would come back as one.
      var clamped = Math.min(1 - 1e-6, Math.max(1e-6, t));
      return authoredOutputValue(rangeMax * (0.5 - Math.log(1 / clamped - 1) / PhysicsEngine.OUTPUT_SIGMOID_STEEPNESS));
    }
    return authoredOutputValue(t * rangeMax);
  }

  function statsFormatValue(v) {
    if (v === null || v === undefined || !isFinite(v)) return "-";
    var prop = scene.output.property;
    // Rotation is stored in radians and read in degrees everywhere a human
    // sees it, same as the editor's own rotation readouts.
    if (prop === "angle") return (v * 180 / Math.PI).toFixed(1) + "°";
    if (prop === "lifespan") return Math.round(v).toLocaleString() + " steps";
    if (prop === "bounces") return (Math.round(v * 10) / 10).toLocaleString() + " bounces";
    var a = Math.abs(v);
    if (a !== 0 && (a < 1e-3 || a >= 1e6)) return v.toExponential(2);
    return (Math.round(v * 100) / 100).toLocaleString();
  }

  // ---- Finding the input seam, cheaply ----
  //
  // See inputStateCrossesSeam: whatever body property X/Y Input is linked
  // to gets settled back into the frame before the simulation starts, and
  // that settle is a sawtooth in world coordinates. Its reset points are
  // false edges - perfectly straight ones - which would otherwise put a
  // spurious spike into the orientation rose at exactly 0 and 90 degrees.
  //
  // The superlative buttons handle this by computing the starting scene for
  // every sample and comparing neighbours, which at their sample count is
  // affordable and at this one is not. It doesn't need to be: the X input
  // offsets its target by worldX alone and the Y input by worldY alone, so
  // every seam is a line of CONSTANT world X or constant world Y. Scanning
  // one row and one column therefore finds all of them, for W + H starting
  // scenes instead of W * H.
  // A seam is a line at a fixed world X or Y. It does not get finer when
  // the samples do - so the scan runs at a FIXED number of probes per axis
  // however far the resolution slider is pushed, and its cost (which is the
  // expensive JS part of a measurement, a whole starting scene per probe)
  // stays flat. A seam is then located to within one probe spacing rather
  // than to one exact column, and that whole spacing's worth of columns is
  // excluded - a handful out of thousands at the resolutions where the
  // spacing is bigger than one.
  var STATS_SEAM_PROBES = 512;

  function createSeamScan(width, height) {
    var grid = { width: width, height: height };
    var colStride = Math.max(1, Math.ceil(width / STATS_SEAM_PROBES));
    var rowStride = Math.max(1, Math.ceil(height / STATS_SEAM_PROBES));
    var colProbes = Math.ceil(width / colStride);
    var rowProbes = Math.ceil(height / rowStride);
    var cols = new Uint8Array(Math.max(0, width - 1));
    var rows = new Uint8Array(Math.max(0, height - 1));
    function mark(mask, from, to) {
      for (var i = Math.max(0, from); i < Math.min(to, mask.length); i++) mask[i] = 1;
    }
    return {
      cols: cols,
      rows: rows,
      // Nothing is settled into the frame under Infinite Space, so there is
      // no seam to find and the whole scan is skipped.
      needed: PhysicsEngine.wrapsAtEdges(scene),
      axis: 0,      // 0 = probing columns, 1 = probing rows, 2 = finished
      index: 0,
      prev: null,
      total: colProbes + rowProbes,
      done: 0,
      step: function (count) {
        if (!this.needed) { this.axis = 2; return true; }
        while (count-- > 0) {
          if (this.axis === 0) {
            if (this.index >= colProbes) { this.axis = 1; this.index = 0; this.prev = null; continue; }
            // The middle row and middle column: any would do, and the
            // middle one is furthest from whatever the view's own edges
            // happen to be doing.
            var col = Math.min(width - 1, this.index * colStride);
            var wc = sampleCoordToWorld(grid, col, (height / 2) | 0);
            var sc = initialStateAt(wc.x, wc.y);
            if (this.index > 0 && inputStateCrossesSeam(this.prev, sc)) {
              mark(cols, (this.index - 1) * colStride, col);
            }
            this.prev = sc;
            this.index++;
            this.done++;
          } else if (this.axis === 1) {
            if (this.index >= rowProbes) { this.axis = 2; return true; }
            var row = Math.min(height - 1, this.index * rowStride);
            var wr = sampleCoordToWorld(grid, (width / 2) | 0, row);
            var sr = initialStateAt(wr.x, wr.y);
            if (this.index > 0 && inputStateCrossesSeam(this.prev, sr)) {
              mark(rows, (this.index - 1) * rowStride, row);
            }
            this.prev = sr;
            this.index++;
            this.done++;
          } else {
            return true;
          }
        }
        return this.axis === 2;
      },
    };
  }

  function statsWantsWork() {
    return statsOpen && statsPanel !== null;
  }

  // Whether the measurement currently in flight will produce the section
  // that is open right now.
  function statsRunCoversEnabled() {
    if (!statsRun) return false;
    var wanted = statsPanel.enabledGroups();
    for (var key in wanted) {
      if (Object.prototype.hasOwnProperty.call(wanted, key) && !statsRun.groups[key]) return false;
    }
    return true;
  }

  function abandonStatsRun() {
    cancelStatsSlice(statsSliceHandle);
    statsSliceHandle = null;
    if (statsSettleTimer) { clearTimeout(statsSettleTimer); statsSettleTimer = null; }
    if (statsRun) { freeSampleTarget(statsRun.target); statsRun = null; }
  }

  // Called from markDirty, i.e. from every pan tick, every zoom, every
  // resize and every settings change that invalidates the picture - so it
  // stays cheap and does nothing at all while the card is closed.
  function statsOnViewChanged() {
    if (!statsPanel) return;
    // The overlay is drawn in the coordinates of the block that was
    // measured, so the moment the view moves it is pointing at the wrong
    // place - and a stale annotation on the map is worse than none. Off it
    // goes, switch and all, before anything else here can return early.
    statsPanel.featureOverlayOff();
    statsGeneration++;
    statsResultIsCurrent = false;
    abandonStatsRun();
    if (!statsWantsWork()) return;
    // Only dim what is actually stale: before the first measurement there
    // is nothing on the card but its own explanations, and dimming those
    // reads as the panel being disabled.
    if (statsHasResult) statsPanel.markStale();
    scheduleStatsRun();
  }

  // Starts a measurement once the view has held still for the settle
  // delay. Called from every view change, and from every change on the
  // card itself that needs a fresh run - it does not wait for the ladder:
  // the sampler re-renders the view into its own target, so the picture
  // being mid-refinement on screen makes no difference to what is measured.
  function scheduleStatsRun() {
    if (!statsWantsWork() || statsRun) return;
    statsPanel.setStatus("Measuring the view on screen…", "loading");
    if (statsSettleTimer) clearTimeout(statsSettleTimer);
    statsSettleTimer = setTimeout(function () {
      statsSettleTimer = null;
      beginStatsRun();
    }, STATS_SETTLE_DELAY_MS);
  }

  function beginStatsRun() {
    if (!statsWantsWork() || statsRun) return;
    if (!canSampleField()) {
      statsPanel.setStatus("This browser can't read floating-point values back from the GPU, so Global Stats can't measure anything here.", "stale");
      return;
    }
    var block = statsSampleBlock();
    var w = block.width, h = block.height;
    // How tall one band is. Half the refinement ladder's own adaptive pixel
    // budget - which is already a measurement of how many simulated pixels
    // this machine fits in one refresh period, so half of it is comfortably
    // inside one idle slice. STATS_MAX_BAND_SAMPLES is a second, flat
    // ceiling on the readback buffer, so the memory this holds does not
    // grow with the slider even though the block does.
    var bandRows = clamp(Math.floor(ladderBudget.budget / 2 / w), 1,
      Math.min(h, Math.max(1, Math.floor(STATS_MAX_BAND_SAMPLES / w))));

    statsRun = {
      generation: statsGeneration,
      width: w,
      height: h,
      full: block.full,
      target: createSampleTarget(w, bandRows),
      bandRows: bandRows,
      bandBuffer: new Float32Array(w * bandRows * 4),
      t: new Float32Array(w * h),
      row: 0,
      phase: "sample",
      groups: statsPanel.enabledGroups(),
      // Whether this run's result can be MERGED into the panel's last one
      // rather than replacing it: true when the view and block are the ones
      // the last result was measured from, so a section opened later joins
      // the sections already measured instead of throwing them away.
      merge: statsResultIsCurrent,
      seam: null,
      job: null,
    };
    statsPanel.setStatus("Measuring the view on screen…", "working");
    scheduleStatsSlice();
  }

  function scheduleStatsSlice() {
    if (!statsRun) return;
    statsSliceHandle = requestStatsSlice(function (deadline) {
      statsSliceHandle = null;
      runStatsSlice(deadline);
    });
  }

  function runStatsSlice(deadline) {
    var run = statsRun;
    if (!run) return;
    // The generation check is the only thing standing between a run and the
    // view it was started for; `dirty` catches a change that arrived after
    // the last markDirty was already accounted for.
    if (run.generation !== statsGeneration || dirty) { abandonStatsRun(); return; }

    // A timed-out idle callback means the page is NOT idle - the browser
    // fired this only because the deadline elapsed. Do the smallest useful
    // amount and come back rather than taking a full slice out of whatever
    // is keeping it busy.
    var pressed = !!(deadline && deadline.didTimeout);
    var sliceStart = performance.now();
    function hasTimeLeft() {
      if (pressed) return false;
      if (deadline && deadline.timeRemaining) return deadline.timeRemaining() > 3;
      return performance.now() - sliceStart < 6;
    }

    if (run.phase === "sample") {
      // Each band is drawn, read back, and its red channel copied into the
      // block. Reading back per band rather than once at the end is what
      // caps the memory a full-resolution measurement needs - and, since
      // readSampleBand blocks on the GPU, what makes hasTimeLeft() below a
      // real measurement of how much of this slice the GPU has eaten rather
      // than of how fast the draw calls were queued.
      while (run.row < run.height) {
        var drawn = drawSampleBand(run.target, run.width, run.height, run.row, run.bandRows, false);
        // Nothing drawn on the very first band means the sampler went away
        // between beginStatsRun's check and here (a precision switch
        // dropping its program, say). Reading the target back now would
        // analyze an untouched texture - all zeros - and present that as a
        // measurement.
        if (drawn === 0) {
          abandonStatsRun();
          statsPanel.setStatus("Couldn't sample the view - nothing measured.", "stale");
          return;
        }
        readSampleBand(run.target, drawn, run.bandBuffer);
        for (var j = 0; j < drawn; j++) {
          var srcRow = j * run.width * 4;
          var dstRow = (run.row + j) * run.width;
          for (var i = 0; i < run.width; i++) run.t[dstRow + i] = run.bandBuffer[srcRow + i * 4];
        }
        run.row += drawn;
        if (run.row < run.height && !hasTimeLeft()) {
          statsPanel.setStatus("Measuring the view on screen… sampling " +
            Math.round(100 * run.row / run.height) + "%", "working");
          scheduleStatsSlice();
          return;
        }
      }
      freeSampleTarget(run.target);
      run.target = null;
      run.bandBuffer = null;
      run.seam = createSeamScan(run.width, run.height);
      run.phase = "seams";
    }

    if (run.phase === "seams") {
      // Each starting scene is a full cloneScene plus the hinge-preserving
      // edits, so this is the one genuinely CPU-heavy stretch - hence a
      // handful at a time against the real deadline.
      while (!run.seam.step(pressed ? 1 : 8) && hasTimeLeft()) { /* keep going while the slice lasts */ }
      if (run.seam.axis !== 2) {
        statsPanel.setStatus("Measuring the view on screen… mapping input seams " +
          Math.round(100 * run.seam.done / run.seam.total) + "%", "working");
        scheduleStatsSlice();
        return;
      }
      run.job = FractalStats.createJob({
        width: run.width,
        height: run.height,
        t: run.t,
        circular: isCircularOutput,
        groups: run.groups,
        colSeam: run.seam.needed ? run.seam.cols : null,
        rowSeam: run.seam.needed ? run.seam.rows : null,
        histogramBuckets: STATS_HISTOGRAM_BUCKETS,
        orientationBins: STATS_ORIENTATION_BINS,
      });
      run.phase = "analyze";
    }

    if (run.phase === "analyze") {
      var more = true;
      do { more = run.job.step(); } while (more && hasTimeLeft());
      if (more) {
        statsPanel.setStatus("Measuring the view on screen… analysing " +
          Math.round(100 * run.job.doneSteps / run.job.totalSteps) + "%", "working");
        scheduleStatsSlice();
        return;
      }
      finishStatsRun(run);
    }
  }

  function finishStatsRun(run) {
    var result = run.job.result;
    var sampleHeight = run.height;
    // How much of the world, and how much of the screen, one sample step
    // covers. sampleCoordToWorld normalises by the block's HEIGHT on both
    // axes (mirroring the shader's own uv), so both of these are height
    // ratios and the sample block is square in world terms.
    var worldPerSample = view.scale / sampleHeight;
    var cssHeight = Math.max(1, canvasArea.clientHeight);
    var screenPixelsPerSample = cssHeight / sampleHeight;
    var info = {
      circular: isCircularOutput,
      resultantLength: result.resultantLength,
      circularStd: result.circularStd,
      sampleWidth: run.width,
      sampleHeight: sampleHeight,
      worldPerSample: worldPerSample,
      screenPixelsPerSample: screenPixelsPerSample,
      screenPixelsPerSampleRecip: 1 / screenPixelsPerSample,
      valuePerT: statsValueSpan(),
      outputLabel: outputPropertyLabel(),
      seamsFound: run.seam.needed
        ? countSeams(run.seam.cols) + countSeams(run.seam.rows)
        : 0,
    };
    statsLastWidth = run.width;
    statsLastHeight = sampleHeight;
    statsRun = null;
    statsHasResult = true;
    statsResultIsCurrent = true;
    statsPanel.markFresh();
    statsPanel.showResult(result, info, run.merge);
    // Just the seam warning, if there is one - the sample size and Output
    // are already right there in the Sampling resolution slider and the
    // scene's own X/Y Input mapping, so restating them here was pure
    // repetition.
    statsLastStatus = info.seamsFound > 0
      ? info.seamsFound + " input-seam line" + (info.seamsFound === 1 ? "" : "s") +
        " excluded (see the X/Y Input mapping - those are where a starting position wraps back into the frame, not real edges)."
      : "";
    statsPanel.setStatus(statsLastStatus);
  }

  // How many seam LINES, not how many excluded columns - at a coarse probe
  // spacing one seam marks a whole span of them (see createSeamScan), and
  // the status line is telling the user how many real lines were found.
  function countSeams(mask) {
    var n = 0;
    for (var i = 0; i < mask.length; i++) if (mask[i] && !mask[i - 1]) n++;
    return n;
  }

  // ---- The longest ridge / longest valley overlay ----
  //
  // Hovering either of Topography's two "longest" rows draws that path
  // straight onto the map, which is the only way to tell "the longest
  // valley is 0.8 screens" from a number that happens to be 0.8. Its own
  // canvas over the grid rather than anything in the WebGL pipeline: this
  // is an annotation that comes and goes with the pointer, and rebuilding
  // the render for it would tie a piece of UI to the thing the whole page
  // is otherwise built to keep fast.
  //
  // Row 0 is the BOTTOM row of the sample block (see fractal-stats.js's own
  // header), so the y mapping below flips - and the block is proportioned
  // to this same canvas area, which is what lets a sample index map to a
  // CSS pixel by simple ratio without going through world coordinates.
  var featureOverlay = null;      // { width, height, path } or null - the hovered longest ridge or valley
  // Every sample of one of Topography's four classes, lit up while its
  // slice of the pie or its legend line is hovered: { width, height, mask,
  // cls } or null. Same canvas, same coordinates, same reason it goes away
  // the moment the view moves.
  var featureHighlight = null;
  // The highlight rendered once as a tiny image (one texel per sample) and
  // scaled onto the canvas by the GPU, rather than a rectangle per sample:
  // at full resolution that would be a million fillRects per frame.
  var featureHighlightImage = null;   // { mask, cls, canvas }
  var featureOverlayCanvas = null;

  function ensureFeatureOverlayCanvas() {
    if (featureOverlayCanvas) return featureOverlayCanvas;
    featureOverlayCanvas = document.createElement("canvas");
    featureOverlayCanvas.id = "grid-feature-overlay";
    canvasArea.appendChild(featureOverlayCanvas);
    return featureOverlayCanvas;
  }

  function drawFeatureOverlay() {
    if (!featureOverlayCanvas) return;
    var cw = canvasArea.clientWidth, ch = canvasArea.clientHeight;
    var dpr = gridDpr();
    featureOverlayCanvas.width = Math.max(1, Math.round(cw * dpr));
    featureOverlayCanvas.height = Math.max(1, Math.round(ch * dpr));
    var ctx = featureOverlayCanvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    if (featureHighlight) drawFeatureHighlight(ctx, cw, ch);
    if (!featureOverlay) return;
    var W = featureOverlay.width, H = featureOverlay.height;
    if (!(W > 0 && H > 0)) return;

    function stroke(path, color, casing) {
      if (!path || path.length < 4) return;
      ctx.beginPath();
      for (var i = 0; i < path.length; i += 2) {
        var x = (path[i] + 0.5) / W * cw;
        var y = (1 - (path[i + 1] + 0.5) / H) * ch;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      // Casing first, in the opposite of the line's own colour: the
      // fractal underneath is every colour there is, and a single-coloured
      // line disappears into whichever part of it happens to match. White
      // and black are the two colours no hue ramp contains, which is why
      // the lines are those rather than a pair of hues.
      // Wide on purpose: a 6px line at 3 points into the pane read as a
      // hairline against a picture this busy.
      ctx.strokeStyle = casing;
      ctx.lineWidth = 12;
      ctx.stroke();
      ctx.strokeStyle = color;
      ctx.lineWidth = 6;
      ctx.stroke();
    }
    // Only one is ever shown at a time (whichever row is hovered), so the
    // two need no telling apart: black cased in white, the pair of colours
    // no hue ramp contains.
    stroke(featureOverlay.path, "#000000", "#ffffff");
  }

  // White at half strength over every sample of the hovered class. The
  // image is nearest-neighbour scaled on purpose: each sample IS a block of
  // the map, and smoothing the edges would blur which pixels are in and out.
  function drawFeatureHighlight(ctx, cw, ch) {
    var hl = featureHighlight;
    var W = hl.width, H = hl.height;
    if (!(W > 0 && H > 0) || !hl.mask) return;
    if (!featureHighlightImage || featureHighlightImage.mask !== hl.mask || featureHighlightImage.cls !== hl.cls) {
      var off = document.createElement("canvas");
      off.width = W; off.height = H;
      var octx = off.getContext("2d");
      var img = octx.createImageData(W, H);
      var px = img.data, mask = hl.mask, cls = hl.cls;
      // Row 0 of the block is the BOTTOM of the map; row 0 of an image is
      // its top.
      for (var r = 0; r < H; r++) {
        var src = r * W, dst = (H - 1 - r) * W * 4;
        for (var c = 0; c < W; c++, dst += 4) {
          if (mask[src + c] === cls) { px[dst] = 255; px[dst + 1] = 255; px[dst + 2] = 255; px[dst + 3] = 128; }
        }
      }
      octx.putImageData(img, 0, 0);
      featureHighlightImage = { mask: mask, cls: cls, canvas: off };
    }
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(featureHighlightImage.canvas, 0, 0, cw, ch);
  }

  // Both layers share the one canvas, which exists only while either has
  // something to show.
  function syncFeatureOverlayCanvas() {
    if (!featureOverlay && !featureHighlight) {
      if (featureOverlayCanvas) {
        featureOverlayCanvas.parentNode.removeChild(featureOverlayCanvas);
        featureOverlayCanvas = null;
      }
      featureHighlightImage = null;
      return;
    }
    ensureFeatureOverlayCanvas();
    drawFeatureOverlay();
  }

  function setFeatureOverlay(data) {
    featureOverlay = data || null;
    syncFeatureOverlayCanvas();
  }

  function setFeatureHighlight(data) {
    featureHighlight = data || null;
    syncFeatureOverlayCanvas();
  }

  if (statsPanelBodyEl && statsSampleSlider && global.FractalStatsPanel && global.FractalStats) {
    statsPanel = FractalStatsPanel.create({
      body: statsPanelBodyEl,
      host: {
        valueForT: statsValueForT,
        formatValue: statsFormatValue,
        // The grid's own color for this value - hoverOutputColorFinal is
        // already an exact JS copy of the shader's colorMap, Color Zoom
        // included, so a swatch here is the color on screen and not an
        // approximation of it. Bounce Count's t can exceed 1 (the divisor
        // comes from a coarser sample than this one), which would run the
        // hue past the end of the ramp.
        colorForT: function (t) { return hoverOutputColorFinal(Math.min(1, Math.max(0, t))); },
        labelForT: function (t) { return statsFormatValue(statsValueForT(t)); },
        worldAt: function (col, row) {
          return sampleCoordToWorld({ width: statsLastWidth, height: statsLastHeight }, col, row);
        },
        setFeatureOverlay: setFeatureOverlay,
        setFeatureHighlight: setFeatureHighlight,
      },
      onSectionChange: function () {
        if (!statsWantsWork()) return;
        // Opening a section the last result already covers (the view
        // hasn't moved since it was measured) needs no new run - the panel
        // has just drawn it from what it holds.
        if (statsResultIsCurrent && !statsPanel.needsMeasurement()) {
          if (!statsRun) statsPanel.setStatus(statsLastStatus);
          return;
        }
        // Opening one while a run is in flight is different: which section
        // to compute is fixed when the job is built, so a run that doesn't
        // already cover the new section never will. Restarting is the only
        // way it gets measured, and it costs only the slices already spent.
        if (statsRun) {
          if (statsRunCoversEnabled()) return;
          abandonStatsRun();
        }
        scheduleStatsRun();
      },
    });

    // ---- The sampling slider, under Settings > Performance > Advanced ----
    statsSampleSlider.min = "0";
    statsSampleSlider.max = String(STATS_SAMPLE_FRACTIONS.length - 1);
    statsSampleSlider.value = String(statsSampleStop);
    updateStatsSampleReadout();
    // Dragging only re-labels; the measurement restarts on release, so
    // sweeping the slider doesn't start (and abandon) a run per notch.
    statsSampleSlider.addEventListener("input", function () {
      statsSampleStop = clamp(Number(statsSampleSlider.value) | 0, 0, STATS_SAMPLE_FRACTIONS.length - 1);
      updateStatsSampleReadout();
    });
    statsSampleSlider.addEventListener("change", function () {
      statsSampleStop = clamp(Number(statsSampleSlider.value) | 0, 0, STATS_SAMPLE_FRACTIONS.length - 1);
      updateStatsSampleReadout();
      // A different block size makes every number on the card a
      // measurement of something else, so this invalidates a finished run
      // exactly as a pan does - and abandons one in flight, which is
      // measuring at the old resolution.
      statsResultIsCurrent = false;
      abandonStatsRun();
      if (statsHasResult) statsPanel.markStale();
      scheduleStatsRun();
    });

    // A chart sizes itself to the card's width, which only exists once the
    // card is laid out - and changes when a portrait window is resized.
    var statsRelayoutTimer = null;
    window.addEventListener("resize", function () {
      if (!statsOpen) return;
      if (statsRelayoutTimer) clearTimeout(statsRelayoutTimer);
      statsRelayoutTimer = setTimeout(function () {
        statsRelayoutTimer = null;
        statsPanel.relayout();
      }, 150);
    });
  }

  // The Analysis card opening and closing, as far as MEASURING is
  // concerned - wired to the menu's own state change below.
  function setStatsPanelOpen(open) {
    if (!statsPanel) return;
    statsOpen = open;
    if (!open) { abandonStatsRun(); return; }
    statsPanel.relayout();
    if (statsResultIsCurrent && !statsPanel.needsMeasurement()) {
      statsPanel.setStatus(statsLastStatus);
    } else {
      scheduleStatsRun();
    }
  }

  // Drag #panel-resizer to resize the menu column's open cards. #canvas-area's own
  // ResizeObserver (below) picks up the resulting width change and re-renders
  // the grid at the new size - no separate hook needed here.
  var PANEL_MIN_WIDTH = 220;
  var PANEL_MAX_WIDTH_FRACTION = 0.75;
  (function setUpPanelResize() {
    var dragStartX = 0;
    var dragStartWidth = 0;

    function onMove(e) {
      var maxWidth = window.innerWidth * PANEL_MAX_WIDTH_FRACTION;
      var width = clamp(dragStartWidth + (e.clientX - dragStartX), PANEL_MIN_WIDTH, maxWidth);
      document.documentElement.style.setProperty("--panel-width", width + "px");
      repositionActiveTip(); // a tip pointing at a sidebar element (e.g. Color Zoom) needs to follow it here - the anchor itself doesn't fire an event when the panel resizes around it
    }
    function onUp() {
      panelResizer.classList.remove("dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    panelResizer.addEventListener("mousedown", function (e) {
      dragStartX = e.clientX;
      // The column, not the stack: the stack's box is wider than the cards
      // by its shadow-room padding (see fractal-grid.css), the column's is
      // exactly --panel-width.
      dragStartWidth = menuColumn.getBoundingClientRect().width;
      panelResizer.classList.add("dragging");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      e.preventDefault();
    });
  })();

  // ---- Playback: the grid's own timeline ----
  //
  // Plays the fractal forward in time. The grid always shows every pixel's
  // simulation run to one step (timeline.step - see renderedSteps); Play
  // walks that step up toward the Simulation Duration while the picture
  // keeps up with it.
  //
  // Not by re-rendering each frame from step 0: frame N would cost N steps
  // per pixel, so a run's total cost would grow with the SQUARE of its
  // length - measured on the samples, minutes of GPU time to play one
  // full-resolution view out to step 1000. Instead every pixel's simulation
  // lives in float textures between frames (see
  // PhysicsGridCodegen.playbackStateVariables for exactly what that is), and
  // a frame pays only for the steps it adds: a step pass reads the state,
  // runs a few steps and writes the other texture of a ping-pong pair, then a
  // color pass paints the result.
  //
  // What that costs, and what takes over where it can't reach:
  //  - Resolution. Two full copies of the state is a lot of video memory,
  //    and every step costs every pixel it covers, so playback runs on one
  //    sub-lattice of the full-res grid (see playbackStride) - at most one
  //    sample per CSS pixel. It is the ladder's own lattice, so pausing hands
  //    the image to the ladder as an already-finished level (see
  //    seedLadderFromPlayback) and refinement carries on from there to full
  //    resolution and antialiasing.
  //  - The view. State belongs to the world points it was built for, so a
  //    pan, zoom or resize throws all of it away. While the view is moving
  //    the ladder shows the current step the ordinary way; once it has held
  //    still for PLAYBACK_SETTLE_MS, playback rebuilds its state up to that
  //    step ("catching up") and carries on.
  //  - Going backward. State only moves forward, so an earlier step is a
  //    rebuild from step 0.
  //  - Exactness where the field is chaotic. The step pass is a different
  //    program from the grid's own, and this backend's compiler rounds each
  //    program's arithmetic its own way (see physics-df.js's header), so
  //    where one ULP decides a trajectory, playback's step N and the paused
  //    render of step N can differ pixel by pixel. Wherever the field is
  //    smooth enough to see, they agree.

  // 1x is real time: a step is PhysicsGPU.FIXED_DT of simulated time, the
  // same rate the editor's own Play runs at.
  var PLAYBACK_STEPS_PER_SECOND = 1 / PhysicsGPU.FIXED_DT;
  // How long the view has to hold still before playback rebuilds its state
  // for it. Any shorter and every pause between two mousemoves of a slow
  // drag would start a rebuild, only to throw it away on the next one.
  var PLAYBACK_SETTLE_MS = 250;
  // Both copies of the state together. Playback coarsens its lattice until
  // they fit. Kept well short of what a browser will allocate: the page
  // already holds several full-resolution targets of its own (the
  // accumulators, antialiasing's float average), all of it shares one GPU
  // process with every other tab, and running that process out of memory
  // takes the browser down with it - it was 640MB at first, and Chrome
  // crashed. A typical scene on a Retina laptop needs about half of this at
  // one sample per CSS pixel; bigger states just run coarser.
  //
  //
  // That is the High preset's 256MB. Low gets well under half of it (see
  // PERF_PRESETS): a phone's GPU has no memory of its own - this comes out of
  // the same few gigabytes as everything else on the device - and the penalty
  // for overreaching is not a slow frame but the browser discarding the page
  // (see "Losing the WebGL context"). Playback only runs coarser for it,
  // which on that GPU it would be doing anyway.
  function playbackStateMaxBytes() { return perf.playbackMB * 1024 * 1024; }
  var BYTES_PER_STATE_TEXEL = 16; // RGBA32F, one layer
  // The most wall-clock time the clock will owe steps for. A hitch - a
  // shader compile, a GC pause, a backgrounded tab - should cost that much
  // playback, not come back as a burst of catch-up steps afterward.
  var PLAYBACK_MAX_CARRY_SECONDS = 0.25;
  // Counted in pixel-steps. The ladder's budget can't be shared: a playback
  // draw's cost is its step count times its pixels, a ladder draw's is its
  // pixels at the whole run length. Starts modest (a handful of steps over a
  // CSS-pixel lattice) and only grows on frames that used it - see
  // makeWorkBudget's growMinUse.
  var playbackBudget = makeWorkBudget(8000000, 20000, 4000000000, 0.5);
  var MAX_STATE_ATTACHMENTS = Math.min(gl.getParameter(gl.MAX_DRAW_BUFFERS), gl.getParameter(gl.MAX_COLOR_ATTACHMENTS));

  // Programs per precision, built on the first Play that needs them (null:
  // this device couldn't build them). The two state textures are sized to
  // whatever the current canvas, lattice and state layout need, and
  // reallocated when any of those change.
  var playbackGpu = {
    programs: {},
    textures: [null, null],
    current: 0, // which of the two holds the complete state
    fbo: null,
    width: 0,
    height: 0,
    layers: 0,
    // The view the textures were allocated for - see
    // releasePlaybackIfViewMoved.
    viewKey: null,
  };

  function indentLines(lines, by) {
    return lines.map(function (l) { return by + l; });
  }

  // The step pass: continue each pixel's simulation by u_steps steps from the
  // state in u_state (or from its own starting state when u_init is set),
  // and write one group's slice of the result.
  function buildPlaybackStepShader(pieces, vars, layersPerGroup) {
    var loop = pieces.stepLoop({
      bound: "u_steps",
      stepIndex: "float(u_baseStep + i)",
      budget: "float(u_baseStep + u_steps)",
    });
    var carriesLifespan = vars.some(function (v) { return v.name === "lifespanValue"; });
    return [
      "#version 300 es",
      "precision highp float;",
      "precision highp sampler2DArray;",
      // The grid program's own pixel -> world point uniforms, with the same
      // meanings - see its header.
      "uniform vec2 u_resolution;",
      "uniform float u_gridStride;",
      "uniform vec2 u_gridOrigin;",
    ].concat(PhysicsDF.wordUniformDecls("u_center"), [
      "uniform float u_scale;",
      "uniform sampler2DArray u_state;",
      "uniform bool u_init;",
      // How many steps u_state already holds, and how many this draw adds.
      "uniform int u_baseStep;",
      "uniform int u_steps;",
      "uniform int u_group;",
      // Which tile of the lattice the state texture holds, and how many
      // stencil points each lattice pixel owns - see stateWorldCoordLines.
      // Playback proper always runs with (0, 0) and 1.
      "uniform vec2 u_tileOrigin;",
      "uniform int u_stencil;",
      // The centre, then the grid program's own STENCIL[] in its order.
      "const vec2 STATE_STENCIL[5] = vec2[5](vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(-1.0, 0.0), vec2(0.0, 1.0), vec2(0.0, -1.0));",
    ]).concat(
      PhysicsGridCodegen.generatePlaybackStateOutputsGLSL(layersPerGroup),
      [""], pieces.libraryLines, [""], pieces.constantLines,
      ["", pieces.stepOnceSource, "", "void main() {"],
      pieces.stateWorldCoordLines,
      pieces.physicsDeclarationLines,
      loop.declarations,
      ["  if (!u_init) {"],
      indentLines(PhysicsGridCodegen.generatePlaybackStateLoadGLSL(vars, "u_state", "ivec2(gl_FragCoord.xy)"), "    "),
      // What the state deliberately leaves out - see loopStateVariables.
      indentLines(pieces.loopStateRestoreLines, "    "),
      // The saved lifespan of a pixel still running is the step count as of
      // the save; it has lived through the steps this draw adds, too.
      carriesLifespan ? ["    if (!wrapStopped) lifespanValue = float(u_baseStep + u_steps);"] : [],
      ["  }"],
      loop.loop,
      indentLines(PhysicsGridCodegen.generatePlaybackStateStoreGLSL(vars, "u_group", layersPerGroup), "  "),
      ["}"]
    ).join("\n");
  }

  // The color pass: each texel's Output value from its saved state, through
  // exactly the grid program's own t and color code.
  function buildPlaybackColorShader(pieces, vars) {
    var outScalar = pieces.outScalar;
    var carriesLifespan = vars.some(function (v) { return v.name === "lifespanValue"; });
    return [
      "#version 300 es",
      "precision highp float;",
      "precision highp sampler2DArray;",
      "uniform sampler2DArray u_state;",
      "uniform ivec2 u_stateSize;",
      // How many steps the state holds - the lifespan of a pixel still running.
      "uniform int u_stateSteps;",
      // Full-res pixels between two neighbouring texels - see
      // shadePlaybackDerived.
      "uniform float u_gridStride;",
      // The grid program's own coloring uniforms - see its header.
      "uniform bool u_colorZoom;",
      "uniform int u_durationSteps;",
      "uniform float u_bounceMax;",
      "uniform int u_displayMode;",
      // Where in the TARGET the state's texel (0, 0) lands, and how many
      // state texels each target pixel owns (see stateWorldCoordLines).
      // Playback proper always runs with (0, 0) and 1.
      "uniform ivec2 u_targetOrigin;",
      "uniform int u_stencil;",
      // Write the raw t instead of a colour - the grid program's own
      // u_sampleField, for the same readers.
      "uniform bool u_sampleField;",
      "out vec4 fragColor;",
      "",
    ].concat(
      pieces.libraryLines, [""], pieces.colorLibraryLines, pieces.constantLines,
      ["", outScalar + " outputAt(ivec2 texel) {"],
      carriesLifespan ? [] : ["  float lifespanValue = float(u_stateSteps);"],
      indentLines(PhysicsGridCodegen.generatePlaybackStateDeclarationsGLSL(vars), "  "),
      indentLines(PhysicsGridCodegen.generatePlaybackStateLoadGLSL(vars, "u_state", "texel"), "  "),
      [
        "  " + outScalar + " outputValue = " + pieces.outZero + ";",
        pieces.outputLines.join("\n"),
        "  return outputValue;",
        "}",
        "",
      ],
      pieces.deltaTLines,
      [
        "const ivec2 PLAYBACK_STENCIL[4] = ivec2[4](ivec2(1, 0), ivec2(-1, 0), ivec2(0, 1), ivec2(0, -1));",
        "",
        // The derived modes, from neighbouring TEXELS' saved values rather
        // than from re-simulating a stencil around each one - the texels are
        // already simulated, and five simulations a pixel is exactly the cost
        // playback exists to avoid. The grid's own program can't do this (its
        // accumulators hold hue-ramped color, see shadeDerived), but these
        // are raw values. Neighbours are u_gridStride full-res pixels apart,
        // so each difference is scaled back to "per full-res pixel", the unit
        // the color formulas are calibrated in; the Laplacian's sum of
        // differences grows with the square of the spacing. An edge texel
        // reuses itself for its missing neighbour, which reads as flat.
        "vec3 shadePlaybackDerived(ivec2 texel, " + outScalar + " outputValue, float t) {",
        "  float d[4];",
        "  for (int k = 0; k < 4; k++) {",
        "    ivec2 q = clamp(texel + PLAYBACK_STENCIL[k], ivec2(0), u_stateSize - 1);",
        "    d[k] = deltaT(outputValue, outputAt(q)) / u_gridStride;",
        "  }",
        "  if (u_displayMode == MODE_LAPLACIAN) return laplacianColor((d[0] + d[1] + d[2] + d[3]) / u_gridStride);",
        "  vec2 g = vec2(d[0] - d[1], d[2] - d[3]) * 0.5;",
        "  if (u_displayMode == MODE_CONTOURS) return contourColor(t, g);",
        "  return gradientColor(g);",
        "}",
        "",
        // The same three pictures from a pixel's OWN five-point stencil,
        // when the state carries one (u_stencil == 5): texel + 1..4 are the
        // neighbours one full-res pixel away, in STENCIL's order, so this is
        // shadeDerived()'s arithmetic exactly - differences per full-res
        // pixel, whatever the lattice's stride - rather than playback's
        // approximation from whichever texels happen to be adjacent.
        "vec3 shadeStencilDerived(ivec2 texel, " + outScalar + " outputValue, float t) {",
        "  float d[4];",
        "  for (int k = 0; k < 4; k++) d[k] = deltaT(outputValue, outputAt(texel + ivec2(k + 1, 0)));",
        "  if (u_displayMode == MODE_LAPLACIAN) return laplacianColor(d[0] + d[1] + d[2] + d[3]);",
        "  vec2 g = vec2(d[0] - d[1], d[2] - d[3]) * 0.5;",
        "  if (u_displayMode == MODE_CONTOURS) return contourColor(t, g);",
        "  return gradientColor(g);",
        "}",
        "",
        "void main() {",
        "  ivec2 targetPixel = ivec2(gl_FragCoord.xy) - u_targetOrigin;",
        "  ivec2 texel = ivec2(targetPixel.x * u_stencil, targetPixel.y);",
        "  " + outScalar + " outputValue = outputAt(texel);",
        pieces.tLine,
        "  if (u_sampleField) { fragColor = vec4(t, 0.0, 0.0, 1.0); return; }",
        "  if (u_displayMode != MODE_STANDARD) {",
        "    fragColor = vec4(u_stencil == 5 ? shadeStencilDerived(texel, outputValue, t)",
        "                                    : shadePlaybackDerived(texel, outputValue, t), 1.0);",
        "    return;",
        "  }",
        "  fragColor = vec4(colorMap(t), 1.0);",
        "}",
      ]
    ).join("\n");
  }

  var PLAYBACK_STEP_UNIFORMS = ["resolution", "gridStride", "gridOrigin", "centerHi", "centerLo", "centerLo2", "centerLo3", "scale", "state", "init", "baseStep", "steps", "group", "tileOrigin", "stencil"];
  var PLAYBACK_COLOR_UNIFORMS = ["state", "stateSize", "stateSteps", "gridStride", "colorZoom", "durationSteps", "bounceMax", "displayMode", "targetOrigin", "stencil", "sampleField"];

  function finishedPlaybackProgram(build, uniformNames) {
    var prog = build.program;
    var uniforms = {};
    uniformNames.forEach(function (name) { uniforms[name] = gl.getUniformLocation(prog, "u_" + name); });
    return { program: prog, posLoc: gl.getAttribLocation(prog, "a_position"), uniforms: uniforms };
  }

  // Both of playback's programs for one precision, as a build in flight - the
  // same state machine the grid's own programs use (see startProgramBuild),
  // and for the same reason: the step pass is a whole copy of the scene's
  // physics, and in df compiling it on the spot froze the page for seconds
  // the moment Play was pressed.
  function startPlaybackBuild(precision) {
    var pieces = compileScenePieces(scene, precision);
    var vars = PhysicsGridCodegen.playbackStateVariables(pieces.initial, pieces.outputBodyIndices)
      .concat(pieces.loopStateVariables);
    var layers = PhysicsGridCodegen.playbackStateLayerCount(vars);
    return {
      status: "building",
      programs: null,
      layers: layers,
      groups: Math.ceil(layers / MAX_STATE_ATTACHMENTS),
      stepBuild: startProgramBuild(buildPlaybackStepShader(pieces, vars, MAX_STATE_ATTACHMENTS)),
      colorBuild: startProgramBuild(buildPlaybackColorShader(pieces, vars)),
    };
  }

  function pumpPlaybackBuild(entry, wait) {
    if (entry.status !== "building") return;
    // The step pass writes a group of state layers at once: warm it for a
    // full group, and for the short last group if there is one.
    var stepFormats = [{ format: gl.RGBA32F, count: Math.min(entry.layers, MAX_STATE_ATTACHMENTS) }];
    var lastGroup = entry.layers - (entry.groups - 1) * MAX_STATE_ATTACHMENTS;
    if (entry.groups > 1 && lastGroup !== MAX_STATE_ATTACHMENTS) stepFormats.push({ format: gl.RGBA32F, count: lastGroup });
    // The color pass paints the picture (RGBA8), measures it (RGBA32F, see
    // drawSampleBandSliced) and averages antialiasing samples (RGBA16F,
    // blended) - three pipelines, all built now.
    var colorFormats = [gl.RGBA8, gl.RGBA32F];
    if (antialiasSupported()) colorFormats.push({ format: gl.RGBA16F, blend: true });
    var a = pumpProgramBuild(entry.stepBuild, stepFormats, wait);
    var b = pumpProgramBuild(entry.colorBuild, colorFormats, wait);
    if (a === "failed" || b === "failed") {
      entry.status = "failed";
      setStatus(false, "Playback unavailable: " + (entry.stepBuild.error || entry.colorBuild.error));
      discardProgramBuild(entry.stepBuild);
      discardProgramBuild(entry.colorBuild);
      return;
    }
    if (a === "ready" && b === "ready") {
      entry.programs = {
        layers: entry.layers,
        groups: entry.groups,
        step: finishedPlaybackProgram(entry.stepBuild, PLAYBACK_STEP_UNIFORMS),
        color: finishedPlaybackProgram(entry.colorBuild, PLAYBACK_COLOR_UNIFORMS),
      };
      entry.status = "ready";
    }
  }

  // The programs, or null while there are none to use - either because this
  // precision's can't be built here (status "failed", with a status line,
  // since unlike the df pass there is nothing else to show in its place) or
  // because they are still building (status "building": ask again next
  // frame). playbackPlan tells the two apart. Float32 builds on the spot, as
  // it always did; df builds in the background.
  function playbackProgramsFor(precision) {
    var entry = playbackGpu.programs[precision];
    if (!entry) {
      try {
        entry = startPlaybackBuild(precision);
      } catch (err) {
        entry = { status: "failed", programs: null };
        setStatus(false, "Playback unavailable: " + (err.message || err));
      }
      playbackGpu.programs[precision] = entry;
    }
    pumpPlaybackBuild(entry, precision === "f32");
    return entry.programs;
  }

  function playbackProgramsPending(precision) {
    var entry = playbackGpu.programs[precision];
    return !!entry && entry.status === "building";
  }

  // ---- Sliced rendering: no draw ever runs more than a slice of the steps ----
  //
  // The grid program runs a pixel's WHOLE simulation inside one draw. At
  // float32 prices that is nothing. At df prices a single step of a hinged
  // scene is ~60 microseconds of strictly sequential work per pixel, so a
  // 1000-step draw cannot finish in under ~60ms however few pixels it
  // covers - banding by rows, which is all the ladder could do about a slow
  // draw, does not touch that floor. Draws that long get worse than slow.
  // Fragment work cannot be preempted in the middle of a tile, and the
  // compositor wants the GPU back every frame, so on an Apple-silicon Mac
  // WITH ITS DISPLAY ON a tile that shades for more than roughly 30-45ms is
  // reported by Metal as a GPU hang and its command buffer discarded.
  // (Measured with a bare Metal program as well as through the browser: a
  // 4x4 target survives a 33ms fragment loop and not a 58ms one, while a
  // 1024x1024 pass of short fragments runs 326ms untroubled - it is the
  // longest single run that counts, not the draw's total. A compute kernel
  // ran 13s. With the display asleep the same fragment draws are allowed
  // seconds, which is why this first looked like "gives out somewhere past
  // 350 steps".) WebGL is told nothing - no error, no lost context, just
  // pixels that were never written - and after a few of them the OS ignores
  // everything the GPU process submits until the page is reloaded.
  //
  // Playback already has the cure, for a different reason: a STEP pass that
  // carries every pixel's state in float textures between draws, and a
  // COLOR pass that paints from that state. So above float32 the grid is
  // drawn with those same two programs (playbackProgramsFor), a tile at a
  // time: run the tile's steps a slice per draw, then paint it into the
  // level exactly where the grid program would have drawn it. Every
  // consumer of the grid program has a sliced twin here - the ladder,
  // antialiasing, and the samplers - so nothing above float32 ever issues a
  // whole-simulation draw. (The hover replay is the one exception, and the
  // one remaining place a long run can still overstay.)
  //
  // The derived display modes ride along: a tile is simulated with five
  // state texels per pixel, the grid program's own five-point stencil laid
  // side by side (see stateWorldCoordLines / shadeStencilDerived), so the
  // picture is the same one shadeDerived() paints - not playback's
  // neighbouring-texel approximation of it.
  //
  // Float32 keeps the single-draw grid program, where one draw per band is
  // cheaper than a dozen. That is safe for the sample scenes and NOT for
  // every scene: a splitter scene's 20 body slots cost ~0.4ms a step even in
  // float32, so a few hundred steps of it overruns the limit above exactly
  // as df did. (True of this page before slicing existed, too. Routing
  // float32 through these same programs whenever a calibration like the
  // one below says its whole run is too long is the fix, and is not done
  // yet.)
  var MAX_TEXTURE_SIZE = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  // The most state texels one tile may hold. Two textures of this, times
  // the scene's state layers, times 16 bytes: ~30MB for a typical scene.
  var SLICE_MAX_TEXELS = 131072;
  // Steps per draw (sliceSteps, per precision) are MEASURED, once per scene
  // and precision - see calibrateSliceSteps. What one draw's longest run is
  // steered towards is several times under the limit above, because the
  // measurement is of a handful of pixels at the start of their runs and a
  // tile shades as slowly as its slowest pixel at its dearest step.
  //
  // 5ms is that, and is what Settings > Performance Settings > Longest single
  // GPU draw offers as its safest stop. The limit it keeps clear of is
  // Apple's. Other GPUs' watchdogs are measured in seconds, and there a
  // longer draw is simply a cheaper way to do the same work: every slice pays
  // to load and store the whole tile's state, in float textures, through a
  // phone's memory bus - and a whole run that fits in ONE draw pays none of
  // it (see sliceLimits().f32SingleDrawMs, which moves with this). So the
  // setting is honoured everywhere except on an Apple GPU, where it is held
  // at 5 whatever it says.
  var SLICE_TARGET_BASE_MS = 5;
  var gpuRendererName = (function () {
    try {
      var info = gl.getExtension("WEBGL_debug_renderer_info");
      return String((info && gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || "");
    } catch (err) {
      return "";
    }
  })();
  // By the renderer's name where there is one, and by the platform where the
  // browser masks it (Safari says only "Apple GPU"; an iPad says it is a Mac).
  var drawLengthLocked = /apple|metal/i.test(gpuRendererName) ||
    /Mac|iPhone|iPad|iPod/.test((global.navigator && (global.navigator.platform || global.navigator.userAgent)) || "");
  function sliceTargetMs() {
    return drawLengthLocked ? SLICE_TARGET_BASE_MS : Math.max(SLICE_TARGET_BASE_MS, perf.drawMs || SLICE_TARGET_BASE_MS);
  }
  var SLICE_STEPS_MIN = 1;
  // At the base draw length; a longer draw may run proportionally more.
  var SLICE_STEPS_BASE_MAX = 256;
  function sliceStepsMax() { return Math.round(SLICE_STEPS_BASE_MAX * sliceTargetMs() / SLICE_TARGET_BASE_MS); }
  // A precision whose SINGLE step measures longer than this cannot be drawn
  // at all - there is no smaller slice than one step - so the ladder treats
  // it as unavailable for the scene rather than hang the GPU finding out.
  // (Three draws' worth, like everything here in proportion to sliceTargetMs.)
  function sliceSingleStepLimitMs() { return 3 * sliceTargetMs(); }
  // The calibration stops doubling once a slice takes this long: enough to
  // stand clear of the ~1ms a timed round trip costs by itself.
  var SLICE_CALIBRATION_STOP_MS = 3;
  // A slice takes at least as long as its steps take ONE pixel, however few
  // pixels it has - that is what the numbers above are about - so a draw of
  // a few thousand pixels costs the GPU what a draw of tens of thousands
  // does, and leaves most of it idle while it runs. Measured with GPU timer
  // queries: a 64x64 tile of the df double pendulum took 0.9ms a step and a
  // 192x192 one 1.5ms, nine times the pixels for 1.6 times the time; df
  // pinball reached its benchmark throughput at 192x192 and a third of it
  // at the ~100x100 tiles the budget alone used to ask for. So:
  //
  // Tiles are at least this big wherever the level has that much left to
  // draw, with the STEPS per slice brought down (never up - the calibrated
  // count is a ceiling, see drawSlicedTile) to keep a slice of it inside
  // the frame's budget...
  var SLICE_SATURATE_TEXELS = 32768;
  // ...the ladder does not start coarser than a level with this many
  // samples. Every level is at least one pass of slices, and a pass of the
  // whole run costs the same few hundred ms whether it covers one sample or
  // ten thousand - so the 1x1, 2x1, 3x2... levels each held the first real
  // picture back by that much (eight levels of three passes each, for the
  // double pendulum: 12s before anything finer than 32px blocks)...
  var SLICE_FIRST_LEVEL_SAMPLES = 4096;
  // ...and a frame stops issuing slices once their runs add up to this share
  // of the display period, whatever the pixel budget has left. The budget
  // counts pixels, by which a slice of a tiny tile is free; the GPU counts
  // time, by which it is not. Frames of a coarse level used to issue
  // thousands of them (3,586 in one, measured: a 5.4s stall).
  // ("The display period" being the frame's target length - see frameBaseMs -
  // so a longer frame has room for proportionally more of them.)
  var SLICE_FRAME_SHARE = 0.75;
  var sliceFrameMs = 0;
  function sliceFrameCapMs() { return frameTargetMs(performance.now()) * SLICE_FRAME_SHARE; }
  // Far below the ladder's own floor: a sliced frame's smallest unit of work
  // is one slice of a small tile, not a whole simulated row.
  var SLICE_MIN_PIXEL_BUDGET = 16;

  // ---- Float32, when its whole run is too long for one draw ----
  //
  // The limit at the top of this section is not about precision. A scene
  // with many body slots is dear at float32 too - a splitter's 20 cost
  // ~0.4ms a step - and the grid program runs a pixel's WHOLE simulation in
  // one draw, so a few hundred steps of such a scene is a fragment that runs
  // for 100ms and more: the GPU is reset under it, the canvas goes blank,
  // and after a few of those the OS ignores the page's GPU work until it is
  // reloaded. (Measured, on this page as it was before slicing existed as
  // well as after.)
  //
  // So float32 is timed too, once per scene and display mode: the grid
  // program itself, on a handful of pixels, for 1, 2, 4... steps until a
  // run is long enough to measure - each at most double one already seen to
  // be short, as in calibrateSliceSteps, and for the same reason. If the
  // full Simulation Duration at that rate fits comfortably in one draw,
  // nothing changes: float32 keeps its single-draw program, which for an
  // ordinary scene is the fast path by a wide margin. If it does not,
  // float32 is drawn by the sliced renderer like everything above it.
  //
  // "Comfortably" is 2.4 draws' worth: 12ms at the base draw length, and more
  // where Longest single GPU draw allows more - which on a slow GPU is what
  // decides whether an ordinary scene gets the single-draw fast path at all.
  function f32SingleDrawLimitMs() { return 2.4 * sliceTargetMs(); }
  var f32StepMs = {};   // by variant; emptied with the scene (releaseAllSliceStates)
  function measureF32StepMs() {
    var target = makeTarget(8, 8);
    var stride = Math.max(1, Math.floor(Math.min(canvas.width, canvas.height) / 8));
    var texel = new Uint8Array(4);
    function timedRun(k) {
      var startedAt = performance.now();
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      gl.viewport(0, 0, 8, 8);
      gl.disable(gl.SCISSOR_TEST);
      gl.disable(gl.BLEND);
      drawSublattice(stride, 0, 0, k);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, texel);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return performance.now() - startedAt;
    }
    function timed(k) { return Math.min(timedRun(k), timedRun(k)); }
    timedRun(1);
    timedRun(1);
    var k = 1, took = timed(1), before = took, perStep = took;
    while (took < SLICE_CALIBRATION_STOP_MS && k < simulationSteps) {
      var next = Math.min(k * 2, simulationSteps);
      before = took;
      took = timed(next);
      // The slope between the last two, as in calibrateSliceSteps - and never
      // less than an eighth of the plain ratio, against a noisy pair.
      perStep = Math.max((took - before) / (next - k), took / next / 8);
      k = next;
    }
    freeTarget(target);
    gl.viewport(0, 0, canvas.width, canvas.height);
    return perStep;
  }
  function f32NeedsSlicing() {
    // (Reachable while the page is still starting up - the first budget is
    // made before the targets exist - when there is nothing to time with.)
    if (!hasFloatColorBuffer || !accum || !accum[0]) return false;
    var variant = wantedVariant();
    if (f32StepMs[variant] === undefined) {
      // The grid program has to exist to be timed; building it is what the
      // first frame would have done anyway.
      if (!requestPass("f32", variant, true)) return false;
      var measureStartedAt = performance.now();
      f32StepMs[variant] = measureF32StepMs();
      perfStats.calibrationMs += performance.now() - measureStartedAt;
    }
    return f32StepMs[variant] * simulationSteps > f32SingleDrawLimitMs();
  }
  // The sliced programs float32 is waiting for, when it needs them and they
  // are still building. Until they arrive the grid draws NOTHING: the only
  // other thing it could draw is the very draw that must not be issued.
  function f32SlicedPending() {
    if (effectivePrecision() !== "f32" || !f32NeedsSlicing()) return false;
    var entry = playbackGpu.programs.f32;
    return !entry || entry.status === "building";
  }

  // Named state-texture pairs: "ladder" for the tile the refinement ladder is
  // working on (which lives across frames), "sampler" for measurements (which
  // start and finish inside one call, and so must not share the ladder's).
  var sliceStates = {};

  function releaseSliceState(name) {
    var st = sliceStates[name];
    if (!st) return;
    gl.deleteFramebuffer(st.fbo);
    gl.deleteTexture(st.textures[0]);
    gl.deleteTexture(st.textures[1]);
    delete sliceStates[name];
  }
  function releaseAllSliceStates() {
    Object.keys(sliceStates).forEach(releaseSliceState);
    progressive.tile = null;
    progressive.tileX = 0;
    // What a step costs is the scene's.
    sliceSteps = {};
    sliceCalibrated = {};
    sliceTooHeavy = {};
    f32StepMs = {};
  }

  // Grow-only: a tile's size follows the budget from frame to frame, and
  // reallocating two float array textures every time it changed would cost
  // more than the tile.
  function ensureSliceState(name, w, h, layers) {
    var st = sliceStates[name];
    if (st && st.w >= w && st.h >= h && st.layers === layers) return st;
    var newW = Math.max(w, st && st.layers === layers ? st.w : 0);
    var newH = Math.max(h, st && st.layers === layers ? st.h : 0);
    releaseSliceState(name);
    var textures = [];
    for (var i = 0; i < 2; i++) {
      var tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA32F, newW, newH, layers);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      textures.push(tex);
    }
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
    st = { textures: textures, fbo: gl.createFramebuffer(), w: newW, h: newH, layers: layers, current: 0 };
    sliceStates[name] = st;
    return st;
  }

  // A tile of a lattice: `cols` x `rows` pixels starting at lattice pixel
  // (tileX, tileY), `stencil` state texels per pixel. The rest of `spec` is
  // the grid program's own pixel -> world mapping (stride, origin, the
  // resolution the lattice divides) and how many steps the run is.
  function beginSliceJob(stateName, programs, spec) {
    var st = ensureSliceState(stateName, spec.cols * spec.stencil, spec.rows, programs.layers);
    return { state: st, programs: programs, spec: spec, done: 0, started: false };
  }

  // One step draw: up to `steps` more of the run. The first also builds each
  // pixel's starting state (and is issued even for a zero-step run, which
  // still needs a state to paint from). Returns how many steps it ran.
  //
  // `maxDraws` (default: no limit) lets a slice be spread over several calls.
  // A state too big for one draw's attachments is written a group per draw,
  // each re-running the slice's steps - seven draws for a 20-slot splitter
  // scene - and the groups land in different layers of the same target, so
  // nothing stops them being issued a few per frame. A slice left part-way
  // returns 0 and picks up at its next group when called again; the state
  // only changes hands once the last group is in.
  function advanceSliceJob(job, steps, maxDraws) {
    var spec = job.spec, st = job.state, prog = job.programs.step, u = prog.uniforms;
    var resuming = job.nextGroup > 0;
    var k = resuming ? job.sliceSteps : Math.max(0, Math.min(steps, spec.totalSteps - job.done));
    if (k === 0 && job.started) return 0;
    var target = st.textures[1 - st.current];
    gl.useProgram(prog.program);
    bindQuad(prog.posLoc);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, st.textures[st.current]);
    gl.uniform1i(u.state, 0);
    gl.uniform2f(u.resolution, spec.resW, spec.resH);
    gl.uniform1f(u.gridStride, spec.stride);
    gl.uniform2f(u.gridOrigin, spec.originX, spec.originY);
    setCenterUniforms(u);
    gl.uniform1f(u.scale, view.scale);
    gl.uniform1i(u.init, job.started ? 0 : 1);
    gl.uniform1i(u.baseStep, job.done);
    gl.uniform1i(u.steps, k);
    gl.uniform2f(u.tileOrigin, spec.tileX, spec.tileY);
    gl.uniform1i(u.stencil, spec.stencil);
    gl.bindFramebuffer(gl.FRAMEBUFFER, st.fbo);
    // The viewport IS the tile: gl_FragCoord is in framebuffer pixels either
    // way, so texel (0, 0) is the tile's first point and nothing outside the
    // tile's rectangle is shaded.
    gl.viewport(0, 0, spec.cols * spec.stencil, spec.rows);
    gl.disable(gl.SCISSOR_TEST);
    var layers = job.programs.layers;
    var firstGroup = resuming ? job.nextGroup : 0;
    var lastGroup = Math.min(job.programs.groups, firstGroup + (maxDraws > 0 ? maxDraws : job.programs.groups));
    for (var g = firstGroup; g < lastGroup; g++) {
      var buffers = [];
      for (var a = 0; a < MAX_STATE_ATTACHMENTS; a++) {
        var layer = g * MAX_STATE_ATTACHMENTS + a;
        var used = layer < layers;
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + a, used ? target : null, 0, used ? layer : 0);
        buffers.push(used ? gl.COLOR_ATTACHMENT0 + a : gl.NONE);
      }
      gl.drawBuffers(buffers);
      gl.uniform1i(u.group, g);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    job.drawsIssued = lastGroup - firstGroup;
    perfStats.drawsThisFrame += job.drawsIssued;
    if (lastGroup < job.programs.groups) {
      job.nextGroup = lastGroup;
      job.sliceSteps = k;
      return 0;
    }
    job.nextGroup = 0;
    st.current = 1 - st.current;
    job.done += k;
    job.started = true;
    return k;
  }

  // The color pass: paint the finished tile into `fbo` with its first pixel
  // at (x, y). opts.sample writes the raw t instead (into a float target);
  // opts.blend = n averages the tile in as the n-th antialiasing sample.
  function resolveSliceJob(job, fbo, x, y, opts) {
    opts = opts || {};
    var spec = job.spec, st = job.state, prog = job.programs.color, u = prog.uniforms;
    gl.useProgram(prog.program);
    bindQuad(prog.posLoc);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, st.textures[st.current]);
    gl.uniform1i(u.state, 0);
    gl.uniform2i(u.stateSize, spec.cols * spec.stencil, spec.rows);
    gl.uniform1i(u.stateSteps, spec.totalSteps);
    gl.uniform1f(u.gridStride, spec.stride);
    gl.uniform1i(u.colorZoom, colorZoomEnabled ? 1 : 0);
    gl.uniform1i(u.durationSteps, simulationSteps);
    gl.uniform1f(u.bounceMax, opts.bounceMax === undefined ? bounceMaxValue : opts.bounceMax);
    gl.uniform1i(u.displayMode, displayMode.id);
    gl.uniform2i(u.targetOrigin, x, y);
    gl.uniform1i(u.stencil, spec.stencil);
    gl.uniform1i(u.sampleField, opts.sample ? 1 : 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(x, y, spec.cols, spec.rows);
    gl.disable(gl.SCISSOR_TEST);
    if (opts.blend) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.CONSTANT_ALPHA, gl.ONE_MINUS_CONSTANT_ALPHA);
      gl.blendColor(0, 0, 0, 1 / opts.blend);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    if (opts.blend) gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // How many steps one sliced draw may run at `precision`, by timing it: a
  // small tile spread across the view (so its pixels do not all take the
  // same branches), advanced 1, 2, 4, ... steps with the clock stopped on a
  // one-texel readback after each, until a slice takes long enough to
  // measure. Every timed slice is at most double one that was already seen
  // to be short, so the measurement cannot itself be the draw that hangs.
  // The time includes the readback's round trip, which makes a step look
  // dearer than it is - the safe direction.
  //
  // This blocks the page while it runs: a few round trips of a few ms, once
  // per scene and precision. Cheap next to the seconds the programs took to
  // build, and there is no way to learn the number without waiting for it.
  function calibrateSliceSteps(precision, programs) {
    var CAL = 8;
    var job = beginSliceJob("calibrate", programs, {
      cols: CAL, rows: CAL, stencil: 1, tileX: 0, tileY: 0,
      stride: Math.max(1, Math.floor(Math.min(canvas.width, canvas.height) / CAL)), originX: 0, originY: 0,
      resW: canvas.width, resH: canvas.height, totalSteps: 1 << 20,
    });
    var texel = new Float32Array(4);
    function timedSlice(k) {
      var startedAt = performance.now();
      advanceSliceJob(job, k);
      gl.bindFramebuffer(gl.FRAMEBUFFER, job.state.fbo);
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, texel);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return performance.now() - startedAt;
    }
    // Each timing is the better of two. One bad reading used to decide the
    // whole scene: measured over three loads of the df double pendulum, the
    // slices after the first took 2.1, 4.7 and 2.3ms for a single step whose
    // true cost is 0.1ms - the driver still settling in - and the 4.7 was
    // read as "one step is all a draw can afford", which left that session
    // drawing one step per slice and rendering at a fraction of the speed.
    //
    // And it is per DRAW: a state too big for one draw's attachments is
    // written in groups, one draw each (see advanceSliceJob), and it is a
    // single draw's length the limit is about - a 20-slot splitter scene
    // takes seven, and timing the seven together allowed it one step a
    // slice where four are safe.
    function timed(k) { return Math.min(timedSlice(k), timedSlice(k)) / programs.groups; }
    // Untimed: builds each pixel's starting state, and absorbs whatever the
    // driver still had left to do for this program - which takes more than
    // one draw.
    timedSlice(1);
    timedSlice(1);
    var k = 1, took = timed(1), before = took;
    var calibrationStartedAt = performance.now();
    if (took > sliceSingleStepLimitMs()) {
      sliceTooHeavy[precision] = true;
      sliceSteps[precision] = SLICE_STEPS_MIN;
    } else {
      var stepsMax = sliceStepsMax(), targetMs = sliceTargetMs();
      while (took < SLICE_CALIBRATION_STOP_MS && k < stepsMax) {
        k *= 2;
        before = took;
        took = timed(k);
      }
      // A slice costs a fixed amount (the round trip that timed it, the
      // state's load and store) plus so much a step, and only the second
      // part grows with its length - so the step's cost is the SLOPE between
      // the last two timings, not the last one divided by its steps, which
      // charged the fixed part to the steps and came out several times too
      // cautious for a scene whose steps are cheap.
      var perStep = k > 1 ? Math.max((took - before) / (k / 2), took / k / 8) : took;
      var fixed = Math.max(0, took - perStep * k);
      sliceSteps[precision] = clamp(Math.floor((targetMs - Math.min(fixed, targetMs / 2)) / perStep), SLICE_STEPS_MIN, stepsMax);
      perfStats.sliceStepMs = perStep;
    }
    perfStats.calibrationMs += performance.now() - calibrationStartedAt;
    sliceCalibrated[precision] = sliceSteps[precision];
    releaseSliceState("calibrate");
  }

  // The step + color programs to draw the GRID with, or null when the grid
  // program itself should (float32, or no float render targets to carry
  // state in, or the programs are still building - see effectivePrecision).
  function slicedProgramsForGrid() {
    var precision = effectivePrecision();
    if (!hasFloatColorBuffer) return null;
    if (precision === "f32") {
      if (!f32NeedsSlicing()) return null;
      // Built in the background like the precisions above - playback's own
      // request for them (playbackProgramsFor) still waits, as it always has.
      if (!playbackGpu.programs.f32) {
        try {
          playbackGpu.programs.f32 = startPlaybackBuild("f32");
        } catch (err) {
          playbackGpu.programs.f32 = { status: "failed", programs: null };
        }
      }
    }
    var entry = playbackGpu.programs[precision];
    if (!entry || entry.status !== "ready") return null;
    if (!sliceSteps[precision]) {
      calibrateSliceSteps(precision, entry.programs);
      // One step alone was too long: this precision is off the ladder for
      // this scene, and the next frame falls back down it.
      if (sliceTooHeavy[precision]) { updatePrecisionReadout(); markDirty(); return null; }
    }
    return entry.programs;
  }

  // The ladder's (and antialiasing's) unit of work under sliced rendering:
  // one more slice of the tile in flight - starting the next tile of
  // `lattice` first if there is none - and, when that finishes the tile's
  // run, the color pass that lands it in lattice.target. Returns what the
  // slice cost in the budget's own unit, whole simulated pixels, so a slice
  // of k steps out of n costs k/n of the tile; and never 0, which the
  // callers read as "nothing left to draw".
  //
  // A tile is sized so that ONE slice of it is about what this frame can
  // still afford: whole rows of the level when that many pixels cover at
  // least one, a run of one row when they don't.
  function drawSlicedTile(programs, lattice, pixelsAvailable) {
    var total = renderedSteps();
    var perDraw = sliceSteps[effectivePrecision()] || SLICE_STEPS_MIN;
    // See SLICE_FRAME_SHARE. Never before the frame's first slice, so a
    // frame always moves forward; 0 is what the callers read as "stop here".
    if (sliceFrameMs >= sliceFrameCapMs()) return 0;
    var job = progressive.tile;
    // A slice is sized to be about a whole frame's budget (see perDraw
    // below), so unlike a band it cannot be trimmed to whatever the frame
    // has left - and a frame that had spent 99% of its budget on one used to
    // see 1% remaining and issue a second, for twice the budget every frame.
    // After the frame's first, the next slice goes ahead only if most of it
    // fits in what is left.
    if (sliceFrameMs > 0) {
      var nextCost = job ? job.spec.cols * job.spec.rows * Math.min(job.perDraw, total - job.done) / Math.max(total, 1)
                         : ladderBudget.budget;
      if (nextCost > pixelsAvailable * 2) return 0;
    }
    if (!job) {
      // Which rectangle of the level's region this tile is cut from (the
      // whole level, unless a pan is reusing pixels - see levelSimRegion).
      // The caller has checked there is one.
      var at = locateBand(lattice.region, progressive.band), rect = at.rect;
      var stencil = displayMode.id !== 0 ? 5 : 1;
      var slices = Math.max(1, Math.ceil(total / perDraw));
      var maxPixels = Math.max(1, Math.floor(SLICE_MAX_TEXELS / stencil));
      var maxCols = Math.max(1, Math.floor(MAX_TEXTURE_SIZE / stencil));
      // See SLICE_SATURATE_TEXELS: what the budget affords at full-length
      // slices, or enough to keep the GPU busy, whichever is more - but
      // never so many that even a ONE-step slice of them overruns the
      // frame's budget, which for a scene heavy enough is fewer than that.
      var saturate = Math.min(Math.floor(SLICE_SATURATE_TEXELS / stencil), Math.floor(ladderBudget.budget * Math.max(total, 1)));
      var pixels = clamp(Math.max(Math.floor(pixelsAvailable * slices), saturate), 64, maxPixels);
      var cols, rows;
      if (progressive.tileX === 0 && pixels >= rect.w && rect.w <= maxCols) {
        cols = rect.w;
        rows = Math.min(rect.h - at.row, Math.floor(pixels / rect.w));
      } else {
        rows = 1;
        cols = Math.min(rect.w - progressive.tileX, pixels, maxCols);
      }
      job = beginSliceJob("ladder", programs, {
        cols: cols, rows: rows, stencil: stencil, tileX: rect.x + progressive.tileX, tileY: rect.y + at.row,
        stride: lattice.stride, originX: lattice.originX, originY: lattice.originY,
        resW: canvas.width, resH: canvas.height, totalSteps: total,
      });
      job.rectWidth = rect.w;
      // Steps per slice for THIS tile: as many as a frame's budget covers
      // for a tile this size, up to the calibrated ceiling.
      job.perDraw = clamp(Math.floor(ladderBudget.budget * total / Math.max(cols * rows, 1)), SLICE_STEPS_MIN, perDraw);
      progressive.tile = job;
    }
    // The calibrated count takes about sliceTargetMs() a draw; fewer steps,
    // less. A state written in several groups is that many draws a slice,
    // of which a frame issues only as many as its time cap has room for
    // (always one) - see advanceSliceJob.
    var sliceK = Math.min(job.perDraw || perDraw, perDraw);
    var drawMs = sliceTargetMs() * Math.max(job.nextGroup > 0 ? job.sliceSteps : sliceK, 1) / perDraw;
    var room = Math.max(1, Math.floor((sliceFrameCapMs() - sliceFrameMs) / drawMs));
    var ran = advanceSliceJob(job, sliceK, room);
    sliceFrameMs += drawMs * job.drawsIssued;
    // Part-way through a slice: nothing to charge or finish yet, and nothing
    // more to issue this frame.
    if (job.nextGroup > 0) { sliceFrameMs = Infinity; return REUSE_FREE_COST; }
    var area = job.spec.cols * job.spec.rows;
    var cost = total > 0 ? area * ran / total : area;
    if (job.done >= total) {
      resolveSliceJob(job, lattice.target.fbo, job.spec.tileX, job.spec.tileY, { blend: lattice.blend });
      if (job.spec.cols === job.rectWidth) {
        progressive.band += job.spec.rows;
      } else {
        progressive.tileX += job.spec.cols;
        if (progressive.tileX >= job.rectWidth) { progressive.tileX = 0; progressive.band += 1; }
      }
      progressive.tile = null;
    }
    return Math.max(cost, 1e-6);
  }

  // drawSampleBand's twin: the same block of samples into the same target,
  // simulated in slices. Every draw is only QUEUED here - nothing waits on
  // the GPU until the caller reads the target back - so however many slices
  // it takes, this costs the page no more than the single draw did.
  function drawSampleBandSliced(programs, target, blockWidth, blockHeight, rowStart, rowCount, rawBounces) {
    var total = rawBounces ? simulationSteps : renderedSteps();
    var perDraw = sliceSteps[effectivePrecision()] || SLICE_STEPS_MIN;
    var maxRows = Math.max(1, Math.floor(SLICE_MAX_TEXELS / Math.max(blockWidth, 1)));
    for (var r = 0; r < rowCount; r += maxRows) {
      var rows = Math.min(maxRows, rowCount - r);
      var job = beginSliceJob("sampler", programs, {
        cols: blockWidth, rows: rows, stencil: 1, tileX: 0, tileY: rowStart + r,
        stride: 1, originX: 0, originY: 0, resW: blockWidth, resH: blockHeight, totalSteps: total,
      });
      do { advanceSliceJob(job, perDraw); } while (job.done < total);
      resolveSliceJob(job, target.fbo, 0, r, { sample: true, bounceMax: rawBounces ? 1 : bounceMaxValue });
    }
  }

  // The calibration times a run's first steps, and a step can get dearer
  // later on (a split wakes more bodies). That shows up as a frame that
  // overruns badly even though the budget is already at its floor - there
  // are no pixels left to take away, so what is too long is the draw
  // itself. Halve it. It is never raised again: a scene that needed the
  // smaller slice still does.
  //
  // But only down to a quarter of what was measured. An overrun at the floor
  // is not proof the slice was too long - a frame also runs long for a
  // garbage collection, a program still building, or a tab that was in the
  // background - and the rungs above df START at the floor, so there every
  // such hiccup used to count. Unbounded, a few of them ratcheted triple-
  // float down to one step per draw for good (seen: a 10s picture took 50s).
  // A quarter still leaves a real mis-measurement a further 4x of relief, on
  // top of the several-fold margin sliceTargetMs() already keeps under the
  // limit.
  var sliceOverrunsInARow = 0;
  function adaptSliceSteps(tookPeriods) {
    var precision = effectivePrecision();
    // Three in a row: one long frame is a hiccup, and says nothing about
    // the slices that happened to be in it.
    if (!sliceSteps[precision] || tookPeriods <= HARD_OVERRUN_RATIO || ladderBudget.budget > ladderBudget.min * 1.5) {
      if (tookPeriods > 0) sliceOverrunsInARow = 0;
      return;
    }
    sliceOverrunsInARow += 1;
    if (sliceOverrunsInARow < 3) return;
    sliceOverrunsInARow = 0;
    var floor = Math.max(SLICE_STEPS_MIN, Math.ceil((sliceCalibrated[precision] || sliceSteps[precision]) / 4));
    sliceSteps[precision] = Math.max(floor, Math.floor(sliceSteps[precision] / 2));
  }

  function releasePlaybackPrograms() {
    Object.keys(playbackGpu.programs).forEach(function (k) {
      var entry = playbackGpu.programs[k];
      if (entry.programs) {
        gl.deleteProgram(entry.programs.step.program);
        gl.deleteProgram(entry.programs.color.program);
      } else if (entry.status === "building") {
        discardProgramBuild(entry.stepBuild);
        discardProgramBuild(entry.colorBuild);
      }
    });
    playbackGpu.programs = {};
  }

  // Frees the state - by far the biggest thing playback holds - and forgets
  // everything that described it. Called the moment the state stops being
  // useful: the view moves (see releasePlaybackIfViewMoved), the page is
  // left, or the scene changes. A later Play rebuilds it from step 0, which
  // it would have had to do for any of those anyway.
  function releasePlaybackTextures() {
    // The framebuffer first, so no attachment is holding a texture alive.
    if (playbackGpu.fbo) gl.deleteFramebuffer(playbackGpu.fbo);
    playbackGpu.textures.forEach(function (t) { if (t) gl.deleteTexture(t); });
    playbackGpu.textures = [null, null];
    playbackGpu.fbo = null;
    playbackGpu.width = playbackGpu.height = playbackGpu.layers = 0;
    playbackGpu.viewKey = null;
    timeline.stateKey = null;
    timeline.pass = null;
    timeline.presentedKey = null;
  }

  // Everything, including the compiled programs - for leaving the page.
  function releaseAllPlayback() {
    stopTimelineClock();
    timeline.following = false;
    releasePlaybackTextures();
    releasePlaybackPrograms();
  }

  // The world view and canvas the state was built for, without the lattice
  // or precision - those are only known once programs exist, and this is
  // checked every frame, playing or not.
  function playbackViewKey() {
    return [viewCenterKey(), view.scale, canvas.width, canvas.height].join(" ");
  }

  // State built for a view is worthless once the view moves: every pixel's
  // simulation belongs to the world point it started from. So a pan, zoom or
  // resize frees it immediately rather than holding hundreds of megabytes
  // until the next Play happens to reallocate.
  function releasePlaybackIfViewMoved() {
    if (playbackGpu.fbo && playbackGpu.viewKey !== playbackViewKey()) releasePlaybackTextures();
  }

  function ensurePlaybackTextures(w, h, layers) {
    if (playbackGpu.fbo && playbackGpu.width === w && playbackGpu.height === h && playbackGpu.layers === layers) return true;
    releasePlaybackTextures();
    // Whatever is already queued up is somebody else's error, not this
    // allocation's.
    while (gl.getError() !== gl.NO_ERROR) { /* drain */ }
    for (var i = 0; i < 2; i++) {
      var tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA32F, w, h, layers);
      // A float texture isn't filterable, and one whose filter asks for
      // filtering is incomplete - every texelFetch of it reads zero.
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      playbackGpu.textures[i] = tex;
    }
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
    playbackGpu.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, playbackGpu.fbo);
    gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, playbackGpu.textures[0], 0, 0);
    var complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!complete || gl.getError() !== gl.NO_ERROR) {
      releasePlaybackTextures();
      return false;
    }
    playbackGpu.width = w;
    playbackGpu.height = h;
    playbackGpu.layers = layers;
    playbackGpu.current = 0;
    playbackGpu.viewKey = playbackViewKey();
    return true;
  }

  // Which sub-lattice of the full-res grid playback simulates: never finer
  // than one sample per CSS pixel (a Retina canvas has four device pixels to
  // each), never finer than the Resolution Limits setting allows the ladder,
  // and coarser still until both state copies fit playbackStateMaxBytes().
  // A power of two, so it is always one of the ladder's own levels.
  function playbackStride(layers) {
    var dpr = gridDpr();
    var stride = Math.max(endStride(), Math.pow(2, Math.floor(Math.log2(Math.max(1, dpr)))));
    while (stride < COARSEST_STRIDE &&
      2 * layers * BYTES_PER_STATE_TEXEL * levelWidth(stride) * levelHeight(stride) > playbackStateMaxBytes()) {
      stride *= 2;
    }
    return stride;
  }

  // What one playback frame needs for the view as it stands, or null when
  // playback can't run here. `key` names what the state is only valid for:
  // the exact view, canvas, lattice and precision.
  //
  // Deliberately allocates no state. That happens in stepPlayback, and only
  // once the view has held still: allocating here - every frame, before
  // knowing whether the view was still moving - reallocated both state
  // textures on every frame of a window resize, hundreds of megabytes a
  // frame, which is enough to crash the browser's GPU process.
  function playbackPlan() {
    if (!hasFloatColorBuffer || !ensureTargets()) return null;
    var precision = effectivePrecision();
    var programs = playbackProgramsFor(precision);
    // Still building: not "can't", just "not yet" - the caller lets the
    // ladder keep the frame and asks again on the next one.
    if (!programs) return playbackProgramsPending(precision) ? { pending: true } : null;
    var stride = playbackStride(programs.layers);
    var w = levelWidth(stride), h = levelHeight(stride);
    return {
      programs: programs,
      stride: stride,
      w: w,
      h: h,
      key: [viewCenterKey(), view.scale, canvas.width, canvas.height, stride, precision].join(" "),
    };
  }

  // Everything the color pass's picture depends on besides the state
  // itself - if any of it changes, the same state has to be painted again.
  function playbackLookKey(res) {
    return [res.key, timeline.stateStep, displayMode.id, colorZoomEnabled, simulationSteps, bounceMaxValue].join(" ");
  }

  // Rows [band, band + rows) of one step pass, into the texture that isn't
  // current. A state with more layers than one draw can write is written
  // one group per draw - the same steps, a different slice kept each time.
  function drawPlaybackBand(res, pass, rows) {
    var prog = res.programs.step, u = prog.uniforms;
    var layers = res.programs.layers;
    var target = playbackGpu.textures[1 - playbackGpu.current];
    gl.useProgram(prog.program);
    bindQuad(prog.posLoc);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, playbackGpu.textures[playbackGpu.current]);
    gl.uniform1i(u.state, 0);
    // The full-res canvas, and this lattice's place in it - so every texel
    // lands on the world point the ladder's own pixel there would.
    gl.uniform2f(u.resolution, canvas.width, canvas.height);
    gl.uniform1f(u.gridStride, res.stride);
    gl.uniform2f(u.gridOrigin, 0, 0);
    setCenterUniforms(u);
    gl.uniform1f(u.scale, view.scale);
    gl.uniform1i(u.init, pass.init ? 1 : 0);
    gl.uniform1i(u.baseStep, pass.from);
    gl.uniform1i(u.steps, pass.steps);
    // The whole lattice, one point per pixel - see "Sliced rendering" for
    // the caller that uses these two for something else.
    gl.uniform2f(u.tileOrigin, 0, 0);
    gl.uniform1i(u.stencil, 1);
    gl.bindFramebuffer(gl.FRAMEBUFFER, playbackGpu.fbo);
    gl.viewport(0, 0, res.w, res.h);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, pass.band, res.w, rows);
    for (var g = 0; g < res.programs.groups; g++) {
      var buffers = [];
      for (var k = 0; k < MAX_STATE_ATTACHMENTS; k++) {
        var layer = g * MAX_STATE_ATTACHMENTS + k;
        var used = layer < layers;
        gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + k, used ? target : null, 0, used ? layer : 0);
        buffers.push(used ? gl.COLOR_ATTACHMENT0 + k : gl.NONE);
      }
      gl.drawBuffers(buffers);
      gl.uniform1i(u.group, g);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // Paints the current state into the accumulator, at the lattice's own
  // size, and puts it on the canvas the same way the ladder shows a level.
  function presentPlayback(res) {
    var prog = res.programs.color, u = prog.uniforms;
    var target = accum[accumIndex];
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, res.w, res.h);
    gl.disable(gl.SCISSOR_TEST);
    gl.useProgram(prog.program);
    bindQuad(prog.posLoc);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, playbackGpu.textures[playbackGpu.current]);
    gl.uniform1i(u.state, 0);
    gl.uniform2i(u.stateSize, res.w, res.h);
    gl.uniform1i(u.stateSteps, timeline.stateStep);
    gl.uniform1f(u.gridStride, res.stride);
    gl.uniform1i(u.colorZoom, colorZoomEnabled ? 1 : 0);
    gl.uniform1i(u.durationSteps, simulationSteps);
    gl.uniform1f(u.bounceMax, bounceMaxValue);
    gl.uniform1i(u.displayMode, displayMode.id);
    gl.uniform2i(u.targetOrigin, 0, 0);
    gl.uniform1i(u.stencil, 1);
    gl.uniform1i(u.sampleField, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    presentLevel(target, res.w, res.h, res.stride);
    timeline.presentedKey = playbackLookKey(res);
    // Picture reuse: the accumulator is playback's now, not a ladder run's.
    reuse.image = null;
  }

  // One frame of playback. Returns false when playback isn't drawing this
  // frame (paused, or waiting for the view to hold still), in which case the
  // ladder gets the frame instead.
  function stepPlayback(now) {
    timeline.drawing = false;
    if (!timeline.playing) return false;
    var dt = timeline.lastTickAt > 0 ? (now - timeline.lastTickAt) / 1000 : 0;
    timeline.lastTickAt = now;
    var res = playbackPlan();
    if (res && res.pending) {
      // The programs are on their way (see playbackProgramsFor). Hold the
      // clock where it is rather than letting it run on ahead of a picture
      // that cannot follow yet.
      timeline.lastTickAt = 0;
      return false;
    }
    if (!res) {
      stopTimelineClock();
      timeline.following = false;
      markDirty();
      updateTimelineUI();
      return false;
    }
    if (res.key !== timeline.seenKey) {
      if (timeline.seenKey !== null) timeline.seenAt = now;
      timeline.seenKey = res.key;
    }
    var building = timeline.pass && timeline.pass.key === res.key;
    if (res.key !== timeline.stateKey && !building) {
      // Nothing valid for this view - it moved, or there never was any.
      timeline.pass = null;
      timeline.carry = 0;
      if (now - timeline.seenAt < PLAYBACK_SETTLE_MS) {
        playbackBudget.lastWorkAt = 0;
        playbackBudget.lastSpent = 0;
        updateTimelineUI();
        return false;
      }
    }
    // The view has held still, so this is the first moment the state is
    // worth its memory - see playbackPlan.
    if (!ensurePlaybackTextures(res.w, res.h, res.programs.layers)) {
      setStatus(false, "Playback unavailable: not enough video memory for its state");
      stopTimelineClock();
      timeline.following = false;
      markDirty();
      updateTimelineUI();
      return false;
    }

    // The ladder's timing is meaningless across however long playback holds
    // the frame; left alone it would read the whole stretch as one frame of
    // its own and shrink its budget to nothing.
    ladderBudget.lastWorkAt = 0;
    ladderBudget.lastSpent = 0;
    noteFrameTiming(playbackBudget, now);
    var budget = playbackBudget.budget;
    var groups = res.programs.groups;
    var following = timeline.following;
    var catchingUp = timeline.stateKey !== res.key || timeline.stateStep < timeline.step;
    if (!catchingUp && !following) {
      var rate = PLAYBACK_STEPS_PER_SECOND * playbackSpeed;
      timeline.carry = Math.min(timeline.carry + dt * rate, Math.max(1, rate * PLAYBACK_MAX_CARRY_SECONDS));
    }

    var spent = 0, advanced = false;
    // Always at least one band, however tight the budget - the same
    // forward-progress rule as the ladder's.
    while (spent < budget || spent === 0) {
      if (!timeline.pass) {
        var fresh = timeline.stateKey !== res.key;
        var have = fresh ? 0 : timeline.stateStep;
        // Following Inspect, the target is whatever step its clock shows;
        // otherwise it's the step to catch up to, or else the clock's.
        var want = following ? Math.min(simulationSteps, timeline.followTarget)
          : (fresh || have < timeline.step) ? timeline.step
          : Math.min(simulationSteps, have + Math.floor(timeline.carry));
        if (!fresh && want <= have) break;
        if (fresh && isBouncesOutput) bounceMaxValue = findBounceMax();
        // As many steps as the rest of this frame's budget covers across the
        // whole lattice, never fewer than one: a pass that can't finish this
        // frame just bands across the next few.
        var affordable = Math.max(1, Math.floor((budget - spent) / (res.w * res.h * groups)));
        timeline.pass = { key: res.key, init: fresh, from: have, steps: Math.min(want - have, affordable), band: 0 };
      }
      var pass = timeline.pass;
      var rowCost = res.w * Math.max(1, pass.steps) * groups;
      var rows = Math.min(res.h - pass.band, Math.max(1, Math.floor((budget - spent) / rowCost)));
      drawPlaybackBand(res, pass, rows);
      spent += rows * rowCost;
      pass.band += rows;
      if (pass.band < res.h) continue;

      // The pass is complete: the texture it wrote is the state now.
      playbackGpu.current = 1 - playbackGpu.current;
      timeline.stateKey = pass.key;
      timeline.stateStep = pass.from + pass.steps;
      timeline.pass = null;
      if (following) {
        timeline.step = timeline.stateStep;
      } else if (timeline.stateStep > timeline.step) {
        timeline.carry = Math.max(0, timeline.carry - (timeline.stateStep - timeline.step));
        timeline.step = timeline.stateStep;
      }
      advanced = true;
      if (timeline.stateStep >= simulationSteps) break;
    }
    playbackBudget.lastSpent = spent;

    if (following) {
      // Best effort, never a hold-up: whatever step the state has reached
      // is shown, even short of Inspect's - a GPU slower than the preview's
      // clock just trails it a little rather than freezing the map until it
      // catches up. Only a rebuild for a new view shows nothing new.
      catchingUp = timeline.stateKey !== res.key;
      timeline.catchingUp = catchingUp;
      timeline.catchUpFraction = 0;
      timeline.stride = res.stride;
      timeline.drawing = true;
      if (!catchingUp && (advanced || timeline.presentedKey !== playbackLookKey(res))) presentPlayback(res);
      updateRenderProgressRing();
      // Inspect has stopped and the map has reached its step - sharpen it.
      if (!catchingUp && !timeline.followPlaying && timeline.stateStep >= timeline.followTarget) pauseTimeline();
      else updateTimelineUI();
      return true;
    }

    catchingUp = timeline.stateKey !== res.key || timeline.stateStep < timeline.step;
    timeline.catchingUp = catchingUp;
    timeline.catchUpFraction = timeline.step > 0 && timeline.stateKey === res.key ? timeline.stateStep / timeline.step : 0;
    timeline.stride = res.stride;
    timeline.drawing = true;
    if (!catchingUp && (advanced || timeline.presentedKey !== playbackLookKey(res))) presentPlayback(res);
    updateRenderProgressRing();
    // Reached the end - the picture stops changing, so let the ladder
    // finish it off at full quality.
    if (!catchingUp && timeline.step >= simulationSteps) pauseTimeline();
    else updateTimelineUI();
    return true;
  }

  // Hands the image playback last painted to the ladder as a finished level
  // of the current run, so pausing sharpens what is on screen rather than
  // restarting from the coarsest blocks. Only when that image is exactly the
  // picture the ladder would be refining (same view, step and look), and
  // only in Standard: the derived modes' playback shading differences
  // neighbouring texels (see shadePlaybackDerived), which approximates the
  // ladder's per-pixel stencil but doesn't reproduce it, and a level built
  // one way refined by samples of the other would show the seam.
  function seedLadderFromPlayback() {
    if (displayMode !== DISPLAY_MODES[0] || !timeline.presentedKey) return false;
    var res = playbackPlan();
    if (!res || res.pending || timeline.stateKey !== res.key || timeline.stateStep !== timeline.step) return false;
    if (timeline.presentedKey !== playbackLookKey(res)) return false;
    dirty = false;
    // Picture reuse: what playback painted is this view at this step, and
    // from here on the ladder's to refine.
    if (reuseEnabled) reuseNoteImage();
    progressive.stride = res.stride;
    progressive.accumStride = res.stride;
    progressive.sublattice = 1;
    progressive.band = 0;
    progressive.complete = false;
    progressive.aaSample = 0;
    // What beginProgressive would have done for a run of its own - the
    // bounce-count divisor excepted, which playback already measured for
    // this same view.
    updateInspectMarkers();
    updatePrecisionReadout();
    if (res.stride <= endStride()) {
      finishRun(0);
    } else {
      presentFrame();
      updateResolutionBoundsUI();
    }
    scheduleColorSpreadCheck();
    statsOnViewChanged();
    return true;
  }

  // Stops the clock without deciding what the grid shows next.
  function stopTimelineClock() {
    timeline.playing = false;
    timeline.drawing = false;
    timeline.catchingUp = false;
    // The texture a pass in flight was writing is simply abandoned - the
    // current one is still complete.
    timeline.pass = null;
    timeline.carry = 0;
    timeline.lastTickAt = 0;
    playbackBudget.lastWorkAt = 0;
    playbackBudget.lastSpent = 0;
  }

  // A first measurement to start playback's budget from, rather than a
  // guess: the ladder's throughput is pixels per period at the step count it
  // was rendering, i.e. roughly that many pixel-steps.
  function seedPlaybackBudget() {
    if (playbackBudget.throughput === 0 && ladderBudget.throughput > 0) {
      playbackBudget.budget = clamp(ladderBudget.throughput * Math.max(1, renderedSteps()) * displayMode.samples,
        playbackBudget.min, playbackBudget.max);
    }
  }

  function playTimeline() {
    if (timeline.playing || timeline.following || !hasFloatColorBuffer) return;
    // Play at the end starts over, the way a media player does.
    if (timeline.step >= simulationSteps) {
      timeline.step = 0;
      timeline.stateKey = null;
    }
    seedPlaybackBudget();
    timeline.playing = true;
    timeline.carry = 0;
    timeline.lastTickAt = 0;
    // Nothing is moving - no reason to wait for the view to settle.
    timeline.seenKey = null;
    timeline.seenAt = 0;
    // The picture is about to change every frame: nothing measured of it
    // stays true, and nothing new is worth measuring until it stops.
    statsOnViewChanged();
    updateTimelineUI();
  }

  function pauseTimeline() {
    if (!timeline.playing) return;
    stopTimelineClock();
    if (!seedLadderFromPlayback()) markDirty();
    updateRenderProgressRing();
    updateTimelineUI();
  }

  // Shows `step` - from a scrub of the timeline, or the restart button.
  // Pauses first: a user dragging the timeline is choosing the step
  // themselves.
  function seekTimeline(step) {
    step = clamp(Math.round(step), 0, simulationSteps);
    var wasPlaying = timeline.playing;
    if (wasPlaying) stopTimelineClock();
    if (step === timeline.step && !wasPlaying) return;
    // State only moves forward; a later step is still reachable from it.
    if (step < timeline.stateStep) timeline.stateKey = null;
    timeline.step = step;
    markDirty();
    updateTimelineUI();
  }

  // ---- The map in lockstep with Inspect ----
  //
  // While the Map Evolution card is open, the map plays whatever step the
  // Inspect preview is showing, so a hovered or inspected point and the
  // whole field around it evolve together. The preview's clock is the one
  // clock: it already owns play/pause, scrubbing, speed and restarting on a
  // new hover, and the map follows it.
  //
  // The two cards' transports are then two views of that one clock rather
  // than two clocks - Map Evolution's play/pause, scrubber and reset drive
  // the PREVIEW (see previewOwnsTimeline and the listeners below), exactly
  // as its own controls do, so whichever the user reaches for they stay in
  // the same state. With no preview session to share - Inspect shut, or
  // nothing hovered or locked - those same controls drive the map's own
  // timeline instead, which is Map Evolution working on its own.
  //
  // But NOT until asked. Merely hovering the grid builds a preview session
  // and parks it on its first frame, and following that would drag the
  // whole map off the finished field and back to frame 1 just because the
  // cursor crossed the picture - so the map ignores the preview entirely
  // until the user reaches for a transport control (either card's: they are
  // the same clock). That gesture is the only thing that sets this, and
  // going back to the finished field - the card opening or closing, Inspect
  // closing, the preview session ending - is the only thing that clears it,
  // so the map is always either resting at the end or somewhere the user
  // themselves put it.
  var mapLinked = false;
  function linkMapToPreview() { mapLinked = true; }

  // Something new to preview - a different cell under the cursor, a point
  // locked or removed - is not a request to move the map either. It comes
  // unlinked and stays exactly where the user last put it, rather than
  // being dragged back to the new replay's own first frame. (A preview that
  // goes away entirely is different: see releaseMapFollow, which returns
  // the map to the finished field, its resting state.)
  function unlinkMapWhereItIs() {
    if (!mapLinked) return;
    mapLinked = false;
    pauseTimeline(); // stops the follow clock and sharpens the frame it stopped on
    timeline.following = false;
    updateTimelineUI();
  }

  function previewOwnsTimeline() {
    return hasFloatColorBuffer && playbackMenu.isOpen() && inspectMenu.isOpen() && playbackHasSession
      // Already mid-run on its own clock (started here, with nothing
      // hovered at the time): this row goes on controlling THAT rather than
      // silently switching to a preview the user hasn't linked - otherwise
      // Pause would leave the map running.
      && (mapLinked || !timeline.playing);
  }

  // Called with the step the preview is showing and whether its clock is
  // advancing, every time either might have changed (see
  // syncMapToInspection). Cheap to call when neither has.
  function followInspection(step, playing) {
    if (!playbackMenu.isOpen() || !mapLinked || !hasFloatColorBuffer) return;
    step = clamp(step, 0, simulationSteps);
    if (timeline.following && step === timeline.followTarget && playing === timeline.followPlaying) return;
    if (!timeline.following) {
      stopTimelineClock();
      timeline.following = true;
      timeline.seenKey = null;
      timeline.seenAt = 0;
      seedPlaybackBudget();
      statsOnViewChanged();
    }
    var backward = step < timeline.stateStep;
    timeline.followTarget = step;
    timeline.followPlaying = playing;
    if (playing || (!backward && timeline.playing)) {
      // Advancing - or paused just ahead of where the map has got to, which
      // it can still reach from its state and then sharpen (stepPlayback).
      // Behind the state is a rebuild from step 0, and a write already in
      // flight belongs to the old run.
      if (backward) {
        timeline.stateKey = null;
        timeline.pass = null;
      }
      timeline.playing = true;
    } else {
      // Paused somewhere the state can't reach - most often a scrub of the
      // preview's slider, one tick at a time. The ladder renders each step
      // directly, the same as scrubbing the map's own timeline.
      stopTimelineClock();
      if (backward) timeline.stateKey = null;
      timeline.step = step;
      markDirty();
    }
    updateTimelineUI();
  }

  // The preview's step, in the map's terms. playbackStep is 0-indexed over
  // logged rows, and row 0 is the state after one step - the preview's own
  // readout says "step 1" there, and so does the map.
  function syncMapToInspection() {
    if (!playbackHasSession) return;
    followInspection(Math.floor(playbackStep) + 1, playbackPlaying);
  }

  // The finished field - the step the Simulation Duration names - which is
  // what the grid shows whenever Map Evolution is shut, and what it opens
  // on. Panning and zooming are untouched by any of this; only which step
  // every pixel is rendered at.
  function freezeMapAtEnd() {
    stopTimelineClock();
    timeline.following = false;
    // Back at the end is back to "don't move until asked" - see mapLinked.
    mapLinked = false;
    timeline.step = simulationSteps;
    if (timeline.stateStep > timeline.step) timeline.stateKey = null;
    markDirty();
    updateTimelineUI();
  }

  // Back to the map's own timeline, resting at its end - for when the thing
  // being followed goes away (the preview session ends, Inspect closes)
  // rather than the card itself. Guarded, so it never stomps a Map
  // Evolution run the user started on its own.
  function releaseMapFollow() {
    if (!timeline.following) return;
    freezeMapAtEnd();
  }

  function updateTimelineUI() {
    // Sharing Inspect's clock, this row reports and controls THAT clock -
    // so the button reads from playbackPlaying, not from whether the map's
    // own timeline happens to be mid-catch-up. Nothing is disabled for
    // following any more: these controls drive the shared clock rather than
    // being locked out of it.
    var linked = previewOwnsTimeline();
    var playing = linked ? playbackPlaying : timeline.playing;
    setPlayPauseIcon(gridPlayPauseBtn, playing);
    gridPlayPauseBtn.title = !linked && !hasFloatColorBuffer
      ? "Playback needs floating-point render targets, which this browser doesn't provide"
      : playing ? "Pause" : "Play";
    gridPlayPauseBtn.setAttribute("aria-label", playing ? "Pause" : "Play");
    gridPlayPauseBtn.disabled = !linked && !hasFloatColorBuffer;
    gridRestartBtn.disabled = false;
    gridTimelineSlider.disabled = false;
    gridSpeedBtn.disabled = false;
    gridTimelineSlider.max = String(simulationSteps);
    gridTimelineSlider.value = String(renderedSteps());
    var text = "Frame " + renderedSteps().toLocaleString() + " / " + simulationSteps.toLocaleString();
    // Honest about where the MAP has actually got to: following, the value
    // is the step it has rendered, which can trail the preview's by a beat
    // on a slow GPU. No percentage in that case - a follow rebuild reports
    // no fraction (see stepPlayback).
    if (timeline.drawing && timeline.catchingUp) {
      text += timeline.following ? " · catching up"
        : playing ? " · catching up " + Math.floor(timeline.catchUpFraction * 100) + "%" : "";
    }
    gridTimelineReadout.textContent = text;
  }

  makeSpeedControl(gridSpeedBtn, gridSpeedPopup, gridSpeedSlider, gridSpeedValueEl);

  // Each of these three drives the shared clock when there is one - the
  // preview's, the very clock Inspect's own identical row drives - and the
  // map's own timeline otherwise. Same handler either way, so the two cards
  // can never end up in different states: there is only ever one clock
  // being controlled.
  //
  // The step mapping is renderPlaybackFrame's, inverted: the preview's
  // playbackStep is 0-indexed over logged rows and row 0 is the state after
  // one step, so map frame N is preview row N-1 (see syncMapToInspection).
  gridPlayPauseBtn.addEventListener("click", function () {
    if (previewOwnsTimeline()) {
      if (playbackPlaying) {
        // The same grace window Inspect's own button honours - a click
        // landing this soon after playback started on its own meant
        // "start", which already happened.
        if (performance.now() - playbackAutoStartedAt < PLAY_PAUSE_GRACE_MS) return;
        linkMapToPreview();
        pausePlayback();
      } else {
        linkMapToPreview();
        resumePlayback();
      }
      return;
    }
    if (timeline.playing) pauseTimeline(); else playTimeline();
  });
  gridRestartBtn.addEventListener("click", function () {
    if (previewOwnsTimeline()) {
      linkMapToPreview();
      pausePlayback();
      playbackStep = 0;
      renderPlaybackFrame();
      return;
    }
    seekTimeline(0);
  });
  gridTimelineSlider.addEventListener("input", function () {
    var frame = Number(gridTimelineSlider.value);
    if (previewOwnsTimeline()) {
      linkMapToPreview();
      pausePlayback();
      playbackStep = clamp(frame - 1, 0, playbackClockCeiling() - 1);
      renderPlaybackFrame();
      return;
    }
    seekTimeline(frame);
  });

  // resizeCanvas both matches the backing store to the new CSS size and
  // (via markDirty) restarts refinement, which is the whole of what a
  // resize needs now. This used to have a second job - retrying a startup
  // calibration that had bailed out because canvasArea was still
  // display:none when boot() ran - and that job no longer exists, because
  // there is no measurement to get wrong. A hidden canvas simply refines
  // nothing until it has a size.
  new ResizeObserver(resizeCanvas).observe(canvasArea);

  // ResizeObserver only fires on a CSS-size change - dragging the window to
  // a display with a different devicePixelRatio (e.g. laptop screen <->
  // external monitor) changes what "matches the screen" means without
  // resizing anything in CSS pixels, so it needs its own listener. A
  // matchMedia query for an exact dppx value only ever matches the dpr it
  // was created at, so each firing re-subscribes fresh at the new one.
  function watchDevicePixelRatio() {
    var mq = window.matchMedia("(resolution: " + window.devicePixelRatio + "dppx)");
    mq.addEventListener("change", function () {
      resizeCanvas(); // same reason as the ResizeObserver above
      watchDevicePixelRatio();
    }, { once: true });
  }
  watchDevicePixelRatio();

  resizeCanvas();
  updateZoomReadout();
  updateSpeedUI(); // both speed buttons at once - they share one value
  updateTimelineUI();
  showHoverEmpty(); // sets the X: 0, Y: 0 placeholder before the cursor ever touches the grid
  // Inspect is the one menu open on arrival. The other two configure and
  // measure the fractal; this one is how you read it, and landing on a page
  // of nothing but icons would hide the preview that explains what the
  // colors mean. Deliberately here rather than in the markup, so the
  // opening runs through the same path a click does.
  //
  // This covers the FIRST arrival only - boot() runs once and every later
  // visit re-enters through setScene(), which opens it again for itself.
  setInspectOpen(true);
  scheduleColorSpreadCheck(); // the default view (before any pan/zoom) can already qualify

  // Unlike the old loop, this runs work on most frames rather than only
  // after something changed: `dirty` now means "the view moved, start over"
  // and the refinement itself carries on across frames until it reaches the
  // end of the ladder, at which point stepProgressive returns immediately
  // and the loop costs nothing until the next change.
  //
  // Playback, while it is playing, takes the frame instead - except while
  // the view is moving, when it hands the frame back so the ladder can show
  // the current step (see stepPlayback).
  requestAnimationFrame(function frame(now) {
    // Every GL call on a lost context is a silent no-op that hands back
    // null, which the code below was never written to be handed - and there
    // is nothing to draw to in any case. See "Losing the WebGL context".
    if (contextLost) { requestAnimationFrame(frame); return; }
    updatePerfReadout(now);
    // Every frame, working or idle - see noteFrameCadence on why the idle
    // ones are the important ones.
    noteFrameCadence(now);
    pumpPassBuilds();
    pumpPlaybackBuilds();
    prewarmPasses();
    pollBounceMax();
    refreshBuildStatus();
    pumpPendingInspect();
    if (dirty) { resetProgressive(); dirty = false; }
    releasePlaybackIfViewMoved();
    // A gesture's frame moves the picture and does nothing else - see
    // "Gestures first". (It declines while the timeline is playing, which
    // has its own way of giving a moving view the frame - see stepPlayback.)
    if (!presentGestureFrame(now) && !stepPlayback(now)) stepProgressive(now);
    requestAnimationFrame(frame);
  });

  // ---- Re-entering with a different scene ----
  //
  // Everything derived from `scene` gets recomputed, and everything
  // compiled FROM it gets dropped so the lazy builders rebuild against the
  // new one. Deliberately explicit rather than a re-boot: see this file's
  // head for why the module is started once and kept.
  // ---- What the transition needs from the grid ----
  //
  // The explainer drives the grid's zoom directly: it starts the view far
  // INSIDE one pixel and pulls out to the default framing in lockstep with
  // the tiled editor scene fading over it (see transition.js). view.scale
  // is world-units-per-reference-height, so a scale of DEFAULT_SCALE / n
  // shows one default-view pixel filling n of them.
  global.FractalGrid.defaultScale = function () { return DEFAULT_SCALE; };
  global.FractalGrid.setScale = function (scale) {
    view.scale = scale;
    // The readout is driven by the user's own zoom handlers, not by
    // render() - so a programmatic zoom has to say so itself, or the panel
    // reports 1.00x through the whole transition.
    updateZoomReadout();
    markDirty();
  };
  global.FractalGrid.resetView = function () {
    setViewCenter(DEFAULT_CENTER.x, DEFAULT_CENTER.y);
    view.scale = DEFAULT_SCALE;
    updateZoomReadout();
    markDirty();
  };
  // Called when leaving the grid for the editor (see transition.js's own
  // transitionTo) - the hover/Inspect preview's rAF loop and its loop-restart
  // timer keep running otherwise, since nothing about hiding #grid-view stops
  // them on its own. Left running, that meant a bounce/edge sound already
  // looping when the user navigated away just kept firing indefinitely from
  // the now-invisible page. pausePlayback() is exactly the same stop this
  // page's own Pause button performs, just triggered from outside instead of
  // a click. The grid's own timeline gets the same treatment, for the same
  // reason: nothing would stop it simulating a page nobody can see.
  global.FractalGrid.pausePlayback = function () {
    pausePlayback();
    // Leaving the page, so playback's GPU memory goes with it - state and
    // programs both. Coming back rebuilds whatever is needed on the next Play.
    releaseAllPlayback();
    markDirty();
    updateTimelineUI();
  };
  // Forces the pending frame out now rather than on the next rAF tick -
  // the transition needs the grid's picture to be current for the frame it
  // is compositing against, not one behind it.
  //
  // Only ONE step, not a refinement to completion: this is called from
  // inside the intro animation's own per-frame work, where the grid's zoom
  // is being driven continuously, so every frame invalidates the last one's
  // refinement anyway. Blocking here until full resolution would stall the
  // very animation it exists to keep in sync, and to no purpose - the
  // coarse level it does produce is what that frame of the animation is
  // going to be composited against regardless.
  global.FractalGrid.renderNow = function () {
    if (dirty) { resetProgressive(); dirty = false; }
    stepProgressive(performance.now());
  };

  global.FractalGrid.setScene = function (nextScene) {
    // The context went while the editor was on screen (see "Losing the
    // WebGL context"), so there is nothing here to compile the scene with.
    // A reload gets a new one, and an address that says "this scene, on the
    // map" is what makes the reload land where this call was headed.
    if (contextLost) { reloadIntoMap(nextScene); return; }
    // The view is about to be put back to its default framing, which is
    // framed for whatever size the canvas ends up - not pinned to a corner
    // of the size it happens to be before Inspect reopens (see the dock).
    dockSuppressPin = true;
    scene = nextScene;
    // Picture reuse: nothing rendered so far is a picture of this scene.
    sceneGeneration += 1;
    reuse.image = null;
    reuseDropSource();
    adoptSceneDuration();
    // The timeline was the old scene's: stop it, drop everything playback
    // compiled and simulated for that scene, and rest at the new one's end.
    releaseAllPlayback();
    timeline.step = simulationSteps;
    updateTimelineUI();
    isBouncesOutput = scene.output.property === "bounces";
    isInfinitePositionOutput = scene.edgeMode === "infinite" &&
      (scene.output.property === "x" || scene.output.property === "y");
    // Alongside the two flags above, and for the same reason: a re-sent
    // scene can map Output to a different property (or change Edge
    // Handling), and whether that property WRAPS decides the hover panel's
    // hue range, the superlatives' neighbour distance, and every circular
    // statistic on the Global Stats card. Left at the first scene's value
    // these three disagree with the shader the grid is actually running.
    isCircularOutput = computeIsCircularOutput();
    hueRangeMaxValue = isCircularOutput ? 360 : 300;
    relabelSuperlativeExtremeButtons();
    sceneCoordinateSpan = computeSceneCoordinateSpan();
    // Compiled against the OLD scene - dropped, not reused, including any
    // build still in flight. requestPass rebuilds each lazily on next use.
    discardAllPasses();
    releaseAllSliceStates();
    // Its key names a view, not a scene, so the same view of a different
    // scene would otherwise read as already measured.
    bounceMaxProbe.measuredKey = null;
    bounceMaxProbe.key = null;
    clearInspected();
    // Keyframes are views of the old scene's map, and a still half-rendered
    // for someone is a picture of it.
    movie.keyframes = [];
    stillJob = null;
    updateMovieUI();
    setViewCenter(DEFAULT_CENTER.x, DEFAULT_CENTER.y);
    view.scale = DEFAULT_SCALE;
    // Display mode and Color Zoom are this page's own view of the field,
    // not part of the scene - carrying them over from whatever the last
    // scene was left on would show the new scene through a lens picked for
    // the old one. Same reset Reset View performs by hand, just automatic
    // on every re-entry.
    colorZoomEnabled = false;
    colorZoomCheckbox.checked = false;
    setDisplayMode(DISPLAY_MODES[0]);
    // And Inspect open, for the same reason boot() opens it on the first
    // visit (see its comment there). Needed separately here because the
    // menus are an accordion: a user who left the grid with Display or
    // Analysis open left Inspect SHUT, and without this they would come
    // back to a column of icons and no preview - the state boot() went out
    // of its way to avoid, on every arrival but the first.
    setInspectOpen(true);
    canvas.hidden = false;
    emptyState.hidden = true;
    setStatus(true, "Ready");
    // Measured against the old scene, in the old scene's units - dropped
    // rather than dimmed, unlike an ordinary view change (see markStale).
    if (statsPanel) { statsHasResult = false; statsResultIsCurrent = false; statsPanel.clearResult(); }
    resizeCanvas();
    markDirty();
    // Clears dockSuppressPin once the dock has settled, whether or not the
    // setInspectOpen above changed anything it had to react to.
    scheduleDockLayout(false);
  };

  // ---- Movies ----
  //
  // A movie is a list of KEYFRAMES - a view of the map, and the Map
  // Evolution frame it was showing - that a camera then travels between
  // (movie-path.js is the travelling). The Movie card only collects them;
  // Done hands the list, in a link, to chaosplayback.html, which renders
  // every frame and plays the result. That page has no renderer of its own:
  // it loads this app in a frame and asks it for one finished picture after
  // another through renderStill, below - so a movie is drawn by exactly the
  // code that draws the map, at whatever precision each of its views needs.

  var MOVIE_QUALITIES = MoviePath.QUALITIES;
  // keyframes: [{ center: { x, xLo, y, yLo }, scale, step, seconds }] -
  // movie-path.js's own shape, seconds null until the user types one.
  var movie = { keyframes: [], quality: MOVIE_QUALITIES.length - 1, loop: true };

  var movieMenu = makeMenu("menu-movie", "grid-btn-movie", "movie");
  var movieHint = document.getElementById("movie-hint");
  var btnMovieAddKeyframe = document.getElementById("movie-add-keyframe");
  var movieKeyframeList = document.getElementById("movie-keyframe-list");
  var movieQualitySlider = document.getElementById("movie-quality-slider");
  var movieQualityReadout = document.getElementById("movie-quality-readout");
  var movieLoopCheckbox = document.getElementById("movie-loop-checkbox");
  var movieSummary = document.getElementById("movie-summary");
  var btnMovieDone = document.getElementById("movie-done");

  function currentKeyframe(seconds) {
    return {
      center: { x: view.center.x, xLo: view.center.xLo, y: view.center.y, yLo: view.center.yLo },
      scale: view.scale,
      step: timeline.step,
      seconds: seconds === undefined ? null : seconds,
    };
  }

  function goToKeyframe(k) {
    // A frame short of the last is only ever on screen with Map Evolution
    // open (closing it is what puts the map back to the end), so showing one
    // opens it - and takes the map off the Inspect preview's clock, which
    // would otherwise carry it straight off again.
    if (k.step < simulationSteps) playbackMenu.set(true);
    unlinkMapWhereItIs();
    view.center.x = k.center.x; view.center.xLo = k.center.xLo;
    view.center.y = k.center.y; view.center.yLo = k.center.yLo;
    view.scale = k.scale;
    seekTimeline(Math.min(k.step, simulationSteps));
    updateZoomReadout();
    markDirty();
  }

  function movieButton(glyph, title, onClick) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = "icon-button";
    button.textContent = glyph;
    button.title = title;
    button.setAttribute("aria-label", title);
    button.addEventListener("click", onClick);
    return button;
  }

  // A zoom as typed: "1.4e+25", "1.4e25", "1.4\u00d710^25", "10^25", "1,400",
  // with or without the readout's trailing "\u00d7". Positive, or null.
  function parseZoomText(text) {
    var s = String(text).trim().toLowerCase().replace(/[\s,]/g, "").replace(/[\u00d7x*]$/, "");
    s = s.replace(/[\u00d7x*]10\^/, "e").replace(/^10\^/, "1e");
    var zoom = Number(s);
    return zoom > 0 && isFinite(zoom) ? zoom : null;
  }

  // One number in a keyframe's row, with a caption, a pair of arrows and,
  // once it is clicked into, a place to type. The arrows are what says the
  // number can be changed at all. `field` is:
  //   show()       the text at rest
  //   edit()       the text to type over, when focused (defaults to show())
  //   parse(text)  what was typed as a value, or undefined to leave it be
  //   step(dir)    the value one arrow press up (+1) or down (-1) from here
  //   apply(value) commits, and the row is rebuilt after
  function movieField(caption, label, field) {
    var wrap = document.createElement("label");
    wrap.className = "movie-field";
    if (field.title) wrap.title = field.title;
    var input = document.createElement("input");
    input.type = "text";
    input.inputMode = "decimal";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.value = field.show();
    if (field.placeholder) input.placeholder = field.placeholder;
    input.setAttribute("aria-label", label);
    var editing = false;
    function commit(value) {
      if (value === undefined) { updateMovieUI(); return; }
      field.apply(value);
      updateMovieUI();
    }
    input.addEventListener("focus", function () {
      if (!editing) {
        editing = true;
        input.value = field.edit ? field.edit() : field.show();
      }
      input.select();
    });
    input.addEventListener("blur", function () { if (editing) commit(field.parse(input.value)); });
    input.addEventListener("keydown", function (event) {
      if (event.key === "Enter") { event.preventDefault(); input.blur(); }
      else if (event.key === "Escape") { event.preventDefault(); editing = false; updateMovieUI(); }
      else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        editing = false;
        commit(field.step(event.key === "ArrowUp" ? 1 : -1));
      }
    });
    var arrows = document.createElement("span");
    arrows.className = "movie-field-arrows";
    [["\u25b2", "up", 1], ["\u25bc", "down", -1]].forEach(function (a) {
      var button = document.createElement("button");
      button.type = "button";
      button.tabIndex = -1;
      button.textContent = a[0];
      button.title = label + " " + a[1] + (field.stepHint ? " " + field.stepHint : "");
      button.setAttribute("aria-label", button.title);
      // mousedown, not click: a click would first blur the input, whose own
      // commit rebuilds the row from under the button.
      button.addEventListener("mousedown", function (event) { event.preventDefault(); });
      button.addEventListener("click", function () { editing = false; commit(field.step(a[2])); });
      arrows.appendChild(button);
    });
    var cap = document.createElement("span");
    cap.className = "movie-field-caption";
    cap.textContent = caption;
    wrap.appendChild(cap);
    wrap.appendChild(input);
    wrap.appendChild(arrows);
    return wrap;
  }

  // Rebuilt whole on every change: a movie has a handful of keyframes, and
  // each row's text depends on its neighbours (the time a move takes is a
  // property of BOTH its ends).
  function updateMovieUI() {
    movieKeyframeList.textContent = "";
    var moves = MoviePath.moves(movie.keyframes, movie.loop);
    movie.keyframes.forEach(function (k, i) {
      var row = document.createElement("li");
      row.className = "movie-keyframe";

      var what = document.createElement("div");
      what.className = "movie-keyframe-what";
      var index = document.createElement("b");
      index.textContent = String(i + 1);
      what.appendChild(index);

      // Zoom: typed in any notation, shown to two figures while it is being
      // typed, and stepped a power of ten at a time. Changing it here moves
      // the keyframe, not the map.
      what.appendChild(movieField("zoom", "Zoom of keyframe " + (i + 1), {
        title: "The zoom at this keyframe. Type any notation - 1.4e+25, 1.4\u00d710^25 - or step it a power of ten with the arrows.",
        stepHint: "a power of ten",
        show: function () { return formatZoom(DEFAULT_SCALE / k.scale); },
        edit: function () { return (DEFAULT_SCALE / k.scale).toExponential(1); },
        parse: function (text) { var z = parseZoomText(text); return z === null ? undefined : z; },
        step: function (dir) { return DEFAULT_SCALE / k.scale * (dir > 0 ? 10 : 0.1); },
        apply: function (zoom) { k.scale = clamp(DEFAULT_SCALE / zoom, MIN_SCALE, MAX_SCALE); },
      }));

      // Frame: the simulation frame the map is drawn at here.
      what.appendChild(movieField("frame", "Frame of keyframe " + (i + 1), {
        title: "The simulation frame the map shows at this keyframe.",
        stepHint: "a frame",
        show: function () { return Math.min(k.step, simulationSteps).toLocaleString(); },
        edit: function () { return String(Math.min(k.step, simulationSteps)); },
        parse: function (text) {
          var n = Number(String(text).replace(/[\s,]/g, ""));
          return isFinite(n) ? Math.round(n) : undefined;
        },
        step: function (dir) { return Math.min(k.step, simulationSteps) + dir; },
        apply: function (step) { k.step = clamp(step, 0, simulationSteps); },
      }));

      // The move that ARRIVES here. The first keyframe has one only in a
      // movie that returns to it. Left empty, the time is worked out - and
      // the arrows step from THAT, not from nothing.
      var arriving = i > 0 ? moves[i - 1] : (movie.loop && movie.keyframes.length > 1 ? moves[moves.length - 1] : null);
      if (arriving) {
        what.appendChild(movieField("s", "Seconds to reach keyframe " + (i + 1), {
          title: "How long the move arriving at this keyframe takes. Left empty, it is worked out from how far the camera and the simulation have to go.",
          stepHint: "a tenth of a second",
          placeholder: String(arriving.seconds),
          show: function () { return k.seconds ? String(k.seconds) : ""; },
          parse: function (text) {
            if (String(text).trim() === "") return null;
            var v = Number(text);
            return v > 0 ? v : undefined;
          },
          step: function (dir) { return (k.seconds || arriving.seconds) + dir * 0.1; },
          apply: function (seconds) { k.seconds = seconds === null ? null : clamp(Math.round(seconds * 10) / 10, 0.1, 60); },
        }));
      }
      row.appendChild(what);

      var actions = document.createElement("div");
      actions.className = "movie-keyframe-actions";
      actions.appendChild(movieButton("⌖", "Go to this keyframe", function () { goToKeyframe(k); }));
      actions.appendChild(movieButton("⟳", "Replace with the current view and frame", function () {
        movie.keyframes[i] = currentKeyframe(k.seconds);
        updateMovieUI();
      }));
      var earlier = movieButton("▲", "Move earlier", function () {
        movie.keyframes.splice(i - 1, 0, movie.keyframes.splice(i, 1)[0]);
        updateMovieUI();
      });
      earlier.disabled = i === 0;
      var later = movieButton("▼", "Move later", function () {
        movie.keyframes.splice(i + 1, 0, movie.keyframes.splice(i, 1)[0]);
        updateMovieUI();
      });
      later.disabled = i === movie.keyframes.length - 1;
      actions.appendChild(earlier);
      actions.appendChild(later);
      actions.appendChild(movieButton("✕", "Delete this keyframe", function () {
        movie.keyframes.splice(i, 1);
        updateMovieUI();
      }));
      row.appendChild(actions);
      movieKeyframeList.appendChild(row);
    });

    movieHint.hidden = movie.keyframes.length > 0;
    movieQualitySlider.value = String(movie.quality);
    movieQualityReadout.textContent = MOVIE_QUALITIES[movie.quality].label;
    movieLoopCheckbox.checked = movie.loop;
    var seconds = MoviePath.totalSeconds(movie.keyframes, movie.loop);
    movieSummary.textContent = movie.keyframes.length < 2
      ? (movie.keyframes.length ? "Add at least one more keyframe." : "")
      : movie.keyframes.length + " keyframes  \u00b7  " + seconds.toFixed(1) + " s  \u00b7  " +
        Math.round(seconds * MoviePath.FPS).toLocaleString() + " frames to render";
    btnMovieDone.disabled = movie.keyframes.length < 2;
  }

  btnMovieAddKeyframe.addEventListener("click", function () {
    movie.keyframes.push(currentKeyframe());
    updateMovieUI();
  });
  movieQualitySlider.addEventListener("input", function () {
    movie.quality = clamp(Number(movieQualitySlider.value), 0, MOVIE_QUALITIES.length - 1);
    movieQualityReadout.textContent = MOVIE_QUALITIES[movie.quality].label;
  });
  movieLoopCheckbox.addEventListener("change", function () {
    movie.loop = movieLoopCheckbox.checked;
    updateMovieUI();
  });
  btnMovieDone.addEventListener("click", function () {
    if (movie.keyframes.length < 2) return;
    var shared = global.FractalGrid.shareState();
    var link = "chaosplayback.html#" + ShareUrl.encode({
      page: ShareUrl.PAGE_MOVIE,
      scene: PhysicsCoords.toAuthoredJSON(shared.scene),
      // A movie has no view of its own - its keyframes are its views.
      view: { display: shared.view.display, precision: shared.view.precision, movie: shared.view.movie },
    });
    // The address this page leaves behind has to say what is in the card,
    // or Back from the player would return to a map with no keyframes.
    if (global.AppShell && global.AppShell.syncAddress) global.AppShell.syncAddress();
    global.location.href = link;
  });
  updateMovieUI();

  // ---- One finished picture, on request ----
  //
  // What the movie player asks of this page, once per frame of the movie:
  // show THIS view at THIS simulation frame, render it all the way, and say
  // when it is on the canvas. `onDone` is called in the same task as the
  // draw that finished it, which is the one moment the canvas can be copied
  // from (it has no preserved drawing buffer - by the next task the browser
  // may have cleared it).
  //
  // A picture is only ever handed over at the precision its view calls for.
  // One that finishes while that is still being built was drawn by the
  // float32 stand-in, and is kept back: the build landing restarts the
  // render (see pumpPlaybackBuilds), and the run after that is the one
  // delivered. A rung that failed or is too slow here is not coming, so that
  // is not waited for.
  var stillJob = null;
  function deliverStill() {
    if (!stillJob) return;
    var wanted = pickPrecision();
    if (effectivePrecision() !== wanted && precisionPending(wanted)) return;
    var job = stillJob;
    stillJob = null;
    job.onDone(canvas);
  }
  // spec: { center: { x, xLo, y, yLo }, scale, step, antialias }
  global.FractalGrid.renderStill = function (spec, onDone) {
    stillJob = { antialias: spec.antialias !== false, onDone: onDone };
    stopTimelineClock();
    unlinkMapWhereItIs();
    view.center.x = spec.center.x; view.center.xLo = spec.center.xLo || 0;
    view.center.y = spec.center.y; view.center.yLo = spec.center.yLo || 0;
    view.scale = clamp(spec.scale, MIN_SCALE, MAX_SCALE);
    timeline.step = clamp(Math.round(spec.step), 0, simulationSteps);
    // Playback state is only ever advanced, never rewound, and is for a
    // view that has just been left in any case.
    timeline.stateKey = null;
    updateZoomReadout();
    updateTimelineUI();
    markDirty();
  };

  // ---- The address bar ----
  //
  // A link to the map carries this page's view of it as well as the scene
  // (see share-url.js for the format; transition.js decides when the address
  // is read and written, and asks here for what it should say).

  // Inspections a link asked for that haven't been rebuilt yet, as
  // { type, a, b, count | size + twoPart } with a/b WORLD points - turned
  // into those the moment the link's view was applied, so panning away
  // before they are built doesn't move them.
  var pendingInspect = null;
  var pendingInspectFrames = 0;

  function describeInspectGroup(group) {
    if (group.type === "point") return { type: "point", a: group.points[0].worldPoint };
    if (group.type === "line") return { type: "line", a: group.startWorld, b: group.endWorld, count: group.sampleCount };
    return { type: "grid", a: group.startWorld, b: group.endWorld, size: group.gridSize, twoPart: group.twoPart };
  }

  // One group a frame, and none until the map has had a couple of frames to
  // put something on screen: every inspected point is a shader compiled and
  // run on the spot, so a link with a full grid in it is seconds of work -
  // which should come after the picture, the way it did for whoever made it.
  //
  // And not until the precision this view calls for is built. A trajectory
  // is computed at whatever the grid is drawing with (see
  // computeTrajectoryEntry), which on arrival is the float32 stand-in: a
  // deep-zoom link's points would all be traced at a precision that cannot
  // tell them apart. A rung that failed or is too slow here isn't coming, so
  // that is not waited for.
  function pumpPendingInspect() {
    if (!pendingInspect) return;
    if (++pendingInspectFrames < 3) return;
    var wanted = pickPrecision();
    if (effectivePrecision() !== wanted && precisionPending(wanted)) return;
    var next = pendingInspect.shift();
    if (!pendingInspect.length) pendingInspect = null;
    if (next.type === "point") lockPointAt(next.a);
    else if (next.type === "line") lockLineOfPoints(next.a, next.b, next.count);
    else lockGridOfPoints(next.a, next.b, next.size, next.twoPart);
  }

  // Everything a link to this map has to say: the scene as this page runs
  // it (its own Simulation Duration, which is the one on screen), and the
  // view. Inspection points go out as view-heights from the centre - see
  // share-url.js on why - including any still waiting to be rebuilt, so a
  // link copied in those first seconds doesn't quietly lose them.
  global.FractalGrid.shareState = function () {
    var shared = {};
    Object.keys(scene).forEach(function (k) { shared[k] = scene[k]; });
    shared.simulationSteps = simulationSteps;
    var inspect = inspectedGroups.map(describeInspectGroup).concat(pendingInspect || []).map(function (group) {
      var out = { type: group.type, a: worldPointToUV(group.a), count: group.count, size: group.size, twoPart: group.twoPart };
      if (group.b) out.b = worldPointToUV(group.b);
      return out;
    });
    return {
      scene: shared,
      view: {
        center: { x: view.center.x, xLo: view.center.xLo, y: view.center.y, yLo: view.center.yLo },
        scale: view.scale,
        zoom: DEFAULT_SCALE / view.scale,
        display: colorZoomEnabled ? "colorzoom" : displayMode.value,
        precision: precisionMode,
        speed: playbackSpeed,
        volume: PhysicsSound.getVolume(),
        inspect: inspect,
        movie: {
          keyframes: movie.keyframes.map(function (k) {
            return { center: k.center, scale: k.scale, zoom: DEFAULT_SCALE / k.scale, step: k.step, seconds: k.seconds };
          }),
          quality: movie.quality,
          loop: movie.loop,
        },
      },
    };
  };

  // The way back in, for a view ShareUrl.decode produced - so every field is
  // present and already a number or a known word. Called right after the
  // link's scene has been started (or set), which is what put everything
  // here back to its defaults first.
  global.FractalGrid.applyShareView = function (shared) {
    // A link's view is its centre and its zoom, and has to arrive as both -
    // see setScene on why that means no corner pinning.
    dockSuppressPin = true;
    scheduleDockLayout(false);
    view.center.x = shared.center.x; view.center.xLo = shared.center.xLo;
    view.center.y = shared.center.y; view.center.yLo = shared.center.yLo;
    view.scale = clamp(DEFAULT_SCALE / shared.zoom, MIN_SCALE, MAX_SCALE);

    colorZoomEnabled = shared.display === "colorzoom";
    colorZoomCheckbox.checked = colorZoomEnabled;
    setDisplayMode(colorZoomEnabled ? DISPLAY_MODES[0] : displayModeByValue(shared.display));

    // A rung this browser can't build (see PRECISION_LADDER) becomes Auto:
    // the best it does have, where the view needs it.
    precisionMode = (shared.precision === "auto" || PRECISION_LADDER.indexOf(shared.precision) !== -1) ? shared.precision : "auto";
    // Unless the last visit ended in repeated context losses, which the
    // multi-float programs - many times the size and the memory of the
    // float32 one - are the likeliest cause of. See "Losing the WebGL context".
    if (contextLossForcesFloat32()) precisionMode = "f32";
    if (precisionSelect) precisionSelect.value = precisionMode;

    setPlaybackSpeed(shared.speed);
    PhysicsSound.setVolume(shared.volume);

    clearInspected();
    var groups = shared.inspect.map(function (group) {
      return {
        type: group.type,
        a: worldPointAtUV(group.a[0], group.a[1]),
        b: group.b ? worldPointAtUV(group.b[0], group.b[1]) : null,
        count: clamp(group.count || 0, 2, INSPECT_LINE_SAMPLE_MAX),
        size: clamp(group.size || 0, Number(inspectGridSizeSlider.min) || 1, Number(inspectGridSizeSlider.max) || 8),
        twoPart: !!group.twoPart,
      };
    });
    pendingInspect = groups.length ? groups : null;
    pendingInspectFrames = 0;

    movie.keyframes = shared.movie.keyframes.map(function (k) {
      return {
        center: k.center,
        scale: clamp(DEFAULT_SCALE / k.zoom, MIN_SCALE, MAX_SCALE),
        step: clamp(k.step, 0, simulationSteps),
        seconds: k.seconds,
      };
    });
    movie.quality = clamp(shared.movie.quality, 0, MOVIE_QUALITIES.length - 1);
    movie.loop = shared.movie.loop;
    updateMovieUI();

    updateZoomReadout();
    markDirty();
  };

  // ---- Performance settings: the controls ----
  //
  // The values and what the two presets are live at the top of boot (see
  // "Performance settings: the values"). This is the Settings card's side of
  // it: one control per value, and the three-stop slider above them.
  //
  // The slider is an OUTPUT as much as an input. Low and High each set every
  // control beneath them; Custom cannot be chosen, and is simply where the
  // slider goes whenever those controls match neither preset. Which means it
  // is never stored: it is worked
  // out from the controls every time one of them changes (perfPresetNow), so
  // there is no second copy of the truth to fall out of step, and setting
  // everything back by hand to what Low means IS Low.
  var perfPresetSlider = document.getElementById("perf-preset-slider");
  var perfPresetLabels = Array.prototype.slice.call(document.querySelectorAll(".perf-preset-labels [data-preset]"));
  var antialiasCheckbox = document.getElementById("antialias-checkbox");
  var perfDprSelect = document.getElementById("perf-dpr-select");
  var perfDprReadout = document.getElementById("perf-dpr-readout");
  var perfFrameSelect = document.getElementById("perf-frame-select");
  var perfDrawSelect = document.getElementById("perf-draw-select");
  var perfPlaybackMemorySelect = document.getElementById("perf-playback-memory-select");
  var perfGestureCheckbox = document.getElementById("perf-gesture-checkbox");
  var perfReadoutCheckbox = document.getElementById("perf-readout-checkbox");
  var perfReadoutEl = document.getElementById("perf-readout");
  var PERF_PRESET_STOPS = { low: 0, custom: 1, high: 2 };
  var PERF_PRESET_NAMES = { low: "Low Performance Devices", custom: "Custom", high: "High Performance Devices" };
  // Where the right-hand resolution handle sits for an endStride of 2. Not
  // 100 * (levels - 1) / levels worked out on the spot: the ladder's length
  // changes with the canvas (the dock opening is enough), and 90 rounds to
  // "one level short of the end" for every ladder from 6 levels to 14.
  var RESOLUTION_SLIDER_FOR_STRIDE = { 1: "100", 2: "90" };

  // Everything a preset decides, as it stands right now.
  function perfValuesNow() {
    return {
      startAtCoarsest: Number(resolutionMinSlider.value) === 0,
      endStride: sliderValueToStride(Number(resolutionMaxSlider.value)),
      antialias: perf.antialias,
      reuse: reuseEnabled,
      maxDpr: perf.maxDpr,
      frameMs: perf.frameMs,
      drawMs: perf.drawMs,
      playbackMB: perf.playbackMB,
      gestureFirst: perf.gestureFirst,
    };
  }
  function perfPresetNow() {
    var now = perfValuesNow();
    var names = ["low", "high"];
    for (var i = 0; i < names.length; i++) {
      var p = PERF_PRESETS[names[i]];
      if (now.startAtCoarsest && now.endStride === p.endStride &&
          now.antialias === p.antialias && now.reuse === p.reuse && now.maxDpr === p.maxDpr &&
          now.frameMs === p.frameMs && now.playbackMB === p.playbackMB && now.gestureFirst === p.gestureFirst &&
          // A control this GPU doesn't get to use (see drawLengthLocked) can't
          // be what keeps the slider off a preset.
          (drawLengthLocked || now.drawMs === p.drawMs)) return names[i];
    }
    return "custom";
  }

  // Puts every control where the values are, and the slider where they add
  // up to. Safe to call from anywhere, any number of times.
  function syncPerfPresetUI() {
    if (!perfPresetSlider) return; // called from a run that began before the card was wired
    antialiasCheckbox.checked = perf.antialias;
    perfDprSelect.value = String(perf.maxDpr);
    perfFrameSelect.value = String(perf.frameMs);
    perfDrawSelect.value = String(drawLengthLocked ? SLICE_TARGET_BASE_MS : perf.drawMs);
    perfPlaybackMemorySelect.value = String(perf.playbackMB);
    perfGestureCheckbox.checked = perf.gestureFirst;
    var devDpr = window.devicePixelRatio || 1, dpr = gridDpr();
    perfDprReadout.textContent = (Math.round(dpr * 100) / 100) + "×" + (dpr < devDpr ? " of " + (Math.round(devDpr * 100) / 100) + "×" : "");
    var preset = perfPresetNow();
    perfPresetSlider.value = String(PERF_PRESET_STOPS[preset]);
    perfPresetSlider.setAttribute("aria-valuetext", PERF_PRESET_NAMES[preset]);
    perfPresetLabels.forEach(function (el) { el.classList.toggle("is-current", el.getAttribute("data-preset") === preset); });
  }

  // What changing each value has to set in motion. Every one of them changes
  // what the next frame should draw, so all end in markDirty; the rest is
  // whatever was measured or allocated under the old value.
  function setPerfMaxDpr(v) {
    if (v === perf.maxDpr) return;
    perf.maxDpr = v;
    resizeCanvas(); // a different backing store, if this display is past the cap
    markDirty();
  }
  function setPerfFrameMs(v) {
    if (v === perf.frameMs) return;
    perf.frameMs = v;
    // Budgets are in work per frame, and a frame has just changed length.
    // They would find their way (an overrun is believed at once, and fitting
    // grows 10% a frame) but there is no reason to make them.
    ladderBudgets = {};
    ladderBudget = budgetFor(effectivePrecision(), wantedVariant());
    markDirty();
  }
  function setPerfDrawMs(v) {
    if (v === perf.drawMs) return;
    perf.drawMs = v;
    // Steps per draw were calibrated against the old length, and whether
    // float32 needs slicing at all is decided against it too (per-step
    // timings, f32StepMs, are the GPU's and stay).
    sliceSteps = {};
    sliceCalibrated = {};
    sliceTooHeavy = {};
    progressive.tile = null;
    progressive.tileX = 0;
    ladderBudgets = {};
    ladderBudget = budgetFor(effectivePrecision(), wantedVariant());
    updatePrecisionReadout();
    markDirty();
  }
  function setPerfPlaybackMB(v) {
    if (v === perf.playbackMB) return;
    perf.playbackMB = v;
    // The lattice is chosen to fit the budget when the state is built (see
    // playbackStride); dropping the state is what makes the next Play choose
    // again.
    releasePlaybackTextures();
    markDirty();
  }
  function setPerfAntialias(on) {
    on = !!on;
    if (on === perf.antialias) return;
    perf.antialias = on;
    markDirty();
  }

  function applyPerfValues(p) {
    resolutionMinSlider.value = "0";
    resolutionMaxSlider.value = RESOLUTION_SLIDER_FOR_STRIDE[p.endStride] || "100";
    setPerfAntialias(p.antialias);
    setReuseEnabled(p.reuse);
    setPerfMaxDpr(p.maxDpr);
    setPerfFrameMs(p.frameMs);
    setPerfDrawMs(p.drawMs);
    setPerfPlaybackMB(p.playbackMB);
    perf.gestureFirst = !!p.gestureFirst; // read fresh every frame; nothing to set in motion
    markDirty();
    // After the restart, so its "at ..." half describes the run that is
    // starting rather than the one just abandoned.
    updateResolutionBoundsUI();
    syncPerfPresetUI();
  }
  function applyPerfPreset(name) {
    if (!PERF_PRESETS[name] || perfPresetNow() === name) { syncPerfPresetUI(); return; }
    applyPerfValues(PERF_PRESETS[name]);
  }

  // The slider. Dragging THROUGH the middle is fine - it is between the two
  // ends - but it is not somewhere to stop: released there, the slider goes
  // back to wherever the controls below actually put it.
  perfPresetSlider.addEventListener("input", function () {
    var stop = Number(perfPresetSlider.value);
    if (stop === PERF_PRESET_STOPS.low) applyPerfPreset("low");
    else if (stop === PERF_PRESET_STOPS.high) applyPerfPreset("high");
  });
  perfPresetSlider.addEventListener("change", syncPerfPresetUI);
  // From the keyboard the middle would be a wall: one arrow press from an
  // end lands on it, and it bounces back. So the arrows step over it.
  perfPresetSlider.addEventListener("keydown", function (e) {
    var toward = { ArrowLeft: "low", ArrowDown: "low", Home: "low", ArrowRight: "high", ArrowUp: "high", End: "high" }[e.key];
    if (!toward) return;
    e.preventDefault();
    applyPerfPreset(toward);
  });
  // The labels are the stops' names, and the two that can be chosen can be
  // chosen by pressing them - an easier target than the end of a slider.
  perfPresetLabels.forEach(function (el) {
    var name = el.getAttribute("data-preset");
    if (name === "custom") return;
    el.addEventListener("click", function () { applyPerfPreset(name); });
  });

  antialiasCheckbox.addEventListener("change", function () { setPerfAntialias(antialiasCheckbox.checked); syncPerfPresetUI(); });
  perfDprSelect.addEventListener("change", function () { setPerfMaxDpr(Number(perfDprSelect.value)); syncPerfPresetUI(); });
  perfFrameSelect.addEventListener("change", function () { setPerfFrameMs(Number(perfFrameSelect.value)); syncPerfPresetUI(); });
  perfDrawSelect.addEventListener("change", function () { setPerfDrawMs(Number(perfDrawSelect.value)); syncPerfPresetUI(); });
  perfPlaybackMemorySelect.addEventListener("change", function () { setPerfPlaybackMB(Number(perfPlaybackMemorySelect.value)); syncPerfPresetUI(); });
  perfGestureCheckbox.addEventListener("change", function () { perf.gestureFirst = perfGestureCheckbox.checked; syncPerfPresetUI(); });
  // Held at its first stop on an Apple GPU (see sliceTargetMs), so there it
  // is shown for what it is rather than offered as a choice.
  if (drawLengthLocked) perfDrawSelect.disabled = true;

  // The one setting `perf` could not take from its control at the top of
  // boot: picture reuse, whose machinery did not exist yet. (The resolution
  // handles are read where they stand.) Before the first frame, so nothing
  // is drawn twice.
  setReuseEnabled(reusePictureCheckbox.checked);
  updateResolutionBoundsUI();
  syncPerfPresetUI();

  // ---- The performance readout ----
  //
  // Settings > Performance Settings > Nerd Performance Stats: what the
  // renderer is doing, as a few lines of text over the map. It exists to be
  // screenshotted from a device nobody can attach a debugger to - so it
  // favours the numbers that say WHY a render is slow over the ones that say
  // that it is: which path is drawing (one draw per band, or slices), how
  // much a frame is allowed and how long frames actually take, whether the
  // budget is sitting on its floor, and what building and calibrating cost
  // before the first pixel.
  //
  // Not a performance setting, and not part of either preset. Everything it
  // shows is gathered whether or not it is showing (see perfStats).
  var PERF_READOUT_INTERVAL_MS = 250;
  var perfReadoutShown = perfReadoutCheckbox.checked; // off, unless switched on from the builder page
  var perfReadoutAt = 0;
  var perfFrame = { lastAt: 0, ms: 0 };

  function beginPerfRun() {
    perfStats.run = {
      startedAt: performance.now(), steps: renderedSteps(), spent: 0,
      firstPictureAt: 0, levels: [], lastStride: 0, aa: [], aaSeen: 0, doneAt: 0,
    };
    perfStats.workFrameMaxMs = 0;
    perfStats.busyWaits = 0;
  }
  // Once per work frame, after the work: how far the run has got.
  function notePerfRunProgress() {
    var run = perfStats.run;
    if (!run || run.doneAt) return;
    var t = performance.now() - run.startedAt;
    run.spent += ladderBudget.lastSpent || 0;
    if (progressive.accumStride > 0) {
      if (!run.firstPictureAt) run.firstPictureAt = t;
      if (progressive.accumStride !== run.lastStride) {
        run.lastStride = progressive.accumStride;
        run.levels.push({ stride: progressive.accumStride, t: t });
      }
    }
    if (progressive.aaSample > run.aaSeen) {
      run.aaSeen = progressive.aaSample;
      // aaSample n means sample n is being averaged in, i.e. n - 1 are done
      // (the ladder's own picture counting as the first).
      if (progressive.aaSample > 1) run.aa.push({ n: progressive.aaSample - 1, t: t });
    }
    if (progressive.complete) run.doneAt = t;
  }

  function perfSeconds(ms) { return ms >= 9950 ? Math.round(ms / 1000) + "s" : (ms / 1000).toFixed(ms < 995 ? 2 : 1) + "s"; }
  function perfCount(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(2) + "G";
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M";
    if (n >= 1e4) return Math.round(n / 1e3) + "k";
    return String(Math.round(n));
  }
  function perfReadoutText(now) {
    var precision = effectivePrecision();
    // Read off what has already been measured - NOT f32NeedsSlicing(), which
    // measures (a blocking build and a GPU round trip) when it hasn't been.
    // A readout that changes what it reads out is not one.
    var stepMs = f32StepMs[wantedVariant()];
    var sliced = precision !== "f32" || (stepMs !== undefined && stepMs * simulationSteps > f32SingleDrawLimitMs());
    var lines = [];
    var gpu = gpuRendererName.replace(/^ANGLE \((.*)\)$/, "$1");
    if (gpu.length > 44) gpu = gpu.slice(0, 43) + "…";
    lines.push("gpu    " + (gpu || "?"));
    lines.push("       timer " + (gpuTimer.ext ? "yes" : "no") + " · attach " + MAX_STATE_ATTACHMENTS +
      " · parallel-compile " + (parallelCompileExt ? "yes" : "no"));
    var devDpr = window.devicePixelRatio || 1;
    lines.push("view   " + canvas.width + "×" + canvas.height + " @" + (Math.round(gridDpr() * 100) / 100) +
      " (display " + (Math.round(devDpr * 100) / 100) + ") · " + renderedSteps() + " steps · " + precision);

    var path = sliced ? "sliced" : "single draw";
    if (sliced) {
      var perDraw = sliceSteps[precision], tile = progressive.tile;
      path += perDraw ? " · " + (tile ? tile.perDraw + "/" : "") + perDraw + " steps/draw" +
        (sliceCalibrated[precision] && sliceCalibrated[precision] !== perDraw ? " (was " + sliceCalibrated[precision] + ")" : "") : " · calibrating";
      if (tile) path += " · tile " + tile.spec.cols + "×" + tile.spec.rows;
      var slicedEntry = playbackGpu.programs[precision];
      if (!slicedEntry || slicedEntry.status === "building") path += " · programs building";
      else if (slicedEntry.status !== "ready") path += " · programs " + slicedEntry.status;
    }
    lines.push("path   " + path);
    lines.push("       draw ≤" + sliceTargetMs() + "ms" + (drawLengthLocked ? " (fixed)" : "") +
      (stepMs !== undefined ? " · f32 step " + stepMs.toFixed(4) + "ms → run " + (stepMs * simulationSteps).toFixed(1) + "ms" : "") +
      (perfStats.sliceStepMs > 0 && sliced ? " · slice step " + perfStats.sliceStepMs.toFixed(4) + "ms" : ""));

    lines.push("frame  " + (perfStats.workFrameMs > 0 ? perfStats.workFrameMs.toFixed(1) + "ms work (max " + Math.round(perfStats.workFrameMaxMs) + ")" : "idle") +
      " · page " + perfFrame.ms.toFixed(1) + "ms · display " + displayPeriodMs.toFixed(1) + "ms" +
      (perfStats.gpuMs > 0 ? " · gpu " + perfStats.gpuMs.toFixed(1) + "ms" : ""));
    var b = ladderBudget;
    lines.push("budget " + perfCount(b.budget) + " px/frame" + (b.budget <= b.min * 1.5 ? " (AT FLOOR " + b.min + ")" : "") +
      " · target " + Math.round(frameTargetMs(now)) + "ms · " + perfStats.drawsLastFrame + " draws/frame");
    lines.push("input  " + (now - perfStats.presentOnlyAt < 400 ? "GESTURE - moving the picture, rendering nothing" :
      perf.gestureFirst ? (reuseEnabled ? "gestures first" : "gestures first (needs Reuse Last Picture)") : "renders through gestures") +
      (perf.frameMs > 0 ? " · gpu waits " + perfStats.busyWaits : "") +
      (reuse.run ? (reuse.run.exact ? " · reusing " + Math.round(reuse.run.coverage * 100) + "%" : " · preview only") : ""));

    var run = perfStats.run;
    if (run) {
      var elapsed = run.doneAt || (performance.now() - run.startedAt);
      var parts = [];
      if (run.firstPictureAt) parts.push("first " + perfSeconds(run.firstPictureAt));
      run.levels.slice(-4).forEach(function (l) { parts.push(describeStride(l.stride).replace(" sim/px", "/px") + " " + perfSeconds(l.t)); });
      run.aa.forEach(function (a) { parts.push("aa" + a.n + " " + perfSeconds(a.t)); });
      lines.push("run    " + (parts.join(" · ") || "starting") + (run.doneAt ? " · DONE " + perfSeconds(run.doneAt) : " · " + perfSeconds(elapsed) + "…"));
      lines.push("rate   " + (elapsed > 50 ? perfCount(run.spent * Math.max(run.steps, 1) / (elapsed / 1000)) + " px·steps/s" : "…") +
        " · stop at " + describeStride(endStride()) + (antialiasWanted() && endStride() <= 1 ? " + aa" : "") + (reuseEnabled ? " · reuse" : ""));
    }
    lines.push("build  " + perfStats.builds + " programs " + Math.round(perfStats.buildMs) + "ms (last " + Math.round(perfStats.lastBuildMs) + ")" +
      " · calibrate " + Math.round(perfStats.calibrationMs) + "ms");
    return lines.join("\n");
  }
  // Called every animation frame; does nothing at all unless it is showing,
  // and then rebuilds its text four times a second.
  function updatePerfReadout(now) {
    if (perfFrame.lastAt > 0) {
      var dt = now - perfFrame.lastAt;
      if (dt > 0 && dt < 1000) perfFrame.ms = perfFrame.ms > 0 ? perfFrame.ms * 0.9 + dt * 0.1 : dt;
    }
    perfFrame.lastAt = now;
    if (!perfReadoutShown || now - perfReadoutAt < PERF_READOUT_INTERVAL_MS) return;
    perfReadoutAt = now;
    try {
      perfReadoutEl.textContent = perfReadoutText(now);
    } catch (err) {
      // A readout must never be what stops the render loop it is reporting on.
      perfReadoutEl.textContent = "readout: " + (err && err.message || err);
    }
  }
  function setPerfReadoutShown(on) {
    perfReadoutShown = !!on;
    perfReadoutCheckbox.checked = perfReadoutShown;
    perfReadoutEl.hidden = !perfReadoutShown;
    perfReadoutAt = 0;
  }
  perfReadoutCheckbox.addEventListener("change", function () { setPerfReadoutShown(perfReadoutCheckbox.checked); });
  setPerfReadoutShown(perfReadoutShown);

  // ---- The dock: where the menus live in the small-window layout ----
  //
  // On a phone there is no room for cards floating over the map - one open
  // card IS the screen. So in the small-window layout (LayoutMode.isMobile -
  // decided by the window's size alone, which makes this just as reachable
  // in a narrow desktop window) the map gets an area of its own, and the
  // menus move into a dock along the bottom edge: every menu's button into a
  // tab bar, every open card into a sheet above it. On its side, the dock
  // runs down the right edge instead.
  //
  // MOVED, not rebuilt: the button and the card are lifted out of their
  // .menu-item and put back again when the layout is left. makeMenu holds
  // all three by reference and every listener is on the elements themselves,
  // so nothing about a menu knows or cares which layout it is in.
  //
  // One card at a time, whichever side of the desktop layout it came from
  // (see makeMenu): a lit tab is the card that is open, pressing it again
  // puts the card away, and with none open the sheet is gone and the map has
  // everything but the tab bar. That does cost the phone the one pairing the
  // desktop's two columns exist for - Inspect beside Map Evolution, the map
  // playing in step with the preview - which was tried here as a sheet
  // showing every open card, and lost: the second card sat below a fold
  // nobody scrolled to, and a tab bar with two tabs lit read as broken.
  //
  // Every menu but one. There is no Movie tab: a movie is hundreds of
  // finished pictures rendered back to back, which is not something to start
  // on a phone, and five tabs is what a phone's width holds comfortably. Its
  // button and card stay where chaos.html put them, in the right-hand column
  // - which this layout hides (see #grid-right-menu-column in mobile.css) -
  // so the card is simply not reachable here, and is shut on the way in if
  // it was open. Nothing about a movie is lost by that: the keyframes are
  // state, not markup, and are all still there when the window is wide again
  // (and in the link, either way).
  var gridViewEl = document.getElementById("grid-view");
  var dockSheetEl = document.getElementById("grid-dock-sheet");
  var dockTabsEl = document.getElementById("grid-dock-tabs");
  // Tab order, left to right (top to bottom, on its side).
  var dockMenus = [inspectMenu, statsMenu, displayMenu, playbackMenu, settingsMenu];
  var dockActive = false;
  // Upright, the dock as a whole gets at most this share of the view: "the
  // bottom half of the screen", tab bar included.
  var DOCK_MAX_SHARE = 0.5;
  // True from a programmatic reset of the view (a new scene, a link) until
  // the dock next settles: the resize that follows is then an ordinary one,
  // which re-frames about the centre instead of pinning a corner.
  var dockSuppressPin = false;
  var dockLayoutQueued = false, dockLayoutWantsPin = false;

  // The sheet's height is set ONCE per change of which cards are open - to
  // what they need, up to the cap - and then left alone, scrolling whatever
  // outgrows it. Every change of its height is a change of the map's, and
  // every one of those restarts the render from its coarsest level: worth it
  // for a menu opened on purpose, not for a list that grew by one row.
  function layoutDock(pin) {
    if (!dockActive) return;
    var anyOpen = dockMenus.some(function (menu) { return menu.isOpen(); });
    gridViewEl.classList.toggle("dock-sheet-open", anyOpen);
    if (!anyOpen || global.LayoutMode.orientation() !== "portrait") {
      // On its side the sheet is a fixed-width column (see mobile.css).
      dockSheetEl.style.height = "";
    } else {
      dockSheetEl.style.height = "auto";
      var cap = Math.max(140, Math.round(gridViewEl.clientHeight * DOCK_MAX_SHARE) - dockTabsEl.offsetHeight);
      dockSheetEl.style.height = Math.min(dockSheetEl.scrollHeight, cap) + "px";
    }
    // Now, rather than whenever the ResizeObserver gets to it: the frame in
    // between would show the old picture stretched to the new shape.
    pinViewCornerOnResize = !!pin;
    resizeCanvas();
    pinViewCornerOnResize = false;
    // Analysis lays its charts out to the card's width, which has just
    // changed if the card has just changed homes.
    if (statsPanel && statsOpen) statsPanel.relayout();
    repositionActiveTip();
  }
  // Coalesced to the end of the current task. Opening one menu can shut
  // another in the same call (they are accordions), and a new scene opens
  // Inspect half-way through resetting the view: measured in the middle of
  // either, the sheet is a size it will not be by the time anything paints.
  function scheduleDockLayout(pin) {
    dockLayoutWantsPin = dockLayoutWantsPin || !!pin;
    if (dockLayoutQueued) return;
    dockLayoutQueued = true;
    Promise.resolve().then(function () {
      var wantsPin = dockLayoutWantsPin && !dockSuppressPin;
      dockLayoutQueued = false;
      dockLayoutWantsPin = false;
      dockSuppressPin = false;
      layoutDock(wantsPin);
    });
  }

  function setDockActive(active) {
    if (active === dockActive) { scheduleDockLayout(false); return; }
    dockActive = active;
    gridViewEl.classList.toggle("dock-active", active);
    // Not coming along (see above) - and an open card left behind in a hidden
    // column would be open with no way to shut it.
    if (active && movieMenu.isOpen()) movieMenu.set(false);
    // One card at a time in here (see makeMenu): coming in with one open on
    // each side, the left-hand one - Inspect, usually - is the one kept.
    if (active) {
      var keep = null;
      dockMenus.forEach(function (menu) {
        if (!menu.isOpen()) return;
        if (keep) menu.set(false); else keep = menu;
      });
    }
    dockMenus.forEach(function (menu) {
      menu.docked = active;
      if (active) {
        dockTabsEl.appendChild(menu.toggle);
        dockSheetEl.appendChild(menu.card);
      } else {
        // Back where chaos.html put them: the button first, then its card.
        menu.item.insertBefore(menu.toggle, menu.item.firstChild);
        menu.item.appendChild(menu.card);
      }
    });
    if (!active) {
      gridViewEl.classList.remove("dock-sheet-open");
      dockSheetEl.style.height = "";
      // The floating gauge goes back to sharing a corner, and an accordion,
      // with the left column - which may have a card open that it must not
      // be open beside.
      if (renderProgressMenu.isOpen() && (inspectMenu.isOpen() || statsMenu.isOpen() || displayMenu.isOpen())) {
        renderProgressMenu.set(false);
      }
    }
    // An ordinary resize, not a pinned one: the whole window changed shape.
    scheduleDockLayout(false);
  }

  onDockedMenuChange = function (menu) {
    if (!dockActive || !menu.docked) return;
    if (menu.isOpen()) {
      // From its top, however far down the last card had been scrolled.
      dockSheetEl.insertBefore(menu.card, dockSheetEl.firstChild);
      dockSheetEl.scrollTop = 0;
    }
    scheduleDockLayout(true);
  };

  // The cap is a share of the view, so it moves when the view does: the
  // phone turned, the window dragged, the address bar sliding away. Also what
  // sizes the sheet for the first time when the grid is started while still
  // hidden behind the transition (a hidden view measures as zero).
  new ResizeObserver(function () { if (dockActive) scheduleDockLayout(false); }).observe(gridViewEl);

  if (global.LayoutMode) {
    global.LayoutMode.onChange(function (mode) { setDockActive(mode.isMobile()); });
    dockSuppressPin = true; // the default framing - see setScene
    setDockActive(global.LayoutMode.isMobile());
  }

  // ---- Losing the WebGL context ----
  //
  // A browser may take a page's WebGL context away at any moment, and on a
  // phone it routinely does: the tab sent to the background, the GPU's
  // memory wanted elsewhere, the graphics driver restarting. Every texture,
  // buffer and program made on that context is gone. Rebuilding them in
  // place would mean auditing every GL object this file ever keeps - across
  // the ladder, reuse, antialiasing, playback, the slice states and the
  // sampler - for whether it re-makes itself on demand, and then trusting
  // that audit on devices nobody here can test. The address bar already
  // holds the whole state of the page instead (see "The address bar"): so
  // recovery is to make sure it is current and load it again.
  //
  // Not instantly, though, and not blindly:
  //  - A hidden page waits until it is looked at again. There is nothing to
  //    recover FOR until then, and a reload in the background can simply lose
  //    its new context the same way.
  //  - A visible one gives the browser a moment to hand the context back
  //    first ("webglcontextrestored"). Straight after a driver reset, asking
  //    for a new one can fail.
  //  - While the EDITOR is what is on screen nothing reloads at all - the
  //    user is part-way through something that has nothing to do with this
  //    page. The next scene sent over finds the context gone and reloads into
  //    the map then (see setScene, and reloadIntoMap).
  //  - And a page that keeps losing its context stops reloading itself and
  //    says so, rather than looping. Whatever it comes back as comes back at
  //    float32: see contextLossForcesFloat32.
  var contextLost = false;
  var contextLostEl = document.getElementById("grid-context-lost");
  var contextLostText = document.getElementById("grid-context-lost-text");
  var contextLostReloadBtn = document.getElementById("grid-context-lost-reload");
  var CONTEXT_LOSS_KEY = "fractalGridContextLoss";
  // Losses closer together than this are the same trouble, not a new one.
  var CONTEXT_LOSS_WINDOW_MS = 90 * 1000;
  var CONTEXT_LOSS_MAX_AUTO_RELOADS = 2;
  var CONTEXT_RESTORE_GRACE_MS = 2000;

  function readContextLossRecord() {
    try {
      var rec = JSON.parse(global.sessionStorage.getItem(CONTEXT_LOSS_KEY));
      if (rec && typeof rec.t === "number" && typeof rec.n === "number") return rec;
    } catch (err) {
      // Unreadable or unreachable storage: no history, which is the safe read.
    }
    return { t: 0, n: 0 };
  }
  function noteContextLoss() {
    var rec = readContextLossRecord();
    var now = Date.now();
    rec = { t: now, n: now - rec.t < CONTEXT_LOSS_WINDOW_MS ? rec.n + 1 : 1 };
    try { global.sessionStorage.setItem(CONTEXT_LOSS_KEY, JSON.stringify(rec)); } catch (err) { /* see above */ }
    return rec;
  }
  // True on a visit that follows back-to-back context losses. One loss is
  // weather - a backgrounded tab - and the view comes back exactly as it was,
  // precision included. Two in a row says something this page is doing is
  // what the device cannot hold, and the multi-float programs are the
  // likeliest something by a wide margin.
  function contextLossForcesFloat32() {
    var rec = readContextLossRecord();
    return rec.n >= 2 && Date.now() - rec.t < CONTEXT_LOSS_WINDOW_MS;
  }

  function reloadToCurrentAddress() {
    if (global.AppShell && global.AppShell.syncAddress) global.AppShell.syncAddress();
    global.location.reload();
  }
  function reloadIntoMap(sceneForMap) {
    try {
      var fragment = global.ShareUrl.encode({
        page: global.ShareUrl.PAGE_MAP,
        scene: global.PhysicsCoords.toAuthoredJSON(sceneForMap),
      });
      global.history.replaceState(null, "", "#" + fragment);
    } catch (err) {
      // Reloads where it is, then: the editor, with the scene it auto-saved.
    }
    global.location.reload();
  }

  var contextRecoveryTimer = null;
  function scheduleContextRecovery() {
    if (!contextLost || contextRecoveryTimer) return;
    if (document.hidden) return; // visibilitychange calls back in
    if (global.AppShell && global.AppShell.currentView() !== "grid") return; // see above: the editor is left alone
    contextRecoveryTimer = setTimeout(reloadToCurrentAddress, CONTEXT_RESTORE_GRACE_MS);
  }

  canvas.addEventListener("webglcontextlost", function (e) {
    // Without this the browser never offers the context back at all.
    e.preventDefault();
    contextLost = true;
    var rec = noteContextLoss();
    contextLostEl.hidden = false;
    if (rec.n > CONTEXT_LOSS_MAX_AUTO_RELOADS) {
      contextLostText.textContent = "The browser keeps resetting this page\u2019s graphics, which usually means the device is out of graphics memory. Closing other tabs or apps may help.";
      return; // the button is the only way on from here
    }
    scheduleContextRecovery();
  });
  canvas.addEventListener("webglcontextrestored", function () {
    if (!contextLost) return;
    if (readContextLossRecord().n > CONTEXT_LOSS_MAX_AUTO_RELOADS) return;
    if (document.hidden || (global.AppShell && global.AppShell.currentView() !== "grid")) return;
    if (contextRecoveryTimer) clearTimeout(contextRecoveryTimer);
    reloadToCurrentAddress();
  });
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && readContextLossRecord().n <= CONTEXT_LOSS_MAX_AUTO_RELOADS) scheduleContextRecovery();
  });
  contextLostReloadBtn.addEventListener("click", reloadToCurrentAddress);

  }
})(window);
