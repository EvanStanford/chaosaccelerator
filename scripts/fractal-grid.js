// CPAL-1.0 License. See chaosaccelerator.com/license.html

// The fractal map: every pixel runs the handed-over scene from its own offset
// starting state in WebGL2 and is colored by the Output value at the end of
// the run. Compiled once per scene; each render redoes the full run per pixel.
(function (global) {
  "use strict";

  // Everything runs on demand: nothing touches WebGL until FractalGrid.start(scene).
  // Started once and kept alive; a later scene goes through setScene().
  var started = false;
  global.FractalGrid = {
    start: function (scene) {
      if (started) { global.FractalGrid.setScene(scene); return; }
      started = true;
      boot(scene);
    },
    isStarted: function () { return started; },
    setScene: function () {},
    shareState: function () { return null; },
    applyShareView: function () {},
    renderStill: function () {},
  };

  // One Settings body (#shared-settings-body) is MOVED between the builder's panel
  // and the map's card (placeSettings). Until the map starts, the controls hold the state.
  var PERF_PRESETS = {
    low: { endStride: 2, antialias: false, reuse: true, maxDpr: 2, frameMs: 50, drawMs: 20, playbackMB: 96, gestureFirst: true },
    high: { endStride: 1, antialias: true, reuse: true, maxDpr: 0, frameMs: 0, drawMs: 5, playbackMB: 256, gestureFirst: false },
  };
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
      el.resReadout.textContent = el.resMax.value === "100" ? "down to 1 sim/px" : el.resMax.value === "90" ? "down to 2px" : "set";
    }

    // Pre-map half: stands down once the map starts.
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
    // Reset all: state lives in localStorage, not cookies; wipe it, then hard reload.
    el.resetAll.addEventListener("click", function () {
      if (!global.confirm("Reset all saved data for this page? This clears your saved scene, dismissed tips, and intro animation state, then reloads.")) return;
      try { localStorage.clear(); } catch (err) { /* nothing to clear */ }
      try {
        document.cookie.split(";").forEach(function (pair) {
          var name = pair.split("=")[0].trim();
          if (name) document.cookie = name + "=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/";
        });
      } catch (err) { /* same */ }
      // Clear the address first or the reload loads the scene straight back.
      try { global.history.replaceState(null, "", global.location.pathname + global.location.search); } catch (err) { /* reloads where it is */ }
      global.location.reload();
    });

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
  // World span across the reference height on load; the readout calls this 1.00x.
  var DEFAULT_SCALE = 200 / 0.17;
  // The readout's 1e26x: deliberately past the four-word precision's ~1e24x limit.
  var MIN_SCALE = DEFAULT_SCALE / 1e26;
  var MAX_SCALE = 1e6;

  // Settings > Simulation Duration. A uniform: ES 3.00 allows a dynamic loop bound, no recompile.
  var DEFAULT_SIMULATION_STEPS = 500;
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
  var renderProgressGlyphs = Array.prototype.slice.call(document.querySelectorAll(".render-progress-glyph"));
  var renderProgressPrecisionGlyph = document.querySelector(".render-progress-precision-glyph");
  var renderProgressPrecisionText = document.getElementById("render-progress-precision-text");
  var colorZoomCheckbox = document.getElementById("color-zoom-checkbox");
  var colorZoomField = document.getElementById("color-zoom-field");
  var lowSaturationCheckbox = document.getElementById("low-saturation-checkbox");
  var lowSaturationField = document.getElementById("low-saturation-field");
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

  // Paths, not glyphs: U+23F8 has an emoji form on some phones.
  var PLAY_ICON_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M8 5.14v13.72a.6.6 0 0 0 .92.5l10.55-6.86a.6.6 0 0 0 0-1L8.92 4.64a.6.6 0 0 0-.92.5z"></path></svg>';
  var PAUSE_ICON_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"></rect><rect x="14" y="5" width="4" height="14" rx="1"></rect></svg>';
  function setPlayPauseIcon(button, playing) {
    var want = playing ? "pause" : "play";
    if (button.getAttribute("data-icon") === want) return;
    button.setAttribute("data-icon", want);
    button.innerHTML = playing ? PAUSE_ICON_SVG : PLAY_ICON_SVG;
  }

  // ---- Performance settings: the values ----
  // Settings > Performance Settings; a three-stop slider sets them all. The device
  // only picks the STARTING preset. endStride: where refinement stops (1 = a sim per
  // pixel). maxDpr 0: no cap. frameMs 0: one refresh. gestureFirst: move the old
  // picture during a drag instead of redrawing. Read from the controls.
  var perf = sharedSettings.readPerf();

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

  // Canvas pixels per CSS pixel, capped by perf.maxDpr; not window.devicePixelRatio.
  function gridDpr() {
    var dpr = window.devicePixelRatio || 1;
    return perf.maxDpr > 0 ? Math.min(dpr, perf.maxDpr) : dpr;
  }

  // ---- Reusable tip popover ----
  // showTip(id, anchorEl, text); id is the "don't tell me again" localStorage key.
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
    }
  }

  var activeTipAnchor = null;
  var activeTipNoArrowAbove = false;
  var activeTipOnOk = null;

  function hideTip() {
    tipPopover.hidden = true;
    activeTipId = null;
    activeTipAnchor = null;
    activeTipOnOk = null;
  }

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
    var above = rect.bottom + 10 + height > window.innerHeight - 12 && rect.top - 10 - height >= 12;
    tipPopover.classList.toggle("tip-above", above);
    tipPopover.classList.toggle("tip-no-arrow", above && activeTipNoArrowAbove);
    tipPopover.style.top = clamp(above ? rect.top - 10 - height : rect.bottom + 10, 12, Math.max(12, window.innerHeight - height - 12)) + "px";
    tipPopover.style.left = left + "px";
    var ARROW_SIZE = 10, CORNER_INSET = 10;
    var arrowLeft = rect.left + rect.width / 2 - left - ARROW_SIZE / 2;
    tipPopover.style.setProperty("--tip-arrow-left",
      clamp(arrowLeft, CORNER_INSET, Math.max(CORNER_INSET, width - CORNER_INSET - ARROW_SIZE)) + "px");
  }

  // False if this id was dismissed for good or is already showing. opts.onOk replaces OK and must hideTip.
  function showTip(id, anchorEl, text, opts) {
    if (isTipDismissed(id) || activeTipId === id) return false;
    if (!bringTipAnchorIntoView(anchorEl)) return false;
    activeTipId = id;
    activeTipAnchor = anchorEl;
    activeTipOnOk = (opts && opts.onOk) || null;
    activeTipNoArrowAbove = !!(opts && opts.noArrowAbove);
    tipPopoverOk.textContent = (opts && opts.okLabel) || "OK";
    tipPopoverText.textContent = text;
    tipPopover.hidden = false;
    positionTip(anchorEl);
    return true;
  }

  function bringTipAnchorIntoView(anchorEl) {
    if (!anchorEl) return false;
    var rect = anchorEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (!tipAnchorVisible(anchorEl) && anchorEl.scrollIntoView) {
      anchorEl.scrollIntoView({ block: "nearest" });
    }
    return tipAnchorVisible(anchorEl);
  }

  function repositionActiveTip() {
    if (activeTipAnchor) positionTip(activeTipAnchor);
  }
  window.addEventListener("resize", repositionActiveTip);

  tipPopoverOk.addEventListener("click", function () {
    var onOk = activeTipOnOk;
    if (onOk) onOk();
    else hideTip();
  });
  tipPopoverDismiss.addEventListener("click", function () {
    if (activeTipId) dismissTipForever(activeTipId);
    hideTip();
  });

  // ---- The menus ----
  // One accordion per side; "movie" is a group of one so the Movie card stays open beside Map Evolution.
  var menuGroups = { left: [], right: [], movie: [] };
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
          if (other.docked !== api.docked) return;
          other.set(false);
        });
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
      menuColumn.classList.toggle("has-open-menu",
        !!document.querySelector("#grid-menu-stack .menu-item.is-open"));
      if (onDockedMenuChange) onDockedMenuChange(api);
      repositionActiveTip();
      if (onChange) onChange(open);
    }
    toggle.addEventListener("click", function () { set(!open); });
    header.addEventListener("click", function () { set(false); });
    var api = {
      isOpen: function () { return open; },
      set: set,
      anchor: function () { return open ? card : toggle; },
      item: item,
      toggle: toggle,
      card: card,
      docked: false,
    };
    group.push(api);
    return api;
  }

  var settingsMenu = makeMenu("menu-settings", "grid-btn-settings", "right");

  // Collapsing Inspect stops the preview outright (it has sound) and disarms
  // Line/Grid, but keeps inspectedGroups so reopening restores them.
  var inspectMenu = makeMenu("menu-inspect", "grid-btn-inspect", "left",
    function (open) {
      if (open) {
        if (inspectedGroups.length > 0) beginInspectOnlySession();
        else showHoverEmpty();
      } else {
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

  var displayMenu = makeMenu("menu-display", "grid-btn-display", "left");

  // OPEN, the map follows the Inspect preview's step (followInspection); shut, it is frozen at the end.
  var playbackMenu = makeMenu("menu-playback", "grid-btn-playback", "right",
    function (open) {
      if (open) {
        pauseTimeline();
        mapLinked = false;
      } else {
        freezeMapAtEnd();
      }
    });

  var renderProgressMenu = makeMenu("menu-render-progress", "grid-btn-render-progress", "left");
  // The Output property's exact range: a non-anchored body's x/y is wrapped into
  // [0, frame) by the engine; angle uses mod(angle, TAU), the current facing.
  var TAU = Math.PI * 2;
  function outputRangeMax(sceneForRange, property) {
    if (property === "x") return sceneForRange.frameWidth;
    if (property === "y") return sceneForRange.frameHeight;
    if (property === "distance") return PhysicsEngine.outputDistanceMax(sceneForRange);
    // Lifespan can equal its max, so it clamps rather than mod()s.
    if (property === "lifespan") return simulationSteps;
    return TAU;
  }

  function showEmptyState(message) {
    canvas.hidden = true;
    emptyState.hidden = false;
    if (message) emptyState.querySelector("p").textContent = message;
  }

  var raw = bootScene ? JSON.stringify(bootScene) : null;
  var scene = null;
  if (raw) {
    try {
      scene = JSON.parse(raw);
      if (!scene || typeof scene !== "object") throw new Error("not an object");
      if (!Array.isArray(scene.bodies) || !Array.isArray(scene.hinges)) throw new Error("missing bodies/hinges");
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

  function adoptSceneDuration() {
    simulationSteps = scene.simulationSteps;
    syncStepsUI();
  }
  adoptSceneDuration();

  // ---- Shader assembly: view -> world (X, Y) -> offset + cascade -> step loop -> Output -> color ----

  // precision: "f32" or "df" (same physics end to end, see physics-df.js and
  // pickPrecision). variant: "standard" or "derived", see compileScenePieces' end.
  function buildFragmentShader(sceneToCompile, precision, variant) {
    var pieces = compileScenePieces(sceneToCompile, precision);
    return variant === "derived" ? pieces.derivedSource : pieces.gridSource;
  }

  function compileScenePieces(sceneToCompile, precision) {
    // "df" means any multi-float precision (two, three or four words).
    var df = PhysicsDF.isExtended(precision);
    var B = PhysicsGridCodegen.backendFor(precision);
    var initial = PhysicsGridCodegen.generateGridInitialStateGLSL(sceneToCompile, precision);
    var outProp = sceneToCompile.output.property; // "x" | "y" | "angle" | "distance" | "lifespan" | "bounces"
    var isLifespan = outProp === "lifespan";
    var isDistance = outProp === "distance";
    var outputBodies = PhysicsEngine.outputBodyIndices(sceneToCompile.output);
    var isBounces = outProp === "bounces";
    var isRunTally = isLifespan || isBounces;
    var isInfinitePosition = sceneToCompile.edgeMode === "infinite" && (outProp === "x" || outProp === "y" || isDistance);
    var rangeMax = outputRangeMax(sceneToCompile, outProp);
    // Circular outputs use the full 360; capped ranges stop at 300 so the ends differ.
    var isCircularOutput = outProp === "angle" || ((outProp === "x" || outProp === "y") && sceneToCompile.edgeMode === "wrap");
    var hueRangeMax = isCircularOutput ? 360 : 300;
    // Read bodyN (the loop mutates it) at the pass's precision: folding in float32
    // first wastes the df budget. Lineage average when the scene has a splitter.
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
      // Twin of shortestSeparation, at the pass's precision: derived modes difference it.
      outputLines = [];
      emitBodyValue("outAx", outputBodies[0], "x").forEach(function (l) { outputLines.push(l); });
      emitBodyValue("outAy", outputBodies[0], "y").forEach(function (l) { outputLines.push(l); });
      emitBodyValue("outBx", outputBodies[1], "x").forEach(function (l) { outputLines.push(l); });
      emitBodyValue("outBy", outputBodies[1], "y").forEach(function (l) { outputLines.push(l); });
      outputLines.push("  " + B.scalar + " outDx = " + B.sub("outBx", "outAx") + ";");
      outputLines.push("  " + B.scalar + " outDy = " + B.sub("outBy", "outAy") + ";");
      if (PhysicsEngine.wrapsAtEdges(sceneToCompile)) {
        // floor(x + 0.5), not round(): GLSL rounds ties to even, JS upward.
        var fw = PhysicsGPU.fnum(sceneToCompile.frameWidth), fh = PhysicsGPU.fnum(sceneToCompile.frameHeight);
        outputLines.push("  outDx = " + B.sub("outDx", B.mul(B.lit(sceneToCompile.frameWidth), B.fromFloat("floor(" + B.toFloat("outDx") + " / " + fw + " + 0.5)"))) + ";");
        outputLines.push("  outDy = " + B.sub("outDy", B.mul(B.lit(sceneToCompile.frameHeight), B.fromFloat("floor(" + B.toFloat("outDy") + " / " + fh + " + 0.5)"))) + ";");
      }
      outputLines.push("  outputValue = " + (df ? "dv2Length(dv2(outDx, outDy))" : "length(vec2(outDx, outDy))") + ";");
    } else if (outputBodies.length === 2) {
      outputLines = [];
      emitBodyValue("outA", outputBodies[0], outProp).forEach(function (l) { outputLines.push(l); });
      emitBodyValue("outB", outputBodies[1], outProp).forEach(function (l) { outputLines.push(l); });
      outputLines.push("  outputValue = " + B.mul(B.add("outA", "outB"), B.lit(0.5)) + ";");
    } else {
      outputLines = emitBodyValue("outOne", outputBodies[0], outProp);
      outputLines.push("  outputValue = outOne;");
    }
    var frame = PhysicsEngine.wrapsAtEdges(sceneToCompile)
      ? { width: sceneToCompile.frameWidth, height: sceneToCompile.frameHeight } : undefined;
    var stepOnceSource = PhysicsGPU.generateStepOnceGLSL(initial.n, initial.consts, initial.pairs, initial.hingeAnchors, frame, precision, sceneToCompile.mutualGravity, PhysicsEngine.collisionsEnabled(sceneToCompile), initial.spawnBase, initial.springs);
    var stepOnceCall = "stepOnce(" + PhysicsGPU.stepOnceCallArgs(initial.n, initial.hingeAnchors, precision, initial.spawnBase, initial.springs) + ");";

    // "Stop on wrap": each pixel freezes the first step ANY watched body would cross
    // a frame edge. The discrete step index alone puts a spurious jump wherever
    // starting conditions cross a step boundary, so the exact sub-step instant is
    // solved (as in collideCircleCircle's CCD) and every property extrapolated to one
    // step BEFORE it; lifespan takes the instant itself.
    var watchedIndices = PhysicsHingeGeometry.wrapWatchedBodyIndices(sceneToCompile);
    var outputIndices = isRunTally ? [] : outputBodies;
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
    // ---- The step loop, shared by the grid program and playback's step pass ----
    // loop.bound: steps THIS draw runs; stepIndex: step number from the start of
    // the whole run; budget: lifespan of a pixel that never stops.
    var isStickyLoop = sceneToCompile.edgeMode === "sticky" && frame && watchedIndices.length > 0;
    function stepLoop(loop) {
      var declarations = [];
      var lines = [];
      if (isStickyLoop) {
        var halfW = PhysicsGPU.fnum(frame.width / 2), halfH = PhysicsGPU.fnum(frame.height / 2);
        var fullW = PhysicsGPU.fnum(frame.width), fullH = PhysicsGPU.fnum(frame.height);
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
        declarations.push("  float lifespanValue = " + loop.budget + ";");
        bounceInitLines.forEach(function (l) { declarations.push(l); });
        lines.push("  for (int i = 0; i < " + loop.bound + "; i++) {");
        lines.push("    if (wrapStopped) break;");
        lines.push("    " + stepOnceCall);
        bounceStepLines.forEach(function (l) { lines.push(l); });
        // DT+1.0: above any real tFrac. tFracHi carries the pass's precision; bestTFrac is its float32 shadow.
        lines.push("    float bestTFrac = DT + 1.0;");
        lines.push("    " + B.scalar + " bestTFracHi = " + B.zero + ";");
        watchedIndices.forEach(function (idx) {
          lines.push("    {");
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
          lines.push("        if (tFrac < bestTFrac) { bestTFrac = tFrac; bestTFracHi = tFracHi; }");
          lines.push("      }");
          lines.push("    }");
        });
        lines.push("    if (bestTFrac <= DT) {");
        lines.push("      " + B.scalar + " tTarget = " + B.sub("bestTFracHi", df ? "DF_DT" : "DT") + ";");
        lines.push("      lifespanValue = " + loop.stepIndex + " + bestTFrac / DT;");
        outputIndices.forEach(function (out) {
          function extrapolate(axis) {
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

    // Loop state that outlives a draw (see playbackStateVariables). Only what cannot
    // be re-derived: each float costs bandwidth and, past 32 outputs, extra draws.
    // frozen*, unread prevFrozen* (found as "body.field" text) and hasPrevFrozen are re-derived.
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
    // A derivative of the field from a stencil of neighbouring starting points, in
    // WORLD space: differencing 8-bit ramped color would show false edges at hue breakpoints.
    var OB = isRunTally ? PhysicsGridCodegen.backendFor("f32") : B;
    var outScalar = OB.scalar;
    var outZero = OB.zero;
    var deltaDenom = isBounces ? "max(u_bounceMax, 1.0)"
      : isLifespan ? "float(u_durationSteps)"
        : "OUTPUT_RANGE_MAX";
    // Contours needs the gradient of t ITSELF: under the sigmoid that is deltaT
    // times k * t * (1 - t), or the saturated tails paint whole regions solid.
    var contourSlopeGain = isInfinitePosition
      ? " * (" + PhysicsGPU.fnum(PhysicsEngine.OUTPUT_SIGMOID_STEEPNESS) + " * t * (1.0 - t))"
      : "";

    // ---- Raw Output value -> the t the color ramp reads ----
    var tLine =
    // mod() at the pass's precision (folding in float32 first merges neighbouring
    // pixels); lifespan and distance clamp. Bounce Count is scaled by the busiest
    // pixel in view and NOT clamped: readback uses u_bounceMax = 1 for the raw count.
    isBounces
      ? "  float t = u_bounceMax > 0.0 ? outputValue / u_bounceMax : 0.0;"
      : isLifespan
        ? "  float t = clamp(outputValue / float(u_durationSteps), 0.0, 1.0);"
        : isInfinitePosition
          ? "  float t = frameSigmoid(" + B.toFloat(B.div("outputValue", B.fromFloat("OUTPUT_RANGE_MAX"))) + ");"
          : isDistance
            ? "  float t = clamp(" + B.toFloat(B.div("outputValue", B.fromFloat("OUTPUT_RANGE_MAX"))) + ", 0.0, 1.0);"
            : "  float t = " + B.toFloat(B.div(B.mod("outputValue", "OUTPUT_RANGE_MAX"), B.fromFloat("OUTPUT_RANGE_MAX"))) + ";";

    var physicsDeclarationLines = [
      initial.declarationLines.map(function (l) { return "  " + l; }).join("\n"),
      "  " + PhysicsGridCodegen.generateCanonicalBodyDeclarationsGLSL(initial).split("\n").join("\n  "),
      "  " + PhysicsGPU.generateHingeAnchorLocalsGLSL(initial.hingeAnchors, precision).split("\n").join("\n  "),
    ];

    var worldCoordLines = [
      "  vec2 fullCoord = (gl_FragCoord.xy - 0.5) * u_gridStride + u_gridOrigin + 0.5;",
      "  vec2 uv = (fullCoord - 0.5 * u_resolution) / u_resolution.y;",
      // uv * u_scale stays float32 (~1e-4 px of error); the ADD onto the center is df.
      df ? "  MF worldX = dfAddFloat(" + PhysicsDF.wordUniformValue("u_center", "x", precision) + ", uv.x * u_scale);" : "  float worldX = u_centerHi.x + uv.x * u_scale;",
      df ? "  MF worldY = dfAddFloat(" + PhysicsDF.wordUniformValue("u_center", "y", precision) + ", uv.y * u_scale);" : "  float worldY = u_centerHi.y + uv.y * u_scale;",
    ];

    // Plus u_tileOrigin (one TILE per state texture) and u_stencil (5 texels per pixel in derived modes).
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
      // FULL-resolution size, never the current target's: every level must agree.
      "uniform vec2 u_resolution;",
      "uniform float u_gridStride;",
      "uniform vec2 u_gridOrigin;",
      // Center as float32 WORDS: one uniform would drop all but 24 bits at upload.
    ].concat(PhysicsDF.wordUniformDecls("u_center"), [
      "uniform float u_scale;",
      "uniform bool u_colorZoom;",
      "uniform bool u_lowSaturation;",
      "uniform int u_maxSteps;",
      "uniform int u_durationSteps;",
      "uniform float u_bounceMax;",
      "uniform int u_displayMode;",
      "out vec4 fragColor;",
      "",
      PhysicsGPU.libraryGLSL(precision, PhysicsEngine.speedCapFor(sceneToCompile)),
      "",
    ]);

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
      // ---- Low Saturation: sRGB <-> OKLab (Ottosson). JS lowSaturate is a copy ----
      "vec3 srgb2linear(vec3 c) {",
      "  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));",
      "}",
      "vec3 linear2srgb(vec3 c) {",
      "  c = clamp(c, 0.0, 1.0);",
      "  return mix(12.92 * c, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));",
      "}",
      "vec3 linear2oklab(vec3 c) {",
      "  vec3 lms = vec3(",
      "    0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b,",
      "    0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b,",
      "    0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b);",
      // max() first: pow() below zero may yield NaN.
      "  lms = pow(max(lms, vec3(0.0)), vec3(1.0 / 3.0));",
      "  return vec3(",
      "    0.2104542553 * lms.x + 0.7936177850 * lms.y - 0.0040720468 * lms.z,",
      "    1.9779984951 * lms.x - 2.4285922050 * lms.y + 0.4505937099 * lms.z,",
      "    0.0259040371 * lms.x + 0.7827717662 * lms.y - 0.8086757660 * lms.z);",
      "}",
      "vec3 oklab2linear(vec3 lab) {",
      "  float l_ = lab.x + 0.3963377774 * lab.y + 0.2158037573 * lab.z;",
      "  float m_ = lab.x - 0.1055613458 * lab.y - 0.0638541728 * lab.z;",
      "  float s_ = lab.x - 0.0894841775 * lab.y - 1.2914855480 * lab.z;",
      "  float l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;",
      "  return vec3(",
      "    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,",
      "    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,",
      "    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);",
      "}",
      // Keep hue; pull OKLab L and C LOW_SAT_KEEP of the way from an even ramp toward the original.
      "const float LOW_SAT_L = 0.70;",
      "const float LOW_SAT_C = 0.20;",
      "const float LOW_SAT_KEEP = 0.5;",
      "vec3 lowSaturate(vec3 srgb) {",
      "  vec3 lab = linear2oklab(srgb2linear(srgb));",
      "  float C = length(lab.yz);",
      // The rainbow is never gray, but a zero chroma would divide by zero.
      "  vec2 dir = C > 1e-6 ? lab.yz / C : vec2(1.0, 0.0);",
      "  float L2 = mix(LOW_SAT_L, lab.x, LOW_SAT_KEEP);",
      "  float C2 = mix(LOW_SAT_C, C, LOW_SAT_KEEP);",
      "  return linear2srgb(oklab2linear(vec3(L2, dir * C2)));",
      "}",
      "",
      // 360 for circular outputs (t=0 and t=1 coincide), 300 otherwise. Color Zoom
      // repeats the ramp 10x, saturation 40%-100% across full t to tell repeats apart.
      "const float HUE_RANGE_MAX = " + PhysicsGPU.fnum(hueRangeMax) + ";",
      "float frameSigmoid(float v) {",
      "  return 1.0 / (1.0 + exp(" + PhysicsGPU.fnum(-PhysicsEngine.OUTPUT_SIGMOID_STEEPNESS) + " * (v - 0.5)));",
      "}",
      "",
      "vec3 rainbow(float t) {",
      // Bounce Count's unclamped t can arrive a hair over 1.
      "  t = clamp(t, 0.0, 1.0);",
      "  float hue = HUE_RANGE_MAX * (1.0 - t);",
      "  return hsl2rgb(hue, 1.0, 0.5);",
      "}",
      "",
      "vec3 colorMap(float t) {",
      "  t = clamp(t, 0.0, 1.0);",
      "  vec3 color;",
      "  if (u_colorZoom) {",
      "    float tZoom = mod(t * 10.0, 1.0);",
      "    float hue = HUE_RANGE_MAX * (1.0 - tZoom);",
      "    float sat = t * 0.6 + 0.4;",
      "    color = hsl2rgb(hue, sat, 0.5);",
      "  } else {",
      "    color = rainbow(t);",
      "  }",
      "  return u_lowSaturation ? lowSaturate(color) : color;",
      "}",
      "",

      // ---- The derived modes' own color formulas ----
      "const int MODE_STANDARD = 0;",
      "const int MODE_GRADIENT = 1;",
      "const int MODE_LAPLACIAN = 2;",
      "const int MODE_CONTOURS = 3;",
      // t per full-res pixel spans decades (<= 0.5 folded; thousandths on a wash),
      // so a LOG ramp of ~four decades; DERIVED_FLOOR is what counts as flat.
      "const float DERIVED_FLOOR = 1e-4;",
      "const float DERIVED_CEIL = 0.5;",
      "float magnitudeLift(float m) {",
      // max(): a driver may turn log2(0) into NaN.
      "  float lifted = log2(max(m, 1e-30) / DERIVED_FLOOR) / log2(DERIVED_CEIL / DERIVED_FLOOR);",
      "  return clamp(lifted, 0.0, 1.0);",
      "}",
      "",
      "vec3 gradientColor(vec2 g) {",
      // atan(0, 0) is undefined: a flat neighbourhood is common on integer outputs.
      "  float m = magnitudeLift(length(g));",
      "  if (m <= 0.0) return vec3(0.0);",
      "  float hue = degrees(atan(g.y, g.x));",
      "  if (hue < 0.0) hue += 360.0;",
      "  return hsl2rgb(hue, 1.0, 0.5 * m);",
      "}",
      "",
      "vec3 laplacianColor(float lap) {",
      "  return hsl2rgb(lap < 0.0 ? 205.0 : 25.0, 0.9, 0.5 * magnitudeLift(abs(lap) * 0.5));",
      "}",
      "",
      // Isolines at CONTOUR_LEVELS levels, constant SCREEN width (distance-to-level
      // over gradient). Fades at both ends: too steep (over one contour per pixel,
      // Nyquist) and too flat (a saturated sigmoid pins t on a level: 0/0 reads as full).
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
      isRunTally ? "" : "const float OUTPUT_RANGE_MAX = " + PhysicsGPU.fnum(rangeMax) + ";",
      "",
      stepOnceSource,
      "",
    ];

    // From here to gridTailLines: the DERIVED program only.
    var sampleOutputLines = [
      // ---- One pixel's whole simulation: re-entrant, and called from ONE site so
      // the compiler does not inline a copy of the step function per stencil point ----
      outScalar + " sampleOutput(" + B.scalar + " worldX, " + B.scalar + " worldY) {",
      initial.declarationLines.map(function (l) { return "  " + l; }).join("\n"),
      "  " + PhysicsGridCodegen.generateCanonicalBodyDeclarationsGLSL(initial).split("\n").join("\n  "),
      "  " + PhysicsGPU.generateHingeAnchorLocalsGLSL(initial.hingeAnchors, precision).split("\n").join("\n  "),
      stepLoopLines,

      "  " + outScalar + " outputValue = " + outZero + ";",
      outputLines.join("\n"),
      "  return outputValue;",
      "}",
      "",
    ];

    var deltaTLines = [
      // ---- b - a, in t units ----
      // Subtract at the pass's precision, THEN collapse: neighbours at a deep zoom
      // differ by under a float32 ULP of t. Fold: twin of fractal-stats.js's delta().
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
      "const vec2 STENCIL[4] = vec2[4](",
      "  vec2( 1.0,  0.0), vec2(-1.0,  0.0), vec2( 0.0,  1.0), vec2( 0.0, -1.0)",
      ");",
      "",

      "vec3 shadeDerived(" + B.scalar + " worldX, " + B.scalar + " worldY, " + outScalar + " outputValue, float t) {",
      // One FULL-RES pixel whatever level draws, so every level differentiates the same picture.
      "  float eps = u_scale / u_resolution.y;",
      "  float d[4];",
      "  for (int k = 0; k < 4; k++) {",
      "    vec2 o = STENCIL[k] * eps;",
      "    d[k] = deltaT(outputValue, sampleOutput(" +
        B.add("worldX", B.fromFloat("o.x")) + ", " + B.add("worldY", B.fromFloat("o.y")) + "));",
      "  }",
      "",
      "  if (u_displayMode == MODE_LAPLACIAN) return laplacianColor(d[0] + d[1] + d[2] + d[3]);",
      "",
      "  vec2 g = vec2(d[0] - d[1], d[2] - d[3]) * 0.5;",
      "  if (u_displayMode == MODE_CONTOURS) return contourColor(t, g);",
      "  return gradientColor(g);",
      "}",
      "",
      "void main() {",
    ];

    var gridMainLines = [
      // Standard stays INLINE, not a call to sampleOutput(): measured, the call
      // changed 3.5% of a colliding scene's pixels (driver float contraction across
      // the function boundary, ~1 ULP on the start coordinate, which is everything here).
      initial.declarationLines.map(function (l) { return "  " + l; }).join("\n"),
      "  " + PhysicsGridCodegen.generateCanonicalBodyDeclarationsGLSL(initial).split("\n").join("\n  "),
      "  " + PhysicsGPU.generateHingeAnchorLocalsGLSL(initial.hingeAnchors, precision).split("\n").join("\n  "),
      stepLoopLines,
      "  " + outScalar + " outputValue = " + outZero + ";",
      outputLines.join("\n"),
      tLine,
    ];

    // ---- Two programs from the same pieces ----
    // STANDARD: with u_sampleField it writes raw t to a float target, so every
    // measurement reads the program that drew. DERIVED is built only when picked.
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

  // antialias:false is load-bearing: blitFramebuffer into a multisampled draw
  // framebuffer is INVALID_OPERATION in ES 3.0, and every frame blits the accumulator.
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
  // On ANGLE/Metal a df program's real cost is its FIRST DRAW (0.5-11s of pipeline
  // build), so a build is a POLLED state machine: linking (background, via
  // KHR_parallel_shader_compile) -> warming (1x1 draw per format + fence) -> ready/failed.
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

  // One 1x1 draw per format so the pipelines build now. Program left for the caller to restore.
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
      var format = entry.format || entry, count = entry.count || 1;
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
      // No checkFramebufferStatus: a GPU round trip that would block for the very stall this avoids.
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

  function pumpProgramBuild(build, warmFormats, wait) {
    if (build.status === "linking") {
      if (!wait && parallelCompileExt &&
          !gl.getProgramParameter(build.program, parallelCompileExt.COMPLETION_STATUS_KHR)) return build.status;
      if (!gl.getProgramParameter(build.program, gl.LINK_STATUS)) {
        build.error = gl.getShaderInfoLog(build.shader) || gl.getProgramInfoLog(build.program) || "unknown shader error";
        discardProgramBuild(build);
        build.status = "failed";
        return build.status;
      }
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
  function noteBuildDone(build) {
    if (!build.startedAt) return;
    var ms = performance.now() - build.startedAt;
    build.startedAt = 0;
    perfStats.builds += 1;
    perfStats.buildMs += ms;
    perfStats.lastBuildMs = ms;
  }

  // ---- The grid's programs ----
  // One per (precision, variant). float32 builds blocking; df builds in the
  // background while float32 stands in (just above the wall they must match).
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
      lowSaturation: gl.getUniformLocation(prog, "u_lowSaturation"),
      maxSteps: gl.getUniformLocation(prog, "u_maxSteps"),
      durationSteps: gl.getUniformLocation(prog, "u_durationSteps"),
      bounceMax: gl.getUniformLocation(prog, "u_bounceMax"),
      displayMode: gl.getUniformLocation(prog, "u_displayMode"),
      sampleField: gl.getUniformLocation(prog, "u_sampleField"),
    };
    pass.status = "ready";
  }

  function pumpPass(pass, wait) {
    if (pass.status !== "building") return;
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

  function requestPass(precision, variant, wait) {
    var key = passKey(precision, variant);
    if (!passes[key]) {
      var pass = { key: key, precision: precision, variant: variant, status: "building", build: null,
        program: null, posLoc: -1, uniforms: null, error: null };
      try {
        pass.build = startProgramBuild(buildFragmentShader(scene, precision, variant));
      } catch (err) {
        pass.status = "failed";
        pass.error = err.message || String(err);
        if (precision !== "f32") setStatus(false, "High-precision shader unavailable: " + pass.error);
      }
      passes[key] = pass;
    }
    if (wait) pumpPass(passes[key], true);
    return passes[key].status === "ready" ? passes[key] : null;
  }

  function pumpPassBuilds() {
    Object.keys(passes).forEach(function (k) { pumpPass(passes[k], false); });
  }

  function onPassReady(pass) {
    if (!activePass) return;
    updatePrecisionReadout();
    if (pass.precision === pickPrecision() && pass.variant === wantedVariant() && pass !== activePass) markDirty();
  }

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
  var isInfinitePositionOutput = scene.edgeMode === "infinite" &&
    (scene.output.property === "x" || scene.output.property === "y");
  var bounceMaxValue = 1;
  function currentOutputRangeMax() { return outputRangeMax(scene, scene.output.property); }
  function computeIsCircularOutput() {
    var prop = scene.output.property;
    return prop === "angle" || ((prop === "x" || prop === "y") && scene.edgeMode === "wrap");
  }
  var isCircularOutput = computeIsCircularOutput();
  var hueRangeMaxValue = isCircularOutput ? 360 : 300;
  quadBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  function bindQuad(posLoc) {
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
  }
  bindQuad(activePass.posLoc);

  function setCenterUniforms(u) {
    var words = PhysicsDF.wordUniformValues(view.center.x, view.center.xLo, view.center.y, view.center.yLo);
    gl.uniform2f(u.centerHi, words[0][0], words[1][0]);
    gl.uniform2f(u.centerLo, words[0][1], words[1][1]);
    gl.uniform2f(u.centerLo2, words[0][2], words[1][2]);
    gl.uniform2f(u.centerLo3, words[0][3], words[1][3]);
  }

  // ---- Measuring the field: the standard program, in sample mode ----
  // u_sampleField writes raw t into RGBA32F: no 8-bit noise, no second compile,
  // and it cannot disagree with the picture. Always standard, whatever mode shows.
  var SAMPLE_SIZE = 24;
  var hasFloatColorBuffer = !!gl.getExtension("EXT_color_buffer_float");
  // Null when nothing can measure now. Never falls back across precisions.
  function currentSampler() {
    if (!hasFloatColorBuffer) return null; // heuristic only, skip quietly if this GPU/browser can't render float textures
    if (effectivePrecision() !== "f32" || f32NeedsSlicing()) return null;
    return requestPass("f32", "standard", true);
  }

  function canSampleField() {
    return !!(hasFloatColorBuffer && (slicedProgramsForGrid() || currentSampler()));
  }

  setStatus(true, "Ready");

  // The centre is a DOUBLE-DOUBLE (x + xLo, ~106 bits): past ~1e-13 a float64
  // cannot tell pixels apart. Anything that must land on a PIXEL uses the helpers below.
  var view = { center: { x: DEFAULT_CENTER.x, y: DEFAULT_CENTER.y, xLo: 0, yLo: 0 }, scale: DEFAULT_SCALE };

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
  function shiftViewCenterByProducts(ax, bx, ay, by) {
    var px = PhysicsDF.twoProd64(ax, bx), py = PhysicsDF.twoProd64(ay, by);
    shiftViewCenter(px[0], py[0]);
    shiftViewCenter(px[1], py[1]);
  }
  function setViewCenter(x, y) {
    view.center.x = x; view.center.xLo = 0;
    view.center.y = y; view.center.yLo = 0;
  }
  // Every digit, for keys: at a deep zoom a pan moves only the low halves.
  function viewCenterKey() {
    return [view.center.x, view.center.xLo, view.center.y, view.center.yLo].join(" ");
  }
  function worldPointAtUV(uvx, uvy) {
    var px = ddAddNumber(view.center.x, view.center.xLo, uvx * view.scale);
    var py = ddAddNumber(view.center.y, view.center.yLo, uvy * view.scale);
    return { x: px[0], y: py[0], xLo: px[1], yLo: py[1] };
  }
  // The inverse, as [u, v]; high and low differenced separately.
  function worldPointToUV(point) {
    return [
      ((point.x - view.center.x) + ((point.xLo || 0) - view.center.xLo)) / view.scale,
      ((point.y - view.center.y) + ((point.yLo || 0) - view.center.yLo)) / view.scale,
    ];
  }
  function snappedWorldPointAtUV(uvx, uvy) {
    var col = Math.floor(uvx * canvas.height + 0.5 * canvas.width);
    var row = Math.floor(uvy * canvas.height + 0.5 * canvas.height);
    var point = worldPointAtUV((col + 0.5 - 0.5 * canvas.width) / canvas.height, (row + 0.5 - 0.5 * canvas.height) / canvas.height);
    point.cell = col + "," + row;
    return point;
  }
  function worldPointDelta(a, b, axis) {
    return (b[axis] - a[axis]) + ((b[axis + "Lo"] || 0) - (a[axis + "Lo"] || 0));
  }
  function lerpWorldPoint(ax, bx, tx, ay, by, ty) {
    var px = ddAddNumber(ax.x, ax.xLo || 0, worldPointDelta(ax, bx, "x") * tx);
    var py = ddAddNumber(ay.y, ay.yLo || 0, worldPointDelta(ay, by, "y") * ty);
    return { x: px[0], y: py[0], xLo: px[1], yLo: py[1] };
  }

  // ---- Progressive refinement state ----
  // Declared here: markDirty() runs from setup before the ladder's vars exist.
  // stride: current level's spacing in full-res px; sublattice: 0 base, else 1-3.
  var progressive = {
    stride: 0,          // 0 = nothing started yet; set on the first step after a reset
    sublattice: 1,      // 1..3, which of the level's three new sub-lattices is next
    band: 0,            // next un-drawn row of the current sub-lattice's target
    complete: false,
    accumStride: 0,     // spacing of the data currently sitting in the accumulator
    // 0 while the ladder runs; then how many whole-screen samples averaged.
    aaSample: 0,
    // Sliced rendering only: the tile still running, and its row offset.
    tile: null,
    tileX: 0,
  };

  // ---- Picture reuse (Settings > Reuse Last Picture) ----
  // A full-res copy of the best picture (`source`) and its mapping onto the run
  // (`run`, reusePlanRun): a PREVIEW for any view change (presentWithSource), and
  // EXACT reuse for a pan, snapped to whole device pixels (reuseFillCovered).
  var reuseEnabled = false;
  var reuse = {
    source: null,        // {tex, fbo, width, height}, full resolution
    center: null,        // the view the source is a picture of...
    scale: 0,
    stride: 0,           // ...the spacing of its samples, in its own pixels...
    aaRect: null,
    look: "",            // ...and the look and precision it was rendered with
    precision: "",
    // What the accumulator holds a picture OF; null when playback painted it.
    image: null,
    // How the source maps onto the run in progress; null when it doesn't.
    run: null,
    // The fractions of a device pixel that snapping a pan has set aside.
    panCarryX: 0,
    panCarryY: 0,
  };
  var sceneGeneration = 0;
  // Below this screen coverage an unbettered source is dropped anyway.
  var REUSE_KEEP_COVERAGE = 0.15;
  // Cost of a level with nothing to simulate: not 0, which reads as "done".
  var REUSE_FREE_COST = 1e-6;

  // ---- The playback timeline ----
  // `step` is what the grid shows (renderedSteps); rests at Simulation Duration.
  var timeline = {
    step: simulationSteps,
    playing: false,
    // Steps the playback clock has asked for but no draw has run yet.
    carry: 0,
    lastTickAt: 0,
    // Which view the CURRENT state texture was built for, and its steps.
    stateKey: null,
    stateStep: 0,
    // A write into the OTHER state texture that is still in flight, or null.
    pass: null,
    // Last view seen and when: playback waits for the view to hold still.
    seenKey: null,
    seenAt: 0,
    presentedKey: null,
    drawing: false,
    catchingUp: false,
    catchUpFraction: 0,
    stride: 1,
    // While `following`, the step comes from the Inspect preview's clock.
    following: false,
    followTarget: 0,
    followPlaying: false,
  };
  function renderedSteps() { return Math.min(timeline.step, simulationSteps); }

  var dirty = true;
  // Invalidates the image, every partial refinement level and Global Stats.
  function markDirty() { dirty = true; resetProgressive(); scheduleColorSpreadCheck(); statsOnViewChanged(); }

  // ---- Choosing a precision ----
  // The float32 wall: one pixel's world distance under the ULP of the largest coordinate in play.
  function computeSceneCoordinateSpan() {
    var m = 1;
    scene.bodies.forEach(function (b) {
      m = Math.max(m, Math.abs(b.x || 0), Math.abs(b.y || 0));
    });
    return Math.max(m, scene.frameWidth || 0, scene.frameHeight || 0);
  }
  var sceneCoordinateSpan = computeSceneCoordinateSpan();
  // The wall is at ~1 ULP per pixel (clean at 3, gone by 0.3): a 20x margin. A df
  // pixel costs 5x-25x, and the crossover should happen while both passes agree.
  var DF_SWITCH_MARGIN_ULPS = 64;
  // Coarsest first; rungs above df need BigInt, so without it the ladder stops at df.
  var PRECISION_LADDER = ["f32", "df", "tf", "qf"].filter(function (precision) {
    return PhysicsDF.isSupported(precision);
  });
  var PRECISION_LABELS = {
    f32: "float32 (~7 digits)",
    df: "double-float (~15 digits)",
    tf: "triple-float (~21 digits)",
    qf: "quad-float (~28 digits)",
  };
  // Cost over float32 as one round figure (measured: df ~10x typical; tf 4x, qf 7x of that).
  var PRECISION_TITLES = { f32: "Single Precision", df: "Double Precision", tf: "Triple Precision", qf: "Quadruple Precision" };
  var PRECISION_SLOWDOWN = { df: 10, tf: 40, qf: 70 };
  var sliceSteps = {};
  var sliceCalibrated = {};
  var sliceTooHeavy = {};
  // "auto" or a rung (the Settings override). Page state: Auto on arrival unless changed on the builder page.
  var precisionMode = sharedSettings.readPrecision(PRECISION_LADDER);

  function float32UlpAt(magnitude) {
    return Math.pow(2, Math.ceil(Math.log2(Math.max(magnitude, 1e-30))) - 24);
  }
  // The FINEST spacing the view reaches, so the choice is stable across a run.
  function referenceHeightPx() {
    return Math.max(canvasArea.clientHeight * gridDpr(), canvas.height, 1);
  }
  // The distance in world units between two adjacent simulated points.
  function worldPixelSpacing() { return view.scale / referenceHeightPx(); }
  // Smallest step at `precision`: 24 bits per word, words don't overlap.
  function precisionUlpAt(precision, magnitude) {
    return float32UlpAt(magnitude) * Math.pow(2, -24 * (PhysicsDF.wordsFor(precision) - 1));
  }
  // Coarsest rung with DF_SWITCH_MARGIN_ULPS of its own ULPs per `spacing`.
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
    if (active !== wanted) {
      var name = PRECISION_LABELS[wanted].replace(/ \(.*$/, "");
      text += " \u2014 " + name + (precisionPending(wanted) ? " compiling\u2026" : sliceTooHeavy[wanted] ? " too slow for this scene on this GPU" : " unavailable");
    }
    precisionReadout.textContent = text;
  }
  if (precisionSelect) {
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

  // Shared by the checkbox and the presets; switched on at the end of boot (applyPerfValues).
  function setReuseEnabled(on) {
    on = !!on;
    if (reusePictureCheckbox) reusePictureCheckbox.checked = on;
    if (on === reuseEnabled) return;
    reuseEnabled = on;
    reuse.panCarryX = reuse.panCarryY = 0;
    if (reuseEnabled) {
      if (!dirty && progressive.stride > 0) reuseNoteImage();
      return;
    }
    // Off mid-run: a reusing run drew only part of each level.
    reuse.image = null;
    reuseDropSource();
    markDirty();
  }
  if (reusePictureCheckbox) {
      // Not set from reuseEnabled here: the end of boot takes reuseEnabled from IT.
    reusePictureCheckbox.addEventListener("change", function () {
      setReuseEnabled(reusePictureCheckbox.checked);
      syncPerfPresetUI();
    });
  }

  // ---- "Those radial lines aren't real" ----
  // Both axes on one body's velocity, zoomed out past speedCapFor: the cap keeps
  // direction and drops length, so the region is a function of angle alone, a fan.
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
    if (DEFAULT_SCALE / view.scale > VELOCITY_CAP_TIP_MAX_ZOOM) return false;
    var anchor = tipAnchorVisible(zoomReadout) ? zoomReadout : displayMenu.anchor();
    return showTip(VELOCITY_CAP_TIP_ID, anchor,
      "Radial lines are an artifact of the maximum speed cap.",
      { okLabel: "Dismiss", noArrowAbove: true });
  }

  // Which of a scene's two programs the display mode calls for.
  function wantedVariant() {
    return displayMode && displayMode.id !== 0 ? "derived" : "standard";
  }

  // Above float32: the sliced programs, or the single-draw one on a device
  // without float targets. Asking also STARTS the build.
  function precisionReady(precision) {
    if (precision === "f32") return true;
    if (sliceTooHeavy[precision]) return false;
    if (hasFloatColorBuffer) return !!playbackProgramsFor(precision);
    return !!requestPass(precision, wantedVariant(), false);
  }
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

  // What the zoom wants, or the finest built rung below it while that builds.
  // Anything that must agree with the picture asks this, not pickPrecision().
  function effectivePrecision() {
    var wanted = pickPrecision();
    if (precisionReady(wanted)) return wanted;
    for (var i = PRECISION_LADDER.indexOf(wanted) - 1; i > 0; i--) {
      if (precisionBuilt(PRECISION_LADDER[i])) return PRECISION_LADDER[i];
    }
    return "f32";
  }

  // Start the next rung's build this many margins early: several wheel notches.
  var DF_PREWARM_FACTOR = 16;
  function prewarmPasses() {
    if (precisionMode !== "auto") return;
    precisionReady(precisionForSpacing(worldPixelSpacing() / DF_PREWARM_FACTOR));
  }

  // Binds the single-draw program; above float32 only float-texture-less devices use it.
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

  // View-only preference, never saved: a uniform flipped and redrawn.
  var colorZoomEnabled = false;
  var lowSaturationEnabled = false;

  // ---- Display mode ----
  // `samples`: simulations per pixel. `value` is also the thumbnail filename.
  // ids are the GLSL MODE_* constants. A blurb over ~5 wrapped lines drives row height.
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

  // Offscreen RGBA32F target for reading raw t back; made per call, never per
  // frame. rawBounces: sample with u_bounceMax = 1 to get the raw count.
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

  // Shades rows [rowStart, +rowCount) of a blockWidth x blockHeight grid into the
  // first rows of `target`; banded so Global Stats never issues one watchdog-length
  // draw. Selected via u_gridOrigin (no full block texture). Restores all GL state.
  function drawSampleBand(target, blockWidth, blockHeight, rowStart, rowCount, rawBounces) {
    var slicedPrograms = hasFloatColorBuffer ? slicedProgramsForGrid() : null;
    var sampler = slicedPrograms ? null : currentSampler();
    if (!slicedPrograms && !sampler) return 0;
    rowCount = Math.min(rowCount, target.height, blockHeight - rowStart);
    if (rowCount <= 0) return 0;
    // gl.getParameter returns null once the context is lost; this is reached from a timer, so bail rather than throw.
    var prevViewport = gl.isContextLost() ? null : gl.getParameter(gl.VIEWPORT);
    if (!prevViewport) return 0;
    if (slicedPrograms) {
      drawSampleBandSliced(slicedPrograms, target, blockWidth, blockHeight, rowStart, rowCount, rawBounces);
      gl.viewport(prevViewport[0], prevViewport[1], prevViewport[2], prevViewport[3]);
      useCurrentPass();
      return rowCount;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, target.width, target.height);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, blockWidth, rowCount);
    gl.useProgram(sampler.program);
    gl.uniform1i(sampler.uniforms.sampleField, 1);
    // The FULL block, not the band: the shader divides by this to get uv.
    gl.uniform2f(sampler.uniforms.resolution, blockWidth, blockHeight);
    gl.uniform1f(sampler.uniforms.gridStride, 1);
    gl.uniform2f(sampler.uniforms.gridOrigin, 0, rowStart);
    setCenterUniforms(sampler.uniforms);
    gl.uniform1f(sampler.uniforms.scale, view.scale);
    // rawBounces: the bounce divisor is measured over the whole duration so colors hold while the timeline plays.
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

  // Reads rowCount rows of a band into `into`. readPixels is a GPU sync: an idle deadline measured around it is real.
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

  // One-shot sampler for the small fixed-size scans; Global Stats drives drawSampleBand itself.
  function sampleValueGrid(w, h, rawBounces) {
    if (!canSampleField()) return null;
    var target = createSampleTarget(w, h);
    if (drawSampleBand(target, w, h, 0, h, rawBounces) === 0) {
      freeSampleTarget(target);
      return null;
    }
    var values = new Float32Array(w * h * 4);
    readSampleBand(target, h, values);
    freeSampleTarget(target);
    return { width: w, height: h, values: values };
  }

  // ---- Superlatives: largest/smallest/rarest/sharpest-edge point in the view, locked as Inspect points ----
  var SUPERLATIVE_SAMPLE_LONG_SIDE = 200;

  function tAt(grid, col, row) {
    return grid.values[(row * grid.width + col) * 4];
  }

  // Circular outputs need a wraparound-aware distance (t=0.99 and t=0.02 are close).
  function valueDistance(a, b) {
    var d = Math.abs(a - b);
    return isCircularOutput ? Math.min(d, 1 - d) : d;
  }

  // t=0 and t=1 coincide on a circular output, so comparisons straddling that seam are skipped.
  // 0.15, not tighter: the sample grid is coarse.
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

  // Mirrors buildFragmentShader's uv/world formula; gl_FragCoord is bottom-left like readPixels, so no Y-flip.
  function sampleCoordToWorld(grid, col, row) {
    var uvx = (col + 0.5 - 0.5 * grid.width) / grid.height;
    var uvy = (row + 0.5 - 0.5 * grid.height) / grid.height;
    return worldPointAtUV(uvx, uvy);
  }

  // A separate seam from the OUTPUT wrap: the INPUT position is settled into the frame before simulating, so
  // adjacent samples straddling a reset start far apart. Detected from the computed initial state.
  function initialStateAt(worldX, worldY) {
    try {
      return PhysicsGridCodegen.computeOffsetSceneNumeric(scene, worldX, worldY);
    } catch (err) {
      return null;
    }
  }

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

  // Adjacent samples' starts differ by a tiny amount; a jump near a frame dimension can only be the settle wrap.
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

  // Rarest = least like its 8 neighbors (mean valueDistance, maximized); neighbors across either seam are skipped.
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

  // Most different ADJACENT pair; checking right and down neighbors visits each edge once.
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
    if (!grid) return; // heuristic-only sampler unavailable (see setUpColorSpreadSampler), nothing to do
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

  // Smallest arc of the color wheel holding every t: 1 minus the largest gap (t=0 and t=1 coincide).
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
  var COLOR_SPREAD_CHECK_DELAY_MS = 500; // debounced off markDirty, only check once the view settles, not on every drag tick
  var colorSpreadCheckTimer = null;

  function checkColorSpreadAndMaybeSuggestColorZoom() {
    if (colorZoomEnabled) return;
    // Only about the finished picture: partway along the timeline a narrow spread is often just early.
    if (timeline.playing || renderedSteps() < simulationSteps) return;
    var grid = sampleValueGrid(SAMPLE_SIZE, SAMPLE_SIZE);
    if (!grid) return;
    var values = [];
    for (var i = 0; i < grid.values.length; i += 4) values.push(grid.values[i]);
    if (isTipDismissed("color-zoom")) return;
    if (circularSpread(values) <= COLOR_SPREAD_SUGGEST_THRESHOLD) {
      displayMenu.set(true);
      showTip("color-zoom", colorZoomCheckbox, "Try Color Zoom to highlight subtle color differences");
    }
  }

  // One popover, so tips run in priority order: the speed cap explains a collapsed spread; Color Zoom does not.
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

  // Bounce-count divisor: the largest count in the view, from a small offscreen float sample over the whole
  // duration. Measured once per VIEW change (beginProgressive): a mid-refinement re-measure would shift every hue.
  var BOUNCE_MAX_SAMPLE_SIZE = 32;

  // Asynchronous (PBO behind a fence): it runs every frame of a drag, and a readPixels stall hitched each one.
  var bounceMaxProbe = { target: null, pbo: null, sync: null, key: null, measuredKey: null,
    values: new Float32Array(BOUNCE_MAX_SAMPLE_SIZE * BOUNCE_MAX_SAMPLE_SIZE * 4) };

  function bounceMaxViewKey() {
    return [viewCenterKey(), view.scale, canvas.width, canvas.height, simulationSteps, effectivePrecision()].join(" ");
  }

  function requestBounceMax() {
    var key = bounceMaxViewKey();
    // Already measured, or being measured, for this view.
    if (key === bounceMaxProbe.measuredKey || (bounceMaxProbe.sync && key === bounceMaxProbe.key)) return;
    if (!canSampleField()) return; // no float targets to measure into: keep what we had
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
    // A stale view's measurement says nothing; the move queued its own.
    if (bounceMaxProbe.key !== bounceMaxViewKey()) return;
    bounceMaxProbe.measuredKey = bounceMaxProbe.key;
    var max = 0, values = bounceMaxProbe.values;
    for (var i = 0; i < values.length; i += 4) max = Math.max(max, values[i]);
    // Never 0: an all-quiet view would divide by zero.
    max = Math.max(1, max);
    if (max !== bounceMaxValue) {
      bounceMaxValue = max;
      markDirty();
    }
  }

  // Blocking form, for the one caller that cannot draw a first frame without it.
  function findBounceMax() {
    var grid = sampleValueGrid(BOUNCE_MAX_SAMPLE_SIZE, BOUNCE_MAX_SAMPLE_SIZE, true);
    if (!grid) return bounceMaxValue; // no float-texture support: keep whatever we had
    var max = 0;
    for (var i = 0; i < grid.values.length; i += 4) max = Math.max(max, grid.values[i]);
    return Math.max(1, max);
  }

  // Draws one sub-lattice: rendered pixel (i, j) carries full-res pixel (i*stride + originX, j*stride + originY).
  // Caller owns framebuffer/viewport/scissor. u_resolution is always the FULL-res canvas size, never the target's.
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
    gl.uniform1i(pass.uniforms.lowSaturation, lowSaturationEnabled ? 1 : 0);
    gl.uniform1i(pass.uniforms.maxSteps, steps === undefined ? renderedSteps() : steps);
    gl.uniform1i(pass.uniforms.durationSteps, simulationSteps);
    gl.uniform1f(pass.uniforms.bounceMax, bounceMaxValue);
    gl.uniform1i(pass.uniforms.displayMode, displayMode.id);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  // ---- Inspect: locked reference points played back alongside the hover ----
  // Groups: "point" (one entry), "line" (entries along a drag), "grid" (a computeGridLayout-sized set over a
  // dragged box, drawn as a mesh). An entry is computeTrajectoryEntry's result plus a color; Grid Size 8 needs 176.
  var MAX_INSPECT_POINTS = 300;
  var inspectGridSize = Number(document.getElementById("inspect-grid-size-slider").value) || 3;
  var inspectGridTwoPart = document.getElementById("inspect-grid-two-part-checkbox").checked;
  var inspectedGroups = []; // each: { type, points: [...], startWorld, endWorld (line/grid), cols, rows, segments, meshLineEls, outputBodyIndex (grid only) }
  function totalInspectedPointCount() {
    var total = 0;
    for (var i = 0; i < inspectedGroups.length; i++) total += inspectedGroups[i].points.length;
    return total;
  }

  // Which drag the next gesture commits to. "point" is touch-only (no hover) and never takes the drag from panning.
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

  // Never reassigned, so removing a point never recolors the others; resets only once every group is gone.
  var nextColorIndex = 0;
  // Golden-angle hue step keeps successive points visually distinct.
  var INSPECT_HUE_STEP = 137.5;
  function lockedPointColor(colorIndex) {
    var hue = (colorIndex * INSPECT_HUE_STEP) % 360;
    return { fill: "hsl(" + hue + ", 100%, 50%)", stroke: "#000000" };
  }

  // Points per Inspect (Line) drag, hues split evenly; the dot pool is built at the slider's max so it never resizes.
  var INSPECT_LINE_SAMPLE_MAX = 60;
  var inspectLineSampleCount = Number(document.getElementById("inspect-line-sample-count-slider").value) || 30;
  // Short of 360 so the last point never matches the first.
  var INSPECT_LINE_MAX_HUE = 324;
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

  function evenlySpacedGrid(corner1, corner2, cols, rows) {
    // Decided on the double-double delta: at deep zoom both corners' .x can be the same float64.
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
  // Grid Settings -> the dense dot grid a drag builds. N < 2 clamps to 2 (a plain box, intentionally). Two-part
  // lines add a midpoint dot per gap (2*nEff - 1 per axis); lockGridOfPoints' filter drops the interior dots.
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
  // RGB(x, y, 0.5) by (col, row) over the grid's own denseSize: position-only, legible whatever the scene does.
  function inspectGridPointColor(col, row, denseSize) {
    var x = denseSize > 1 ? col / (denseSize - 1) : 0;
    var y = denseSize > 1 ? row / (denseSize - 1) : 0;
    var r = Math.round(x * 255), g = Math.round(y * 255), b = Math.round(0.5 * 255);
    return { r: r, g: g, b: b, fill: "rgb(" + r + "," + g + "," + b + ")", stroke: "#000000" };
  }
  function averageRgbFill(colorA, colorB) {
    return "rgb(" + Math.round((colorA.r + colorB.r) / 2) + "," + Math.round((colorA.g + colorB.g) / 2) + "," + Math.round((colorA.b + colorB.b) / 2) + ")";
  }
  // One chain per drawn row/column (lineAxes), every dot along it so a two-part line can kink. `points` is row-major.
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

  // Which body a grid point plots: scene.output.body, or for Scene Lifespan (no body) the first non-anchored one.
  function inspectGridOutputBodyIndex() {
    if (scene.output.property !== "lifespan") return scene.output.body;
    for (var i = 0; i < scene.bodies.length; i++) {
      if (!scene.bodies[i].isAnchored) return i;
    }
    return scene.bodies.length > 0 ? 0 : null;
  }

  // World point -> CSS pixels relative to #canvas-area. gl_FragCoord is bottom-left, the DOM top-left: hence fy.
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

  // Pooled .inspect-marker per point/line point; grids only reposition their mesh lines. Clicking removes the
  // WHOLE group; inspectMarkerGroupIndex is read fresh per click since slots change as points come and go.
  var inspectMarkerEls = [];
  var inspectMarkerGroupIndex = [];
  function updateInspectMarkers() {
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
      // The dot sits over the canvas, so it must zoom too or it blocks the wheel.
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
      // A custom property, so .inspect-marker:hover's own background rule wins without !important.
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

  // Inspect (Line) drag preview, pooled at the slider's max; hidden per element (#inspect-preview also hosts grids).
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
    // Attributes, not .hidden: the IDL property is unreliable on SVGElement.
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

  // "Drag to inspect" toast. Never [hidden]: display:none and an opacity transition can't combine in one frame.
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

  // Restarts the hover preview whenever the inspected set changes, so a slow batch's points all start at step 0.
  function restartCurrentPreview() {
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

  // runHoverAt's GPU replay + wrap-stop work, run once and cached. Null on failure; the caller decides the batch.
  function computeTrajectoryEntry(worldPoint) {
    var compiled, trajectory;
    var steps = hoverStepCount();
    try {
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
      // Neither Scene Lifespan nor Bounce Count has an output body to reconstruct.
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
    disarmInspect();
    updateInspectUI();
  }

  // Inspect (Line) drag. Past MAX_INSPECT_POINTS only the first `available` points are added.
  function lockLineOfPoints(startWorld, endWorld, sampleCount) {
    sampleCount = sampleCount || inspectLineSampleCount;
    var available = MAX_INSPECT_POINTS - totalInspectedPointCount();
    if (available <= 0) return; // stays armed: Clear All (or removing a point) might free up room to retry
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

  // Inspect (Grid) drag. All-or-nothing (a partial grid reads as broken), staying armed on failure. The layout is
  // resolved from Grid Settings once, here: a later settings change only affects the NEXT drag.
  function lockGridOfPoints(startWorld, endWorld, gridSize, twoPart) {
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
      // What it was made with (the resolved layout can't be read back), for share links.
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
      nextColorIndex = 0;
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

  // Clicking the armed button cancels it (a toggle).
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

  // Relabels (and for x/y reorders) the extreme buttons per output; which button does which search never changes.
  function relabelSuperlativeExtremeButtons() {
    var prop = scene.output.property;
    var largestLabel = "Largest Point", smallestLabel = "Smallest Point", smallestFirst = false;
    if (prop === "x") {
      // Larger x is further right; this project's world-X isn't flipped.
      largestLabel = "Rightest";
      smallestLabel = "Leftest";
      smallestFirst = true;
    } else if (prop === "y") {
      // Larger y is LOWER on screen (see PhysicsGridCodegen's Y-flip), so largest is "Lowest".
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
    if (smallestFirst) {
      btnSuperlativeLargest.parentNode.insertBefore(btnSuperlativeSmallest, btnSuperlativeLargest);
    } else {
      btnSuperlativeSmallest.parentNode.insertBefore(btnSuperlativeLargest, btnSuperlativeSmallest);
    }
  }
  relabelSuperlativeExtremeButtons();

  // ---- Progressive refinement ----
  // Ever-finer power-of-two sub-lattices of the full-res pixel grid until every pixel has its own simulation. Starts
  // cheap and stops when out of time, so nothing guesses GPU speed; each level is a small, abandonable draw.

  var COARSEST_STRIDE = 4096;

  // Rows per band; in ROWS so a band's cost scales with the width being drawn, as the budget does.
  var MIN_BAND_ROWS = 1;

  // ---- The per-frame work budget ----
  // A feedback loop on wall-clock frame time, relative to the DISPLAY's refresh period, not 16ms: intervals are
  // quantised to whole refreshes, and on a 30Hz or throttled display 16ms would pin the budget to its floor.
  var displayPeriodMs = 16.7;
  // Running minimum with a slow upward leak, fed by every frame (idle ones are the cleanest observation).
  var DISPLAY_PERIOD_LEAK = 1.01;
  function noteFrameCadence(now) {
    if (lastFrameAt > 0) {
      var dt = now - lastFrameAt;
      // A backgrounded tab or sleep says nothing about the refresh rate.
      if (dt > 0 && dt < 200) displayPeriodMs = Math.min(displayPeriodMs * DISPLAY_PERIOD_LEAK, dt);
    }
    lastFrameAt = now;
  }
  var lastFrameAt = 0;

  // A frame's target length: one refresh, or Settings > Performance > Work per frame. Where even an empty frame takes
  // two refreshes (a phone), one-refresh feedback pins the budget to its floor. Halved while the user interacts.
  function frameBaseMs() { return Math.max(displayPeriodMs, perf.frameMs || 0); }
  function userIsInteracting(now) { return now - lastInteractionAt < INTERACTION_HOLD_MS; }
  function frameTargetMs(now) {
    var base = frameBaseMs();
    return base > displayPeriodMs && userIsInteracting(now) ? Math.max(displayPeriodMs, base / 2) : base;
  }

  // Correcting down is a measurement; probing up is a guess. Under vsync a frame that fit says nothing about its
  // margin, but one that took TWO periods measures throughput, so the budget lands on it instead of limit-cycling.
  var BUDGET_SAFETY = 0.85;   // aim just under measured capacity, not at it
  var BUDGET_GROW = 1.1;      // gentle upward probe when a frame fit
  // How far past one period counts as an overrun rather than jitter; HARD_ is where it is taken at face value.
  var OVERRUN_RATIO = 1.15;
  var HARD_OVERRUN_RATIO = 2.5;
  var BUDGET_SMOOTHING = 0.35; // weight of each new measurement
  var INITIAL_PIXEL_BUDGET = 120000;
  // A floor on the FEEDBACK, not throughput (one band always draws): too high and the loop can never regulate down.
  var MIN_PIXEL_BUDGET = 1000;
  var MAX_PIXEL_BUDGET = 32000000;

  // ---- ...and, where the browser offers it, measuring the GPU after all ----
  // EXT_disjoint_timer_query_webgl2 (Chrome, not Safari) reports GPU time a few frames later without a stall and
  // steers the budget where present (noteGpuTime). Target: most of the period idle, about half while interacting.
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
    // Only a frame that spent most of its budget measures its cost (a short one is overhead); a LONG one always does.
    if (!(ms > 0.2) || (spent < budgetThen * 0.5 && ms < targetMs)) return;
    var perMs = spent / ms;
    // Too slow is believed at once; faster is eased into.
    b.gpuPerMs = b.gpuPerMs > 0 && perMs > b.gpuPerMs ? b.gpuPerMs * (1 - BUDGET_SMOOTHING) + perMs * BUDGET_SMOOTHING : perMs;
    b.budget = clamp(b.gpuPerMs * targetMs, b.min, b.max);
    // What one period holds: the figure other budgets are seeded from.
    b.throughput = b.gpuPerMs * frameBaseMs();
  }

  // A work budget: the ladder's (simulated pixels) or playback's (pixel-steps). growMinUse: see noteFrameTiming.
  function makeWorkBudget(initial, min, max, growMinUse) {
    return {
      budget: initial,
      min: min,
      max: max,
      growMinUse: growMinUse || 0,
      // How much work fits in one refresh period, as last measured.
      throughput: 0,
      // The same from GPU timer queries, per ms; 0 until one reports.
      gpuPerMs: 0,
      lastSpent: 0,
      // Last frame that dispatched work. Idle frames are NOT fed back: they return in one period on any GPU.
      lastWorkAt: 0,
    };
  }
  // One budget per ladder program (keyed like `passes`). A never-drawn one is seeded from float32-standard's
  // throughput and a pessimistic cost prior: too dear under-refines a few frames; too cheap hangs the canvas.
  var DF_COST_PRIOR = 64;
  // Rungs above df as multiples of its prior, measured 3.4-5.0x (tf) and 6.5-7.9x (qf); high end taken.
  var PRECISION_COST_PRIOR = { df: DF_COST_PRIOR, tf: DF_COST_PRIOR * 5, qf: DF_COST_PRIOR * 8 };
  var DERIVED_COST_PRIOR = 5;
  var ladderBudgets = {};
  function budgetFor(precision, variant) {
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
      // Sliced frames can stop at their slice-time cap with budget unspent; fitting says nothing then.
      ladderBudgets[key] = makeWorkBudget(seed, floor, MAX_PIXEL_BUDGET, sliced ? 0.5 : 0);
    }
    return ladderBudgets[key];
  }
  var ladderBudget = budgetFor("f32", "standard");

  // Returns how many periods the previous work frame took (0 if none), for adaptSliceSteps.
  function noteFrameTiming(b, now) {
    var tookPeriods = 0;
    if (b.lastWorkAt > 0 && b.lastSpent > 0) {
      var dt = now - b.lastWorkAt;
      // NOT rounded to whole periods: outside strict vsync a 1.3-period frame would round to 1 and grow the budget.
      var periods = Math.max(1, dt / frameTargetMs(now));
      tookPeriods = periods;
      perfStats.workFrameMs = perfStats.workFrameMs > 0 ? perfStats.workFrameMs * 0.8 + dt * 0.2 : dt;
      perfStats.workFrameMaxMs = Math.max(perfStats.workFrameMaxMs, dt);
      if (b.gpuPerMs > 0) {
        b.lastWorkAt = now;
        return tookPeriods;
      }
      if (periods > OVERRUN_RATIO) {
        // A real measurement of how much work fits in one period.
        var measured = b.lastSpent / periods;
        // A frame several periods long is not noise: taken at face value, or the next frames keep overshooting.
        var blend = periods > HARD_OVERRUN_RATIO ? 1 : BUDGET_SMOOTHING;
        b.throughput = b.throughput > 0
          ? b.throughput * (1 - blend) + measured * blend
          : measured;
        b.budget = b.throughput * BUDGET_SAFETY;
      } else if (b.lastSpent >= b.budget * b.growMinUse) {
        // Fit, by an unknowable margin: creep upward. growMinUse stops playback growing on frames that spent little.
        b.budget *= BUDGET_GROW;
        b.throughput = Math.max(b.throughput, b.budget / BUDGET_SAFETY);
      }
      b.budget = clamp(b.budget, b.min, b.max);
    }
    b.lastWorkAt = now;
    return tookPeriods;
  }

  // Left = where refinement starts (0% = one sample for the screen), right = where it stops (100% = one sim/pixel).
  function strideLadderLength() {
    // Halvings from COARSEST_STRIDE to 1, capped at one sample for the whole canvas.
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
    // A movie still (renderStill) has no use for coarse levels; each costs a run's latency.
    if (stillJob) return endStride();
    return Math.max(sliderValueToStride(Number(resolutionMinSlider.value)), endStride());
  }
  function endStride() {
    // A movie's frames are finished at the movie's own quality, whatever this page's limits say.
    if (stillJob) return 1;
    return sliderValueToStride(Number(resolutionMaxSlider.value));
  }
  // Settings > Performance > Antialiasing, except a movie frame, which says for itself.
  function antialiasWanted() { return stillJob ? stillJob.antialias : perf.antialias; }

  // Allocated at the largest size ever needed and used at sub-rectangles: texelFetch is explicit, so that is free.
  var accum = [null, null];   // {tex, fbo}
  var accumIndex = 0;         // which of the two currently holds the live image
  var sublattices = [];       // three {tex, fbo}, indexed 0..2 for sub-lattices 1..3
  var allocatedFor = { w: 0, h: 0 };
  var compositeProgram = null;

  function makeTarget(w, h, internalFormat, type) {
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat || gl.RGBA8, w, h, 0,
      gl.RGBA, type || gl.UNSIGNED_BYTE, null);
    // NEAREST, never mipmapped: interpolating point samples of a chaotic field invents colors.
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
  // Folds the accumulator and the three new sub-lattices into one image at the NEW level's size (all composites of a
  // run total 4/3 of a screen). One of each new quadruple is already held, so every pixel is simulated exactly once.
  var COMPOSITE_FRAGMENT_SOURCE = [
    "#version 300 es",
    "precision highp float;",
    "uniform sampler2D u_accum;",
    "uniform sampler2D u_subA;",
    "uniform sampler2D u_subB;",
    "uniform sampler2D u_subC;",
    // How many of the three sub-lattices are drawn (0..3); the rest fall back to the coarser level.
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

  // (Re)allocates every target to the canvas; false if anything failed, so the caller draws nothing.
  function ensureTargets() {
    if (canvas.width <= 0 || canvas.height <= 0) return false;
    if (allocatedFor.w === canvas.width && allocatedFor.h === canvas.height && accum[0]) return true;
    releaseTargets();
    try {
      if (!compositeProgram) compositeProgram = buildCompositeProgram();
      // Full res: the final level's composite output is the whole grid.
      accum[0] = makeTarget(canvas.width, canvas.height);
      accum[1] = makeTarget(canvas.width, canvas.height);
      // Half the full-res grid each way is the largest a sub-lattice needs; ceil so an odd size keeps its last row.
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
  // Extra whole-screen passes offset by fractions of a pixel, averaged: an area estimate, nothing interpolated.
  // Sub-pixel chaos averages toward gray, which is truthful. Runs once the ladder settles; sample 0 is the render.
  var MAX_AA_SAMPLES = 4;
  var aaAccum = null;       // RGBA16F, full res: the running average
  var presentProgram = null;

  // Needs a float target: at 8 bits a 1/n blend rounds later samples away after about four.
  function antialiasSupported() { return hasFloatColorBuffer; }

  // R2 low-discrepancy sequence: even coverage without random clumping or a grid's axis alignment. i=0 is the center.
  var R2_A1 = 0.7548776662466927;   // 1/phi2,   phi2 = the plastic number
  var R2_A2 = 0.5698402909980532;   // 1/phi2^2
  function aaOffset(i) {
    if (i === 0) return { x: 0, y: 0 };
    return {
      x: ((0.5 + R2_A1 * i) % 1) - 0.5,
      y: ((0.5 + R2_A2 * i) % 1) - 0.5,
    };
  }

  // Texture -> bound framebuffer, one texel per pixel: blitFramebuffer refuses float-to-fixed conversion.
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

  function beginAntialias() {
    if (!ensureAaTarget()) return false;
    gl.bindFramebuffer(gl.FRAMEBUFFER, aaAccum.fbo);
    gl.disable(gl.BLEND);
    drawPresent(accum[accumIndex].tex, canvas.width, canvas.height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    progressive.aaSample = 1;
    return true;
  }

  // A constant-alpha blend of 1/n IS the running mean after n samples: one float target, no extra pass.
  function drawAaBand(pixelsAvailable) {
    // The whole screen, unless a pan reused pixels that were ALREADY antialiased; those are left alone.
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

  // Sample count of a level per axis; ceil so a partial last cell is still painted.
  function levelWidth(stride) { return Math.max(1, Math.ceil(canvas.width / stride)); }
  function levelHeight(stride) { return Math.max(1, Math.ceil(canvas.height / stride)); }

  // ---- Rendering progress ring ----
  // Checkpoints are pinned to strides 32px..1 (coarser reads as 0%); a run stopped short still fills once complete.
  var RENDER_RING_STRIDE_CHECKPOINTS = [32, 16, 8, 4, 2];
  var RENDER_RING_CIRCUMFERENCE = 2 * Math.PI * 17; // matches the r=17 circles in chaos.html

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

  // The ring's numbers as text for the open menu; "complete" rather than "4 of 4", which read as one more to come.
  function renderProgressLabelText() {
    if (progressive.complete) return "Rendering Complete";
    if (progressive.aaSample > 0) {
      return "Antialiasing Progress: " + Math.min(progressive.aaSample, MAX_AA_SAMPLES) +
        " of " + MAX_AA_SAMPLES + " samples per pixel";
    }
    var stride = progressive.accumStride || progressive.stride || startStride();
    return "Rendering Progress: " + (stride <= 1 ? "1 sim/px" : "1 sim per " + stride + "px");
  }

  // Called from presentFrame, so never more than a frame stale. During playback the ring reports playback instead.
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
    updateRenderProgressPrecision();
  }

  // Precision badge, following effectivePrecision (what is ACTUALLY drawn). Writes skipped while unchanged.
  var renderProgressPrecisionShown = null;
  function updateRenderProgressPrecision() {
    // Reachable from setup before the precision machinery is declared.
    if (!PRECISION_LADDER || !precisionMode) return;
    var precision = effectivePrecision();
    if (precision === renderProgressPrecisionShown) return;
    renderProgressPrecisionShown = precision;
    var extended = precision !== "f32";
    // Attributes, not the .hidden property: SVG elements have none.
    renderProgressGlyphs.forEach(function (use) {
      if (extended) use.setAttribute("href", "#precision-glyph-" + precision);
      else use.removeAttribute("href");
      if (extended) use.removeAttribute("hidden"); else use.setAttribute("hidden", "");
    });
    if (renderProgressPrecisionGlyph) {
      if (extended) renderProgressPrecisionGlyph.removeAttribute("hidden");
      else renderProgressPrecisionGlyph.setAttribute("hidden", "");
    }
    if (renderProgressPrecisionText) {
      renderProgressPrecisionText.textContent = PRECISION_TITLES[precision] +
        (extended ? ": Enables high zoom but loads " + PRECISION_SLOWDOWN[precision] + "X slower" : "");
    }
  }

  // Abandons the run in flight but NOT the picture on screen, so a pan never flickers through black.
  function resetProgressive() {
    // Picture reuse: decide, while the run's state still says what it reached, whether to keep its picture.
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

  // Starts a run. Even the coarsest level goes through the banded path: the left slider can be dragged to full res.
  function beginProgressive() {
    if (reuseEnabled) { reuseNoteImage(); reusePlanRun(); }
    if (isBouncesOutput) requestBounceMax();
    progressive.stride = startStride();
    // See SLICE_FIRST_LEVEL_SAMPLES: under slicing the coarsest levels cost as much as a useful one.
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
    // Both describe the view, not the image, so they belong with the start of a run.
    updateInspectMarkers();
    updatePrecisionReadout();
    beginPerfRun();
  }

  // Blits a level magnified by its stride. The destination is w*stride, NOT the canvas size: levelWidth rounds up,
  // so scaling to the canvas would squash each level differently and the image would creep. GL clips the overhang.
  function presentLevel(target, w, h, stride) {
    // blitFramebuffer honours the scissor box.
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, target.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.blitFramebuffer(0, 0, w, h, 0, 0, w * stride, h * stride, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  }

  // ---- Picture reuse: the machinery (see the state's own comment, above) ----

  function reuseLookKey() {
    return [sceneGeneration, renderedSteps(), simulationSteps, displayMode ? displayMode.id : 0,
      colorZoomEnabled ? 1 : 0, lowSaturationEnabled ? 1 : 0, bounceMaxValue, canvas.width, canvas.height].join(" ");
  }

  function reuseDropSource() {
    freeTarget(reuse.source);
    reuse.source = null;
    reuse.run = null;
  }

  // Called as a run starts. Not while the timeline moves: a run across several steps is a picture of none.
  function reuseNoteImage() {
    if (timeline.playing || timeline.following) { reuse.image = null; return; }
    reuse.image = {
      center: { x: view.center.x, xLo: view.center.xLo, y: view.center.y, yLo: view.center.yLo },
      scale: view.scale, look: reuseLookKey(), precision: effectivePrecision(),
    };
  }

  // to - from on one axis of two double-double centres: at the zoom limit a whole pan lives in the low halves.
  function reuseCentreDelta(from, to, axis) {
    var lows = PhysicsDF.twoSum64(to[axis + "Lo"], -from[axis + "Lo"]);
    return ((to[axis] - from[axis]) + lows[0]) + lows[1];
  }

  // Pixel p of this view shows source texel floor(a*(p+0.5)+b): a = ratio of scales, b = what is left over.
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
    // The same view at another precision asks what the OTHER arithmetic makes of it; no preview of that.
    if (a === 1 && bx === 0 && by === 0 && !samePrecision) return;
    // Exact when every sample this run wants is one the source HAS: same scale, pan a whole number of source samples.
    var sourceStride = reuse.stride;
    var snappedX = Math.round(bx / sourceStride) * sourceStride, snappedY = Math.round(by / sourceStride) * sourceStride;
    var exact = a === 1 && sourceStride >= 1 && sourceStride <= endStride() && samePrecision &&
      Math.abs(bx - snappedX) < 1e-4 && Math.abs(by - snappedY) < 1e-4;
    if (exact) { bx = snappedX; by = snappedY; }
    // The pixels of this view the source has something for.
    var x0 = clamp(Math.ceil(-bx / a - 0.5), 0, W), x1 = clamp(Math.ceil((W - bx) / a - 0.5), 0, W);
    var y0 = clamp(Math.ceil(-by / a - 0.5), 0, H), y1 = clamp(Math.ceil((H - by) / a - 0.5), 0, H);
    if (x1 <= x0 || y1 <= y0) return;
    // Of those, the ones whose source texel had been antialiased (see levelSimRegion).
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

  // The ladder wins once it has a finished level at least as fine as the source looks from here (ties to the ladder).
  function reuseLadderWins() {
    var run = reuse.run;
    if (!run) return true;
    if (run.ladderWon) return true;
    if (progressive.accumStride > 0 && progressive.accumStride <= Math.max(run.effStride, endStride())) run.ladderWon = true;
    return run.ladderWon;
  }

  // Called as a run is abandoned, BEFORE its state is cleared: keeps the ladder's picture if it bettered the source.
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
      gl.bindFramebuffer(gl.FRAMEBUFFER, reuse.source.fbo);
      drawPresent(aaAccum.tex, W, H);
    } else {
      // The last finished level, magnified as presentLevel does (mid-antialias: the accumulator, not the average).
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
    // Finished everywhere if the run was; otherwise only the rectangle this run skipped.
    reuse.aaRect = progressive.complete ? { x0: 0, y0: 0, x1: W, y1: H }
      : (stride === 1 && run && run.exact ? run.aa : null);
    reuse.image = null;
  }

  // The part of a level still to be SIMULATED, as rectangles in level coordinates, plus the rectangle the source
  // covers. The covered samples form one rectangle; what is left is at most four more around it.
  function levelSimRegion(stride, originX, originY, forAntialias) {
    var w = levelWidth(stride), h = levelHeight(stride);
    var whole = { rects: [{ x: 0, y: 0, w: w, h: h }], covered: null, rows: h };
    var run = reuse.run;
    if (!run || !run.exact) return whole;
    // An AA pass is only skipped where the source's pixels were already antialiased.
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

  // progressive.band counts rows through the region's rectangles in turn; this finds which one and how far.
  function locateBand(region, band) {
    for (var i = 0; i < region.rects.length; i++) {
      if (band < region.rects[i].h) return { rect: region.rects[i], row: band };
      band -= region.rects[i].h;
    }
    return null;
  }

  // Where sub-lattice k of a step from `stride` to stride/2 sits: half a cell across, down, or both.
  function sublatticeOrigin(k, stride) {
    var half = stride / 2;
    return { x: (k === 0 || k === 2) ? 0 : half, y: (k === 0 || k === 1) ? 0 : half };
  }

  // Rows the pass in progress has to draw: what progressive.band counts towards.
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
  // While the source is the better picture: source where it has a texel, else the ladder, else a dim edge smear.
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
    // Neither has this pixel yet (a strip a drag just exposed): the source's dimmed edge; black read as tearing.
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

  // Draws about `pixelsAvailable` more of the current level; returns the real cost (0: the level is done).
  function drawSublatticeBand(pixelsAvailable) {
    var k = progressive.sublattice;
    var w = levelWidth(progressive.stride);
    var h = levelHeight(progressive.stride);
    var target = k === 0 ? accum[accumIndex] : sublattices[k - 1];
    var origin = sublatticeOrigin(k, progressive.stride), originX = origin.x, originY = origin.y;
    // The whole level, unless a pan reuses the last picture: then only what it exposed.
    var region = levelSimRegion(progressive.stride, originX, originY, false);
    if (progressive.band === 0 && progressive.tileX === 0 && !progressive.tile) {
      reuseFillCovered(target, progressive.stride, originX, originY, region);
      if (region.rows === 0) return REUSE_FREE_COST;
    }
    var at = locateBand(region, progressive.band);
    if (!at) return 0;
    // Above float32: a slice of a tile rather than a band, see "Sliced rendering".
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

  // Composites into the spare accumulator at the finer size; the caller adopts it (level done) or only shows it.
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

  // Exactly one canvas update per frame: a panning frame walks a dozen levels, and only the last is seen.
  function presentFrame() {
    updateRenderProgressRing();
    if (progressive.aaSample > 0 && aaAccum) {
      drawPresent(aaAccum.tex, canvas.width, canvas.height);
      return;
    }
    var level = null;
    if (progressive.sublattice > 1) {
      level = runComposite(progressive.sublattice - 1);
    } else if (progressive.accumStride > 0) {
      level = { target: accum[accumIndex], w: levelWidth(progressive.accumStride),
        h: levelHeight(progressive.accumStride), stride: progressive.accumStride };
    }
    // Picture reuse: the last picture stays up until the ladder has bettered it.
    if (!reuseLadderWins()) presentWithSource(level);
    else if (level) presentLevel(level.target, level.w, level.h, level.stride);
  }

  function stepProgressive(now) {
    if (!ensureTargets()) return;
    if (progressive.stride === 0) beginProgressive();
    if (progressive.complete) {
      // Idle. Forgotten here, not in finishRun: during a drag every frame restarts AND completes a run.
      ladderBudget.lastWorkAt = 0;
      ladderBudget.lastSpent = 0;
      return;
    }

    // Each (precision, display mode) keeps its own budget rather than inheriting one tuned to something else.
    var drawingWith = budgetFor(effectivePrecision(), wantedVariant());
    if (drawingWith !== ladderBudget) {
      ladderBudget = drawingWith;
      ladderBudget.lastWorkAt = 0;
      ladderBudget.lastSpent = 0;
    }
    // See f32SlicedPending: nothing safe to draw yet.
    if (f32SlicedPending()) return;
    // Before the timing below: the interval should run from work issued to the GPU being free.
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

    // Antialiasing runs on the same budget and banding: a whole-screen sample costs as much as the whole ladder.
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

    // Always at least one band per frame, however tight the budget: forward progress beats the frame target.
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

  // Recorded here too: during a drag EVERY frame restarts and finishes a run, and the budget must still adapt.
  function finishRun(spent) {
    ladderBudget.lastSpent = spent || 0;
    // With antialiasing on this is only the first sample, and only once the ladder reached 1 sim/px (else it blurs).
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

  // A resize drops every target and restarts refinement. canvasArea can be display:none (shared document): then
  // skip and let the ResizeObserver call back. view.scale is world per canvas height, so a taller window keeps its
  // world; the small-window dock instead pins the top-left corner (pinViewCornerOnResize) so its sheet just covers.
  var pinViewCornerOnResize = false;
  function pinViewTopLeft(oldW, oldH, newW, newH) {
    if (!(oldW > 1 && oldH > 1)) return; // never sized before: nothing on screen to hold still
    var oldScale = view.scale;
    var newScale = clamp(oldScale * newH / oldH, MIN_SCALE, MAX_SCALE);
    // Corner = centre + (-W/2H, +1/2) view-heights; exact products, for zoomAtClientPoint's reason.
    shiftViewCenterByProducts(0.5 * (newW - oldW) / oldH, oldScale, 0.5, oldScale - newScale);
    view.scale = newScale;
    updateZoomReadout();
  }
  function resizeCanvas() {
    if (canvasArea.clientWidth <= 0 || canvasArea.clientHeight <= 0) return;
    var dpr = gridDpr();
    // A capped backing store stretched by a non-integer ratio looks wrong pixelated: smooth-scale it instead.
    canvas.classList.toggle("is-upscaled", dpr < (window.devicePixelRatio || 1));
    var w = Math.max(1, Math.round(canvasArea.clientWidth * dpr));
    var h = Math.max(1, Math.round(canvasArea.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      if (pinViewCornerOnResize) pinViewTopLeft(canvas.width, canvas.height, w, h);
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
      // Topography's pinned line survives a resize: it is anchored in world coordinates (statsOnViewChanged).
      statsResizing = true;
      markDirty();
      statsResizing = false;
      if (featureOverlayCanvas) drawFeatureOverlay();
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

  // Rescales so the world point under (clientX, clientY) stays put; shared by wheel and pinch.
  function zoomAtClientPoint(clientX, clientY, factor) {
    var uv = pixelToUV(clientX, clientY);
    var oldScale = view.scale;
    view.scale = clamp(view.scale * factor, MIN_SCALE, MAX_SCALE);
    // center' = center + uv*(oldScale - newScale), formed EXACTLY: a rounded product is a lasting error at deep zoom.
    shiftViewCenterByProducts(uv.uvx, oldScale - view.scale, uv.uvy, oldScale - view.scale);
  }

  // ---- Gestures first ----
  // WebGL has one queue, so prioritising a pan can only mean not ISSUING the render: with Prioritize panning on, a
  // frame mid-gesture just redraws the last picture moved to the view (presentWithSource); the ladder restarts after.
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
  // A gesture's whole frame, when it can be; false means this frame should be ordinary.
  function presentGestureFrame(now) {
    if (!reuseEnabled || stillJob || !gestureInProgress(now)) return false;
    // The ladder sits this frame out; an interval with no work must not read as a slow frame.
    function sitOut() {
      ladderBudget.lastWorkAt = 0;
      ladderBudget.lastSpent = 0;
      perfStats.presentOnlyAt = now;
      return true;
    }
    // A run in progress or finished means the view has not moved since: the right picture is up.
    if (progressive.stride !== 0 || progressive.complete) return sitOut();
    if (!ensureTargets()) return false;
    reusePlanRun();
    if (!reuse.run) return false;
    presentWithSource(null);
    updateInspectMarkers();
    return sitOut();
  }

  // ---- ...and never more than a frame behind ----
  // With Work per frame long, a frame is only issued once the GPU FINISHED the last (a fence), or the browser queues
  // a sixth of a second between the user and the screen. Nothing here runs at one display refresh.
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
    // A fence only signals once the commands ahead of it have been sent.
    gl.flush();
  }

  // Also registered on every .inspect-marker (they sit over the canvas), or hovering a marker blocks zooming.
  function onWheelZoom(e) {
    e.preventDefault();
    gesture.wheelAt = performance.now();
    zoomAtClientPoint(e.clientX, e.clientY, Math.pow(1.0016, e.deltaY));
    updateZoomReadout();
    markDirty();
  }
  canvas.addEventListener("wheel", onWheelZoom, { passive: false });

  // Pans by a CLIENT-pixel delta; shared by the mouse drag and both touch gestures.
  function panByClientDelta(dxPix, dyPix) {
    var scaleFactor = canvas.width / canvas.getBoundingClientRect().width;
    if (reuseEnabled) {
      // Snap to whole pixels (whole blocks at a small end stride) so old samples stay reusable; the remainder carries over.
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
  // Total movement below this is a click, not a drag.
  var CLICK_DRAG_THRESHOLD = 4;
  // A touch pans nothing until this far from the press point (distance, not path: a resting finger jitters); else it is a tap.
  var TOUCH_SLOP_PX = 10;
  var dragIsTouch = false, dragStartClientX = 0, dragStartClientY = 0;
  // False only for a touch that has not yet left its slop radius.
  var dragPastSlop = true;
  var inspectDragStartWorld = null;

  // Snapped to the hover preview's cell resolution; takes a plain {clientX, clientY} (a Touch works too).
  function snappedWorldPointFromEvent(e) {
    var uv = pixelToUV(e.clientX, e.clientY);
    return snappedWorldPointAtUV(uv.uvx, uv.uvy);
  }

  // ---- One-finger drag: mouse and single-touch share beginDrag/handleDragMove/endDrag ----
  function beginDrag(clientX, clientY, isTouch) {
    dragging = true;
    dragIsTouch = !!isTouch;
    dragStartClientX = lastClientX = clientX;
    dragStartClientY = lastClientY = clientY;
    dragDistance = 0;
    dragPastSlop = !dragIsTouch;
    if (inspectArmTakesDrag()) {
      inspectDragStartWorld = snappedWorldPointFromEvent({ clientX: clientX, clientY: clientY });
    } else {
      canvas.classList.add("dragging");
    }
  }
  function handleDragMove(clientX, clientY) {
    if (!dragPastSlop) {
      if (Math.hypot(clientX - dragStartClientX, clientY - dragStartClientY) < TOUCH_SLOP_PX) return;
      dragPastSlop = true;
      // Pick up from HERE: the slop is discarded, not delivered as a jump. No longer a tap.
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
      // Hidden BEFORE locking: each lock runs a GPU trajectory per point synchronously; a preview left up looks frozen.
      hideInspectPreview();
      var wasTap = dragIsTouch ? !dragPastSlop : dragDistance < CLICK_DRAG_THRESHOLD;
      if (wasTap) {
        // A plain click locks a point; with Line/Grid armed it only reminds (a real drag is
        // needed). A click on Topography's pinned line releases it instead.
        if (featurePinned && featurePinnedHit(clientX, clientY)) {
          if (statsPanel) statsPanel.unpin(); else setPinnedOverlay(null);
        }
        else if (inspectArmMode === "line") showInspectToast("Drag to inspect a line");
        else if (inspectArmMode === "grid") showInspectToast("Drag to inspect a grid");
        // Neither arms without the Inspect card open, so a collapsed card is checked explicitly here.
        else if (inspectMenu.isOpen()) {
          // A finger's tap only locks a point once Inspect (Point) is armed; unarmed it does nothing, silently.
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

  // ---- Touch: one finger pans (same drag functions as the mouse), two fingers pinch-zoom-and-pan ----
  // touch-action:none plus {passive:false}/preventDefault() on every listener, or the page's own scroll/pinch fights the gesture.
  // A pinch is midpoint + distance only: pan by the midpoint's travel, then zoom anchored at the NEW midpoint.
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
      // A second finger supersedes the first's pan or Inspect preview: a pinch is never an Inspect gesture.
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
      // old/new: view.scale is world per pixel, so spreading fingers must shrink it. Two fingers at one spot would divide by zero.
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
        dragging = false;
        canvas.classList.remove("dragging");
        hideInspectPreview();
        inspectDragStartWorld = null;
        pinchDistance = 0;
        return;
      }
      // changedTouches has the lifted finger's last position; e.touches is empty now.
      var last = e.changedTouches[0];
      endDrag(last.clientX, last.clientY);
      pinchDistance = 0;
    } else if (e.touches.length === 2) {
      pinchDistance = touchDistance(e.touches[0], e.touches[1]);
      var mid = touchMidpoint(e.touches[0], e.touches[1]);
      pinchMidX = mid.x; pinchMidY = mid.y;
    } else if (e.touches.length === 1) {
      // Two fingers to one: keep panning. Not while Line/Grid is armed: inspectDragStartWorld
      // was cleared at the pinch, so a resumed drag would preview from null.
      pinchDistance = 0;
      if (!inspectArmTakesDrag()) {
        dragging = true;
        dragIsTouch = true;
        lastClientX = e.touches[0].clientX;
        lastClientY = e.touches[0].clientY;
        // Never a tap: a pinch always ends with one finger resting briefly, which would otherwise lock an Inspect point.
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
    lowSaturationEnabled = false;
    lowSaturationCheckbox.checked = false;
    setDisplayMode(DISPLAY_MODES[0]);
    updateZoomReadout();
    markDirty();
  });

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
      text += progressive.complete
        ? " · " + progressive.aaSample + " samples/px"
        : " · averaging " + progressive.aaSample + "/" + MAX_AA_SAMPLES;
    } else if (progressive.stride > 0 && !progressive.complete) {
      text += " · at " + describeStride(progressive.stride);
    }
    resolutionBoundsReadout.textContent = text;
  }
  updateResolutionBoundsUI();

  // Moving a handle restarts refinement (markDirty, cheap per input tick). Handles may touch, never cross.
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
  // Drag updates only the readout; release applies: a top-end frame costs hundreds of ms and recompiles per locked point.
  function stepsFromSlider() { return Number(stepsSlider.value) * SIMULATION_STEPS_PER_NOTCH; }
  // Puts the control back in step with simulationSteps; the readout can be typed, so the slider rests on the nearest notch.
  function syncStepsUI() {
    stepsSlider.value = String(clamp(Math.round(simulationSteps / SIMULATION_STEPS_PER_NOTCH), Number(stepsSlider.min), Number(stepsSlider.max)));
    updateStepsUI(simulationSteps);
  }
  function updateStepsUI(value) {
    if (stepsReadout.value !== String(value)) stepsReadout.value = String(value);
  }
  // Locked points cached OLD-length trajectories: recompile in place, keeping colors. A failed point
  // group is removed; a line/grid point keeps its stale trajectory so the group's shape survives.
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
          if (!recomputed) continue;
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
  // On commit only: every intermediate number would be a full re-render.
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
    // A timeline at the end moves with the duration; one partway keeps its step unless it is now past the end.
    var timelineAtEnd = timeline.step >= simulationSteps;
    simulationSteps = next;
    if (timelineAtEnd || timeline.step > next) {
      stopTimelineClock();
      timeline.step = next;
    }
    if (timeline.stateStep > timeline.step) timeline.stateKey = null;
    updateTimelineUI();
    updateStepsUI(simulationSteps);
    // Duration belongs to the SCENE, and the editor has the same slider: write both or they drift.
    scene.simulationSteps = next;
    if (global.PhysicsUI && global.PhysicsUI.setSimulationSteps) {
      global.PhysicsUI.setSimulationSteps(next);
    }
    markDirty();
    if (inspectedGroups.length > 0) recomputeLockedTrajectories();
    else restartCurrentPreview();
  }

  colorZoomCheckbox.addEventListener("change", function () {
    colorZoomEnabled = colorZoomCheckbox.checked;
    if (colorZoomEnabled && activeTipId === "color-zoom") hideTip();
    // Color Zoom only changes Standard's ramp, so land on Standard; in the change event so keyboard and Reset View go through it too.
    setDisplayMode(DISPLAY_MODES[0]);
    markDirty();
  });

  lowSaturationCheckbox.addEventListener("change", function () {
    lowSaturationEnabled = lowSaturationCheckbox.checked;
    setDisplayMode(DISPLAY_MODES[0]);
    markDirty();
  });

  // ---- The Display Mode menu's rows ----
  // Built from DISPLAY_MODES so the GLSL MODE_* constants, sample counts and thumbnails can't drift. Each row is a radio.
  var displayModeRows = [];
  DISPLAY_MODES.forEach(function (mode) {
    // Standard's row hosts a checkbox, which a <button> may not contain: a <div> with the same role/tabIndex/click wiring.
    var isStandard = mode.value === "standard";
    var row = document.createElement(isStandard ? "div" : "button");
    if (!isStandard) row.type = "button";
    row.className = "display-mode-row";
    row.setAttribute("role", "radio");
    row.dataset.mode = mode.value;

    var img = document.createElement("img");
    img.src = "assets/" + mode.value + ".jpg";
    img.width = 400;
    img.height = 364;
    img.alt = "";
    row.appendChild(img);

    var text = document.createElement("span");
    text.className = "display-mode-text";
    var name = document.createElement("b");
    name.className = "display-mode-name";
    name.textContent = mode.label;
    text.appendChild(name);
    // The exact #color-zoom-checkbox from chaos.html, moved (not cloned) so its listeners keep working.
    if (isStandard) {
      text.appendChild(colorZoomField);
      text.appendChild(lowSaturationField);
    } else text.appendChild(document.createTextNode(mode.blurb));
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
      // Only the selected row is a tab stop (radiogroup pattern).
      entry.row.tabIndex = on ? 0 : -1;
    });
  }

  function setDisplayMode(mode) {
    if (mode === displayMode) return;
    displayMode = mode;
    syncDisplayModeUI();
    // Full restart: the accumulator holds the old mode's picture.
    markDirty();
  }

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

  // ---- Inspection Line Sample Count: read on the NEXT Line drag; nothing on screen changes ----
  inspectLineSampleCountSlider.value = String(inspectLineSampleCount);
  inspectLineSampleCountReadout.textContent = String(inspectLineSampleCount);
  inspectLineSampleCountSlider.addEventListener("input", function () {
    inspectLineSampleCount = Number(inspectLineSampleCountSlider.value);
    inspectLineSampleCountReadout.textContent = String(inspectLineSampleCount);
  });

  // ---- Grid Settings (Grid Size, Two Part Line) ----
  // Read on the NEXT drag; an existing grid is never touched. The Inspect (Grid) tooltip is kept in sync.
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
  // Volume is shared with the editor's controls; onVolumeChange keeps every control in sync.
  function setVolumeIconState(container, volume) {
    var muted = volume <= 0;
    // Explicit "inline", not "": .vol-mute-x's stylesheet default is display:none.
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
  // Two stages so a fast cursor never queues WebGL recompiles: step-0 state via computeOffsetSceneNumeric
  // (pure JS) instantly; after HOVER_UPGRADE_DELAY_MS on the same cell, compileHoverTrajectoryGLSL and
  // replay the logged trajectory. The preview is t=0 and the replay's first row is one step later.

  var HOVER_UPGRADE_DELAY_MS = 500; // cursor dwell time before the cheap preview is upgraded to the real WebGL replay
  // Per-step hold during a replay: flat, so a replay's length is proportional to its step count.
  var HOVER_MS_PER_FRAME = 11;

  // The replay logs every step into a (numBodies x steps) texture: cap at the GPU's max texture size (WebGL2 guarantees only 2048).
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
  var REPLAY_LOOP_DELAY_MS = 1500;
  var hoverLoopTimer = null;
  var hoverUpgradeTimer = null;
  var hoverKey = null; // last (snapped) world point currently shown (instant preview or replay): skips redundant work while the cursor sits still or jitters within one cell
  var hoverWorldPoint = null; // the actual {x,y} behind hoverKey: kept alongside it so restartCurrentPreview can re-run runHoverAt without needing the cursor to still be there
  var isHoveringGrid = false; // true between the canvas's own mousemove and mouseleave: lets a locked-point edit made from the sidebar (while the cursor is over it, not the grid) refresh beginInspectOnlySession instead of leaving it showing a stale frame

  // ---- Playback controls (Play/Pause, Progress, Reset) ----
  // One player for whatever the panel shows (hovered replay, inspected points, or both); playbackStep is the
  // shared clock, each entry clamped to its own effectiveMaxStep. activeReplay is null in the empty state and in Inspect-only mode.
  var activeReplay = null;
  // 0-indexed step shown: a float while auto-advancing, floored where used as an index.
  var playbackStep = 0;
  var playbackPlaying = false;
  var playbackLastTickTime = 0;
  // hoverStepCount() at session start, NOT playbackClockCeiling(): the slider always spans the
  // configured duration, so an early stop shows as a thumb resting short.
  var playbackConfiguredMax = 1;
  // False only in the true empty state: disables all three controls.
  var playbackHasSession = false;
  // Stamped when code (not a click) starts playback: a Pause within PLAY_PAUSE_GRACE_MS is dropped as an intended Play.
  var playbackAutoStartedAt = -Infinity;
  var PLAY_PAUSE_GRACE_MS = 300;

  function updatePlayPauseButtonUI() {
    setPlayPauseIcon(hoverPlayPauseBtn, playbackPlaying);
    hoverPlayPauseBtn.title = playbackPlaying ? "Pause" : "Play";
    hoverPlayPauseBtn.setAttribute("aria-label", playbackPlaying ? "Pause" : "Play");
  }

  // ---- Playback speed ----
  // A multiplier on the base rate, read fresh every tick. ONE speed for both Inspect's transport and the
  // Map Evolution timeline; each button is a view of it (like the two volume controls).
  var SPEED_MIN = 0.5, SPEED_MAX = 16;
  // log2(speed) space with step=1: equal travel per doubling, only whole powers of two.
  var SPEED_LOG_MIN = Math.log2(SPEED_MIN), SPEED_LOG_MAX = Math.log2(SPEED_MAX);
  function sliderValueToSpeed(v) { return Math.pow(2, v); }
  function speedToSliderValue(speed) { return Math.log2(speed); }

  function formatSpeed(v) {
    return (v < 2 ? v.toFixed(1) : String(Math.round(v))) + "x";
  }

  var playbackSpeed = 1;
  var speedRenderers = [];
  function updateSpeedUI() {
    speedRenderers.forEach(function (render) { render(); });
  }
  function setPlaybackSpeed(v) {
    playbackSpeed = clamp(v, SPEED_MIN, SPEED_MAX);
    updateSpeedUI();
  }

  function makeSpeedControl(button, popup, slider, valueEl) {
    // The HTML hardcodes matching min/max/step for a flash-free first paint; set from the same constants so they can't drift.
    slider.min = String(SPEED_LOG_MIN);
    slider.max = String(SPEED_LOG_MAX);
    slider.step = "1";

    speedRenderers.push(function () {
      var text = formatSpeed(playbackSpeed);
      button.textContent = text;
      valueEl.textContent = text;
      slider.value = String(speedToSliderValue(playbackSpeed));
    });

    // position:fixed, so placed by hand like positionTip: centered above the button, clamped to the window, below if no room.
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

  // Auto-advance ceiling: the latest final frame on screen. Recomputed per call, since inspected points change under a running session.
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

  // A JS copy of colorMap's hue (hueRangeMaxValue: 360 for a wrapping Output, 300 for a capped one).
  // OKLCH, not HSL, for this animated window: HSL lightness isn't perceptually uniform, so a sweeping
  // hue would flash. Under Color Zoom the hue repeats 10x; chroma/lightness stay fixed.
  function hoverOutputColor(t) {
    var hue = colorZoomEnabled ? hueRangeMaxValue * (1 - (t * 10 % 1)) : hueRangeMaxValue * (1 - t);
    return "oklch(60% 0.136 " + hue.toFixed(2) + ")";
  }

  // The exact grid color (colorMap's HSL): only for the FINAL frozen frame, where nothing flashes and
  // the swatch can match the pixel. In a derived display mode it still shows the value's own color.
  function hoverOutputColorFinal(t) {
    var hue, sat;
    if (colorZoomEnabled) {
      hue = hueRangeMaxValue * (1 - (t * 10 % 1));
      sat = t * 0.6 + 0.4;
    } else {
      hue = hueRangeMaxValue * (1 - t);
      sat = 1;
    }
    if (lowSaturationEnabled) return lowSaturate(hslToRgb(hue, sat, 0.5));
    return "hsl(" + hue.toFixed(2) + ", " + (sat * 100).toFixed(2) + "%, 50%)";
  }

  function hslToRgb(h, s, l) {
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var hp = h / 60;
    var x = c * (1 - Math.abs(hp % 2 - 1));
    var rgb;
    if (hp < 1) rgb = [c, x, 0];
    else if (hp < 2) rgb = [x, c, 0];
    else if (hp < 3) rgb = [0, c, x];
    else if (hp < 4) rgb = [0, x, c];
    else if (hp < 5) rgb = [x, 0, c];
    else rgb = [c, 0, x];
    var m = l - c * 0.5;
    return [rgb[0] + m, rgb[1] + m, rgb[2] + m];
  }

  // The shader's lowSaturate, line for line; see the GLSL for why the browser's oklab() is not used.
  var LOW_SAT_L = 0.70, LOW_SAT_C = 0.20, LOW_SAT_KEEP = 0.5;
  function lowSaturate(srgb) {
    var lin = srgb.map(function (v) { return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    var lms = [
      0.4122214708 * lin[0] + 0.5363325363 * lin[1] + 0.0514459929 * lin[2],
      0.2119034982 * lin[0] + 0.6806995451 * lin[1] + 0.1073969566 * lin[2],
      0.0883024619 * lin[0] + 0.2817188376 * lin[1] + 0.6299787005 * lin[2],
    ].map(function (v) { return Math.cbrt(Math.max(v, 0)); });
    var L = 0.2104542553 * lms[0] + 0.7936177850 * lms[1] - 0.0040720468 * lms[2];
    var a = 1.9779984951 * lms[0] - 2.4285922050 * lms[1] + 0.4505937099 * lms[2];
    var b = 0.0259040371 * lms[0] + 0.7827717662 * lms[1] - 0.8086757660 * lms[2];
    var C = Math.sqrt(a * a + b * b);
    var dirA = C > 1e-6 ? a / C : 1, dirB = C > 1e-6 ? b / C : 0;
    var L2 = LOW_SAT_L + (L - LOW_SAT_L) * LOW_SAT_KEEP;
    var C2 = LOW_SAT_C + (C - LOW_SAT_C) * LOW_SAT_KEEP;
    var a2 = dirA * C2, b2 = dirB * C2;
    var l_ = L2 + 0.3963377774 * a2 + 0.2158037573 * b2;
    var m_ = L2 - 0.1055613458 * a2 - 0.0638541728 * b2;
    var s_ = L2 - 0.0894841775 * a2 - 1.2914855480 * b2;
    var l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
    var out = [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
    ].map(function (v) {
      v = Math.min(1, Math.max(0, v));
      return Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055));
    });
    return "rgb(" + out.join(", ") + ")";
  }

  // Mirrors the shader's mod(outputValue, OUTPUT_RANGE_MAX) / OUTPUT_RANGE_MAX with the always-positive wrap.
  function outputColorT(v) {
    // Lifespan is clamped, not wrapped (its max means "ran the whole run"); Bounce Count scales by the grid's own u_bounceMax.
    if (isBouncesOutput) return Math.min(1, Math.max(0, v / bounceMaxValue));
    var rangeMax = currentOutputRangeMax();
    if (scene.output.property === "lifespan") return Math.min(1, Math.max(0, v / rangeMax));
    // Infinite Space: an unbounded coordinate is squashed by the shader's own curve, not wrapped.
    if (isInfinitePositionOutput) return PhysicsEngine.frameSigmoid(v / rangeMax);
    return PhysicsHingeGeometry.wrapIntoRange(v, rangeMax) / rangeMax;
  }

  // Stops any animation without touching what is shown: always a prelude to something else.
  function stopHoverReplay() {
    if (hoverRafId) cancelAnimationFrame(hoverRafId);
    hoverRafId = null;
    if (hoverLoopTimer) clearTimeout(hoverLoopTimer);
    hoverLoopTimer = null;
    playbackPlaying = false;
  }

  function showHoverEmpty(message) {
    stopHoverReplay();
    releaseMapFollow();
    if (hoverUpgradeTimer) { clearTimeout(hoverUpgradeTimer); hoverUpgradeTimer = null; }
    hoverKey = null;
    activeReplay = null;
    playbackStep = 0;
    setPlaybackControlsEnabled(false);
    updatePlayPauseButtonUI();
    updateProgressSliderPosition();
    hoverEmptyState.hidden = false;
    // Asked fresh each time: a tablet can gain or lose a mouse.
    hoverEmptyState.textContent = message || (global.LayoutMode && !global.LayoutMode.canHover()
      ? "Press Inspect (Point), then tap the map to see that spot\u2019s simulation"
      : "Hover the grid to preview a pixel");
    // A placeholder, not blank: an empty line would collapse and reflow everything below.
    hoverReadout.textContent = "X: 0, Y: 0";
    hoverCanvas.style.backgroundColor = "";
    hoverCtx.setTransform(1, 0, 0, 1, 0, 0);
    hoverCtx.clearRect(0, 0, hoverCanvas.width, hoverCanvas.height);
  }

  // One fixed camera from the authored scene, so hover points are comparable and a big swing moves off-canvas instead of re-fitting.
  var hoverFit = (function computeFixedHoverFit() {
    var minX, maxX, minY, maxY;
    if (scene.frameWidth && scene.frameHeight) {
      // A locked frame is a real wrap boundary: fit it so a wrap shows as a body reappearing on the far edge.
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

  // drawHoverBody: type/isAnchored come from the authored scene, x/y/angle/half from the trajectory row;
  // colorOverride replaces the isAnchored colors so an inspected point reads as "the other scene".
  // MIN_DISPLAY_RADIUS matches physics-ui.js's: a radius-linked Input routinely lands near zero.
  var MIN_DISPLAY_RADIUS = 15;

  // Arrows for Input/Output bodies that left the frame: the twin of physics-ui.js's (shared
  // offscreenPointer). One arrow per BODY, not per mapping.
  var OFFSCREEN_ARROW_MAX_FRACTION = 0.12;

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
    // Widths are in scene units (the panel transform scales them), so divide by the scale.
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

  // Splitter rows are MAX_SIMULATION_BODIES wide: a slot past the authored bodies is a ball some split woke, half = 0 until then.
  function hoverBodySpec(i) {
    return scene.bodies[i] || { type: "circle", isAnchored: false };
  }
  function hoverRowIsLive(i, row) {
    return i < scene.bodies.length || row[i].half > 0;
  }

  function isTrapezoidType(type) { return type === "funnel" || type === "splitter"; }

  // A funnel/splitter's corners from the engine's own geometry; a trapezoid's `half` is size/2.
  function traceTrapezoid(row) {
    var e = PhysicsEngine.getFunnelEdges({ x: row.x, y: row.y, angle: row.angle, size: row.half * 2 });
    var corners = [e.mouth[0], e.mouth[1], e.throat[1], e.throat[0]];
    hoverCtx.beginPath();
    hoverCtx.moveTo(corners[0].x, corners[0].y);
    for (var i = 1; i < corners.length; i++) hoverCtx.lineTo(corners[i].x, corners[i].y);
    hoverCtx.closePath();
  }

  // ---- Solid for the Output's body, an outline for everything else ----
  // Two identical balls passing through each other are otherwise indistinguishable. Tracked slots: the Output's
  // bodies, or the whole lineage with a splitter; null when the Output names no body, and then nothing is hollowed.
  function trackedBodySlots(lineageSlots) {
    var heads = PhysicsEngine.outputBodyIndices(scene.output);
    if (!heads.length) return null;
    var tracked = {};
    (lineageSlots ? [].concat.apply([], lineageSlots) : heads).forEach(function (slot) { tracked[slot] = true; });
    return tracked;
  }
  function isHollow(tracked, i) { return !!tracked && !tracked[i]; }

  var HOLLOW_OUTLINE_WIDTH = 2.5;
  // A wider dark ring under every outline: a lone light ring vanishes where the background hue matches.
  var HOLLOW_UNDERLAY = "rgba(0, 0, 0, 0.6)";
  var HOLLOW_UNDERLAY_EXTRA = 2.5;

  // A thick stroke as an outline: stroke, then clear its inside (destination-out) so the background shows through.
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
      // Display floor only; the simulation used the real radius. A line's `half` is half-LENGTH, left alone.
      hoverCtx.arc(row.x, row.y, Math.max(row.half, MIN_DISPLAY_RADIUS), 0, Math.PI * 2);
      hoverCtx.fill();
      hoverCtx.stroke();
    } else if (isTrapezoidType(spec.type)) {
      hoverCtx.lineCap = "round";
      hoverCtx.lineJoin = "round";
      if (colorOverride) {
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
        // A stroked line has no fill to carry the hue: a wider black pass underneath, then the hue on top.
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

  // `rows` is indexed by AUTHORED body (a split ball keeps its spring on the slot it kept). An anchor
  // scales with a size-linked body: the row's half over the authored one.
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

  // Every inspected point's bodies at `step` (each capped to its own effectiveMaxStep), in its own color.
  // "grid" groups draw no bodies; their mesh is the separate pass below so it sits on top of every group.
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
        drawHoverSprings(shown, color);
        drawOffscreenMappingArrows(effective, color);
      });
    });

    // Grid mesh pass: points at the OUTPUT body's (x, y), joined by buildGridMeshSegments' pairs; a separate
    // pass so it paints over every group's bodies. Per-segment gradients, since endpoints drift apart.
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

  // The wrap boundary (PhysicsEngine.step), so a wrap reads as wrapped; a no-op without a locked frame.
  function drawFrameBoundary() {
    if (!scene.frameWidth || !scene.frameHeight) return;
    hoverCtx.strokeStyle = "rgba(255,255,255,0.25)";
    hoverCtx.lineWidth = 1.5 / hoverFit.scale;
    hoverCtx.strokeRect(0, 0, scene.frameWidth, scene.frameHeight);
  }

  // Cheap pure-JS path: the offset scene at t=0, no WebGL, fast enough for every mousemove; t=0 here is
  // the replay's first frame. A VELOCITY Input starts every pixel in the same place, so only this preview
  // draws the throw as an arrow (the editor's); in the replay the motion shows it.
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
      // The engine clamps speed on the first step: draw what it will start at.
      var cap = PhysicsEngine.speedCapFor(offsetScene);
      var len = cap > 0 ? Math.min(speed, cap) : speed;
      var ux = vx / speed, uy = vy / speed;
      var tipX = body.x + ux * len, tipY = body.y + uy * len;
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
    // No trajectory yet: controls paused-at-start and disabled until beginPlaybackSession; the slider range is set now so it isn't stale.
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
        // PhysicsGPU.shapeHalf, the quantity the shader packs into alpha; a trapezoid has no `length` (NaN drew nothing).
        half: PhysicsGPU.shapeHalf([body], 0),
      }, undefined, isHollow(previewTracked, i));
    });
    drawHoverSprings(offsetScene.bodies.map(function (body) {
      return { x: body.x, y: body.y, angle: body.angle, half: PhysicsGPU.shapeHalf([body], 0) };
    }));
    drawHoverInputVelocityArrows(offsetScene);
    drawInspectedAtStep(0);
    if (inspectedGroups.length > 0) {
      // Several scenes' Output values aren't reconciled into one background; each has its own color.
      hoverCanvas.style.backgroundColor = "";
    } else {
      // Lifespan is unknown before the replay: show "hasn't crossed yet" until the upgrade. Bounce Count is 0 at the start.
      var v0 = scene.output.property === "lifespan" ? simulationSteps
        : isBouncesOutput ? 0
        : PhysicsEngine.computeOutputValue(offsetScene, scene.output);
      hoverCanvas.style.backgroundColor = hoverOutputColor(outputColorT(v0));
    }
    hoverReadout.textContent = "X: " + worldPoint.x.toFixed(5) + ", Y: " + worldPoint.y.toFixed(5) + " - loading replay…";
  }

  // From the per-frame duration only (so replay length is proportional to step count), times
  // playbackSpeed. A rate, because the tick is wall-clock driven.
  function hoverStepsPerSecond() {
    return (1000 / HOVER_MS_PER_FRAME) * playbackSpeed;
  }

  // One frame at `playbackStep`, shared by the rAF loop and slider scrubs. An entry Sticky Edges stopped
  // early freezes at its effectiveMaxStep while the readout keeps the full length and the rest keeps going.
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
        var bodyRow = (isFinalFrame && activeReplay.wrapOverride && i === activeReplay.wrapOverride.bodyIndex)
          ? { x: activeReplay.wrapOverride.x, y: activeReplay.wrapOverride.y, angle: activeReplay.wrapOverride.angle, half: row[i].half }
          : row[i];
        if (!hoverRowIsLive(i, row)) continue;
        effectiveRow.push(bodyRow);
        shownRows[i] = bodyRow;
        drawHoverBody(hoverBodySpec(i), bodyRow, undefined, isHollow(replayTracked, i));
      }
      drawHoverSprings(shownRows);
      drawOffscreenMappingArrows(effectiveRow);
    }

    // step, not the capped hoveredStep: an inspected point keeps playing after the hovered scene froze.
    drawInspectedAtStep(step);

    if (inspectedGroups.length > 0) {
      hoverCanvas.style.backgroundColor = "";
    } else if (activeReplay) {
      // Lifespan is one fact about the whole run (known since findWrapStopStep): held for every frame.
      var v = activeReplay.lifespanValue !== null ? activeReplay.lifespanValue
        : activeReplay.bounceCounts ? activeReplay.bounceCounts[Math.min(hoveredStep, activeReplay.bounceCounts.length - 1)]
        : hoverOutputValue(row, activeReplay.lineageSlots, activeReplay.wrapOverride, isFinalFrame, activeReplay.extraWrapOverrides);
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
    // Every frame passes through here, so this one call keeps the map in lockstep; a no-op with Map Evolution shut.
    syncMapToInspection();
  }

  // Every trajectory on screen in the order its sound is pitched: hovered first, then Inspect points in list order.
  function activeVoiceEntries() {
    var entries = activeReplay ? [activeReplay] : [];
    inspectedGroups.forEach(function (group) { entries = entries.concat(group.points); });
    return entries;
  }

  // Sounds for steps newly reached between frames (auto-advance only, never scrubbing): fromStep < e <= toStep,
  // INCLUSIVE, since the clock caps at ceiling-1 and a strict < would drop every edge sound.
  function checkPlaybackSounds(fromStep, toStep) {
    if (PhysicsSound.isMuted() || toStep <= fromStep) return;
    var entries = activeVoiceEntries();
    var freqs = PhysicsSound.chordFrequencies(entries.length);
    entries.forEach(function (entry, i) {
      // bounceEvents covers the full configured run, so it can hold events past this entry's frozen final frame.
      var lastVisibleStep = entry.effectiveMaxStep - 1;
      var bounced = false;
      for (var e = 0; e < entry.bounceEvents.length; e++) {
        var ev = entry.bounceEvents[e];
        if (ev > lastVisibleStep) break; // sorted ascending, nothing further is reachable either
        if (ev > fromStep && ev <= toStep) { bounced = true; break; }
      }
      if (bounced) PhysicsSound.playBounce(freqs[i]);
      // The edge stop is one terminal event: only when first reached, and only for a genuine edge stop (wrapOverride).
      var finalStep = entry.effectiveMaxStep - 1;
      if (entry.wrapOverride && finalStep > fromStep && finalStep <= toStep) {
        PhysicsSound.playEdge(freqs[i]);
      }
    });
  }

  // Driven by elapsed wall-clock time, not steps per callback: rAF stretches under load, and total duration
  // must track hoverStepsPerSecond(). playbackStep is an accumulator, so it can be paused, seeked, resumed.
  function playbackTick() {
    // Inspected points can be cleared under a running Inspect-only preview: bail to the empty state.
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
      // With Map Evolution open this is the map's clock too, and a map run ends on its last frame;
      // Play from there restarts at 0. Inspect alone loops.
      if (playbackMenu.isOpen()) {
        playbackPlaying = false;
        updatePlayPauseButtonUI();
        syncMapToInspection();
        return;
      }
      hoverLoopTimer = setTimeout(function () {
        hoverLoopTimer = null;
        if (!playbackPlaying) return;
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
    if (playbackStep >= playbackClockCeiling() - 1) playbackStep = 0;
    playbackPlaying = true;
    updatePlayPauseButtonUI();
    ensurePlaybackAdvancing();
    syncMapToInspection();
  }

  // The one entry point for showing something new: starts at 0 so a newly added point is in sync, and
  // stops whatever was animating so a slow compile can't draw over a later session.
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

  // Bounce Count per step from the JS engine on the same offset scene (a GPU trajectory logs positions
  // only); the engines agree except on a grazing contact.
  function bounceCountsAt(worldPoint, steps) {
    try {
      var offsetScene = PhysicsGridCodegen.computeOffsetSceneNumeric(scene, worldPoint.x, worldPoint.y);
      return PhysicsEngine.runBounceCounts(offsetScene, scene.output.body, steps, PhysicsGPU.FIXED_DT);
    } catch (err) {
      return null; // same "a preview must never break the page" rule as showHoverInstant's own catch
    }
  }

  // Bounce sound events, also a JS re-simulation. Failure never costs the entry: an empty list just means no sound.
  function bounceEventsAt(worldPoint, steps) {
    try {
      var offsetScene = PhysicsGridCodegen.computeOffsetSceneNumeric(scene, worldPoint.x, worldPoint.y);
      return PhysicsEngine.runBounceEvents(offsetScene, steps, PhysicsGPU.FIXED_DT);
    } catch (err) {
      return [];
    }
  }

  // Which slots are in the Output's lineage: null without a splitter. The shader colors a splitter pixel by
  // the lineage AVERAGE, so the replay must too; the GPU trajectory carries no lineage tag, so the JS
  // engine supplies WHICH slots (the averaged values stay the GPU's).
  function outputLineageSlotsAt(worldPoint, steps) {
    var heads = PhysicsEngine.outputBodyIndices(scene.output);
    if (!PhysicsGPU.sceneHasSplitter(scene) || !heads.length) return null;
    try {
      var offsetScene = PhysicsGridCodegen.computeOffsetSceneNumeric(scene, worldPoint.x, worldPoint.y);
      var rows = PhysicsEngine.runTrajectory(offsetScene, steps, PhysicsGPU.FIXED_DT);
      var last = rows[rows.length - 1];
      // Grouped BY HEAD: a pair Output is the mean of two lineage averages, not a flat mean.
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

  // The Output value for one frame: a single read without a lineage, else the mean over members woken
  // so far (half = 0 until a split fills a slot).
  function hoverOutputValue(row, lineageGroups, wrapOverride, isFinalFrame, extraWrapOverrides) {
    var prop = scene.output.property;
    var heads = PhysicsEngine.outputBodyIndices(scene.output);
    var overrides = {};
    if (isFinalFrame && wrapOverride) overrides[wrapOverride.bodyIndex] = wrapOverride;
    (extraWrapOverrides || []).forEach(function (o) { if (isFinalFrame && o) overrides[o.bodyIndex] = o; });
    // Per authored head: its lineage average; on a wrap-stopped final frame the continuous reconstruction.
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
      // At the grid's current precision, so the replay is of the pixel under the cursor, not a float32 approximation.
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
      var initialAtPoint = PhysicsGridCodegen.computeOffsetSceneNumeric(scene, worldPoint.x, worldPoint.y);
      var watchedIndices = PhysicsHingeGeometry.wrapWatchedBodyIndices(scene);
      // Bounce Count and Lifespan aren't positions: findWrapStopStep picks the body that crossed.
      var heads = (isLifespan || isBouncesOutput) ? [] : PhysicsEngine.outputBodyIndices(scene.output);
      var targetBodyIndex = heads.length ? heads[0] : null;
      var wrapStop = PhysicsHingeGeometry.findWrapStopStep(trajectory, watchedIndices, targetBodyIndex, scene.frameWidth, scene.frameHeight, initialAtPoint.bodies, PhysicsGPU.FIXED_DT);
      if (wrapStop !== null) {
        stopStep = Math.max(1, wrapStop.step);
        wrapOverride = wrapStop;
        lifespanValue = wrapStop.step + wrapStop.tFrac / PhysicsGPU.FIXED_DT;
        // A pair Output needs BOTH halves reconstructed on the stopping frame, as the shader does.
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
      // With Map Evolution open a run is user-started: land on the first frame and wait.
    }, /* autoplay */ !playbackMenu.isOpen());
  }

  // Cursor off the grid with points inspected: keep playing them together instead of the empty state.
  // inspectedGroups is read fresh each frame, so removals show immediately.
  function beginInspectOnlySession() {
    beginPlaybackSession(null, /* autoplay */ !playbackMenu.isOpen());
  }

  canvas.addEventListener("mousemove", function (e) {
    isHoveringGrid = true;
    if (dragging) return; // don't fight panning, only preview while not dragging the view
    if (!inspectMenu.isOpen()) return;
    var uv = pixelToUV(e.clientX, e.clientY);
    var world = snappedWorldPointAtUV(uv.uvx, uv.uvy);
    // Keyed by CELL and view, not the point's digits: past float64 resolution every cell prints the same decimals.
    var key = world.cell + " " + viewCenterKey() + " " + view.scale;
    if (key === hoverKey) return; // already showing (or about to show) this exact cell
    hoverKey = key;
    hoverWorldPoint = world;
    // Updated above regardless, so removing the last inspected point can fall back to this cell; with any point locked the panel is theirs.
    if (inspectedGroups.length > 0) return;
    stopHoverReplay(); // a previous cell's replay may still be animating: don't let it keep drawing over the new cell's preview
    if (hoverUpgradeTimer) clearTimeout(hoverUpgradeTimer);
    showHoverInstant(world);
    hoverUpgradeTimer = setTimeout(function () {
      if (key !== hoverKey) return; // cursor moved on before the dwell delay elapsed: superseded
      runHoverAt(world);
    }, HOVER_UPGRADE_DELAY_MS);
  });
  canvas.addEventListener("mouseleave", function (e) {
    // Reaching the playback controls crosses out of the canvas, which must not end the session.
    // hoverSpeedPopup is position:fixed outside the row, so checked separately.
    if (e.relatedTarget && (hoverPlaybackControlsEl.contains(e.relatedTarget) || hoverSpeedPopup.contains(e.relatedTarget))) return;
    isHoveringGrid = false;
    // Moving onto the Inspect bar isn't "done looking" either. (The card may be in the dock, outside #menu-inspect.)
    if (e.relatedTarget && (inspectMenuEl.contains(e.relatedTarget) || inspectMenu.card.contains(e.relatedTarget)) && inspectedGroups.length > 0 && playbackHasSession) return;
    if (inspectedGroups.length > 0) { beginInspectOnlySession(); } else { showHoverEmpty(); }
  });

  // ---- Global Stats ----
  // Measures the fractal CURRENTLY ON SCREEN, so every number goes stale on a pan or zoom. Only while the
  // card is open, only the open section, starting once the view settles; never on the render path (idle
  // slices, GPU sampling banded by the ladder's budget, arithmetic stepped by fractal-stats.js); any view
  // change abandons the run. Measured from a float re-render (drawSampleRows), NOT the 8-bit canvas:
  // hue-ramped bytes are lossy, ambiguous under Color Zoom, and wrong where antialiasing blended hues.

  // ---- How finely to sample the view ----
  // A re-render at its own resolution: 1 sim/px measures exactly what is on screen; 1/8 costs a 64th. A
  // slider under Settings > Performance > Advanced. Full is the default: connected features need it.
  var STATS_SAMPLE_FRACTIONS = [
    { fraction: 1 / 8, label: "1/8" },
    { fraction: 1 / 4, label: "1/4" },
    { fraction: 1 / 2, label: "1/2" },
    { fraction: 1, label: "Full" },
  ];
  var statsSampleStop = STATS_SAMPLE_FRACTIONS.length - 1;

  // The canvas scaled by the fraction (same aspect: the Rose Plot is about direction), capped at 1 sample/px and one texture.
  function statsSampleBlock() {
    var f = STATS_SAMPLE_FRACTIONS[statsSampleStop].fraction;
    var cw = Math.max(1, canvas.width), ch = Math.max(1, canvas.height);
    return {
      width: Math.min(MAX_TEXTURE_SIZE, Math.max(8, Math.round(cw * f))),
      height: Math.min(MAX_TEXTURE_SIZE, Math.max(8, Math.round(ch * f))),
      full: f >= 1,
    };
  }

  // Settle time after the last view change; a pan that pauses briefly never triggers a run.
  var STATS_SETTLE_DELAY_MS = 400;
  // requestIdleCallback's deadline: reached on a busy page, runStatsSlice does a single step per callback.
  var STATS_IDLE_TIMEOUT_MS = 2000;
  // One degree per bin; the rose smooths for display but the peak comes from these.
  var STATS_ORIENTATION_BINS = 180;
  var STATS_HISTOGRAM_BUCKETS = 96;
  var STATS_MAX_BAND_SAMPLES = 262144;

  var statsPanel = null;        // the FractalStatsPanel instance, once built
  var statsResizing = false;    // true only while resizeCanvas's own markDirty runs
  var statsSampleSlider = document.getElementById("stats-sample-slider");
  var statsSampleReadout = document.getElementById("stats-sample-readout");
  function updateStatsSampleReadout() {
    if (!statsSampleReadout) return;
    var block = statsSampleBlock();
    statsSampleReadout.textContent = STATS_SAMPLE_FRACTIONS[statsSampleStop].label +
      " (" + block.width + " × " + block.height + ")";
  }
  var statsOpen = false;
  var statsRun = null;          // the measurement in flight, if any
  // Bumped by every view change: a slice from an older generation stops, which makes abandoning mid-slice safe.
  var statsGeneration = 0;
  var statsSliceHandle = null;
  var statsSettleTimer = null;
  var statsHasResult = false;
  var statsResultIsCurrent = false;
  var statsLastStatus = "";
  // Kept after the run is torn down: later section re-renders still map sample column/row to world.
  var statsLastWidth = 1, statsLastHeight = 1;

  var hasIdleCallback = typeof window.requestIdleCallback === "function";
  function requestStatsSlice(fn) {
    if (hasIdleCallback) return window.requestIdleCallback(fn, { timeout: STATS_IDLE_TIMEOUT_MS });
    // Safari before 16.4 has no idle callback: a short timeout, with each slice kept short.
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

  // Output units per unit of t. Exact where t is a plain division; under Infinite Space (a sigmoid) it is the frame dimension, not a constant ratio.
  function statsValueSpan() {
    return isBouncesOutput ? bounceMaxValue : currentOutputRangeMax();
  }

  // Every REPORTED number is in authored coordinates (origin at frame center, +y up, +rotation CCW;
  // physics-coords.js); everything upstream is engine space. Distance, lifespan and bounces pass through.
  function authoredOutputValue(v) {
    var prop = scene.output.property;
    if (prop === "x") return PhysicsCoords.toAuthoredX(v, scene);
    if (prop === "y") return PhysicsCoords.toAuthoredY(v, scene);
    if (prop === "angle") return PhysicsCoords.flipAngle(v);
    return v;
  }

  // Inverse of outputColorT, branch for branch. Not monotonic for every Output: with +y up, t = 0 is the
  // TOP of the frame (largest Center Y); callers wanting an ordered pair sort themselves.
  function statsValueForT(t) {
    if (isBouncesOutput) return authoredOutputValue(t * bounceMaxValue);
    var rangeMax = currentOutputRangeMax();
    if (scene.output.property === "lifespan") return authoredOutputValue(t * rangeMax);
    if (isInfinitePositionOutput) {
      // frameSigmoid's inverse, clamped off both ends (it only reaches 0 and 1 at infinity).
      var clamped = Math.min(1 - 1e-6, Math.max(1e-6, t));
      return authoredOutputValue(rangeMax * (0.5 - Math.log(1 / clamped - 1) / PhysicsEngine.OUTPUT_SIGMOID_STEEPNESS));
    }
    return authoredOutputValue(t * rangeMax);
  }

  function statsFormatValue(v) {
    if (v === null || v === undefined || !isFinite(v)) return "-";
    var prop = scene.output.property;
    if (prop === "angle") return (v * 180 / Math.PI).toFixed(1) + "°";
    if (prop === "lifespan") return Math.round(v).toLocaleString() + " steps";
    if (prop === "bounces") return (Math.round(v * 10) / 10).toLocaleString() + " bounces";
    var a = Math.abs(v);
    if (a !== 0 && (a < 1e-3 || a >= 1e6)) return v.toExponential(2);
    return (Math.round(v * 100) / 100).toLocaleString();
  }

  // ---- Finding the input seam, cheaply ----
  // The Input's settle-into-frame is a sawtooth in world coordinates (inputStateCrossesSeam); its resets are
  // perfectly straight false edges that would spike the rose at 0 and 90 degrees. Every seam is a line of
  // constant world X or Y, so one row and one column find them all, at a FIXED number of probes per axis
  // so the cost stays flat; a seam is located to within one probe spacing, all of which is excluded.
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
      // Nothing settles into the frame under Infinite Space: no seam to find.
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

  // The t of the Output's STARTING value as authored, for Topography's Return Line; null for a lifespan or bounce count.
  function statsReturnT() {
    var prop = scene.output.property;
    if (prop === "lifespan" || isBouncesOutput) return null;
    var v = PhysicsEngine.computeOutputValue(scene, scene.output);
    if (typeof v !== "number" || !isFinite(v)) return null;
    return outputColorT(v);
  }

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

  // Called from markDirty on every view change: cheap, and nothing while the card is closed.
  function statsOnViewChanged() {
    if (!statsPanel) return;
    // Hover drawings are in the measured block's coordinates, so they go the moment the view moves. The
    // pinned line survives a resize (anchored to the world) but not a pan or zoom.
    if (statsResizing) statsPanel.hoverOverlaysOff();
    else statsPanel.featureOverlayOff();
    statsGeneration++;
    statsResultIsCurrent = false;
    abandonStatsRun();
    if (!statsWantsWork()) return;
    if (statsHasResult) statsPanel.markStale();
    scheduleStatsRun();
  }

  // Starts a measurement once the view has held still. Does not wait for the ladder: the sampler re-renders the view itself.
  function scheduleStatsRun() {
    if (!statsWantsWork() || statsRun) return;
    statsPanel.setStatus("Measuring…", "loading");
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
    // Band height: half the ladder's adaptive pixel budget, capped by STATS_MAX_BAND_SAMPLES so memory doesn't grow with the slider.
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
      // Whether this result can MERGE into the panel's last one (same view and block) rather than replace it.
      merge: statsResultIsCurrent,
      seam: null,
      job: null,
    };
    statsPanel.setStatus("Measuring 0%", "working");
    scheduleStatsSlice();
  }

  // One percentage for the whole run: the three phases get fixed shares so it only moves one way.
  var STATS_PHASE_STARTS = [0, 0.4, 0.5, 1];
  function statsProgressText(phase, fraction) {
    var from = STATS_PHASE_STARTS[phase], to = STATS_PHASE_STARTS[phase + 1];
    var f = Math.min(1, Math.max(0, fraction));
    return "Measuring " + Math.round(100 * (from + (to - from) * f)) + "%";
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
    if (run.generation !== statsGeneration || dirty) { abandonStatsRun(); return; }

    // A timed-out idle callback means the page is NOT idle: do the smallest useful amount.
    var pressed = !!(deadline && deadline.didTimeout);
    var sliceStart = performance.now();
    function hasTimeLeft() {
      if (pressed) return false;
      if (deadline && deadline.timeRemaining) return deadline.timeRemaining() > 3;
      return performance.now() - sliceStart < 6;
    }

    if (run.phase === "sample") {
      // Per-band readback caps memory and, since readSampleBand blocks on the GPU, makes hasTimeLeft() measure real GPU time.
      while (run.row < run.height) {
        var drawn = drawSampleBand(run.target, run.width, run.height, run.row, run.bandRows, false);
        // Nothing drawn on the first band: the sampler went away (a precision switch); an untouched target would read as all zeros.
        if (drawn === 0) {
          abandonStatsRun();
          statsPanel.setStatus("Couldn't sample the view, nothing measured.", "stale");
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
          statsPanel.setStatus(statsProgressText(0, run.row / run.height), "working");
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
      while (!run.seam.step(pressed ? 1 : 8) && hasTimeLeft()) { /* keep going while the slice lasts */ }
      if (run.seam.axis !== 2) {
        statsPanel.setStatus(statsProgressText(1, run.seam.done / run.seam.total), "working");
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
        returnT: statsReturnT(),
      });
      run.phase = "analyze";
    }

    if (run.phase === "analyze") {
      var more = true;
      do { more = run.job.step(); } while (more && hasTimeLeft());
      if (more) {
        statsPanel.setStatus(statsProgressText(2, run.job.doneSteps / run.job.totalSteps), "working");
        scheduleStatsSlice();
        return;
      }
      finishStatsRun(run);
    }
  }

  function finishStatsRun(run) {
    var result = run.job.result;
    var sampleHeight = run.height;
    // sampleCoordToWorld normalises by the block's HEIGHT on both axes (like the shader's uv), so both are height ratios.
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
    statsLastStatus = info.seamsFound > 0
      ? info.seamsFound + " input-seam line" + (info.seamsFound === 1 ? "" : "s") +
        " excluded (see the X/Y Input mapping: those are where a starting position wraps back into the frame, not real edges)."
      : "";
    statsPanel.setStatus(statsLastStatus);
  }

  // Seam LINES, not excluded columns: a coarse probe spacing marks a span per seam.
  function countSeams(mask) {
    var n = 0;
    for (var i = 0; i < mask.length; i++) if (mask[i] && !mask[i - 1]) n++;
    return n;
  }

  // ---- The longest ridge / longest valley overlay ----
  // Hovering a Topography "Longest" row draws its path on the map (own 2D canvas, not the WebGL pipeline);
  // clicking pins it. Row 0 is the BOTTOM of the sample block, so y flips; the block is proportioned to
  // this canvas area, so a sample index maps to a CSS pixel by ratio.
  var featureOverlay = null;      // { width, height, path } or null: the hovered "Longest" row's line
  // PINNED by a click: kept until clicked again or the view pans/zooms. Held in WORLD coordinates (low
  // halves included) so a resize redraws it in place.
  var featurePinned = null;         // { world: Float64Array [x, y, xLo, yLo, ...] } or null
  var featurePinnedCss = null;      // the same projected to CSS pixels at the last draw, for hit-testing
  // Every sample of one Topography class, lit while its pie slice or legend line is hovered: { width, height, mask, cls }.
  var featureHighlight = null;
  // The highlight as a tiny image scaled by the GPU: a fillRect per sample would be a million per frame.
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
    var css = null;
    if (featureOverlay && featureOverlay.path && featureOverlay.path.length >= 4) {
      var W = featureOverlay.width, H = featureOverlay.height, path = featureOverlay.path;
      if (W > 0 && H > 0) {
        css = new Float64Array(path.length);
        for (var k = 0; k < path.length; k += 2) {
          css[k] = (path[k] + 0.5) / W * cw;
          css[k + 1] = (1 - (path[k + 1] + 0.5) / H) * ch;
        }
      }
    } else if (featurePinned) {
      var world = featurePinned.world;
      css = new Float64Array(world.length / 2);
      for (var m = 0, n = 0; m < world.length; m += 4, n += 2) {
        var pt = worldToCanvasAreaPixel(world[m], world[m + 1], world[m + 2], world[m + 3]);
        css[n] = pt.x; css[n + 1] = pt.y;
      }
      featurePinnedCss = css;
    }
    if (!css) return;

    function stroke(points, color, casing) {
      if (!points || points.length < 4) return;
      ctx.beginPath();
      for (var i = 0; i < points.length; i += 2) {
        if (i === 0) ctx.moveTo(points[i], points[i + 1]); else ctx.lineTo(points[i], points[i + 1]);
      }
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      // Casing in the opposite colour: white and black are the two no hue ramp contains. Wide on purpose: 6px read as a hairline.
      ctx.strokeStyle = casing;
      ctx.lineWidth = 12;
      ctx.stroke();
      ctx.strokeStyle = color;
      ctx.lineWidth = 6;
      ctx.stroke();
    }
    stroke(css, "#000000", "#ffffff");
  }

  // White at half strength over the hovered class, nearest-neighbour scaled: each sample IS a block of the map.
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
      // Row 0 of the block is the BOTTOM of the map; row 0 of an image is its top.
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

  function syncFeatureOverlayCanvas() {
    if (!featureOverlay && !featurePinned && !featureHighlight) {
      if (featureOverlayCanvas) {
        featureOverlayCanvas.parentNode.removeChild(featureOverlayCanvas);
        featureOverlayCanvas = null;
      }
      featureHighlightImage = null;
      featurePinnedCss = null;
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

  // Pins a path in block coordinates, converted to world once here: the block's mapping is only right for the canvas it was measured on.
  function setPinnedOverlay(data) {
    featurePinned = null;
    featurePinnedCss = null;
    if (data && data.path && data.path.length >= 4 && data.width > 0 && data.height > 0) {
      var grid = { width: data.width, height: data.height }, path = data.path;
      var world = new Float64Array(path.length * 2);
      for (var i = 0, j = 0; i < path.length; i += 2, j += 4) {
        var w = sampleCoordToWorld(grid, path[i], path[i + 1]);
        world[j] = w.x; world[j + 1] = w.y; world[j + 2] = w.xLo || 0; world[j + 3] = w.yLo || 0;
      }
      featurePinned = { world: world };
    }
    syncFeatureOverlayCanvas();
  }

  var PINNED_HIT_PX = 10;
  function featurePinnedHit(clientX, clientY) {
    var pts = featurePinnedCss;
    if (!featurePinned || !pts || pts.length < 4) return false;
    var rect = canvasArea.getBoundingClientRect();
    var x = clientX - rect.left, y = clientY - rect.top;
    var limit = PINNED_HIT_PX * PINNED_HIT_PX;
    var px = pts[0], py = pts[1];
    for (var i = 2; i < pts.length; i += 2) {
      var qx = pts[i], qy = pts[i + 1];
      var dx = qx - px, dy = qy - py, len2 = dx * dx + dy * dy;
      var u = len2 > 0 ? Math.max(0, Math.min(1, ((x - px) * dx + (y - py) * dy) / len2)) : 0;
      var ex = px + u * dx - x, ey = py + u * dy - y;
      if (ex * ex + ey * ey <= limit) return true;
      px = qx; py = qy;
    }
    return false;
  }

  if (statsPanelBodyEl && statsSampleSlider && global.FractalStatsPanel && global.FractalStats) {
    statsPanel = FractalStatsPanel.create({
      body: statsPanelBodyEl,
      host: {
        valueForT: statsValueForT,
        formatValue: statsFormatValue,
        // hoverOutputColorFinal is an exact copy of the shader's colorMap, so the swatch is the on-screen
        // color. Bounce Count's t can exceed 1 (its divisor comes from a coarser sample), so clamp.
        colorForT: function (t) { return hoverOutputColorFinal(Math.min(1, Math.max(0, t))); },
        labelForT: function (t) { return statsFormatValue(statsValueForT(t)); },
        worldAt: function (col, row) {
          return sampleCoordToWorld({ width: statsLastWidth, height: statsLastHeight }, col, row);
        },
        setFeatureOverlay: setFeatureOverlay,
        setFeatureHighlight: setFeatureHighlight,
        setPinnedOverlay: setPinnedOverlay,
      },
      onSectionChange: function () {
        if (!statsWantsWork()) return;
        if (statsResultIsCurrent && !statsPanel.needsMeasurement()) {
          if (!statsRun) statsPanel.setStatus(statsLastStatus);
          return;
        }
        // A run in flight that doesn't cover the new section never will (groups are fixed at job build): restart.
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
    // Dragging only re-labels; the measurement restarts on release.
    statsSampleSlider.addEventListener("input", function () {
      statsSampleStop = clamp(Number(statsSampleSlider.value) | 0, 0, STATS_SAMPLE_FRACTIONS.length - 1);
      updateStatsSampleReadout();
    });
    statsSampleSlider.addEventListener("change", function () {
      statsSampleStop = clamp(Number(statsSampleSlider.value) | 0, 0, STATS_SAMPLE_FRACTIONS.length - 1);
      updateStatsSampleReadout();
      statsResultIsCurrent = false;
      abandonStatsRun();
      if (statsHasResult) statsPanel.markStale();
      scheduleStatsRun();
    });

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

  // Drag #panel-resizer to resize the menu column; #canvas-area's ResizeObserver re-renders the grid.
  var PANEL_MIN_WIDTH = 220;
  var PANEL_MAX_WIDTH_FRACTION = 0.75;
  (function setUpPanelResize() {
    var dragStartX = 0;
    var dragStartWidth = 0;

    function onMove(e) {
      var maxWidth = window.innerWidth * PANEL_MAX_WIDTH_FRACTION;
      var width = clamp(dragStartWidth + (e.clientX - dragStartX), PANEL_MIN_WIDTH, maxWidth);
      document.documentElement.style.setProperty("--panel-width", width + "px");
      repositionActiveTip(); // a tip pointing at a sidebar element (e.g. Color Zoom) needs to follow it here: the anchor itself doesn't fire an event when the panel resizes around it
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
      // The column, not the stack: the stack's box includes shadow-room padding.
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
  // Every pixel's simulation state lives in float textures between frames
  // (playbackStateVariables): a step pass adds steps into a ping-pong pair, a
  // color pass paints it. Runs on a sub-lattice (playbackStride); pausing hands
  // the image to the ladder (seedLadderFromPlayback). State belongs to the view:
  // a pan/zoom/resize drops it and, after PLAYBACK_SETTLE_MS, it rebuilds
  // ("catching up"); going backward is a rebuild from step 0.

  // 1x is real time: one step per FIXED_DT.
  var PLAYBACK_STEPS_PER_SECOND = 1 / PhysicsGPU.FIXED_DT;
  // Any shorter and a slow drag restarts the rebuild on every mousemove.
  var PLAYBACK_SETTLE_MS = 250;
  // Both state copies together; playback coarsens its lattice until they fit.
  // Kept well short of what the GPU process will allocate: exhausting it crashes the browser.
  function playbackStateMaxBytes() { return perf.playbackMB * 1024 * 1024; }
  var BYTES_PER_STATE_TEXEL = 16; // RGBA32F, one layer
  // Most wall-clock time the clock owes steps for: a hitch costs playback, not a burst of catch-up.
  var PLAYBACK_MAX_CARRY_SECONDS = 0.25;
  // In pixel-steps, not shared with the ladder's (a different cost unit).
  var playbackBudget = makeWorkBudget(8000000, 20000, 4000000000, 0.5);
  var MAX_STATE_ATTACHMENTS = Math.min(gl.getParameter(gl.MAX_DRAW_BUFFERS), gl.getParameter(gl.MAX_COLOR_ATTACHMENTS));

  // Programs per precision, built on the first Play that needs them (null: couldn't build).
  var playbackGpu = {
    programs: {},
    textures: [null, null],
    current: 0, // which of the two holds the complete state
    fbo: null,
    width: 0,
    height: 0,
    layers: 0,
    viewKey: null,
  };

  function indentLines(lines, by) {
    return lines.map(function (l) { return by + l; });
  }

  // The step pass: advance each pixel by u_steps from u_state (or its starting state when u_init).
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
      "uniform vec2 u_resolution;",
      "uniform float u_gridStride;",
      "uniform vec2 u_gridOrigin;",
    ].concat(PhysicsDF.wordUniformDecls("u_center"), [
      "uniform float u_scale;",
      "uniform sampler2DArray u_state;",
      "uniform bool u_init;",
      "uniform int u_baseStep;",
      "uniform int u_steps;",
      "uniform int u_group;",
      // Lattice tile the state holds, and stencil texels per pixel (stateWorldCoordLines); playback: (0, 0), 1.
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
      // What the state deliberately leaves out: see loopStateVariables.
      indentLines(pieces.loopStateRestoreLines, "    "),
      // A still-running pixel's saved lifespan is the save's step count; add this draw's steps.
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
      "uniform int u_stateSteps;",
      "uniform float u_gridStride;",
      "uniform bool u_colorZoom;",
      "uniform bool u_lowSaturation;",
      "uniform int u_durationSteps;",
      "uniform float u_bounceMax;",
      "uniform int u_displayMode;",
      // Where texel (0, 0) lands in the TARGET, and state texels per target pixel; playback: (0, 0), 1.
      "uniform ivec2 u_targetOrigin;",
      "uniform int u_stencil;",
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
        // Derived modes from neighbouring TEXELS' saved values (re-simulating a
        // stencil is the cost playback exists to avoid). Neighbours are u_gridStride
        // full-res pixels apart, so differences are rescaled to per full-res pixel.
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
        // From a pixel's OWN five-point stencil (u_stencil == 5, texels +1..4 in STENCIL order): shadeDerived() exactly.
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
  var PLAYBACK_COLOR_UNIFORMS = ["state", "stateSize", "stateSteps", "gridStride", "colorZoom", "lowSaturation", "durationSteps", "bounceMax", "displayMode", "targetOrigin", "stencil", "sampleField"];

  function finishedPlaybackProgram(build, uniformNames) {
    var prog = build.program;
    var uniforms = {};
    uniformNames.forEach(function (name) { uniforms[name] = gl.getUniformLocation(prog, "u_" + name); });
    return { program: prog, posLoc: gl.getAttribLocation(prog, "a_position"), uniforms: uniforms };
  }

  // Both playback programs for one precision as a build in flight (startProgramBuild); df compiles too slowly to block.
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
    var stepFormats = [{ format: gl.RGBA32F, count: Math.min(entry.layers, MAX_STATE_ATTACHMENTS) }];
    var lastGroup = entry.layers - (entry.groups - 1) * MAX_STATE_ATTACHMENTS;
    if (entry.groups > 1 && lastGroup !== MAX_STATE_ATTACHMENTS) stepFormats.push({ format: gl.RGBA32F, count: lastGroup });
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

  // The programs, or null while "failed" or still "building" (playbackPlan tells them apart).
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
  // A df step is ~60us of sequential work per pixel, so a long run can't fit
  // one draw however few pixels it covers, and on an Apple GPU with its display
  // on a fragment tile shading past ~30-45ms is killed SILENTLY (no error, no
  // lost context, pixels never written; after a few the OS ignores the page's
  // GPU work until reload). So above float32 the grid is drawn with playback's
  // step + color programs, a tile at a time, a slice of steps per draw; ladder,
  // antialiasing and samplers all have sliced twins here (the hover replay is
  // the exception). Derived modes carry five state texels per pixel (shadeStencilDerived).
  var MAX_TEXTURE_SIZE = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  // Most state texels per tile: two textures of this x state layers x 16 bytes, ~30MB typical.
  var SLICE_MAX_TEXELS = 131072;
  // Steps per draw are MEASURED per scene and precision (calibrateSliceSteps),
  // steered several times under the limit above: a tile shades as slowly as its
  // slowest pixel. 5ms is the Longest single GPU draw setting's safest stop and
  // is held there on an Apple GPU; elsewhere watchdogs allow seconds and a longer draw is cheaper.
  var SLICE_TARGET_BASE_MS = 5;
  var gpuRendererName = (function () {
    try {
      var info = gl.getExtension("WEBGL_debug_renderer_info");
      return String((info && gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || "");
    } catch (err) {
      return "";
    }
  })();
  // By renderer name, or platform where the browser masks it (Safari: "Apple GPU"; an iPad says Mac).
  var drawLengthLocked = /apple|metal/i.test(gpuRendererName) ||
    /Mac|iPhone|iPad|iPod/.test((global.navigator && (global.navigator.platform || global.navigator.userAgent)) || "");
  function sliceTargetMs() {
    return drawLengthLocked ? SLICE_TARGET_BASE_MS : Math.max(SLICE_TARGET_BASE_MS, perf.drawMs || SLICE_TARGET_BASE_MS);
  }
  var SLICE_STEPS_MIN = 1;
  // At the base draw length; a longer draw may run proportionally more.
  var SLICE_STEPS_BASE_MAX = 256;
  function sliceStepsMax() { return Math.round(SLICE_STEPS_BASE_MAX * sliceTargetMs() / SLICE_TARGET_BASE_MS); }
  // A precision whose SINGLE step takes longer than this can't be drawn at all: off the ladder.
  function sliceSingleStepLimitMs() { return 3 * sliceTargetMs(); }
  // Calibration stops doubling once a slice takes this long: clear of the ~1ms round-trip cost.
  var SLICE_CALIBRATION_STOP_MS = 3;
  // A slice costs at least what its steps cost ONE pixel, so small tiles leave the GPU idle.
  // Tiles are at least this big where the level has that much left (steps per slice brought down to fit)...
  var SLICE_SATURATE_TEXELS = 32768;
  // ...the ladder starts no coarser than this many samples: every level is at least one full pass of slices...
  var SLICE_FIRST_LEVEL_SAMPLES = 4096;
  // ...and a frame stops issuing slices once their runs add up to this share of
  // its target length: the pixel budget thinks a tiny tile's slice is free; the GPU doesn't.
  var SLICE_FRAME_SHARE = 0.75;
  var sliceFrameMs = 0;
  function sliceFrameCapMs() { return frameTargetMs(performance.now()) * SLICE_FRAME_SHARE; }
  var SLICE_MIN_PIXEL_BUDGET = 16;

  // ---- Float32, when its whole run is too long for one draw ----
  //
  // The limit above is not about precision (a splitter's 20 body slots cost
  // ~0.4ms a step in float32), so float32 is timed too, once per scene and
  // display mode; a run that won't fit comfortably in one draw is sliced as well.
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
      perStep = Math.max((took - before) / (next - k), took / next / 8);
      k = next;
    }
    freeTarget(target);
    gl.viewport(0, 0, canvas.width, canvas.height);
    return perStep;
  }
  function f32NeedsSlicing() {
    if (!hasFloatColorBuffer || !accum || !accum[0]) return false;
    var variant = wantedVariant();
    if (f32StepMs[variant] === undefined) {
      if (!requestPass("f32", variant, true)) return false;
      var measureStartedAt = performance.now();
      f32StepMs[variant] = measureF32StepMs();
      perfStats.calibrationMs += performance.now() - measureStartedAt;
    }
    return f32StepMs[variant] * simulationSteps > f32SingleDrawLimitMs();
  }
  // Float32 needs the sliced programs and they are still building: the grid draws NOTHING meanwhile.
  function f32SlicedPending() {
    if (effectivePrecision() !== "f32" || !f32NeedsSlicing()) return false;
    var entry = playbackGpu.programs.f32;
    return !entry || entry.status === "building";
  }

  // Named state-texture pairs: "ladder" (the tile in flight, lives across frames)
  // and "sampler" (measurements, start and finish in one call: must not share).
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
    sliceSteps = {};
    sliceCalibrated = {};
    sliceTooHeavy = {};
    f32StepMs = {};
  }

  // Grow-only: reallocating two float array textures per size change costs more than the tile.
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

  // A tile of a lattice: cols x rows pixels at (tileX, tileY), stencil texels per pixel; the rest of spec is the pixel -> world mapping.
  function beginSliceJob(stateName, programs, spec) {
    var st = ensureSliceState(stateName, spec.cols * spec.stencil, spec.rows, programs.layers);
    return { state: st, programs: programs, spec: spec, done: 0, started: false };
  }

  // One step draw: up to `steps` more (the first also builds the starting state).
  // Returns steps run. `maxDraws` spreads a multi-group state over calls: a slice
  // left part-way returns 0 and resumes at its next group; state swaps after the last.
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
    // The viewport IS the tile: texel (0, 0) is the tile's first point.
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

  // The color pass into fbo at (x, y). opts.sample writes raw t; opts.blend = n averages in as the n-th AA sample.
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
    gl.uniform1i(u.lowSaturation, lowSaturationEnabled ? 1 : 0);
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

  // Steps one sliced draw may run at `precision`, by timing a small tile for
  // 1, 2, 4... steps with a readback after each; each timed slice is at most
  // double one seen to be short, so the measurement can't itself hang. Blocks the page, once per scene.
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
    // Best of two: the driver is still settling after a build, and one bad reading
    // used to leave a session at one step per slice. Per DRAW: a multi-group state is one draw per group.
    function timed(k) { return Math.min(timedSlice(k), timedSlice(k)) / programs.groups; }
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
      // The step's cost is the SLOPE between the last two timings; the fixed part (round trip, load/store) isn't per step.
      var perStep = k > 1 ? Math.max((took - before) / (k / 2), took / k / 8) : took;
      var fixed = Math.max(0, took - perStep * k);
      sliceSteps[precision] = clamp(Math.floor((targetMs - Math.min(fixed, targetMs / 2)) / perStep), SLICE_STEPS_MIN, stepsMax);
      perfStats.sliceStepMs = perStep;
    }
    perfStats.calibrationMs += performance.now() - calibrationStartedAt;
    sliceCalibrated[precision] = sliceSteps[precision];
    releaseSliceState("calibrate");
  }

  // Sliced programs to draw the GRID with, or null when the grid program should (float32, no float targets, or still building).
  function slicedProgramsForGrid() {
    var precision = effectivePrecision();
    if (!hasFloatColorBuffer) return null;
    if (precision === "f32") {
      if (!f32NeedsSlicing()) return null;
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
      // One step alone was too long: this precision is off the ladder for this scene.
      if (sliceTooHeavy[precision]) { updatePrecisionReadout(); markDirty(); return null; }
    }
    return entry.programs;
  }

  // The ladder's unit of work under slicing: one more slice of the tile in
  // flight (starting the next of `lattice` if none), plus the color pass when
  // its run finishes. Returns cost in whole simulated pixels (k of n steps =
  // k/n of the tile), never 0, which callers read as "nothing left".
  function drawSlicedTile(programs, lattice, pixelsAvailable) {
    var total = renderedSteps();
    var perDraw = sliceSteps[effectivePrecision()] || SLICE_STEPS_MIN;
    // See SLICE_FRAME_SHARE. Never before the frame's first slice; 0 means "stop here".
    if (sliceFrameMs >= sliceFrameCapMs()) return 0;
    var job = progressive.tile;
    // A slice can't be trimmed like a band: after the frame's first, the next goes only if most of it fits.
    if (sliceFrameMs > 0) {
      var nextCost = job ? job.spec.cols * job.spec.rows * Math.min(job.perDraw, total - job.done) / Math.max(total, 1)
                         : ladderBudget.budget;
      if (nextCost > pixelsAvailable * 2) return 0;
    }
    if (!job) {
      var at = locateBand(lattice.region, progressive.band), rect = at.rect;
      var stencil = displayMode.id !== 0 ? 5 : 1;
      var slices = Math.max(1, Math.ceil(total / perDraw));
      var maxPixels = Math.max(1, Math.floor(SLICE_MAX_TEXELS / stencil));
      var maxCols = Math.max(1, Math.floor(MAX_TEXTURE_SIZE / stencil));
      // Budget's worth or enough to keep the GPU busy, but never so many that a ONE-step slice overruns the frame.
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
      job.perDraw = clamp(Math.floor(ladderBudget.budget * total / Math.max(cols * rows, 1)), SLICE_STEPS_MIN, perDraw);
      progressive.tile = job;
    }
    // Calibrated count ~ sliceTargetMs() a draw; a frame issues only as many group draws as its cap allows.
    var sliceK = Math.min(job.perDraw || perDraw, perDraw);
    var drawMs = sliceTargetMs() * Math.max(job.nextGroup > 0 ? job.sliceSteps : sliceK, 1) / perDraw;
    var room = Math.max(1, Math.floor((sliceFrameCapMs() - sliceFrameMs) / drawMs));
    var ran = advanceSliceJob(job, sliceK, room);
    sliceFrameMs += drawMs * job.drawsIssued;
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

  // drawSampleBand's twin, in slices. Draws are only QUEUED: nothing waits until the caller reads back.
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

  // A step can get dearer later in a run (a split wakes more bodies): a bad
  // overrun with the budget at its floor means the draw itself is too long.
  // Halve it, never raise it, but only to a quarter of the measurement: overruns also come from GC and builds.
  var sliceOverrunsInARow = 0;
  function adaptSliceSteps(tookPeriods) {
    var precision = effectivePrecision();
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

  // Frees the state the moment it stops being useful (view moved, page left, scene changed).
  function releasePlaybackTextures() {
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

  function releaseAllPlayback() {
    stopTimelineClock();
    timeline.following = false;
    releasePlaybackTextures();
    releasePlaybackPrograms();
  }

  function playbackViewKey() {
    return [viewCenterKey(), view.scale, canvas.width, canvas.height].join(" ");
  }

  // State is worthless once the view moves: free it now rather than hold hundreds of MB.
  function releasePlaybackIfViewMoved() {
    if (playbackGpu.fbo && playbackGpu.viewKey !== playbackViewKey()) releasePlaybackTextures();
  }

  function ensurePlaybackTextures(w, h, layers) {
    if (playbackGpu.fbo && playbackGpu.width === w && playbackGpu.height === h && playbackGpu.layers === layers) return true;
    releasePlaybackTextures();
    while (gl.getError() !== gl.NO_ERROR) { /* drain */ }
    for (var i = 0; i < 2; i++) {
      var tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA32F, w, h, layers);
      // Float textures aren't filterable; asking makes the texture incomplete (texelFetch reads zero).
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

  // Playback's sub-lattice: never finer than one sample per CSS pixel or the Resolution
  // Limits setting, coarser until both state copies fit. A power of two: one of the ladder's levels.
  function playbackStride(layers) {
    var dpr = gridDpr();
    var stride = Math.max(endStride(), Math.pow(2, Math.floor(Math.log2(Math.max(1, dpr)))));
    while (stride < COARSEST_STRIDE &&
      2 * layers * BYTES_PER_STATE_TEXEL * levelWidth(stride) * levelHeight(stride) > playbackStateMaxBytes()) {
      stride *= 2;
    }
    return stride;
  }

  // What one playback frame needs, or null when playback can't run here. Allocates NO
  // state: that waits for the view to hold still (stepPlayback), or a resize reallocates every frame.
  function playbackPlan() {
    if (!hasFloatColorBuffer || !ensureTargets()) return null;
    var precision = effectivePrecision();
    var programs = playbackProgramsFor(precision);
    // Still building: "not yet", not "can't"; the ladder keeps the frame.
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

  function playbackLookKey(res) {
    return [res.key, timeline.stateStep, displayMode.id, colorZoomEnabled, lowSaturationEnabled, simulationSteps, bounceMaxValue].join(" ");
  }

  // Rows [band, band + rows) of one step pass into the non-current texture, one group per draw.
  function drawPlaybackBand(res, pass, rows) {
    var prog = res.programs.step, u = prog.uniforms;
    var layers = res.programs.layers;
    var target = playbackGpu.textures[1 - playbackGpu.current];
    gl.useProgram(prog.program);
    bindQuad(prog.posLoc);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, playbackGpu.textures[playbackGpu.current]);
    gl.uniform1i(u.state, 0);
    gl.uniform2f(u.resolution, canvas.width, canvas.height);
    gl.uniform1f(u.gridStride, res.stride);
    gl.uniform2f(u.gridOrigin, 0, 0);
    setCenterUniforms(u);
    gl.uniform1f(u.scale, view.scale);
    gl.uniform1i(u.init, pass.init ? 1 : 0);
    gl.uniform1i(u.baseStep, pass.from);
    gl.uniform1i(u.steps, pass.steps);
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
    gl.uniform1i(u.lowSaturation, lowSaturationEnabled ? 1 : 0);
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
    reuse.image = null;
  }

  // One frame of playback; false when not drawing this frame (paused, or view still moving): the ladder gets it.
  function stepPlayback(now) {
    timeline.drawing = false;
    if (!timeline.playing) return false;
    var dt = timeline.lastTickAt > 0 ? (now - timeline.lastTickAt) / 1000 : 0;
    timeline.lastTickAt = now;
    var res = playbackPlan();
    if (res && res.pending) {
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
      timeline.pass = null;
      timeline.carry = 0;
      if (now - timeline.seenAt < PLAYBACK_SETTLE_MS) {
        playbackBudget.lastWorkAt = 0;
        playbackBudget.lastSpent = 0;
        updateTimelineUI();
        return false;
      }
    }
    if (!ensurePlaybackTextures(res.w, res.h, res.programs.layers)) {
      setStatus(false, "Playback unavailable: not enough video memory for its state");
      stopTimelineClock();
      timeline.following = false;
      markDirty();
      updateTimelineUI();
      return false;
    }

    // The ladder's timing is meaningless across playback frames; left alone it would shrink its budget to nothing.
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
    while (spent < budget || spent === 0) {
      if (!timeline.pass) {
        var fresh = timeline.stateKey !== res.key;
        var have = fresh ? 0 : timeline.stateStep;
        var want = following ? Math.min(simulationSteps, timeline.followTarget)
          : (fresh || have < timeline.step) ? timeline.step
          : Math.min(simulationSteps, have + Math.floor(timeline.carry));
        if (!fresh && want <= have) break;
        if (fresh && isBouncesOutput) bounceMaxValue = findBounceMax();
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
      // Best effort: show whatever step the state reached; a slow GPU trails Inspect rather than freezing.
      catchingUp = timeline.stateKey !== res.key;
      timeline.catchingUp = catchingUp;
      timeline.catchUpFraction = 0;
      timeline.stride = res.stride;
      timeline.drawing = true;
      if (!catchingUp && (advanced || timeline.presentedKey !== playbackLookKey(res))) presentPlayback(res);
      updateRenderProgressRing();
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
    if (!catchingUp && timeline.step >= simulationSteps) pauseTimeline();
    else updateTimelineUI();
    return true;
  }

  // Hands playback's last image to the ladder as a finished level, so pausing
  // sharpens what is on screen. Only when it is exactly the ladder's picture, and
  // only in Standard: derived-mode playback shading approximates the stencil and would show a seam.
  function seedLadderFromPlayback() {
    if (displayMode !== DISPLAY_MODES[0] || !timeline.presentedKey) return false;
    var res = playbackPlan();
    if (!res || res.pending || timeline.stateKey !== res.key || timeline.stateStep !== timeline.step) return false;
    if (timeline.presentedKey !== playbackLookKey(res)) return false;
    dirty = false;
    if (reuseEnabled) reuseNoteImage();
    progressive.stride = res.stride;
    progressive.accumStride = res.stride;
    progressive.sublattice = 1;
    progressive.band = 0;
    progressive.complete = false;
    progressive.aaSample = 0;
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
    // A pass in flight is abandoned; the current texture is still complete.
    timeline.pass = null;
    timeline.carry = 0;
    timeline.lastTickAt = 0;
    playbackBudget.lastWorkAt = 0;
    playbackBudget.lastSpent = 0;
  }

  function seedPlaybackBudget() {
    if (playbackBudget.throughput === 0 && ladderBudget.throughput > 0) {
      playbackBudget.budget = clamp(ladderBudget.throughput * Math.max(1, renderedSteps()) * displayMode.samples,
        playbackBudget.min, playbackBudget.max);
    }
  }

  function playTimeline() {
    if (timeline.playing || timeline.following || !hasFloatColorBuffer) return;
    if (timeline.step >= simulationSteps) {
      timeline.step = 0;
      timeline.stateKey = null;
    }
    seedPlaybackBudget();
    timeline.playing = true;
    timeline.carry = 0;
    timeline.lastTickAt = 0;
    timeline.seenKey = null;
    timeline.seenAt = 0;
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

  // Pauses first: a user scrubbing the timeline is choosing the step.
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
  // With Map Evolution open the map plays the step the Inspect preview shows:
  // the preview's clock is the one clock and both cards' transports drive it
  // (previewOwnsTimeline), or the map's own timeline with no preview session.
  // NOT until asked, though: hovering parks a preview on frame 1, so the map
  // ignores it until a transport control is touched (mapLinked); returning to the finished field clears it.
  var mapLinked = false;
  function linkMapToPreview() { mapLinked = true; }

  // A new thing to preview (another cell, a lock) is not a request to move the map: unlink and stay put.
  function unlinkMapWhereItIs() {
    if (!mapLinked) return;
    mapLinked = false;
    pauseTimeline(); // stops the follow clock and sharpens the frame it stopped on
    timeline.following = false;
    updateTimelineUI();
  }

  function previewOwnsTimeline() {
    return hasFloatColorBuffer && playbackMenu.isOpen() && inspectMenu.isOpen() && playbackHasSession
      // Mid-run on its own clock: keep controlling THAT, or Pause would leave the map running.
      && (mapLinked || !timeline.playing);
  }

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
      // Advancing, or paused just ahead of the map (reachable). Behind the state is a rebuild from 0.
      if (backward) {
        timeline.stateKey = null;
        timeline.pass = null;
      }
      timeline.playing = true;
    } else {
      // Paused where the state can't reach (a scrub): the ladder renders the step directly.
      stopTimelineClock();
      if (backward) timeline.stateKey = null;
      timeline.step = step;
      markDirty();
    }
    updateTimelineUI();
  }

  // Row 0 of the preview's log is the state after one step, so map step = playbackStep + 1.
  function syncMapToInspection() {
    if (!playbackHasSession) return;
    followInspection(Math.floor(playbackStep) + 1, playbackPlaying);
  }

  // The finished field (Simulation Duration's step): what the grid shows with Map Evolution shut.
  function freezeMapAtEnd() {
    stopTimelineClock();
    timeline.following = false;
    mapLinked = false;
    timeline.step = simulationSteps;
    if (timeline.stateStep > timeline.step) timeline.stateKey = null;
    markDirty();
    updateTimelineUI();
  }

  // Back to the map's own timeline at its end when the followed preview goes away. Never stomps a user's own run.
  function releaseMapFollow() {
    if (!timeline.following) return;
    freezeMapAtEnd();
  }

  function updateTimelineUI() {
    // Sharing Inspect's clock, this row reports and controls THAT clock (playbackPlaying).
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
    if (timeline.drawing && timeline.catchingUp) {
      text += timeline.following ? " · catching up"
        : playing ? " · catching up " + Math.floor(timeline.catchUpFraction * 100) + "%" : "";
    }
    gridTimelineReadout.textContent = text;
  }

  makeSpeedControl(gridSpeedBtn, gridSpeedPopup, gridSpeedSlider, gridSpeedValueEl);

  // One handler each, for the shared preview clock or the map's own timeline. Map frame N = preview row N-1.
  gridPlayPauseBtn.addEventListener("click", function () {
    if (previewOwnsTimeline()) {
      if (playbackPlaying) {
        // Same grace window as Inspect's own button.
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

  new ResizeObserver(resizeCanvas).observe(canvasArea);

  // ResizeObserver misses a devicePixelRatio change; an exact-dppx matchMedia only matches once, so re-subscribe.
  function watchDevicePixelRatio() {
    var mq = window.matchMedia("(resolution: " + window.devicePixelRatio + "dppx)");
    mq.addEventListener("change", function () {
      resizeCanvas();
      watchDevicePixelRatio();
    }, { once: true });
  }
  watchDevicePixelRatio();

  resizeCanvas();
  updateZoomReadout();
  updateSpeedUI(); // both speed buttons at once: they share one value
  updateTimelineUI();
  showHoverEmpty();
  // Inspect opens on arrival (it explains the colors), via a click's path. First arrival only: setScene re-opens.
  setInspectOpen(true);
  scheduleColorSpreadCheck(); // the default view (before any pan/zoom) can already qualify

  // `dirty` means "the view moved, start over"; refinement carries on across frames until the
  // ladder ends. Playback takes the frame while playing, except while the view moves.
  requestAnimationFrame(function frame(now) {
    // Every GL call on a lost context is a silent no-op returning null. See "Losing the WebGL context".
    if (contextLost) { requestAnimationFrame(frame); return; }
    updatePerfReadout(now);
    noteFrameCadence(now);
    pumpPassBuilds();
    pumpPlaybackBuilds();
    prewarmPasses();
    pollBounceMax();
    refreshBuildStatus();
    pumpPendingInspect();
    if (dirty) { resetProgressive(); dirty = false; }
    releasePlaybackIfViewMoved();
    if (!presentGestureFrame(now) && !stepPlayback(now)) stepProgressive(now);
    requestAnimationFrame(frame);
  });

  // ---- Re-entering with a different scene, and what the transition needs ----
  //
  // setScene recomputes and drops rather than re-booting (see the file's head).
  // The explainer drives the zoom from far inside one pixel out to the default
  // framing (transition.js): DEFAULT_SCALE / n shows one default-view pixel filling n.
  global.FractalGrid.defaultScale = function () { return DEFAULT_SCALE; };
  global.FractalGrid.setScale = function (scale) {
    view.scale = scale;
    // The readout is driven by the user's zoom handlers, so a programmatic zoom must update it.
    updateZoomReadout();
    markDirty();
  };
  global.FractalGrid.resetView = function () {
    setViewCenter(DEFAULT_CENTER.x, DEFAULT_CENTER.y);
    view.scale = DEFAULT_SCALE;
    updateZoomReadout();
    markDirty();
  };
  // Leaving the grid for the editor (transition.js): hiding #grid-view stops neither the preview loop, its sounds, nor the timeline.
  global.FractalGrid.pausePlayback = function () {
    pausePlayback();
    releaseAllPlayback();
    markDirty();
    updateTimelineUI();
  };
  // Forces the pending frame out for the transition to composite against. ONE step: the intro re-drives the zoom every frame.
  global.FractalGrid.renderNow = function () {
    if (dirty) { resetProgressive(); dirty = false; }
    stepProgressive(performance.now());
  };

  global.FractalGrid.setScene = function (nextScene) {
    // Context gone while the editor was up: reload into the map with this scene ("Losing the WebGL context").
    if (contextLost) { reloadIntoMap(nextScene); return; }
    // The default framing is for whatever size the canvas ends up: no corner pinning (see the dock).
    dockSuppressPin = true;
    scene = nextScene;
    sceneGeneration += 1;
    reuse.image = null;
    reuseDropSource();
    adoptSceneDuration();
    releaseAllPlayback();
    timeline.step = simulationSteps;
    updateTimelineUI();
    isBouncesOutput = scene.output.property === "bounces";
    isInfinitePositionOutput = scene.edgeMode === "infinite" &&
      (scene.output.property === "x" || scene.output.property === "y");
    // Whether Output WRAPS decides hue range, superlative neighbour distance and circular stats.
    isCircularOutput = computeIsCircularOutput();
    hueRangeMaxValue = isCircularOutput ? 360 : 300;
    relabelSuperlativeExtremeButtons();
    sceneCoordinateSpan = computeSceneCoordinateSpan();
    // Compiled against the OLD scene, builds in flight included; requestPass rebuilds lazily.
    discardAllPasses();
    releaseAllSliceStates();
    bounceMaxProbe.measuredKey = null;
    bounceMaxProbe.key = null;
    clearInspected();
    movie.keyframes = [];
    stillJob = null;
    updateMovieUI();
    setViewCenter(DEFAULT_CENTER.x, DEFAULT_CENTER.y);
    view.scale = DEFAULT_SCALE;
    // Display mode and Color Zoom are this page's lens, not the scene's: reset, as Reset View does.
    colorZoomEnabled = false;
    colorZoomCheckbox.checked = false;
    lowSaturationEnabled = false;
    lowSaturationCheckbox.checked = false;
    setDisplayMode(DISPLAY_MODES[0]);
    // Inspect open, as boot() does: the menus are an accordion, so a user could otherwise return to no preview.
    setInspectOpen(true);
    canvas.hidden = false;
    emptyState.hidden = true;
    setStatus(true, "Ready");
    if (statsPanel) { statsHasResult = false; statsResultIsCurrent = false; statsPanel.clearResult(); }
    resizeCanvas();
    markDirty();
    scheduleDockLayout(false);
  };

  // ---- Movies ----
  //
  // A movie is a list of KEYFRAMES (view + Map Evolution frame) a camera travels
  // between (movie-path.js). Done hands the list, in a link, to chaosplayback.html,
  // which loads this app in a frame and asks for one picture after another via renderStill.

  var MOVIE_QUALITIES = MoviePath.QUALITIES;
  // keyframes: movie-path.js's shape, [{ center, scale, step, seconds }], seconds null until typed.
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
    // A frame short of the last is only on screen with Map Evolution open, so open it and unlink from the preview's clock.
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

  // A zoom as typed: "1.4e+25", "1.4e25", "1.4x10^25", "10^25", "1,400", with or without a trailing "x". Positive, or null.
  function parseZoomText(text) {
    var s = String(text).trim().toLowerCase().replace(/[\s,]/g, "").replace(/[\u00d7x*]$/, "");
    s = s.replace(/[\u00d7x*]10\^/, "e").replace(/^10\^/, "1e");
    var zoom = Number(s);
    return zoom > 0 && isFinite(zoom) ? zoom : null;
  }

  // One number in a keyframe's row. `field`: show() text at rest, edit() text to type over
  // (default show()), parse(text) -> value or undefined, step(dir) one arrow away, apply(value) commits.
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
      // mousedown, not click: a click would first blur the input, whose commit rebuilds the row.
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

      what.appendChild(movieField("zoom", "Zoom of keyframe " + (i + 1), {
        title: "The zoom at this keyframe. Type any notation, 1.4e+25, 1.4\u00d710^25, or step it a power of ten with the arrows.",
        stepHint: "a power of ten",
        show: function () { return formatZoom(DEFAULT_SCALE / k.scale); },
        edit: function () { return (DEFAULT_SCALE / k.scale).toExponential(1); },
        parse: function (text) { var z = parseZoomText(text); return z === null ? undefined : z; },
        step: function (dir) { return DEFAULT_SCALE / k.scale * (dir > 0 ? 10 : 0.1); },
        apply: function (zoom) { k.scale = clamp(DEFAULT_SCALE / zoom, MIN_SCALE, MAX_SCALE); },
      }));

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

      // The move ARRIVING here (the first keyframe has one only when looping). Empty: worked out; arrows step from that.
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
      // Keyframes are the movie's views; how the map is drawn (mode, Color Zoom, Low Saturation) rides along.
      view: { display: shared.view.display, lowSaturation: shared.view.lowSaturation, precision: shared.view.precision, movie: shared.view.movie },
    });
    // The address left behind must hold the card, or Back from the player loses the keyframes.
    if (global.AppShell && global.AppShell.syncAddress) global.AppShell.syncAddress();
    global.location.href = link;
  });
  updateMovieUI();

  // ---- One finished picture, on request ----
  //
  // The movie player asks: show THIS view at THIS step, render fully, and call
  // `onDone` in the same task as the finishing draw (no preserved drawing buffer).
  // Delivered only at the view's precision: a float32 stand-in's picture is held back until the build lands.
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
    timeline.stateKey = null;
    updateZoomReadout();
    updateTimelineUI();
    markDirty();
  };

  // ---- The address bar ----
  //
  // A link carries this page's view as well as the scene (share-url.js; transition.js decides when it is read and written).

  // Inspections a link asked for, not yet rebuilt, with a/b WORLD points so panning first doesn't move them.
  var pendingInspect = null;
  var pendingInspectFrames = 0;

  function describeInspectGroup(group) {
    if (group.type === "point") return { type: "point", a: group.points[0].worldPoint };
    if (group.type === "line") return { type: "line", a: group.startWorld, b: group.endWorld, count: group.sampleCount };
    return { type: "grid", a: group.startWorld, b: group.endWorld, size: group.gridSize, twoPart: group.twoPart };
  }

  // One group a frame, none until the map has drawn a couple of frames (each
  // point is a shader compiled on the spot), and none until the view's precision
  // is built: the float32 stand-in can't tell a deep zoom's points apart.
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

  // The scene as run here (its own Simulation Duration) and the view; inspection points as view-heights from the centre, pending included.
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
        // Color Zoom only shows in Standard (colorMap): "colorzoom" only when that is the picture on screen.
        display: colorZoomEnabled && displayMode.value === "standard" ? "colorzoom" : displayMode.value,
        lowSaturation: lowSaturationEnabled,
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

  // The way back in for a ShareUrl.decode view (every field present and typed), right after the link's scene reset everything.
  global.FractalGrid.applyShareView = function (shared) {
    dockSuppressPin = true;
    scheduleDockLayout(false);
    view.center.x = shared.center.x; view.center.xLo = shared.center.xLo;
    view.center.y = shared.center.y; view.center.yLo = shared.center.yLo;
    view.scale = clamp(DEFAULT_SCALE / shared.zoom, MIN_SCALE, MAX_SCALE);

    colorZoomEnabled = shared.display === "colorzoom";
    colorZoomCheckbox.checked = colorZoomEnabled;
    lowSaturationEnabled = shared.lowSaturation === true;
    lowSaturationCheckbox.checked = lowSaturationEnabled;
    setDisplayMode(colorZoomEnabled ? DISPLAY_MODES[0] : displayModeByValue(shared.display));

    // A rung this browser can't build (PRECISION_LADDER) becomes Auto.
    precisionMode = (shared.precision === "auto" || PRECISION_LADDER.indexOf(shared.precision) !== -1) ? shared.precision : "auto";
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
  // Values and presets live at the top of boot. The slider is an OUTPUT too: Low and
  // High set every control; Custom can't be chosen and is never stored, only derived (perfPresetNow).
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
  // Right-hand resolution handle for an endStride of 2. Not computed from the ladder's
  // length, which changes with the canvas; 90 rounds to "one short of the end" for 6-14 levels.
  var RESOLUTION_SLIDER_FOR_STRIDE = { 1: "100", 2: "90" };

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
          // A control this GPU can't use (drawLengthLocked) can't keep the slider off a preset.
          (drawLengthLocked || now.drawMs === p.drawMs)) return names[i];
    }
    return "custom";
  }

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

  function setPerfMaxDpr(v) {
    if (v === perf.maxDpr) return;
    perf.maxDpr = v;
    resizeCanvas(); // a different backing store, if this display is past the cap
    markDirty();
  }
  function setPerfFrameMs(v) {
    if (v === perf.frameMs) return;
    perf.frameMs = v;
    ladderBudgets = {};
    ladderBudget = budgetFor(effectivePrecision(), wantedVariant());
    markDirty();
  }
  function setPerfDrawMs(v) {
    if (v === perf.drawMs) return;
    perf.drawMs = v;
    // Calibrated against the old length, as was whether float32 needs slicing (f32StepMs is the GPU's and stays).
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
    updateResolutionBoundsUI();
    syncPerfPresetUI();
  }
  function applyPerfPreset(name) {
    if (!PERF_PRESETS[name] || perfPresetNow() === name) { syncPerfPresetUI(); return; }
    applyPerfValues(PERF_PRESETS[name]);
  }

  // The middle is fine to drag through but not to stop on: released there, it goes back to where the controls put it.
  perfPresetSlider.addEventListener("input", function () {
    var stop = Number(perfPresetSlider.value);
    if (stop === PERF_PRESET_STOPS.low) applyPerfPreset("low");
    else if (stop === PERF_PRESET_STOPS.high) applyPerfPreset("high");
  });
  perfPresetSlider.addEventListener("change", syncPerfPresetUI);
  // From the keyboard the middle would be a wall, so the arrows step over it.
  perfPresetSlider.addEventListener("keydown", function (e) {
    var toward = { ArrowLeft: "low", ArrowDown: "low", Home: "low", ArrowRight: "high", ArrowUp: "high", End: "high" }[e.key];
    if (!toward) return;
    e.preventDefault();
    applyPerfPreset(toward);
  });
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
  // Held at its first stop on an Apple GPU (sliceTargetMs): shown, not offered.
  if (drawLengthLocked) perfDrawSelect.disabled = true;

  // Picture reuse is the one setting perf couldn't take from its control at the top of boot. Before the first frame.
  setReuseEnabled(reusePictureCheckbox.checked);
  updateResolutionBoundsUI();
  syncPerfPresetUI();

  // ---- The performance readout ----
  //
  // Nerd Performance Stats: text over the map, meant to be screenshotted from a device
  // without a debugger, so it favours WHY a render is slow. Gathered whether or not showing (perfStats).
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
      // aaSample n means sample n is being averaged in: n - 1 are done.
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
    // Read what's measured, NOT f32NeedsSlicing(), which measures (blocking) when it hasn't.
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
    lines.push("input  " + (now - perfStats.presentOnlyAt < 400 ? "GESTURE, moving the picture, rendering nothing" :
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
  // In the small-window layout (LayoutMode.isMobile) the menus move into a dock
  // along the bottom edge (right edge on its side): buttons into a tab bar, the
  // open card into a sheet. MOVED, not rebuilt: makeMenu holds the elements by
  // reference and every listener is on them. One card at a time. No Movie tab:
  // its card stays in the hidden right column, shut on the way in, keyframes intact.
  var gridViewEl = document.getElementById("grid-view");
  var dockSheetEl = document.getElementById("grid-dock-sheet");
  var dockTabsEl = document.getElementById("grid-dock-tabs");
  var dockMenus = [inspectMenu, statsMenu, displayMenu, playbackMenu, settingsMenu];
  var dockActive = false;
  var DOCK_MAX_SHARE = 0.5;
  // True from a programmatic view reset until the dock settles: that resize re-frames about the centre, no corner pin.
  var dockSuppressPin = false;
  var dockLayoutQueued = false, dockLayoutWantsPin = false;

  // Set ONCE per change of open cards: every change of the sheet's height restarts the render from coarsest.
  function layoutDock(pin) {
    if (!dockActive) return;
    var anyOpen = dockMenus.some(function (menu) { return menu.isOpen(); });
    gridViewEl.classList.toggle("dock-sheet-open", anyOpen);
    if (!anyOpen || global.LayoutMode.orientation() !== "portrait") {
      dockSheetEl.style.height = "";
    } else {
      dockSheetEl.style.height = "auto";
      var cap = Math.max(140, Math.round(gridViewEl.clientHeight * DOCK_MAX_SHARE) - dockTabsEl.offsetHeight);
      dockSheetEl.style.height = Math.min(dockSheetEl.scrollHeight, cap) + "px";
    }
    // Now, not when the ResizeObserver gets to it: the frame between would stretch the old picture.
    pinViewCornerOnResize = !!pin;
    resizeCanvas();
    pinViewCornerOnResize = false;
    if (statsPanel && statsOpen) statsPanel.relayout();
    repositionActiveTip();
  }
  // Coalesced to the end of the task: accordion side effects and a mid-reset Inspect open would mis-measure the sheet.
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
    if (active && movieMenu.isOpen()) movieMenu.set(false);
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
        menu.item.insertBefore(menu.toggle, menu.item.firstChild);
        menu.item.appendChild(menu.card);
      }
    });
    if (!active) {
      gridViewEl.classList.remove("dock-sheet-open");
      dockSheetEl.style.height = "";
      if (renderProgressMenu.isOpen() && (inspectMenu.isOpen() || statsMenu.isOpen() || displayMenu.isOpen())) {
        renderProgressMenu.set(false);
      }
    }
    scheduleDockLayout(false);
  }

  onDockedMenuChange = function (menu) {
    if (!dockActive || !menu.docked) return;
    if (menu.isOpen()) {
      dockSheetEl.insertBefore(menu.card, dockSheetEl.firstChild);
      dockSheetEl.scrollTop = 0;
    }
    scheduleDockLayout(true);
  };

  // The cap moves with the view (phone turned, address bar sliding); also sizes the sheet first when started hidden.
  new ResizeObserver(function () { if (dockActive) scheduleDockLayout(false); }).observe(gridViewEl);

  if (global.LayoutMode) {
    global.LayoutMode.onChange(function (mode) { setDockActive(mode.isMobile()); });
    dockSuppressPin = true; // the default framing: see setScene
    setDockActive(global.LayoutMode.isMobile());
  }

  // ---- Losing the WebGL context ----
  //
  // A browser may take the context away at any moment (phones routinely do).
  // Rather than re-create every GL object, the address bar already holds the
  // page's whole state: recovery is to sync it and reload. A hidden page waits
  // until looked at; a visible one first gives the browser a grace period; the
  // EDITOR on screen reloads nothing (setScene finds it gone: reloadIntoMap);
  // repeated losses stop the auto-reload and force float32.
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
  // One loss is weather (a backgrounded tab); two in a row says the multi-float programs are what the device can't hold.
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
