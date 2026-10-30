// CPAL-1.0 License. See chaosaccelerator.com/license.html

// Per-pixel initial-state codegen for the fractal grid: GLSL that adds a pixel's
// world X/Y to the linked property and applies the editor's hinge-preserving
// cascade (PhysicsHingeGeometry), fully unrolled at codegen time into flat statements.
(function (global) {
  "use strict";

  var PhysicsEngine = global.PhysicsEngine;
  var PhysicsGPU = global.PhysicsGPU;
  var PhysicsHingeGeometry = global.PhysicsHingeGeometry;

  function fnum(n) { return PhysicsGPU.fnum(n); }

  // ---- Precision backends: GLSL expression strings, so f32 and df share one
  // cascade. The offset add here is the 32-bit wall no later precision can undo ----
  var BACKENDS = {
    f32: {
      scalar: "float",
      vecType: "vec2",
      zero: "0.0",
      lit: fnum,
      add: function (a, b) { return "(" + a + ") + (" + b + ")"; },
      sub: function (a, b) { return "(" + a + ") - (" + b + ")"; },
      mul: function (a, b) { return "(" + a + ") * (" + b + ")"; },
      div: function (a, b) { return "(" + a + ") / (" + b + ")"; },
      abs: function (a) { return "abs(" + a + ")"; },
      rotate: function (x, y, angle) { return "rotateVec(vec2(" + x + ", " + y + "), " + angle + ")"; },
      absCos: function (a) { return "abs(cos(" + a + "))"; },
      absSin: function (a) { return "abs(sin(" + a + "))"; },
      mod: function (a, m) { return "mod(" + a + ", " + m + ")"; },
      clamp: function (a, lo, hi) { return "clamp(" + a + ", " + lo + ", " + hi + ")"; },
      greater: function (a, b) { return "(" + a + ") > (" + b + ")"; },
      less: function (a, b) { return "(" + a + ") < (" + b + ")"; },
      toFloat: function (a) { return a; },
      fromFloat: function (a) { return a; },
    },
    // df, tf and qf all spell arithmetic the same way: df names, MF scalar type.
    df: {
      scalar: "MF",
      vecType: "DVec2",
      zero: "MF(0.0)",
      lit: function (n) { return global.PhysicsDF.num(n); },
      add: function (a, b) { return "dfAdd(" + a + ", " + b + ")"; },
      sub: function (a, b) { return "dfSub(" + a + ", " + b + ")"; },
      mul: function (a, b) { return "dfMul(" + a + ", " + b + ")"; },
      div: function (a, b) { return "dfDiv(" + a + ", " + b + ")"; },
      abs: function (a) { return "dfAbs(" + a + ")"; },
      rotate: function (x, y, angle) { return "dfRotate(" + x + ", " + y + ", " + angle + ")"; },
      absCos: function (a) { return "dfAbs(dfCos(" + a + "))"; },
      absSin: function (a) { return "dfAbs(dfSin(" + a + "))"; },
      mod: function (a, m) { return "dfMod(" + a + ", " + m + ")"; },
      clamp: function (a, lo, hi) { return "dfClamp(" + a + ", " + lo + ", " + hi + ")"; },
      greater: function (a, b) { return "dfGreater(" + a + ", " + b + ")"; },
      less: function (a, b) { return "dfLess(" + a + ", " + b + ")"; },
      toFloat: function (a) { return "dfToFloat(" + a + ")"; },
      fromFloat: function (a) { return "dfFromFloat(" + a + ")"; },
    },
  };
  function backendFor(precision) {
    if (!global.PhysicsDF.isExtended(precision)) return BACKENDS.f32;
    // Literals this backend writes (B.lit) are at this precision from here on.
    global.PhysicsDF.usePrecision(precision);
    return BACKENDS.df;
  }

  // Scaled so a full turn's pixel-span matches a position sweep's (2*PI world units is a turn).
  var ANGLE_INPUT_SCALE = 1 / 360;

  // World Y is up (OpenGL); scene y and vy are down: same sign flip for both.
  function isYAxisProperty(property) { return property === "y" || property === "vy"; }

  function findWorldHingeIndex(scene, bodyIndex) {
    for (var i = 0; i < scene.hinges.length; i++) {
      if (scene.hinges[i].bodyA === null && scene.hinges[i].bodyB === bodyIndex) return i;
    }
    return -1;
  }

  function findOwnHingeIndex(scene, bodyIndex) {
    for (var i = 0; i < scene.hinges.length; i++) {
      if (scene.hinges[i].bodyB === bodyIndex) return i;
    }
    return -1;
  }

  // ---- X/Y links into distinct (body, property) targets; duplicates add. Resize/
  // rotate targets run before translate ones: their recenter is absolute ----
  function resolveOffsetTargets(xInput, yInput, B) {
    var byKey = {};
    var order = [];

    function add(input, axisVar) {
      if (!input) return;
      var key = input.body + ":" + input.property;
      var scaledVar = input.property === "angle" ? B.mul(axisVar, B.lit(ANGLE_INPUT_SCALE)) : axisVar;
      var term = (isYAxisProperty(input.property) ? "-" : "") + scaledVar;
      if (!byKey[key]) { byKey[key] = { body: input.body, property: input.property, terms: [] }; order.push(key); }
      byKey[key].terms.push(term);
    }
    add(xInput, "worldX");
    add(yInput, "worldY");

    return order.map(function (key) {
      var t = byKey[key];
      return { body: t.body, property: t.property, expr: t.terms.join(" + ").replace(/\+ -/g, "- ") };
    });
  }

  // Flat GLSL statements turning the authored body state into the offset-and-cascaded state for the pixel whose worldX/worldY are in scope.
  function generateGridInitialStateGLSL(scene, precision) {
    var B = backendFor(precision);
    if (scene.bodies.length > PhysicsGPU.MAX_BODIES) {
      throw new Error("GPU physics supports at most " + PhysicsGPU.MAX_BODIES + " bodies (scene has " + scene.bodies.length + ")");
    }
    var consts = scene.bodies.map(PhysicsGPU.bodyConst);
    var n = consts.length;
    var targets = resolveOffsetTargets(scene.xInput, scene.yInput, B);

    var state = consts.map(function (b) {
      return { x: B.lit(b.x), y: B.lit(b.y), angle: B.lit(b.angle), vx: B.lit(b.vx || 0), vy: B.lit(b.vy || 0) };
    });
    // Shape at full precision too: the resize recenter derives POSITION from half/oldHalf.
    var shapeState = consts.map(function (b, i) {
      return { half: B.lit(PhysicsGPU.shapeHalf(consts, i)), invMass: B.lit(b.invMass), invInertia: B.lit(b.invInertia) };
    });
    var anchorA = scene.hinges.map(function (h) { return { x: B.lit(h.localAnchorA.x), y: B.lit(h.localAnchorA.y) }; });
    var anchorB = scene.hinges.map(function (h) { return { x: B.lit(h.localAnchorB.x), y: B.lit(h.localAnchorB.y) }; });
    var springs = PhysicsGPU.springLinksFor(scene, B.lit);

    var lines = [];
    var counter = 0;
    function def(type, expr) {
      var name = "gv_" + (counter++);
      lines.push(type + " " + name + " = " + expr + ";");
      return name;
    }
    function num(expr) { return def(B.scalar, expr); }
    function rotateExpr(v, angleExpr) {
      var name = def(B.vecType, B.rotate(v.x, v.y, angleExpr));
      return { x: name + ".x", y: name + ".y" };
    }
    // Lines scale only along local X (PhysicsHingeGeometry.scaleAnchorForResize).
    function scaleAnchor(anchor, ratioExpr, bodyType) {
      var x = num(B.mul(anchor.x, ratioExpr));
      var y = bodyType !== "circle" ? anchor.y : num(B.mul(anchor.y, ratioExpr));
      return { x: x, y: y };
    }

    // World position of a hinge's A side, from the parent's CURRENT state (hingeWorldPointA).
    function hingeWorldPointAExpr(hingeIndex) {
      var hinge = scene.hinges[hingeIndex];
      if (hinge.bodyA === null) return anchorA[hingeIndex];
      var parentIdx = hinge.bodyA;
      var r = rotateExpr(anchorA[hingeIndex], state[parentIdx].angle);
      return {
        x: num(B.add(state[parentIdx].x, r.x)),
        y: num(B.add(state[parentIdx].y, r.y)),
      };
    }

    // A body and its descendants, for resize/rotate's children (translateBodyAndDescendants).
    function translateAndCascade(bodyIndex, dxExpr, dyExpr, visited) {
      if (visited[bodyIndex]) return;
      visited[bodyIndex] = true;
      state[bodyIndex].x = num(B.add(state[bodyIndex].x, dxExpr));
      state[bodyIndex].y = num(B.add(state[bodyIndex].y, dyExpr));
      scene.hinges.forEach(function (h) {
        if (h.bodyA === bodyIndex) translateAndCascade(h.bodyB, dxExpr, dyExpr, visited);
      });
    }

    // ---- Translate (x/y): translateBodyPreservingHinges; the whole hinge assembly and its world pins ----
    function applyTranslateTarget(bodyIndex, dxExpr, dyExpr) {
      var isMember = {};
      PhysicsHingeGeometry.hingeAssembly(scene, bodyIndex).forEach(function (m) {
        isMember[m] = true;
        state[m].x = num(B.add(state[m].x, dxExpr));
        state[m].y = num(B.add(state[m].y, dyExpr));
      });
      scene.hinges.forEach(function (h, hi) {
        if (h.bodyA === null && isMember[h.bodyB]) anchorA[hi] = { x: num(B.add(anchorA[hi].x, dxExpr)), y: num(B.add(anchorA[hi].y, dyExpr)) };
      });
    }

    // ---- Velocity (vx/vy): additive on one body, no cascade; the hinge solver reconciles ----
    function applyVelocityTarget(bodyIndex, property, offsetExpr) {
      state[bodyIndex][property] = num(B.add(state[bodyIndex][property], offsetExpr));
    }

    // ---- Resize/rotate: applyBodyEditPreservingHinge. Recenter only a body with an own
    // hinge, then move each direct child by how far its own attachment point moved ----
    function applyResizeRotateTarget(bodyIndex, property, offsetExpr) {
      var ownHingeIdx = findOwnHingeIndex(scene, bodyIndex);
      var isResize = property === "radius" || property === "length";
      var isAnchored = consts[bodyIndex].isAnchored;
      var oldAngle = state[bodyIndex].angle;
      var oldX = state[bodyIndex].x, oldY = state[bodyIndex].y;
      var oldHalf = shapeState[bodyIndex].half;

      var children = [];
      scene.hinges.forEach(function (h, hi) {
        if (h.bodyA === bodyIndex) children.push({ bodyB: h.bodyB, hingeIndex: hi, oldLocal: { x: anchorA[hi].x, y: anchorA[hi].y } });
      });

      if (property === "angle") {
        state[bodyIndex].angle = num(B.add(state[bodyIndex].angle, offsetExpr));
      } else if (property === "radius") {
        // Clamp to magnitude: everything assumes radius >= 0.
        var newRadius = num(B.abs(B.add(oldHalf, offsetExpr)));
        shapeState[bodyIndex].half = newRadius;
        // Anchored: mass/inertia stay exactly 0 (computeMass short-circuits), never tiny.
        if (!isAnchored) {
          var area = num(B.mul(B.mul(B.mul(B.lit(PhysicsEngine.DENSITY), B.lit(Math.PI)), newRadius), newRadius));
          var invMass = num(B.div(B.lit(1), area));
          shapeState[bodyIndex].invMass = invMass;
          // inertia = mass * r^2 / 2  =>  invInertia = 2 * invMass / r^2
          shapeState[bodyIndex].invInertia = num(B.div(B.mul(B.lit(2), invMass), B.mul(newRadius, newRadius)));
        }
      } else {
        var newLen = num(B.abs(B.add(B.mul(B.lit(2), oldHalf), offsetExpr)));
        shapeState[bodyIndex].half = num(B.mul(newLen, B.lit(0.5)));
        if (!isAnchored) {
          var mass = num(B.mul(B.lit(PhysicsEngine.LINE_LINEAR_DENSITY), newLen));
          var invMassL = num(B.div(B.lit(1), mass));
          shapeState[bodyIndex].invMass = invMassL;
          // inertia = mass * len^2 / 12  =>  invInertia = 12 / (mass * len^2)
          shapeState[bodyIndex].invInertia = num(B.div(B.lit(12), B.mul(B.mul(mass, newLen), newLen)));
        }
      }

      // Spring anchors keep their place on the body (rescaleSpringAnchorsOnBody); a dead-center one stays zero.
      var ratio = null;
      if (isResize) {
        var sprungHere = springs.some(function (sp) {
          return (!sp.aIsWorld && sp.a === bodyIndex && !sp.localA.zero) || (sp.b === bodyIndex && !sp.localB.zero);
        });
        if (sprungHere || ownHingeIdx !== -1) ratio = num(B.div(shapeState[bodyIndex].half, oldHalf));
        springs.forEach(function (sp) {
          function rescaled(anchor) {
            var scaled = scaleAnchor(anchor, ratio, consts[bodyIndex].type);
            return { x: scaled.x, y: scaled.y, zero: false };
          }
          if (!sp.aIsWorld && sp.a === bodyIndex && !sp.localA.zero) sp.localA = rescaled(sp.localA);
          if (sp.b === bodyIndex && !sp.localB.zero) sp.localB = rescaled(sp.localB);
        });
      }

      if (ownHingeIdx === -1) return; // no own hinge -> no recenter, no cascade (matches PhysicsHingeGeometry exactly)

      if (isResize) {
        var bodyType = consts[bodyIndex].type;
        scene.hinges.forEach(function (h, hi) {
          if (h.bodyA === bodyIndex) anchorA[hi] = scaleAnchor(anchorA[hi], ratio, bodyType);
          if (h.bodyB === bodyIndex) anchorB[hi] = scaleAnchor(anchorB[hi], ratio, bodyType);
        });
      }

      // Reads the parent's CURRENT state, so target order is free: a later parent move is a pure translation on top.
      var pivot = hingeWorldPointAExpr(ownHingeIdx);
      var rB = rotateExpr(anchorB[ownHingeIdx], state[bodyIndex].angle);
      state[bodyIndex].x = num(B.sub(pivot.x, rB.x));
      state[bodyIndex].y = num(B.sub(pivot.y, rB.y));

      var visited = {};
      visited[bodyIndex] = true;
      children.forEach(function (child) {
        var oldR = rotateExpr(child.oldLocal, oldAngle);
        var oldWorldX = num(B.add(oldX, oldR.x));
        var oldWorldY = num(B.add(oldY, oldR.y));
        var newR = rotateExpr(anchorA[child.hingeIndex], state[bodyIndex].angle);
        var newWorldX = num(B.add(state[bodyIndex].x, newR.x));
        var newWorldY = num(B.add(state[bodyIndex].y, newR.y));
        var dx = num(B.sub(newWorldX, oldWorldX));
        var dy = num(B.sub(newWorldY, oldWorldY));
        translateAndCascade(child.bodyB, dx, dy, visited);
      });
    }

    // Resize/rotate first: their recenter is absolute and would discard a translate.
    var resizeTargets = targets.filter(function (t) { return t.property === "radius" || t.property === "length" || t.property === "angle"; });
    var translateTargets = targets.filter(function (t) { return t.property === "x" || t.property === "y"; });
    var velocityTargets = targets.filter(function (t) { return t.property === "vx" || t.property === "vy"; });
    resizeTargets.forEach(function (t) { applyResizeRotateTarget(t.body, t.property, t.expr); });
    translateTargets.forEach(function (t) {
      applyTranslateTarget(t.body, t.property === "x" ? t.expr : B.zero, t.property === "y" ? t.expr : B.zero);
    });
    velocityTargets.forEach(function (t) { applyVelocityTarget(t.body, t.property, t.expr); });

    // ---- Settle into the frame with mod(), as normalizeAllBodiesIntoFrame and assemblyWrapDelta do.
    // Skipped under Infinite Space ----
    if (PhysicsEngine.wrapsAtEdges(scene)) {
      // mod() takes a plain float modulus (an integer frame size); overhang tests use the pass's precision.
      var frameW = fnum(scene.frameWidth), frameH = fnum(scene.frameHeight);
      var frameWLit = B.lit(scene.frameWidth), frameHLit = B.lit(scene.frameHeight);
      // Spring groups settle as one (PhysicsEngine.springGroups); a tethered group stays put.
      var springGroups = PhysicsEngine.springGroups(scene), assemblies = PhysicsEngine.hingeAssemblies(scene);
      // Sticky Edges: an input leader lands at least STICKY_START_MARGIN inside the frame (nudgeStickyStarts).
      var nudge = {}, margin = PhysicsHingeGeometry.STICKY_START_MARGIN;
      PhysicsHingeGeometry.stickyStartNudges(scene).forEach(function (n) { nudge[n.body] = n; });
      function settled(v, span, nudged) {
        var inFrame = B.mod(v, fnum(span));
        return nudged ? B.clamp(inFrame, B.lit(margin), B.lit(span - margin)) : inFrame;
      }
      for (var wi = 0; wi < n; wi++) {
        var springGroup = springGroups ? springGroups.groupOf[wi] : null;
        var assembly = assemblies.groupOf[wi];
        if (springGroup ? springGroup.tethered || springGroup.leader !== wi : assembly.leader !== wi) continue;
        var bx = state[wi].x, by = state[wi].y;
        var dxExpr, dyExpr;
        if (!springGroup && assembly.held) {
          // Out of the frame entirely (every body and pin), then the leader's shape decides each axis.
          var outside = [], isMember = {}, leaderPast;
          var past = function (x, y, halfX, halfY) {
            return {
              x: B.greater(halfX ? B.sub(x, halfX) : x, frameWLit) + " || " + B.less(halfX ? B.add(x, halfX) : x, B.zero),
              y: B.greater(halfY ? B.sub(y, halfY) : y, frameHLit) + " || " + B.less(halfY ? B.add(y, halfY) : y, B.zero),
            };
          };
          assembly.members.forEach(function (m) {
            var halfX, halfY;
            if (consts[m].type === "circle") {
              halfX = shapeState[m].half;
              halfY = shapeState[m].half;
            } else {
              halfX = num(B.mul(B.absCos(state[m].angle), shapeState[m].half));
              halfY = num(B.mul(B.absSin(state[m].angle), shapeState[m].half));
            }
            isMember[m] = true;
            var p = past(state[m].x, state[m].y, halfX, halfY);
            if (m === wi) leaderPast = p;
            outside.push("(" + p.x + " || " + p.y + ")");
          });
          scene.hinges.forEach(function (h, hi) {
            if (h.bodyA !== null || !isMember[h.bodyB]) return;
            var p = past(anchorA[hi].x, anchorA[hi].y);
            outside.push("(" + p.x + " || " + p.y + ")");
          });
          // A lone body is out of the frame whenever an axis of its own is past.
          var gone = outside.length > 1 ? "(" + outside.join(" && ") + ") && " : "";
          dxExpr = "(" + gone + (gone ? "(" + leaderPast.x + ")" : leaderPast.x) + ") ? (" + B.sub(B.mod(bx, frameW), bx) + ") : " + B.zero;
          dyExpr = "(" + gone + (gone ? "(" + leaderPast.y + ")" : leaderPast.y) + ") ? (" + B.sub(B.mod(by, frameH), by) + ") : " + B.zero;
        } else {
          dxExpr = B.sub(settled(bx, scene.frameWidth, nudge[wi] && nudge[wi].x), bx);
          dyExpr = B.sub(settled(by, scene.frameHeight, nudge[wi] && nudge[wi].y), by);
        }
        if (springGroup) {
          var gdx = num(dxExpr), gdy = num(dyExpr);
          springGroup.members.forEach(function (m) {
            state[m].x = num(B.add(state[m].x, gdx));
            state[m].y = num(B.add(state[m].y, gdy));
            var pin = findWorldHingeIndex(scene, m);
            if (pin !== -1) anchorA[pin] = { x: num(B.add(anchorA[pin].x, gdx)), y: num(B.add(anchorA[pin].y, gdy)) };
          });
          continue;
        }
        applyTranslateTarget(wi, num(dxExpr), num(dyExpr));
      }
    }

    var hingeAnchors = scene.hinges.map(function (hg, hi) {
      return { aIsWorld: hg.bodyA === null, a: hg.bodyA, b: hg.bodyB, localA: anchorA[hi], localB: anchorB[hi] };
    });
    var pairs = PhysicsEngine.collisionsEnabled(scene) ? PhysicsGPU.collisionPairs(n, consts, scene.hinges) : [];

    return {
      declarationLines: lines,
      bodyState: state,
      shapeState: shapeState,
      consts: consts,
      n: n,
      pairs: pairs,
      hingeAnchors: hingeAnchors,
      springs: springs,
      precision: global.PhysicsDF.isExtended(precision) ? precision : "f32",
    };
  }

  // Body structs plus BODYn_INV_MASS/INV_INERTIA/HALF locals for stepOnce(),
  // initialized from the offset expressions. Emit AFTER result.declarationLines.
  function generateCanonicalBodyDeclarationsGLSL(result) {
    var df = global.PhysicsDF.isExtended(result.precision);
    var B = backendFor(result.precision);
    var lines = [];
    for (var i = 0; i < result.n; i++) {
      var s = result.bodyState[i], sh = result.shapeState[i];
      var c = result.consts[i];
      var vx = s.vx, vy = s.vy, w = B.lit(c.w || 0);
      lines.push(df
        ? "DBody dbody" + i + " = DBody(" + s.x + ", " + s.y + ", " + s.angle + ", " + vx + ", " + vy + ", " + w + ");"
        : "Body body" + i + " = Body(" + s.x + ", " + s.y + ", " + s.angle + ", " + vx + ", " + vy + ", " + w + ");");
      // At the pass's own precision: collapsing to float32 would re-quantize a size-linked axis.
      var scalarDecl = df ? "MF " : "float ";
      lines.push(scalarDecl + "BODY" + i + "_INV_MASS = " + sh.invMass + ";");
      lines.push(scalarDecl + "BODY" + i + "_INV_INERTIA = " + sh.invInertia + ";");
      lines.push(scalarDecl + "BODY" + i + "_HALF = " + sh.half + ";");
    }
    // A fresh set of bodies is a fresh run: see staticGeometryResetGLSL.
    var geomReset = PhysicsGPU.staticGeometryResetGLSL(result.precision);
    if (geomReset) lines.push(geomReset);
    return lines.join("\n");
  }

  // Hover replay: the grid's code with trajectory logging on for the point under the
  // cursor. The point is a uniform or a texel, so one compile serves every hovered point.
  // `precision` must match the grid's; worldXLo/worldYLo are double-double lows.
  // float32 keeps the point in uniforms, one point per run: the batched program's float32 code rounds
  // differently, and its chaotic replays agree with the map's own pixels less often.
  function compileHoverTrajectoryGLSL(scene, worldX, worldY, maxSteps, precision, worldXLo, worldYLo) {
    var point = { x: worldX, y: worldY, xLo: worldXLo, yLo: worldYLo };
    return compileHoverGLSL(scene, [point], maxSteps, precision, !global.PhysicsDF.isExtended(precision));
  }

  // Replays of several start points { x, y, xLo?, yLo? } in one run (PhysicsGPU.runCompiledTrajectoriesOnGPU).
  // The source is the same for any points and any count, so one compile serves hover and Inspect alike.
  function compileHoverBatchGLSL(scene, points, maxSteps, precision) {
    return compileHoverGLSL(scene, points, maxSteps, precision, false);
  }

  function compileHoverGLSL(scene, points, maxSteps, precision, uniformPoint) {
    var df = global.PhysicsDF.isExtended(precision);
    var initial = generateGridInitialStateGLSL(scene, precision);
    // undefined in Infinite Space: the step loop emits no wrap.
    var frame = PhysicsEngine.wrapsAtEdges(scene) ? { width: scene.frameWidth, height: scene.frameHeight } : undefined;

    var lines = [];
    lines.push("#version 300 es");
    lines.push("precision highp float;");
    // Every word of the point: a float32-rounded point would replay a different one at deep zoom.
    // Batched, texel (p, 0) holds point p's x words and (p, 1) its y words.
    if (uniformPoint) global.PhysicsDF.wordUniformDecls("u_hoverWorld").forEach(function (l) { lines.push(l); });
    else lines.push("uniform highp sampler2D u_hoverPoints;");
    // The chunked LOG / ADVANCE scheme: see PhysicsGPU.generateTrajectoryMainGLSL.
    var chunk = PhysicsGPU.trajectoryChunkInfo(initial.n, initial.consts, initial.hingeAnchors, precision);
    lines.push(PhysicsGPU.generateTrajectoryHeaderGLSL(chunk));
    lines.push("");
    lines.push(PhysicsGPU.libraryGLSL(precision, PhysicsEngine.speedCapFor(scene), PhysicsEngine.frictionRate(scene)));
    lines.push("");
    lines.push(PhysicsGPU.generateStepOnceGLSL(initial.n, initial.consts, initial.pairs, initial.hingeAnchors, frame, precision, scene.mutualGravity, PhysicsEngine.collisionsEnabled(scene), initial.springs,
      { pairContacts: true, warpBits: true }));
    lines.push("");
    // Locals, declared first: a global's initializer must be constant, a uniform is not.
    var B = backendFor(precision);
    var n = global.PhysicsDF.wordsFor(precision);
    function wordsValue(texel) {
      return n <= 1 ? texel + ".x" : "MF(" + ["x", "y", "z", "w"].slice(0, n).map(function (c) { return texel + "." + c; }).join(", ") + ")";
    }
    var worldDecl = uniformPoint
      ? B.scalar + " worldX = " + global.PhysicsDF.wordUniformValue("u_hoverWorld", "x", precision) + ";\n" +
        B.scalar + " worldY = " + global.PhysicsDF.wordUniformValue("u_hoverWorld", "y", precision) + ";"
      : "vec4 hoverWordsX = texelFetch(u_hoverPoints, ivec2(trajPoint, 0), 0);\n" +
        "vec4 hoverWordsY = texelFetch(u_hoverPoints, ivec2(trajPoint, 1), 0);\n" +
        B.scalar + " worldX = " + wordsValue("hoverWordsX") + ";\n" +
        B.scalar + " worldY = " + wordsValue("hoverWordsY") + ";";
    var bodyDecl = worldDecl + "\n" + initial.declarationLines.join("\n") + "\n" + generateCanonicalBodyDeclarationsGLSL(initial) +
      "\n" + PhysicsGPU.generateHingeAnchorLocalsGLSL(initial.hingeAnchors, precision);
    lines.push(PhysicsGPU.generateTrajectoryMainGLSL(initial.n, bodyDecl, initial.hingeAnchors, precision, chunk, initial.springs, !uniformPoint));

    var compiled = {
      fragmentSource: PhysicsGPU.pruneUnusedGLSL(lines.join("\n")),
      numBodies: initial.n,
      precision: df ? precision : "f32",
      chunk: chunk,
    };
    if (uniformPoint) {
      var p = points[0], words = global.PhysicsDF.wordUniformValues(p.x, p.xLo, p.y, p.yLo);
      compiled.uniforms = {};
      global.PhysicsDF.WORD_SUFFIXES.forEach(function (sfx, k) { compiled.uniforms["u_hoverWorld" + sfx] = [words[0][k], words[1][k]]; });
      return compiled;
    }
    var data = new Float32Array(points.length * 8);
    points.forEach(function (pt, i) {
      var w = global.PhysicsDF.wordUniformValues(pt.x, pt.xLo, pt.y, pt.yLo);
      for (var k = 0; k < 4; k++) {
        data[i * 4 + k] = w[0][k];
        data[(points.length + i) * 4 + k] = w[1][k];
      }
    });
    compiled.pointCount = points.length;
    compiled.points = data;
    return compiled;
  }

  // Numeric mirror of resolveOffsetTargets' add(), kept side by side; the lockstep test compares them.
  function resolveOffsetTargetsNumeric(xInput, yInput, worldX, worldY) {
    var byKey = {};
    var order = [];
    function add(input, axisValue) {
      if (!input) return;
      var key = input.body + ":" + input.property;
      var scaledValue = input.property === "angle" ? axisValue * ANGLE_INPUT_SCALE : axisValue;
      var term = isYAxisProperty(input.property) ? -scaledValue : scaledValue;
      if (!byKey[key]) { byKey[key] = { body: input.body, property: input.property, value: 0 }; order.push(key); }
      byKey[key].value += term;
    }
    add(xInput, worldX);
    add(yInput, worldY);
    return order.map(function (key) { return byKey[key]; });
  }

  // Hover preview's no-WebGL path: the offset scene as numbers via the editor's own PhysicsHingeGeometry calls, resize/rotate before translate as above.
  function computeOffsetSceneNumeric(scene, worldX, worldY) {
    var result = PhysicsEngine.cloneScene(scene);
    // JSON scenes omit derived mass fields and cloneScene copies only what exists.
    result.bodies.forEach(PhysicsEngine.computeMass);

    var targets = resolveOffsetTargetsNumeric(scene.xInput, scene.yInput, worldX, worldY);
    var resizeTargets = targets.filter(function (t) { return t.property === "radius" || t.property === "length" || t.property === "angle"; });
    var translateTargets = targets.filter(function (t) { return t.property === "x" || t.property === "y"; });
    var velocityTargets = targets.filter(function (t) { return t.property === "vx" || t.property === "vy"; });
    resizeTargets.forEach(function (t) {
      PhysicsHingeGeometry.applyBodyEditPreservingHinge(result, t.body, t.property !== "angle", function () {
        var body = result.bodies[t.body];
        if (t.property === "radius") { body.radius = Math.abs(body.radius + t.value); PhysicsEngine.computeMass(body); }
        else if (t.property === "length") { body.length = Math.abs(body.length + t.value); PhysicsEngine.computeMass(body); }
        else { body.angle += t.value; }
      });
    });
    translateTargets.forEach(function (t) {
      PhysicsHingeGeometry.translateBodyPreservingHinges(result, t.body, t.property === "x" ? t.value : 0, t.property === "y" ? t.value : 0);
    });
    velocityTargets.forEach(function (t) {
      result.bodies[t.body][t.property] += t.value;
    });
    // Settle into the frame by spring group (`true`), skipped under Infinite Space: must match generateGridInitialStateGLSL.
    if (PhysicsEngine.wrapsAtEdges(result)) {
      PhysicsHingeGeometry.normalizeAllBodiesIntoFrame(result, true);
      PhysicsHingeGeometry.nudgeStickyStarts(result);
    }
    return result;
  }

  // playbackStateVariables and friends live in physics-gpu.js; re-exported here.

  global.PhysicsGridCodegen = {
    backendFor: backendFor,
    resolveOffsetTargets: resolveOffsetTargets,
    generateGridInitialStateGLSL: generateGridInitialStateGLSL,
    generateCanonicalBodyDeclarationsGLSL: generateCanonicalBodyDeclarationsGLSL,
    compileHoverTrajectoryGLSL: compileHoverTrajectoryGLSL,
    compileHoverBatchGLSL: compileHoverBatchGLSL,
    computeOffsetSceneNumeric: computeOffsetSceneNumeric,
    playbackStateVariables: PhysicsGPU.playbackStateVariables,
    withWords: PhysicsGPU.withWords,
    playbackStateLayerCount: PhysicsGPU.playbackStateLayerCount,
    generatePlaybackStateDeclarationsGLSL: PhysicsGPU.generatePlaybackStateDeclarationsGLSL,
    generatePlaybackStateLoadGLSL: PhysicsGPU.generatePlaybackStateLoadGLSL,
    generatePlaybackStateOutputsGLSL: PhysicsGPU.generatePlaybackStateOutputsGLSL,
    generatePlaybackStateStoreGLSL: PhysicsGPU.generatePlaybackStateStoreGLSL,
  };
})(window);
