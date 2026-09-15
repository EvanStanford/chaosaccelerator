// This file is part of Chaos Accelerator, licensed under the Common Public
// Attribution License, Version 1.0 (CPAL-1.0) - see LICENSE in the project
// root, or https://chaosaccelerator.com/license for a hosted copy.

// Renders every pixel's offset scene run forward a fixed number of steps,
// colored by the Output property's value at the END of that run. Scene is
// read once from localStorage (written by #editor-view's "Send to Fractal
// Grid" button) and compiled into one fixed WebGL2 shader for this page's
// lifetime - there's no live editing here, unlike the physics simulator.
// Each render (on load, pan, zoom, or resize) redoes the full offset +
// simulation for every pixel from scratch, for however many steps the
// Settings panel currently asks for - the
// whole grid has no Play button or animation of its own (only the hover
// panel replays a single point's trajectory), so this doesn't need to stay
// fast enough for 60fps.
(function (global) {
  "use strict";

  // ---- Started on demand, not at load ----
  //
  // Both views live in one document now (index.html), and the grid has no
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
    // Replaced by boot() with the real implementation once it has run; this
    // stub only exists so a caller can't hit `undefined` before then.
    setScene: function () {},
  };

  function boot(bootScene) {

  var GRID_HANDOFF_KEY = "physicsFractalScene";
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
  // Not a precision-derived floor - just small enough that the real limit
  // is what you hit first, as visible pixelation/aliasing rather than an
  // artificial hard stop. That limit used to be highp float's ~7 decimal
  // digits in the GLSL computing worldX/worldY; with the double-float path
  // (physics-df.js) it's ~15 digits instead, so this floor moved down with
  // it - see the precision readout in the Settings panel, which reports
  // which of the two is actually running at the current zoom.
  var MIN_SCALE = 1e-12;
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
  var colorZoomCheckbox = document.getElementById("color-zoom-checkbox");
  var btnInspectLine = document.getElementById("btn-inspect-line");
  var btnInspectGrid = document.getElementById("btn-inspect-grid");
  var btnInspectClearAll = document.getElementById("btn-inspect-clear-all");
  var btnSuperlativeLargest = document.getElementById("btn-superlative-largest");
  var btnSuperlativeSmallest = document.getElementById("btn-superlative-smallest");
  var btnSuperlativeEdge = document.getElementById("btn-superlative-edge");
  var btnSuperlativeRarest = document.getElementById("btn-superlative-rarest");
  var inspectListEl = document.getElementById("inspect-list");
  var inspectPreviewSvg = document.getElementById("inspect-preview");
  var inspectToastEl = document.getElementById("inspect-toast");
  var tipPopover = document.getElementById("tip-popover");
  var tipPopoverText = document.getElementById("tip-popover-text");
  var tipPopoverOk = document.getElementById("tip-popover-ok");
  var tipPopoverDismiss = document.getElementById("tip-popover-dismiss");
  var btnResetTips = document.getElementById("grid-btn-reset-tips");
  var btnResetAll = document.getElementById("grid-btn-reset-all");
  var statsPanelBodyEl = document.getElementById("grid-stats-panel-body");
  var stepsSlider = document.getElementById("steps-slider");
  var stepsReadout = document.getElementById("steps-readout");
  var precisionReadout = document.getElementById("precision-readout");
  var precisionSelect = document.getElementById("precision-select");
  var inspectLineSampleCountSlider = document.getElementById("inspect-line-sample-count-slider");
  var inspectLineSampleCountReadout = document.getElementById("inspect-line-sample-count-readout");
  var inspectGridSizeSlider = document.getElementById("inspect-grid-size-slider");
  var inspectGridSizeReadout = document.getElementById("inspect-grid-size-readout");
  var inspectGridTwoPartCheckbox = document.getElementById("inspect-grid-two-part-checkbox");
  var hoverMuteBtn = document.getElementById("hover-mute");
  var gridSoundVolumeSlider = document.getElementById("grid-sound-volume-slider");
  var gridSoundVolumeIcon = document.getElementById("grid-sound-volume-icon");

  function setStatus(ok, message) {
    statusEl.textContent = message;
    statusEl.className = ok ? "status-ok" : "status-error";
  }

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

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
  // What OK does for the tip currently showing, when "just close it" isn't
  // the whole story - see showTip's own comment.
  var activeTipOnOk = null;
  // Which step of the deep-zoom precision tip is showing: 0 none, 1 pointing
  // at the Settings gear, 2 pointing at the precision dropdown inside the
  // panel. See maybeShowDeepZoomPrecisionTip, far below, for the sequence.
  var deepZoomTipStage = 0;

  function hideTip() {
    tipPopover.hidden = true;
    activeTipId = null;
    activeTipAnchor = null;
    activeTipOnOk = null;
    deepZoomTipStage = 0;
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
    // Vertically clamped for the same reason the horizontal clamp exists,
    // and newly necessary: an anchor part-way out of the scrolling menu
    // column would otherwise put the whole popover above the top of the
    // window.
    tipPopover.style.top = clamp(rect.bottom + 10, 12, Math.max(12, window.innerHeight - height - 12)) + "px";
    tipPopover.style.left = left + "px";
    // Aim the arrow at the middle of the anchor rather than leaving it at a
    // fixed spot on the popover: the clamp above can push the body far from
    // the control it's about (most visibly for the Settings gear, which sits
    // at the right edge - the body lands to its left, so a left-side arrow
    // pointed at nothing). ARROW_SIZE/2 centres the rotated square on the
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
  // completely - whatever it does next (retargetTip to a further step, or
  // hideTip to finish) is its own job. Without it, OK just closes.
  function showTip(id, anchorEl, text, opts) {
    if (isTipDismissed(id) || activeTipId === id) return false;
    // Nothing to point at - don't burn the tip's one showing on a card the
    // user has collapsed. It offers itself again next time the view
    // settles, by which point the card may well be open.
    if (!bringTipAnchorIntoView(anchorEl)) return false;
    activeTipId = id;
    activeTipAnchor = anchorEl;
    activeTipOnOk = (opts && opts.onOk) || null;
    tipPopoverText.textContent = text;
    tipPopover.hidden = false;
    positionTip(anchorEl);
    return true;
  }

  // Moves the tip already showing onto a different control, with new text,
  // skipping showTip's "already showing / already dismissed" guards. This is
  // what lets a multi-step tip keep ONE dismissal id across all its steps, so
  // "Don't tell me again" means the whole sequence rather than just the step
  // the user happened to be looking at.
  // Scrolls an anchor back into the menu column if it has drifted out of
  // it, and reports whether it is pointable-at afterwards. Only called when
  // a tip first appears or changes target - NOT from repositionActiveTip,
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

  function retargetTip(anchorEl, text, opts) {
    if (!activeTipId) return;
    // The new target is somewhere else in the column and may need scrolling
    // to - step 2 of the deep-zoom sequence points at a dropdown inside a
    // card that was shut a moment ago.
    bringTipAnchorIntoView(anchorEl);
    activeTipAnchor = anchorEl;
    activeTipOnOk = (opts && opts.onOk) || null;
    tipPopoverText.textContent = text;
    positionTip(anchorEl);
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

  // ---- The menu column (upper left) ----
  //
  // Three menus - Settings, Inspect, Analysis - each a square icon button
  // until it is opened, at which point the button leaves the layout and its
  // card takes the space. Accordion, not independent: opening one closes
  // whichever of the other two was open (see menuGroup below), so the
  // column never has to show more than one card's worth of controls at
  // once. Zero open is still fine - closing the last one just leaves the
  // three collapsed buttons.
  //
  // The open/shut state lives HERE rather than being read back off a class,
  // so the one thing that can vary (which of the button and the card is in
  // the layout) has exactly one owner.
  //
  // Every menu this factory builds registers itself here, so opening one
  // can close the others without each menu having to know the other two by
  // name at its own construction time (settingsMenu/inspectMenu/statsMenu
  // are still being built when the first of them runs this).
  var menuGroup = [];
  function makeMenu(itemId, toggleId, onChange) {
    var item = document.getElementById(itemId);
    var toggle = document.getElementById(toggleId);
    var card = item.querySelector(".menu-card");
    var header = card.querySelector(".menu-card-header");
    var open = false;
    function set(next) {
      next = !!next;
      if (next === open) return;
      open = next;
      if (open) {
        menuGroup.forEach(function (other) {
          if (other !== api && other.isOpen()) other.set(false);
        });
      }
      item.classList.toggle("is-open", open);
      card.hidden = !open;
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      // Nothing to drag when every menu is shut - see #panel-resizer.
      menuColumn.classList.toggle("has-open-menu",
        !!document.querySelector("#grid-menu-stack .menu-item.is-open"));
      // A tip anchored to something inside a card that has just appeared or
      // vanished is pointing at a rect that no longer describes anything.
      repositionActiveTip();
      if (onChange) onChange(open);
    }
    toggle.addEventListener("click", function () { set(true); });
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
    };
    menuGroup.push(api);
    return api;
  }

  var settingsMenu = makeMenu("menu-settings", "grid-btn-settings",
    function (open) {
      // Opening Settings IS the "yes, show me" that the deep-zoom tip's
      // step 1 asks for, so getting there by hand skips straight ahead
      // rather than leaving the tip pointing at a button the user has
      // already pressed.
      if (open && deepZoomTipStage === 1) showDeepZoomPrecisionStep2();
      // Step 2 points at a control that has just left the layout - there's
      // nothing to point at any more, so end the sequence rather than leave
      // the popover stranded.
      else if (!open && deepZoomTipStage === 2) hideTip();
    });

  // Kept as a named function because the deep-zoom tip sequence above opens
  // Settings on the user's behalf.
  function setSettingsPanelOpen(open) {
    settingsMenu.set(open);
  }

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
  var inspectMenu = makeMenu("menu-inspect", "grid-btn-inspect",
    function (open) {
      if (open) {
        // Pick up whatever should be on screen now - the locked points if
        // there are any, the placeholder otherwise. Not the last hovered
        // cell: the cursor has been elsewhere since.
        if (inspectedGroups.length > 0) beginInspectOnlySession();
        else showHoverEmpty();
      } else {
        pausePlayback();
        stopHoverReplay();
        hoverKey = null; // so re-entering the same cell later still previews it
        disarmInspect();
      }
      updateInspectMarkers();
    });
  function setInspectOpen(open) {
    inspectMenu.set(open);
  }

  var statsMenu = makeMenu("menu-stats", "grid-btn-stats",
    function (open) {
      setStatsPanelOpen(open);
    });
  btnResetTips.addEventListener("click", function () {
    try {
      localStorage.removeItem(TIP_DISMISSED_KEY);
    } catch (err) {
      // Nothing to clean up if storage was never reachable to begin with.
    }
    var original = btnResetTips.textContent;
    btnResetTips.textContent = "Tips reset";
    setTimeout(function () { btnResetTips.textContent = original; }, 1500);
  });
  // "Deletes all cookies for the page" per the user's ask - this app keeps
  // its state in localStorage, not cookies, so that (plus any cookies this
  // origin might still pick up some day) is what actually needs clearing.
  // A hard reload after wiping is the simplest way to put every module back
  // in its true first-run state, rather than hand-resetting each one here.
  if (btnResetAll) {
    btnResetAll.addEventListener("click", function () {
      if (!global.confirm("Reset all saved data for this page? This clears your saved scene, dismissed tips, and intro animation state, then reloads.")) return;
      try {
        localStorage.clear();
      } catch (err) {
        // Nothing to clean up if storage was never reachable to begin with.
      }
      try {
        document.cookie.split(";").forEach(function (pair) {
          var name = pair.split("=")[0].trim();
          if (!name) return;
          document.cookie = name + "=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/";
        });
      } catch (err) {
        // Same - nothing to clean up if cookies aren't reachable.
      }
      global.location.reload();
    });
  }

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

  // bootScene is what the app shell handed over; the localStorage read is
  // the fallback for a cold load (opening index.html with a scene already
  // saved from a previous session).
  var raw = bootScene ? JSON.stringify(bootScene) : localStorage.getItem(GRID_HANDOFF_KEY);
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
      setStatus(false, "Invalid saved scene");
      showEmptyState("The saved scene couldn't be read (" + (err.message || err) + "). Go back and send it again.");
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

  // Adopt the sent scene's own duration, same fallback-on-garbage and
  // snap-to-notch treatment as physics-ui.js's parseSceneData - scene JSON
  // written before this field existed (or a hand-edited/malformed value)
  // just keeps this page's long-standing default instead.
  // Named rather than an inline IIFE so setScene() can re-run it for a
  // scene arriving after boot.
  function adoptSceneDuration() {
    var v = Number(scene.simulationSteps);
    if (!isFinite(v) || v <= 0) return;
    simulationSteps = Math.min(50 * SIMULATION_STEPS_PER_NOTCH, Math.max(SIMULATION_STEPS_PER_NOTCH,
      Math.round(v / SIMULATION_STEPS_PER_NOTCH) * SIMULATION_STEPS_PER_NOTCH));
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
  // the same physics - only the six per-body accumulators (and the world
  // X/Y that seeds them) change representation. See physics-df.js and
  // physics-gpu-df.js for the df physics library; see pickPrecision()
  // below for when each one is used.
  function buildFragmentShader(sceneToCompile, precision) {
    var df = precision === "df";
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
      // The two subtractions happen at the pass's precision and only the
      // (small) separations collapse to float32 for the length() - the same
      // ordering the mutual-gravity code uses, and for the same reason:
      // collapsing two full-magnitude coordinates first would throw away
      // exactly the distinction between neighbouring pixels that a df pass
      // exists to keep.
      outputLines = [];
      emitBodyValue("outAx", outputBodies[0], "x").forEach(function (l) { outputLines.push(l); });
      emitBodyValue("outAy", outputBodies[0], "y").forEach(function (l) { outputLines.push(l); });
      emitBodyValue("outBx", outputBodies[1], "x").forEach(function (l) { outputLines.push(l); });
      emitBodyValue("outBy", outputBodies[1], "y").forEach(function (l) { outputLines.push(l); });
      outputLines.push("  float outDx = " + B.toFloat(B.sub("outBx", "outAx")) + ";");
      outputLines.push("  float outDy = " + B.toFloat(B.sub("outBy", "outAy")) + ";");
      if (PhysicsEngine.wrapsAtEdges(sceneToCompile)) {
        // floor(x + 0.5), not round(): GLSL's round() breaks ties to even,
        // JS's Math.round breaks them upward, and the two engines have to
        // fold the same way at exactly half a frame.
        var fw = PhysicsGPU.fnum(sceneToCompile.frameWidth), fh = PhysicsGPU.fnum(sceneToCompile.frameHeight);
        outputLines.push("  outDx -= " + fw + " * floor(outDx / " + fw + " + 0.5);");
        outputLines.push("  outDy -= " + fh + " * floor(outDy / " + fh + " + 0.5);");
      }
      outputLines.push("  outputValue = " + B.fromFloat("length(vec2(outDx, outDy))") + ";");
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
    var stepOnceSource = PhysicsGPU.generateStepOnceGLSL(initial.n, initial.consts, initial.pairs, initial.hingeAnchors, frame, precision, sceneToCompile.mutualGravity, PhysicsEngine.collisionsEnabled(sceneToCompile), initial.spawnBase);
    var stepOnceCall = "stepOnce(" + PhysicsGPU.stepOnceCallArgs(initial.n, initial.hingeAnchors, precision, initial.spawnBase) + ");";

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
    var stepLoopLines;
    if (sceneToCompile.edgeMode === "sticky" && frame && watchedIndices.length > 0) {
      var halfW = PhysicsGPU.fnum(frame.width / 2), halfH = PhysicsGPU.fnum(frame.height / 2);
      var fullW = PhysicsGPU.fnum(frame.width), fullH = PhysicsGPU.fnum(frame.height);
      // The frozen samples ARE the reported output on any pixel that stops,
      // so they are tracked at the pass's own precision: collapsing them to
      // float32 here would quantize the answer for exactly the pixels this
      // feature exists to serve, no matter how precise the step loop that
      // produced them was.
      var bodyVar = df ? "dbody" : "body";
      var lines = [];
      trackedIndices.forEach(function (idx) {
        lines.push("  " + B.scalar + " frozenX" + idx + " = " + bodyVar + idx + ".x;");
        lines.push("  " + B.scalar + " frozenY" + idx + " = " + bodyVar + idx + ".y;");
        lines.push("  " + B.scalar + " frozenAngle" + idx + " = " + bodyVar + idx + ".angle;");
        lines.push("  " + B.scalar + " prevFrozenX" + idx + " = " + B.zero + ";");
        lines.push("  " + B.scalar + " prevFrozenY" + idx + " = " + B.zero + ";");
        lines.push("  " + B.scalar + " prevFrozenAngle" + idx + " = " + B.zero + ";");
      });
      lines.push("  bool hasPrevFrozen = false;");
      lines.push("  bool wrapStopped = false;");
      // Default: never crosses within the budget, so it "lasts" the whole
      // thing - matches outputRangeMax's own ceiling, which is this same
      // step budget.
      lines.push("  float lifespanValue = float(u_maxSteps);");
      bounceInitLines.forEach(function (l) { lines.push(l); });
      lines.push("  for (int i = 0; i < u_maxSteps; i++) {");
      lines.push("    if (wrapStopped) break;");
      lines.push("    " + stepOnceCall);
      bounceStepLines.forEach(function (l) { lines.push(l); });
      // DT+1.0 sentinel: strictly greater than any real tFrac (which is
      // clamped into [0, DT]), so the first real crossing this step always
      // wins the comparison below regardless of watch order.
      lines.push("    float bestTFrac = DT + 1.0;");
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
        lines.push("        float vAxis = " + B.toFloat("xCrossed ? " + bodyVar + idx + ".vx : " + bodyVar + idx + ".vy") + ";");
        lines.push("        " + B.scalar + " prevAxis = xCrossed ? frozenX" + idx + " : frozenY" + idx + ";");
        lines.push("        float boundary = vAxis > 0.0 ? span : 0.0;");
        lines.push("        float tFrac = clamp(" + B.toFloat(B.sub(B.fromFloat("boundary"), "prevAxis")) + " / vAxis, 0.0, DT);");
        // Earliest continuous crossing wins when more than one watched body
        // registers a crossing on the same discrete step.
        lines.push("        if (tFrac < bestTFrac) bestTFrac = tFrac;");
        lines.push("      }");
        lines.push("    }");
      });
      lines.push("    if (bestTFrac <= DT) {");
      lines.push("      float tTarget = bestTFrac - DT;");
      lines.push("      lifespanValue = float(i) + bestTFrac / DT;");
      outputIndices.forEach(function (out) {
        // frozen + (frozen - prevFrozen)/DT * tTarget, kept whole at the
        // pass's precision: the reconstructed velocity is a difference of
        // two consecutive samples (small, so precise either way), but the
        // base it is added onto is a full-magnitude coordinate that must
        // not be rounded.
        function extrapolate(axis) {
          var vel = B.mul(B.sub("frozen" + axis + out, "prevFrozen" + axis + out), B.fromFloat("(1.0 / DT)"));
          return B.add("frozen" + axis + out, B.mul(vel, B.fromFloat("tTarget")));
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
      stepLoopLines = lines.join("\n");
    } else {
      // No watched bodies at all (every body is static or a hinge child) -
      // Sticky Edges has nothing to trigger on, so lifespan is trivially
      // always the full run length.
      stepLoopLines = "  float lifespanValue = float(u_maxSteps);\n" +
        bounceInitLines.map(function (l) { return l + "\n"; }).join("") +
        "  for (int i = 0; i < u_maxSteps; i++) {\n" +
        "    " + stepOnceCall + "\n" +
        bounceStepLines.map(function (l) { return l + "\n"; }).join("") +
        "  }";
    }

    return [
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
      // The view center arrives pre-split into two float32 words. JS
      // numbers are float64 and view.center has always carried the full
      // precision - uploading it as a single float32 uniform was throwing
      // ~8 decimal digits away at the door, which no amount of care later
      // in the shader could get back. The f32 pass simply ignores the low
      // word, so both programs take the same uniforms.
      "uniform vec2 u_centerHi;",
      "uniform vec2 u_centerLo;",
      "uniform float u_scale;",
      "uniform bool u_colorZoom;",
      // How many steps each pixel runs. A uniform rather than a baked
      // constant so the Settings slider doesn't recompile four programs per
      // notch - GLSL ES 3.00 allows a non-constant loop bound (ES 1.00
      // didn't), and measured, the dynamic bound costs nothing.
      "uniform int u_maxSteps;",
      // Bounce Count only: the largest bounce count currently in view, which
      // is what a pixel's own count is scaled against (see findBounceMax).
      // A uniform, not a baked constant, because it's a property of where
      // you're looking rather than of the scene - it's re-measured on every
      // render, so panning into a busier region rescales the whole picture
      // instead of saturating.
      "uniform float u_bounceMax;",
      "out vec4 fragColor;",
      "",
      PhysicsGPU.libraryGLSL(precision, PhysicsEngine.speedCapFor(sceneToCompile)),
      "",
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
      // Color Zoom (off by default, u_colorZoom): repeats that same hue
      // ramp 10 times across the range instead of once, for scenes whose
      // whole range needs to be seen at once but where one single rainbow
      // sweep isn't enough resolution to tell nearby values apart. Since
      // hue alone would then look identical across all 10 repeats,
      // saturation also ramps 40%-100% across the FULL (non-repeating) t -
      // low saturation (paler, closer to gray) near t=0, full saturation
      // near t=1 - so which of the 10 repeats a color belongs to is still
      // visible.
      "const float HUE_RANGE_MAX = " + PhysicsGPU.fnum(hueRangeMax) + ";",
      // The GLSL twin of PhysicsEngine.frameSigmoid - same constant, so the
      // grid and the hover panel beside it agree on the colour.
      "float frameSigmoid(float v) {",
      "  return 1.0 / (1.0 + exp(" + PhysicsGPU.fnum(-PhysicsEngine.OUTPUT_SIGMOID_STEEPNESS) + " * (v - 0.5)));",
      "}",
      "",
      "vec3 colorMap(float t) {",
      // A no-op for every output whose t is already in [0,1) by construction;
      // it's Bounce Count's deliberately-unclamped t (see its own comment
      // below) that can arrive a hair over 1 and would otherwise wrap round
      // to a negative hue.
      "  t = clamp(t, 0.0, 1.0);",
      "  if (u_colorZoom) {",
      "    float tZoom = mod(t * 10.0, 1.0);",
      "    float hue = HUE_RANGE_MAX * (1.0 - tZoom);",
      "    float sat = t * 0.6 + 0.4;",
      "    return hsl2rgb(hue, sat, 0.5);",
      "  }",
      "  float hue = HUE_RANGE_MAX * (1.0 - t);",
      "  return hsl2rgb(hue, 1.0, 0.5);",
      "}",
      "",

      // Scene lifespan's range IS the step budget and Bounce Count's is
      // u_bounceMax, so both read a uniform instead of a baked-in constant;
      // every other property's range is a fixed property of the scene.
      isRunTally ? "" : "const float OUTPUT_RANGE_MAX = " + PhysicsGPU.fnum(rangeMax) + ";",
      PhysicsGPU.sceneConstantsGLSL(sceneToCompile.gravity, sceneToCompile.friction, sceneToCompile.restitution, precision),
      "",
      stepOnceSource,
      "",
      "void main() {",
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
      df ? "  vec2 worldX = dfAddFloat(vec2(u_centerHi.x, u_centerLo.x), uv.x * u_scale);" : "  float worldX = u_centerHi.x + uv.x * u_scale;",
      df ? "  vec2 worldY = dfAddFloat(vec2(u_centerHi.y, u_centerLo.y), uv.y * u_scale);" : "  float worldY = u_centerHi.y + uv.y * u_scale;",
      initial.declarationLines.map(function (l) { return "  " + l; }).join("\n"),
      "  " + PhysicsGridCodegen.generateCanonicalBodyDeclarationsGLSL(initial).split("\n").join("\n  "),
      "  " + PhysicsGPU.generateHingeAnchorLocalsGLSL(initial.hingeAnchors, precision).split("\n").join("\n  "),
      stepLoopLines,

      // A step count or a bounce count is always a plain float, in both passes.
      "  " + (isRunTally ? "float" : B.scalar) + " outputValue = " + (isRunTally ? "0.0" : B.zero) + ";",
      outputLines.join("\n"),
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
      // two frames out as if it were barely off-centre, and dividing without
      // one would run t past 1 and off the end of the colour range. The
      // sigmoid squashes the whole infinite line into [0,1] instead: dead
      // centre is 0.5, the frame's own edges 0.076 and 0.924, two frames out
      // 0.9995 - arbitrarily distant still lands inside the range, just ever
      // closer to its end. Only x/y take it; angle is genuinely circular
      // whatever the edges do, and the two run tallies aren't positions.
      isBounces
        ? "  float t = u_bounceMax > 0.0 ? outputValue / u_bounceMax : 0.0;"
        : isLifespan
          ? "  float t = clamp(outputValue / float(u_maxSteps), 0.0, 1.0);"
          : isInfinitePosition
            ? "  float t = frameSigmoid(" + B.toFloat(B.div("outputValue", B.fromFloat("OUTPUT_RANGE_MAX"))) + ");"
            // Distance clamps for the same reason lifespan does: its maximum
            // is a value the pair can legitimately sit at (exact antipodes),
            // and mod()-ing that back to 0 would paint "as far apart as this
            // world allows" the same colour as "touching".
            : isDistance
              ? "  float t = clamp(" + B.toFloat(B.div("outputValue", B.fromFloat("OUTPUT_RANGE_MAX"))) + ", 0.0, 1.0);"
              : "  float t = " + B.toFloat(B.div(B.mod("outputValue", "OUTPUT_RANGE_MAX"), B.fromFloat("OUTPUT_RANGE_MAX"))) + ";",
      "  fragColor = vec4(colorMap(t), 1.0);",
      "}",
    ].join("\n");
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

  // ---- The two shader passes ----
  //
  // The same scene compiled twice: once with float32 body state, once with
  // double-float. They compute the same physics and differ only in how much
  // of a pixel's starting conditions survives into it, so which one is
  // bound is purely a function of the current zoom (see pickPrecision) and
  // nothing else in the page has to know which is running.
  //
  // The df pass costs real ALU, so it is compiled lazily - a session that
  // never zooms past the float32 wall never pays for it, and (because both
  // are the same program otherwise) at any zoom just ABOVE that wall the
  // two must render identically, which is the cheapest correctness check
  // this code has.
  function buildPass(precision) {
    var prog = PhysicsGPU.linkProgram(gl, vs,
      PhysicsGPU.compileShader(gl, gl.FRAGMENT_SHADER, buildFragmentShader(scene, precision)));
    return {
      precision: precision,
      program: prog,
      posLoc: gl.getAttribLocation(prog, "a_position"),
      uniforms: {
        resolution: gl.getUniformLocation(prog, "u_resolution"),
        gridStride: gl.getUniformLocation(prog, "u_gridStride"),
        gridOrigin: gl.getUniformLocation(prog, "u_gridOrigin"),
        centerHi: gl.getUniformLocation(prog, "u_centerHi"),
        centerLo: gl.getUniformLocation(prog, "u_centerLo"),
        scale: gl.getUniformLocation(prog, "u_scale"),
        colorZoom: gl.getUniformLocation(prog, "u_colorZoom"),
        maxSteps: gl.getUniformLocation(prog, "u_maxSteps"),
        bounceMax: gl.getUniformLocation(prog, "u_bounceMax"),
      },
      sampler: null,      // filled in by setUpColorSpreadSampler, below
      samplerBuilt: false,
    };
  }

  var passes = {};
  // Returns null (and leaves the current pass in place) if this precision
  // can't be built on this device, rather than blanking the page.
  function getPass(precision) {
    if (!(precision in passes)) {
      try {
        passes[precision] = buildPass(precision);
      } catch (err) {
        passes[precision] = null;
        if (precision === "df") setStatus(false, "High-precision shader unavailable: " + (err.message || err));
      }
    }
    return passes[precision];
  }

  var basePass;
  try {
    basePass = buildPass("f32");
    passes.f32 = basePass;
  } catch (err) {
    setStatus(false, "Compile error");
    showEmptyState("Couldn't build the grid shader: " + (err.message || err));
    return;
  }
  var activePass = basePass;
  gl.useProgram(basePass.program);
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
  bindQuad(basePass.posLoc);

  // The view center's two float32 words. JS numbers are float64, so this
  // is where the precision that was previously lost at upload time is
  // actually handed over.
  function setCenterUniforms(u) {
    var hx = PhysicsDF.split(view.center.x), hy = PhysicsDF.split(view.center.y);
    gl.uniform2f(u.centerHi, hx[0], hy[0]);
    gl.uniform2f(u.centerLo, hx[1], hy[1]);
  }

  // ---- Color Zoom suggestion: sample the currently visible output values
  // into a tiny offscreen texture, so the tip below can tell when they're
  // all bunched into a narrow slice of the rainbow. ----
  //
  // Reuses buildFragmentShader's own real output verbatim (same physics,
  // same wrap handling) rather than re-deriving anything - the only change
  // is swapping the final color-mapping line for one that writes the raw
  // pre-color t value straight into the red channel of an RGBA32F texture,
  // so reading it back needs no reverse color math (and none of the 8-bit
  // quantization noise that would introduce near hue boundaries).
  var SAMPLE_SIZE = 24;
  var hasFloatColorBuffer = !!gl.getExtension("EXT_color_buffer_float");
  // One sampler per precision, built alongside (and lazily, like) its pass
  // - a sampler reading the f32 shader while the grid displays the df one
  // would answer questions about a picture nobody is looking at.
  function samplerFor(pass) {
    if (pass.samplerBuilt) return pass.sampler;
    pass.samplerBuilt = true;
    if (!hasFloatColorBuffer) return null; // heuristic only - skip quietly if this GPU/browser can't render float textures
    try {
      var src = buildFragmentShader(scene, pass.precision).replace(
        "  fragColor = vec4(colorMap(t), 1.0);",
        "  fragColor = vec4(t, 0.0, 0.0, 1.0);"
      );
      var prog = PhysicsGPU.linkProgram(gl, vs, PhysicsGPU.compileShader(gl, gl.FRAGMENT_SHADER, src));
      pass.sampler = {
        program: prog,
        posLoc: gl.getAttribLocation(prog, "a_position"),
        uniforms: {
          resolution: gl.getUniformLocation(prog, "u_resolution"),
          gridStride: gl.getUniformLocation(prog, "u_gridStride"),
          gridOrigin: gl.getUniformLocation(prog, "u_gridOrigin"),
          centerHi: gl.getUniformLocation(prog, "u_centerHi"),
          centerLo: gl.getUniformLocation(prog, "u_centerLo"),
          scale: gl.getUniformLocation(prog, "u_scale"),
          maxSteps: gl.getUniformLocation(prog, "u_maxSteps"),
          bounceMax: gl.getUniformLocation(prog, "u_bounceMax"),
        },
      };
    } catch (err) {
      pass.sampler = null; // heuristic only - never let a problem here affect the real grid
    }
    return pass.sampler;
  }

  setStatus(true, "Ready");

  var view = { center: { x: DEFAULT_CENTER.x, y: DEFAULT_CENTER.y }, scale: DEFAULT_SCALE };

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
  };
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
  // margin. Not larger: the df pass costs ~3x the render time, which is
  // paid for in how far down the refinement ladder a view gets before the
  // user moves again, so switching hundreds of times earlier than
  // necessary is not free. Not smaller: the
  // crossover wants to happen while both passes still agree, which is what
  // makes comparing them (Settings > Numeric precision) a real check.
  var DF_SWITCH_MARGIN_ULPS = 64;
  // "auto" | "f32" | "df" - the last two are the Settings panel's manual
  // override, for comparing the two passes at the same view.
  //
  // Starts at f32, and (being page state, never persisted) is back at f32
  // every time this page is opened - including on the way back from the
  // physics editor. The df pass costs several times the render time, so a
  // session that doesn't need it shouldn't quietly inherit it from an
  // earlier one; the deep-zoom tip below is what offers Auto at the point
  // where it actually starts to buy something.
  var precisionMode = "f32";

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
    return Math.max(canvasArea.clientHeight * (window.devicePixelRatio || 1), canvas.height, 1);
  }
  // The distance in world units between two adjacent simulated points.
  function worldPixelSpacing() { return view.scale / referenceHeightPx(); }
  function autoPrecision() {
    var ulp = float32UlpAt(Math.max(Math.abs(view.center.x), Math.abs(view.center.y), sceneCoordinateSpan));
    return worldPixelSpacing() < ulp * DF_SWITCH_MARGIN_ULPS ? "df" : "f32";
  }
  function pickPrecision() {
    return precisionMode === "auto" ? autoPrecision() : precisionMode;
  }

  function updatePrecisionReadout() {
    if (!precisionReadout) return;
    var active = activePass.precision;
    precisionReadout.textContent = active === "df" ? "double-float (~15 digits)" : "float32 (~7 digits)";
  }
  if (precisionSelect) {
    // Explicit, rather than trusting the markup's own `selected`: browsers
    // restore form-control values across a reload or a Back navigation, which
    // would otherwise leave the dropdown showing whatever it was set to last
    // visit while precisionMode had genuinely reset to f32.
    precisionSelect.value = precisionMode;
    precisionSelect.addEventListener("change", function () {
      precisionMode = precisionSelect.value;
      markDirty();
    });
  }

  // ---- Deep-zoom tip: offer double precision at the point it starts to pay
  // for itself ----
  //
  // Precision now starts at Force float32 every visit, which is right for
  // ordinary zooms and wrong past the float32 wall - where neighbouring
  // pixels begin rounding onto identical starting scenes and the image goes
  // flat. Rather than silently switching (df costs several times the render
  // time), this points the user at the setting in two steps: first at the
  // gear that hides it, then - once they're in there - at the dropdown
  // itself, where OK makes the change for them. Both steps share one
  // dismissal id, so "Don't tell me again" retires the whole sequence and
  // Settings > Reset Tool Tips brings it back.
  var DEEP_ZOOM_TIP_ID = "deep-zoom-precision";
  // An absolute view.scale, NOT a number on the zoom readout. This tip
  // points at the float32 wall, which sits at a fixed world-units-per-pixel
  // whatever the readout happens to call 1.00x - so writing it as a zoom
  // ratio meant rebasing DEFAULT_SCALE silently moved where it fired. 2e-3
  // is exactly where the old ratio (1e5x, back when 1.00x meant a 200-unit
  // span) landed.
  var DEEP_ZOOM_TIP_MAX_SCALE = 2e-3;

  function showDeepZoomPrecisionStep2() {
    deepZoomTipStage = 2;
    settingsMenu.set(true);
    retargetTip(precisionSelect,
      "Set this to Auto and the grid uses double precision only where the zoom needs it. Click OK to switch it.",
      { onOk: function () {
          precisionMode = "auto";
          precisionSelect.value = "auto";
          markDirty();
          hideTip();
        } });
  }

  // Returns true if this tip is showing (or just appeared), so the caller can
  // leave the one shared popover alone instead of talking over it.
  function maybeShowDeepZoomPrecisionTip() {
    if (activeTipId === DEEP_ZOOM_TIP_ID) return true; // mid-sequence - don't restart it
    if (!precisionSelect) return false;
    // Nothing to offer once precision is already Auto or forced to df: this
    // tip exists only to get the user off the fixed-float32 default, so this
    // is also what stops it reappearing after they've accepted it.
    if (precisionMode !== "f32") return false;
    if (view.scale >= DEEP_ZOOM_TIP_MAX_SCALE) return false;
    var shown = showTip(DEEP_ZOOM_TIP_ID, settingsMenu.anchor(),
      "Try enabling double precision to unlock more zoom, but at slower render speed",
      { onOk: showDeepZoomPrecisionStep2 });
    if (shown) deepZoomTipStage = 1;
    return shown;
  }
  // Binds whichever pass the current view calls for, falling back to f32 if
  // the df one couldn't be built. Returns the pass actually bound.
  function useCurrentPass() {
    var wanted = pickPrecision();
    var pass = getPass(wanted) || basePass;
    // Switching passes used to have to invalidate a cached cost prediction
    // here - the df pass costs several times the ALU of the f32 one, so a
    // resolution chosen against one of them missed badly for the other.
    // The progressive budget needs no such notice: it is a feedback loop
    // against measured frame times, so a pass that suddenly costs four
    // times as much simply produces a few slow frames and the budget walks
    // itself down. That is the same mechanism that already absorbs a
    // deeper zoom, a heavier scene, or a throttling GPU.
    activePass = pass;
    gl.useProgram(pass.program);
    bindQuad(pass.posLoc);
    return pass;
  }

  // A view-only rendering preference, same footing as the resolution slider -
  // not part of the scene, never saved/serialized, just a uniform flipped and
  // redrawn, not something that needs the shader itself recompiled.
  var colorZoomEnabled = false;

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
    var sampler = samplerFor(getPass(pickPrecision()) || basePass);
    if (!sampler) return 0;
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
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, target.width, target.height);
    // Only the rows actually wanted: the quad covers the whole target, and
    // on the last (short) band the rows past the end would otherwise run a
    // full simulation each for values nothing reads.
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, blockWidth, rowCount);
    gl.useProgram(sampler.program);
    // The FULL block, not the band - this is what the shader divides by to
    // get uv, so it has to describe the grid being sampled rather than the
    // slice of it being drawn (exactly as u_resolution is always the
    // full-res canvas for the ladder's own sub-lattice draws).
    gl.uniform2f(sampler.uniforms.resolution, blockWidth, blockHeight);
    gl.uniform1f(sampler.uniforms.gridStride, 1);
    gl.uniform2f(sampler.uniforms.gridOrigin, 0, rowStart);
    setCenterUniforms(sampler.uniforms);
    gl.uniform1f(sampler.uniforms.scale, view.scale);
    gl.uniform1i(sampler.uniforms.maxSteps, simulationSteps);
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
    if (!samplerFor(getPass(pickPrecision()) || basePass)) return null;
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
    return { x: view.center.x + uvx * view.scale, y: view.center.y + uvy * view.scale };
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
    var grid = sampleValueGrid(SAMPLE_SIZE, SAMPLE_SIZE);
    if (!grid) return;
    var values = [];
    for (var i = 0; i < grid.values.length; i += 4) values.push(grid.values[i]);
    if (circularSpread(values) <= COLOR_SPREAD_SUGGEST_THRESHOLD) {
      showTip("color-zoom", colorZoomCheckbox, "Try Color Zoom to highlight subtle color differences");
    }
  }

  // Everything worth offering the user once the view stops moving. There is
  // only one popover, so these run in priority order and the first one to
  // take it wins: past the float32 wall the precision limit is the thing
  // actually flattening the image, which makes a Color Zoom suggestion about
  // that same flatness misleading.
  function checkSettledViewTips() {
    if (maybeShowDeepZoomPrecisionTip()) return;
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
  // as a number.
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
  function drawSublattice(stride, originX, originY) {
    var pass = useCurrentPass();
    gl.uniform2f(pass.uniforms.resolution, canvas.width, canvas.height);
    gl.uniform1f(pass.uniforms.gridStride, stride);
    gl.uniform2f(pass.uniforms.gridOrigin, originX, originY);
    setCenterUniforms(pass.uniforms);
    gl.uniform1f(pass.uniforms.scale, view.scale);
    gl.uniform1i(pass.uniforms.colorZoom, colorZoomEnabled ? 1 : 0);
    gl.uniform1i(pass.uniforms.maxSteps, simulationSteps);
    gl.uniform1f(pass.uniforms.bounceMax, bounceMaxValue);
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
  var inspectGridSize = 3;
  var inspectGridTwoPart = true;
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
  var inspectArmMode = null; // null | "line" | "grid"
  function disarmInspect() {
    inspectArmMode = null;
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
  var inspectLineSampleCount = 30;
  // Stops short of 360 (== 0 on the hue wheel) so the last point never ends
  // up looking near-identical to the first - the interval is [0, 324], not
  // [0, 360), regardless of inspectLineSampleCount.
  var INSPECT_LINE_MAX_HUE = 324;
  function inspectLinePointColor(i) {
    var hue = inspectLineSampleCount > 1 ? i * (INSPECT_LINE_MAX_HUE / (inspectLineSampleCount - 1)) : 0;
    return { fill: "hsl(" + hue + ", 100%, 50%)", stroke: "#000000" };
  }
  function evenlySpacedPoints(start, end, count) {
    var points = [];
    for (var i = 0; i < count; i++) {
      var t = count > 1 ? i / (count - 1) : 0;
      points.push({ x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t });
    }
    return points;
  }

  // Dragging while Inspect (Grid) is armed locks a cols×rows grid of points
  // evenly spaced over the axis-aligned box the drag spans (corner1/corner2
  // in either order - sorted into min/max here), row-major so a later
  // filter/lookup (see below) can still find points by (row,col). Each
  // point keeps its own col/row for inspectGridPointColor.
  function evenlySpacedGrid(corner1, corner2, cols, rows) {
    var minX = Math.min(corner1.x, corner2.x), maxX = Math.max(corner1.x, corner2.x);
    var minY = Math.min(corner1.y, corner2.y), maxY = Math.max(corner1.y, corner2.y);
    var points = [];
    for (var row = 0; row < rows; row++) {
      var ty = rows > 1 ? row / (rows - 1) : 0;
      for (var col = 0; col < cols; col++) {
        var tx = cols > 1 ? col / (cols - 1) : 0;
        points.push({ x: minX + (maxX - minX) * tx, y: minY + (maxY - minY) * ty, col: col, row: row });
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
  function worldToCanvasAreaPixel(worldX, worldY) {
    var uvx = (worldX - view.center.x) / view.scale;
    var uvy = (worldY - view.center.y) / view.scale;
    var fx = uvx * canvas.height + 0.5 * canvas.width;
    var fy = 0.5 * canvas.height - uvy * canvas.height;
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
      canvasArea.appendChild(el);
      inspectMarkerEls.push(el);
    }
    while (inspectMarkerEls.length > flatPoints.length) {
      inspectMarkerEls.pop().remove();
    }
    flatPoints.forEach(function (entry, i) {
      var p = worldToCanvasAreaPixel(entry.worldPoint.x, entry.worldPoint.y);
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
        var a = worldToCanvasAreaPixel(group.points[pair[0]].worldPoint.x, group.points[pair[0]].worldPoint.y);
        var b = worldToCanvasAreaPixel(group.points[pair[1]].worldPoint.x, group.points[pair[1]].worldPoint.y);
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
    var startPx = worldToCanvasAreaPixel(startWorld.x, startWorld.y);
    var endPx = worldToCanvasAreaPixel(endWorld.x, endWorld.y);
    inspectLinePreviewLine.setAttribute("x1", startPx.x);
    inspectLinePreviewLine.setAttribute("y1", startPx.y);
    inspectLinePreviewLine.setAttribute("x2", endPx.x);
    inspectLinePreviewLine.setAttribute("y2", endPx.y);
    var points = evenlySpacedPoints(startWorld, endWorld, inspectLineSampleCount);
    points.forEach(function (worldPoint, i) {
      var px = worldToCanvasAreaPixel(worldPoint.x, worldPoint.y);
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
    var startPx = worldToCanvasAreaPixel(startWorld.x, startWorld.y);
    var endPx = worldToCanvasAreaPixel(endWorld.x, endWorld.y);
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
      compiled = PhysicsGridCodegen.compileHoverTrajectoryGLSL(scene, worldPoint.x, worldPoint.y, steps, pickPrecision());
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
  function lockLineOfPoints(startWorld, endWorld) {
    var available = MAX_INSPECT_POINTS - totalInspectedPointCount();
    if (available <= 0) return; // stays armed - Clear All (or removing a point) might free up room to retry
    var worldPoints = evenlySpacedPoints(startWorld, endWorld, inspectLineSampleCount);
    var count = Math.min(worldPoints.length, available);
    var points = [];
    for (var i = 0; i < count; i++) {
      var entry = computeTrajectoryEntry(worldPoints[i]);
      if (!entry) continue; // don't let one bad point abort the rest of the line
      entry.color = inspectLinePointColor(i);
      points.push(entry);
    }
    disarmInspect();
    if (points.length > 0) inspectedGroups.push({ type: "line", points: points, startWorld: startWorld, endWorld: endWorld });
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
  function lockGridOfPoints(startWorld, endWorld) {
    var layout = computeGridLayout(inspectGridSize, inspectGridTwoPart);
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
    nextColorIndex = 0;
    disarmInspect();
    updateInspectUI();
  }

  // Clicking the already-armed button cancels it (a plain toggle) rather
  // than just re-arming a no-op state - otherwise there'd be no way back to
  // "neither armed" short of dragging one to completion or clearing
  // everything. Grey means "idle, click me"; the blue .inspect-armed look
  // (see fractal-grid.css) means "now go drag the grid" - the same
  // grey-idle/blue-active convention the first page's own .tool-btn uses,
  // so the color signals which button (if either) is waiting the same way
  // it does everywhere else in the app.
  function armInspect(mode) {
    if (inspectArmMode === mode) { disarmInspect(); return; }
    inspectArmMode = mode;
    btnInspectLine.classList.toggle("inspect-armed", mode === "line");
    btnInspectGrid.classList.toggle("inspect-armed", mode === "grid");
  }
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
  var throughputEstimate = 0;  // pixels that fit in one refresh period
  // Pixels dispatched during the previous work frame - the other half of
  // the measurement, since the interval alone says nothing without knowing
  // what was being timed.
  var lastFrameSpent = 0;
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
  var pixelBudget = INITIAL_PIXEL_BUDGET;
  // Wall-clock timestamp of the last frame that actually dispatched work.
  // Frames where refinement was already complete are NOT fed back into the
  // budget: an idle rAF returns in one refresh period no matter how slow
  // the GPU is, so counting those would ratchet the budget up without
  // limit and guarantee a stutter on the next view change.
  var lastWorkFrameAt = 0;

  function noteFrameTiming(now) {
    if (lastWorkFrameAt > 0 && lastFrameSpent > 0) {
      var dt = now - lastWorkFrameAt;
      // Deliberately NOT rounded to whole periods. Under strict vsync an
      // interval really is a whole multiple of the refresh period and
      // rounding is harmless, but plenty of contexts don't present that
      // cleanly - an embedded webview, a compositor under load, a browser
      // pane rendering into another surface - and there a frame that ran
      // 1.3 periods long rounds down to "1", i.e. reads as having fit
      // comfortably, and the budget grows on the strength of a frame that
      // actually overran. Left continuous, the same interval is a straight
      // measurement of how much work fits in one period.
      var periods = Math.max(1, dt / displayPeriodMs);
      if (periods > OVERRUN_RATIO) {
        // A real measurement of how much work fits in one period.
        var measured = lastFrameSpent / periods;
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
        throughputEstimate = throughputEstimate > 0
          ? throughputEstimate * (1 - blend) + measured * blend
          : measured;
        pixelBudget = throughputEstimate * BUDGET_SAFETY;
      } else {
        // Fit inside one period, by an unknowable margin. Creep upward.
        pixelBudget *= BUDGET_GROW;
        throughputEstimate = Math.max(throughputEstimate, pixelBudget / BUDGET_SAFETY);
      }
      pixelBudget = clamp(pixelBudget, MIN_PIXEL_BUDGET, MAX_PIXEL_BUDGET);
    }
    lastWorkFrameAt = now;
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
    return Math.max(sliderValueToStride(Number(resolutionMinSlider.value)), endStride());
  }
  function endStride() {
    return sliderValueToStride(Number(resolutionMaxSlider.value));
  }

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
  // because interpolating a chaotic field would produce colours belonging
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
  //    averaging happens, averaging opposing hues in RGB tends toward grey,
  //    and those regions visibly calm down. That is the truthful rendering
  //    - it says "there is nothing resolvable here", the same thing the
  //    precision readout says in words - rather than a bug to be tuned out.
  //
  // Two things keep this from ever costing the user anything. It runs only
  // once the ladder has fully settled, so it never competes with panning;
  // and sample 0 is the pixel centre, i.e. exactly the image the ladder
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
  // i=0 returns (0,0), the pixel centre.
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
  // the pixel centre - and hands the AA phase something to build on.
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
  function drawAaBand(maxRows) {
    var rows = Math.min(maxRows, canvas.height - progressive.band);
    if (rows <= 0) return 0;
    var n = progressive.aaSample + 1;         // the sample being added
    var off = aaOffset(progressive.aaSample); // 0-based index of that sample
    gl.bindFramebuffer(gl.FRAMEBUFFER, aaAccum.fbo);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, progressive.band, canvas.width, rows);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.CONSTANT_ALPHA, gl.ONE_MINUS_CONSTANT_ALPHA);
    gl.blendColor(0, 0, 0, 1 / n);
    drawSublattice(1, off.x, off.y);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    progressive.band += rows;
    return rows;
  }

  // How many sample points a level of the given stride has, in each
  // direction. ceil so the right and bottom edges are always covered: with
  // floor, a canvas whose width isn't a multiple of the stride would leave
  // its last partial cell unsampled and therefore unpainted.
  function levelWidth(stride) { return Math.max(1, Math.ceil(canvas.width / stride)); }
  function levelHeight(stride) { return Math.max(1, Math.ceil(canvas.height / stride)); }

  // Abandon whatever refinement is in flight. Deliberately does NOT touch
  // the accumulator or the canvas: the picture on screen stays up until
  // something better replaces it, which is what makes a pan look like the
  // image being dragged and re-resolved rather than flickering through
  // black between frames.
  function resetProgressive() {
    progressive.stride = 0;
    progressive.sublattice = 1;
    progressive.band = 0;
    progressive.complete = false;
    progressive.accumStride = 0;
    progressive.aaSample = 0;
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
    if (isBouncesOutput) bounceMaxValue = findBounceMax();
    progressive.stride = startStride();
    progressive.sublattice = 0;   // 0 = the base level, drawn straight into the accumulator
    progressive.band = 0;
    progressive.complete = false;
    progressive.accumStride = 0;
    // Both of these describe the view rather than the image, so they belong
    // with the start of a run, not with every level inside it.
    updateInspectMarkers();
    updatePrecisionReadout();
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

  // Draws up to `maxRows` more rows of whatever is currently in progress -
  // either the base level (sub-lattice 0, straight into the accumulator) or
  // one of the three sub-lattices that refine it. Returns how many rows it
  // actually drew, so the budget loop can charge itself the real pixel
  // count rather than what it asked for.
  //
  // The three sub-lattices of a step from stride s to s/2 are exactly the
  // new sample positions the coarser grid didn't already cover: offset by
  // half a cell across, down, or both.
  function drawSublatticeBand(maxRows) {
    var k = progressive.sublattice;
    var w = levelWidth(progressive.stride);
    var h = levelHeight(progressive.stride);
    var rows = Math.min(maxRows, h - progressive.band);
    if (rows <= 0) return 0;
    var half = progressive.stride / 2;
    var target, originX, originY;
    if (k === 0) {
      target = accum[accumIndex];
      originX = originY = 0;
    } else {
      target = sublattices[k - 1];
      originX = (k === 2) ? 0 : half;   // sub-lattices 1 and 3 are shifted across
      originY = (k === 1) ? 0 : half;   // sub-lattices 2 and 3 are shifted down
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, w, h);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, progressive.band, w, rows);
    drawSublattice(progressive.stride, originX, originY);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    progressive.band += rows;
    return rows;
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
    if (progressive.aaSample > 0 && aaAccum) {
      drawPresent(aaAccum.tex, canvas.width, canvas.height);
      return;
    }
    if (progressive.sublattice > 1) {
      // Mid-level: show a preview that includes the sub-lattices finished
      // so far, without disturbing the accumulator the next composite reads.
      var preview = runComposite(progressive.sublattice - 1);
      presentLevel(preview.target, preview.w, preview.h, preview.stride);
      return;
    }
    if (progressive.accumStride > 0) {
      presentLevel(accum[accumIndex], levelWidth(progressive.accumStride),
        levelHeight(progressive.accumStride), progressive.accumStride);
    }
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
      lastWorkFrameAt = 0;
      lastFrameSpent = 0;
      return;
    }

    noteFrameTiming(now);
    var spent = 0;

    // Antialiasing runs on the same budget, banding and present path as
    // everything else - a whole-screen sample is as expensive as the entire
    // ladder that preceded it, so it emphatically cannot be one draw.
    if (progressive.aaSample > 0) {
      while (spent < pixelBudget || spent === 0) {
        var aaRows = drawAaBand(Math.max(MIN_BAND_ROWS,
          Math.floor((pixelBudget - spent) / Math.max(canvas.width, 1))));
        if (aaRows === 0) break;
        spent += aaRows * canvas.width;
        if (progressive.band < canvas.height) continue;
        progressive.aaSample += 1;
        progressive.band = 0;
        updateResolutionBoundsUI();
        if (progressive.aaSample >= MAX_AA_SAMPLES) return finishRun(spent);
      }
      lastFrameSpent = spent;
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
      var rowBudget = Math.max(MIN_BAND_ROWS, Math.floor((pixelBudget - spent) / Math.max(width, 1)));
      var rows = drawSublatticeBand(rowBudget);
      if (rows === 0) break;
      spent += rows * width;
      if (progressive.band < levelHeight(progressive.stride)) continue;

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
    lastFrameSpent = spent;
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
    lastFrameSpent = spent || 0;
    // The ladder is done. If antialiasing is on, this isn't the end of the
    // work, just the end of the first sample - and only when the ladder
    // actually reached one simulation per pixel, since averaging offset
    // samples of a deliberately coarse render would just blur the blocks.
    if (progressive.aaSample === 0 && endStride() <= 1 &&
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
    // The one moment the view is genuinely finished - full resolution (or
    // whatever the resolution slider stops at) AND every antialiasing
    // sample averaged in. Global Stats waits for exactly this and then a
    // further beat on top, being the lowest-priority work on the page.
    statsOnRenderSettled();
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
  function resizeCanvas() {
    if (canvasArea.clientWidth <= 0 || canvasArea.clientHeight <= 0) return;
    var dpr = window.devicePixelRatio || 1;
    var w = Math.max(1, Math.round(canvasArea.clientWidth * dpr));
    var h = Math.max(1, Math.round(canvasArea.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
      markDirty();
      // Global Stats' resolution slider is expressed against this size -
      // its top stop is one sample per rendered pixel - so the card has to
      // be told, whether or not anyone is looking at it. (The measurement
      // itself reads the canvas when it runs and is never stale; it is the
      // readout, and how many stops the slider has, that would be.)
      if (statsPanel) {
        if (statsOpen) statsPanel.relayout();
        else statsPanel.refreshSampleReadout();
      }
    }
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
    var worldX = view.center.x + uv.uvx * view.scale;
    var worldY = view.center.y + uv.uvy * view.scale;
    view.scale = clamp(view.scale * factor, MIN_SCALE, MAX_SCALE);
    view.center.x = worldX - uv.uvx * view.scale;
    view.center.y = worldY - uv.uvy * view.scale;
  }

  canvas.addEventListener("wheel", function (e) {
    e.preventDefault();
    zoomAtClientPoint(e.clientX, e.clientY, Math.pow(1.0016, e.deltaY));
    updateZoomReadout();
    markDirty();
  }, { passive: false });

  // Pans the view by a raw pixel delta in CLIENT (CSS) pixels - "drag the
  // content by this many screen pixels." Shared by the mouse-drag pan below
  // and both touch gestures further down (a one-finger drag, and a
  // two-finger pinch's own midpoint motion), instead of three copies of the
  // same conversion from screen pixels to world units.
  function panByClientDelta(dxPix, dyPix) {
    var scaleFactor = canvas.width / canvas.getBoundingClientRect().width;
    var worldPerPixel = (view.scale / canvas.height) * scaleFactor;
    view.center.x -= dxPix * worldPerPixel;
    view.center.y += dyPix * worldPerPixel;
  }

  var dragging = false, lastClientX = 0, lastClientY = 0, dragDistance = 0;
  // Below this many total pixels of movement between mousedown and mouseup,
  // treat it as a click (lock a single Inspect point, or - with Line/Grid
  // armed - just show the "drag instead" toast) rather than a pan or an
  // Inspect drag - a real drag easily exceeds it within the first couple of
  // mousemoves.
  var CLICK_DRAG_THRESHOLD = 4;
  // The world point an Inspect-armed drag started at - see beginDrag below.
  // Only meaningful while inspectArmMode && dragging.
  var inspectDragStartWorld = null;

  // Snapped to the same grid-cell resolution the hover preview itself
  // samples at (see handleDragMove below) - a locked point then corresponds
  // to an actual rendered cell, not an arbitrary sub-pixel float. Takes a
  // plain {clientX, clientY} rather than a real event, since a Touch object
  // carries exactly those same two fields and needs no adapting.
  function snappedWorldPointFromEvent(e) {
    var uv = pixelToUV(e.clientX, e.clientY);
    var worldPerCell = view.scale / canvas.height;
    return {
      x: Math.round((view.center.x + uv.uvx * view.scale) / worldPerCell) * worldPerCell,
      y: Math.round((view.center.y + uv.uvy * view.scale) / worldPerCell) * worldPerCell,
    };
  }

  // ---- One-finger drag: mouse and single-touch share this exact logic ----
  //
  // beginDrag/handleDragMove/endDrag take plain (clientX, clientY) pairs,
  // not an event, so both the mouse listeners below and the touch listeners
  // further down can call the same three functions instead of keeping two
  // hand-synced copies of "pan, or preview/commit an Inspect line or grid."
  function beginDrag(clientX, clientY) {
    dragging = true;
    lastClientX = clientX;
    lastClientY = clientY;
    dragDistance = 0;
    if (inspectArmMode) {
      // Don't pan while armed - see handleDragMove below. Recorded now (not
      // just at the end of the drag) so the line/rectangle preview starts
      // from the actual press point.
      inspectDragStartWorld = snappedWorldPointFromEvent({ clientX: clientX, clientY: clientY });
    } else {
      canvas.classList.add("dragging");
    }
  }
  function handleDragMove(clientX, clientY) {
    var dxPix = clientX - lastClientX;
    var dyPix = clientY - lastClientY;
    dragDistance += Math.abs(dxPix) + Math.abs(dyPix);
    lastClientX = clientX;
    lastClientY = clientY;
    if (inspectArmMode) {
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
      if (dragDistance < CLICK_DRAG_THRESHOLD) {
        // A plain click/tap with NEITHER armed always locks a single
        // Inspect point - no button needed for this. With Line or Grid
        // armed, a plain click isn't enough to mean "make one of those" (a
        // real drag still has to default to panning, so that meaning needs
        // an unambiguous drag, not just a click), so it just reminds
        // instead of silently doing nothing, and leaves the mode armed for
        // the drag it's actually waiting for.
        if (inspectArmMode === "line") showInspectToast("Drag to inspect a line");
        else if (inspectArmMode === "grid") showInspectToast("Drag to inspect a grid");
        // Neither arms without the Inspect card open (their buttons live
        // inside it), so a collapsed card always reaches this branch with
        // nothing armed - exactly where a plain click otherwise locks a new
        // point. Collapsed means "not right now" (see makeMenu's own
        // comment), so this is the one thing that has to check for it
        // explicitly rather than relying on disarmInspect leaving nothing
        // else to do.
        else if (inspectMenu.isOpen()) lockPointAt(current);
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

  canvas.addEventListener("mousedown", function (e) { beginDrag(e.clientX, e.clientY); });
  window.addEventListener("mousemove", function (e) { if (dragging) handleDragMove(e.clientX, e.clientY); });
  window.addEventListener("mouseup", function (e) { endDrag(e.clientX, e.clientY); });

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
    if (e.touches.length === 1) {
      beginDrag(e.touches[0].clientX, e.touches[0].clientY);
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
      // wheel handler's factor<1 branch - not increase.
      zoomAtClientPoint(mid.x, mid.y, pinchDistance / dist);
      pinchMidX = mid.x; pinchMidY = mid.y; pinchDistance = dist;
      updateZoomReadout();
      markDirty();
    } else if (e.touches.length === 1 && dragging) {
      e.preventDefault();
      handleDragMove(e.touches[0].clientX, e.touches[0].clientY);
    }
  }, { passive: false });

  function onTouchEnd(e) {
    if (e.touches.length === 0) {
      // changedTouches, not the now-empty e.touches, has the lifted
      // finger's last known position - needed either to commit a one-finger
      // drag's Inspect tap/line/grid (endDrag) or, if this touch just ended a
      // pinch instead (dragging is already false then), to harmlessly reset
      // the "dragging" CSS class.
      var last = e.changedTouches[0];
      endDrag(last.clientX, last.clientY);
      pinchDistance = 0;
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
      if (!inspectArmMode) {
        dragging = true;
        lastClientX = e.touches[0].clientX;
        lastClientY = e.touches[0].clientY;
        // Starts this finger's own count fresh, same as a real beginDrag -
        // otherwise whatever a plain click now does (see endDrag) could
        // fire off however little the FIRST finger happened to move before
        // the second one landed, plus however little this one moves before
        // it's lifted, even though the gesture in between was a pinch.
        dragDistance = 0;
        canvas.classList.add("dragging");
      }
    }
  }
  window.addEventListener("touchend", onTouchEnd, { passive: false });
  window.addEventListener("touchcancel", onTouchEnd, { passive: false });

  btnResetView.addEventListener("click", function () {
    view.center.x = DEFAULT_CENTER.x;
    view.center.y = DEFAULT_CENTER.y;
    view.scale = DEFAULT_SCALE;
    colorZoomEnabled = false;
    colorZoomCheckbox.checked = false;
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
  function syncStepsUI() {
    stepsSlider.value = String(simulationSteps / SIMULATION_STEPS_PER_NOTCH);
    updateStepsUI(simulationSteps);
  }
  function updateStepsUI(value) {
    stepsReadout.textContent = value.toLocaleString();
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
  stepsSlider.addEventListener("change", function () {
    var next = stepsFromSlider();
    if (next === simulationSteps) return;
    simulationSteps = next;
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
  });

  colorZoomCheckbox.addEventListener("change", function () {
    colorZoomEnabled = colorZoomCheckbox.checked;
    if (colorZoomEnabled && activeTipId === "color-zoom") hideTip(); // they took the suggestion (or just found the checkbox themselves) - either way it's moot now
    markDirty();
  });

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
    hoverPlayPauseBtn.textContent = playbackPlaying ? "⏸" : "▶";
    hoverPlayPauseBtn.title = playbackPlaying ? "Pause" : "Play";
    hoverPlayPauseBtn.setAttribute("aria-label", playbackPlaying ? "Pause" : "Play");
  }

  // ---- Playback speed ----
  //
  // A multiplier on hoverStepsPerSecond()'s own base rate, read fresh every
  // tick - see playbackTick - so dragging the slider takes effect
  // immediately on whatever's already animating rather than only on the
  // next hover. Not part of setPlaybackControlsEnabled below: it's a
  // standing preference (like the grid's own Simulation Duration setting),
  // useful to set before ever hovering a pixel, not a transport control
  // that needs something loaded to act on. Defaults to 2x on this page -
  // physics-ui.js's own default is a real-time 1x instead.
  var playbackSpeed = 2;
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
  // The HTML hardcodes matching min/max/step (see #hover-speed-slider's own
  // comment) for a flash-free first paint before this runs - set from the
  // same constants here so the two can never quietly drift apart.
  hoverSpeedSlider.min = String(SPEED_LOG_MIN);
  hoverSpeedSlider.max = String(SPEED_LOG_MAX);
  hoverSpeedSlider.step = "1";

  // "2x"/"16x" (no decimal) once a whole step no longer reads as a
  // meaningfully different speed; "0.5x"/"1.3x" below that, where a tenth
  // is still a noticeable fraction of the current value.
  function formatSpeed(v) {
    return (v < 2 ? v.toFixed(1) : String(Math.round(v))) + "x";
  }

  function updateSpeedUI() {
    var text = formatSpeed(playbackSpeed);
    hoverSpeedBtn.textContent = text;
    hoverSpeedValueEl.textContent = text;
    hoverSpeedSlider.value = String(speedToSliderValue(playbackSpeed));
  }

  // Fixed positioning (see #hover-speed-popup's own HTML comment) means
  // this has to be placed by hand, the same way positionTip places this
  // file's own tip popover: measured against the button's live position
  // rather than laid out declaratively, since nothing here is a
  // normal-flow descendant of it. Centered above the button, clamped so a
  // button near either edge doesn't push the popup off-screen.
  function positionSpeedPopup() {
    var rect = hoverSpeedBtn.getBoundingClientRect();
    var width = hoverSpeedPopup.offsetWidth, height = hoverSpeedPopup.offsetHeight;
    var left = clamp(rect.left + rect.width / 2 - width / 2, 8, window.innerWidth - width - 8);
    hoverSpeedPopup.style.left = left + "px";
    hoverSpeedPopup.style.top = (rect.top - height - 8) + "px";
  }

  function openSpeedPopup() {
    hoverSpeedPopup.hidden = false;
    hoverSpeedBtn.setAttribute("aria-expanded", "true");
    positionSpeedPopup();
    hoverSpeedSlider.focus();
  }
  function closeSpeedPopup() {
    if (hoverSpeedPopup.hidden) return;
    hoverSpeedPopup.hidden = true;
    hoverSpeedBtn.setAttribute("aria-expanded", "false");
  }

  hoverSpeedBtn.addEventListener("click", function (e) {
    e.stopPropagation(); // otherwise the document click listener below sees this same click as "outside" and immediately closes what it just opened
    if (hoverSpeedPopup.hidden) openSpeedPopup(); else closeSpeedPopup();
  });
  hoverSpeedSlider.addEventListener("input", function () {
    playbackSpeed = clamp(sliderValueToSpeed(Number(hoverSpeedSlider.value)), SPEED_MIN, SPEED_MAX);
    updateSpeedUI();
  });
  document.addEventListener("click", function (e) {
    if (hoverSpeedPopup.hidden) return;
    if (hoverSpeedBtn.contains(e.target) || hoverSpeedPopup.contains(e.target)) return;
    closeSpeedPopup();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !hoverSpeedPopup.hidden) { closeSpeedPopup(); hoverSpeedBtn.focus(); }
  });
  window.addEventListener("resize", function () {
    if (!hoverSpeedPopup.hidden) positionSpeedPopup();
  });

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
    if (hoverUpgradeTimer) { clearTimeout(hoverUpgradeTimer); hoverUpgradeTimer = null; }
    hoverKey = null;
    activeReplay = null;
    playbackStep = 0;
    setPlaybackControlsEnabled(false);
    updatePlayPauseButtonUI();
    updateProgressSliderPosition();
    hoverEmptyState.hidden = false;
    hoverEmptyState.textContent = message || "Hover the grid to preview a pixel";
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
  // scene's default colouring, exactly as drawHoverBody does.
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
    // "coloured body, dark outline" treatment drawHoverBody gives that
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

  function drawHoverBody(spec, row, colorOverride) {
    var fill = colorOverride ? colorOverride.fill : (spec.isAnchored ? "#5a6178" : "#3a63d1");
    var stroke = colorOverride ? colorOverride.stroke : (spec.type === "circle" ? (spec.isAnchored ? "#7a8199" : "#7ea0ff") : (spec.isAnchored ? "#5a6178" : "#3a63d1"));
    hoverCtx.fillStyle = fill;
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
      // Deliberately one flat colour for the whole outline. #editor-view
      // colours each of the four edges by its ROLE - which side teleports,
      // which side splits, which are plain walls - because that is the view
      // where you build the thing. This panel is a thumbnail of one pixel's
      // starting state; the edge roles aren't what you're reading it for,
      // and four colours at this size is just noise.
      hoverCtx.lineCap = "round";
      hoverCtx.lineJoin = "round";
      if (colorOverride) {
        // Same two-pass outline a line gets under an inspected colour, and for
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
        var effective = [];
        for (var i = 0; i < row.length; i++) {
          var bodyRow = (isFinalFrame && entry.wrapOverride && entry.wrapOverride.bodyIndex === i)
            ? { x: entry.wrapOverride.x, y: entry.wrapOverride.y, angle: entry.wrapOverride.angle, half: row[i].half }
            : row[i];
          if (!hoverRowIsLive(i, row)) continue;
          effective.push(bodyRow);
          drawHoverBody(hoverBodySpec(i), bodyRow, color);
        }
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
      });
    });
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
  // its step count - scaled by the user's own playbackSpeed on top of that
  // fixed base rate. Expressed as a rate rather than "steps per callback"
  // because the tick is driven by wall-clock elapsed time (see
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
      var effectiveRow = [];
      for (var i = 0; i < row.length; i++) {
        // wrapOverride has no `half` (a resize-link's rendered size is
        // unaffected by this x/y/angle correction) - keep this step's own.
        var bodyRow = (isFinalFrame && activeReplay.wrapOverride && i === activeReplay.wrapOverride.bodyIndex)
          ? { x: activeReplay.wrapOverride.x, y: activeReplay.wrapOverride.y, angle: activeReplay.wrapOverride.angle, half: row[i].half }
          : row[i];
        if (!hoverRowIsLive(i, row)) continue;
        effectiveRow.push(bodyRow);
        drawHoverBody(hoverBodySpec(i), bodyRow);
      }
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
      // Everything on screen has reached its final logged frame - hold
      // there for a beat, then play the whole thing again from the start
      // (every replay loops this way, with or without Inspect) unless the
      // user paused during the hold.
      hoverRafId = null;
      hoverLoopTimer = setTimeout(function () {
        hoverLoopTimer = null;
        if (!playbackPlaying) return;
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
  }

  function resumePlayback() {
    // Resuming after the end (or being paused right there) restarts from
    // the top, same as the auto-loop in playbackTick above.
    if (playbackStep >= playbackClockCeiling() - 1) playbackStep = 0;
    playbackPlaying = true;
    updatePlayPauseButtonUI();
    ensurePlaybackAdvancing();
  }

  // The one entry point for "start showing something new": a fresh hover
  // point (runHoverAt) or Inspect-only preview (beginInspectOnlySession).
  // Always starts at step 0 and auto-plays - restarting from 0 is what
  // guarantees a newly-added inspected point starts in sync with everything
  // already on screen (see restartCurrentPreview) - and always stops
  // whatever was animating before it, so a slow point that finishes
  // compiling after the cursor has moved on can't draw over a session that
  // has since moved on to something else.
  function beginPlaybackSession(replay) {
    stopHoverReplay();
    activeReplay = replay || null;
    playbackStep = 0;
    playbackConfiguredMax = hoverStepCount();
    hoverProgressSlider.min = "0";
    hoverProgressSlider.max = String(Math.max(0, playbackConfiguredMax - 1));
    setPlaybackControlsEnabled(true);
    playbackPlaying = true;
    playbackAutoStartedAt = performance.now();
    updatePlayPauseButtonUI();
    ensurePlaybackAdvancing();
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
      pausePlayback();
    } else {
      resumePlayback();
    }
  });

  hoverProgressSlider.addEventListener("input", function () {
    if (!playbackHasSession) return;
    pausePlayback();
    playbackStep = Number(hoverProgressSlider.value);
    renderPlaybackFrame();
  });

  hoverResetBtn.addEventListener("click", function () {
    if (!playbackHasSession) return;
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
      compiled = PhysicsGridCodegen.compileHoverTrajectoryGLSL(scene, worldPoint.x, worldPoint.y, steps, pickPrecision());
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
    });
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
    beginPlaybackSession(null);
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
    var worldPerCell = view.scale / canvas.height;
    var world = {
      x: Math.round((view.center.x + uv.uvx * view.scale) / worldPerCell) * worldPerCell,
      y: Math.round((view.center.y + uv.uvy * view.scale) / worldPerCell) * worldPerCell,
    };
    var key = world.x.toFixed(6) + "," + world.y.toFixed(6);
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
  // card is open AND that section's switch is on; every section starts off;
  // and the whole thing is the lowest-priority work on the page. The last
  // one is why this never runs on the render path. It waits for the
  // refinement ladder (and its antialiasing pass) to finish completely,
  // waits a further beat on top of that, and only then works through the
  // measurement in requestIdleCallback slices - the GPU sampling banded
  // against the same adaptive pixel budget the ladder uses, and the
  // arithmetic split into steps by fractal-stats.js. Any view change at all
  // abandons whatever is in flight, mid-slice, and the card dims to say the
  // numbers on it are about somewhere else now.
  //
  // What gets measured is a re-render of the view into an offscreen float
  // target (the same drawSampleRows the superlative buttons use), NOT a
  // readback of the canvas. The canvas is 8-bit colour that has already
  // been through a hue ramp; turning that back into values would be lossy
  // where the ramp is steep, ambiguous under Color Zoom's repeats, and
  // wrong wherever antialiasing averaged two hues into a third that no
  // pixel actually holds. Sampling t directly avoids all three.

  // ---- How finely to sample the view ----
  //
  // The block the whole card is measured from is a re-render of the view at
  // its own resolution, which is NOT the screen's. Sampling coarsely is
  // cheap and describes the broad shape of the picture; sampling at one
  // simulation per rendered pixel measures exactly what is on screen, at
  // several million simulations a go. Which of those the user wants depends
  // entirely on what they are looking for, so it is a slider at the top of
  // the card rather than a constant here.
  //
  // Long-side sample counts, in the same doubling-ish progression as the
  // resolution ladder: each notch is roughly twice the work of the one
  // before it. 0 is the top notch and means "match the grid" - one sample
  // per rendered pixel, whatever that is on this screen.
  var STATS_SAMPLE_STOPS = [96, 128, 192, 256, 384, 512, 768, 1024, 1536, 2048, 3072, 4096, 6144];
  // 256, which is what this was fixed at before the slider existed: about
  // 40k simulations at 16:9, a small fraction of one rendered frame.
  var STATS_DEFAULT_SAMPLE_LONG_SIDE = 256;
  var statsSampleLongSide = STATS_DEFAULT_SAMPLE_LONG_SIDE;

  // The stops the slider actually offers on THIS screen: everything below
  // one sample per rendered pixel, then that. Trimmed rather than fixed,
  // because every stop past the screen's own resolution would measure the
  // identical block - several indistinguishable notches at the top of a
  // slider, all of them the most expensive setting there is.
  function statsSampleLadder() {
    var cap = Math.min(MAX_TEXTURE_SIZE, Math.max(canvas.width, canvas.height, 1));
    var list = [];
    for (var i = 0; i < STATS_SAMPLE_STOPS.length; i++) {
      if (STATS_SAMPLE_STOPS[i] < cap) list.push(STATS_SAMPLE_STOPS[i]);
    }
    list.push(0); // one sample per rendered pixel, whatever that is here
    return list;
  }

  // The block a given ladder entry asks for, in samples, proportioned to
  // the canvas so the sampled rectangle is the one on screen rather than a
  // stretched version of it - which matters far more here than it does for
  // the superlative buttons, since whole sections of this card are about
  // direction and scale.
  function statsSampleBlock(longSide) {
    var cw = Math.max(1, canvas.width), ch = Math.max(1, canvas.height);
    // One sample per rendered pixel is the finest that means anything: past
    // it, two samples would run the same simulation the grid ran once.
    var cap = Math.min(MAX_TEXTURE_SIZE, Math.max(cw, ch));
    var side = longSide > 0 ? Math.min(longSide, cap) : cap;
    if (side >= cap) {
      return {
        width: Math.min(cw, MAX_TEXTURE_SIZE),
        height: Math.min(ch, MAX_TEXTURE_SIZE),
        full: true,
      };
    }
    var scale = side / Math.max(cw, ch);
    return {
      width: Math.max(8, Math.round(cw * scale)),
      height: Math.max(8, Math.round(ch * scale)),
      full: false,
    };
  }

  // Everything the slider's own readout needs, in the units the rest of
  // this page already speaks (see describeStride: "px" is a rendered pixel,
  // "1 sim/px" is one simulation per one of them).
  function statsDescribeSample(longSide) {
    var block = statsSampleBlock(longSide);
    var stride = block.height > 0 ? canvas.height / block.height : 1;
    return {
      width: block.width,
      height: block.height,
      full: block.full,
      samples: block.width * block.height,
      stride: stride,
      strideLabel: block.full ? "1 sim/px" : "1 sim per " + stride.toFixed(stride < 10 ? 1 : 0) + "px",
    };
  }
  // How long after the ladder settles before measuring. Long enough that a
  // pan which pauses briefly and resumes never triggers a run at all.
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

  // The inverse of outputColorT: a sampled t back into the Output's own
  // units. Every branch mirrors one of that function's, in the same order.
  function statsValueForT(t) {
    if (isBouncesOutput) return t * bounceMaxValue;
    var rangeMax = currentOutputRangeMax();
    if (scene.output.property === "lifespan") return t * rangeMax;
    if (isInfinitePositionOutput) {
      // frameSigmoid's own inverse. Clamped off both ends first: the
      // sigmoid only reaches 0 and 1 at infinity, so a t that has rounded
      // onto either would come back as one.
      var clamped = Math.min(1 - 1e-6, Math.max(1e-6, t));
      return rangeMax * (0.5 - Math.log(1 / clamped - 1) / PhysicsEngine.OUTPUT_SIGMOID_STEEPNESS);
    }
    return t * rangeMax;
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
  // spurious spike into the orientation rose at exactly 0 and 90 degrees,
  // inflate every roughness number, and add a phantom peak to the spectrum.
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
    return statsOpen && statsPanel !== null && statsPanel.anyEnabled();
  }

  // Whether the measurement currently in flight will produce every section
  // that is switched on right now.
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
    statsGeneration++;
    statsResultIsCurrent = false;
    abandonStatsRun();
    if (!statsWantsWork()) return;
    // Only dim what is actually stale: before the first measurement there
    // is nothing on the card but its own explanations, and dimming those
    // reads as the panel being disabled.
    if (statsHasResult) statsPanel.markStale();
    statsPanel.setStatus(statsHasResult
      ? "The view moved - these numbers describe the previous one. Re-measuring once the fractal has finished rendering."
      : "Waiting for the fractal to finish rendering.", "stale");
  }

  // Called from finishRun - the one place that knows the ladder has reached
  // the end of its resolution range AND finished averaging its antialiasing
  // samples, which together is the whole of "the view is done."
  function statsOnRenderSettled() {
    if (!statsWantsWork() || statsRun) return;
    if (statsSettleTimer) clearTimeout(statsSettleTimer);
    statsSettleTimer = setTimeout(function () {
      statsSettleTimer = null;
      beginStatsRun();
    }, STATS_SETTLE_DELAY_MS);
  }

  function beginStatsRun() {
    if (!statsWantsWork() || statsRun) return;
    // The settle delay is long enough that the view can have moved again
    // while it ran; starting anyway would measure one view and label it
    // with another's.
    if (dirty || !progressive.complete) return;
    if (!samplerFor(getPass(pickPrecision()) || basePass)) {
      statsPanel.setStatus("This browser can't read floating-point values back from the GPU, so Global Stats can't measure anything here.", "stale");
      return;
    }
    var block = statsSampleBlock(statsSampleLongSide);
    var w = block.width, h = block.height;
    // How tall one band is. Half the refinement ladder's own adaptive pixel
    // budget - which is already a measurement of how many simulated pixels
    // this machine fits in one refresh period, so half of it is comfortably
    // inside one idle slice. STATS_MAX_BAND_SAMPLES is a second, flat
    // ceiling on the readback buffer, so the memory this holds does not
    // grow with the slider even though the block does.
    var bandRows = clamp(Math.floor(pixelBudget / 2 / w), 1,
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
        // analyse an untouched texture - all zeros - and present that as a
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
    statsPanel.showResult(result, info);
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

  if (statsPanelBodyEl && global.FractalStatsPanel && global.FractalStats) {
    statsPanel = FractalStatsPanel.create({
      body: statsPanelBodyEl,
      host: {
        valueForT: statsValueForT,
        formatValue: statsFormatValue,
        // The grid's own colour for this value - hoverOutputColorFinal is
        // already an exact JS copy of the shader's colorMap, Color Zoom
        // included, so a swatch here is the colour on screen and not an
        // approximation of it. Bounce Count's t can exceed 1 (the divisor
        // comes from a coarser sample than this one), which would run the
        // hue past the end of the ramp.
        colorForT: function (t) { return hoverOutputColorFinal(Math.min(1, Math.max(0, t))); },
        labelForT: function (t) { return statsFormatValue(statsValueForT(t)); },
        worldAt: function (col, row) {
          return sampleCoordToWorld({ width: statsLastWidth, height: statsLastHeight }, col, row);
        },
        sampleLadder: statsSampleLadder,
        sampleLongSide: function () { return statsSampleLongSide; },
        describeSample: statsDescribeSample,
      },
      onSampleResolutionChange: function (longSide) {
        statsSampleLongSide = longSide | 0;
        // A different block size makes every number on the card a
        // measurement of something else, so this invalidates a finished run
        // exactly as a pan does - and abandons one in flight, which is
        // measuring at the old resolution.
        statsResultIsCurrent = false;
        abandonStatsRun();
        if (!statsWantsWork()) return;
        if (progressive.complete && !dirty) {
          statsPanel.setStatus("Measuring the view on screen…", "working");
          statsOnRenderSettled();
        } else {
          statsPanel.setStatus("Waiting for the fractal to finish rendering.", "stale");
        }
      },
      onEnabledChange: function () {
        if (!statsWantsWork()) {
          abandonStatsRun();
          statsPanel.setStatus("Every measurement below is off. Switch one on to analyse the view currently on screen.");
          return;
        }
        // Switching a section OFF invalidates nothing, so it neither starts
        // a run nor disturbs one in flight.
        if (statsResultIsCurrent && !statsPanel.needsMeasurement()) {
          if (!statsRun) statsPanel.setStatus(statsLastStatus);
          return;
        }
        // Switching one ON while a run is in flight is different: which
        // sections to compute is fixed when the job is built, so a run that
        // doesn't already cover the new section never will. Restarting is
        // the only way it gets measured, and it costs only the slices
        // already spent.
        if (statsRun) {
          if (statsRunCoversEnabled()) return;
          abandonStatsRun();
        }
        if (progressive.complete && !dirty) {
          statsPanel.setStatus("Measuring the view on screen…", "working");
          statsOnRenderSettled();
        } else {
          statsPanel.setStatus("Waiting for the fractal to finish rendering.", "stale");
        }
      },
    });
    statsPanel.setStatus("Every measurement below is off. Switch one on to analyse the view currently on screen.");

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
    if (!statsPanel.anyEnabled()) {
      statsPanel.setStatus("Every measurement below is off. Switch one on to analyse the view currently on screen.");
    } else if (statsResultIsCurrent && !statsPanel.needsMeasurement()) {
      statsPanel.setStatus(statsLastStatus);
    } else if (progressive.complete && !dirty) {
      statsPanel.setStatus("Measuring the view on screen…", "working");
      statsOnRenderSettled();
    } else {
      statsPanel.setStatus("Waiting for the fractal to finish rendering.", "stale");
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
      dragStartWidth = menuStack.getBoundingClientRect().width;
      panelResizer.classList.add("dragging");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      e.preventDefault();
    });
  })();

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
  updateSpeedUI();
  showHoverEmpty(); // sets the X: 0, Y: 0 placeholder before the cursor ever touches the grid
  // Inspect is the one menu open on arrival. The other two configure and
  // measure the fractal; this one is how you read it, and landing on a page
  // of nothing but icons would hide the preview that explains what the
  // colours mean. Deliberately here rather than in the markup, so the
  // opening runs through the same path a click does.
  setInspectOpen(true);
  scheduleColorSpreadCheck(); // the default view (before any pan/zoom) can already qualify

  // Unlike the old loop, this runs work on most frames rather than only
  // after something changed: `dirty` now means "the view moved, start over"
  // and the refinement itself carries on across frames until it reaches the
  // end of the ladder, at which point stepProgressive returns immediately
  // and the loop costs nothing until the next change.
  requestAnimationFrame(function frame(now) {
    // Every frame, working or idle - see noteFrameCadence on why the idle
    // ones are the important ones.
    noteFrameCadence(now);
    if (dirty) { resetProgressive(); dirty = false; }
    stepProgressive(now);
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
    view.center.x = DEFAULT_CENTER.x;
    view.center.y = DEFAULT_CENTER.y;
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
  // a click.
  global.FractalGrid.pausePlayback = function () {
    pausePlayback();
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
    scene = nextScene;
    adoptSceneDuration();
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
    // Compiled against the OLD scene - dropped, not reused. buildPass and
    // buildSampler both rebuild lazily on next use.
    Object.keys(passes).forEach(function (k) {
      var pass = passes[k];
      if (pass && pass.program) gl.deleteProgram(pass.program);
      if (pass && pass.sampler && pass.sampler.program) gl.deleteProgram(pass.sampler.program);
      delete passes[k];
    });
    clearInspected();
    view.center.x = DEFAULT_CENTER.x;
    view.center.y = DEFAULT_CENTER.y;
    view.scale = DEFAULT_SCALE;
    canvas.hidden = false;
    emptyState.hidden = true;
    setStatus(true, "Ready");
    // Measured against the old scene, in the old scene's units - dropped
    // rather than dimmed, unlike an ordinary view change (see markStale).
    if (statsPanel) { statsHasResult = false; statsResultIsCurrent = false; statsPanel.clearResult(); }
    resizeCanvas();
    markDirty();
  };

  }
})(window);
