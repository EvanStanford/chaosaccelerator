// CPAL-1.0 License. See chaosaccelerator.com/license.html

// Pure, DOM-free 2D rigid body engine: circles, capsule lines, funnels/splitters, pin
// hinges, springs, anchors. A scene is plain data { bodies, hinges, springs, ... } and
// step(scene, dt) mutates it in place.
(function (global) {
  "use strict";

  var DENSITY = 1;
  var LINE_LINEAR_DENSITY = 8; // mass per unit length of a line body
  // Collision/click thickness of a line: not physical, so not in mass or inertia.
  var LINE_THICKNESS = 20;

  // ---- Funnel: trapezoid (throat 1, mouth 3, legs 2, times body.size), mouth at local -y and
  // throat at +y; a circle touching the mouth teleports to the throat center, velocity kept.
  var FUNNEL_MOUTH_HALF = 0.75;
  var FUNNEL_THROAT_HALF = 0.25;
  var FUNNEL_HALF_HEIGHT = Math.sqrt(3) / 4;
  // Mass/inertia of the 3 solid edges only (the mouth is an opening): 2.5*size and size^3*37/48.
  var FUNNEL_MASS_COEFF = 2.5;
  var FUNNEL_INERTIA_COEFF = 37 / 48;

  // Default ceiling on bodies a run may GROW to via splitters; it is also the GPU shader's slot
  // count (cost is quadratic in it), so both engines must agree.
  var MAX_SIMULATION_BODIES = 20;
  // Override range: floor 2 (one split); past ~44 slots stepOnce() exceeds GLSL's 256 parameters.
  var MIN_SIMULATION_BODIES = 2;
  var MAX_SIMULATION_BODIES_LIMIT = 40;

  function maxSimulationBodiesFor(scene) {
    var v = scene && Number(scene.maxSimulationBodies);
    if (!isFinite(v) || v <= 0) return MAX_SIMULATION_BODIES;
    return Math.min(MAX_SIMULATION_BODIES_LIMIT, Math.max(MIN_SIMULATION_BODIES, Math.round(v)));
  }
  // Speed cap. Tunneling is handled by the swept tests; this only trims energy above it.
  var MAX_SPEED = 2000;
  // A close perihelion pass legitimately reaches ~2000px/s; clamping it drops the orbit.
  var MUTUAL_GRAVITY_MAX_SPEED = 5000;

  // Must agree with the GLSL copies in physics-gpu.js and physics-gpu-df.js.
  function speedCapFor(scene) {
    return scene.mutualGravity ? MUTUAL_GRAVITY_MAX_SPEED : MAX_SPEED;
  }
  // Downward pull when Mutual Gravity is off. Fixed; no friction, perfectly elastic.
  var GRAVITY = 800;
  // Below this closing speed restitution is 0, so a resting body settles instead of jittering.
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

  // advanceVelocity must be the identity at dt=0 (step() calls it per leg). Air drag (EXPERIMENTAL,
  // 0 turns it off exactly): a = -AIR_DRAG*v, linear only, as a factor (1 - AIR_DRAG*dt) before the cap.
  var AIR_DRAG = 0.005;

  function advanceVelocity(vx, vy, dt, ax, ay, maxSpeed) {
    vx += ax * dt;
    vy += ay * dt;
    var drag = 1 - AIR_DRAG * dt;
    vx *= drag; vy *= drag;
    var speedSq = vx * vx + vy * vy;
    if (speedSq > maxSpeed * maxSpeed) {
      var scale = maxSpeed / Math.sqrt(speedSq);
      vx *= scale; vy *= scale;
    }
    return { x: vx, y: vy };
  }

  // ---- Mutual Gravity: every body attracts every other by inverse square. Gravitational mass
  // is NOT body.mass (anchors have invMass 0 but must pull): shape-derived, anchors 10x denser.
  var ANCHORED_GRAVITY_DENSITY = 10;
  // Tuned so an anchored default circle (radius 30) pulls at about GRAVITY from 300px.
  var MUTUAL_GRAVITY_CONSTANT = 2500;

  // All four shapes: a trapezoid has no .length, and a NaN here makes every swept test fire.
  function gravitationalMass(body) {
    var density = body.isAnchored ? ANCHORED_GRAVITY_DENSITY : 1;
    if (body.type === "circle") return density * DENSITY * Math.PI * body.radius * body.radius;
    if (body.type === "funnel" || body.type === "splitter") {
      return density * LINE_LINEAR_DENSITY * FUNNEL_MASS_COEFF * body.size;
    }
    return density * LINE_LINEAR_DENSITY * body.length;
  }

  // Reach from center (radius, half length, mouth-corner distance): where inverse square stops.
  var FUNNEL_CORNER_REACH = Math.sqrt(FUNNEL_MOUTH_HALF * FUNNEL_MOUTH_HALF + FUNNEL_HALF_HEIGHT * FUNNEL_HALF_HEIGHT);
  function halfExtent(body) {
    if (body.type === "circle") return body.radius;
    if (body.type === "funnel" || body.type === "splitter") return FUNNEL_CORNER_REACH * body.size;
    return body.length / 2;
  }

  // Per-body acceleration this step. Uniform: (0, GRAVITY). Mutual: G*m/r^2 summed toward every
  // other body (anchors pull, are never pulled). Touching bodies (r < combined halfExtent) get
  // NO mutual gravity with collisions on: position correction would pump energy, and the contact
  // force answers the pull. With collisions off bodies pass through, so inside the pull is a
  // polynomial in r^2 matching G*m/r^2 at the rim in value, slope AND curvature (less is a corner).
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
            continue; // touching: the contact force answers for it
          } else {
            var u2 = r2 / (contact * contact);
            pull = MUTUAL_GRAVITY_CONSTANT * gravitationalMass(bodies[j]) / (contact * contact * contact) *
              (35 / 8 - 21 / 4 * u2 + 15 / 8 * u2 * u2);
          }
          ax += pull * dx;
          ay += pull * dy;
        }
      }
      acc[i] = { x: ax, y: ay };
    }
    return acc;
  }

  // ---- Springs: a FORCE, not a constraint (massless, collides with nothing). Shape:
  // { bodyA: index | null, bodyB, localAnchorA, localAnchorB, stiffness, restLength }; bodyA
  // null means localAnchorA is a WORLD point. An off-center end is the engine's only source
  // of angular acceleration. Hooke's law outside a core of SPRING_CORE*restLength; inside, a
  // polynomial in r^2 matching Hooke at the rim (value, slope, curvature), 0 at r == 0; an eighth
  // keeps its push near zero above Mutual Gravity's interior pull. No damping, on purpose.
  var SPRING_CORE = 0.125;
  // Stiffness slider range, in force per pixel; loaded scenes are clamped into it.
  var SPRING_STIFFNESS_MIN = 2000;
  var SPRING_STIFFNESS_MAX = 2000000;
  var SPRING_REST_LENGTH_MAX = 1000;
  // Semi-implicit Euler holds an oscillator only while (omega*dt)^2 < 4 and spin has no cap, so
  // stiffness is limited to k*dt^2*(wA + wB) <= SPRING_STABILITY, w = 1/mass + arm^2/inertia per
  // end (shape-only, so still conservative). Swing under tension is handled in springSpin.
  var SPRING_STABILITY = 0.5;

  function sceneSprings(scene) { return scene.springs || []; }

  function springBodyA(spring, bodies) {
    return spring.bodyA === null ? WORLD_BODY : bodies[spring.bodyA];
  }

  function springEndWeight(body, localAnchor) {
    if (body.isAnchored) return 0;
    return body.invMass + body.invInertia * (localAnchor.x * localAnchor.x + localAnchor.y * localAnchor.y);
  }

  // Stiffest this spring may be at this dt; Infinity when neither end can move.
  function springStableStiffness(spring, bodies, dt) {
    var wSum = springEndWeight(springBodyA(spring, bodies), spring.localAnchorA) +
      springEndWeight(bodies[spring.bodyB], spring.localAnchorB);
    return wSum > 0 ? SPRING_STABILITY / (wSum * dt * dt) : Infinity;
  }

  function springEffectiveStiffness(spring, bodies, dt) {
    return Math.min(spring.stiffness, springStableStiffness(spring, bodies, dt));
  }

  function getSpringWorldPoints(spring, bodies) {
    var bodyA = springBodyA(spring, bodies), bodyB = bodies[spring.bodyB];
    var rA = rotateVec(spring.localAnchorA, bodyA.angle);
    var rB = rotateVec(spring.localAnchorB, bodyB.angle);
    return { a: { x: bodyA.x + rA.x, y: bodyA.y + rA.y }, b: { x: bodyB.x + rB.x, y: bodyB.y + rB.y } };
  }

  // The spring law as f in F = f*d: Hooke outside the core, the polynomial inside.
  function springForceFactor(length, restLength) {
    if (restLength === 0) return 1;
    var c = SPRING_CORE * restLength;
    if (length >= c) return 1 - restLength / length;
    var u = (length * length) / (c * c);
    return 1 - (restLength / c) * (15 / 8 - 5 / 4 * u + 3 / 8 * u * u);
  }

  function springArmLength(localAnchor) {
    return Math.sqrt(localAnchor.x * localAnchor.x + localAnchor.y * localAnchor.y);
  }

  // Spin after t seconds of torque. Explicit while swing*t^2 < SPRING_STABILITY (swing: summed
  // tension*arm/inertia); past it the excess goes backward-Euler: stable, dissipative, continuous in t.
  function springSpin(w, alpha, swing, t) {
    return (w + alpha * t) / (1 + Math.max(0, swing * t * t - SPRING_STABILITY));
  }

  // Adds spring pulls to acc, alpha (nothing else contributes) and swing, once per step.
  function addSpringAccelerations(scene, acc, alpha, swing, dt) {
    var bodies = scene.bodies, springs = sceneSprings(scene);
    for (var s = 0; s < springs.length; s++) {
      var spring = springs[s];
      var bodyA = springBodyA(spring, bodies), bodyB = bodies[spring.bodyB];
      if (bodyA.isAnchored && bodyB.isAnchored) continue; // nothing here can move
      var rA = rotateVec(spring.localAnchorA, bodyA.angle);
      var rB = rotateVec(spring.localAnchorB, bodyB.angle);
      var dx = (bodyB.x + rB.x) - (bodyA.x + rA.x);
      var dy = (bodyB.y + rB.y) - (bodyA.y + rA.y);
      var k = springEffectiveStiffness(spring, bodies, dt);
      var length = Math.sqrt(dx * dx + dy * dy);
      var f = k * springForceFactor(length, spring.restLength);
      var fx = f * dx, fy = f * dy;
      var tension = Math.abs(f) * length; // |F|
      if (!bodyA.isAnchored) {
        acc[spring.bodyA].x += fx * bodyA.invMass;
        acc[spring.bodyA].y += fy * bodyA.invMass;
        alpha[spring.bodyA] += (rA.x * fy - rA.y * fx) * bodyA.invInertia;
        swing[spring.bodyA] += tension * springArmLength(spring.localAnchorA) * bodyA.invInertia;
      }
      if (!bodyB.isAnchored) {
        acc[spring.bodyB].x -= fx * bodyB.invMass;
        acc[spring.bodyB].y -= fy * bodyB.invMass;
        alpha[spring.bodyB] -= (rB.x * fy - rB.y * fx) * bodyB.invInertia;
        swing[spring.bodyB] += tension * springArmLength(spring.localAnchorB) * bodyB.invInertia;
      }
    }
  }

  // Potential the force above is the gradient of, for energy audits.
  function springPotentialEnergy(scene, dt) {
    var total = 0, bodies = scene.bodies;
    sceneSprings(scene).forEach(function (spring) {
      var p = getSpringWorldPoints(spring, bodies);
      var dx = p.b.x - p.a.x, dy = p.b.y - p.a.y;
      var r = Math.sqrt(dx * dx + dy * dy), L0 = spring.restLength, c = SPRING_CORE * L0;
      var k = springEffectiveStiffness(spring, bodies, dt);
      if (L0 === 0 || r >= c) { total += 0.5 * k * (r - L0) * (r - L0); return; }
      // Inside the core: Hooke's energy at the rim plus the integral of f(r)*r from there in.
      function G(x) { var u = (x * x) / (c * c); return k * x * x * (0.5 - (L0 / c) * (15 / 16 - 5 / 16 * u + 1 / 16 * u * u)); }
      total += 0.5 * k * (c - L0) * (c - L0) + G(r) - G(c);
    });
    return total;
  }

  // ---- Springs and the frame's edges: a sprung set wraps together or not at all. GROUPS of
  // bodies joined by springs (directly or via hinges): `tethered` (a spring to the background, or
  // an anchored member) never wraps; else it wraps with its `leader`, the lowest free non-hinge-child.
  function springGroups(scene) {
    var springs = sceneSprings(scene);
    if (!springs.length) return null;
    var n = scene.bodies.length, parent = new Array(n), i;
    for (i = 0; i < n; i++) parent[i] = i;
    function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
    function union(a, b) { a = find(a); b = find(b); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); }
    var sprung = {};
    springs.forEach(function (s) {
      sprung[s.bodyB] = true;
      if (s.bodyA !== null) { sprung[s.bodyA] = true; union(s.bodyA, s.bodyB); }
    });
    var isHingeChild = {};
    scene.hinges.forEach(function (h) {
      if (h.bodyA !== null) { union(h.bodyA, h.bodyB); isHingeChild[h.bodyB] = true; }
    });
    var byRoot = {}, groups = [], groupOf = new Array(n);
    for (i = 0; i < n; i++) groupOf[i] = null;
    for (i = 0; i < n; i++) if (sprung[i] && !byRoot[find(i)]) {
      byRoot[find(i)] = { members: [], tethered: false, leader: -1 };
      groups.push(byRoot[find(i)]);
    }
    for (i = 0; i < n; i++) {
      var g = byRoot[find(i)];
      if (!g) continue;
      groupOf[i] = g;
      g.members.push(i);
      if (scene.bodies[i].isAnchored) g.tethered = true;
      else if (g.leader === -1 && !isHingeChild[i]) g.leader = i;
    }
    springs.forEach(function (s) { if (s.bodyA === null) groupOf[s.bodyB].tethered = true; });
    return { groups: groups, groupOf: groupOf };
  }

  function computeMass(body) {
    if (body.isAnchored) {
      body.mass = 0; body.invMass = 0; body.inertia = 0; body.invInertia = 0;
      // The contact solver still reads an anchor's velocity; a stale one makes a moving wall.
      body.vx = 0; body.vy = 0; body.w = 0;
      return;
    }
    if (body.type === "circle") {
      var area = Math.PI * body.radius * body.radius;
      body.mass = DENSITY * area;
      body.inertia = body.mass * body.radius * body.radius / 2;
    } else if (body.type === "funnel" || body.type === "splitter") {
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

  // Same trapezoid as a funnel with the trigger swapped: a circle touching the SHORT side splits.
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

  // Corners in the local frame (unrotated, uncentered); physics-hinge-geometry.js uses them too.
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

  // mouth: teleport trigger. throat/leg1/leg2: solid edges. throatCenter: teleport target.
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

  // Ericson, "Real-Time Collision Detection", ClosestPtSegmentSegment.
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

  // ---- Collision detection. Normals point A -> B (first argument to second); lines are capsules. ----

  // Sweep primitives: earliest t in [0,dt] at which a moving point reaches distance R, or -1.

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

  // Flat side of the capsule; outside the axial span [0,len] the caps own the contact (-1).
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
      // Solve the exact crossing time, so the contact is continuous in the starting conditions.
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
      // Lever arms at the true contact instant, exactly +-n*radius; stale centers inject spin.
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

  // Swept capsule (e0-e1, moving at segVx/segVy, rotation ignored) vs. circle: flat side plus a cap
  // each end, earliest t wins. refX/refY is the OWNING body's center, since rA is its lever arm.
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

    // Computed in the segment's frame; its own translation over tHit cancels out of rA.
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

  // line = A, circle = B; normal points line -> circle. Swept in the line's frame.
  function collideLineCircle(line, circle, dt) {
    var endpoints = getLineEndpoints(line);
    var c = sweptCapsuleCircleContact(endpoints[0], endpoints[1], line.vx, line.vy, line.x, line.y, circle, LINE_THICKNESS / 2, dt);
    return c ? [c] : null;
  }

  // funnel = A, circle = B: the 3 solid edges bounce; the mouth teleports instead (step()).
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

  // Circle's path vs. the mouth in [0, dt]; target is the throat center advanced to tHit.
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

  // splitter = A, circle = B: collideFunnelCircle with the trigger swapped (short side splits).
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

  // Circle's path vs. the short side. Returns two DISPLACEMENTS: translations by each leg vector
  // (throat corner -> mouth corner) plus 2*(halfThickness + radius), so a ball touching the entrance
  // exits touching the exit from OUTSIDE. A translation, not a snap, keeps the split continuous.
  function collideSplitterShortSideTHit(splitter, circle, dt) {
    var edges = getFunnelEdges(splitter);
    var throatLeft0 = edges.throat[0], throatRight0 = edges.throat[1];

    // Only a FRESH crossing splits; a circle already inside the capsule would re-split every step.
    var startClosest = closestPointOnSegment(throatLeft0, throatRight0, { x: circle.x, y: circle.y });
    var sdx = circle.x - startClosest.x, sdy = circle.y - startClosest.y;
    if (Math.sqrt(sdx * sdx + sdy * sdy) < LINE_THICKNESS / 2 + circle.radius) return null;

    var contact = sweptCapsuleCircleContact(edges.throat[0], edges.throat[1], splitter.vx, splitter.vy, splitter.x, splitter.y, circle, LINE_THICKNESS / 2, dt);
    if (!contact) return null;

    var mouthLeft = edges.mouth[0], mouthRight = edges.mouth[1];
    // Unit normal of the parallel sides, short side -> long side.
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

  // Near-parallel lines get contact at BOTH ends of their overlap, or a flat rod spins away.
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

  // A and B are PROBE bodies (velocity advanced by this step's gravity: see step()); tHit in [0, dt].
  function collidePair(A, B, dt) {
    var cs;
    if (A.type === "circle" && B.type === "circle") cs = collideCircleCircle(A, B, dt);
    else if (A.type === "line" && B.type === "circle") cs = collideLineCircle(A, B, dt);
    else if (A.type === "circle" && B.type === "line") {
      // Called as (line=B, circle=A): flip the normal and swap rA/rB back to this A/B order.
      cs = collideLineCircle(B, A, dt);
      if (cs) for (var i = 0; i < cs.length; i++) {
        cs[i].normal.x *= -1; cs[i].normal.y *= -1;
        var tmp = cs[i].rA; cs[i].rA = cs[i].rB; cs[i].rB = tmp;
      }
    } else if (A.type === "funnel" && B.type === "circle") {
      cs = collideFunnelCircle(A, B, dt);
    } else if (A.type === "circle" && B.type === "funnel") {
      cs = collideFunnelCircle(B, A, dt);
      if (cs) for (var j = 0; j < cs.length; j++) {
        cs[j].normal.x *= -1; cs[j].normal.y *= -1;
        var tmp2 = cs[j].rA; cs[j].rA = cs[j].rB; cs[j].rB = tmp2;
      }
    } else if (A.type === "splitter" && B.type === "circle") {
      cs = collideSplitterCircle(A, B, dt);
    } else if (A.type === "circle" && B.type === "splitter") {
      cs = collideSplitterCircle(B, A, dt);
      if (cs) for (var k = 0; k < cs.length; k++) {
        cs[k].normal.x *= -1; cs[k].normal.y *= -1;
        var tmp3 = cs[k].rA; cs[k].rA = cs[k].rB; cs[k].rB = tmp3;
      }
    } else if (A.type === "line" && B.type === "line") {
      cs = collideLineLine(A, B);
    } else {
      // funnel/splitter vs line or each other: not modeled; null rather than crash on .length.
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
    // Lever arms from the contact instant, not (point - center): centers are mid-step.
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

    // Smoothed restitution ramp: no cliff at rest, and a grazing hit stays continuous with a miss.
    var e = smoothstep(0.5 * RESTITUTION_THRESHOLD, RESTITUTION_THRESHOLD, -velAlongNormal);
    var j = -(1 + e) * velAlongNormal / invMassSum;
    applyImpulse(bodyA, -n.x * j, -n.y * j, rA);
    applyImpulse(bodyB, n.x * j, n.y * j, rB);
    // Frictionless. No position fixup here: step()'s two-leg integration handles the sub-step.
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

  // Hinged bodies touch at the joint by design; colliding them there fights the joint solver.
  function hingeConnects(hinges, i, j) {
    for (var h = 0; h < hinges.length; h++) {
      var hinge = hinges[h];
      if ((hinge.bodyA === i && hinge.bodyB === j) || (hinge.bodyA === j && hinge.bodyB === i)) return true;
    }
    return false;
  }

  function solve2x2(bodyA, bodyB, rA, rB, rhsX, rhsY) {
    var mA = bodyA.invMass, mB = bodyB.invMass, iA = bodyA.invInertia, iB = bodyB.invInertia;
    // Positive definite whenever either body has mass; an epsilon on det fails for heavy bodies.
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

  // ---- Frame-wrap helpers: a world-hinged body wraps by its PIN and its whole hinged assembly
  // translates with it (keeps every hinge satisfied on a torus); a hinge child never wraps alone.
  // ---- Edge modes (all share frameWidth/frameHeight):
  //   "sticky"   run ends at an edge (engine still wraps; PhysicsHingeGeometry.findWrapStopStep)
  //   "wrap"     Pac-Man: leaving one edge reappears at the opposite
  //   "infinite" no edges at all
  var EDGE_MODES = ["sticky", "wrap", "infinite"];
  var DEFAULT_EDGE_MODE = "sticky";

  function edgeModeOf(scene) {
    return EDGE_MODES.indexOf(scene.edgeMode) === -1 ? DEFAULT_EDGE_MODE : scene.edgeMode;
  }
  function wrapsAtEdges(scene) {
    return edgeModeOf(scene) !== "infinite" && !!(scene.frameWidth && scene.frameHeight);
  }

  // Opt-OUT: absent means enabled. The engine has no opinion about mutualGravity here.
  function collisionsEnabled(scene) {
    return scene.collisionsEnabled !== false;
  }

  // Squashes a frame-relative position (frame = 0..1) into (0, 1) for Infinite Space.
  var OUTPUT_SIGMOID_STEEPNESS = 5;
  function frameSigmoid(v) {
    return 1 / (1 + Math.exp(-OUTPUT_SIGMOID_STEEPNESS * (v - 0.5)));
  }

  function wrapCoord(v, span) {
    if (v > span) return v - span;
    if (v < 0) return v + span;
    return v;
  }

  // Not physics-hinge-geometry.js's version (it depends on this file). Translates the hinge subtree.
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

  // Same for a spring group, including background pins members hang from, or a hinge tears.
  function translateSpringGroup(scene, group, dx, dy) {
    var isMember = {};
    group.members.forEach(function (m) {
      isMember[m] = true;
      scene.bodies[m].x += dx;
      scene.bodies[m].y += dy;
    });
    scene.hinges.forEach(function (h) {
      if (h.bodyA === null && isMember[h.bodyB]) h.localAnchorA = { x: h.localAnchorA.x + dx, y: h.localAnchorA.y + dy };
    });
  }

  // .lineage: the authored index a split-born body descends from (others: their own index).
  function lineageOf(scene, index) {
    var body = scene.bodies[index];
    return body && body.lineage !== undefined && body.lineage !== null ? body.lineage : index;
  }

  // ---- Two-body Outputs { body, bodyB, property }: x/y/angle become the pair's mean; adds "distance".
  function outputBodyIndices(output) {
    if (!output || typeof output.body !== "number") return [];
    var indices = [output.body];
    if (typeof output.bodyB === "number" && output.bodyB !== output.body) indices.push(output.bodyB);
    return indices;
  }

  function isPairOutput(output) { return outputBodyIndices(output).length === 2; }

  // null when downstream can evaluate this mapping, else a readable reason.
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

  // Short way round on a wrapped frame, so a distance Output doesn't jump at an edge crossing.
  function shortestSeparation(scene, dx, dy) {
    if (!wrapsAtEdges(scene)) return { x: dx, y: dy };
    var w = scene.frameWidth, h = scene.frameHeight;
    return { x: dx - w * Math.round(dx / w), y: dy - h * Math.round(dy / h) };
  }

  // Largest distance value: the antipode on a torus; with no edges the diagonal, frameSigmoid's scale.
  function outputDistanceMax(scene) {
    var w = scene.frameWidth || 0, h = scene.frameHeight || 0;
    var f = wrapsAtEdges(scene) ? 0.5 : 1;
    return Math.sqrt(w * f * w * f + h * f * h * f) || 1;
  }

  // The one JS definition of the Output value; the grid shader's GLSL matches it term for term.
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

    // Fixed for the whole step; both legs and the detection sweep must agree on it.
    var maxSpeed = speedCapFor(scene);
    var acc = computeAccelerations(scene);
    // Springs add angular acceleration (alpha) and the swing tally; all zeros without springs.
    var alpha = new Array(bodies.length).fill(0), swing = new Array(bodies.length).fill(0);
    if (sceneSprings(scene).length) addSpringAccelerations(scene, acc, alpha, swing, dt);

    // u: entering velocity. vFull: whole-step velocity, used for BOTH detection and leg 1.
    var u = new Array(bodies.length), vFull = new Array(bodies.length);
    for (i = 0; i < bodies.length; i++) {
      if (bodies[i].isAnchored) continue;
      u[i] = { x: bodies[i].vx, y: bodies[i].vy };
      vFull[i] = advanceVelocity(u[i].x, u[i].y, dt, acc[i].x, acc[i].y, maxSpeed);
    }

    var probes = new Array(bodies.length);
    for (i = 0; i < bodies.length; i++) {
      probes[i] = bodies[i].isAnchored ? bodies[i] : Object.assign({}, bodies[i], { vx: vFull[i].x, vy: vFull[i].y });
    }

    // Funnel teleports: a winner replaces leg 1's position update. Earliest mouth per circle wins.
    var teleportTarget = new Array(bodies.length).fill(null);
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

    // Splitter hits: earliest per circle, APPLIED at the end of step() since a split adds a body.
    var splitHit = new Array(bodies.length).fill(null);
    if (collisionsEnabled(scene)) {
      for (i = 0; i < bodies.length; i++) {
        if (bodies[i].type !== "splitter") continue;
        for (j = 0; j < bodies.length; j++) {
          if (bodies[j].type !== "circle") continue;
          // Never split an anchor: no position of its own, and invMass 0 can't be inherited.
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

    // Ordinary solid pairs. Empty with collisions off; every consumer handles "no contacts".
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

    // Earliest contact instant per body; dt when none (leg 1 is the whole step, leg 2 a no-op).
    var bodyTHit = new Array(bodies.length).fill(dt);
    for (i = 0; i < contacts.length; i++) {
      var c = contacts[i];
      if (c.tHit < bodyTHit[c.a]) bodyTHit[c.a] = c.tHit;
      if (c.tHit < bodyTHit[c.b]) bodyTHit[c.b] = c.tHit;
    }

    // A teleport wins when earliest on its body (ties to it); its contacts with that funnel are dropped.
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
    // Same for a splitter: a ball going THROUGH must not bounce off a leg end-cap. After the tHit fold.
    if (contacts.length) {
      contacts = contacts.filter(function (sc) {
        var si = bodies[sc.a].type === "splitter" ? sc.a : (bodies[sc.b].type === "splitter" ? sc.b : -1);
        var ci = bodies[sc.a].type === "circle" ? sc.a : (bodies[sc.b].type === "circle" ? sc.b : -1);
        if (si === -1 || ci === -1) return true;
        return !(splitHit[ci] && splitHit[ci].splitterIndex === si);
      });
    }

    // Opt-in per-body "touching this step" (Bounce Count's source; twin of the GPU's g_contactN).
    var contactFlags = opts.contactFlags;
    if (contactFlags) {
      for (i = 0; i < bodies.length; i++) contactFlags[i] = false;
      for (i = 0; i < contacts.length; i++) {
        contactFlags[contacts[i].a] = true;
        contactFlags[contacts[i].b] = true;
      }
    }
    // Opt-in raw pair list for runBounceEvents' per-pair detection. Refilled in place.
    var contactsOut = opts.contactsOut;
    if (contactsOut) {
      contactsOut.length = 0;
      for (i = 0; i < contacts.length; i++) contactsOut.push({ a: contacts[i].a, b: contacts[i].b });
    }

    // Leg 1: move at vFull for tHit (matching detection), then set velocity to gravity applied only
    // up to tHit before the solve (reflecting v+g*dt vs v then adding g*dt differ by 2*(g.n)*dt).
    // A teleport winner's position is OVERRIDDEN to the throat center; velocity is as any other.
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
      // Angular twin: turn at the whole step's spin, keep only the torque acted by tHit.
      b1.angle += springSpin(b1.w, alpha[i], swing[i], dt) * th;
      b1.w = springSpin(b1.w, alpha[i], swing[i], th);
      var vPre = advanceVelocity(u[i].x, u[i].y, th, acc[i].x, acc[i].y, maxSpeed);
      b1.vx = vPre.x; b1.vy = vPre.y;
    }

    var iter;
    for (iter = 0; iter < velIter; iter++) {
      for (i = 0; i < scene.hinges.length; i++) solveHingeVelocity(scene.hinges[i], bodies);
      for (i = 0; i < contacts.length; i++) {
        solveContactVelocity(contacts[i], bodies[contacts[i].a], bodies[contacts[i].b]);
      }
    }

    // Leg 2: the rest of the step and of gravity on the POST-impulse velocity; identity if no contact.
    for (i = 0; i < bodies.length; i++) {
      var b2 = bodies[i];
      if (b2.isAnchored) continue;
      var tRest = dt - bodyTHit[i];
      var vPost = advanceVelocity(b2.vx, b2.vy, tRest, acc[i].x, acc[i].y, maxSpeed);
      b2.vx = vPost.x; b2.vy = vPost.y;
      b2.w = springSpin(b2.w, alpha[i], swing[i], tRest);
      b2.x += vPost.x * tRest; b2.y += vPost.y * tRest; b2.angle += b2.w * tRest;
    }

    for (iter = 0; iter < posIter; iter++) {
      for (i = 0; i < scene.hinges.length; i++) solveHingePosition(scene.hinges[i], bodies);
      for (i = 0; i < contacts.length; i++) {
        solveContactPosition(contacts[i], bodies[contacts[i].a], bodies[contacts[i].b]);
      }
    }

    // Edge wrapping, last (matches the GLSL). Only roots decide; world-hinged by PIN; sprung by group.
    if (wrapsAtEdges(scene)) {
      var isHingeChild = {};
      var ownWorldHinge = {};
      scene.hinges.forEach(function (h) {
        if (h.bodyA === null) ownWorldHinge[h.bodyB] = h;
        else isHingeChild[h.bodyB] = true;
      });
      var sprung = springGroups(scene);
      for (i = 0; i < bodies.length; i++) {
        var wb = bodies[i];
        if (wb.isAnchored || isHingeChild[i]) continue;
        var group = sprung ? sprung.groupOf[i] : null;
        if (group && (group.tethered || group.leader !== i)) continue;
        var worldHinge = ownWorldHinge[i];
        var ref = worldHinge ? worldHinge.localAnchorA : wb;
        var dx = wrapCoord(ref.x, scene.frameWidth) - ref.x;
        var dy = wrapCoord(ref.y, scene.frameHeight) - ref.y;
        if (dx === 0 && dy === 0) continue;
        if (group) {
          translateSpringGroup(scene, group, dx, dy);
          continue;
        }
        if (worldHinge) worldHinge.localAnchorA = { x: worldHinge.localAnchorA.x + dx, y: worldHinge.localAnchorA.y + dy };
        wrapTranslateAndCascade(scene, i, dx, dy, {});
      }
    }

    // Splits last, from the final state; the parent KEEPS ITS SLOT (and lineage), the half is appended.
    for (i = 0; i < splitHit.length; i++) {
      var sh = splitHit[i];
      if (!sh) continue;
      var parent = bodies[i];
      // Both offsets are from the pre-split position: read the child's before the parent moves.
      var childX = parent.x + sh.offset2.x, childY = parent.y + sh.offset2.y;
      parent.x += sh.offset1.x;
      parent.y += sh.offset1.y;
      // At the ceiling the ball still passes through, just without duplicating; continue, not break.
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
    // A spring goes with either body it was tied to. (No field stays no field.)
    if (scene.springs) scene.springs = scene.springs.filter(function (s) {
      return s.bodyA !== index && s.bodyB !== index;
    }).map(function (s) {
      var copy = cloneSpring(s);
      if (copy.bodyA !== null && copy.bodyA > index) copy.bodyA -= 1;
      if (copy.bodyB > index) copy.bodyB -= 1;
      return copy;
    });
  }

  function cloneSpring(s) {
    return {
      bodyA: s.bodyA,
      bodyB: s.bodyB,
      localAnchorA: { x: s.localAnchorA.x, y: s.localAnchorA.y },
      localAnchorB: { x: s.localAnchorB.x, y: s.localAnchorB.y },
      stiffness: s.stiffness,
      restLength: s.restLength,
    };
  }

  function cloneScene(scene) {
    return {
      // physics-ui.js clones the scene on Play and back on Reset: an omitted field is wiped by that.
      mutualGravity: !!scene.mutualGravity,
      collisionsEnabled: collisionsEnabled(scene),
      edgeMode: edgeModeOf(scene),
      simulationSteps: scene.simulationSteps,
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
      springs: sceneSprings(scene).map(cloneSpring),
      xInput: scene.xInput ? { body: scene.xInput.body, property: scene.xInput.property } : null,
      yInput: scene.yInput ? { body: scene.yInput.body, property: scene.yInput.property } : null,
      output: scene.output ? { body: scene.output.body, bodyB: scene.output.bodyB === undefined ? null : scene.output.bodyB, property: scene.output.property } : null,
      frameWidth: scene.frameWidth,
      frameHeight: scene.frameHeight,
    };
  }

  // runTrajectory: rows[i] is every body's state after i+1 steps, like PhysicsGPU.runSceneOnGPU's
  // plus radius and lineage; rows grow as splitters add bodies (a GPU row is always full width).
  // runBounceCounts: counts[i] is the body's bounces by the end of step i+1; a bounce is the
  // false->true edge of contactFlags, not every step spent touching. Both use a private clone.
  function runTrajectory(scene, steps, dt) {
    var sim = cloneScene(scene);
    // A scene straight from JSON has no invMass/invInertia; stepping without them yields NaN.
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

  // Pairs overlapping geometrically (halfExtent sum), solver running or not; keys "i,j", i < j.
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

  // Hinged pairs of two free lines (a double pendulum); the alignment event below is theirs.
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

  // `sign`: which side of ray 1 (hinge -> center A) ray 2 falls on; `dot` > 0: centers on one side.
  // A sign flip between steps is the event.
  function lineHingeCrossState(sim, pair) {
    var hingePoint = getHingeWorldPoint(pair.hinge, sim.bodies);
    var a = sim.bodies[pair.i], b = sim.bodies[pair.j];
    var v1x = a.x - hingePoint.x, v1y = a.y - hingePoint.y;
    var v2x = b.x - hingePoint.x, v2y = b.y - hingePoint.y;
    var cross = v1x * v2y - v1y * v2x;
    var dot = v1x * v2x + v1y * v2y;
    return { sign: cross > 0 ? 1 : (cross < 0 ? -1 : 0), dot: dot };
  }

  // Steps at which some pair STARTS touching: the bounce sound's event source. Per-PAIR state
  // ("a,b", a < b). Mutual Gravity usually runs with collisions off, so there overlap is geometric
  // (overlappingPairs); otherwise the contact list. Hinged-line alignment also fires. One event a step.
  function runBounceEvents(scene, steps, dt) {
    var geometric = !!scene.mutualGravity;
    var sim = cloneScene(scene);
    sim.bodies.forEach(computeMass);
    var linePairs = hingedLinePairs(sim);
    if (!geometric && !collisionsEnabled(scene) && linePairs.length === 0) return [];
    var contactsBuf = [];
    var wasTouchingPairs = {};
    // Seed with pairs already overlapping, so pre-placed contact isn't a fresh bounce on step 0.
    var initialPairs = overlappingPairs(sim);
    for (var q = 0; q < initialPairs.length; q++) wasTouchingPairs[initialPairs[q]] = true;
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
        // dot > 0: only the same-orientation alignment; the folded-apart flip isn't the sound's.
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
    // Exported so physics-gpu.js's GLSL bakes the same numbers.
    GRAVITY: GRAVITY,
    AIR_DRAG: AIR_DRAG,
    ANCHORED_GRAVITY_DENSITY: ANCHORED_GRAVITY_DENSITY,
    MUTUAL_GRAVITY_CONSTANT: MUTUAL_GRAVITY_CONSTANT,
    gravitationalMass: gravitationalMass,
    halfExtent: halfExtent,
    computeAccelerations: computeAccelerations,
    runBounceCounts: runBounceCounts,
    runBounceEvents: runBounceEvents,
    runTrajectory: runTrajectory,
    createCircle: createCircle,
    createLine: createLine,
    createFunnel: createFunnel,
    createSplitter: createSplitter,
    lineageOf: lineageOf,
    computeOutputLineageAverage: computeOutputLineageAverage,
    computeOutputValue: computeOutputValue,
    outputBodyIndices: outputBodyIndices,
    isPairOutput: isPairOutput,
    outputMappingError: outputMappingError,
    shortestSeparation: shortestSeparation,
    outputDistanceMax: outputDistanceMax,
    getLineEndpoints: getLineEndpoints,
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
    SPRING_CORE: SPRING_CORE,
    springForceFactor: springForceFactor,
    SPRING_STABILITY: SPRING_STABILITY,
    SPRING_STIFFNESS_MIN: SPRING_STIFFNESS_MIN,
    SPRING_STIFFNESS_MAX: SPRING_STIFFNESS_MAX,
    SPRING_REST_LENGTH_MAX: SPRING_REST_LENGTH_MAX,
    sceneSprings: sceneSprings,
    cloneSpring: cloneSpring,
    getSpringWorldPoints: getSpringWorldPoints,
    springStableStiffness: springStableStiffness,
    springEffectiveStiffness: springEffectiveStiffness,
    springPotentialEnergy: springPotentialEnergy,
    springGroups: springGroups,
    translateSpringGroup: translateSpringGroup,
    LINE_THICKNESS: LINE_THICKNESS,
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
