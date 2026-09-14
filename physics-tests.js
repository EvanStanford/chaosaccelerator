// This file is part of Chaos Accelerator, licensed under the Common Public
// Attribution License, Version 1.0 (CPAL-1.0) - see LICENSE in the project
// root, or https://chaosaccelerator.com/license for a hosted copy.

// Regression suite for the physics engine/GPU compiler/hinge-editing logic.
// Each test reproduces a bug that was actually found and fixed during
// development - run this page after any physics change to make sure none of
// them came back. Everything under test (PhysicsEngine, PhysicsGPU,
// PhysicsHingeGeometry, PhysicsGridCodegen) is plain DOM-free scene math,
// loaded directly - no iframe/live-page indirection needed anywhere here.
(function () {
  "use strict";

  var DT = 1 / 60;
  var TESTS = [];

  function addTest(name, bugRef, fn) {
    TESTS.push({ name: name, bugRef: bugRef, fn: fn });
  }

  function dist(ax, ay, bx, by) { return Math.hypot(bx - ax, by - ay); }

  // World-space point of the bodyA side of a hinge (bodyA === null means the
  // fixed background pin, expressed directly in world coordinates).
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

  // ---- 0. A scene round-tripped through JSON has no mass fields to clone ----
  //
  // serializeScene() deliberately omits mass/invMass/inertia/invInertia -
  // they're derived from radius/length, not authored data - so anything
  // that JSON.parses a saved scene (the Send-to-Fractal-Grid handoff, the
  // Scene JSON textarea) gets bodies with those fields simply absent.
  // PhysicsEngine.cloneScene only copies whatever properties a body
  // already has; it doesn't call computeMass. Skipping computeMass before
  // PhysicsEngine.step on such a scene silently produces NaN everywhere on
  // the very first step (this exact bug shipped once, in fractal-grid.js's
  // output-baseline computation, and was only caught by testing the actual
  // rendered page, not by the codegen-level tests below - bodyConst already
  // guards every codegen path against it, but a raw JS step() call doesn't
  // go through bodyConst at all).
  addTest(
    "A JSON-round-tripped scene needs computeMass before it can be stepped",
    "PhysicsEngine.cloneScene doesn't compute mass; serializeScene() doesn't include it",
    function () {
      // Needs a hinge (or a contact): gravity and plain integration never
      // read invMass/invInertia at all, so a lone, unconstrained body steps
      // "fine" (wrong, but not NaN) even with them undefined - the actual
      // bug this reproduces only showed up via solveHingeVelocity's
      // solve2x2, which multiplies invMass/invInertia directly. A version
      // of this test without a hinge would silently test nothing.
      var authored = {
        gravity: 800, friction: 0.4, restitution: 0.2,
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
      var scene = {
        gravity: 3000, friction: 0.4, restitution: 0.1,
        bodies: [
          PhysicsEngine.createLine(400, 600, 700, 0, true),
          PhysicsEngine.createCircle(400, -400, 20, false),
        ],
        hinges: [],
      };
      runJS(scene, 400);
      var circle = scene.bodies[1];
      var expectedRestY = 600 - PhysicsEngine.LINE_THICKNESS / 2 - circle.radius;
      var drift = Math.abs(circle.y - expectedRestY);
      var detail = "final y=" + circle.y.toFixed(2) + ", expected rest y=" + expectedRestY.toFixed(2) + ", drift=" + drift.toFixed(2) + "px";
      return { pass: circle.y < 600 && drift < 3, detail: detail };
    }
  );

  addTest(
    "A fast circle no longer tunnels through a smaller circle it's aimed straight at",
    "collideCircleCircle had no continuous collision detection: a same-step start/end sample (dist=10, then dist=6.67) can both read as 'not touching' (rsum=6) even though the straight path passes through dist=0 in between",
    function () {
      var scene = {
        gravity: 0, friction: 0.4, restitution: 0.8,
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
      var detail = "after 1 step: x=" + ball.x.toFixed(3) + ", vx=" + ball.vx.toFixed(3) + " (want vx<0 and x<10 - bounced back, didn't pass through to x=16.67 with vx still 1000)";
      return { pass: bounced, detail: detail };
    }
  );

  addTest(
    "GPU compiler agrees with JS for the same tunneling case",
    "collideCircleCircle's continuous collision detection (GLSL port)",
    function () {
      var scene = {
        gravity: 0, friction: 0.4, restitution: 0.8,
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
          gravity: 800, friction: 0.4, restitution: 0.6,
          bodies: [
            PhysicsEngine.createCircle(startX, 100, 20, false),
            PhysicsEngine.createCircle(500, 400, 40, true),
          ],
          hinges: [],
        };
        runJS(scene, 200);
        return scene.bodies[0].x;
      }
      // Deliberately the exact 442.0-442.6 window the original bug report's
      // jump sat in, not a wider sweep: solveContactVelocity's own
      // RESTITUTION_THRESHOLD is a SEPARATE, still-unfixed hard on/off
      // switch on the coefficient of restitution (elsewhere in this same
      // scene's wider neighborhood, a starting X exists whose grazing angle
      // puts the closing speed within ~1e-3px/s of that threshold - a real,
      // known, pre-existing discontinuity, but not the one CCD fixes or
      // this test is targeting). A wide blanket sweep would eventually
      // catch that other threshold too and fail for an unrelated reason.
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
        "px at x=" + jumpAt + " (want <20px - before this fix, x=442.3->442.4 alone jumped ~267px)";
      return { pass: maxJump < 20, detail: detail };
    }
  );

  // ---- 2. Resting contact: a nearly-flat rod must settle, not spin forever ----
  addTest(
    "A rod dropped onto flat ground settles instead of spinning",
    "2-point contact for near-parallel lines",
    function () {
      var scene = {
        gravity: 1200, friction: 0.5, restitution: 0.05,
        bodies: [
          PhysicsEngine.createLine(400, 600, 700, 0, true),
          PhysicsEngine.createLine(400, 550, 300, 0.12, false),
        ],
        hinges: [],
      };
      runJS(scene, 900);
      var rod = scene.bodies[1];
      var angleDeg = Math.abs(rod.angle * 180 / Math.PI);
      var w = Math.abs(rod.w);
      var detail = "final angle=" + angleDeg.toFixed(3) + "deg, angular vel=" + w.toFixed(4) + "rad/s";
      return { pass: angleDeg < 2 && w < 0.1, detail: detail };
    }
  );

  // ---- 3. Hinge exclusion: a double pendulum must swing freely, joints must ----
  //         not drift apart, in BOTH the JS engine and the GPU compiler.
  function buildDoublePendulum() {
    return {
      gravity: 800, friction: 0.4, restitution: 0.2,
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
            gravity: 800, friction: 0.4, restitution: 0.2,
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
            gravity: 800, friction: 0.4, restitution: 0.2,
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
            gravity: 800, friction: 0.4, restitution: 0.2,
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
        gravity: 1000, friction: 0.4, restitution: 0.2,
        bodies: [PhysicsEngine.createCircle(100, 100, 20, false)],
        hinges: [],
      };
      var N = 5;
      var traj = PhysicsGPU.runSceneOnGPU(scene, N);
      var y = 100, vy = 0;
      var expected = [];
      for (var s = 0; s < N; s++) { vy += 1000 * DT; y += vy * DT; expected.push(y); }
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
          gravity: 800, friction: 0.4, restitution: 0.2,
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
      gravity: 800, friction: 0.4, restitution: 0.2,
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

  // ---- Milestone 2: physics-grid-codegen.js (per-pixel offset+cascade,
  // compiled to GLSL) - every scene here reuses a scenario already verified
  // against a direct PhysicsHingeGeometry call elsewhere in this file, so
  // the only new thing under test is whether the GLSL port reaches the
  // same answer. ----

  // Compiles the codegen's declaration lines into a tiny debug shader that
  // evaluates them once at a hardcoded (worldX, worldY) and reads back every
  // body's resulting (x, y, angle) - the same WebGL2/OffscreenCanvas/
  // RGBA32F machinery as PhysicsGPU.runSceneOnGPU, just a single sample
  // point over bodies instead of a (body, step) trajectory.
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

  // Same idea as runGridCodegenAtPoint, but also runs the shared
  // PhysicsGPU.generateStepOnceGLSL loop `steps` times first - this is
  // fractal-grid.js's actual shader shape (offset -> canonical Body structs
  // -> step loop -> read result), not just the offset half of it.
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
      "const float GRAVITY = " + PhysicsGPU.fnum(scene.gravity) + ";",
      "const float FRICTION = " + PhysicsGPU.fnum(scene.friction) + ";",
      "const float RESTITUTION = " + PhysicsGPU.fnum(scene.restitution) + ";",
      "", stepOnceSrc, "",
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
      // Any hinged body is an oscillator, however small its swing - even
      // hinged 2px from its own center (barely any lever arm for gravity's
      // torque), low rotational inertia still lets its ANGLE drift out of
      // phase between JS (float64) and GPU (float32) well before its
      // position visibly moves (confirmed empirically: this scene's angle
      // was already ~0.13rad off from the JS reference by step 60, despite
      // sub-pixel position agreement - a real consequence of comparing an
      // oscillating quantity at a fixed distant step, not a bug). So this
      // checks early steps only, where phase drift hasn't had room to
      // accumulate yet - enough to prove resize+rescale+recenter ->
      // canonical-struct -> stepOnce(...) is wired correctly. Whether the
      // hinge constraint itself holds up over a FULL run is checked
      // separately below via joint gap, which - unlike raw angle - stays
      // meaningful regardless of oscillation phase.
      var scene = {
        gravity: 800, friction: 0.4, restitution: 0.2,
        bodies: [PhysicsEngine.createCircle(500, 300, 50, false)],
        hinges: [{ bodyA: null, bodyB: 0, localAnchorA: { x: 502, y: 300 }, localAnchorB: { x: 2, y: 0 } }],
        xInput: { body: 0, property: "radius" },
        yInput: null,
        output: { body: 0, property: "angle" },
      };
      var STEPS = 5, WORLD_X = 20;
      var jsScene = PhysicsEngine.cloneScene(scene);
      // Hinge-preserving resize: radius 50->70 (ratio 1.4) rescales the
      // hinge anchor 2->2.8, then recenters so the hinge still lands on its
      // fixed pivot (502,300) - same algebra as the "resize-link cascade"
      // test above. Skipping this would start the JS reference from a
      // constraint-violating state the grid codegen never produces.
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
    "fractal-grid.js's shader shape - self-consistency, not cross-implementation phase",
    function () {
      var hinge = { bodyA: null, bodyB: 0, localAnchorA: { x: 502, y: 300 }, localAnchorB: { x: 2, y: 0 } };
      var scene = {
        gravity: 800, friction: 0.4, restitution: 0.2,
        bodies: [PhysicsEngine.createCircle(500, 300, 50, false)],
        hinges: [hinge],
        xInput: { body: 0, property: "radius" },
        yInput: null,
        output: { body: 0, property: "angle" },
      };
      var STEPS = 500;
      var bodies = runGridSimulationAtPoint(scene, STEPS, 20, 0);
      // The hinge anchor rescales with the resize (2 -> 2.8 at worldX=20,
      // same ratio as the test above), so the gap check needs the SAME
      // rescaled anchor jointGap's rotateVec call expects, not the
      // original 2.0 the scene was authored with.
      var rescaledHinge = { bodyA: null, bodyB: 0, localAnchorA: hinge.localAnchorA, localAnchorB: { x: 2.8, y: 0 } };
      var gap = jointGap(rescaledHinge, bodies);
      var detail = "hinge gap after " + STEPS + " steps=" + gap.toFixed(3) + "px (final angle=" + bodies[0].angle.toFixed(2) + "rad, proving real motion occurred)";
      return { pass: gap < 1, detail: detail };
    }
  );

  addTest(
    "Grid codegen: numeric offset scene (instant JS preview) matches the GLSL path",
    "physics-grid-codegen.js computeOffsetSceneNumeric vs. generateGridInitialStateGLSL - a third independent path to the same answer",
    function () {
      // Exact same scenario as the "resize-link cascade" test below (which
      // itself matches the direct PhysicsHingeGeometry call elsewhere in
      // this file) - three independent routes to the same numbers: the
      // editor's own function, the GLSL the grid actually runs, and this
      // JS-only shortcut the hover-preview uses for its instant first
      // frame. All three had better agree.
      var scene = {
        gravity: 800, friction: 0.4, restitution: 0.2,
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
    "physics-grid-codegen.js compileHoverTrajectoryGLSL - the same offset math as the grid, but with per-step logging on",
    function () {
      // Reuses the exact scenario already validated for the plain (no
      // logging) grid codegen below, so any mismatch here is specifically
      // about the LOGGING mechanism (reading back many rows of a texture
      // instead of the grid shader's single final-state row), not the
      // offset/cascade math itself.
      var hinge0 = { bodyA: null, bodyB: 0, localAnchorA: { x: 400, y: 300 }, localAnchorB: { x: -100, y: 0 } };
      var hinge1 = { bodyA: 0, bodyB: 1, localAnchorA: { x: 100, y: 0 }, localAnchorB: { x: 0, y: 0 } };
      var scene = {
        gravity: 800, friction: 0.4, restitution: 0.2,
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

      // Length 200 -> 400 (worldX=200), recentered: same exact scene as the
      // "resize-link cascade" test below, just stepped forward instead of
      // read at step 0.
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
        gravity: 800, friction: 0.4, restitution: 0.2,
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
      // worldX = +200 -> length 200 -> 400, the exact same edit as the
      // "Resizing a hinged body..." test elsewhere in this file - expect
      // the exact same resulting positions, just reached through the grid
      // shader instead of a direct function call.
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
        gravity: 800, friction: 0.4, restitution: 0.2,
        bodies: [
          PhysicsEngine.createLine(500, 300, 200, 0, false),
          PhysicsEngine.createCircle(600, 300, 30, false),
        ],
        hinges: [hinge0, hinge1],
        xInput: { body: 0, property: "angle" },
        yInput: null,
      };
      // *360: an angle-linked X/Y Input is scaled down 360x from a
      // straight radians-per-world-unit mapping (see ANGLE_INPUT_SCALE in
      // physics-grid-codegen.js), so this still lands the body at exactly
      // PI/2 for the cascade check below.
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
    "physics-grid-codegen.js's applyResizeRotateTarget only ever recentered around a WORLD hinge, the exact same gap as applyBodyEditPreservingHinge - reported via this exact double-pendulum scene, whose yInput links the CHILD body's own angle",
    function () {
      var scene = {
        gravity: 800, friction: 0, restitution: 1,
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
        gravity: 800, friction: 0.4, restitution: 0.2,
        bodies: [PhysicsEngine.createCircle(500, 300, 50, false)],
        hinges: [{ bodyA: null, bodyB: 0, localAnchorA: { x: 500, y: 300 }, localAnchorB: { x: 0, y: 0 } }],
        xInput: null,
        yInput: { body: 0, property: "y" },
      };
      var bodies = runGridCodegenAtPoint(scene, 0, 50);
      var ok = Math.abs(bodies[0].x - 500) < 1e-3 && Math.abs(bodies[0].y - 250) < 1e-3;
      var detail = "at worldY=+50: body0=" + bodies[0].x.toFixed(3) + "," + bodies[0].y.toFixed(3) +
        " (want 500,250 - moving 'up' in the grid should move the body up, i.e. smaller physics-y)";
      return { pass: ok, detail: detail };
    }
  );

  addTest(
    "Grid codegen: a static body's mass stays exactly zero when its size is linked",
    "physics-grid-codegen.js isAnchored guard on the ported mass formula",
    function () {
      var scene = {
        gravity: 800, friction: 0.4, restitution: 0.2,
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
      // X resizes body0 (radius 50 -> 80, ratio 1.6); Y then moves body0's
      // center directly. Resize's recenter runs first (an absolute
      // assignment) and translate's += runs second, on top of it - so both
      // effects should show up, not just the last one applied. Hand-derived:
      // ratio 1.6 rescales localAnchorB 20->32 and body1's attachment point
      // 40->64; recenter puts body0 at (488,300); body1's attachment moves
      // 540->552 (+12,0), so body1 -> (552,300); the Y translate then adds
      // (+15,0) to both body0 and body1 (dragging body0's world pin along
      // with it, same as any direct move), landing at (503,300)/(567,300).
      var hinge0 = { bodyA: null, bodyB: 0, localAnchorA: { x: 520, y: 300 }, localAnchorB: { x: 20, y: 0 } };
      var hinge1 = { bodyA: 0, bodyB: 1, localAnchorA: { x: 40, y: 0 }, localAnchorB: { x: 0, y: 0 } };
      var scene = {
        gravity: 800, friction: 0.4, restitution: 0.2,
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
    "PhysicsEngine.step's frame-wrap - the whole point of this feature",
    function () {
      var scene = {
        gravity: 0, friction: 0.4, restitution: 0.2,
        bodies: [
          PhysicsEngine.createCircle(190, 100, 10, false), // -> right edge
          PhysicsEngine.createCircle(10, 100, 10, false),  // -> left edge
          PhysicsEngine.createCircle(100, 190, 10, false), // -> bottom edge
          PhysicsEngine.createCircle(100, 10, 10, false),  // -> top edge
        ],
        hinges: [],
        frameWidth: 200, frameHeight: 200,
      };
      scene.bodies[0].vx = 500;
      scene.bodies[1].vx = -500;
      scene.bodies[2].vy = 500;
      scene.bodies[3].vy = -500;
      for (var i = 0; i < 2; i++) PhysicsEngine.step(scene, DT);

      var d = 190 + 2 * 500 * DT - 200; // start position + net displacement, then wrapped back by one frame length
      var checks = [
        { body: scene.bodies[0], axis: "x", want: d, otherAxis: "y", otherWant: 100 },
        { body: scene.bodies[1], axis: "x", want: 200 - d, otherAxis: "y", otherWant: 100 },
        { body: scene.bodies[2], axis: "y", want: d, otherAxis: "x", otherWant: 100 },
        { body: scene.bodies[3], axis: "y", want: 200 - d, otherAxis: "x", otherWant: 100 },
      ];
      var pass = true;
      var details = [];
      checks.forEach(function (c, idx) {
        var got = c.body[c.axis];
        var otherGot = c.body[c.otherAxis];
        var inRange = got >= 0 && got < 200;
        var ok = Math.abs(got - c.want) < 1e-6 && Math.abs(otherGot - c.otherWant) < 1e-6 && inRange;
        if (!ok) pass = false;
        details.push("body" + idx + "." + c.axis + "=" + got.toFixed(4) + " (want " + c.want.toFixed(4) + ")");
      });
      var velOk = scene.bodies[0].vx === 500 && scene.bodies[1].vx === -500 && scene.bodies[2].vy === 500 && scene.bodies[3].vy === -500;
      return { pass: pass && velOk, detail: details.join("; ") + "; velocities unchanged=" + velOk };
    }
  );

  addTest(
    "Pac-Man wrap: a static body left outside the frame never moves",
    "PhysicsEngine.step's frame-wrap must skip static bodies (they don't fall, so they shouldn't warp either)",
    function () {
      var scene = {
        gravity: 800, friction: 0.4, restitution: 0.2,
        bodies: [PhysicsEngine.createCircle(300, 100, 10, true)], // x=300 is outside a 200-wide frame
        hinges: [],
        frameWidth: 200, frameHeight: 200,
      };
      for (var i = 0; i < 30; i++) PhysicsEngine.step(scene, DT);
      var body = scene.bodies[0];
      var pass = body.x === 300 && body.y === 100;
      return { pass: pass, detail: "static body at x=" + body.x + ", y=" + body.y + " (want unchanged 300,100 - static bodies are exempt from wrapping)" };
    }
  );

  addTest(
    "Pac-Man wrap: JS engine and GPU compiler agree, including across a wrap",
    "PhysicsGPU.generateStepOnceGLSL's frame-wrap port",
    function () {
      var scene = {
        gravity: 0, friction: 0.4, restitution: 0.2,
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
      // The exact reported scenario: a line hinged near one end, released
      // horizontal. Its center legitimately swings past x=0 (a normal part
      // of the pendulum's arc) while its pin (x=77) stays nowhere near
      // either edge of a 1198-wide frame - under the old per-body-center
      // rule this wrapped the body but not the pin, tearing the joint.
      var scene = {
        gravity: 800, friction: 0, restitution: 1,
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
        " (negative = did swing outside the frame), pin untouched=" + pinUntouched + " (want true - it never needed to move)";
      return { pass: pass, detail: detail };
    }
  );

  addTest(
    "Pac-Man wrap: GPU compiler agrees with the JS reference for a world-hinged pendulum",
    "PhysicsGPU.generateStepOnceGLSL's port of the pin-decides-the-wrap rule, including the new inout HINGEn_A plumbing",
    function () {
      var scene = {
        gravity: 800, friction: 0, restitution: 1,
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
    "PhysicsEngine.step's cascade for a body hinged to another body - it must never independently wrap, only move as its parent's wrap carries it along",
    function () {
      // Pin authored just outside the frame (an extreme case, but the
      // mechanism has to fire correctly whenever the pin IS out of bounds,
      // however it got there) so a wrap is guaranteed on the very first
      // step, cascading through a 2-body chain.
      var scene = {
        gravity: 800, friction: 0.4, restitution: 0.2,
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

  // ---- Stop-on-wrap: findWrapStopStep must give a CONTINUOUS answer, not
  //      just a "did it wrap" boolean - the whole point of this feature is
  //      coloring a fractal grid by it, and a jumpy answer means a jumpy
  //      plot. See the function's own comment for why a raw logged sample
  //      isn't good enough on its own. ----

  function runWrapStopStepAtPoint(scene, worldX, worldY, steps) {
    var offset = PhysicsGridCodegen.computeOffsetSceneNumeric(scene, worldX, worldY);
    var initialBody = { x: offset.bodies[0].x, y: offset.bodies[0].y, angle: offset.bodies[0].angle };
    offset.bodies.forEach(PhysicsEngine.computeMass);
    if (scene.gravity !== undefined) offset.gravity = scene.gravity;
    if (scene.friction !== undefined) offset.friction = scene.friction;
    if (scene.restitution !== undefined) offset.restitution = scene.restitution;
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
        gravity: 800, friction: 0, restitution: 1,
        bodies: [PhysicsEngine.createCircle(600, 1120, 20, false)],
        hinges: [], xInput: null, yInput: { body: 0, property: "y" },
        frameWidth: 1198, frameHeight: 1128,
      };
      var results = [];
      // worldY is NEGATED for a y-property link (see the Y-axis-flip test
      // elsewhere in this file), so sweeping [-2, 0] here moves the actual
      // starting y from 1120 up to 1122 - the exact range hand-verified
      // (in the browser console, against this same scene) to straddle
      // several step boundaries (steps 8, 7, 6 all appear in it).
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
    "sanity check on the actual formula, not just 'is it smooth' - a circle already at MAX_SPEED (terminal velocity) when it crosses has a closed-form answer: boundary - MAX_SPEED*DT, independent of exactly which step notices",
    function () {
      // Launched already AT terminal velocity rather than falling until
      // gravity saturates it: with the cap at 5000 a body would need to fall
      // 15,000px to reach it under gravity, far more than any frame here.
      // Starting there is the same physical situation - gravity keeps adding
      // speed and the clamp keeps removing it, so it descends at exactly
      // MAX_SPEED - and it holds whatever that constant is set to.
      var scene = {
        gravity: 800, friction: 0, restitution: 1,
        bodies: [PhysicsEngine.createCircle(600, 50, 20, false)],
        hinges: [], xInput: null, yInput: { body: 0, property: "y" },
        frameWidth: 1198, frameHeight: 1128,
      };
      scene.bodies[0].vy = PhysicsEngine.MAX_SPEED;
      var result = runWrapStopStepAtPoint(scene, 0, 0, 500);
      var expectedY = 1128 - PhysicsEngine.MAX_SPEED * DT; // boundary - MAX_SPEED * DT
      var err = Math.abs(result.y - expectedY);
      var detail = "interpolated y=" + result.y.toFixed(4) + ", hand-derived boundary-MAX_SPEED*DT=" + expectedY.toFixed(4) + ", error=" + err.toFixed(4) + "px";
      return { pass: err < 0.01, detail: detail };
    }
  );

  addTest(
    "findWrapStopStep: GPU grid shader's inline wrap-stop agrees with the JS reference",
    "fractal-grid.js's buildFragmentShader ports this same one-step-before-crossing interpolation into the per-pixel GLSL loop (using body.vx/vy directly instead of finite-differencing, since it has live velocity - see its own comment)",
    function () {
      var scene = {
        gravity: 800, friction: 0, restitution: 1,
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
          "const float GRAVITY = " + PhysicsGPU.fnum(scene.gravity) + ";",
          "const float FRICTION = " + PhysicsGPU.fnum(scene.friction) + ";",
          "const float RESTITUTION = " + PhysicsGPU.fnum(scene.restitution) + ";", "",
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
      // Deliberately NOT computeOffsetSceneNumeric/runWrapStopStepAtPoint
      // here - those apply the y-property "up in the grid means up in the
      // scene" negation (already covered by its own test elsewhere), which
      // the hand-rolled GLSL harness above does not replicate. Both sides
      // of this comparison use the same plain (base + worldY) convention
      // instead, so this test isolates just the wrap-stop interpolation.
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
          gravity: 800, friction: 0, restitution: 1,
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
        maxRatio.toFixed(2) + "x at step " + ratioAtStep + " (want <50x - before this fix, step 62 alone jumped 0.01px->14.69px, a ~1470x ratio)";
      return { pass: maxRatio < 50, detail: detail };
    }
  );

  addTest(
    "cloneScene preserves xInput/yInput/output/frameWidth/frameHeight",
    "PhysicsEngine.cloneScene silently dropped these, so a Play -> Reset cycle in physics-ui.js wiped every mapping and un-locked the wrap frame",
    function () {
      var scene = {
        gravity: 800, friction: 0.4, restitution: 0.2,
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
  //
  // The physics editor lets you type/paste a coordinate anywhere, and the
  // fractal grid can offset a linked property by a huge worldX/worldY once
  // zoomed out far enough - either can land a body many frame-widths away
  // in one shot, unlike ordinary per-step motion (bounded by MAX_SPEED*dt).
  // PhysicsHingeGeometry.frameWrapDelta/normalizeAllBodiesIntoFrame (and
  // physics-grid-codegen.js's GLSL port of the same rules) settle that back
  // into the frame using mod(), not the per-step rule's single subtract.

  addTest(
    "frameWrapDelta: a non-anchored body's center wraps by any distance in one shot",
    "PhysicsHingeGeometry.frameWrapDelta - mod(), not a single frame-width subtract, is what makes an arbitrarily large starting offset safe",
    function () {
      var body = { x: 5190.5, y: -3050.25, isAnchored: false };
      var d = PhysicsHingeGeometry.frameWrapDelta(body, 200, 400);
      var cx = body.x + d.dx, cy = body.y + d.dy;
      var pass = Math.abs(cx - 190.5) < 1e-9 && Math.abs(cy - 149.75) < 1e-9 && cx >= 0 && cx < 200 && cy >= 0 && cy < 400;
      return { pass: pass, detail: "corrected=(" + cx + "," + cy + ") (want 190.5,149.75 - both many frame-lengths from where they started)" };
    }
  );

  addTest(
    "frameWrapDelta: an anchored circle only wraps once its WHOLE shape clears the edge",
    "PhysicsHingeGeometry.frameWrapDelta's isAnchored branch - a merely-overhanging anchored body must not move",
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
      // length 40 at 45deg -> half-extent on each axis = 20*cos(45deg) = 14.142,
      // so the left edge (250 - 14.142 = 235.858) has fully cleared x=200.
      var line = { type: "line", x: 250, y: 100, length: 40, angle: Math.PI / 4, isAnchored: true };
      var d = PhysicsHingeGeometry.frameWrapDelta(line, 200, 200);
      var pass = d.dx === -200 && d.dy === 0;
      return { pass: pass, detail: "delta=(" + d.dx + "," + d.dy + ") (want -200,0)" };
    }
  );

  addTest(
    "normalizeAllBodiesIntoFrame never wraps a hinge CHILD directly, only cascades to it",
    "PhysicsHingeGeometry.isHingeChild - wrapping a child's own position independently of its parent tears the joint",
    function () {
      // body0: world-hinged, 5000 units outside a 200-wide frame. body1: hinged
      // to body0's local (100,0) - sitting exactly at that joint, also far
      // outside the frame, but rigidly so (it must NOT be wrapped on its own).
      var scene = {
        gravity: 800, friction: 0.4, restitution: 0.2,
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
        gravity: 0, friction: 0.4, restitution: 0.2,
        bodies: [{ type: "circle", x: 100, y: 100, angle: 0, isAnchored: false, radius: 10, vx: 0, vy: 0, w: 0 }],
        hinges: [], xInput: { body: 0, property: "x" }, yInput: null, output: { body: 0, property: "x" },
        frameWidth: 200, frameHeight: 200,
      };
      var anchoredFullyOut = {
        gravity: 0, friction: 0.4, restitution: 0.2,
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
          gravity: 800, friction: 0.4, restitution: 0.2,
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
          gravity: 800, friction: 0.4, restitution: 0.2,
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

    // The interactive editor never offers rotating a circle, and never
    // rotates anything via applyBodyEditPreservingHinge's isResize=false
    // path in the existing tests above (both only exercise resize) - but
    // the X/Y mapping UI does let "angle" be linked on either shape, so the
    // fractal grid (Milestone 2) is what first exercises this for real.
    // Check the INVARIANT the function promises (hinge stays put, cascade
    // reaches descendants) via already-trusted primitives, rather than
    // hand-deriving trig-heavy expected coordinates by hand.
  addTest(
      "Rotating a world-hinged line keeps its pin fixed and drags its child",
      "applyBodyEditPreservingHinge (isResize=false, previously untested)",
      function () {
        var scene = {
          gravity: 800, friction: 0.4, restitution: 0.2,
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
          gravity: 800, friction: 0.4, restitution: 0.2,
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
          gravity: 800, friction: 0.4, restitution: 0.2,
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

    // The two edit functions are NOT symmetric: applyBodyEditPreservingHinge
    // only cascades to descendants if the EDITED body itself has a world
    // hinge (no world hinge -> early "mutate(); return;" with no cascade at
    // all), but translateBodyPreservingHinges cascades unconditionally.
    // Milestone 2's codegen has to replicate this exactly, not "fix" it.
  addTest(
      "Resize vs. direct-move cascade asymmetry on a non-world-hinged parent",
      "applyBodyEditPreservingHinge vs. translateBodyPreservingHinges",
      function () {
        function buildScene() {
          return {
            gravity: 800, friction: 0.4, restitution: 0.2,
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
  //
  // Everything below exists because the failure mode of extended-precision
  // emulation is SILENT. A driver that reassociates float arithmetic turns
  // every error term into 0.0 and the shader still compiles, still runs,
  // and still produces plausible-looking pictures - just with none of the
  // extra precision it was supposed to have. See physics-df.js's header,
  // and df-probe.html for the same checks in a standalone page.

  // Runs a bespoke fragment shader over a `width` x 1 RGBA32F target and
  // returns the raw floats.
  //
  // Keep the df tests SHORT. A df step costs roughly an order of magnitude
  // more than a float32 one, and a page that queues up enough of them can
  // trip the GPU's watchdog - after which every draw on that page returns
  // all zeros, with no error raised anywhere, and two dozen unrelated
  // float32 tests start "failing" with plausible-looking numbers. Same OffscreenCanvas/readback machinery as
  // runGridCodegenAtPoint above, factored out because the df tests need
  // several differently-shaped one-off shaders.
  // Runs a bespoke fragment shader over a `width` x 1 RGBA32F target and
  // returns the raw floats.
  //
  // Keep the df tests SHORT. A df step costs roughly an order of magnitude
  // more than a float32 one, and a page that queues up enough of them can
  // trip the GPU's watchdog - after which every draw on that page returns
  // all zeros, with no error raised anywhere, and two dozen unrelated
  // float32 tests start "failing" with plausible-looking numbers. Same OffscreenCanvas/readback machinery as
  // runGridCodegenAtPoint above, factored out because the df tests need
  // several differently-shaped one-off shaders.
  //
  // A fresh context per call, explicitly lost at the end. Browsers cap how
  // many WebGL contexts can be live at once and silently drop the oldest,
  // after which draws stop happening and readPixels returns all zeros with
  // no error raised - so a suite this shader-hungry has to hand each one
  // back. It also means these helpers stop working from the console once a
  // full run has churned through enough of them; measure from a page that
  // hasn't run the suite.
  function runFloatShader(fragmentSource, width) {
    var canvas = new OffscreenCanvas(width, 1);
    var gl = canvas.getContext("webgl2");
    if (!gl.getExtension("EXT_color_buffer_float")) throw new Error("EXT_color_buffer_float unavailable");
    var program = PhysicsGPU.linkProgram(gl,
      PhysicsGPU.compileShader(gl, gl.VERTEX_SHADER, PhysicsGPU.VERTEX_SOURCE),
      PhysicsGPU.compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource));
    gl.useProgram(program);
    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
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
    var loseCtx = gl.getExtension("WEBGL_lose_context");
    if (loseCtx) loseCtx.loseContext();
    return pixels;
  }

  // Steps a grid-codegen scene at one (worldX, worldY) and reads back a
  // body's position as a RESIDUAL against `ref`, not as an absolute
  // coordinate.
  //
  // This is not a nicety. The readback texture is RGBA32F, so an absolute
  // coordinate of order 700 comes back quantized at ~6e-5 - which is the
  // same size as the error being measured. Subtracting the reference INSIDE
  // the shader (in df, where that subtraction is exact) leaves a small
  // number that float32 carries with ~10 significant digits, so the test
  // can actually see down to where df lives.
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
      // Both the speed cap and the gravity mode are per-scene, so this helper
      // has to forward them or it would silently compile different physics
      // than the scene it was handed.
      PhysicsGPU.libraryGLSL(precision, PhysicsEngine.speedCapFor(scene)), "",
      PhysicsGPU.sceneConstantsGLSL(scene.gravity, scene.friction, scene.restitution, precision),
      "const " + B.scalar + " worldX = " + B.lit(worldX) + ";",
      "const " + B.scalar + " worldY = " + B.lit(worldY) + ";", "",
      PhysicsGPU.generateStepOnceGLSL(initial.n, initial.consts, initial.pairs, initial.hingeAnchors, frame, precision, scene.mutualGravity, PhysicsEngine.collisionsEnabled(scene)), "",
      "void main() {",
      "  " + initial.declarationLines.join("\n  "),
      "  " + PhysicsGridCodegen.generateCanonicalBodyDeclarationsGLSL(initial).split("\n").join("\n  "),
      "  " + PhysicsGPU.generateHingeAnchorLocalsGLSL(initial.hingeAnchors, precision).split("\n").join("\n  "),
      "  for (int i = 0; i < " + steps + "; i++) { stepOnce(" +
        PhysicsGPU.stepOnceCallArgs(initial.n, initial.hingeAnchors, precision) + "); }",
      "  fragColor = vec4(" + residual("x", ref.x) + ", " + residual("y", ref.y) + ", " +
        residual("angle", ref.angle) + ", 1.0);",
      "}",
    ].join("\n");
    var px = runFloatShader(src, 1);
    return { dx: px[0], dy: px[1], da: px[2], err: Math.hypot(px[0], px[1]) };
  }

  // A ball dropped between two static walls: chaotic enough to be a real
  // fractal-grid scene, simple enough that the JS engine is unambiguous
  // ground truth. Same shape as samples/pinball.json.
  function buildDeepZoomScene() {
    return {
      gravity: 800, friction: 0, restitution: 1,
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
      // The operands have to be opaque to the front end or it constant-
      // folds the whole expression in higher precision and the test passes
      // for the wrong reason (an earlier version of this test did exactly
      // that, reporting "IEEE-conservative" on a driver the standalone
      // probe had already caught reassociating). u_zeroF is a never-
      // assigned uniform, which is 0 by spec and unknowable at compile time
      // - the same trick dfv() itself is built on.
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
        // The bare result is allowed to be either - some drivers are
        // IEEE-conservative and some aren't, and that's exactly the point:
        // only the veiled one is REQUIRED to be right.
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
      // float32 alone is ~6e-8 relative. 1e-12 is a wide margin below df's
      // real ~1e-15 and well above anything float32 could reach by luck.
      return { pass: worst < 1e-12, detail: "worst relative error " + worst.toExponential(2) + " (" + worstName + "); float32 alone would be ~6e-8" };
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
      // f32's floor is one ULP of the coordinate itself (~7.6e-6 here), so
      // 20x is a deliberately loose bar for a path that measures ~1000x
      // better in practice.
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
      // A separation far below float32's ULP at these coordinates (~6e-5)
      // and far above df's (~3e-13) - i.e. exactly the regime this exists
      // to serve.
      var X0 = 13.7, DX = 1e-9, STEPS = 25;
      var ref = cpuStateAt(scene, X0, 0, STEPS, 0);
      function spread(precision) {
        var a = gridResidualAtPoint(scene, STEPS, X0, 0, precision, 0, ref);
        var b = gridResidualAtPoint(scene, STEPS, X0 + DX, 0, precision, 0, ref);
        return Math.hypot(a.dx - b.dx, a.dy - b.dy);
      }
      var f32Spread = spread("f32"), dfSpread = spread("df");
      // NOTE what this does and does not prove. It proves the input-side
      // distinction survives, which is necessary and is exactly what the
      // 32-bit wall destroys. It does NOT prove the df pass RESOLVES that
      // distinction correctly - below a certain separation the difference
      // it produces is float32 dynamics noise rather than physics, which
      // the fidelity test below is the one to measure. An earlier version
      // of this project used "the pixels differ at all" as its headline
      // metric and overstated the gain by about three decades because of
      // exactly that conflation.
      return {
        pass: f32Spread === 0 && dfSpread > 0,
        detail: "starting positions " + DX + " apart -> outcomes differ by " +
          dfSpread.toExponential(2) + " under df, " + f32Spread.toExponential(2) +
          " under float32 (float32 must be exactly 0 - that IS the wall)",
      };
    }
  );

  // ---- df.5 The two shaders must be the same physics ----
  addTest(
    "The df and float32 shaders agree wherever float32 is still valid",
    "a df path that silently diverges is worse than none: the grid switches between them mid-zoom",
    function () {
      var scene = buildDeepZoomScene();
      // Short enough that the scene's own chaos hasn't had time to amplify
      // the ~1e-7 difference between the two paths into a visible one -
      // past a bounce or two it legitimately will, and that is the df
      // answer being MORE right, not the two disagreeing.
      var STEPS = 30;
      var worst = 0, worstPoint = null;
      [[0, 0], [13.7, -42.3], [-88.125, 17.5], [301.5, -120.25]].forEach(function (p) {
        var ref = cpuStateAt(scene, p[0], p[1], STEPS, 0);
        var a = gridResidualAtPoint(scene, STEPS, p[0], p[1], "f32", 0, ref);
        var b = gridResidualAtPoint(scene, STEPS, p[0], p[1], "df", 0, ref);
        var d = Math.hypot(a.dx - b.dx, a.dy - b.dy);
        if (d > worst) { worst = d; worstPoint = p; }
      });
      // A few float32 ULPs at these coordinates (~6e-5) is all the two are
      // allowed to differ by.
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
      // Long enough that the ball has fallen out of the bottom of the frame
      // and been wrapped back to the top at least once.
      var STEPS = 120, WORLD_X = 5.5, WORLD_Y = 0;
      var ref = cpuStateAt(scene, WORLD_X, WORLD_Y, STEPS, 0);
      var f32 = gridResidualAtPoint(scene, STEPS, WORLD_X, WORLD_Y, "f32", 0, ref);
      var df = gridResidualAtPoint(scene, STEPS, WORLD_X, WORLD_Y, "df", 0, ref);
      var inFrame = Math.abs(ref.y) < scene.frameHeight && ref.y >= 0;
      // Both must land in the same frame period as the JS engine - a
      // mis-wrapped body is off by a whole frameHeight (819), not by
      // rounding.
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
        gravity: 800, friction: 0, restitution: 1,
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
      // *360: an angle-linked X/Y Input is scaled down 360x from a
      // straight radians-per-world-unit mapping (see ANGLE_INPUT_SCALE in
      // physics-grid-codegen.js) - scaling these back up keeps the same
      // effective 0.35/-0.2 rad offsets this test always exercised.
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
    "generateCanonicalBodyDeclarationsGLSL hardcoded all three velocity accumulators to zero - correct back when nothing could give a body a starting velocity, silently wrong once the Set Velocity tool could. The JS mirror (computeOffsetSceneNumeric, via cloneScene) kept the velocity all along, so the grid ran a different scene than its own hover preview claimed",
    function () {
      var scene = {
        gravity: 800, friction: 0, restitution: 1,
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

      // The same offset scene the grid builds for this point, stepped by the
      // JS engine - which has always carried vx/vy through.
      var jsScene = PhysicsGridCodegen.computeOffsetSceneNumeric(scene, WORLD_X, 0);
      var maxErr = 0;
      for (var i = 0; i < N; i++) {
        PhysicsEngine.step(jsScene, PhysicsGPU.FIXED_DT);
        maxErr = Math.max(maxErr,
          Math.abs(jsScene.bodies[0].x - trajectory[i][0].x),
          Math.abs(jsScene.bodies[0].y - trajectory[i][0].y));
      }

      // With the bug, the GPU body started at rest and simply fell: it would
      // still be at its starting x while the JS one had been carried sideways.
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
    "the n-body attraction is a second hand-synced pair of implementations (PhysicsEngine.computeAccelerations and its GLSL port in generateStepOnceGLSL) - exactly the kind of split that has drifted before. Checked over two regimes on purpose: several mutually-attracting bodies IS the n-body problem, i.e. genuinely chaotic, so there the two are compared only over the horizon where float32-vs-float64 rounding hasn't yet been amplified into visibility (measured: they agree to ~3e-5px at step 1 and the gap then grows about 10x per 20 steps, which is the physics, not a porting error). A two-body orbit is integrable rather than chaotic, so that one is held to the same tight bound for 300 steps and catches any slow, systematic disagreement the short run would miss.",
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
          gravity: 800, mutualGravity: true, friction: 0, restitution: 1,
          bodies: [
            PhysicsEngine.createCircle(300, 300, 40, false),
            PhysicsEngine.createCircle(700, 320, 25, false),
            PhysicsEngine.createCircle(500, 640, 60, true),
            PhysicsEngine.createLine(760, 620, 120, 0.4, false),
          ],
          hinges: [],
        };
      }
      // Two bounds rather than one: an EARLY one, tight, before four-body
      // chaos has had time to amplify float32-vs-float64 rounding at all, and
      // a late one that only has to catch gross divergence. Measured here,
      // the gap is 2.7e-5px at step 1 growing to 2.9e-2px by step 40 - the
      // early number is what actually tests whether the port is faithful,
      // and a real mismatch (the df speed cap left out of sync, say) showed
      // up as ~100px, three orders clear of even the loose bound.
      var cScene = chaotic(), cTraj = PhysicsGPU.runSceneOnGPU(chaotic(), 40), cStepped = { n: 0 };
      var cEarlyErr = 0, cErr = 0;
      [1, 5].forEach(function (t) { cEarlyErr = Math.max(cEarlyErr, maxErrAt(cScene, cTraj, t, cStepped)); });
      cErr = cEarlyErr;
      [20, 40].forEach(function (t) { cErr = Math.max(cErr, maxErrAt(cScene, cTraj, t, cStepped)); });
      var cMoved = Math.abs(cScene.bodies[0].x - 300) + Math.abs(cScene.bodies[1].x - 700);

      // Regime 2: one free body swinging around one anchored one, long horizon.
      // Deliberately a WIDE orbit, closest approach ~234px against a contact
      // distance of 39px. An orbit that grazes contact is no use here: bodies
      // in contact exert no mutual gravity (see computeAccelerations), so a
      // grazing orbit crosses that switch every lap and which side a given
      // step lands on is decided by the last bit of the float - the two
      // implementations then diverge chaotically for reasons that have
      // nothing to do with whether the port is faithful. Measured: the orbit
      // this test used to use dipped to 70.5px inside a 75px contact and
      // spent 18 steps there, and disagreed by 62px as a result.
      function orbit() {
        var s = {
          gravity: 800, mutualGravity: true, friction: 0, restitution: 1,
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
      // Both halves must have actually gone somewhere, so "agrees that nothing
      // happened" can't pass.
      var oMoved = Math.abs(oScene.bodies[0].x - 500) + Math.abs(oScene.bodies[0].y - 300);

      // The orbit's bound is 0.5px rather than the chaotic case's 0.01px, and
      // deliberately so: this orbit peaks at ~1500px/s, which used to be
      // clamped to MAX_SPEED. That clamp was a contraction - it forced both
      // implementations onto exactly the same value every time it fired, and
      // so hid their float32-vs-float64 difference. With the Mutual Gravity
      // ceiling raised the orbit runs uncapped and the two drift apart on
      // their own merits: measured 1e-5px at step 1, growing smoothly and
      // then levelling off around 2e-1 by step 200 rather than running away.
      // Sub-pixel over 300 steps of a 426px orbit is agreement, not a bug;
      // a porting error shows up as a large error immediately, which is what
      // the 40-step chaotic bound above is tight enough to catch.
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
    "the one rule that isn't plain Newton - anchored bodies have mass 0 in the solver (that IS how 'immovable' is spelled), so gravitational mass has to come from the shape instead, with the 10x applied",
    function () {
      function pullOn0(secondAnchored) {
        var scene = {
          gravity: 800, mutualGravity: true, friction: 0, restitution: 1,
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
        gravity: 800, mutualGravity: true, friction: 0, restitution: 1,
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
        gravity: 800, friction: 0, restitution: 1,
        bodies: [PhysicsEngine.createCircle(400, 100, 30, false)],
        hinges: [],
      };
      var STEPS = 10;
      for (var i = 0; i < STEPS; i++) PhysicsEngine.step(scene, DT);
      // Free fall from rest: v = g*t exactly, with no sideways component.
      var wantVy = 800 * DT * STEPS;
      return {
        pass: Math.abs(scene.bodies[0].vy - wantVy) < 1e-9 && scene.bodies[0].vx === 0 && scene.bodies[0].x === 400,
        detail: "after " + STEPS + " steps: vy=" + scene.bodies[0].vy.toFixed(6) + " (want " + wantVy.toFixed(6) +
          "), vx=" + scene.bodies[0].vx + ", x=" + scene.bodies[0].x + " (want unmoved sideways)",
      };
    }
  );

  addTest(
    "Mutual Gravity: touching bodies merge and thereafter move as one",
    "bodies under Mutual Gravity no longer bounce off each other - they accrete, which is what an n-body simulation does with a collision. This replaces a test that pinned the old bouncing behaviour. The reason for the change is that contact plus a field ~20x ordinary gravity is the one regime this engine cannot integrate: the contact solver's positional correction moves bodies without touching their velocity, which in a field that steep is work done from nothing, and it pumped a body arriving at 165px/s into a surface-skimming orbit at ~1000px/s",
    function () {
      function c(x) {
        return { type: "circle", x: x, y: 300, angle: 0, radius: 30, vx: 0, vy: 0, w: 0, isAnchored: false };
      }
      var scene = {
        gravity: 800, mutualGravity: true, friction: 0, restitution: 1,
        bodies: [c(350), c(650)], hinges: [],
      };
      scene.bodies.forEach(PhysicsEngine.computeMass);
      var a = scene.bodies[0], b = scene.bodies[1];
      var contact = a.radius + b.radius;

      var touchedAt = null, maxSepAfterTouch = 0, maxRelSpeedAfterTouch = 0;
      for (var i = 0; i < 1200; i++) {
        PhysicsEngine.step(scene, DT);
        var sep = Math.hypot(b.x - a.x, b.y - a.y);
        if (touchedAt === null && sep <= contact) touchedAt = i;
        // Measured from the step AFTER they meet: the arrival step itself
        // still carries the closing speed they came in with, which the merge
        // is in the middle of absorbing.
        if (touchedAt !== null && i > touchedAt) {
          maxSepAfterTouch = Math.max(maxSepAfterTouch, sep);
          maxRelSpeedAfterTouch = Math.max(maxRelSpeedAfterTouch, Math.hypot(b.vx - a.vx, b.vy - a.vy));
        }
      }
      // Released from rest and symmetric, so the merged pair's momentum is
      // zero: they should meet and simply stop, never separating again.
      return {
        pass: touchedAt !== null && maxSepAfterTouch <= contact + 0.5 && maxRelSpeedAfterTouch < 1,
        detail: "met at step " + touchedAt + "; over the following " + (1200 - touchedAt) +
          " steps they never parted by more than " + maxSepAfterTouch.toFixed(2) +
          "px (they touch at " + contact + ") and their relative speed stayed under " +
          maxRelSpeedAfterTouch.toFixed(3) + "px/s - they are one object",
      };
    }
  );

  addTest(
    "Mutual Gravity: a merge conserves momentum",
    "merging is a perfectly inelastic collision, so the pair has to come away with the momentum-weighted velocity - the GLSL port writes this using the reciprocal masses it carries rather than forming a mass, so it is worth pinning the arithmetic",
    function () {
      // A small fast body into a big stationary one, far from anything else,
      // with the frame off so nothing wraps.
      var scene = {
        gravity: 0, mutualGravity: true, friction: 0, restitution: 1,
        bodies: [
          PhysicsEngine.createCircle(0, 0, 15, false),
          PhysicsEngine.createCircle(200, 0, 45, false),
        ],
        hinges: [],
      };
      var a = scene.bodies[0], b = scene.bodies[1];
      a.vx = 400;
      var pBefore = a.mass * a.vx + b.mass * b.vx;
      var expected = pBefore / (a.mass + b.mass);
      for (var i = 0; i < 200; i++) PhysicsEngine.step(scene, DT);
      var pAfter = a.mass * a.vx + b.mass * b.vx;
      var relSpeed = Math.hypot(b.vx - a.vx, b.vy - a.vy);
      return {
        pass: Math.abs(a.vx - expected) < 1 && Math.abs(b.vx - expected) < 1 &&
          Math.abs(pAfter - pBefore) / Math.abs(pBefore) < 0.01 && relSpeed < 1,
        detail: "common velocity " + a.vx.toFixed(2) + " / " + b.vx.toFixed(2) + " (want " +
          expected.toFixed(2) + "), momentum " + pBefore.toExponential(3) + " -> " +
          pAfter.toExponential(3) + ", relative speed " + relSpeed.toFixed(3),
      };
    }
  );

  addTest(
    "Mutual Gravity's merge leaves hinged assemblies free to move",
    "a hinged pair overlaps at its shared pivot permanently, so welding anything that overlaps would freeze every pendulum solid the moment Mutual Gravity was switched on. The merge skips exactly the pairs collision detection skips - hinge-joined, and two anchored bodies",
    function () {
      // Needs a third body to pull on it: under Mutual Gravity there is no
      // "down", and two hinged links on their own only attract each other
      // along the hinge, which the hinge cancels - such a pendulum sits
      // still for entirely legitimate reasons and would pass this test
      // whether or not the merge had frozen it.
      var scene = {
        gravity: 800, mutualGravity: true, friction: 0, restitution: 1,
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
      // What a weld would destroy is the links' freedom to move RELATIVE to
      // each other - the assembly as a whole could still swing on its world
      // hinge even if the two links had been fused.
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
          maxAngleChange.toFixed(3) + " rad over 300 steps (a weld would hold it at 0)",
      };
    }
  );

  addTest(
    "The speed cap is raised for Mutual Gravity and unchanged for ordinary gravity",
    "reported as an orbit dropping to a lower one on its first pass and then looking correct forever after. The cause was MAX_SPEED: a close perihelion legitimately needs ~2000px/s, and clamping it to 1000 deleted that energy once - after which the smaller orbit never reached the cap again, which is why it then looked stable. Raised only for Mutual Gravity, so every existing downward-gravity scene, and every fractal image already rendered from one, is untouched",
    function () {
      var plain = PhysicsEngine.speedCapFor({ mutualGravity: false });
      var mutual = PhysicsEngine.speedCapFor({ mutualGravity: true });

      // A body under ordinary gravity must still be held at the old ceiling.
      var falling = {
        gravity: 800, friction: 0, restitution: 1,
        bodies: [PhysicsEngine.createCircle(500, 0, 20, false)], hinges: [],
      };
      falling.bodies[0].vy = 100000; // absurd, purely to drive it into the clamp
      PhysicsEngine.step(falling, DT);
      var plainClamped = Math.hypot(falling.bodies[0].vx, falling.bodies[0].vy);

      // The same absurd speed under Mutual Gravity clamps to the higher one.
      var orbiting = {
        gravity: 800, mutualGravity: true, friction: 0, restitution: 1,
        bodies: [PhysicsEngine.createCircle(500, 0, 20, false)], hinges: [],
      };
      orbiting.bodies[0].vy = 100000;
      PhysicsEngine.step(orbiting, DT);
      var mutualClamped = Math.hypot(orbiting.bodies[0].vx, orbiting.bodies[0].vy);

      return {
        pass: plain === 1000 && mutual === 5000 &&
          Math.abs(plainClamped - 1000) < 1e-6 && Math.abs(mutualClamped - 5000) < 1e-6,
        detail: "ordinary gravity caps at " + plain + " (a body launched at 100000 came out at " +
          plainClamped.toFixed(1) + "), Mutual Gravity at " + mutual + " (came out at " +
          mutualClamped.toFixed(1) + ")",
      };
    }
  );

  addTest(
    "Mutual Gravity: an orbit clear of the surface is a closed Kepler ellipse",
    "reported as an orbit coming out 'a very different shape' from what Kepler predicts. Widening MUTUAL_GRAVITY_SOFTENING for the bounce had put a flattened, non-inverse-square region around every body, and an orbit dipping into one precesses instead of closing - 177 degrees per lap on the reported scene. This pins the property that matters: an orbit that stays clear of the bodies themselves must close, lap after lap, at the distance Kepler says",
    function () {
      // Started 500px out at 300px/s tangential - a wide, ordinary ellipse
      // whose closest approach is nowhere near either surface.
      var scene = {
        gravity: 800, mutualGravity: true, friction: 0, restitution: 1,
        bodies: [
          PhysicsEngine.createCircle(1000, 400, 9, false),
          PhysicsEngine.createCircle(500, 400, 30, true),
        ],
        hinges: [],
      };
      scene.bodies[0].vy = 300;

      // Closed form for these initial conditions, from the same constants the
      // engine uses - so this compares against Kepler, not against itself.
      var mu = PhysicsEngine.MUTUAL_GRAVITY_CONSTANT * PhysicsEngine.gravitationalMass(scene.bodies[1]);
      var r0 = 500, v0 = 300, L = r0 * v0;
      var E = v0 * v0 / 2 - mu / r0;
      var semiMajor = -mu / (2 * E);
      var ecc = Math.sqrt(Math.max(0, 1 + 2 * E * L * L / (mu * mu)));
      var keplerPeri = semiMajor * (1 - ecc);

      // Record each perihelion: how far out, and in which direction it lies.
      // A closed ellipse repeats both; a rosette keeps the distance and walks
      // the direction round.
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
    "the softening that fixed the bounce works by flattening the force near contact, so it has to be checked that it flattens ONLY there - a scene whose bodies orbit rather than collide must be completely unaffected by it",
    function () {
      function pullAt(sep) {
        function c(x) {
          return { type: "circle", x: x, y: 0, angle: 0, radius: 30, vx: 0, vy: 0, w: 0, isAnchored: false };
        }
        var scene = { gravity: 800, mutualGravity: true, friction: 0, restitution: 1,
                      bodies: [c(0), c(sep)], hinges: [] };
        scene.bodies.forEach(PhysicsEngine.computeMass);
        return PhysicsEngine.computeAccelerations(scene)[0].x;
      }
      // Halving the distance must quadruple the pull, everywhere the two
      // bodies are not touching.
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
    "reported as a ball that bounced, stopped, and then whipped round the anchored body at rising speed. A body at rest sits a fraction of a pixel inside the surface, and the contact solver's positional correction pushes it out WITHOUT changing its velocity - free work, done in a field of ~19,600px/s^2 right at contact. Gravity turned it back into speed, the body drove deeper, the correction pushed harder: energy climbed on 401 of 900 steps. Bodies in contact now exert no mutual gravity, which is also the honest reading (the contact normal force is what answers the attraction, and the solver already supplies it)",
    function () {
      // The exact reported scene: a free circle released far from an
      // anchored one, left to fall in, bounce, and settle.
      var scene = {
        gravity: 970, mutualGravity: true, friction: 0, restitution: 1,
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
        // Potential matching the force law: 1/r while they are apart, and
        // flat once touching, since there is no force there to integrate.
        var u = r >= contact ? -k / r : -k / contact;
        return 0.5 * ball.mass * (ball.vx * ball.vx + ball.vy * ball.vy) + u;
      }
      // What matters is that it SETTLES rather than winding up: the runaway
      // showed as speed climbing without bound long after the bounces were
      // over. So compare the second half of the run against the first - a
      // pump makes the late half the faster one.
      var earlyPeak = 0, latePeak = 0;
      for (var i = 0; i < 900; i++) {
        PhysicsEngine.step(scene, DT);
        var speed = Math.hypot(ball.vx, ball.vy);
        if (i < 450) earlyPeak = Math.max(earlyPeak, speed);
        else latePeak = Math.max(latePeak, speed);
      }
      var finalSep = Math.hypot(ball.x - anchor.x, ball.y - anchor.y);
      var finalSpeed = Math.hypot(ball.vx, ball.vy);
      // Before the fix: it ended lodged at 57.4px INSIDE the 60px contact,
      // doing 1110px/s and still climbing, with a late peak far above the
      // early one.
      return {
        pass: finalSpeed < 100 && finalSep >= 59.5 && latePeak < earlyPeak,
        detail: "after 900 steps: resting " + finalSep.toFixed(1) + "px apart (they touch at 60) at " +
          finalSpeed.toFixed(0) + "px/s; fastest in the first half " + earlyPeak.toFixed(0) +
          "px/s vs the second half " + latePeak.toFixed(0) +
          "px/s (a pump makes the second half faster - it used to end at 57.4px doing 1110px/s and rising)",
      };
    }
  );

  addTest(
    "Bounce Count counts contact episodes, not steps spent in contact",
    "PhysicsEngine.runBounceCounts - a body resting or sliding on a surface is touching for hundreds of consecutive steps, which a naive per-step tally would report as hundreds of bounces for what is visibly one",
    function () {
      var scene = {
        gravity: 800, friction: 0.4, restitution: 0,
        bodies: [
          { type: "circle", x: 400, y: 200, angle: 0, isAnchored: false, radius: 20, vx: 0, vy: 0, w: 0 },
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
        detail: "inelastic ball settling on a floor: " + touchingSteps + " of " + STEPS +
          " steps in contact, reported as " + total + " bounce(s) (want a handful, not ~" + touchingSteps +
          "); running totals monotonic=" + monotonic,
      };
    }
  );

  addTest(
    "A body with nothing to collide with never registers a bounce",
    "PhysicsEngine.step's contactFlags must be rewritten each step, not accumulated - a stale true would make every later step read as still-touching",
    function () {
      var scene = {
        gravity: 800, friction: 0, restitution: 1,
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
    "measuring the gain as \"do neighbouring pixels differ\" counts quantization noise as detail - it overstated this by ~3 decades",
    function () {
      // The metric that matters is agreement with PhysicsEngine (float64),
      // which is the answer both shaders are approximating - not whether
      // adjacent pixels happen to differ at all. Noise decorrelates from
      // the truth; real signal doesn't.
      //
      // samples/double_pendulum.json, hardcoded: an angle-linked, hinged,
      // genuinely sensitive scene is where this distinction bites hardest,
      // and the exact numbers matter (body 0's -pi/2 rest angle in
      // particular), so this can't be a hand-approximated stand-in.
      var scene = {
        gravity: 800, friction: 0, restitution: 1,
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
      // Searched rather than hardcoded: exactly where float32 gives out
      // depends on the scene's own sensitivity, and a magic constant here
      // would silently stop testing anything if the sample were retuned.
      var collapsedWidth = null;
      var widths = [3e-5, 1e-5, 3e-6];
      for (var w = 0; w < widths.length && collapsedWidth === null; w++) {
        if (distinct(rowAt(widths[w], "f32")) === 1) collapsedWidth = widths[w];
      }
      if (collapsedWidth === null) {
        return { pass: false, detail: "float32 never collapsed to a single value across " + widths.join(", ") + " - this test can no longer tell the two apart" };
      }
      var dfCorr = correlation(rowAt(collapsedWidth, "df"), rowAt(collapsedWidth, "cpu"));
      // 0.5 is the floor this has to clear. With the df solver in place it
      // reaches 1.000 here - the interesting question became "how much
      // further down", but answering that inside the suite costs another
      // ~30 shader compiles and this page is already close to the
      // browser's live-WebGL-context ceiling (see runFloatShader), so that
      // sweep is a manual measurement rather than a test.
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
          gravity: 800, edgeMode: mode, friction: 0, restitution: 1,
          bodies: [PhysicsEngine.createCircle(500, 400, 20, false)],
          hinges: [], frameWidth: 900, frameHeight: 600,
        };
        for (var i = 0; i < 200; i++) PhysicsEngine.step(scene, DT);
        return scene.bodies[0].y;
      }
      var sticky = fallFor("sticky"), wrap = fallFor("wrap"), infinite = fallFor("infinite");
      // An unspecified mode must behave as it always did, so old scenes and
      // old JSON keep working.
      var legacy = fallFor(undefined);
      return {
        pass: sticky < 600 && wrap < 600 && infinite > 600 &&
          Math.abs(sticky - wrap) < 1e-9 && Math.abs(legacy - sticky) < 1e-9,
        detail: "after 200 steps of free fall in a 600-tall frame: sticky y=" + sticky.toFixed(1) +
          ", wrap y=" + wrap.toFixed(1) + " (both wrapped back inside), infinite y=" + infinite.toFixed(1) +
          " (kept going); an unset mode falls exactly where sticky does",
      };
    }
  );

  addTest(
    "Infinite Space: JS engine and GPU compiler agree",
    "turning the wrap off is a change in the generated shader as well as the engine - the GPU path stops being handed a frame, so this checks the two still walk together once bodies are far outside it",
    function () {
      function build() {
        var s = {
          gravity: 800, edgeMode: "infinite", friction: 0, restitution: 1,
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
      // Must actually have left the frame, or this would be agreeing about a
      // scene that never exercised the change.
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
    "the other two edge modes settle a body's STARTING position back into the frame with a mod(), so sweeping the X/Y Input far enough cycles it through the frame over and over. Infinite Space has no frame to settle into, so the mapping is linear instead - and the two implementations of that settle (generateGridInitialStateGLSL's GLSL and computeOffsetSceneNumeric's JS) have to skip it together, or the hover preview would show a different starting scene from the pixel it is previewing",
    function () {
      function base(mode) {
        return {
          gravity: 0, mutualGravity: false, friction: 0, restitution: 1,
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

      // The GPU's own starting state for the same pixel. Gravity is off, so
      // the first logged step is still the starting position.
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
    "Infinite Space's output curve keeps every distance inside the colour range",
    "with nothing wrapping a coordinate back into the frame there is no range to divide it into: mod() would report a body two frames out as barely off-centre, and a plain divide would run past 1 and off the end of the colours. The sigmoid squashes the whole infinite line into [0,1]",
    function () {
      var f = PhysicsEngine.frameSigmoid;
      // The worked example this was specified with: a 100-tall scene whose
      // body ends at y=200 is v=2, and must come out near 0.9995 rather than
      // the 2 a plain divide would give.
      var worked = f(200 / 100);
      var centre = f(0.5), top = f(0), bottom = f(1);
      // Monotonic and bounded however far out it is asked about.
      var monotonic = true, bounded = true, prev = -Infinity;
      for (var v = -50; v <= 50; v += 0.25) {
        var y = f(v);
        if (y < prev) monotonic = false;
        if (!(y >= 0 && y <= 1)) bounded = false;
        prev = y;
      }
      return {
        pass: Math.abs(worked - 0.9995) < 5e-4 && Math.abs(centre - 0.5) < 1e-12 &&
          monotonic && bounded && top > 0 && bottom < 1,
        detail: "two frames out -> " + worked.toFixed(4) + " (spec said ~0.9995); frame centre -> " +
          centre.toFixed(4) + ", its edges -> " + top.toFixed(4) + " and " + bottom.toFixed(4) +
          "; monotonic and inside [0,1] across ±50 frames=" + (monotonic && bounded),
      };
    }
  );

  addTest(
    "Off-screen pointers sit on the frame edge and fade to nothing at it",
    "PhysicsHingeGeometry.offscreenPointer - where the arrow marking a body that has left the view goes, shared by the editor's playback and the fractal grid's replay panel. Two properties matter: the tip is exactly where the line from the frame's centre crosses the edge, and the length reaches zero as the body arrives at that edge, so the arrow shrinks away instead of popping out of existence when the body comes back on screen",
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

      // Length: continuous to zero at the edge, monotonic, and bounded no
      // matter how far out Infinite Space puts the body.
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

  // ---- Funnel: mouth teleports a circle to the throat, legs/throat bounce
  // it like a line. Supported so far only in Pac-Man edge mode with
  // standard (non-mutual) gravity - see physics-engine.js's Funnel header
  // comment. ----

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
    "the mouth (length-3 side) is a teleport trigger, not a wall - see collideFunnelMouthTHit and step()'s teleportWins handling",
    function () {
      // Funnel at angle 0: mouth (wide) faces -y (up), throat (narrow) faces
      // +y (down) - a ball dropped on the mouth's centerline should fall
      // through and reappear at the throat's centerline, still falling.
      var scene = {
        gravity: 800, friction: 0, restitution: 1,
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
      // "Velocity unchanged" through the teleport itself: vy should still be
      // the same smooth, gravity-advancing sequence across the jump, not
      // reflected (which would flip its sign) or reset (which would drop it
      // back near 0).
      var velocityContinuous = teleportStep >= 0 && vyAfter > vyBefore - 1 && vyAfter < vyBefore + 20;
      var detail = "teleport detected at step " + teleportStep + ": y " + (yBefore && yBefore.toFixed(2)) +
        " -> " + (yAfter && yAfter.toFixed(2)) + " (throat center y=" + edges.throatCenter.y.toFixed(2) +
        "), vy " + (vyBefore && vyBefore.toFixed(2)) + " -> " + (vyAfter && vyAfter.toFixed(2)) + " (should be continuous, not reflected)";
      return { pass: teleportStep >= 0 && reachedThroat && velocityContinuous, detail: detail };
    }
  );

  addTest(
    "A circle hitting the middle of a funnel's leg bounces like a line, without teleporting",
    "the 2 legs (and the throat) are solid capsule colliders (see collideFunnelCircle) - only the mouth teleports",
    function () {
      // Funnel at angle 0 (mouth up at y=348.04, throat down at y=451.96);
      // leg2 runs from the mouth corner (490, 348.04) to the throat corner
      // (430, 451.96). The ball starts well INSIDE the funnel's vertical
      // span (y=400, more than a capsule-width below the mouth line, so it
      // can never be mistaken for touching the mouth) and just inside leg2
      // horizontally (leg2 sits at x=460 at that height) - falling further
      // only closes that gap, since leg2 slants toward smaller x as y
      // grows, so it can only ever hit the flat side of leg2 itself.
      var scene = {
        gravity: 800, friction: 0, restitution: 1,
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
        " (want a bounce off the leg - the ball's path never reaches the mouth)";
      return { pass: bounced && !teleported, detail: detail };
    }
  );

  addTest(
    "A rotated, anchored funnel teleports along its own rotated axis, not the world axis",
    "getFunnelEdges/collideFunnelMouthTHit rotate every vertex by body.angle - a scene with angle=0 in every other test would not catch a sign/axis error here",
    function () {
      var angle = Math.PI / 2; // mouth now faces -x instead of -y
      var scene = {
        gravity: 0, friction: 0, restitution: 1,
        bodies: [
          PhysicsEngine.createFunnel(400, 400, 120, angle, true),
          PhysicsEngine.createCircle(400, 400, 10, false),
        ],
        hinges: [], frameWidth: 1200, frameHeight: 900, edgeMode: "wrap",
      };
      // Ball starts dead center (already inside the mouth-to-throat gap) and
      // moves toward the rotated mouth direction so it exits there, then
      // should reappear at the rotated throat.
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
        gravity: 800, friction: 0, restitution: 1,
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
          gravity: 800, mutualGravity: false, friction: 0, restitution: 1,
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
          gravity: 800, mutualGravity: false, friction: 0, restitution: 1,
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
    "Compiling a funnel scene in double-float mode fails loudly instead of emitting wrong GLSL",
    "the funnel GLSL functions (sweptCapsuleCircleContact, collideFunnelMouthTHit, etc.) exist only in float32 - generateStepOnceGLSL must throw in df mode rather than reference undefined df functions or silently drop the funnel's physics",
    function () {
      var scene = {
        gravity: 800, friction: 0, restitution: 1,
        bodies: [
          PhysicsEngine.createFunnel(400, 400, 120, 0, true),
          PhysicsEngine.createCircle(400, 250, 10, false),
        ],
        hinges: [],
      };
      var threw = false, message = "";
      try {
        PhysicsGPU.compileSceneToTrajectoryGLSL(scene, 5, "df");
      } catch (err) {
        threw = true;
        message = err && err.message || String(err);
      }
      var detail = threw ? ("threw as expected: " + message) : "did NOT throw - a df compile of a funnel scene silently produced something";
      return { pass: threw, detail: detail };
    }
  );

  // ---- Splitter: the short side turns one circle into two on the long
  // side, each keeping the parent's velocity, and Output then tracks the
  // AVERAGE over that lineage. Same trapezoid as a funnel, opposite trigger
  // edge - see physics-engine.js's createSplitter. ----

  // The reported worked example, exactly: a length-1 short side hit 0.75 of
  // the way along it, against a length-3 long side, must put one ball 0.75
  // from its own edge and the other 0.25 from its own edge - landing them
  // exactly 2 units apart. size=120 makes "1 unit" 60px (throat = size/2,
  // mouth = 3*size/2, legs = size), and angle=PI turns the short side to
  // face the falling ball.
  function buildSplitterScene(ballX, ballRadius) {
    return {
      gravity: 800, mutualGravity: false, friction: 0, restitution: 1,
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
      // throat[0] is at x=430 with the throat 60px (1 unit) long, so 0.75 of
      // the way along it is x = 430 - 45 = 385.
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
    "\"They each have the same velocity as the initial ball\" - the split is a position/identity event, never an impulse",
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
      // One step of gravity (the step the split happened on) separates the
      // children's velocity from the pre-step reading, and nothing else may.
      var expectedVy = beforeV.vy + 800 * DT;
      var carriedThrough = Math.abs(split[0].vy - expectedVy) < 1e-6 && Math.abs(split[0].vx - beforeV.vx) < 1e-9;
      var detail = "children v=(" + split[0].vx.toFixed(3) + "," + split[0].vy.toFixed(3) + ") and (" +
        split[1].vx.toFixed(3) + "," + split[1].vy.toFixed(3) + "); parent entered the step at vy=" +
        beforeV.vy.toFixed(3) + ", so one step of gravity gives " + expectedVy.toFixed(3);
      return { pass: sameAsEachOther && carriedThrough, detail: detail };
    }
  );

  addTest(
    "Output tracks the AVERAGE over a split lineage, and that average is continuous through the split",
    "computeOutputLineageAverage / lineageOf - the whole point of the mapping surviving a body becoming two",
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
      // The two spawn points sit symmetrically about the hit point along the
      // parallel sides' shared direction, so the averaged X doesn't jump at
      // the instant the lineage goes from one ball to two.
      var lineageMembers = scene.bodies.filter(function (b, idx) { return PhysicsEngine.lineageOf(scene, idx) === 1; }).length;
      var detail = "averaged X " + beforeX.toFixed(4) + " (over " + beforeCount + " ball) -> " +
        afterX.toFixed(4) + " (over " + afterCount + "), lineage 1 now has " + lineageMembers + " members";
      return { pass: Math.abs(afterX - beforeX) < 1e-6 && lineageMembers === 2 && afterCount === 2, detail: detail };
    }
  );

  addTest(
    "A splitter's long side and legs bounce like a funnel's - only the short side splits",
    "collideSplitterCircle covers mouth + both legs; a ball arriving at the long side must not spawn anything",
    function () {
      // Default angle (0) puts the LONG side up, so a ball dropped from
      // above meets the long side, which is solid here (the mirror image of
      // the funnel, where the long side is the special one).
      var scene = {
        gravity: 800, mutualGravity: false, friction: 0, restitution: 1,
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
      var detail = "after 60 steps: bodies=" + scene.bodies.length + " (want 2 - no split), bounced off the long side=" + bounced;
      return { pass: scene.bodies.length === 2 && bounced, detail: detail };
    }
  );

  addTest(
    "Splitting is recursive: a ball produced by a split can split again",
    "each half keeps its lineage and is an ordinary circle afterward, so nothing special-cases it out of the next splitter it meets",
    function () {
      // Two splitters stacked: the upper one splits the dropped ball, and
      // the lower one (offset under one of the two halves) splits that half
      // again - 1 -> 2 -> 3 balls, all in lineage 1.
      var scene = {
        gravity: 800, mutualGravity: false, friction: 0, restitution: 1,
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

  // ---- Output mappings that read TWO bodies: the average of a pair, and
  // the distance between them. See PhysicsEngine.computeOutputValue. ----

  function twoBallScene(edgeMode, ax, ay, bx, by) {
    var scene = {
      gravity: 800, friction: 0, restitution: 1, edgeMode: edgeMode,
      frameWidth: 800, frameHeight: 600, hinges: [],
      bodies: [PhysicsEngine.createCircle(ax, ay, 10, false), PhysicsEngine.createCircle(bx, by, 10, false)],
    };
    scene.bodies.forEach(PhysicsEngine.computeMass);
    return scene;
  }

  addTest(
    "A two-body Output averages the pair, and a one-body Output still reads exactly what it always did",
    "PhysicsEngine.computeOutputValue is the single definition of what an Output means - physics-ui.js's playback colour, fractal-grid.js's instant preview and the grid shader's GLSL are all written against it, so the one-body case has to come through it completely unchanged or every existing scene shifts colour",
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
    "without this, a Pac-Man scene's distance Output jumps the width of the frame the instant either body crosses an edge - for a pair that never actually moved apart. That is a discontinuity in the exact quantity the grid is a picture of, and on a toroidal world the shortest separation IS the distance. Infinite Space has no edges to go round, so there it stays the plain one.",
    function () {
      // 100 and 700 on an 800-wide frame: 600 apart the long way, 200 the short way.
      var wrapped = PhysicsEngine.computeOutputValue(twoBallScene("wrap", 100, 300, 700, 300), { body: 0, bodyB: 1, property: "distance" });
      var sticky = PhysicsEngine.computeOutputValue(twoBallScene("sticky", 100, 300, 700, 300), { body: 0, bodyB: 1, property: "distance" });
      var infinite = PhysicsEngine.computeOutputValue(twoBallScene("infinite", 100, 300, 700, 300), { body: 0, bodyB: 1, property: "distance" });
      // A plain 3-4-5, nowhere near an edge, must be untouched by any of it.
      var plain = PhysicsEngine.computeOutputValue(twoBallScene("infinite", 100, 200, 400, 600), { body: 0, bodyB: 1, property: "distance" });
      // The colour range: the antipode on a torus is HALF a frame per axis.
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
    "each half is its own lineage average FIRST, then the two are averaged - flattening every body into one mean instead would let whichever ball split more times drag the answer toward itself, which is not what \"the average of object 1 and object 2\" means",
    function () {
      var scene = twoBallScene("infinite", 0, 0, 200, 0);
      // A third ball that is a split child of body 0 - same lineage tag the
      // engine's own splitter gives it (see step()'s splitting section).
      var child = PhysicsEngine.createCircle(100, 0, 10, false);
      child.lineage = 0;
      scene.bodies.push(child);
      PhysicsEngine.computeMass(child);
      var got = PhysicsEngine.computeOutputValue(scene, { body: 0, bodyB: 1, property: "x" });
      // lineage 0 averages (0 + 100)/2 = 50; lineage 1 is 200; the pair is 125.
      // A flat mean over all three bodies would be 100 - the bug this pins.
      var flat = (0 + 200 + 100) / 3;
      return {
        pass: Math.abs(got - 125) < 1e-9,
        detail: "pair average = " + got + " (want 125 - lineage 0 averages to 50, lineage 1 is 200); a flat mean over all three bodies would give " + flat.toFixed(1),
      };
    }
  );

  addTest(
    "Output survives a Play/Reset round trip with its second body intact",
    "PhysicsEngine.cloneScene is what physics-ui.js round-trips the live scene through on every Play and Reset - an omitted field there silently resets mid-edit, which is how simulationSteps and edgeMode each got lost once, and a dropped bodyB would quietly turn a pair Output back into a one-body one",
    function () {
      var scene = twoBallScene("wrap", 100, 200, 700, 500);
      scene.output = { body: 0, bodyB: 1, property: "distance" };
      scene.xInput = null; scene.yInput = null;
      var round = PhysicsEngine.cloneScene(scene);
      var kept = round.output && round.output.bodyB === 1 && round.output.property === "distance";
      // And a one-body Output must come back as a one-body Output, not as a
      // pair whose second half is some coerced 0.
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
    "Scene Lifespan is `{ body: null, property: \"lifespan\" }` and \"lifespan\" is deliberately in neither body-property list - so a guard that re-picked an out-of-list property rewrote it to \"x\" while body stayed null, leaving a mapping naming no body AND no run tally. The fractal page could only report that as \"missing an Output mapping\" even though one was plainly there, which is how picking Scene Lifespan broke that page.",
    function () {
      var E = PhysicsEngine, N = 3;
      var good = [
        ["scene lifespan", { body: null, bodyB: null, property: "lifespan" }],
        ["lifespan, no bodyB key at all", { body: null, property: "lifespan" }],
        ["one body", { body: 1, bodyB: null, property: "y" }],
        ["legacy one body", { body: 1, property: "y" }],
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
    "fractal-grid.js's instant hover preview asked for `body.length / 2`, and a funnel/splitter has no `length` at all - undefined/2 is NaN, and a NaN coordinate makes canvas draw nothing silently. Reported as \"the preview doesn't show the funnel or splitter until the replay loads\": the GPU trajectory carries a real half in its alpha channel, so the shape appeared the moment the replay took over. Both paths read PhysicsGPU.shapeHalf now, so they cannot disagree again.",
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
    "A trapezoid's outline can be rebuilt from just (x, y, angle, half) - what the hover preview draws from",
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
        detail: "worst corner disagreement " + worst.toFixed(12) + "px across all four corners (want 0 - the rebuilt outline IS the collided one)",
      };
    }
  );

  addTest(
    "A ball entering a splitter off-centre isn't bounced by the splitter it's passing through",
    "a splitter's mouth and legs are solid, and their capsules reach LINE_THICKNESS/2 PAST the short side's own corners - so a ball entering anywhere near a corner clips a leg end-cap on the very step it splits, and the split then carries that bounce's velocity out with it. Reported as \"the balls come out at weird angles\"; measured, a ball entering 2px from a corner at vy=+373 came out at vy=-332 (reflected backwards) with 102px/s of sideways drift it never had. step() now drops those contacts, exactly as it already did for a funnel teleport.",
    function () {
      // The throat spans x 370..430 at this size/angle, so 372 and 428 are
      // hard against a corner while 400 is dead centre. All of them are
      // dropped straight down, so any vx at all is invented, and vy must
      // stay positive (still heading the way it entered).
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
      // Every entry point must produce the same velocity - the parent's -
      // which for a straight drop means vx exactly 0 and one identical
      // positive vy across all five.
      var vy0 = entries[2].vy; // the dead-centre drop, which never touched a leg
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
    "collideSplitterShortSideTHit returns offsets, not points on the long side - an absolute landing point would discard how far past the short side the ball actually got and replace it with a constant, which is a discontinuity in exactly the variable the fractal grid is a picture of",
    function () {
      // Two balls dropped from slightly different heights cross the short
      // side with different amounts of the step left over, so they sit at
      // different perpendicular depths when the split fires. A translation
      // carries that difference through; a snap onto the long side would
      // collapse both to the same y.
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
    "PhysicsEngine.MAX_SIMULATION_BODIES: the old rule skipped the whole split, leaving the ball behind on the short side. Being at the ceiling is a fact about the scene, not a reason to stop the warp - and `continue` rather than `break`, so a later ball that hit a splitter this same step isn't skipped along with it.",
    function () {
      // One splitter, MAX balls already in the scene: nothing can be added,
      // but the one that reaches the short side must still come out the
      // other side.
      var cap = PhysicsEngine.MAX_SIMULATION_BODIES;
      var scene = buildSplitterScene(385);
      while (scene.bodies.length < cap) {
        // Parked far from the splitter and each other, so they only ever
        // occupy slots.
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
        : "the ball never got past the long side - it was left behind on the short side";
      return { pass: crossed && countAfter === cap, detail: detail };
    }
  );

  addTest(
    "A scene's own maxSimulationBodies caps the run, and the GPU pads to exactly that",
    "the ceiling is a per-scene control (#editor-view's Max Objects), not a constant - and it decides the compiled shader's whole size, so the JS engine's ball count and the GPU's slot count have to come from the same number or the grid renders a different scene than it plays back",
    function () {
      function cascade(cap) {
        var scene = {
          gravity: 800, mutualGravity: false, friction: 0, restitution: 1,
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
      // The uncapped run has to grow PAST both low caps, or neither of them
      // proves anything - "stopped at 5" and "ran out of splits at 4" look
      // identical otherwise. It is NOT asserted to reach the default
      // ceiling exactly: this cascade runs out of splitters to fall through
      // before it gets there, which is a fact about the scene, not the cap.
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
    "maxSimulationBodies is clamped, never trusted - and survives a Play/Reset round trip",
    "it arrives from hand-edited JSON and from a slider, and PhysicsEngine.cloneScene is what physics-ui.js round-trips the live scene through on every Play and Reset - an omission there silently resets the ceiling mid-edit, which is exactly how simulationSteps and edgeMode each got lost once",
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
        gravity: 800, bodies: [], hinges: [], maxSimulationBodies: 6,
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
    "stepOnce() takes 4 parameters per authored body and 6 per spawn slot against GLSL's hard limit of 256 - the slider's own max is set below that for any authorable scene, but a hand-edited scene can ask for more, and the driver's own answer is \"'stepOnce' : Function has too many parameters\" against a line number in generated code",
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
      // The slider's own ceiling must be comfortably inside the limit for
      // the worst scene anyone can author (MAX_BODIES bodies), or the
      // control would offer values that can't compile.
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
    "a split adds a body, which a compiled fixed-body shader cannot do - so PhysicsGPU.padSceneForSplitting pre-allocates spawn slots up to MAX_SIMULATION_BODIES and a split wakes one instead of creating one. This is the check that the two engines' splitting agrees: same trigger step, same two halves, same recursion.",
    function () {
      var STEPS = 90;
      var scene = buildSplitterScene(385);
      var rows = PhysicsEngine.runTrajectory(PhysicsEngine.cloneScene(scene), STEPS, DT);
      var traj = PhysicsGPU.runSceneOnGPU(scene, STEPS);
      // A GPU row is always MAX_SIMULATION_BODIES long (dead slots report
      // half = 0); a JS row grows as splits happen. Compare over whatever
      // the JS engine says is alive at that step.
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
      // The step the GPU first shows a woken slot, found the same way.
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
    "the grid builds each pixel's scene symbolically (generateGridInitialStateGLSL) and hands it to the shared step loop - a different declaration path from compileSceneToTrajectoryGLSL's baked literals, so the spawn slots it emits (and the padding that has to leave every authored body's index alone) need their own check. This is the path the fractal image is actually made of.",
    function () {
      var STEPS = 90, WORLD_X = 12;
      var scene = {
        gravity: 800, mutualGravity: false, friction: 0, restitution: 1,
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
      // The same offset scene this pixel stands for, stepped in JS.
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
        gravity: 800, mutualGravity: false, friction: 0, restitution: 1,
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
      // A trapezoid reports half = size/2 > 0 too, so the two splitters
      // count toward the GPU's "alive" tally the same way they do toward
      // the JS body count.
      var detail = "worst disagreement " + worst.toFixed(5) + "px (at step " + worstAt + "); final bodies: JS " +
        jsFinal + ", GPU " + gpuFinal + " (want equal, and >= 5 - two splitters plus three balls)";
      return { pass: worst < 0.01 && jsFinal === gpuFinal && jsFinal >= 5, detail: detail };
    }
  );

  addTest(
    "Mutual Gravity with a funnel or splitter stays finite (it used to go NaN and hang the tab)",
    "gravitationalMass/halfExtent read body.length, which a trapezoid doesn't have - the NaN that produced made every 'dist >= rsum' test false, so every swept test reported contact, so a splitter split its ball EVERY step and the body count doubled until the tab died (reported as 'when I press play it crashes')",
    function () {
      // The exact reported scene.
      var scene = {
        gravity: 970, mutualGravity: true, friction: 0, restitution: 1,
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
      // A funnel under Mutual Gravity has to stay finite for the same reason,
      // even though it can't multiply bodies.
      var fScene = {
        gravity: 800, mutualGravity: true, friction: 0, restitution: 1,
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
    "A circle sitting against a splitter's short side splits once, not once per step",
    "only a FRESH crossing splits - a circle already inside the trigger capsule at the start of a step would otherwise re-split every step, which is exponential in steps rather than an occasional extra ball",
    function () {
      // Aimed to loiter right at the short side: zero gravity and a crawl,
      // so once it reaches the trigger's capsule it stays inside it for
      // hundreds of consecutive steps. The short side (angle=PI puts it on
      // top) sits at y=348, and the capsule reaches 18px out from it
      // (LINE_THICKNESS/2 + radius), so this enters the trigger around step
      // 150 and is still inside it at step 400.
      var scene = {
        gravity: 0, mutualGravity: false, friction: 0, restitution: 1,
        bodies: [
          PhysicsEngine.createSplitter(400, 400, 120, Math.PI, true),
          PhysicsEngine.createCircle(400, 320, 8, false),
        ],
        hinges: [], frameWidth: 1200, frameHeight: 900, edgeMode: "wrap",
      };
      scene.bodies[1].vy = 4; // ~0.07px per step
      var counts = [];
      for (var i = 0; i < 400; i++) {
        PhysicsEngine.step(scene, DT);
        counts.push(scene.bodies.length);
      }
      var circles = scene.bodies.filter(function (b) { return b.type === "circle"; }).length;
      var detail = "after 400 steps of creeping across the short side: " + circles +
        " circles (want exactly 2 - one split, not one per step); body count went " +
        counts[0] + " -> " + counts[counts.length - 1];
      return { pass: circles === 2, detail: detail };
    }
  );

  // ---- df.N The double-float pass must actually BUY its extra digits ----
  //
  // Not "df runs" (other tests cover that) but "df resolves adjacent PIXELS
  // that float32 cannot" - the one property the whole df path exists for,
  // and the one a single float32 operation anywhere in the chain silently
  // destroys, since precision is set by the weakest link. Measured as: give
  // two neighbouring pixels' world coordinates at a given zoom, and check
  // the simulations actually end up somewhere different.
  //
  // Measured walls for this scene at 500 steps, which is where the bounds
  // below come from: float32 stops distinguishing neighbours between 1e5
  // and 1e6 (~5 ooms, matching what the app reports in practice), df keeps
  // going past 1e12 (~12 ooms - df's ~46-bit significand at this scene's
  // coordinate magnitude of ~700). The assertions sit well inside both
  // walls so this can't go flaky, while still failing loudly if df's
  // advantage collapses back toward float32's.
  addTest(
    "Double-float resolves pixels float32 cannot (guards against a f32 collapse in the df chain)",
    "precision is set by the weakest link: one float32 op anywhere in the df step would cost most of df's ~7 extra digits while every other df test still passed",
    function () {
      function scene() {
        return {
          gravity: 800, friction: 0, restitution: 1,
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
      // One pixel of world distance at `oom` orders of zoom, mirroring the
      // grid's own scale/resolution relationship.
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
        gravity: 0, friction: 0, restitution: 1,
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
    "vx/vy used to be baked as a compile-time literal in generateCanonicalBodyDeclarationsGLSL - a Input link to them would silently do nothing on the actual grid/Play GPU path while still working in computeOffsetSceneNumeric's JS-only hover preview",
    function () {
      var scene = {
        gravity: 300, friction: 0, restitution: 1,
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
      // A scene with NO vx/vy Input at all - the offset should be exactly
      // zero, so this must land on the authored (5, -10) velocity, not on
      // the frozen-at-compile-time value some other regression could leave
      // it at.
      var noInputScene = { gravity: 300, friction: 0, restitution: 1, bodies: [PhysicsEngine.createCircle(500, 300, 20, false)], hinges: [], xInput: null, yInput: null, output: null };
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
    "the Collisions toggle - every detection loop in step() (ordinary contacts, funnel mouth, splitter short side) is gated on PhysicsEngine.collisionsEnabled, and applyContactMerge alongside them",
    function () {
      function scene(collisionsEnabled) {
        var s = {
          gravity: 800, mutualGravity: false, friction: 0, restitution: 1,
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
    "\"objects can pass right through each other\" was read as applying uniformly - a funnel/splitter's solid edges and triggers use the exact same swept detection as an ordinary bounce, so leaving them collidable while turning off everything else would be an inconsistent carve-out",
    function () {
      var funnelScene = {
        gravity: 800, mutualGravity: false, friction: 0, restitution: 1, collisionsEnabled: false,
        bodies: [
          PhysicsEngine.createCircle(400, 250, 10, false),
          PhysicsEngine.createFunnel(400, 400, 120, 0, true),
        ],
        hinges: [], frameWidth: 1200, frameHeight: 900, edgeMode: "wrap",
      };
      for (var i = 0; i < 60; i++) PhysicsEngine.step(funnelScene, DT);
      var noTeleport = funnelScene.bodies.length === 2 && funnelScene.bodies[0].y > 460; // fell straight past the throat, no snap
      // Reuses buildSplitterScene(385) - the exact setup the earlier "becomes
      // two... 0.75/0.25" test already proved DOES split within 60 steps
      // with collisions on, so this is a real negative control, not just an
      // arrangement that happened to never reach the short side at all.
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
    "physics-gpu.js's fix is passing collisionPairs an empty array rather than a flag threaded through generateStepOnceGLSL - this proves that actually reaches the compiled shader, not just the JS engine",
    function () {
      function buildScene() {
        return {
          gravity: 800, mutualGravity: false, friction: 0.4, restitution: 0.2, collisionsEnabled: false,
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
    "Mutual Gravity with collisions off: the pull is continuous across the contact shell, and linear inside it",
    "the touching-bodies rule switched the pull from ~1963px/s^2 to exactly 0 at r=contact. With collisions on that's fine (the contact solver answers for it, and the overlap lasts a step) but with collisions off nothing answers for it and bodies coast through, making the shell a step discontinuity in the field itself. Inside, the pull now follows the uniform-density interior solution G*m*r/contact^3 instead",
    function () {
      function pullAt(r, collisions) {
        var scene = {
          gravity: 0, mutualGravity: true, collisionsEnabled: collisions,
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
      // Continuity at the shell: the two branches must meet there. (The tiny
      // residual is just the 1e-6 probe offset riding the 1/r^2 curve.)
      var jump = Math.abs(outside - inside);
      // Linearity inside: a(r) = k*r means a(r)/r is the same constant at every
      // interior radius. Comparing two interior points tests the ramp itself,
      // with no dependence on where outside the shell the other probe sat.
      var k1 = pullAt(C / 2, false) / (C / 2);
      var k2 = pullAt(C / 4, false) / (C / 4);
      var linearityErr = Math.abs(k1 - k2) / k1;
      var atOrigin = pullAt(1e-9, false); // ramp reaches zero, so no singularity
      var detail = "collisions off: pull just outside=" + outside.toFixed(4) +
        ", just inside=" + inside.toFixed(4) + " (jump=" + jump.toExponential(2) +
        "px/s^2, was ~1963 - the whole bug); interior a(r)/r=" + k1.toFixed(6) + " at r=C/2 and " +
        k2.toFixed(6) + " at r=C/4 (linear ramp, rel err=" + linearityErr.toExponential(2) +
        "); a(1e-9px)=" + atOrigin.toExponential(2) + " (no singularity); collisions ON just inside=" +
        onInside.toFixed(4) + " (want exactly 0, unchanged)";
      return { pass: jump < 1e-3 && linearityErr < 1e-12 && atOrigin < 1e-6 && onInside === 0, detail: detail };
    }
  );

  addTest(
    "Mutual Gravity with collisions off: neighbouring starting states no longer come out a fixed distance apart",
    "reported as 'non-continuousness' on a two-circle scene: two starts 4.7e-5px apart came out 133.9px apart, and bringing them 7 decades closer together did not shrink that gap at all - the signature of a discontinuity rather than chaos. Cause was the contact-shell cutoff above; this pins the outcome rather than the mechanism, so it fails if any future change reintroduces a branch anywhere in this path",
    function () {
      var SCENE = {
        gravity: 800, mutualGravity: true, collisionsEnabled: false, friction: 0, restitution: 1,
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
    "Mutual Gravity with collisions off: JS engine and GPU compiler agree through an overlapping pass",
    "the interior ramp is a second hand-synced pair of implementations (PhysicsEngine.computeAccelerations and its GLSL port in generateStepOnceGLSL). generateStepOnceGLSL learns collisions are off from a new argument rather than from `pairs` being empty, since the Mutual Gravity accel loop walks every body rather than the pair list - this proves that argument is actually threaded through from every caller",
    function () {
      function buildScene() {
        return {
          gravity: 0, mutualGravity: true, collisionsEnabled: false, friction: 0, restitution: 1,
          bodies: [
            PhysicsEngine.createCircle(400, 300, 30, false),
            PhysicsEngine.createCircle(600, 300, 30, false),
          ],
          hinges: [],
        };
      }
      // Aim them straight at each other so they pass well inside contact (60px)
      // and spend several steps on the ramp, where the two ports must agree.
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
      var detail = "closest centre separation=" + minSep.toFixed(2) + "px (contact is 60px, so the ramp was exercised=" +
        wentInside + "); max JS/GPU position error after " + STEPS + " steps=" + maxErr.toFixed(4) + "px";
      return { pass: wentInside && maxErr < 0.05, detail: detail };
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

  function runAll() {
    var tbody = document.querySelector("#results tbody");
    tbody.innerHTML = "";
    var passCount = 0;

    TESTS.forEach(function (t) {
      var outcome;
      try {
        outcome = t.fn();
      } catch (err) {
        outcome = { pass: false, detail: "Threw: " + (err && err.message || err) };
      }
      if (renderRow(tbody, t.name, t.bugRef, outcome)) passCount++;
    });

    updateSummary(passCount, TESTS.length);
  }

  // gridResidualAtPoint and cpuStateAt are exported alongside the runner
  // because measuring this project's precision is an ongoing activity, not
  // a one-off: they are the only two pieces that can compare a shader
  // against the float64 engine without the float32 readback swallowing the
  // answer (see gridResidualAtPoint's own comment). Re-deriving them ad hoc
  // in a console is exactly how a measurement ends up wrong.
  window.__physicsTests = {
    runAll: runAll,
    gridResidualAtPoint: gridResidualAtPoint,
    cpuStateAt: cpuStateAt,
  };
})();
