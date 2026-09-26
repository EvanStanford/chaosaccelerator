// CPAL-1.0 License. See chaosaccelerator.com/license.html

// Regression suite for PhysicsEngine / PhysicsGPU / PhysicsHingeGeometry /
// PhysicsGridCodegen. Each test reproduces a bug that was found and fixed.
(function () {
  "use strict";

  var DT = 1 / 60;
  var TESTS = [];

  function addTest(name, bugRef, fn) {
    TESTS.push({ name: name, bugRef: bugRef, fn: fn });
  }

  function dist(ax, ay, bx, by) { return Math.hypot(bx - ax, by - ay); }

  // World point of a hinge's bodyA side (bodyA === null: fixed world pin).
  function worldHingePointA(hinge, bodies) {
    if (hinge.bodyA === null) return { x: hinge.localAnchorA.x, y: hinge.localAnchorA.y };
    var bodyA = bodies[hinge.bodyA];
    var rA = PhysicsEngine.rotateVec(hinge.localAnchorA, bodyA.angle);
    return { x: bodyA.x + rA.x, y: bodyA.y + rA.y };
  }

  function jointGap(hinge, bodies) {
    var wa = worldHingePointA(hinge, bodies);
    var wb = PhysicsEngine.getHingeWorldPoint(hinge, bodies);
    return dist(wa.x, wa.y, wb.x, wb.y);
  }

  function runJS(scene, steps) {
    for (var i = 0; i < steps; i++) PhysicsEngine.step(scene, DT);
    return scene;
  }

  // ---- 0. A JSON-round-tripped scene has no mass fields ----
  addTest(
    "A JSON-round-tripped scene needs computeMass before it can be stepped",
    "PhysicsEngine.cloneScene doesn't compute mass; serializeScene() doesn't include it",
    function () {
      // Needs a hinge: only the hinge solver multiplies invMass/invInertia.
      var authored = {
        bodies: [{ type: "circle", x: 500, y: 300, angle: 0, isAnchored: false, radius: 50, vx: 0, vy: 0, w: 0 }],
        hinges: [{ bodyA: null, bodyB: 0, localAnchorA: { x: 500, y: 300 }, localAnchorB: { x: 0, y: 0 } }],
      };
      var scene = JSON.parse(JSON.stringify(authored)); // simulates serializeScene() -> JSON -> JSON.parse
      var missingMassFields = scene.bodies[0].invMass === undefined;

      var beforeFix = PhysicsEngine.cloneScene(scene);
      PhysicsEngine.step(beforeFix, DT);
      var wentToNaN = isNaN(beforeFix.bodies[0].y);

      var afterFix = PhysicsEngine.cloneScene(scene);
      afterFix.bodies.forEach(PhysicsEngine.computeMass);
      PhysicsEngine.step(afterFix, DT);
      var staysFinite = isFinite(afterFix.bodies[0].y);

      var detail = "round-tripped body missing invMass: " + missingMassFields +
        "; stepping without computeMass -> y=" + beforeFix.bodies[0].y + " (NaN, as expected without the fix)" +
        "; stepping WITH computeMass -> y=" + afterFix.bodies[0].y.toFixed(3) + " (finite, correct)";
      return { pass: missingMassFields && wentToNaN && staysFinite, detail: detail };
    }
  );

  // ---- 1. Tunneling: a fast fall must not pass clean through a thin line ----
  addTest(
    "Fast fall doesn't tunnel through a thin line",
    "MAX_SPEED cap + LINE_THICKNESS bump",
    function () {
      // Falls at the speed cap, so each step covers more than the line is thick.
      var ball = PhysicsEngine.createCircle(400, -400, 20, false);
      ball.vy = PhysicsEngine.MAX_SPEED;
      var scene = {
        bodies: [
          PhysicsEngine.createLine(400, 600, 700, 0, true),
          ball,
        ],
        hinges: [],
      };
      var deepestY = -Infinity;
      for (var i = 0; i < 400; i++) {
        PhysicsEngine.step(scene, DT);
        deepestY = Math.max(deepestY, scene.bodies[1].y);
      }
      var surfaceY = 600 - PhysicsEngine.LINE_THICKNESS / 2 - ball.radius;
      var stepTravel = PhysicsEngine.MAX_SPEED * DT;
      var detail = "at " + stepTravel.toFixed(1) + "px per step against a " + PhysicsEngine.LINE_THICKNESS +
        "px-thick line: deepest y=" + deepestY.toFixed(2) + ", surface contact at y=" + surfaceY.toFixed(2) +
        " (a tunnel would carry it past y=600)";
      return { pass: deepestY < surfaceY + 3 && deepestY > surfaceY - 2 * stepTravel, detail: detail };
    }
  );

  addTest(
    "Anchoring a body clears its starting velocity, so nothing bounces off it like a moving wall",
    "computeMass left vx/vy/w on a body anchored after Set Velocity; velocityAt still read them in the contact solver",
    function () {
      // Velocity first, then anchor: the order the builder produces.
      var line = PhysicsEngine.createLine(400, 600, 700, 0, false);
      line.vx = 300; line.vy = -PhysicsEngine.MAX_SPEED; line.w = 2;
      line.isAnchored = true;
      PhysicsEngine.computeMass(line);
      var cleared = line.vx === 0 && line.vy === 0 && line.w === 0;

      // Off a truly static wall the ball can never rise above where it started.
      var startY = 400;
      var ball = PhysicsEngine.createCircle(400, startY, 20, false);
      var scene = { bodies: [line, ball], hinges: [] };
      var highestY = Infinity;
      for (var i = 0; i < 400; i++) {
        PhysicsEngine.step(scene, DT);
        highestY = Math.min(highestY, ball.y);
      }
      var detail = "after anchoring: vx=" + line.vx + " vy=" + line.vy + " w=" + line.w +
        "; ball dropped from y=" + startY + " rose back to y=" + highestY.toFixed(2) + " at highest";
      return { pass: cleared && highestY >= startY - 1, detail: detail };
    }
  );

  addTest(
    "A fast circle no longer tunnels through a smaller circle it's aimed straight at",
    "collideCircleCircle had no continuous collision detection: a same-step start/end sample (dist=10, then dist=6.67) can both read as 'not touching' (rsum=6) even though the straight path passes through dist=0 in between",
    function () {
      var scene = {
        bodies: [
          PhysicsEngine.createCircle(0, 300, 3, false),
          PhysicsEngine.createCircle(10, 300, 3, true),
        ],
        hinges: [],
      };
      scene.bodies[0].vx = 1000; // 1000/60 = 16.67px this step, well past the 4px gap between the two rims
      PhysicsEngine.step(scene, DT);
      var ball = scene.bodies[0];
      var bounced = ball.vx < 0 && ball.x < 10;
      var detail = "after 1 step: x=" + ball.x.toFixed(3) + ", vx=" + ball.vx.toFixed(3) + " (want vx<0 and x<10: bounced back, didn't pass through to x=16.67 with vx still 1000)";
      return { pass: bounced, detail: detail };
    }
  );

  addTest(
    "GPU compiler agrees with JS for the same tunneling case",
    "collideCircleCircle's continuous collision detection (GLSL port)",
    function () {
      var scene = {
        bodies: [
          PhysicsEngine.createCircle(0, 300, 3, false),
          PhysicsEngine.createCircle(10, 300, 3, true),
        ],
        hinges: [],
      };
      scene.bodies[0].vx = 1000;
      var jsScene = PhysicsEngine.cloneScene(scene);
      jsScene.bodies.forEach(PhysicsEngine.computeMass);
      PhysicsEngine.step(jsScene, DT);
      var traj = PhysicsGPU.runSceneOnGPU(scene, 1);
      var err = dist(jsScene.bodies[0].x, jsScene.bodies[0].y, traj[0][0].x, traj[0][0].y);
      var detail = "js x=" + jsScene.bodies[0].x.toFixed(4) + ", gpu x=" + traj[0][0].x.toFixed(4) + ", position error=" + err.toFixed(5) + "px";
      return { pass: err < 0.01, detail: detail };
    }
  );

  addTest(
    "CCD: sweeping a grazing circle-circle collision's starting position no longer jumps",
    "collideCircleCircle: which discrete step first noticed contact used to flip abruptly as starting X swept past ~442.35, producing a ~267px discontinuity in the resulting bounce (a real user-reported scene: a ball falling onto an anchored circle)",
    function () {
      function finalXAt(startX) {
        var scene = {
          bodies: [
            PhysicsEngine.createCircle(startX, 100, 20, false),
            PhysicsEngine.createCircle(500, 400, 40, true),
          ],
          hinges: [],
        };
        runJS(scene, 200);
        return scene.bodies[0].x;
      }
      // Exactly the 442.0-442.6 window of the original report: a wider sweep would
      // also hit RESTITUTION_THRESHOLD's own (unrelated, still-unfixed) discontinuity.
      var xs = [];
      for (var x = 442.0; x <= 442.6; x += 0.1) xs.push(Math.round(x * 10) / 10);
      var maxJump = 0, jumpAt = null;
      var prev = finalXAt(xs[0]);
      for (var i = 1; i < xs.length; i++) {
        var cur = finalXAt(xs[i]);
        var jump = Math.abs(cur - prev);
        if (jump > maxJump) { maxJump = jump; jumpAt = xs[i]; }
        prev = cur;
      }
      var detail = "max adjacent-sample (0.1px apart) change across x=442.0-442.6=" + maxJump.toFixed(2) +
        "px at x=" + jumpAt + " (want <20px, before this fix, x=442.3->442.4 alone jumped ~267px)";
      return { pass: maxJump < 20, detail: detail };
    }
  );

  // ---- 2. Line-line contact: a flat rod must land on both ends at once ----
  addTest(
    "A rod dropped flat onto flat ground bounces without starting to spin",
    "2-point contact for near-parallel lines",
    function () {
      var scene = {
        bodies: [
          PhysicsEngine.createLine(400, 600, 700, 0, true),
          PhysicsEngine.createLine(400, 550, 300, 0, false),
        ],
        hinges: [],
      };
      // Contacts are elastic so the rod keeps bouncing; it must land on both ends
      // at once, since a single off-center contact impulse is what spun rods.
      var maxAngle = 0, maxW = 0;
      for (var i = 0; i < 900; i++) {
        PhysicsEngine.step(scene, DT);
        maxAngle = Math.max(maxAngle, Math.abs(scene.bodies[1].angle));
        maxW = Math.max(maxW, Math.abs(scene.bodies[1].w));
      }
      var maxAngleDeg = maxAngle * 180 / Math.PI;
      var detail = "over 900 steps: max angle=" + maxAngleDeg.toFixed(3) + "deg, max angular vel=" + maxW.toFixed(4) + "rad/s";
      return { pass: maxAngleDeg < 2 && maxW < 0.1, detail: detail };
    }
  );

  // ---- 3. Hinge exclusion: double pendulum swings freely, joints don't drift (JS and GPU) ----
  function buildDoublePendulum() {
    return {
      bodies: [
        PhysicsEngine.createLine(475, 300, 150, 0, false),
        PhysicsEngine.createLine(625, 300, 150, 0, false),
      ],
      hinges: [
        { bodyA: null, bodyB: 0, localAnchorA: { x: 400, y: 300 }, localAnchorB: { x: -75, y: 0 } },
        { bodyA: 0, bodyB: 1, localAnchorA: { x: 75, y: 0 }, localAnchorB: { x: -75, y: 0 } },
      ],
    };
  }

  addTest(
    "Double pendulum: JS joints stay together over a long, chaotic run",
    "hinge-connected bodies excluded from normal collision",
    function () {
      var scene = buildDoublePendulum();
      var early = null, late = null;
      for (var i = 1; i <= 1200; i++) {
        PhysicsEngine.step(scene, DT);
        if (i === 100) early = { x: scene.bodies[1].x, y: scene.bodies[1].y };
        if (i === 1200) late = { x: scene.bodies[1].x, y: scene.bodies[1].y };
      }
      var gap0 = jointGap(scene.hinges[0], scene.bodies);
      var gap1 = jointGap(scene.hinges[1], scene.bodies);
      var moved = dist(early.x, early.y, late.x, late.y);
      var detail = "joint gaps=" + gap0.toFixed(4) + "px/" + gap1.toFixed(4) + "px, body1 moved " + moved.toFixed(1) + "px between step 100 and 1200";
      return { pass: gap0 < 1 && gap1 < 1 && moved > 15, detail: detail };
    }
  );

  addTest(
    "Double pendulum: GPU joints stay together over a long, chaotic run",
    "hinge-connected bodies excluded from normal collision (GLSL)",
    function () {
      var scene = buildDoublePendulum();
      var traj = PhysicsGPU.runSceneOnGPU(scene, 1200);
      var early = traj[99][1], late = traj[1199][1];
      var gap0 = jointGap(scene.hinges[0], traj[1199]);
      var gap1 = jointGap(scene.hinges[1], traj[1199]);
      var moved = dist(early.x, early.y, late.x, late.y);
      var detail = "joint gaps=" + gap0.toFixed(4) + "px/" + gap1.toFixed(4) + "px, body1 moved " + moved.toFixed(1) + "px between step 100 and 1200";
      return { pass: gap0 < 1 && gap1 < 1 && moved > 15, detail: detail };
    }
  );

  // ---- 4. Generated GLSL must compile across a range of scene shapes ----
  addTest(
    "Generated GLSL compiles for varied scene shapes",
    "missing #version/precision/fragColor; illegal global initializers",
    function () {
      var scenes = [
        {
          name: "3 bodies, all colliding, no hinges",
          scene: {
            bodies: [
              PhysicsEngine.createLine(400, 560, 700, 0, true),
              PhysicsEngine.createCircle(270, 150, 30, false),
              PhysicsEngine.createLine(530, 150, 140, 0.3, false),
            ],
            hinges: [],
          },
        },
        {
          name: "6 bodies (MAX_BODIES), mixed world + body hinges",
          scene: {
            bodies: [
              PhysicsEngine.createLine(400, 300, 150, 0, false),
              PhysicsEngine.createCircle(600, 300, 30, false),
              PhysicsEngine.createLine(400, 500, 100, 0, true),
              PhysicsEngine.createCircle(200, 200, 20, false),
              PhysicsEngine.createCircle(700, 500, 25, false),
              PhysicsEngine.createCircle(650, 300, 20, false),
            ],
            hinges: [
              { bodyA: null, bodyB: 0, localAnchorA: { x: 325, y: 300 }, localAnchorB: { x: -75, y: 0 } },
              { bodyA: 0, bodyB: 1, localAnchorA: { x: 75, y: 0 }, localAnchorB: { x: 0, y: 0 } },
              { bodyA: 1, bodyB: 5, localAnchorA: { x: 30, y: 0 }, localAnchorB: { x: -20, y: 0 } },
            ],
          },
        },
        {
          name: "3-body hinge chain, zero collision pairs",
          scene: {
            bodies: [
              PhysicsEngine.createCircle(400, 300, 20, false),
              PhysicsEngine.createCircle(450, 300, 20, false),
              PhysicsEngine.createCircle(500, 300, 20, false),
            ],
            hinges: [
              { bodyA: null, bodyB: 0, localAnchorA: { x: 400, y: 300 }, localAnchorB: { x: 0, y: 0 } },
              { bodyA: 0, bodyB: 1, localAnchorA: { x: 0, y: 0 }, localAnchorB: { x: 0, y: 0 } },
              { bodyA: 1, bodyB: 2, localAnchorA: { x: 0, y: 0 }, localAnchorB: { x: 0, y: 0 } },
            ],
          },
        },
      ];
      var details = [];
      var pass = true;
      scenes.forEach(function (s) {
        try {
          var traj = PhysicsGPU.runSceneOnGPU(s.scene, 5);
          var ok = traj.length === 5 && traj[0].length === s.scene.bodies.length &&
            traj.every(function (row) { return row.every(function (b) { return isFinite(b.x) && isFinite(b.y) && isFinite(b.angle); }); });
          if (!ok) pass = false;
          details.push(s.name + ": " + (ok ? "ok" : "bad trajectory shape"));
        } catch (err) {
          pass = false;
          details.push(s.name + ": THREW " + (err.message || err));
        }
      });
      return { pass: pass, detail: details.join("; ") };
    }
  );

  // ---- 5. Off-by-one in trajectory step indexing ----
  addTest(
    "GPU trajectory row 0 is the state after exactly 1 step",
    "stepTarget off-by-one",
    function () {
      var scene = {
        bodies: [PhysicsEngine.createCircle(100, 100, 20, false)],
        hinges: [],
      };
      var N = 5;
      var traj = PhysicsGPU.runSceneOnGPU(scene, N);
      var y = 100, vy = 0;
      var expected = [];
      for (var s = 0; s < N; s++) { vy += PhysicsEngine.GRAVITY * DT; y += vy * DT; expected.push(y); }
      var maxErr = 0, xDrift = 0;
      for (var i = 0; i < N; i++) {
        maxErr = Math.max(maxErr, Math.abs(traj[i][0].y - expected[i]));
        xDrift = Math.max(xDrift, Math.abs(traj[i][0].x - 100));
      }
      var detail = "trajectory length=" + traj.length + " (expected " + N + "), max y error vs hand-derived=" + maxErr.toFixed(5) + "px, x drift=" + xDrift.toFixed(5) + "px";
      return { pass: traj.length === N && maxErr < 0.02 && xDrift < 0.001, detail: detail };
    }
  );

  // ---- 6. JS and GPU must agree on ordinary (non-chaotic) physics ----
  addTest(
    "JS engine and GPU compiler agree step-by-step",
    "keeps physics-engine.js and the GLSL port in lockstep",
    function () {
      function buildScene() {
        return {
          bodies: [
            PhysicsEngine.createLine(400, 560, 700, 0, true),
            PhysicsEngine.createCircle(270, 150, 30, false),
            PhysicsEngine.createLine(530, 150, 140, 0.3, false),
          ],
          hinges: [],
        };
      }
      var jsScene = buildScene();
      var gpuScene = buildScene();
      var checkpoints = [1, 10, 40, 100];
      var maxSteps = checkpoints[checkpoints.length - 1];
      var traj = PhysicsGPU.runSceneOnGPU(gpuScene, maxSteps);

      var maxPosErr = 0, maxAngleErr = 0;
      var stepped = 0;
      checkpoints.forEach(function (target) {
        while (stepped < target) { PhysicsEngine.step(jsScene, DT); stepped++; }
        var row = traj[target - 1];
        for (var b = 0; b < jsScene.bodies.length; b++) {
          maxPosErr = Math.max(maxPosErr, Math.abs(jsScene.bodies[b].x - row[b].x), Math.abs(jsScene.bodies[b].y - row[b].y));
          maxAngleErr = Math.max(maxAngleErr, Math.abs(jsScene.bodies[b].angle - row[b].angle));
        }
      });
      var detail = "checked steps " + checkpoints.join(",") + " - max position error=" + maxPosErr.toFixed(4) + "px, max angle error=" + maxAngleErr.toFixed(5) + "rad";
      return { pass: maxPosErr < 0.2 && maxAngleErr < 0.01, detail: detail };
    }
  );

  // ---- 7. Heavy/large hinged body must not free-fall (degenerate 2x2 matrix) ----
  function buildHeavyHingedCircle() {
    return {
      bodies: [PhysicsEngine.createCircle(500, 300, 130, false)],
      hinges: [{ bodyA: null, bodyB: 0, localAnchorA: { x: 499, y: 299 }, localAnchorB: { x: -1, y: -1 } }],
    };
  }

  addTest(
    "Heavy circle hinged near its center holds (JS)",
    "solve2x2 absolute-epsilon-on-determinant bug",
    function () {
      var scene = buildHeavyHingedCircle();
      var startPoint = worldHingePointA(scene.hinges[0], scene.bodies);
      runJS(scene, 1500);
      var gap = jointGap(scene.hinges[0], scene.bodies);
      var detail = "hinge-point gap after 1500 steps=" + gap.toFixed(4) + "px (pivot=" + startPoint.x + "," + startPoint.y + ")";
      return { pass: gap < 2, detail: detail };
    }
  );

  addTest(
    "Heavy circle hinged near its center holds (GPU)",
    "solve2x2 absolute-epsilon-on-determinant bug (GLSL)",
    function () {
      var scene = buildHeavyHingedCircle();
      var traj = PhysicsGPU.runSceneOnGPU(scene, 1500);
      var gap = jointGap(scene.hinges[0], traj[1499]);
      var detail = "hinge-point gap after 1500 steps=" + gap.toFixed(4) + "px";
      return { pass: gap < 2, detail: detail };
    }
  );

  // ---- Milestone 2: physics-grid-codegen.js (per-pixel offset+cascade in GLSL) ----
  // Every scene reuses a scenario verified against PhysicsHingeGeometry directly.

  // Compiles the codegen's declaration lines into a one-sample debug shader and
  // reads back every body's (x, y, angle) at a fixed (worldX, worldY).
  function runGridCodegenAtPoint(scene, worldX, worldY) {
    var result = PhysicsGridCodegen.generateGridInitialStateGLSL(scene);
    var n = result.n;
    var outputs = [];
    for (var i = 0; i < n; i++) {
      outputs.push((i === 0 ? "  if" : "  else if") + " (idx == " + i + ") outVal = vec3(" +
        result.bodyState[i].x + ", " + result.bodyState[i].y + ", " + result.bodyState[i].angle + ");");
    }
    var fs = [
      "#version 300 es",
      "precision highp float;",
      "out vec4 fragColor;",
      "",
      PhysicsGPU.libraryGLSL("f32", PhysicsEngine.speedCapFor(scene)),
      "",
      "void main() {",
      "  float worldX = " + PhysicsGPU.fnum(worldX) + ";",
      "  float worldY = " + PhysicsGPU.fnum(worldY) + ";",
      result.declarationLines.map(function (l) { return "  " + l; }).join("\n"),
      "  int idx = int(gl_FragCoord.x);",
      "  vec3 outVal = vec3(0.0);",
      outputs.join("\n"),
      "  fragColor = vec4(outVal, 1.0);",
      "}",
    ].join("\n");

    var canvas = new OffscreenCanvas(n, 1);
    var gl = canvas.getContext("webgl2");
    if (!gl.getExtension("EXT_color_buffer_float")) throw new Error("EXT_color_buffer_float unavailable");
    var vs = PhysicsGPU.compileShader(gl, gl.VERTEX_SHADER, PhysicsGPU.VERTEX_SOURCE);
    var fsCompiled = PhysicsGPU.compileShader(gl, gl.FRAGMENT_SHADER, fs);
    var program = PhysicsGPU.linkProgram(gl, vs, fsCompiled);
    gl.useProgram(program);
    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    var posLoc = gl.getAttribLocation(program, "a_position");
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, n, 1, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    var fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.viewport(0, 0, n, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    var pixels = new Float32Array(n * 4);
    gl.readPixels(0, 0, n, 1, gl.RGBA, gl.FLOAT, pixels);

    var loseCtx = gl.getExtension("WEBGL_lose_context");
    if (loseCtx) loseCtx.loseContext();

    var bodies = [];
    for (var b = 0; b < n; b++) bodies.push({ x: pixels[b * 4], y: pixels[b * 4 + 1], angle: pixels[b * 4 + 2] });
    return bodies;
  }

  // Like runGridCodegenAtPoint but also runs the shared stepOnce loop `steps`
  // times first: fractal-grid.js's actual shader shape.
  function runGridSimulationAtPoint(scene, steps, worldX, worldY) {
    var initial = PhysicsGridCodegen.generateGridInitialStateGLSL(scene);
    var n = initial.n;
    var stepOnceSrc = PhysicsGPU.generateStepOnceGLSL(n, initial.consts, initial.pairs, initial.hingeAnchors);
    var stepCall = "stepOnce(" + PhysicsGPU.stepOnceCallArgs(n, initial.hingeAnchors) + ");";
    var outputs = [];
    for (var i = 0; i < n; i++) {
      outputs.push((i === 0 ? "  if" : "  else if") + " (idx == " + i + ") outVal = vec3(body" + i + ".x, body" + i + ".y, body" + i + ".angle);");
    }
    var fs = [
      "#version 300 es", "precision highp float;", "out vec4 fragColor;", "",
      PhysicsGPU.libraryGLSL("f32", PhysicsEngine.speedCapFor(scene)), "",
      stepOnceSrc, "",
      "void main() {",
      "  float worldX = " + PhysicsGPU.fnum(worldX) + ";",
      "  float worldY = " + PhysicsGPU.fnum(worldY) + ";",
      initial.declarationLines.map(function (l) { return "  " + l; }).join("\n"),
      "  " + PhysicsGridCodegen.generateCanonicalBodyDeclarationsGLSL(initial).split("\n").join("\n  "),
      "  " + PhysicsGPU.generateHingeAnchorLocalsGLSL(initial.hingeAnchors).split("\n").join("\n  "),
      "  for (int i = 0; i < " + steps + "; i++) { " + stepCall + " }",
      "  int idx = int(gl_FragCoord.x);",
      "  vec3 outVal = vec3(0.0);",
      outputs.join("\n"),
      "  fragColor = vec4(outVal, 1.0);",
      "}",
    ].join("\n");

    var canvas = new OffscreenCanvas(n, 1);
    var gl = canvas.getContext("webgl2");
    if (!gl.getExtension("EXT_color_buffer_float")) throw new Error("EXT_color_buffer_float unavailable");
    var vs = PhysicsGPU.compileShader(gl, gl.VERTEX_SHADER, PhysicsGPU.VERTEX_SOURCE);
    var fsCompiled = PhysicsGPU.compileShader(gl, gl.FRAGMENT_SHADER, fs);
    var program = PhysicsGPU.linkProgram(gl, vs, fsCompiled);
    gl.useProgram(program);
    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    var posLoc = gl.getAttribLocation(program, "a_position");
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, n, 1, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    var fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.viewport(0, 0, n, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    var pixels = new Float32Array(n * 4);
    gl.readPixels(0, 0, n, 1, gl.RGBA, gl.FLOAT, pixels);

    var loseCtx = gl.getExtension("WEBGL_lose_context");
    if (loseCtx) loseCtx.loseContext();

    var bodies = [];
    for (var b = 0; b < n; b++) bodies.push({ x: pixels[b * 4], y: pixels[b * 4 + 1], angle: pixels[b * 4 + 2] });
    return bodies;
  }

  addTest(
    "Grid codegen + step loop matches the JS reference (early steps)",
    "fractal-grid.js's shader shape: offset -> canonical Body structs -> stepOnce loop",
    function () {
      // Early steps only: a hinged body's ANGLE drifts out of phase between JS
      // (float64) and GPU (float32) long before its position does. The hinge
      // over a full run is checked by joint gap in the next test.
      var scene = {
        bodies: [PhysicsEngine.createCircle(500, 300, 50, false)],
        hinges: [{ bodyA: null, bodyB: 0, localAnchorA: { x: 502, y: 300 }, localAnchorB: { x: 2, y: 0 } }],
        xInput: { body: 0, property: "radius" },
        yInput: null,
        output: { body: 0, property: "angle" },
      };
      var STEPS = 5, WORLD_X = 20;
      var jsScene = PhysicsEngine.cloneScene(scene);
      // Hinge-preserving resize (radius 50->70 rescales the anchor 2->2.8, then
      // recenter on the pivot): otherwise the JS reference starts constraint-violating.
      jsScene.bodies[0].radius = 70;
      PhysicsEngine.computeMass(jsScene.bodies[0]);
      jsScene.bodies[0].x = 502 - 2.8;
      jsScene.bodies[0].y = 300;
      jsScene.hinges[0].localAnchorB.x = 2.8; // the rescaled anchor itself, not just the body position it implies
      for (var i = 0; i < STEPS; i++) PhysicsEngine.step(jsScene, PhysicsGPU.FIXED_DT);

      var gpuBodies = runGridSimulationAtPoint(scene, STEPS, WORLD_X, 0);
      var posErr = Math.max(Math.abs(gpuBodies[0].x - jsScene.bodies[0].x), Math.abs(gpuBodies[0].y - jsScene.bodies[0].y));
      var angleErr = Math.abs(gpuBodies[0].angle - jsScene.bodies[0].angle);
      var detail = "after " + STEPS + " steps: position error=" + posErr.toFixed(4) + "px, angle error=" + angleErr.toFixed(5) + "rad " +
        "(js angle=" + jsScene.bodies[0].angle.toFixed(4) + ", gpu angle=" + gpuBodies[0].angle.toFixed(4) + ")";
      return { pass: posErr < 0.01 && angleErr < 0.001, detail: detail };
    }
  );

  addTest(
    "Grid codegen + step loop: hinge stays satisfied over a full 500-step run",
    "fractal-grid.js's shader shape: self-consistency, not cross-implementation phase",
    function () {
      var hinge = { bodyA: null, bodyB: 0, localAnchorA: { x: 502, y: 300 }, localAnchorB: { x: 2, y: 0 } };
      var scene = {
        bodies: [PhysicsEngine.createCircle(500, 300, 50, false)],
        hinges: [hinge],
        xInput: { body: 0, property: "radius" },
        yInput: null,
        output: { body: 0, property: "angle" },
      };
      var STEPS = 500;
      var bodies = runGridSimulationAtPoint(scene, STEPS, 20, 0);
      // The anchor rescales with the resize (2 -> 2.8), so the gap check needs it too.
      var rescaledHinge = { bodyA: null, bodyB: 0, localAnchorA: hinge.localAnchorA, localAnchorB: { x: 2.8, y: 0 } };
      var gap = jointGap(rescaledHinge, bodies);
      var detail = "hinge gap after " + STEPS + " steps=" + gap.toFixed(3) + "px (final angle=" + bodies[0].angle.toFixed(2) + "rad, proving real motion occurred)";
      return { pass: gap < 1, detail: detail };
    }
  );

  addTest(
    "Grid codegen: numeric offset scene (instant JS preview) matches the GLSL path",
    "physics-grid-codegen.js computeOffsetSceneNumeric vs. generateGridInitialStateGLSL: a third independent path to the same answer",
    function () {
      // Same scenario as the "resize-link cascade" test: three routes to one answer.
      var scene = {
        bodies: [
          PhysicsEngine.createLine(500, 300, 200, 0, false),
          PhysicsEngine.createCircle(650, 300, 30, false),
        ],
        hinges: [
          { bodyA: null, bodyB: 0, localAnchorA: { x: 400, y: 300 }, localAnchorB: { x: -100, y: 0 } },
          { bodyA: 0, bodyB: 1, localAnchorA: { x: 100, y: 0 }, localAnchorB: { x: 0, y: 0 } },
        ],
        xInput: { body: 0, property: "length" },
        yInput: null,
      };
      var result = PhysicsGridCodegen.computeOffsetSceneNumeric(scene, 200, 0);
      var body0Ok = Math.abs(result.bodies[0].x - 600) < 1e-9 && Math.abs(result.bodies[0].y - 300) < 1e-9;
      var body1Ok = Math.abs(result.bodies[1].x - 850) < 1e-9 && Math.abs(result.bodies[1].y - 300) < 1e-9;
      var detail = "body0=" + result.bodies[0].x + "," + result.bodies[0].y + " (want 600,300); body1=" +
        result.bodies[1].x + "," + result.bodies[1].y + " (want 850,300)";
      return { pass: body0Ok && body1Ok, detail: detail };
    }
  );

  addTest(
    "Hover-replay compiler: logged trajectory matches the JS reference",
    "physics-grid-codegen.js compileHoverTrajectoryGLSL: the same offset math as the grid, but with per-step logging on",
    function () {
      // Same scenario as the plain grid codegen test, so any mismatch is the logging.
      var hinge0 = { bodyA: null, bodyB: 0, localAnchorA: { x: 400, y: 300 }, localAnchorB: { x: -100, y: 0 } };
      var hinge1 = { bodyA: 0, bodyB: 1, localAnchorA: { x: 100, y: 0 }, localAnchorB: { x: 0, y: 0 } };
      var scene = {
        bodies: [
          PhysicsEngine.createLine(500, 300, 200, 0, false),
          PhysicsEngine.createCircle(650, 300, 30, false),
        ],
        hinges: [hinge0, hinge1],
        xInput: { body: 0, property: "length" },
        yInput: null,
        output: { body: 0, property: "angle" },
      };
      var N = 5;
      var compiled = PhysicsGridCodegen.compileHoverTrajectoryGLSL(scene, 200, 0, N);
      var trajectory = PhysicsGPU.runCompiledTrajectoryOnGPU(compiled, N);

      // Length 200 -> 400 (worldX=200), recentered.
      var jsScene = PhysicsEngine.cloneScene(scene);
      jsScene.bodies[0].length = 400;
      PhysicsEngine.computeMass(jsScene.bodies[0]);
      jsScene.bodies[0].x = 600;
      jsScene.bodies[0].y = 300;
      jsScene.hinges[0].localAnchorB.x = -200;
      jsScene.hinges[1].localAnchorA.x = 200;
      jsScene.bodies[1].x = 850;
      jsScene.bodies[1].y = 300;

      var maxErr = 0;
      var perStepDetail = [];
      for (var s = 1; s <= N; s++) {
        PhysicsEngine.step(jsScene, DT);
        var row = trajectory[s - 1];
        var err = Math.max(
          Math.abs(row[0].x - jsScene.bodies[0].x), Math.abs(row[0].y - jsScene.bodies[0].y),
          Math.abs(row[1].x - jsScene.bodies[1].x), Math.abs(row[1].y - jsScene.bodies[1].y)
        );
        maxErr = Math.max(maxErr, err);
        perStepDetail.push("step" + s + "=" + err.toFixed(4));
      }
      var detail = "trajectory length=" + trajectory.length + " (want " + N + "), max position error across all " + N + " logged rows=" + maxErr.toFixed(4) + "px [" + perStepDetail.join(", ") + "]";
      return { pass: trajectory.length === N && maxErr < 0.01, detail: detail };
    }
  );

  addTest(
    "Grid codegen: resize-link cascade matches the editor exactly",
    "physics-grid-codegen.js port of applyBodyEditPreservingHinge",
    function () {
      var scene = {
        bodies: [
          PhysicsEngine.createLine(500, 300, 200, 0, false),
          PhysicsEngine.createCircle(650, 300, 30, false),
        ],
        hinges: [
          { bodyA: null, bodyB: 0, localAnchorA: { x: 400, y: 300 }, localAnchorB: { x: -100, y: 0 } },
          { bodyA: 0, bodyB: 1, localAnchorA: { x: 100, y: 0 }, localAnchorB: { x: 0, y: 0 } },
        ],
        xInput: { body: 0, property: "length" },
        yInput: null,
      };
      // Same edit as the "Resizing a hinged body..." test; expect the same positions.
      var bodies = runGridCodegenAtPoint(scene, 200, 0);
      var body0Ok = Math.abs(bodies[0].x - 600) < 1e-3 && Math.abs(bodies[0].y - 300) < 1e-3;
      var body1Ok = Math.abs(bodies[1].x - 850) < 1e-3 && Math.abs(bodies[1].y - 300) < 1e-3;
      var detail = "body0=" + bodies[0].x.toFixed(3) + "," + bodies[0].y.toFixed(3) + " (want 600,300); body1=" +
        bodies[1].x.toFixed(3) + "," + bodies[1].y.toFixed(3) + " (want 850,300)";
      return { pass: body0Ok && body1Ok, detail: detail };
    }
  );

  addTest(
    "Grid codegen: rotation-link cascade keeps the pin fixed",
    "physics-grid-codegen.js port of applyBodyEditPreservingHinge (isResize=false)",
    function () {
      var hinge0 = { bodyA: null, bodyB: 0, localAnchorA: { x: 400, y: 300 }, localAnchorB: { x: -100, y: 0 } };
      var hinge1 = { bodyA: 0, bodyB: 1, localAnchorA: { x: 100, y: 0 }, localAnchorB: { x: 0, y: 0 } };
      var scene = {
        bodies: [
          PhysicsEngine.createLine(500, 300, 200, 0, false),
          PhysicsEngine.createCircle(600, 300, 30, false),
        ],
        hinges: [hinge0, hinge1],
        xInput: { body: 0, property: "angle" },
        yInput: null,
      };
      // *360: angle-linked inputs are scaled by ANGLE_INPUT_SCALE (physics-grid-codegen.js).
      var bodies = runGridCodegenAtPoint(scene, (Math.PI / 2) * 360, 0);
      var gap0 = jointGap(hinge0, bodies);
      var gap1 = jointGap(hinge1, bodies);
      var angleOk = Math.abs(bodies[0].angle - Math.PI / 2) < 1e-3;
      var detail = "angle=" + bodies[0].angle.toFixed(4) + " (want " + (Math.PI / 2).toFixed(4) + "), pivot gap=" +
        gap0.toFixed(4) + "px, child-hinge gap=" + gap1.toFixed(4) + "px";
      return { pass: angleOk && gap0 < 1e-2 && gap1 < 1e-2, detail: detail };
    }
  );

  addTest(
    "Grid codegen: a child hinged to another body (not world) is recentered too, matching the JS reference",
    "physics-grid-codegen.js's applyResizeRotateTarget only ever recentered around a WORLD hinge, the exact same gap as applyBodyEditPreservingHinge: reported via this exact double-pendulum scene, whose yInput links the CHILD body's own angle",
    function () {
      var scene = {
        bodies: [
          { type: "line", x: 492, y: 330, angle: 0, isAnchored: false, length: 140, vx: 0, vy: 0, w: 0 },
          { type: "line", x: 632, y: 328, angle: 0, isAnchored: false, length: 140, vx: 0, vy: 0, w: 0 },
        ],
        hinges: [
          { bodyA: null, bodyB: 0, localAnchorA: { x: 427, y: 336 }, localAnchorB: { x: -65, y: 6 } },
          { bodyA: 0, bodyB: 1, localAnchorA: { x: 71, y: -7 }, localAnchorB: { x: -69, y: -5 } },
        ],
        xInput: { body: 0, property: "angle" },
        yInput: { body: 1, property: "angle" },
        output: { body: 1, property: "y" },
        frameWidth: 1198, frameHeight: 1128,
      };
      var worldX = 0.6, worldY = -0.4;
      var gpuBodies = runGridCodegenAtPoint(scene, worldX, worldY);
      var jsScene = PhysicsGridCodegen.computeOffsetSceneNumeric(scene, worldX, worldY);
      var gpuGap = jointGap(scene.hinges[1], gpuBodies);
      var jsGap = jointGap(scene.hinges[1], jsScene.bodies);
      var posErr = dist(gpuBodies[1].x, gpuBodies[1].y, jsScene.bodies[1].x, jsScene.bodies[1].y);
      var detail = "gpu child-hinge gap=" + gpuGap.toFixed(5) + "px, js child-hinge gap=" + jsGap.toFixed(8) +
        "px, gpu-vs-js body1 position error=" + posErr.toFixed(5) + "px";
      return { pass: gpuGap < 1e-3 && jsGap < 1e-6 && posErr < 1e-3, detail: detail };
    }
  );

  addTest(
    "Grid codegen: Y-input is negated so 'up' in the grid means 'up' in the scene",
    "physics-grid-codegen.js Y-axis convention flip",
    function () {
      var scene = {
        bodies: [PhysicsEngine.createCircle(500, 300, 50, false)],
        hinges: [{ bodyA: null, bodyB: 0, localAnchorA: { x: 500, y: 300 }, localAnchorB: { x: 0, y: 0 } }],
        xInput: null,
        yInput: { body: 0, property: "y" },
      };
      var bodies = runGridCodegenAtPoint(scene, 0, 50);
      var ok = Math.abs(bodies[0].x - 500) < 1e-3 && Math.abs(bodies[0].y - 250) < 1e-3;
      var detail = "at worldY=+50: body0=" + bodies[0].x.toFixed(3) + "," + bodies[0].y.toFixed(3) +
        " (want 500,250, moving 'up' in the grid should move the body up, i.e. smaller physics-y)";
      return { pass: ok, detail: detail };
    }
  );

  addTest(
    "Grid codegen: a static body's mass stays exactly zero when its size is linked",
    "physics-grid-codegen.js isAnchored guard on the ported mass formula",
    function () {
      var scene = {
        bodies: [PhysicsEngine.createCircle(500, 300, 50, true)],
        hinges: [],
        xInput: { body: 0, property: "radius" },
        yInput: null,
      };
      var result = PhysicsGridCodegen.generateGridInitialStateGLSL(scene);
      var s = result.shapeState[0];
      var ok = s.invMass === "0.0" && s.invInertia === "0.0" && s.half !== "50.0";
      var detail = "half=" + s.half + " (changed, correct), invMass=" + s.invMass + ", invInertia=" + s.invInertia + " (want literal 0.0, left unrecomputed)";
      return { pass: ok, detail: detail };
    }
  );

  addTest(
    "Grid codegen: X and Y linked to the same property add",
    "physics-grid-codegen.js resolveOffsetTargets",
    function () {
      var targets = PhysicsGridCodegen.resolveOffsetTargets({ body: 0, property: "radius" }, { body: 0, property: "radius" });
      var ok = targets.length === 1 && targets[0].body === 0 && targets[0].property === "radius" && targets[0].expr === "worldX + worldY";
      return { pass: ok, detail: "resolved to: " + JSON.stringify(targets) };
    }
  );

  addTest(
    "Grid codegen: a position link and a shape link on the same body compose",
    "physics-grid-codegen.js resize-then-translate ordering",
    function () {
      // X resizes body0 (ratio 1.6), Y then translates it; recenter (absolute) runs
      // first, translate (+=) second. Hand-derived: (503,300)/(567,300).
      var hinge0 = { bodyA: null, bodyB: 0, localAnchorA: { x: 520, y: 300 }, localAnchorB: { x: 20, y: 0 } };
      var hinge1 = { bodyA: 0, bodyB: 1, localAnchorA: { x: 40, y: 0 }, localAnchorB: { x: 0, y: 0 } };
      var scene = {
        bodies: [
          PhysicsEngine.createCircle(500, 300, 50, false),
          PhysicsEngine.createCircle(540, 300, 10, false),
        ],
        hinges: [hinge0, hinge1],
        xInput: { body: 0, property: "radius" },
        yInput: { body: 0, property: "x" },
      };
      var bodies = runGridCodegenAtPoint(scene, 30, 15);
      var radius0 = 50 + 30; // no direct readback of shape state at a point; re-derived from the known input
      var pivotBody = { x: bodies[0].x, y: bodies[0].y, angle: bodies[0].angle };
      var rescaledAnchorB = { x: 20 * (radius0 / 50), y: 0 };
      var pin = PhysicsEngine.getHingeWorldPoint({ bodyB: 0, localAnchorB: rescaledAnchorB }, [pivotBody]);
      var pinOk = Math.abs(pin.x - 535) < 1e-3 && Math.abs(pin.y - 300) < 1e-3;
      var body0Ok = Math.abs(bodies[0].x - 503) < 1e-3 && Math.abs(bodies[0].y - 300) < 1e-3;
      var body1Ok = Math.abs(bodies[1].x - 567) < 1e-3 && Math.abs(bodies[1].y - 300) < 1e-3;
      var detail = "body0=" + bodies[0].x.toFixed(3) + "," + bodies[0].y.toFixed(3) + " (want 503,300); body1=" +
        bodies[1].x.toFixed(3) + "," + bodies[1].y.toFixed(3) + " (want 567,300); dragged pin=" +
        pin.x.toFixed(3) + "," + pin.y.toFixed(3) + " (want 535,300)";
      return { pass: pinOk && body0Ok && body1Ok, detail: detail };
    }
  );

  // ---- Pac-Man frame wrapping (opt-in via scene.frameWidth/frameHeight) ----
  addTest(
    "Pac-Man wrap: a body crossing any edge reappears on the opposite side, velocity unchanged",
    "PhysicsEngine.step's frame-wrap: the whole point of this feature",
    function () {
      function run(edgeMode) {
        var scene = {
          bodies: [
            PhysicsEngine.createCircle(190, 100, 10, false), // -> right edge
            PhysicsEngine.createCircle(10, 100, 10, false),  // -> left edge
            PhysicsEngine.createCircle(100, 190, 10, false), // -> bottom edge
            PhysicsEngine.createCircle(100, 10, 10, false),  // -> top edge
          ],
          hinges: [],
          frameWidth: 200, frameHeight: 200, edgeMode: edgeMode,
        };
        scene.bodies[0].vx = 500;
        scene.bodies[1].vx = -500;
        scene.bodies[2].vy = 500;
        scene.bodies[3].vy = -500;
        for (var i = 0; i < 2; i++) PhysicsEngine.step(scene, DT);
        return scene;
      }
      // Reference: the same two steps with no edges. A wrap must shift exactly one
      // frame length on the crossed axis and change nothing else.
      var wrapped = run("wrap"), free = run("infinite");
      var checks = [
        { axis: "x", shift: -200, otherAxis: "y" },
        { axis: "x", shift: 200, otherAxis: "y" },
        { axis: "y", shift: -200, otherAxis: "x" },
        { axis: "y", shift: 200, otherAxis: "x" },
      ];
      var pass = true;
      var details = [];
      checks.forEach(function (c, idx) {
        var got = wrapped.bodies[idx], ref = free.bodies[idx];
        var want = ref[c.axis] + c.shift;
        var inRange = got[c.axis] >= 0 && got[c.axis] < 200;
        var ok = Math.abs(got[c.axis] - want) < 1e-6 && Math.abs(got[c.otherAxis] - ref[c.otherAxis]) < 1e-6 && inRange;
        if (!ok) pass = false;
        details.push("body" + idx + "." + c.axis + "=" + got[c.axis].toFixed(4) + " (want " + want.toFixed(4) + ")");
      });
      var velOk = wrapped.bodies.every(function (b, i) {
        return b.vx === free.bodies[i].vx && b.vy === free.bodies[i].vy;
      });
      return { pass: pass && velOk, detail: details.join("; ") + "; velocities unchanged=" + velOk };
    }
  );

  addTest(
    "Pac-Man wrap: a static body left outside the frame never moves",
    "PhysicsEngine.step's frame-wrap must skip static bodies (they don't fall, so they shouldn't warp either)",
    function () {
      var scene = {
        bodies: [PhysicsEngine.createCircle(300, 100, 10, true)], // x=300 is outside a 200-wide frame
        hinges: [],
        frameWidth: 200, frameHeight: 200,
      };
      for (var i = 0; i < 30; i++) PhysicsEngine.step(scene, DT);
      var body = scene.bodies[0];
      var pass = body.x === 300 && body.y === 100;
      return { pass: pass, detail: "static body at x=" + body.x + ", y=" + body.y + " (want unchanged 300,100: static bodies are exempt from wrapping)" };
    }
  );

  addTest(
    "Pac-Man wrap: JS engine and GPU compiler agree, including across a wrap",
    "PhysicsGPU.generateStepOnceGLSL's frame-wrap port",
    function () {
      var scene = {
        bodies: [PhysicsEngine.createCircle(190, 100, 10, false)],
        hinges: [],
        frameWidth: 200, frameHeight: 200,
      };
      scene.bodies[0].vx = 500;
      var STEPS = 2;

      var jsScene = PhysicsEngine.cloneScene(scene);
      for (var i = 0; i < STEPS; i++) PhysicsEngine.step(jsScene, DT);

      var trajectory = PhysicsGPU.runSceneOnGPU(scene, STEPS);
      var gpuBody = trajectory[STEPS - 1][0];
      var posErr = Math.max(Math.abs(gpuBody.x - jsScene.bodies[0].x), Math.abs(gpuBody.y - jsScene.bodies[0].y));
      var bothWrapped = jsScene.bodies[0].x < 190 && gpuBody.x < 190; // both should have wrapped back near 0, not kept climbing past 200
      var detail = "js x=" + jsScene.bodies[0].x.toFixed(4) + ", gpu x=" + gpuBody.x.toFixed(4) + " (both should be ~6.67, not ~206.67), error=" + posErr.toFixed(5) + "px";
      return { pass: posErr < 0.01 && bothWrapped, detail: detail };
    }
  );

  addTest(
    "Pac-Man wrap: a world-hinged body's PIN decides the wrap, not its own swinging center",
    "PhysicsEngine.step's wrap used to teleport a hinged body's center independently of its pin, tearing the joint (a real repro: a pendulum released horizontal, whose pin sits nowhere near an edge, spun wildly off-screen once its swinging center crossed x=0)",
    function () {
      // The reported scene: the center swings past x=0 while the pin (x=77) stays
      // well inside a 1198-wide frame.
      var scene = {
        bodies: [PhysicsEngine.createLine(336.15, 568, 511, 0, false)],
        hinges: [{ bodyA: null, bodyB: 0, localAnchorA: { x: 77, y: 568 }, localAnchorB: { x: -259.15, y: 0 } }],
        frameWidth: 1198, frameHeight: 1128,
      };
      var maxGap = 0, minCenterX = Infinity;
      for (var i = 0; i < 1000; i++) {
        PhysicsEngine.step(scene, DT);
        var b = scene.bodies[0], h = scene.hinges[0];
        minCenterX = Math.min(minCenterX, b.x);
        var rB = PhysicsEngine.rotateVec(h.localAnchorB, b.angle);
        var gap = Math.hypot(b.x + rB.x - h.localAnchorA.x, b.y + rB.y - h.localAnchorA.y);
        maxGap = Math.max(maxGap, gap);
      }
      var pinUntouched = scene.hinges[0].localAnchorA.x === 77 && scene.hinges[0].localAnchorA.y === 568;
      var centerActuallySwungOutOfFrame = minCenterX < 0; // proves this scenario really exercises the bug, not just a scene that never leaves the frame anyway
      var pass = maxGap < 0.01 && pinUntouched && centerActuallySwungOutOfFrame;
      var detail = "max joint gap over 1000 steps=" + maxGap.toExponential(2) + "px, min center x reached=" + minCenterX.toFixed(2) +
        " (negative = did swing outside the frame), pin untouched=" + pinUntouched + " (want true: it never needed to move)";
      return { pass: pass, detail: detail };
    }
  );

  addTest(
    "Pac-Man wrap: GPU compiler agrees with the JS reference for a world-hinged pendulum",
    "PhysicsGPU.generateStepOnceGLSL's port of the pin-decides-the-wrap rule, including the new inout HINGEn_A plumbing",
    function () {
      var scene = {
        bodies: [PhysicsEngine.createLine(336.15, 568, 511, 0, false)],
        hinges: [{ bodyA: null, bodyB: 0, localAnchorA: { x: 77, y: 568 }, localAnchorB: { x: -259.15, y: 0 } }],
        frameWidth: 1198, frameHeight: 1128,
      };
      var STEPS = 200;
      var jsScene = PhysicsEngine.cloneScene(scene);
      for (var i = 0; i < STEPS; i++) PhysicsEngine.step(jsScene, PhysicsGPU.FIXED_DT);
      var trajectory = PhysicsGPU.runSceneOnGPU(scene, STEPS);
      var gpuBody = trajectory[STEPS - 1][0];
      var posErr = Math.max(Math.abs(gpuBody.x - jsScene.bodies[0].x), Math.abs(gpuBody.y - jsScene.bodies[0].y));
      var angleErr = Math.abs(gpuBody.angle - jsScene.bodies[0].angle);
      var detail = "after " + STEPS + " steps: js x=" + jsScene.bodies[0].x.toFixed(4) + ", gpu x=" + gpuBody.x.toFixed(4) +
        ", position error=" + posErr.toFixed(5) + "px, angle error=" + angleErr.toExponential(2) + "rad";
      return { pass: posErr < 0.01 && angleErr < 0.001, detail: detail };
    }
  );

  addTest(
    "Pac-Man wrap: a world-hinged root's wrap cascades to its hinge child, joints stay satisfied",
    "PhysicsEngine.step's cascade for a body hinged to another body: it must never independently wrap, only move as its parent's wrap carries it along",
    function () {
      // Pin authored just outside the frame so a wrap fires on the first step.
      var scene = {
        bodies: [PhysicsEngine.createLine(1050, 300, 200, 0, false), PhysicsEngine.createCircle(1150, 300, 20, false)],
        hinges: [
          { bodyA: null, bodyB: 0, localAnchorA: { x: 1050, y: 300 }, localAnchorB: { x: 0, y: 0 } },
          { bodyA: 0, bodyB: 1, localAnchorA: { x: 100, y: 0 }, localAnchorB: { x: 0, y: 0 } },
        ],
        frameWidth: 1000, frameHeight: 800,
      };
      PhysicsEngine.step(scene, DT);
      var h0 = scene.hinges[0], h1 = scene.hinges[1], b0 = scene.bodies[0], b1 = scene.bodies[1];
      var rB0 = PhysicsEngine.rotateVec(h0.localAnchorB, b0.angle);
      var gap0 = Math.hypot(b0.x + rB0.x - h0.localAnchorA.x, b0.y + rB0.y - h0.localAnchorA.y);
      var rA1 = PhysicsEngine.rotateVec(h1.localAnchorA, b0.angle);
      var rB1 = PhysicsEngine.rotateVec(h1.localAnchorB, b1.angle);
      var gap1 = Math.hypot((b0.x + rA1.x) - (b1.x + rB1.x), (b0.y + rA1.y) - (b1.y + rB1.y));
      var pinWrapped = Math.abs(h0.localAnchorA.x - 50) < 1e-6; // 1050 - frameWidth(1000)
      var childCascaded = Math.abs(b1.x - 150) < 0.01; // 1150 - 1000, same delta as the pin/parent
      var pass = pinWrapped && childCascaded && gap0 < 0.01 && gap1 < 1e-6;
      var detail = "pin=" + h0.localAnchorA.x.toFixed(4) + " (want 50); body0=" + b0.x.toFixed(4) + " (want ~50); body1=" +
        b1.x.toFixed(4) + " (want ~150, cascaded by the same -1000 delta); gap0=" + gap0.toExponential(2) + "px, gap1=" + gap1.toExponential(2) + "px";
      return { pass: pass, detail: detail };
    }
  );

  // ---- Stop-on-wrap: findWrapStopStep must be CONTINUOUS (it colors a fractal grid) ----

  function runWrapStopStepAtPoint(scene, worldX, worldY, steps) {
    var offset = PhysicsGridCodegen.computeOffsetSceneNumeric(scene, worldX, worldY);
    var initialBody = { x: offset.bodies[0].x, y: offset.bodies[0].y, angle: offset.bodies[0].angle };
    offset.bodies.forEach(PhysicsEngine.computeMass);
    var traj = [];
    for (var i = 0; i < steps; i++) {
      PhysicsEngine.step(offset, DT);
      traj.push(offset.bodies.map(function (b) { return { x: b.x, y: b.y, angle: b.angle }; }));
    }
    return PhysicsHingeGeometry.findWrapStopStep(traj, [0], 0, scene.frameWidth, scene.frameHeight, [initialBody], DT);
  }

  addTest(
    "findWrapStopStep: no longer jumps as starting position sweeps across a step boundary",
    "the OLD behavior (return the raw logged sample before the wrap) made the answer a function of WHICH DISCRETE STEP first noticed the crossing - an integer that changes by 1 exactly when a sweep crosses a step boundary, producing a real jump with zero collisions involved (confirmed on a lone free-falling circle: a clean jump of about one step's fall distance, at regular intervals matching it)",
    function () {
      var scene = {
        bodies: [PhysicsEngine.createCircle(600, 1120, 20, false)],
        hinges: [], xInput: null, yInput: { body: 0, property: "y" },
        frameWidth: 1198, frameHeight: 1128,
      };
      var results = [];
      // worldY is negated for a y-property link, so [-2, 0] sweeps y from 1120 to
      // 1122: hand-verified to straddle several step boundaries.
      for (var y = -2.0; y <= 0; y += 0.1) results.push(runWrapStopStepAtPoint(scene, 0, y, 500));
      var steps = results.map(function (r) { return r.step; });
      var maxJump = 0;
      for (var i = 1; i < results.length; i++) maxJump = Math.max(maxJump, Math.abs(results[i].y - results[i - 1].y));
      var distinctSteps = steps.filter(function (v, i) { return steps.indexOf(v) === i; }).length;
      var detail = "swept 21 points 0.1px apart, spanning " + distinctSteps + " distinct step values (" + Math.min.apply(null, steps) + "-" + Math.max.apply(null, steps) +
        "); max adjacent-sample change in the interpolated y=" + maxJump.toFixed(4) + "px (want <1px, and >1 distinct step to prove this actually exercised a step-boundary crossing)";
      return { pass: maxJump < 1 && distinctSteps > 1, detail: detail };
    }
  );

  addTest(
    "findWrapStopStep: interpolated value matches hand-derived kinematics exactly",
    "sanity check on the actual formula, not just 'is it smooth', a circle already at MAX_SPEED (terminal velocity) when it crosses has a closed-form answer: boundary, MAX_SPEED*DT, independent of exactly which step notices",
    function () {
      // Launched already at MAX_SPEED: gravity adds, the clamp removes, so it
      // descends at exactly MAX_SPEED whatever that constant is.
      var scene = {
        bodies: [PhysicsEngine.createCircle(600, 50, 20, false)],
        hinges: [], xInput: null, yInput: { body: 0, property: "y" },
        frameWidth: 1198, frameHeight: 1128,
      };
      scene.bodies[0].vy = PhysicsEngine.MAX_SPEED;
      var result = runWrapStopStepAtPoint(scene, 0, 0, 500);
      var expectedY = 1128 - PhysicsEngine.MAX_SPEED * DT; // boundary: MAX_SPEED * DT
      var err = Math.abs(result.y - expectedY);
      var detail = "interpolated y=" + result.y.toFixed(4) + ", hand-derived boundary-MAX_SPEED*DT=" + expectedY.toFixed(4) + ", error=" + err.toFixed(4) + "px";
      return { pass: err < 0.01, detail: detail };
    }
  );

  addTest(
    "findWrapStopStep: GPU grid shader's inline wrap-stop agrees with the JS reference",
    "fractal-grid.js's buildFragmentShader ports this same one-step-before-crossing interpolation into the per-pixel GLSL loop (using body.vx/vy directly instead of finite-differencing, since it has live velocity: see its own comment)",
    function () {
      var scene = {
        bodies: [PhysicsEngine.createCircle(600, 1120, 20, false)],
        hinges: [], xInput: null, yInput: { body: 0, property: "y" },
        frameWidth: 1198, frameHeight: 1128,
      };
      function runGpuStickyEdgesAtPoint(worldX, worldY) {
        var consts = scene.bodies.map(PhysicsGPU.bodyConst);
        var frame = { width: scene.frameWidth, height: scene.frameHeight };
        var stepOnceCall = "stepOnce(" + PhysicsGPU.stepOnceCallArgs(1, []) + ");";
        var halfW = PhysicsGPU.fnum(frame.width / 2), halfH = PhysicsGPU.fnum(frame.height / 2);
        var fullW = PhysicsGPU.fnum(frame.width), fullH = PhysicsGPU.fnum(frame.height);
        var fs = [
          "#version 300 es", "precision highp float;", "out vec4 fragColor;", "",
          PhysicsGPU.libraryGLSL("f32", PhysicsEngine.speedCapFor(scene)), "",
          PhysicsGPU.generateStepOnceGLSL(1, consts, [], [], frame), "",
          "void main() {",
          "  Body body0 = Body(" + PhysicsGPU.fnum(consts[0].x + worldX) + ", " + PhysicsGPU.fnum(consts[0].y + worldY) + ", " + PhysicsGPU.fnum(consts[0].angle) + ", 0.0, 0.0, 0.0);",
          "  float BODY0_INV_MASS = " + PhysicsGPU.fnum(consts[0].invMass) + ";",
          "  float BODY0_INV_INERTIA = " + PhysicsGPU.fnum(consts[0].invInertia) + ";",
          "  float BODY0_HALF = " + PhysicsGPU.fnum(PhysicsGPU.shapeHalf(consts, 0)) + ";",
          "  float frozenX = body0.x; float frozenY = body0.y; float frozenAngle = body0.angle;",
          "  float prevFrozenX = 0.0; float prevFrozenY = 0.0; float prevFrozenAngle = 0.0;",
          "  bool hasPrevFrozen = false; bool wrapStopped = false;",
          "  for (int i = 0; i < 500; i++) {",
          "    if (wrapStopped) break;",
          "    " + stepOnceCall,
          "    float wrapDx = body0.x - frozenX; float wrapDy = body0.y - frozenY;",
          "    if (abs(wrapDx) > " + halfW + " || abs(wrapDy) > " + halfH + ") {",
          "      bool xCrossed = abs(wrapDx) > " + halfW + ";",
          "      float span = xCrossed ? " + fullW + " : " + fullH + ";",
          "      float vAxis = xCrossed ? body0.vx : body0.vy;",
          "      float prevAxis = xCrossed ? frozenX : frozenY;",
          "      float boundary = vAxis > 0.0 ? span : 0.0;",
          "      float tFrac = clamp((boundary - prevAxis) / vAxis, 0.0, DT);",
          "      float tTarget = tFrac - DT;",
          "      if (hasPrevFrozen) {",
          "        float vx = (frozenX - prevFrozenX) / DT; float vy = (frozenY - prevFrozenY) / DT; float va = (frozenAngle - prevFrozenAngle) / DT;",
          "        body0.x = frozenX + vx * tTarget; body0.y = frozenY + vy * tTarget; body0.angle = frozenAngle + va * tTarget;",
          "      } else { body0.x = frozenX; body0.y = frozenY; body0.angle = frozenAngle; }",
          "      wrapStopped = true;",
          "    } else {",
          "      prevFrozenX = frozenX; prevFrozenY = frozenY; prevFrozenAngle = frozenAngle;",
          "      frozenX = body0.x; frozenY = body0.y; frozenAngle = body0.angle; hasPrevFrozen = true;",
          "    }",
          "  }",
          "  fragColor = vec4(body0.x, body0.y, body0.angle, 1.0);",
          "}",
        ].join("\n");
        var canvas = new OffscreenCanvas(1, 1);
        var gl = canvas.getContext("webgl2");
        gl.getExtension("EXT_color_buffer_float");
        var vs = PhysicsGPU.compileShader(gl, gl.VERTEX_SHADER, PhysicsGPU.VERTEX_SOURCE);
        var fsCompiled = PhysicsGPU.compileShader(gl, gl.FRAGMENT_SHADER, fs);
        var program = PhysicsGPU.linkProgram(gl, vs, fsCompiled);
        gl.useProgram(program);
        var buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
        var posLoc = gl.getAttribLocation(program, "a_position");
        gl.enableVertexAttribArray(posLoc);
        gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
        var tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 1, 1, 0, gl.RGBA, gl.FLOAT, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        var fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        gl.viewport(0, 0, 1, 1);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        var pixels = new Float32Array(4);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, pixels);
        var loseCtx = gl.getExtension("WEBGL_lose_context");
        if (loseCtx) loseCtx.loseContext();
        return { x: pixels[0], y: pixels[1], angle: pixels[2] };
      }
      // Not computeOffsetSceneNumeric: that negates worldY for y links, which the
      // GLSL harness above doesn't. Both sides use plain base + worldY here.
      function runJsStickyEdgesAtPoint(worldX, worldY, steps) {
        var s = PhysicsEngine.cloneScene(scene);
        var initialBody = { x: s.bodies[0].x + worldX, y: s.bodies[0].y + worldY, angle: s.bodies[0].angle };
        s.bodies[0].x = initialBody.x; s.bodies[0].y = initialBody.y;
        s.bodies.forEach(PhysicsEngine.computeMass);
        var traj = [];
        for (var i = 0; i < steps; i++) {
          PhysicsEngine.step(s, DT);
          traj.push([{ x: s.bodies[0].x, y: s.bodies[0].y, angle: s.bodies[0].angle }]);
        }
        return PhysicsHingeGeometry.findWrapStopStep(traj, [0], 0, s.frameWidth, s.frameHeight, [initialBody], DT);
      }
      var maxErr = 0;
      var detail = [];
      [0, 1.5, 1.7, 1.8, 2.0].forEach(function (worldY) {
        var js = runJsStickyEdgesAtPoint(0, worldY, 500);
        var gpu = runGpuStickyEdgesAtPoint(0, worldY);
        var err = dist(js.x, js.y, gpu.x, gpu.y);
        maxErr = Math.max(maxErr, err);
        detail.push("worldY=" + worldY + ": js=" + js.y.toFixed(3) + " gpu=" + gpu.y.toFixed(3));
      });
      return { pass: maxErr < 0.01, detail: detail.join(", ") + " - max position error=" + maxErr.toFixed(5) + "px" };
    }
  );

  addTest(
    "CCD position sub-stepping: no sharp one-step jump in trajectory separation at the moment of first contact",
    "collideCircleCircle's CCD fixed the contact NORMAL/velocity at the exact sub-step instant but still integrated POSITION for the whole step at the post-bounce velocity from the pre-bounce point. Invisible for one isolated bounce, but this scene rides the anchored circle's curved surface under gravity for ~130 consecutive steps of contact - long enough that this one-time positional error used to compound into a DISCONTINUOUS jump (real user-reported scene, via #grid-view tracking body0.y with stickyEdges: a ball at (449,111) grazing a static anchored circle at (676,577)). Two starting points 0.01px apart (worldX 277.75/277.76) used to stay 0.01px apart through step 61, then jump to 14.69px apart at step 62 the instant CCD caught the contact - a ~1470x one-step blowup. This scene's sustained sliding contact is itself genuinely chaotic (confirmed separately: the eventual divergence between two close starting points shrinks smoothly, not to a floor, as the starting gap shrinks - sensitive dependence, not a bug) so gradual growth over many steps is expected and NOT what this test checks; it only checks that no single step still multiplies the separation by an outsized factor the way the old unconditional 'move the whole step at the post-bounce velocity' logic did",
    function () {
      function traceAt(worldX) {
        var scene = {
          bodies: [
            PhysicsEngine.createCircle(449 + worldX, 111, 30, false),
            PhysicsEngine.createCircle(676, 577, 30, true),
          ],
          hinges: [],
        };
        scene.bodies.forEach(PhysicsEngine.computeMass);
        var log = [];
        for (var i = 0; i < 70; i++) {
          PhysicsEngine.step(scene, DT);
          log.push({ x: scene.bodies[0].x, y: scene.bodies[0].y });
        }
        return log;
      }
      var a = traceAt(277.75), b = traceAt(277.76);
      var gaps = a.map(function (r, i) { return dist(r.x, r.y, b[i].x, b[i].y); });
      var maxRatio = 0, ratioAtStep = null;
      for (var i = 1; i < gaps.length; i++) {
        if (gaps[i - 1] < 1e-6) continue;
        var ratio = gaps[i] / gaps[i - 1];
        if (ratio > maxRatio) { maxRatio = ratio; ratioAtStep = i + 1; }
      }
      var detail = "worldX=277.75 vs 277.76 (0.01px apart), steps 1-70: max one-step separation-growth ratio=" +
        maxRatio.toFixed(2) + "x at step " + ratioAtStep + " (want <50x, before this fix, step 62 alone jumped 0.01px->14.69px, a ~1470x ratio)";
      return { pass: maxRatio < 50, detail: detail };
    }
  );

  addTest(
    "cloneScene preserves xInput/yInput/output/frameWidth/frameHeight",
    "PhysicsEngine.cloneScene silently dropped these, so a Play -> Reset cycle in physics-ui.js wiped every mapping and un-locked the wrap frame",
    function () {
      var scene = {
        bodies: [PhysicsEngine.createCircle(100, 100, 10, false), PhysicsEngine.createCircle(200, 100, 10, false)],
        hinges: [],
        xInput: { body: 0, property: "x" },
        yInput: { body: 1, property: "y" },
        output: { body: 0, property: "angle" },
        frameWidth: 900, frameHeight: 600,
      };
      var clone = PhysicsEngine.cloneScene(scene);
      var pass = clone.xInput && clone.xInput.body === 0 && clone.xInput.property === "x" &&
        clone.yInput && clone.yInput.body === 1 && clone.yInput.property === "y" &&
        clone.output && clone.output.body === 0 && clone.output.property === "angle" &&
        clone.frameWidth === 900 && clone.frameHeight === 600;
      var detail = "xInput=" + JSON.stringify(clone.xInput) + ", yInput=" + JSON.stringify(clone.yInput) +
        ", output=" + JSON.stringify(clone.output) + ", frame=" + clone.frameWidth + "x" + clone.frameHeight;
      return { pass: pass, detail: detail };
    }
  );

  // ---- Settling a STARTING position into the frame (not the per-step wrap) ----
  // A typed coordinate or huge grid offset can land many frames away at once; uses mod().

  addTest(
    "frameWrapDelta: a non-anchored body's center wraps by any distance in one shot",
    "PhysicsHingeGeometry.frameWrapDelta: mod(), not a single frame-width subtract, is what makes an arbitrarily large starting offset safe",
    function () {
      var body = { x: 5190.5, y: -3050.25, isAnchored: false };
      var d = PhysicsHingeGeometry.frameWrapDelta(body, 200, 400);
      var cx = body.x + d.dx, cy = body.y + d.dy;
      var pass = Math.abs(cx - 190.5) < 1e-9 && Math.abs(cy - 149.75) < 1e-9 && cx >= 0 && cx < 200 && cy >= 0 && cy < 400;
      return { pass: pass, detail: "corrected=(" + cx + "," + cy + ") (want 190.5,149.75: both many frame-lengths from where they started)" };
    }
  );

  addTest(
    "frameWrapDelta: an anchored circle only wraps once its WHOLE shape clears the edge",
    "PhysicsHingeGeometry.frameWrapDelta's isAnchored branch: a merely-overhanging anchored body must not move",
    function () {
      var partiallyOut = { type: "circle", x: 195, y: 100, radius: 10, isAnchored: true }; // right edge at 205 > 200, but center (and most of the shape) is still inside
      var fullyOut = { type: "circle", x: 215, y: 100, radius: 10, isAnchored: true }; // left edge at 205 > 200 -> the whole circle has cleared it
      var d1 = PhysicsHingeGeometry.frameWrapDelta(partiallyOut, 200, 200);
      var d2 = PhysicsHingeGeometry.frameWrapDelta(fullyOut, 200, 200);
      var pass = d1.dx === 0 && d1.dy === 0 && d2.dx === -200 && d2.dy === 0;
      return { pass: pass, detail: "partially-out delta=(" + d1.dx + "," + d1.dy + ") (want 0,0 - left alone); fully-out delta=(" + d2.dx + "," + d2.dy + ") (want -200,0)" };
    }
  );

  addTest(
    "frameWrapDelta: an anchored line's bounding box accounts for its angle",
    "PhysicsHingeGeometry.frameHalfExtent's trig for a rotated line",
    function () {
      // length 40 at 45deg -> half-extent 14.142, so the left edge clears x=200.
      var line = { type: "line", x: 250, y: 100, length: 40, angle: Math.PI / 4, isAnchored: true };
      var d = PhysicsHingeGeometry.frameWrapDelta(line, 200, 200);
      var pass = d.dx === -200 && d.dy === 0;
      return { pass: pass, detail: "delta=(" + d.dx + "," + d.dy + ") (want -200,0)" };
    }
  );

  addTest(
    "normalizeAllBodiesIntoFrame never wraps a hinge CHILD directly, only cascades to it",
    "PhysicsHingeGeometry.isHingeChild, wrapping a child's own position independently of its parent tears the joint",
    function () {
      // body0: world-hinged, 5000 outside a 200-wide frame. body1: hinged to it,
      // also far outside, but rigidly so (must NOT be wrapped on its own).
      var scene = {
        bodies: [PhysicsEngine.createLine(5100, 300, 200, 0, false), PhysicsEngine.createCircle(5200, 300, 20, false)],
        hinges: [
          { bodyA: null, bodyB: 0, localAnchorA: { x: 5000, y: 300 }, localAnchorB: { x: -100, y: 0 } },
          { bodyA: 0, bodyB: 1, localAnchorA: { x: 100, y: 0 }, localAnchorB: { x: 0, y: 0 } },
        ],
        frameWidth: 200, frameHeight: 400,
      };
      PhysicsHingeGeometry.normalizeAllBodiesIntoFrame(scene);
      var rB = PhysicsEngine.rotateVec({ x: 100, y: 0 }, scene.bodies[0].angle);
      var jointWorld = { x: scene.bodies[0].x + rB.x, y: scene.bodies[0].y + rB.y };
      var gap = Math.hypot(jointWorld.x - scene.bodies[1].x, jointWorld.y - scene.bodies[1].y);
      var body0InRange = scene.bodies[0].x >= 0 && scene.bodies[0].x < 200;
      var pass = gap < 1e-9 && body0InRange && Math.abs(scene.bodies[0].x - 100) < 1e-9;
      var detail = "body0=" + scene.bodies[0].x.toFixed(3) + " (want 100, in range); body1=" + scene.bodies[1].x.toFixed(3) +
        " (want 200 - still outside [0,200), correctly, since it's rigidly attached there); joint gap=" + gap.toFixed(6) + "px";
      return { pass: pass, detail: detail };
    }
  );

  addTest(
    "Grid codegen: starting-state frame settling matches the JS reference (non-anchored and anchored)",
    "physics-grid-codegen.js's GLSL port of PhysicsHingeGeometry.frameWrapDelta inside generateGridInitialStateGLSL",
    function () {
      var nonAnchored = {
        bodies: [{ type: "circle", x: 100, y: 100, angle: 0, isAnchored: false, radius: 10, vx: 0, vy: 0, w: 0 }],
        hinges: [], xInput: { body: 0, property: "x" }, yInput: null, output: { body: 0, property: "x" },
        frameWidth: 200, frameHeight: 200,
      };
      var anchoredFullyOut = {
        bodies: [{ type: "circle", x: 100, y: 100, angle: 0, isAnchored: true, radius: 10, vx: 0, vy: 0, w: 0 }],
        hinges: [], xInput: { body: 0, property: "x" }, yInput: null, output: { body: 0, property: "x" },
        frameWidth: 200, frameHeight: 200,
      };
      var r1js = PhysicsGridCodegen.computeOffsetSceneNumeric(nonAnchored, 5000, 0);
      var r1gpu = PhysicsGPU.runCompiledTrajectoryOnGPU(PhysicsGridCodegen.compileHoverTrajectoryGLSL(nonAnchored, 5000, 0, 1), 1);
      var r2js = PhysicsGridCodegen.computeOffsetSceneNumeric(anchoredFullyOut, 130, 0);
      var r2gpu = PhysicsGPU.runCompiledTrajectoryOnGPU(PhysicsGridCodegen.compileHoverTrajectoryGLSL(anchoredFullyOut, 130, 0, 1), 1);
      var err1 = Math.abs(r1js.bodies[0].x - r1gpu[0][0].x);
      var err2 = Math.abs(r2js.bodies[0].x - r2gpu[0][0].x);
      var pass = err1 < 1e-4 && err2 < 1e-4 && Math.abs(r1js.bodies[0].x - 100) < 1e-9 && Math.abs(r2js.bodies[0].x - 30) < 1e-9;
      var detail = "non-anchored: js=" + r1js.bodies[0].x + ", gpu=" + r1gpu[0][0].x + " (want 100); anchored fully-out: js=" +
        r2js.bodies[0].x + ", gpu=" + r2gpu[0][0].x + " (want 30)";
      return { pass: pass, detail: detail };
    }
  );

  // ---- 8 & 9: hinge-preserving edits (physics-hinge-geometry.js) ----
  addTest(
      "Resizing a hinged body keeps its pin fixed and drags descendants",
      "applyBodyEditPreservingHinge (radius/length/rotation)",
      function () {
        var scene = {
          bodies: [
            PhysicsEngine.createLine(500, 300, 200, 0, false),
            PhysicsEngine.createCircle(650, 300, 30, false),
          ],
          hinges: [
            { bodyA: null, bodyB: 0, localAnchorA: { x: 400, y: 300 }, localAnchorB: { x: -100, y: 0 } },
            { bodyA: 0, bodyB: 1, localAnchorA: { x: 100, y: 0 }, localAnchorB: { x: 0, y: 0 } },
          ],
        };
        PhysicsHingeGeometry.applyBodyEditPreservingHinge(scene, 0, true, function () {
          scene.bodies[0].length = 400;
          PhysicsEngine.computeMass(scene.bodies[0]);
        });
        var body0 = scene.bodies[0], body1 = scene.bodies[1];
        var pivot = worldHingePointA(scene.hinges[0], scene.bodies);
        var pivotOk = Math.abs(pivot.x - 400) < 1e-6 && Math.abs(pivot.y - 300) < 1e-6;
        var body0Ok = Math.abs(body0.x - 600) < 1e-6 && Math.abs(body0.y - 300) < 1e-6;
        var body1Ok = Math.abs(body1.x - 850) < 1e-6 && Math.abs(body1.y - 300) < 1e-6;
        var detail = "pivot=" + pivot.x.toFixed(3) + "," + pivot.y.toFixed(3) + " (want 400,300); body0=" +
          body0.x.toFixed(3) + "," + body0.y.toFixed(3) + " (want 600,300); body1=" +
          body1.x.toFixed(3) + "," + body1.y.toFixed(3) + " (want 850,300)";
        return { pass: pivotOk && body0Ok && body1Ok, detail: detail };
      }
    );

  addTest(
      "Directly moving a hinged body drags its pin and descendants along",
      "translateBodyPreservingHinges (Center X/Y edit + drag)",
      function () {
        var scene = {
          bodies: [
            PhysicsEngine.createCircle(500, 300, 50, false),
            PhysicsEngine.createCircle(600, 300, 20, false),
          ],
          hinges: [
            { bodyA: null, bodyB: 0, localAnchorA: { x: 503, y: 301 }, localAnchorB: { x: 3, y: 1 } },
            { bodyA: 0, bodyB: 1, localAnchorA: { x: 50, y: 0 }, localAnchorB: { x: 0, y: 0 } },
          ],
        };
        PhysicsHingeGeometry.translateBodyPreservingHinges(scene, 0, 40, -25);
        var body0 = scene.bodies[0], body1 = scene.bodies[1];
        var pinWorld = PhysicsEngine.getHingeWorldPoint(scene.hinges[0], scene.bodies);
        var pinOk = Math.abs(pinWorld.x - 543) < 1e-6 && Math.abs(pinWorld.y - 276) < 1e-6;
        var body0Ok = Math.abs(body0.x - 540) < 1e-6 && Math.abs(body0.y - 275) < 1e-6;
        var body1Ok = Math.abs(body1.x - 640) < 1e-6 && Math.abs(body1.y - 275) < 1e-6;
        var detail = "pin=" + pinWorld.x.toFixed(3) + "," + pinWorld.y.toFixed(3) + " (want 543,276); body0=" +
          body0.x.toFixed(3) + "," + body0.y.toFixed(3) + " (want 540,275); body1=" +
          body1.x.toFixed(3) + "," + body1.y.toFixed(3) + " (want 640,275)";
        return { pass: pinOk && body0Ok && body1Ok, detail: detail };
      }
    );

  // Rotation (isResize=false) is only reached via an angle-linked grid input.
  // Checks the invariant (pin fixed, cascade reaches descendants) via trusted primitives.
  addTest(
      "Rotating a world-hinged line keeps its pin fixed and drags its child",
      "applyBodyEditPreservingHinge (isResize=false, previously untested)",
      function () {
        var scene = {
          bodies: [
            PhysicsEngine.createLine(500, 300, 200, 0, false),
            PhysicsEngine.createCircle(600, 300, 30, false),
          ],
          hinges: [
            { bodyA: null, bodyB: 0, localAnchorA: { x: 400, y: 300 }, localAnchorB: { x: -100, y: 0 } },
            { bodyA: 0, bodyB: 1, localAnchorA: { x: 100, y: 0 }, localAnchorB: { x: 0, y: 0 } },
          ],
        };
        var body1Before = { x: scene.bodies[1].x, y: scene.bodies[1].y };
        PhysicsHingeGeometry.applyBodyEditPreservingHinge(scene, 0, false, function () {
          scene.bodies[0].angle = Math.PI / 2;
        });
        var body0 = scene.bodies[0], body1 = scene.bodies[1];
        var angleOk = Math.abs(body0.angle - Math.PI / 2) < 1e-9;
        var gap0 = jointGap(scene.hinges[0], scene.bodies);
        var gap1 = jointGap(scene.hinges[1], scene.bodies);
        var body1Moved = dist(body1Before.x, body1Before.y, body1.x, body1.y);
        var detail = "angle=" + body0.angle.toFixed(4) + " (want " + (Math.PI / 2).toFixed(4) + "), pivot gap=" + gap0.toFixed(6) +
          "px, child-hinge gap=" + gap1.toFixed(6) + "px, child moved " + body1Moved.toFixed(2) + "px";
        return { pass: angleOk && gap0 < 1e-6 && gap1 < 1e-6 && body1Moved > 1, detail: detail };
      }
    );

  addTest(
      "Rotating a world-hinged circle keeps its pin fixed and drags its child",
      "applyBodyEditPreservingHinge (isResize=false, previously untested)",
      function () {
        var scene = {
          bodies: [
            PhysicsEngine.createCircle(500, 300, 50, false),
            PhysicsEngine.createLine(500, 340, 60, 0, false),
          ],
          hinges: [
            { bodyA: null, bodyB: 0, localAnchorA: { x: 520, y: 300 }, localAnchorB: { x: 20, y: 0 } },
            // localAnchorA (30,40) sits exactly on the radius-50 circle's rim.
            { bodyA: 0, bodyB: 1, localAnchorA: { x: -30, y: 40 }, localAnchorB: { x: -30, y: 0 } },
          ],
        };
        var body1Before = { x: scene.bodies[1].x, y: scene.bodies[1].y };
        PhysicsHingeGeometry.applyBodyEditPreservingHinge(scene, 0, false, function () {
          scene.bodies[0].angle = Math.PI / 2;
        });
        var body0 = scene.bodies[0], body1 = scene.bodies[1];
        var angleOk = Math.abs(body0.angle - Math.PI / 2) < 1e-9;
        var gap0 = jointGap(scene.hinges[0], scene.bodies);
        var gap1 = jointGap(scene.hinges[1], scene.bodies);
        var body1Moved = dist(body1Before.x, body1Before.y, body1.x, body1.y);
        var detail = "angle=" + body0.angle.toFixed(4) + " (want " + (Math.PI / 2).toFixed(4) + "), pivot gap=" + gap0.toFixed(6) +
          "px, child-hinge gap=" + gap1.toFixed(6) + "px, child moved " + body1Moved.toFixed(2) + "px";
        return { pass: angleOk && gap0 < 1e-6 && gap1 < 1e-6 && body1Moved > 1, detail: detail };
      }
    );

  addTest(
      "Rotating a body hinged to ANOTHER body (not world) keeps that hinge satisfied",
      "applyBodyEditPreservingHinge only ever recentered around a WORLD hinge; a body hinged to a non-world parent was mutated in place with no recenter at all, tearing the joint (reported via a double-pendulum scene whose yInput links the CHILD body's own angle)",
      function () {
        var scene = {
          bodies: [
            PhysicsEngine.createLine(500, 300, 200, 0, false),
            PhysicsEngine.createLine(675, 300, 150, 0, false),
            PhysicsEngine.createCircle(750, 300, 25, false),
          ],
          hinges: [
            { bodyA: null, bodyB: 0, localAnchorA: { x: 400, y: 300 }, localAnchorB: { x: -100, y: 0 } },
            { bodyA: 0, bodyB: 1, localAnchorA: { x: 100, y: 0 }, localAnchorB: { x: -75, y: 0 } },
            { bodyA: 1, bodyB: 2, localAnchorA: { x: 75, y: 0 }, localAnchorB: { x: 0, y: 0 } },
          ],
        };
        var body0Before = { x: scene.bodies[0].x, y: scene.bodies[0].y, angle: scene.bodies[0].angle };
        var body2Before = { x: scene.bodies[2].x, y: scene.bodies[2].y };
        PhysicsHingeGeometry.applyBodyEditPreservingHinge(scene, 1, false, function () {
          scene.bodies[1].angle = Math.PI / 2;
        });
        var angleOk = Math.abs(scene.bodies[1].angle - Math.PI / 2) < 1e-9;
        var body0Untouched = scene.bodies[0].x === body0Before.x && scene.bodies[0].y === body0Before.y &&
          scene.bodies[0].angle === body0Before.angle;
        var gapWorld = jointGap(scene.hinges[0], scene.bodies);
        var gapToParent = jointGap(scene.hinges[1], scene.bodies);
        var gapToChild = jointGap(scene.hinges[2], scene.bodies);
        var body2Moved = dist(body2Before.x, body2Before.y, scene.bodies[2].x, scene.bodies[2].y);
        var detail = "angle=" + scene.bodies[1].angle.toFixed(4) + " (want " + (Math.PI / 2).toFixed(4) +
          "), gap-to-world=" + gapWorld.toFixed(6) + "px, gap-to-parent=" + gapToParent.toFixed(6) +
          "px, gap-to-child=" + gapToChild.toFixed(6) + "px, parent untouched=" + body0Untouched +
          ", child moved " + body2Moved.toFixed(2) + "px";
        return {
          pass: angleOk && body0Untouched && gapWorld < 1e-6 && gapToParent < 1e-6 && gapToChild < 1e-6 && body2Moved > 1,
          detail: detail,
        };
      }
    );

  // Asymmetry: applyBodyEditPreservingHinge only cascades when the edited body
  // has a world hinge; translateBodyPreservingHinges cascades unconditionally.
  addTest(
      "Resize vs. direct-move cascade asymmetry on a non-world-hinged parent",
      "applyBodyEditPreservingHinge vs. translateBodyPreservingHinges",
      function () {
        function buildScene() {
          return {
            bodies: [
              PhysicsEngine.createLine(500, 300, 100, 0, false),
              PhysicsEngine.createCircle(550, 300, 20, false),
            ],
            hinges: [{ bodyA: 0, bodyB: 1, localAnchorA: { x: 50, y: 0 }, localAnchorB: { x: 0, y: 0 } }],
          };
        }

        var resizeScene = buildScene();
        PhysicsHingeGeometry.applyBodyEditPreservingHinge(resizeScene, 0, true, function () {
          resizeScene.bodies[0].length = 200;
          PhysicsEngine.computeMass(resizeScene.bodies[0]);
        });
        var noCascade = resizeScene.bodies[0].length === 200 &&
          resizeScene.bodies[0].x === 500 && resizeScene.bodies[0].y === 300 &&
          resizeScene.bodies[1].x === 550 && resizeScene.bodies[1].y === 300;

        var moveScene = buildScene();
        PhysicsHingeGeometry.translateBodyPreservingHinges(moveScene, 0, 30, -15);
        var body0 = moveScene.bodies[0], body1 = moveScene.bodies[1];
        var cascadeOk = Math.abs(body0.x - 530) < 1e-9 && Math.abs(body0.y - 285) < 1e-9 &&
          Math.abs(body1.x - 580) < 1e-9 && Math.abs(body1.y - 285) < 1e-9;

        var detail = "resize (no world hinge): body1 stayed at " + resizeScene.bodies[1].x + "," + resizeScene.bodies[1].y +
          " (no cascade, correct); direct move: body0=" + body0.x + "," + body0.y + " body1=" + body1.x + "," + body1.y + " (both shift +30,-15, cascade, correct)";
        return { pass: noCascade && cascadeOk, detail: detail };
      }
    );

  // ---- Double-float (df) precision path ----
  // Extended-precision failure is SILENT: a reassociating driver zeroes every
  // error term and the shader still runs. See physics-df.js and df-probe.html.

  // Runs a bespoke fragment shader over a `width` x 1 RGBA32F target and
  // returns the raw floats. Keep df tests SHORT: a df step is ~10x a float32
  // one, and tripping the GPU watchdog makes every later draw return zeros.
  // ONE context for the whole run: browsers cap live WebGL contexts and drop
  // the oldest silently (readPixels then returns zeros with no error).
  var sharedFloatContext = null;
  function floatContext() {
    if (sharedFloatContext && !sharedFloatContext.gl.isContextLost()) return sharedFloatContext;
    var canvas = new OffscreenCanvas(1, 1);
    var gl = canvas.getContext("webgl2");
    if (!gl.getExtension("EXT_color_buffer_float")) throw new Error("EXT_color_buffer_float unavailable");
    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    sharedFloatContext = { gl: gl, vs: PhysicsGPU.compileShader(gl, gl.VERTEX_SHADER, PhysicsGPU.VERTEX_SOURCE), quad: buf };
    return sharedFloatContext;
  }

  function runFloatShader(fragmentSource, width) {
    var ctx = floatContext(), gl = ctx.gl;
    var fs = PhysicsGPU.compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    var program;
    try {
      program = PhysicsGPU.linkProgram(gl, ctx.vs, fs);
    } finally {
      gl.deleteShader(fs);
    }
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, ctx.quad);
    var posLoc = gl.getAttribLocation(program, "a_position");
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, 1, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    var fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.viewport(0, 0, width, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    var pixels = new Float32Array(width * 4);
    gl.readPixels(0, 0, width, 1, gl.RGBA, gl.FLOAT, pixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    gl.deleteTexture(tex);
    gl.deleteProgram(program);
    return pixels;
  }

  // Reads back a body's position as a RESIDUAL against `ref`, subtracted in the
  // shader: RGBA32F quantizes an absolute ~700 coordinate at ~6e-5, the error size.
  function gridResidualAtPoint(scene, steps, worldX, worldY, precision, bodyIndex, ref) {
    var B = PhysicsGridCodegen.backendFor(precision);
    var initial = PhysicsGridCodegen.generateGridInitialStateGLSL(scene, precision);
    var frame = scene.frameWidth && scene.frameHeight
      ? { width: scene.frameWidth, height: scene.frameHeight } : undefined;
    var dv = precision === "df" ? "dbody" : "body";
    function residual(axis, value) {
      var v = dv + bodyIndex + "." + axis;
      return precision === "df"
        ? "dfToFloat(dfSub(" + v + ", " + PhysicsDF.num(value) + "))"
        : "(" + v + " - " + PhysicsGPU.fnum(Math.fround(value)) + ")";
    }
    var src = [
      "#version 300 es", "precision highp float;", "out vec4 fragColor;", "",
      // Speed cap and gravity mode are per-scene; forward them.
      PhysicsGPU.libraryGLSL(precision, PhysicsEngine.speedCapFor(scene)), "",
      "const " + B.scalar + " worldX = " + B.lit(worldX) + ";",
      "const " + B.scalar + " worldY = " + B.lit(worldY) + ";", "",
      PhysicsGPU.generateStepOnceGLSL(initial.n, initial.consts, initial.pairs, initial.hingeAnchors, frame, precision, scene.mutualGravity, PhysicsEngine.collisionsEnabled(scene), initial.spawnBase), "",
      "void main() {",
      "  " + initial.declarationLines.join("\n  "),
      "  " + PhysicsGridCodegen.generateCanonicalBodyDeclarationsGLSL(initial).split("\n").join("\n  "),
      "  " + PhysicsGPU.generateHingeAnchorLocalsGLSL(initial.hingeAnchors, precision).split("\n").join("\n  "),
      "  for (int i = 0; i < " + steps + "; i++) { stepOnce(" +
        PhysicsGPU.stepOnceCallArgs(initial.n, initial.hingeAnchors, precision, initial.spawnBase) + "); }",
      "  fragColor = vec4(" + residual("x", ref.x) + ", " + residual("y", ref.y) + ", " +
        residual("angle", ref.angle) + ", 1.0);",
      "}",
    ].join("\n");
    var px = runFloatShader(src, 1);
    return { dx: px[0], dy: px[1], da: px[2], err: Math.hypot(px[0], px[1]) };
  }

  // Same measurement for a whole ROW: texel k simulates worldX = x0 + k*dx (df),
  // one shader compile and one context however many points.
  function gridResidualRow(scene, steps, x0, dx, count, worldY, bodyIndex, ref) {
    var B = PhysicsGridCodegen.backendFor("df");
    var initial = PhysicsGridCodegen.generateGridInitialStateGLSL(scene, "df");
    var frame = PhysicsEngine.wrapsAtEdges(scene) ? { width: scene.frameWidth, height: scene.frameHeight } : undefined;
    function residual(axis, value) {
      return "dfToFloat(dfSub(dbody" + bodyIndex + "." + axis + ", " + PhysicsDF.num(value) + "))";
    }
    var src = [
      "#version 300 es", "precision highp float;", "out vec4 fragColor;", "",
      PhysicsGPU.libraryGLSL("df", PhysicsEngine.speedCapFor(scene)), "",
      PhysicsGPU.generateStepOnceGLSL(initial.n, initial.consts, initial.pairs, initial.hingeAnchors, frame, "df", scene.mutualGravity, PhysicsEngine.collisionsEnabled(scene), initial.spawnBase), "",
      "void main() {",
      // k*dx may be float32; the ADD onto x0 is what needs df, as in the grid shader.
      "  vec2 worldX = dfAddFloat(" + B.lit(x0) + ", (gl_FragCoord.x - 0.5) * " + PhysicsGPU.fnum(dx) + ");",
      "  vec2 worldY = " + B.lit(worldY) + ";",
      "  " + initial.declarationLines.join("\n  "),
      "  " + PhysicsGridCodegen.generateCanonicalBodyDeclarationsGLSL(initial).split("\n").join("\n  "),
      "  " + PhysicsGPU.generateHingeAnchorLocalsGLSL(initial.hingeAnchors, "df").split("\n").join("\n  "),
      "  for (int i = 0; i < " + steps + "; i++) { stepOnce(" +
        PhysicsGPU.stepOnceCallArgs(initial.n, initial.hingeAnchors, "df", initial.spawnBase) + "); }",
      "  fragColor = vec4(" + residual("x", ref.x) + ", " + residual("y", ref.y) + ", " +
        residual("angle", ref.angle) + ", 1.0);",
      "}",
    ].join("\n");
    var px = runFloatShader(src, count);
    var rows = [];
    for (var k = 0; k < count; k++) rows.push({ dx: px[k * 4], dy: px[k * 4 + 1], da: px[k * 4 + 2] });
    return rows;
  }

  // Relative error of df's response to a starting nudge `dx` vs the float64
  // engine's: ~0 resolved it, ~1 never saw it (a float32 stage in the chain).
  function dfResponseError(scene, steps, x0, dx, worldY, bodyIndex) {
    var ref = cpuStateAt(scene, x0, worldY, steps, bodyIndex);
    var moved = cpuStateAt(scene, x0 + dx, worldY, steps, bodyIndex);
    var want = { x: moved.x - ref.x, y: moved.y - ref.y };
    var row = gridResidualRow(scene, steps, x0, dx, 2, worldY, bodyIndex, ref);
    var got = { x: row[1].dx - row[0].dx, y: row[1].dy - row[0].dy };
    var scale = Math.hypot(want.x, want.y);
    return {
      relErr: scale > 0 ? Math.hypot(got.x - want.x, got.y - want.y) / scale : NaN,
      want: scale,
      got: Math.hypot(got.x, got.y),
      offset: Math.hypot(row[0].dx, row[0].dy),
    };
  }

  // Ball dropped between two static walls; same shape as samples/pinball.json.
  function buildDeepZoomScene() {
    return {
      bodies: [
        PhysicsEngine.createCircle(673.9, 46.1, 30, false),
        PhysicsEngine.createLine(323, 468, 300, 0.35, true),
        PhysicsEngine.createLine(903, 475, 300, -0.4, true),
      ],
      hinges: [],
      xInput: { body: 0, property: "x" },
      yInput: { body: 0, property: "y" },
      output: { body: 0, property: "y" },
      frameWidth: 1192, frameHeight: 819,
    };
  }

  function cpuStateAt(scene, worldX, worldY, steps, bodyIndex) {
    var s = PhysicsGridCodegen.computeOffsetSceneNumeric(scene, worldX, worldY);
    for (var i = 0; i < steps; i++) PhysicsEngine.step(s, DT);
    return s.bodies[bodyIndex];
  }

  // ---- df.1 The compiler must not fold the compensation away ----
  addTest(
    "The shader compiler doesn't optimize double-float's error terms to zero",
    "ANGLE's Metal backend reassociates float math; (a+b)-a returns b, so every unveiled EFT yields 0.0",
    function () {
      // Operands must be opaque or the front end constant-folds in higher
      // precision: u_zeroF is a never-assigned uniform (0 by spec), dfv()'s own trick.
      var A = 1000000.0, B = 1e-7; // fl(A+B) == A exactly, so (A+B)-A must be 0
      var src = [
        "#version 300 es", "precision highp float;", "out vec4 fragColor;",
        PhysicsDF.UNIFORM_DECL,
        "uniform float u_zeroF;",
        "float dfv(float x) { return uintBitsToFloat(floatBitsToUint(x) ^ u_dfVeil); }",
        "void main() {",
        "  float a = " + PhysicsGPU.fnum(A) + " + u_zeroF;",
        "  float b = " + PhysicsGPU.fnum(B) + " + u_zeroF;",
        "  fragColor = vec4((a + b) - a, dfv(dfv(a + b) - a), 0.0, 1.0);",
        "}",
      ].join("\n");
      var px = runFloatShader(src, 1);
      var reassociates = px[0] !== 0;
      var veilHolds = px[1] === 0;
      return {
        // The bare result may go either way; only the veiled one must be right.
        pass: veilHolds,
        detail: "bare (a+b)-a = " + px[0] + (reassociates ? " (driver reassociates)" : " (driver is IEEE-conservative)") +
          "; veiled = " + px[1] + " (must be 0)",
      };
    }
  );

  // ---- df.2 The arithmetic itself ----
  addTest(
    "physics-df.js reaches ~15 decimal digits where float32 reaches ~7",
    "a df library whose low word is always 0 still compiles and runs, just without any of the extra precision",
    function () {
      PhysicsDF.usePrecision("df");
      var CENTER = 1234.5678901234, TINY = 3.7e-10;
      var cases = [
        { name: "dfAddFloat(center, 3.7e-10)", glsl: "dfAddFloat(" + PhysicsDF.num(CENTER) + ", " + PhysicsGPU.fnum(TINY) + ")", exact: CENTER + TINY },
        { name: "dfMul(2pi, 1e5)", glsl: "dfMul(DF_TWO_PI, vec2(100000.0, 0.0))", exact: 2 * Math.PI * 1e5 },
        { name: "dfDiv(1, 3)", glsl: "dfDiv(vec2(1.0, 0.0), vec2(3.0, 0.0))", exact: 1 / 3 },
        { name: "dfCos(1e4)", glsl: "dfCos(" + PhysicsDF.num(10000.000000001) + ")", exact: Math.cos(10000.000000001) },
        { name: "dfSin(-3218)", glsl: "dfSin(" + PhysicsDF.num(-3217.9876543) + ")", exact: Math.sin(-3217.9876543) },
        { name: "dfMod(1234.57, 800)", glsl: "dfMod(" + PhysicsDF.num(CENTER) + ", 800.0)", exact: CENTER % 800 },
      ];
      var lines = ["#version 300 es", "precision highp float;", PhysicsDF.UNIFORM_DECL, "out vec4 fragColor;", "",
        PhysicsDF.GLSL_LIBRARY, "", "void main() {", "  int i = int(gl_FragCoord.x);", "  vec2 v = vec2(0.0);"];
      cases.forEach(function (c, i) {
        lines.push("  " + (i === 0 ? "if" : "else if") + " (i == " + i + ") v = " + c.glsl + ";");
      });
      lines.push("  fragColor = vec4(v.x, v.y, 0.0, 1.0);", "}");
      var px = runFloatShader(lines.join("\n"), cases.length);
      var worst = 0, worstName = "";
      cases.forEach(function (c, i) {
        var got = px[i * 4] + px[i * 4 + 1];
        var rel = Math.abs(got - c.exact) / (Math.abs(c.exact) || 1);
        if (rel > worst) { worst = rel; worstName = c.name; }
      });
      // float32 alone is ~6e-8 relative; df's real figure is ~1e-15.
      return { pass: worst < 1e-12, detail: "worst relative error " + worst.toExponential(2) + " (" + worstName + "); float32 alone would be ~6e-8" };
    }
  );

  // ---- df.2b The same, for three and four words ----
  // float64 can't referee 72/96-bit values: BigInt fixed-point (FP_BITS) references, subtracted in-shader.
  var FP_BITS = 300;
  function fpShift() { return BigInt(FP_BITS); }
  function fpOne() { return BigInt(1) << fpShift(); }
  function fpFromDecimal(str) {
    var neg = str[0] === "-";
    if (neg) str = str.slice(1);
    var parts = str.split(".");
    var v = (BigInt(parts[0] + (parts[1] || "")) << fpShift()) / (BigInt(10) ** BigInt((parts[1] || "").length));
    return neg ? -v : v;
  }
  function fpMul(a, b) { return (a * b) >> fpShift(); }
  function fpDiv(a, b) { return (a << fpShift()) / b; }
  function fpSqrt(a) {
    var n = a << fpShift();
    var x = BigInt(1) << BigInt((n.toString(2).length + 1) >> 1);
    for (;;) { var y = (x + n / x) >> BigInt(1); if (y >= x) return x; x = y; }
  }
  function fpAbs(a) { return a < BigInt(0) ? -a : a; }
  var FP_PI = fpFromDecimal("3.14159265358979323846264338327950288419716939937510582097494459230781640628620899862803482534211706798");
  // sin/cos of a fixed-point angle: quarter-turn reduction, then Taylor to convergence.
  function fpSinCos(x) {
    var halfPi = FP_PI >> BigInt(1);
    var k = (x + (halfPi >> BigInt(1))) / halfPi;
    if ((x + (halfPi >> BigInt(1))) < BigInt(0) && (x + (halfPi >> BigInt(1))) % halfPi !== BigInt(0)) k -= BigInt(1);
    var r = x - k * halfPi, r2 = fpMul(r, r);
    var sn = BigInt(0), cs = BigInt(0), term = fpOne();
    for (var n = 0; n < 200 && term !== BigInt(0); n++) {
      if (n % 2 === 0) cs += (n % 4 === 0 ? term : -term);
      else sn += (n % 4 === 1 ? term : -term);
      term = fpMul(term, r) / BigInt(n + 1);
    }
    var q = Number(((k % BigInt(4)) + BigInt(4)) % BigInt(4));
    if (q === 0) return { sin: sn, cos: cs };
    if (q === 1) return { sin: cs, cos: -sn };
    if (q === 2) return { sin: -sn, cos: -cs };
    return { sin: -cs, cos: sn };
  }
  function fpToNumber(v) { return Number(v >> BigInt(FP_BITS - 60)) / Math.pow(2, 60); }

  addTest(
    "Triple- and quad-float arithmetic reach ~21 and ~28 digits",
    "past two words nothing about the arithmetic is hand-written, physics-df.js generates the add/mul/div/sqrt cascades and their constants, and the failure mode is the usual one for this file: a kernel that drops a carry, or a constant that only had a float64's 53 bits to begin with, still compiles and runs, and is simply a few words less precise than it claims",
    function () {
      if (!PhysicsDF.isSupported("qf")) return { pass: true, detail: "no BigInt in this browser: the multi-word precisions are unavailable here, so there is nothing to check" };
      var A = fpFromDecimal("1234.56789012345678901234567890123456789");
      var B = fpFromDecimal("0.00000000000000000000370000000001234567890123");
      var C = fpFromDecimal("3.1415926535897932384626433832795028841971");
      var D = fpFromDecimal("10000.0000000010000000001230000000045");
      var trig = fpSinCos(D);
      var report = [], ok = true;
      ["tf", "qf"].forEach(function (precision) {
        var N = PhysicsDF.usePrecision(precision);
        function lit(v) { return PhysicsDF.literal(PhysicsDF.rationalWords(v, fpOne(), N)); }
        var cases = [
          { name: "add", glsl: "dfAdd(" + lit(A) + ", " + lit(B) + ")", exact: A + B },
          { name: "sub", glsl: "dfSub(" + lit(A) + ", " + lit(C) + ")", exact: A - C },
          { name: "mul", glsl: "dfMul(" + lit(A) + ", " + lit(C) + ")", exact: fpMul(A, C) },
          { name: "sqr", glsl: "dfSqr(" + lit(A) + ")", exact: fpMul(A, A) },
          { name: "div", glsl: "dfDiv(" + lit(A) + ", " + lit(C) + ")", exact: fpDiv(A, C) },
          { name: "sqrt", glsl: "dfSqrt(" + lit(A) + ")", exact: fpSqrt(A) },
          { name: "mulFloat", glsl: "dfMulFloat(" + lit(C) + ", 1234.5)", exact: fpMul(C, fpFromDecimal("1234.5")) },
          { name: "addFloat", glsl: "dfAddFloat(" + lit(A) + ", 0.015625)", exact: A + fpFromDecimal("0.015625") },
          { name: "sin", glsl: "dfSin(" + lit(D) + ")", exact: trig.sin },
          { name: "cos", glsl: "dfCos(" + lit(D) + ")", exact: trig.cos },
          { name: "mod", glsl: "dfMod(" + lit(A) + ", 800.0)", exact: A - fpFromDecimal("800") },
        ];
        var lines = ["#version 300 es", "precision highp float;", PhysicsDF.UNIFORM_DECL, "out vec4 fragColor;", "",
          PhysicsDF.GLSL_LIBRARY, "", "void main() {", "  int i = int(gl_FragCoord.x);", "  float residual = 0.0;"];
        cases.forEach(function (c, i) {
          lines.push("  " + (i === 0 ? "if" : "else if") + " (i == " + i + ") residual = dfToFloat(dfSub(" + c.glsl + ", " + lit(c.exact) + "));");
        });
        lines.push("  fragColor = vec4(residual, 0.0, 0.0, 1.0);", "}");
        var px = runFloatShader(lines.join("\n"), cases.length);
        var worst = 0, worstName = "";
        cases.forEach(function (c, i) {
          var rel = Math.abs(px[i * 4]) / Math.abs(fpToNumber(c.exact));
          if (!(rel <= worst)) { worst = rel; worstName = c.name; }
        });
        // 24 bits a word less what the sloppy cascades give up; a df in disguise would show ~2^-47.
        var bar = Math.pow(2, -(24 * N - 10));
        if (!(worst < bar)) ok = false;
        report.push(precision + ": worst relative error " + worst.toExponential(2) + " (" + worstName + "), bar " + bar.toExponential(1));
      });
      PhysicsDF.usePrecision("df");
      return { pass: ok, detail: report.join("; ") };
    }
  );

  // ---- df.3 The whole per-pixel pipeline, against the float64 engine ----
  addTest(
    "The df step loop tracks the float64 JS engine ~100x closer than float32 does",
    "df accumulators that are wired up wrong (low word dropped on write-back) look exactly like the f32 path",
    function () {
      var scene = buildDeepZoomScene();
      var WORLD_X = 13.7, WORLD_Y = -42.3, STEPS = 10; // contact-free: this measures integration, not collision
      var ref = cpuStateAt(scene, WORLD_X, WORLD_Y, STEPS, 0);
      var f32 = gridResidualAtPoint(scene, STEPS, WORLD_X, WORLD_Y, "f32", 0, ref);
      var df = gridResidualAtPoint(scene, STEPS, WORLD_X, WORLD_Y, "df", 0, ref);
      // f32's floor is one ULP (~7.6e-6); 20x is loose for a path measuring ~1000x.
      return {
        pass: df.err * 20 < f32.err,
        detail: "after " + STEPS + " steps: float32 off by " + f32.err.toExponential(2) +
          " world units, df off by " + df.err.toExponential(2),
      };
    }
  );

  // ---- df.4 The thing the whole feature is for ----
  addTest(
    "Two pixels 1e-9 apart get different starting scenes under df, identical ones under float32",
    "the 32-bit wall: worldX + an authored coordinate of order 1e3 rounds a whole block of pixels onto one starting scene",
    function () {
      var scene = buildDeepZoomScene();
      // Far below float32's ULP here (~6e-5), far above df's (~3e-13).
      var X0 = 13.7, DX = 1e-9, STEPS = 25;
      var ref = cpuStateAt(scene, X0, 0, STEPS, 0);
      function spread(precision) {
        var a = gridResidualAtPoint(scene, STEPS, X0, 0, precision, 0, ref);
        var b = gridResidualAtPoint(scene, STEPS, X0 + DX, 0, precision, 0, ref);
        return Math.hypot(a.dx - b.dx, a.dy - b.dy);
      }
      var f32Spread = spread("f32"), dfSpread = spread("df");
      // Proves the input-side distinction survives, NOT that df resolves it
      // correctly: that is the fidelity test below.
      return {
        pass: f32Spread === 0 && dfSpread > 0,
        detail: "starting positions " + DX + " apart -> outcomes differ by " +
          dfSpread.toExponential(2) + " under df, " + f32Spread.toExponential(2) +
          " under float32 (float32 must be exactly 0: that IS the wall)",
      };
    }
  );

  // ---- df.4b The same question, asked of the FORCE rather than the state ----
  addTest(
    "Mutual Gravity under df answers a 1e-8 nudge in proportion, like the float64 engine",
    "the df pass used to collapse each pairwise separation to float32 and run the force math there, 'because only the accumulators need the digits'. A float32 separation cannot see a nudge smaller than its own ULP (~1e-5px here), so every pixel in that block got an identical acceleration: the nudge was carried along faithfully and never amplified, which is the one thing a chaotic picture is made of. With the force in df the shader's response to the nudge matches the float64 engine's; with a float32 force it comes out several times too small",
    function () {
      var scene = {
        mutualGravity: true,
        bodies: [
          PhysicsEngine.createCircle(400, 300, 30, false),
          PhysicsEngine.createCircle(760, 380, 30, false),
          PhysicsEngine.createCircle(400, 140, 5, false),
        ],
        hinges: [],
        xInput: { body: 2, property: "x" }, yInput: { body: 2, property: "y" },
        output: { body: 2, property: "y" },
        frameWidth: 1192, frameHeight: 809, edgeMode: "infinite",
      };
      scene.bodies[2].vx = 150;
      var STEPS = 60, DX = 1e-8;
      var r = dfResponseError(scene, STEPS, 3.3, DX, -2.1, 2);
      // The tidal field grows a separation ~1.5x per second; an unamplified
      // nudge reads as ~0.3 relative error. The second condition guards retuning.
      return {
        pass: r.relErr < 0.05 && r.want > DX * 1.25,
        detail: "a " + DX + "px nudge grows to " + r.want.toExponential(3) + "px in the float64 engine over " + STEPS +
          " steps and " + r.got.toExponential(3) + "px in the df shader (relative error " + r.relErr.toExponential(2) +
          "; the two engines' common offset is " + r.offset.toExponential(2) + "px)",
      };
    }
  );

  // ---- mf.2 The rungs above df: is the precision there at the END of a run? ----
  // Texel k starts at x0 + NUDGES[k]; positions come back WORD BY WORD (exact
  // in RGBA32F), so texel differences are exact in float64. The slope per
  // nudge is compared to the float64 engine's slope from a 1e-7 nudge.
  // Returns per-nudge relative slope error: ~1e-6 carried, ~1 never seen.
  function ladderSlopeErrors(scene, steps, x0, y0, precision, nudges, bodyIndex) {
    var words = PhysicsDF.wordsFor(precision);
    var B = PhysicsGridCodegen.backendFor(precision);
    var initial = PhysicsGridCodegen.generateGridInitialStateGLSL(scene, precision);
    var frame = PhysicsEngine.wrapsAtEdges(scene) ? { width: scene.frameWidth, height: scene.frameHeight } : undefined;
    var count = nudges.length + 1;
    function wordsOf(expr) {
      var c = [];
      for (var w = 0; w < 4; w++) c.push(w < words ? expr + "." + "xyzw"[w] : "0.0");
      return "vec4(" + c.join(", ") + ")";
    }
    var nudgeLines = nudges.map(function (dx, k) { return "  if (k == " + (k + 1) + ") nudge = " + PhysicsGPU.fnum(dx) + ";"; });
    var src = [
      "#version 300 es", "precision highp float;", "out vec4 fragColor;", "",
      PhysicsGPU.libraryGLSL(precision, PhysicsEngine.speedCapFor(scene)), "",
      PhysicsGPU.generateStepOnceGLSL(initial.n, initial.consts, initial.pairs, initial.hingeAnchors, frame, precision, scene.mutualGravity, PhysicsEngine.collisionsEnabled(scene), initial.spawnBase), "",
      "void main() {",
      "  int texel = int(gl_FragCoord.x); int k = texel % " + count + "; bool wantY = texel >= " + count + ";",
      "  float nudge = 0.0;",
    ].concat(nudgeLines, [
      "  " + B.scalar + " worldX = dfAddFloat(" + B.lit(x0) + ", nudge);",
      "  " + B.scalar + " worldY = " + B.lit(y0) + ";",
      "  " + initial.declarationLines.join("\n  "),
      "  " + PhysicsGridCodegen.generateCanonicalBodyDeclarationsGLSL(initial).split("\n").join("\n  "),
      "  " + PhysicsGPU.generateHingeAnchorLocalsGLSL(initial.hingeAnchors, precision).split("\n").join("\n  "),
      "  for (int i = 0; i < " + steps + "; i++) { stepOnce(" +
        PhysicsGPU.stepOnceCallArgs(initial.n, initial.hingeAnchors, precision, initial.spawnBase) + "); }",
      "  fragColor = wantY ? " + wordsOf("dbody" + bodyIndex + ".y") + " : " + wordsOf("dbody" + bodyIndex + ".x") + ";",
      "}",
    ]).join("\n");
    var px = runFloatShader(src, 2 * count);
    // Smallest words first, so the sum loses nothing to the largest.
    function difference(a, b) {
      var sum = 0;
      for (var w = 3; w >= 0; w--) sum += px[b * 4 + w] - px[a * 4 + w];
      return sum;
    }
    var REF_DX = 1e-7;
    var ref = cpuStateAt(scene, x0, y0, steps, bodyIndex), moved = cpuStateAt(scene, x0 + REF_DX, y0, steps, bodyIndex);
    var slope = { x: (moved.x - ref.x) / REF_DX, y: (moved.y - ref.y) / REF_DX };
    var size = Math.hypot(slope.x, slope.y);
    return {
      slope: slope,
      errors: nudges.map(function (dx, k) {
        var got = { x: difference(0, k + 1) / dx, y: difference(count, count + k + 1) / dx };
        return Math.hypot(got.x - slope.x, got.y - slope.y) / size;
      }),
    };
  }

  // Three scenes, one per kind of machinery, each with a slope that is NOT
  // (1, 0), which would test nothing but addition.
  function ladderScenes() {
    // samples/double_pendulum.json and samples/binary_star.json, hardcoded.
    var pendulum = {
      bodies: [
        PhysicsEngine.createLine(409, 288, 140, -1.5708, false),
        PhysicsEngine.createLine(480, 217, 140, 0, false),
      ],
      hinges: [
        { bodyA: null, bodyB: 0, localAnchorA: { x: 408, y: 358 }, localAnchorB: { x: -70, y: -1 } },
        { bodyA: 0, bodyB: 1, localAnchorA: { x: 70, y: 0 }, localAnchorB: { x: -71, y: -1 } },
      ],
      xInput: { body: 0, property: "angle" }, yInput: { body: 1, property: "angle" },
      output: { body: 1, property: "angle" },
      frameWidth: 1192, frameHeight: 819,
    };
    var stars = {
      mutualGravity: true,
      bodies: [
        PhysicsEngine.createCircle(651, 318, 30, false),
        PhysicsEngine.createCircle(489, 521, 30, false),
        PhysicsEngine.createCircle(202, 165, 5, false),
      ],
      hinges: [],
      xInput: { body: 2, property: "x" }, yInput: { body: 2, property: "y" },
      output: { body: 2, property: "y" },
      frameWidth: 1192, frameHeight: 809, edgeMode: "infinite",
    };
    [[87, 49], [-87, -57], [34, -28]].forEach(function (v, i) { stars.bodies[i].vx = v[0]; stars.bodies[i].vy = v[1]; });
    return [
      // Two bounces inside 150 steps: the right wall at step 59, the left by 140.
      { name: "two wall bounces", scene: buildDeepZoomScene(), steps: 150, x0: 229.13, y0: -0.21 },
      { name: "hinged double pendulum", scene: pendulum, steps: 24, x0: 0.37, y0: -0.21 },
      { name: "mutual gravity", scene: stars, steps: 100, x0: 0.37, y0: -0.21 },
    ];
  }

  addTest(
    "Triple-float still resolves, at the END of a run, a nudge double-float cannot see (collisions, hinges, gravity)",
    "the point of a third word. A 1e-15 nudge moves a ~500px coordinate by a few hundred times less than double-float can resolve there (2^-48 x 500 is about 2e-12), so df's answer to it is noise - which this checks too, since a harness that df could pass would be measuring nothing. Triple-float has to return the float64 engine's slope",
    function () {
      var NUDGE = 1e-15, details = [], pass = true;
      ladderScenes().forEach(function (c) {
        var body = c.scene.output.body;
        var tf = ladderSlopeErrors(c.scene, c.steps, c.x0, c.y0, "tf", [NUDGE], body);
        var df = ladderSlopeErrors(c.scene, c.steps, c.x0, c.y0, "df", [NUDGE], body);
        var moved = Math.hypot(tf.slope.x - 1, tf.slope.y) > 0.05;
        // A resolving rung measures 1e-3 or better; one that cannot, ~1.
        if (!(tf.errors[0] < 0.05 && df.errors[0] > 0.5 && moved)) pass = false;
        details.push(c.name + " (" + c.steps + " steps, slope " + tf.slope.x.toFixed(3) + ", " + tf.slope.y.toFixed(3) + "): tf error " +
          tf.errors[0].toExponential(1) + ", df error " + df.errors[0].toExponential(1));
      });
      return { pass: pass, detail: "answering a " + NUDGE + "px nudge - " + details.join(" | ") + " (want tf < 0.05, and df > 0.5 as the control)" };
    }
  );

  addTest(
    "Quad-float still resolves, at the END of a run, a nudge triple-float cannot see (collisions, hinges, gravity)",
    "the point of a fourth word, by the same method one rung up: a 1e-21 nudge is a hundred times below triple-float's resolution of a ~500px coordinate (2^-72 x 500 is about 1e-19), so tf is the control here and quad-float has to return the float64 engine's slope",
    function () {
      var NUDGE = 1e-21, details = [], pass = true;
      ladderScenes().forEach(function (c) {
        var body = c.scene.output.body;
        var qf = ladderSlopeErrors(c.scene, c.steps, c.x0, c.y0, "qf", [NUDGE], body);
        var tf = ladderSlopeErrors(c.scene, c.steps, c.x0, c.y0, "tf", [NUDGE], body);
        if (!(qf.errors[0] < 0.05 && tf.errors[0] > 0.5)) pass = false;
        details.push(c.name + ": qf error " + qf.errors[0].toExponential(1) + ", tf error " + tf.errors[0].toExponential(1));
      });
      return { pass: pass, detail: "answering a " + NUDGE + "px nudge - " + details.join(" | ") + " (want qf < 0.05, and tf > 0.5 as the control)" };
    }
  );

  // ---- df.5 The two shaders must be the same physics ----
  addTest(
    "The df and float32 shaders agree wherever float32 is still valid",
    "a df path that silently diverges is worse than none: the grid switches between them mid-zoom",
    function () {
      var scene = buildDeepZoomScene();
      // Short enough that chaos hasn't amplified the ~1e-7 path difference.
      var STEPS = 30;
      var worst = 0, worstPoint = null;
      [[0, 0], [13.7, -42.3], [-88.125, 17.5], [301.5, -120.25]].forEach(function (p) {
        var ref = cpuStateAt(scene, p[0], p[1], STEPS, 0);
        var a = gridResidualAtPoint(scene, STEPS, p[0], p[1], "f32", 0, ref);
        var b = gridResidualAtPoint(scene, STEPS, p[0], p[1], "df", 0, ref);
        var d = Math.hypot(a.dx - b.dx, a.dy - b.dy);
        if (d > worst) { worst = d; worstPoint = p; }
      });
      // A few float32 ULPs (~6e-5) is all they may differ by.
      return {
        pass: worst < 1e-3,
        detail: "largest disagreement after " + STEPS + " steps: " + worst.toExponential(2) +
          " world units at (" + worstPoint + ")",
      };
    }
  );

  // ---- df.6 Frame wrapping crossed the seam correctly ----
  addTest(
    "Frame wrapping in df puts a body in the same place float32 wrapping does",
    "the wrap moved out of the float32 leg and onto the df accumulators; an off-by-one-period bug there is invisible until a body crosses",
    function () {
      var scene = buildDeepZoomScene();
      // Long enough to fall out the bottom and wrap to the top at least once.
      var STEPS = 120, WORLD_X = 5.5, WORLD_Y = 0;
      var ref = cpuStateAt(scene, WORLD_X, WORLD_Y, STEPS, 0);
      var f32 = gridResidualAtPoint(scene, STEPS, WORLD_X, WORLD_Y, "f32", 0, ref);
      var df = gridResidualAtPoint(scene, STEPS, WORLD_X, WORLD_Y, "df", 0, ref);
      var inFrame = Math.abs(ref.y) < scene.frameHeight && ref.y >= 0;
      // A mis-wrap is off by a whole frameHeight (819), not by rounding.
      return {
        pass: inFrame && f32.err < 1 && df.err < 1,
        detail: "after " + STEPS + " steps JS has y=" + ref.y.toFixed(3) + "; float32 off by " +
          f32.err.toExponential(2) + ", df off by " + df.err.toExponential(2),
      };
    }
  );

  // ---- df.7 Hinges and rotation go through the df cascade too ----
  addTest(
    "A hinged, rotating scene survives the df cascade (dfRotate / dfReduceAngle)",
    "the offset cascade rotates hinge anchors about a df angle; df trig with a bad range reduction only shows up after many turns",
    function () {
      var scene = {
        bodies: [PhysicsEngine.createLine(409, 288, 140, 0, false), PhysicsEngine.createLine(480, 217, 142, 0, false)],
        hinges: [
          { bodyA: null, bodyB: 0, localAnchorA: { x: 408, y: 358 }, localAnchorB: { x: -70, y: -1 } },
          { bodyA: 0, bodyB: 1, localAnchorA: { x: 70, y: 0 }, localAnchorB: { x: -71, y: -1 } },
        ],
        xInput: { body: 0, property: "angle" },
        yInput: { body: 1, property: "angle" },
        output: { body: 1, property: "angle" },
        frameWidth: 1192, frameHeight: 819,
      };
      // *360: ANGLE_INPUT_SCALE (physics-grid-codegen.js); keeps the 0.35/-0.2 rad offsets.
      var STEPS = 20, WORLD_X = 0.35 * 360, WORLD_Y = -0.2 * 360;
      var ref = cpuStateAt(scene, WORLD_X, WORLD_Y, STEPS, 1);
      var f32 = gridResidualAtPoint(scene, STEPS, WORLD_X, WORLD_Y, "f32", 1, ref);
      var df = gridResidualAtPoint(scene, STEPS, WORLD_X, WORLD_Y, "df", 1, ref);
      return {
        pass: df.err < f32.err && df.err < 1e-4,
        detail: "double pendulum, angle-linked inputs, " + STEPS + " steps: float32 off by " +
          f32.err.toExponential(2) + ", df off by " + df.err.toExponential(2),
      };
    }
  );

  addTest(
    "A starting velocity survives into the fractal grid's own shader",
    "generateCanonicalBodyDeclarationsGLSL hardcoded all three velocity accumulators to zero: correct back when nothing could give a body a starting velocity, silently wrong once the Set Velocity tool could. The JS mirror (computeOffsetSceneNumeric, via cloneScene) kept the velocity all along, so the grid ran a different scene than its own hover preview claimed",
    function () {
      var scene = {
        bodies: [PhysicsEngine.createCircle(300, 250, 28, false)],
        hinges: [],
        xInput: { body: 0, property: "x" },
        yInput: null,
        output: { body: 0, property: "y" },
      };
      scene.bodies[0].vx = 393;
      scene.bodies[0].vy = -282;

      var N = 6, WORLD_X = 40;
      var compiled = PhysicsGridCodegen.compileHoverTrajectoryGLSL(scene, WORLD_X, 0, N);
      var trajectory = PhysicsGPU.runCompiledTrajectoryOnGPU(compiled, N);

      // The same offset scene stepped by the JS engine, which always kept vx/vy.
      var jsScene = PhysicsGridCodegen.computeOffsetSceneNumeric(scene, WORLD_X, 0);
      var maxErr = 0;
      for (var i = 0; i < N; i++) {
        PhysicsEngine.step(jsScene, PhysicsGPU.FIXED_DT);
        maxErr = Math.max(maxErr,
          Math.abs(jsScene.bodies[0].x - trajectory[i][0].x),
          Math.abs(jsScene.bodies[0].y - trajectory[i][0].y));
      }

      // With the bug the GPU body started at rest and just fell.
      var travelledSideways = Math.abs(trajectory[N - 1][0].x - (300 + WORLD_X));
      return {
        pass: maxErr < 0.01 && travelledSideways > 20,
        detail: "GPU vs JS over " + N + " steps: max error=" + maxErr.toFixed(5) +
          "px; GPU body carried " + travelledSideways.toFixed(1) +
          "px sideways from its start (0 would mean the velocity was dropped again)",
      };
    }
  );

  addTest(
    "Mutual Gravity: JS engine and GPU compiler agree step-by-step",
    "the n-body attraction is a second hand-synced pair of implementations (PhysicsEngine.computeAccelerations and its GLSL port in generateStepOnceGLSL): exactly the kind of split that has drifted before. Checked over two regimes on purpose: several mutually-attracting bodies IS the n-body problem, i.e. genuinely chaotic, so there the two are compared only over the horizon where float32-vs-float64 rounding hasn't yet been amplified into visibility (measured: they agree to ~3e-5px at step 1 and the gap then grows about 10x per 20 steps, which is the physics, not a porting error). A two-body orbit is integrable rather than chaotic, so that one is held to the same tight bound for 300 steps and catches any slow, systematic disagreement the short run would miss.",
    function () {
      function maxErrAt(jsScene, traj, target, stepped) {
        while (stepped.n < target) { PhysicsEngine.step(jsScene, DT); stepped.n++; }
        var row = traj[target - 1], e = 0;
        for (var b = 0; b < jsScene.bodies.length; b++) {
          e = Math.max(e, Math.abs(jsScene.bodies[b].x - row[b].x), Math.abs(jsScene.bodies[b].y - row[b].y));
        }
        return e;
      }

      // Regime 1: four mutually-attracting bodies, short horizon.
      function chaotic() {
        return {
          mutualGravity: true,
          bodies: [
            PhysicsEngine.createCircle(300, 300, 40, false),
            PhysicsEngine.createCircle(700, 320, 25, false),
            PhysicsEngine.createCircle(500, 640, 60, true),
            PhysicsEngine.createLine(760, 620, 120, 0.4, false),
          ],
          hinges: [],
        };
      }
      // An early tight bound (before chaos amplifies rounding) tests fidelity;
      // the late loose one catches gross divergence. A real mismatch showed ~100px.
      var cScene = chaotic(), cTraj = PhysicsGPU.runSceneOnGPU(chaotic(), 40), cStepped = { n: 0 };
      var cEarlyErr = 0, cErr = 0;
      [1, 5].forEach(function (t) { cEarlyErr = Math.max(cEarlyErr, maxErrAt(cScene, cTraj, t, cStepped)); });
      cErr = cEarlyErr;
      [20, 40].forEach(function (t) { cErr = Math.max(cErr, maxErrAt(cScene, cTraj, t, cStepped)); });
      var cMoved = Math.abs(cScene.bodies[0].x - 300) + Math.abs(cScene.bodies[1].x - 700);

      // Regime 2: one free body orbiting one anchored one, long horizon. A WIDE
      // orbit (closest ~234px vs 39px contact): bodies in contact exert no mutual
      // gravity, so a grazing orbit flips that switch on the last bit of a float.
      function orbit() {
        var s = {
          mutualGravity: true,
          bodies: [
            PhysicsEngine.createCircle(1000, 400, 9, false),
            PhysicsEngine.createCircle(500, 400, 30, true),
          ],
          hinges: [],
        };
        s.bodies[0].vy = 300; // tangential, so it swings around rather than falling straight in
        return s;
      }
      var oScene = orbit(), oTraj = PhysicsGPU.runSceneOnGPU(orbit(), 300), oStepped = { n: 0 };
      var oErr = 0;
      [1, 50, 150, 300].forEach(function (t) { oErr = Math.max(oErr, maxErrAt(oScene, oTraj, t, oStepped)); });
      // Both must have gone somewhere, so "agrees nothing happened" can't pass.
      var oMoved = Math.abs(oScene.bodies[0].x - 500) + Math.abs(oScene.bodies[0].y - 300);

      // Orbit bound 0.5px, not 0.01px: it runs uncapped at ~1500px/s (the old
      // MAX_SPEED clamp hid the float32/float64 gap) and drifts to ~2e-1 by step 200.
      return {
        pass: cEarlyErr < 1e-4 && cErr < 0.1 && cMoved > 5 && oErr < 0.5 && oMoved > 100,
        detail: "4-body (chaotic): max error=" + cEarlyErr.toExponential(2) + "px over the first 5 steps, " +
          cErr.toExponential(2) + "px by step 40, after moving " + cMoved.toFixed(1) +
          "px; 2-body orbit, steps 1-300: max error=" + oErr.toExponential(2) +
          "px after travelling " + oMoved.toFixed(1) + "px",
      };
    }
  );

  addTest(
    "Mutual Gravity: an anchored body pulls at 10x density and never gets pulled",
    "the one rule that isn't plain Newton: anchored bodies have mass 0 in the solver (that IS how 'immovable' is spelled), so gravitational mass has to come from the shape instead, with the 10x applied",
    function () {
      function pullOn0(secondAnchored) {
        var scene = {
          mutualGravity: true,
          bodies: [
            PhysicsEngine.createCircle(300, 300, 30, false),
            PhysicsEngine.createCircle(700, 300, 30, secondAnchored),
          ],
          hinges: [],
        };
        return PhysicsEngine.computeAccelerations(scene)[0].x;
      }
      var free = pullOn0(false), anchored = pullOn0(true);
      var ratio = anchored / free;

      // And it must stay put while doing it.
      var scene = {
        mutualGravity: true,
        bodies: [
          PhysicsEngine.createCircle(300, 300, 30, false),
          PhysicsEngine.createCircle(700, 300, 30, true),
        ],
        hinges: [],
      };
      for (var i = 0; i < 60; i++) PhysicsEngine.step(scene, DT);
      var anchorDrift = Math.abs(scene.bodies[1].x - 700) + Math.abs(scene.bodies[1].y - 300);
      var pulledIn = 700 - scene.bodies[0].x > 5;

      return {
        pass: Math.abs(ratio - 10) < 1e-9 && anchorDrift === 0 && pulledIn,
        detail: "identical neighbour pulls " + free.toFixed(3) + " free vs " + anchored.toFixed(3) +
          " anchored (ratio " + ratio.toFixed(6) + ", want 10); anchor drifted " + anchorDrift.toFixed(6) +
          "px over 60 steps; free body was drawn toward it=" + pulledIn,
      };
    }
  );

  addTest(
    "Mutual Gravity off leaves the old constant-gravity behaviour exactly as it was",
    "computeAccelerations replaced a hardcoded downward scalar for EVERY scene, so the default path had to come out bit-for-bit unchanged",
    function () {
      var scene = {
        bodies: [PhysicsEngine.createCircle(400, 100, 30, false)],
        hinges: [],
      };
      var STEPS = 10;
      for (var i = 0; i < STEPS; i++) PhysicsEngine.step(scene, DT);
      // Free fall from rest: v = g*t exactly, with no sideways component.
      var wantVy = PhysicsEngine.GRAVITY * DT * STEPS;
      return {
        pass: Math.abs(scene.bodies[0].vy - wantVy) < 1e-9 && scene.bodies[0].vx === 0 && scene.bodies[0].x === 400,
        detail: "after " + STEPS + " steps: vy=" + scene.bodies[0].vy.toFixed(6) + " (want " + wantVy.toFixed(6) +
          "), vx=" + scene.bodies[0].vx + ", x=" + scene.bodies[0].x + " (want unmoved sideways)",
      };
    }
  );

  addTest(
    "Mutual Gravity: bodies that collide bounce, nothing welds them together",
    "Mutual Gravity used to weld touching bodies into one (merge-on-contact). That feature was retired: a collision under Mutual Gravity is now the same impulse bounce it is everywhere else, and Collisions=off is the recommended way to avoid contact altogether. This pins the retirement on the JS side: a leftover weld would hold the pair at contact forever",
    function () {
      function c(x) {
        return { type: "circle", x: x, y: 300, angle: 0, radius: 30, vx: 0, vy: 0, w: 0, isAnchored: false };
      }
      var scene = {
        mutualGravity: true,
        bodies: [c(350), c(650)], hinges: [],
      };
      scene.bodies.forEach(PhysicsEngine.computeMass);
      var a = scene.bodies[0], b = scene.bodies[1];
      var contact = a.radius + b.radius;

      var flags = [], touchedAt = null, maxSepAfterTouch = 0;
      for (var i = 0; i < 400; i++) {
        PhysicsEngine.step(scene, DT, { contactFlags: flags });
        if (touchedAt === null && flags[0]) touchedAt = i;
        if (touchedAt !== null && i > touchedAt) {
          maxSepAfterTouch = Math.max(maxSepAfterTouch, Math.hypot(b.x - a.x, b.y - a.y));
        }
      }
      // They meet at ~270px/s each, above the restitution threshold: elastic bounce.
      return {
        pass: touchedAt !== null && maxSepAfterTouch > contact + 20,
        detail: "first contact at step " + touchedAt + "; afterwards they parted by up to " +
          maxSepAfterTouch.toFixed(2) + "px (they touch at " + contact + " - a weld would have held them there)",
      };
    }
  );

  addTest(
    "Mutual Gravity: a collision conserves momentum",
    "between two free bodies the pull is equal and opposite and so is the contact impulse, so a bounce under Mutual Gravity must leave the pair's total momentum where it was, and must actually be a bounce, not the perfectly inelastic weld this engine used to apply",
    function () {
      // Small fast body into a big stationary one, frame off so nothing wraps.
      var scene = {
        mutualGravity: true,
        bodies: [
          PhysicsEngine.createCircle(0, 0, 15, false),
          PhysicsEngine.createCircle(200, 0, 45, false),
        ],
        hinges: [],
      };
      var a = scene.bodies[0], b = scene.bodies[1];
      a.vx = 400;
      var pBefore = a.mass * a.vx + b.mass * b.vx;
      var flags = [], touched = false, relSpeedAfter = 0;
      for (var i = 0; i < 60; i++) {
        PhysicsEngine.step(scene, DT, { contactFlags: flags });
        if (flags[0]) touched = true;
        else if (touched && relSpeedAfter === 0) relSpeedAfter = Math.hypot(b.vx - a.vx, b.vy - a.vy);
      }
      var pAfter = a.mass * a.vx + b.mass * b.vx;
      return {
        pass: touched && Math.abs(pAfter - pBefore) / Math.abs(pBefore) < 1e-9 && relSpeedAfter > 100,
        detail: "momentum " + pBefore.toExponential(6) + " -> " + pAfter.toExponential(6) +
          "; relative speed once they parted=" + relSpeedAfter.toFixed(1) + "px/s (a weld would leave 0)",
      };
    }
  );

  addTest(
    "Mutual Gravity leaves hinged assemblies free to move",
    "a hinged pair overlaps at its shared pivot permanently, so anything that treats overlap as contact (the retired merge-on-contact did, and had to skip hinge-joined pairs to avoid it) would freeze every pendulum solid the moment Mutual Gravity was switched on",
    function () {
      // Needs a third body: two hinged links alone attract only along the hinge,
      // which the hinge cancels, so the pendulum would sit still legitimately.
      var scene = {
        mutualGravity: true,
        bodies: [
          PhysicsEngine.createLine(500, 300, 200, 0, false),
          PhysicsEngine.createLine(700, 300, 200, 0, false),
          PhysicsEngine.createCircle(500, 900, 60, true),
        ],
        hinges: [
          { bodyA: null, bodyB: 0, localAnchorA: { x: 400, y: 300 }, localAnchorB: { x: -100, y: 0 } },
          { bodyA: 0, bodyB: 1, localAnchorA: { x: 100, y: 0 }, localAnchorB: { x: -100, y: 0 } },
        ],
      };
      // Freezing would destroy the links' RELATIVE motion; the assembly could still swing.
      var startAngleGap = scene.bodies[1].angle - scene.bodies[0].angle;
      var maxAngleChange = 0;
      for (var i = 0; i < 300; i++) {
        PhysicsEngine.step(scene, DT);
        maxAngleChange = Math.max(maxAngleChange,
          Math.abs((scene.bodies[1].angle - scene.bodies[0].angle) - startAngleGap));
      }
      return {
        pass: maxAngleChange > 0.1,
        detail: "the angle between the two links changed by up to " +
          maxAngleChange.toFixed(3) + " rad over 300 steps (a frozen assembly would hold it at 0)",
      };
    }
  );

  addTest(
    "The speed cap is raised for Mutual Gravity and unchanged for ordinary gravity",
    "reported as an orbit dropping to a lower one on its first pass and then looking correct forever after. The cause was MAX_SPEED: a close perihelion legitimately needs ~2000px/s, and clamping it to 1000 deleted that energy once, after which the smaller orbit never reached the cap again, which is why it then looked stable. Raised only for Mutual Gravity, so every existing downward-gravity scene, and every fractal image already rendered from one, is untouched",
    function () {
      var plain = PhysicsEngine.speedCapFor({ mutualGravity: false });
      var mutual = PhysicsEngine.speedCapFor({ mutualGravity: true });

      // A body under ordinary gravity must still be held at the lower ceiling.
      var falling = {
        bodies: [PhysicsEngine.createCircle(500, 0, 20, false)], hinges: [],
      };
      falling.bodies[0].vy = 100000; // absurd, purely to drive it into the clamp
      PhysicsEngine.step(falling, DT);
      var plainClamped = Math.hypot(falling.bodies[0].vx, falling.bodies[0].vy);

      // The same absurd speed under Mutual Gravity clamps to the higher one.
      var orbiting = {
        mutualGravity: true,
        bodies: [PhysicsEngine.createCircle(500, 0, 20, false)], hinges: [],
      };
      orbiting.bodies[0].vy = 100000;
      PhysicsEngine.step(orbiting, DT);
      var mutualClamped = Math.hypot(orbiting.bodies[0].vx, orbiting.bodies[0].vy);

      return {
        pass: plain === 2000 && mutual === 5000 &&
          Math.abs(plainClamped - 2000) < 1e-6 && Math.abs(mutualClamped - 5000) < 1e-6,
        detail: "ordinary gravity caps at " + plain + " (a body launched at 100000 came out at " +
          plainClamped.toFixed(1) + "), Mutual Gravity at " + mutual + " (came out at " +
          mutualClamped.toFixed(1) + ")",
      };
    }
  );

  addTest(
    "Mutual Gravity: an orbit clear of the surface is a closed Kepler ellipse",
    "reported as an orbit coming out 'a very different shape' from what Kepler predicts. Widening MUTUAL_GRAVITY_SOFTENING for the bounce had put a flattened, non-inverse-square region around every body, and an orbit dipping into one precesses instead of closing: 177 degrees per lap on the reported scene. This pins the property that matters: an orbit that stays clear of the bodies themselves must close, lap after lap, at the distance Kepler says",
    function () {
      // 500px out at 300px/s tangential: a wide ellipse clear of both surfaces.
      var scene = {
        mutualGravity: true,
        bodies: [
          PhysicsEngine.createCircle(1000, 400, 9, false),
          PhysicsEngine.createCircle(500, 400, 30, true),
        ],
        hinges: [],
      };
      scene.bodies[0].vy = 300;

      // Closed form from the engine's own constants: compares against Kepler.
      var mu = PhysicsEngine.MUTUAL_GRAVITY_CONSTANT * PhysicsEngine.gravitationalMass(scene.bodies[1]);
      var r0 = 500, v0 = 300, L = r0 * v0;
      var E = v0 * v0 / 2 - mu / r0;
      var semiMajor = -mu / (2 * E);
      var ecc = Math.sqrt(Math.max(0, 1 + 2 * E * L * L / (mu * mu)));
      var keplerPeri = semiMajor * (1 - ecc);

      // Record each perihelion's distance and direction: a closed ellipse repeats
      // both, a rosette walks the direction round.
      var peris = [], prevR = null, prevPrev = null;
      for (var i = 0; i < 25 * 60; i++) {
        PhysicsEngine.step(scene, DT);
        var dx = scene.bodies[0].x - scene.bodies[1].x, dy = scene.bodies[0].y - scene.bodies[1].y;
        var r = Math.hypot(dx, dy);
        if (prevPrev !== null && prevR < prevPrev && prevR <= r) {
          peris.push({ r: prevR, ang: Math.atan2(dy, dx) * 180 / Math.PI });
        }
        prevPrev = prevR; prevR = r;
      }
      var precession = null;
      if (peris.length > 1) {
        precession = peris[1].ang - peris[0].ang;
        while (precession > 180) precession -= 360;
        while (precession < -180) precession += 360;
      }
      var distanceErr = peris.length ? Math.abs(peris[0].r - keplerPeri) : Infinity;
      return {
        pass: peris.length >= 2 && distanceErr < 5 && Math.abs(precession) < 3,
        detail: "perihelion " + (peris.length ? peris[0].r.toFixed(0) : "-") + "px against Kepler's " +
          keplerPeri.toFixed(0) + "px (off by " + distanceErr.toFixed(1) + "), precessing " +
          (precession === null ? "n/a" : precession.toFixed(1) + "° per lap") +
          " - a rosette would walk it round tens of degrees a lap",
      };
    }
  );

  addTest(
    "Mutual Gravity's softening leaves orbital distances on an exact inverse square",
    "the softening that fixed the bounce works by flattening the force near contact, so it has to be checked that it flattens ONLY there: a scene whose bodies orbit rather than collide must be completely unaffected by it",
    function () {
      function pullAt(sep) {
        function c(x) {
          return { type: "circle", x: x, y: 0, angle: 0, radius: 30, vx: 0, vy: 0, w: 0, isAnchored: false };
        }
        var scene = { mutualGravity: true,
                      bodies: [c(0), c(sep)], hinges: [] };
        scene.bodies.forEach(PhysicsEngine.computeMass);
        return PhysicsEngine.computeAccelerations(scene)[0].x;
      }
      // Halving the distance must quadruple the pull wherever they're not touching.
      var worst = 0;
      [61, 80, 150, 200, 300, 500].forEach(function (r) {
        worst = Math.max(worst, Math.abs(pullAt(r) / pullAt(r * 2) - 4));
      });
      var justClear = pullAt(60.001), justTouching = pullAt(59.999);
      return {
        pass: worst < 1e-9 && justClear > 0 && justTouching === 0,
        detail: "inverse square exact from the moment they part (worst deviation " + worst.toExponential(1) +
          ") - pull is " + justClear.toFixed(0) + " a hair clear of contact and exactly " + justTouching +
          " a hair inside it",
      };
    }
  );

  addTest(
    "Mutual Gravity never invents energy against a body it is resting on",
    "reported as a ball that bounced, stopped, and then whipped round the anchored body at rising speed. A body at rest sits a fraction of a pixel inside the surface, and the contact solver's positional correction pushes it out WITHOUT changing its velocity: free work, done in a field of ~19,600px/s^2 right at contact. Gravity turned it back into speed, the body drove deeper, the correction pushed harder: energy climbed on 401 of 900 steps. Bodies in contact now exert no mutual gravity, which is also the honest reading (the contact normal force is what answers the attraction, and the solver already supplies it)",
    function () {
      // The reported scene: a free circle falls onto an anchored one and settles.
      var scene = {
        mutualGravity: true,
        bodies: [
          PhysicsEngine.createCircle(538, 427, 30, true),
          PhysicsEngine.createCircle(907, 221, 30, false),
        ],
        hinges: [], frameWidth: 1192, frameHeight: 809,
      };
      var anchor = scene.bodies[0], ball = scene.bodies[1];
      var G = PhysicsEngine.MUTUAL_GRAVITY_CONSTANT;
      function totalEnergy() {
        var r = Math.hypot(ball.x - anchor.x, ball.y - anchor.y);
        var contact = anchor.radius + ball.radius;
        var k = G * PhysicsEngine.gravitationalMass(anchor) * ball.mass;
        // Potential matching the force law: 1/r apart, flat once touching.
        var u = r >= contact ? -k / r : -k / contact;
        return 0.5 * ball.mass * (ball.vx * ball.vx + ball.vy * ball.vy) + u;
      }
      // It must SETTLE, not wind up: a pump makes the second half the faster one.
      var earlyPeak = 0, latePeak = 0;
      for (var i = 0; i < 900; i++) {
        PhysicsEngine.step(scene, DT);
        var speed = Math.hypot(ball.vx, ball.vy);
        if (i < 450) earlyPeak = Math.max(earlyPeak, speed);
        else latePeak = Math.max(latePeak, speed);
      }
      var finalSep = Math.hypot(ball.x - anchor.x, ball.y - anchor.y);
      var finalSpeed = Math.hypot(ball.vx, ball.vy);
      // Before the fix: lodged 57.4px inside the 60px contact at 1110px/s and climbing.
      return {
        pass: finalSpeed < 100 && finalSep >= 59.5 && latePeak < earlyPeak,
        detail: "after 900 steps: resting " + finalSep.toFixed(1) + "px apart (they touch at 60) at " +
          finalSpeed.toFixed(0) + "px/s; fastest in the first half " + earlyPeak.toFixed(0) +
          "px/s vs the second half " + latePeak.toFixed(0) +
          "px/s (a pump makes the second half faster: it used to end at 57.4px doing 1110px/s and rising)",
      };
    }
  );

  addTest(
    "Bounce Count counts contact episodes, not steps spent in contact",
    "PhysicsEngine.runBounceCounts: a body resting or sliding on a surface is touching for hundreds of consecutive steps, which a naive per-step tally would report as hundreds of bounces for what is visibly one",
    function () {
      // Set down already sliding: frictionless, it never leaves the surface.
      var scene = {
        bodies: [
          { type: "circle", x: 150, y: 570, angle: 0, isAnchored: false, radius: 20, vx: 60, vy: 0, w: 0 },
          { type: "line", x: 400, y: 600, angle: 0, isAnchored: true, length: 700, vx: 0, vy: 0, w: 0 },
        ],
        hinges: [], frameWidth: 1200, frameHeight: 800,
      };
      var STEPS = 500;
      var counts = PhysicsEngine.runBounceCounts(scene, 0, STEPS, PhysicsGPU.FIXED_DT);

      // The same run, tallied the naive way, for the contrast this is about.
      var sim = PhysicsEngine.cloneScene(scene);
      sim.bodies.forEach(PhysicsEngine.computeMass);
      var flags = [], touchingSteps = 0;
      for (var i = 0; i < STEPS; i++) {
        PhysicsEngine.step(sim, PhysicsGPU.FIXED_DT, { contactFlags: flags });
        if (flags[0]) touchingSteps++;
      }

      // Monotonic and never running ahead of the steps that have happened.
      var monotonic = true;
      for (var k = 1; k < counts.length; k++) {
        if (counts[k] < counts[k - 1] || counts[k] > k + 1) monotonic = false;
      }
      var total = counts[STEPS - 1];
      return {
        pass: monotonic && total >= 1 && total <= 5 && touchingSteps > 100,
        detail: "ball sliding along a floor: " + touchingSteps + " of " + STEPS +
          " steps in contact, reported as " + total + " bounce(s) (want a handful, not ~" + touchingSteps +
          "); running totals monotonic=" + monotonic,
      };
    }
  );

  addTest(
    "A body with nothing to collide with never registers a bounce",
    "PhysicsEngine.step's contactFlags must be rewritten each step, not accumulated: a stale true would make every later step read as still-touching",
    function () {
      var scene = {
        bodies: [{ type: "circle", x: 400, y: 200, angle: 0, isAnchored: false, radius: 20, vx: 0, vy: 0, w: 0 }],
        hinges: [], frameWidth: 1200, frameHeight: 800,
      };
      var counts = PhysicsEngine.runBounceCounts(scene, 0, 300, PhysicsGPU.FIXED_DT);
      return {
        pass: counts[299] === 0,
        detail: "lone falling circle after 300 steps: " + counts[299] + " bounces (want 0)",
      };
    }
  );

  // ---- df.8 The honest version of "does df buy resolution" ----
  addTest(
    "Where float32 renders one flat color, df still tracks the float64 engine",
    "measuring the gain as \"do neighbouring pixels differ\" counts quantization noise as detail: it overstated this by ~3 decades",
    function () {
      // Metric: agreement with the float64 engine, not whether adjacent pixels
      // differ (noise decorrelates from truth). samples/double_pendulum.json, hardcoded.
      var scene = {
        bodies: [
          PhysicsEngine.createLine(409, 288, 140, -1.5708, false),
          PhysicsEngine.createLine(480, 217, 140, 0, false),
        ],
        hinges: [
          { bodyA: null, bodyB: 0, localAnchorA: { x: 408, y: 358 }, localAnchorB: { x: -70, y: -1 } },
          { bodyA: 0, bodyB: 1, localAnchorA: { x: 70, y: 0 }, localAnchorB: { x: -71, y: -1 } },
        ],
        xInput: { body: 0, property: "angle" },
        yInput: { body: 1, property: "angle" },
        output: { body: 1, property: "angle" },
        frameWidth: 1192, frameHeight: 819,
      };
      var N = 6, STEPS = 150, X0 = 0.7, Y0 = -0.3, BODY = 1;
      var ref = cpuStateAt(scene, X0, Y0, STEPS, BODY);
      function rowAt(width, precision) {
        var out = [];
        for (var i = 0; i < N; i++) {
          var x = X0 + (i / (N - 1) - 0.5) * width;
          out.push(precision === "cpu"
            ? cpuStateAt(scene, x, Y0, STEPS, BODY).angle
            : gridResidualAtPoint(scene, STEPS, x, Y0, precision, BODY, ref).da);
        }
        return out;
      }
      function distinct(values) {
        var seen = {}, n = 0;
        values.forEach(function (v) { if (!(v in seen)) { seen[v] = 1; n++; } });
        return n;
      }
      function correlation(a, b) {
        var n = a.length, ma = 0, mb = 0, i;
        for (i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
        ma /= n; mb /= n;
        var num = 0, da = 0, db = 0;
        for (i = 0; i < n; i++) {
          var x = a[i] - ma, y = b[i] - mb;
          num += x * y; da += x * x; db += y * y;
        }
        return (da > 0 && db > 0) ? num / Math.sqrt(da * db) : NaN;
      }
      // Searched, not hardcoded: where float32 gives out depends on the scene.
      var collapsedWidth = null;
      var widths = [3e-5, 1e-5, 3e-6];
      for (var w = 0; w < widths.length && collapsedWidth === null; w++) {
        if (distinct(rowAt(widths[w], "f32")) === 1) collapsedWidth = widths[w];
      }
      if (collapsedWidth === null) {
        return { pass: false, detail: "float32 never collapsed to a single value across " + widths.join(", ") + " - this test can no longer tell the two apart" };
      }
      var dfCorr = correlation(rowAt(collapsedWidth, "df"), rowAt(collapsedWidth, "cpu"));
      // 0.5 is the floor; df reaches 1.000 here. A finer sweep costs ~30 more
      // shader compiles, too close to the WebGL context ceiling (see runFloatShader).
      return {
        pass: dfCorr > 0.5,
        detail: "across a " + collapsedWidth.toExponential(0) + "-wide row float32 has collapsed to one value; " +
          "df correlates " + dfCorr.toFixed(3) + " with the float64 engine (must be > 0.5)",
      };
    }
  );

  addTest(
    "Infinite Space lets bodies leave the frame, where the other two edge modes wrap",
    "the third edge mode. Sticky and Pac-Man both rely on PhysicsEngine.step's frame wrap happening and differ only in how the result is READ; Infinite Space is the one that turns the wrap off, in the JS engine and in the generated GLSL alike (the shader is handed no frame at all, so it emits no wrap)",
    function () {
      function fallFor(mode) {
        var scene = {
          edgeMode: mode,
          bodies: [PhysicsEngine.createCircle(500, 400, 20, false)],
          hinges: [], frameWidth: 900, frameHeight: 600,
        };
        for (var i = 0; i < 200; i++) PhysicsEngine.step(scene, DT);
        return scene.bodies[0].y;
      }
      var sticky = fallFor("sticky"), wrap = fallFor("wrap"), infinite = fallFor("infinite");
      return {
        pass: sticky < 600 && wrap < 600 && infinite > 600 && Math.abs(sticky - wrap) < 1e-9,
        detail: "after 200 steps of free fall in a 600-tall frame: sticky y=" + sticky.toFixed(1) +
          ", wrap y=" + wrap.toFixed(1) + " (both wrapped back inside), infinite y=" + infinite.toFixed(1) +
          " (kept going)",
      };
    }
  );

  addTest(
    "Infinite Space: JS engine and GPU compiler agree",
    "turning the wrap off is a change in the generated shader as well as the engine: the GPU path stops being handed a frame, so this checks the two still walk together once bodies are far outside it",
    function () {
      function build() {
        var s = {
          edgeMode: "infinite",
          bodies: [
            PhysicsEngine.createCircle(500, 400, 20, false),
            PhysicsEngine.createCircle(300, 200, 25, false),
          ],
          hinges: [], frameWidth: 900, frameHeight: 600,
        };
        s.bodies[1].vx = 240;
        return s;
      }
      var js = build(), traj = PhysicsGPU.runSceneOnGPU(build(), 150), err = 0;
      for (var i = 0; i < 150; i++) {
        PhysicsEngine.step(js, DT);
        for (var b = 0; b < js.bodies.length; b++) {
          err = Math.max(err, Math.abs(js.bodies[b].x - traj[i][b].x), Math.abs(js.bodies[b].y - traj[i][b].y));
        }
      }
      // Must actually have left the frame, or this would pass vacuously.
      var leftFrame = js.bodies[0].y > 600;
      return {
        pass: err < 0.05 && leftFrame,
        detail: "max JS-vs-GPU error " + err.toExponential(2) + "px over 150 steps, ending at y=" +
          js.bodies[0].y.toFixed(0) + " in a 600-tall frame",
      };
    }
  );

  addTest(
    "Infinite Space lets a pixel's offset start a body outside the frame",
    "the other two edge modes settle a body's STARTING position back into the frame with a mod(), so sweeping the X/Y Input far enough cycles it through the frame over and over. Infinite Space has no frame to settle into, so the mapping is linear instead, and the two implementations of that settle (generateGridInitialStateGLSL's GLSL and computeOffsetSceneNumeric's JS) have to skip it together, or the hover preview would show a different starting scene from the pixel it is previewing",
    function () {
      function base(mode) {
        return {
          mutualGravity: false,
          bodies: [PhysicsEngine.createCircle(500, 400, 20, false)], hinges: [],
          xInput: { body: 0, property: "x" }, yInput: { body: 0, property: "y" },
          output: { body: 0, property: "y" }, frameWidth: 900, frameHeight: 600,
          edgeMode: mode,
        };
      }
      var OFFSET = 2500; // several frame-widths out
      var sticky = PhysicsGridCodegen.computeOffsetSceneNumeric(base("sticky"), OFFSET, 0).bodies[0].x;
      var wrap = PhysicsGridCodegen.computeOffsetSceneNumeric(base("wrap"), OFFSET, 0).bodies[0].x;
      var infinite = PhysicsGridCodegen.computeOffsetSceneNumeric(base("infinite"), OFFSET, 0).bodies[0].x;

      // The GPU's own start for the same pixel; gravity is y-only, so step 0's x is the start.
      var compiled = PhysicsGridCodegen.compileHoverTrajectoryGLSL(base("infinite"), OFFSET, 0, 2, "f32");
      var gpuStart = PhysicsGPU.runCompiledTrajectoryOnGPU(compiled, 2)[0][0].x;

      return {
        pass: Math.abs(infinite - 3000) < 1e-6 && sticky < 900 && wrap < 900 &&
          Math.abs(sticky - wrap) < 1e-9 && Math.abs(gpuStart - infinite) < 0.01,
        detail: "authored x=500 offset by +" + OFFSET + ": infinite starts at " + infinite.toFixed(1) +
          " (outside the 900-wide frame, as asked), sticky and wrap both at " + sticky.toFixed(1) +
          " (mod'd back inside); the GPU puts the infinite one at " + gpuStart.toFixed(1),
      };
    }
  );

  addTest(
    "Infinite Space's output curve keeps every distance inside the color range",
    "with nothing wrapping a coordinate back into the frame there is no range to divide it into: mod() would report a body two frames out as barely off-center, and a plain divide would run past 1 and off the end of the colors. The sigmoid squashes the whole infinite line into [0,1]",
    function () {
      var f = PhysicsEngine.frameSigmoid;
      // Worked example: v=2 (body at y=200 in a 100-tall scene) must give ~0.9995, not 2.
      var worked = f(200 / 100);
      var center = f(0.5), top = f(0), bottom = f(1);
      var monotonic = true, bounded = true, prev = -Infinity;
      for (var v = -50; v <= 50; v += 0.25) {
        var y = f(v);
        if (y < prev) monotonic = false;
        if (!(y >= 0 && y <= 1)) bounded = false;
        prev = y;
      }
      return {
        pass: Math.abs(worked - 0.9995) < 5e-4 && Math.abs(center - 0.5) < 1e-12 &&
          monotonic && bounded && top > 0 && bottom < 1,
        detail: "two frames out -> " + worked.toFixed(4) + " (spec said ~0.9995); frame center -> " +
          center.toFixed(4) + ", its edges -> " + top.toFixed(4) + " and " + bottom.toFixed(4) +
          "; monotonic and inside [0,1] across ±50 frames=" + (monotonic && bounded),
      };
    }
  );

  addTest(
    "Off-screen pointers sit on the frame edge and fade to nothing at it",
    "PhysicsHingeGeometry.offscreenPointer, where the arrow marking a body that has left the view goes, shared by the editor's playback and the fractal grid's replay panel. Two properties matter: the tip is exactly where the line from the frame's center crosses the edge, and the length reaches zero as the body arrives at that edge, so the arrow shrinks away instead of popping out of existence when the body comes back on screen",
    function () {
      var W = 900, H = 600, MAX = 70;
      function p(x, y) { return PhysicsHingeGeometry.offscreenPointer(x, y, W, H, MAX); }

      // Nothing to point at while the body is inside, including on the edge.
      var inside = p(450, 300) === null && p(899, 599) === null && p(0, 0) === null;

      // Tips land ON the boundary, on the side facing the body.
      var right = p(5000, 300), up = p(450, -400), corner = p(1350, 900);
      var onEdge = Math.abs(right.tipX - W) < 1e-9 && Math.abs(right.tipY - H / 2) < 1e-9 &&
        Math.abs(up.tipY - 0) < 1e-9 && Math.abs(up.tipX - W / 2) < 1e-9 &&
        Math.abs(corner.tipX - W) < 1e-9 && Math.abs(corner.tipY - H) < 1e-9;

      // Length: zero at the edge, monotonic, bounded however far out.
      var justOut = p(900.0001, 300).length;
      var monotonic = p(1000, 300).length < p(2000, 300).length &&
        p(2000, 300).length < p(50000, 300).length;
      var bounded = p(5e5, 300).length < MAX && p(5e9, 300).length < MAX;

      return {
        pass: inside && onEdge && justOut < 0.01 && monotonic && bounded,
        detail: "inside the frame gives no arrow=" + inside + "; tips on the edge=" + onEdge +
          "; a body 0.0001px out gives length " + justOut.toExponential(1) +
          ", 4100px out gives " + p(5000, 300).length.toFixed(1) +
          ", 500,000px out gives " + p(5e5, 300).length.toFixed(2) + " (never reaching " + MAX + ")",
      };
    }
  );

    // ---- Funnel: the mouth teleports a circle to the throat, legs/throat bounce like a line.
    // Pac-Man edge mode + standard gravity only: see physics-engine.js's Funnel header. ----

  addTest(
    "Funnel mass/inertia are derived from size the same closed form the engine hardcodes",
    "FUNNEL_MASS_COEFF/FUNNEL_INERTIA_COEFF must match createFunnel's actual computeMass output, not just look plausible",
    function () {
      var size = 120;
      var f = PhysicsEngine.createFunnel(0, 0, size, 0, false);
      var expectedMass = PhysicsEngine.LINE_LINEAR_DENSITY * PhysicsEngine.FUNNEL_MASS_COEFF * size;
      var expectedInertia = PhysicsEngine.LINE_LINEAR_DENSITY * PhysicsEngine.FUNNEL_INERTIA_COEFF * size * size * size;
      var massErr = Math.abs(f.mass - expectedMass);
      var inertiaErr = Math.abs(f.inertia - expectedInertia);
      var anchored = PhysicsEngine.createFunnel(0, 0, size, 0, true);
      var detail = "mass=" + f.mass.toFixed(3) + " (expected " + expectedMass.toFixed(3) + "), inertia=" +
        f.inertia.toFixed(1) + " (expected " + expectedInertia.toFixed(1) + "); anchored funnel mass/invMass=" +
        anchored.mass + "/" + anchored.invMass;
      return {
        pass: massErr < 1e-6 && inertiaErr < 1e-3 && anchored.mass === 0 && anchored.invMass === 0,
        detail: detail,
      };
    }
  );

  addTest(
    "A circle touching a funnel's mouth teleports to the throat center with its velocity unchanged",
    "the mouth (length-3 side) is a teleport trigger, not a wall: see collideFunnelMouthTHit and step()'s teleportWins handling",
    function () {
      // Angle 0: mouth faces up, throat down; a ball dropped on the centerline reappears at the throat, still falling.
      var scene = {
        bodies: [
          PhysicsEngine.createFunnel(400, 400, 120, 0, true),
          PhysicsEngine.createCircle(400, 250, 10, false),
        ],
        hinges: [], frameWidth: 1200, frameHeight: 900, edgeMode: "wrap",
      };
      var edges = PhysicsEngine.getFunnelEdges(scene.bodies[0]);
      var teleportStep = -1, vyBefore = null, vyAfter = null, yBefore = null, yAfter = null;
      for (var i = 0; i < 100 && teleportStep < 0; i++) {
        var prevY = scene.bodies[1].y, prevVy = scene.bodies[1].vy;
        PhysicsEngine.step(scene, DT);
        var b = scene.bodies[1];
        if (Math.abs(b.y - prevY) > 50) { // a real per-step move under this gravity/dt is well under 20px
          teleportStep = i; vyBefore = prevVy; vyAfter = b.vy; yBefore = prevY; yAfter = b.y;
        }
      }
      var reachedThroat = teleportStep >= 0 &&
        Math.abs(scene.bodies[1].x - edges.throatCenter.x) < 1 &&
        Math.abs(scene.bodies[1].y - edges.throatCenter.y) < 20; // leg 2 keeps falling a bit further this same step
      // vy must continue its gravity sequence across the jump: not reflected, not reset.
      var velocityContinuous = teleportStep >= 0 && vyAfter > vyBefore - 1 && vyAfter < vyBefore + 20;
      var detail = "teleport detected at step " + teleportStep + ": y " + (yBefore && yBefore.toFixed(2)) +
        " -> " + (yAfter && yAfter.toFixed(2)) + " (throat center y=" + edges.throatCenter.y.toFixed(2) +
        "), vy " + (vyBefore && vyBefore.toFixed(2)) + " -> " + (vyAfter && vyAfter.toFixed(2)) + " (should be continuous, not reflected)";
      return { pass: teleportStep >= 0 && reachedThroat && velocityContinuous, detail: detail };
    }
  );

  addTest(
    "A circle hitting the middle of a funnel's leg bounces like a line, without teleporting",
    "the 2 legs (and the throat) are solid capsule colliders (see collideFunnelCircle), only the mouth teleports",
    function () {
      // Angle 0: leg2 runs (490, 348.04) -> (430, 451.96). The ball starts well inside the funnel's
      // vertical span, just inside leg2 (x=460 at y=400), so it can only ever hit leg2's flat side.
      var scene = {
        bodies: [
          PhysicsEngine.createFunnel(400, 400, 120, 0, true),
          PhysicsEngine.createCircle(450, 400, 8, false),
        ],
        hinges: [], frameWidth: 1200, frameHeight: 900, edgeMode: "wrap",
      };
      var bounced = false, teleported = false;
      var prevVy = scene.bodies[1].vy;
      for (var i = 0; i < 60 && !bounced && !teleported; i++) {
        var prevY = scene.bodies[1].y;
        PhysicsEngine.step(scene, DT);
        var b = scene.bodies[1];
        if (Math.abs(b.y - prevY) > 50) teleported = true;
        else if (prevVy > 50 && b.vy < prevVy - 50) bounced = true;
        prevVy = b.vy;
      }
      var detail = "first event: bounced=" + bounced + ", teleported=" + teleported +
        " (want a bounce off the leg: the ball's path never reaches the mouth)";
      return { pass: bounced && !teleported, detail: detail };
    }
  );

  addTest(
    "A rotated, anchored funnel teleports along its own rotated axis, not the world axis",
    "getFunnelEdges/collideFunnelMouthTHit rotate every vertex by body.angle: a scene with angle=0 in every other test would not catch a sign/axis error here",
    function () {
      var angle = Math.PI / 2; // mouth now faces -x instead of -y
      var scene = {
        bodies: [
          PhysicsEngine.createFunnel(400, 400, 120, angle, true),
          PhysicsEngine.createCircle(400, 400, 10, false),
        ],
        hinges: [], frameWidth: 1200, frameHeight: 900, edgeMode: "wrap",
      };
      // Starts dead center, moving toward the rotated mouth; must reappear at the rotated throat.
      var mouthDir = PhysicsEngine.rotateVec({ x: 0, y: -1 }, angle);
      scene.bodies[1].vx = mouthDir.x * 300;
      scene.bodies[1].vy = mouthDir.y * 300;
      var edges = PhysicsEngine.getFunnelEdges(scene.bodies[0]);
      var teleported = false;
      for (var i = 0; i < 60 && !teleported; i++) {
        var prevX = scene.bodies[1].x, prevY = scene.bodies[1].y;
        PhysicsEngine.step(scene, DT);
        var b = scene.bodies[1];
        if (dist(prevX, prevY, b.x, b.y) > 50) teleported = true;
      }
      var b = scene.bodies[1];
      var landedAtThroat = dist(b.x, b.y, edges.throatCenter.x, edges.throatCenter.y) < 20;
      var detail = "rotated 90deg: throat center=(" + edges.throatCenter.x.toFixed(1) + "," + edges.throatCenter.y.toFixed(1) +
        "), ball landed at (" + b.x.toFixed(1) + "," + b.y.toFixed(1) + ") after teleport=" + teleported;
      return { pass: teleported && landedAtThroat, detail: detail };
    }
  );

  addTest(
    "A funnel next to a line or a second funnel doesn't crash (unsupported pair, not a wrong answer)",
    "collidePair has no funnel<->line or funnel<->funnel model yet - it must return null there instead of falling through to collideLineLine and reading a funnel's undefined .length",
    function () {
      var scene = {
        bodies: [
          PhysicsEngine.createFunnel(300, 300, 100, 0, true),
          PhysicsEngine.createFunnel(700, 300, 100, 0.4, false),
          PhysicsEngine.createLine(500, 600, 200, 0, true),
        ],
        hinges: [], frameWidth: 1200, frameHeight: 900, edgeMode: "wrap",
      };
      for (var i = 0; i < 60; i++) PhysicsEngine.step(scene, DT);
      var allFinite = scene.bodies.every(function (b) { return isFinite(b.x) && isFinite(b.y) && isFinite(b.vx) && isFinite(b.vy); });
      var detail = "after 60 steps, bodies: " + scene.bodies.map(function (b) { return "(" + b.x.toFixed(1) + "," + b.y.toFixed(1) + ")"; }).join(" ");
      return { pass: allFinite, detail: detail };
    }
  );

  addTest(
    "JS engine and GPU compiler agree on a funnel mouth teleport",
    "keeps physics-engine.js's Funnel step() logic and physics-gpu.js's GLSL port (sweptCapsuleCircleContact, collideFunnelMouthTHit, the teleFound/teleWon codegen) in lockstep",
    function () {
      function buildScene() {
        return {
          mutualGravity: false,
          bodies: [
            PhysicsEngine.createFunnel(400, 400, 120, 0, true),
            PhysicsEngine.createCircle(400, 250, 10, false),
          ],
          hinges: [],
        };
      }
      var jsScene = buildScene();
      var gpuScene = buildScene();
      var maxSteps = 60;
      var traj = PhysicsGPU.runSceneOnGPU(gpuScene, maxSteps);
      var maxPosErr = 0;
      for (var s = 0; s < maxSteps; s++) {
        PhysicsEngine.step(jsScene, DT);
        var row = traj[s];
        for (var b = 0; b < jsScene.bodies.length; b++) {
          maxPosErr = Math.max(maxPosErr, Math.abs(jsScene.bodies[b].x - row[b].x), Math.abs(jsScene.bodies[b].y - row[b].y));
        }
      }
      var detail = "after " + maxSteps + " steps (includes a mouth teleport): max position error=" + maxPosErr.toFixed(5) +
        "px; JS final=(" + jsScene.bodies[1].x.toFixed(2) + "," + jsScene.bodies[1].y.toFixed(2) +
        "), GPU final=(" + traj[maxSteps - 1][1].x.toFixed(2) + "," + traj[maxSteps - 1][1].y.toFixed(2) + ")";
      return { pass: maxPosErr < 0.01, detail: detail };
    }
  );

  addTest(
    "JS engine and GPU compiler agree on a funnel leg bounce",
    "same lockstep concern as the mouth teleport test, for the 3 solid-edge Contact path instead of the MouthHit path",
    function () {
      function buildScene() {
        return {
          mutualGravity: false,
          bodies: [
            PhysicsEngine.createFunnel(400, 400, 120, 0, true),
            PhysicsEngine.createCircle(450, 400, 8, false),
          ],
          hinges: [],
        };
      }
      var jsScene = buildScene();
      var gpuScene = buildScene();
      var maxSteps = 60;
      var traj = PhysicsGPU.runSceneOnGPU(gpuScene, maxSteps);
      var maxPosErr = 0;
      for (var s = 0; s < maxSteps; s++) {
        PhysicsEngine.step(jsScene, DT);
        var row = traj[s];
        for (var b = 0; b < jsScene.bodies.length; b++) {
          maxPosErr = Math.max(maxPosErr, Math.abs(jsScene.bodies[b].x - row[b].x), Math.abs(jsScene.bodies[b].y - row[b].y));
        }
      }
      var detail = "after " + maxSteps + " steps (includes a leg bounce): max position error=" + maxPosErr.toFixed(5) + "px";
      return { pass: maxPosErr < 0.01, detail: detail };
    }
  );

  addTest(
    "A funnel teleport and a leg bounce run in double-float, in step with the float64 engine",
    "funnels and splitters used to be float32-only: a df compile threw, and the grid quietly fell back to float32 however deep the zoom. physics-gpu-df.js now ports the trapezoid functions (dfSweptCapsuleCircleContact, dfTrapezoid, dfCollideFunnelMouthTHit) and generateStepOnceGLSL emits its funnel block at either precision: this pins both halves of that block, the mouth teleport and the solid-edge contacts, against the JS engine, where a float32 stage left in the chain shows up as an error ~1000x larger",
    function () {
      function sceneWith(circleX, circleY, radius) {
        return {
          bodies: [
            PhysicsEngine.createFunnel(400, 400, 120, 0, true),
            PhysicsEngine.createCircle(circleX, circleY, radius, false),
          ],
          hinges: [], xInput: null, yInput: null, output: { body: 1, property: "y" },
        };
      }
      var STEPS = 60;
      function errorOf(scene, precision) {
        var ref = cpuStateAt(scene, 0, 0, STEPS, 1);
        return { err: gridResidualAtPoint(scene, STEPS, 0, 0, precision, 1, ref).err, ref: ref };
      }
      var teleport = errorOf(sceneWith(400, 250, 10), "df");
      var bounce = errorOf(sceneWith(450, 400, 8), "df");
      var bounce32 = errorOf(sceneWith(450, 400, 8), "f32");
      // The ball starts 150px above the funnel's center; only a teleport can put it below.
      var teleported = teleport.ref.y > 400;
      return {
        pass: teleported && teleport.err < 1e-6 && bounce.err < 1e-6 && bounce.err * 20 < bounce32.err,
        detail: "after " + STEPS + " steps: teleport run off by " + teleport.err.toExponential(2) + "px in df (ball ended at y=" +
          teleport.ref.y.toFixed(1) + ", past the funnel's center=" + teleported + "); leg bounce off by " +
          bounce.err.toExponential(2) + "px in df vs " + bounce32.err.toExponential(2) + "px in float32",
      };
    }
  );

  addTest(
    "A splitter scene runs in double-float, in step with the float64 engine",
    "the splitter shares the funnel's trapezoid port, plus its own end-of-step machinery: spawn slots waking as DBody values, df alive-gating, the split offsets applied in df. The body checked is the one that stays in the parent's slot, so this passes only if the split itself landed where the JS engine put it",
    function () {
      // Slot ceiling pulled down: each spawn slot is a whole extra body of df work under the GPU watchdog.
      var scene = buildSplitterScene(385);
      scene.xInput = null; scene.yInput = null; scene.output = { body: 1, property: "y" };
      scene.maxSimulationBodies = 4;
      var STEPS = 40;
      var js = PhysicsEngine.cloneScene(scene);
      js.bodies.forEach(PhysicsEngine.computeMass);
      for (var i = 0; i < STEPS; i++) PhysicsEngine.step(js, DT);
      var ref = js.bodies[1];
      var df = gridResidualAtPoint(scene, STEPS, 0, 0, "df", 1, ref);
      return {
        pass: js.bodies.length === 3 && df.err < 1e-6,
        detail: "after " + STEPS + " steps the JS engine has " + js.bodies.length + " bodies (want 3: the ball split once); " +
          "the df shader's parent half is off by " + df.err.toExponential(2) + "px",
      };
    }
  );

    // ---- Splitter: the short side turns one circle into two on the long side (parent's velocity kept);
    // Output tracks the lineage AVERAGE. See physics-engine.js's createSplitter. ----

    // The reported worked example: size=120 makes "1 unit" 60px (throat = size/2, mouth = 3*size/2,
    // legs = size); angle=PI turns the short side up toward the falling ball.
  function buildSplitterScene(ballX, ballRadius) {
    return {
      mutualGravity: false,
      bodies: [
        PhysicsEngine.createSplitter(400, 400, 120, Math.PI, true),
        PhysicsEngine.createCircle(ballX, 250, ballRadius === undefined ? 4 : ballRadius, false),
      ],
      hinges: [], frameWidth: 1200, frameHeight: 900, edgeMode: "wrap",
    };
  }

  addTest(
    "A circle hitting a splitter's short side becomes two on the long side, 0.75/0.25 from their own edges",
    "collideSplitterShortSideTHit's spawn rule: the contact's absolute distance from one corner is preserved from BOTH corners of the long side, which is what makes the pair land (mouthLen - throatLen) apart for any hit position",
    function () {
      // throat[0] is at x=430 and the throat is 60px long: 0.75 along it is x=385.
      var scene = buildSplitterScene(385);
      var split = null;
      for (var i = 0; i < 60 && !split; i++) {
        PhysicsEngine.step(scene, DT);
        if (scene.bodies.length > 2) split = scene.bodies.slice(1);
      }
      if (!split) return { pass: false, detail: "the ball never split within 60 steps" };
      var edges = PhysicsEngine.getFunnelEdges(scene.bodies[0]);
      var unit = 120 / 2; // size/2 - "1 unit" in the 1 : 3 : 2 description
      var fromEdge0 = Math.abs(split[0].x - edges.mouth[0].x) / unit;
      var fromEdge1 = Math.abs(split[1].x - edges.mouth[1].x) / unit;
      var separation = Math.abs(split[0].x - split[1].x) / unit;
      var detail = "one ball " + fromEdge0.toFixed(4) + " units from its edge, the other " +
        fromEdge1.toFixed(4) + " from its own (want 0.75 / 0.25), separation " + separation.toFixed(4) +
        " units (want 2)";
      return {
        pass: Math.abs(fromEdge0 - 0.75) < 1e-6 && Math.abs(fromEdge1 - 0.25) < 1e-6 && Math.abs(separation - 2) < 1e-6,
        detail: detail,
      };
    }
  );

  addTest(
    "Both balls a splitter produces carry the parent's velocity unchanged",
    "\"They each have the same velocity as the initial ball\": the split is a position/identity event, never an impulse",
    function () {
      var scene = buildSplitterScene(385);
      var beforeV = null, split = null;
      for (var i = 0; i < 60 && !split; i++) {
        var prevV = { vx: scene.bodies[1].vx, vy: scene.bodies[1].vy };
        PhysicsEngine.step(scene, DT);
        if (scene.bodies.length > 2) { split = scene.bodies.slice(1); beforeV = prevV; }
      }
      if (!split) return { pass: false, detail: "the ball never split within 60 steps" };
      var sameAsEachOther = Math.abs(split[0].vx - split[1].vx) < 1e-9 && Math.abs(split[0].vy - split[1].vy) < 1e-9;
      // Only the split step's own gravity may separate the children's vy from the pre-step reading.
      var expectedVy = beforeV.vy + PhysicsEngine.GRAVITY * DT;
      var carriedThrough = Math.abs(split[0].vy - expectedVy) < 1e-6 && Math.abs(split[0].vx - beforeV.vx) < 1e-9;
      var detail = "children v=(" + split[0].vx.toFixed(3) + "," + split[0].vy.toFixed(3) + ") and (" +
        split[1].vx.toFixed(3) + "," + split[1].vy.toFixed(3) + "); parent entered the step at vy=" +
        beforeV.vy.toFixed(3) + ", so one step of gravity gives " + expectedVy.toFixed(3);
      return { pass: sameAsEachOther && carriedThrough, detail: detail };
    }
  );

  addTest(
    "Output tracks the AVERAGE over a split lineage, and that average is continuous through the split",
    "computeOutputLineageAverage / lineageOf: the whole point of the mapping surviving a body becoming two",
    function () {
      var scene = buildSplitterScene(385);
      var beforeX = null, afterX = null, beforeCount = 0, afterCount = 0;
      for (var i = 0; i < 60 && afterX === null; i++) {
        var prevX = PhysicsEngine.computeOutputLineageAverage(scene, 1, "x");
        var prevCount = scene.bodies.length;
        PhysicsEngine.step(scene, DT);
        if (scene.bodies.length > prevCount) {
          beforeX = prevX; beforeCount = prevCount - 1;
          afterX = PhysicsEngine.computeOutputLineageAverage(scene, 1, "x");
          afterCount = scene.bodies.length - 1;
        }
      }
      if (afterX === null) return { pass: false, detail: "the ball never split within 60 steps" };
      // Spawn points are symmetric about the hit point, so the averaged X must not jump at the split.
      var lineageMembers = scene.bodies.filter(function (b, idx) { return PhysicsEngine.lineageOf(scene, idx) === 1; }).length;
      var detail = "averaged X " + beforeX.toFixed(4) + " (over " + beforeCount + " ball) -> " +
        afterX.toFixed(4) + " (over " + afterCount + "), lineage 1 now has " + lineageMembers + " members";
      return { pass: Math.abs(afterX - beforeX) < 1e-6 && lineageMembers === 2 && afterCount === 2, detail: detail };
    }
  );

  addTest(
    "A splitter's long side and legs bounce like a funnel's, only the short side splits",
    "collideSplitterCircle covers mouth + both legs; a ball arriving at the long side must not spawn anything",
    function () {
      // Angle 0 puts the LONG side up, which is the solid side on a splitter.
      var scene = {
        mutualGravity: false,
        bodies: [
          PhysicsEngine.createSplitter(400, 400, 120, 0, true),
          PhysicsEngine.createCircle(400, 250, 10, false),
        ],
        hinges: [], frameWidth: 1200, frameHeight: 900, edgeMode: "wrap",
      };
      var bounced = false;
      var prevVy = 0;
      for (var i = 0; i < 60 && !bounced; i++) {
        PhysicsEngine.step(scene, DT);
        if (prevVy > 50 && scene.bodies[1].vy < prevVy - 50) bounced = true;
        prevVy = scene.bodies[1].vy;
      }
      var detail = "after 60 steps: bodies=" + scene.bodies.length + " (want 2: no split), bounced off the long side=" + bounced;
      return { pass: scene.bodies.length === 2 && bounced, detail: detail };
    }
  );

  addTest(
    "Splitting is recursive: a ball produced by a split can split again",
    "each half keeps its lineage and is an ordinary circle afterward, so nothing special-cases it out of the next splitter it meets",
    function () {
      // Two stacked splitters: 1 -> 2 -> 3 balls, all in lineage 1.
      var scene = {
        mutualGravity: false,
        bodies: [
          PhysicsEngine.createSplitter(400, 400, 120, Math.PI, true),
          PhysicsEngine.createCircle(400, 250, 4, false),
          PhysicsEngine.createSplitter(460, 700, 120, Math.PI, true),
        ],
        hinges: [], frameWidth: 1200, frameHeight: 1400, edgeMode: "wrap",
      };
      var counts = [];
      for (var i = 0; i < 120; i++) {
        PhysicsEngine.step(scene, DT);
        counts.push(scene.bodies.length);
      }
      var balls = scene.bodies.filter(function (b) { return b.type === "circle"; });
      var allSameLineage = balls.every(function (b, idx) {
        return PhysicsEngine.lineageOf(scene, scene.bodies.indexOf(b)) === 1;
      });
      var detail = "circles after 120 steps: " + balls.length + " (want >= 3 - one split, then a second on one half); " +
        "all in lineage 1: " + allSameLineage;
      return { pass: balls.length >= 3 && allSameLineage, detail: detail };
    }
  );

    // ---- Pair Outputs: average of two bodies, and distance between them (PhysicsEngine.computeOutputValue) ----

  function twoBallScene(edgeMode, ax, ay, bx, by) {
    var scene = {
      edgeMode: edgeMode,
      frameWidth: 800, frameHeight: 600, hinges: [],
      bodies: [PhysicsEngine.createCircle(ax, ay, 10, false), PhysicsEngine.createCircle(bx, by, 10, false)],
    };
    scene.bodies.forEach(PhysicsEngine.computeMass);
    return scene;
  }

  addTest(
    "A two-body Output averages the pair, and a one-body Output still reads exactly what it always did",
    "PhysicsEngine.computeOutputValue is the single definition of what an Output means: physics-ui.js's playback color, fractal-grid.js's instant preview and the grid shader's GLSL are all written against it, so the one-body case has to come through it completely unchanged or every existing scene shifts color",
    function () {
      var scene = twoBallScene("wrap", 100, 200, 700, 500);
      var cases = [
        ["one body, y", { body: 0, bodyB: null, property: "y" }, 200],
        ["one body, x", { body: 0, bodyB: null, property: "x" }, 100],
        ["pair, avg y", { body: 0, bodyB: 1, property: "y" }, 350],
        ["pair, avg x", { body: 0, bodyB: 1, property: "x" }, 400],
        // Pairing a body with itself is just that body, not a double count.
        ["self-paired", { body: 0, bodyB: 0, property: "y" }, 200],
      ];
      var bad = cases.filter(function (c) {
        return Math.abs(PhysicsEngine.computeOutputValue(scene, c[1]) - c[2]) > 1e-9;
      });
      var detail = cases.map(function (c) {
        return c[0] + "=" + PhysicsEngine.computeOutputValue(scene, c[1]).toFixed(1) + " (want " + c[2] + ")";
      }).join("; ");
      return { pass: bad.length === 0, detail: detail };
    }
  );

  addTest(
    "Distance Apart takes the short way round when the frame wraps",
    "without this, a Pac-Man scene's distance Output jumps the width of the frame the instant either body crosses an edge: for a pair that never actually moved apart. That is a discontinuity in the exact quantity the grid is a picture of, and on a toroidal world the shortest separation IS the distance. Infinite Space has no edges to go round, so there it stays the plain one.",
    function () {
      // 100 and 700 on an 800-wide frame: 600 apart the long way, 200 the short way.
      var wrapped = PhysicsEngine.computeOutputValue(twoBallScene("wrap", 100, 300, 700, 300), { body: 0, bodyB: 1, property: "distance" });
      var sticky = PhysicsEngine.computeOutputValue(twoBallScene("sticky", 100, 300, 700, 300), { body: 0, bodyB: 1, property: "distance" });
      var infinite = PhysicsEngine.computeOutputValue(twoBallScene("infinite", 100, 300, 700, 300), { body: 0, bodyB: 1, property: "distance" });
      // A plain 3-4-5, nowhere near an edge, must be untouched by any of it.
      var plain = PhysicsEngine.computeOutputValue(twoBallScene("infinite", 100, 200, 400, 600), { body: 0, bodyB: 1, property: "distance" });
      // The color range: the antipode on a torus is HALF a frame per axis.
      var maxWrap = PhysicsEngine.outputDistanceMax(twoBallScene("wrap", 0, 0, 0, 0));
      var maxInf = PhysicsEngine.outputDistanceMax(twoBallScene("infinite", 0, 0, 0, 0));
      var ok = Math.abs(wrapped - 200) < 1e-9 && Math.abs(sticky - 200) < 1e-9 &&
        Math.abs(infinite - 600) < 1e-9 && Math.abs(plain - 500) < 1e-9 &&
        Math.abs(maxWrap - 500) < 1e-9 && Math.abs(maxInf - 1000) < 1e-9;
      var detail = "same pair: wrap=" + wrapped + ", sticky=" + sticky + ", infinite=" + infinite +
        " (want 200/200/600); 3-4-5 pair=" + plain + " (want 500); range max wrap=" + maxWrap +
        " (want 500, the half-frame diagonal), infinite=" + maxInf + " (want 1000, the full one)";
      return { pass: ok, detail: detail };
    }
  );

  addTest(
    "A pair Output weighs each half once, however many times either has split",
    "each half is its own lineage average FIRST, then the two are averaged, flattening every body into one mean instead would let whichever ball split more times drag the answer toward itself, which is not what \"the average of object 1 and object 2\" means",
    function () {
      var scene = twoBallScene("infinite", 0, 0, 200, 0);
      // A third ball tagged as a split child of body 0.
      var child = PhysicsEngine.createCircle(100, 0, 10, false);
      child.lineage = 0;
      scene.bodies.push(child);
      PhysicsEngine.computeMass(child);
      var got = PhysicsEngine.computeOutputValue(scene, { body: 0, bodyB: 1, property: "x" });
      // lineage 0 averages to 50, lineage 1 is 200, pair is 125; a flat mean over three bodies would be 100.
      var flat = (0 + 200 + 100) / 3;
      return {
        pass: Math.abs(got - 125) < 1e-9,
        detail: "pair average = " + got + " (want 125 - lineage 0 averages to 50, lineage 1 is 200); a flat mean over all three bodies would give " + flat.toFixed(1),
      };
    }
  );

  addTest(
    "Output survives a Play/Reset round trip with its second body intact",
    "PhysicsEngine.cloneScene is what physics-ui.js round-trips the live scene through on every Play and Reset: an omitted field there silently resets mid-edit, which is how simulationSteps and edgeMode each got lost once, and a dropped bodyB would quietly turn a pair Output back into a one-body one",
    function () {
      var scene = twoBallScene("wrap", 100, 200, 700, 500);
      scene.output = { body: 0, bodyB: 1, property: "distance" };
      scene.xInput = null; scene.yInput = null;
      var round = PhysicsEngine.cloneScene(scene);
      var kept = round.output && round.output.bodyB === 1 && round.output.property === "distance";
      // A one-body Output must round-trip as one-body, not as a pair with a coerced 0.
      var single = PhysicsEngine.cloneScene(Object.assign({}, scene, { output: { body: 1, property: "y" } }));
      var stillSingle = !PhysicsEngine.isPairOutput(single.output);
      return {
        pass: kept && stillSingle,
        detail: "pair round-tripped as " + JSON.stringify(round.output) + "; a one-body Output came back as " +
          JSON.stringify(single.output) + " (isPair=" + PhysicsEngine.isPairOutput(single.output) + ")",
      };
    }
  );

  addTest(
    "Only the three real Output shapes validate, and each bad one says what's actually wrong",
    "Scene Lifespan is `{ body: null, property: \"lifespan\" }` and \"lifespan\" is deliberately in neither body-property list, so a guard that re-picked an out-of-list property rewrote it to \"x\" while body stayed null, leaving a mapping naming no body AND no run tally. The fractal page could only report that as \"missing an Output mapping\" even though one was plainly there, which is how picking Scene Lifespan broke that page.",
    function () {
      var E = PhysicsEngine, N = 3;
      var good = [
        ["scene lifespan", { body: null, bodyB: null, property: "lifespan" }],
        ["lifespan, no bodyB key at all", { body: null, property: "lifespan" }],
        ["one body", { body: 1, bodyB: null, property: "y" }],
        ["one body, no bodyB key at all", { body: 1, property: "y" }],
        ["bounce count", { body: 2, bodyB: null, property: "bounces" }],
        ["pair average", { body: 0, bodyB: 2, property: "x" }],
        ["distance", { body: 0, bodyB: 2, property: "distance" }],
      ];
      var bad = [
        ["THE BUG: no body, not a run tally", { body: null, bodyB: null, property: "x" }],
        ["lifespan with a body set", { body: 0, property: "lifespan" }],
        ["distance without a pair", { body: 0, bodyB: null, property: "distance" }],
        ["bounces with a pair", { body: 0, bodyB: 1, property: "bounces" }],
        ["body out of range", { body: 9, bodyB: null, property: "y" }],
        ["bodyB out of range", { body: 0, bodyB: 9, property: "x" }],
        ["no mapping at all", null],
      ];
      var wronglyRejected = good.filter(function (c) { return E.outputMappingError(c[1], N) !== null; });
      var wronglyAccepted = bad.filter(function (c) { return E.outputMappingError(c[1], N) === null; });
      var detail = wronglyRejected.length || wronglyAccepted.length
        ? "wrongly rejected: " + wronglyRejected.map(function (c) { return c[0] + " (" + E.outputMappingError(c[1], N) + ")"; }).join(", ") +
          "; wrongly accepted: " + wronglyAccepted.map(function (c) { return c[0]; }).join(", ")
        : good.length + " valid shapes accepted; " + bad.length + " invalid ones rejected, e.g. \"" +
          E.outputMappingError(bad[0][1], N) + "\" for the one that broke the page";
      return { pass: wronglyRejected.length === 0 && wronglyAccepted.length === 0, detail: detail };
    }
  );

  addTest(
    "Every body type has a finite rendered half-extent, including a trapezoid",
    "fractal-grid.js's instant hover preview asked for `body.length / 2`, and a funnel/splitter has no `length` at all: undefined/2 is NaN, and a NaN coordinate makes canvas draw nothing silently. Reported as \"the preview doesn't show the funnel or splitter until the replay loads\": the GPU trajectory carries a real half in its alpha channel, so the shape appeared the moment the replay took over. Both paths read PhysicsGPU.shapeHalf now, so they cannot disagree again.",
    function () {
      var bodies = [
        PhysicsEngine.createCircle(100, 100, 17, false),
        PhysicsEngine.createLine(100, 100, 300, 0.4, true), // (x, y, LENGTH, angle)
        PhysicsEngine.createFunnel(400, 400, 120, 0, true),
        PhysicsEngine.createSplitter(400, 400, 140, Math.PI, true),
      ];
      var want = [17, 150, 60, 70]; // radius, length/2, size/2, size/2
      var got = bodies.map(function (b) { return PhysicsGPU.shapeHalf([b], 0); });
      var ok = got.every(function (v, i) { return isFinite(v) && Math.abs(v - want[i]) < 1e-9; });
      var detail = bodies.map(function (b, i) {
        return b.type + ": " + got[i] + " (want " + want[i] + ")";
      }).join("; ");
      return { pass: ok, detail: detail };
    }
  );

  addTest(
    "A trapezoid's outline can be rebuilt from just (x, y, angle, half), what the hover preview draws from",
    "the preview has a trajectory ROW, not a body: x/y/angle and the one packed half. Drawing the four corners from that has to land on the same trapezoid the engine collides against, or the preview would show a shape the simulation isn't using.",
    function () {
      var body = PhysicsEngine.createSplitter(437, 618, 140, 0.7, true);
      var real = PhysicsEngine.getFunnelEdges(body);
      // Exactly what fractal-grid.js's traceTrapezoid reconstructs from.
      var half = PhysicsGPU.shapeHalf([body], 0);
      var rebuilt = PhysicsEngine.getFunnelEdges({ x: body.x, y: body.y, angle: body.angle, size: half * 2 });
      var corners = [["mouth", 0], ["mouth", 1], ["throat", 0], ["throat", 1]];
      var worst = 0;
      corners.forEach(function (c) {
        var a = real[c[0]][c[1]], b = rebuilt[c[0]][c[1]];
        worst = Math.max(worst, dist(a.x, a.y, b.x, b.y));
        if (!isFinite(b.x) || !isFinite(b.y)) worst = Infinity;
      });
      return {
        pass: worst < 1e-9,
        detail: "worst corner disagreement " + worst.toFixed(12) + "px across all four corners (want 0: the rebuilt outline IS the collided one)",
      };
    }
  );

  addTest(
    "A ball entering a splitter off-center isn't bounced by the splitter it's passing through",
    "a splitter's mouth and legs are solid, and their capsules reach LINE_THICKNESS/2 PAST the short side's own corners - so a ball entering anywhere near a corner clips a leg end-cap on the very step it splits, and the split then carries that bounce's velocity out with it. Reported as \"the balls come out at weird angles\"; measured, a ball entering 2px from a corner at vy=+373 came out at vy=-332 (reflected backwards) with 102px/s of sideways drift it never had. step() now drops those contacts, exactly as it already did for a funnel teleport.",
    function () {
      // Throat spans x 370..430: 372 and 428 hug a corner, 400 is dead center. Straight drops, so any vx is invented.
      function dropAt(x) {
        var scene = buildSplitterScene(x);
        for (var i = 0; i < 80; i++) {
          var before = scene.bodies.length;
          PhysicsEngine.step(scene, DT);
          if (scene.bodies.length > before) {
            var a = scene.bodies[1], b = scene.bodies[scene.bodies.length - 1];
            return { x: x, vx: a.vx, vy: a.vy, matched: Math.abs(a.vx - b.vx) < 1e-9 && Math.abs(a.vy - b.vy) < 1e-9 };
          }
        }
        return null;
      }
      var entries = [372, 385, 400, 415, 428].map(dropAt);
      if (entries.some(function (e) { return e === null; })) {
        return { pass: false, detail: "a ball failed to split within 80 steps" };
      }
      // All five must carry the parent's velocity: vx exactly 0, one identical positive vy.
      var vy0 = entries[2].vy; // the dead-center drop, which never touched a leg
      var clean = entries.every(function (e) {
        return e.matched && Math.abs(e.vx) < 1e-9 && Math.abs(e.vy - vy0) < 1e-9;
      });
      var detail = entries.map(function (e) {
        return "x=" + e.x + ": v=(" + e.vx.toFixed(3) + ", " + e.vy.toFixed(1) + ")";
      }).join("; ") + " - want vx=0 and vy=" + vy0.toFixed(1) + " for every entry point";
      return { pass: clean, detail: detail };
    }
  );

  addTest(
    "The split is a pure translation, so the ball's own overshoot survives it",
    "collideSplitterShortSideTHit returns offsets, not points on the long side: an absolute landing point would discard how far past the short side the ball actually got and replace it with a constant, which is a discontinuity in exactly the variable the fractal grid is a picture of",
    function () {
      // Different drop heights leave different depths past the short side; a snap onto the long side would erase them.
      function depthAfterSplit(startY) {
        var scene = buildSplitterScene(385);
        scene.bodies[1].y = startY;
        for (var i = 0; i < 120; i++) {
          var before = scene.bodies.length;
          PhysicsEngine.step(scene, DT);
          if (scene.bodies.length > before) return scene.bodies[1].y;
        }
        return null;
      }
      var a = depthAfterSplit(250), b = depthAfterSplit(250.9);
      if (a === null || b === null) return { pass: false, detail: "one of the two balls never split within 120 steps" };
      var spread = Math.abs(a - b);
      var detail = "post-split y: " + a.toFixed(4) + " vs " + b.toFixed(4) + ", spread " + spread.toFixed(4) +
        "px (want > 0 - a snap onto the long side would make both exactly equal)";
      return { pass: spread > 1e-6, detail: detail };
    }
  );

  addTest(
    "Both halves emerge clear of the long side instead of trapped inside the trapezoid",
    "the swept trigger fires while the ball is still (halfThickness + radius) short of the short side's centerline, so translating by the bare leg vector leaves it that far short of the LONG side's centerline - i.e. embedded in its wall, bouncing back inside forever. collideSplitterShortSideTHit's clearance term is what matches the two SURFACES up instead of the two centerlines.",
    function () {
      var scene = buildSplitterScene(385);
      var split = null;
      for (var i = 0; i < 60 && !split; i++) {
        PhysicsEngine.step(scene, DT);
        if (scene.bodies.length > 2) split = scene.bodies.slice(1);
      }
      if (!split) return { pass: false, detail: "the ball never split within 60 steps" };
      var edges = PhysicsEngine.getFunnelEdges(scene.bodies[0]);
      // angle=PI puts the mouth below the throat, so "clear" is y past it.
      var mouthY = edges.mouth[0].y, radius = split[0].radius;
      var clearOf = PhysicsEngine.LINE_THICKNESS / 2 + radius;
      var d0 = split[0].y - mouthY, d1 = split[1].y - mouthY;
      var detail = "halves sit " + d0.toFixed(2) + " and " + d1.toFixed(2) +
        "px past the long side's centerline (want >= " + clearOf.toFixed(2) + ", the wall's own half-thickness plus the radius)";
      return { pass: d0 >= clearOf - 1e-6 && d1 >= clearOf - 1e-6, detail: detail };
    }
  );

  addTest(
    "At the body ceiling a ball still passes through the splitter, it just stops duplicating",
    "PhysicsEngine.MAX_SIMULATION_BODIES: the old rule skipped the whole split, leaving the ball behind on the short side. Being at the ceiling is a fact about the scene, not a reason to stop the warp, and `continue` rather than `break`, so a later ball that hit a splitter this same step isn't skipped along with it.",
    function () {
      // MAX balls already in the scene: nothing can be added, but the ball must still pass through.
      var cap = PhysicsEngine.MAX_SIMULATION_BODIES;
      var scene = buildSplitterScene(385);
      while (scene.bodies.length < cap) {
        // Parked far from the splitter, only occupying slots.
        scene.bodies.push(PhysicsEngine.createCircle(50 + scene.bodies.length * 25, 850, 4, true));
      }
      var edges = PhysicsEngine.getFunnelEdges(scene.bodies[0]);
      var crossed = false, countAfter = null;
      for (var i = 0; i < 60 && !crossed; i++) {
        PhysicsEngine.step(scene, DT);
        if (scene.bodies[1].y > edges.mouth[0].y) { crossed = true; countAfter = scene.bodies.length; }
      }
      var detail = crossed
        ? "ball reached y=" + scene.bodies[1].y.toFixed(1) + ", past the long side at " + edges.mouth[0].y.toFixed(1) +
          "; bodies " + countAfter + " (capped at " + cap + ", so no duplicate)"
        : "the ball never got past the long side: it was left behind on the short side";
      return { pass: crossed && countAfter === cap, detail: detail };
    }
  );

  addTest(
    "A scene's own maxSimulationBodies caps the run, and the GPU pads to exactly that",
    "the ceiling is a per-scene control (#editor-view's Max Objects), not a constant, and it decides the compiled shader's whole size, so the JS engine's ball count and the GPU's slot count have to come from the same number or the grid renders a different scene than it plays back",
    function () {
      function cascade(cap) {
        var scene = {
          mutualGravity: false,
          bodies: [
            PhysicsEngine.createSplitter(400, 400, 120, Math.PI, true),
            PhysicsEngine.createCircle(400, 250, 4, false),
            PhysicsEngine.createSplitter(460, 700, 120, Math.PI, true),
          ],
          hinges: [], frameWidth: 1200, frameHeight: 1400, edgeMode: "wrap",
        };
        if (cap !== null) scene.maxSimulationBodies = cap;
        return scene;
      }
      var results = [5, 8, null].map(function (cap) {
        var scene = cascade(cap);
        var rows = PhysicsEngine.runTrajectory(PhysicsEngine.cloneScene(scene), 400, DT);
        var grew = rows[rows.length - 1].length;
        var slots = PhysicsGPU.padSceneForSplitting(scene).scene.bodies.length;
        var want = PhysicsEngine.maxSimulationBodiesFor(scene);
        return { cap: cap, grew: grew, slots: slots, want: want };
      });
      // The uncapped run must grow PAST both low caps, or "stopped at 5" and "ran out of splits" look the same.
      // Not asserted to reach the default ceiling: this cascade runs out of splitters first.
      var uncapped = results[2];
      var ok = results.every(function (r) { return r.grew <= r.want && r.slots === r.want; }) &&
        uncapped.grew > 8 &&
        results[0].grew === 5 && results[1].grew === 8;
      var detail = results.map(function (r) {
        return (r.cap === null ? "default" : "cap " + r.cap) + ": JS grew to " + r.grew +
          ", GPU padded to " + r.slots + " slots (ceiling " + r.want + ")";
      }).join("; ");
      return { pass: ok, detail: detail };
    }
  );

  addTest(
    "maxSimulationBodies is clamped, never trusted, and survives a Play/Reset round trip",
    "it arrives from hand-edited JSON and from a slider, and PhysicsEngine.cloneScene is what physics-ui.js round-trips the live scene through on every Play and Reset: an omission there silently resets the ceiling mid-edit, which is exactly how simulationSteps and edgeMode each got lost once",
    function () {
      var F = PhysicsEngine.maxSimulationBodiesFor;
      var LO = PhysicsEngine.MIN_SIMULATION_BODIES, HI = PhysicsEngine.MAX_SIMULATION_BODIES_LIMIT;
      var clamps = [
        [{}, PhysicsEngine.MAX_SIMULATION_BODIES],
        [{ maxSimulationBodies: 0 }, PhysicsEngine.MAX_SIMULATION_BODIES],
        [{ maxSimulationBodies: "nonsense" }, PhysicsEngine.MAX_SIMULATION_BODIES],
        [{ maxSimulationBodies: 1 }, LO],
        [{ maxSimulationBodies: 99999 }, HI],
        [{ maxSimulationBodies: 7.6 }, 8],
        [{ maxSimulationBodies: 12 }, 12],
      ];
      var bad = clamps.filter(function (c) { return F(c[0]) !== c[1]; });
      var round = PhysicsEngine.cloneScene({
        bodies: [], hinges: [], maxSimulationBodies: 6,
        xInput: null, yInput: null, output: null,
      });
      var survived = round.maxSimulationBodies === 6;
      var detail = "clamping: " + (bad.length ? bad.length + " wrong (" + JSON.stringify(bad[0]) + ")" : "all " + clamps.length + " correct") +
        "; cloneScene round trip kept " + round.maxSimulationBodies + " (want 6)";
      return { pass: bad.length === 0 && survived, detail: detail };
    }
  );

  addTest(
    "A ceiling too high to compile is refused with a readable message, not a driver error",
    "stepOnce() takes 4 parameters per authored body and 6 per spawn slot against GLSL's hard limit of 256: the slider's own max is set below that for any authorable scene, but a hand-edited scene can ask for more, and the driver's own answer is \"'stepOnce' : Function has too many parameters\" against a line number in generated code",
    function () {
      function attempt(authored, total) {
        var bodies = [];
        for (var i = 0; i < authored; i++) bodies.push(PhysicsEngine.createCircle(i * 40, 100, 10, false));
        for (var j = authored; j < total; j++) bodies.push(PhysicsEngine.createCircle(0, 0, 0, false));
        var consts = bodies.map(PhysicsGPU.bodyConst);
        try {
          PhysicsGPU.generateStepOnceGLSL(total, consts, [], [], undefined, "f32", false, true, authored);
          return null;
        } catch (err) { return err.message; }
      }
      // The slider's ceiling must compile for the worst authorable scene (MAX_BODIES bodies).
      var atSliderMax = attempt(PhysicsGPU.MAX_BODIES, PhysicsEngine.MAX_SIMULATION_BODIES_LIMIT);
      var pastIt = attempt(4, 44);
      var readable = pastIt && /parameters/.test(pastIt) && /Max Objects/.test(pastIt);
      var detail = "at the slider's max (" + PhysicsEngine.MAX_SIMULATION_BODIES_LIMIT + " slots, " + PhysicsGPU.MAX_BODIES +
        " authored): " + (atSliderMax ? "REFUSED - " + atSliderMax : "compiles") +
        "; at 44 slots: " + (pastIt ? "refused with \"" + pastIt + "\"" : "did NOT refuse");
      return { pass: atSliderMax === null && readable, detail: detail };
    }
  );

  addTest(
    "The GPU runs a splitter scene, and agrees with the JS engine step for step",
    "a split adds a body, which a compiled fixed-body shader cannot do, so PhysicsGPU.padSceneForSplitting pre-allocates spawn slots up to MAX_SIMULATION_BODIES and a split wakes one instead of creating one. This is the check that the two engines' splitting agrees: same trigger step, same two halves, same recursion.",
    function () {
      var STEPS = 90;
      var scene = buildSplitterScene(385);
      var rows = PhysicsEngine.runTrajectory(PhysicsEngine.cloneScene(scene), STEPS, DT);
      var traj = PhysicsGPU.runSceneOnGPU(scene, STEPS);
      // A GPU row is always MAX_SIMULATION_BODIES long (dead slots have half = 0); compare over what JS says is alive.
      var worst = 0, worstAt = -1, jsBornStep = -1, gpuBornStep = -1;
      for (var stepIdx = 0; stepIdx < STEPS; stepIdx++) {
        var jsRow = rows[stepIdx], gpuRow = traj[stepIdx];
        if (jsBornStep === -1 && jsRow.length > rows[0].length) jsBornStep = stepIdx;
        var gpuAlive = gpuRow.filter(function (b) { return b.half > 0; }).length;
        if (gpuBornStep === -1 && gpuAlive > jsRow.length - (jsBornStep === -1 ? 0 : 1)) { /* noop */ }
        for (var b = 0; b < jsRow.length; b++) {
          var e = dist(jsRow[b].x, jsRow[b].y, gpuRow[b].x, gpuRow[b].y);
          if (e > worst) { worst = e; worstAt = stepIdx; }
        }
      }
      for (var g = 0; g < STEPS && gpuBornStep === -1; g++) {
        if (traj[g].filter(function (b) { return b.half > 0; }).length > traj[0].filter(function (b) { return b.half > 0; }).length) gpuBornStep = g;
      }
      var detail = "worst position disagreement " + worst.toFixed(5) + "px (at step " + worstAt + ") over " +
        STEPS + " steps; split fired at step " + jsBornStep + " in JS and step " + gpuBornStep + " on the GPU; " +
        "JS grew " + rows[0].length + " -> " + rows[rows.length - 1].length + " bodies";
      return { pass: worst < 0.01 && jsBornStep >= 0 && jsBornStep === gpuBornStep, detail: detail };
    }
  );

  addTest(
    "The fractal grid's own per-pixel codegen splits too, and matches the JS engine for that pixel",
    "the grid builds each pixel's scene symbolically (generateGridInitialStateGLSL) and hands it to the shared step loop: a different declaration path from compileSceneToTrajectoryGLSL's baked literals, so the spawn slots it emits (and the padding that has to leave every authored body's index alone) need their own check. This is the path the fractal image is actually made of.",
    function () {
      var STEPS = 90, WORLD_X = 12;
      var scene = {
        mutualGravity: false,
        bodies: [
          PhysicsEngine.createSplitter(400, 400, 120, Math.PI, true),
          PhysicsEngine.createCircle(385, 250, 4, false),
        ],
        hinges: [], frameWidth: 1200, frameHeight: 900, edgeMode: "wrap",
        xInput: { body: 1, property: "x" },
        yInput: null,
        output: { body: 1, property: "y" },
      };
      var compiled = PhysicsGridCodegen.compileHoverTrajectoryGLSL(scene, WORLD_X, 0, STEPS, "f32");
      var traj = PhysicsGPU.runCompiledTrajectoryOnGPU(compiled, STEPS);
      var jsScene = PhysicsGridCodegen.computeOffsetSceneNumeric(scene, WORLD_X, 0);
      var worst = 0, jsBornStep = -1, gpuBornStep = -1;
      var startBodies = jsScene.bodies.length;
      var gpuStartAlive = null;
      for (var i = 0; i < STEPS; i++) {
        PhysicsEngine.step(jsScene, PhysicsGPU.FIXED_DT);
        if (jsBornStep === -1 && jsScene.bodies.length > startBodies) jsBornStep = i;
        var alive = traj[i].filter(function (b) { return b.half > 0; }).length;
        if (gpuStartAlive === null) gpuStartAlive = alive;
        if (gpuBornStep === -1 && alive > gpuStartAlive) gpuBornStep = i;
        for (var b = 0; b < jsScene.bodies.length; b++) {
          worst = Math.max(worst, dist(jsScene.bodies[b].x, jsScene.bodies[b].y, traj[i][b].x, traj[i][b].y));
        }
      }
      var detail = "worst disagreement " + worst.toFixed(5) + "px over " + STEPS + " steps at worldX=" + WORLD_X +
        "; split fired at step " + jsBornStep + " in JS and step " + gpuBornStep + " on the grid's shader; " +
        "JS ended with " + jsScene.bodies.length + " bodies";
      return { pass: worst < 0.01 && jsBornStep >= 0 && jsBornStep === gpuBornStep && jsScene.bodies.length === 3, detail: detail };
    }
  );

  addTest(
    "The GPU agrees with JS through a RECURSIVE split, with two lineage members live at once",
    "one split is a single woken slot; a second split off one half exercises liveCount's ordering, a spawn slot being itself splittable, and a woken slot inheriting its parent's lineage rather than its own index",
    function () {
      var STEPS = 130;
      var scene = {
        mutualGravity: false,
        bodies: [
          PhysicsEngine.createSplitter(400, 400, 120, Math.PI, true),
          PhysicsEngine.createCircle(400, 250, 4, false),
          PhysicsEngine.createSplitter(460, 700, 120, Math.PI, true),
        ],
        hinges: [], frameWidth: 1200, frameHeight: 1400, edgeMode: "wrap",
      };
      var rows = PhysicsEngine.runTrajectory(PhysicsEngine.cloneScene(scene), STEPS, DT);
      var traj = PhysicsGPU.runSceneOnGPU(scene, STEPS);
      var worst = 0, worstAt = -1;
      for (var stepIdx = 0; stepIdx < STEPS; stepIdx++) {
        for (var b = 0; b < rows[stepIdx].length; b++) {
          var e = dist(rows[stepIdx][b].x, rows[stepIdx][b].y, traj[stepIdx][b].x, traj[stepIdx][b].y);
          if (e > worst) { worst = e; worstAt = stepIdx; }
        }
      }
      var jsFinal = rows[rows.length - 1].length;
      var gpuFinal = traj[STEPS - 1].filter(function (b) { return b.half > 0; }).length;
      // A trapezoid reports half = size/2 > 0, so the splitters count as alive on both sides.
      var detail = "worst disagreement " + worst.toFixed(5) + "px (at step " + worstAt + "); final bodies: JS " +
        jsFinal + ", GPU " + gpuFinal + " (want equal, and >= 5 - two splitters plus three balls)";
      return { pass: worst < 0.01 && jsFinal === gpuFinal && jsFinal >= 5, detail: detail };
    }
  );

  addTest(
    "Mutual Gravity with a funnel or splitter stays finite (it used to go NaN and hang the tab)",
    "gravitationalMass/halfExtent read body.length, which a trapezoid doesn't have - the NaN that produced made every 'dist >= rsum' test false, so every swept test reported contact, so a splitter split its ball EVERY step and the body count doubled until the tab died (reported as 'when I press play it crashes')",
    function () {
      var scene = {
        mutualGravity: true,
        bodies: [
          PhysicsEngine.createCircle(1027, 140, 11, false),
          PhysicsEngine.createSplitter(688, 492, 120, 0, true),
        ],
        hinges: [], frameWidth: 1192, frameHeight: 809, edgeMode: "infinite",
      };
      scene.bodies[0].vx = 14; scene.bodies[0].vy = 41;
      var started = Date.now();
      var rows = PhysicsEngine.runTrajectory(scene, 1000, DT);
      var elapsed = Date.now() - started;
      var last = rows[rows.length - 1];
      var allFinite = last.every(function (b) { return isFinite(b.x) && isFinite(b.y); });
      var maxBodies = rows.reduce(function (m, r) { return Math.max(m, r.length); }, 0);
      // A funnel under Mutual Gravity has to stay finite too.
      var fScene = {
        mutualGravity: true,
        bodies: [
          PhysicsEngine.createCircle(500, 200, 10, false),
          PhysicsEngine.createFunnel(500, 500, 120, 0, true),
        ],
        hinges: [], frameWidth: 1200, frameHeight: 900, edgeMode: "wrap",
      };
      runJS(fScene, 300);
      var funnelFinite = isFinite(fScene.bodies[0].x) && isFinite(fScene.bodies[0].y);
      var detail = "1000 steps in " + elapsed + "ms, bodies peaked at " + maxBodies +
        " (cap " + PhysicsEngine.MAX_SIMULATION_BODIES + "), all positions finite=" + allFinite +
        "; funnel under Mutual Gravity finite=" + funnelFinite;
      return { pass: allFinite && funnelFinite && maxBodies <= PhysicsEngine.MAX_SIMULATION_BODIES && elapsed < 5000, detail: detail };
    }
  );

  addTest(
    "A circle resting against a splitter's short side never splits",
    "only a FRESH crossing splits: a circle already inside the trigger capsule at the start of a step would otherwise re-split every step, which is exponential in steps rather than an occasional extra ball",
    function () {
      // Short side vertical at x=448 (y 470-530); the ball rests on a floor 12px to its left, inside the
      // trigger capsule (18px = LINE_THICKNESS/2 + radius) without ever having crossed into it.
      var scene = {
        bodies: [
          PhysicsEngine.createSplitter(500, 500, 120, Math.PI / 2, true),
          PhysicsEngine.createLine(300, 518, 300, 0, true),
          PhysicsEngine.createCircle(436, 500, 8, false),
        ],
        hinges: [], frameWidth: 1200, frameHeight: 900, edgeMode: "infinite",
      };
      var firstSplit = 0;
      for (var i = 0; i < 400; i++) {
        PhysicsEngine.step(scene, DT);
        if (!firstSplit && scene.bodies.length > 3) firstSplit = i + 1;
      }
      var circles = scene.bodies.filter(function (b) { return b.type === "circle"; }).length;
      var detail = "after 400 steps resting against the short side: " + circles +
        " circle(s) (want exactly 1: it never crossed in, so it never splits)" +
        (firstSplit ? "; first split at step " + firstSplit : "");
      return { pass: circles === 1, detail: detail };
    }
  );

    // ---- df.N The double-float pass must actually BUY its extra digits ----
    // Measured as: two neighbouring pixels at a given zoom must end up somewhere different.
    // Measured walls at 500 steps: float32 stops resolving neighbours between 1e5 and 1e6, df past 1e12;
    // the assertions sit well inside both so this can't go flaky.
  addTest(
    "Double-float resolves pixels float32 cannot (guards against a f32 collapse in the df chain)",
    "precision is set by the weakest link: one float32 op anywhere in the df step would cost most of df's ~7 extra digits while every other df test still passed",
    function () {
      function scene() {
        return {
          bodies: [
            PhysicsEngine.createCircle(673.9, 46.1, 30, false),
            PhysicsEngine.createLine(323, 468, 300, 0.35, true),
            PhysicsEngine.createLine(903, 475, 300, -0.4, true),
            PhysicsEngine.createLine(600, 800, 900, 0, true),
          ],
          hinges: [],
          xInput: { body: 0, property: "x" }, yInput: { body: 0, property: "y" },
          output: { body: 0, property: "y" }, frameWidth: 1192, frameHeight: 819,
        };
      }
      var STEPS = 500, WX = 0.37, WY = 0.11;
      var ref = cpuStateAt(scene(), WX, WY, STEPS, 0);
      // One pixel of world distance at `oom` orders of zoom, as the grid's own scale/resolution gives it.
      function neighbourSeparation(precision, oom) {
        var pixel = (900 / Math.pow(10, oom)) / 200;
        var a = gridResidualAtPoint(scene(), STEPS, WX, WY, precision, 0, ref);
        var b = gridResidualAtPoint(scene(), STEPS, WX + pixel, WY, precision, 0, ref);
        return Math.hypot(a.dx - b.dx, a.dy - b.dy);
      }
      var f32At1e6 = neighbourSeparation("f32", 6);
      var dfAt1e10 = neighbourSeparation("df", 10);
      var detail = "at 1e6 zoom float32 separates neighbours by " + f32At1e6.toExponential(2) +
        " (0 = cannot tell them apart, its wall is ~1e5); at 1e10 zoom df separates them by " +
        dfAt1e10.toExponential(2) + " (df's own wall measured past 1e12)";
      return { pass: f32At1e6 === 0 && dfAt1e10 > 0, detail: detail };
    }
  );

  addTest(
    "vx/vy Input offsets the body's starting velocity directly, with the same Y-axis flip x/y position get",
    "resolveOffsetTargetsNumeric's isYAxisProperty must catch \"vy\" the same way it already catches \"y\", or panning the world view \"up\" would feel backwards for a velocity link while feeling right for a position link",
    function () {
      var scene = {
        bodies: [PhysicsEngine.createCircle(500, 300, 20, false)],
        hinges: [],
        xInput: { body: 0, property: "vx" },
        yInput: { body: 0, property: "vy" },
        output: null,
      };
      scene.bodies[0].vx = 10; scene.bodies[0].vy = -5;
      var offset = PhysicsGridCodegen.computeOffsetSceneNumeric(scene, 100, 40);
      var b = offset.bodies[0];
      // vx: plain offset, no flip -> 10 + 100. vy: Y-axis flip -> -5 + (-40).
      var vxOk = Math.abs(b.vx - 110) < 1e-9;
      var vyOk = Math.abs(b.vy - (-45)) < 1e-9;
      // Position/angle/radius are untouched by a velocity link.
      var restUntouched = b.x === 500 && b.y === 300 && b.angle === 0 && b.radius === 20;
      var detail = "vx=" + b.vx + " (want 110), vy=" + b.vy + " (want -45), position/angle/radius unchanged=" + restUntouched;
      return { pass: vxOk && vyOk && restUntouched, detail: detail };
    }
  );

  addTest(
    "Grid codegen + step loop: a vx/vy Input offset reaches the GPU shader, not just the JS mirror",
    "vx/vy used to be baked as a compile-time literal in generateCanonicalBodyDeclarationsGLSL: a Input link to them would silently do nothing on the actual grid/Play GPU path while still working in computeOffsetSceneNumeric's JS-only hover preview",
    function () {
      var scene = {
        bodies: [PhysicsEngine.createCircle(500, 300, 20, false)],
        hinges: [],
        xInput: { body: 0, property: "vx" },
        yInput: { body: 0, property: "vy" },
        output: null,
      };
      scene.bodies[0].vx = 5; scene.bodies[0].vy = -10;
      var STEPS = 30, WORLD_X = 150, WORLD_Y = 60;
      var jsScene = PhysicsGridCodegen.computeOffsetSceneNumeric(scene, WORLD_X, WORLD_Y);
      for (var i = 0; i < STEPS; i++) PhysicsEngine.step(jsScene, PhysicsGPU.FIXED_DT);
      var gpuBodies = runGridSimulationAtPoint(scene, STEPS, WORLD_X, WORLD_Y);
      var posErr = Math.max(Math.abs(gpuBodies[0].x - jsScene.bodies[0].x), Math.abs(gpuBodies[0].y - jsScene.bodies[0].y));
      // No vx/vy Input at all: the offset must be exactly zero, landing on the authored (5, -10).
      var noInputScene = { bodies: [PhysicsEngine.createCircle(500, 300, 20, false)], hinges: [], xInput: null, yInput: null, output: null };
      noInputScene.bodies[0].vx = 5; noInputScene.bodies[0].vy = -10;
      var jsNoInput = PhysicsEngine.cloneScene(noInputScene);
      PhysicsEngine.computeMass(jsNoInput.bodies[0]);
      for (var j = 0; j < STEPS; j++) PhysicsEngine.step(jsNoInput, PhysicsGPU.FIXED_DT);
      var gpuNoInput = runGridSimulationAtPoint(noInputScene, STEPS, WORLD_X, WORLD_Y);
      var noInputErr = Math.max(Math.abs(gpuNoInput[0].x - jsNoInput.bodies[0].x), Math.abs(gpuNoInput[0].y - jsNoInput.bodies[0].y));
      var detail = "with vx/vy Input, after " + STEPS + " steps: position error=" + posErr.toFixed(4) +
        "px; with NO vx/vy Input (authored velocity only): position error=" + noInputErr.toFixed(4) + "px";
      return { pass: posErr < 0.05 && noInputErr < 0.05, detail: detail };
    }
  );

  addTest(
    "collisionsEnabled:false lets a body pass straight through a wall it would otherwise bounce off",
    "the Collisions toggle: every detection loop in step() (ordinary contacts, funnel mouth, splitter short side) is gated on PhysicsEngine.collisionsEnabled",
    function () {
      function scene(collisionsEnabled) {
        var s = {
          mutualGravity: false,
          bodies: [
            PhysicsEngine.createCircle(500, 100, 20, false),
            PhysicsEngine.createLine(500, 500, 400, 0, true),
          ],
          hinges: [],
        };
        if (collisionsEnabled !== undefined) s.collisionsEnabled = collisionsEnabled;
        return s;
      }
      var withC = scene(true), without = scene(false);
      var maxYWith = -Infinity;
      for (var i = 0; i < 120; i++) {
        PhysicsEngine.step(withC, DT);
        PhysicsEngine.step(without, DT);
        maxYWith = Math.max(maxYWith, withC.bodies[0].y);
      }
      var bouncedOff = maxYWith < 500; // never crosses the line's own y
      var passedThrough = without.bodies[0].y > 700; // well past the line, still falling freely
      var defaultIsOn = PhysicsEngine.collisionsEnabled(scene());
      var detail = "with collisions: max y reached=" + maxYWith.toFixed(1) + " (line at y=500, want bounded under it); " +
        "without: final y=" + without.bodies[0].y.toFixed(1) + " (want > 700, i.e. fell straight through); " +
        "default (field omitted)=" + (defaultIsOn ? "on" : "off");
      return { pass: bouncedOff && passedThrough && defaultIsOn, detail: detail };
    }
  );

  addTest(
    "collisionsEnabled:false also passes a circle through a funnel and a splitter, not just ordinary bodies",
    "\"objects can pass right through each other\" was read as applying uniformly: a funnel/splitter's solid edges and triggers use the exact same swept detection as an ordinary bounce, so leaving them collidable while turning off everything else would be an inconsistent carve-out",
    function () {
      var funnelScene = {
        mutualGravity: false, collisionsEnabled: false,
        bodies: [
          PhysicsEngine.createCircle(400, 250, 10, false),
          PhysicsEngine.createFunnel(400, 400, 120, 0, true),
        ],
        hinges: [], frameWidth: 1200, frameHeight: 900, edgeMode: "wrap",
      };
      for (var i = 0; i < 60; i++) PhysicsEngine.step(funnelScene, DT);
      var noTeleport = funnelScene.bodies.length === 2 && funnelScene.bodies[0].y > 460; // fell straight past the throat, no snap
      // buildSplitterScene(385) is proven to split within 60 steps with collisions on: a real negative control.
      var splitterScene = buildSplitterScene(385);
      splitterScene.collisionsEnabled = false;
      for (var j = 0; j < 60; j++) PhysicsEngine.step(splitterScene, DT);
      var noSplit = splitterScene.bodies.length === 2; // circle + splitter, unchanged
      var detail = "funnel: bodies=" + funnelScene.bodies.length + ", ball y=" + funnelScene.bodies[0].y.toFixed(1) +
        " (no teleport happened=" + noTeleport + "); splitter: bodies=" + splitterScene.bodies.length + " (no split happened=" + noSplit + ")";
      return { pass: noTeleport && noSplit, detail: detail };
    }
  );

  addTest(
    "JS engine and GPU compiler agree with collisions off (including a body that starts already overlapping)",
    "physics-gpu.js's fix is passing collisionPairs an empty array rather than a flag threaded through generateStepOnceGLSL: this proves that actually reaches the compiled shader, not just the JS engine",
    function () {
      function buildScene() {
        return {
          mutualGravity: false, collisionsEnabled: false,
          bodies: [
            PhysicsEngine.createLine(400, 560, 700, 0, true),
            PhysicsEngine.createCircle(400, 400, 30, false), // already overlapping the line at step 0
            PhysicsEngine.createLine(530, 150, 140, 0.3, false),
          ],
          hinges: [],
        };
      }
      var jsScene = buildScene();
      var gpuScene = buildScene();
      var STEPS = 100;
      var traj = PhysicsGPU.runSceneOnGPU(gpuScene, STEPS);
      for (var i = 0; i < STEPS; i++) PhysicsEngine.step(jsScene, DT);
      var row = traj[STEPS - 1];
      var maxErr = 0;
      for (var b = 0; b < jsScene.bodies.length; b++) {
        maxErr = Math.max(maxErr, Math.abs(jsScene.bodies[b].x - row[b].x), Math.abs(jsScene.bodies[b].y - row[b].y));
      }
      var fellThrough = jsScene.bodies[1].y > 700;
      var detail = "after " + STEPS + " steps: max JS/GPU position error=" + maxErr.toFixed(4) +
        "px, ball y=" + jsScene.bodies[1].y.toFixed(1) + " (started overlapping a line at y=560; want it to have fallen straight through, not stuck or bounced)";
      return { pass: maxErr < 0.01 && fellThrough, detail: detail };
    }
  );

  addTest(
    "Mutual Gravity with collisions off: the pull is continuous across the contact shell, and smooth inside it",
    "the touching-bodies rule switched the pull from ~1963px/s^2 to exactly 0 at r=contact. With collisions on that's fine (the contact solver answers for it, and the overlap lasts a step) but with collisions off nothing answers for it and bodies coast through, making the shell a step discontinuity in the field itself. Its first replacement, the uniform-density ramp G*m*r/contact^3, was continuous but turned sharply from rising to falling at the shell: a corner the fixed step catches at a different phase for every starting state, which came out as a sawtooth across neighbouring pixels. The interior now meets G*m/r^2 at the shell in value, slope and curvature",
    function () {
      function pullAt(r, collisions) {
        var scene = {
          mutualGravity: true, collisionsEnabled: collisions,
          bodies: [PhysicsEngine.createCircle(0, 0, 30, false), PhysicsEngine.createCircle(r, 0, 30, false)],
          hinges: [],
        };
        PhysicsEngine.computeMass(scene);
        var acc = PhysicsEngine.computeAccelerations(scene);
        return Math.abs(acc[0].x);
      }
      var C = 60; // both radii 30
      var outside = pullAt(C + 1e-6, false);
      var inside = pullAt(C - 1e-6, false);
      var onInside = pullAt(C - 1e-6, true);
      // Continuity at the shell (the residual is the 1e-6 probe offset on the 1/r^2 curve).
      var jump = Math.abs(outside - inside);
      // Slope and curvature from one-sided differences, each side on its own branch.
      var h = 1e-3;
      var slopeOut = (pullAt(C + 2 * h, false) - pullAt(C + h, false)) / h;
      var slopeIn = (pullAt(C - h, false) - pullAt(C - 2 * h, false)) / h;
      var slopeErr = Math.abs(slopeOut - slopeIn) / Math.abs(slopeOut);
      var H = 1e-2;
      var bendOut = (pullAt(C + 3 * H, false) - 2 * pullAt(C + 2 * H, false) + pullAt(C + H, false)) / (H * H);
      var bendIn = (pullAt(C - H, false) - 2 * pullAt(C - 2 * H, false) + pullAt(C - 3 * H, false)) / (H * H);
      var bendErr = Math.abs(bendOut - bendIn) / Math.abs(bendOut);
      // The interior law itself, against its closed form at two radii.
      var GM = PhysicsEngine.MUTUAL_GRAVITY_CONSTANT *
        PhysicsEngine.gravitationalMass(PhysicsEngine.createCircle(0, 0, 30, false));
      function expected(r) {
        var u2 = (r / C) * (r / C);
        return GM * r / (C * C * C) * (35 / 8 - 21 / 4 * u2 + 15 / 8 * u2 * u2);
      }
      var lawErr = Math.max(Math.abs(pullAt(C / 2, false) / expected(C / 2) - 1),
                            Math.abs(pullAt(C / 4, false) / expected(C / 4) - 1));
      var atOrigin = pullAt(1e-9, false); // reaches zero, so no singularity
      var detail = "collisions off: pull just outside=" + outside.toFixed(4) +
        ", just inside=" + inside.toFixed(4) + " (jump=" + jump.toExponential(2) +
        "px/s^2, was ~1963 - the whole bug); slope " + slopeOut.toFixed(3) + " outside vs " +
        slopeIn.toFixed(3) + " inside (rel err=" + slopeErr.toExponential(2) + "); curvature " +
        bendOut.toFixed(4) + " vs " + bendIn.toFixed(4) + " (rel err=" + bendErr.toExponential(2) +
        "); interior law vs closed form rel err=" + lawErr.toExponential(2) +
        "; a(1e-9px)=" + atOrigin.toExponential(2) + " (no singularity); collisions ON just inside=" +
        onInside.toFixed(4) + " (want exactly 0, unchanged)";
      return {
        pass: jump < 1e-3 && slopeErr < 1e-3 && bendErr < 2e-2 && lawErr < 1e-12 && atOrigin < 1e-6 && onInside === 0,
        detail: detail,
      };
    }
  );

  addTest(
    "Mutual Gravity with collisions off: neighbouring starting states no longer come out a fixed distance apart",
    "reported as 'non-continuousness' on a two-circle scene: two starts 4.7e-5px apart came out 133.9px apart, and bringing them 7 decades closer together did not shrink that gap at all - the signature of a discontinuity rather than chaos. Cause was the contact-shell cutoff above; this pins the outcome rather than the mechanism, so it fails if any future change reintroduces a branch anywhere in this path",
    function () {
      var SCENE = {
        mutualGravity: true, collisionsEnabled: false,
        bodies: [
          { type: "circle", x: 695.1829, y: 424.083, angle: 0, isAnchored: false, radius: 30, vx: -82, vy: 133, w: 0 },
          { type: "circle", x: 335.4948, y: 446.0356, angle: 0, isAnchored: false, radius: 30, vx: 126, vy: -2, w: 0 },
        ],
        hinges: [], xInput: { body: 1, property: "x" }, yInput: { body: 0, property: "y" },
        output: { body: 0, property: "y" }, frameWidth: 1099, frameHeight: 1147, edgeMode: "infinite",
      };
      var A = [-57.621353, 86.656494], B = [-57.621189, 86.656541];
      var BORDER = 0.4603957024236781; // where the old cutoff-entry step flipped, bisected
      function outputAt(t) {
        var wx = A[0] + t * (B[0] - A[0]), wy = A[1] + t * (B[1] - A[1]);
        var s = PhysicsGridCodegen.computeOffsetSceneNumeric(SCENE, wx, wy);
        PhysicsEngine.computeMass(s);
        for (var k = 0; k < 400; k++) PhysicsEngine.step(s, DT);
        return s.bodies[0].y;
      }
      var reportedGap = Math.abs(outputAt(0) - outputAt(1));
      // Refining the pair 100x closer must shrink the gap ~100x. A discontinuity holds it constant.
      function gapAt(d) { return Math.abs(outputAt(BORDER + d) - outputAt(BORDER - d)); }
      var coarse = gapAt(1e-2), fine = gapAt(1e-4), finest = gapAt(1e-6);
      var ratio1 = coarse / fine, ratio2 = fine / finest;
      var detail = "the two reported starts now land " + reportedGap.toExponential(3) +
        "px apart (was 133.9px); refining across the old border: " + coarse.toExponential(2) + " -> " +
        fine.toExponential(2) + " -> " + finest.toExponential(2) +
        "px, shrinking " + ratio1.toFixed(0) + "x then " + ratio2.toFixed(0) + "x per 100x refinement (want ~100x each; a discontinuity gives 1x)";
      return { pass: reportedGap < 0.01 && ratio1 > 50 && ratio2 > 50, detail: detail };
    }
  );

  addTest(
    "Mutual Gravity with collisions off: a pass through another body no longer turns a smooth sweep into a sawtooth",
    "reported on a scene where a 6.18px circle passes through a free 30px one: 30 samples along a 10px line came out as a sawtooth, falling for ~5 samples, then jumping back up by as much as 67px, every ~6 samples. Not a discontinuity (the jumps shrank under refinement) and not chaos (a 1/128th-size step gave a smooth line): the old interior ramp met 1/r^2 at the contact shell with a sharp corner, and each start caught that corner at a different step phase. This pins the sweep itself: no slope reversals, no sharp bends",
    function () {
      // The reported scene, in engine space (authored in a 1044x862 frame).
      var SCENE = {
        mutualGravity: true, collisionsEnabled: false,
        bodies: [
          { type: "circle", x: 480, y: 431, angle: 0, isAnchored: false, radius: 30, vx: 0, vy: 0, w: 0 },
          { type: "circle", x: 181, y: 105, angle: 0, isAnchored: false, radius: 6.1838, vx: -46, vy: 38, w: 0 },
        ],
        hinges: [], xInput: { body: 1, property: "x" }, yInput: { body: 1, property: "y" },
        output: { body: 1, property: "y" }, frameWidth: 1044, frameHeight: 862, edgeMode: "infinite",
      };
      var A = [486.519103, -395.488076], B = [495.396947, -400.099254], N = 30;
      var ys = [], closest = Infinity;
      for (var i = 0; i < N; i++) {
        var t = i / (N - 1);
        var s = PhysicsGridCodegen.computeOffsetSceneNumeric(SCENE, A[0] + t * (B[0] - A[0]), A[1] + t * (B[1] - A[1]));
        for (var k = 0; k < 200; k++) {
          PhysicsEngine.step(s, DT);
          closest = Math.min(closest, Math.hypot(s.bodies[1].x - s.bodies[0].x, s.bodies[1].y - s.bodies[0].y));
        }
        ys.push(s.bodies[1].y);
      }
      var reversals = 0, worstBend = 0;
      for (var j = 2; j < N; j++) {
        var d1 = ys[j - 1] - ys[j - 2], d2 = ys[j] - ys[j - 1];
        if ((d1 > 0) !== (d2 > 0)) reversals++;
        worstBend = Math.max(worstBend, Math.abs(d2 - d1));
      }
      // Guards the test itself: the pass must actually reach inside the shell.
      var wentInside = closest < 30 + 6.1838;
      var detail = "closest approach " + closest.toFixed(1) + "px (shell at 36.2px, so the interior was exercised=" +
        wentInside + "); across 30 samples the output's slope reversed " + reversals +
        " times (was 10) and the sharpest bend between neighbours was " + worstBend.toFixed(2) + "px (was 91.7)";
      return { pass: wentInside && reversals === 0 && worstBend < 5, detail: detail };
    }
  );

  addTest(
    "Mutual Gravity with collisions off: JS engine and GPU compiler agree through an overlapping pass",
    "the interior law is a second hand-synced pair of implementations (PhysicsEngine.computeAccelerations and its GLSL port in generateStepOnceGLSL). generateStepOnceGLSL learns collisions are off from a new argument rather than from `pairs` being empty, since the Mutual Gravity accel loop walks every body rather than the pair list: this proves that argument is actually threaded through from every caller",
    function () {
      function buildScene() {
        return {
          mutualGravity: true, collisionsEnabled: false,
          bodies: [
            PhysicsEngine.createCircle(400, 300, 30, false),
            PhysicsEngine.createCircle(600, 300, 30, false),
          ],
          hinges: [],
        };
      }
      // Aimed straight at each other so they pass well inside contact (60px) and spend steps on the interior law.
      var jsScene = buildScene(); jsScene.bodies[0].vx = 140; jsScene.bodies[1].vx = -140;
      var gpuScene = buildScene(); gpuScene.bodies[0].vx = 140; gpuScene.bodies[1].vx = -140;
      var STEPS = 90;
      var traj = PhysicsGPU.runSceneOnGPU(gpuScene, STEPS);
      var minSep = 1e9;
      for (var i = 0; i < STEPS; i++) {
        PhysicsEngine.step(jsScene, DT);
        minSep = Math.min(minSep, Math.abs(jsScene.bodies[1].x - jsScene.bodies[0].x));
      }
      var row = traj[STEPS - 1];
      var maxErr = 0;
      for (var b = 0; b < jsScene.bodies.length; b++) {
        maxErr = Math.max(maxErr, Math.abs(jsScene.bodies[b].x - row[b].x), Math.abs(jsScene.bodies[b].y - row[b].y));
      }
      var wentInside = minSep < 60;
      var detail = "closest center separation=" + minSep.toFixed(2) + "px (contact is 60px, so the interior law was exercised=" +
        wentInside + "); max JS/GPU position error after " + STEPS + " steps=" + maxErr.toFixed(4) + "px";
      return { pass: wentInside && maxErr < 0.05, detail: detail };
    }
  );

    // ---- Global Stats analysis math (fractal-stats.js) ----
    // These pin the analysis math to pictures with known answers (ramps, stripes, noise, a wrap sweep)
    // rather than reproducing shipped bugs. FractalStats is DOM- and WebGL-free so it loads here.

    // Runs a job to completion; the real caller spreads the same steps across idle callbacks.
  function runStatsJob(spec) {
    var job = FractalStats.createJob(spec);
    var guard = 0;
    while (job.step()) {
      if (++guard > 100000) throw new Error("stats job never finished");
    }
    return job.result;
  }

  var ALL_STAT_GROUPS = { extremes: true, distribution: true, orientation: true, features: true };

  function statsField(w, h, fn) {
    var t = new Float32Array(w * h);
    for (var r = 0; r < h; r++) {
      for (var c = 0; c < w; c++) t[r * w + c] = fn(c, r);
    }
    return { width: w, height: h, t: t };
  }

    // mulberry32: a real generator, because the white-noise test needs input that is actually white.
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  addTest(
    "A plain left-to-right ramp reads as one vertical-lined, perfectly coherent plane",
    "Structure tensor, extrema and curvature all have exact answers here",
    function () {
      var W = 64, H = 64;
      var f = statsField(W, H, function (c) { return c / (W - 1); });
      var res = runStatsJob({ width: W, height: H, t: f.t, circular: false, groups: ALL_STAT_GROUPS });
      var ex = res.groups.extremes, or = res.groups.orientation;
      // The rose's total weight is the summed Sobel |grad| over the (W-2)(H-2) interior samples.
      var slope = 1 / (W - 1);
      var checks = [
        ["min at the left edge", ex.min.col === 0 && ex.min.t === 0],
        ["max at the right edge", ex.max.col === W - 1 && Math.abs(ex.max.t - 1) < 1e-6],
        ["range = 1", Math.abs(ex.range - 1) < 1e-6],
        ["mean Sobel gradient = 1/(W-1)", Math.abs(or.totalWeight / or.samples - slope) < 1e-7],
        // The gradient points along +x, so the EDGES run at 90 degrees (the easiest mistake in the rose).
        ["edges read as vertical (90 degrees)", Math.abs(or.dominantEdgeDegrees - 90) < 0.01],
        ["coherence = 1", Math.abs(or.coherence - 1) < 1e-6],
        // A ramp has zero curvature, so Topography calls all of it flat.
        ["curves nowhere", res.groups.features.flatFraction === 1],
      ];
      var failed = checks.filter(function (c) { return !c[1]; });
      return {
        pass: failed.length === 0,
        detail: failed.length ? "failed: " + failed.map(function (c) { return c[0]; }).join(", ")
          : "gradient=" + (or.totalWeight / or.samples).toFixed(6) + ", edge angle=" + or.dominantEdgeDegrees.toFixed(2) + " degrees",
      };
    }
  );

  addTest(
    "Stripes are found at the angle they were drawn at",
    "The rose and the structure tensor must agree with each other and with the picture",
    function () {
      // Row 0 is the BOTTOM row, so lines of constant (c + r) run up to the LEFT: 135 degrees, not 45.
      var cases = [
        { name: "horizontal", fn: function (c, r) { return (r % 8 < 4) ? 0.2 : 0.8; }, degrees: 0 },
        { name: "vertical", fn: function (c) { return (c % 8 < 4) ? 0.2 : 0.8; }, degrees: 90 },
        { name: "diagonal", fn: function (c, r) { return ((c + r) % 8 < 4) ? 0.2 : 0.8; }, degrees: 135 },
      ];
      var W = 64, H = 64, problems = [], detail = [];
      cases.forEach(function (one) {
        var f = statsField(W, H, one.fn);
        var res = runStatsJob({ width: W, height: H, t: f.t, circular: false, groups: { orientation: true } });
        var o = res.groups.orientation;
        // 0 degrees and 180 degrees are the same heading.
        var off = Math.min(Math.abs(o.peakBinDegrees - one.degrees), 180 - Math.abs(o.peakBinDegrees - one.degrees));
        if (off > 1.5) problems.push(one.name + " rose peak " + o.peakBinDegrees.toFixed(1));
        if (o.coherence < 0.95) problems.push(one.name + " coherence " + o.coherence.toFixed(3));
        detail.push(one.name + ": " + o.peakBinDegrees.toFixed(1) + " degrees");
      });
      return { pass: problems.length === 0, detail: problems.length ? problems.join("; ") : detail.join("; ") };
    }
  );

  addTest(
    "White noise reads as structureless",
    "Every 'how structured is this' number must sit at its own zero for an unstructured picture",
    function () {
      var W = 96, H = 96, rnd = mulberry32(1);
      var f = statsField(W, H, function () { return rnd(); });
      var res = runStatsJob({ width: W, height: H, t: f.t, circular: false, groups: ALL_STAT_GROUPS });
      var d = res.groups.distribution, o = res.groups.orientation;
      var checks = [
        ["coherence near 0", o.coherence < 0.1],
        // A uniform distribution's exact moments: this tests the moment code, not the generator.
        ["mean ~ 0.5", Math.abs(d.mean - 0.5) < 0.02],
        ["std ~ 1/sqrt(12)", Math.abs(d.std - Math.sqrt(1 / 12)) < 0.01],
        ["excess kurtosis ~ -1.2", Math.abs(d.kurtosisExcess + 1.2) < 0.1],
        ["entropy near 100%", d.entropyNormalized > 0.99],
      ];
      var failed = checks.filter(function (x) { return !x[1]; });
      return {
        pass: failed.length === 0,
        detail: failed.length ? "failed: " + failed.map(function (x) { return x[0]; }).join(", ")
          : "coherence=" + o.coherence.toFixed(3) + ", kurtosis=" + d.kurtosisExcess.toFixed(2),
      };
    }
  );

  addTest(
    "A wrapping Output's seam is not mistaken for an edge",
    "mod() cutting the color wheel would otherwise read as the sharpest feature in the view",
    function () {
      // A smooth ramp wrapping 1 -> 0 twice: the true slope is 2/W everywhere; a naive difference sees
      // a near-1.0 cliff at each wrap, which would read as an edge and as curvature.
      var W = 64, H = 64;
      var f = statsField(W, H, function (c) { return (0.4 + 2 * c / W) % 1; });
      var wrapped = runStatsJob({ width: W, height: H, t: f.t, circular: true, groups: { orientation: true, features: true } });
      var naive = runStatsJob({ width: W, height: H, t: f.t, circular: false, groups: { orientation: true, features: true } });
      var trueSlope = 2 / W;
      var wrappedMean = wrapped.groups.orientation.totalWeight / wrapped.groups.orientation.samples;
      var naiveMean = naive.groups.orientation.totalWeight / naive.groups.orientation.samples;
      var ok = Math.abs(wrappedMean - trueSlope) < 1e-5 &&
        naiveMean > 1.5 * trueSlope &&
        wrapped.groups.features.flatFraction === 1 &&
        naive.groups.features.flatFraction < 1;
      return {
        pass: ok,
        detail: "circular mean gradient=" + wrappedMean.toFixed(6) +
          " (true slope " + trueSlope.toFixed(6) + "), same data read linearly=" +
          naiveMean.toFixed(4) + "; flat share circular=" + wrapped.groups.features.flatFraction.toFixed(3) +
          ", linear=" + naive.groups.features.flatFraction.toFixed(3),
      };
    }
  );

  addTest(
    "A wrapping Output averages round the wheel, not across it",
    "The mean of 0.98 and 0.02 is 0, not 0.5: a plain average lands on the opposite side",
    function () {
      var W = 8, H = 8;
      var f = statsField(W, H, function (c, r) { return ((c + r) % 2 === 0) ? 0.98 : 0.02; });
      var res = runStatsJob({ width: W, height: H, t: f.t, circular: true, groups: { distribution: true } });
      var distanceFromZero = Math.min(res.circularMean, 1 - res.circularMean);
      return {
        pass: distanceFromZero < 0.01 && res.resultantLength > 0.99 && res.groups.distribution.circularSpread < 0.05,
        detail: "circular mean=" + res.circularMean.toFixed(4) + " (should be ~0 or ~1), concentration=" +
          res.resultantLength.toFixed(4) + ", spread=" + res.groups.distribution.circularSpread.toFixed(4),
      };
    }
  );

  addTest(
    "A masked input seam contributes no gradient at all",
    "Where X/Y Input wraps back into the frame there is a straight false edge, and it is axis-aligned",
    function () {
      // Two flat halves with one step, marked as a seam; masked, the step must count for nothing.
      var W = 32, H = 16;
      var f = statsField(W, H, function (c) { return c < 16 ? 0.1 : 0.9; });
      var colSeam = new Uint8Array(W - 1);
      colSeam[15] = 1;
      var masked = runStatsJob({ width: W, height: H, t: f.t, circular: false, colSeam: colSeam, groups: { orientation: true } }).groups.orientation;
      var unmasked = runStatsJob({ width: W, height: H, t: f.t, circular: false, groups: { orientation: true } }).groups.orientation;
      // Unmasked, the two columns either side of the step carry Sobel gx of 0.8 * 4 / 8 on every interior row.
      var wantUnmasked = 2 * (H - 2) * 0.4;
      return {
        pass: masked.totalWeight < 1e-9 && Math.abs(unmasked.totalWeight - wantUnmasked) < 1e-5 &&
          Math.abs(unmasked.peakBinDegrees - 90) < 1.5,
        detail: "masked rose weight=" + masked.totalWeight.toExponential(2) +
          ", unmasked=" + unmasked.totalWeight.toFixed(4) + " (expected " + wantUnmasked.toFixed(4) +
          ") at " + unmasked.peakBinDegrees.toFixed(1) + " degrees",
      };
    }
  );

  addTest(
    "A simulation that produced NaN is excluded rather than averaged in",
    "One non-finite sample would otherwise make every mean, min and max on the card NaN",
    function () {
      var W = 16, H = 16;
      var f = statsField(W, H, function () { return 0.5; });
      f.t[0] = NaN;
      f.t[5] = Infinity;
      var res = runStatsJob({ width: W, height: H, t: f.t, circular: false, groups: { extremes: true, distribution: true } });
      return {
        pass: res.invalidCount === 2 && res.validCount === W * H - 2 &&
          Math.abs(res.groups.distribution.mean - 0.5) < 1e-7 &&
          Math.abs(res.groups.extremes.max.t - 0.5) < 1e-7,
        detail: "valid=" + res.validCount + ", invalid=" + res.invalidCount +
          ", mean=" + res.groups.distribution.mean + ", max=" + res.groups.extremes.max.t,
      };
    }
  );

  addTest(
    "A block too tall for one step is still counted exactly once, all of it",
    "Every pass is split by rows so a full-resolution block never hitches a frame: a split that skipped or repeated a row would be invisible in the numbers",
    function () {
      // Tall enough to force the row splitting (see SAMPLES_PER_STEP); distinct row values expose a dropped or doubled row.
      var W = 64, H = 2000;
      var f = statsField(W, H, function (c, r) { return r / (H - 1); });
      var res = runStatsJob({ width: W, height: H, t: f.t, circular: false, groups: ALL_STAT_GROUPS });
      var d = res.groups.distribution, ex = res.groups.extremes;
      var checks = [
        ["every sample counted", res.validCount === W * H],
        ["mean is the ramp's own midpoint", Math.abs(d.mean - 0.5) < 1e-6],
        ["min on the bottom row", ex.min.row === 0 && ex.min.t === 0],
        ["max on the top row", ex.max.row === H - 1 && Math.abs(ex.max.t - 1) < 1e-6],
        // A ramp up the screen has horizontal edges: 0 degrees.
        ["edges read as horizontal", Math.abs(res.groups.orientation.dominantEdgeDegrees % 180) < 0.01],
        ["the pass really was split", res.width * res.height > 60000],
      ];
      var failed = checks.filter(function (c) { return !c[1]; });
      return {
        pass: failed.length === 0,
        detail: failed.length ? "failed: " + failed.map(function (c) { return c[0]; }).join(", ")
          : W + "x" + H + " counted " + res.validCount + " samples, mean=" + d.mean.toFixed(6),
      };
    }
  );

  addTest(
    "The longest ridge and the longest valley are found, and measured along themselves",
    "Topography reports these in screens, and the map overlay draws the very paths measured",
    function () {
      // A separable field whose ridge and valley lines are known exactly:
      //   t = 0.5 + 0.3 cos(pi c / 2) + 0.2 cos(pi r / H)
      // Columns c = 0 (mod 4) are crests, c = 2 (mod 4) troughs, each running the full interior height
      // (rows 1 to 62: 62 samples, 61 unit steps); the gentle tilt along r stays inside the "level" allowance.
      var W = 64, H = 64;
      var f = statsField(W, H, function (c, r) {
        return 0.5 + 0.3 * Math.cos(Math.PI * c / 2) + 0.2 * Math.cos(Math.PI * r / H);
      });
      var g = runStatsJob({ width: W, height: H, t: f.t, circular: false, groups: { features: true } }).groups.features;
      var diag = Math.sqrt(W * W + H * H);
      var problems = [];
      function check(name, got, want) {
        if (Math.abs(got - want) > 1e-9) problems.push(name + "=" + got + " (expected " + want + ")");
      }
      if (!g.longestRidge) problems.push("no ridge found at all");
      if (!g.longestValley) problems.push("no valley found at all");
      if (g.longestRidge && g.longestValley) {
        // Every step is one row, so the length is a plain count.
        check("ridge length", g.longestRidge.length, 61);
        check("valley length", g.longestValley.length, 61);
        check("ridge in of the diagonal", g.longestRidgeDiagonals, 61 / diag);
        check("valley in of the diagonal", g.longestValleyDiagonals, 61 / diag);
        check("diagonal", g.diagonalSamples, diag);
        // The path is what the overlay draws, so its shape matters: one column (0 mod 4 for ridges,
        // 2 mod 4 for valleys), every row in it, no repeats.
        [["ridge", g.longestRidge, 0, 1, 62], ["valley", g.longestValley, 2, 1, 62]].forEach(function (one) {
          var name = one[0], path = one[1].path, rows = {};
          var col = path[0], minR = 1e9, maxR = -1e9, straight = true;
          for (var i = 0; i < path.length; i += 2) {
            if (path[i] !== col) straight = false;
            rows[path[i + 1]] = (rows[path[i + 1]] || 0) + 1;
            minR = Math.min(minR, path[i + 1]);
            maxR = Math.max(maxR, path[i + 1]);
          }
          if (!straight) problems.push(name + " path wanders across columns");
          if ((col % 4) !== one[2]) problems.push(name + " path column " + col + " is not " + one[2] + " (mod 4)");
          if (minR !== one[3] || maxR !== one[4]) problems.push(name + " path spans rows " + minR + ".." + maxR + " (expected " + one[3] + ".." + one[4] + ")");
          for (var k in rows) if (rows[k] !== 1) problems.push(name + " path visits row " + k + " " + rows[k] + " times");
        });
      }

      // A flat view has neither, and says so rather than reporting a
      // zero-length one.
      var flat = statsField(W, H, function () { return 0.42; });
      var fg = runStatsJob({ width: W, height: H, t: flat.t, circular: false, groups: { features: true } }).groups.features;
      if (fg.longestRidge !== null || fg.longestValley !== null) problems.push("a flat field reported a longest feature");
      if (fg.longestRidgeDiagonals !== 0 || fg.longestValleyDiagonals !== 0) problems.push("a flat field reported a non-zero length");

      return {
        pass: problems.length === 0,
        detail: problems.length ? problems.join("; ")
          : "ridge " + g.longestRidge.length + " samples (" + g.longestRidgeDiagonals.toFixed(4) +
            " of the diagonal), valley " + g.longestValley.length + " samples (" + g.longestValleyDiagonals.toFixed(4) + ")",
      };
    }
  );

  addTest(
    "A ridge line is followed the whole way across the view, and noise has no long one",
    "The point of the measurement: the crest of a range that crosses the screen reads as about one screen, and a chaotic speckle reads as nothing",
    function () {
      var W = 64, H = 64, diag = Math.sqrt(W * W + H * H), problems = [], detail = [];
      // Diagonal bands: crests along c + r = 64 (and every 32 either side). The middle one crosses
      // corner to corner: 61 samples, 60 root-two steps. Then upside down, so the trough crosses the middle.
      var want = 60 * Math.SQRT2 / diag;
      [1, -1].forEach(function (sign) {
        var bands = statsField(W, H, function (c, r) { return 0.5 + sign * 0.5 * Math.cos(2 * Math.PI * (c + r) / 32); });
        var g = runStatsJob({ width: W, height: H, t: bands.t, circular: false, groups: { features: true } }).groups.features;
        var name = sign > 0 ? "diagonal crest" : "diagonal trough";
        var got = sign > 0 ? g.longestRidgeDiagonals : g.longestValleyDiagonals;
        var found = sign > 0 ? g.longestRidge : g.longestValley;
        if (!found || Math.abs(got - want) > 0.03) {
          problems.push(name + " " + (found ? got.toFixed(3) : "missing") + " of the diagonal (expected " + want.toFixed(3) + ")");
        }
        detail.push(name + " " + (found ? got.toFixed(3) : "-") + " of the diagonal");
      });

      // Horizontal bands: the crest is a row, 62 samples and 61 unit steps
      // - the interior width over the diagonal.
      var rows = statsField(W, H, function (c, r) { return 0.5 + 0.5 * Math.cos(2 * Math.PI * r / 16); });
      var h = runStatsJob({ width: W, height: H, t: rows.t, circular: false, groups: { features: true } }).groups.features;
      if (!h.longestRidge || Math.abs(h.longestRidgeDiagonals - 61 / diag) > 1e-9) {
        problems.push("horizontal crest " + (h.longestRidge ? h.longestRidgeDiagonals.toFixed(3) : "missing") + " of the diagonal (expected " + (61 / diag).toFixed(3) + ")");
      }
      detail.push("horizontal crest " + (h.longestRidge ? h.longestRidgeDiagonals.toFixed(3) : "-"));

      // White noise: bumps everywhere, but no ridge may chain across the view. Two seeds.
      var worst = 0;
      [3, 5].forEach(function (seed) {
        var rnd = mulberry32(seed), N = 128;
        var noise = statsField(N, N, function () { return rnd(); });
        var ng = runStatsJob({ width: N, height: N, t: noise.t, circular: false, groups: { features: true } }).groups.features;
        worst = Math.max(worst, ng.longestRidgeDiagonals, ng.longestValleyDiagonals);
        if (ng.longestRidgeDiagonals > 0.15 || ng.longestValleyDiagonals > 0.15) {
          problems.push("noise (seed " + seed + ") ridge " + ng.longestRidgeDiagonals.toFixed(3) + ", valley " + ng.longestValleyDiagonals.toFixed(3) + " of the diagonal");
        }
      });
      detail.push("longest line in noise " + worst.toFixed(3) + " of the diagonal");

      // A float32 plateau rounds to a staircase of one-bit steps, and a one-bit groove is a perfect valley
      // by every geometric test; it must still report no valley at all.
      var plateau = statsField(W, H, function (c) { return 0.9 + (c % 2 ? 0 : 1e-7); });
      var pg = runStatsJob({ width: W, height: H, t: plateau.t, circular: false, groups: { features: true } }).groups.features;
      if (pg.longestValley || pg.longestRidge) {
        problems.push("rounding grooves on a plateau read as a " + (pg.longestValley ? "valley " + pg.longestValley.length : "ridge " + pg.longestRidge.length) + " samples long");
      }
      detail.push("plateau rounding ignored");
      return { pass: problems.length === 0, detail: problems.length ? problems.join("; ") : detail.join(", ") };
    }
  );

  addTest(
    "An edge is a step that holds its new level, followed the whole way along, and speckle is not one",
    "Longest Edge is a Canny edge with a plateau test and a direction test; each of those has a picture it exists for",
    function () {
      var W = 64, H = 64, diag = Math.sqrt(W * W + H * H), problems = [], detail = [];
      function edgeOf(fn, w, h) {
        return runStatsJob({ width: w || W, height: h || H, t: statsField(w || W, h || H, fn).t, circular: false, groups: { features: true } }).groups.features;
      }
      // A vertical step: one column, every interior row, 61 unit steps.
      var v = edgeOf(function (c) { return c < 32 ? 0.2 : 0.8; });
      if (!v.longestEdge || Math.abs(v.longestEdgeDiagonals - 61 / diag) > 1e-9) {
        problems.push("vertical step: " + (v.longestEdge ? v.longestEdgeDiagonals.toFixed(3) : "missing") + " of the diagonal (expected " + (61 / diag).toFixed(3) + ")");
      }
      // A diagonal step, corner to corner: the hard case for direction snapping. About 94% of the diagonal.
      var d = edgeOf(function (c, r) { return c + r < 64 ? 0.2 : 0.8; });
      var wantDiag = 60 * Math.SQRT2 / diag;
      if (!d.longestEdge || Math.abs(d.longestEdgeDiagonals - wantDiag) > 0.04) {
        problems.push("diagonal step: " + (d.longestEdge ? d.longestEdgeDiagonals.toFixed(3) : "missing") + " of the diagonal (expected " + wantDiag.toFixed(3) + ")");
      }
      detail.push("vertical " + v.longestEdgeDiagonals.toFixed(3) + ", diagonal " + (d.longestEdge ? d.longestEdgeDiagonals.toFixed(3) : "-") + " of the diagonal");
      // A one-sample line is a ridge, not an edge: its flanks don't hold their level (the plateau test).
      var line = edgeOf(function (c) { return c === 32 ? 0.9 : 0.2; });
      if (line.longestEdge) problems.push("a one-sample line read as an edge " + line.longestEdge.length + " samples long");
      if (!line.longestRidge || line.longestRidge.length !== 61) problems.push("the same line was not found as a 61-sample ridge");
      // A smooth ramp steps 2/63 per sample: over the follow threshold, under the seed one, so no edge (hysteresis).
      var ramp = edgeOf(function (c) { return c / (W - 1); });
      if (ramp.longestEdge) problems.push("a smooth ramp read as an edge");
      // A step fading from 0.6 to 0.04 (under the seed, over the follow threshold): one edge the full
      // height, followed through the faint rows, which is what the second threshold is for.
      var fading = edgeOf(function (c, r) { return c < 32 ? 0.2 : 0.2 + 0.6 * (1 - (r / (H - 1)) * (14 / 15)); });
      if (!fading.longestEdge || fading.longestEdge.length !== 61) {
        problems.push("a fading edge came out " + (fading.longestEdge ? fading.longestEdge.length : 0) + " samples (expected 61)");
      }
      // Speckle: steps everywhere; the direction test keeps them from chaining.
      var worst = 0;
      [3, 5].forEach(function (seed) {
        var rnd = mulberry32(seed), N = 128;
        var ng = edgeOf(function () { return rnd(); }, N, N);
        worst = Math.max(worst, ng.longestEdgeDiagonals);
        if (ng.longestEdgeDiagonals > 0.15) problems.push("noise (seed " + seed + ") edge " + ng.longestEdgeDiagonals.toFixed(3) + " of the diagonal");
      });
      detail.push("longest edge in noise " + worst.toFixed(3) + " of the diagonal");
      return { pass: problems.length === 0, detail: problems.length ? problems.join("; ") : detail.join(", ") };
    }
  );

  addTest(
    "Contours and catchments each find the picture they were built for",
    "Topography's remaining rows: exact level sets (closed and open, median, return level) and the watershed",
    function () {
      var W = 64, H = 64, diag = Math.sqrt(W * W + H * H), problems = [], detail = [];
      function feat(fn, opts) {
        var spec = { width: W, height: H, t: statsField(W, H, fn).t, circular: false, groups: { features: true } };
        if (opts) for (var k in opts) spec[k] = opts[k];
        return runStatsJob(spec).groups.features;
      }
      // A round bump on a flat floor: every contour is a loop, and the 0.7 return level is a circle of
      // radius sqrt(200 ln 2) = 11.8 samples, about 74 round.
      var bump = feat(function (c, r) { return 0.5 + 0.4 * Math.exp(-((c - 32) * (c - 32) + (r - 32) * (r - 32)) / 200); }, { returnT: 0.7 });
      if (bump.longestOpenContour) problems.push("bump: an open contour " + bump.longestOpenContour.length.toFixed(1) + " long on a picture with none");
      if (!bump.returnContour || Math.abs(bump.returnContour.length - 2 * Math.PI * Math.sqrt(200 * Math.LN2)) > 3) {
        problems.push("bump: return line " + (bump.returnContour ? bump.returnContour.length.toFixed(1) : "missing") + " (expected " + (2 * Math.PI * Math.sqrt(200 * Math.LN2)).toFixed(1) + ")");
      }
      if (bump.returnContour && bump.returnContour.path && bump.returnContour.path.length < 40) problems.push("bump: return line path has only " + bump.returnContour.path.length / 2 + " points");
      detail.push("bump return line " + (bump.returnContour ? bump.returnContour.length.toFixed(1) : "-") + " samples round");
      // The same bump with a NaN column cut through it: every ring is severed, so the longest open contour
      // is a ring walked from one side of the cut round to the other (a contour ending at a hole is open).
      var cut = feat(function (c, r) { return c === 40 ? NaN : 0.5 + 0.4 * Math.exp(-((c - 32) * (c - 32) + (r - 32) * (r - 32)) / 200); });
      if (!cut.longestOpenContour || !cut.longestOpenContour.path) problems.push("cut bump: no open contour");
      else {
        var cp = cut.longestOpenContour.path;
        var endsAtCut = Math.abs(cp[0] - 40) <= 1.5 && Math.abs(cp[cp.length - 2] - 40) <= 1.5;
        if (!endsAtCut) problems.push("cut bump: the open contour runs from x=" + cp[0].toFixed(1) + " to x=" + cp[cp.length - 2].toFixed(1) + " (expected both ends at the cut, x=40)");
        // The outer ring (radius 30.4) keeps the 211 degrees left of the cut: about 112 samples.
        if (Math.abs(cut.longestOpenContour.length - 112) > 8) problems.push("cut bump: the open contour is " + cut.longestOpenContour.length.toFixed(0) + " long (expected about 112)");
      }
      detail.push("cut bump open contour " + (cut.longestOpenContour ? cut.longestOpenContour.length.toFixed(0) : "-") + " long");
      // A ramp: every contour is a straight column, 63 samples, none a loop; the median contour is the middle column.
      var ramp = feat(function (c) { return c / (W - 1); });
      if (!ramp.longestOpenContour || Math.abs(ramp.longestOpenContour.length - (H - 1)) > 1e-6) {
        problems.push("ramp: open contour " + (ramp.longestOpenContour ? ramp.longestOpenContour.length.toFixed(3) : "missing") + " (expected " + (H - 1) + ")");
      }
      if (!ramp.medianContour || Math.abs(ramp.medianContour.length - (H - 1)) > 1e-6 || Math.abs(ramp.medianContour.level - 0.5) > 0.01) {
        problems.push("ramp: median contour " + (ramp.medianContour ? ramp.medianContour.length.toFixed(3) + " at " + ramp.medianContour.level.toFixed(3) : "missing"));
      }
      if (ramp.returnContour !== undefined) problems.push("ramp: a return line with no return level given");
      // A thin ridge ending inside the block: every contour round it is a closed hairpin, so no open
      // contour, and the 0.5 return level is one such hairpin.
      var S = 256;
      function pow8(x) { x = x * x; x = x * x; return x * x; }
      var spike = runStatsJob({ width: S, height: S, circular: false, groups: { features: true }, returnT: 0.5,
        t: statsField(S, S, function (c, r) {
          return 0.2 + 0.7 * Math.exp(-pow8((c - 128) / 1.2)) * Math.exp(-pow8((r - 128) / 80));
        }).t }).groups.features;
      if (spike.longestOpenContour) problems.push("spike: an open contour on a picture whose contours all close");
      if (!spike.returnContour || !spike.returnContour.closed) problems.push("spike: the return line " + (spike.returnContour ? "is not the closed hairpin" : "is missing"));
      detail.push("spike return hairpin " + (spike.returnContour ? spike.returnContour.length.toFixed(0) : "-") + " long");
      // Two wells: exactly two catchments, divided along the middle column.
      var wells = feat(function (c, r) {
        var d1 = (c - 16) * (c - 16) + (r - 32) * (r - 32), d2 = (c - 48) * (c - 48) + (r - 32) * (r - 32);
        return 1 - 0.4 * Math.exp(-d1 / 400) - 0.4 * Math.exp(-d2 / 400);
      });
      if (!wells.watershed || wells.watershed.basins !== 2) problems.push("wells: " + (wells.watershed ? wells.watershed.basins : "no") + " catchments (expected 2)");
      if (wells.watershed && wells.watershed.mask) {
        var onMiddle = 0, elsewhere = 0;
        for (var r2 = 0; r2 < H; r2++) for (var c2 = 0; c2 < W; c2++) {
          if (!wells.watershed.mask[r2 * W + c2]) continue;
          if (Math.abs(c2 - 31.5) <= 1.5) onMiddle++; else elsewhere++;
        }
        if (onMiddle < H - 2 || elsewhere > 0) problems.push("wells: divides " + onMiddle + " on the middle column, " + elsewhere + " elsewhere");
      }
      detail.push("wells " + (wells.watershed ? wells.watershed.basins : "-") + " basins");
      // A wrapping Output gets no median contour and no catchments.
      var wrapped = runStatsJob({ width: W, height: H, t: statsField(W, H, function (c) { return c / (W - 1); }).t, circular: true, groups: { features: true } }).groups.features;
      if (wrapped.medianContour !== undefined || wrapped.watershed) problems.push("a wrapping Output reported a median contour or catchments");
      return { pass: problems.length === 0, detail: problems.length ? problems.join("; ") : detail.join(", ") };
    }
  );

    // ---- Grid playback: a pixel's simulation survives a trip through its state textures ----
    // Playback keeps each pixel's state in RGBA32F layers between draws (playbackStateVariables). A lossy
    // round trip and a dropped state variable look the same from here, so: run a strip straight through,
    // run it again in `legs` (each resuming from the save before it), compare every float bit for bit.
    // One program for both runs (two may round differently); layersPerGroup below MAX_DRAW_BUFFERS forces
    // the state across several draws, the path a big scene takes.
  function runPlaybackStateLegs(scene, precision, legs, layersPerGroup, width) {
    var B = PhysicsGridCodegen.backendFor(precision);
    var initial = PhysicsGridCodegen.generateGridInitialStateGLSL(scene, precision);
    var frame = PhysicsEngine.wrapsAtEdges(scene) ? { width: scene.frameWidth, height: scene.frameHeight } : undefined;
    var vars = PhysicsGridCodegen.playbackStateVariables(initial);
    var layers = PhysicsGridCodegen.playbackStateLayerCount(vars);
    var groups = Math.ceil(layers / layersPerGroup);
    var indent = function (lines) { return lines.map(function (l) { return "    " + l; }).join("\n"); };
    var src = [
      "#version 300 es", "precision highp float;",
      "uniform highp sampler2DArray u_state;",
      "uniform bool u_init;", "uniform int u_steps;", "uniform int u_group;",
      PhysicsGridCodegen.generatePlaybackStateOutputsGLSL(layersPerGroup).join("\n"), "",
      PhysicsGPU.libraryGLSL(precision, PhysicsEngine.speedCapFor(scene)), "",
      PhysicsGPU.generateStepOnceGLSL(initial.n, initial.consts, initial.pairs, initial.hingeAnchors, frame, precision,
        scene.mutualGravity, PhysicsEngine.collisionsEnabled(scene), initial.spawnBase), "",
      "void main() {",
      // A different start per texel, so state crossing between texels shows up too.
      "  " + B.scalar + " worldX = " + B.fromFloat("(gl_FragCoord.x - 0.5) * 7.0") + ";",
      "  " + B.scalar + " worldY = " + B.fromFloat("3.0") + ";",
      "  " + initial.declarationLines.join("\n  "),
      "  " + PhysicsGridCodegen.generateCanonicalBodyDeclarationsGLSL(initial).split("\n").join("\n  "),
      "  " + PhysicsGPU.generateHingeAnchorLocalsGLSL(initial.hingeAnchors, precision).split("\n").join("\n  "),
      "  if (!u_init) {",
      indent(PhysicsGridCodegen.generatePlaybackStateLoadGLSL(vars, "u_state", "ivec2(gl_FragCoord.xy)")),
      "  }",
      "  for (int i = 0; i < u_steps; i++) { stepOnce(" +
        PhysicsGPU.stepOnceCallArgs(initial.n, initial.hingeAnchors, precision, initial.spawnBase) + "); }",
      indent(PhysicsGridCodegen.generatePlaybackStateStoreGLSL(vars, "u_group", layersPerGroup)),
      "}",
    ].join("\n");

    var canvas = new OffscreenCanvas(width, 1);
    var gl = canvas.getContext("webgl2");
    if (!gl.getExtension("EXT_color_buffer_float")) throw new Error("EXT_color_buffer_float unavailable");
    var program = PhysicsGPU.linkProgram(gl,
      PhysicsGPU.compileShader(gl, gl.VERTEX_SHADER, PhysicsGPU.VERTEX_SOURCE),
      PhysicsGPU.compileShader(gl, gl.FRAGMENT_SHADER, src));
    gl.useProgram(program);
    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    var posLoc = gl.getAttribLocation(program, "a_position");
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
    var textures = [0, 1].map(function () {
      var t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA32F, width, 1, layers);
      // A float texture isn't filterable: a filtering sampler reads back all zeros, even via texelFetch.
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      return t;
    });
    var fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, width, 1);
    gl.uniform1i(gl.getUniformLocation(program, "u_state"), 0);
    var current = 0;
    legs.forEach(function (steps, legIndex) {
      var target = textures[1 - current];
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, textures[current]);
      gl.uniform1i(gl.getUniformLocation(program, "u_init"), legIndex === 0 ? 1 : 0);
      gl.uniform1i(gl.getUniformLocation(program, "u_steps"), steps);
      for (var g = 0; g < groups; g++) {
        var attachments = [];
        for (var k = 0; k < layersPerGroup; k++) {
          var layer = g * layersPerGroup + k;
          if (layer < layers) {
            gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + k, target, 0, layer);
            attachments.push(gl.COLOR_ATTACHMENT0 + k);
          } else {
            gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + k, null, 0, 0);
          }
        }
        gl.drawBuffers(attachments);
        var status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
        if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error("state framebuffer incomplete (" + status + ")");
        gl.uniform1i(gl.getUniformLocation(program, "u_group"), g);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
      current = 1 - current;
    });

    for (var d = 1; d < layersPerGroup; d++) gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + d, null, 0, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    var state = new Float32Array(width * layers * 4);
    for (var l = 0; l < layers; l++) {
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, textures[current], 0, l);
      gl.readPixels(0, 0, width, 1, gl.RGBA, gl.FLOAT, state.subarray(l * width * 4, (l + 1) * width * 4));
    }
    var loseCtx = gl.getExtension("WEBGL_lose_context");
    if (loseCtx) loseCtx.loseContext();
    return { state: state, layers: layers, groups: groups, floats: vars.length };
  }

    // Compared as raw bits, so -0.0 vs 0.0 or two different NaNs count as mismatches.
  function comparePlaybackLegs(scene, precision, straight, legs, layersPerGroup) {
    var WIDTH = 6;
    var a = runPlaybackStateLegs(scene, precision, [straight], layersPerGroup, WIDTH);
    var b = runPlaybackStateLegs(scene, precision, legs, layersPerGroup, WIDTH);
    var bitsA = new Uint32Array(a.state.buffer), bitsB = new Uint32Array(b.state.buffer);
    var mismatches = 0, first = null, moved = 0;
    var start = runPlaybackStateLegs(scene, precision, [0], layersPerGroup, WIDTH);
    var bitsStart = new Uint32Array(start.state.buffer);
    for (var i = 0; i < bitsA.length; i++) {
      if (bitsA[i] !== bitsB[i]) {
        mismatches++;
        if (!first) first = "layer " + Math.floor(i / (WIDTH * 4)) + ", texel " + (Math.floor(i / 4) % WIDTH) + ": " + a.state[i] + " vs " + b.state[i];
      }
      if (bitsA[i] !== bitsStart[i]) moved++;
    }
    return {
      // `moved` guards against passing vacuously on a scene that never left its start.
      pass: mismatches === 0 && moved > 0,
      detail: a.layers + " layers in " + a.groups + " draw(s); " + straight + " steps straight vs legs " + legs.join("+") +
        ": " + mismatches + " of " + bitsA.length + " floats differ" + (first ? " (first: " + first + ")" : "") +
        "; " + moved + " floats changed from the starting state",
    };
  }

  addTest(
    "Grid playback: a hinged pendulum's state survives being saved and reloaded between steps",
    "Playback carries each pixel's simulation in float textures between frames - a lossy round trip or a missing state variable (here: the world hinge's own anchor) would drift from an uninterrupted run",
    function () {
      var scene = {
        bodies: [PhysicsEngine.createLine(600, 300, 160, 0, false), PhysicsEngine.createLine(760, 300, 160, 0, false)],
        hinges: [
          { bodyA: null, bodyB: 0, localAnchorA: { x: 520, y: 300 }, localAnchorB: { x: -80, y: 0 } },
          { bodyA: 0, bodyB: 1, localAnchorA: { x: 80, y: 0 }, localAnchorB: { x: -80, y: 0 } },
        ],
        xInput: { body: 0, property: "angle" },
        yInput: { body: 1, property: "angle" },
        output: { body: 1, property: "angle" },
        frameWidth: 1192, frameHeight: 819, edgeMode: "wrap",
      };
      return comparePlaybackLegs(scene, "f32", 120, [1, 37, 50, 32], 8);
    }
  );

  addTest(
    "Grid playback: pinball's state round trip is exact in both precisions, written across several draws",
    "Anchored walls are deliberately NOT carried in the state (stepOnce never writes them), if that ever stops being true, this is where it shows",
    function () {
      var scene = buildDeepZoomScene();
      scene.edgeMode = "wrap";
      var f32 = comparePlaybackLegs(scene, "f32", 150, [60, 1, 89], 1);
      var df = comparePlaybackLegs(scene, "df", 150, [75, 75], 2);
      return { pass: f32.pass && df.pass, detail: "float32: " + f32.detail + " | double-float: " + df.detail };
    }
  );

  addTest(
    "Grid playback: a splitter scene's spawn slots survive the round trip",
    "A split rewrites a spawn slot's size, mass, alive flag and lineage mid-run, and liveCount decides which slot the next split takes: all of it has to be state",
    function () {
      var scene = buildSplitterScene(385);
      scene.xInput = { body: 1, property: "x" };
      scene.output = { body: 1, property: "x" };
      return comparePlaybackLegs(scene, "f32", 90, [20, 20, 50], 8);
    }
  );

  addTest(
    "Grid playback: mutual gravity's state round trip is exact",
    "Mutual Gravity's pull is recomputed from the positions every step: stateless by design, so nothing beyond the six accumulators should need carrying",
    function () {
      var scene = {
        mutualGravity: true,
        bodies: [
          PhysicsEngine.createCircle(500, 400, 40, false),
          PhysicsEngine.createCircle(700, 400, 20, false),
          PhysicsEngine.createCircle(600, 250, 10, false),
        ],
        hinges: [],
        xInput: { body: 2, property: "x" },
        yInput: { body: 2, property: "y" },
        output: { body: 2, property: "y" },
        frameWidth: 1192, frameHeight: 809, edgeMode: "infinite",
      };
      scene.bodies[1].vy = 180;
      scene.bodies[2].vx = -120;
      return comparePlaybackLegs(scene, "f32", 200, [99, 101], 8);
    }
  );

    // ---- Shared links (share-url.js): a link must say exactly what it was written from, and
    // survive arriving damaged ----

  // Key order is the writer's business, not part of what a scene says.
  function canonicalJSON(value) {
    return JSON.stringify(value, function (key, v) {
      if (!v || typeof v !== "object" || Array.isArray(v)) return v;
      var sorted = {};
      Object.keys(v).sort().forEach(function (k) { sorted[k] = v[k]; });
      return sorted;
    });
  }

    // One of everything a scene can hold: all four shapes, anchors, velocities, both hinge kinds,
    // both spring kinds, a pair Output, and every setting off its default.
  function everythingScene() {
    return {
      mutualGravity: true, collisionsEnabled: false, simulationSteps: 2300,
      bodies: [
        { type: "circle", x: -132.1042, y: 321.4385, angle: 0.0021, isAnchored: false, radius: 30, vx: 0, vy: 0, w: 0 },
        { type: "line", x: -334, y: -173.5, angle: -0.7679, isAnchored: true, length: 479, vx: 0, vy: 0, w: 0 },
        { type: "funnel", x: 260.5, y: -160.5, angle: 0.6632, isAnchored: true, size: 120, vx: 0, vy: 0, w: 0 },
        { type: "splitter", x: 0, y: 0, angle: 3.1416, isAnchored: false, size: 95.5, vx: 12.5, vy: 0, w: 0 },
        { type: "circle", x: 410.0625, y: 288.125, angle: 0, isAnchored: false, radius: 18.5, vx: 0, vy: 44, w: -0.12 },
      ],
      hinges: [
        { bodyA: null, bodyB: 0, localAnchorA: { x: -188, y: 51.5 }, localAnchorB: { x: -70, y: 1 } },
        { bodyA: 0, bodyB: 4, localAnchorA: { x: 70, y: 0 }, localAnchorB: { x: -71.25, y: 1 } },
      ],
      springs: [
        { bodyA: null, bodyB: 3, localAnchorA: { x: 40.5, y: 220 }, localAnchorB: { x: 0, y: 0 }, stiffness: 112000, restLength: 187.25 },
        { bodyA: 3, bodyB: 4, localAnchorA: { x: -12, y: 8.5 }, localAnchorB: { x: 0, y: -18.5 }, stiffness: 2530, restLength: 0 },
      ],
      xInput: { body: 0, property: "vx" }, yInput: { body: 4, property: "radius" },
      output: { body: 0, bodyB: 4, property: "distance" },
      frameWidth: 1192, frameHeight: 809, edgeMode: "infinite", maxSimulationBodies: 7,
    };
  }

  addTest(
    "A shared link says exactly the scene it was written from, and says it again unchanged",
    "share-url.js: the scene is the address bar now, so anything the link drops or rounds differently from serializeScene is a scene that silently changes when it is shared. Re-encoding what was decoded must give the same text, or the address would rewrite itself under a page that had only just loaded it",
    function () {
      var scene = everythingScene();
      var fragment = ShareUrl.encode({ page: "bldr", scene: scene });
      var back = ShareUrl.decode("#" + fragment);
      var same = canonicalJSON(back.scene) === canonicalJSON(scene);
      var stable = ShareUrl.encode({ page: "bldr", scene: back.scene }) === fragment;
      // Scene Lifespan belongs to no body: the one mapping with a shape of its own.
      var lifespan = everythingScene();
      lifespan.output = { body: null, bodyB: null, property: "lifespan" };
      var lifespanBack = ShareUrl.decode(ShareUrl.encode({ page: "bldr", scene: lifespan })).scene.output;
      return {
        pass: same && stable && back.page === "bldr" && back.view === null && canonicalJSON(lifespanBack) === canonicalJSON(lifespan.output),
        detail: (same ? "round trip exact" : "ROUND TRIP DIFFERS: " + canonicalJSON(back.scene)) + "; re-encodes identically=" + stable +
          "; " + (fragment.length + 1) + " characters: #" + fragment,
      };
    }
  );

  addTest(
    "An absent field means the FORMAT's default, not whatever the editor starts a scene with today",
    "share-url.js's wire defaults: a field at its default is left out of a link, so what 'left out' means is fixed by every link already shared. decode() fills each one in explicitly so that nothing downstream can substitute a newer default of its own",
    function () {
      var decoded = ShareUrl.decode("#bldr/body:ci:0:0:0:30,frmw:900,frmh:600").scene;
      var want = { mutualGravity: false, collisionsEnabled: true, simulationSteps: 1000, edgeMode: "sticky", maxSimulationBodies: 20 };
      var wrong = Object.keys(want).filter(function (k) { return decoded[k] !== want[k]; });
      var body = decoded.bodies[0];
      var restOk = body.vx === 0 && body.vy === 0 && body.w === 0 && body.isAnchored === false &&
        decoded.hinges.length === 0 && decoded.springs.length === 0 && decoded.xInput === null && decoded.yInput === null && decoded.output === null;
      return {
        pass: wrong.length === 0 && restOk,
        detail: wrong.length ? "wrong defaults for: " + wrong.join(", ") : "all five settings, the three velocities, anchoring and the mappings come back explicit",
      };
    }
  );

  addTest(
    "A link's view center keeps every digit the zoom can use, from 1x to 1e26x",
    "share-url.js's formatDD/parseDD - the map holds its center as a double-double because one float64 cannot tell neighbouring pixels apart past ~1e13x, and a link that carried only the float64 would reopen a deep view somewhere else entirely. The center travels as one decimal with zoom-dependent places; this checks it lands within a millionth of a pixel at every depth, by exact integer arithmetic rather than by the floating point under test",
    function () {
      if (typeof BigInt !== "function") return { pass: true, detail: "no BigInt in this browser: centers keep float64 precision, which is as deep as it can render" };
      function exact(x) { // x === m * 2^e
        var view = new DataView(new ArrayBuffer(8));
        view.setFloat64(0, x);
        var top = view.getUint32(0), low = view.getUint32(4), ex = (top >>> 20) & 0x7FF;
        var m = BigInt(top & 0xFFFFF) * BigInt(4294967296) + BigInt(low);
        if (ex) m += BigInt(4503599627370496);
        return { m: (top >>> 31) ? -m : m, e: ex ? ex - 1075 : -1074 };
      }
      function ddDistance(a, b) { // |(a0 + a1) - (b0 + b1)|, exactly, then as a float
        var parts = [exact(a[0]), exact(a[1]), exact(-b[0]), exact(-b[1])];
        var e = Math.min.apply(null, parts.map(function (p) { return p.e; }));
        var sum = BigInt(0);
        parts.forEach(function (p) { sum += p.m << BigInt(p.e - e); });
        if (sum < BigInt(0)) sum = -sum;
        return Number(sum) * Math.pow(2, e);
      }
      var seed = 20260920;
      function random() { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }
      var worst = 0, worstAt = "", unstable = 0;
      for (var i = 0; i < 1500; i++) {
        var hi = (random() - 0.5) * Math.pow(10, Math.floor(random() * 5));
        var sum = PhysicsDF.twoSum64(hi, (random() - 0.5) * Math.abs(hi) * Math.pow(2, -52));
        var scale = (200 / 0.17) / Math.pow(10, random() * 26);
        var places = ShareUrl.centerDecimals(scale);
        var text = ShareUrl.formatDD(sum[0], sum[1], places);
        var back = ShareUrl.parseDD(text, "center");
        var viewHeights = ddDistance(sum, back) / scale;
        if (viewHeights > worst) { worst = viewHeights; worstAt = text + " at " + ((200 / 0.17) / scale).toExponential(1) + "x"; }
        if (ShareUrl.formatDD(back[0], back[1], places) !== text) unstable++;
      }
      // A millionth of a pixel on a thousand-pixel-high view.
      return {
        pass: worst <= 1e-9 && unstable === 0 && ShareUrl.centerDecimals((200 / 0.17) / 1e26) === 32,
        detail: "worst of 1500 random centers and zooms: " + worst.toExponential(2) + " view heights (" + worstAt +
          "); " + unstable + " re-encoded differently; " + ShareUrl.centerDecimals((200 / 0.17) / 1e26) + " decimal places at the deepest zoom",
      };
    }
  );

  addTest(
    "A map link carries its view, and nothing at all for a view left at its defaults",
    "share-url.js's view fields: zoom, display mode (Color Zoom counted as one), Low Saturation, precision, speed, volume and the three kinds of inspection, each written only when it differs from its default so an untouched map's link is just its scene",
    function () {
      var scene = everythingScene();
      var center = PhysicsDF.twoSum64(213.41826094537, 3.1e-15);
      var view = {
        center: { x: center[0], xLo: center[1], y: -88.0421795513, yLo: 0 }, scale: 1e-5, zoom: (200 / 0.17) / 1e-5,
        display: "colorzoom", lowSaturation: true, precision: "tf", speed: 4, volume: 0.35,
        inspect: [
          { type: "point", a: [0.0115, -0.0075] },
          { type: "line", a: [-0.2875, -0.1018], b: [0.2973, 0.143], count: 45 },
          { type: "grid", a: [-0.3691, -0.1426], b: [0.3925, 0.2246], size: 5, twoPart: true },
          { type: "grid", a: [0.1, 0.1], b: [0.2, 0.2], size: 2, twoPart: false },
        ],
      };
      var fragment = ShareUrl.encode({ page: "map", scene: scene, view: view });
      var back = ShareUrl.decode(fragment).view;
      var viewOk = back.display === "colorzoom" && back.lowSaturation === true && back.precision === "tf" && back.speed === 4 && back.volume === 0.35 &&
        Math.abs(back.zoom / view.zoom - 1) < 1e-9 && back.center.y === view.center.y &&
        Math.abs((back.center.x - view.center.x) + (back.center.xLo - view.center.xLo)) < 1e-14 &&
        canonicalJSON(back.inspect) === canonicalJSON(view.inspect);
      var untouched = ShareUrl.encode({
        page: "map", scene: scene,
        view: { center: { x: 0, xLo: 0, y: 0, yLo: 0 }, scale: 200 / 0.17, zoom: 1, display: "standard", lowSaturation: false, precision: "f32", speed: 1, volume: 1, inspect: [] },
      });
      var bare = untouched === "map/" + ShareUrl.encodeScene(scene).join(",");
      return {
        pass: viewOk && bare,
        detail: "view round trip " + (viewOk ? "exact" : "DIFFERS: " + canonicalJSON(back)) + "; untouched view adds nothing=" + bare +
          "; view fields: " + fragment.slice(fragment.indexOf("frmh:") + 9),
      };
    }
  );

  addTest(
    "Links survive how they actually arrive, and the ones that can't be read say why",
    "share-url.js's decode - chat apps drop a trailing '!' or ',' from the link they detect (so no link may end in one: the frame size follows the bodies for exactly this reason), some software percent-encodes the punctuation, and a link lifted out of a sentence brings the sentence's own full stop. A scene that can't be read must throw something showable rather than load as something else; a view field that can't be read is dropped, since the right map framed slightly wrong beats no map",
    function () {
      var scene = everythingScene();
      scene.bodies = [scene.bodies[1]]; // one anchored line: its "!" is the last character of the body list
      scene.hinges = []; scene.xInput = scene.yInput = scene.output = null;
      var fragment = ShareUrl.encode({ page: "bldr", scene: scene });
      var want = canonicalJSON(ShareUrl.decode(fragment));
      var endsClean = /[A-Za-z0-9]$/.test(fragment);
      var survives = [encodeURIComponent(fragment).replace(/%2F/g, "/"), fragment + ".", fragment + ").", fragment + ",futr:1:2:3"]
        .filter(function (mangled) { return canonicalJSON(ShareUrl.decode("#" + mangled)) !== want; });
      var ignored = ["", "#", "#editor", "#grid-view", "#maps/body:ci:0:0:0:30"].filter(function (other) { return ShareUrl.decode(other) !== null; });
      var unreadable = ["#bldr/body:zz:1:2:3:4", "#bldr/body:ci:1:2:3", "#bldr/body:ci:1:2:3:0", "#bldr/body:ci:1:0x10:3:4",
        "#bldr/body:ci:1:2:3:4,hnge:0:1:2", "#bldr/body:ci:1:2:3:4,outp:0.nope", "#bldr/body:ci:1:2:3:4,edge:nope", "#bldr/body:ci:1:2:3:4,coll:yes"];
      var accepted = unreadable.filter(function (bad) {
        try { ShareUrl.decode(bad); return true; } catch (err) { return !err.message; }
      });
      var lenient = ShareUrl.decode("#map/body:ci:1:2:3:4,zoom:banana,ctrx:12.5,disp:nope,insp:q:1:2").view;
      var lenientOk = lenient.zoom === 1 && lenient.center.x === 12.5 && lenient.display === "standard" && lenient.inspect.length === 0;
      return {
        pass: endsClean && survives.length === 0 && ignored.length === 0 && accepted.length === 0 && lenientOk,
        detail: "ends in a letter or digit=" + endsClean + "; mangled forms misread: " + (survives.length || "none") +
          "; other sites' anchors mistaken for links: " + (ignored.length || "none") + "; unreadable scenes accepted: " +
          (accepted.length ? accepted.join(" ") : "none of " + unreadable.length) + "; bad view fields dropped without losing the rest=" + lenientOk,
      };
    }
  );

  // ---- Movies (movie-path.js, and their fields in share-url.js) ----

  function movieKeyframe(x, y, scale, step, seconds) {
    return { center: { x: x, xLo: 0, y: y, yLo: 0 }, scale: scale, step: step || 0, seconds: seconds === undefined ? null : seconds };
  }
  function viewDistance(p, q) {
    return Math.hypot((p.x - q.x) + (p.xLo - q.xLo), (p.y - q.y) + (p.yLo - q.yLo));
  }

  addTest(
    "A movie's camera lands exactly on every keyframe, however far it pans while it zooms",
    "movie-path.js's path(): the textbook form of van Wijk & Nuij's zoom-and-pan path gives the position as a FRACTION of the whole pan, good to one part in 1e16, and subtracts two numbers that grow with the zoom ratio to get it. Both are harmless across a UI transition's 10x and ruinous across this map's 1e12x: on the move below the textbook form ends thousands of views from its keyframe. Each half of the path is measured from its own end instead, so both ends are exact and the halves have to meet in the middle",
    function () {
      var cases = [
        ["gentle", movieKeyframe(0, 0, 1000), movieKeyframe(900, -400, 300)],
        ["pure pan", movieKeyframe(0, 0, 500), movieKeyframe(800, 0, 500)],
        ["pure zoom 1e20", movieKeyframe(12.5, -3, 1000), movieKeyframe(12.5, -3, 1e-17)],
        ["pan 1000 views while zooming in 1e12", movieKeyframe(0, 0, 1), movieKeyframe(1000, 250, 1e-12)],
        ["zoom out 1e15 and pan", movieKeyframe(3.3333, 1.25, 1e-15), movieKeyframe(-40, 9, 1)],
      ];
      var worstEnd = 0, worstSeam = 0, worstHop = 0, bad = [];
      cases.forEach(function (c) {
        var from = c[1], to = c[2], route = MoviePath.path(from, to);
        var start = route.at(0), end = route.at(1);
        var endError = Math.max(viewDistance(start.center, from.center) / from.scale, viewDistance(end.center, to.center) / to.scale,
          Math.abs(start.scale / from.scale - 1), Math.abs(end.scale / to.scale - 1));
        var before = route.at(0.5 - 1e-12), after = route.at(0.5);
        var seam = Math.max(viewDistance(before.center, after.center) / after.scale, Math.abs(before.scale / after.scale - 1));
        var previous = start, hop = 0, finite = true;
        for (var k = 1; k <= 400; k++) {
          var v = route.at(k / 400);
          if (!(v.scale > 0) || !isFinite(v.center.x + v.center.y)) finite = false;
          hop = Math.max(hop, viewDistance(v.center, previous.center) / Math.max(v.scale, previous.scale));
          previous = v;
        }
        worstEnd = Math.max(worstEnd, endError); worstSeam = Math.max(worstSeam, seam); worstHop = Math.max(worstHop, hop);
        if (endError > 1e-9 || seam > 1e-6 || hop > 0.1 || !finite || !(route.length > 0)) bad.push(c[0]);
      });
      // Far apart, the path pulls back until both ends are in view.
      var far = MoviePath.path(movieKeyframe(0, 0, 10), movieKeyframe(5000, 0, 10)), peak = 0;
      for (var j = 0; j <= 100; j++) peak = Math.max(peak, far.at(j / 100).scale);
      return {
        pass: bad.length === 0 && peak > 1000,
        detail: (bad.length ? "FAILED: " + bad.join(", ") + "; " : "") + "across " + cases.length + " moves: worst miss at a keyframe " +
          worstEnd.toExponential(1) + " views, worst gap where the halves meet " + worstSeam.toExponential(1) +
          " views, biggest hop in 1/400 of a move " + worstHop.toFixed(3) + " views; a 500-view pan pulls back from scale 10 to " + peak.toFixed(0),
      };
    }
  );

  addTest(
    "A movie's frames: counted from its seconds, eased, looped without a jump, and the simulation rewinds as well as advances",
    "movie-path.js's frames() - a keyframe holds the Map Evolution frame as well as the view, so a move can run the physics backwards; a movie starts and ends at rest (and a keyframe with a hold beside it is at rest) so the camera never starts or stops with a jerk; and 'Return to First Keyframe' closes the movie with one more move so that played on a loop its last frame leads into its first",
    function () {
      var keys = [movieKeyframe(0, 0, 1000, 0), movieKeyframe(100, 50, 100, 500, 2), movieKeyframe(100, 50, 100, 200, 1)];
      var looped = MoviePath.frames(keys, true), open = MoviePath.frames(keys, false);
      var closing = MoviePath.autoSeconds(keys[2], keys[0]);
      var counts = looped.length === Math.round((2 + 1 + closing) * MoviePath.FPS) && open.length === (2 + 1) * MoviePath.FPS + 1;
      var last = open[open.length - 1];
      var endsOnKeyframe = last.center.x === 100 && last.scale === 100 && last.step === 200;
      var wraps = viewDistance(looped[looped.length - 1].center, looped[0].center) / looped[0].scale < 0.01;
      var rewinds = open[60].step === 500 && open[75].step < 500 && open[75].step > 200 &&
        open.every(function (f) { return f.step === Math.round(f.step); });
      var ease = MoviePath.ease, monotonic = true;
      for (var m = 1; m <= 1000; m++) if (ease(m / 1000) < ease((m - 1) / 1000)) monotonic = false;
      var eased = monotonic && ease(0) === 0 && ease(1) === 1 && ease(1e-3) < 1e-8 && 1 - ease(1 - 1e-3) < 1e-8;
      var smooth = 0;
      for (var n = 1; n < looped.length; n++) {
        smooth = Math.max(smooth, viewDistance(looped[n].center, looped[n - 1].center) / Math.min(looped[n].scale, looped[n - 1].scale));
      }
      var degenerate = MoviePath.frames([keys[0]], true).length === 1 && MoviePath.frames([], true).length === 0;
      return {
        pass: counts && endsOnKeyframe && wraps && rewinds && eased && smooth < 0.25 && degenerate,
        detail: looped.length + " frames looped (closing move worked out at " + closing + "s), " + open.length + " open; ends on its last keyframe=" +
          endsOnKeyframe + "; last frame leads into the first=" + wraps + "; simulation frame at the 2nd keyframe " + open[60].step +
          " then mid-rewind " + open[75].step + "; ease flat at both ends=" + eased + "; biggest frame-to-frame hop " + smooth.toFixed(3) + " views",
      };
    }
  );

  addTest(
    "A movie passes through a keyframe on its way at full speed, and comes to rest at one it turns round at",
    "movie-path.js's frames() - a movie that stopped dead at every keyframe would make 1x -> 100x -> 10000x a zoom in two lurches. Each keyframe is given the mean of the velocities arriving and leaving, as vectors: on the way somewhere they agree and the camera sails through at speed, and where the camera turns round (in to 1e8x, back out to 1e4x) they cancel and it eases to a halt. The first and last keyframes of a movie that doesn't loop are always at rest",
    function () {
      function zoomKeyframe(zoom) { return movieKeyframe(0, 0, 1 / zoom, 0); }
      // The zoom's slope, in decades per second, either side of each keyframe.
      function slopes(keys, loop) {
        var frames = MoviePath.frames(keys, loop), moves = MoviePath.moves(keys, loop);
        var z = frames.map(function (f) { return Math.log10(1 / f.scale); });
        var slope = function (i) { return (z[i + 1] - z[i]) * MoviePath.FPS; };
        var at = 0, out = [];
        moves.forEach(function (move) {
          out.push({ before: at > 0 ? slope(at - 1) : 0, after: slope(at) });
          at += Math.round(move.seconds * MoviePath.FPS);
        });
        out.push({ before: slope(z.length - 2), after: 0 });
        return out;
      }
      var through = slopes([zoomKeyframe(1), zoomKeyframe(100), zoomKeyframe(10000)], false);
      var turn = slopes([zoomKeyframe(1), zoomKeyframe(1e8), zoomKeyframe(1e4)], false);
      var loop = slopes([zoomKeyframe(1), zoomKeyframe(100), zoomKeyframe(10000)], true);
      var rest = function (s) { return Math.abs(s) < 0.01; };
      var sails = through[1].before > 0.3 && Math.abs(through[1].after - through[1].before) < 0.01;
      var endsAtRest = rest(through[0].after) && rest(through[2].before) && rest(turn[0].after) && rest(turn[2].before);
      var halts = rest(turn[1].before) && rest(turn[1].after);
      // Looped, the first keyframe is a turnaround too (out to 10000x, then back in to 1x) and rests; the middle one still sails.
      var loopRests = rest(loop[0].after) && rest(loop[2].before) && rest(loop[2].after) && loop[1].before > 0.3 && Math.abs(loop[1].after - loop[1].before) < 0.01;
      return {
        pass: sails && endsAtRest && halts && loopRests,
        detail: "1x->100x->10000x passes 100x at " + through[1].before.toFixed(2) + " -> " + through[1].after.toFixed(2) + " decades/s (ends " +
          through[0].after.toFixed(3) + ", " + through[2].before.toFixed(3) + "); 1x->1e8x->1e4x turns at 1e8x at " +
          turn[1].before.toFixed(3) + " -> " + turn[1].after.toFixed(3) + "; looped, the first keyframe rests=" + loopRests,
      };
    }
  );

  addTest(
    "A movie's link carries its keyframes, each with the digits its own zoom can use",
    "share-url.js's kfrm/qual/loop - the player renders from its address alone, so the keyframes are the movie, and how the map is drawn (display mode, Low Saturation) rides along with them. A keyframe's center is written to the precision of THAT keyframe's zoom, which is what keeps a movie that dives to 1e8x from costing thirty digits on its wide shots; and a movie link has no view of its own, so none of the map's view fields belong in it",
    function () {
      var deep = PhysicsDF.twoSum64(213.41826094537, 3.1e-15);
      var movie = { quality: 2, loop: false, keyframes: [
        { center: { x: 0, xLo: 0, y: 0, yLo: 0 }, scale: 200 / 0.17, zoom: 1, step: 1000, seconds: null },
        { center: { x: deep[0], xLo: deep[1], y: -88.0421795513, yLo: 0 }, scale: 1e-5, zoom: (200 / 0.17) / 1e-5, step: 500, seconds: 4.26 },
      ] };
      var scene = everythingScene();
      var fragment = ShareUrl.encode({ page: "movi", scene: scene, view: { display: "laplacian", lowSaturation: true, precision: "auto", movie: movie } });
      var back = ShareUrl.decode(fragment);
      var k = back.view.movie.keyframes;
      var keyframesOk = k.length === 2 && k[0].zoom === 1 && k[0].step === 1000 && k[0].seconds === null &&
        k[1].step === 500 && k[1].seconds === 4.3 && Math.abs(k[1].zoom / movie.keyframes[1].zoom - 1) < 1e-9 &&
        Math.abs((k[1].center.x - deep[0]) + (k[1].center.xLo - deep[1])) < 1e-14;
      var settingsOk = back.page === "movi" && back.view.movie.quality === 2 && back.view.movie.loop === false &&
        back.view.display === "laplacian" && back.view.lowSaturation === true && back.view.precision === "auto" && canonicalJSON(back.scene) === canonicalJSON(scene);
      var noViewFields = !/ctrx|ctry|zoom:|insp/.test(fragment);
      // The map's own link keeps the keyframes, and says nothing about movies while there are none.
      var mapView = { center: { x: 0, xLo: 0, y: 0, yLo: 0 }, scale: 200 / 0.17, zoom: 1, movie: movie };
      var mapKeeps = ShareUrl.decode(ShareUrl.encode({ page: "map", scene: scene, view: mapView })).view.movie.keyframes.length === 2;
      mapView.movie = { keyframes: [], quality: 1, loop: false };
      var silent = !/kfrm|qual|loop/.test(ShareUrl.encode({ page: "map", scene: scene, view: mapView }));
      var defaults = ShareUrl.decode("#map/body:ci:0:0:0:30").view.movie;
      return {
        pass: keyframesOk && settingsOk && noViewFields && mapKeeps && silent && defaults.quality === 4 && defaults.loop === true && defaults.keyframes.length === 0,
        detail: "keyframes " + (keyframesOk ? "exact" : "DIFFER: " + JSON.stringify(k)) + "; settings and scene=" + settingsOk +
          "; no map-view fields in a movie link=" + noViewFields + "; a map link keeps them=" + mapKeeps + " and is silent without any=" + silent +
          "; " + fragment.slice(fragment.indexOf("kfrm")),
      };
    }
  );

    // ---- Springs: the engine's only torque source, implemented in the JS engine, float32 GLSL and
    // multi-float GLSL (plus anchor-follows-resize in physics-hinge-geometry.js and physics-grid-codegen.js).
    // Each test holds one copy to another, or the engine to physics. ----

    // Kinetic + spring + uniform-gravity energy. `dt` because the stiffness actually in force can
    // depend on it: see PhysicsEngine.springEffectiveStiffness.
  function springSceneEnergy(scene, dt) {
    var e = PhysicsEngine.springPotentialEnergy(scene, dt);
    scene.bodies.forEach(function (b) {
      if (b.isAnchored) return;
      e += 0.5 * b.mass * (b.vx * b.vx + b.vy * b.vy) + 0.5 * b.inertia * b.w * b.w - b.mass * PhysicsEngine.GRAVITY * b.y;
    });
    return e;
  }

    // Ball on a spring from the background, second ball on a spring from the first, both attached OFF-center.
  function buildSpringChain() {
    var a = PhysicsEngine.createCircle(300, 300, 30, false), b = PhysicsEngine.createCircle(520, 340, 20, false);
    a.vx = 50; b.vy = -80;
    return {
      bodies: [a, b], hinges: [], collisionsEnabled: false, edgeMode: "infinite",
      springs: [
        { bodyA: null, bodyB: 0, localAnchorA: { x: 300, y: 100 }, localAnchorB: { x: -12, y: 0 }, stiffness: 80000, restLength: 150 },
        { bodyA: 0, bodyB: 1, localAnchorA: { x: 10, y: 5 }, localAnchorB: { x: 0, y: -8 }, stiffness: 60000, restLength: 120 },
      ],
    };
  }

  addTest(
    "A spring conserves energy, and its torque is the torque of its force",
    "springs are the engine's only source of angular acceleration: a force and a torque that disagreed (a sign, a lever arm taken from the wrong end) would not crash anything - it would quietly pump energy in, and only an energy audit says so. Semi-implicit Euler makes the total wobble by an amount proportional to the step, so the wobble has to SHRINK with the step; an inconsistent force leaves a drift that does not",
    function () {
      function wobble(sub) {
        var dt = DT / sub, scene = buildSpringChain();
        var e0 = springSceneEnergy(scene, dt), scale = PhysicsEngine.springPotentialEnergy(scene, dt) + 1e7, worst = 0;
        for (var i = 0; i < 1500 * sub; i++) {
          PhysicsEngine.step(scene, dt);
          worst = Math.max(worst, Math.abs(springSceneEnergy(scene, dt) - e0) / scale);
        }
        return { worst: worst, spun: Math.abs(scene.bodies[1].w) > 0 };
      }
      var full = wobble(1), fine = wobble(8);
      return {
        pass: full.worst < 0.12 && fine.worst < full.worst / 4 && full.spun,
        detail: "energy wobble " + (full.worst * 100).toFixed(2) + "% at 1/60s, " + (fine.worst * 100).toFixed(2) + "% at 1/480s (must shrink with the step); the off-center ball was turned=" + full.spun,
      };
    }
  );

  addTest(
    "A two-body spring pushes both ends equally: momentum and angular momentum hold",
    "the force on end B must be exactly the opposite of the force on end A, lever arms included, or a pair of bodies joined by a spring drifts off (or spins up) by itself. Run under Mutual Gravity, whose pull between two free bodies is equal and opposite too: under ordinary gravity the pair free-falls into the speed cap, which rescales the whole velocity vector and so does not conserve anything",
    function () {
      var scene = buildSpringChain();
      scene.springs = [scene.springs[1]]; // just the body-to-body one: nothing acts from outside
      scene.mutualGravity = true;
      function momenta(s) {
        var px = 0, py = 0, L = 0;
        s.bodies.forEach(function (q) {
          px += q.mass * q.vx; py += q.mass * q.vy;
          L += q.mass * (q.x * q.vy - q.y * q.vx) + q.inertia * q.w;
        });
        return { px: px, py: py, L: L };
      }
      var before = momenta(scene), scale = 0;
      scene.bodies.forEach(function (q) { scale += q.mass * Math.hypot(q.vx, q.vy); });
      runJS(scene, 1500);
      var after = momenta(scene);
      var dp = Math.hypot(after.px - before.px, after.py - before.py) / scale;
      var dL = Math.abs(after.L - before.L) / Math.abs(before.L);
      return {
        pass: dp < 1e-9 && dL < 1e-9 && Math.abs(scene.bodies[1].w) > 0,
        detail: "linear momentum changed by " + dp.toExponential(2) + " of the bodies' own, angular momentum by " + dL.toExponential(2) +
          " of itself, over 1500 steps in which the small ball was spun to " + scene.bodies[1].w.toFixed(2) + " rad/s",
      };
    }
  );

    // Hinge + lever-arm background spring + body-to-body spring + a zero-rest-length spring at dead
    // center (the two compile-time special cases: no sqrt, no lever arm).
  function buildSpringLockstepScene() {
    var line = PhysicsEngine.createLine(500, 300, 240, 0, false);
    var ball = PhysicsEngine.createCircle(560, 480, 28, false);
    var top = PhysicsEngine.createCircle(760, 250, 22, false);
    return {
      bodies: [line, ball, top],
      hinges: [{ bodyA: null, bodyB: 0, localAnchorA: { x: 380, y: 300 }, localAnchorB: { x: -120, y: 0 } }],
      springs: [
        { bodyA: null, bodyB: 0, localAnchorA: { x: 640, y: 120 }, localAnchorB: { x: 120, y: 0 }, stiffness: 90000, restLength: 150 },
        { bodyA: 0, bodyB: 1, localAnchorA: { x: 40, y: 0 }, localAnchorB: { x: 0, y: -20 }, stiffness: 120000, restLength: 110 },
        { bodyA: 1, bodyB: 2, localAnchorA: { x: 0, y: 0 }, localAnchorB: { x: 0, y: 0 }, stiffness: 50000, restLength: 0 },
      ],
      frameWidth: 1200, frameHeight: 800, edgeMode: "infinite",
    };
  }

  function worstTrajectoryGap(js, traj, steps, bodyCount) {
    var worst = 0;
    for (var i = 0; i < steps; i++) {
      for (var b = 0; b < bodyCount; b++) {
        worst = Math.max(worst, Math.abs(js[i][b].x - traj[i][b].x), Math.abs(js[i][b].y - traj[i][b].y), Math.abs(js[i][b].angle - traj[i][b].angle) * 50);
      }
    }
    return worst;
  }

  addTest(
    "JS engine and GPU compiler agree on springs (float32 and double-float)",
    "PhysicsEngine.addSpringAccelerations and its GLSL port in generateStepOnceGLSL are a hand-synced pair in each precision - force, torque, the stability limit on the stiffness, and the angular half of both integration legs. The double-float run is the real check: it tracks the float64 engine to a fraction of a thousandth of a pixel for hundreds of steps or it is not the same physics. float32 is held only over a short run, before its own rounding (this scene is chaotic) has had time to grow",
    function () {
      var js = PhysicsEngine.runTrajectory(buildSpringLockstepScene(), 300, DT);
      var f32 = worstTrajectoryGap(js, PhysicsGPU.runSceneOnGPU(buildSpringLockstepScene(), 60), 60, 3);
      var df = worstTrajectoryGap(js, PhysicsGPU.runSceneOnGPU(buildSpringLockstepScene(), 300, "df"), 300, 3);
      return {
        pass: f32 < 0.02 && df < 0.002,
        detail: "worst gap from the JS engine: float32 " + f32.toExponential(2) + "px over 60 steps, double-float " + df.toExponential(2) + "px over 300 (angles weighted as 50px per radian)",
      };
    }
  );

  addTest(
    "A spring too stiff for a small body is limited, not unstable: in JS and on the GPU alike",
    "the step is fixed, so past (omega*dt)^2 = 4 an oscillation's energy grows without limit, and ANGULAR speed has no cap to run into. Two things guard it, and the GLSL has to apply both identically from per-pixel masses: springEffectiveStiffness limits the stiffness to what the two ends can take, and springSpin integrates the spin implicitly once a body's swing about its own center - driven by the spring's TENSION, which no stiffness limit bounds - is too fast for the step. Unguarded, this exact scene spun its circle to 7,000 rad/s and multiplied its energy by 580",
    function () {
      // Smallest circle, stiffest spring, off-center, stretched so its swing is past what the step can follow.
      function build() {
        var tiny = PhysicsEngine.createCircle(476, 300, 5, false);
        tiny.vy = 120;
        return {
          bodies: [tiny], hinges: [], edgeMode: "infinite", mutualGravity: true,
          springs: [{ bodyA: null, bodyB: 0, localAnchorA: { x: 400, y: 300 }, localAnchorB: { x: 3, y: 0 }, stiffness: PhysicsEngine.SPRING_STIFFNESS_MAX, restLength: 60 }],
        };
      }
      var scene = build(), body = scene.bodies[0];
      var limit = PhysicsEngine.springEffectiveStiffness(scene.springs[0], scene.bodies, DT);
      var e0 = springSceneEnergy(scene, DT) + body.mass * PhysicsEngine.GRAVITY * body.y; // no gravity in this scene
      var peakEnergy = 0, peakSpin = 0, peakSwing = 0;
      for (var i = 0; i < 3000; i++) {
        PhysicsEngine.step(scene, DT);
        peakEnergy = Math.max(peakEnergy, (springSceneEnergy(scene, DT) + body.mass * PhysicsEngine.GRAVITY * body.y) / e0);
        peakSpin = Math.max(peakSpin, Math.abs(body.w));
        var p = PhysicsEngine.getSpringWorldPoints(scene.springs[0], scene.bodies);
        peakSwing = Math.max(peakSwing, limit * Math.abs(Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y) - 60) * 3 * body.invInertia * DT * DT);
      }
      var finite = isFinite(body.x + body.y + body.angle + body.w);
      // 60 steps only: the scene is chaotic (a 1e-9px nudge is 0.2px by step 112). Energy may wobble
      // (omega*dt is 0.53 here); it must not CLIMB.
      var js = PhysicsEngine.runTrajectory(build(), 60, DT);
      var gap = worstTrajectoryGap(js, PhysicsGPU.runSceneOnGPU(build(), 60, "df"), 60, 1);
      return {
        pass: limit < PhysicsEngine.SPRING_STIFFNESS_MAX / 10 && peakSwing > PhysicsEngine.SPRING_STABILITY && finite && peakEnergy < 1.6 && peakSpin < 300 && gap < 0.002,
        detail: "asked for " + PhysicsEngine.SPRING_STIFFNESS_MAX + ", ran at " + Math.round(limit) + "; swing reached (omega*dt)^2=" + peakSwing.toFixed(2) +
          " (the guard engages past " + PhysicsEngine.SPRING_STABILITY + "); over 3000 steps finite=" + finite + ", energy never exceeded " + peakEnergy.toFixed(3) +
          "x what it started with, spin peaked at " + peakSpin.toFixed(0) + " rad/s; GPU (double-float) within " + gap.toExponential(2) + "px of JS over 60 steps",
      };
    }
  );

    // Two free circles under Mutual Gravity, collisions off, joined by a spring stretched to twice its
    // rest length, so they pass THROUGH each other. `t` slides body 0's start along the line of centers.
  function buildPassThroughScene(t) {
    var ux = -0.80421, uy = 0.59434; // from body 1 toward body 0, engine space
    return {
      mutualGravity: true, collisionsEnabled: false, edgeMode: "infinite", hinges: [],
      bodies: [PhysicsEngine.createCircle(-424.79 + ux * t, 845.4 + uy * t, 30, false), PhysicsEngine.createCircle(226, 364.44, 30, false)],
      springs: [{ bodyA: 1, bodyB: 0, localAnchorA: { x: 0, y: 0 }, localAnchorB: { x: 0, y: 0 }, stiffness: 56000, restLength: 406 }],
    };
  }

  addTest(
    "A spring whose ends pass through each other no longer puts ridges in the map",
    "a Hookean spring with a rest length pushes hardest at zero length, and as its ends pass through each other that push reverses in no distance at all, so each pass landed one 1/60s sample just before the flip or just after it, and starts a hair apart got a whole step of k*rest/m in opposite directions. Measured before the fix on this scene: neighbours 0.005px apart came out up to 261px apart, 124 such jumps in 2px of travel, and a gap that would not close under refinement (71px at 0.0005px). Inside an eighth of its rest length the law is now a smooth polynomial (PhysicsEngine.springForceFactor) meeting Hooke in value, slope and curvature",
    function () {
      function finalY(t, sub) {
        var scene = buildPassThroughScene(t), dt = DT / sub;
        for (var i = 0; i < 400 * sub; i++) PhysicsEngine.step(scene, dt);
        return scene.bodies[0].y;
      }
      // 1. The law itself joins Hooke smoothly at the core's rim and vanishes at zero length.
      var L0 = 406, c = PhysicsEngine.SPRING_CORE * L0, h = 1e-3;
      function q(r) { return PhysicsEngine.springForceFactor(r, L0); }
      function hooke(r) { return 1 - L0 / r; }
      var valueGap = Math.abs(q(c - 1e-9) - hooke(c));
      var slopeGap = Math.abs((q(c) - q(c - h)) / h - (hooke(c + h) - hooke(c)) / h) / (L0 / (c * c));
      var curveIn = (q(c - 2 * h) - 2 * q(c - h) + q(c)) / (h * h), curveOut = (hooke(c) - 2 * hooke(c + h) + hooke(c + 2 * h)) / (h * h);
      var curveGap = Math.abs(curveIn - curveOut) / Math.abs(curveOut);
      var linearSpring = PhysicsEngine.springForceFactor(0, 0) === 1 && PhysicsEngine.springForceFactor(123, 0) === 1;
      // 2. Neighbouring starts give neighbouring results, and the passes really happen.
      var worst = 0, prev = null;
      for (var i = 0; i <= 200; i++) { var y = finalY((i / 200 - 0.5) * 2, 1); if (prev !== null) worst = Math.max(worst, Math.abs(y - prev)); prev = y; }
      var probe = buildPassThroughScene(0), passes = 0, side = 1;
      for (i = 0; i < 400; i++) {
        PhysicsEngine.step(probe, DT);
        var along = (probe.bodies[0].x - probe.bodies[1].x) * -0.80421 + (probe.bodies[0].y - probe.bodies[1].y) * 0.59434;
        if ((along < 0 ? -1 : 1) !== side) { side = -side; passes++; }
      }
      // 3. And the 1/60s answer is the physics, not the step: it agrees with 1/960s.
      var stepGap = Math.abs(finalY(0, 1) - finalY(0, 16));
      return {
        pass: valueGap < 1e-9 && slopeGap < 1e-3 && curveGap < 1e-2 && q(0) * 0 === 0 && linearSpring && passes >= 6 && worst < 1 && stepGap < 40,
        detail: "at the core's rim the law meets Hooke to " + valueGap.toExponential(1) + " in value, " + slopeGap.toExponential(1) + " in slope, " + curveGap.toExponential(1) +
          " in curvature; rest length 0 stays exactly linear=" + linearSpring + "; the balls passed through each other " + passes + " times, and 201 starts across 2px never differed from a neighbour by more than " +
          worst.toFixed(3) + "px (was 261); 1/60s vs 1/960s differ by " + stepGap.toFixed(1) + "px (was ~350)",
      };
    }
  );

  addTest(
    "The spring's smooth core is the same law, with the same energy, in JS and on the GPU",
    "the core is a second branch of the spring law, written three times (springForceFactor, and the float32 and multi-float spellings in generateStepOnceGLSL) plus once more as its own integral in springPotentialEnergy. A pass through zero length exercises every one: if the GLSL branch disagreed the trajectories would part on the first pass, and if the potential were not the force's integral the energy audit would show a step at the core's rim",
    function () {
      var js = PhysicsEngine.runTrajectory(buildPassThroughScene(0), 120, DT);
      var f32 = worstTrajectoryGap(js, PhysicsGPU.runSceneOnGPU(buildPassThroughScene(0), 60), 60, 2);
      var df = worstTrajectoryGap(js, PhysicsGPU.runSceneOnGPU(buildPassThroughScene(0), 120, "df"), 120, 2);
      // Only the spring in the scene: one ball, released at twice the rest length, swinging through the anchor.
      function wobble(sub) {
        var ball = PhysicsEngine.createCircle(1000, 300, 30, false), dt = DT / sub;
        var scene = { mutualGravity: true, edgeMode: "infinite", bodies: [ball], hinges: [],
          springs: [{ bodyA: null, bodyB: 0, localAnchorA: { x: 200, y: 300 }, localAnchorB: { x: 0, y: 0 }, stiffness: 110000, restLength: 406 }] };
        function energy() { return PhysicsEngine.springPotentialEnergy(scene, dt) + 0.5 * ball.mass * (ball.vx * ball.vx + ball.vy * ball.vy); }
        var e0 = energy(), lo = e0, hi = e0, farSide = false;
        for (var i = 0; i < 240 * sub; i++) { PhysicsEngine.step(scene, dt); var e = energy(); lo = Math.min(lo, e); hi = Math.max(hi, e); if (ball.x < 200 - 406 * PhysicsEngine.SPRING_CORE) farSide = true; }
        return { range: (hi - lo) / e0, farSide: farSide };
      }
      var coarse = wobble(1), fine = wobble(16);
      return {
        pass: f32 < 0.05 && df < 0.002 && coarse.farSide && coarse.range < 0.25 && fine.range < coarse.range / 8,
        detail: "through two passes: float32 within " + f32.toExponential(1) + "px of JS over 60 steps, double-float within " + df.toExponential(1) + "px over 120; a lone ball swung through its spring's attachment point and out the far side=" +
          coarse.farSide + ", its energy ranging over " + (coarse.range * 100).toFixed(2) + "% at 1/60s and " + (fine.range * 100).toFixed(3) + "% at 1/960s (a potential that was not the force's integral would leave a step at the core's rim that no step size removes)",
      };
    }
  );

  addTest(
    "Springs at the frame's edges: a tethered group never wraps, a free one wraps as one (JS and GPU)",
    "wrapping one end of a spring alone stretches it by a whole frame in a single step. PhysicsEngine.springGroups is the rule that prevents it, a group tied to the background never wraps, any other wraps together when its leader does, and generateStepOnceGLSL runs the same rule at codegen time. A member that merely follows must also stay OFF Sticky Edges' watch list, or findWrapStopStep solves for a crossing that never happened",
    function () {
      var W = 600, H = 400;
      function tethered() {
        var ball = PhysicsEngine.createCircle(560, 200, 20, false); ball.vx = 900;
        return { bodies: [ball], hinges: [], frameWidth: W, frameHeight: H, edgeMode: "wrap", mutualGravity: true,
          springs: [{ bodyA: null, bodyB: 0, localAnchorA: { x: 300, y: 200 }, localAnchorB: { x: 0, y: 0 }, stiffness: 20000, restLength: 100 }] };
      }
      function pair() {
        // Body 0 leads (lowest index); body 1 trails it by 150px and follows it through the edge.
        var lead = PhysicsEngine.createCircle(560, 200, 20, false), trail = PhysicsEngine.createCircle(410, 200, 20, false);
        lead.vx = 600; trail.vx = 600;
        return { bodies: [lead, trail], hinges: [], frameWidth: W, frameHeight: H, edgeMode: "wrap", mutualGravity: true, collisionsEnabled: false,
          springs: [{ bodyA: 0, bodyB: 1, localAnchorA: { x: 0, y: 0 }, localAnchorB: { x: 0, y: 0 }, stiffness: 30000, restLength: 150 }] };
      }
      // Tethered: flies out past the right edge and is pulled back, never teleported.
      var t = PhysicsEngine.runTrajectory(tethered(), 60, DT), tMax = 0, tJump = 0;
      for (var i = 0; i < t.length; i++) { tMax = Math.max(tMax, t[i][0].x); if (i) tJump = Math.max(tJump, Math.abs(t[i][0].x - t[i - 1][0].x)); }
      var tGpu = worstTrajectoryGap(t, PhysicsGPU.runSceneOnGPU(tethered(), 60), 60, 1);
      // Free pair: both shift by exactly one frame on the same step, so their separation never jumps.
      var p = PhysicsEngine.runTrajectory(pair(), 60, DT), wrapStep = -1, sepJump = 0, trailOutside = false;
      for (i = 1; i < p.length; i++) {
        if (wrapStep === -1 && p[i][0].x < p[i - 1][0].x - W / 2) { wrapStep = i; trailOutside = p[i][1].x < 0; }
        sepJump = Math.max(sepJump, Math.abs((p[i][0].x - p[i][1].x) - (p[i - 1][0].x - p[i - 1][1].x)));
      }
      var pGpu = worstTrajectoryGap(p, PhysicsGPU.runSceneOnGPU(pair(), 60), 60, 2);
      var watched = PhysicsHingeGeometry.wrapWatchedBodyIndices(pair()).join(",") + "|" + PhysicsHingeGeometry.wrapWatchedBodyIndices(tethered()).join(",");
      return {
        pass: tMax > W + 50 && tJump < 20 && tGpu < 0.02 && wrapStep > 0 && trailOutside && sepJump < 5 && pGpu < 0.02 && watched === "0|",
        detail: "tethered ball reached x=" + tMax.toFixed(0) + " (frame is " + W + ") with no jump over " + tJump.toFixed(1) + "px, GPU gap " + tGpu.toExponential(1) +
          "; free pair wrapped together at step " + wrapStep + " (trailing ball carried outside the frame=" + trailOutside + "), separation never jumped more than " + sepJump.toFixed(2) +
          "px, GPU gap " + pGpu.toExponential(1) + "; Sticky Edges watches [" + watched + "] (expected the pair's leader only, and nothing tethered)",
      };
    }
  );

  addTest(
    "The grid's per-pixel springs match the numeric mirror: anchors follow a linked size, groups settle as one",
    "physics-grid-codegen.js rescales a spring's anchor when X/Y Input resizes the body it sits on, and settles spring groups into the frame by their leader; PhysicsHingeGeometry (rescaleSpringAnchorsOnBody, normalizeAllBodiesIntoFrame's bySpringGroup) is the JS mirror the hover preview and the seam detection read. If the two disagree the preview shows a different scene from the pixel it is previewing",
    function () {
      function build(edge, xin, yin) {
        var line = PhysicsEngine.createLine(500, 300, 240, 0.2, false), ball = PhysicsEngine.createCircle(560, 480, 28, false), top = PhysicsEngine.createCircle(760, 250, 22, false);
        return {
          bodies: [line, ball, top], hinges: [],
          springs: [
            { bodyA: 0, bodyB: 1, localAnchorA: { x: 120, y: 0 }, localAnchorB: { x: 0, y: -20 }, stiffness: 120000, restLength: 110 },
            { bodyA: 1, bodyB: 2, localAnchorA: { x: 0, y: 0 }, localAnchorB: { x: 10, y: 0 }, stiffness: 50000, restLength: 60 },
          ],
          xInput: xin, yInput: yin, output: { body: 1, bodyB: null, property: "y" },
          frameWidth: 1200, frameHeight: 800, edgeMode: edge,
        };
      }
      function gap(scene, wx, wy, steps) {
        var compiled = PhysicsGridCodegen.compileHoverTrajectoryGLSL(scene, wx, wy, steps, "df");
        var traj = PhysicsGPU.runCompiledTrajectoryOnGPU(compiled, steps);
        var start = PhysicsGridCodegen.computeOffsetSceneNumeric(scene, wx, wy);
        return { gap: worstTrajectoryGap(PhysicsEngine.runTrajectory(start, steps, DT), traj, steps, 3), start: start };
      }
      var resized = gap(build("infinite", { body: 0, property: "length" }, { body: 2, property: "radius" }), 37.5, -6.25, 100);
      var anchorA = resized.start.springs[0].localAnchorA.x, anchorB = resized.start.springs[1].localAnchorB.x;
      // Leader (body 0) pushed 2950.5px right: it settles to 1050.5 and BOTH others go with it, off-frame.
      var settled = gap(build("wrap", { body: 0, property: "x" }, null), 2950.5, 0, 100);
      var xs = settled.start.bodies.map(function (b) { return b.x; });
      // A non-leader pushed the same distance is left where its pixel put it: the spring just starts stretched.
      var follower = gap(build("wrap", { body: 2, property: "x" }, null), 2950.5, 0, 60);
      return {
        pass: Math.abs(anchorA - 138.75) < 1e-9 && Math.abs(anchorB - 10 * (22 - 6.25) / 22) < 1e-9 && resized.gap < 0.005 &&
          Math.abs(xs[0] - 1050.5) < 1e-9 && Math.abs(xs[1] - (560 - 2400)) < 1e-9 && Math.abs(xs[2] - (760 - 2400)) < 1e-9 && settled.gap < 0.005 &&
          Math.abs(follower.start.bodies[2].x - 3710.5) < 1e-9 && follower.gap < 0.05,
        detail: "length-linked line's anchor 120 -> " + anchorA + " (expected 138.75), radius-linked ball's 10 -> " + anchorB.toFixed(4) + ", GPU gap " + resized.gap.toExponential(1) +
          "; settled group at x=[" + xs.map(function (x) { return x.toFixed(1); }).join(", ") + "], GPU gap " + settled.gap.toExponential(1) +
          "; unsettled follower at x=" + follower.start.bodies[2].x + ", GPU gap " + follower.gap.toExponential(1),
      };
    }
  );

  addTest(
    "Springs survive every copy of a scene: clone, delete-and-reindex, authored JSON, and a share link",
    "a field one of these forgets is wiped silently: physics-ui.js clones the scene on Play and back on Reset, deleteBody renumbers everything after the deleted body, and a link or an exported file is the only copy of a scene someone else ever sees. A scene WITHOUT springs must also come through unchanged, so nothing written before they existed reads differently now",
    function () {
      var scene = buildSpringLockstepScene();
      var cloned = JSON.stringify(PhysicsEngine.cloneScene(scene).springs) === JSON.stringify(scene.springs);
      // Delete body 1 (the ball): both springs touching it go; the background spring on body 0 stays.
      var cut = PhysicsEngine.cloneScene(scene);
      PhysicsEngine.deleteBody(cut, 1);
      var cutOk = cut.springs.length === 1 && cut.springs[0].bodyA === null && cut.springs[0].bodyB === 0;
      // Delete body 0 instead: the 1-2 spring survives, renumbered 0-1.
      var shifted = PhysicsEngine.cloneScene(scene);
      PhysicsEngine.deleteBody(shifted, 0);
      var shiftedOk = shifted.springs.length === 1 && shifted.springs[0].bodyA === 0 && shifted.springs[0].bodyB === 1;
      // Authored space and back: a background end takes the full position map, a local anchor only flips y.
      var json = { bodies: [{ type: "circle", x: 300, y: 200, angle: 0, radius: 30 }], hinges: [], frameWidth: 1000, frameHeight: 600,
        springs: [{ bodyA: null, bodyB: 0, localAnchorA: { x: 250, y: 100 }, localAnchorB: { x: 5, y: -7 }, stiffness: 123000, restLength: 88 }] };
      var authored = PhysicsCoords.toAuthoredJSON(json);
      var a = authored.springs[0];
      var authoredOk = a.localAnchorA.x === -250 && a.localAnchorA.y === 200 && a.localAnchorB.x === 5 && a.localAnchorB.y === 7 && a.stiffness === 123000 && a.restLength === 88;
      var backOk = JSON.stringify(PhysicsCoords.toEngineJSON(authored, json).springs) === JSON.stringify(json.springs);
      var noSpringsUntouched = PhysicsCoords.toAuthoredJSON({ bodies: [], hinges: [] }).springs === undefined;
      // The link: "sprg", and absent entirely from a scene with none.
      authored.bodies[0].isAnchored = false; authored.bodies[0].vx = 0; authored.bodies[0].vy = 0; authored.bodies[0].w = 0;
      var fragment = ShareUrl.encode({ page: "bldr", scene: authored });
      var linkOk = JSON.stringify(ShareUrl.decode(fragment).scene.springs) === JSON.stringify(authored.springs);
      var silent = ShareUrl.encode({ page: "bldr", scene: { bodies: authored.bodies, hinges: [], frameWidth: 1000, frameHeight: 600 } }).indexOf("sprg") === -1;
      var oldLinkOk = ShareUrl.decode("#bldr/body:ci:0:0:0:30").scene.springs.length === 0;
      return {
        pass: cloned && cutOk && shiftedOk && authoredOk && backOk && noSpringsUntouched && linkOk && silent && oldLinkOk,
        detail: "clone=" + cloned + "; delete removes/renumbers=" + cutOk + "/" + shiftedOk + "; authored space=" + authoredOk + " and back=" + backOk +
          "; a spring-less scene gains no field=" + noSpringsUntouched + "; link round trip=" + linkOk + ", silent without springs=" + silent + ", a link from before springs reads as none=" + oldLinkOk +
          "; " + fragment.slice(fragment.indexOf("sprg")),
      };
    }
  );

  addTest(
    "A scene with no springs compiles to exactly the shader it always did",
    "every existing scene, sample and shared link has no springs. The spring codegen is written to emit nothing at all for them, no accumulator, no parameter, no angular term in either leg, so their shaders (and with them every picture already made) are untouched. An empty `springs` list and no list at all must both produce that same source",
    function () {
      function build(withField) {
        var scene = {
          bodies: [PhysicsEngine.createLine(400, 560, 700, 0, true), PhysicsEngine.createCircle(270, 150, 30, false), PhysicsEngine.createLine(530, 150, 140, 0.3, false)],
          hinges: [{ bodyA: null, bodyB: 2, localAnchorA: { x: 460, y: 150 }, localAnchorB: { x: -70, y: 0 } }],
          frameWidth: 1200, frameHeight: 800, edgeMode: "wrap",
        };
        if (withField) scene.springs = [];
        return scene;
      }
      var same = ["f32", "df"].every(function (precision) {
        return PhysicsGPU.compileSceneToTrajectoryGLSL(build(false), 10, precision).fragmentSource ===
          PhysicsGPU.compileSceneToTrajectoryGLSL(build(true), 10, precision).fragmentSource;
      });
      var source = PhysicsGPU.compileSceneToTrajectoryGLSL(build(true), 10, "f32").fragmentSource;
      var clean = !/spr[A-Z]|SPRING\d|accel\d/.test(source);
      // And the JS engine: identical bits with and without the field.
      var a = build(false), b = build(true);
      runJS(a, 200); runJS(b, 200);
      var bits = a.bodies.every(function (body, i) { return body.x === b.bodies[i].x && body.y === b.bodies[i].y && body.angle === b.bodies[i].angle; });
      return {
        pass: same && clean && bits,
        detail: "same source with and without an empty list=" + same + "; no spring code in it=" + clean + "; JS engine bit-identical over 200 steps=" + bits,
      };
    }
  );

  // ---- Runner / report rendering ----

  function renderRow(tbody, name, bugRef, outcome) {
    var row = document.createElement("tr");
    row.className = outcome.pass ? "row-pass" : "row-fail";
    var nameCell = document.createElement("td");
    nameCell.innerHTML = "<div>" + name + "</div><div class='bug-ref'>" + bugRef + "</div>";
    var statusCell = document.createElement("td");
    statusCell.textContent = outcome.pass ? "PASS" : "FAIL";
    statusCell.className = "status-cell";
    var detailCell = document.createElement("td");
    detailCell.textContent = outcome.detail;
    row.appendChild(nameCell);
    row.appendChild(statusCell);
    row.appendChild(detailCell);
    tbody.appendChild(row);
    return outcome.pass;
  }

  function updateSummary(passCount, total) {
    var el = document.getElementById("summary");
    el.textContent = passCount + " / " + total + " passed";
    el.className = passCount === total ? "summary-ok" : "summary-fail";
  }

    // `only` runs just the tests whose name contains it (case-insensitive): physics-tests.html?only=spring.
    // The summary says how many were left out, so a filtered pass can't pass for a clean bill.
  function runAll(only) {
    var tbody = document.querySelector("#results tbody");
    tbody.innerHTML = "";
    var passCount = 0;
    var needle = only ? String(only).toLowerCase() : "";
    var selected = TESTS.filter(function (t) { return !needle || t.name.toLowerCase().indexOf(needle) !== -1; });

    selected.forEach(function (t) {
      var outcome;
      try {
        outcome = t.fn();
      } catch (err) {
        outcome = { pass: false, detail: "Threw: " + (err && err.message || err) };
      }
      if (renderRow(tbody, t.name, t.bugRef, outcome)) passCount++;
    });

    updateSummary(passCount, selected.length);
    if (selected.length !== TESTS.length) {
      document.getElementById("summary").textContent += " (only \"" + only + "\": " + (TESTS.length - selected.length) + " not run)";
    }
  }

    // gridResidualAtPoint and cpuStateAt are exported because they are the only way to compare a shader
    // against the float64 engine without the float32 readback swallowing the answer.
  window.__physicsTests = {
    runAll: runAll,
    gridResidualAtPoint: gridResidualAtPoint,
    cpuStateAt: cpuStateAt,
  };
})();
