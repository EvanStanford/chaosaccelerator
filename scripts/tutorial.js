// CPAL-1.0 License. See chaosaccelerator.com/license.html

// How the map is made, as an animation: each square of a small map is one run of the scene, played on
// the left, colored by where the ball leaves the frame, then shrunk into its square on the right. Then the
// map's pixels halve, a level at a time, and the runs between them fill the gaps.
(function () {
  "use strict";

  // The scene, and an Inspect line whose two ends are the corners of the box that becomes the map.
  var LINK = "#map/v:1.0,body:ci:13.4731:468.3284:0:75;ci:9.9353:-341.1889:0:75!,xinp:0.x,yinp:0.y,outp:0.y,step:800," +
    "frmw:1080,frmh:1590,ctrx:-29.256147,ctry:-266.417678,insp:l:-.1343915343:.4335978834:.1920634921:-.3140211642:30";
  var BOX_COLUMNS = 8, COLUMNS = 9; // squares across the Inspect box, and across the map, which runs on past its right side
  var X_STRETCH = 2; // the map is drawn this much wider than its own shape: a square covers half as much x as y

  // A square's turn, phase by phase.
  var OUTLINE = 0, SPAWN = 1, RUN = 2, POINT = 3, FILL = 4, HOLD = 5, FLY = 6, UNHIGHLIGHT = 7;
  var PHASE_MS = [500, 400, null, 1000, 500, 300, 1100, 250]; // RUN lasts as long as its run
  var DT = 1 / 60; // one step
  var RUN_SPEED = 1.3; // at 1x a run plays 30% faster than real time
  var SLOW_SQUARES = 3, FAST_START = 2, FAST_GROWTH = 1.08; // the first 3 squares at 1x, then 2x, 8% faster each square after
  var MODERATE_START = 3; // level 1's squares start at 3x, FAST_GROWTH faster each square after
  var SHRINK_MS = 1200; // each halving of the pixels
  // Per level (0 and 1): squares that play their run, then squares that only show their color and move it to the
  // map; the rest just fill in, FILL_IN_RATE a second at first and FILL_IN_GROWTH faster each after.
  var PLAYED = [12, 3], COLOR_ONLY = [8, 10];
  var FILL_IN_RATE = 20, FILL_IN_GROWTH = 1.02;

  var STAGE_ASPECT = 16 / 9; // the picture's shape, black bars around it in a window of any other
  var LETTERBOX_BG = "#000", PAGE_BG = "#14161c", FRAME_BG = "#0c0d11";
  var BODY = { fill: "#3a63d1", stroke: "#7ea0ff" }, ANCHORED = { fill: "#5a6178", stroke: "#7a8199" };
  var GHOST = { fill: "#a9aeb9", stroke: "#cfd3db" };
  var GHOST_SCALE = 1, GHOSTS_SHOWN = 5, GHOST_FADE_MS = 400; // the ball's size; about 5 at once
  var GHOSTS_GONE_AFTER = 20; // squares until no ghost shows at all
  var OUTLINE_COLOR = "#ffcf4d";
  var GRID_STEP = 50, GRID_COLOR = "rgba(255,255,255,0.05)";
  var KEY_BORDER_PX = 10, KEY_STOPS = 24;
  var SPOT_RING_PX = 45; // how far the rings around the edge mark spread

  var link = ShareUrl.decode(LINK);
  var scene = PhysicsCoords.toEngineJSON(link.scene, link.scene);
  var W = scene.frameWidth, H = scene.frameHeight;
  var output = scene.output, alongY = output.property === "y";
  var ends = PhysicsEngine.outputColorEnds(scene);

  // The builder's key color at t, the Output's place along its axis (0 to 1); x and y stop at hue 300 on Sticky Edges.
  function colorAt(t) {
    if (ends.flip) t = 1 - t;
    var fade = ends.fadeAt < 0 ? 1 : Math.min(1, Math.abs(t - ends.fadeAt) / ends.fadeSpan);
    return "oklch(" + (60 * fade).toFixed(2) + "% " + (0.136 * fade).toFixed(4) + " " + (300 * (1 - t)).toFixed(2) + ")";
  }

  // ---- The runs ----

  // One square of the map in map units (the Input body's offset, y up), BOX_COLUMNS of them across the Inspect box,
  // and the map's top left: as many rows as fit the box's height, centered on it.
  var box = link.view.inspect[0];
  var cellX = Math.abs(box.b.x - box.a.x) / BOX_COLUMNS, cellY = cellX * X_STRETCH;
  var ROWS = Math.round(Math.abs(box.a.y - box.b.y) / cellY);
  var mapLeft = Math.min(box.a.x, box.b.x), mapTop = (box.a.y + box.b.y) / 2 + ROWS * cellY / 2;
  var watched = PhysicsHingeGeometry.wrapWatchedBodyIndices(scene);

  function pose(b) { return { x: b.x, y: b.y, angle: b.angle }; }

  // Which edge the center crossed at p, and the point on it.
  function crossingEdge(p) {
    var gaps = [p.x, W - p.x, p.y, H - p.y], which = gaps.indexOf(Math.min.apply(null, gaps));
    return { which: which, x: which === 0 ? 0 : which === 1 ? W : p.x, y: which === 2 ? 0 : which === 3 ? H : p.y };
  }

  // The run from map point (u, v), in squares from the top left, until the center leaves the frame: frames[k] is
  // every body after k steps, final the state at the crossing, steps (fractional) when that happened.
  function runFrom(u, v) {
    var sim = PhysicsEngine.cloneScene(scene);
    sim.bodies.forEach(PhysicsEngine.computeMass);
    sim.bodies[scene.xInput.body].x += mapLeft + u * cellX;
    sim.bodies[scene.yInput.body].y -= mapTop - v * cellY;
    var start = sim.bodies.map(pose), rows = [], flags = [], stop = null;
    while (!stop && rows.length < sim.simulationSteps) {
      PhysicsEngine.step(sim, DT, { wrapFlags: flags });
      rows.push(sim.bodies.map(function (b, j) {
        return { x: b.x, y: b.y, angle: b.angle, wrapX: !!(flags[j] & 1), wrapY: !!(flags[j] & 2) };
      }));
      if (flags.some(Boolean)) stop = PhysicsHingeGeometry.findWrapStopStep(rows, watched, null, W, H, start, DT);
    }
    var run = { u: u, v: v };
    if (stop) {
      run.frames = [start].concat(rows.slice(0, stop.step));
      run.final = start.map(function (b, j) { return pose(PhysicsHingeGeometry.findWrapStopStep(rows, watched, j, W, H, start, DT)); });
      run.steps = stop.step + stop.tFrac / DT;
    } else {
      run.frames = [start].concat(rows.slice(0, -1));
      run.final = rows[rows.length - 1].map(pose);
      run.steps = rows.length;
    }
    var end = run.final[output.body];
    run.color = colorAt(Math.min(1, Math.max(0, alongY ? end.y / H : end.x / W)));
    run.edge = stop ? crossingEdge(end) : null;
    return run;
  }

  // Outward from the middle of a cols x rows grid, a turn at a time, skipping places off it.
  function spiralOrder(cols, rows) {
    var col = Math.floor(cols / 2), row = Math.floor((rows - 1) / 2);
    var order = [{ col: col, row: row }], moves = [[-1, 0], [0, -1], [1, 0], [0, 1]]; // left, up, right, down
    for (var length = 1, turn = 0; order.length < cols * rows; turn++) {
      var move = moves[turn % 4];
      for (var k = 0; k < length; k++) {
        col += move[0];
        row += move[1];
        if (col >= 0 && col < cols && row >= 0 && row < rows) order.push({ col: col, row: row });
      }
      if (turn % 2 === 1) length++;
    }
    return order;
  }

  // ---- The map's levels ----

  // Each level's pixel size in squares and its lattice, centers at (k + offset) * size from the top left, and how
  // dark the lines between its pixels are. A level keeps the last one's centers; from level 1 on, the lattice takes
  // in the map's edges, where pixels are cut in half.
  var LEVELS = [
    { w: 1, h: 1, ox: 0.5, oy: 0.5, grid: 0.12 },
    { w: 0.5, h: 0.5, ox: 0, oy: 0, grid: 0.09 },
    { w: 0.25, h: 0.25, ox: 0, oy: 0, grid: 0.06 },
    { w: 0.125, h: 0.125, ox: 0, oy: 0, grid: 0.03 },
    { w: 0.0625, h: 0.0625, ox: 0, oy: 0, grid: 0.012 },
    { w: 0.03125, h: 0.03125, ox: 0, oy: 0, grid: 0 },
  ];
  function latticeOf(level) {
    var L = LEVELS[level], points = [];
    for (var j = 0; (j + L.oy) * L.h <= ROWS; j++) {
      for (var i = 0; (i + L.ox) * L.w <= COLUMNS; i++) points.push({ u: (i + L.ox) * L.w, v: (j + L.oy) * L.h });
    }
    return points;
  }
  function key(p) { return p.u * 32 + "," + p.v * 32; }
  function pixelKeys() {
    var have = {};
    pixels.forEach(function (p) { have[key(p)] = true; });
    return have;
  }

  // Every square shown on the left, and every pixel; shownAt is when one is on the map. A square of tier 1 plays
  // its run, one of tier 2 only shows its color and moves it to the map.
  var total = 0, squares = [], pixels = [];
  function play(run, level, speed, tier, rings) {
    run.level = level;
    run.speed = speed;
    run.tier = tier;
    run.rings = rings;
    // The first two squares' balls are in before their runs, the first from the start and the second with its
    // outline, so they have no spawn.
    run.early = squares.length < 2;
    // phaseMs at 1x, phaseStart on the real clock.
    run.phaseMs = PHASE_MS.map(function (ms, phase) {
      if (phase === RUN) return tier > 1 ? 0 : run.steps * DT * 1000 / RUN_SPEED;
      return (phase === SPAWN && (tier > 1 || run.early)) || (phase === POINT && tier > 1) ? 0 : ms;
    });
    run.phaseStart = run.phaseMs.map(function (ms) { var at = total; total += ms / speed; return at; });
    run.end = total;
    run.shownAt = run.phaseStart[UNHIGHLIGHT];
    squares.push(run);
    pixels.push(run);
  }
  // A level's new pixels in order: the first PLAYED as tier 1, the next COLOR_ONLY as tier 2, the rest filled in.
  function playLevel(points, level, speedOf) {
    points.forEach(function (p, i) {
      var run = runFrom(p.u, p.v), k = i - PLAYED[level] - COLOR_ONLY[level];
      if (k < 0) {
        play(run, level, speedOf(i), i < PLAYED[level] ? 1 : 2, level === 0 && i < SLOW_SQUARES);
      } else {
        pixels.push({ u: p.u, v: p.v, color: run.color, shownAt: total });
        total += 1000 / (FILL_IN_RATE * Math.pow(FILL_IN_GROWTH, k));
      }
    });
  }
  // fullAt[level]: when that level is filled in, and the shrink into the next one starts.
  var fullAt = [];
  playLevel(spiralOrder(COLUMNS, ROWS).map(function (cell) { return { u: cell.col + 0.5, v: cell.row + 0.5 }; }), 0, function (i) {
    return i < SLOW_SQUARES ? 1 : FAST_START * Math.pow(FAST_GROWTH, i - SLOW_SQUARES);
  });
  fullAt.push(total);
  total += SHRINK_MS;
  // Level 1's new pixels in a spiral over its whole lattice from the middle out, skipping level 0's.
  var levelZero = pixelKeys();
  playLevel(spiralOrder(COLUMNS / LEVELS[1].w + 1, ROWS / LEVELS[1].h + 1).map(function (cell) {
    return { u: cell.col * LEVELS[1].w, v: cell.row * LEVELS[1].h };
  }).filter(function (p) { return !levelZero[key(p)]; }), 1, function (i) { return MODERATE_START * Math.pow(FAST_GROWTH, i); });
  fullAt.push(total);
  // Levels 2 on appear all at once as their shrink ends, each drawn from one image, a texel to a pixel. The images
  // are made after load so the page starts at once (the last level is over 80,000 runs); a level wanted before it
  // is ready is finished on the spot.
  var colors = {}, levelImages = [], pending = [];
  pixels.forEach(function (p) { colors[key(p)] = p.color; });
  for (var n = 2; n < LEVELS.length; n++) {
    total += SHRINK_MS;
    fullAt.push(total);
    var image = document.createElement("canvas");
    image.width = Math.round(COLUMNS / LEVELS[n].w) + 1;
    image.height = Math.round(ROWS / LEVELS[n].h) + 1;
    pending.push({ level: n, points: latticeOf(n), next: 0, image: image, ctx: image.getContext("2d") });
  }
  // Runs and paints pending pixels while more() says to go on.
  function work(more) {
    while (pending.length && more()) {
      var job = pending[0], L = LEVELS[job.level], p = job.points[job.next++], k = key(p);
      if (!(k in colors)) colors[k] = runFrom(p.u, p.v).color;
      job.ctx.fillStyle = colors[k];
      job.ctx.fillRect(Math.round(p.u / L.w), Math.round(p.v / L.h), 1, 1);
      if (job.next === job.points.length) {
        levelImages[job.level] = job.image;
        pending.shift();
      }
    }
  }
  function workInBackground() {
    var until = performance.now() + 12;
    work(function () { return performance.now() < until; });
    if (pending.length) setTimeout(workInBackground, 0);
  }

  // Where the animation is `ms` in: the square whose turn it is, its phase, and how far into that at 1x.
  function locate(ms) {
    for (var i = 0; i < squares.length; i++) {
      var sq = squares[i];
      if (ms >= sq.end) continue;
      if (ms < sq.phaseStart[OUTLINE]) break;
      var phase = PHASE_MS.length - 1;
      while (phase > 0 && ms < sq.phaseStart[phase]) phase--;
      var into = (ms - sq.phaseStart[phase]) * sq.speed;
      return { square: sq, phase: phase, ms: into, t: Math.min(1, into / sq.phaseMs[phase]) };
    }
    return { square: null };
  }

  // The level the map is at, at ms, and how far through the shrink into it (1 once it has settled).
  function levelAt(ms) {
    var level = 0, p = 1;
    for (var k = 0; k + 1 < LEVELS.length; k++) {
      if (ms > fullAt[k]) { level = k + 1; p = clamp01((ms - fullAt[k]) / SHRINK_MS); }
    }
    return { level: level, p: p };
  }
  function pixelSize(at) {
    var to = LEVELS[at.level];
    if (at.level === 0) return to;
    var from = LEVELS[at.level - 1], e = easeInOut(at.p);
    return { w: from.w + (to.w - from.w) * e, h: from.h + (to.h - from.h) * e };
  }

  function clamp01(v) { return Math.min(1, Math.max(0, v)); }
  function smooth(t) { return t * t * (3 - 2 * t); }
  function easeOut(t) { return 1 - Math.pow(1 - t, 3); }
  function easeInOut(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(2 - 2 * t, 3) / 2; }
  function overshoot(t) { return t <= 0 ? 0 : 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2); }

  // Every body s steps into the run, straight between logged steps.
  function posesAt(sq, s) {
    if (s >= sq.steps) return sq.final;
    var k = Math.floor(s), a = sq.frames[k], b = k + 1 < sq.frames.length ? sq.frames[k + 1] : sq.final;
    var f = (s - k) / (Math.min(k + 1, sq.steps) - k);
    return a.map(function (p, j) {
      return { x: p.x + (b[j].x - p.x) * f, y: p.y + (b[j].y - p.y) * f, angle: p.angle + (b[j].angle - p.angle) * f };
    });
  }

  // The run on the left at `at`, or null between squares: poses, the ball's grow-in, ms since the edge mark, the fill.
  function runState(at, ms) {
    var first = squares[0];
    if (ms < first.phaseStart[RUN]) return { square: first, poses: first.frames[0], grow: 1, spotMs: -1, fill: 0 };
    var sq = at.square;
    if (sq && at.phase === OUTLINE && sq.early) return { square: sq, poses: sq.frames[0], grow: overshoot(at.t), spotMs: -1, fill: 0 };
    if (!sq || at.phase === OUTLINE || at.phase === UNHIGHLIGHT) return null;
    var played = sq.tier === 1;
    return {
      square: sq,
      poses: at.phase === RUN ? posesAt(sq, at.ms * RUN_SPEED / 1000 / DT) : at.phase === SPAWN ? sq.frames[0] : sq.final,
      grow: !played ? 0 : at.phase === SPAWN ? overshoot(at.t) : 1,
      spotMs: played && at.phase >= POINT ? (sq.phaseStart[at.phase] - sq.phaseStart[POINT]) * sq.speed + at.ms : -1,
      fill: at.phase < FILL ? 0 : at.phase === FILL ? easeOut(at.t) : 1,
    };
  }

  // ---- Drawing ----

  var canvas = document.getElementById("stage"), ctx = canvas.getContext("2d");
  var dpr = 1, view = null;

  var keyGradient = alongY ? ctx.createLinearGradient(0, 0, 0, H) : ctx.createLinearGradient(0, 0, W, 0);
  for (var i = 0; i <= KEY_STOPS; i++) keyGradient.addColorStop(i / KEY_STOPS, colorAt(i / KEY_STOPS));

  // The stage centered in the window; the sim against its left side and the map its right, the same margin
  // from each, the same height.
  function measure() {
    var vw = window.innerWidth, vh = window.innerHeight;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(vw * dpr);
    canvas.height = Math.round(vh * dpr);
    canvas.style.width = vw + "px";
    canvas.style.height = vh + "px";
    var sw = Math.round(Math.min(vw, vh * STAGE_ASPECT)), sh = Math.round(sw / STAGE_ASPECT);
    var sx = Math.round((vw - sw) / 2), sy = Math.round((vh - sh) / 2);
    var pad = Math.max(16, 0.06 * Math.min(sw / 2, sh));
    var h = Math.min(sh - 2 * pad, (sw - 3 * pad) / (W / H + COLUMNS / ROWS));
    var simW = h * W / H, mapW = h * COLUMNS / ROWS, top = sy + (sh - h) / 2;
    view = {
      width: vw, height: vh,
      stage: { x: sx, y: sy, w: sw, h: sh },
      sim: { x: sx + pad, y: top, w: simW, h: h },
      map: { x: sx + sw - pad - mapW, y: top, w: mapW, h: h },
      px: W / simW, // one screen pixel of the sim, in frame units
    };
  }
  function snap(v) { return Math.round(v * dpr) / dpr; }
  // A pixel's rect on screen at size (in squares), cut to the map and snapped to device pixels so neighbors meet.
  function pixelRect(p, size) {
    var m = view.map, cell = m.w / COLUMNS;
    var x0 = snap(m.x + Math.max(0, p.u - size.w / 2) * cell), x1 = snap(m.x + Math.min(COLUMNS, p.u + size.w / 2) * cell);
    var y0 = snap(m.y + Math.max(0, p.v - size.h / 2) * cell), y1 = snap(m.y + Math.min(ROWS, p.v + size.h / 2) * cell);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  // The builder's grid, ruled from the frame's center.
  function drawGrid(px) {
    ctx.lineWidth = px;
    ctx.strokeStyle = GRID_COLOR;
    ctx.beginPath();
    for (var x = (W / 2) % GRID_STEP; x < W; x += GRID_STEP) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (var y = (H / 2) % GRID_STEP; y < H; y += GRID_STEP) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();
  }

  // The builder's Output key: the frame's edge shaded along the Output's axis, ruled every half its thickness.
  function drawKeyBorder(px) {
    var b = KEY_BORDER_PX * px, length = alongY ? H : W, span = alongY ? W : H;
    ctx.fillStyle = keyGradient;
    ctx.fillRect(0, 0, W, b);
    ctx.fillRect(0, H - b, W, b);
    ctx.fillRect(0, b, b, H - 2 * b);
    ctx.fillRect(W - b, b, b, H - 2 * b);
    function tick(along, from, to) {
      if (alongY) { ctx.moveTo(from, along); ctx.lineTo(to, along); } else { ctx.moveTo(along, from); ctx.lineTo(along, to); }
    }
    var first = b / 2, last = length - b / 2, intervals = Math.max(1, Math.round((last - first) / (b / 2)));
    ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
    ctx.lineWidth = px;
    ctx.beginPath();
    for (var k = 0; k <= intervals; k++) {
      var at = first + k * (last - first) / intervals;
      if (k === 0 || k === intervals) tick(at, 0, span);
      else { tick(at, 0, b); tick(at, span - b, span); }
    }
    ctx.stroke();
  }

  function drawBall(spec, p, px, grow) {
    var look = spec.isAnchored ? ANCHORED : BODY, r = spec.radius * grow;
    if (!(r > 0)) return;
    ctx.fillStyle = look.fill;
    ctx.strokeStyle = look.stroke;
    ctx.lineWidth = 2 * px;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, 2 * Math.PI);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + Math.cos(p.angle) * r, p.y + Math.sin(p.angle) * r);
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 1.5 * px;
    ctx.stroke();
  }

  // Light grey where the latest played runs started: each fades a step as a newer square comes in (over
  // GHOST_FADE_MS at its speed) and is gone once GHOSTS_SHOWN have, and all fade with every square, gone after
  // GHOSTS_GONE_AFTER.
  function drawGhosts(ms, px) {
    var j = scene.xInput.body, r = GHOST_SCALE * scene.bodies[j].radius, base = ctx.globalAlpha;
    var last = -1, newer = 0, shown = [];
    while (last + 1 < squares.length && squares[last + 1].phaseStart[RUN] <= ms) last++;
    if (last < 0) return;
    function arrived(i) { return clamp01((ms - squares[i].phaseStart[RUN]) * squares[i].speed / GHOST_FADE_MS); }
    var dim = Math.max(0, last - 1 + arrived(last)) / GHOSTS_GONE_AFTER;
    for (var i = last; i >= 0; i--) {
      var alpha = 1 - newer / GHOSTS_SHOWN - dim;
      if (alpha <= 0) break;
      if (squares[i].tier === 1) shown.push({ p: squares[i].frames[0][j], alpha: alpha });
      newer += arrived(i);
    }
    ctx.fillStyle = GHOST.fill;
    ctx.strokeStyle = GHOST.stroke;
    ctx.lineWidth = 2 * px;
    for (var k = shown.length - 1; k >= 0; k--) {
      ctx.globalAlpha = base * shown[k].alpha;
      ctx.beginPath();
      ctx.arc(shown[k].p.x, shown[k].p.y, r, 0, 2 * Math.PI);
      ctx.fill();
      ctx.stroke();
    }
    ctx.globalAlpha = base;
  }

  // Where the ball crossed: a disc of the key's color over it, with rings going out from it if asked.
  function drawSpot(p, radius, color, ms, px, rings) {
    ctx.lineWidth = 3 * px;
    for (var ring = 0; rings && ring < 2; ring++) {
      var u = (ms - 150 - 400 * ring) / 900;
      if (u < 0 || u > 1) continue;
      ctx.strokeStyle = "rgba(255,255,255," + (0.8 * (1 - u)).toFixed(3) + ")";
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius + SPOT_RING_PX * px * easeOut(u), 0, 2 * Math.PI);
      ctx.stroke();
    }
    ctx.fillStyle = color;
    ctx.strokeStyle = "#fff";
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius * overshoot(clamp01(ms / 350)), 0, 2 * Math.PI);
    ctx.fill();
    ctx.stroke();
  }

  // The scene fitted in rect: the frame (in its run's color as far as the fill has spread), the grid and key,
  // the runs' starts, the bodies, and the mark where the run crossed the edge. fade dims all but the color.
  function drawSim(rect, state, fade, ms) {
    var px = view.px, k = Math.min(rect.w / W, rect.h / H);
    var frameAt = [dpr * k, 0, 0, dpr * k, dpr * (rect.x + (rect.w - W * k) / 2), dpr * (rect.y + (rect.h - H * k) / 2)];
    var sq = state && state.square, edge = sq && sq.edge;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.w, rect.h);
    ctx.clip();
    ctx.fillStyle = state && state.fill >= 1 ? sq.color : FRAME_BG;
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    ctx.setTransform.apply(ctx, frameAt);
    if (state && state.fill > 0 && state.fill < 1 && edge) {
      ctx.fillStyle = sq.color;
      ctx.beginPath();
      ctx.arc(edge.x, edge.y, state.fill * Math.hypot(Math.max(edge.x, W - edge.x), Math.max(edge.y, H - edge.y)), 0, 2 * Math.PI);
      ctx.fill();
    }
    ctx.globalAlpha = fade;
    drawGrid(px);
    drawKeyBorder(px);
    drawGhosts(ms, px);
    scene.bodies.forEach(function (spec, j) {
      if (spec.isAnchored) drawBall(spec, spec, px, 1);
      else if (state) drawBall(spec, state.poses[j], px, state.grow);
    });
    ctx.restore();
    // Over the frame's edge, so outside its clip.
    if (state && state.spotMs >= 0 && edge) {
      ctx.save();
      ctx.setTransform.apply(ctx, frameAt);
      ctx.globalAlpha = fade;
      drawSpot(sq.final[output.body], scene.bodies[output.body].radius, sq.color, state.spotMs, px, sq.rings);
      ctx.restore();
    }
  }

  // The faint lines between a level's pixels.
  function drawLattice(L, alpha) {
    if (!(L.grid * alpha > 0)) return;
    var m = view.map, cell = m.w / COLUMNS;
    ctx.strokeStyle = "rgba(0,0,0," + (L.grid * alpha).toFixed(3) + ")";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var u = (L.ox + 0.5) % 1 * L.w; u < COLUMNS; u += L.w) {
      if (u > 0) { ctx.moveTo(m.x + u * cell, m.y); ctx.lineTo(m.x + u * cell, m.y + m.h); }
    }
    for (var v = (L.oy + 0.5) % 1 * L.h; v < ROWS; v += L.h) {
      if (v > 0) { ctx.moveTo(m.x, m.y + v * cell); ctx.lineTo(m.x + m.w, m.y + v * cell); }
    }
    ctx.stroke();
  }

  // A level's image scaled up a texel to a pixel, with white between pixels while they shrink to size.
  function drawLevelImage(level, size) {
    if (!levelImages[level]) work(function () { return !levelImages[level]; });
    var m = view.map, cell = m.w / COLUMNS, L = LEVELS[level], image = levelImages[level], d = L.w * cell;
    var gap = (L.w - size.w) * cell;
    ctx.save();
    ctx.beginPath();
    ctx.rect(m.x, m.y, m.w, m.h);
    ctx.clip();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(image, m.x - d / 2, m.y - d / 2, image.width * d, image.height * d);
    if (gap > 0) {
      ctx.fillStyle = "#fff";
      for (var i = 0; i + 1 < image.width; i++) ctx.fillRect(m.x + (i + 0.5) * d - gap / 2, m.y, gap, m.h);
      for (var j = 0; j + 1 < image.height; j++) ctx.fillRect(m.x, m.y + (j + 0.5) * d - gap / 2, m.w, gap);
    }
    ctx.restore();
  }

  // White until a run lands in a pixel, the pixels shrinking as each level halves them; the square whose turn it
  // is outlined, with a dot at its center while it runs. While a level shrinks, its pixels are the last level's.
  function drawMap(at, ms) {
    var m = view.map, cell = m.w / COLUMNS, level = levelAt(ms), size = pixelSize(level);
    var shownLevel = level.p < 1 ? level.level - 1 : level.level;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#fff";
    ctx.fillRect(m.x, m.y, m.w, m.h);
    if (shownLevel >= 2) {
      drawLevelImage(shownLevel, size);
    } else {
      pixels.forEach(function (p) {
        if (p.shownAt > ms) return;
        var r = pixelRect(p, size);
        ctx.fillStyle = p.color;
        ctx.fillRect(r.x, r.y, r.w, r.h);
      });
    }
    drawLattice(LEVELS[level.level], level.p);
    if (level.p < 1) drawLattice(LEVELS[level.level - 1], 1 - level.p);
    if (!at.square) return;
    var rect = pixelRect(at.square, LEVELS[at.square.level]);
    // The outline closes in on its square, and fades once the color is in.
    var grow = at.phase === OUTLINE ? 0.5 * cell * (1 - easeOut(at.t)) : 0;
    ctx.globalAlpha = at.phase === OUTLINE ? easeOut(at.t) : at.phase === UNHIGHLIGHT ? 1 - at.t : 1;
    ctx.strokeStyle = "rgba(0,0,0,0.8)";
    ctx.lineWidth = 6;
    ctx.strokeRect(rect.x - grow, rect.y - grow, rect.w + 2 * grow, rect.h + 2 * grow);
    ctx.strokeStyle = OUTLINE_COLOR;
    ctx.lineWidth = 3;
    ctx.strokeRect(rect.x - grow, rect.y - grow, rect.w + 2 * grow, rect.h + 2 * grow);
    if (at.square.tier === 1 && at.phase >= SPAWN && at.phase < FLY) {
      ctx.globalAlpha = at.phase === SPAWN ? at.t : 1;
      ctx.fillStyle = BODY.fill;
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(m.x + at.square.u * cell, m.y + at.square.v * cell, 4, 0, 2 * Math.PI);
      ctx.fill();
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // The finished run shrinking from the left into its square, its drawing fading to leave the color.
  function drawFlight(state, t, ms) {
    var from = view.sim, to = pixelRect(state.square, LEVELS[state.square.level]), e = easeInOut(t);
    var w = from.w * Math.pow(to.w / from.w, e), h = from.h * Math.pow(to.h / from.h, e);
    var x = from.x + from.w / 2 + (to.x + to.w / 2 - from.x - from.w / 2) * e - w / 2;
    var y = from.y + from.h / 2 + (to.y + to.h / 2 - from.y - from.h / 2) * e - h / 2;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.shadowColor = "rgba(0,0,0," + (0.6 * Math.sin(Math.PI * e)).toFixed(3) + ")";
    ctx.shadowBlur = 30 * dpr;
    ctx.shadowOffsetY = 8 * dpr;
    ctx.fillStyle = state.square.color;
    ctx.fillRect(x, y, w, h);
    ctx.restore();
    drawSim({ x: x, y: y, w: w, h: h }, state, 1 - smooth(clamp01((t - 0.1) / 0.6)), ms);
  }

  function render(ms) {
    var at = locate(ms), state = runState(at, ms), flying = state && at.phase === FLY;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = LETTERBOX_BG;
    ctx.fillRect(0, 0, view.width, view.height);
    ctx.fillStyle = PAGE_BG;
    ctx.fillRect(view.stage.x, view.stage.y, view.stage.w, view.stage.h);
    drawSim(view.sim, flying ? null : state, 1, ms);
    drawMap(at, ms);
    if (flying) drawFlight(state, at.t, ms);
  }

  // ---- Stepping ----

  // Each click or space press plays on to the next stop: for each of the first two squares the outline, the run,
  // the color, the move to the map; then the rest of level 0; the shrink to level 1, then its squares; then each
  // level after, a shrink and its pixels at once. Presses while it plays are ignored.
  var stops = [];
  squares.slice(0, 2).forEach(function (sq) {
    stops.push(sq.phaseStart[SPAWN], sq.phaseStart[POINT], sq.phaseStart[FLY], sq.end);
  });
  stops.push(fullAt[0], fullAt[0] + SHRINK_MS, fullAt[1]);
  stops.push.apply(stops, fullAt.slice(2));

  // The clock holds through hidden tabs and long frames, so no square is skipped.
  var clock = -1, stopIndex = -1, lastFrame = 0, playing = false;
  function frame(now) {
    clock = Math.min(stops[stopIndex], Math.max(0, clock) + Math.min(100, now - lastFrame));
    lastFrame = now;
    render(clock);
    if (clock < stops[stopIndex]) requestAnimationFrame(frame);
    else playing = false;
  }
  function advance() {
    if (playing || stopIndex === stops.length - 1) return;
    stopIndex++;
    playing = true;
    lastFrame = performance.now();
    requestAnimationFrame(frame);
  }
  canvas.addEventListener("click", advance);
  document.addEventListener("keydown", function (e) {
    // x jumps to the end.
    if ((e.key === "x" || e.key === "X") && !e.metaKey && !e.ctrlKey) {
      stopIndex = stops.length - 1;
      clock = stops[stopIndex];
      render(clock);
      return;
    }
    if (e.key !== " ") return;
    e.preventDefault();
    if (!e.repeat) advance();
  });
  window.addEventListener("resize", function () {
    measure();
    render(clock);
  });
  measure();
  render(-1);
  workInBackground();
})();
