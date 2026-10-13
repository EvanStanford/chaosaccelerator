// CPAL-1.0 License. See chaosaccelerator.com/license.html

// Pure, DOM-free 2D rigid body engine: circles, capsule lines, port holes, pin hinges,
// springs, anchors. A scene is plain data { bodies, hinges, springs, ... } and
// step(scene, dt) mutates it in place.
(function (global) {
  "use strict";

  var DENSITY = 1;
  var LINE_LINEAR_DENSITY = 8; // mass per unit length of a line body
  // Collision/click thickness of a line: not physical, so not in mass or inertia.
  var LINE_THICKNESS = 20;

  // ---- Port holes: a pair of lines whose fronts are joined. The front half of the oval lets a chain
  // leader through, and it leaves the other port hole with its velocity and offset carried over into
  // that port hole's frame. The back half, and a lone port hole, bounce.
  var PORTHOLE_COLORS = ["orange", "green"];

  // Tangent along the line; the front normal points up the screen at angle 0.
  function portholeAxes(angle) {
    var c = Math.cos(angle), s = Math.sin(angle);
    return { tx: c, ty: s, nx: s, ny: -c };
  }

  // Speed cap. Tunneling is handled by the swept tests; this only trims energy above it.
  var MAX_SPEED = 2000;
  // A close perihelion pass legitimately reaches ~2000px/s; clamping it drops the orbit.
  var MUTUAL_GRAVITY_MAX_SPEED = 5000;

  // Must agree with the GLSL copies in physics-gpu.js and physics-gpu-df.js.
  function speedCapFor(scene) {
    return scene.mutualGravity ? MUTUAL_GRAVITY_MAX_SPEED : MAX_SPEED;
  }
  // Downward pull when Mutual Gravity is off. Fixed; contacts are perfectly elastic.
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

  // Friction: scene.friction is the share of speed lost per second (0 = none, the default). As a rate
  // k = -ln(1 - f), a leg of length dt is the closed-form solution of dv/dt = a - k v, so legs compose (below
  // the speed cap), dt=0 is the identity and a negative leg undoes a positive one: v' = v e^-x + a dt phi(x),
  // x = k dt, phi = (1 - e^-x)/x. Spin is left alone.
  var FRICTION_MAX = 0.99;
  function frictionOf(scene) {
    var f = Number(scene.friction);
    return f > 0 ? Math.min(FRICTION_MAX, f) : 0;
  }
  function frictionRate(scene) {
    var f = frictionOf(scene);
    return f > 0 ? -Math.log(1 - f) : 0;
  }
  // Must agree with the GLSL copies in physics-gpu.js and physics-gpu-df.js.
  function advanceVelocity(vx, vy, dt, ax, ay, maxSpeed, friction) {
    if (friction > 0) {
      var x = friction * dt, phi = x !== 0 ? -Math.expm1(-x) / x : 1, decay = 1 - x * phi;
      vx = vx * decay + ax * dt * phi;
      vy = vy * decay + ay * dt * phi;
    } else {
      vx += ax * dt;
      vy += ay * dt;
    }
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

  function gravitationalMass(body) {
    var density = body.isAnchored ? ANCHORED_GRAVITY_DENSITY : 1;
    if (body.type === "circle") return density * DENSITY * Math.PI * body.radius * body.radius;
    return density * LINE_LINEAR_DENSITY * body.length;
  }

  // Reach from center (radius, half length): where inverse square stops.
  function halfExtent(body) {
    return body.type === "circle" ? body.radius : body.length / 2;
  }

  // Mutual Gravity's pull of bodyJ on a body of bodyI's shape sitting (dx, dy) short of it, as an
  // acceleration: G*m/r^2 (anchors pull, are never pulled). Touching bodies (r < combined halfExtent)
  // get NO pull with collisions on (null): position correction would pump energy, and the contact
  // force answers the pull. With collisions off bodies pass through, so inside the pull is a
  // polynomial in r^2 matching G*m/r^2 at the rim in value, slope AND curvature (less is a corner).
  function mutualPull(scene, bodyI, bodyJ, dx, dy) {
    var r2 = dx * dx + dy * dy;
    var contact = halfExtent(bodyI) + halfExtent(bodyJ);
    var pull;
    if (r2 >= contact * contact) {
      pull = MUTUAL_GRAVITY_CONSTANT * gravitationalMass(bodyJ) / (r2 * Math.sqrt(r2));
    } else if (collisionsEnabled(scene)) {
      return null;
    } else {
      var u2 = r2 / (contact * contact);
      pull = MUTUAL_GRAVITY_CONSTANT * gravitationalMass(bodyJ) / (contact * contact * contact) *
        (35 / 8 - 21 / 4 * u2 + 15 / 8 * u2 * u2);
    }
    return { x: pull * dx, y: pull * dy };
  }

  // Per-body acceleration this step: (0, GRAVITY), or under Mutual Gravity every other body's pull.
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
          var p = mutualPull(scene, bodies[i], bodies[j], bodies[j].x - bodies[i].x, bodies[j].y - bodies[i].y);
          if (p) { ax += p.x; ay += p.y; }
        }
      }
      acc[i] = { x: ax, y: ay };
    }
    return acc;
  }

  // ---- Gravity Substeps (Settings > Performance): page state, not scene data. Under Mutual Gravity a step's
  // pull is taken GRAVITY_SUBSTEPS times, so a fast close pass doesn't hang on where the step boundaries fall.
  var GRAVITY_SUBSTEPS = 3;
  var gravitySubstepsOn = false;
  function setGravitySubsteps(on) { gravitySubstepsOn = !!on; }
  function gravitySubstepsFor(scene) { return gravitySubstepsOn && scene.mutualGravity ? GRAVITY_SUBSTEPS : 1; }

  // The constant acceleration a leg of dt takes from velocity u to v: advanceVelocity's inverse below the cap.
  function legAcceleration(u, v, dt, friction) {
    if (friction > 0) {
      var x = friction * dt, phi = -Math.expm1(-x) / x, decay = 1 - x * phi;
      return { x: (v.x - u.x * decay) / (dt * phi), y: (v.y - u.y * decay) / (dt * phi) };
    }
    return { x: (v.x - u.x) / dt, y: (v.y - u.y) / dt };
  }

  // The pull at substep positions. With collisions on, a pair touching at the step's start stays pull-free, and
  // one apart pulls at no less than contact distance: the substeps run on past the bounce the step will find.
  function substepAccelerations(scene, poses, apart) {
    var bodies = scene.bodies, n = bodies.length, acc = new Array(n);
    for (var i = 0; i < n; i++) {
      var ax = 0, ay = 0;
      if (!bodies[i].isAnchored) {
        for (var j = 0; j < n; j++) {
          if (j === i || (apart && !apart[i][j])) continue;
          var dx = poses[j].x - poses[i].x, dy = poses[j].y - poses[i].y;
          if (apart) {
            var contact = halfExtent(bodies[i]) + halfExtent(bodies[j]);
            var r2 = Math.max(dx * dx + dy * dy, contact * contact);
            var k = MUTUAL_GRAVITY_CONSTANT * gravitationalMass(bodies[j]) / (r2 * Math.sqrt(r2));
            ax += k * dx; ay += k * dy;
          } else {
            var p = mutualPull(scene, bodies[i], bodies[j], dx, dy);
            ax += p.x; ay += p.y;
          }
        }
      }
      acc[i] = { x: ax, y: ay };
    }
    return acc;
  }

  // Kick-drift substeps of h = dt / GRAVITY_SUBSTEPS, so velocities trail positions by h / 2 (step's contact kick
  // follows). Springs keep their start value. vFull becomes the chord, acc the constant acceleration from u to the end.
  function substepGravity(scene, gravityStart, acc, u, vFull, dt, maxSpeed, friction) {
    var bodies = scene.bodies, n = bodies.length, h = dt / GRAVITY_SUBSTEPS, i, s;
    var poses = bodies.map(function (b) { return { x: b.x, y: b.y }; });
    var a = new Array(n), other = new Array(n), v = new Array(n);
    var apart = collisionsEnabled(scene) ? bodies.map(function (bi) {
      return bodies.map(function (bj) {
        var dx = bj.x - bi.x, dy = bj.y - bi.y, contact = halfExtent(bi) + halfExtent(bj);
        return dx * dx + dy * dy >= contact * contact;
      });
    }) : null;
    for (i = 0; i < n; i++) {
      if (bodies[i].isAnchored) continue;
      a[i] = acc[i];
      other[i] = { x: acc[i].x - gravityStart[i].x, y: acc[i].y - gravityStart[i].y };
      v[i] = u[i];
    }
    for (s = 0; s < GRAVITY_SUBSTEPS; s++) {
      var g = s > 0 ? substepAccelerations(scene, poses, apart) : null;
      for (i = 0; i < n; i++) {
        if (bodies[i].isAnchored) continue;
        if (g) a[i] = { x: g[i].x + other[i].x, y: g[i].y + other[i].y };
        v[i] = advanceVelocity(v[i].x, v[i].y, h, a[i].x, a[i].y, maxSpeed, friction);
        poses[i].x += v[i].x * h;
        poses[i].y += v[i].y * h;
      }
    }
    for (i = 0; i < n; i++) {
      if (bodies[i].isAnchored) continue;
      vFull[i] = { x: (poses[i].x - bodies[i].x) / dt, y: (poses[i].y - bodies[i].y) / dt };
      acc[i] = legAcceleration(u[i], v[i], dt, friction);
    }
  }

  // The acceleration on port hole chain member m at (x, y) from outside its chain, the part that does
  // not turn with it: gravity, or every body outside `members` pulling from its step-start pose.
  function outsideAcceleration(scene, m, members, x, y, poses) {
    if (!scene.mutualGravity) return { x: 0, y: GRAVITY };
    var bodies = scene.bodies, ax = 0, ay = 0;
    for (var j = 0; j < bodies.length; j++) {
      if (members.indexOf(j) !== -1) continue;
      var p = mutualPull(scene, bodies[m], bodies[j], poses[j].x - x, poses[j].y - y);
      if (p) { ax += p.x; ay += p.y; }
    }
    return { x: ax, y: ay };
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

  // Union-find over every hinge and spring joining two bodies; links to the background are left out.
  function linkedRoot(scene) {
    var n = scene.bodies.length, parent = new Array(n), i;
    for (i = 0; i < n; i++) parent[i] = i;
    function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
    function union(a, b) { a = find(a); b = find(b); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); }
    sceneSprings(scene).forEach(function (s) { if (s.bodyA !== null) union(s.bodyA, s.bodyB); });
    scene.hinges.forEach(function (h) { if (h.bodyA !== null) union(h.bodyA, h.bodyB); });
    return find;
  }

  // ---- Springs and the frame's edges: a sprung set wraps together or not at all. GROUPS of
  // bodies joined by springs (directly or via hinges): `tethered` (a spring to the background, or
  // an anchored member) never wraps; else it wraps with its `leader`, the lowest free non-hinge-child.
  function springGroups(scene) {
    var springs = sceneSprings(scene);
    if (!springs.length) return null;
    var n = scene.bodies.length, find = linkedRoot(scene), i;
    var sprung = {};
    springs.forEach(function (s) {
      sprung[s.bodyB] = true;
      if (s.bodyA !== null) sprung[s.bodyA] = true;
    });
    var isHingeChild = {};
    scene.hinges.forEach(function (h) { if (h.bodyA !== null) isHingeChild[h.bodyB] = true; });
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

  // ---- Port hole chains: bodies joined by hinges or springs go through together, led by the lowest
  // free member that is no hinge child. A chain pinned or sprung to the background, or holding an
  // anchor or a port hole, never goes through. Every body gets a group; a lone body leads its own.
  function portholeGroups(scene) {
    var n = scene.bodies.length, find = linkedRoot(scene), i;
    var worldLinked = {}, isHingeChild = {};
    scene.hinges.forEach(function (h) { if (h.bodyA === null) worldLinked[h.bodyB] = true; else isHingeChild[h.bodyB] = true; });
    sceneSprings(scene).forEach(function (s) { if (s.bodyA === null) worldLinked[s.bodyB] = true; });
    var byRoot = {}, groupOf = new Array(n);
    for (i = 0; i < n; i++) {
      var root = find(i), g = byRoot[root];
      if (!g) g = byRoot[root] = { members: [], tethered: false, leader: -1 };
      g.members.push(i);
      if (scene.bodies[i].isAnchored || worldLinked[i] || scene.bodies[i].type === "porthole") g.tethered = true;
      else if (g.leader === -1 && !isHingeChild[i]) g.leader = i;
      groupOf[i] = g;
    }
    return groupOf;
  }

  // The two port holes' indices, or null: with one or none placed, a port hole is a line.
  function portholePair(bodies) {
    var found = [];
    for (var i = 0; i < bodies.length; i++) if (bodies[i].type === "porthole") found.push(i);
    return found.length === 2 ? found : null;
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

  function createPorthole(x, y, length, angle, color, isAnchored) {
    var b = { type: "porthole", color: color, x: x, y: y, angle: angle || 0, length: length, vx: 0, vy: 0, w: 0, isAnchored: !!isAnchored };
    computeMass(b);
    return b;
  }

  function getLineEndpoints(line) {
    var hx = Math.cos(line.angle) * line.length / 2;
    var hy = Math.sin(line.angle) * line.length / 2;
    return [{ x: line.x - hx, y: line.y - hy }, { x: line.x + hx, y: line.y + hy }];
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
    var endpoints = getLineEndpoints(body);
    var closest = closestPointOnSegment(endpoints[0], endpoints[1], { x: px, y: py });
    var ddx = px - closest.x, ddy = py - closest.y;
    return ddx * ddx + ddy * ddy <= r * r;
  }

  // ---- Collision detection. Normals point A -> B (first argument to second); lines are capsules,
  // a port hole is its oval (portholeOval). ----

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

  // ---- Port hole outline: two big arcs and two tip circles, tangent where they meet. a is a tip's
  // reach (half-length + half-thickness), b the half-thickness; the arcs' radius R follows.
  var PORTHOLE_TIP_RADIUS = 5;
  function portholeOval(length) {
    var b = LINE_THICKNESS / 2, r = PORTHOLE_TIP_RADIUS, a = length / 2 + b;
    var R = ((a - r) * (a - r) + b * b - r * r) / (2 * (b - r));
    return { a: a, b: b, r: r, R: R, cy: R - b, ax: a - r };
  }

  // Feature circles: 0 the back arc, 1 the front arc, 2 the left tip, 3 the right tip.
  function portholeFeatureCircle(o, kind) {
    if (kind === 0) return { kind: 0, cx: 0, cy: -o.cy, radius: o.R };
    if (kind === 1) return { kind: 1, cx: 0, cy: o.cy, radius: o.R };
    if (kind === 2) return { kind: 2, cx: -o.ax, cy: 0, radius: o.r };
    return { kind: 3, cx: o.ax, cy: 0, radius: o.r };
  }

  // The feature owning a local point (x along the port hole, y toward its back): a tip past the
  // junction rays, else the arc on the point's side. d is the signed distance to the outline.
  function portholeFeature(o, px, py) {
    var f;
    if (Math.abs(px) * o.cy > o.ax * (Math.abs(py) + o.cy)) f = portholeFeatureCircle(o, px < 0 ? 2 : 3);
    else f = portholeFeatureCircle(o, py < 0 ? 1 : 0);
    var dx = px - f.cx, dy = py - f.cy;
    f.dist = Math.sqrt(dx * dx + dy * dy);
    f.d = f.dist - f.radius;
    return f;
  }

  // The port hole's frame: x along it, y toward its back.
  function portholeFrame(ph) {
    var cs = Math.cos(ph.angle), sn = Math.sin(ph.angle);
    return {
      toLocal: function (wx, wy) { return { x: wx * cs + wy * sn, y: wy * cs - wx * sn }; },
      toWorld: function (lx, ly) { return { x: lx * cs - ly * sn, y: lx * sn + ly * cs }; },
    };
  }

  // Port hole = A (its oval, carried along at its velocity), circle = B. Swept in the port hole's
  // frame: the earliest sweep onto a feature circle whose hit point that feature owns.
  function collidePortholeCircle(ph, circle, dt) {
    var o = portholeOval(ph.length), fr = portholeFrame(ph);
    var p0 = fr.toLocal(circle.x - ph.x, circle.y - ph.y);
    var v = fr.toLocal(circle.vx - ph.vx, circle.vy - ph.vy);
    var tHit = 0;
    if (portholeFeature(o, p0.x, p0.y).d >= circle.radius) {
      var best = -1;
      for (var kind = 0; kind < 4; kind++) {
        var fc = portholeFeatureCircle(o, kind);
        var t = sweepPointSphere(p0.x, p0.y, v.x, v.y, fc.cx, fc.cy, fc.radius + circle.radius, dt);
        if (t < 0 || (best >= 0 && t >= best)) continue;
        if (portholeFeature(o, p0.x + v.x * t, p0.y + v.y * t).kind === kind) best = t;
      }
      if (best < 0) return null;
      tHit = best;
    }
    var px = p0.x + v.x * tHit, py = p0.y + v.y * tHit;
    var f = portholeFeature(o, px, py);
    var nx = f.dist > 1e-9 ? (px - f.cx) / f.dist : 0, ny = f.dist > 1e-9 ? (py - f.cy) / f.dist : 1;
    var n = fr.toWorld(nx, ny), s = fr.toWorld(f.cx + nx * f.radius, f.cy + ny * f.radius);
    return [{
      normal: { x: n.x, y: n.y },
      point: { x: ph.x + s.x + ph.vx * tHit, y: ph.y + s.y + ph.vy * tHit },
      rA: { x: s.x, y: s.y },
      rB: { x: -n.x * circle.radius, y: -n.y * circle.radius },
      penetration: Math.max(f.radius + circle.radius - f.dist, 0),
      tHit: tHit,
    }];
  }

  // Port hole = A (its oval), line = B (its capsule). The segment's nearest point to the oval is an
  // endpoint or the foot of a feature circle's center, when that feature owns the foot. One contact.
  function collidePortholeLine(ph, line) {
    var o = portholeOval(ph.length), fr = portholeFrame(ph);
    var ends = getLineEndpoints(line);
    var e0 = fr.toLocal(ends[0].x - ph.x, ends[0].y - ph.y), e1 = fr.toLocal(ends[1].x - ph.x, ends[1].y - ph.y);
    var bestQ = null, bestF = null;
    function consider(q, f) { if (!bestF || f.d < bestF.d) { bestQ = q; bestF = f; } }
    consider(e0, portholeFeature(o, e0.x, e0.y));
    consider(e1, portholeFeature(o, e1.x, e1.y));
    for (var kind = 0; kind < 4; kind++) {
      var fc = portholeFeatureCircle(o, kind);
      var q = closestPointOnSegment(e0, e1, { x: fc.cx, y: fc.cy });
      var f = portholeFeature(o, q.x, q.y);
      if (f.kind === kind) consider(q, f);
    }
    var half = LINE_THICKNESS / 2;
    if (bestF.d >= half) return null;
    var nx = bestF.dist > 1e-9 ? (bestQ.x - bestF.cx) / bestF.dist : 0, ny = bestF.dist > 1e-9 ? (bestQ.y - bestF.cy) / bestF.dist : 1;
    // Midway between the two surfaces, as collideLineLine puts it.
    var m = fr.toWorld((bestF.cx + nx * bestF.radius + bestQ.x - nx * half) / 2, (bestF.cy + ny * bestF.radius + bestQ.y - ny * half) / 2);
    var n = fr.toWorld(nx, ny);
    var px = ph.x + m.x, py = ph.y + m.y;
    return [{
      normal: { x: n.x, y: n.y },
      point: { x: px, y: py },
      rA: { x: m.x, y: m.y },
      rB: { x: px - line.x, y: py - line.y },
      penetration: half - bestF.d,
      tHit: 0,
    }];
  }

  // Computed as (B, A): flip the normal and swap rA/rB back to the caller's order.
  function flipContacts(cs) {
    if (cs) for (var i = 0; i < cs.length; i++) {
      cs[i].normal.x *= -1; cs[i].normal.y *= -1;
      var tmp = cs[i].rA; cs[i].rA = cs[i].rB; cs[i].rB = tmp;
    }
    return cs;
  }

  // A and B are PROBE bodies (velocity advanced by this step's gravity: see step()); tHit in [0, dt].
  // A port hole meets a circle or a line as its oval; two port holes meet as capsules.
  function collidePair(A, B, dt) {
    var aRound = A.type === "circle", bRound = B.type === "circle";
    var aPort = A.type === "porthole", bPort = B.type === "porthole";
    if (aRound && bRound) return collideCircleCircle(A, B, dt);
    if (aPort && bRound) return collidePortholeCircle(A, B, dt);
    if (bPort && aRound) return flipContacts(collidePortholeCircle(B, A, dt));
    if (!aRound && bRound) return collideLineCircle(A, B, dt);
    if (aRound) return flipContacts(collideLineCircle(B, A, dt));
    if (aPort && !bPort) return collidePortholeLine(A, B);
    if (bPort && !aPort) return flipContacts(collidePortholeLine(B, A));
    return collideLineLine(A, B);
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

  // ---- Hinge impulses for the start pose (RATTLE's position half) ----
  // One impulse per hinge at the step's start, along the start-pose arms, sized so the two anchors meet
  // after the whole-step move x += (vFull + dv) dt, angle += (spin + dw) dt. The gap is nonlinear in the
  // impulse (the arms turn), so Newton on every hinge at once: a dense 2H x 2H system, eliminated without
  // pivoting in the order the GLSL unrolls. Must agree with generateStepOnceGLSL's shake block.
  function hingeShakeIterations(hingeCount) { return hingeCount === 1 ? 2 : 3; }
  // Past a radian per step the predicted arms are meaningless and the Jacobian can lose its sign.
  var HINGE_SHAKE_SPIN_LIMIT = 1;
  function rotateBy(v, sn, cs) { return { x: v.x * cs - v.y * sn, y: v.x * sn + v.y * cs }; }
  // Returns {x, y, w} per body a shaken hinge moves (null elsewhere), with dv already in vFull; null when the
  // scene has nothing to shake or a hinged body turns too fast this step (the projection then closes the joints).
  function shakeHinges(scene, bodies, vFull, alpha, swing, dt) {
    var hinges = [], i, h, k, it;
    for (h = 0; h < scene.hinges.length; h++) {
      var hg = scene.hinges[h];
      var aFixed = hg.bodyA === null || bodies[hg.bodyA].isAnchored, bFixed = bodies[hg.bodyB].isAnchored;
      if (!aFixed || !bFixed) hinges.push(hg);
    }
    if (!hinges.length) return null;
    var n = bodies.length, dv = new Array(n), w0 = new Array(n), s0 = new Array(n), c0 = new Array(n);
    function touch(idx) {
      if (idx === null || bodies[idx].isAnchored || dv[idx]) return;
      dv[idx] = { x: 0, y: 0, w: 0 };
      w0[idx] = springSpin(bodies[idx].w, alpha[idx], swing[idx], dt);
      s0[idx] = Math.sin(bodies[idx].angle); c0[idx] = Math.cos(bodies[idx].angle);
    }
    for (h = 0; h < hinges.length; h++) { touch(hinges[h].bodyA); touch(hinges[h].bodyB); }
    for (i = 0; i < n; i++) if (dv[i] && Math.abs(w0[i]) * dt > HINGE_SHAKE_SPIN_LIMIT) return null;
    // Each hinge's two sides: a fixed point, or a free body with its sign and start-pose arm.
    var sides = hinges.map(function (hinge) {
      function side(idx, local, sign) {
        if (idx === null) return { fixed: local };
        var b = bodies[idx];
        if (b.isAnchored) { var r = rotateVec(local, b.angle); return { fixed: { x: b.x + r.x, y: b.y + r.y } }; }
        return { body: idx, sign: sign, local: local, r0: rotateBy(local, s0[idx], c0[idx]) };
      }
      return [side(hinge.bodyA, hinge.localAnchorA, -1), side(hinge.bodyB, hinge.localAnchorB, 1)];
    });
    var H = hinges.length, N = 2 * H, iters = hingeShakeIterations(H);
    var xE = new Array(n), yE = new Array(n), sE = new Array(n), cE = new Array(n), rE = new Array(H), g = new Array(H);
    var J = new Array(N * N), rhs = new Array(N);
    for (it = 0; it < iters; it++) {
      for (i = 0; i < n; i++) {
        if (!dv[i]) continue;
        var aE = bodies[i].angle + (w0[i] + dv[i].w) * dt;
        sE[i] = Math.sin(aE); cE[i] = Math.cos(aE);
        xE[i] = bodies[i].x + (vFull[i].x + dv[i].x) * dt;
        yE[i] = bodies[i].y + (vFull[i].y + dv[i].y) * dt;
      }
      for (h = 0; h < H; h++) {
        var ends = [], arms = [];
        for (k = 0; k < 2; k++) {
          var sd = sides[h][k];
          if (sd.fixed) { ends.push(sd.fixed); arms.push(null); continue; }
          var r = rotateBy(sd.local, sE[sd.body], cE[sd.body]);
          arms.push(r);
          ends.push({ x: xE[sd.body] + r.x, y: yE[sd.body] + r.y });
        }
        rE[h] = arms;
        g[h] = { x: ends[1].x - ends[0].x, y: ends[1].y - ends[0].y };
      }
      for (i = 0; i < N * N; i++) J[i] = 0;
      for (h = 0; h < H; h++) {
        rhs[2 * h] = -g[h].x / dt; rhs[2 * h + 1] = -g[h].y / dt;
        for (k = 0; k < H; k++) {
          for (var ph = 0; ph < 2; ph++) {
            var sh = sides[h][ph];
            if (sh.fixed) continue;
            for (var pk = 0; pk < 2; pk++) {
              var sk = sides[k][pk];
              if (sk.fixed || sk.body !== sh.body) continue;
              var b = bodies[sh.body], sg = sh.sign * sk.sign, rn = rE[h][ph], r0 = sk.r0;
              J[(2 * h) * N + 2 * k] += sg * (b.invMass + b.invInertia * rn.y * r0.y);
              J[(2 * h) * N + 2 * k + 1] += sg * (-b.invInertia * rn.y * r0.x);
              J[(2 * h + 1) * N + 2 * k] += sg * (-b.invInertia * rn.x * r0.y);
              J[(2 * h + 1) * N + 2 * k + 1] += sg * (b.invMass + b.invInertia * rn.x * r0.x);
            }
          }
        }
      }
      for (i = 0; i < N; i++) {
        for (var j = i + 1; j < N; j++) {
          var f = J[j * N + i] / J[i * N + i];
          for (k = i + 1; k < N; k++) J[j * N + k] -= f * J[i * N + k];
          rhs[j] -= f * rhs[i];
        }
      }
      for (i = N - 1; i >= 0; i--) {
        var sum = rhs[i];
        for (j = i + 1; j < N; j++) sum -= J[i * N + j] * rhs[j];
        rhs[i] = sum / J[i * N + i];
      }
      for (h = 0; h < H; h++) {
        var Px = rhs[2 * h], Py = rhs[2 * h + 1];
        for (k = 0; k < 2; k++) {
          var sp = sides[h][k];
          if (sp.fixed) continue;
          var bb = bodies[sp.body], d = dv[sp.body];
          d.x += sp.sign * Px * bb.invMass; d.y += sp.sign * Py * bb.invMass;
          d.w += sp.sign * bb.invInertia * (sp.r0.x * Py - sp.r0.y * Px);
        }
      }
    }
    for (i = 0; i < n; i++) if (dv[i]) vFull[i] = { x: vFull[i].x + dv[i].x, y: vFull[i].y + dv[i].y };
    return dv;
  }

  // A pair the GPU would sweep: not both anchored, not hinge-joined. Decides the velocity pass count.
  function hasCollidablePairs(scene) {
    if (!collisionsEnabled(scene)) return false;
    var bodies = scene.bodies;
    for (var i = 0; i < bodies.length; i++) {
      for (var j = i + 1; j < bodies.length; j++) {
        if (bodies[i].isAnchored && bodies[j].isAnchored) continue;
        if (!hingeConnects(scene.hinges, i, j)) return true;
      }
    }
    return false;
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
    if (output.property === "totalRotation" && isPairOutput(output)) {
      return "Cumulative Rotation reads one body, but a second is set";
    }
    if (output.property === "warps" && isPairOutput(output)) {
      return "Port Hole Warp Count reads one body, but a second is set";
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
    var bodies = scene.bodies;
    if (output.property === "distance") {
      if (indices.length < 2) return 0;
      var a = bodies[indices[0]], b = bodies[indices[1]];
      var d = shortestSeparation(scene, b.x - a.x, b.y - a.y);
      return Math.sqrt(d.x * d.x + d.y * d.y);
    }
    // Run tallies start from nothing.
    if (output.property === "bounces" || output.property === "warps" || output.property === "totalRotation") return 0;
    var sum = 0;
    for (var i = 0; i < indices.length; i++) sum += bodies[indices[i]][output.property];
    return sum / indices.length;
  }

  // A chain leader whose center was in front of a port hole's center line at the step's start and
  // behind it at the end, crossing within its reach, leaves through the other one. The crossing point
  // scales with the length ratio; the rest of the step's travel past it is kept as is, and velocities
  // turn with the port holes, so the exit continues the entry. The share of the step past the crossing
  // is then re-integrated on the exit side (outside forces from there, the chain's own turned with it),
  // or the exit's gravity would start up to a step late, by an amount that saws with the start.
  // A port hole as it stood part-way through the step: pose, velocity and spin interpolated
  // between the step's start and end. An anchored one does not move.
  function portholeStateAt(P, start, u, lambda) {
    if (P.isAnchored) return { x: P.x, y: P.y, angle: P.angle, vx: 0, vy: 0, w: 0 };
    return {
      x: start.x + (P.x - start.x) * lambda, y: start.y + (P.y - start.y) * lambda, angle: start.angle + (P.angle - start.angle) * lambda,
      vx: u.x + (P.vx - u.x) * lambda, vy: u.y + (P.vy - u.y) * lambda, w: start.w + (P.w - start.w) * lambda,
    };
  }
  // Its velocity at a point, from its own motion about its center.
  function frameVelocityAt(S, x, y) {
    return { x: S.vx - S.w * (y - S.y), y: S.vy + S.w * (x - S.x) };
  }

  function applyPortholeTransports(scene, portals, groupOf, startPose, u, acc, dt, maxSpeed, friction, warpFlags) {
    var bodies = scene.bodies;
    for (var i = 0; i < bodies.length; i++) {
      var g = groupOf[i];
      if (g.leader !== i || g.tethered) continue;
      for (var k = 0; k < 2; k++) {
        var P = bodies[portals[k]], Q = bodies[portals[1 - k]], O = bodies[i];
        var startP = startPose[portals[k]], startO = startPose[i];
        var a0 = portholeAxes(startP.angle), a1 = portholeAxes(P.angle);
        var dx0 = startO.x - startP.x, dy0 = startO.y - startP.y, dx1 = O.x - P.x, dy1 = O.y - P.y;
        var f0 = dx0 * a0.nx + dy0 * a0.ny, f1 = dx1 * a1.nx + dy1 * a1.ny;
        if (!(f0 >= 0 && f1 < 0)) continue;
        var lambda = f0 / (f0 - f1);
        var s0 = dx0 * a0.tx + dy0 * a0.ty, s1 = dx1 * a1.tx + dy1 * a1.ty;
        var sCross = s0 + (s1 - s0) * lambda;
        // Anywhere the body could have touched the front: the capsule's reach plus the body's own.
        if (Math.abs(sCross) > P.length / 2 + LINE_THICKNESS / 2 + halfExtent(O)) continue;
        var tStar = lambda * dt, tau = dt - tStar;
        // Both port holes as they stood at the crossing instant.
        var Ps = portholeStateAt(P, startP, u[portals[k]], lambda), Qs = portholeStateAt(Q, startPose[portals[1 - k]], u[portals[1 - k]], lambda);
        var ap = portholeAxes(Ps.angle), aq = portholeAxes(Qs.angle);
        // The crossing point on the exit side, and the turn taking P's inward normal onto Q's outward one.
        var crossX = Qs.x - sCross * Q.length / P.length * aq.tx, crossY = Qs.y - sCross * Q.length / P.length * aq.ty;
        var cs = -(aq.tx * ap.tx + aq.ty * ap.ty), sn = -(ap.tx * aq.ty - ap.ty * aq.tx);
        var phi = Qs.angle - Ps.angle + Math.PI;
        var leadStarX = startO.x + (O.x - startO.x) * lambda, leadStarY = startO.y + (O.y - startO.y) * lambda;
        g.members.forEach(function (m) {
          var b = bodies[m], s = startPose[m], a = acc[m];
          // Where this member was at the crossing instant, and where that lands on the exit side.
          var starX = s.x + (b.x - s.x) * lambda, starY = s.y + (b.y - s.y) * lambda;
          var rx = starX - leadStarX, ry = starY - leadStarY;
          var exitStarX = crossX + rx * cs - ry * sn, exitStarY = crossY + rx * sn + ry * cs;
          var extIn = outsideAcceleration(scene, m, g.members, s.x, s.y, startPose);
          var extOut = outsideAcceleration(scene, m, g.members, exitStarX, exitStarY, startPose);
          var inX = a.x - extIn.x, inY = a.y - extIn.y;
          var outX = inX * cs - inY * sn + extOut.x, outY = inX * sn + inY * cs + extOut.y;
          // Velocity and spin are kept relative to the port holes' own motion at the member's spot.
          var fin = frameVelocityAt(Ps, starX, starY), fout = frameVelocityAt(Qs, exitStarX, exitStarY);
          // Two legs split at the crossing, turned there or not: their difference is what the step's
          // whole-step velocity got wrong.
          var pre = advanceVelocity(u[m].x, u[m].y, tStar, a.x, a.y, maxSpeed, friction);
          var preX = pre.x - fin.x, preY = pre.y - fin.y;
          var turned = advanceVelocity(preX * cs - preY * sn + fout.x, preX * sn + preY * cs + fout.y, tau, outX, outY, maxSpeed, friction);
          var straight = advanceVelocity(pre.x, pre.y, tau, a.x, a.y, maxSpeed, friction);
          var strX = straight.x - fin.x, strY = straight.y - fin.y;
          var dvx = turned.x - (strX * cs - strY * sn + fout.x), dvy = turned.y - (strX * sn + strY * cs + fout.y);
          var ox = b.x - leadStarX, oy = b.y - leadStarY, vx = b.vx - fin.x, vy = b.vy - fin.y;
          b.vx = vx * cs - vy * sn + fout.x + dvx;
          b.vy = vx * sn + vy * cs + fout.y + dvy;
          // The step's travel past the crossing, solver shoves included, carried into the exit's frame.
          b.x = crossX + ox * cs - oy * sn + (fout.x - (fin.x * cs - fin.y * sn) + dvx) * tau;
          b.y = crossY + ox * sn + oy * cs + (fout.y - (fin.x * sn + fin.y * cs) + dvy) * tau;
          var spin = Qs.w - Ps.w;
          b.w += spin;
          b.angle += phi + spin * tau;
          if (warpFlags) warpFlags[m] = true;
        });
        break;
      }
    }
  }

  function step(scene, dt, opts) {
    opts = opts || {};
    // One 2x2 solve is exact for a lone hinge, so a scene with nothing else to solve takes one pass.
    var velIter = opts.velocityIterations || (scene.hinges.length === 1 && !hasCollidablePairs(scene) ? 1 : VELOCITY_ITERATIONS);
    var posIter = opts.positionIterations || POSITION_ITERATIONS;
    var bodies = scene.bodies;
    var i, j;

    // Fixed for the whole step; both legs and the detection sweep must agree on them.
    var maxSpeed = speedCapFor(scene), friction = frictionRate(scene);
    var acc = computeAccelerations(scene);
    var substeps = gravitySubstepsFor(scene);
    var gravityStart = substeps > 1 ? acc.map(function (a) { return { x: a.x, y: a.y }; }) : null;
    // Springs add angular acceleration (alpha) and the swing tally; all zeros without springs.
    var alpha = new Array(bodies.length).fill(0), swing = new Array(bodies.length).fill(0);
    if (sceneSprings(scene).length) addSpringAccelerations(scene, acc, alpha, swing, dt);

    // u: entering velocity. vFull: whole-step velocity, used for BOTH detection and leg 1.
    var u = new Array(bodies.length), vFull = new Array(bodies.length);
    for (i = 0; i < bodies.length; i++) {
      if (bodies[i].isAnchored) continue;
      u[i] = { x: bodies[i].vx, y: bodies[i].vy };
      vFull[i] = advanceVelocity(u[i].x, u[i].y, dt, acc[i].x, acc[i].y, maxSpeed, friction);
    }
    if (gravityStart) substepGravity(scene, gravityStart, acc, u, vFull, dt, maxSpeed, friction);
    var shake = scene.hinges.length ? shakeHinges(scene, bodies, vFull, alpha, swing, dt) : null;

    var probes = new Array(bodies.length);
    for (i = 0; i < bodies.length; i++) {
      probes[i] = bodies[i].isAnchored ? bodies[i] : Object.assign({}, bodies[i], { vx: vFull[i].x, vy: vFull[i].y });
    }

    // Port holes: with both placed, a chain leader's center may pass the front of one and leave
    // through the other at the end of the step; its contacts on that front are dropped.
    var portals = portholePair(bodies);
    var passGroup = portals ? portholeGroups(scene) : null;
    var startPose = portals ? bodies.map(function (b) { return { x: b.x, y: b.y, angle: b.angle, w: b.w }; }) : null;
    function onPortholeFront(c) {
      var pi = bodies[c.a].type === "porthole" ? c.a : (bodies[c.b].type === "porthole" ? c.b : -1);
      if (pi === -1) return false;
      var oi = pi === c.a ? c.b : c.a;
      if (passGroup[oi].leader !== oi || passGroup[oi].tethered) return false;
      var r = pi === c.a ? c.rA : c.rB, axes = portholeAxes(startPose[pi].angle);
      return r.x * axes.nx + r.y * axes.ny > 0;
    }

    // Contacts. Empty with collisions off; every consumer handles "no contacts".
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
    if (portals && contacts.length) contacts = contacts.filter(function (c) { return !onPortholeFront(c); });

    // Earliest contact instant per body; dt when none (leg 1 is the whole step, leg 2 a no-op).
    var bodyTHit = new Array(bodies.length).fill(dt);
    for (i = 0; i < contacts.length; i++) {
      var c = contacts[i];
      if (c.tHit < bodyTHit[c.a]) bodyTHit[c.a] = c.tHit;
      if (c.tHit < bodyTHit[c.b]) bodyTHit[c.b] = c.tHit;
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
    // Opt-in per-body edge wrap this step: 1 along x, 2 along y (the trajectory's wrapX/wrapY).
    var wrapFlags = opts.wrapFlags;
    if (wrapFlags) for (i = 0; i < bodies.length; i++) wrapFlags[i] = 0;
    // Opt-in per-body "went through a port hole this step" (the trajectory's warped).
    var warpFlags = opts.warpFlags;
    if (warpFlags) for (i = 0; i < bodies.length; i++) warpFlags[i] = false;
    // Opt-in raw pair list for runTrajectory's per-pair contacts. Refilled in place.
    var contactsOut = opts.contactsOut;
    if (contactsOut) {
      contactsOut.length = 0;
      for (i = 0; i < contacts.length; i++) contactsOut.push({ a: contacts[i].a, b: contacts[i].b });
    }

    // Leg 1: move at vFull for tHit (matching detection). A hit body's kick runs to tHit plus half a (sub)step
    // and leg 2 takes the rest: the stored velocity trails the position by that much.
    var bodyTKick = new Array(bodies.length);
    for (i = 0; i < bodies.length; i++) {
      var b1 = bodies[i];
      if (b1.isAnchored) continue;
      var th = bodyTHit[i];
      bodyTKick[i] = th < dt ? th + dt / (2 * substeps) : dt;
      b1.x += vFull[i].x * th; b1.y += vFull[i].y * th;
      // Angular twin: turn at the whole step's spin, keep only the torque acted by tHit. A hinge impulse
      // (already in vFull) joins the spin and the velocity here.
      var sh = shake && shake[i], dw = sh ? sh.w : 0;
      b1.angle += (springSpin(b1.w, alpha[i], swing[i], dt) + dw) * th;
      b1.w = springSpin(b1.w, alpha[i], swing[i], th) + dw;
      var vPre = advanceVelocity(u[i].x, u[i].y, bodyTKick[i], acc[i].x, acc[i].y, maxSpeed, friction);
      b1.vx = vPre.x + (sh ? sh.x : 0); b1.vy = vPre.y + (sh ? sh.y : 0);
    }

    var iter;
    for (iter = 0; iter < velIter; iter++) {
      for (i = 0; i < scene.hinges.length; i++) solveHingeVelocity(scene.hinges[i], bodies);
      for (i = 0; i < contacts.length; i++) {
        solveContactVelocity(contacts[i], bodies[contacts[i].a], bodies[contacts[i].b]);
      }
    }

    // Leg 2: the rest of the step, and of the kick, on the POST-impulse velocity; identity if no contact.
    for (i = 0; i < bodies.length; i++) {
      var b2 = bodies[i];
      if (b2.isAnchored) continue;
      var tRest = dt - bodyTHit[i];
      var vPost = advanceVelocity(b2.vx, b2.vy, dt - bodyTKick[i], acc[i].x, acc[i].y, maxSpeed, friction);
      b2.vx = vPost.x; b2.vy = vPost.y;
      b2.w = springSpin(b2.w, alpha[i], swing[i], tRest);
      b2.x += vPost.x * tRest; b2.y += vPost.y * tRest; b2.angle += b2.w * tRest;
    }

    // The shake lands the joints closed; the projection is for steps a contact or the spin guard spoiled.
    var projectHinges = scene.hinges.length && (contacts.length > 0 || !shake);
    for (iter = 0; iter < posIter; iter++) {
      if (projectHinges) for (i = 0; i < scene.hinges.length; i++) solveHingePosition(scene.hinges[i], bodies);
      for (i = 0; i < contacts.length; i++) {
        solveContactPosition(contacts[i], bodies[contacts[i].a], bodies[contacts[i].b]);
      }
    }

    if (portals) applyPortholeTransports(scene, portals, passGroup, startPose, u, acc, dt, maxSpeed, friction, warpFlags);

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
        if (wrapFlags) wrapFlags[i] = (dx !== 0 ? 1 : 0) | (dy !== 0 ? 2 : 0);
        if (dx === 0 && dy === 0) continue;
        if (group) {
          translateSpringGroup(scene, group, dx, dy);
          continue;
        }
        if (worldHinge) worldHinge.localAnchorA = { x: worldHinge.localAnchorA.x + dx, y: worldHinge.localAnchorA.y + dy };
        wrapTranslateAndCascade(scene, i, dx, dy, {});
      }
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
      friction: frictionOf(scene),
      simulationSteps: scene.simulationSteps,
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

  // runTrajectory: rows[i] is every body's {x, y, angle, wrapX, wrapY, warped, contacts} after i+1 steps, like
  // PhysicsGPU.runSceneOnGPU's: the wrap flags say the body crossed that frame edge in that step, warped that
  // it went through a port hole, and contacts has bit j set when it touched body j in that step. Uses a private clone.
  function runTrajectory(scene, steps, dt) {
    var sim = cloneScene(scene);
    // A scene straight from JSON has no invMass/invInertia; stepping without them yields NaN.
    sim.bodies.forEach(computeMass);
    var rows = new Array(steps), flags = new Array(sim.bodies.length), warps = new Array(sim.bodies.length), contactsBuf = [];
    for (var i = 0; i < steps; i++) {
      step(sim, dt, { wrapFlags: flags, warpFlags: warps, contactsOut: contactsBuf });
      var row = sim.bodies.map(function (body, b) {
        return { x: body.x, y: body.y, angle: body.angle, wrapX: !!(flags[b] & 1), wrapY: !!(flags[b] & 2), warped: warps[b], contacts: 0 };
      });
      for (var k = 0; k < contactsBuf.length; k++) {
        row[contactsBuf[k].a].contacts |= 1 << contactsBuf[k].b;
        row[contactsBuf[k].b].contacts |= 1 << contactsBuf[k].a;
      }
      rows[i] = row;
    }
    return rows;
  }

  // counts[i] is the body's bounces by the end of step i+1 of a run's rows (runTrajectory's or the
  // GPU's); a bounce is the false->true edge of touching anything, not every step spent touching.
  function bounceCountsFromTrajectory(rows, bodyIndex) {
    var counts = new Array(rows.length);
    var count = 0, wasTouching = false;
    for (var i = 0; i < rows.length; i++) {
      var touching = rows[i][bodyIndex].contacts !== 0;
      if (touching && !wasTouching) count++;
      wasTouching = touching;
      counts[i] = count;
    }
    return counts;
  }

  function runBounceCounts(scene, bodyIndex, steps, dt) {
    return bounceCountsFromTrajectory(runTrajectory(scene, steps, dt), bodyIndex);
  }

  // counts[i] is how many times the body has gone through a port hole by the end of step i+1.
  function warpCountsFromTrajectory(rows, bodyIndex) {
    var counts = new Array(rows.length), count = 0;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i][bodyIndex].warped) count++;
      counts[i] = count;
    }
    return counts;
  }

  // Steps (0-indexed) in which some body went through a port hole: the warp sound's triggers.
  function warpEventsFromTrajectory(rows) {
    var events = [];
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].some(function (r) { return r.warped; })) events.push(i);
    }
    return events;
  }

  function wrapToPi(a) { return a - 2 * Math.PI * Math.floor(a / (2 * Math.PI) + 0.5); }

  // turns[i] is the body's rotation in radians from `scene` to the end of step i+1, less each warp's own
  // turn, which the rows give only at the step's end: the way through that leaves the smaller turn.
  function rotationsFromTrajectory(scene, rows, bodyIndex) {
    var portals = portholePair(scene.bodies);
    var turns = new Array(rows.length), total = 0, prev = scene.bodies[bodyIndex].angle;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i][bodyIndex], turn = r.angle - prev;
      if (r.warped && portals) {
        var p = rows[i][portals[0]].angle, q = rows[i][portals[1]].angle;
        var a = wrapToPi(turn - (q - p + Math.PI)), b = wrapToPi(turn - (p - q + Math.PI));
        turn = Math.abs(a) <= Math.abs(b) ? a : b;
      }
      total += turn;
      prev = r.angle;
      turns[i] = total;
    }
    return turns;
  }

  // Pairs overlapping geometrically (halfExtent sum), solver running or not; keys "i,j", i < j.
  // Shapes from scene.bodies, positions from `at` (scene.bodies or a trajectory row).
  function overlappingPairs(scene, at) {
    var bodies = scene.bodies, n = bodies.length, pairs = [];
    for (var i = 0; i < n; i++) {
      for (var j = i + 1; j < n; j++) {
        var a = bodies[i], b = bodies[j];
        if (a.isAnchored && b.isAnchored) continue;
        if (hingeConnects(scene.hinges, i, j)) continue;
        var dx = at[j].x - at[i].x, dy = at[j].y - at[i].y;
        var contact = halfExtent(a) + halfExtent(b);
        if (dx * dx + dy * dy <= contact * contact) pairs.push(i + "," + j);
      }
    }
    return pairs;
  }

  // Hinged pairs of two free lines (a double pendulum); the alignment event below is theirs.
  function hingedLinePairs(scene) {
    var pairs = [];
    for (var h = 0; h < scene.hinges.length; h++) {
      var hinge = scene.hinges[h];
      var a = scene.bodies[hinge.bodyA], b = scene.bodies[hinge.bodyB];
      if (!a || !b) continue; // hinge.bodyA can be null (pinned to a world point, not a body)
      if (a.type !== "line" || b.type !== "line") continue;
      if (a.isAnchored || b.isAnchored) continue;
      pairs.push({ hinge: hinge, i: hinge.bodyA, j: hinge.bodyB });
    }
    return pairs;
  }

  // `sign`: which side of ray 1 (hinge -> center A) ray 2 falls on; `dot` > 0: centers on one side.
  // A sign flip between steps is the event. `at`: positions and angles, as in overlappingPairs.
  function lineHingeCrossState(at, pair) {
    var hingePoint = getHingeWorldPoint(pair.hinge, at);
    var a = at[pair.i], b = at[pair.j];
    var v1x = a.x - hingePoint.x, v1y = a.y - hingePoint.y;
    var v2x = b.x - hingePoint.x, v2y = b.y - hingePoint.y;
    var cross = v1x * v2y - v1y * v2x;
    var dot = v1x * v2x + v1y * v2y;
    return { sign: cross > 0 ? 1 : (cross < 0 ? -1 : 0), dot: dot };
  }

  function hasBounceSounds(scene) {
    return !!scene.mutualGravity || collisionsEnabled(scene) || hingedLinePairs(scene).length > 0;
  }

  // Steps at which some pair STARTS touching: the bounce sound's event source, read off a run's rows
  // (runTrajectory's or the GPU's) that start from `scene`. Per-PAIR state ("a,b", a < b). Mutual
  // Gravity usually runs with collisions off, so there overlap is geometric (overlappingPairs);
  // otherwise the rows' contacts. Hinged-line alignment also fires. One event a step.
  function bounceEventsFromTrajectory(scene, rows) {
    if (!hasBounceSounds(scene)) return [];
    var geometric = !!scene.mutualGravity;
    var linePairs = hingedLinePairs(scene);
    var wasTouchingPairs = {};
    // Seed with pairs already overlapping, so pre-placed contact isn't a fresh bounce on step 0.
    var initialPairs = overlappingPairs(scene, scene.bodies);
    for (var q = 0; q < initialPairs.length; q++) wasTouchingPairs[initialPairs[q]] = true;
    var prevCrossSign = linePairs.map(function (lp) { return lineHingeCrossState(scene.bodies, lp).sign; });
    var events = [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var nowTouchingPairs = {};
      var newEvent = false;
      if (geometric) {
        var pairs = overlappingPairs(scene, row);
        for (var p = 0; p < pairs.length; p++) {
          nowTouchingPairs[pairs[p]] = true;
          if (!wasTouchingPairs[pairs[p]]) newEvent = true;
        }
      } else {
        for (var a = 0; a < row.length; a++) {
          for (var b = a + 1; b < row.length; b++) {
            if (!(row[a].contacts & (1 << b))) continue;
            var key = a + "," + b;
            nowTouchingPairs[key] = true;
            if (!wasTouchingPairs[key]) newEvent = true;
          }
        }
      }
      for (var lp2 = 0; lp2 < linePairs.length; lp2++) {
        var state = lineHingeCrossState(row, linePairs[lp2]);
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

  function runBounceEvents(scene, steps, dt) {
    return hasBounceSounds(scene) ? bounceEventsFromTrajectory(scene, runTrajectory(scene, steps, dt)) : [];
  }

  global.PhysicsEngine = {
    DENSITY: DENSITY,
    LINE_LINEAR_DENSITY: LINE_LINEAR_DENSITY,
    // Exported so physics-gpu.js's GLSL bakes the same numbers.
    GRAVITY: GRAVITY,
    FRICTION_MAX: FRICTION_MAX,
    frictionOf: frictionOf,
    frictionRate: frictionRate,
    advanceVelocity: advanceVelocity,
    ANCHORED_GRAVITY_DENSITY: ANCHORED_GRAVITY_DENSITY,
    MUTUAL_GRAVITY_CONSTANT: MUTUAL_GRAVITY_CONSTANT,
    gravitationalMass: gravitationalMass,
    halfExtent: halfExtent,
    computeAccelerations: computeAccelerations,
    GRAVITY_SUBSTEPS: GRAVITY_SUBSTEPS,
    setGravitySubsteps: setGravitySubsteps,
    gravitySubstepsFor: gravitySubstepsFor,
    runBounceCounts: runBounceCounts,
    runBounceEvents: runBounceEvents,
    bounceCountsFromTrajectory: bounceCountsFromTrajectory,
    warpCountsFromTrajectory: warpCountsFromTrajectory,
    warpEventsFromTrajectory: warpEventsFromTrajectory,
    rotationsFromTrajectory: rotationsFromTrajectory,
    bounceEventsFromTrajectory: bounceEventsFromTrajectory,
    runTrajectory: runTrajectory,
    createCircle: createCircle,
    createLine: createLine,
    createPorthole: createPorthole,
    PORTHOLE_COLORS: PORTHOLE_COLORS,
    PORTHOLE_TIP_RADIUS: PORTHOLE_TIP_RADIUS,
    portholeOval: portholeOval,
    portholeFeature: portholeFeature,
    collidePair: collidePair,
    portholeAxes: portholeAxes,
    portholeGroups: portholeGroups,
    portholePair: portholePair,
    computeOutputValue: computeOutputValue,
    outputBodyIndices: outputBodyIndices,
    isPairOutput: isPairOutput,
    outputMappingError: outputMappingError,
    shortestSeparation: shortestSeparation,
    outputDistanceMax: outputDistanceMax,
    getLineEndpoints: getLineEndpoints,
    computeMass: computeMass,
    pointInBody: pointInBody,
    step: step,
    deleteBody: deleteBody,
    cloneScene: cloneScene,
    rotateVec: rotateVec,
    worldToLocal: worldToLocal,
    getHingeWorldPoint: getHingeWorldPoint,
    hingeConnects: hingeConnects,
    hasCollidablePairs: hasCollidablePairs,
    hingeShakeIterations: hingeShakeIterations,
    HINGE_SHAKE_SPIN_LIMIT: HINGE_SHAKE_SPIN_LIMIT,
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
