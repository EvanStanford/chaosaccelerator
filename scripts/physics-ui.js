// CPAL-1.0 License. See chaosaccelerator.com/license.html

// Scene builder UI: canvas drawing, tools and handles, the side panel, playback,
// scene import/export and the hand-off to the fractal grid.
(function (global) {
  "use strict";

  // Default only: simulationSteps travels with the scene (export/import, grid handoff).
  var DEFAULT_SIMULATION_STEPS = 1000;
  // Notches match fractal-grid.js's slider notch-for-notch.
  var SIMULATION_STEPS_PER_NOTCH = 100;
  var SIMULATION_STEPS_MAX_NOTCHES = 50;
  // Typed durations keep their exact value; the slider just rests on the nearest notch.
  var SIMULATION_STEPS_MAX = SIMULATION_STEPS_PER_NOTCH * SIMULATION_STEPS_MAX_NOTCHES;
  function clampSimulationSteps(v) {
    v = Number(v);
    if (!isFinite(v) || v <= 0) return null;
    return Math.min(SIMULATION_STEPS_MAX, Math.max(1, Math.round(v)));
  }
  function simulationStepsNotch(steps) {
    return Math.min(SIMULATION_STEPS_MAX_NOTCHES, Math.max(1, Math.round(steps / SIMULATION_STEPS_PER_NOTCH)));
  }
  // Auto-saved on every edit; restored when the page is reopened.
  var EDITOR_STORAGE_KEY = "physicsEditorScene";
  // Non-null while the scene arrived by link and is unedited: see saveEditorAutosave.
  var sharedSceneIdentity = null;
  var TIP_DISMISSED_KEY = "physicsAppDismissedTips";

  var canvas = document.getElementById("physics-canvas");
  var ctx = canvas.getContext("2d");
  var canvasArea = document.getElementById("canvas-area");
  // Read for its rect: decides where the drag-to-delete zone sits (deleteZoneCenter).
  var playbackToolbar = document.getElementById("playback-toolbar");
  var panelEl = document.getElementById("panel");
  var btnSettings = document.getElementById("btn-settings");
  var btnSettingsClose = document.getElementById("btn-settings-close");
  var settingsPanel = document.getElementById("settings-panel");
  var btnMute = document.getElementById("btn-mute");
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
  var editorView = document.getElementById("editor-view"); // undo/redo only fire while this is the view up
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
  var springSection = document.getElementById("spring-section");
  var springStiffnessSlider = document.getElementById("spring-stiffness-slider");
  var springStiffnessReadout = document.getElementById("spring-stiffness-readout");
  var springStiffnessNote = document.getElementById("spring-stiffness-note");
  var springRestSlider = document.getElementById("spring-rest-slider");
  var springRestReadout = document.getElementById("spring-rest-readout");
  var btnDeleteSpring = document.getElementById("btn-delete-spring");
  var btnSendToGrid = document.getElementById("btn-send-to-grid");
  var sendToGridErrorEl = document.getElementById("send-to-grid-error");

  // X/Y Inputs only record a target; Output colors the playback background.
  // vx/vy are offsets, applied in physics-grid-codegen.js's velocityTargets.
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
    // Same trapezoid as a funnel; only the special edge differs (createSplitter).
    splitter: [
      { key: "x", label: "Center X" },
      { key: "y", label: "Center Y" },
      { key: "angle", label: "Rotation" },
      { key: "size", label: "Size" },
      { key: "vx", label: "Starting X Velocity" },
      { key: "vy", label: "Starting Y Velocity" },
    ],
  };
  // Output-only: bounces are accumulated over a run (PhysicsEngine.step's contactFlags).
  var OUTPUT_PROPERTIES = [
    { key: "x", label: "Center X" },
    { key: "y", label: "Center Y" },
    { key: "angle", label: "Rotation" },
    { key: "bounces", label: "Bounce Count" },
  ];
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
    // On: no "down"; every body attracts every other (PhysicsEngine.computeAccelerations).
    mutualGravity: false,
    // Off: no pair contact at all. Toggling Mutual Gravity resets this to a default.
    collisionsEnabled: true,
    simulationSteps: DEFAULT_SIMULATION_STEPS,
    bodies: [],
    hinges: [],
    springs: [],
    xInput: null,
    yInput: null,
    output: null,
    // Wrap edges. Synced to the canvas while editing, frozen once Play/Send locks a run.
    frameWidth: 0,
    frameHeight: 0,
    // Stop-at-edge vs wrap: serialized with the scene, since it changes how Output reads.
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
  var deleteZoneArmed = false;
  // A drag on a hinge dot moves nothing; it only carries the hinge to the delete zone.
  var hingeDrag = null; // { hingeIndex, current: {x,y} }
  var selectedSpring = -1;
  var springDraw = null; // { start: <spring end>, current: {x,y} }
  var springDrag = null; // { springIndex, current: {x,y} }
  var drawingShape = null; // { tool: "circle" | "line", start: {x,y}, current: {x,y} }
  var velocityDrag = null; // Set Velocity tool, mid-drag: { bodyIndex, start: {x,y}, current: {x,y} }
  // Only bodyIndex: handle geometry is recomputed every move, since a hinge-preserving
  // resize can move body.x/y mid-drag.
  var resizeHandleDrag = null; // { bodyIndex }
  // angleOffset (cursor angle minus body angle at mousedown) stops the body snapping on grab.
  var rotationHandleDrag = null; // { bodyIndex, angleOffset }
  // Shorter drags count as a click and place the default-size shape.
  var CLICK_DRAG_THRESHOLD = 6;
  var DEFAULT_CIRCLE_RADIUS = 30;
  var DEFAULT_LINE_LENGTH = 140;
  var DEFAULT_FUNNEL_SIZE = 120;
  // Bounds the on-canvas resize handle's drag to a sane range.
  var RADIUS_MIN = 5, RADIUS_MAX = 300;
  var LENGTH_MIN = 10, LENGTH_MAX = 800;
  var rafId = null;
  var dpr = 1;
  // 1 while editing; while playing, how much the locked frame is scaled to fit canvasArea.
  var displayScale = 1;

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  function canvasPoint(e) {
    var rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  // ---- Rendering ----

  // Ruled from the origin (frame center: see physics-coords.js), not the corner;
  // every line the same weight on purpose.
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

  // Playback-only display floor; physics keeps the real radius (the grid preview does the same).
  var MIN_PLAYBACK_DISPLAY_RADIUS = 15;
  function playbackDisplayRadius(radius) {
    return isPlaying ? Math.max(radius, MIN_PLAYBACK_DISPLAY_RADIUS) : radius;
  }

  // Trapezoid corners in path order (mouthLeft, throatLeft, throatRight, mouthRight).
  var FUNNEL_MOUTH_COLOR = "#2dd4bf"; // teal: the funnel's teleporting long side
  var SPLITTER_SHORT_COLOR = "#f0883e"; // amber: the splitter's splitting short side
  function funnelPathVertices(x, y, angle, size) {
    var v = PhysicsEngine.getFunnelVertices({ x: x, y: y, angle: angle, size: size });
    return [v.mouthLeft, v.throatLeft, v.throatRight, v.mouthRight];
  }

  // The special (non-wall) edge: funnel = long mouth (3->0), splitter = short throat (1->2).
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

  // Shared by preview and placement. A drag under CLICK_DRAG_THRESHOLD places the default size.
  function computeShapeParams(shape, endPoint) {
    var start = shape.start;
    var dx = endPoint.x - start.x, dy = endPoint.y - start.y;
    var dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < CLICK_DRAG_THRESHOLD) {
      if (shape.tool === "circle") return { x: start.x, y: start.y, radius: DEFAULT_CIRCLE_RADIUS, angle: 0, length: 0, size: 0 };
      if (shape.tool === "funnel" || shape.tool === "splitter") return { x: start.x, y: start.y, radius: 0, angle: 0, length: 0, size: DEFAULT_FUNNEL_SIZE };
      return { x: start.x, y: start.y, radius: 0, angle: 0, length: DEFAULT_LINE_LENGTH, size: 0 };
    }
    if (shape.tool === "circle") return { x: start.x, y: start.y, radius: dist, angle: 0, length: 0, size: 0 };
    if (shape.tool === "funnel" || shape.tool === "splitter") return { x: start.x, y: start.y, radius: 0, angle: 0, length: 0, size: dist };
    return { x: (start.x + endPoint.x) / 2, y: (start.y + endPoint.y) / 2, radius: 0, angle: Math.atan2(dy, dx), length: dist, size: 0 };
  }

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
  // Starting speed per pixel of drag; at 1 the engine's speed cap is beyond a canvas-wide drag.
  var VELOCITY_DRAG_SCALE = 1;
  var VELOCITY_ARROW_COLOR = "#e06bff";
  var VELOCITY_ARROW_MIN_SPEED = 1;

  function velocityFromDrag(drag) {
    var vx = (drag.current.x - drag.start.x) * VELOCITY_DRAG_SCALE;
    var vy = (drag.current.y - drag.start.y) * VELOCITY_DRAG_SCALE;
    // Clamp as the engine does on its first step, so the arrow shows the real start speed.
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

  // Editing only: during playback the motion shows the velocity itself.
  function drawVelocityArrows() {
    if (isPlaying) return;
    for (var i = 0; i < scene.bodies.length; i++) {
      var body = scene.bodies[i];
      if (body.isAnchored) continue;
      if (velocityDrag && velocityDrag.bodyIndex === i) continue;
      drawVelocityArrow(body.x, body.y, body.vx, body.vy, false);
    }
    if (velocityDrag) {
      var dragged = scene.bodies[velocityDrag.bodyIndex];
      var v = velocityFromDrag(velocityDrag);
      drawVelocityArrow(dragged.x, dragged.y, v.vx, v.vy, true);
    }
  }

  var HINGE_RADIUS = 6;
  var HINGE_HIT_PAD = 4; // a 6px dot is a small thing to land a mouse on

  function drawHinge(hinge, grabbed) {
    var p = PhysicsEngine.getHingeWorldPoint(hinge, scene.bodies);
    ctx.beginPath();
    ctx.arc(p.x, p.y, HINGE_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = "#ffcf4d";
    ctx.fill();
    ctx.strokeStyle = "#8a6d1a";
    ctx.lineWidth = 2;
    ctx.stroke();
    if (grabbed) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, HINGE_RADIUS + 5, 0, Math.PI * 2);
      ctx.strokeStyle = "#ffcf4d";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  function drawHingeDragGhost(drag) {
    var hinge = scene.hinges[drag.hingeIndex];
    if (!hinge) return;
    var p = PhysicsEngine.getHingeWorldPoint(hinge, scene.bodies);
    ctx.save();
    ctx.globalAlpha = 0.6;
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = "#ffcf4d";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(drag.current.x, drag.current.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(drag.current.x, drag.current.y, HINGE_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = "#ffcf4d";
    ctx.fill();
    ctx.strokeStyle = "#8a6d1a";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  function drawSpringPreview(draw) {
    var end = pickSpringEnd(draw.current.x, draw.current.y);
    var dx = end.world.x - draw.start.world.x, dy = end.world.y - draw.start.world.y;
    drawSpringShape(draw.start.world, end.world, PhysicsEngine.SPRING_STIFFNESS_MIN, Math.sqrt(dx * dx + dy * dy), false, 0.7);
  }

  function drawSpringDragGhost(drag) {
    var spring = scene.springs[drag.springIndex];
    if (!spring) return;
    var p = PhysicsEngine.getSpringWorldPoints(spring, scene.bodies);
    var mx = (p.a.x + p.b.x) / 2, my = (p.a.y + p.b.y) / 2;
    ctx.save();
    ctx.globalAlpha = 0.6;
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = SPRING_SELECTED_COLOR;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(mx, my);
    ctx.lineTo(drag.current.x, drag.current.y);
    ctx.stroke();
    ctx.restore();
    var half = { x: (p.b.x - p.a.x) / 2, y: (p.b.y - p.a.y) / 2 };
    var scale = Math.min(1, 30 / Math.max(1, Math.sqrt(half.x * half.x + half.y * half.y)));
    drawSpringShape(
      { x: drag.current.x - half.x * scale, y: drag.current.y - half.y * scale },
      { x: drag.current.x + half.x * scale, y: drag.current.y + half.y * scale },
      spring.stiffness, 60, false, 0.6);
  }

  // Hinge dot under this point, or -1; last-drawn first. Half the bodies' touch slop: a hinge sits on a body.
  function hitTestHinge(px, py) {
    var r = HINGE_RADIUS + HINGE_HIT_PAD + pointerSlop / 2;
    for (var i = scene.hinges.length - 1; i >= 0; i--) {
      var p = PhysicsEngine.getHingeWorldPoint(scene.hinges[i], scene.bodies);
      var dx = px - p.x, dy = py - p.y;
      if (dx * dx + dy * dy <= r * r) return i;
    }
    return -1;
  }

  // ---- Springs ----
  // Thickness is stiffness (log scale); coil count follows REST length, so stretch reads as open coils.
  var SPRING_COLOR = "#c8d3e6";
  var SPRING_SELECTED_COLOR = "#ffcf4d";
  var SPRING_COIL_AMPLITUDE = 8;   // half the zigzag's width
  var SPRING_COIL_PITCH = 16;      // one full zig-and-zag per this much REST length
  var SPRING_COIL_MAX_PITCH = 44;  // ...but never drawn more open than this, however far it is stretched
  var SPRING_LEAD = 10;            // the straight stub at each end
  var SPRING_WIDTH_MIN = 1.5, SPRING_WIDTH_MAX = 6;
  var SPRING_HIT_PAD = 3;
  // Within this of a body's center an end snaps to the center (no lever arm, no spin).
  var SPRING_CENTER_SNAP = 8;

  // 0 at the softest spring the slider allows, 1 at the stiffest.
  function springStiffnessT(stiffness) {
    var lo = PhysicsEngine.SPRING_STIFFNESS_MIN, hi = PhysicsEngine.SPRING_STIFFNESS_MAX;
    return clamp(Math.log(stiffness / lo) / Math.log(hi / lo), 0, 1);
  }
  function springLineWidth(stiffness) {
    return SPRING_WIDTH_MIN + (SPRING_WIDTH_MAX - SPRING_WIDTH_MIN) * springStiffnessT(stiffness);
  }

  function traceSpringPath(a, b, restLength) {
    var dx = b.x - a.x, dy = b.y - a.y;
    var len = Math.sqrt(dx * dx + dy * dy);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    if (len < 1e-6) return;
    var ux = dx / len, uy = dy / len, px = -uy, py = ux;
    var lead = Math.min(SPRING_LEAD, len * 0.2);
    var coils = clamp(Math.max(Math.round(restLength / SPRING_COIL_PITCH), Math.ceil(len / SPRING_COIL_MAX_PITCH)), 6, 40);
    var span = len - 2 * lead;
    ctx.lineTo(a.x + ux * lead, a.y + uy * lead);
    for (var k = 0; k < coils * 2; k++) {
      var along = lead + span * (k + 0.5) / (coils * 2);
      var side = (k % 2 === 0 ? 1 : -1) * SPRING_COIL_AMPLITUDE;
      ctx.lineTo(a.x + ux * along + px * side, a.y + uy * along + py * side);
    }
    ctx.lineTo(b.x - ux * lead, b.y - uy * lead);
    ctx.lineTo(b.x, b.y);
  }

  function drawSpringShape(a, b, stiffness, restLength, selected, alpha, color) {
    ctx.save();
    ctx.globalAlpha = alpha === undefined ? 1 : alpha;
    color = color || SPRING_COLOR;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    var width = springLineWidth(stiffness);
    traceSpringPath(a, b, restLength);
    if (selected) {
      ctx.lineWidth = width + 4;
      ctx.strokeStyle = SPRING_SELECTED_COLOR;
      ctx.stroke();
    }
    ctx.lineWidth = width;
    ctx.strokeStyle = color;
    ctx.stroke();
    [a, b].forEach(function (p) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(3.5, width * 0.9), 0, Math.PI * 2);
      ctx.fillStyle = selected ? SPRING_SELECTED_COLOR : color;
      ctx.fill();
    });
    ctx.restore();
  }

  // Rest-length tick across the selected spring's axis, so the slider shows slack vs taut.
  function drawSpringRestMarker(a, b, restLength) {
    var dx = b.x - a.x, dy = b.y - a.y;
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1e-6) return;
    var ux = dx / len, uy = dy / len;
    var rx = a.x + ux * restLength, ry = a.y + uy * restLength;
    ctx.save();
    ctx.strokeStyle = SPRING_SELECTED_COLOR;
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(rx, ry);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(rx + uy * 13, ry - ux * 13);
    ctx.lineTo(rx - uy * 13, ry + ux * 13);
    ctx.stroke();
    ctx.restore();
  }

  function drawSpring(spring, selected) {
    var p = PhysicsEngine.getSpringWorldPoints(spring, scene.bodies);
    drawSpringShape(p.a, p.b, spring.stiffness, spring.restLength, selected);
    if (selected && !isPlaying) drawSpringRestMarker(p.a, p.b, spring.restLength);
  }

  // Spring under this point, or -1: distance to the chord out to the zigzag's half-width; half touch slop.
  function hitTestSpring(px, py) {
    var reach = SPRING_COIL_AMPLITUDE + SPRING_HIT_PAD + pointerSlop / 2;
    for (var i = scene.springs.length - 1; i >= 0; i--) {
      var p = PhysicsEngine.getSpringWorldPoints(scene.springs[i], scene.bodies);
      var dx = p.b.x - p.a.x, dy = p.b.y - p.a.y;
      var lenSq = dx * dx + dy * dy;
      var t = lenSq > 0 ? clamp(((px - p.a.x) * dx + (py - p.a.y) * dy) / lenSq, 0, 1) : 0;
      var cx = p.a.x + dx * t - px, cy = p.a.y + dy * t - py;
      if (cx * cx + cy * cy <= reach * reach) return i;
    }
    return -1;
  }

  // What a Spring-tool press/release landed on: a body (local point, snapped to center when close) or the background.
  function pickSpringEnd(x, y) {
    var hit = hitTestTopmost(x, y);
    if (hit < 0) return { body: null, local: { x: x, y: y }, world: { x: x, y: y } };
    var body = scene.bodies[hit];
    var snap = SPRING_CENTER_SNAP + pointerSlop / 2;
    var ox = x - body.x, oy = y - body.y;
    if (ox * ox + oy * oy <= snap * snap) return { body: hit, local: { x: 0, y: 0 }, world: { x: body.x, y: body.y } };
    var local = PhysicsEngine.worldToLocal(ox, oy, body.angle);
    return { body: hit, local: { x: local.x, y: local.y }, world: { x: x, y: y } };
  }

  // A new spring starts relaxed, stiff enough to bob its load at about NEW_SPRING_HZ:
  // stable is SPRING_STABILITY / (w * dt^2), so k = stable * (2*pi*f*dt)^2 / STABILITY.
  var NEW_SPRING_HZ = 1;
  function defaultSpringStiffness(spring) {
    var stable = PhysicsEngine.springStableStiffness(spring, scene.bodies, PhysicsGPU.FIXED_DT);
    var wdt = 2 * Math.PI * NEW_SPRING_HZ * PhysicsGPU.FIXED_DT;
    var k = isFinite(stable) ? stable * wdt * wdt / PhysicsEngine.SPRING_STABILITY : PhysicsEngine.SPRING_STIFFNESS_MIN;
    // Two significant figures: this is a starting point, not a measurement.
    var mag = Math.pow(10, Math.floor(Math.log10(k)) - 1);
    return clamp(Math.round(k / mag) * mag, PhysicsEngine.SPRING_STIFFNESS_MIN, PhysicsEngine.SPRING_STIFFNESS_MAX);
  }

  function finalizeSpringDrawing(draw, endPoint) {
    var start = draw.start, end = pickSpringEnd(endPoint.x, endPoint.y);
    var dx = end.world.x - start.world.x, dy = end.world.y - start.world.y;
    var length = Math.sqrt(dx * dx + dy * dy);
    if (length < CLICK_DRAG_THRESHOLD) {
      flashStatus("Drag from one object to another, or to the background");
      return;
    }
    if (start.body === null && end.body === null) {
      flashStatus("A spring needs an object on at least one end");
      return;
    }
    if (start.body === end.body) {
      flashStatus("A spring joins two different things");
      return;
    }
    function canMove(e) { return e.body !== null && !scene.bodies[e.body].isAnchored; }
    if (!canMove(start) && !canMove(end)) {
      flashStatus("Neither end of that spring can move");
      return;
    }
    // bodyB is always a body; a background end is always A (hinge convention, what PhysicsEngine reads).
    var a = start, b = end;
    if (b.body === null) { a = end; b = start; }
    var spring = {
      bodyA: a.body, bodyB: b.body,
      localAnchorA: { x: a.local.x, y: a.local.y },
      localAnchorB: { x: b.local.x, y: b.local.y },
      stiffness: PhysicsEngine.SPRING_STIFFNESS_MIN,
      restLength: Math.min(PhysicsEngine.SPRING_REST_LENGTH_MAX, Math.round(length)),
    };
    spring.stiffness = defaultSpringStiffness(spring);
    scene.springs.push(spring);
    selectSpring(scene.springs.length - 1);
  }

  // ---- Radius/Length/Size drag handle ----
  // Gap from shape edge to handle center, per shape: a line's end reads closer than a curved edge.
  var RESIZE_HANDLE_GAP_CIRCLE = 32;
  var RESIZE_HANDLE_GAP_LINE = 52;
  var RESIZE_HANDLE_GAP_FUNNEL = 32;
  var RESIZE_HANDLE_LENGTH = 34; // capsule long axis
  var RESIZE_HANDLE_WIDTH = 16; // capsule short axis
  var RESIZE_HANDLE_HIT_PAD = 6; // grabbable area extends this far past the visual capsule
  var SIZE_MIN = 10, SIZE_MAX = 400;

  function resizeHandleSupported(body) {
    return !!body && (body.type === "circle" || body.type === "line" || isTrapezoidType(body.type));
  }

  // Pivot for resize/rotate (what applyBodyEditPreservingHinge keeps fixed): hinge world point if any, else center.
  function handlePivot(bodyIndex) {
    var body = scene.bodies[bodyIndex];
    var ownHinge = PhysicsHingeGeometry.findOwnHinge(scene, bodyIndex);
    return ownHinge ? PhysicsHingeGeometry.hingeWorldPointA(scene, ownHinge) : { x: body.x, y: body.y };
  }

  // Shared by drawing, hit-testing and the drag. refX/refY stays fixed (handlePivot); dirX/dirY points out along it.
  function resizeHandleGeometry(bodyIndex) {
    var body = scene.bodies[bodyIndex];
    if (!resizeHandleSupported(body)) return null;
    var ownHinge = PhysicsHingeGeometry.findOwnHinge(scene, bodyIndex);

    if (body.type === "circle" || isTrapezoidType(body.type)) {
      var ref = handlePivot(bodyIndex);
      // Fixed 45 degrees up-right (screen space): halfExtent's trapezoid reach is the max over all directions.
      var dirX = Math.SQRT1_2, dirY = -Math.SQRT1_2;
      var gap = body.type === "circle" ? RESIZE_HANDLE_GAP_CIRCLE : RESIZE_HANDLE_GAP_FUNNEL;
      var dist = PhysicsEngine.halfExtent(body) + gap;
      return { refX: ref.x, refY: ref.y, dirX: dirX, dirY: dirY, x: ref.x + dirX * dist, y: ref.y + dirY * dist };
    }

    // Line: inline with the line; a hinge only picks which end, so the handle avoids the dot.
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

  function hitTestResizeHandle(bodyIndex, px, py) {
    var geo = resizeHandleGeometry(bodyIndex);
    if (!geo) return false;
    var dx = px - geo.x, dy = py - geo.y;
    var localX = dx * geo.dirX + dy * geo.dirY;
    var localY = -dx * geo.dirY + dy * geo.dirX;
    var halfLen = RESIZE_HANDLE_LENGTH / 2 + RESIZE_HANDLE_HIT_PAD + pointerSlop;
    var halfWid = RESIZE_HANDLE_WIDTH / 2 + RESIZE_HANDLE_HIT_PAD + pointerSlop;
    return Math.abs(localX) <= halfLen && Math.abs(localY) <= halfWid;
  }

  // Projects the cursor onto the handle axis (no drift), via applyBodyEditPreservingHinge like every resize.
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

  // ---- Rotation drag handle (line and funnel/splitter; a circle has no angle) ----
  // Same ray as the resize handle, farther out, turned 90 degrees: it drags along an arc around the pivot.
  var ROTATION_HANDLE_GAP = 14; // beyond the resize handle's own far edge
  // Cosmetic only: a true-scale arc over ~30px would look straight.
  var ROTATION_ARC_RADIUS = 22;
  var ROTATION_ARC_HALF_ANGLE = 0.7; // radians; sets the arc's chord to ~match the resize handle's own arrow span

  function rotationHandleSupported(body) {
    return !!body && (body.type === "line" || isTrapezoidType(body.type));
  }

  // Reuses resizeHandleGeometry's ref point and end; dirX/dirY here is the TANGENT (dir rotated a quarter turn).
  function rotationHandleGeometry(bodyIndex) {
    var body = scene.bodies[bodyIndex];
    if (!rotationHandleSupported(body)) return null;
    var resizeGeo = resizeHandleGeometry(bodyIndex);
    if (!resizeGeo) return null;

    var resizeDist = Math.hypot(resizeGeo.x - resizeGeo.refX, resizeGeo.y - resizeGeo.refY);
    var dist = resizeDist + RESIZE_HANDLE_LENGTH / 2 + ROTATION_HANDLE_GAP + RESIZE_HANDLE_LENGTH / 2;
    var tanX = -resizeGeo.dirY, tanY = resizeGeo.dirX;
    return {
      refX: resizeGeo.refX, refY: resizeGeo.refY,
      dirX: resizeGeo.dirX, dirY: resizeGeo.dirY, // still "outward", which side the arc bulges away from
      tanX: tanX, tanY: tanY,
      x: resizeGeo.refX + resizeGeo.dirX * dist, y: resizeGeo.refY + resizeGeo.dirY * dist,
    };
  }

  function drawRotationHandle(bodyIndex) {
    var geo = rotationHandleGeometry(bodyIndex);
    if (!geo) return;
    var halfLen = RESIZE_HANDLE_LENGTH / 2, halfWid = RESIZE_HANDLE_WIDTH / 2;

    ctx.save();
    ctx.translate(geo.x, geo.y);
    ctx.rotate(Math.atan2(geo.tanY, geo.tanX));

    drawHandleCapsuleBase(halfLen, halfWid);

    // Arc center sits toward the pivot (+Y); dropping it half a sagitta centers the curve on the capsule.
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

  function hitTestRotationHandle(bodyIndex, px, py) {
    var geo = rotationHandleGeometry(bodyIndex);
    if (!geo) return false;
    var dx = px - geo.x, dy = py - geo.y;
    var localX = dx * geo.tanX + dy * geo.tanY;
    var localY = -dx * geo.tanY + dy * geo.tanX;
    var halfLen = RESIZE_HANDLE_LENGTH / 2 + RESIZE_HANDLE_HIT_PAD + pointerSlop;
    var halfWid = RESIZE_HANDLE_WIDTH / 2 + RESIZE_HANDLE_HIT_PAD + pointerSlop;
    return Math.abs(localX) <= halfLen && Math.abs(localY) <= halfWid;
  }

  // Absolute: angle = cursor angle around the pivot minus the mousedown offset (rotationHandleDrag).
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
  // Only for a body that is both anchored and selected; toggles the same isAnchored flag as the Anchor tool.
  var ANCHOR_ICON_RADIUS = 12;
  var ANCHOR_ICON_GAP = 14; // beyond the farthest existing handle's own edge
  var ANCHOR_ICON_HIT_PAD = 4;

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
    // The glyph's bitmap sits a couple px left of center (emoji-font quirk): nudged right.
    ctx.fillText("⚓", geo.x + 2, geo.y + 1);
    ctx.restore();
  }

  function hitTestAnchorIcon(bodyIndex, px, py) {
    var geo = anchorIconGeometry(bodyIndex);
    if (!geo) return false;
    var dx = px - geo.x, dy = py - geo.y;
    var r = ANCHOR_ICON_RADIUS + ANCHOR_ICON_HIT_PAD + pointerSlop;
    return dx * dx + dy * dy <= r * r;
  }

  // ---- Drag-to-delete zone ----
  // Shown during a plain body drag or a hinge/spring drag, fixed at the frame's top center.
  var DELETE_ZONE_RADIUS = 20;
  var DELETE_ZONE_TOP_MARGIN = 44; // distance from the frame's own top edge to the zone's center, with nothing in the way
  var DELETE_ZONE_ARMED_SCALE = 1.3; // drawn this much bigger once the dragged body actually overlaps it
  var DELETE_ZONE_TOOLBAR_GAP = 14; // clear air between the transport's bottom edge and the zone's

  // Below the playback transport, measured since its height varies (step readout, speed label).
  // Frame units = CSS px from the canvas's top-left while editing, same as canvasPoint.
  function deleteZoneTop() {
    var y = DELETE_ZONE_TOP_MARGIN;
    if (playbackToolbar) {
      var bar = playbackToolbar.getBoundingClientRect();
      if (bar.height > 0) {
        y = Math.max(y, bar.bottom - canvas.getBoundingClientRect().top +
          DELETE_ZONE_TOOLBAR_GAP + DELETE_ZONE_RADIUS * DELETE_ZONE_ARMED_SCALE);
      }
    }
    // On a frame too short for both, keep the zone reachable inside it.
    var armed = DELETE_ZONE_RADIUS * DELETE_ZONE_ARMED_SCALE;
    return Math.min(y, Math.max(armed, (scene.frameHeight || 0) - armed));
  }

  function deleteZoneCenter() {
    return { x: (scene.frameWidth || 0) / 2, y: deleteZoneTop() };
  }

  // Tested against the cursor (the grab point), not the body's extent: a long body would arm it too easily.
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

  // Fraction of the frame's shorter side (the grid's replay canvas is smaller):
  // see PhysicsHingeGeometry.offscreenPointer.
  var OFFSCREEN_ARROW_MAX_FRACTION = 0.12;
  function offscreenArrowMaxLength() {
    return OFFSCREEN_ARROW_MAX_FRACTION * Math.min(scene.frameWidth || 0, scene.frameHeight || 0);
  }

  // Tip on the frame edge pointing at an off-screen body; tail grows with distance.
  function drawOffscreenArrow(pointer, color) {
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

    // One pointer per off-frame body, however many of X, Y and Output it carries.
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

  function saveEditorAutosave() {
    var authored = PhysicsCoords.toAuthoredJSON(serializeScene());
    // A linked scene is not saved until edited (a link must not overwrite this browser's scene); frame excluded.
    if (sharedSceneIdentity !== null) {
      var identity = sceneIdentity(authored);
      if (sharedSceneIdentity === true) sharedSceneIdentity = identity;
      if (identity === sharedSceneIdentity) return;
      sharedSceneIdentity = null;
    }
    try {
      localStorage.setItem(EDITOR_STORAGE_KEY, JSON.stringify(authored));
    } catch (err) {
      // Full/unavailable storage must not break editing.
    }
  }

  function render() {
    // Settle bodies pushed outside the frame before drawing; skipped while playing (the GPU owns them).
    if (!isPlaying) {
      PhysicsHingeGeometry.normalizeAllBodiesIntoFrame(scene);
    }

    // Drawing works in frame space; this transform is the only place it meets canvas pixels.
    var w = scene.frameWidth || canvasArea.clientWidth || 1;
    var h = scene.frameHeight || canvasArea.clientHeight || 1;
    var renderScale = displayScale * dpr;
    ctx.setTransform(renderScale, 0, 0, renderScale, 0, 0);
    ctx.clearRect(0, 0, w, h);
    drawGrid(w, h);
    drawOutputKeyBorder(w, h);
    drawOutputKeyRing();
    updateOutputKeyControls();
    for (var i = 0; i < scene.bodies.length; i++) drawBody(scene.bodies[i], i === selectedIndex);
    for (var sp = 0; sp < scene.springs.length; sp++) drawSpring(scene.springs[sp], sp === selectedSpring);
    for (var j = 0; j < scene.hinges.length; j++) drawHinge(scene.hinges[j], !!hingeDrag && hingeDrag.hingeIndex === j);
    drawOutputKeyBodyDot(w, h);
    drawVelocityArrows();
    drawMappingBadges();
    if (!isPlaying && selectedIndex >= 0) {
      drawResizeHandle(selectedIndex);
      drawRotationHandle(selectedIndex); // no-op for anything but a line
      drawAnchorIcon(selectedIndex); // no-op unless this body is anchored
    }
    if ((dragging && selectedIndex >= 0) || hingeDrag || springDrag) drawDeleteZone(deleteZoneArmed);
    if (hingeDrag) drawHingeDragGhost(hingeDrag);
    if (springDrag) drawSpringDragGhost(springDrag);
    if (drawingShape) drawShapePreview(drawingShape);
    if (springDraw) drawSpringPreview(springDraw);
    refreshSpringPanel();
    // Auto-save piggybacks on render(); skipped during playback so a mid-run frame is never saved.
    if (!isPlaying) {
      saveEditorAutosave();
      recordUndoState(); // same piggyback, same reason: see "Undo / redo" below
    }
  }

  // isPlaying gates the frame sync (Play/Send-to-Grid lock it). Also gated on a nonzero
  // size: this page shares a document with the grid view, and display:none reports 0x0.
  function resizeCanvas() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (!isPlaying && canvasArea.clientWidth > 0 && canvasArea.clientHeight > 0) {
      // Origin is the frame center (physics-coords.js): shift the scene so it holds still relative to the middle.
      var prevW = scene.frameWidth, prevH = scene.frameHeight;
      scene.frameWidth = canvasArea.clientWidth;
      scene.frameHeight = canvasArea.clientHeight;
      translateWholeScene(
        (scene.frameWidth - prevW) / 2,
        (scene.frameHeight - prevH) / 2);
    }
    var fw = scene.frameWidth || canvasArea.clientWidth || 1;
    var fh = scene.frameHeight || canvasArea.clientHeight || 1;
    // "Contain" fit: preserves the locked frame's aspect ratio; 1 while editing.
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
  window.addEventListener("resize", resizeCanvas);

  // Some controls (gravity slider, Stop-on-wrap) don't render(): flush on pagehide/hidden so a last edit is kept.
  function flushEditorAutosaveOnHide() {
    if (!isPlaying) saveEditorAutosave();
  }
  window.addEventListener("pagehide", flushEditorAutosaveOnHide);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") flushEditorAutosaveOnHide();
  });

  // ---- Hit testing (topmost first = end of array first, matching paint order) ----

  // Extra reach past a shape's edge for a press: 0 for a mouse, more for a fingertip.
  // Set per press from the pointer type.
  var TOUCH_HIT_SLOP = 14;
  var pointerSlop = 0;
  var HIT_RING = [[1, 0], [0.7071, 0.7071], [0, 1], [-0.7071, 0.7071], [-1, 0], [-0.7071, -0.7071], [0, -1], [0.7071, -0.7071]];

  function hitTestExact(px, py) {
    for (var i = scene.bodies.length - 1; i >= 0; i--) {
      if (PhysicsEngine.pointInBody(scene.bodies[i], px, py)) return i;
    }
    return -1;
  }

  function hitTestTopmost(px, py) {
    var hit = hitTestExact(px, py);
    if (hit >= 0 || pointerSlop <= 0) return hit;
    // Nothing exactly under the point: nearest within the slop, probed on rings at half and full slop.
    for (var ring = 1; ring <= 2; ring++) {
      var r = pointerSlop * ring / 2;
      for (var k = 0; k < HIT_RING.length; k++) {
        hit = hitTestExact(px + HIT_RING[k][0] * r, py + HIT_RING[k][1] * r);
        if (hit >= 0) return hit;
      }
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
    if (tool === "select") hideToolHint();
  }

  // A tool picked by touch shows its button's title in a toast (#editor-hint-toast), "click" read as "tap".
  // Pointer type is noted at the window in the capture phase, before the click reaches a button.
  var toolHintEl = document.getElementById("editor-hint-toast");
  var toolHintTimer = null;
  var TOOL_HINT_VISIBLE_MS = 6000;
  var lastPointerType = "mouse";
  window.addEventListener("pointerdown", function (e) { lastPointerType = e.pointerType || "mouse"; }, true);

  function hideToolHint() {
    if (toolHintTimer) { clearTimeout(toolHintTimer); toolHintTimer = null; }
    if (toolHintEl) toolHintEl.classList.remove("visible");
  }
  function showToolHint(text) {
    if (!toolHintEl || !text) return;
    hideToolHint();
    toolHintEl.textContent = text.replace(/\bClick\b/g, "Tap").replace(/\bclick\b/g, "tap");
    toolHintEl.classList.add("visible");
    toolHintTimer = setTimeout(hideToolHint, TOOL_HINT_VISIBLE_MS);
  }

  toolButtons.forEach(function (btn) {
    btn.addEventListener("click", function () {
      setActiveTool(btn.getAttribute("data-tool"));
      if (lastPointerType === "touch") showToolHint(btn.getAttribute("title"));
    });
  });

  // No Select button: any panel click that isn't a tool button backs out of the tool (canvas clicks excluded).
  panelEl.addEventListener("click", function (e) {
    if (e.target.closest("[data-tool]")) return;
    setActiveTool("select");
  });

  window.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if (!modalBackdrop.hidden) { closeModal(); return; }
    if (drawingShape) { drawingShape = null; render(); } // cancel the in-progress drag instead of still placing it on the eventual mouseup
    if (velocityDrag) { velocityDrag = null; render(); } // same, for a velocity aim in progress: leave the body's existing velocity alone
    if (hingeDrag) { hingeDrag = null; deleteZoneArmed = false; canvas.classList.remove("dragging"); render(); } // same, for a hinge on its way to the delete zone: it stays
    if (springDrag) { springDrag = null; deleteZoneArmed = false; canvas.classList.remove("dragging"); render(); } // and for a spring on its way there
    if (springDraw) { springDraw = null; render(); } // and for a spring half drawn: nothing is placed
    setActiveTool("select");
  });

  // ---- Settings panel (gear button, upper right) ----
  btnSettings.addEventListener("click", function () {
    settingsPanel.classList.toggle("open");
  });
  btnSettingsClose.addEventListener("click", function () {
    settingsPanel.classList.remove("open");
  });

  // ---- The top bar (small-window layout only) ----
  // On a phone-sized window (LayoutMode.isMobile) the back chevron, transport and settings button
  // are MOVED into #editor-topbar (listeners and ids stay put) and moved back when wide again.
  var editorTopbar = document.getElementById("editor-topbar");
  var topbarHomes = null; // where each element lives in the desktop layout
  function setTopbarActive(active) {
    if (!editorTopbar || !playbackToolbar) return;
    if (active === !!topbarHomes) return;
    if (active) {
      var btnHome = document.getElementById("btn-home");
      topbarHomes = [btnHome, playbackToolbar, btnSettings].filter(Boolean).map(function (el) {
        return { el: el, parent: el.parentNode, next: el.nextSibling };
      });
      if (btnHome) editorTopbar.appendChild(btnHome);
      editorTopbar.appendChild(playbackToolbar);
      editorTopbar.appendChild(btnSettings);
    } else {
      topbarHomes.forEach(function (home) { home.parent.insertBefore(home.el, home.next); });
      topbarHomes = null;
    }
    closeSpeedPopup(); // it was placed against a button that has just moved
  }
  if (window.LayoutMode) {
    window.LayoutMode.onChange(function (mode) { setTopbarActive(mode.isMobile()); });
    setTopbarActive(window.LayoutMode.isMobile());
  }
  // ---- Sound volume (mute button + settings slider) ----
  // PhysicsSound's volume is shared with the grid's controls; onVolumeChange keeps
  // every mute button and slider in sync.
  function setVolumeIconState(container, volume) {
    var muted = volume <= 0;
    // Explicit "inline"/"none": .vol-mute-x's stylesheet default is display:none, so "" would hide it.
    container.querySelector(".vol-arc-1").style.display = muted ? "none" : "inline";
    container.querySelector(".vol-arc-2").style.display = (muted || volume <= 0.5) ? "none" : "inline";
    container.querySelector(".vol-mute-x").style.display = muted ? "inline" : "none";
  }
  function updateVolumeUI(volume) {
    setVolumeIconState(btnMute, volume);
    var label = volume <= 0 ? "Unmute" : "Mute";
    btnMute.title = label;
    btnMute.setAttribute("aria-label", label);
  }
  btnMute.addEventListener("click", function () { PhysicsSound.toggleMute(); });
  PhysicsSound.onVolumeChange(updateVolumeUI);
  updateVolumeUI(PhysicsSound.getVolume());

  var flashTimer = null;
  function flashStatus(message, holdMs) {
    if (flashTimer) clearTimeout(flashTimer);
    var prevText = statusEl.textContent, prevClass = statusEl.className;
    statusEl.textContent = message;
    statusEl.className = "status-error";
    flashTimer = setTimeout(function () {
      statusEl.textContent = prevText;
      statusEl.className = prevClass;
      flashTimer = null;
    }, holdMs || 1600);
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

    // One hinge per pair (a second would over-constrain the solver);
    // hingeConnects treats bodyA === null as the background.
    if (PhysicsEngine.hingeConnects(scene.hinges, behindIndex, frontIndex)) {
      flashStatus(behindIndex === null ? "Already hinged to the background" : "These two objects are already hinged together");
      return;
    }
    // Hinging to an anchored object would be a second way to pin to the background: disallowed.
    if (behindIndex !== null && (scene.bodies[behindIndex].isAnchored || scene.bodies[frontIndex].isAnchored)) {
      flashStatus("Can't hinge to an anchored object: hinge to the background instead");
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

  // Pure scene math lives in physics-hinge-geometry.js, shared with the grid's preview and the tests.
  var translateBodyPreservingHinges = PhysicsHingeGeometry.translateBodyPreservingHinges;
  var applyBodyEditPreservingHinge = PhysicsHingeGeometry.applyBodyEditPreservingHinge;

  // ---- Selection ----

  function selectBody(index) {
    selectedIndex = index;
    selectedSpring = -1;
    render();
  }

  // One thing selected at a time: see selectedSpring.
  function selectSpring(index) {
    selectedSpring = index;
    selectedIndex = -1;
    render();
  }

  // ---- The Spring section of the panel ----
  // Stiffness slider is a LOG scale: stiffness spans three decades, and "a bit stiffer" is a ratio.
  function springSliderToStiffness(v) {
    var lo = PhysicsEngine.SPRING_STIFFNESS_MIN, hi = PhysicsEngine.SPRING_STIFFNESS_MAX;
    var k = lo * Math.pow(hi / lo, clamp(v / Number(springStiffnessSlider.max), 0, 1));
    // Three significant figures: the number goes into a scene file a person may read.
    var mag = Math.pow(10, Math.floor(Math.log10(k)) - 2);
    return clamp(Math.round(k / mag) * mag, lo, hi);
  }
  function stiffnessToSpringSlider(k) {
    return Math.round(springStiffnessT(k) * Number(springStiffnessSlider.max));
  }

  // Called from render(); writes to the DOM only on a difference, so it never fights a slider being dragged.
  function refreshSpringPanel() {
    var spring = !isPlaying && selectedSpring >= 0 ? scene.springs[selectedSpring] : null;
    if (springSection.hidden !== !spring) {
      springSection.hidden = !spring;
      if (spring && springSection.scrollIntoView) springSection.scrollIntoView({ block: "nearest" });
    }
    if (!spring) return;
    function setValue(el, v) { if (el.value !== String(v)) el.value = String(v); }
    function setText(el, t) { if (el.textContent !== t) el.textContent = t; }
    // Only when the slider does not already mean this stiffness: writing the nearest stop back could nudge the thumb.
    if (springSliderToStiffness(Number(springStiffnessSlider.value)) !== spring.stiffness) {
      setValue(springStiffnessSlider, stiffnessToSpringSlider(spring.stiffness));
    }
    setText(springStiffnessReadout, Math.round(spring.stiffness).toLocaleString());
    setValue(springRestSlider, Math.round(spring.restLength));
    setText(springRestReadout, Math.round(spring.restLength) + " px");
    // The engine caps stiffness by what the ends can take (SPRING_STABILITY): say so.
    var stable = PhysicsEngine.springStableStiffness(spring, scene.bodies, PhysicsGPU.FIXED_DT);
    setText(springStiffnessNote, spring.stiffness > stable
      ? "What it is tied to is light enough that the simulation limits this to " + Math.round(stable).toLocaleString() + "."
      : "");
  }

  springRestSlider.max = String(PhysicsEngine.SPRING_REST_LENGTH_MAX);
  springStiffnessSlider.addEventListener("input", function () {
    if (selectedSpring < 0) return;
    scene.springs[selectedSpring].stiffness = springSliderToStiffness(Number(springStiffnessSlider.value));
    render();
  });
  springRestSlider.addEventListener("input", function () {
    if (selectedSpring < 0) return;
    scene.springs[selectedSpring].restLength = clamp(Number(springRestSlider.value), 0, PhysicsEngine.SPRING_REST_LENGTH_MAX);
    render();
  });
  btnDeleteSpring.addEventListener("click", function () { deleteSelectedSpring(); });

  function deleteSelectedSpring() {
    if (selectedSpring < 0) return;
    scene.springs.splice(selectedSpring, 1);
    selectedSpring = -1;
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
    // A focused text field owns these keys; a focused slider (a touched Spring slider) does not.
    var focused = document.activeElement;
    if (focused && focused.tagName === "INPUT" && focused.type !== "range") return;
    if (selectedSpring >= 0) deleteSelectedSpring();
    else deleteSelectedBody();
  });

  // ---- Canvas interaction ----
  // Pointer events, not mouse events (never synthesized for a moving finger); touch-action: none is in mobile.css.
  // One pointer at a time: only a primary pointer starts a gesture and only it can move or finish it.
  // Captured, so a drag keeps arriving after a finger leaves the canvas.
  var activePointerId = null;

  canvas.addEventListener("pointerdown", function (e) {
    if (isPlaying) return;
    if (!e.isPrimary) return;
    activePointerId = e.pointerId;
    pointerSlop = e.pointerType === "touch" ? TOUCH_HIT_SLOP : 0;
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* already gone: the window listeners still see it */ }
    var p = canvasPoint(e);

    if (activeTool === "select") {
      // Before the hit-test: the handles sit OUTSIDE the selected body, so a click
      // there must not select whatever body is under them.
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
      var hingeHit = hitTestHinge(p.x, p.y);
      if (hingeHit >= 0) {
        hingeDrag = { hingeIndex: hingeHit, current: p };
        canvas.classList.add("dragging");
        render();
        return;
      }
      // A spring, unless a body is squarely under the pointer: springs end inside the bodies they join.
      var springHit = hitTestExact(p.x, p.y) >= 0 ? -1 : hitTestSpring(p.x, p.y);
      if (springHit >= 0) {
        springDrag = { springIndex: springHit, current: p };
        canvas.classList.add("dragging");
        selectSpring(springHit);
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
      // Placement happens on release (finalizeShapeDrawing); this just starts the drag.
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
    } else if (activeTool === "spring") {
      springDraw = { start: pickSpringEnd(p.x, p.y), current: p };
      render();
    } else if (activeTool === "velocity") {
      var hitV = hitTestTopmost(p.x, p.y);
      if (hitV >= 0 && scene.bodies[hitV].isAnchored) {
        // An anchored body would discard the velocity on its first step: say so.
        flashStatus("An anchored object can't be given a velocity");
        setActiveTool("select");
      } else if (hitV >= 0) {
        selectBody(hitV);
        velocityDrag = { bodyIndex: hitV, start: p, current: p };
      } else {
        setActiveTool("select"); // dragged from empty space, nothing to aim
      }
      render();
    } else if (activeTool === "input") {
      // Shortcut for the common X/Y Input: this object's Center X/Y. Still an ordinary mapping.
      var hit3 = hitTestTopmost(p.x, p.y);
      if (hit3 >= 0) {
        scene.xInput = { body: hit3, property: "x" };
        scene.yInput = { body: hit3, property: "y" };
        refreshMappingUI();
      }
      setActiveTool("select");
      render();
    } else if (activeTool === "input-velocity") {
      // Same shortcut for vx/vy. Rejects an anchored object: its velocity is never read.
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
      // Shortcut for the common Output: this object's Center Y. Anchored would be a constant.
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

  window.addEventListener("pointermove", function (e) {
    if (activePointerId !== null && e.pointerId !== activePointerId) return;
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
    if (hingeDrag) {
      hingeDrag.current = canvasPoint(e);
      deleteZoneArmed = isOverDeleteZone(hingeDrag.current.x, hingeDrag.current.y);
      render();
      return;
    }
    if (springDrag) {
      springDrag.current = canvasPoint(e);
      deleteZoneArmed = isOverDeleteZone(springDrag.current.x, springDrag.current.y);
      render();
      return;
    }
    if (springDraw) {
      springDraw.current = canvasPoint(e);
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

  // The browser took the pointer mid-gesture: drop whatever was in progress, never commit it.
  window.addEventListener("pointercancel", function (e) {
    if (e.pointerId !== activePointerId) return;
    activePointerId = null;
    rotationHandleDrag = null;
    resizeHandleDrag = null;
    velocityDrag = null;
    drawingShape = null;
    hingeDrag = null;
    springDrag = null;
    springDraw = null;
    dragging = false;
    deleteZoneArmed = false;
    canvas.classList.remove("dragging");
    render();
  });

  window.addEventListener("pointerup", function (e) {
    if (e.pointerId !== activePointerId) return;
    activePointerId = null;
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
    if (hingeDrag) {
      // Judged from where the pointer IS: a touch can lift without a final move event.
      var upPoint = canvasPoint(e);
      var droppedHinge = isOverDeleteZone(upPoint.x, upPoint.y) ? hingeDrag.hingeIndex : -1;
      hingeDrag = null;
      deleteZoneArmed = false;
      canvas.classList.remove("dragging");
      if (droppedHinge >= 0) scene.hinges.splice(droppedHinge, 1);
      render();
      return;
    }
    if (springDrag) {
      var springUp = canvasPoint(e);
      var droppedSpring = isOverDeleteZone(springUp.x, springUp.y);
      springDrag = null;
      deleteZoneArmed = false;
      canvas.classList.remove("dragging");
      if (droppedSpring) deleteSelectedSpring();
      else render();
      return;
    }
    if (springDraw) {
      var draw = springDraw;
      springDraw = null;
      finalizeSpringDrawing(draw, canvasPoint(e));
      setActiveTool("select");
      render();
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

  // ---- Undo / redo ----
  // One step each way, not a history. Snapshots are the autosave's authored JSON, recorded from
  // render() after an edit but never while a gesture or pointer press is under way (a drag renders per pixel).
  var undoPrevJSON = null;    // the step back, or null when there is none
  var undoCurrentJSON = null; // the scene as last recorded
  var redoJSON = null;        // the step forward, only ever set by undo
  var pointerHeld = false;

  function currentUndoJSON() {
    return JSON.stringify(PhysicsCoords.toAuthoredJSON(serializeScene()));
  }
  function editInProgress() {
    return pointerHeld || dragging || !!hingeDrag || !!springDrag || !!drawingShape ||
      !!springDraw || !!velocityDrag || !!rotationHandleDrag || !!resizeHandleDrag;
  }
  function recordUndoState() {
    if (editInProgress()) return;
    var json = currentUndoJSON();
    if (json === undoCurrentJSON) return;
    // Loose null test: an early ResizeObserver render can get here before these vars are assigned.
    if (undoCurrentJSON != null) {
      undoPrevJSON = undoCurrentJSON;
      redoJSON = null;
    }
    undoCurrentJSON = json;
  }
  // Capture phase so pointerHeld is set before any handler renders; the bubble pointerup records resize/rotation drags.
  window.addEventListener("pointerdown", function () { pointerHeld = true; }, true);
  window.addEventListener("pointerup", function () { pointerHeld = false; }, true);
  window.addEventListener("pointercancel", function () { pointerHeld = false; }, true);
  window.addEventListener("pointerup", function () { if (!isPlaying) recordUndoState(); });
  window.addEventListener("pointercancel", function () { if (!isPlaying) recordUndoState(); });

  // The same door a pasted scene comes in through, frame and all.
  function restoreUndoJSON(json) {
    applySceneData(parseSceneData(PhysicsCoords.toEngineJSON(JSON.parse(json), liveFrame())));
    finishSceneReplace();
    render();
  }
  function undoLastEdit() {
    if (undoPrevJSON == null) return;
    var target = undoPrevJSON;
    var before = undoCurrentJSON;
    restoreUndoJSON(target);
    // After restoreUndoJSON's render, which would otherwise count the undo as a fresh edit and clear the redo.
    undoCurrentJSON = currentUndoJSON();
    undoPrevJSON = null; // one step only
    redoJSON = before;
  }
  function redoLastEdit() {
    if (redoJSON == null) return;
    var target = redoJSON;
    var before = undoCurrentJSON;
    restoreUndoJSON(target);
    undoCurrentJSON = currentUndoJSON();
    undoPrevJSON = before; // the redo can itself be undone, once
    redoJSON = null;
  }

  var IS_APPLE = /Mac|iPhone|iPad|iPod/.test((navigator.platform || navigator.userAgent) || "");
  window.addEventListener("keydown", function (e) {
    // Cmd on Apple, Ctrl elsewhere; Ctrl-Y is the Windows/Linux redo.
    var mod = IS_APPLE ? e.metaKey : e.ctrlKey;
    if (!mod || e.altKey) return;
    var key = typeof e.key === "string" ? e.key.toLowerCase() : "";
    var isUndo = key === "z" && !e.shiftKey;
    var isRedo = (key === "z" && e.shiftKey) || (!IS_APPLE && key === "y");
    if (!isUndo && !isRedo) return;
    // Builder only, not during playback or over the Import/Export modal.
    if (editorView.hidden || isPlaying || !modalBackdrop.hidden) return;
    // A focused text field owns its own undo, unless hidden: the Export textarea keeps focus after its modal closes.
    var focused = document.activeElement;
    if (focused && focused.offsetParent === null) focused = null;
    if (focused && (focused.tagName === "TEXTAREA" || focused.isContentEditable ||
        (focused.tagName === "INPUT" && focused.type !== "range" && focused.type !== "checkbox"))) return;
    e.preventDefault();
    if (isUndo) undoLastEdit(); else redoLastEdit();
  });

  // ---- Gravity ----

  // The one place that changes edge mode (Edge Handling dropdown and Mutual Gravity's nudge).
  function applyEdgeMode(mode) {
    // Scene Lifespan only means anything under Sticky Edges.
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
    // One-time nudges, not a lock: mutual gravity behaves with Collisions off and Infinite Space; off restores the defaults.
    scene.collisionsEnabled = !scene.mutualGravity;
    collisionsCheckbox.checked = scene.collisionsEnabled;
    applyEdgeMode(scene.mutualGravity ? "infinite" : "wrap");
  });

  collisionsCheckbox.addEventListener("change", function () {
    scene.collisionsEnabled = collisionsCheckbox.checked;
    render();
  });

  function updateSimulationStepsReadout(value) {
    if (simulationStepsReadout.value !== String(value)) simulationStepsReadout.value = String(value);
  }
  // Applied on commit (Enter or blur), not per keystroke; unusable input restores the current value.
  simulationStepsReadout.addEventListener("change", function () {
    var typed = clampSimulationSteps(simulationStepsReadout.value);
    if (typed !== null) {
      scene.simulationSteps = typed;
      simulationStepsSlider.value = String(simulationStepsNotch(typed));
      if (!isPlaying) playbackProgressSlider.max = String(typed);
    }
    updateSimulationStepsReadout(scene.simulationSteps);
    render(); // sweeps it into the autosave and the address bar
  });
  simulationStepsReadout.addEventListener("keydown", function (e) {
    if (e.key === "Enter") simulationStepsReadout.blur();
  });
  simulationStepsSlider.addEventListener("input", function () {
    scene.simulationSteps = Number(simulationStepsSlider.value) * SIMULATION_STEPS_PER_NOTCH;
    updateSimulationStepsReadout(scene.simulationSteps);
    if (!isPlaying) playbackProgressSlider.max = String(scene.simulationSteps);
  });

  edgeModeSelect.addEventListener("change", function () {
    applyEdgeMode(edgeModeSelect.value);
  });

  // ---- Max Objects ----
  // How many bodies a splitter may grow the scene to; shown only when the scene has one. The grid
  // shader checks every slot against every other per pixel per step (quadratic): the biggest lever on GPU hangs.
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
    // render() (unlike the duration slider) so the value autosaves the moment it's set.
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

  // includeLifespan: only the Output dropdown offers Scene lifespan; inputs drive a body property.
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

  function refreshMappingUI() {
    populateBodySelect(xInputBodySelect, scene.xInput);
    populatePropertySelect(xInputPropertySelect, scene.xInput ? scene.xInput.body : null, scene.xInput ? scene.xInput.property : null);
    populateBodySelect(yInputBodySelect, scene.yInput);
    populatePropertySelect(yInputPropertySelect, scene.yInput ? scene.yInput.body : null, scene.yInput ? scene.yInput.property : null);
    populateBodySelect(outputBodySelect, scene.output, true);
    refreshOutputPairUI();
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
      // Lifespan only means anything under Sticky Edges: turn it on.
      if (scene.edgeMode !== "sticky") {
        scene.edgeMode = "sticky";
        edgeModeSelect.value = "sticky";
      }
      scene.output = { body: null, bodyB: null, property: "lifespan" };
    } else {
      // Keep the chosen second object unless it is now body A itself.
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
  // A pair reads the average (and unlocks Distance Apart). Only for a mapping that reads a body.
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
      if (outputBodyBSelect.value === "") scene.output.bodyB = null;
    }
    // The property list depends on whether a pair is active. Body mappings only: Scene Lifespan is
    // { body: null } and in neither list; the fallback would rewrite it to a shape the grid rejects.
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
  // Never the native `disabled` attribute: a disabled button stops firing the hover events this depends on.
  // Checked in a fixed order so the message names the single earliest blocker. One body counts once
  // something is attached to it (a lone ball on a spring). Shared with gridSceneFromShared.
  function hasSomethingToMap(s) {
    var attached = (s.springs || []).length > 0 || (s.hinges || []).length > 0;
    return s.bodies.length > 1 || (s.bodies.length === 1 && attached);
  }

  function gridReadiness() {
    if (!hasSomethingToMap(scene)) {
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

  var hintHighlighted = [];
  // Set during a click's grace period: mouseenter/mouseleave defer to it.
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
    // Playback writes animation frames into scene.bodies: reset so the fractal starts from the authored scene.
    resetToInitialScene();
    var readiness = gridReadiness();
    if (!readiness.ready) {
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
    window.AppShell.goToGrid(serializeScene());
  });

  // ---- Scene JSON: a live, editable description of the starting scene ----

  function roundNum(n) {
    return Math.round(n * 10000) / 10000;
  }

  // The frame an authored scene is loaded INTO (see PhysicsCoords.toEngineJSON); the fallback covers the very first load.
  function liveFrame() {
    return {
      frameWidth: scene.frameWidth || canvasArea.clientWidth || 0,
      frameHeight: scene.frameHeight || canvasArea.clientHeight || 0,
    };
  }

  // Moves the whole scene rigidly, world-anchored hinge/spring ends included. NOT
  // translateBodyPreservingHinges, whose job is moving one body without its neighbors.
  function translateWholeScene(dx, dy) {
    if (!dx && !dy) return;
    scene.bodies.forEach(function (b) { b.x += dx; b.y += dy; });
    scene.hinges.forEach(function (h) {
      if (h.bodyA !== null) return;
      h.localAnchorA = { x: h.localAnchorA.x + dx, y: h.localAnchorA.y + dy };
    });
    scene.springs.forEach(function (sp) {
      if (sp.bodyA !== null) return;
      sp.localAnchorA = { x: sp.localAnchorA.x + dx, y: sp.localAnchorA.y + dy };
    });
  }

  function serializeScene() {
    return serializeSceneOf(scene);
  }
  // Of any scene-shaped object (see gridSceneFromShared); the parameter deliberately shadows the live scene.
  function serializeSceneOf(scene) {
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
      springs: PhysicsEngine.sceneSprings(scene).map(function (sp) {
        return {
          bodyA: sp.bodyA,
          bodyB: sp.bodyB,
          localAnchorA: { x: roundNum(sp.localAnchorA.x), y: roundNum(sp.localAnchorA.y) },
          localAnchorB: { x: roundNum(sp.localAnchorB.x), y: roundNum(sp.localAnchorB.y) },
          stiffness: roundNum(sp.stiffness),
          restLength: roundNum(sp.restLength),
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

  // Validates any scene-shaped object into fresh bodies/hinges/mappings, or throws a message fit to show.
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
      // An anchored body's velocity would make it a moving wall in the contact solver (see computeMass).
      if (!body.isAnchored) {
        if (b.vx !== undefined) body.vx = Number(b.vx);
        if (b.vy !== undefined) body.vy = Number(b.vy);
        if (b.w !== undefined) body.w = Number(b.w);
      }
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

    // Absent from scenes saved before springs existed; stiffness/rest length are clamped, not rejected.
    var newSprings = [];
    if (Array.isArray(parsed.springs)) {
      for (var si = 0; si < parsed.springs.length; si++) {
        var sp = parsed.springs[si];
        var springA = sp.bodyA === null || sp.bodyA === undefined ? null : Number(sp.bodyA);
        var springB = Number(sp.bodyB);
        if (springA !== null && !(springA >= 0 && springA < newBodies.length)) {
          throw new Error("springs[" + si + "]: bodyA index out of range.");
        }
        if (!(springB >= 0 && springB < newBodies.length)) {
          throw new Error("springs[" + si + "]: bodyB index out of range.");
        }
        if (springA === springB) throw new Error("springs[" + si + "]: both ends are on the same object.");
        if (!sp.localAnchorA || !sp.localAnchorB) {
          throw new Error("springs[" + si + "]: needs localAnchorA and localAnchorB.");
        }
        var stiffness = Number(sp.stiffness), restLength = Number(sp.restLength);
        newSprings.push({
          bodyA: springA,
          bodyB: springB,
          localAnchorA: { x: Number(sp.localAnchorA.x) || 0, y: Number(sp.localAnchorA.y) || 0 },
          localAnchorB: { x: Number(sp.localAnchorB.x) || 0, y: Number(sp.localAnchorB.y) || 0 },
          stiffness: clamp(isFinite(stiffness) ? stiffness : PhysicsEngine.SPRING_STIFFNESS_MIN,
            PhysicsEngine.SPRING_STIFFNESS_MIN, PhysicsEngine.SPRING_STIFFNESS_MAX),
          restLength: clamp(isFinite(restLength) ? restLength : 0, 0, PhysicsEngine.SPRING_REST_LENGTH_MAX),
        });
      }
    }

    function parseMapping(raw, label, propsList, allowLifespan) {
      if (raw === null || raw === undefined) return null;
      // Scene Lifespan has no body: checked before Number(raw.body) turns a genuine null into 0.
      if (allowLifespan && raw.body === null && raw.property === "lifespan") return { body: null, bodyB: null, property: "lifespan" };
      var bodyIndex = Number(raw.body);
      if (!(bodyIndex >= 0 && bodyIndex < newBodies.length)) {
        throw new Error(label + ".body index out of range.");
      }
      var bodyB = null;
      if (allowLifespan && raw.bodyB !== null && raw.bodyB !== undefined) {
        bodyB = Number(raw.bodyB);
        if (!(bodyB >= 0 && bodyB < newBodies.length)) {
          throw new Error(label + ".bodyB index out of range.");
        }
        // Paired with itself is just the body.
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
      springs: newSprings,
      xInput: parseMapping(parsed.xInput, "xInput"),
      yInput: parseMapping(parsed.yInput, "yInput"),
      output: parseMapping(parsed.output, "output", OUTPUT_PROPERTIES, true),
      edgeMode: PhysicsEngine.edgeModeOf(parsed),
      mutualGravity: parsed.mutualGravity === true,
      maxSimulationBodies: PhysicsEngine.maxSimulationBodiesFor(parsed),
      collisionsEnabled: PhysicsEngine.collisionsEnabled(parsed),
      // Kept exact (see clampSimulationSteps); the slider rests on the nearest hundred.
      simulationSteps: clampSimulationSteps(parsed.simulationSteps) || DEFAULT_SIMULATION_STEPS,
    };
  }

  function applySceneData(data) {
    scene.bodies = data.bodies;
    scene.hinges = data.hinges;
    scene.springs = data.springs || [];
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
    simulationStepsSlider.value = String(simulationStepsNotch(scene.simulationSteps));
    updateSimulationStepsReadout(scene.simulationSteps);
    playbackProgressSlider.max = String(scene.simulationSteps);
  }

  // Common tail for anything replacing the whole scene: refresh panels that read scene state directly.
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
    scene.springs = [];
    scene.xInput = null;
    scene.yInput = null;
    scene.output = null;
    finishSceneReplace();
  });

  // Restores the last edited scene; any error falls back to the seed scene so a bad save can't break loading.
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

  // ---- Scenes that arrive by link ----
  // The address bar carries the whole scene (share-url.js, transition.js): the same authored JSON Export writes.

  function sceneIdentity(authored) {
    var copy = {};
    Object.keys(authored).forEach(function (k) {
      if (k !== "frameWidth" && k !== "frameHeight") copy[k] = authored[k];
    });
    return JSON.stringify(copy);
  }

  // On load, ahead of the autosave. False when the address bar has no usable scene; transition.js tells the user why.
  function loadSceneFromLink() {
    try {
      var shared = ShareUrl.decode(location.hash);
      if (!shared || !shared.scene) return false;
      applySceneData(parseSceneData(PhysicsCoords.toEngineJSON(shared.scene, liveFrame())));
      sharedSceneIdentity = true;
      return true;
    } catch (err) {
      return false;
    }
  }

  // ---- Export / Import modal: one shared dialog shell (#modal-backdrop) ----
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
    // A compact one-liner: meant to be pasted whole, not read in place.
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

  // Enabled-only now: controls no longer gray out during playback (see lockedDuringPlaybackControls).
  function setEditingEnabled(enabled) {
    if (!enabled) return;
    refreshMappingUI();
  }

  // ---- Keep these usable during playback instead of graying out ----
  // Touching any of these mid-run first does what Reset does, then runs the control's own handler.
  // Not listed: the playback transport, outputBodyBSelect and the Advanced disclosures.
  var lockedDuringPlaybackControls = toolButtons.concat([
    btnExportScene, btnImportScene,
    btnSampleDoublePendulum, btnSamplePinball, btnSampleBinaryStar, btnClearAll,
    mutualGravityCheckbox, collisionsCheckbox,
    edgeModeSelect, maxBodiesSlider, simulationStepsSlider, simulationStepsReadout,
    xInputBodySelect, yInputBodySelect, outputBodySelect,
    xInputPropertySelect, yInputPropertySelect, outputPropertySelect,
  ]);
  // A capturing listener on #panel runs before the control's own, whatever event it uses. The reset's
  // refreshMappingUI can rebuild the element, so the just-committed value is snapshotted and restored.
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

  // Stops the clock without leaving playback mode (isPlaying stays true); only resetToInitialScene goes back to Editing.
  function pausePlayback() {
    isAdvancing = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    updatePlayPauseButtonUI();
  }

  var trajectory = null;

  // Where playback stops this run: simulationSteps, or earlier if findWrapStopStep found a wrap.
  var effectiveMaxSteps = DEFAULT_SIMULATION_STEPS;
  // The Output body's continuous x/y/angle for the FINAL frame of a wrap-stopped run (null otherwise):
  // the last discrete sample is a discontinuous function of the starting conditions.
  var wrapStopOverride = null;
  // Scene Lifespan's value for this run, constant across frames; simulationSteps if it never stopped early.
  var lifespanValue = DEFAULT_SIMULATION_STEPS;
  // Bounce Count's per-step totals (JS engine; not in the GPU trajectory), or null.
  var bounceCounts = null;
  // Steps (0-indexed) at which a pair started touching: the bounce sound's triggers, whatever the Output.
  var bounceEvents = [];

  // The property's exact range (mirrors fractal-grid.js): x/y wrap into [0, frame); mod(angle, TAU)
  // is the current facing, so the color runs the whole spectrum every turn instead of saturating.
  var TAU = Math.PI * 2;
  function outputRangeMax(property) {
    if (property === "x") return scene.frameWidth;
    if (property === "y") return scene.frameHeight;
    // Not circular, nor is lifespan below: maximal separation must not read as touching.
    if (property === "distance") return PhysicsEngine.outputDistanceMax(scene);
    if (property === "lifespan") return scene.simulationSteps;
    return TAU;
  }

  // Same rainbow as the fractal grid, hue 360 (min) down to 0 (max). OKLCH, not HSL: HSL lightness
  // isn't perceptually uniform and flashes as the hue sweeps on something animating in place.
  function outputColorForNormalized(t, hueRange) {
    var hue = (hueRange || 360) * (1 - t);
    return "oklch(60% 0.136 " + hue.toFixed(2) + ")";
  }

  // The map's rule: a range that does not wrap (lifespan; x/y unless the edges wrap) stops at 300
  // degrees so the key's ends are two colors (fractal-grid.js: isCircularOutput, HUE_RANGE_MAX).
  function outputHueRange(prop) {
    if (prop === "lifespan") return 300;
    if (prop === "x" || prop === "y") return scene.edgeMode === "wrap" ? 360 : 300;
    return 360;
  }
  // Where a POSITION lands in its color range: wrapped into the frame, or with the edges off squashed into it.
  function positionOutputT(prop, value) {
    var rangeMax = outputRangeMax(prop);
    if (scene.edgeMode === "infinite") return PhysicsEngine.frameSigmoid(value / rangeMax);
    return PhysicsHingeGeometry.wrapIntoRange(value, rangeMax) / rangeMax;
  }

  function updateOutputBackground(currentStepCount) {
    if (!scene.output) return;
    var rangeMax = outputRangeMax(scene.output.property);
    var t;
    if (scene.output.property === "lifespan") {
      t = Math.min(1, Math.max(0, lifespanValue / rangeMax));
    } else if (scene.output.property === "distance") {
      // Clamped, not wrapped: maximal separation is a real value.
      t = Math.min(1, Math.max(0, outputValueAtFrame(trajectory[currentStepCount - 1], scene.output) / rangeMax));
    } else if (scene.output.property === "bounces") {
      var maxBounces = bounceCounts ? bounceCounts[effectiveMaxSteps - 1] : 0;
      t = maxBounces > 0 ? bounceCounts[currentStepCount - 1] / maxBounces : 0;
    } else {
      var value = (wrapStopOverride && currentStepCount === effectiveMaxSteps)
        ? wrapStopOverride[scene.output.property]
        : outputValueAtFrame(trajectory[currentStepCount - 1], scene.output);
      var prop = scene.output.property;
      if (prop === "x" || prop === "y") {
        // Edges off: a sigmoid squashes the unbounded coordinate into range (positionOutputT); angle is always circular.
        t = positionOutputT(prop, value);
      } else {
        t = PhysicsHingeGeometry.wrapIntoRange(value, rangeMax) / rangeMax;
      }
    }
    canvasArea.style.backgroundColor = outputColorForNormalized(t, outputHueRange(scene.output.property));
  }

  // ---- The Output's color key ----
  // Shows which color means what, in the colors Play paints the background with: X/Y as a border shaded
  // along that axis, Scene Lifespan as the scrubber's track, Rotation as a ring around the body, each
  // with a pointer. Whatever the Output, the Set Output button is a swatch of its whole range.
  var OUTPUT_KEY_BORDER_PX = 10;   // the border's thickness, in screen pixels
  var OUTPUT_KEY_STOPS = 24;       // gradients interpolate in sRGB; the hue sweep is given to them in slices
  function outputKeyAxis() {
    var prop = scene.output && scene.output.property;
    return prop === "x" || prop === "y" ? prop : null;
  }
  // Drawn by render() in frame space, so it hugs the FRAME (letterboxed while playing).
  function drawOutputKeyBorder(w, h) {
    var axis = outputKeyAxis();
    if (!axis || !(w > 0 && h > 0)) return;
    var gradient;
    try {
      gradient = axis === "y" ? ctx.createLinearGradient(0, 0, 0, h) : ctx.createLinearGradient(0, 0, w, 0);
      var hueRange = outputHueRange(axis), length = axis === "y" ? h : w;
      for (var i = 0; i <= OUTPUT_KEY_STOPS; i++) {
        var f = i / OUTPUT_KEY_STOPS;
        // A hair inside the frame: AT the far edge a wrapped coordinate is the near edge again.
        gradient.addColorStop(f, outputColorForNormalized(positionOutputT(axis, Math.min(f * length, length - 1e-6)), hueRange));
      }
    } catch (err) {
      return; // a browser whose canvas can't parse oklch(): no key, rather than a wrong one
    }
    var b = OUTPUT_KEY_BORDER_PX / (displayScale || 1);
    ctx.save();
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, b);
    ctx.fillRect(0, h - b, w, b);
    ctx.fillRect(0, b, b, h - 2 * b);
    ctx.fillRect(w - b, b, b, h - 2 * b);
    // Ruler ticks: the two sides the color changes ALONG are ticked across their thickness; the others
    // get one line down the middle, which also sets the interval (stretched so a whole number fit).
    var px = 1 / (displayScale || 1);
    var length = axis === "y" ? h : w, span = axis === "y" ? w : h;
    var first = b / 2, last = length - b / 2;
    var intervals = Math.max(1, Math.round((last - first) / (b / 2)));
    ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
    ctx.lineWidth = 1 * px;
    ctx.beginPath();
    for (var k = 0; k <= intervals; k++) {
      var at = first + k * (last - first) / intervals;
      var whole = k === 0 || k === intervals; // a flat side's own line: the full length of it
      if (axis === "y") {
        if (whole) { ctx.moveTo(0, at); ctx.lineTo(span, at); }
        else { ctx.moveTo(0, at); ctx.lineTo(b, at); ctx.moveTo(span - b, at); ctx.lineTo(span, at); }
      } else {
        if (whole) { ctx.moveTo(at, 0); ctx.lineTo(at, span); }
        else { ctx.moveTo(at, 0); ctx.lineTo(at, b); ctx.moveTo(at, span - b); ctx.lineTo(at, span); }
      }
    }
    ctx.stroke();
    ctx.restore();
    drawOutputKeyBorderPointer(axis, w, h, b);
  }
  // The border's pointer: a dashed line through the Output body with a dot on each side; under the bodies.
  function drawOutputKeyBorderPointer(axis, w, h, b) {
    var output = scene.output, body = scene.bodies[output.body];
    if (!body) return;
    var value = outputValueAtFrame(scene.bodies, output);
    var length = axis === "y" ? h : w, span = axis === "y" ? w : h;
    if (!isFinite(value)) return;
    if (scene.edgeMode === "wrap") value = PhysicsHingeGeometry.wrapIntoRange(value, length);
    // Off the frame (edges off): nothing on the border is level with it.
    if (value < 0 || value > length) return;
    var px = 1 / (displayScale || 1);
    ctx.save();
    ctx.globalAlpha = 0.8;
    ctx.strokeStyle = "#ffffff";
    ctx.fillStyle = "#ffffff";
    ctx.lineWidth = 1.5 * px;
    ctx.setLineDash([4 * px, 4 * px]);
    ctx.beginPath();
    // Between the border's two inner edges...
    if (axis === "y") { ctx.moveTo(b, value); ctx.lineTo(span - b, value); }
    else { ctx.moveTo(value, b); ctx.lineTo(value, span - b); }
    ctx.stroke();
    ctx.setLineDash([]);
    // ...with a dot in the middle of the border's thickness at each end.
    [b / 2, span - b / 2].forEach(function (dot) {
      ctx.beginPath();
      if (axis === "y") ctx.arc(dot, value, 3 * px, 0, TAU);
      else ctx.arc(value, dot, 3 * px, 0, TAU);
      ctx.fill();
    });
    ctx.restore();
  }
  // The pointer's third dot, on the body's own center: drawn AFTER the bodies, unlike the rest of the key.
  function drawOutputKeyBodyDot(w, h) {
    var axis = outputKeyAxis();
    if (!axis) return;
    var output = scene.output, body = scene.bodies[output.body];
    if (!body) return;
    var partner = PhysicsEngine.isPairOutput(output) ? scene.bodies[output.bodyB] : null;
    var other = axis === "y" ? "x" : "y";
    var along = outputValueAtFrame(scene.bodies, output);
    var across = partner ? (body[other] + partner[other]) / 2 : body[other];
    var length = axis === "y" ? h : w;
    if (!isFinite(along) || !isFinite(across)) return;
    if (scene.edgeMode === "wrap") along = PhysicsHingeGeometry.wrapIntoRange(along, length);
    if (along < 0 || along > length) return; // no line to sit on: see drawOutputKeyBorderPointer
    var px = 1 / (displayScale || 1);
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    if (axis === "y") ctx.arc(across, along, 3 * px, 0, TAU);
    else ctx.arc(along, across, 3 * px, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  // The ring, for a single body's Rotation (a pair's average points at nothing).
  var OUTPUT_KEY_RING_GAP_PX = 22;    // from the body's farthest reach to the ring
  var OUTPUT_KEY_RING_WIDTH_PX = 10;
  var OUTPUT_KEY_RING_SEGMENTS = 90;  // arcs of 4 degrees: a conic gradient, without needing createConicGradient
  function drawOutputKeyRing() {
    var output = scene.output;
    if (!output || output.property !== "angle" || PhysicsEngine.isPairOutput(output)) return;
    var body = scene.bodies[output.body];
    if (!body) return;
    var px = 1 / (displayScale || 1); // one screen pixel, in frame units
    var reach;
    if (body.type === "circle") reach = playbackDisplayRadius(body.radius);
    else if (isTrapezoidType(body.type)) {
      reach = 0;
      funnelPathVertices(body.x, body.y, body.angle, body.size).forEach(function (v) {
        reach = Math.max(reach, Math.hypot(v.x - body.x, v.y - body.y));
      });
    } else reach = body.length / 2;
    var radius = reach + OUTPUT_KEY_RING_GAP_PX * px;
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = OUTPUT_KEY_RING_WIDTH_PX * px;
    ctx.lineCap = "butt";
    var step = TAU / OUTPUT_KEY_RING_SEGMENTS;
    for (var i = 0; i < OUTPUT_KEY_RING_SEGMENTS; i++) {
      // Mid-segment color, with a hair of overlap against seams; canvas angles run the way body.angle does.
      ctx.strokeStyle = outputColorForNormalized((i + 0.5) / OUTPUT_KEY_RING_SEGMENTS, outputHueRange("angle"));
      ctx.beginPath();
      ctx.arc(body.x, body.y, radius, i * step - 0.003, (i + 1) * step + 0.003);
      ctx.stroke();
    }
    // The pointer: from the end that points, out to the ring.
    var dx = Math.cos(body.angle), dy = Math.sin(body.angle);
    ctx.globalAlpha = 0.8;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.5 * px;
    ctx.setLineDash([4 * px, 4 * px]);
    ctx.beginPath();
    ctx.moveTo(body.x + dx * reach, body.y + dy * reach);
    ctx.lineTo(body.x + dx * (radius - OUTPUT_KEY_RING_WIDTH_PX * px / 2), body.y + dy * (radius - OUTPUT_KEY_RING_WIDTH_PX * px / 2));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(body.x + dx * radius, body.y + dy * radius, 3 * px, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  // The keys that are CONTROLS: the scrubber's track and the Set Output button. A class plus a custom property,
  // since a range track is only reachable via pseudo-elements (.output-key in physics.css); the state string avoids a style write per frame.
  var outputKeyControlsState = null;
  var btnOutputTool = document.querySelector('.tool-btn[data-tool="output"]');
  function outputKeyGradient(prop) {
    var stops = [];
    for (var i = 0; i <= OUTPUT_KEY_STOPS; i++) {
      var f = i / OUTPUT_KEY_STOPS;
      stops.push(outputColorForNormalized(f, outputHueRange(prop)) + " " + (f * 100).toFixed(1) + "%");
    }
    return "linear-gradient(to right, " + stops.join(", ") + ")";
  }
  function updateOutputKeyControls() {
    var prop = scene.output ? scene.output.property : "";
    var state = prop + "|" + (prop === "x" || prop === "y" ? scene.edgeMode : "");
    if (state === outputKeyControlsState) return;
    outputKeyControlsState = state;
    var gradient = prop ? outputKeyGradient(prop) : "";
    if (btnOutputTool) btnOutputTool.textContent = prop ? "Output Set" : "Set Output";
    [[playbackProgressSlider, prop === "lifespan"], [btnOutputTool, !!prop]].forEach(function (pair) {
      var el = pair[0], on = pair[1];
      if (!el) return;
      el.classList.toggle("output-key", on);
      if (on) el.style.setProperty("--output-key", gradient);
      else el.style.removeProperty("--output-key");
    });
  }

  function sceneHasSplitter(s) {
    return s.bodies.some(function (b) { return b.type === "splitter"; });
  }

  // The Output value at one frame: the AVERAGE over the body's lineage, so a split ball tracks all its pieces.
  function outputValueAtFrame(frame, output) {
    // Wrapped into a scene shape so PhysicsEngine.computeOutputValue stays the one JS definition.
    var asScene = {
      bodies: frame.map(function (b, i) {
        return { x: b.x, y: b.y, angle: b.angle, lineage: b.lineage !== undefined ? b.lineage : i };
      }),
      frameWidth: scene.frameWidth, frameHeight: scene.frameHeight, edgeMode: scene.edgeMode,
    };
    return PhysicsEngine.computeOutputValue(asScene, output);
  }

  // stepCount is 1-indexed; trajectory[] is 0-indexed, so the lookup is stepCount - 1.
  function applyTrajectoryStep(stepCount) {
    var frame = trajectory[stepCount - 1];
    // A splitter's run has more bodies in later frames: grow or shrink the scene to match the frame.
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
    // Only on the final frame of a wrap-stopped run (see wrapStopOverride); lifespan has no body to correct.
    if (wrapStopOverride && stepCount === effectiveMaxSteps && scene.output.body !== null) {
      var out = scene.bodies[scene.output.body];
      out.x = wrapStopOverride.x;
      out.y = wrapStopOverride.y;
      out.angle = wrapStopOverride.angle;
    }
  }

  var STEPS_PER_SECOND = 1 / PhysicsGPU.FIXED_DT;
  // True only while the clock advances; isPlaying stays true through a pause.
  var isAdvancing = false;
  var playbackClockSteps = 0;
  var lastTickTime = 0;

  // stepCount can be dragged past effectiveMaxSteps (the slider spans the full duration): hold on the real final frame.
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

  // Drawings, not characters: U+23F8 has an emoji form some phones draw as an orange tile. (Same in fractal-grid.js.)
  var PLAY_ICON_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M8 5.14v13.72a.6.6 0 0 0 .92.5l10.55-6.86a.6.6 0 0 0 0-1L8.92 4.64a.6.6 0 0 0-.92.5z"></path></svg>';
  var PAUSE_ICON_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"></rect><rect x="14" y="5" width="4" height="14" rx="1"></rect></svg>';
  function updatePlayPauseButtonUI() {
    var icon = isAdvancing ? "pause" : "play";
    if (btnPlayPause.getAttribute("data-icon") !== icon) {
      btnPlayPause.setAttribute("data-icon", icon);
      btnPlayPause.innerHTML = isAdvancing ? PAUSE_ICON_SVG : PLAY_ICON_SVG;
    }
    btnPlayPause.title = isAdvancing ? "Pause" : "Play";
    btnPlayPause.setAttribute("aria-label", isAdvancing ? "Pause" : "Play");
  }

  // ---- Playback speed ----
  // A multiplier on STEPS_PER_SECOND (1x is real time), read fresh by tick() every frame; the grid defaults to 2x.
  var playbackSpeed = 1;
  var SPEED_MIN = 0.5, SPEED_MAX = 16;
  // log2(speed) space, so each x2 step gets equal travel; step="1" restricts it to powers of two.
  var SPEED_LOG_MIN = Math.log2(SPEED_MIN), SPEED_LOG_MAX = Math.log2(SPEED_MAX);
  function sliderValueToSpeed(v) { return Math.pow(2, v); }
  function speedToSliderValue(speed) { return Math.log2(speed); }
  // The HTML hardcodes matching min/max/step for a flash-free first paint; set from the same constants so they can't drift.
  speedSlider.min = String(SPEED_LOG_MIN);
  speedSlider.max = String(SPEED_LOG_MAX);
  speedSlider.step = "1";

  function formatSpeed(v) {
    return (v < 2 ? v.toFixed(1) : String(Math.round(v))) + "x";
  }

  function updateSpeedUI() {
    var text = formatSpeed(playbackSpeed);
    btnSpeed.textContent = text;
    speedValueEl.textContent = text;
    speedSlider.value = String(speedToSliderValue(playbackSpeed));
  }

  // Fixed positioning, so placed by hand (like fractal-grid.js's positionTip): centered above the button, clamped on-screen.
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

  // Driven by elapsed wall-clock time, not one step per callback: rAF intervals stretch under load, so a
  // late callback skips ahead to stay on schedule. One scene at a time, so the sounds are single-voice.
  function singleVoiceFreq() { return PhysicsSound.chordFrequencies(1)[0]; }

  function tick() {
    if (!isAdvancing) return;
    var now = performance.now();
    var dt = (now - lastTickTime) / 1000;
    lastTickTime = now;
    playbackClockSteps = Math.min(effectiveMaxSteps, playbackClockSteps + dt * STEPS_PER_SECOND * playbackSpeed);
    var targetStep = Math.floor(playbackClockSteps);
    if (targetStep > stepCount) {
      // Before stepCount moves: a slow frame can jump several steps, and every bounce crossed still sounds.
      var prevStepCount = stepCount;
      stepCount = targetStep;
      var displayStep = currentDisplayStep();
      applyTrajectoryStep(displayStep);
      updateOutputBackground(displayStep);
      updateStepReadout();
      updatePlaybackProgressSliderPosition();
      render();
      // bounceEvents rows are 0-indexed, stepCount 1-indexed: event e was just reached when prevStepCount <= e < stepCount.
      for (var i = 0; i < bounceEvents.length; i++) {
        if (bounceEvents[i] >= prevStepCount && bounceEvents[i] < stepCount) {
          PhysicsSound.playBounce(singleVoiceFreq());
          break;
        }
      }
      if (wrapStopOverride && prevStepCount < effectiveMaxSteps && stepCount >= effectiveMaxSteps) {
        PhysicsSound.playEdge(singleVoiceFreq());
      }
    }
    if (stepCount >= effectiveMaxSteps) {
      // Freeze on the final frame: a pause, not a stop, so isPlaying stays true until Reset.
      pausePlayback();
      return;
    }
    rafId = requestAnimationFrame(tick);
  }

  // Only reached from Editing or right after Reset; returns false, leaving everything as it was, if the simulation fails.
  function startPlaybackFromScratch() {
    initialScene = PhysicsEngine.cloneScene(scene);
    try {
      // A splitter grows bodies mid-run: the GPU pads rows to full width, but playback wants rows that GROW
      // (applyTrajectoryStep sizes the scene per frame), so it runs on the JS engine. The suite checks the two agree.
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
    // The slider spans the full configured duration, not effectiveMaxSteps: an early stop reads as a thumb short of the end.
    playbackProgressSlider.min = "1";
    playbackProgressSlider.max = String(scene.simulationSteps);
    playbackProgressSlider.disabled = false;
    updatePlaybackProgressSliderPosition();
    return true;
  }

  // Pause is immediate; play starts, resumes, or restarts a finished run. No autoplay grace period here: every play is a click.
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

  // Scrubbing always pauses (else it fights the clock); values past effectiveMaxSteps hold on the real final frame.
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

  // Shared by Reset and Fractal-ize: playback writes into scene.bodies, so restore the authored scene. The only
  // path that re-enables editing. initialScene is nulled once consumed so later edits aren't reverted.
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
    // resizeCanvas(), not render(): re-syncs the frame and un-letterboxes the canvas now that isPlaying is false.
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

  // Order matters: the frame must be known before the scene is restored or seeded, and the scene must be
  // populated BEFORE the first resizeCanvas(), whose render() auto-saves and would overwrite the real save with an empty scene.
  if (canvasArea.clientWidth > 0 && canvasArea.clientHeight > 0) {
    scene.frameWidth = canvasArea.clientWidth;
    scene.frameHeight = canvasArea.clientHeight;
  }
  if (!loadSceneFromLink() && !loadPersistedScene()) seedDefaultScene();
  // Redundant after loadPersistedScene, but keeps a seeded scene's slider in sync without trusting the HTML default.
  simulationStepsSlider.value = String(simulationStepsNotch(scene.simulationSteps));
  updateSimulationStepsReadout(scene.simulationSteps);
  playbackProgressSlider.max = String(scene.simulationSteps);
  updatePlayPauseButtonUI();
  updateSpeedUI();
  resizeCanvas();
  setEditingEnabled(true);
  setActiveTool("select");
  render();

  // ---- What the transition needs from the editor ----
  // transition.js draws the editor's BODIES, tiled, into its own canvas: none of the editing chrome.
  // drawBody() draws into this module's `ctx`, so the context is swapped rather than the drawing duplicated.
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
    // One spring into someone else's canvas, drawn as the editor draws it; `color` is optional (an inspected point's hue).
    drawSpringBetween: function (targetCtx, a, b, stiffness, restLength, color) {
      var previous = ctx;
      ctx = targetCtx;
      try {
        drawSpringShape(a, b, stiffness, restLength, false, 1, color);
      } finally {
        ctx = previous;
      }
    },
    // Every spring of a scene whose bodies are where they should be drawn.
    drawSceneSprings: function (targetCtx, sceneToDraw) {
      var previous = ctx;
      ctx = targetCtx;
      try {
        PhysicsEngine.sceneSprings(sceneToDraw).forEach(function (sp) {
          var p = PhysicsEngine.getSpringWorldPoints(sp, sceneToDraw.bodies);
          drawSpringShape(p.a, p.b, sp.stiffness, sp.restLength, false);
        });
      } finally {
        ctx = previous;
      }
    },
    // A copy, so the transition stepping it forward can't disturb the editor's.
    currentScene: function () { return PhysicsEngine.cloneScene(scene); },
    // For the address bar (transition.js): the authored JSON; null during a run, when scene.bodies is an animation frame.
    shareScene: function () {
      return isPlaying ? null : PhysicsCoords.toAuthoredJSON(serializeScene());
    },
    // Why a link's scene can't be used, or null; how transition.js finds out, since on load the scene is already in.
    sharedSceneProblem: function (authored) {
      try {
        parseSceneData(PhysicsCoords.toEngineJSON(authored, liveFrame()));
        return null;
      } catch (err) {
        return err.message;
      }
    },
    // A link opened while the page is up (pasted address, or Back). Returns why it was refused, or null.
    loadSharedScene: function (authored) {
      var data;
      try {
        data = parseSceneData(PhysicsCoords.toEngineJSON(authored, liveFrame()));
      } catch (err) {
        return err.message;
      }
      resetToInitialScene(); // a run in progress belongs to the scene being replaced
      applySceneData(data);
      sharedSceneIdentity = true;
      finishSceneReplace();
      return null;
    },
    // The scene a map link opens ON, placed in the link's OWN frame: the frame is physics (edges, x/y color range),
    // so the map only matches in the frame it was shared from. Throws a message fit to show if the editor would refuse it.
    gridSceneFromShared: function (authored) {
      var frame = { frameWidth: Number(authored.frameWidth), frameHeight: Number(authored.frameHeight) };
      if (!(frame.frameWidth > 0 && frame.frameHeight > 0)) throw new Error("it doesn't say how big the scene's frame is");
      var data = parseSceneData(PhysicsCoords.toEngineJSON(authored, frame));
      if (!hasSomethingToMap(data) || !data.xInput || !data.yInput || !data.output) {
        throw new Error("its scene has no X / Y Input and Output mapped yet");
      }
      data.frameWidth = frame.frameWidth;
      data.frameHeight = frame.frameHeight;
      return serializeSceneOf(data);
    },
    reportLinkProblem: function (message) { flashStatus(message, 6000); },
    // ---- The one setting that exists on both pages ----
    // The grid's own Simulation Duration slider calls this so the value survives the round trip.
    // Snapped to the slider's notches and clamped: a setter reachable from another module.
    setSimulationSteps: function (steps) {
      var next = clampSimulationSteps(steps);
      if (next === null || next === scene.simulationSteps) return;
      scene.simulationSteps = next;
      simulationStepsSlider.value = String(simulationStepsNotch(next));
      updateSimulationStepsReadout(next);
      if (!isPlaying) playbackProgressSlider.max = String(next);
      // Nothing renders here (the editor isn't the visible view), so autosave by hand.
      saveEditorAutosave();
    },
  };
})(window);
