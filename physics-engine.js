// This file is part of Chaos Accelerator, licensed under the Common Public
// Attribution License, Version 1.0 (CPAL-1.0) - see LICENSE in the project
// root, or https://chaosaccelerator.com/license for a hosted copy.

// Pure, DOM-free 2D rigid body physics engine: circles and line segments,
// capsule-style collision, revolute (pin) joints, static anchors.
//
// The scene is plain, serializable data - { bodies: [...], hinges: [...] }
// - and step(scene, dt) mutates it in place. That data-in/data-out shape is
// deliberate: it's what a future per-pixel GPU port (Milestone 2) or a
// deterministic replay-from-a-starting-state (Milestone 3) both need.
(function (global) {
  "use strict";

  var DENSITY = 1;
  var LINE_LINEAR_DENSITY = 8; // mass per unit length of a line body
  // Lines are mathematically 1D, but need a real thickness to collide with
  // and to be clickable/hinge-able - this is a UI/collision detail, not a
  // physical property, so it does NOT factor into mass or inertia.
  var LINE_THICKNESS = 20;

  // ---- Funnel: a trapezoid (throat 1, mouth 3, legs 2 each - all scaled by
  // body.size, which plays the same role for a funnel that radius/length
  // play for a circle/line) that teleports a circle touching its mouth to
  // the center of its throat, velocity unchanged. Local frame: the mouth
  // (wide, length 3*size/2) sits at local -y, the throat (narrow, length
  // size/2) at local +y, so angle=0 reads as a funnel opening upward and
  // narrowing downward - same convention as ordinary downward gravity
  // feeding something in the top and out the bottom. Only supported so far
  // in Pac-Man edge mode with standard (non-mutual) gravity; see
  // gravitationalMass/halfExtent below and computeAccelerations, which do
  // not have a funnel case and are simply not exercised by that mode.
  var FUNNEL_MOUTH_HALF = 0.75;
  var FUNNEL_THROAT_HALF = 0.25;
  var FUNNEL_HALF_HEIGHT = Math.sqrt(3) / 4;
  // Mass/inertia of the 3 solid edges only (throat + 2 legs) - the mouth is
  // an opening, not a wall, so it carries no mass. Derived once, in closed
  // form, as three thin rods (LINE_LINEAR_DENSITY per unit length) about
  // their own centers, moved to the body's center by the parallel axis
  // theorem: mass = LINE_LINEAR_DENSITY*(throatLen + 2*legLen) with
  // throatLen=size/2, legLen=size, giving 2.5*size; inertia works out to
  // LINE_LINEAR_DENSITY*size^3*37/48 the same way (both cubic in size, like
  // a line's mass*length^2/12 = density*length^3/12 already is).
  var FUNNEL_MASS_COEFF = 2.5;
  var FUNNEL_INERTIA_COEFF = 37 / 48;

  // The ceiling on how many bodies a running simulation may reach, however
  // many splitters it contains - see step()'s splitting section. Authoring
  // is capped far lower (PhysicsGPU.MAX_BODIES); this is only about what a
  // run may GROW to.
  //
  // The DEFAULT ceiling, for a scene that doesn't name its own. A scene can
  // (and for anything with a splitter, should) carry its own
  // `maxSimulationBodies` - see maxSimulationBodiesFor below.
  //
  // This number IS the compiled shader's size: physics-gpu.js pads a
  // splitter scene out to exactly this many body slots and unrolls every
  // pair among them, so the cost is quadratic in it. 20 is ~190 collision
  // pairs and a ~350KB shader that links in about three quarters of a
  // second - and every pixel of the fractal grid then runs all of that,
  // every step. Whatever it is set to, both engines must agree or a splitter
  // scene renders one thing on the grid and plays back another.
  var MAX_SIMULATION_BODIES = 20;
  // What the scene-level override may be set to. The floor is 2 because one
  // ball splitting into two is the smallest thing a splitter can do at all.
  //
  // The ceiling is NOT where it stops being slow - it is where it stops
  // being expressible. stepOnce() takes 4 parameters per authored body and 6
  // per spawn slot (a slot's shape constants, alive flag and lineage all
  // have to persist across calls), plus 2 per hinge and the shared
  // liveCount, against a hard GLSL limit of 256 parameters. 40 slots leaves
  // headroom for any authorable scene; past ~44 the shader stops compiling.
  // physics-gpu.js re-checks the real count and throws rather than trusting
  // this bound. Long before then it is unusably slow, which is exactly what
  // the control in #editor-view is for: start low, raise it until the
  // picture costs more than it is worth.
  var MIN_SIMULATION_BODIES = 2;
  var MAX_SIMULATION_BODIES_LIMIT = 40;

  // This scene's ceiling: its own `maxSimulationBodies` when it names a
  // usable one, the default otherwise. Clamped rather than rejected, and
  // rounded, so a hand-edited or out-of-range value in pasted JSON lands
  // somewhere sane instead of throwing or silently uncapping the run.
  function maxSimulationBodiesFor(scene) {
    var v = scene && Number(scene.maxSimulationBodies);
    if (!isFinite(v) || v <= 0) return MAX_SIMULATION_BODIES;
    return Math.min(MAX_SIMULATION_BODIES_LIMIT, Math.max(MIN_SIMULATION_BODIES, Math.round(v)));
  }
  // A hard ceiling on how fast anything may move. It originally existed to
  // stop tunneling: a body crossing an entire LINE_THICKNESS-wide collision
  // band within one step is past a thin line before any contact is detected,
  // and 1000 kept per-step movement (16.7px) under LINE_THICKNESS (20). That
  // job now belongs to the swept collision tests instead - circle and line
  // contacts both solve for the exact instant of impact along the step's
  // path, so nothing tunnels regardless of this value (verified by firing
  // circles at a thin line at up to 5000px/s with the cap at 10000: all
  // bounced).
  //
  // What the cap still does is silently delete the energy of anything that
  // would legitimately exceed it. Ordinary downward gravity rarely needs
  // this much, but leaves headroom for the faster scenes that do.
  var MAX_SPEED = 2000;
  // Under Mutual Gravity a real orbit does exceed it: a close perihelion
  // passage legitimately runs to ~2000px/s, and clamping that to 1000 threw
  // the body into a far lower orbit on its first pass - once, and then never
  // again, because the smaller orbit no longer reached the cap. That is the
  // "it drops, then looks correct forever after" this was reported as.
  var MUTUAL_GRAVITY_MAX_SPEED = 5000;

  // Whichever ceiling this scene runs under. Every copy of this rule - here,
  // physics-gpu.js's GLSL and physics-gpu-df.js's df GLSL - has to agree, or
  // the three implementations quietly simulate different physics; the JS/GPU
  // lockstep tests catch it, loudly (~100px of divergence, or a body landing
  // a whole frame period away).
  function speedCapFor(scene) {
    return scene.mutualGravity ? MUTUAL_GRAVITY_MAX_SPEED : MAX_SPEED;
  }
  // The constant downward pull whenever Mutual Gravity is off (under Mutual
  // Gravity nothing pulls "down" at all - see computeAccelerations). Fixed,
  // not a scene setting - and so are friction (none) and restitution
  // (perfectly elastic, apart from the resting-contact ramp below).
  var GRAVITY = 800;
  // Below this closing speed, treat restitution as 0. Without this, a body
  // resting under constant gravity never quite settles: each step gravity
  // adds a little velocity, and bouncing that back with restitution > 0
  // creates a permanent small jitter instead of coming to rest.
  var RESTITUTION_THRESHOLD = 30;
  var VELOCITY_ITERATIONS = 8;
  var POSITION_ITERATIONS = 4;
  var POSITION_SLOP = 0.01;
  var POSITION_PERCENT = 0.2;

  var WORLD_BODY = {
    x: 0, y: 0, angle: 0, vx: 0, vy: 0, w: 0,
    isAnchored: true, invMass: 0, invInertia: 0,
  };

  function rotateVec(v, angle) {
    var c = Math.cos(angle), s = Math.sin(angle);
    return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
  }

  function worldToLocal(dx, dy, angle) {
    var c = Math.cos(angle), s = Math.sin(angle);
    return { x: dx * c + dy * s, y: -dx * s + dy * c };
  }

  function dot(a, b) { return a.x * b.x + a.y * b.y; }
  function clampNum(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  function smoothstep(edge0, edge1, x) {
    var t = clampNum((x - edge0) / (edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
  }

  // Gravity + speed clamp over an arbitrary sub-step, not just the fixed
  // step dt - step() calls this once per leg of a CCD-split step (see its
  // own comment), so it has to be continuous in dt itself: dt=0 must reduce
  // to a clamp of an already-clamped vector, i.e. the identity.
  // Takes the whole acceleration as a vector rather than just a downward
  // scalar, because under Mutual Gravity (see computeAccelerations) every
  // body pulls in its own direction - uniform gravity is then simply the
  // special case where every body's acceleration is (0, GRAVITY).
  function advanceVelocity(vx, vy, dt, ax, ay, maxSpeed) {
    vx += ax * dt;
    vy += ay * dt;
    var speedSq = vx * vx + vy * vy;
    if (speedSq > maxSpeed * maxSpeed) {
      var scale = maxSpeed / Math.sqrt(speedSq);
      vx *= scale; vy *= scale;
    }
    return { x: vx, y: vy };
  }

  // ---- Mutual Gravity ----
  //
  // The alternative to the usual constant downward pull: no "down" at all,
  // every body instead attracting every other by Newton's inverse square.
  //
  // GRAVITATIONAL mass is deliberately NOT body.mass. computeMass gives an
  // anchored body mass 0 / invMass 0, which is how the solver reads "cannot
  // be pushed" - but a thing that can't be pushed should still pull, so the
  // attraction below derives mass from the body's shape instead, and gives
  // an anchored one 10x the density (its immovability reads as "much denser
  // stuff", and it makes anchors usable as the suns of a scene).
  var ANCHORED_GRAVITY_DENSITY = 10;
  // The one free parameter, since replacing the Gravity slider left no UI to
  // tune it with. Set so an anchored default-size circle (radius 30) pulls
  // at roughly GRAVITY from 300px away - near enough
  // that scenes built for downward gravity stay in a familiar range when
  // flipped over to Mutual, while two free bodies that far apart pull on
  // each other about ten times more gently, which is the regime where orbits
  // rather than immediate collapse happen.
  var MUTUAL_GRAVITY_CONSTANT = 2500;

  // A trapezoid (funnel/splitter) has no `length` - reading one here is what
  // used to turn every Mutual Gravity acceleration into NaN the moment a
  // funnel or splitter was in the scene, and NaN does not stay contained:
  // every distance comparison against it is false, so `dist >= rsum` reads as
  // "already touching" in every swept test, and a splitter then split its
  // ball on EVERY step, doubling the body count until the tab died. Both
  // functions below now answer for all four shapes.
  function gravitationalMass(body) {
    var density = body.isAnchored ? ANCHORED_GRAVITY_DENSITY : 1;
    if (body.type === "circle") return density * DENSITY * Math.PI * body.radius * body.radius;
    if (body.type === "funnel" || body.type === "splitter") {
      // Its own wall mass - the same closed form computeMass uses, which is
      // what "how much stuff is there" means for this shape.
      return density * LINE_LINEAR_DENSITY * FUNNEL_MASS_COEFF * body.size;
    }
    return density * LINE_LINEAR_DENSITY * body.length;
  }

  // How far from its own center a body reaches - the radius of a circle,
  // half the length of a line, and for a trapezoid the distance to its
  // furthest corner (the mouth corners, always). Used below only to decide
  // where the inverse square stops being the right law.
  var FUNNEL_CORNER_REACH = Math.sqrt(FUNNEL_MOUTH_HALF * FUNNEL_MOUTH_HALF + FUNNEL_HALF_HEIGHT * FUNNEL_HALF_HEIGHT);
  function halfExtent(body) {
    if (body.type === "circle") return body.radius;
    if (body.type === "funnel" || body.type === "splitter") return FUNNEL_CORNER_REACH * body.size;
    return body.length / 2;
  }

  // Each body's total acceleration for this step, as {x, y} per body.
  //
  // Uniform mode is the trivial case: everything accelerates downward at
  // GRAVITY. Under Mutual Gravity each body instead sums G*m/r^2
  // toward every OTHER body - including anchored ones, which pull without
  // ever being pulled (they don't move, and advanceVelocity is never called
  // for them, so their own entry is left at zero).
  //
  // TWO BODIES THAT ARE ACTUALLY TOUCHING EXERT NO MUTUAL GRAVITY - but only
  // when collisions are on. See the ramp below for the collisions-off case.
  //
  // Not an approximation for tidiness - without it the simulation invents
  // energy. Once a body settles against another it sits a fraction of a pixel
  // inside the surface, and the contact solver's positional correction pushes
  // it back out. That correction moves the body WITHOUT touching its
  // velocity, which in a gravitational field is a free lift out of the well:
  // it is work done from nothing. Right at contact this field is savage -
  // about 19,600 px/s^2 for a default circle resting on an anchored one,
  // twenty times ordinary gravity - so each nudge hands back a large slug of
  // potential energy, gravity converts it straight back to speed, the body
  // drives deeper, and the correction pushes harder still. Measured on the
  // scene this was reported from: energy climbing on 401 of 900 steps, the
  // body lodged inside the surface and whipping round it ever faster. With
  // this rule the same scene comes to rest exactly on the surface, which is
  // what it should have done.
  //
  // Physically it is also the honest reading: for bodies in contact the
  // normal force is what answers the attraction, and this engine's contact
  // solver already supplies that. Adding gravity on top double-counts it.
  //
  // Anything not touching is untouched by this: an orbit is an exact inverse
  // square the whole way round (a wide orbit's perihelion lands at 234px
  // against Kepler's 233, precessing 0.1 degrees per lap), and a head-on
  // bounce is bit-for-bit what it was, because the overlap lasts a step.
  //
  // It also removes the need for any softening of 1/r^2 near the origin: the
  // force can never be evaluated closer than the bodies' combined reach, so
  // it is bounded by its value there and never approaches the singularity.
  //
  // WITH COLLISIONS OFF, none of that reasoning survives. Nothing supplies the
  // force being removed (no contact solve, no merge - both are gated off), and
  // bodies pass straight through each other, so the region inside `contact`
  // stops being a one-step transient and becomes a gravity-free cavity they
  // coast through for as long as they like. Switching the pull off at its rim
  // is then a genuine discontinuity: at the shell the pull is ~1963 px/s^2 on
  // one side and exactly 0 on the other, so two neighbouring pixels whose
  // crossing lands on opposite sides of a single step differ by a whole step's
  // worth of it (~32.7 px/s) no matter how close their starting states are.
  // Measured on a reported scene: two starts 4.7e-5 px apart came out 133.9 px
  // apart, and that gap stayed at 133.9 px as the starts were brought 7 decades
  // closer together - a gap that will not close is a discontinuity, not chaos.
  //
  // So with collisions off the pull ramps down instead of falling off a cliff:
  // outside, the usual G*m/r^2; inside, G*m*r/contact^3, which is the textbook
  // interior solution for a body of uniform density (only the enclosed mass
  // pulls). The two agree exactly at r == contact and the ramp reaches 0 at
  // r == 0, so the field is continuous everywhere and still has no singularity
  // to guard against. Measured on the same scene: adjacent-sample jumps then
  // fall 10x per 10x of refinement across 5 decades, and peak speed over the
  // whole parameter sweep is 465 px/s against the 5000 cap - where dropping the
  // rule entirely (plain 1/r^2 all the way down) pins the cap at 5000 and still
  // leaves 3e+4 px jumps at practical sampling.
  function computeAccelerations(scene) {
    var bodies = scene.bodies, n = bodies.length, i, acc = new Array(n);
    if (!scene.mutualGravity) {
      for (i = 0; i < n; i++) acc[i] = { x: 0, y: GRAVITY };
      return acc;
    }
    for (i = 0; i < n; i++) {
      var ax = 0, ay = 0;
      if (!bodies[i].isAnchored) {
        for (var j = 0; j < n; j++) {
          if (j === i) continue;
          var dx = bodies[j].x - bodies[i].x;
          var dy = bodies[j].y - bodies[i].y;
          var r2 = dx * dx + dy * dy;
          var contact = halfExtent(bodies[i]) + halfExtent(bodies[j]);
          var pull;
          if (r2 >= contact * contact) {
            pull = MUTUAL_GRAVITY_CONSTANT * gravitationalMass(bodies[j]) / (r2 * Math.sqrt(r2));
          } else if (collisionsEnabled(scene)) {
            continue; // touching - the contact force answers for it
          } else {
            // Uniform-density interior: |a| = G*m*r/contact^3, linear in r.
            pull = MUTUAL_GRAVITY_CONSTANT * gravitationalMass(bodies[j]) / (contact * contact * contact);
          }
          ax += pull * dx;
          ay += pull * dy;
        }
      }
      acc[i] = { x: ax, y: ay };
    }
    return acc;
  }

  // ---- Merge on contact (Mutual Gravity only) ----
  //
  // Two bodies that are touching stop being two things and start moving as
  // one: they take a single momentum-weighted velocity, so nothing can move
  // relative to anything else in the cluster. Against an anchored body that
  // velocity is zero - an anchor absorbs whatever lands on it.
  //
  // This is what an n-body simulation normally does with a collision, and it
  // exists here because contact and Mutual Gravity together are the one
  // regime this engine cannot integrate. Right at contact the field reaches
  // ~19,600 px/s^2 for a default circle on an anchored one - twenty times
  // ordinary gravity - so a 1/60s step changes velocity by ~330 px/s inside
  // a single step, and the contact solver's positional correction (which
  // moves bodies without touching their velocity, doing work from nothing)
  // stops being a small correction. Measured on the scene this was reported
  // from: a body arriving at 165px/s was pumped into a surface-skimming
  // orbit at ~1000px/s. Merging removes the regime rather than managing it.
  //
  // No "merged" flag is stored, and none is needed: the state sustains
  // itself. Bodies in contact exert no mutual gravity (see
  // computeAccelerations) and now share one velocity, so nothing drives them
  // apart; the contact solver's positional correction deliberately
  // under-corrects, leaving them a hair overlapped and therefore still
  // touching next step. That matters well beyond tidiness - it means the
  // GPU port needs no per-body state carried across steps, which the shader
  // has nowhere to put.
  //
  // Applied BEFORE the step's acceleration and velocity are read, so the
  // merged velocity is what the whole step - both CCD legs and the
  // detection sweep - actually runs on. Applying it after contact detection
  // instead does NOT hold: gravity from the start of that step is still in
  // flight and re-launches the body within the same step (measured: the
  // reported scene stayed at ~954px/s instead of settling).
  function weldPair(a, b) {
    if (a.isAnchored && b.isAnchored) return;
    if (a.isAnchored) { b.vx = 0; b.vy = 0; b.w = 0; return; }
    if (b.isAnchored) { a.vx = 0; a.vy = 0; a.w = 0; return; }
    // Perfectly inelastic: one velocity for both, conserving momentum.
    var total = a.mass + b.mass;
    var vx = (a.mass * a.vx + b.mass * b.vx) / total;
    var vy = (a.mass * a.vy + b.mass * b.vy) / total;
    var w = (a.mass * a.w + b.mass * b.w) / total;
    a.vx = vx; a.vy = vy; a.w = w;
    b.vx = vx; b.vy = vy; b.w = w;
  }

  // Bodies already overlapping at the start of the step. This is the half
  // that makes a merge STAY merged.
  //
  // Skips exactly the pairs collision detection skips - two anchored bodies,
  // and anything joined by a hinge. The hinge case matters: a pendulum's
  // links overlap at their shared pivot permanently, so welding on overlap
  // would freeze every hinged assembly solid the moment Mutual Gravity was
  // switched on. They are already one assembly; the hinge solver owns them.
  function applyContactMerge(scene) {
    var bodies = scene.bodies, n = bodies.length;
    for (var i = 0; i < n; i++) {
      for (var j = i + 1; j < n; j++) {
        var a = bodies[i], b = bodies[j];
        if (a.isAnchored && b.isAnchored) continue;
        if (hingeConnects(scene.hinges, i, j)) continue;
        var dx = b.x - a.x, dy = b.y - a.y;
        var contact = halfExtent(a) + halfExtent(b);
        if (dx * dx + dy * dy > contact * contact) continue;
        weldPair(a, b);
      }
    }
  }

  // The other half: pairs the swept detection found during this step. A fast
  // approach can close, touch and rebound entirely between two step
  // boundaries, so it is never seen overlapping by the check above and would
  // bounce straight through the merge. Applied after leg 1 has moved the
  // bodies to the contact instant and before the impulse solver runs, so the
  // solver finds no relative velocity left to bounce.
  function mergeDetectedContacts(scene, contacts) {
    for (var c = 0; c < contacts.length; c++) {
      weldPair(scene.bodies[contacts[c].a], scene.bodies[contacts[c].b]);
    }
  }

  function computeMass(body) {
    if (body.isAnchored) {
      body.mass = 0; body.invMass = 0; body.inertia = 0; body.invInertia = 0;
      return;
    }
    if (body.type === "circle") {
      var area = Math.PI * body.radius * body.radius;
      body.mass = DENSITY * area;
      body.inertia = body.mass * body.radius * body.radius / 2;
    } else if (body.type === "funnel" || body.type === "splitter") {
      // A splitter is the identical trapezoid (same material, same
      // formula) - only which edge does what differs. See createSplitter.
      body.mass = LINE_LINEAR_DENSITY * FUNNEL_MASS_COEFF * body.size;
      body.inertia = LINE_LINEAR_DENSITY * FUNNEL_INERTIA_COEFF * body.size * body.size * body.size;
    } else {
      // Thin rod about its center: I = m*L^2/12.
      body.mass = LINE_LINEAR_DENSITY * body.length;
      body.inertia = body.mass * body.length * body.length / 12;
    }
    body.invMass = body.mass > 0 ? 1 / body.mass : 0;
    body.invInertia = body.inertia > 0 ? 1 / body.inertia : 0;
  }

  function createCircle(x, y, radius, isAnchored) {
    var b = { type: "circle", x: x, y: y, angle: 0, radius: radius, vx: 0, vy: 0, w: 0, isAnchored: !!isAnchored };
    computeMass(b);
    return b;
  }

  function createLine(x, y, length, angle, isAnchored) {
    var b = { type: "line", x: x, y: y, angle: angle || 0, length: length, vx: 0, vy: 0, w: 0, isAnchored: !!isAnchored };
    computeMass(b);
    return b;
  }

  function createFunnel(x, y, size, angle, isAnchored) {
    var b = { type: "funnel", x: x, y: y, angle: angle || 0, size: size, vx: 0, vy: 0, w: 0, isAnchored: !!isAnchored };
    computeMass(b);
    return b;
  }

  // Same trapezoid as a funnel (identical geometry/mass - see
  // getFunnelVertices/getFunnelEdges and computeMass's shared branch above),
  // with the special edge swapped: a circle touching the SHORT side (the
  // funnel's "throat") here splits into two, rather than a circle touching
  // the long side (the funnel's "mouth") teleporting - see
  // collideSplitterShortSideTHit and step()'s splitting section.
  function createSplitter(x, y, size, angle, isAnchored) {
    var b = { type: "splitter", x: x, y: y, angle: angle || 0, size: size, vx: 0, vy: 0, w: 0, isAnchored: !!isAnchored };
    computeMass(b);
    return b;
  }

  function getLineEndpoints(line) {
    var hx = Math.cos(line.angle) * line.length / 2;
    var hy = Math.sin(line.angle) * line.length / 2;
    return [{ x: line.x - hx, y: line.y - hy }, { x: line.x + hx, y: line.y + hy }];
  }

  // The 4 corners in the funnel's own local frame (unrotated, uncentered) -
  // used both to place them in the world (getFunnelVertices) and, by
  // physics-hinge-geometry.js, to get an axis-aligned bounding box for an
  // anchored funnel's frame-edge check without duplicating this shape.
  function getFunnelLocalVertices(size) {
    var mh = FUNNEL_MOUTH_HALF * size, th = FUNNEL_THROAT_HALF * size, hh = FUNNEL_HALF_HEIGHT * size;
    return {
      mouthLeft: { x: -mh, y: -hh },
      mouthRight: { x: mh, y: -hh },
      throatLeft: { x: -th, y: hh },
      throatRight: { x: th, y: hh },
    };
  }

  function getFunnelVertices(funnel) {
    var local = getFunnelLocalVertices(funnel.size);
    var out = {};
    for (var k in local) {
      var r = rotateVec(local[k], funnel.angle);
      out[k] = { x: funnel.x + r.x, y: funnel.y + r.y };
    }
    return out;
  }

  // mouth: the teleport trigger (length-3 side). throat/leg1/leg2: the 3
  // solid, bouncing edges (length-1 side and the two length-2 legs).
  // throatCenter is exposed separately since it's the teleport destination.
  function getFunnelEdges(funnel) {
    var v = getFunnelVertices(funnel);
    return {
      mouth: [v.mouthLeft, v.mouthRight],
      throat: [v.throatLeft, v.throatRight],
      leg1: [v.mouthLeft, v.throatLeft],
      leg2: [v.mouthRight, v.throatRight],
      throatCenter: { x: (v.throatLeft.x + v.throatRight.x) / 2, y: (v.throatLeft.y + v.throatRight.y) / 2 },
    };
  }

  function closestPointOnSegment(p1, p2, point) {
    var dx = p2.x - p1.x, dy = p2.y - p1.y;
    var lenSq = dx * dx + dy * dy;
    var t = lenSq > 1e-12 ? ((point.x - p1.x) * dx + (point.y - p1.y) * dy) / lenSq : 0;
    t = clampNum(t, 0, 1);
    return { x: p1.x + t * dx, y: p1.y + t * dy };
  }

  // Standard closest-points-between-two-segments algorithm
  // (Ericson, "Real-Time Collision Detection", ClosestPtSegmentSegment).
  function closestPointsSegmentSegment(p1, q1, p2, q2) {
    var d1 = { x: q1.x - p1.x, y: q1.y - p1.y };
    var d2 = { x: q2.x - p2.x, y: q2.y - p2.y };
    var r = { x: p1.x - p2.x, y: p1.y - p2.y };
    var a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
    var EPS = 1e-9;
    var s, t;
    if (a <= EPS && e <= EPS) {
      s = 0; t = 0;
    } else if (a <= EPS) {
      s = 0; t = clampNum(f / e, 0, 1);
    } else {
      var c = dot(d1, r);
      if (e <= EPS) {
        t = 0; s = clampNum(-c / a, 0, 1);
      } else {
        var b = dot(d1, d2);
        var denom = a * e - b * b;
        s = denom !== 0 ? clampNum((b * f - c * e) / denom, 0, 1) : 0;
        t = (b * s + f) / e;
        if (t < 0) { t = 0; s = clampNum(-c / a, 0, 1); }
        else if (t > 1) { t = 1; s = clampNum((b - c) / a, 0, 1); }
      }
    }
    return {
      c1: { x: p1.x + d1.x * s, y: p1.y + d1.y * s },
      c2: { x: p2.x + d2.x * t, y: p2.y + d2.y * t },
    };
  }

  function pointInBody(body, px, py) {
    if (body.type === "circle") {
      var dx = px - body.x, dy = py - body.y;
      return dx * dx + dy * dy <= body.radius * body.radius;
    }
    var r = LINE_THICKNESS / 2;
    if (body.type === "funnel" || body.type === "splitter") {
      var edges = getFunnelEdges(body);
      var segs = [edges.mouth, edges.throat, edges.leg1, edges.leg2];
      for (var i = 0; i < segs.length; i++) {
        var c = closestPointOnSegment(segs[i][0], segs[i][1], { x: px, y: py });
        var cdx = px - c.x, cdy = py - c.y;
        if (cdx * cdx + cdy * cdy <= r * r) return true;
      }
      return false;
    }
    var endpoints = getLineEndpoints(body);
    var closest = closestPointOnSegment(endpoints[0], endpoints[1], { x: px, y: py });
    var ddx = px - closest.x, ddy = py - closest.y;
    return ddx * ddx + ddy * ddy <= r * r;
  }

  // ---- Collision detection. Every collider returns contacts whose normal
  // points from its first argument body toward its second (A -> B). Lines
  // collide as capsules: closest-point math plus a fixed LINE_THICKNESS,
  // deliberately simple rather than a full polygon manifold. ----

  // Sweep primitives: each returns the earliest t in [0,dt] at which a point
  // travelling from (px,py) at constant velocity (vx,vy) first reaches
  // distance R from the feature, or -1 if that never happens inside the step.

  function sweepPointSphere(px, py, vx, vy, cx, cy, R, dt) {
    var dx = px - cx, dy = py - cy;
    var qc = dx * dx + dy * dy - R * R;
    if (qc <= 0) return 0;
    var qa = vx * vx + vy * vy;
    if (qa <= 1e-9) return -1;
    var qb = 2 * (dx * vx + dy * vy);
    var disc = qb * qb - 4 * qa * qc;
    if (disc < 0) return -1;
    var t = (-qb - Math.sqrt(disc)) / (2 * qa);
    if (t < 0 || t > dt) return -1;
    return t;
  }

  // The flat side of the capsule: the perpendicular offset must reach +-R
  // while the axial parameter is still inside [0,len]. Outside that axial
  // span the caps own the contact, so this returns -1 and lets
  // sweepPointSphere win.
  function sweepPointSlab(px, py, vx, vy, e0x, e0y, dirx, diry, len, R, dt) {
    var perpx = -diry, perpy = dirx;
    var f0 = (px - e0x) * perpx + (py - e0y) * perpy;
    var fv = vx * perpx + vy * perpy;
    var t;
    if (Math.abs(f0) <= R) {
      t = 0;
    } else {
      var target = f0 > 0 ? R : -R;
      if (Math.abs(fv) <= 1e-9) return -1;
      t = (target - f0) / fv;
      if (t < 0 || t > dt) return -1;
    }
    var s = (px + vx * t - e0x) * dirx + (py + vy * t - e0y) * diry;
    if (s < 0 || s > len) return -1;
    return t;
  }

  function collideCircleCircle(a, b, dt) {
    var dx = b.x - a.x, dy = b.y - a.y;
    var dist = Math.sqrt(dx * dx + dy * dy);
    var rsum = a.radius + b.radius;
    if (dist >= rsum) {
      // Not touching yet at the start of this step - solve for whether
      // straight-line motion at the current velocities brings them together
      // before this step's own dt elapses. Without this, a fast enough
      // approach only gets caught once some future step's STARTING position
      // happens to already be past the boundary - which step that ends up
      // being is a discontinuous function of the starting conditions, so
      // the resulting bounce is too (a tiny nudge to a starting position
      // can shift which discrete step first notices contact, and each
      // step's own velocity/penetration state differs). Solving the exact
      // crossing time instead makes the contact normal - and everything
      // downstream of it - a continuous function of where things started.
      var vrx = b.vx - a.vx, vry = b.vy - a.vy;
      var qa = vrx * vrx + vry * vry;
      var qb = 2 * (dx * vrx + dy * vry);
      var qc = dist * dist - rsum * rsum;
      var disc = qb * qb - 4 * qa * qc;
      if (qa <= 1e-9 || disc < 0) return null;
      var t = (-qb - Math.sqrt(disc)) / (2 * qa);
      if (t < 0 || t > dt) return null;
      var hitDx = dx + vrx * t, hitDy = dy + vry * t;
      var hitDist = Math.sqrt(hitDx * hitDx + hitDy * hitDy);
      var hnx = hitDist > 1e-9 ? hitDx / hitDist : 0;
      var hny = hitDist > 1e-9 ? hitDy / hitDist : 1;
      // Evaluated at the true contact instant (a's position advanced by t),
      // not a's stale start-of-step position - otherwise rB below (point
      // minus b's UNADVANCED center) picks up a spurious component along
      // vRel*t instead of landing exactly on -n*b.radius, injecting phantom
      // spin into a contact that should only ever be linear for two
      // circles. rA and rB are the lever arms themselves, not derived by
      // subtracting a center from .point at solve time - for a circle the
      // lever arm is always exactly ±n*radius by construction, regardless
      // of any sub-step timing.
      var posAx = a.x + a.vx * t, posAy = a.y + a.vy * t;
      return [{
        normal: { x: hnx, y: hny },
        point: { x: posAx + hnx * a.radius, y: posAy + hny * a.radius },
        rA: { x: hnx * a.radius, y: hny * a.radius },
        rB: { x: -hnx * b.radius, y: -hny * b.radius },
        penetration: 0,
        tHit: t,
      }];
    }
    var nx = dist > 1e-9 ? dx / dist : 0;
    var ny = dist > 1e-9 ? dy / dist : 1;
    return [{
      normal: { x: nx, y: ny },
      point: { x: a.x + nx * a.radius, y: a.y + ny * a.radius },
      rA: { x: nx * a.radius, y: ny * a.radius },
      rB: { x: -nx * b.radius, y: -ny * b.radius },
      penetration: rsum - dist,
      tHit: 0,
    }];
  }

  // Swept capsule (segment e0-e1, half-thickness halfThickness, moving at
  // constant velocity segVx/segVy, otherwise rigid - rotation during the
  // step is ignored, matching the capsule's own historical approximation)
  // vs. circle. Shared by collideLineCircle (segment = the line's own body,
  // refX/refY = its center) and collideFunnelCircle (segment = one of the
  // funnel's 3 solid edges, refX/refY = the FUNNEL's center, since rA is a
  // lever arm on the whole funnel body, not on an implicit sub-body) - same
  // three sub-tests (flat side of the capsule plus a cap at each endpoint),
  // earliest valid t wins, exactly as collideLineCircle always worked.
  // Returns null if the capsule and circle never come within halfThickness+
  // circle.radius of each other during [0, dt].
  function sweptCapsuleCircleContact(e0, e1, segVx, segVy, refX, refY, circle, halfThickness, dt) {
    var p0x = circle.x, p0y = circle.y;
    var vrx = circle.vx - segVx, vry = circle.vy - segVy;
    var rsum = halfThickness + circle.radius;

    var closest0 = closestPointOnSegment(e0, e1, { x: p0x, y: p0y });
    var dist0x = p0x - closest0.x, dist0y = p0y - closest0.y;
    var dist0 = Math.sqrt(dist0x * dist0x + dist0y * dist0y);
    var tHit = 0;

    if (dist0 >= rsum) {
      var segx = e1.x - e0.x, segy = e1.y - e0.y;
      var segLen = Math.sqrt(segx * segx + segy * segy);
      var dirx = segLen > 1e-9 ? segx / segLen : 1;
      var diry = segLen > 1e-9 ? segy / segLen : 0;

      var best = -1;
      var tSlab = sweepPointSlab(p0x, p0y, vrx, vry, e0.x, e0.y, dirx, diry, segLen, rsum, dt);
      if (tSlab >= 0) best = tSlab;
      var tCap0 = sweepPointSphere(p0x, p0y, vrx, vry, e0.x, e0.y, rsum, dt);
      if (tCap0 >= 0 && (best < 0 || tCap0 < best)) best = tCap0;
      var tCap1 = sweepPointSphere(p0x, p0y, vrx, vry, e1.x, e1.y, rsum, dt);
      if (tCap1 >= 0 && (best < 0 || tCap1 < best)) best = tCap1;
      if (best < 0) return null;
      tHit = best;
    }

    var pHitx = p0x + vrx * tHit, pHity = p0y + vry * tHit;
    var closest = closestPointOnSegment(e0, e1, { x: pHitx, y: pHity });
    var dx = pHitx - closest.x, dy = pHity - closest.y;
    var dist = Math.sqrt(dx * dx + dy * dy);
    var nx = dist > 1e-9 ? dx / dist : 0;
    var ny = dist > 1e-9 ? dy / dist : 1;

    // Everything above is in the segment's frame; its own translation over
    // tHit shifts .point and its reference center equally, so it cancels
    // out of rA.
    var segOffsetX = segVx * tHit, segOffsetY = segVy * tHit;
    var px = closest.x + nx * halfThickness, py = closest.y + ny * halfThickness;

    return {
      normal: { x: nx, y: ny },
      point: { x: px + segOffsetX, y: py + segOffsetY },
      rA: { x: px - refX, y: py - refY },
      rB: { x: -nx * circle.radius, y: -ny * circle.radius },
      penetration: Math.max(rsum - dist, 0),
      tHit: tHit,
    };
  }

  // line = A, circle = B; normal returned points line -> circle. Swept, for
  // the same reason collideCircleCircle is: a discrete test only notices
  // contact once some step's STARTING configuration is already overlapping,
  // and which step that is jumps with the starting conditions. Runs in the
  // line's frame (relative velocity, endpoints held fixed), so it ignores
  // rotation of the line during the step.
  function collideLineCircle(line, circle, dt) {
    var endpoints = getLineEndpoints(line);
    var c = sweptCapsuleCircleContact(endpoints[0], endpoints[1], line.vx, line.vy, line.x, line.y, circle, LINE_THICKNESS / 2, dt);
    return c ? [c] : null;
  }

  // funnel = A, circle = B. The 3 solid edges (throat + 2 legs) bounce like
  // a line each; the mouth (see collideFunnelMouthTHit) never appears here -
  // it teleports instead of colliding, handled separately in step(). More
  // than one edge can register in the same step (e.g. a ball resting in the
  // throat/leg corner needs both normals to be stable, the same reason
  // collideLineLine already returns up to 2 contacts for a flush pair).
  function collideFunnelCircle(funnel, circle, dt) {
    var edges = getFunnelEdges(funnel);
    var halfThickness = LINE_THICKNESS / 2;
    var solidEdges = [edges.throat, edges.leg1, edges.leg2];
    var contacts = [];
    for (var i = 0; i < solidEdges.length; i++) {
      var c = sweptCapsuleCircleContact(solidEdges[i][0], solidEdges[i][1], funnel.vx, funnel.vy, funnel.x, funnel.y, circle, halfThickness, dt);
      if (c) contacts.push(c);
    }
    return contacts.length ? contacts : null;
  }

  // Does circle's path touch funnel's mouth (the teleport trigger) sometime
  // in [0, dt]? Uses the same swept capsule test as the solid edges (same
  // halfThickness, so the trigger reads as the same "wall" thickness the
  // mouth is drawn at) but only ever needs tHit and the teleport
  // destination - normal/point/rA/rB are meaningless for a teleport, since
  // no impulse is ever applied. targetX/Y is the funnel's OWN throat center
  // advanced by the funnel's velocity to the same tHit (consistent with how
  // the funnel's translation-during-the-sweep is already handled for the
  // solid edges), rotated by the funnel's angle at the START of the step -
  // rotation during the step is ignored, the same simplification every
  // capsule test here already makes.
  function collideFunnelMouthTHit(funnel, circle, dt) {
    var edges = getFunnelEdges(funnel);
    var contact = sweptCapsuleCircleContact(edges.mouth[0], edges.mouth[1], funnel.vx, funnel.vy, funnel.x, funnel.y, circle, LINE_THICKNESS / 2, dt);
    if (!contact) return null;
    var th = contact.tHit;
    var localThroatCenter = { x: 0, y: FUNNEL_HALF_HEIGHT * funnel.size };
    var rotated = rotateVec(localThroatCenter, funnel.angle);
    return {
      tHit: th,
      targetX: funnel.x + funnel.vx * th + rotated.x,
      targetY: funnel.y + funnel.vy * th + rotated.y,
    };
  }

  // splitter = A, circle = B. The 3 solid edges (mouth + 2 legs) bounce like
  // a line each - the short side (see collideSplitterShortSideTHit) never
  // appears here; it splits the circle in two instead of colliding, handled
  // separately in step(). Mirrors collideFunnelCircle exactly, with the
  // trigger edge swapped (mouth instead of throat).
  function collideSplitterCircle(splitter, circle, dt) {
    var edges = getFunnelEdges(splitter);
    var halfThickness = LINE_THICKNESS / 2;
    var solidEdges = [edges.mouth, edges.leg1, edges.leg2];
    var contacts = [];
    for (var i = 0; i < solidEdges.length; i++) {
      var c = sweptCapsuleCircleContact(solidEdges[i][0], solidEdges[i][1], splitter.vx, splitter.vy, splitter.x, splitter.y, circle, halfThickness, dt);
      if (c) contacts.push(c);
    }
    return contacts.length ? contacts : null;
  }

  // Does circle's path touch splitter's short side (the split trigger)
  // sometime in [0, dt]? Same swept capsule test collideFunnelMouthTHit uses
  // against the mouth, run here against the throat instead - but returns
  // two DISPLACEMENTS rather than one teleport target (see step()'s
  // splitting section for how they're used: the circle this hit becomes
  // two, each moved by one of them, both keeping its velocity).
  //
  // Offsets, not points on the long side. The rule being implemented is
  // "the contact's distance from a short-side corner is preserved as the
  // distance from the corresponding long-side corner" - and the map that
  // does that is a pure translation by the leg vector joining those two
  // corners. offset1 slides the ball down the left leg (throatLeft ->
  // mouthLeft); offset2 slides it down the right leg (throatRight ->
  // mouthRight). Since the two parallel sides share a direction, a
  // translation moves a point at distance d from throatLeft to distance d
  // from mouthLeft exactly, for every d, with no d appearing in the formula
  // at all - the worked example (0.75/0.25 through a length-1 throat
  // against a length-3 mouth, landing 2 units apart) falls out of the
  // geometry rather than being solved for.
  //
  // Why it matters that this is a translation and not a snap: computing an
  // absolute landing point discards how far past the short side the ball
  // actually got this step, replacing it with a point exactly on the long
  // side. Two pixels whose balls cross at slightly different speeds then
  // produce the same post-split position, and the perpendicular component
  // of the answer jumps to a constant at the split - a discontinuity in the
  // one variable the fractal grid is a picture OF. Translating instead
  // carries the ball's own sub-step overshoot through untouched, so the
  // post-split state stays a continuous function of the pre-split state.
  //
  // The splitter's own motion drops out for free: at the contact instant
  // both corners have moved by the same splitter velocity, so their
  // difference - the leg vector - is unchanged by it. An earlier
  // absolute-target version had to add splitter.v * tHit back in by hand.
  //
  // ...plus one constant clearance, without which the feature doesn't work
  // at all. The trigger fires off a SWEPT capsule test, so it fires while
  // the ball is still (halfThickness + radius) short of the short side's
  // centerline - it has touched the surface, not crossed the line. A pure
  // leg-vector translation preserves that "short by 14px" faithfully, which
  // on the far side means 14px short of the LONG side's centerline - i.e.
  // inside its wall, where the ball then bounces back in and is trapped
  // inside the trapezoid forever. (Observed exactly that: both halves stuck
  // at y=444 against a mouth wall spanning 442-462, ping-ponging until the
  // run ended.)
  //
  // So the two surfaces are matched up instead of the two centerlines: a
  // ball touching the entrance surface comes out touching the exit surface,
  // from the outside. That is one extra step of 2*(halfThickness + radius)
  // along the throat->mouth normal - a constant for a given ball, so the
  // map is still a pure translation and still exactly as continuous as the
  // leg vector alone. Anything arriving faster than that crosses further
  // in and correspondingly further out, which is the continuity this is
  // all for.
  function collideSplitterShortSideTHit(splitter, circle, dt) {
    var edges = getFunnelEdges(splitter);
    var throatLeft0 = edges.throat[0], throatRight0 = edges.throat[1];

    // Only a FRESH crossing splits. A circle that was already inside the
    // trigger's capsule when the step began - resting against the short
    // side, or grazing along it - would otherwise re-split on every single
    // step, and since each split adds a body that is exponential growth
    // measured in steps, not an occasional extra ball. Requiring the circle
    // to have been clear at the start of the step makes each pass through
    // the short side split exactly once, however slowly it crosses.
    var startClosest = closestPointOnSegment(throatLeft0, throatRight0, { x: circle.x, y: circle.y });
    var sdx = circle.x - startClosest.x, sdy = circle.y - startClosest.y;
    if (Math.sqrt(sdx * sdx + sdy * sdy) < LINE_THICKNESS / 2 + circle.radius) return null;

    var contact = sweptCapsuleCircleContact(edges.throat[0], edges.throat[1], splitter.vx, splitter.vy, splitter.x, splitter.y, circle, LINE_THICKNESS / 2, dt);
    if (!contact) return null;

    var mouthLeft = edges.mouth[0], mouthRight = edges.mouth[1];
    // Unit normal of the two parallel sides, pointing the way a ball
    // travels through: short side -> long side.
    var exitX = (mouthLeft.x + mouthRight.x) / 2 - (throatLeft0.x + throatRight0.x) / 2;
    var exitY = (mouthLeft.y + mouthRight.y) / 2 - (throatLeft0.y + throatRight0.y) / 2;
    var exitLen = Math.sqrt(exitX * exitX + exitY * exitY) || 1;
    var clearance = LINE_THICKNESS + 2 * circle.radius; // 2 * (halfThickness + radius)
    var clearX = exitX / exitLen * clearance, clearY = exitY / exitLen * clearance;
    return {
      tHit: contact.tHit,
      offset1: { x: mouthLeft.x - throatLeft0.x + clearX, y: mouthLeft.y - throatLeft0.y + clearY },
      offset2: { x: mouthRight.x - throatRight0.x + clearX, y: mouthRight.y - throatRight0.y + clearY },
    };
  }

  // A single contact point can't stop a line from spinning around it (real
  // physics: hitting a rod off-center mostly imparts spin, not braking), so
  // two lines lying flat against each other need contact at BOTH ends of
  // their overlap to actually rest - otherwise a rod dropped flat on the
  // ground just spins away on first touch instead of settling. This is
  // still just axis-aligned interval overlap, not a general polygon
  // manifold, so it stays simple; it only kicks in for the near-parallel
  // case, and falls back to a single closest-point contact otherwise.
  var LINE_PARALLEL_EPS = 0.05; // ~3 degrees

  function collideLineLine(lineA, lineB) {
    var eA = getLineEndpoints(lineA), eB = getLineEndpoints(lineB);
    var dirA = { x: eA[1].x - eA[0].x, y: eA[1].y - eA[0].y };
    var lenA = Math.sqrt(dot(dirA, dirA)) || 1;
    dirA.x /= lenA; dirA.y /= lenA;
    var dirB = { x: eB[1].x - eB[0].x, y: eB[1].y - eB[0].y };
    var lenB = Math.sqrt(dot(dirB, dirB)) || 1;
    var cross = dirA.x * (dirB.y / lenB) - dirA.y * (dirB.x / lenB);

    if (Math.abs(cross) < LINE_PARALLEL_EPS) {
      var perp = { x: -dirA.y, y: dirA.x };
      var offset = dot({ x: eB[0].x - eA[0].x, y: eB[0].y - eA[0].y }, perp);
      var dist = Math.abs(offset);
      if (dist < LINE_THICKNESS) {
        var b0 = dot({ x: eB[0].x - eA[0].x, y: eB[0].y - eA[0].y }, dirA);
        var b1 = dot({ x: eB[1].x - eA[0].x, y: eB[1].y - eA[0].y }, dirA);
        var lo = Math.max(0, Math.min(b0, b1));
        var hi = Math.min(lenA, Math.max(b0, b1));
        if (hi > lo) {
          var sign = offset >= 0 ? 1 : -1;
          var normal = { x: perp.x * sign, y: perp.y * sign };
          var penetration = LINE_THICKNESS - dist;
          var ts = hi - lo > 1e-6 ? [lo, hi] : [lo];
          return ts.map(function (t) {
            var pOnA = { x: eA[0].x + dirA.x * t, y: eA[0].y + dirA.y * t };
            var px = pOnA.x + perp.x * offset / 2, py = pOnA.y + perp.y * offset / 2;
            return {
              normal: normal,
              point: { x: px, y: py },
              rA: { x: px - lineA.x, y: py - lineA.y },
              rB: { x: px - lineB.x, y: py - lineB.y },
              penetration: penetration,
              tHit: 0,
            };
          });
        }
      }
    }

    var cp = closestPointsSegmentSegment(eA[0], eA[1], eB[0], eB[1]);
    var dx = cp.c2.x - cp.c1.x, dy = cp.c2.y - cp.c1.y;
    var dist2 = Math.sqrt(dx * dx + dy * dy);
    var rsum = LINE_THICKNESS;
    if (dist2 >= rsum) return null;
    var nx = dist2 > 1e-9 ? dx / dist2 : 0;
    var ny = dist2 > 1e-9 ? dy / dist2 : 1;
    var px2 = (cp.c1.x + cp.c2.x) / 2, py2 = (cp.c1.y + cp.c2.y) / 2;
    return [{
      normal: { x: nx, y: ny },
      point: { x: px2, y: py2 },
      rA: { x: px2 - lineA.x, y: py2 - lineA.y },
      rB: { x: px2 - lineB.x, y: py2 - lineB.y },
      penetration: rsum - dist2,
      tHit: 0,
    }];
  }

  // A and B are expected to be PROBE bodies here (real position, velocity
  // advanced by this step's own gravity+clamp - see step()'s comment) so
  // the swept tests solve against the same straight-line motion the body
  // is actually about to take in leg 1, not its pre-gravity entering
  // velocity. tHit (fraction of dt at which contact begins - 0 if already
  // touching at the start of this step, up to dt for a just-barely-caught
  // CCD contact) is set explicitly by every collide function now.
  function collidePair(A, B, dt) {
    var cs;
    if (A.type === "circle" && B.type === "circle") cs = collideCircleCircle(A, B, dt);
    else if (A.type === "line" && B.type === "circle") cs = collideLineCircle(A, B, dt);
    else if (A.type === "circle" && B.type === "line") {
      // collideLineCircle(line, circle) always takes (line, circle) in that
      // order, so calling it as (B, A) here returns rA/rB for (line=B,
      // circle=A) - the opposite of this function's own A/B. Swap them back
      // along with flipping the normal, or the caller (which always passes
      // bodies[contacts[i].a] as bodyA) ends up applying the line's lever
      // arm to the circle and vice versa.
      cs = collideLineCircle(B, A, dt);
      if (cs) for (var i = 0; i < cs.length; i++) {
        cs[i].normal.x *= -1; cs[i].normal.y *= -1;
        var tmp = cs[i].rA; cs[i].rA = cs[i].rB; cs[i].rB = tmp;
      }
    } else if (A.type === "funnel" && B.type === "circle") {
      cs = collideFunnelCircle(A, B, dt);
    } else if (A.type === "circle" && B.type === "funnel") {
      // Same swap-back as the line/circle case above and for the same
      // reason: collideFunnelCircle(funnel, circle) always returns rA/rB
      // for (funnel=B, circle=A) here, the opposite of this function's own
      // A/B order.
      cs = collideFunnelCircle(B, A, dt);
      if (cs) for (var j = 0; j < cs.length; j++) {
        cs[j].normal.x *= -1; cs[j].normal.y *= -1;
        var tmp2 = cs[j].rA; cs[j].rA = cs[j].rB; cs[j].rB = tmp2;
      }
    } else if (A.type === "splitter" && B.type === "circle") {
      cs = collideSplitterCircle(A, B, dt);
    } else if (A.type === "circle" && B.type === "splitter") {
      // Same swap-back as the funnel/circle case above and for the same
      // reason.
      cs = collideSplitterCircle(B, A, dt);
      if (cs) for (var k = 0; k < cs.length; k++) {
        cs[k].normal.x *= -1; cs[k].normal.y *= -1;
        var tmp3 = cs[k].rA; cs[k].rA = cs[k].rB; cs[k].rB = tmp3;
      }
    } else if (A.type === "line" && B.type === "line") {
      cs = collideLineLine(A, B);
    } else {
      // funnel/splitter <-> line, funnel<->funnel, splitter<->splitter,
      // funnel<->splitter: none of these are modeled (funnel and splitter
      // are only supported so far interacting with a circle - see this
      // file's Funnel header comment). No collision rather than guessing at
      // one, so an incidental line or a second funnel/splitter in the same
      // scene doesn't crash on a field (e.g. .length) it doesn't have.
      cs = null;
    }
    return cs;
  }

  // ---- Impulse solver ----

  function applyImpulse(body, ix, iy, r) {
    if (body.isAnchored) return;
    body.vx += ix * body.invMass;
    body.vy += iy * body.invMass;
    body.w += body.invInertia * (r.x * iy - r.y * ix);
  }

  function velocityAt(body, r) {
    return { x: body.vx - body.w * r.y, y: body.vy + body.w * r.x };
  }

  function solveContactVelocity(contact, bodyA, bodyB) {
    var n = contact.normal;
    // Lever arms recorded at the contact instant by the narrow phase, NOT
    // re-derived as (point - center) here - the centers are mid-step and
    // would contaminate the arms with up to a full step of travel, which
    // changes invMassSum by an amount that depends on tHit.
    var rA = contact.rA, rB = contact.rB;

    var vA = velocityAt(bodyA, rA), vB = velocityAt(bodyB, rB);
    var rv = { x: vB.x - vA.x, y: vB.y - vA.y };
    var velAlongNormal = dot(rv, n);
    if (velAlongNormal > 0) return;

    var raCrossN = rA.x * n.y - rA.y * n.x;
    var rbCrossN = rB.x * n.y - rB.y * n.x;
    var invMassSum = bodyA.invMass + bodyB.invMass +
      raCrossN * raCrossN * bodyA.invInertia + rbCrossN * rbCrossN * bodyB.invInertia;
    if (invMassSum <= 0) return;

    // Was a hard step at RESTITUTION_THRESHOLD, which doubles j across a
    // zero-width band. Smoothed so it still suppresses jitter at rest
    // without being a cliff - this is also what keeps a grazing hit
    // continuous with a near miss, since -velAlongNormal -> 0 as the
    // impact goes tangential.
    var e = smoothstep(0.5 * RESTITUTION_THRESHOLD, RESTITUTION_THRESHOLD, -velAlongNormal);
    var j = -(1 + e) * velAlongNormal / invMassSum;
    applyImpulse(bodyA, -n.x * j, -n.y * j, rA);
    applyImpulse(bodyB, n.x * j, n.y * j, rB);
    // Nothing along the tangent: every contact is frictionless.
    // No position fixup here. step() integrates the step in two legs split
    // at each body's own tHit, which accounts for the sub-step exactly;
    // correcting here as well would double-count it.
  }

  function solveContactPosition(contact, bodyA, bodyB) {
    var invMassSum = bodyA.invMass + bodyB.invMass;
    if (invMassSum <= 0) return;
    var correction = Math.max(contact.penetration - POSITION_SLOP, 0) / invMassSum * POSITION_PERCENT;
    var n = contact.normal;
    if (!bodyA.isAnchored) { bodyA.x -= n.x * correction * bodyA.invMass; bodyA.y -= n.y * correction * bodyA.invMass; }
    if (!bodyB.isAnchored) { bodyB.x += n.x * correction * bodyB.invMass; bodyB.y += n.y * correction * bodyB.invMass; }
  }

  function hingeBodyA(hinge, bodies) {
    return hinge.bodyA === null ? WORLD_BODY : bodies[hinge.bodyA];
  }

  // Bodies pinned together by a hinge touch at the joint by design - they
  // must not ALSO be treated as colliding rigid bodies there, or the contact
  // solver fights the joint solver every step (extra, unintended damping).
  function hingeConnects(hinges, i, j) {
    for (var h = 0; h < hinges.length; h++) {
      var hinge = hinges[h];
      if ((hinge.bodyA === i && hinge.bodyB === j) || (hinge.bodyA === j && hinge.bodyB === i)) return true;
    }
    return false;
  }

  function solve2x2(bodyA, bodyB, rA, rB, rhsX, rhsY) {
    var mA = bodyA.invMass, mB = bodyB.invMass, iA = bodyA.invInertia, iB = bodyB.invInertia;
    // This is the effective-mass matrix for a 2D point constraint: whenever
    // either body has positive mass, it's guaranteed strictly positive
    // definite (mB*(mB + iB*|rB|^2) > 0, and symmetrically for A), so det
    // can be legitimately tiny for a heavy/large body without ever being
    // truly singular - the only real degenerate case is both bodies static.
    // An absolute epsilon on det itself breaks for large bodies (det scales
    // with invMass^2, which shrinks fast as mass grows), so check the
    // actual precondition instead.
    if (mA + mB + iA + iB <= 0) return { x: 0, y: 0 };
    var k11 = mA + mB + iA * rA.y * rA.y + iB * rB.y * rB.y;
    var k12 = -iA * rA.x * rA.y - iB * rB.x * rB.y;
    var k22 = mA + mB + iA * rA.x * rA.x + iB * rB.x * rB.x;
    var det = k11 * k22 - k12 * k12;
    var invDet = 1 / det;
    return {
      x: invDet * (k22 * rhsX - k12 * rhsY),
      y: invDet * (k11 * rhsY - k12 * rhsX),
    };
  }

  function solveHingeVelocity(hinge, bodies) {
    var bodyA = hingeBodyA(hinge, bodies);
    var bodyB = bodies[hinge.bodyB];
    var rA = rotateVec(hinge.localAnchorA, bodyA.angle);
    var rB = rotateVec(hinge.localAnchorB, bodyB.angle);
    var vA = velocityAt(bodyA, rA), vB = velocityAt(bodyB, rB);
    var cdot = { x: vB.x - vA.x, y: vB.y - vA.y };
    var impulse = solve2x2(bodyA, bodyB, rA, rB, -cdot.x, -cdot.y);
    applyImpulse(bodyA, -impulse.x, -impulse.y, rA);
    applyImpulse(bodyB, impulse.x, impulse.y, rB);
  }

  function solveHingePosition(hinge, bodies) {
    var bodyA = hingeBodyA(hinge, bodies);
    var bodyB = bodies[hinge.bodyB];
    var rA = rotateVec(hinge.localAnchorA, bodyA.angle);
    var rB = rotateVec(hinge.localAnchorB, bodyB.angle);
    var worldA = { x: bodyA.x + rA.x, y: bodyA.y + rA.y };
    var worldB = { x: bodyB.x + rB.x, y: bodyB.y + rB.y };
    var c = { x: worldB.x - worldA.x, y: worldB.y - worldA.y };
    var impulse = solve2x2(bodyA, bodyB, rA, rB, -c.x, -c.y);
    if (!bodyA.isAnchored) {
      bodyA.x -= impulse.x * bodyA.invMass;
      bodyA.y -= impulse.y * bodyA.invMass;
      bodyA.angle -= bodyA.invInertia * (rA.x * impulse.y - rA.y * impulse.x);
    }
    if (!bodyB.isAnchored) {
      bodyB.x += impulse.x * bodyB.invMass;
      bodyB.y += impulse.y * bodyB.invMass;
      bodyB.angle += bodyB.invInertia * (rB.x * impulse.y - rB.y * impulse.x);
    }
  }

  function getHingeWorldPoint(hinge, bodies) {
    var bodyB = bodies[hinge.bodyB];
    var rB = rotateVec(hinge.localAnchorB, bodyB.angle);
    return { x: bodyB.x + rB.x, y: bodyB.y + rB.y };
  }

  // ---- Frame-wrap helpers ----
  //
  // A body hinged to the world can't just have its own center wrapped
  // independently: the hinge solver above enforces that its local anchor
  // point coincides with a FIXED world pin, so teleporting only the body by
  // a frame-width tears that joint instantly (the position solver then
  // "corrects" the sudden, huge error next step, which - since the
  // correction is linearized around the body's current rotation - can
  // impart a large, physically meaningless spin rather than cleanly
  // snapping back). The fix: treat the PIN itself as the thing living in
  // wrapped frame-space. Wrapping the pin and shifting the body (and
  // anything hinged to it, however many hops away) by that exact same
  // delta is a pure translation of the whole rigid assembly - on a wrapped
  // (toroidal) space, shifting everything by one full period changes
  // nothing physically, so every hinge in the assembly stays exactly
  // satisfied. A body hinged to another (non-world) body is never wrapped
  // on its own for the same reason: its position is a rigid consequence of
  // that parent, not an independent choice, so it only ever moves as part
  // of the parent's own cascade.
  // ---- Edge handling ----
  //
  // What the frame's edges mean for a scene. All three modes share the same
  // frameWidth/frameHeight - the difference is only what happens on reaching
  // one:
  //   "sticky"   the simulation is read as ending there (the engine still
  //              wraps; it is the observer that stops - see
  //              PhysicsHingeGeometry.findWrapStopStep)
  //   "wrap"     Pac-Man: a body leaving one edge reappears at the opposite
  //   "infinite" no edges at all. Bodies leave and keep going, forever.
  var EDGE_MODES = ["sticky", "wrap", "infinite"];
  var DEFAULT_EDGE_MODE = "sticky";

  function edgeModeOf(scene) {
    return EDGE_MODES.indexOf(scene.edgeMode) === -1 ? DEFAULT_EDGE_MODE : scene.edgeMode;
  }
  // Infinite space is the only mode that doesn't wrap; the other two both
  // rely on the wrap happening and differ in how the result is read.
  function wrapsAtEdges(scene) {
    return edgeModeOf(scene) !== "infinite" && !!(scene.frameWidth && scene.frameHeight);
  }

  // Defaults true when absent (not just when scene.collisionsEnabled ===
  // true) - this is an opt-OUT, never an opt-in. physics-ui.js's Mutual
  // Gravity checkbox flips this to
  // a sensible default (off under Mutual Gravity, on otherwise) as a one-
  // time UX nudge whenever THAT checkbox changes, not as a property of the
  // engine itself - this function has no opinion about mutualGravity at all.
  function collisionsEnabled(scene) {
    return scene.collisionsEnabled !== false;
  }

  // Squashes an unbounded position into [0, 1] for display, for Infinite
  // Space where a coordinate has no range to divide by any more. `v` is the
  // position already divided by the frame dimension, so the frame itself
  // spans 0..1 and everything beyond it is what this has to fit: v=0.5 (dead
  // center) maps to exactly 0.5, the frame's own edges to 0.076 and 0.924,
  // and a body two frames out to 0.9995 - arbitrarily far still lands inside
  // the color range, just ever closer to its end.
  var OUTPUT_SIGMOID_STEEPNESS = 5;
  function frameSigmoid(v) {
    return 1 / (1 + Math.exp(-OUTPUT_SIGMOID_STEEPNESS * (v - 0.5)));
  }

  function wrapCoord(v, span) {
    if (v > span) return v - span;
    if (v < 0) return v + span;
    return v;
  }

  // Self-contained (not physics-hinge-geometry.js's translateBodyAndDescendants)
  // since that module depends on this file for rotateVec - this file can't
  // depend back on it without a cycle. Shifts bodies[bodyIndex] and every
  // body hinged to it, however many hops away, by the same (dx, dy): a
  // pure translation preserves every hinge in the subtree regardless of
  // depth, so no per-hinge geometry needs recomputing.
  function wrapTranslateAndCascade(scene, bodyIndex, dx, dy, visited) {
    if (visited[bodyIndex]) return;
    visited[bodyIndex] = true;
    var body = scene.bodies[bodyIndex];
    body.x += dx;
    body.y += dy;
    scene.hinges.forEach(function (h) {
      if (h.bodyA === bodyIndex) wrapTranslateAndCascade(scene, h.bodyB, dx, dy, visited);
    });
  }

  // A body created by a split (see step()'s splitting section) carries an
  // explicit .lineage pointing back at whichever body index Output/Input
  // mapping actually names - every other body's lineage is implicitly its
  // own index. This is what lets "track body 2's Y" keep meaning something
  // after body 2 has become two (or more) circles: computeOutputLineageAverage
  // below averages over every body CURRENTLY sharing a lineage, not just one
  // fixed index.
  function lineageOf(scene, index) {
    var body = scene.bodies[index];
    return body && body.lineage !== undefined && body.lineage !== null ? body.lineage : index;
  }

  // ---- Output mappings that read TWO bodies ----
  //
  // An Output is `{ body, bodyB, property }`. bodyB absent/null is the
  // ordinary one-body mapping every scene had before this existed; with it
  // set, an x/y/angle Output becomes the MEAN of the two bodies' values, and
  // the extra property "distance" becomes available - how far apart they
  // are, which has no one-body meaning at all.
  //
  // Each half is still its own lineage average first (see
  // computeOutputLineageAverage), so a ball that has split into four counts
  // once, not four times: the pair mean is the mean of two bodies, not of
  // however many balls happen to exist.
  function outputBodyIndices(output) {
    if (!output || typeof output.body !== "number") return [];
    var indices = [output.body];
    if (typeof output.bodyB === "number" && output.bodyB !== output.body) indices.push(output.bodyB);
    return indices;
  }

  function isPairOutput(output) { return outputBodyIndices(output).length === 2; }

  // null when this Output mapping is one of the shapes everything
  // downstream knows how to evaluate, a human-readable reason otherwise.
  //
  // There are only three: Scene Lifespan (no body, property "lifespan"),
  // Bounce Count (one body, no pair), and a positional reading of one body
  // or of a pair (with "distance" needing the pair). Anything else is a
  // mapping some consumer will silently mis-evaluate - which is exactly
  // what happened when an editor state transition left `{ body: null,
  // property: "x" }` behind: a mapping naming no body AND no run tally,
  // which the grid could only report as "missing an Output mapping" even
  // though one was plainly there.
  function outputMappingError(output, bodyCount) {
    if (!output) return "no Output mapping";
    function badIndex(i) {
      return bodyCount !== undefined && !(i >= 0 && i < bodyCount);
    }
    if (output.property === "lifespan") {
      if (output.body !== null && output.body !== undefined) return "Scene Lifespan reads no body, but body " + output.body + " is set";
      if (output.bodyB !== null && output.bodyB !== undefined) return "Scene Lifespan reads no body, but a second body is set";
      return null;
    }
    if (typeof output.body !== "number") {
      return 'Output property "' + output.property + '" reads a body, but none is set';
    }
    if (badIndex(output.body)) return "output.body index out of range";
    var hasB = output.bodyB !== null && output.bodyB !== undefined;
    if (hasB && typeof output.bodyB !== "number") return "output.bodyB must be a body index or null";
    if (hasB && badIndex(output.bodyB)) return "output.bodyB index out of range";
    if (output.property === "distance" && !isPairOutput(output)) {
      return "Distance Apart reads two bodies, but only one is set";
    }
    if (output.property === "bounces" && isPairOutput(output)) {
      return "Bounce Count reads one body, but a second is set";
    }
    return null;
  }

  // The separation between two points, taking the short way round when the
  // frame wraps. Without this a Pac-Man scene's distance Output would jump
  // from ~0 to ~frameWidth the instant one of the two bodies crossed an
  // edge - a discontinuity in the exact quantity the grid is a picture of,
  // for a pair that never actually moved apart. On a wrapped (toroidal)
  // world the shortest separation IS the distance; the plain difference is
  // only right when there are no edges at all.
  function shortestSeparation(scene, dx, dy) {
    if (!wrapsAtEdges(scene)) return { x: dx, y: dy };
    var w = scene.frameWidth, h = scene.frameHeight;
    return { x: dx - w * Math.round(dx / w), y: dy - h * Math.round(dy / h) };
  }

  // The largest value a distance Output can take, which is what colors it.
  // On a torus that is the antipode - half a frame away on each axis, not a
  // whole one. With no edges there is no bound, and the caller squashes it
  // through frameSigmoid instead; the diagonal is handed back as that
  // sigmoid's natural scale.
  function outputDistanceMax(scene) {
    var w = scene.frameWidth || 0, h = scene.frameHeight || 0;
    var f = wrapsAtEdges(scene) ? 0.5 : 1;
    return Math.sqrt(w * f * w * f + h * f * h * f) || 1;
  }

  // What this scene's Output mapping currently reads, whatever shape it is.
  // The single JS definition of it: physics-ui.js's playback coloring and
  // fractal-grid.js's instant hover preview both go through here, and the
  // grid shader's GLSL is written to match it term for term.
  function computeOutputValue(scene, output) {
    var indices = outputBodyIndices(output);
    if (!indices.length) return 0;
    if (output.property === "distance") {
      if (indices.length < 2) return 0;
      var ax = computeOutputLineageAverage(scene, indices[0], "x");
      var ay = computeOutputLineageAverage(scene, indices[0], "y");
      var bx = computeOutputLineageAverage(scene, indices[1], "x");
      var by = computeOutputLineageAverage(scene, indices[1], "y");
      var d = shortestSeparation(scene, bx - ax, by - ay);
      return Math.sqrt(d.x * d.x + d.y * d.y);
    }
    var sum = 0;
    for (var i = 0; i < indices.length; i++) {
      sum += computeOutputLineageAverage(scene, indices[i], output.property);
    }
    return sum / indices.length;
  }

  function computeOutputLineageAverage(scene, bodyIndex, property) {
    var targetLineage = lineageOf(scene, bodyIndex);
    var sum = 0, count = 0;
    for (var i = 0; i < scene.bodies.length; i++) {
      if (lineageOf(scene, i) !== targetLineage) continue;
      sum += scene.bodies[i][property];
      count++;
    }
    return count > 0 ? sum / count : 0;
  }

  function step(scene, dt, opts) {
    opts = opts || {};
    var velIter = opts.velocityIterations || VELOCITY_ITERATIONS;
    var posIter = opts.positionIterations || POSITION_ITERATIONS;
    var bodies = scene.bodies;
    var i, j;

    // Fixed for the whole step, from the positions it starts at, and reused
    // by all three advanceVelocity calls below - the two legs and the
    // detection sweep have to agree on what acceleration this step applied,
    // or a body would be swept along a different line than the one it then
    // moves down.
    // Before anything reads a velocity this step - see applyContactMerge for
    // why the ordering is load-bearing. Merging IS a collision response (the
    // "sticky" force the Collisions toggle promises to turn off), so it's
    // gated on collisionsEnabled the same as every detection loop below.
    if (scene.mutualGravity && collisionsEnabled(scene)) applyContactMerge(scene);

    var maxSpeed = speedCapFor(scene);
    var acc = computeAccelerations(scene);

    // Entering velocity (u, before any gravity this step) and the whole-step
    // gravity-advanced velocity (vFull) for every non-static body. vFull
    // drives both detection below AND leg 1's position move - using
    // anything else for one but not the other would let the body travel
    // along a different line than the one it was swept against.
    var u = new Array(bodies.length), vFull = new Array(bodies.length);
    for (i = 0; i < bodies.length; i++) {
      if (bodies[i].isAnchored) continue;
      u[i] = { x: bodies[i].vx, y: bodies[i].vy };
      vFull[i] = advanceVelocity(u[i].x, u[i].y, dt, acc[i].x, acc[i].y, maxSpeed);
    }

    // Detect against PROBE bodies (real position, velocity = vFull) rather
    // than the raw pre-gravity bodies - see collidePair's comment.
    var probes = new Array(bodies.length);
    for (i = 0; i < bodies.length; i++) {
      probes[i] = bodies[i].isAnchored ? bodies[i] : Object.assign({}, bodies[i], { vx: vFull[i].x, vy: vFull[i].y });
    }

    // Funnel mouth teleport detection (see this file's Funnel header
    // comment) - resolved before the normal contacts loop because a
    // teleport, when it wins, replaces leg 1's position update entirely
    // rather than feeding an impulse into the solver like every other
    // contact does. teleportTarget[circleIndex] is the EARLIEST funnel
    // mouth (by tHit) that circle's swept path crosses this step, if any -
    // "earliest" exactly mirrors how bodyTHit below picks the earliest of
    // several ordinary contacts on the same body.
    var teleportTarget = new Array(bodies.length).fill(null);
    // Skipped along with every other detection loop below when collisions
    // are off - a funnel's mouth is a trigger a circle has to actually
    // TOUCH to fire, and "never check for collisions... objects can pass
    // right through each other" applies here exactly as it does to an
    // ordinary bounce: the funnel is just another body being passed through.
    if (collisionsEnabled(scene)) {
      for (i = 0; i < bodies.length; i++) {
        if (bodies[i].type !== "funnel") continue;
        for (j = 0; j < bodies.length; j++) {
          if (bodies[j].type !== "circle") continue;
          if (hingeConnects(scene.hinges, i, j)) continue;
          var mouthHit = collideFunnelMouthTHit(probes[i], probes[j], dt);
          if (!mouthHit) continue;
          if (!teleportTarget[j] || mouthHit.tHit < teleportTarget[j].tHit) {
            teleportTarget[j] = { tHit: mouthHit.tHit, targetX: mouthHit.targetX, targetY: mouthHit.targetY, funnelIndex: i };
          }
        }
      }
    }

    // Splitter short-side detection (see createSplitter /
    // collideSplitterShortSideTHit) - same "earliest wins per circle" shape
    // as the funnel teleport above, but APPLIED at the very end of step()
    // rather than woven into leg 1/2's sub-stepping: a split creates a
    // genuinely new body, and leg 1, the contacts list, bodyTHit and the
    // solver iterations were all sized and indexed before that body exists.
    //
    // What the end-of-step timing costs: on the single step a circle
    // splits, its position/velocity come from this step's ordinary
    // (un-split) integration, and only then snap to the two spawn points -
    // rather than being exact to the sub-step instant the way a funnel
    // teleport is. At 1/60s per step that is invisible, and it keeps the
    // whole mid-step machinery unaware of bodies that don't exist yet.
    var splitHit = new Array(bodies.length).fill(null);
    // Same reasoning as the funnel loop above - a splitter's short side is
    // also a trigger a circle has to touch to fire.
    if (collisionsEnabled(scene)) {
      for (i = 0; i < bodies.length; i++) {
        if (bodies[i].type !== "splitter") continue;
        for (j = 0; j < bodies.length; j++) {
          if (bodies[j].type !== "circle") continue;
          // An anchored circle is never split, for the same reason an
          // anchored circle is never teleported by a funnel (see leg 1,
          // which skips it outright): it has no position of its own to move.
          // It would also be the one case where the two halves couldn't
          // inherit the parent's mass - an anchor carries invMass 0, while
          // the ordinary circle a split produces does not.
          if (bodies[j].isAnchored) continue;
          if (hingeConnects(scene.hinges, i, j)) continue;
          var shortHit = collideSplitterShortSideTHit(probes[i], probes[j], dt);
          if (!shortHit) continue;
          if (!splitHit[j] || shortHit.tHit < splitHit[j].tHit) {
            shortHit.splitterIndex = i;
            splitHit[j] = shortHit;
          }
        }
      }
    }

    // The ordinary solid-body pairs - circle/circle, line/circle, a
    // funnel/splitter's own solid edges, etc. Left empty when collisions are
    // off: every consumer below (bodyTHit, contactFlags, the velocity/
    // position solve loops, mergeDetectedContacts) already handles "nothing
    // detected this step" correctly, since that's the everyday case for any
    // body that simply isn't near anything - an empty array here is that
    // same path, just for every body at once.
    var contacts = [];
    if (collisionsEnabled(scene)) {
      for (i = 0; i < bodies.length; i++) {
        for (j = i + 1; j < bodies.length; j++) {
          var A = bodies[i], B = bodies[j];
          if (A.isAnchored && B.isAnchored) continue;
          if (hingeConnects(scene.hinges, i, j)) continue;
          var cs = collidePair(probes[i], probes[j], dt);
          if (cs) for (var k = 0; k < cs.length; k++) { cs[k].a = i; cs[k].b = j; contacts.push(cs[k]); }
        }
      }
    }

    // Per-body tHit: the earliest contact instant among everything that
    // body touches this step, defaulting to dt (no contact -> the whole
    // step is "leg 1", leg 2 never runs - see the no-hit-path note below).
    var bodyTHit = new Array(bodies.length).fill(dt);
    for (i = 0; i < contacts.length; i++) {
      var c = contacts[i];
      if (c.tHit < bodyTHit[c.a]) bodyTHit[c.a] = c.tHit;
      if (c.tHit < bodyTHit[c.b]) bodyTHit[c.b] = c.tHit;
    }

    // A teleport wins this step over any ordinary contact exactly when it's
    // the earliest event touching that body - a tie goes to the teleport,
    // since a circle reaching the mouth at the same instant as some other
    // contact still has nowhere else to go afterward. Winning both moves
    // this body's own bodyTHit up (so leg 1 stops exactly there, same as
    // any other contact would) AND drops any contact this step found
    // between the teleporting circle and that SAME funnel's own solid edges
    // (throat/legs): without this, the circle would land dead center on the
    // throat segment (see collideFunnelMouthTHit) only to have this same
    // step's already-computed contacts immediately bounce it off that very
    // edge, using rA/rB computed against its PRE-teleport position.
    var teleportWins = new Array(bodies.length).fill(false);
    for (i = 0; i < bodies.length; i++) {
      var tp = teleportTarget[i];
      if (tp && tp.tHit <= bodyTHit[i]) {
        bodyTHit[i] = tp.tHit;
        teleportWins[i] = true;
      }
    }
    if (contacts.length) {
      contacts = contacts.filter(function (fc) {
        var fi = bodies[fc.a].type === "funnel" ? fc.a : (bodies[fc.b].type === "funnel" ? fc.b : -1);
        var ci = bodies[fc.a].type === "circle" ? fc.a : (bodies[fc.b].type === "circle" ? fc.b : -1);
        if (fi === -1 || ci === -1) return true;
        return !(teleportWins[ci] && teleportTarget[ci].funnelIndex === fi);
      });
    }
    // The same rule for a splitter, and for the same reason - a body going
    // THROUGH a portal must not also bounce off it. A splitter's mouth and
    // legs are solid, and their capsules reach LINE_THICKNESS/2 past the
    // short side's own corners, so a ball entering anywhere but dead center
    // clips a leg end-cap on the very step it splits. The split then carries
    // that bounce's velocity out with it, which is what "the halves come out
    // at weird angles" is: the two spawn points are right, the velocity
    // they inherit is not.
    //
    // Dropped AFTER the bodyTHit fold above, exactly like the funnel's own
    // filter: the walls still decide how far leg 1 carries the ball this
    // step (the split is applied from wherever it ends up), they just no
    // longer get to push on it. Since a split applies no impulse at all,
    // that leaves the halves carrying the parent's entering velocity
    // untouched, which is the whole contract of the feature.
    //
    // Only the splitter the ball actually went through is excluded. A
    // second splitter it happens to be resting against this same step is an
    // ordinary wall and keeps behaving like one.
    if (contacts.length) {
      contacts = contacts.filter(function (sc) {
        var si = bodies[sc.a].type === "splitter" ? sc.a : (bodies[sc.b].type === "splitter" ? sc.b : -1);
        var ci = bodies[sc.a].type === "circle" ? sc.a : (bodies[sc.b].type === "circle" ? sc.b : -1);
        if (si === -1 || ci === -1) return true;
        return !(splitHit[ci] && splitHit[ci].splitterIndex === si);
      });
    }

    // "Is this body touching anything at all this step?", per body, for a
    // caller that passes an array in - the JS-side twin of the g_contactN
    // globals physics-gpu.js publishes, and what Bounce Count is counted from
    // (a false->true flip is one bounce). Opt-in via opts so the common
    // caller pays nothing; rewritten in place each step, never accumulated.
    var contactFlags = opts.contactFlags;
    if (contactFlags) {
      for (i = 0; i < bodies.length; i++) contactFlags[i] = false;
      for (i = 0; i < contacts.length; i++) {
        contactFlags[contacts[i].a] = true;
        contactFlags[contacts[i].b] = true;
      }
    }
    // The raw pair list itself, for a caller that needs to tell WHICH two
    // bodies touched apart (contactFlags alone can't: with 3+ bodies a
    // shared true/true doesn't say who is touching whom) - runBounceEvents'
    // per-pair "just started touching" detection is the one consumer today.
    // Same opt-in-array convention as contactFlags: cleared and refilled in
    // place each step rather than allocating a fresh array, since this runs
    // once per simulated step of a full trajectory.
    var contactsOut = opts.contactsOut;
    if (contactsOut) {
      contactsOut.length = 0;
      for (i = 0; i < contacts.length; i++) contactsOut.push({ a: contacts[i].a, b: contacts[i].b });
    }

    // Leg 1: move at vFull for tHit - matching detection exactly - then
    // drop velocity to vPre (gravity applied only up to tHit, not the whole
    // step) before the impulse solve runs. Reflection doesn't commute with
    // adding gravity: reflecting v+g*dt (this step's full gravity, as if
    // the contact had waited until the very end to be noticed) differs from
    // reflecting v and then adding g*dt (as if it were noticed at the very
    // start) by 2*(g.n)*dt along the normal - up to a real, visible amount
    // per step. That gap is what made a bounce's outcome depend on which
    // discrete step happened to catch it. Using each contact's own tHit
    // here closes it: the impulse always reflects the velocity the body
    // actually had at the true contact instant, not a full step of gravity
    // early or late.
    //
    // A body that WON a teleport this step (teleportWins[i]) gets its
    // position OVERRIDDEN to the funnel's throat center instead of moved by
    // vFull*th - that is the entire teleport, a hard position discontinuity
    // - while vPre is computed exactly the same way as any other body's:
    // gravity applied up to th, nothing reflected. That is what "keeps the
    // same velocity" (the position teleports, the velocity does not) while
    // staying gravity-consistent through the instant it happens.
    for (i = 0; i < bodies.length; i++) {
      var b1 = bodies[i];
      if (b1.isAnchored) continue;
      var th = bodyTHit[i];
      if (teleportWins[i]) {
        b1.x = teleportTarget[i].targetX;
        b1.y = teleportTarget[i].targetY;
      } else {
        b1.x += vFull[i].x * th; b1.y += vFull[i].y * th;
      }
      b1.angle += b1.w * th;
      var vPre = advanceVelocity(u[i].x, u[i].y, th, acc[i].x, acc[i].y, maxSpeed);
      b1.vx = vPre.x; b1.vy = vPre.y;
    }

    // Bodies are now AT the contact instant with their pre-impulse
    // velocities - the moment a merge means anything. Doing it here rather
    // than before leg 1 is what catches a collision fast enough to happen
    // entirely inside one step.
    if (scene.mutualGravity) mergeDetectedContacts(scene, contacts);

    var iter;
    for (iter = 0; iter < velIter; iter++) {
      for (i = 0; i < scene.hinges.length; i++) solveHingeVelocity(scene.hinges[i], bodies);
      for (i = 0; i < contacts.length; i++) {
        solveContactVelocity(contacts[i], bodies[contacts[i].a], bodies[contacts[i].b]);
      }
    }

    // Leg 2: the remainder of the step, with the remainder of gravity
    // applied to the POST-impulse velocity - never the whole dt applied
    // before the solve, for the same reason as leg 1. A body with no
    // contact this step has tHit=dt, tRest=0: vPost reduces to an
    // already-clamped vFull advanced by 0 (the identity), so this whole
    // leg is a no-op and the body's motion is exactly what step() produced
    // before this restructuring.
    for (i = 0; i < bodies.length; i++) {
      var b2 = bodies[i];
      if (b2.isAnchored) continue;
      var tRest = dt - bodyTHit[i];
      var vPost = advanceVelocity(b2.vx, b2.vy, tRest, acc[i].x, acc[i].y, maxSpeed);
      b2.vx = vPost.x; b2.vy = vPost.y;
      b2.x += vPost.x * tRest; b2.y += vPost.y * tRest; b2.angle += b2.w * tRest;
    }

    for (iter = 0; iter < posIter; iter++) {
      for (i = 0; i < scene.hinges.length; i++) solveHingePosition(scene.hinges[i], bodies);
      for (i = 0; i < contacts.length; i++) {
        solveContactPosition(contacts[i], bodies[contacts[i].a], bodies[contacts[i].b]);
      }
    }

    // Pac-Man edge wrapping: opt-in per scene (only scenes with a locked
    // frame size set these), so a scene with neither field keeps its old
    // unbounded-fall behavior exactly. Last thing step() does, so a wrap
    // this step doesn't feed a teleported position into this same step's
    // own position-correction iterations above - matches
    // generateStepOnceGLSL's GLSL port of this same rule.
    //
    // Only ever decided by a "root" body - one with no hinge to another
    // body (either completely free, or hinged straight to the world) - see
    // the frame-wrap helpers above for why a hinge child must never
    // independently wrap, and why a world-hinged root wraps by its PIN's
    // position, not its own center.
    if (wrapsAtEdges(scene)) {
      var isHingeChild = {};
      var ownWorldHinge = {};
      scene.hinges.forEach(function (h) {
        if (h.bodyA === null) ownWorldHinge[h.bodyB] = h;
        else isHingeChild[h.bodyB] = true;
      });
      for (i = 0; i < bodies.length; i++) {
        var wb = bodies[i];
        if (wb.isAnchored || isHingeChild[i]) continue;
        var worldHinge = ownWorldHinge[i];
        var ref = worldHinge ? worldHinge.localAnchorA : wb;
        var dx = wrapCoord(ref.x, scene.frameWidth) - ref.x;
        var dy = wrapCoord(ref.y, scene.frameHeight) - ref.y;
        if (dx === 0 && dy === 0) continue;
        if (worldHinge) worldHinge.localAnchorA = { x: worldHinge.localAnchorA.x + dx, y: worldHinge.localAnchorA.y + dy };
        wrapTranslateAndCascade(scene, i, dx, dy, {});
      }
    }

    // Apply whatever splits the detection above found. Genuinely last, so
    // each splitting circle is snapped to its spawn point from its fully
    // integrated (leg 1 + solve + leg 2 + position solve + wrap) end-of-step
    // state, and so a body appended here never takes part in the step it was
    // born in - it starts fresh next step, like any body added between steps.
    //
    // The circle that hit KEEPS ITS OWN SLOT as the first of the two (moved
    // by offset1, velocity untouched - "each has the same velocity as the
    // initial ball"), and the second is appended. Keeping the original slot
    // is what makes lineage work without any bookkeeping for it: an authored
    // body's lineage is implicitly its own index (see lineageOf), so the
    // in-place half stays in its lineage for free however many times it
    // splits again, and only the appended half needs to be told which
    // lineage it belongs to.
    for (i = 0; i < splitHit.length; i++) {
      var sh = splitHit[i];
      if (!sh) continue;
      var parent = bodies[i];
      // Read the child's position off the parent BEFORE the parent moves -
      // both offsets are displacements of the same pre-split position, not
      // of each other.
      var childX = parent.x + sh.offset2.x, childY = parent.y + sh.offset2.y;
      parent.x += sh.offset1.x;
      parent.y += sh.offset1.y;
      // Splitting is recursive by design (each half can split again), which
      // is growth measured in generations - a scene that keeps feeding balls
      // back through a splitter has no natural ceiling at all. At the cap the
      // ball still passes through the splitter, it just doesn't duplicate:
      // the offset above has already been applied, so it emerges on the long
      // side as a single ball rather than either stopping dead or being
      // silently left behind on the short side. `continue`, not `break` -
      // being at the ceiling is a fact about the scene, not a reason to skip
      // the warp for every later ball that hit a splitter this same step.
      if (bodies.length >= maxSimulationBodiesFor(scene)) continue;
      var child = createCircle(childX, childY, parent.radius, false);
      child.vx = parent.vx; child.vy = parent.vy; child.w = parent.w; child.angle = parent.angle;
      child.lineage = lineageOf(scene, i);
      bodies.push(child);
    }
  }

  function deleteBody(scene, index) {
    scene.bodies.splice(index, 1);
    scene.hinges = scene.hinges.filter(function (h) {
      return h.bodyA !== index && h.bodyB !== index;
    }).map(function (h) {
      return {
        bodyA: h.bodyA === null ? null : (h.bodyA > index ? h.bodyA - 1 : h.bodyA),
        bodyB: h.bodyB > index ? h.bodyB - 1 : h.bodyB,
        localAnchorA: h.localAnchorA,
        localAnchorB: h.localAnchorB,
      };
    });
  }

  function cloneScene(scene) {
    return {
      // Same reasoning as xInput/frameWidth below: physics-ui.js clones the
      // live scene on Play and clones it back on Reset, so anything omitted
      // here is silently wiped by that round trip - and dropping this one
      // would flip the scene back to downward gravity mid-edit.
      mutualGravity: !!scene.mutualGravity,
      collisionsEnabled: collisionsEnabled(scene),
      edgeMode: edgeModeOf(scene),
      // Same reasoning as everything else on this list: physics-ui.js clones
      // the live scene into initialScene on Play and clones it straight back
      // on Reset/a finished run, so an omitted field here reverts to
      // whatever it defaults to elsewhere the moment either of those fires.
      simulationSteps: scene.simulationSteps,
      // Same reasoning as every other field on this list: physics-ui.js
      // clones the live scene on Play and clones it back on Reset, so an
      // omission here silently resets the ceiling mid-edit.
      maxSimulationBodies: maxSimulationBodiesFor(scene),
      bodies: scene.bodies.map(function (b) {
        var copy = {};
        for (var key in b) if (Object.prototype.hasOwnProperty.call(b, key)) copy[key] = b[key];
        return copy;
      }),
      hinges: scene.hinges.map(function (h) {
        return {
          bodyA: h.bodyA,
          bodyB: h.bodyB,
          localAnchorA: { x: h.localAnchorA.x, y: h.localAnchorA.y },
          localAnchorB: { x: h.localAnchorB.x, y: h.localAnchorB.y },
        };
      }),
      // Previously omitted here, which silently wiped every mapping on a
      // Play -> Reset cycle (physics-ui.js clones the live scene into
      // initialScene on Play, then clones initialScene back on Reset) -
      // frameWidth/frameHeight need the same treatment now for the same
      // reason, or a Reset would un-lock the wrap edges mid-edit.
      xInput: scene.xInput ? { body: scene.xInput.body, property: scene.xInput.property } : null,
      yInput: scene.yInput ? { body: scene.yInput.body, property: scene.yInput.property } : null,
      output: scene.output ? { body: scene.output.body, bodyB: scene.output.bodyB === undefined ? null : scene.output.bodyB, property: scene.output.property } : null,
      frameWidth: scene.frameWidth,
      frameHeight: scene.frameHeight,
    };
  }

  // Cumulative Bounce Count for one body, step by step: counts[i] is how many
  // bounces it had racked up by the end of step i+1 (so counts[steps-1] is the
  // run's total, and the array indexes exactly like a trajectory does).
  //
  // A bounce is the moment contact STARTS - the false->true edge of
  // contactFlags - not every step spent touching. Those are very different
  // numbers here: a body sliding along a surface under gravity stays in
  // contact for hundreds of consecutive steps (the CCD regression scene in
  // physics-tests.js rides one for ~130), which as a per-step tally would read
  // as hundreds of "bounces" for what a viewer sees as a single one.
  //
  // Runs its own private copy of the scene, so a caller can compute this for a
  // scene it is also playing/rendering without disturbing it.
  // A whole run's trajectory, computed here in JS rather than on the GPU:
  // rows[i] is every body's state after i+1 steps, in the same shape
  // PhysicsGPU.runSceneOnGPU produces (index-aligned with scene.bodies) -
  // plus `radius` and `lineage` per entry, which a GPU trajectory has no
  // spare texture channel for and no need of.
  //
  // This exists for one reason: a scene containing a SPLITTER grows new
  // bodies mid-run (see step()'s splitting section), and a GPU trajectory
  // can only report the FIXED slot count its shader was compiled with - the
  // per-pixel grid pre-allocates dormant slots up to MAX_SIMULATION_BODIES
  // and a split wakes one (PhysicsGPU.padSceneForSplitting), which means
  // every row it produces is that full width whether or not anything has
  // split yet. Rows here get LONGER as the run goes on instead, so a caller
  // drawing them can size its body list to exactly what existed at that
  // frame (see physics-ui.js's applyTrajectoryStep). Same physics, same
  // ceiling, different row shape - the regression suite checks the two
  // against each other step for step.
  function runTrajectory(scene, steps, dt) {
    var sim = cloneScene(scene);
    // Same reason computeOffsetSceneNumeric does this: a scene straight from
    // JSON has no invMass/invInertia, and stepping without them yields NaN.
    sim.bodies.forEach(computeMass);
    var rows = new Array(steps);
    for (var i = 0; i < steps; i++) {
      step(sim, dt);
      var row = new Array(sim.bodies.length);
      for (var b = 0; b < sim.bodies.length; b++) {
        var body = sim.bodies[b];
        row[b] = {
          x: body.x, y: body.y, angle: body.angle,
          radius: body.radius, lineage: lineageOf(sim, b),
        };
      }
      rows[i] = row;
    }
    return rows;
  }

  function runBounceCounts(scene, bodyIndex, steps, dt) {
    var sim = cloneScene(scene);
    // Same reason computeOffsetSceneNumeric does this: a scene straight from
    // JSON has no invMass/invInertia, and stepping without them yields NaN.
    sim.bodies.forEach(computeMass);
    var flags = new Array(sim.bodies.length);
    var counts = new Array(steps);
    var count = 0, wasTouching = false;
    for (var i = 0; i < steps; i++) {
      step(sim, dt, { contactFlags: flags });
      var touching = !!flags[bodyIndex];
      if (touching && !wasTouching) count++;
      wasTouching = touching;
      counts[i] = count;
    }
    return counts;
  }

  // Every pair of bodies currently overlapping by the same yardstick
  // computeAccelerations/applyContactMerge already use for Mutual Gravity -
  // "touching" is geometric (dx²+dy² <= (halfExtent(a)+halfExtent(b))²),
  // nothing to do with whether the collision solver is even running. Skips
  // the exact pairs applyContactMerge skips (both anchored, or hinge-
  // connected) so a resting/welded pair already accounted for elsewhere
  // doesn't also read as a fresh overlap. Returns "i,j" keys (i < j) to
  // match the contacts array's own a<b convention below.
  function overlappingPairs(sim) {
    var bodies = sim.bodies, n = bodies.length, pairs = [];
    for (var i = 0; i < n; i++) {
      for (var j = i + 1; j < n; j++) {
        var a = bodies[i], b = bodies[j];
        if (a.isAnchored && b.isAnchored) continue;
        if (hingeConnects(sim.hinges, i, j)) continue;
        var dx = b.x - a.x, dy = b.y - a.y;
        var contact = halfExtent(a) + halfExtent(b);
        if (dx * dx + dy * dy <= contact * contact) pairs.push(i + "," + j);
      }
    }
    return pairs;
  }

  // Hinge-connected pairs of two non-anchored lines - a double pendulum's
  // own shape (and anything built the same way: rods swinging end to end).
  // A hinge like this pins the two bodies together at a shared point BY
  // DESIGN (see hingeConnects, used by both overlappingPairs above and the
  // real collision loop in step() below) - they touch there always, so the
  // ordinary overlap/contact bounce sound correctly never fires for this
  // pair, and stays that way; this is a second, unrelated event for the
  // same pair, not a replacement for that exclusion.
  function hingedLinePairs(sim) {
    var pairs = [];
    for (var h = 0; h < sim.hinges.length; h++) {
      var hinge = sim.hinges[h];
      var a = sim.bodies[hinge.bodyA], b = sim.bodies[hinge.bodyB];
      if (!a || !b) continue; // hinge.bodyA can be null (pinned to a world point, not a body)
      if (a.type !== "line" || b.type !== "line") continue;
      if (a.isAnchored || b.isAnchored) continue;
      pairs.push({ hinge: hinge, i: hinge.bodyA, j: hinge.bodyB });
    }
    return pairs;
  }

  // Which side of the hinge point each line's own center of mass currently
  // reads as - the ray from the shared hinge point out to a line's own
  // center (line.x/y IS that center; see createLine) - and whether the two
  // rays point the same general way (dot > 0: hinge on one side, both
  // centers on the other, i.e. the two rods reading as overlapping) or
  // opposite ways (dot < 0: folded apart). `sign` is which side of ray 1
  // ray 2 currently falls on (the sign of their cross product); a JS
  // re-simulation steps PAST the instant the two rays are perfectly
  // aligned rather than landing on it, so runBounceEvents catches that
  // instant as this sign flipping between one step and the next, the same
  // way every other event in this file is a step-to-step state change
  // rather than an exact zero.
  function lineHingeCrossState(sim, pair) {
    var hingePoint = getHingeWorldPoint(pair.hinge, sim.bodies);
    var a = sim.bodies[pair.i], b = sim.bodies[pair.j];
    var v1x = a.x - hingePoint.x, v1y = a.y - hingePoint.y;
    var v2x = b.x - hingePoint.x, v2y = b.y - hingePoint.y;
    var cross = v1x * v2y - v1y * v2x;
    var dot = v1x * v2x + v1y * v2y;
    return { sign: cross > 0 ? 1 : (cross < 0 ? -1 : 0), dot: dot };
  }

  // Every step at which some pair of bodies STARTS touching - the bounce
  // sound effect's own event source (see physics-sound.js), one JS
  // re-simulation same as runBounceCounts/runBounceCounts' own reasoning
  // (a GPU trajectory logs positions only, nothing about contact). Unlike
  // runBounceCounts this tracks PER-PAIR state, not per-body: a single
  // collision between A and B flips both of their contactFlags at once, so
  // per-body "was this body touching anything a moment ago" can't tell one
  // simultaneous collision from two, and would double-fire a body already
  // resting against something else when a third body arrives. Pair state
  // (keyed "a,b", a < b - matching how the engine itself always orders a
  // contact's own a/b) has no such ambiguity. Returns a plain ascending
  // array of 0-indexed step numbers - possibly with the same step appearing
  // only once even if several pairs started touching in it at once, since
  // one bounce sound per step reads as the event, not a wall of them.
  //
  // Mutual Gravity scenes are commonly run with collisions turned OFF (see
  // "Add ability to disable collisions" - it's what lets bodies orbit/pass
  // through each other instead of the contact solver fighting the gravity
  // force at close range), so the collision-response `contacts` array below
  // is frequently empty there even while bodies are visibly overlapping.
  // For Mutual Gravity, overlap is detected geometrically instead
  // (overlappingPairs, above) - the engine's own definition of "touching"
  // for this mode, independent of whether the solver is running at all -
  // so the bounce sound still fires on genuine overlap either way. Non-
  // mutual-gravity scenes keep the original collision-contacts approach
  // unchanged. Separately, ANY scene - mutual gravity or not - gets the
  // double-pendulum-style line-hinge alignment check (lineHingeCrossState,
  // above) folded into the very same per-step event flag, since it's the
  // same "one bounce sound per step" output either way.
  function runBounceEvents(scene, steps, dt) {
    var geometric = !!scene.mutualGravity;
    var sim = cloneScene(scene);
    sim.bodies.forEach(computeMass);
    var linePairs = hingedLinePairs(sim);
    // Nothing can ever touch AND no hinged-line pair exists to watch for
    // alignment - skip the re-simulation entirely.
    if (!geometric && !collisionsEnabled(scene) && linePairs.length === 0) return [];
    var contactsBuf = [];
    var wasTouchingPairs = {};
    // Seed with whatever's ALREADY overlapping in the scene as given - a
    // pair placed touching (e.g. resting contact under ordinary gravity, or
    // two bodies positioned overlapping in Mutual Gravity) didn't just
    // collide, so the first step checked below must not read that
    // pre-existing overlap as a fresh one. This uses the same halfExtent
    // yardstick as the geometric branch even when this run will go on to use
    // collision contacts instead - it's only asking "were these two already
    // touching before this replay started," not tracking every step, so the
    // approximation the rest of the engine already accepts for Mutual
    // Gravity (see overlappingPairs above) is close enough here too. A
    // hinge-connected pair is skipped by overlappingPairs itself, same as it
    // is by the real collision loop below - so a hinged pair (which is
    // typically touching by construction) never reaches either detection
    // path and never needs this seeding to stay silent.
    var initialPairs = overlappingPairs(sim);
    for (var q = 0; q < initialPairs.length; q++) wasTouchingPairs[initialPairs[q]] = true;
    // Same reasoning, for the line-hinge alignment check: seed each pair's
    // "which side" from the scene as given, so a double pendulum that
    // happens to start already folded into alignment doesn't read that as
    // a crossing on step 0 - only an actual sign change, step to step,
    // counts (see lineHingeCrossState above).
    var prevCrossSign = linePairs.map(function (lp) { return lineHingeCrossState(sim, lp).sign; });
    var events = [];
    for (var i = 0; i < steps; i++) {
      step(sim, dt, { contactsOut: contactsBuf });
      var nowTouchingPairs = {};
      var newEvent = false;
      if (geometric) {
        var pairs = overlappingPairs(sim);
        for (var p = 0; p < pairs.length; p++) {
          nowTouchingPairs[pairs[p]] = true;
          if (!wasTouchingPairs[pairs[p]]) newEvent = true;
        }
      } else {
        for (var k = 0; k < contactsBuf.length; k++) {
          var key = contactsBuf[k].a + "," + contactsBuf[k].b;
          nowTouchingPairs[key] = true;
          if (!wasTouchingPairs[key]) newEvent = true;
        }
      }
      for (var lp2 = 0; lp2 < linePairs.length; lp2++) {
        var state = lineHingeCrossState(sim, linePairs[lp2]);
        // dot > 0 keeps this to the "same orientation" alignment (hinge on
        // one side, both centers of mass on the other) - the opposite
        // alignment (rods folded apart, dot < 0) also flips this sign once
        // per swing but isn't what this sound is for.
        if (state.sign !== 0 && prevCrossSign[lp2] !== 0 && state.sign !== prevCrossSign[lp2] && state.dot > 0) {
          newEvent = true;
        }
        if (state.sign !== 0) prevCrossSign[lp2] = state.sign;
      }
      if (newEvent) events.push(i);
      wasTouchingPairs = nowTouchingPairs;
    }
    return events;
  }

  global.PhysicsEngine = {
    DENSITY: DENSITY,
    LINE_LINEAR_DENSITY: LINE_LINEAR_DENSITY,
    // Exported so physics-gpu.js's GLSL port bakes the very same numbers
    // rather than keeping its own copies to drift out of sync.
    GRAVITY: GRAVITY,
    ANCHORED_GRAVITY_DENSITY: ANCHORED_GRAVITY_DENSITY,
    MUTUAL_GRAVITY_CONSTANT: MUTUAL_GRAVITY_CONSTANT,
    gravitationalMass: gravitationalMass,
    // How far a body reaches from its own center in any direction - a
    // circle's radius, a line's half-length, or a trapezoid's own corner
    // reach (its farthest point, so any direction is safely clear of it).
    // Exported for physics-ui.js's on-canvas resize handle, which needs
    // exactly this "how big is this shape" number for every body type.
    halfExtent: halfExtent,
    computeAccelerations: computeAccelerations,
    runBounceCounts: runBounceCounts,
    runBounceEvents: runBounceEvents,
    runTrajectory: runTrajectory,
    createCircle: createCircle,
    createLine: createLine,
    createFunnel: createFunnel,
    createSplitter: createSplitter,
    // A splitter's descendants all answer to the body index the scene's
    // Output/Input mapping names - see lineageOf's own comment.
    lineageOf: lineageOf,
    computeOutputLineageAverage: computeOutputLineageAverage,
    computeOutputValue: computeOutputValue,
    outputBodyIndices: outputBodyIndices,
    isPairOutput: isPairOutput,
    outputMappingError: outputMappingError,
    shortestSeparation: shortestSeparation,
    outputDistanceMax: outputDistanceMax,
    getLineEndpoints: getLineEndpoints,
    // Funnel geometry/mass constants - exported so physics-gpu.js's GLSL
    // port and physics-hinge-geometry.js's AABB check bake the very same
    // numbers rather than keeping their own copies to drift out of sync.
    FUNNEL_MOUTH_HALF: FUNNEL_MOUTH_HALF,
    FUNNEL_THROAT_HALF: FUNNEL_THROAT_HALF,
    FUNNEL_HALF_HEIGHT: FUNNEL_HALF_HEIGHT,
    FUNNEL_MASS_COEFF: FUNNEL_MASS_COEFF,
    MAX_SIMULATION_BODIES: MAX_SIMULATION_BODIES,
    MIN_SIMULATION_BODIES: MIN_SIMULATION_BODIES,
    MAX_SIMULATION_BODIES_LIMIT: MAX_SIMULATION_BODIES_LIMIT,
    maxSimulationBodiesFor: maxSimulationBodiesFor,
    FUNNEL_INERTIA_COEFF: FUNNEL_INERTIA_COEFF,
    getFunnelLocalVertices: getFunnelLocalVertices,
    getFunnelVertices: getFunnelVertices,
    getFunnelEdges: getFunnelEdges,
    computeMass: computeMass,
    pointInBody: pointInBody,
    step: step,
    deleteBody: deleteBody,
    cloneScene: cloneScene,
    rotateVec: rotateVec,
    worldToLocal: worldToLocal,
    getHingeWorldPoint: getHingeWorldPoint,
    hingeConnects: hingeConnects,
    LINE_THICKNESS: LINE_THICKNESS,
    // Exported so the Set Velocity tool can clamp a drag to the same ceiling
    // the first step would silently trim it to anyway, and so physics-gpu.js
    // bakes the very same numbers into its GLSL rather than keeping a third
    // and fourth set of copies to drift.
    EDGE_MODES: EDGE_MODES,
    DEFAULT_EDGE_MODE: DEFAULT_EDGE_MODE,
    edgeModeOf: edgeModeOf,
    wrapsAtEdges: wrapsAtEdges,
    collisionsEnabled: collisionsEnabled,
    OUTPUT_SIGMOID_STEEPNESS: OUTPUT_SIGMOID_STEEPNESS,
    frameSigmoid: frameSigmoid,
    MAX_SPEED: MAX_SPEED,
    MUTUAL_GRAVITY_MAX_SPEED: MUTUAL_GRAVITY_MAX_SPEED,
    speedCapFor: speedCapFor,
  };
})(window);
