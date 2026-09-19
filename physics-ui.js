// This file is part of Chaos Accelerator, licensed under the Common Public
// Attribution License, Version 1.0 (CPAL-1.0) - see LICENSE in the project
// root, or https://chaosaccelerator.com/license for a hosted copy.

(function (global) {
  "use strict";

  // Now a scene property (scene.simulationSteps - the Simulation Duration
  // slider), not a fixed constant: it travels with the scene through export/
  // import and the Fractal Grid handoff, so the same duration authored here
  // is what a sent scene simulates per pixel there. This is only the default
  // for a brand-new scene, and for pasted JSON that leaves it out - see the
  // scene object literal and parseSceneData below.
  var DEFAULT_SIMULATION_STEPS = 1000;
  // Notches are hundreds of steps - matches fractal-grid.js's own slider
  // exactly, notch-for-notch, since a scene's simulationSteps now has to mean
  // the same thing on both pages' identical sliders.
  var SIMULATION_STEPS_PER_NOTCH = 100;
  var SIMULATION_STEPS_MAX_NOTCHES = 50;
  // Handoff to #grid-view - localStorage (not a URL param) since the
  // scene can be arbitrarily large and this is same-origin, same-browser
  // navigation, not a link meant to be shared.
  var GRID_HANDOFF_KEY = "physicsFractalScene";
  // Auto-saved on every edit so navigating away and back (e.g. via the
  // above, or the topbar's back-link) restores exactly what was there
  // before, instead of resetting to the hardcoded seed scene.
  var EDITOR_STORAGE_KEY = "physicsEditorScene";
  // Shared with fractal-grid.js's tip-popover system (not page-specific) -
  // this page has no tips of its own yet, but the Settings panel's Reset
  // Tool Tips button clears the same key either way, so it's ready to work
  // the moment tips do get added here too.
  var TIP_DISMISSED_KEY = "physicsAppDismissedTips";

  var canvas = document.getElementById("physics-canvas");
  var ctx = canvas.getContext("2d");
  var canvasArea = document.getElementById("canvas-area");
  // Floats over the canvas at top center - read for its RECT, not grabbed
  // for hiding: it is what decides how far down the drag-to-delete zone has
  // to sit. See deleteZoneCenter.
  var playbackToolbar = document.getElementById("playback-toolbar");
  var panelEl = document.getElementById("panel");
  var btnSettings = document.getElementById("btn-settings");
  var btnSettingsClose = document.getElementById("btn-settings-close");
  var settingsPanel = document.getElementById("settings-panel");
  var btnResetTips = document.getElementById("btn-reset-tips");
  var btnMute = document.getElementById("btn-mute");
  var soundVolumeSlider = document.getElementById("sound-volume-slider");
  var soundVolumeIcon = document.getElementById("sound-volume-icon");
  var statusEl = document.getElementById("status");
  var stepReadout = document.getElementById("step-readout");
  var toolButtons = Array.prototype.slice.call(document.querySelectorAll(".tool-btn"));
  var btnPlayPause = document.getElementById("btn-play-pause");
  var playbackProgressSlider = document.getElementById("playback-progress-slider");
  var btnSpeed = document.getElementById("btn-speed");
  var speedPopup = document.getElementById("speed-popup");
  var speedSlider = document.getElementById("speed-slider");
  var speedValueEl = document.getElementById("speed-value");
  var btnReset = document.getElementById("btn-reset");
  var edgeModeSelect = document.getElementById("edge-mode-select");
  var maxBodiesSlider = document.getElementById("max-bodies-slider");
  var maxBodiesReadout = document.getElementById("max-bodies-readout");
  var maxBodiesField = document.getElementById("max-bodies-field");
  var mutualGravityCheckbox = document.getElementById("mutual-gravity-checkbox");
  var collisionsCheckbox = document.getElementById("collisions-checkbox");
  var simulationStepsSlider = document.getElementById("simulation-steps-slider");
  var simulationStepsReadout = document.getElementById("simulation-steps-readout");
  var btnExportScene = document.getElementById("btn-export-scene");
  var btnImportScene = document.getElementById("btn-import-scene");
  var modalBackdrop = document.getElementById("modal-backdrop");
  var modalTitle = document.getElementById("modal-title");
  var btnModalClose = document.getElementById("btn-modal-close");
  var exportModalContent = document.getElementById("export-modal-content");
  var exportJsonTextarea = document.getElementById("export-json-textarea");
  var importModalContent = document.getElementById("import-modal-content");
  var importJsonTextarea = document.getElementById("import-json-textarea");
  var btnModalLoadScene = document.getElementById("btn-modal-load-scene");
  var importJsonErrorEl = document.getElementById("import-json-error");
  var btnSampleDoublePendulum = document.getElementById("btn-sample-double-pendulum");
  var btnSamplePinball = document.getElementById("btn-sample-pinball");
  var btnSampleBinaryStar = document.getElementById("btn-sample-binary-star");
  var btnClearAll = document.getElementById("btn-clear-all");
  var xInputBodySelect = document.getElementById("x-input-body");
  var xInputPropertySelect = document.getElementById("x-input-property");
  var yInputBodySelect = document.getElementById("y-input-body");
  var yInputPropertySelect = document.getElementById("y-input-property");
  var outputBodySelect = document.getElementById("output-body");
  var outputPropertySelect = document.getElementById("output-property");
  var outputBodyBSelect = document.getElementById("output-body-b");
  var btnSendToGrid = document.getElementById("btn-send-to-grid");
  var sendToGridErrorEl = document.getElementById("send-to-grid-error");

  // X/Y aren't wired to any behavior yet - this just records, per the scene,
  // which (body, property) pair is earmarked as the future override target
  // for the fractal-viewer integration. Output IS wired up (colors the
  // playback background) - it excludes radius/length since the simulation
  // never changes a shape's size, only its position and rotation.
  // vx/vy: an offset added to whatever starting velocity the body already
  // has (authored directly, or set with the Set Velocity tool) - the exact
  // same "offset an authored value" treatment x/y/angle/radius/length/size
  // already get, just landing on velocity instead of position/shape. Listed
  // last since, unlike every property above it, changing it has no visible
  // effect on the scene as drawn in the editor (only once Play/the grid
  // steps the scene does a velocity do anything) - see
  // physics-grid-codegen.js's velocityTargets for where the offset is
  // actually applied.
  var PROPERTIES_BY_TYPE = {
    circle: [
      { key: "x", label: "Center X" },
      { key: "y", label: "Center Y" },
      { key: "radius", label: "Radius" },
      { key: "angle", label: "Rotation" },
      { key: "vx", label: "Starting X Velocity" },
      { key: "vy", label: "Starting Y Velocity" },
    ],
    line: [
      { key: "x", label: "Center X" },
      { key: "y", label: "Center Y" },
      { key: "angle", label: "Rotation" },
      { key: "length", label: "Length" },
      { key: "vx", label: "Starting X Velocity" },
      { key: "vy", label: "Starting Y Velocity" },
    ],
    funnel: [
      { key: "x", label: "Center X" },
      { key: "y", label: "Center Y" },
      { key: "angle", label: "Rotation" },
      { key: "size", label: "Size" },
      { key: "vx", label: "Starting X Velocity" },
      { key: "vy", label: "Starting Y Velocity" },
    ],
    // Identical trapezoid to a funnel, so identical linkable properties -
    // only which edge is the special one differs (see createSplitter).
    splitter: [
      { key: "x", label: "Center X" },
      { key: "y", label: "Center Y" },
      { key: "angle", label: "Rotation" },
      { key: "size", label: "Size" },
      { key: "vx", label: "Starting X Velocity" },
      { key: "vy", label: "Starting Y Velocity" },
    ],
  };
  // Output-only (never an X/Y Input - see PROPERTIES_BY_TYPE above): a
  // bounce count is something a run PRODUCES, not a starting condition you
  // can dial in. Unlike the other three it isn't a body-state field at all;
  // it's accumulated over the run by counting the steps where this body
  // starts touching something (see PhysicsEngine.step's contactFlags).
  var OUTPUT_PROPERTIES = [
    { key: "x", label: "Center X" },
    { key: "y", label: "Center Y" },
    { key: "angle", label: "Rotation" },
    { key: "bounces", label: "Bounce Count" },
  ];
  // What an Output can read once a SECOND object is chosen. The three
  // positional ones become the mean of the pair; "distance" has no one-body
  // meaning at all, so it only exists here. Bounce Count is deliberately
  // absent: a bounce is one body's event, and "the average bounce count of
  // two bodies" is a number nobody wants to look at.
  var OUTPUT_PAIR_PROPERTIES = [
    { key: "x", label: "Average X" },
    { key: "y", label: "Average Y" },
    { key: "angle", label: "Average Rotation" },
    { key: "distance", label: "Distance Apart" },
  ];
  function outputPropertiesFor(output) {
    return PhysicsEngine.isPairOutput(output) ? OUTPUT_PAIR_PROPERTIES : OUTPUT_PROPERTIES;
  }

  var scene = {
    // Off: the usual constant downward gravity. On: no "down" at all, and
    // every body attracts every other by its mass instead - see
    // PhysicsEngine.computeAccelerations.
    mutualGravity: false,
    // On: bodies bounce/stick off each other exactly as they always have.
    // Off: PhysicsEngine.step never checks any pair for contact at all -
    // no impulse, no merge - so everything passes straight through
    // everything else. Toggling Mutual Gravity flips this to a sensible
    // default (see mutualGravityCheckbox's own handler) but never locks it;
    // the checkbox itself always wins after that.
    collisionsEnabled: true,
    // How many steps Play (and a scene sent to the Fractal Grid) simulates -
    // see the Simulation Duration slider. Shared with fractal-grid.js's own
    // per-pixel step count: sending a scene seeds that page's slider with
    // this value, though it can still be explored further from there without
    // that changing what's authored here.
    simulationSteps: DEFAULT_SIMULATION_STEPS,
    bodies: [],
    hinges: [],
    xInput: null,
    yInput: null,
    output: null,
    // The Pac-Man-wrap edges (see PhysicsEngine.step). Live-synced to the
    // canvas's current size while editing (see resizeCanvas), then frozen
    // the moment Play or Send-to-Grid locks in a run - see isPlaying's
    // gate on that sync, and btnSendToGrid's handler below.
    frameWidth: 0,
    frameHeight: 0,
    // "Stop when any object reaches the frame edge" - travels with
    // the scene (serialized, sent to the fractal grid) since it's really a
    // property of how this scene's Output should be read, not a page-local
    // viewing preference. Defaults on: a wrapped-around Output value is
    // rarely what you want to see colored, and continuous stop-at-edge is
    // the behavior almost every scene should use unless explicitly opted
    // out of.
    edgeMode: PhysicsEngine.DEFAULT_EDGE_MODE,
    maxSimulationBodies: PhysicsEngine.MAX_SIMULATION_BODIES,
  };
  var initialScene = null;
  var selectedIndex = -1;
  var activeTool = "select";
  var isPlaying = false;
  var stepCount = 0;
  var dragging = false;
  var dragOffset = { x: 0, y: 0 };
  // True while a body drag (see `dragging` above) currently has the body
  // over the delete zone - recomputed every mousemove, read on mouseup to
  // decide whether releasing there deletes the body instead of just moving
  // it, and read by render() to draw the zone at its "about to delete" size.
  var deleteZoneArmed = false;
  // Click-and-drag shape creation: set on mousedown while the Circle/Line
  // tool is active, updated on every mousemove to drive the temp preview
  // (see drawShapePreview), and consumed (cleared, turned into a real body)
  // on mouseup - see finalizeShapeDrawing. null whenever not actively
  // drawing a new shape.
  var drawingShape = null; // { tool: "circle" | "line", start: {x,y}, current: {x,y} }
  var velocityDrag = null; // Set Velocity tool, mid-drag: { bodyIndex, start: {x,y}, current: {x,y} }
  // The on-canvas Radius/Length handle (see resizeHandleGeometry), mid-drag.
  // Only bodyIndex: everything about WHERE the handle is and which way it
  // points is recomputed fresh every mousemove from the body's current
  // state, not cached at drag-start - a hinge-preserving resize can move
  // body.x/y out from under a stale snapshot mid-drag (see
  // PhysicsHingeGeometry.applyBodyEditPreservingHinge).
  var resizeHandleDrag = null; // { bodyIndex }
  // The on-canvas rotation handle (line only), mid-drag. angleOffset is
  // captured once at mousedown - the difference between the cursor's angle
  // around the pivot and the body's angle at that moment - so the body
  // doesn't snap the instant the drag starts (see updateRotationHandleDrag).
  var rotationHandleDrag = null; // { bodyIndex, angleOffset }
  // A drag shorter than this reads as "just a click" - places the same
  // fixed-size default shape the tool always used to (see
  // computeShapeParams), rather than the tiny near-zero-size body a literal
  // reading of the drag distance would create.
  var CLICK_DRAG_THRESHOLD = 6;
  var DEFAULT_CIRCLE_RADIUS = 30;
  var DEFAULT_LINE_LENGTH = 140;
  var DEFAULT_FUNNEL_SIZE = 120;
  // Bounds the on-canvas resize handle's drag to a sane range.
  var RADIUS_MIN = 5, RADIUS_MAX = 300;
  var LENGTH_MIN = 10, LENGTH_MAX = 800;
  var rafId = null;
  var dpr = 1;
  // 1 while editing (the canvas fills canvasArea exactly, its own long-
  // standing behavior); while playing, canvasArea can be a different size/
  // aspect ratio than the locked scene.frameWidth/frameHeight, so this is
  // how much the frame is scaled up/down to fit inside it without
  // distorting it - see resizeCanvas.
  var displayScale = 1;

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  function canvasPoint(e) {
    var rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  // ---- Rendering ----

  // Ruled from the ORIGIN out, rather than from the top-left corner in: the
  // coordinate system a scene is authored and read in puts (0, 0) at the
  // center of the frame with +y pointing up (see physics-coords.js), and a
  // mesh that starts counting from a corner quietly says otherwise. Every
  // line is the same weight - the two through the origin are deliberately
  // NOT emphasized, so this stays a sense of scale behind the scene rather
  // than a pair of marks competing with it.
  //
  // Still drawn in engine space (the same space body.x/y is in, and the
  // space this whole file draws in): this is a picture OF the authored
  // system, not a second copy of it.
  var GRID_STEP = 50;
  function drawGrid(w, h) {
    var originX = w / 2, originY = h / 2;
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(255,255,255,0.05)";
    ctx.beginPath();
    for (var x = originX % GRID_STEP; x < w; x += GRID_STEP) {
      ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, h);
    }
    for (var y = originY % GRID_STEP; y < h; y += GRID_STEP) {
      ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(w, Math.round(y) + 0.5);
    }
    ctx.stroke();
  }

  // A circle smaller than this is drawn AT this size during playback - a
  // display floor only, with nothing behind it changed: the body keeps its
  // real radius for collisions, mass and gravity, and the fractal grid's own
  // preview applies the same floor (see drawHoverBody in fractal-grid.js).
  // Small radii are easy to reach - the fractal grid can link a radius to a
  // pixel's coordinate, so a body can be a fraction of a pixel across and
  // simply invisible while it's the thing you're trying to watch.
  //
  // Playback only. While editing, the drawn size is the size you are setting,
  // and quietly rounding it up would make the Radius field lie about what it
  // does below 15.
  var MIN_PLAYBACK_DISPLAY_RADIUS = 15;
  function playbackDisplayRadius(radius) {
    return isPlaying ? Math.max(radius, MIN_PLAYBACK_DISPLAY_RADIUS) : radius;
  }

  // The trapezoid's 4 corners in path order (mouthLeft -> throatLeft ->
  // throatRight -> mouthRight) - shared by the funnel and the splitter,
  // which are the same shape. Takes a plain {x,y,angle,size} rather than a
  // real body so drawShapePreview can call it on the in-progress drag params
  // too, not just a placed body.
  var FUNNEL_MOUTH_COLOR = "#2dd4bf"; // teal: the funnel's teleporting long side
  var SPLITTER_SHORT_COLOR = "#f0883e"; // amber: the splitter's splitting short side
  function funnelPathVertices(x, y, angle, size) {
    var v = PhysicsEngine.getFunnelVertices({ x: x, y: y, angle: angle, size: size });
    return [v.mouthLeft, v.throatLeft, v.throatRight, v.mouthRight];
  }

  // Which edge of that trapezoid is the special (non-wall) one, as a pair of
  // indices into the list above: a funnel's is the long mouth (3->0, where
  // a ball teleports to the throat), a splitter's is the short throat (1->2,
  // where a ball becomes two on the mouth). The other three are ordinary
  // walls in both cases - so drawing only has to know which single edge to
  // pull out and what color it gets.
  function trapezoidEdgeRoles(type) {
    var isSplitter = type === "splitter";
    var special = isSplitter ? [1, 2] : [3, 0];
    var all = [[0, 1], [1, 2], [2, 3], [3, 0]];
    return {
      special: special,
      specialColor: isSplitter ? SPLITTER_SHORT_COLOR : FUNNEL_MOUTH_COLOR,
      solid: all.filter(function (e) { return e[0] !== special[0]; }),
    };
  }

  function isTrapezoidType(type) { return type === "funnel" || type === "splitter"; }

  function drawBody(body, selected) {
    ctx.save();
    ctx.fillStyle = body.isAnchored ? "#5a6178" : "#3a63d1";
    ctx.strokeStyle = selected ? "#ffcf4d" : (body.isAnchored ? "#7a8199" : "#7ea0ff");
    ctx.lineWidth = selected ? 3 : 2;
    if (body.type === "circle") {
      var drawRadius = playbackDisplayRadius(body.radius);
      ctx.beginPath();
      ctx.arc(body.x, body.y, drawRadius, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(body.x, body.y);
      ctx.lineTo(body.x + Math.cos(body.angle) * drawRadius, body.y + Math.sin(body.angle) * drawRadius);
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    } else if (isTrapezoidType(body.type)) {
      var pts = funnelPathVertices(body.x, body.y, body.angle, body.size);
      var roles = trapezoidEdgeRoles(body.type);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      function strokeEdges(edgeList) {
        ctx.beginPath();
        edgeList.forEach(function (e) {
          ctx.moveTo(pts[e[0]].x, pts[e[0]].y);
          ctx.lineTo(pts[e[1]].x, pts[e[1]].y);
        });
        ctx.stroke();
      }
      if (selected) {
        ctx.lineWidth = PhysicsEngine.LINE_THICKNESS + 4;
        ctx.strokeStyle = "#ffcf4d";
        strokeEdges(roles.solid.concat([roles.special]));
      }
      // The 3 wall edges match a line's own color; the special one - the
      // funnel's teleporting mouth, or the splitter's splitting short side -
      // is drawn separately in a distinct color so it reads as different
      // from a wall.
      ctx.lineWidth = PhysicsEngine.LINE_THICKNESS;
      ctx.strokeStyle = body.isAnchored ? "#5a6178" : "#3a63d1";
      strokeEdges(roles.solid);
      ctx.strokeStyle = roles.specialColor;
      strokeEdges([roles.special]);
    } else {
      var endpoints = PhysicsEngine.getLineEndpoints(body);
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(endpoints[0].x, endpoints[0].y);
      ctx.lineTo(endpoints[1].x, endpoints[1].y);
      if (selected) {
        ctx.lineWidth = PhysicsEngine.LINE_THICKNESS + 4;
        ctx.strokeStyle = "#ffcf4d";
        ctx.stroke();
      }
      ctx.lineWidth = PhysicsEngine.LINE_THICKNESS;
      ctx.strokeStyle = body.isAnchored ? "#5a6178" : "#3a63d1";
      ctx.stroke();
    }
    ctx.restore();
  }

  // Shared by drawShapePreview and finalizeShapeDrawing, so what's
  // previewed while dragging is exactly what gets placed on release. A drag
  // under CLICK_DRAG_THRESHOLD is treated as a plain click and returns the
  // same fixed-size default (centered exactly where they clicked) the tool
  // always placed before this feature existed - dragging further is what's
  // new, sizing the shape from the drag itself instead.
  function computeShapeParams(shape, endPoint) {
    var start = shape.start;
    var dx = endPoint.x - start.x, dy = endPoint.y - start.y;
    var dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < CLICK_DRAG_THRESHOLD) {
      if (shape.tool === "circle") return { x: start.x, y: start.y, radius: DEFAULT_CIRCLE_RADIUS, angle: 0, length: 0, size: 0 };
      if (shape.tool === "funnel" || shape.tool === "splitter") return { x: start.x, y: start.y, radius: 0, angle: 0, length: 0, size: DEFAULT_FUNNEL_SIZE };
      return { x: start.x, y: start.y, radius: 0, angle: 0, length: DEFAULT_LINE_LENGTH, size: 0 };
    }
    // Circle and funnel are both "drag from center, release sets size" -
    // drag distance IS the size directly, same 1:1 feel as a circle radius.
    if (shape.tool === "circle") return { x: start.x, y: start.y, radius: dist, angle: 0, length: 0, size: 0 };
    if (shape.tool === "funnel" || shape.tool === "splitter") return { x: start.x, y: start.y, radius: 0, angle: 0, length: 0, size: dist };
    return { x: (start.x + endPoint.x) / 2, y: (start.y + endPoint.y) / 2, radius: 0, angle: Math.atan2(dy, dx), length: dist, size: 0 };
  }

  // The "if they let go now" preview while click-dragging a new circle/line
  // into existence (see drawingShape) - dashed and translucent so it never
  // reads as an already-placed body.
  function drawShapePreview(shape) {
    var params = computeShapeParams(shape, shape.current);
    ctx.save();
    ctx.strokeStyle = "#ffcf4d";
    ctx.fillStyle = "rgba(255, 207, 77, 0.15)";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    if (shape.tool === "circle") {
      ctx.beginPath();
      ctx.arc(params.x, params.y, params.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(shape.start.x, shape.start.y, 3, 0, Math.PI * 2);
      ctx.fillStyle = "#ffcf4d";
      ctx.fill();
    } else if (isTrapezoidType(shape.tool)) {
      var pts = funnelPathVertices(params.x, params.y, params.angle, params.size);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      ctx.lineTo(pts[1].x, pts[1].y);
      ctx.lineTo(pts[2].x, pts[2].y);
      ctx.lineTo(pts[3].x, pts[3].y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(shape.start.x, shape.start.y, 3, 0, Math.PI * 2);
      ctx.fillStyle = "#ffcf4d";
      ctx.fill();
    } else {
      var hx = Math.cos(params.angle) * params.length / 2, hy = Math.sin(params.angle) * params.length / 2;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(params.x - hx, params.y - hy);
      ctx.lineTo(params.x + hx, params.y + hy);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Consumes `shape` (see drawingShape) into a real body at mouse-release,
  // using the exact same params drawShapePreview just showed - then
  // everything after is identical to how a body has always been created
  // (select it, refresh the mapping dropdowns, back to Select).
  function finalizeShapeDrawing(shape, endPoint) {
    var params = computeShapeParams(shape, endPoint);
    if (shape.tool === "circle") {
      scene.bodies.push(PhysicsEngine.createCircle(params.x, params.y, params.radius, false));
    } else if (shape.tool === "splitter") {
      scene.bodies.push(PhysicsEngine.createSplitter(params.x, params.y, params.size, params.angle, false));
    } else if (shape.tool === "funnel") {
      scene.bodies.push(PhysicsEngine.createFunnel(params.x, params.y, params.size, params.angle, false));
    } else {
      scene.bodies.push(PhysicsEngine.createLine(params.x, params.y, params.length, params.angle, false));
    }
    setActiveTool("select");
    refreshMappingUI();
    selectBody(scene.bodies.length - 1);
  }

  // ---- Starting-velocity arrows (the Set Velocity tool) ----
  //
  // One pixel of drag becomes this much starting speed, and an arrow drawn
  // for an existing velocity is that velocity divided by the same number -
  // so the arrow you let go of is exactly the arrow that stays behind.
  //
  // At 1, one pixel dragged is one pixel per second, so a 60px drag is a
  // tidy one pixel per frame at the engine's 1/60s step. That is a third as
  // much speed per pixel as this started out at, which is the point: aiming
  // is three times finer, at the cost of three times the drag for a given
  // speed. Note the engine's own speed ceiling now needs a drag as long as
  // the cap itself (1000px under ordinary gravity, more under Mutual), which
  // is wider than the canvas - so top speed is no longer reachable by
  // dragging alone, only by typing a velocity into a scene's JSON.
  var VELOCITY_DRAG_SCALE = 1;
  var VELOCITY_ARROW_COLOR = "#e06bff";
  // Below this there is no meaningful direction to point, and a
  // one-pixel-long arrow on every body reads as clutter rather than data.
  var VELOCITY_ARROW_MIN_SPEED = 1;

  function velocityFromDrag(drag) {
    var vx = (drag.current.x - drag.start.x) * VELOCITY_DRAG_SCALE;
    var vy = (drag.current.y - drag.start.y) * VELOCITY_DRAG_SCALE;
    // The engine clamps on the very first step anyway (see advanceVelocity),
    // so clamping here too keeps the arrow honest: it shows the speed the
    // body will actually start with, not one that would be silently trimmed
    // the moment Play is pressed. Which ceiling applies depends on the
    // scene's gravity mode, so ask rather than assuming.
    var cap = PhysicsEngine.speedCapFor(scene);
    var speed = Math.sqrt(vx * vx + vy * vy);
    if (speed > cap) {
      var k = cap / speed;
      vx *= k; vy *= k;
    }
    return { vx: vx, vy: vy };
  }

  function drawVelocityArrow(x, y, vx, vy, isPreview) {
    var speed = Math.sqrt(vx * vx + vy * vy);
    if (speed < VELOCITY_ARROW_MIN_SPEED) return;
    var len = speed / VELOCITY_DRAG_SCALE;
    var ux = vx / speed, uy = vy / speed;
    var tipX = x + ux * len, tipY = y + uy * len;
    // Head scales with the arrow but stays inside sane bounds, so a tiny
    // velocity doesn't get a head bigger than its shaft and a huge one
    // doesn't grow a head the size of the body.
    var head = Math.min(14, Math.max(6, len * 0.25));
    var perpX = -uy, perpY = ux;

    ctx.save();
    ctx.strokeStyle = VELOCITY_ARROW_COLOR;
    ctx.fillStyle = VELOCITY_ARROW_COLOR;
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    if (isPreview) ctx.setLineDash([6, 4]); // dashed only while the drag is still live
    ctx.beginPath();
    ctx.moveTo(x, y);
    // Stop the shaft just short of the tip so a round line cap can't poke
    // out through the head.
    ctx.lineTo(tipX - ux * head * 0.6, tipY - uy * head * 0.6);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - ux * head + perpX * head * 0.45, tipY - uy * head + perpY * head * 0.45);
    ctx.lineTo(tipX - ux * head - perpX * head * 0.45, tipY - uy * head - perpY * head * 0.45);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // Every non-anchored body's starting velocity, so whatever the tool left
  // behind stays visible rather than being invisible state you have to
  // remember. Editing only: during playback the velocity changes every frame
  // and is already shown by the motion itself, so arrows there would be
  // noise instead of a description of the scene being authored.
  function drawVelocityArrows() {
    if (isPlaying) return;
    for (var i = 0; i < scene.bodies.length; i++) {
      var body = scene.bodies[i];
      // An anchored body never moves, so it has no starting velocity to show
      // - and the tool refuses to give it one.
      if (body.isAnchored) continue;
      // The body being dragged right now is drawn from the live drag below
      // instead, so its old arrow doesn't linger underneath the new one.
      if (velocityDrag && velocityDrag.bodyIndex === i) continue;
      drawVelocityArrow(body.x, body.y, body.vx, body.vy, false);
    }
    if (velocityDrag) {
      var dragged = scene.bodies[velocityDrag.bodyIndex];
      var v = velocityFromDrag(velocityDrag);
      drawVelocityArrow(dragged.x, dragged.y, v.vx, v.vy, true);
    }
  }

  function drawHinge(hinge) {
    var p = PhysicsEngine.getHingeWorldPoint(hinge, scene.bodies);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
    ctx.fillStyle = "#ffcf4d";
    ctx.fill();
    ctx.strokeStyle = "#8a6d1a";
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // ---- Radius/Length/Size drag handle ----
  //
  // px beyond the shape's own edge to the handle's center - separate per
  // shape since a line's handle reads as noticeably closer than a circle's
  // at the same gap (an end point vs. a curved edge), so it wants more room.
  // A funnel/splitter uses the circle's own gap: like a circle, its handle
  // sits at a fixed 45-degree direction rather than along an axis, so the
  // same "curved edge" reasoning applies.
  var RESIZE_HANDLE_GAP_CIRCLE = 32;
  var RESIZE_HANDLE_GAP_LINE = 52;
  var RESIZE_HANDLE_GAP_FUNNEL = 32;
  var RESIZE_HANDLE_LENGTH = 34; // capsule long axis
  var RESIZE_HANDLE_WIDTH = 16; // capsule short axis
  var RESIZE_HANDLE_HIT_PAD = 6; // grabbable area extends this far past the visual capsule
  // Bounds the funnel/splitter resize handle's drag - the same range the
  // side panel's old Size field used.
  var SIZE_MIN = 10, SIZE_MAX = 400;

  function resizeHandleSupported(body) {
    return !!body && (body.type === "circle" || body.type === "line" || isTrapezoidType(body.type));
  }

  // The point a body's own rotate-or-resize actually pivots around - the
  // same point applyBodyEditPreservingHinge itself keeps fixed: its own
  // hinge's world point (however many hinges that point is itself removed
  // from the body - see PhysicsHingeGeometry.hingeWorldPointA) if it has
  // one, otherwise its own current center. Shared by the circle/trapezoid
  // resize handle's reference point and every rotation handle's drag math -
  // whichever body owns the hinge, this is what "hinged" means for it.
  function handlePivot(bodyIndex) {
    var body = scene.bodies[bodyIndex];
    var ownHinge = PhysicsHingeGeometry.findOwnHinge(scene, bodyIndex);
    return ownHinge ? PhysicsHingeGeometry.hingeWorldPointA(scene, ownHinge) : { x: body.x, y: body.y };
  }

  // Where the handle sits and which way it points, for whichever body is
  // passed in - shared by drawing, hit-testing, and the live drag itself
  // (recomputed fresh every mousemove, not cached at drag-start) so none of
  // the three can ever disagree about where the handle actually is.
  //
  // refX/refY is the point that stays fixed while dragging - see
  // handlePivot. dirX/dirY is the unit vector pointing away from that
  // point, out along the handle.
  function resizeHandleGeometry(bodyIndex) {
    var body = scene.bodies[bodyIndex];
    if (!resizeHandleSupported(body)) return null;
    var ownHinge = PhysicsHingeGeometry.findOwnHinge(scene, bodyIndex);

    if (body.type === "circle" || isTrapezoidType(body.type)) {
      var ref = handlePivot(bodyIndex);
      // 45 degrees up-and-right - screen space, so "up" is -Y. Fixed
      // regardless of the body's own angle: PhysicsEngine.halfExtent's
      // trapezoid case is the reach to its FARTHEST corner, the max over
      // every direction, so any direction - this one included - clears the
      // shape no matter how it's currently rotated.
      var dirX = Math.SQRT1_2, dirY = -Math.SQRT1_2;
      var gap = body.type === "circle" ? RESIZE_HANDLE_GAP_CIRCLE : RESIZE_HANDLE_GAP_FUNNEL;
      var dist = PhysicsEngine.halfExtent(body) + gap;
      return { refX: ref.x, refY: ref.y, dirX: dirX, dirY: dirY, x: ref.x + dirX * dist, y: ref.y + dirY * dist };
    }

    // Line: always inline with the line itself. A hinge doesn't move the
    // reference point the way it does for a circle above - it only picks
    // which end, so the handle isn't sitting right on top of the hinge dot.
    var half = body.length / 2;
    var axisX = Math.cos(body.angle), axisY = Math.sin(body.angle);
    var sign = 1;
    if (ownHinge) {
      var hp = PhysicsHingeGeometry.hingeWorldPointA(scene, ownHinge);
      var endPos = { x: body.x + axisX * half, y: body.y + axisY * half };
      var endNeg = { x: body.x - axisX * half, y: body.y - axisY * half };
      var dPos = (endPos.x - hp.x) * (endPos.x - hp.x) + (endPos.y - hp.y) * (endPos.y - hp.y);
      var dNeg = (endNeg.x - hp.x) * (endNeg.x - hp.x) + (endNeg.y - hp.y) * (endNeg.y - hp.y);
      sign = dPos >= dNeg ? 1 : -1;
    }
    var dirX2 = axisX * sign, dirY2 = axisY * sign;
    var dist2 = half + RESIZE_HANDLE_GAP_LINE;
    return { refX: body.x, refY: body.y, dirX: dirX2, dirY: dirY2, x: body.x + dirX2 * dist2, y: body.y + dirY2 * dist2 };
  }

  // The capsule shell shared by both handles - drawn in whatever local frame
  // the caller has already ctx.translate/rotate'd into, so this never has to
  // know which handle it's drawing or which way it's oriented in world space.
  function drawHandleCapsuleBase(halfLen, halfWid) {
    ctx.beginPath();
    ctx.moveTo(-halfLen + halfWid, -halfWid);
    ctx.lineTo(halfLen - halfWid, -halfWid);
    ctx.arc(halfLen - halfWid, 0, halfWid, -Math.PI / 2, Math.PI / 2);
    ctx.lineTo(-halfLen + halfWid, halfWid);
    ctx.arc(-halfLen + halfWid, 0, halfWid, Math.PI / 2, -Math.PI / 2);
    ctx.closePath();
    ctx.fillStyle = "#ffcf4d";
    ctx.strokeStyle = "#8a6d1a";
    ctx.lineWidth = 2;
    ctx.fill();
    ctx.stroke();
  }

  // The 3-line "drag me" grip texture shared by both handles, perpendicular
  // to whatever the caller's local +X axis means for it (the arrow's own
  // shaft direction, straight or curved) - same local frame as the capsule.
  function drawHandleGripLines() {
    var gripHalfLen = 5, gripSpacing = 3;
    ctx.strokeStyle = "#1b1e27";
    ctx.lineWidth = 1.5;
    [-gripSpacing, gripSpacing].forEach(function (gx) {
      ctx.beginPath();
      ctx.moveTo(gx, -gripHalfLen);
      ctx.lineTo(gx, gripHalfLen);
      ctx.stroke();
    });
  }

  // Capsule button, arrow on top: one head points back at the reference
  // point (refX/refY), the other points away from it, with 3 short grip
  // lines perpendicular to the shaft in the middle - drawn in the handle's
  // own local frame (local +X = dirX/dirY) so the shape math never has to
  // think in world space at all.
  function drawResizeHandle(bodyIndex) {
    var geo = resizeHandleGeometry(bodyIndex);
    if (!geo) return;
    var halfLen = RESIZE_HANDLE_LENGTH / 2, halfWid = RESIZE_HANDLE_WIDTH / 2;

    ctx.save();
    ctx.translate(geo.x, geo.y);
    ctx.rotate(Math.atan2(geo.dirY, geo.dirX));

    drawHandleCapsuleBase(halfLen, halfWid);

    ctx.strokeStyle = "#1b1e27";
    ctx.fillStyle = "#1b1e27";
    ctx.lineCap = "round";
    var tipDist = halfLen - 3, headLen = 6, headHalfWidth = 3.5;
    var shaftEnd = tipDist - headLen;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-shaftEnd, 0);
    ctx.lineTo(shaftEnd, 0);
    ctx.stroke();
    function arrowhead(tipX) {
      var dir = tipX > 0 ? 1 : -1;
      ctx.beginPath();
      ctx.moveTo(tipX, 0);
      ctx.lineTo(tipX - dir * headLen, -headHalfWidth);
      ctx.lineTo(tipX - dir * headLen, headHalfWidth);
      ctx.closePath();
      ctx.fill();
    }
    arrowhead(tipDist);
    arrowhead(-tipDist);

    drawHandleGripLines();

    ctx.restore();
  }

  // px/py already in frame/scene space (matching canvasPoint's output while
  // editing) - rotated into the handle's own local frame (the inverse of
  // drawResizeHandle's own rotate) so this is a plain axis-aligned box test.
  function hitTestResizeHandle(bodyIndex, px, py) {
    var geo = resizeHandleGeometry(bodyIndex);
    if (!geo) return false;
    var dx = px - geo.x, dy = py - geo.y;
    var localX = dx * geo.dirX + dy * geo.dirY;
    var localY = -dx * geo.dirY + dy * geo.dirX;
    var halfLen = RESIZE_HANDLE_LENGTH / 2 + RESIZE_HANDLE_HIT_PAD;
    var halfWid = RESIZE_HANDLE_WIDTH / 2 + RESIZE_HANDLE_HIT_PAD;
    return Math.abs(localX) <= halfLen && Math.abs(localY) <= halfWid;
  }

  // Applies the live drag straight through applyBodyEditPreservingHinge, the
  // same mutator every other resize path uses, so a hinged body's resize
  // behaves identically everywhere. Projects the cursor onto the handle's
  // own axis (the inverse of resizeHandleGeometry's own ref + (size + GAP) *
  // dir placement) to recover the new size directly, rather than tracking a
  // delta from drag-start - immune to drift if a frame gets missed.
  function updateResizeHandleDrag(p) {
    var bodyIndex = resizeHandleDrag.bodyIndex;
    var body = scene.bodies[bodyIndex];
    var geo = resizeHandleGeometry(bodyIndex);
    if (!body || !geo) { resizeHandleDrag = null; return; }
    var proj = (p.x - geo.refX) * geo.dirX + (p.y - geo.refY) * geo.dirY;

    if (body.type === "circle") {
      var newRadius = clamp(proj - RESIZE_HANDLE_GAP_CIRCLE, RADIUS_MIN, RADIUS_MAX);
      applyBodyEditPreservingHinge(scene, bodyIndex, true, function () {
        body.radius = newRadius; PhysicsEngine.computeMass(body);
      });
    } else if (isTrapezoidType(body.type)) {
      var newSize = clamp(proj - RESIZE_HANDLE_GAP_FUNNEL, SIZE_MIN, SIZE_MAX);
      applyBodyEditPreservingHinge(scene, bodyIndex, true, function () {
        body.size = newSize; PhysicsEngine.computeMass(body);
      });
    } else {
      var newLength = clamp((proj - RESIZE_HANDLE_GAP_LINE) * 2, LENGTH_MIN, LENGTH_MAX);
      applyBodyEditPreservingHinge(scene, bodyIndex, true, function () {
        body.length = newLength; PhysicsEngine.computeMass(body);
      });
    }
    render();
  }

  // ---- Rotation drag handle (line and funnel/splitter - a circle has no
  // starting angle to set) ----
  //
  // Sits just outside the resize handle, on the same ray from the same
  // reference point - same idea as that handle, "just farther out" - but
  // turned 90 degrees so its own long axis (and the arrow drawn along it)
  // runs tangentially instead of radially, matching how dragging it actually
  // moves the handle: along an arc around the pivot, not straight out from
  // it. The arrow itself is a short curved stroke rather than a straight
  // one, to read as "this rotates" rather than "this resizes" at a glance.
  var ROTATION_HANDLE_GAP = 14; // beyond the resize handle's own far edge
  // Deliberately small and unrelated to the body's actual size or how far
  // away its real pivot is - a true-scale arc over a ~30px span would look
  // almost perfectly straight. This is purely a cosmetic "which icon am I"
  // signal, not a preview of the real rotation radius.
  var ROTATION_ARC_RADIUS = 22;
  var ROTATION_ARC_HALF_ANGLE = 0.7; // radians; sets the arc's chord to ~match the resize handle's own arrow span

  function rotationHandleSupported(body) {
    return !!body && (body.type === "line" || isTrapezoidType(body.type));
  }

  // Reuses resizeHandleGeometry's own ref point and end-choice wholesale -
  // "just outside" means literally the same ray, farther along it - and
  // only rotates the local frame 90 degrees (dirX/dirY here is the TANGENT
  // direction, i.e. the resize handle's own dir rotated a quarter turn) so
  // the two handles read as a matched pair rather than unrelated controls.
  function rotationHandleGeometry(bodyIndex) {
    var body = scene.bodies[bodyIndex];
    if (!rotationHandleSupported(body)) return null;
    var resizeGeo = resizeHandleGeometry(bodyIndex);
    if (!resizeGeo) return null;

    var resizeDist = Math.hypot(resizeGeo.x - resizeGeo.refX, resizeGeo.y - resizeGeo.refY);
    var dist = resizeDist + RESIZE_HANDLE_LENGTH / 2 + ROTATION_HANDLE_GAP + RESIZE_HANDLE_LENGTH / 2;
    // A 90-degree turn of (dirX, dirY): tangent to the circle the handle
    // would trace if the body actually rotated all the way around.
    var tanX = -resizeGeo.dirY, tanY = resizeGeo.dirX;
    return {
      refX: resizeGeo.refX, refY: resizeGeo.refY,
      dirX: resizeGeo.dirX, dirY: resizeGeo.dirY, // still "outward" - which side the arc bulges away from
      tanX: tanX, tanY: tanY,
      x: resizeGeo.refX + resizeGeo.dirX * dist, y: resizeGeo.refY + resizeGeo.dirY * dist,
    };
  }

  // Same capsule/grip shell as the resize handle, oriented along the
  // tangent direction instead of the radial one, with a curved double-arrow
  // (a short arc, bulging away from the body - see ROTATION_ARC_RADIUS)
  // standing in for the straight one.
  function drawRotationHandle(bodyIndex) {
    var geo = rotationHandleGeometry(bodyIndex);
    if (!geo) return;
    var halfLen = RESIZE_HANDLE_LENGTH / 2, halfWid = RESIZE_HANDLE_WIDTH / 2;

    ctx.save();
    ctx.translate(geo.x, geo.y);
    ctx.rotate(Math.atan2(geo.tanY, geo.tanX));

    drawHandleCapsuleBase(halfLen, halfWid);

    // The arc's own center sits toward the pivot side (local +Y, since
    // dirX/dirY - "away from pivot" - rotates to local -Y under this
    // frame's tanX/tanY basis), so an UNshifted arc's midpoint would touch
    // the local origin while its two ends sit a full sagitta further toward
    // +Y - the whole curve living to one side of the capsule's centerline
    // instead of straddling it. Dropping the circle's center by half the
    // sagitta centers the curve instead: its midpoint and its ends then land
    // symmetrically on either side of local Y=0.
    var R = ROTATION_ARC_RADIUS, half = ROTATION_ARC_HALF_ANGLE;
    var sagitta = R * (1 - Math.cos(half));
    var arcCenterY = R - sagitta / 2;
    var startAngle = -Math.PI / 2 - half, endAngle = -Math.PI / 2 + half;
    ctx.strokeStyle = "#1b1e27";
    ctx.fillStyle = "#1b1e27";
    ctx.lineCap = "round";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, arcCenterY, R, startAngle, endAngle);
    ctx.stroke();
    // Tangent-to-the-arc arrowheads at each end, pointing further along the
    // curve (away from its own midpoint) - the curved equivalent of the
    // straight handle's two outward-pointing triangles.
    var headLen = 6, headHalfWidth = 3.5;
    function arrowhead(angle, sign) {
      var px = R * Math.cos(angle), py = arcCenterY + R * Math.sin(angle);
      var tx = -Math.sin(angle) * sign, ty = Math.cos(angle) * sign; // unit tangent, oriented outward along the arc
      var nx = -ty, ny = tx; // perpendicular to the tangent, for the head's two back corners
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px - tx * headLen + nx * headHalfWidth, py - ty * headLen + ny * headHalfWidth);
      ctx.lineTo(px - tx * headLen - nx * headHalfWidth, py - ty * headLen - ny * headHalfWidth);
      ctx.closePath();
      ctx.fill();
    }
    arrowhead(endAngle, 1);
    arrowhead(startAngle, -1);

    drawHandleGripLines();

    ctx.restore();
  }

  // Same shape as hitTestResizeHandle, in the rotation handle's own
  // (tangentially rotated) local frame.
  function hitTestRotationHandle(bodyIndex, px, py) {
    var geo = rotationHandleGeometry(bodyIndex);
    if (!geo) return false;
    var dx = px - geo.x, dy = py - geo.y;
    var localX = dx * geo.tanX + dy * geo.tanY;
    var localY = -dx * geo.tanY + dy * geo.tanX;
    var halfLen = RESIZE_HANDLE_LENGTH / 2 + RESIZE_HANDLE_HIT_PAD;
    var halfWid = RESIZE_HANDLE_WIDTH / 2 + RESIZE_HANDLE_HIT_PAD;
    return Math.abs(localX) <= halfLen && Math.abs(localY) <= halfWid;
  }

  // Absolute, not incremental: every tick sets body.angle to exactly the
  // cursor's current angle around the pivot minus the offset captured at
  // mousedown (see rotationHandleDrag) - the offset is what stops the body
  // from snapping the instant the drag starts just because the grab point
  // wasn't exactly on the handle's own centerline. Same hinge-preserving
  // mutator applyBodyEditPreservingHinge always uses for a rotation.
  function updateRotationHandleDrag(p) {
    var bodyIndex = rotationHandleDrag.bodyIndex;
    var body = scene.bodies[bodyIndex];
    if (!body) { rotationHandleDrag = null; return; }
    var pivot = handlePivot(bodyIndex);
    var mouseAngle = Math.atan2(p.y - pivot.y, p.x - pivot.x);
    var newAngle = mouseAngle - rotationHandleDrag.angleOffset;
    applyBodyEditPreservingHinge(scene, bodyIndex, false, function () {
      body.angle = newAngle;
    });
    render();
  }

  // ---- Un-anchor button ----
  //
  // Only ever shown for a body that is both anchored AND currently selected
  // - not just anchored (that would clutter every anchored body in the
  // scene, not only the one being worked on), and not just selected (most
  // selected bodies aren't anchored, and have nothing here to undo). A
  // click toggles the same isAnchored flag the Anchor tool already does -
  // one more redundant control reaching the same edit, not a new kind of
  // edit (the side panel's own checkbox for this was removed along with the
  // rest of the Properties section).
  var ANCHOR_ICON_RADIUS = 12;
  var ANCHOR_ICON_GAP = 14; // beyond the farthest existing handle's own edge
  var ANCHOR_ICON_HIT_PAD = 4;

  // Chains onto whichever handles this body already has - same ray as the
  // resize handle, positioned past the outermost one that actually exists
  // for this body's type (the rotation handle if it has one, otherwise just
  // the resize handle) - "after the buttons already there," literally.
  function anchorIconGeometry(bodyIndex) {
    var body = scene.bodies[bodyIndex];
    if (!body || !body.isAnchored) return null;
    var resizeGeo = resizeHandleGeometry(bodyIndex);
    if (!resizeGeo) return null; // this body's type has no resize handle to chain onto

    var farEdge = Math.hypot(resizeGeo.x - resizeGeo.refX, resizeGeo.y - resizeGeo.refY) + RESIZE_HANDLE_LENGTH / 2;
    if (rotationHandleSupported(body)) {
      var rotGeo = rotationHandleGeometry(bodyIndex);
      farEdge = Math.hypot(rotGeo.x - rotGeo.refX, rotGeo.y - rotGeo.refY) + RESIZE_HANDLE_LENGTH / 2;
    }
    var dist = farEdge + ANCHOR_ICON_GAP + ANCHOR_ICON_RADIUS;
    return { x: resizeGeo.refX + resizeGeo.dirX * dist, y: resizeGeo.refY + resizeGeo.dirY * dist };
  }

  function drawAnchorIcon(bodyIndex) {
    var geo = anchorIconGeometry(bodyIndex);
    if (!geo) return;
    ctx.save();
    ctx.beginPath();
    ctx.arc(geo.x, geo.y, ANCHOR_ICON_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = "#ffcf4d";
    ctx.strokeStyle = "#8a6d1a";
    ctx.lineWidth = 2;
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#1b1e27";
    ctx.font = "14px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    // The glyph's own bitmap sits a couple pixels left of center within its
    // reported metrics (a common emoji-font quirk) - nudged right here
    // rather than fighting textAlign for it.
    ctx.fillText("⚓", geo.x + 2, geo.y + 1);
    ctx.restore();
  }

  function hitTestAnchorIcon(bodyIndex, px, py) {
    var geo = anchorIconGeometry(bodyIndex);
    if (!geo) return false;
    var dx = px - geo.x, dy = py - geo.y;
    var r = ANCHOR_ICON_RADIUS + ANCHOR_ICON_HIT_PAD;
    return dx * dx + dy * dy <= r * r;
  }

  // ---- Drag-to-delete zone ----
  //
  // Appears only while an existing body is being dragged by hand (the
  // `dragging` state - not a resize/rotation/anchor drag, and not a new
  // shape being drawn), fixed at the top center of the frame regardless of
  // where the drag itself is, same as the "drag an icon up to X" gesture on
  // an Android or iOS home screen.
  var DELETE_ZONE_RADIUS = 20;
  var DELETE_ZONE_TOP_MARGIN = 44; // distance from the frame's own top edge to the zone's center, with nothing in the way
  var DELETE_ZONE_ARMED_SCALE = 1.3; // drawn this much bigger once the dragged body actually overlaps it
  var DELETE_ZONE_TOOLBAR_GAP = 14; // clear air between the transport's bottom edge and the zone's

  // Top center of the frame is also where the playback transport floats, and
  // that is a DOM element painted over the canvas - so the zone was drawn
  // underneath it and the user had nothing to drop onto. This drops below
  // the transport instead.
  //
  // Measured rather than moved down by a constant: the transport's height
  // changes with the step readout under it (which carries text after a run
  // and none before one) and with how wide the speed button's own label
  // gets, so a constant picked against any one of those states is wrong in
  // the others. Falling back to the bare margin keeps this working if the
  // transport is ever absent or unmeasurable.
  //
  // Everything here is in frame units, which while editing are CSS pixels
  // from the canvas's top-left corner - the same units canvasPoint hands
  // the hit test, so the two agree without either converting.
  function deleteZoneTop() {
    var y = DELETE_ZONE_TOP_MARGIN;
    if (playbackToolbar) {
      var bar = playbackToolbar.getBoundingClientRect();
      if (bar.height > 0) {
        y = Math.max(y, bar.bottom - canvas.getBoundingClientRect().top +
          DELETE_ZONE_TOOLBAR_GAP + DELETE_ZONE_RADIUS * DELETE_ZONE_ARMED_SCALE);
      }
    }
    // On a frame too short to hold both, the zone stays inside it rather
    // than being pushed off the bottom edge by a transport that fills the
    // top - a zone that can't be reached is worse than one drawn close to
    // the transport.
    var armed = DELETE_ZONE_RADIUS * DELETE_ZONE_ARMED_SCALE;
    return Math.min(y, Math.max(armed, (scene.frameHeight || 0) - armed));
  }

  function deleteZoneCenter() {
    return { x: (scene.frameWidth || 0) / 2, y: deleteZoneTop() };
  }

  // Checked against the cursor, not the body's own center or size: a body
  // is dragged by whatever point it was grabbed at (see dragOffset), which
  // for anything but a circle grabbed dead-center isn't the same point as
  // body.x/y - so "is the item on top of the zone" is really "is wherever
  // I'm holding it right now on top of the zone." Scaling the hit area by
  // the body's own reach instead (a line's half-length, say) would also
  // make a long object arm the zone while its center - and the cursor
  // holding it - are still far away, which measured out as a surprisingly
  // easy accidental delete for anything large.
  var DELETE_ZONE_HIT_PAD = 6;
  function isOverDeleteZone(px, py) {
    var zone = deleteZoneCenter();
    var r = DELETE_ZONE_RADIUS + DELETE_ZONE_HIT_PAD;
    var dx = px - zone.x, dy = py - zone.y;
    return dx * dx + dy * dy <= r * r;
  }

  function drawDeleteZone(armed) {
    var zone = deleteZoneCenter();
    var r = DELETE_ZONE_RADIUS * (armed ? DELETE_ZONE_ARMED_SCALE : 1);
    ctx.save();
    ctx.beginPath();
    ctx.arc(zone.x, zone.y, r, 0, Math.PI * 2);
    ctx.fillStyle = armed ? "#ff7a72" : "#ff5f56";
    ctx.fill();
    ctx.strokeStyle = "rgba(0, 0, 0, 0.25)";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    var s = r * 0.4;
    ctx.beginPath();
    ctx.moveTo(zone.x - s, zone.y - s);
    ctx.lineTo(zone.x + s, zone.y + s);
    ctx.moveTo(zone.x + s, zone.y - s);
    ctx.lineTo(zone.x - s, zone.y + s);
    ctx.stroke();
    ctx.restore();
  }

  // Groups X/Y/Output badges by which body they're on so 2-3 sharing one
  // body get spaced out instead of stacking illegibly on top of each other.
  // Longest an off-screen pointer is drawn, as a fraction of the frame's
  // shorter side rather than a pixel count - the fractal grid's replay panel
  // draws the same arrows into a canvas a fraction of this size, and a fixed
  // length would be either a stub there or a monster here. The arrow
  // approaches this without reaching it however far out the body goes; see
  // PhysicsHingeGeometry.offscreenPointer for the curve.
  var OFFSCREEN_ARROW_MAX_FRACTION = 0.12;
  function offscreenArrowMaxLength() {
    return OFFSCREEN_ARROW_MAX_FRACTION * Math.min(scene.frameWidth || 0, scene.frameHeight || 0);
  }

  // An arrow whose TIP sits on the frame edge, pointing outward at a body
  // that has left the view - the tail trails back inside, growing with how
  // far out the body is. One per body, in the body's own outline color, so
  // it reads as "that object went this way".
  function drawOffscreenArrow(pointer, color) {
    // Pull the tip a little inside the frame so the head isn't half-clipped
    // by the canvas edge it is sitting on.
    var inset = 3;
    var tipX = pointer.tipX - pointer.dirX * inset;
    var tipY = pointer.tipY - pointer.dirY * inset;
    var head = Math.min(13, Math.max(7, pointer.length * 0.35));
    var tailX = tipX - pointer.dirX * pointer.length;
    var tailY = tipY - pointer.dirY * pointer.length;
    var perpX = -pointer.dirY, perpY = pointer.dirX;

    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(tailX, tailY);
    ctx.lineTo(tipX - pointer.dirX * head * 0.6, tipY - pointer.dirY * head * 0.6);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - pointer.dirX * head + perpX * head * 0.5, tipY - pointer.dirY * head + perpY * head * 0.5);
    ctx.lineTo(tipX - pointer.dirX * head - perpX * head * 0.5, tipY - pointer.dirY * head - perpY * head * 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawMappingBadges() {
    var entries = [
      { mapping: scene.xInput, label: "X", color: "#ff6b6b" },
      { mapping: scene.yInput, label: "Y", color: "#6bafff" },
      { mapping: scene.output, label: "O", color: "#7ee0a0" },
    ].filter(function (e) { return e.mapping && scene.bodies[e.mapping.body]; });

    var byBody = {};
    entries.forEach(function (e) {
      var key = e.mapping.body;
      (byBody[key] = byBody[key] || []).push(e);
    });

    // Any mapped body that has left the frame gets a pointer instead of a
    // badge - ONE per body however many of X, Y and Output it carries, since
    // the arrow says where the object is, not which role it plays.
    Object.keys(byBody).forEach(function (key) {
      var body = scene.bodies[key];
      var pointer = PhysicsHingeGeometry.offscreenPointer(
        body.x, body.y, scene.frameWidth, scene.frameHeight, offscreenArrowMaxLength());
      if (!pointer) return;
      drawOffscreenArrow(pointer, body.isAnchored ? "#7a8199" : "#7ea0ff");
    });

    ctx.font = "bold 12px sans-serif";
    ctx.textAlign = "center";
    Object.keys(byBody).forEach(function (key) {
      var group = byBody[key];
      var body = scene.bodies[key];
      var spacing = 13;
      var startOffset = -((group.length - 1) * spacing) / 2;
      group.forEach(function (e, i) {
        ctx.fillStyle = e.color;
        ctx.fillText(e.label, body.x + startOffset + i * spacing, body.y - 18);
      });
    });
  }

  // Pulled out of render() so it can also be called from the pagehide/
  // visibilitychange safety net below - see there for why that net exists.
  function saveEditorAutosave() {
    try {
      localStorage.setItem(EDITOR_STORAGE_KEY, JSON.stringify(PhysicsCoords.toAuthoredJSON(serializeScene())));
    } catch (err) {
      // Full/unavailable storage shouldn't break editing - auto-save is a
      // convenience, not a requirement.
    }
  }

  function render() {
    // A typed/pasted coordinate (or a hinge-cascade result) can land a body
    // outside the locked frame - settle it back in (see
    // PhysicsHingeGeometry.normalizeAllBodiesIntoFrame) before drawing, so
    // it's corrected the same render it happened in rather than lagging a
    // frame behind. Skipped while playing: bodies are mid-simulation then,
    // driven by the already-correct GPU trajectory, not something to
    // reach in and re-settle.
    if (!isPlaying) {
      PhysicsHingeGeometry.normalizeAllBodiesIntoFrame(scene);
    }

    // Drawing code below works entirely in frame/scene-space coordinates
    // (the same space body.x/y always have) - this transform is the only
    // place that space meets actual canvas pixels, via whatever displayScale
    // resizeCanvas last computed.
    var w = scene.frameWidth || canvasArea.clientWidth || 1;
    var h = scene.frameHeight || canvasArea.clientHeight || 1;
    var renderScale = displayScale * dpr;
    ctx.setTransform(renderScale, 0, 0, renderScale, 0, 0);
    ctx.clearRect(0, 0, w, h);
    drawGrid(w, h);
    for (var i = 0; i < scene.bodies.length; i++) drawBody(scene.bodies[i], i === selectedIndex);
    for (var j = 0; j < scene.hinges.length; j++) drawHinge(scene.hinges[j]);
    drawVelocityArrows();
    drawMappingBadges();
    if (!isPlaying && selectedIndex >= 0) {
      drawResizeHandle(selectedIndex);
      drawRotationHandle(selectedIndex); // no-op for anything but a line
      drawAnchorIcon(selectedIndex); // no-op unless this body is anchored
    }
    if (dragging && selectedIndex >= 0) drawDeleteZone(deleteZoneArmed);
    if (drawingShape) drawShapePreview(drawingShape);
    // render() already runs after every editing mutation (drag, add/delete,
    // property edits, hinges) - piggyback the auto-save here instead of
    // instrumenting each call site separately. Skipped during playback: it
    // describes the STARTING scene, and running it every animation frame
    // would overwrite the real saved scene with a mid-animation frame.
    if (!isPlaying) {
      saveEditorAutosave();
    }
  }

  // While editing, the frame just IS the canvas - live-synced here on every
  // resize, same as before this feature existed. The instant Play (or Send-
  // to-Grid, in its own click handler) locks it, this stops touching it:
  // isPlaying gates the sync, not a one-time snapshot, so simply not being
  // in playing mode is what "unlocked" means, including right after Reset.
  //
  // Also gated on canvasArea actually having a size: this page now shares a
  // document with the grid view (see index.html/transition.js), and a
  // display:none element's clientWidth/clientHeight are always 0 - with no
  // guard, switching to the grid view (which fires a resize so other layout
  // notices the swap) would zero out the authored frame permanently, since
  // scene.frameWidth/frameHeight is live editor state, not a snapshot.
  // Whatever the frame was BEFORE going invisible is still correct; only a
  // resize while actually visible is real information about what it is now.
  function resizeCanvas() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (!isPlaying && canvasArea.clientWidth > 0 && canvasArea.clientHeight > 0) {
      // The authored origin is the frame's center (see physics-coords.js),
      // so a frame that changes size moves every engine-space coordinate
      // with it: what the scene is described as - its position relative to
      // the middle - is what has to hold still. Without this, resizing the
      // window would silently re-author the whole scene, sliding it toward
      // the top-left exactly the way a corner origin always did.
      var prevW = scene.frameWidth, prevH = scene.frameHeight;
      scene.frameWidth = canvasArea.clientWidth;
      scene.frameHeight = canvasArea.clientHeight;
      translateWholeScene(
        (scene.frameWidth - prevW) / 2,
        (scene.frameHeight - prevH) / 2);
    }
    var fw = scene.frameWidth || canvasArea.clientWidth || 1;
    var fh = scene.frameHeight || canvasArea.clientHeight || 1;
    // "Contain" fit: the frame's own aspect ratio is preserved and it's
    // scaled (up or down) to fit entirely inside whatever canvasArea is
    // right now, rather than stretching to fill it - this is what keeps a
    // locked-in scene from distorting if the window's aspect ratio has
    // since changed. 1 exactly reproduces the pre-existing "always fill
    // canvasArea" behavior whenever fw/fh already match its current size,
    // i.e. always, while editing.
    displayScale = Math.min(canvasArea.clientWidth / fw, canvasArea.clientHeight / fh) || 1;
    var cssW = fw * displayScale, cssH = fh * displayScale;
    canvas.style.width = cssW + "px";
    canvas.style.height = cssH + "px";
    var w = Math.round(cssW * dpr);
    var h = Math.round(cssH * dpr);
    if (w > 0 && h > 0 && (canvas.width !== w || canvas.height !== h)) {
      canvas.width = w;
      canvas.height = h;
    }
    render();
  }

  new ResizeObserver(resizeCanvas).observe(canvasArea);
  // Belt and suspenders: a locked-frame Play run depends on actually
  // noticing every window resize (that's what re-fits/re-centers the
  // letterboxed canvas), and a plain window resize event is a second,
  // independent way to catch that alongside the ResizeObserver above.
  window.addEventListener("resize", resizeCanvas);

  // Safety net for the auto-save above: a couple of controls (the gravity
  // slider, the "Stop on wrap" checkbox) don't call render() from their own
  // change handler - render() already runs constantly from everything ELSE
  // (drag, add/delete, property edits), so in practice those controls'
  // changes get swept up into the next save anyway... unless nothing else
  // happens before the user navigates away
  // (e.g. to the fractal grid), in which case the save that already
  // happened is missing this one, and it silently doesn't survive the trip.
  // Rather than relying on every current AND future control to remember to
  // trigger a save itself, flush whatever `scene` currently is the moment
  // the page actually goes away - pagehide covers navigation/tab close,
  // visibilitychange also catches switching tabs/apps or minimizing.
  // Calling this twice is harmless (it's just an overwrite with the same
  // data), so no need to be precious about which one actually fires first.
  function flushEditorAutosaveOnHide() {
    if (!isPlaying) saveEditorAutosave();
  }
  window.addEventListener("pagehide", flushEditorAutosaveOnHide);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") flushEditorAutosaveOnHide();
  });

  // ---- Hit testing (topmost first = end of array first, matching paint order) ----

  function hitTestTopmost(px, py) {
    for (var i = scene.bodies.length - 1; i >= 0; i--) {
      if (PhysicsEngine.pointInBody(scene.bodies[i], px, py)) return i;
    }
    return -1;
  }

  function hitTestAll(px, py) {
    var hits = [];
    for (var i = scene.bodies.length - 1; i >= 0; i--) {
      if (PhysicsEngine.pointInBody(scene.bodies[i], px, py)) hits.push(i);
    }
    return hits;
  }

  // ---- Tools ----

  function setActiveTool(tool) {
    activeTool = tool;
    toolButtons.forEach(function (b) { b.classList.toggle("active", b.getAttribute("data-tool") === tool); });
    canvas.className = "tool-" + tool;
  }

  toolButtons.forEach(function (btn) {
    btn.addEventListener("click", function () { setActiveTool(btn.getAttribute("data-tool")); });
  });

  // No dedicated "Select" button - it's the default, and any click in the
  // surrounding chrome that isn't itself another tool button (a sample
  // button, a slider, Clear All, a property field, plain empty space...)
  // backs out of whatever tool is active, the same as clicking that button
  // used to. Scoped to the panel specifically so it never fires for clicks
  // on the canvas itself, which is how every tool actually gets used. (The
  // old #topbar was the other container this listened on; it no longer
  // exists - what survived of it lives in .panel-head inside #panel, so the
  // one listener covers it.)
  panelEl.addEventListener("click", function (e) {
    if (e.target.closest("[data-tool]")) return;
    setActiveTool("select");
  });

  window.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if (!modalBackdrop.hidden) { closeModal(); return; }
    if (drawingShape) { drawingShape = null; render(); } // cancel the in-progress drag instead of still placing it on the eventual mouseup
    if (velocityDrag) { velocityDrag = null; render(); } // same, for a velocity aim in progress: leave the body's existing velocity alone
    setActiveTool("select");
  });

  // ---- Settings panel (gear button, upper right) ----
  //
  // More can just be added into #settings-panel-body (see #editor-view in
  // index.html) without needing anything else here to change.
  btnSettings.addEventListener("click", function () {
    settingsPanel.classList.toggle("open");
  });
  btnSettingsClose.addEventListener("click", function () {
    settingsPanel.classList.remove("open");
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
  // ---- Sound volume (mute button + settings slider) ----
  //
  // PhysicsSound's volume is shared, module-level state - the fractal
  // grid's identical controls (see fractal-grid.js's own copy of this
  // exact pattern) read and write the very same value, so the one
  // onVolumeChange listener below is what keeps every location (this
  // page's mute button AND its settings slider, whether it was one of
  // THEM or the grid page's own pair that actually changed it) in sync,
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
    setVolumeIconState(btnMute, volume);
    setVolumeIconState(soundVolumeIcon, volume);
    soundVolumeSlider.value = String(Math.round(volume * 100));
    var label = volume <= 0 ? "Unmute" : "Mute";
    btnMute.title = label;
    btnMute.setAttribute("aria-label", label);
  }
  btnMute.addEventListener("click", function () { PhysicsSound.toggleMute(); });
  soundVolumeSlider.addEventListener("input", function () {
    PhysicsSound.setVolume(Number(soundVolumeSlider.value) / 100);
  });
  PhysicsSound.onVolumeChange(updateVolumeUI);
  updateVolumeUI(PhysicsSound.getVolume());

  var flashTimer = null;
  function flashStatus(message) {
    if (flashTimer) clearTimeout(flashTimer);
    var prevText = statusEl.textContent, prevClass = statusEl.className;
    statusEl.textContent = message;
    statusEl.className = "status-error";
    flashTimer = setTimeout(function () {
      statusEl.textContent = prevText;
      statusEl.className = prevClass;
      flashTimer = null;
    }, 1600);
  }

  function canAddBody() {
    if (scene.bodies.length >= PhysicsGPU.MAX_BODIES) {
      flashStatus("Max " + PhysicsGPU.MAX_BODIES + " bodies");
      return false;
    }
    return true;
  }

  function addHingeAt(x, y) {
    var hits = hitTestAll(x, y);
    if (hits.length === 0) return;
    var frontIndex = hits[0];
    var behindIndex = hits.length > 1 ? hits[1] : null;

    // At most one hinge per (object, background) pair and per (object,
    // object) pair - a second one would just be redundant (the first
    // already pins that exact relationship) or, worse, over-constrain the
    // solver by fighting the first hinge over a slightly different pivot.
    // hingeConnects treats "background" as bodyA === null, so this one call
    // covers both cases: behindIndex === null checks this object against
    // the background, otherwise it checks the two objects against each
    // other.
    if (PhysicsEngine.hingeConnects(scene.hinges, behindIndex, frontIndex)) {
      flashStatus(behindIndex === null ? "Already hinged to the background" : "These two objects are already hinged together");
      return;
    }
    // An anchored object doesn't move - hinging another object to it is the
    // same idea as hinging straight to the background, just through a real
    // (but immobile) body instead. Disallowed so there's exactly one way to
    // pin something in place, not two that happen to behave identically.
    if (behindIndex !== null && (scene.bodies[behindIndex].isAnchored || scene.bodies[frontIndex].isAnchored)) {
      flashStatus("Can't hinge to an anchored object - hinge to the background instead");
      return;
    }

    var bodyB = scene.bodies[frontIndex];
    var localB = PhysicsEngine.worldToLocal(x - bodyB.x, y - bodyB.y, bodyB.angle);
    var hinge = { bodyA: behindIndex, bodyB: frontIndex, localAnchorB: { x: localB.x, y: localB.y } };
    if (behindIndex === null) {
      hinge.localAnchorA = { x: x, y: y };
    } else {
      var bodyA = scene.bodies[behindIndex];
      var localA = PhysicsEngine.worldToLocal(x - bodyA.x, y - bodyA.y, bodyA.angle);
      hinge.localAnchorA = { x: localA.x, y: localA.y };
    }
    scene.hinges.push(hinge);
  }

  // Keeping a hinge point fixed under resize/rotate/move - pure scene math,
  // no DOM, so it now lives in physics-hinge-geometry.js (loaded above)
  // where the fractal grid's hover-preview and the regression suite can
  // both reach it directly instead of through this file's DOM-bound setup.
  var translateBodyPreservingHinges = PhysicsHingeGeometry.translateBodyPreservingHinges;
  var applyBodyEditPreservingHinge = PhysicsHingeGeometry.applyBodyEditPreservingHinge;

  // ---- Selection ----

  function selectBody(index) {
    selectedIndex = index;
    render();
  }

  function deleteSelectedBody() {
    if (selectedIndex < 0) return;
    PhysicsEngine.deleteBody(scene, selectedIndex);
    scene.xInput = reindexMappingAfterDelete(scene.xInput, selectedIndex);
    scene.yInput = reindexMappingAfterDelete(scene.yInput, selectedIndex);
    scene.output = reindexMappingAfterDelete(scene.output, selectedIndex);
    selectedIndex = -1;
    refreshMappingUI();
    render();
  }

  window.addEventListener("keydown", function (e) {
    if (isPlaying) return;
    if (e.key !== "Delete" && e.key !== "Backspace") return;
    if (document.activeElement && document.activeElement.tagName === "INPUT") return;
    deleteSelectedBody();
  });

  // ---- Canvas interaction ----

  canvas.addEventListener("mousedown", function (e) {
    if (isPlaying) return;
    var p = canvasPoint(e);

    if (activeTool === "select") {
      // Checked before the ordinary hit-test below: all three sit OUTSIDE
      // the selected body's own shape on purpose, so a click there must not
      // fall through to hitTestTopmost and re-select (or start dragging)
      // whatever body happens to be underneath it. The anchor icon is a
      // plain click, not a drag - it toggles immediately and never sets any
      // drag state.
      if (selectedIndex >= 0 && hitTestAnchorIcon(selectedIndex, p.x, p.y)) {
        var anchoredBody = scene.bodies[selectedIndex];
        anchoredBody.isAnchored = false;
        PhysicsEngine.computeMass(anchoredBody);
        render();
        return;
      }
      if (selectedIndex >= 0 && hitTestRotationHandle(selectedIndex, p.x, p.y)) {
        var pivot = handlePivot(selectedIndex);
        rotationHandleDrag = {
          bodyIndex: selectedIndex,
          angleOffset: Math.atan2(p.y - pivot.y, p.x - pivot.x) - scene.bodies[selectedIndex].angle,
        };
        return;
      }
      if (selectedIndex >= 0 && hitTestResizeHandle(selectedIndex, p.x, p.y)) {
        resizeHandleDrag = { bodyIndex: selectedIndex };
        return;
      }
      var hit = hitTestTopmost(p.x, p.y);
      selectBody(hit);
      if (hit >= 0) {
        dragging = true;
        dragOffset = { x: p.x - scene.bodies[hit].x, y: p.y - scene.bodies[hit].y };
        canvas.classList.add("dragging");
      }
    } else if (activeTool === "circle") {
      if (!canAddBody()) return;
      // Placement happens on mouseup (finalizeShapeDrawing) - this just
      // starts the drag; activeTool stays "circle" throughout so the drag
      // knows what kind of preview to draw.
      drawingShape = { tool: "circle", start: p, current: p };
      render();
    } else if (activeTool === "funnel" || activeTool === "splitter") {
      if (!canAddBody()) return;
      drawingShape = { tool: activeTool, start: p, current: p };
      render();
    } else if (activeTool === "line") {
      if (!canAddBody()) return;
      drawingShape = { tool: "line", start: p, current: p };
      render();
    } else if (activeTool === "anchor") {
      var hit2 = hitTestTopmost(p.x, p.y);
      if (hit2 >= 0) {
        scene.bodies[hit2].isAnchored = !scene.bodies[hit2].isAnchored;
        PhysicsEngine.computeMass(scene.bodies[hit2]);
        render();
      }
      setActiveTool("select");
    } else if (activeTool === "hinge") {
      addHingeAt(p.x, p.y);
      setActiveTool("select");
      render();
    } else if (activeTool === "velocity") {
      // Unlike the click-once tools around it this one is a drag: mousedown
      // only picks the body and records where the drag began, and the
      // velocity isn't committed until mouseup.
      var hitV = hitTestTopmost(p.x, p.y);
      if (hitV >= 0 && scene.bodies[hitV].isAnchored) {
        // An anchored body is pinned in place - a starting velocity would be
        // discarded on the first step, so say so rather than appearing to
        // set one.
        flashStatus("An anchored object can't be given a velocity");
        setActiveTool("select");
      } else if (hitV >= 0) {
        selectBody(hitV);
        velocityDrag = { bodyIndex: hitV, start: p, current: p };
      } else {
        setActiveTool("select"); // dragged from empty space - nothing to aim
      }
      render();
    } else if (activeTool === "input") {
      // Quick shortcut for the most common X/Y Input scenario - a single
      // object's own Center X/Y. Still just an ordinary mapping afterward,
      // freely overridable (different bodies, different properties) in the
      // dropdowns below.
      var hit3 = hitTestTopmost(p.x, p.y);
      if (hit3 >= 0) {
        scene.xInput = { body: hit3, property: "x" };
        scene.yInput = { body: hit3, property: "y" };
        refreshMappingUI();
      }
      setActiveTool("select");
      render();
    } else if (activeTool === "input-velocity") {
      // Same shortcut as "input" above, but for the vx/vy properties
      // instead of x/y - see PROPERTIES_BY_TYPE. Rejects an anchored
      // object: its velocity is never read (invMass/invInertia are always
      // zero, so PhysicsEngine.step never advances it), so linking one
      // would be a mapping that visibly does nothing.
      var hit5 = hitTestTopmost(p.x, p.y);
      if (hit5 >= 0 && scene.bodies[hit5].isAnchored) {
        flashStatus("An anchored object's velocity is never used");
      } else if (hit5 >= 0) {
        scene.xInput = { body: hit5, property: "vx" };
        scene.yInput = { body: hit5, property: "vy" };
        refreshMappingUI();
      }
      setActiveTool("select");
      render();
    } else if (activeTool === "output") {
      // Quick shortcut for the most common Output scenario - an object's
      // own Center Y. Rejects an anchored object: it never moves, so
      // tracking its Y would just be a constant, almost never the intent.
      var hit4 = hitTestTopmost(p.x, p.y);
      if (hit4 >= 0 && scene.bodies[hit4].isAnchored) {
        flashStatus("Output can't be an anchored object");
      } else if (hit4 >= 0) {
        scene.output = { body: hit4, property: "y" };
        refreshMappingUI();
      }
      setActiveTool("select");
      render();
    }
  });

  window.addEventListener("mousemove", function (e) {
    if (rotationHandleDrag) {
      updateRotationHandleDrag(canvasPoint(e));
      return;
    }
    if (resizeHandleDrag) {
      updateResizeHandleDrag(canvasPoint(e));
      return;
    }
    if (velocityDrag) {
      velocityDrag.current = canvasPoint(e);
      render();
      return;
    }
    if (drawingShape) {
      drawingShape.current = canvasPoint(e);
      render();
      return;
    }
    if (!dragging || selectedIndex < 0) return;
    var p = canvasPoint(e);
    var body = scene.bodies[selectedIndex];
    var newX = p.x - dragOffset.x;
    var newY = p.y - dragOffset.y;
    translateBodyPreservingHinges(scene, selectedIndex, newX - body.x, newY - body.y);
    deleteZoneArmed = isOverDeleteZone(p.x, p.y);
    render();
  });

  window.addEventListener("mouseup", function (e) {
    if (rotationHandleDrag) {
      rotationHandleDrag = null;
      return;
    }
    if (resizeHandleDrag) {
      resizeHandleDrag = null;
      return;
    }
    if (velocityDrag) {
      var vDrag = velocityDrag;
      velocityDrag = null;
      vDrag.current = canvasPoint(e);
      var v = velocityFromDrag(vDrag);
      var target = scene.bodies[vDrag.bodyIndex];
      target.vx = v.vx;
      target.vy = v.vy;
      setActiveTool("select");
      render();
      return;
    }
    if (drawingShape) {
      var shape = drawingShape;
      drawingShape = null;
      finalizeShapeDrawing(shape, canvasPoint(e));
      return;
    }
    if (!dragging) return;
    dragging = false;
    canvas.classList.remove("dragging");
    var droppedOnDeleteZone = deleteZoneArmed;
    deleteZoneArmed = false;
    if (droppedOnDeleteZone) {
      deleteSelectedBody();
    } else {
      render(); // otherwise the delete zone drawn on the last mousemove would linger on screen
    }
  });

  // ---- Gravity ----

  // Shared by the Edge Handling dropdown and Mutual Gravity's auto-nudge
  // below - the same rules apply no matter which one asked for the change,
  // so there's exactly one place that knows how to change edge mode.
  function applyEdgeMode(mode) {
    // Scene Lifespan's whole value IS "when did this stop early", which only
    // Sticky Edges ever does - under either other mode it would report the
    // full step budget for every pixel, so it's cleared rather than silently
    // left meaningless.
    var leavingSticky = mode !== "sticky";
    if (leavingSticky && scene.output && scene.output.property === "lifespan") {
      scene.output = null;
      refreshMappingUI();
    }
    scene.edgeMode = mode;
    edgeModeSelect.value = mode;
    render();
  }

  mutualGravityCheckbox.addEventListener("change", function () {
    scene.mutualGravity = mutualGravityCheckbox.checked;
    // Two one-time nudges toward the combination that actually behaves well -
    // NOT a lock: Collisions and Edge Handling are perfectly ordinary
    // controls the instant after this runs, and flipping Mutual Gravity
    // again just re-nudges both.
    // On: the classic "stuck together, orbiting madly" failure mode this
    // engine used to hit is what Collisions=off sidesteps, so default there -
    // and nothing pulls a flung-out body back under Mutual Gravity the way
    // downward gravity does, so Infinite Space (no edge to bounce or wrap
    // off of) matches what that physics actually implies.
    // Off: back to the everyday case, where bouncing off things (Collisions
    // on) and Pac-Man-style wrapping are both normally what's wanted.
    scene.collisionsEnabled = !scene.mutualGravity;
    collisionsCheckbox.checked = scene.collisionsEnabled;
    applyEdgeMode(scene.mutualGravity ? "infinite" : "wrap");
  });

  collisionsCheckbox.addEventListener("change", function () {
    scene.collisionsEnabled = collisionsCheckbox.checked;
    render();
  });

  function updateSimulationStepsReadout(value) {
    simulationStepsReadout.textContent = value.toLocaleString();
  }
  simulationStepsSlider.addEventListener("input", function () {
    scene.simulationSteps = Number(simulationStepsSlider.value) * SIMULATION_STEPS_PER_NOTCH;
    updateSimulationStepsReadout(scene.simulationSteps);
    // Only actually reachable while editing (this slider is disabled during
    // a run - see setEditingEnabled), but keep the playback slider's own
    // range showing the current setting anyway, so it's already correct the
    // moment Play first runs rather than snapping to a new range then.
    if (!isPlaying) playbackProgressSlider.max = String(scene.simulationSteps);
  });

  edgeModeSelect.addEventListener("change", function () {
    applyEdgeMode(edgeModeSelect.value);
  });

  // ---- Max Objects ----
  //
  // How many bodies a splitter may grow the scene to. Only splitters grow
  // anything, so the control is shown only when the scene has one - for
  // every other scene it is a number that provably cannot matter, and the
  // panel is better without it.
  //
  // It is not just a safety rail. Every slot, filled or not, is a body the
  // Fractal Grid's shader unrolls and collision-checks against every other
  // one, for every pixel, on every step - so the cost is quadratic in this
  // number and it is by far the biggest lever on whether a splitter scene
  // renders in a moment or hangs the GPU. Hence a control rather than a
  // constant: the usable value depends on the scene, the step count and the
  // machine, and the only way to find it is to raise it until it hurts.
  maxBodiesSlider.min = String(PhysicsEngine.MIN_SIMULATION_BODIES);
  maxBodiesSlider.max = String(PhysicsEngine.MAX_SIMULATION_BODIES_LIMIT);

  function setMaxBodiesUI(value) {
    maxBodiesSlider.value = String(value);
    maxBodiesReadout.textContent = String(value);
  }

  function refreshMaxBodiesVisibility() {
    maxBodiesField.hidden = !sceneHasSplitter(scene);
  }

  maxBodiesSlider.addEventListener("input", function () {
    scene.maxSimulationBodies = Number(maxBodiesSlider.value);
    maxBodiesReadout.textContent = String(scene.maxSimulationBodies);
    // render(), unlike the Simulation Duration slider beside it, because
    // render() is also what auto-saves the scene - and this is a value
    // someone will set once and then reload the page to try, so it should
    // be durable the moment it's set rather than on the next unrelated
    // redraw.
    render();
  });

  // ---- X / Y input mapping ----

  function bodyOptionLabel(body, index) {
    return "Body " + index + " (" + body.type + ")";
  }

  function propsListFor(bodyIndex) {
    return PROPERTIES_BY_TYPE[scene.bodies[bodyIndex].type];
  }

  function populatePropertySelect(select, bodyIndex, selectedKey, propsList) {
    select.innerHTML = "";
    if (bodyIndex === null || bodyIndex === undefined || !scene.bodies[bodyIndex]) {
      select.disabled = true;
      return;
    }
    select.disabled = false;
    var props = propsList || propsListFor(bodyIndex);
    props.forEach(function (p) {
      var opt = document.createElement("option");
      opt.value = p.key;
      opt.textContent = p.label;
      select.appendChild(opt);
    });
    if (selectedKey && props.some(function (p) { return p.key === selectedKey; })) {
      select.value = selectedKey;
    }
  }

  // includeLifespan: only the Output body dropdown offers "Scene lifespan"
  // - X/Y Input drive a property FROM a pixel's position, which lifespan
  // (a fact about the whole run, not any one body) has nothing to receive.
  function populateBodySelect(select, mapping, includeLifespan) {
    select.innerHTML = "";
    var noneOpt = document.createElement("option");
    noneOpt.value = "";
    noneOpt.textContent = "None";
    select.appendChild(noneOpt);
    if (includeLifespan) {
      var lifespanOpt = document.createElement("option");
      lifespanOpt.value = "lifespan";
      lifespanOpt.textContent = "Scene lifespan";
      select.appendChild(lifespanOpt);
    }
    scene.bodies.forEach(function (b, i) {
      var opt = document.createElement("option");
      opt.value = i;
      opt.textContent = bodyOptionLabel(b, i);
      select.appendChild(opt);
    });
    select.value = !mapping ? "" : mapping.property === "lifespan" ? "lifespan" : mapping.body;
  }

  // Called whenever the body list changes shape (add/delete/load) - rebuilds
  // all three dropdown pairs from scratch and re-selects the current mapping.
  function refreshMappingUI() {
    populateBodySelect(xInputBodySelect, scene.xInput);
    populatePropertySelect(xInputPropertySelect, scene.xInput ? scene.xInput.body : null, scene.xInput ? scene.xInput.property : null);
    populateBodySelect(yInputBodySelect, scene.yInput);
    populatePropertySelect(yInputPropertySelect, scene.yInput ? scene.yInput.body : null, scene.yInput ? scene.yInput.property : null);
    populateBodySelect(outputBodySelect, scene.output, true);
    refreshOutputPairUI();
    // Max Objects only means anything once something can grow the scene.
    // Hung off this function because every place the body list changes
    // already calls it - adding, deleting, loading a sample, pasted JSON.
    refreshMaxBodiesVisibility();
  }

  function reindexMappingAfterDelete(mapping, deletedIndex) {
    if (!mapping) return null;
    if (mapping.body === deletedIndex) return null;
    if (mapping.body > deletedIndex) return { body: mapping.body - 1, property: mapping.property };
    return mapping;
  }

  xInputBodySelect.addEventListener("change", function () {
    if (xInputBodySelect.value === "") {
      scene.xInput = null;
    } else {
      var bodyIndex = Number(xInputBodySelect.value);
      scene.xInput = { body: bodyIndex, property: propsListFor(bodyIndex)[0].key };
    }
    populatePropertySelect(xInputPropertySelect, scene.xInput ? scene.xInput.body : null, scene.xInput ? scene.xInput.property : null);
    render();
  });

  xInputPropertySelect.addEventListener("change", function () {
    if (!scene.xInput) return;
    scene.xInput.property = xInputPropertySelect.value;
    render();
  });

  yInputBodySelect.addEventListener("change", function () {
    if (yInputBodySelect.value === "") {
      scene.yInput = null;
    } else {
      var bodyIndex = Number(yInputBodySelect.value);
      scene.yInput = { body: bodyIndex, property: propsListFor(bodyIndex)[0].key };
    }
    populatePropertySelect(yInputPropertySelect, scene.yInput ? scene.yInput.body : null, scene.yInput ? scene.yInput.property : null);
    render();
  });

  yInputPropertySelect.addEventListener("change", function () {
    if (!scene.yInput) return;
    scene.yInput.property = yInputPropertySelect.value;
    render();
  });

  outputBodySelect.addEventListener("change", function () {
    if (outputBodySelect.value === "") {
      scene.output = null;
    } else if (outputBodySelect.value === "lifespan") {
      // Lifespan's value IS "when did Sticky Edges first trigger" - under
      // any other mode every scene just runs the full step budget and would
      // report that same constant for everything, so it's turned on
      // automatically rather than silently making the mapping meaningless.
      if (scene.edgeMode !== "sticky") {
        scene.edgeMode = "sticky";
        edgeModeSelect.value = "sticky";
      }
      scene.output = { body: null, bodyB: null, property: "lifespan" };
    } else {
      // Keeps whatever second object was already chosen, unless it is now
      // body A itself - re-picking the first object shouldn't silently drop
      // the pair you set up.
      var keptB = scene.output && typeof scene.output.bodyB === "number" ? scene.output.bodyB : null;
      var newBody = Number(outputBodySelect.value);
      scene.output = { body: newBody, bodyB: keptB === newBody ? null : keptB, property: OUTPUT_PROPERTIES[0].key };
    }
    refreshOutputPairUI();
    render();
  });

  outputPropertySelect.addEventListener("change", function () {
    if (!scene.output) return;
    scene.output.property = outputPropertySelect.value;
    render();
  });

  // ---- Output's optional second object ----
  //
  // Choosing one turns the Output from "this body's X" into "the average X
  // of these two", and unlocks Distance Apart, which has no single-body
  // meaning. Offered only for a mapping that actually reads a body: Scene
  // Lifespan and Bounce Count are facts about a run and about one body
  // respectively, and neither has a second half.
  function refreshOutputPairUI() {
    var isBodyMapping = scene.output && typeof scene.output.body === "number";
    var pairable = isBodyMapping && scene.bodies.length > 1;
    outputBodyBSelect.parentNode.hidden = !pairable;
    if (!pairable) {
      if (scene.output) scene.output.bodyB = null;
      outputBodyBSelect.innerHTML = "";
    } else {
      outputBodyBSelect.innerHTML = "";
      var noneOpt = document.createElement("option");
      noneOpt.value = "";
      noneOpt.textContent = "(second object: none)";
      outputBodyBSelect.appendChild(noneOpt);
      scene.bodies.forEach(function (b, i) {
        if (i === scene.output.body) return; // pairing a body with itself is just the body
        var opt = document.createElement("option");
        opt.value = i;
        opt.textContent = "and " + bodyOptionLabel(b, i);
        outputBodyBSelect.appendChild(opt);
      });
      outputBodyBSelect.value = typeof scene.output.bodyB === "number" ? scene.output.bodyB : "";
      // A bodyB that no longer exists (deleted, or now the same index as
      // body A after a reindex) silently falls back to no pair rather than
      // leaving the mapping pointing at nothing.
      if (outputBodyBSelect.value === "") scene.output.bodyB = null;
    }
    // The property list itself depends on whether a pair is active, and the
    // current property may not survive the switch - "distance" means
    // nothing without two bodies, and Bounce Count means nothing with them.
    //
    // Only for a mapping that READS A BODY, though. Scene Lifespan is
    // `{ body: null, property: "lifespan" }`, and "lifespan" is in neither
    // body-property list by design - so running the fallback over it
    // rewrote the property to "x" while body stayed null, leaving a mapping
    // that names no body and no body-property. The grid rejects exactly
    // that shape ("missing an Output mapping"), which is how picking Scene
    // Lifespan broke the fractal page.
    var props = outputPropertiesFor(scene.output);
    if (isBodyMapping && !props.some(function (p) { return p.key === scene.output.property; })) {
      scene.output.property = props[0].key;
    }
    populatePropertySelect(outputPropertySelect, isBodyMapping ? scene.output.body : null,
      scene.output ? scene.output.property : null, props);
  }

  outputBodyBSelect.addEventListener("change", function () {
    if (!scene.output) return;
    scene.output.bodyB = outputBodyBSelect.value === "" ? null : Number(outputBodyBSelect.value);
    refreshOutputPairUI();
    render();
  });

  // ---- "Not ready yet" guidance for the Fractal-ize button ----
  //
  // The button is ALWAYS the same bright color (see .fractalize-btn in
  // physics.css) - it only ever grays out, with an explanation, while the
  // pointer is actually over it or briefly after a click that couldn't
  // proceed. That rules out the native `disabled` attribute: a genuinely
  // disabled button stops reliably firing the hover events this depends on
  // in every browser, so readiness is instead just a plain JS check, run
  // fresh on demand rather than continuously mirrored into a DOM attribute.
  //
  // Checked in a fixed order - body count, then input, then output - so the
  // message always points at the SINGLE earliest thing actually in the way,
  // never several at once.
  function gridReadiness() {
    if (scene.bodies.length <= 1) {
      return {
        ready: false,
        message: "Try loading a sample scene first",
        highlight: [btnSampleDoublePendulum, btnSamplePinball, btnSampleBinaryStar],
      };
    }
    if (!scene.xInput || !scene.yInput) {
      return {
        ready: false,
        message: "Try setting one of the bodies as input first",
        highlight: [document.querySelector('[data-tool="input"]')],
      };
    }
    if (!scene.output) {
      return {
        ready: false,
        message: "Try setting one of the bodies as output first",
        highlight: [document.querySelector('[data-tool="output"]')],
      };
    }
    return { ready: true };
  }

  // Whatever's currently highlighted because of the CURRENT hint - tracked
  // so showing a new one (or hiding) only ever clears exactly what this
  // feature itself turned on, never anything else.
  var hintHighlighted = [];
  // Set only while a click's post-click grace period (see the click handler
  // below) is running - mouseenter/mouseleave both defer to it instead of
  // fighting over the button's class while it's ticking.
  var notReadyClickTimer = null;

  function showNotReadyHint(readiness) {
    btnSendToGrid.classList.add("not-ready");
    sendToGridErrorEl.textContent = readiness.message;
    sendToGridErrorEl.className = "readout hint";
    hintHighlighted.forEach(function (el) { el.classList.remove("highlight-hint"); });
    hintHighlighted = (readiness.highlight || []).filter(Boolean);
    hintHighlighted.forEach(function (el) { el.classList.add("highlight-hint"); });
  }

  function hideNotReadyHint() {
    btnSendToGrid.classList.remove("not-ready");
    sendToGridErrorEl.textContent = "";
    sendToGridErrorEl.className = "readout";
    hintHighlighted.forEach(function (el) { el.classList.remove("highlight-hint"); });
    hintHighlighted = [];
  }

  btnSendToGrid.addEventListener("mouseenter", function () {
    if (notReadyClickTimer) return; // a click's own grace period is already showing this
    var readiness = gridReadiness();
    if (!readiness.ready) showNotReadyHint(readiness);
  });
  btnSendToGrid.addEventListener("mouseleave", function () {
    if (notReadyClickTimer) return;
    hideNotReadyHint();
  });

  btnSendToGrid.addEventListener("click", function () {
    // The scene may currently be showing a mid- or post-Play animation
    // frame (tick() writes those straight into scene.bodies) rather than
    // what was actually authored - reset first so the fractal is always
    // generated from the starting configuration, not wherever Play left it.
    resetToInitialScene();
    var readiness = gridReadiness();
    if (!readiness.ready) {
      // Clicking a not-ready button is the same hint a hover would show,
      // just held for a fixed window regardless of whether the pointer
      // stays put - clicking is often a quick tap, and the whole point is
      // that the explanation is still legible after it.
      showNotReadyHint(readiness);
      if (notReadyClickTimer) clearTimeout(notReadyClickTimer);
      notReadyClickTimer = setTimeout(function () {
        notReadyClickTimer = null;
        if (!btnSendToGrid.matches(":hover")) hideNotReadyHint();
      }, 2500);
      return;
    }
    sendToGridErrorEl.textContent = "";
    sendToGridErrorEl.className = "readout";
    var handoff = serializeScene();
    try {
      localStorage.setItem(GRID_HANDOFF_KEY, JSON.stringify(handoff));
    } catch (err) {
      showSendToGridError("Couldn't save scene: " + (err.message || err));
      return;
    }
    // Both views live in one document now, so this is a view switch (and
    // the transition that plays over it), not a navigation. The handoff is
    // still written above: it is what a cold load of index.html reads, and
    // what the grid falls back to if it is started without one.
    window.AppShell.goToGrid(handoff);
  });

  function showSendToGridError(message) {
    sendToGridErrorEl.textContent = message;
    sendToGridErrorEl.className = "readout error";
  }

  // ---- Scene JSON: a live, editable description of the starting scene ----

  function roundNum(n) {
    return Math.round(n * 10000) / 10000;
  }

  // The frame an authored scene is being loaded INTO - see
  // PhysicsCoords.toEngineJSON for why it is the receiving frame that
  // matters rather than the one the JSON was written at. scene.frameWidth
  // is already live-synced to the canvas by resizeCanvas; the fallback
  // covers the one moment it isn't, the very first load, where canvasArea
  // is exactly what resizeCanvas is about to set it to anyway.
  function liveFrame() {
    return {
      frameWidth: scene.frameWidth || canvasArea.clientWidth || 0,
      frameHeight: scene.frameHeight || canvasArea.clientHeight || 0,
    };
  }

  // Moves the whole scene rigidly - every body plus every hinge-to-world
  // anchor, which is a world point rather than a local offset (see
  // PhysicsEngine.hingeBodyA). Nothing relative changes, so there is no
  // hinge geometry to re-establish afterward; this is not an edit of any
  // one body and deliberately doesn't go through
  // PhysicsHingeGeometry.translateBodyPreservingHinges, whose whole job is
  // moving one body WITHOUT its neighbors.
  function translateWholeScene(dx, dy) {
    if (!dx && !dy) return;
    scene.bodies.forEach(function (b) { b.x += dx; b.y += dy; });
    scene.hinges.forEach(function (h) {
      if (h.bodyA !== null) return;
      h.localAnchorA = { x: h.localAnchorA.x + dx, y: h.localAnchorA.y + dy };
    });
  }

  function serializeScene() {
    return {
      mutualGravity: !!scene.mutualGravity,
      collisionsEnabled: PhysicsEngine.collisionsEnabled(scene),
      simulationSteps: scene.simulationSteps,
      bodies: scene.bodies.map(function (b) {
        var out = { type: b.type, x: roundNum(b.x), y: roundNum(b.y), angle: roundNum(b.angle), isAnchored: !!b.isAnchored };
        if (b.type === "circle") out.radius = roundNum(b.radius);
        else if (isTrapezoidType(b.type)) out.size = roundNum(b.size);
        else out.length = roundNum(b.length);
        out.vx = roundNum(b.vx);
        out.vy = roundNum(b.vy);
        out.w = roundNum(b.w);
        return out;
      }),
      hinges: scene.hinges.map(function (h) {
        return {
          bodyA: h.bodyA,
          bodyB: h.bodyB,
          localAnchorA: { x: roundNum(h.localAnchorA.x), y: roundNum(h.localAnchorA.y) },
          localAnchorB: { x: roundNum(h.localAnchorB.x), y: roundNum(h.localAnchorB.y) },
        };
      }),
      xInput: scene.xInput ? { body: scene.xInput.body, property: scene.xInput.property } : null,
      yInput: scene.yInput ? { body: scene.yInput.body, property: scene.yInput.property } : null,
      output: scene.output ? {
        body: scene.output.body,
        bodyB: typeof scene.output.bodyB === "number" ? scene.output.bodyB : null,
        property: scene.output.property,
      } : null,
      frameWidth: roundNum(scene.frameWidth),
      frameHeight: roundNum(scene.frameHeight),
      edgeMode: PhysicsEngine.edgeModeOf(scene),
      maxSimulationBodies: PhysicsEngine.maxSimulationBodiesFor(scene),
    };
  }

  // Validates a plain scene-shaped object (from the Import modal's textarea,
  // or from the auto-saved copy in localStorage) and returns fresh, ready-
  // to-use bodies/hinges/mappings - or throws with a message fit to show
  // the user. Pulled out of loadSceneFromImportModal so the auto-restore-
  // on-load feature below can reuse the exact same validation instead of a
  // second copy.
  function parseSceneData(parsed) {
    if (!parsed || !Array.isArray(parsed.bodies)) {
      throw new Error('JSON must have a "bodies" array.');
    }
    if (parsed.bodies.length > PhysicsGPU.MAX_BODIES) {
      throw new Error("Max " + PhysicsGPU.MAX_BODIES + " bodies (JSON has " + parsed.bodies.length + ").");
    }

    var newBodies = parsed.bodies.map(function (b, i) {
      var body;
      if (b.type === "circle") {
        body = PhysicsEngine.createCircle(Number(b.x), Number(b.y), Number(b.radius), !!b.isAnchored);
        if (b.angle !== undefined) body.angle = Number(b.angle);
      } else if (b.type === "line") {
        body = PhysicsEngine.createLine(Number(b.x), Number(b.y), Number(b.length), Number(b.angle) || 0, !!b.isAnchored);
      } else if (b.type === "funnel") {
        body = PhysicsEngine.createFunnel(Number(b.x), Number(b.y), Number(b.size), Number(b.angle) || 0, !!b.isAnchored);
      } else if (b.type === "splitter") {
        body = PhysicsEngine.createSplitter(Number(b.x), Number(b.y), Number(b.size), Number(b.angle) || 0, !!b.isAnchored);
      } else {
        throw new Error('bodies[' + i + "]: type must be \"circle\", \"line\", \"funnel\", or \"splitter\"");
      }
      if (b.vx !== undefined) body.vx = Number(b.vx);
      if (b.vy !== undefined) body.vy = Number(b.vy);
      if (b.w !== undefined) body.w = Number(b.w);
      return body;
    });

    var newHinges = [];
    if (Array.isArray(parsed.hinges)) {
      for (var i = 0; i < parsed.hinges.length; i++) {
        var h = parsed.hinges[i];
        var bodyA = h.bodyA === null || h.bodyA === undefined ? null : Number(h.bodyA);
        var bodyB = Number(h.bodyB);
        if (bodyA !== null && !(bodyA >= 0 && bodyA < newBodies.length)) {
          throw new Error("hinges[" + i + "]: bodyA index out of range.");
        }
        if (!(bodyB >= 0 && bodyB < newBodies.length)) {
          throw new Error("hinges[" + i + "]: bodyB index out of range.");
        }
        if (!h.localAnchorA || !h.localAnchorB) {
          throw new Error("hinges[" + i + "]: needs localAnchorA and localAnchorB.");
        }
        newHinges.push({
          bodyA: bodyA,
          bodyB: bodyB,
          localAnchorA: { x: Number(h.localAnchorA.x), y: Number(h.localAnchorA.y) },
          localAnchorB: { x: Number(h.localAnchorB.x), y: Number(h.localAnchorB.y) },
        });
      }
    }

    function parseMapping(raw, label, propsList, allowLifespan) {
      if (raw === null || raw === undefined) return null;
      // Scene Lifespan has no body of its own - checked before the
      // Number(raw.body) coercion below, which would otherwise turn a
      // genuine `body: null` into bodyIndex 0 instead of rejecting or
      // preserving it.
      if (allowLifespan && raw.body === null && raw.property === "lifespan") return { body: null, bodyB: null, property: "lifespan" };
      var bodyIndex = Number(raw.body);
      if (!(bodyIndex >= 0 && bodyIndex < newBodies.length)) {
        throw new Error(label + ".body index out of range.");
      }
      // Output only: an optional second body, which switches the mapping to
      // the pair reading (average, or Distance Apart). Absent/null is the
      // one-body mapping.
      var bodyB = null;
      if (allowLifespan && raw.bodyB !== null && raw.bodyB !== undefined) {
        bodyB = Number(raw.bodyB);
        if (!(bodyB >= 0 && bodyB < newBodies.length)) {
          throw new Error(label + ".bodyB index out of range.");
        }
        // Paired with itself is just the body - accepted and collapsed
        // rather than rejected, since it means exactly what one body means.
        if (bodyB === bodyIndex) bodyB = null;
      }
      var props = propsList
        ? (bodyB === null ? OUTPUT_PROPERTIES : OUTPUT_PAIR_PROPERTIES)
        : PROPERTIES_BY_TYPE[newBodies[bodyIndex].type];
      var validProps = props.map(function (p) { return p.key; });
      if (validProps.indexOf(raw.property) === -1) {
        throw new Error(label + ".property must be one of: " + validProps.join(", ") +
          (propsList && bodyB !== null ? " (with a second body chosen)" : ""));
      }
      return { body: bodyIndex, bodyB: bodyB, property: raw.property };
    }

    return {
      bodies: newBodies,
      hinges: newHinges,
      xInput: parseMapping(parsed.xInput, "xInput"),
      yInput: parseMapping(parsed.yInput, "yInput"),
      output: parseMapping(parsed.output, "output", OUTPUT_PROPERTIES, true),
      // Pasted JSON that leaves any of these out, or garbles one, gets the
      // same default a brand-new scene starts with rather than an error.
      edgeMode: PhysicsEngine.edgeModeOf(parsed),
      mutualGravity: parsed.mutualGravity === true,
      maxSimulationBodies: PhysicsEngine.maxSimulationBodiesFor(parsed),
      collisionsEnabled: PhysicsEngine.collisionsEnabled(parsed),
      // Snapped onto the slider's own grid of hundreds so the control can
      // always show exactly what got loaded.
      simulationSteps: (function () {
        var v = Number(parsed.simulationSteps);
        if (!isFinite(v) || v <= 0) return DEFAULT_SIMULATION_STEPS;
        var notches = Math.min(SIMULATION_STEPS_MAX_NOTCHES, Math.max(1, Math.round(v / SIMULATION_STEPS_PER_NOTCH)));
        return notches * SIMULATION_STEPS_PER_NOTCH;
      })(),
    };
  }

  function applySceneData(data) {
    scene.bodies = data.bodies;
    scene.hinges = data.hinges;
    scene.xInput = data.xInput;
    scene.yInput = data.yInput;
    scene.output = data.output;
    scene.edgeMode = data.edgeMode;
    scene.maxSimulationBodies = data.maxSimulationBodies;
    scene.mutualGravity = !!data.mutualGravity;
    scene.collisionsEnabled = data.collisionsEnabled !== false;
    scene.simulationSteps = data.simulationSteps;

    edgeModeSelect.value = scene.edgeMode;
    setMaxBodiesUI(scene.maxSimulationBodies);
    mutualGravityCheckbox.checked = scene.mutualGravity;
    collisionsCheckbox.checked = scene.collisionsEnabled;
    simulationStepsSlider.value = String(scene.simulationSteps / SIMULATION_STEPS_PER_NOTCH);
    updateSimulationStepsReadout(scene.simulationSteps);
    playbackProgressSlider.max = String(scene.simulationSteps);
  }

  // Common tail for anything that replaces the whole scene at once (pasted
  // JSON, a sample, Clear All): refresh every panel that reads scene state
  // directly rather than through render()'s own per-frame sync.
  function finishSceneReplace() {
    importJsonErrorEl.textContent = "";
    importJsonErrorEl.className = "readout";
    refreshMappingUI();
    selectBody(-1);
    resizeCanvas(); // re-syncs frameWidth/frameHeight to the live canvas size, same as on initial load
  }

  function loadSceneFromImportModal() {
    var parsed;
    try {
      parsed = JSON.parse(importJsonTextarea.value);
    } catch (err) {
      importJsonErrorEl.textContent = "Invalid JSON: " + err.message;
      importJsonErrorEl.className = "readout error";
      return;
    }
    var data;
    try {
      data = parseSceneData(PhysicsCoords.toEngineJSON(parsed, liveFrame()));
    } catch (err) {
      importJsonErrorEl.textContent = err.message;
      importJsonErrorEl.className = "readout error";
      return;
    }
    applySceneData(data);
    finishSceneReplace();
    closeModal();
  }

  // Samples are fetched on click (not preloaded) since they're only ever
  // needed the moment a button is pressed - same validation path as pasted
  // JSON, so a malformed sample file fails the same way a bad paste would.
  function loadSample(url, label) {
    if (scene.bodies.length > 0 && !window.confirm("Clear current scene and load " + label + "?")) return;
    fetch(url)
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (parsed) {
        applySceneData(parseSceneData(PhysicsCoords.toEngineJSON(parsed, liveFrame())));
        finishSceneReplace();
      })
      .catch(function (err) {
        flashStatus("Couldn't load sample: " + (err.message || err));
      });
  }

  btnSampleDoublePendulum.addEventListener("click", function () {
    loadSample("samples/double_pendulum.json", "Double Pendulum");
  });
  btnSamplePinball.addEventListener("click", function () {
    loadSample("samples/pinball.json", "Pinball");
  });
  btnSampleBinaryStar.addEventListener("click", function () {
    loadSample("samples/binary_star.json", "Binary Star");
  });
  btnClearAll.addEventListener("click", function () {
    scene.bodies = [];
    scene.hinges = [];
    scene.xInput = null;
    scene.yInput = null;
    scene.output = null;
    finishSceneReplace();
  });

  // Restores whatever was being edited last time, so navigating away (e.g.
  // to Send to Fractal Grid, or the back-link) and returning doesn't lose
  // work to the hardcoded seed scene. Silently falls back to the caller
  // seeding a default scene on any error - a corrupted or outdated save
  // should never be able to break the page from loading.
  function loadPersistedScene() {
    var raw = localStorage.getItem(EDITOR_STORAGE_KEY);
    if (!raw) return false;
    try {
      applySceneData(parseSceneData(PhysicsCoords.toEngineJSON(JSON.parse(raw), liveFrame())));
      return true;
    } catch (err) {
      return false;
    }
  }

  // ---- Export / Import modal ----
  //
  // One shared dialog shell (see #modal-backdrop in #editor-view) - opening
  // just shows the one content div (export or import) that's relevant and
  // hides the other, rather than building separate dialogs.
  function openModal(title, contentEl) {
    modalTitle.textContent = title;
    exportModalContent.hidden = contentEl !== exportModalContent;
    importModalContent.hidden = contentEl !== importModalContent;
    modalBackdrop.hidden = false;
  }
  function closeModal() {
    modalBackdrop.hidden = true;
  }

  btnExportScene.addEventListener("click", function () {
    // No indent argument: a compact one-liner (no newlines/tabs) rather
    // than the pretty-printed shape the old live-synced textarea used -
    // this is meant to be pasted around whole, not read in place.
    exportJsonTextarea.value = JSON.stringify(PhysicsCoords.toAuthoredJSON(serializeScene()));
    openModal("Export Scene", exportModalContent);
    exportJsonTextarea.focus();
    exportJsonTextarea.select();
  });

  btnImportScene.addEventListener("click", function () {
    importJsonTextarea.value = "";
    importJsonErrorEl.textContent = "";
    importJsonErrorEl.className = "readout";
    openModal("Import Scene", importModalContent);
    importJsonTextarea.focus();
  });

  btnModalLoadScene.addEventListener("click", loadSceneFromImportModal);
  btnModalClose.addEventListener("click", closeModal);
  modalBackdrop.addEventListener("click", function (e) {
    if (e.target === modalBackdrop) closeModal(); // the dimmed backdrop itself, not the dialog inside it
  });

  // ---- Play / reset ----

  // Used to gray out every editing control the instant Play started (an
  // enabled=false call below), since a run in flight was launched against
  // whatever they held and changing them silently wouldn't do anything
  // until a fresh Play. That hid the fact that they were still real,
  // pressable actions - see lockedDuringPlaybackControls just below, which
  // instead lets each one reset the run and apply immediately. So this is
  // now an enabled-only hook: resetToInitialScene() and the initial boot
  // both still want the "refresh selects to match the live scene" side
  // effect, but there's nothing left to do for the disable side.
  function setEditingEnabled(enabled) {
    if (!enabled) return;
    // Property selects have their own conditional disabled state (only
    // enabled when their body select isn't "None") - refreshMappingUI
    // restores that.
    refreshMappingUI();
  }

  // ---- Keep these usable during playback instead of graying out ----
  //
  // Every real editing control in #panel, including Mutual Gravity/
  // Collisions (which never grayed out, but silently changing physics
  // properties mid-run without resetting was just as stale a no-op as the
  // grayed-out controls were - see the mutualGravityCheckbox/
  // collisionsCheckbox change handlers, which only assign into `scene`).
  // Now any of them can be touched mid-run: the first effect is exactly
  // what Reset does (snap back to the pre-play scene), and only then does
  // the control's own handler run - against that now-editable scene. Not
  // in this list: btnPlayPause/btnMute/playbackProgressSlider/btnSpeed/
  // btnReset (the playback transport itself, now its own floating toolbar
  // - see index.html) and outputBodyBSelect/the "Advanced" disclosures,
  // which stay plain toggles/selects with no reset side effect.
  var lockedDuringPlaybackControls = toolButtons.concat([
    btnExportScene, btnImportScene,
    btnSampleDoublePendulum, btnSamplePinball, btnSampleBinaryStar, btnClearAll,
    mutualGravityCheckbox, collisionsCheckbox,
    edgeModeSelect, maxBodiesSlider, simulationStepsSlider,
    xInputBodySelect, yInputBodySelect, outputBodySelect,
    xInputPropertySelect, yInputPropertySelect, outputPropertySelect,
  ]);
  // A capturing listener on #panel (an ancestor of every control above)
  // always runs before that control's own listener fires, however each one
  // is wired (click/input/change) - so the reset is guaranteed to land
  // first no matter which of the three events actually fired. For a
  // select/slider/checkbox, the browser has already committed the new
  // value to e.target by this point but the control's own handler hasn't
  // read it yet; resetToInitialScene() -> setEditingEnabled(true) ->
  // refreshMappingUI() can rebuild that same element (wiping it back to
  // the pre-play value), so the new value is snapshotted first and
  // restored right after - whatever the user just picked/checked is what
  // the control's own handler sees.
  function resetBeforeLockedControlAction(e) {
    if (!isPlaying) return;
    if (lockedDuringPlaybackControls.indexOf(e.target) === -1) return;
    var target = e.target;
    var isCheckbox = target.type === "checkbox";
    var pendingValue = isCheckbox ? target.checked : target.value;
    resetToInitialScene();
    if (isCheckbox) target.checked = pendingValue;
    else if (pendingValue !== undefined) target.value = pendingValue;
  }
  panelEl.addEventListener("click", resetBeforeLockedControlAction, true);
  panelEl.addEventListener("input", resetBeforeLockedControlAction, true);
  panelEl.addEventListener("change", resetBeforeLockedControlAction, true);

  // Stops the clock without leaving playback mode - isPlaying (and so
  // editing-locked) stays true, since resuming later depends on
  // scene.bodies still holding exactly what the trajectory last wrote into
  // it. Used by the Pause click, a progress-slider drag, and tick()
  // reaching the final frame; only resetToInitialScene (Reset, or
  // Fractal-ize taking a fresh snapshot) goes the rest of the way back to
  // Editing.
  function pausePlayback() {
    isAdvancing = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    updatePlayPauseButtonUI();
  }

  // Playback applies zero physics: it's a pure lookup into the GPU-computed
  // trajectory, written into the same body objects the renderer already
  // knows how to draw.
  var trajectory = null;

  // The stepCount playback actually stops at for this run - scene.
  // simulationSteps unless "Stop on wrap" found the Output body wrapping
  // earlier (see PhysicsHingeGeometry.findWrapStopStep). Recomputed fresh at
  // the top of every Play click.
  var effectiveMaxSteps = DEFAULT_SIMULATION_STEPS;
  // The Output body's interpolated (continuous, sub-step-accurate) x/y/angle
  // for the FINAL frame of a wrap-stopped run - null when this run isn't
  // stopping early. trajectory[] only ever holds discrete, once-per-step
  // samples, so the last logged sample before a wrap is itself a
  // discontinuous function of the starting conditions (which step happened
  // to notice the crossing); this override replaces just that one body's
  // displayed state on the final frame with findWrapStopStep's continuous
  // reconstruction, without touching how any other body is drawn.
  var wrapStopOverride = null;
  // Scene Lifespan's own value for this run - a single fact about the whole
  // trajectory (when did some watched body first cross an edge), known as
  // soon as findWrapStopStep runs at Play time, not a per-step positional
  // readout - so unlike x/y/angle it holds constant across every frame of
  // playback instead of varying as the animation plays. scene.simulationSteps
  // (never crossed, ran the full budget) when this isn't a lifespan run, or a
  // lifespan run that never stopped early.
  var lifespanValue = DEFAULT_SIMULATION_STEPS;
  // Bounce Count's per-step running totals for this run (see
  // PhysicsEngine.runBounceCounts), or null when Output isn't Bounce Count.
  // Unlike x/y/angle it isn't in the GPU trajectory - that only logs body
  // state - so it's counted alongside, on the JS engine, at Play time.
  var bounceCounts = null;
  // Every step (0-indexed) at which some pair of bodies started touching
  // this run - the bounce sound's own trigger list (see
  // PhysicsEngine.runBounceEvents and tick()'s own use of it below).
  // Computed unconditionally alongside bounceCounts, not just when Output is
  // Bounce Count - the sound plays regardless of what's being colored by.
  var bounceEvents = [];

  // The Output property's own exact range, not a per-trajectory min/max
  // scan - mirrors fractal-grid.js's outputRangeMax exactly. A non-anchored
  // body's x/y is already wrapped into exactly [0, frameWidth)/[0,
  // frameHeight) (PhysicsEngine.step's frame wrap, always on here since
  // resizeCanvas always keeps scene.frameWidth/frameHeight set), so those
  // bounds ARE the true range, not an estimate; angle has no positional
  // bound, but mod(angle, TAU) is which way the body is *currently* facing,
  // independent of how many full turns it took to get there, so the color
  // still runs the whole spectrum every rotation instead of slowly
  // saturating over many of them.
  var TAU = Math.PI * 2;
  function outputRangeMax(property) {
    if (property === "x") return scene.frameWidth;
    if (property === "y") return scene.frameHeight;
    // Also not circular: two bodies at the greatest separation the world
    // allows are as far apart as they get, and mod()-ing that back to 0
    // would paint "maximally apart" the same color as "touching".
    if (property === "distance") return PhysicsEngine.outputDistanceMax(scene);
    // Not circular like x/y/angle - see outputColorForNormalized's own
    // comment on why lifespan uses a clamp, not this range's usual mod().
    if (property === "lifespan") return scene.simulationSteps;
    return TAU;
  }

  // Same mapping as the fractal grid: a full-saturation rainbow running the
  // whole way from hue 360° (t=0, the property's minimum) to 0° (t=1, its
  // maximum) - 0° and 360° render identically, so the wrap point reads as
  // one continuous loop of color instead of a seam.
  // OKLCH, not HSL: HSL's lightness is not perceptually uniform (yellow
  // reads far brighter than blue at the same L/S), so a fast-changing value
  // flashes light/dark as the hue sweeps - fine for the fractal grid's
  // static image, but headache-inducing for something animating in place.
  // Fixed lightness/chroma keeps every hue the same apparent brightness;
  // only the hue itself carries the value, same as the HSL version did.
  function outputColorForNormalized(t) {
    var hue = 360 * (1 - t);
    return "oklch(60% 0.136 " + hue.toFixed(2) + ")";
  }

  function updateOutputBackground(currentStepCount) {
    if (!scene.output) return;
    var rangeMax = outputRangeMax(scene.output.property);
    var t;
    if (scene.output.property === "lifespan") {
      // Not circular like x/y/angle - see outputRangeMax's own comment -
      // and already fully known for the whole run, so no per-step lookup.
      t = Math.min(1, Math.max(0, lifespanValue / rangeMax));
    } else if (scene.output.property === "distance") {
      // Clamped, not wrapped, for the same reason lifespan is: the maximum
      // separation is a real value the pair can legitimately sit at.
      t = Math.min(1, Math.max(0, outputValueAtFrame(trajectory[currentStepCount - 1], scene.output) / rangeMax));
    } else if (scene.output.property === "bounces") {
      // Scaled against the most bounces this run reaches (its final total),
      // so the color sweeps the whole rainbow across the run however few or
      // many bounces it turns out to have - the single-scene reading of the
      // fractal grid's "scale against the max bounce count in view".
      var maxBounces = bounceCounts ? bounceCounts[effectiveMaxSteps - 1] : 0;
      t = maxBounces > 0 ? bounceCounts[currentStepCount - 1] / maxBounces : 0;
    } else {
      // Same override as applyTrajectoryStep, and for the same reason: on
      // the final frame of a wrap-stopped run, trajectory[]'s own logged
      // sample is the discontinuous one findWrapStopStep exists to replace.
      var value = (wrapStopOverride && currentStepCount === effectiveMaxSteps)
        ? wrapStopOverride[scene.output.property]
        : outputValueAtFrame(trajectory[currentStepCount - 1], scene.output);
      var prop = scene.output.property;
      if (scene.edgeMode === "infinite" && (prop === "x" || prop === "y")) {
        // Nothing wraps this coordinate back into the frame any more, so
        // there is no range to divide it into - the sigmoid squashes the
        // whole infinite line into the color range instead. Angle is left
        // alone: it is genuinely circular whatever the edges do.
        t = PhysicsEngine.frameSigmoid(value / rangeMax);
      } else {
        t = PhysicsHingeGeometry.wrapIntoRange(value, rangeMax) / rangeMax;
      }
    }
    canvasArea.style.backgroundColor = outputColorForNormalized(t);
  }

  function sceneHasSplitter(s) {
    return s.bodies.some(function (b) { return b.type === "splitter"; });
  }

  // The Output body's value at one trajectory frame - the AVERAGE over every
  // body in its lineage, not one fixed index, so a mapping onto a ball that
  // has since split into two (or more) tracks all of them at once. Only a
  // split-created body carries an explicit `lineage`; everything else is
  // implicitly its own index, so a scene with no splitter averages exactly
  // one body and reads identically to what this replaced.
  function outputValueAtFrame(frame, output) {
    // PhysicsEngine.computeOutputValue reads a SCENE (bodies with a lineage
    // tag); a trajectory frame is the same information in a flatter shape,
    // so it is wrapped into one here rather than duplicating the pair/
    // distance rules a second time. Keeping exactly one definition of "what
    // does this Output mean" is the point - the grid's GLSL is already a
    // second copy of it and that is one more than anyone wants.
    var asScene = {
      bodies: frame.map(function (b, i) {
        return { x: b.x, y: b.y, angle: b.angle, lineage: b.lineage !== undefined ? b.lineage : i };
      }),
      frameWidth: scene.frameWidth, frameHeight: scene.frameHeight, edgeMode: scene.edgeMode,
    };
    return PhysicsEngine.computeOutputValue(asScene, output);
  }

  // stepCount is 1-indexed ("Step 1 / 1000" is the state after 1 physics
  // step); trajectory[] is 0-indexed with row i holding the state after i+1
  // steps, so the lookup is stepCount - 1.
  function applyTrajectoryStep(stepCount) {
    var frame = trajectory[stepCount - 1];
    // A splitter's run has MORE bodies in later frames than the scene was
    // authored with (see PhysicsEngine.runTrajectory) - grow the scene to
    // match so every ball a split produced actually gets drawn, and shrink
    // back when scrubbing to a frame from before it existed.
    while (scene.bodies.length < frame.length) {
      var born = frame[scene.bodies.length];
      var extra = PhysicsEngine.createCircle(born.x, born.y, born.radius, false);
      extra.lineage = born.lineage;
      scene.bodies.push(extra);
    }
    if (scene.bodies.length > frame.length) scene.bodies.length = frame.length;
    for (var i = 0; i < scene.bodies.length; i++) {
      scene.bodies[i].x = frame[i].x;
      scene.bodies[i].y = frame[i].y;
      scene.bodies[i].angle = frame[i].angle;
    }
    // Only meaningful on the exact final frame of a wrap-stopped run - see
    // wrapStopOverride's own comment. Scene Lifespan has no body of its own
    // to correct here - its value doesn't come from any body's position.
    if (wrapStopOverride && stepCount === effectiveMaxSteps && scene.output.body !== null) {
      var out = scene.bodies[scene.output.body];
      out.x = wrapStopOverride.x;
      out.y = wrapStopOverride.y;
      out.angle = wrapStopOverride.angle;
    }
  }

  // Steps per real second the trajectory plays back at - matches the fixed
  // timestep it was simulated with, so "Step 600" reaches the screen at
  // roughly the same wall-clock moment the physics itself models it (10s).
  var STEPS_PER_SECOND = 1 / PhysicsGPU.FIXED_DT;
  // True only while the clock is actively advancing - unlike isPlaying,
  // which stays true through a pause too (see pausePlayback) - so this is
  // exactly what the Play/Pause button's own icon reflects.
  var isAdvancing = false;
  // Elapsed steps as a float, accumulated frame to frame rather than
  // recomputed from a fixed start time (see tick()) - pausing simply stops
  // adding to it, and resuming picks up from exactly where it left off
  // with no separate "how long were we paused" bookkeeping needed.
  var playbackClockSteps = 0;
  var lastTickTime = 0;

  // The step actually shown right now - stepCount itself can be dragged
  // past effectiveMaxSteps (the progress slider spans the full configured
  // Simulation Duration, not just however far this particular run got; see
  // playbackProgressSlider's own "input" handler), in which case the scene
  // just holds on its real final frame rather than indexing past the end
  // of a trajectory that was never simulated that far.
  function currentDisplayStep() { return Math.min(stepCount, effectiveMaxSteps); }

  function updateStepReadout() {
    var displayStep = currentDisplayStep();
    var stoppedEarly = displayStep >= effectiveMaxSteps && effectiveMaxSteps < scene.simulationSteps;
    stepReadout.textContent = "Step " + displayStep + " / " + scene.simulationSteps +
      (stoppedEarly ? " - stopped early: an object reached the frame edge" : "");
  }

  function updatePlaybackProgressSliderPosition() {
    playbackProgressSlider.value = String(Math.max(1, stepCount));
  }

  function updatePlayPauseButtonUI() {
    btnPlayPause.textContent = isAdvancing ? "⏸" : "▶";
    btnPlayPause.title = isAdvancing ? "Pause" : "Play";
    btnPlayPause.setAttribute("aria-label", isAdvancing ? "Pause" : "Play");
  }

  // ---- Playback speed ----
  //
  // A multiplier on STEPS_PER_SECOND, not a replacement for it - 1x is
  // still exactly real-time (see STEPS_PER_SECOND's own comment), so this
  // only ever scales that. Read fresh by tick() every frame, so dragging
  // the slider takes effect immediately on a run already in progress
  // rather than only on the next Play. Defaults to a real-time 1x on this
  // page - the fractal grid's own default (fractal-grid.js) is 2x instead.
  var playbackSpeed = 1;
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
  // The HTML hardcodes matching min/max/step (see #speed-slider's own
  // comment) for a flash-free first paint before this runs - set from the
  // same constants here so the two can never quietly drift apart.
  speedSlider.min = String(SPEED_LOG_MIN);
  speedSlider.max = String(SPEED_LOG_MAX);
  speedSlider.step = "1";

  // "2x"/"16x" (no decimal) once a whole step no longer reads as a
  // meaningfully different speed; "0.5x"/"1.3x" below that, where a tenth
  // is still a noticeable fraction of the current value.
  function formatSpeed(v) {
    return (v < 2 ? v.toFixed(1) : String(Math.round(v))) + "x";
  }

  function updateSpeedUI() {
    var text = formatSpeed(playbackSpeed);
    btnSpeed.textContent = text;
    speedValueEl.textContent = text;
    speedSlider.value = String(speedToSliderValue(playbackSpeed));
  }

  // Fixed positioning (see #speed-popup's own HTML comment) means this has
  // to be placed by hand, the same way positionTip places fractal-grid.js's
  // tip popover: measured against the button's live position rather than
  // laid out declaratively, since nothing here is a normal-flow descendant
  // of it. Centered above the button, clamped so a button near either edge
  // doesn't push the popup off-screen.
  function positionSpeedPopup() {
    var rect = btnSpeed.getBoundingClientRect();
    var width = speedPopup.offsetWidth, height = speedPopup.offsetHeight;
    var left = clamp(rect.left + rect.width / 2 - width / 2, 8, window.innerWidth - width - 8);
    speedPopup.style.left = left + "px";
    speedPopup.style.top = (rect.top - height - 8) + "px";
  }

  function openSpeedPopup() {
    speedPopup.hidden = false;
    btnSpeed.setAttribute("aria-expanded", "true");
    positionSpeedPopup();
    speedSlider.focus();
  }
  function closeSpeedPopup() {
    if (speedPopup.hidden) return;
    speedPopup.hidden = true;
    btnSpeed.setAttribute("aria-expanded", "false");
  }

  btnSpeed.addEventListener("click", function (e) {
    e.stopPropagation(); // otherwise the document click listener below sees this same click as "outside" and immediately closes what it just opened
    if (speedPopup.hidden) openSpeedPopup(); else closeSpeedPopup();
  });
  speedSlider.addEventListener("input", function () {
    playbackSpeed = clamp(sliderValueToSpeed(Number(speedSlider.value)), SPEED_MIN, SPEED_MAX);
    updateSpeedUI();
  });
  document.addEventListener("click", function (e) {
    if (speedPopup.hidden) return;
    if (btnSpeed.contains(e.target) || speedPopup.contains(e.target)) return;
    closeSpeedPopup();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !speedPopup.hidden) { closeSpeedPopup(); btnSpeed.focus(); }
  });
  window.addEventListener("resize", function () {
    if (!speedPopup.hidden) positionSpeedPopup();
  });

  // Driven by elapsed wall-clock time, not "one step per callback": a
  // requestAnimationFrame callback fires whenever the browser is ready to
  // paint, nominally the display's refresh interval but NOT a fixed
  // timer - it stretches under system load, background-tab throttling, or
  // a slower display, and advancing exactly one step per callback would
  // silently slow the whole playback down right along with it. Instead,
  // every callback adds however much real time just passed (scaled to
  // steps, and to the user's chosen playbackSpeed) onto playbackClockSteps
  // and jumps straight to its floor - a slow/late callback skips ahead to
  // stay on schedule (less smooth) rather than dragging the total run time
  // out.
  // This page only ever plays back one scene at a time (no Inspect-style
  // comparison here), so both sound effects always play as a single voice -
  // chordFrequencies(1) is just middle C, the same trivial n<=1 case
  // fractal-grid.js's own multi-voice version collapses to.
  function singleVoiceFreq() { return PhysicsSound.chordFrequencies(1)[0]; }

  function tick() {
    if (!isAdvancing) return;
    var now = performance.now();
    var dt = (now - lastTickTime) / 1000;
    lastTickTime = now;
    playbackClockSteps = Math.min(effectiveMaxSteps, playbackClockSteps + dt * STEPS_PER_SECOND * playbackSpeed);
    var targetStep = Math.floor(playbackClockSteps);
    if (targetStep > stepCount) {
      // Captured before stepCount moves - bounceEvents/wrapStopOverride
      // below need to know exactly which steps this tick newly crossed,
      // not just where it ended up (a slow frame can jump stepCount by more
      // than 1 at once, and every bounce logged in between still deserves
      // its own sound rather than being silently skipped).
      var prevStepCount = stepCount;
      stepCount = targetStep;
      var displayStep = currentDisplayStep();
      applyTrajectoryStep(displayStep);
      updateOutputBackground(displayStep);
      updateStepReadout();
      updatePlaybackProgressSliderPosition();
      render();
      // bounceEvents holds 0-indexed trajectory rows; stepCount is
      // 1-indexed (trajectory[stepCount-1] is "now"), so an event index e
      // has just been reached exactly when prevStepCount <= e < stepCount.
      // One bounce sound per tick is enough even if several qualify at
      // once - several pairs settling in the same frame should read as one
      // busy moment, not a burst of identical blips.
      for (var i = 0; i < bounceEvents.length; i++) {
        if (bounceEvents[i] >= prevStepCount && bounceEvents[i] < stepCount) {
          PhysicsSound.playBounce(singleVoiceFreq());
          break;
        }
      }
      // The sticky-edge stop is a single terminal event (effectiveMaxSteps
      // itself, only set below scene.simulationSteps when
      // findWrapStopStep actually found one) - fires once, the instant
      // playback first reaches it.
      if (wrapStopOverride && prevStepCount < effectiveMaxSteps && stepCount >= effectiveMaxSteps) {
        PhysicsSound.playEdge(singleVoiceFreq());
      }
    }
    if (stepCount >= effectiveMaxSteps) {
      // Freeze right here on the final frame - don't rewind. initialScene
      // still holds the true authored start (untouched by playback, which
      // only ever writes into scene.bodies), so Play/Reset/Fractal-ize all
      // stay correct without the display needing to snap back on its own;
      // see togglePlayPause and resetToInitialScene. Just a pause, not a
      // full stop - isPlaying (and so editing-locked) stays true until
      // Reset, since resuming below depends on scene.bodies still matching
      // this trajectory exactly.
      pausePlayback();
      return;
    }
    rafId = requestAnimationFrame(tick);
  }

  // Always plays from the very first frame - this is only ever reached from
  // Editing (isPlaying false, no run loaded) or right after Reset, since a
  // run already loaded now pauses/resumes in place instead of restarting
  // (see togglePlayPause). Returns false (and leaves everything as it was)
  // if the GPU simulation itself fails.
  function startPlaybackFromScratch() {
    initialScene = PhysicsEngine.cloneScene(scene);
    try {
      // A splitter grows new bodies mid-run. The GPU can represent that now
      // (PhysicsGPU.padSceneForSplitting pre-allocates dormant slots up to
      // MAX_SIMULATION_BODIES and a split wakes one), but its trajectory
      // rows are then always that full width, with dormant slots reporting
      // size 0 - whereas playback below wants rows that GROW, so
      // applyTrajectoryStep can size the drawn scene to whatever existed at
      // that frame. One scene playing back once is cheap in JS, so it runs
      // there and keeps the growing-row shape; see
      // PhysicsEngine.runTrajectory. The regression suite checks the two
      // agree step for step on the same splitter scene.
      trajectory = sceneHasSplitter(scene)
        ? PhysicsEngine.runTrajectory(scene, scene.simulationSteps, PhysicsGPU.FIXED_DT)
        : PhysicsGPU.runSceneOnGPU(scene, scene.simulationSteps);
    } catch (err) {
      flashStatus(err.message || "GPU simulation failed");
      return false;
    }
    effectiveMaxSteps = scene.simulationSteps;
    wrapStopOverride = null;
    lifespanValue = scene.simulationSteps;
    bounceCounts = scene.output && scene.output.property === "bounces"
      ? PhysicsEngine.runBounceCounts(initialScene, scene.output.body, scene.simulationSteps, PhysicsGPU.FIXED_DT)
      : null;
    bounceEvents = PhysicsEngine.runBounceEvents(initialScene, scene.simulationSteps, PhysicsGPU.FIXED_DT);
    if (scene.edgeMode === "sticky" && scene.output) {
      var watchedIndices = PhysicsHingeGeometry.wrapWatchedBodyIndices(scene);
      var targetBodyIndex = scene.output.property === "lifespan" ? null : scene.output.body;
      var wrapStop = PhysicsHingeGeometry.findWrapStopStep(trajectory, watchedIndices, targetBodyIndex, scene.frameWidth, scene.frameHeight, initialScene.bodies, PhysicsGPU.FIXED_DT);
      if (wrapStop !== null) {
        effectiveMaxSteps = Math.max(1, wrapStop.step);
        wrapStopOverride = wrapStop;
        lifespanValue = wrapStop.step + wrapStop.tFrac / PhysicsGPU.FIXED_DT;
      }
    }
    isPlaying = true;
    stepCount = 0;
    playbackClockSteps = 0;
    selectBody(-1);
    setEditingEnabled(false);
    statusEl.textContent = "Playing";
    statusEl.className = "status-playing";
    // The slider's own range is the full configured Simulation Duration,
    // not effectiveMaxSteps - a run that stops early should read as a
    // thumb resting short of the far end, not a shorter bar (see
    // playbackProgressSlider's "input" handler for the matching clamp on
    // the way back in).
    playbackProgressSlider.min = "1";
    playbackProgressSlider.max = String(scene.simulationSteps);
    playbackProgressSlider.disabled = false;
    updatePlaybackProgressSliderPosition();
    return true;
  }

  // The Play/Pause button's only click handler. Pausing is always immediate;
  // "playing" either starts a fresh run, resumes a paused one right where it
  // left off, or - if the run had already reached its last frame - restarts
  // it from the top, the same as every Play click used to before this was a
  // toggle. There's no dwell-then-autoplay grace period to protect here the
  // way the fractal grid's hover panel needs (see its own PLAY_PAUSE_GRACE_MS):
  // playback on this page never starts itself, so every play/pause is
  // already the user's own click.
  function togglePlayPause() {
    if (isAdvancing) {
      pausePlayback();
      return;
    }
    if (!isPlaying) {
      if (!startPlaybackFromScratch()) return;
    } else if (stepCount >= effectiveMaxSteps) {
      stepCount = 0;
      playbackClockSteps = 0;
    }
    isAdvancing = true;
    lastTickTime = performance.now();
    updatePlayPauseButtonUI();
    rafId = requestAnimationFrame(tick);
  }

  btnPlayPause.addEventListener("click", togglePlayPause);

  // Scrubbing always pauses: dragging mid-play would otherwise fight the
  // clock for control of stepCount every frame. Values past effectiveMaxSteps
  // are allowed - the slider's range is the full configured duration - and
  // just hold on the real final frame, via the same currentDisplayStep()
  // clamp tick() itself uses.
  playbackProgressSlider.addEventListener("input", function () {
    if (!isPlaying) return;
    pausePlayback();
    stepCount = Number(playbackProgressSlider.value);
    playbackClockSteps = stepCount;
    var displayStep = currentDisplayStep();
    applyTrajectoryStep(displayStep);
    updateOutputBackground(displayStep);
    updateStepReadout();
    render();
  });

  // Shared by the Reset button and Fractal-ize: both need the live `scene`
  // back to exactly what was authored before Play started, since playback
  // writes each displayed frame straight into scene.bodies (see tick()) and
  // a paused-or-finished run stays frozen there rather than rewinding on
  // its own. The only path that re-enables editing - a run stays locked
  // through every pause/resume/scrub in between, since resuming depends on
  // scene.bodies still matching this trajectory exactly. initialScene is
  // nulled once consumed so a later
  // click - after further edits with no new Play in between - trusts the
  // live scene instead of reverting those edits to a now-stale snapshot.
  function resetToInitialScene() {
    pausePlayback();
    isPlaying = false;
    statusEl.textContent = "Editing";
    statusEl.className = "status-ok";
    setEditingEnabled(true);
    if (initialScene) {
      scene = PhysicsEngine.cloneScene(initialScene);
      initialScene = null;
    }
    stepCount = 0;
    playbackClockSteps = 0;
    stepReadout.textContent = "";
    canvasArea.style.backgroundColor = "";
    playbackProgressSlider.disabled = true;
    playbackProgressSlider.value = playbackProgressSlider.min || "1";
    // resizeCanvas(), not render(): isPlaying is already false by now, so
    // this both re-syncs frameWidth/frameHeight to the live canvas size and
    // un-locks the display back to filling canvasArea - without it, the
    // canvas would stay letterboxed at whatever size it was scaled/centered
    // to during playback until the next unrelated window resize happened to
    // fix it.
    resizeCanvas();
  }

  btnReset.addEventListener("click", resetToInitialScene);

  // ---- Init ----

  function seedDefaultScene() {
    var w = canvasArea.clientWidth || 800, h = canvasArea.clientHeight || 600;
    scene.bodies.push(PhysicsEngine.createLine(w / 2, h - 40, Math.max(200, w - 160), 0, true));
    scene.bodies.push(PhysicsEngine.createCircle(w / 2 - 130, h * 0.25, 30, false));
    scene.bodies.push(PhysicsEngine.createLine(w / 2 + 130, h * 0.25, 140, 0.3, false));
  }

  // Scene must be populated (restored or seeded) BEFORE the first
  // resizeCanvas() call: resizeCanvas() renders internally, and render()
  // now also auto-saves - loading the persisted scene afterward instead
  // would read back whatever that first render() just wrote, which is the
  // still-empty freshly-initialized scene, not the real save. (This isn't
  // hypothetical: it happened, wiping every saved scene on the very next
  // load, and only showed up by actually reloading the page - every
  // automated test constructs scenes directly and never exercises this
  // startup ordering at all.)
  // The frame has to be known BEFORE the scene is restored or seeded.
  // Restoring reads authored, center-relative coordinates and needs a frame
  // to place them in; seeding writes engine coordinates straight from the
  // canvas size, which the first resizeCanvas() below must then see as
  // already matching rather than as a frame change to re-center for.
  if (canvasArea.clientWidth > 0 && canvasArea.clientHeight > 0) {
    scene.frameWidth = canvasArea.clientWidth;
    scene.frameHeight = canvasArea.clientHeight;
  }
  if (!loadPersistedScene()) seedDefaultScene();
  // Redundant when loadPersistedScene ran applySceneData above, but harmless
  // and cheap - and it's what keeps a fresh (seeded) scene's slider in sync
  // with scene.simulationSteps without relying on the HTML's own default
  // value staying hand-matched to DEFAULT_SIMULATION_STEPS forever.
  simulationStepsSlider.value = String(scene.simulationSteps / SIMULATION_STEPS_PER_NOTCH);
  updateSimulationStepsReadout(scene.simulationSteps);
  playbackProgressSlider.max = String(scene.simulationSteps);
  updatePlayPauseButtonUI();
  updateSpeedUI();
  resizeCanvas();
  setEditingEnabled(true);
  setActiveTool("select");
  render();

  // ---- What the transition needs from the editor ----
  //
  // The zoom-out explainer draws the editor's scene, tiled, into its own
  // canvas - see transition.js. It wants the BODIES and nothing else: no
  // grid lines, no hinges, no mapping badges, no selection handles, none of
  // the editing chrome render() above also paints.
  //
  // drawBody() draws into this module's own `ctx`, so the context is
  // swapped for the duration rather than the drawing being duplicated: one
  // definition of what a circle/line/funnel/splitter looks like, used by
  // both the editor and the animation that zooms away from it.
  global.PhysicsUI = {
    drawSceneBodies: function (targetCtx, bodies) {
      var previous = ctx;
      ctx = targetCtx;
      try {
        for (var i = 0; i < bodies.length; i++) drawBody(bodies[i], false);
      } finally {
        ctx = previous;
      }
    },
    // The scene as currently authored, for the transition to simulate and
    // draw. A copy, so the animation stepping it forward can't disturb what
    // the editor is holding.
    currentScene: function () { return PhysicsEngine.cloneScene(scene); },
    // ---- The one setting that exists on both pages ----
    //
    // Simulation Duration is scene.simulationSteps, and the fractal grid
    // has its own slider on the same value. That page calls this when its
    // slider moves, so the number the user set there is the one still
    // showing here when they come back - and, since the handoff is built
    // from this scene, the one a later Fractal-ize sends back over.
    //
    // Without it the grid's change lived only in that module: the editor
    // kept showing the old duration and the next Fractal-ize overwrote the
    // user's choice with it.
    //
    // Snapped to the slider's own notches (and clamped to its range) rather
    // than trusted: this is a setter reachable from another module, and a
    // value between notches would leave the slider unable to represent what
    // the scene says.
    setSimulationSteps: function (steps) {
      var v = Number(steps);
      if (!isFinite(v) || v <= 0) return;
      var notches = Math.min(SIMULATION_STEPS_MAX_NOTCHES,
        Math.max(1, Math.round(v / SIMULATION_STEPS_PER_NOTCH)));
      var next = notches * SIMULATION_STEPS_PER_NOTCH;
      if (next === scene.simulationSteps) return;
      scene.simulationSteps = next;
      simulationStepsSlider.value = String(notches);
      updateSimulationStepsReadout(next);
      // The same guard the slider's own handler uses: during a run the
      // progress slider's range belongs to the run, not to the setting.
      if (!isPlaying) playbackProgressSlider.max = String(next);
      // render() is what normally sweeps a change into the autosave, and
      // nothing is rendering here - the editor isn't the visible view when
      // this is called.
      saveEditorAutosave();
    },
  };
})(window);
