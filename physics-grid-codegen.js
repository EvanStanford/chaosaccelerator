// This file is part of Chaos Accelerator, licensed under the Common Public
// Attribution License, Version 1.0 (CPAL-1.0): see LICENSE in the project
// root, or https://chaosaccelerator.com/license for a hosted copy.

// Per-pixel initial-conditions codegen for the fractal grid (Milestone 2):
// given a scene with xInput/yInput mapped, generates GLSL that computes,
// for whichever pixel is being shaded, the same scene the interactive
// editor would produce after adding that pixel's world X/Y to the linked
// property, including the hinge-preserving cascade rules from
// PhysicsUI.applyBodyEditPreservingHinge / translateBodyPreservingHinges.
//
// Body count and hinge topology are fixed once a scene is sent here, so,
// matching physics-gpu.js's own "specialize, don't generalize" style, the
// whole cascade is resolved once, at codegen time, into a flat sequence of
// GLSL statements. Nothing here walks the hinge graph at runtime; by the
// time the shader exists, the graph has already been fully unrolled into
// GLSL that only ever operates on gl_FragCoord and the scene's own
// authored constants.
(function (global) {
  "use strict";

  var PhysicsEngine = global.PhysicsEngine;
  var PhysicsGPU = global.PhysicsGPU;
  var PhysicsHingeGeometry = global.PhysicsHingeGeometry;

  function fnum(n) { return PhysicsGPU.fnum(n); }

  // ---- Precision backends ----
  //
  // Everything below builds GLSL as expression STRINGS, never numbers, so
  // switching the whole per-pixel cascade from float32 to double-float is
  // a matter of spelling each arithmetic step differently, not of having
  // a second copy of the cascade. `f32` emits exactly the operators it
  // always did; `df` emits calls into physics-df.js. Both walk the same
  // hinge graph, in the same order, producing the same sequence of
  // temporaries.
  //
  // Why the cascade needs the extended precision at all: this is where a
  // pixel's world X/Y is ADDED to an authored coordinate of order 10^3.
  // That single add is the original 32-bit wall: at a deep enough zoom
  // the offset lands below the coordinate's own ULP and a whole block of
  // pixels ends up with byte-identical starting scenes. No amount of
  // precision later in the step loop can recover a distinction that was
  // already thrown away here.
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
      max: function (a, b) { return "max(" + a + ", " + b + ")"; },
      rotate: function (x, y, angle) { return "rotateVec(vec2(" + x + ", " + y + "), " + angle + ")"; },
      absCos: function (a) { return "abs(cos(" + a + "))"; },
      absSin: function (a) { return "abs(sin(" + a + "))"; },
      mod: function (a, m) { return "mod(" + a + ", " + m + ")"; },
      greater: function (a, b) { return "(" + a + ") > (" + b + ")"; },
      less: function (a, b) { return "(" + a + ") < (" + b + ")"; },
      toFloat: function (a) { return a; },
      fromFloat: function (a) { return a; },
    },
    // Every multi-float precision, "df", "tf", "qf", spells its arithmetic
    // the same way: the library's functions keep their df names whatever the
    // word count, and the scalar type is the MF macro (see physics-df.js).
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
      max: function (a, b) { return "dfMax(" + a + ", " + b + ")"; },
      rotate: function (x, y, angle) { return "dfRotate(" + x + ", " + y + ", " + angle + ")"; },
      absCos: function (a) { return "dfAbs(dfCos(" + a + "))"; },
      absSin: function (a) { return "dfAbs(dfSin(" + a + "))"; },
      // The modulus is always a frame dimension, an integer canvas size,
      // exactly representable, so it stays a plain float here.
      mod: function (a, m) { return "dfMod(" + a + ", " + m + ")"; },
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

  // An angle link moves the WHOLE circle in radians per world unit, same as
  // a position link moves it in pixels per world unit, but 2*PI world
  // units (about 6px at default zoom) is a full spin, so an angle-linked
  // body was completing hundreds of turns over a screen's width while an
  // x/y-linked body only crossed it once. Scaling the angle offset down
  // brings a full rotation's pixel-span roughly in line with a full
  // position sweep's, without touching x/y links at all.
  var ANGLE_INPUT_SCALE = 1 / 360;

  // Both "y" (position) and "vy" (velocity) run along the same axis, so a
  // link to either gets the same sign flip: world-space Y increases upward
  // (this is the fractal view's math/OpenGL convention) while the physics
  // scene's own y increases downward (screen convention, same as vy, a
  // positive vy already means "falling," i.e. moving toward larger y).
  // Panning the world view "up" should read as "up" for a velocity link
  // exactly as it already does for a position link, which needs the same
  // negation for the same reason.
  function isYAxisProperty(property) { return property === "y" || property === "vy"; }

  function findWorldHingeIndex(scene, bodyIndex) {
    for (var i = 0; i < scene.hinges.length; i++) {
      if (scene.hinges[i].bodyA === null && scene.hinges[i].bodyB === bodyIndex) return i;
    }
    return -1;
  }

  // The hinge that pins bodyIndex to *something else*, world or another
  // body, mirrors PhysicsHingeGeometry.findOwnHinge exactly.
  function findOwnHingeIndex(scene, bodyIndex) {
    for (var i = 0; i < scene.hinges.length; i++) {
      if (scene.hinges[i].bodyB === bodyIndex) return i;
    }
    return -1;
  }

  // ---- Resolve X/Y links into distinct (body, property) edit targets ----
  //
  // Two links pointing at the same (body, property) just add. A body CAN
  // also be targeted by both a position link (x/y) and a shape/rotation
  // link (radius/length/angle) at once, resize/rotate's hinge-preserving
  // recenter is an ABSOLUTE assignment (body.x = pivot.x, rB.x), which
  // would silently discard a translate's effect if the translate ran
  // first, but generateGridInitialStateGLSL always applies every
  // resize/rotate target before any translate target (see its own
  // comment), so the translate's `+=` composes on top of the already-
  // recentered position instead of being overwritten. Order between two
  // resize/rotate targets on the SAME body doesn't matter either: each
  // call independently re-establishes the hinge invariant from whatever
  // state it finds, so it doesn't matter which one ran first.
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

  // Builds the flat GLSL statement sequence that turns this scene's literal
  // authored body state into the offset-and-cascaded state for whatever
  // pixel calls it, given `worldX`/`worldY` are already in scope as floats.
  // Returns { declarationLines, bodyState, shapeState, consts, n }: the
  // caller (Stage 1: a debug/verification shader; Stage 2: the real grid
  // shader) is responsible for turning bodyState/shapeState into a Body
  // struct + calling PhysicsGPU.generateStepOnceGLSL's stepOnce().
  function generateGridInitialStateGLSL(scene, precision) {
    var B = backendFor(precision);
    if (scene.bodies.length > PhysicsGPU.MAX_BODIES) {
      throw new Error("GPU physics supports at most " + PhysicsGPU.MAX_BODIES + " bodies (scene has " + scene.bodies.length + ")");
    }
    // A splitter scene is padded out to PhysicsEngine.MAX_SIMULATION_BODIES
    // with dead spawn slots before anything else looks at it: see
    // PhysicsGPU.padSceneForSplitting. The padding appends, so every
    // authored body keeps its index and the whole offset/cascade walk below
    // (which addresses bodies and hinges by index) is untouched by it. The
    // authoring limit is checked above, against the count the user actually
    // drew.
    var padded = PhysicsGPU.padSceneForSplitting(scene);
    var spawnBase = padded.spawnBase;
    scene = padded.scene;
    var consts = scene.bodies.map(PhysicsGPU.bodyConst);
    var n = consts.length;
    var targets = resolveOffsetTargets(scene.xInput, scene.yInput, B);

    // Per-body symbolic state: GLSL expression strings, seeded from the
    // scene's literal authored values and overwritten wherever a target or
    // a cascade touches that body.
    var state = consts.map(function (b) {
      return { x: B.lit(b.x), y: B.lit(b.y), angle: B.lit(b.angle), vx: B.lit(b.vx || 0), vy: B.lit(b.vy || 0) };
    });
    // Shape is tracked at the same precision as position even though the
    // step loop only ever sees it as a plain float (BODYn_HALF and friends
    // are float32 parameters, so a size-linked axis is still float32-
    // limited in the collision math). What this buys is the RECENTER path:
    // a resize rescales hinge anchors by half/oldHalf and then re-derives
    // the body's position from the pivot, so a float32 ratio there would
    // quantize the resulting POSITION too, on a scene whose position axis
    // is otherwise fully precise.
    var shapeState = consts.map(function (b, i) {
      return { half: B.lit(PhysicsGPU.shapeHalf(consts, i)), invMass: B.lit(b.invMass), invInertia: B.lit(b.invInertia) };
    });
    // Hinge anchors as symbolic {x,y} pairs, parallel to scene.hinges:
    // mutated in place exactly like PhysicsUI's rescaleAllAnchorsOnBody /
    // translateBodyPreservingHinges mutate the real hinge objects.
    var anchorA = scene.hinges.map(function (h) { return { x: B.lit(h.localAnchorA.x), y: B.lit(h.localAnchorA.y) }; });
    var anchorB = scene.hinges.map(function (h) { return { x: B.lit(h.localAnchorB.x), y: B.lit(h.localAnchorB.y) }; });
    // Springs, in the same symbolic shape (see PhysicsGPU.springLinksFor,
    // whose descriptors these are): the anchors start as the authored
    // literals and are rescaled below when the body they sit on is resized.
    // Nothing else about a spring varies per pixel: a body an Input MOVES
    // takes its end of the spring with it and the spring simply starts
    // stretched by that much, which is the point of linking it.
    var springs = PhysicsGPU.springLinksFor(scene, B.lit);

    var lines = [];
    var counter = 0;
    function def(type, expr) {
      var name = "gv_" + (counter++);
      lines.push(type + " " + name + " = " + expr + ";");
      return name;
    }
    // A scalar in whichever precision this pass is generating for.
    function num(expr) { return def(B.scalar, expr); }
    function rotateExpr(v, angleExpr) {
      var name = def(B.vecType, B.rotate(v.x, v.y, angleExpr));
      return { x: name + ".x", y: name + ".y" };
    }
    // Circles and funnels scale uniformly; lines only scale along their own
    // local X axis (no adjustable thickness): matches
    // physics-ui.js's scaleAnchorForResize exactly (via
    // PhysicsHingeGeometry.scaleAnchorForResize).
    function scaleAnchor(anchor, ratioExpr, bodyType) {
      var x = num(B.mul(anchor.x, ratioExpr));
      var y = bodyType === "line" ? anchor.y : num(B.mul(anchor.y, ratioExpr));
      return { x: x, y: y };
    }

    // The current world position of a hinge's "A" side, as GLSL expression
    // strings: a constant when bodyA is null (the world pin never moves on
    // its own), or derived from the parent's CURRENT symbolic state
    // otherwise. Reading state[parentIdx] here, rather than a snapshot,
    // is what makes this correct regardless of whether the parent's own
    // target has already been resolved by the time this runs: mirrors
    // PhysicsHingeGeometry.hingeWorldPointA exactly.
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

    // ---- Direct translate (x/y links): mirrors
    // PhysicsUI.translateBodyPreservingHinges exactly, unconditional
    // cascade to descendants; the body's own world hinge (if any) drags
    // its pin along by the same delta instead of staying fixed.
    function translateAndCascade(bodyIndex, dxExpr, dyExpr, visited) {
      if (visited[bodyIndex]) return;
      visited[bodyIndex] = true;
      state[bodyIndex].x = num(B.add(state[bodyIndex].x, dxExpr));
      state[bodyIndex].y = num(B.add(state[bodyIndex].y, dyExpr));
      scene.hinges.forEach(function (h) {
        if (h.bodyA === bodyIndex) translateAndCascade(h.bodyB, dxExpr, dyExpr, visited);
      });
    }

    function applyTranslateTarget(bodyIndex, dxExpr, dyExpr) {
      var worldHingeIdx = findWorldHingeIndex(scene, bodyIndex);
      if (worldHingeIdx !== -1) {
        anchorA[worldHingeIdx] = {
          x: num(B.add(anchorA[worldHingeIdx].x, dxExpr)),
          y: num(B.add(anchorA[worldHingeIdx].y, dyExpr)),
        };
      }
      translateAndCascade(bodyIndex, dxExpr, dyExpr, {});
    }

    // ---- Starting velocity (vx/vy links) ----
    //
    // A direct additive offset on the one targeted body only: no hinge
    // recenter, no cascade to descendants. Both exist for position because
    // a hinge anchor is a GEOMETRIC constraint (the pin has to stay exactly
    // coincident, or the joint tears the instant the scene starts stepping);
    // velocity has no such constraint at the starting instant: a hinged
    // child simply authored with a different starting velocity than its
    // parent is a normal, valid starting state, and PhysicsEngine.step's own
    // hinge velocity solver reconciles any mismatch within the very first
    // iteration exactly as it does for any two hinged bodies mid-simulation.
    function applyVelocityTarget(bodyIndex, property, offsetExpr) {
      state[bodyIndex][property] = num(B.add(state[bodyIndex][property], offsetExpr));
    }

    // ---- Resize/rotate (radius/length/angle links): mirrors
    // PhysicsHingeGeometry.applyBodyEditPreservingHinge exactly, only
    // cascades if the EDITED body itself has an own hinge, to the world OR
    // to another body (no own hinge means just apply the edit in place: no
    // recenter, no cascade, even if this body has its own children);
    // resizing rescales any hinge anchor ON the edited body proportionally
    // first, then both paths recenter the body so its own hinge point
    // doesn't move relative to whatever it's pinned to, and finally
    // translate each DIRECT child by however far ITS OWN attachment point
    // on the parent moved (different children can get different deltas,
    // not one uniform delta for the whole subtree).
    function applyResizeRotateTarget(bodyIndex, property, offsetExpr) {
      var ownHingeIdx = findOwnHingeIndex(scene, bodyIndex);
      var isResize = property === "radius" || property === "length" || property === "size";
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
        // A large enough negative offset would otherwise drive the radius
        // below zero: collision/rendering code all assumes radius >= 0, so
        // clamp to the magnitude rather than let it go negative and corrupt
        // downstream math (still lets X/Y Input sweep radius smoothly
        // through zero and back out the other side, just as a size).
        var newRadius = num(B.abs(B.add(oldHalf, offsetExpr)));
        shapeState[bodyIndex].half = newRadius;
        // A static body's mass/inertia are always exactly zero regardless
        // of shape (PhysicsEngine.computeMass short-circuits on isAnchored
        // before ever touching the area/mass formulas): the literal "0.0"
        // already seeded above is correct as-is; don't recompute it into
        // some tiny-but-nonzero value, or an "anchored" body would stop
        // being treated as infinitely heavy in the solver.
        if (!isAnchored) {
          var area = num(B.mul(B.mul(B.mul(B.lit(PhysicsEngine.DENSITY), B.lit(Math.PI)), newRadius), newRadius));
          var invMass = num(B.div(B.lit(1), area));
          shapeState[bodyIndex].invMass = invMass;
          // inertia = mass * r^2 / 2  =>  invInertia = 2 * invMass / r^2
          shapeState[bodyIndex].invInertia = num(B.div(B.mul(B.lit(2), invMass), B.mul(newRadius, newRadius)));
        }
      } else if (property === "length") {
        // Same reasoning as radius above: a negative length is just as
        // invalid.
        var newLen = num(B.abs(B.add(B.mul(B.lit(2), oldHalf), offsetExpr)));
        shapeState[bodyIndex].half = num(B.mul(newLen, B.lit(0.5)));
        if (!isAnchored) {
          var mass = num(B.mul(B.lit(PhysicsEngine.LINE_LINEAR_DENSITY), newLen));
          var invMassL = num(B.div(B.lit(1), mass));
          shapeState[bodyIndex].invMass = invMassL;
          // inertia = mass * len^2 / 12  =>  invInertia = 12 / (mass * len^2)
          shapeState[bodyIndex].invInertia = num(B.div(B.lit(12), B.mul(B.mul(mass, newLen), newLen)));
        }
      } else { // size (funnel): same negative-magnitude guard as above.
        var newSize = num(B.abs(B.add(B.mul(B.lit(2), oldHalf), offsetExpr)));
        shapeState[bodyIndex].half = num(B.mul(newSize, B.lit(0.5)));
        if (!isAnchored) {
          // mass = LINE_LINEAR_DENSITY * FUNNEL_MASS_COEFF * size (see
          // physics-engine.js's computeMass funnel branch).
          var funnelMass = num(B.mul(B.lit(PhysicsEngine.LINE_LINEAR_DENSITY * PhysicsEngine.FUNNEL_MASS_COEFF), newSize));
          var invMassF = num(B.div(B.lit(1), funnelMass));
          shapeState[bodyIndex].invMass = invMassF;
          // inertia = LINE_LINEAR_DENSITY * FUNNEL_INERTIA_COEFF * size^3
          var inertiaF = num(B.mul(B.mul(B.lit(PhysicsEngine.LINE_LINEAR_DENSITY * PhysicsEngine.FUNNEL_INERTIA_COEFF), newSize), B.mul(newSize, newSize)));
          shapeState[bodyIndex].invInertia = num(B.div(B.lit(1), inertiaF));
        }
      }

      // A spring's attachment point keeps its place ON the body, the end of
      // a line stays the end of the line, whether or not the body is hinged
      // to anything: mirrors PhysicsHingeGeometry.rescaleSpringAnchorsOnBody.
      // A dead-center anchor is left alone (zero times anything), which is
      // what lets it stay a compile-time "no lever arm here".
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

      // hingeWorldPointAExpr reads the parent's CURRENT state, so this is
      // correct even if the parent's own target hasn't been resolved yet:
      // resolveOffsetTargets' fixed X-then-Y processing order can put a
      // child's target before its parent's. Recentering the child now
      // against the parent's not-yet-updated point, then translating it
      // again by the parent's own later before/after delta (see the
      // children.forEach cascade below, run when the PARENT's own target is
      // processed), is a sum of two pure translations: order doesn't
      // change the total, exactly like PhysicsHingeGeometry's recursive
      // cascade doesn't care which order sibling subtrees are visited in.
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
        // anchorA[child.hingeIndex] is looked up fresh (not the oldLocal
        // snapshot) since resizing above may have already rescaled it.
        var newR = rotateExpr(anchorA[child.hingeIndex], state[bodyIndex].angle);
        var newWorldX = num(B.add(state[bodyIndex].x, newR.x));
        var newWorldY = num(B.add(state[bodyIndex].y, newR.y));
        var dx = num(B.sub(newWorldX, oldWorldX));
        var dy = num(B.sub(newWorldY, oldWorldY));
        translateAndCascade(child.bodyB, dx, dy, visited);
      });
    }

    // Resize/rotate targets first: their recenter is an ABSOLUTE
    // assignment to body.x/y, so applying them after a translate would
    // silently discard it. This order is what makes it safe for X and Y to
    // target a position property and a shape/rotation property on the same
    // body (see resolveOffsetTargets's comment) as well as on different ones.
    var resizeTargets = targets.filter(function (t) { return t.property === "radius" || t.property === "length" || t.property === "size" || t.property === "angle"; });
    var translateTargets = targets.filter(function (t) { return t.property === "x" || t.property === "y"; });
    var velocityTargets = targets.filter(function (t) { return t.property === "vx" || t.property === "vy"; });
    resizeTargets.forEach(function (t) { applyResizeRotateTarget(t.body, t.property, t.expr); });
    translateTargets.forEach(function (t) {
      applyTranslateTarget(t.body, t.property === "x" ? t.expr : B.zero, t.property === "y" ? t.expr : B.zero);
    });
    // Independent of the other two: touches vx/vy only, which nothing above
    // ever reads, so order relative to them doesn't matter.
    velocityTargets.forEach(function (t) { applyVelocityTarget(t.body, t.property, t.expr); });

    // ---- Settle every body's STARTING position back into the frame ----
    //
    // The per-step wrap PhysicsGPU.generateStepOnceGLSL emits only ever
    // needs to correct a small overshoot (see its own comment): this
    // corrects the STARTING state instead, which can be arbitrarily far
    // outside the frame once worldX/worldY is a large, zoomed-out-enough
    // offset (mod(), not a single subtract, is what makes that safe in one
    // shot). Same two rules as PhysicsHingeGeometry.frameWrapDelta (its
    // direct JS/numeric mirror, used by computeOffsetSceneNumeric below):
    // a moving body's center wraps unconditionally; a body anchored in
    // place only wraps if its own shape would land entirely past one edge,
    // since GLSL's mod() always returns a result in [0, span) for a
    // positive span, exactly like PhysicsHingeGeometry.wrapIntoRange.
    //
    // Only ever applied to a ROOT body (unhinged, or hinged straight to the
    // world), never to a body hinged TO ANOTHER BODY: that body's position
    // is a rigid consequence of its parent (free to rotate about the
    // joint, not to independently translate), so wrapping it directly,
    // plausible-looking, since a rigid "arm" can genuinely put a child way
    // outside the frame, would move it without moving what it's pinned
    // to, tearing the joint immediately. Each root's own correction already
    // cascades to its entire subtree via applyTranslateTarget below, the
    // same as a manual drag would, so one pass over just the roots is
    // enough: see PhysicsHingeGeometry.normalizeAllBodiesIntoFrame, this
    // function's direct JS/numeric mirror, for the same reasoning.
    //
    // Skipped entirely under Infinite Space, where there is no frame to
    // settle into: a pixel's offset then simply places the body where it
    // says, however far outside. That makes the X/Y Input mapping linear
    // rather than periodic, zooming out sweeps the body steadily further
    // away instead of the mod() cycling it back through the frame over and
    // over, and it removes that mod()'s seam, the discontinuity where two
    // neighbouring pixels straddle a wrap point and get starting positions a
    // whole frame apart (see fractal-grid.js's inputStateCrossesSeam, which
    // exists to keep the superlative scans from mistaking that seam for real
    // structure; under this mode there is no seam for it to find).
    if (PhysicsEngine.wrapsAtEdges(scene)) {
      // Two spellings of the same two numbers: mod() always takes a plain
      // float modulus (a frame dimension is an integer canvas size, exactly
      // representable either way), while the overhang comparisons are
      // against a value of the pass's own precision.
      var frameW = fnum(scene.frameWidth), frameH = fnum(scene.frameHeight);
      var frameWLit = B.lit(scene.frameWidth), frameHLit = B.lit(scene.frameHeight);
      // Bodies joined by springs settle the way they wrap: see
      // PhysicsEngine.springGroups: a group tethered to the background (or to
      // an anchored body) is left wherever its pixel put it, and any other
      // moves as one, by its leader's position. Settling one end of a spring
      // on its own would start it a whole frame longer than the pixel next
      // door: the seam this block otherwise only puts BETWEEN bodies, put
      // through the middle of a force. Null for a scene with no springs.
      var springGroups = PhysicsEngine.springGroups(scene);
      for (var wi = 0; wi < n; wi++) {
        var isHingeChild = scene.hinges.some(function (h) { return h.bodyB === wi && h.bodyA !== null; });
        if (isHingeChild) continue;
        var springGroup = springGroups ? springGroups.groupOf[wi] : null;
        if (springGroup && (springGroup.tethered || springGroup.leader !== wi)) continue;
        var bx = state[wi].x, by = state[wi].y;
        var dxExpr, dyExpr;
        if (consts[wi].isAnchored) {
          var halfX, halfY;
          if (consts[wi].type === "circle") {
            halfX = shapeState[wi].half;
            halfY = shapeState[wi].half;
          } else if (consts[wi].type === "funnel") {
            // Max |local x|/|local y| over the 4 rotated vertices: mirrors
            // PhysicsHingeGeometry.frameHalfExtent's numeric version. A
            // leading "-" negates a df value too: it is a vec2, and negating
            // both words is exactly dfNeg.
            var fSize = num(B.mul(shapeState[wi].half, B.lit(2)));
            var fMh = num(B.mul(B.lit(PhysicsEngine.FUNNEL_MOUTH_HALF), fSize));
            var fTh = num(B.mul(B.lit(PhysicsEngine.FUNNEL_THROAT_HALF), fSize));
            var fHh = num(B.mul(B.lit(PhysicsEngine.FUNNEL_HALF_HEIGHT), fSize));
            var fv0 = rotateExpr({ x: "-" + fMh, y: "-" + fHh }, state[wi].angle);
            var fv1 = rotateExpr({ x: fMh, y: "-" + fHh }, state[wi].angle);
            var fv2 = rotateExpr({ x: "-" + fTh, y: fHh }, state[wi].angle);
            var fv3 = rotateExpr({ x: fTh, y: fHh }, state[wi].angle);
            halfX = num(B.max(B.max(B.abs(fv0.x), B.abs(fv1.x)), B.max(B.abs(fv2.x), B.abs(fv3.x))));
            halfY = num(B.max(B.max(B.abs(fv0.y), B.abs(fv1.y)), B.max(B.abs(fv2.y), B.abs(fv3.y))));
          } else {
            halfX = num(B.mul(B.absCos(state[wi].angle), shapeState[wi].half));
            halfY = num(B.mul(B.absSin(state[wi].angle), shapeState[wi].half));
          }
          dxExpr = "(" + B.greater(B.sub(bx, halfX), frameWLit) + " || " + B.less(B.add(bx, halfX), B.zero) + ") ? (" +
            B.sub(B.mod(bx, frameW), bx) + ") : " + B.zero;
          dyExpr = "(" + B.greater(B.sub(by, halfY), frameHLit) + " || " + B.less(B.add(by, halfY), B.zero) + ") ? (" +
            B.sub(B.mod(by, frameH), by) + ") : " + B.zero;
        } else {
          dxExpr = B.sub(B.mod(bx, frameW), bx);
          dyExpr = B.sub(B.mod(by, frameH), by);
        }
        if (springGroup) {
          // Every member, and every background pin one of them hangs from:
          // mirrors PhysicsEngine.translateSpringGroup.
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

    // In the shape PhysicsGPU.generateStepOnceGLSL expects: localA/localB
    // are already GLSL text (a literal for an untouched hinge, a computed
    // variable name for one rescaled above), never raw numbers, so a caller
    // building a step loop on top of this can hand them straight through.
    var hingeAnchors = scene.hinges.map(function (hg, hi) {
      return { aIsWorld: hg.bodyA === null, a: hg.bodyA, b: hg.bodyB, localA: anchorA[hi], localB: anchorB[hi] };
    });
    // Same "hand it nothing" approach as physics-gpu.js's own
    // compileSceneToTrajectoryGLSL: see its comment. Applies to the grid's
    // per-pixel step loop and the hover replay alike, since both are built
    // from this same result.
    var pairs = PhysicsEngine.collisionsEnabled(scene) ? PhysicsGPU.collisionPairs(n, consts, scene.hinges) : [];

    return {
      declarationLines: lines,
      bodyState: state,
      shapeState: shapeState,
      consts: consts,
      n: n,
      pairs: pairs,
      hingeAnchors: hingeAnchors,
      // For generateStepOnceGLSL / stepOnceCallArgs, beside hingeAnchors:
      // empty for a scene with no springs.
      springs: springs,
      // null for every scene without a splitter, which is what every
      // downstream generator reads as "no spawn slots, emit what you always
      // did".
      spawnBase: spawnBase,
      // Carried along so every downstream helper (canonical declarations,
      // the step-loop call args) spells its half of the seam the same way
      // without the caller having to pass the mode twice.
      precision: global.PhysicsDF.isExtended(precision) ? precision : "f32",
    };
  }

  // generateGridInitialStateGLSL tracks each body's state as separate
  // scalar expressions (bodyState[i].x/.y/.angle, shapeState[i].half/...):
  // enough to read out a single property (Stage 1's debug shader, and the
  // regression tests, only ever need one), but PhysicsGPU.generateStepOnceGLSL
  // needs real `inout Body bodyN` struct variables plus the canonically-named
  // BODYn_INV_MASS/INV_INERTIA/HALF locals to call stepOnce(...) against
  // (see stepOnceCallArgs). This assembles exactly those, each initialized
  // from whatever expression the offset computation produced: a literal
  // for an untouched body, a reference to one of generateGridInitialStateGLSL's
  // own computed variables for a linked one. Must be emitted AFTER
  // result.declarationLines, since these expressions can reference locals
  // declared there.
  function generateCanonicalBodyDeclarationsGLSL(result) {
    var df = global.PhysicsDF.isExtended(result.precision);
    var B = backendFor(result.precision);
    var lines = [];
    for (var i = 0; i < result.n; i++) {
      var s = result.bodyState[i], sh = result.shapeState[i];
      // vx/vy come from bodyState now: seeded from the body's own authored
      // velocity (the Set Velocity tool writes vx/vy, and scene JSON has
      // always carried vx/vy/w) and overwritten wherever a vx/vy Input
      // target lands on this body (see applyVelocityTarget), exactly like
      // x/y/angle already work. w (angular velocity) has no linkable
      // property yet, so it stays the plain authored literal.
      var c = result.consts[i];
      var vx = s.vx, vy = s.vy, w = B.lit(c.w || 0);
      lines.push(df
        ? "DBody dbody" + i + " = DBody(" + s.x + ", " + s.y + ", " + s.angle + ", " + vx + ", " + vy + ", " + w + ");"
        : "Body body" + i + " = Body(" + s.x + ", " + s.y + ", " + s.angle + ", " + vx + ", " + vy + ", " + w + ");");
      // Handed through at the pass's own precision. These used to be
      // collapsed to float32 here because the collision library was
      // float32; now that it isn't, collapsing would put a ~1e-7
      // quantization back on any size-linked axis for no reason.
      var scalarDecl = df ? "MF " : "float ";
      lines.push(scalarDecl + "BODY" + i + "_INV_MASS = " + sh.invMass + ";");
      lines.push(scalarDecl + "BODY" + i + "_INV_INERTIA = " + sh.invInertia + ";");
      lines.push(scalarDecl + "BODY" + i + "_HALF = " + sh.half + ";");
    }
    // The alive/lineage/liveCount locals a splitter scene's spawn slots are
    // threaded through stepOnce() by. Emitted here rather than by the
    // caller so that "the locals stepOnce() needs" stays one call, the same
    // way the BODYn_* names above already do.
    var spawnLocals = PhysicsGPU.generateSpawnSlotLocalsGLSL(result.n, result.spawnBase);
    if (spawnLocals) lines.push(spawnLocals);
    // A fresh set of bodies is a fresh run: see staticGeometryResetGLSL.
    var geomReset = PhysicsGPU.staticGeometryResetGLSL(result.precision);
    if (geomReset) lines.push(geomReset);
    return lines.join("\n");
  }

  // The hover-replay feature's entry point: "run the grid's WebGL code,
  // but with logging on" for the ONE specific (worldX, worldY) point under
  // the cursor. Reuses PhysicsGPU.generateTrajectoryMainGLSL: the exact same
  // texture-logging convention (redundant re-simulation per texel) as the
  // single-scene player, so the readback/replay code on the JS side doesn't
  // need to know or care that this scene came from an offset instead of
  // being authored directly.
  //
  // The point arrives as UNIFORMS, not as baked constants. It used to be
  // baked, generateGridInitialStateGLSL only needs `worldX`/`worldY` to be
  // in scope, and a literal is as good as anything, but that made every
  // hovered point its own shader: a compile, a link and (in df) a
  // pipeline build measured in seconds, per mouse move, and up to 300 of
  // them for one Inspect line or grid. As uniforms the source depends only
  // on (scene, maxSteps, precision), so PhysicsGPU.runCompiledTrajectoryOnGPU
  // compiles it once and every point after that is a draw and a readback.
  // It is also closer to what the grid itself does, whose pixels build their
  // world point from uniforms too.
  //
  // `precision` must match whatever the grid itself is currently rendering
  // with, or the replay stops agreeing with the pixel it is replaying,
  // which is the one property this feature exists to have.
  // worldXLo/worldYLo are the low halves of a double-double point: omitted
  // (zero) by every caller that only has a float64 to give.
  function compileHoverTrajectoryGLSL(scene, worldX, worldY, maxSteps, precision, worldXLo, worldYLo) {
    var df = global.PhysicsDF.isExtended(precision);
    var initial = generateGridInitialStateGLSL(scene, precision);
    // undefined in Infinite Space: no frame means the step loop emits no
    // wrap at all, which is exactly what that mode is.
    var frame = PhysicsEngine.wrapsAtEdges(scene) ? { width: scene.frameWidth, height: scene.frameHeight } : undefined;

    var lines = [];
    lines.push("#version 300 es");
    lines.push("precision highp float;");
    // One uniform per WORD of the point, exactly like the grid's own view
    // centre (see PhysicsDF.wordUniformDecls): the hovered point arrives as a
    // double-double, and rounding it to one float32 would replay a
    // measurably different point than the one under the cursor at any zoom
    // deep enough to need more than float32 in the first place. Each
    // precision reads as many of the words as it carries.
    global.PhysicsDF.wordUniformDecls("u_hoverWorld").forEach(function (l) { lines.push(l); });
    // The chunked LOG / ADVANCE scheme: see PhysicsGPU.generateTrajectoryMainGLSL.
    var chunk = PhysicsGPU.trajectoryChunkInfo(initial.n, initial.consts, initial.hingeAnchors, precision, initial.spawnBase);
    lines.push(PhysicsGPU.generateTrajectoryHeaderGLSL(chunk));
    lines.push("");
    lines.push(PhysicsGPU.libraryGLSL(precision, PhysicsEngine.speedCapFor(scene)));
    lines.push("");
    lines.push(PhysicsGPU.generateStepOnceGLSL(initial.n, initial.consts, initial.pairs, initial.hingeAnchors, frame, precision, scene.mutualGravity, PhysicsEngine.collisionsEnabled(scene), initial.spawnBase, initial.springs));
    lines.push("");
    // Locals rather than globals: a global's initializer has to be a constant
    // expression, which a uniform is not. They are declared first, so every
    // expression generateGridInitialStateGLSL built finds them in scope.
    var B = backendFor(precision);
    var worldDecl = B.scalar + " worldX = " + global.PhysicsDF.wordUniformValue("u_hoverWorld", "x", precision) + ";\n" +
      B.scalar + " worldY = " + global.PhysicsDF.wordUniformValue("u_hoverWorld", "y", precision) + ";";
    var bodyDecl = worldDecl + "\n" + initial.declarationLines.join("\n") + "\n" + generateCanonicalBodyDeclarationsGLSL(initial) +
      "\n" + PhysicsGPU.generateHingeAnchorLocalsGLSL(initial.hingeAnchors, precision);
    lines.push(PhysicsGPU.generateTrajectoryMainGLSL(initial.n, bodyDecl, initial.hingeAnchors, precision, initial.spawnBase, chunk, initial.springs));

    var words = global.PhysicsDF.wordUniformValues(worldX, worldXLo, worldY, worldYLo);
    var uniforms = {};
    global.PhysicsDF.WORD_SUFFIXES.forEach(function (sfx, k) { uniforms["u_hoverWorld" + sfx] = [words[0][k], words[1][k]]; });
    return {
      fragmentSource: lines.join("\n"),
      numBodies: initial.n,
      precision: df ? precision : "f32",
      uniforms: uniforms,
      chunk: chunk,
    };
  }

  // Same grouping/sign rule as resolveOffsetTargets's add() (negate only
  // when the target property is "y"), just producing an actual number
  // instead of a GLSL expression string built from "worldX"/"worldY".
  // Deliberately a small, direct, side-by-side mirror of that function
  // rather than one implementation trying to serve both a text-generator
  // and a number-generator: the same reason physics-engine.js and
  // physics-gpu.js's GLSL_LIBRARY stay as two hand-synced implementations
  // instead of one. Kept honest by the lockstep regression test comparing
  // this against the GLSL path for the same (worldX, worldY).
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

  // The hover-preview's "instant, no-WebGL" path: computes the actual
  // offset scene at (worldX, worldY) as real numbers, using the same
  // PhysicsHingeGeometry functions the interactive editor itself calls,
  // so this is exactly what the editor would show if you dragged the
  // linked property to worldX/worldY by hand, not a re-derivation of that
  // math. Same resize/rotate-before-translate ordering as
  // generateGridInitialStateGLSL, for the same reason (a translate applied
  // before a resize's absolute recenter would be silently discarded).
  function computeOffsetSceneNumeric(scene, worldX, worldY) {
    var result = PhysicsEngine.cloneScene(scene);
    // scene may be straight from JSON (serializeScene() omits derived mass
    // fields), and cloneScene only copies whatever properties a body
    // already has, so without this every body would carry undefined
    // invMass/invInertia into the hinge-preserving edits below.
    result.bodies.forEach(PhysicsEngine.computeMass);

    var targets = resolveOffsetTargetsNumeric(scene.xInput, scene.yInput, worldX, worldY);
    var resizeTargets = targets.filter(function (t) { return t.property === "radius" || t.property === "length" || t.property === "size" || t.property === "angle"; });
    var translateTargets = targets.filter(function (t) { return t.property === "x" || t.property === "y"; });
    var velocityTargets = targets.filter(function (t) { return t.property === "vx" || t.property === "vy"; });
    resizeTargets.forEach(function (t) {
      PhysicsHingeGeometry.applyBodyEditPreservingHinge(result, t.body, t.property !== "angle", function () {
        var body = result.bodies[t.body];
        if (t.property === "radius") { body.radius = Math.abs(body.radius + t.value); PhysicsEngine.computeMass(body); }
        else if (t.property === "length") { body.length = Math.abs(body.length + t.value); PhysicsEngine.computeMass(body); }
        else if (t.property === "size") { body.size = Math.abs(body.size + t.value); PhysicsEngine.computeMass(body); }
        else { body.angle += t.value; }
      });
    });
    translateTargets.forEach(function (t) {
      PhysicsHingeGeometry.translateBodyPreservingHinges(result, t.body, t.property === "x" ? t.value : 0, t.property === "y" ? t.value : 0);
    });
    // Direct additive offset, no hinge-preserving call: see
    // generateGridInitialStateGLSL's applyVelocityTarget for why velocity
    // needs none of the geometric-constraint machinery position/angle do.
    velocityTargets.forEach(function (t) {
      result.bodies[t.body][t.property] += t.value;
    });
    // A large enough worldX/worldY (zoomed far enough out) can land a
    // linked body way outside the frame: settle every body back inside it
    // before this starting state is used for anything, the same as the
    // editor does on every render() and the GLSL codegen below does for the
    // GPU paths. Skipped under Infinite Space, which has no frame to settle
    // into and lets a body simply start wherever its pixel puts it: the
    // matching skip is in generateGridInitialStateGLSL, and these two must
    // agree or the hover preview would show a different starting scene from
    // the pixel it is previewing.
    // `true`: by spring group, as the GLSL above settles them, NOT the
    // editor's own per-body settle (see normalizeAllBodiesIntoFrame).
    if (PhysicsEngine.wrapsAtEdges(result)) PhysicsHingeGeometry.normalizeAllBodiesIntoFrame(result, true);
    return result;
  }

  // The state-carrying helpers (playbackStateVariables and friends) live in
  // physics-gpu.js now: the trajectory runner needs them too, and that file
  // loads first. They are re-exported below under the names every caller of
  // this module already uses.

  global.PhysicsGridCodegen = {
    // Exposed so fractal-grid.js's own shader assembly (the world-X/Y
    // computation, the sticky-edges tracking) can be written once and
    // emitted at either precision, the same way the cascade above is.
    backendFor: backendFor,
    resolveOffsetTargets: resolveOffsetTargets,
    generateGridInitialStateGLSL: generateGridInitialStateGLSL,
    generateCanonicalBodyDeclarationsGLSL: generateCanonicalBodyDeclarationsGLSL,
    compileHoverTrajectoryGLSL: compileHoverTrajectoryGLSL,
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
