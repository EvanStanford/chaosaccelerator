// This file is part of Chaos Accelerator, licensed under the Common Public
// Attribution License, Version 1.0 (CPAL-1.0) - see LICENSE in the project
// root, or https://chaosaccelerator.com/license for a hosted copy.

// Compiles the current scene (<=6 bodies) into a specialized GLSL program and
// runs it on the GPU via an offscreen WebGL2 context, logging every body's
// (x, y, angle) at every physics step into a small texture, then reads that
// back as a plain trajectory array. No physics runs in JS for playback -
// physics-ui.js just looks up trajectory[step][bodyIndex] and draws it.
//
// This is a *specialized* simulator, not a general one: because the scene
// (body count, types, hinge topology) is fixed at the moment Play is
// clicked, everything that would need a dynamic loop or array in a general
// engine - which pairs to collision-check, which hinges connect what - is
// fully unrolled into flat generated code instead. GLSL never needs to loop
// over "however many bodies happen to exist."
//
// The physics math below (collision, impulse solver, hinge solver) is a
// direct, function-for-function port of physics-engine.js - same formulas,
// same variable names where possible - specifically so it can be checked
// against the already-validated JS engine.
(function (global) {
  "use strict";

  var MAX_BODIES = 6;
  // GLSL ES 3.00's hard ceiling on a function's parameter list. Only
  // stepOnce() ever approaches it - see stepOnceParams.
  var MAX_GLSL_FUNCTION_PARAMS = 256;

  var LINE_THICKNESS = 20;
  var LINE_PARALLEL_EPS = 0.05;
  var RESTITUTION_THRESHOLD = 30;
  var VELOCITY_ITERATIONS = 8;
  var POSITION_ITERATIONS = 4;
  var POSITION_SLOP = 0.01;
  var POSITION_PERCENT = 0.2;
  var FIXED_DT = 1 / 60;

  function fnum(n) {
    if (!isFinite(n)) n = 0;
    if (Object.is(n, -0)) n = 0;
    var s = String(n);
    if (s.indexOf(".") === -1 && s.indexOf("e") === -1 && s.indexOf("E") === -1) s += ".0";
    return s;
  }

  // ---- The reusable GLSL physics library: a direct port of physics-engine.js ----

  var GLSL_LIBRARY = [
    "struct Body { float x, y, angle, vx, vy, w; };",
    "struct Contact { bool hit; vec2 normal; vec2 point; vec2 rA; vec2 rB; float penetration; float tHit; };",
    "struct ContactPair { Contact c0; Contact c1; };",
    "struct ClosestPair { vec2 c1; vec2 c2; };",
    "",
    "const float LINE_THICKNESS = " + fnum(LINE_THICKNESS) + ";",
    "const float LINE_PARALLEL_EPS = " + fnum(LINE_PARALLEL_EPS) + ";",
    "const float RESTITUTION_THRESHOLD = " + fnum(RESTITUTION_THRESHOLD) + ";",
    "const float POSITION_SLOP = " + fnum(POSITION_SLOP) + ";",
    "const float POSITION_PERCENT = " + fnum(POSITION_PERCENT) + ";",
    "const float DT = " + fnum(FIXED_DT) + ";",
    "const float GRAVITY = " + fnum(global.PhysicsEngine.GRAVITY) + ";",
    "",
    // tHit defaults to 0.0 (already touching as of the START of this step)
    // here - true for every contact except collideCircleCircle's swept
    // branch, which overrides it with the actual sub-step instant. Every
    // other collide function builds on noContact() and never touches tHit
    // itself, so this one default line is all they need too.
    // rA/rB default to the origin - every collide function that sets
    // hit=true also sets these explicitly, so this default is only ever
    // observed by a contact nothing touches.
    "Contact noContact() {",
    "  Contact c;",
    "  c.hit = false; c.normal = vec2(0.0); c.point = vec2(0.0); c.rA = vec2(0.0); c.rB = vec2(0.0); c.penetration = 0.0; c.tHit = 0.0;",
    "  return c;",
    "}",
    "",
    "vec2 rotateVec(vec2 v, float angle) {",
    "  float c = cos(angle), s = sin(angle);",
    "  return vec2(v.x * c - v.y * s, v.x * s + v.y * c);",
    "}",
    "",
    "vec2 lineEndpoint0(Body line, float halfLen) {",
    "  return vec2(line.x - cos(line.angle) * halfLen, line.y - sin(line.angle) * halfLen);",
    "}",
    "vec2 lineEndpoint1(Body line, float halfLen) {",
    "  return vec2(line.x + cos(line.angle) * halfLen, line.y + sin(line.angle) * halfLen);",
    "}",
    "",
    "vec2 closestPointOnSegment(vec2 p1, vec2 p2, vec2 point) {",
    "  vec2 d = p2 - p1;",
    "  float lenSq = dot(d, d);",
    "  float t = lenSq > 1e-12 ? dot(point - p1, d) / lenSq : 0.0;",
    "  t = clamp(t, 0.0, 1.0);",
    "  return p1 + t * d;",
    "}",
    "",
    "ClosestPair closestPointsSegmentSegment(vec2 p1, vec2 q1, vec2 p2, vec2 q2) {",
    "  vec2 d1 = q1 - p1;",
    "  vec2 d2 = q2 - p2;",
    "  vec2 r = p1 - p2;",
    "  float a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);",
    "  float EPS = 1e-9;",
    "  float s, t;",
    "  if (a <= EPS && e <= EPS) {",
    "    s = 0.0; t = 0.0;",
    "  } else if (a <= EPS) {",
    "    s = 0.0; t = clamp(f / e, 0.0, 1.0);",
    "  } else {",
    "    float c = dot(d1, r);",
    "    if (e <= EPS) {",
    "      t = 0.0; s = clamp(-c / a, 0.0, 1.0);",
    "    } else {",
    "      float b = dot(d1, d2);",
    "      float denom = a * e - b * b;",
    "      s = denom != 0.0 ? clamp((b * f - c * e) / denom, 0.0, 1.0) : 0.0;",
    "      t = (b * s + f) / e;",
    "      if (t < 0.0) { t = 0.0; s = clamp(-c / a, 0.0, 1.0); }",
    "      else if (t > 1.0) { t = 1.0; s = clamp((b - c) / a, 0.0, 1.0); }",
    "    }",
    "  }",
    "  ClosestPair result;",
    "  result.c1 = p1 + d1 * s;",
    "  result.c2 = p2 + d2 * t;",
    "  return result;",
    "}",
    "",
    "// Sweep primitives: each returns the earliest t in [0,dt] at which a",
    "// point travelling from p at constant velocity v first reaches distance",
    "// R from the feature, or -1.0 if that never happens inside the step.",
    "float sweepPointSphere(vec2 p, vec2 v, vec2 c, float R, float dt) {",
    "  vec2 d = p - c;",
    "  float qc = dot(d, d) - R * R;",
    "  if (qc <= 0.0) return 0.0;",
    "  float qa = dot(v, v);",
    "  if (qa <= 1e-9) return -1.0;",
    "  float qb = 2.0 * dot(d, v);",
    "  float disc = qb * qb - 4.0 * qa * qc;",
    "  if (disc < 0.0) return -1.0;",
    "  float t = (-qb - sqrt(disc)) / (2.0 * qa);",
    "  if (t < 0.0 || t > dt) return -1.0;",
    "  return t;",
    "}",
    "",
    "// The flat side of the capsule: the perpendicular offset must reach",
    "// +-R while the axial parameter is still inside [0,len]. Outside that",
    "// axial span the caps own the contact, so this returns -1.0 and lets",
    "// sweepPointSphere win.",
    "float sweepPointSlab(vec2 p, vec2 v, vec2 e0, vec2 dir, float len, float R, float dt) {",
    "  vec2 perp = vec2(-dir.y, dir.x);",
    "  float f0 = dot(p - e0, perp);",
    "  float fv = dot(v, perp);",
    "  float t;",
    "  if (abs(f0) <= R) {",
    "    t = 0.0;",
    "  } else {",
    "    float target = f0 > 0.0 ? R : -R;",
    "    if (abs(fv) <= 1e-9) return -1.0;",
    "    t = (target - f0) / fv;",
    "    if (t < 0.0 || t > dt) return -1.0;",
    "  }",
    "  float s = dot(p + v * t - e0, dir);",
    "  if (s < 0.0 || s > len) return -1.0;",
    "  return t;",
    "}",
    "",
    "// Gravity + speed clamp over an arbitrary sub-step, not just the fixed",
    "// step DT - stepOnce() calls this once per leg of a CCD-split step (see",
    "// its own comment), so it has to be continuous in dt itself: dt=0.0 must",
    "// reduce to a clamp of an already-clamped vector, i.e. the identity.",
    // accel is the body's WHOLE acceleration this step, not just a downward
    // scalar - under Mutual Gravity each body has its own direction, and
    // uniform gravity is just the case where every body's is (0, GRAVITY).
    "vec2 advanceVelocity(vec2 v, float dt, vec2 accel) {",
    "  v += accel * dt;",
    // PhysicsEngine.AIR_DRAG (experimental) - no line at all when it is 0.
    (global.PhysicsEngine.AIR_DRAG ? "  v *= 1.0 - " + fnum(global.PhysicsEngine.AIR_DRAG) + " * dt;" : ""),
    "  float sq = dot(v, v);",
    "  if (sq > MAX_SPEED * MAX_SPEED) v *= MAX_SPEED / sqrt(sq);",
    "  return v;",
    "}",
    "",
    "Contact collideCircleCircle(Body a, float ra, Body b, float rb) {",
    "  vec2 d = vec2(b.x - a.x, b.y - a.y);",
    "  float dist = length(d);",
    "  float rsum = ra + rb;",
    "  Contact c = noContact();",
    "  if (dist >= rsum) {",
    "    // Not touching yet at the start of this step - solve for whether",
    "    // straight-line motion at the current velocities brings them",
    "    // together before this step's own DT elapses. Without this, a fast",
    "    // enough approach only gets caught once some future step's STARTING",
    "    // position happens to already be past the boundary - which step that",
    "    // ends up being is a discontinuous function of the starting",
    "    // conditions, so the resulting bounce is too (a tiny nudge to a",
    "    // starting position can shift which discrete step first notices",
    "    // contact, and each step's own velocity/penetration state differs).",
    "    // Solving the exact crossing time instead makes the contact normal -",
    "    // and everything downstream of it - a continuous function of where",
    "    // things started.",
    "    vec2 vRel = vec2(b.vx - a.vx, b.vy - a.vy);",
    "    float qa = dot(vRel, vRel);",
    "    float qb = 2.0 * dot(d, vRel);",
    "    float qc = dot(d, d) - rsum * rsum;",
    "    float disc = qb * qb - 4.0 * qa * qc;",
    "    if (qa <= 1e-9 || disc < 0.0) return c;",
    "    float t = (-qb - sqrt(disc)) / (2.0 * qa);",
    "    if (t < 0.0 || t > DT) return c;",
    "    vec2 hitD = d + vRel * t;",
    "    float hitDist = length(hitD);",
    "    vec2 n = hitDist > 1e-9 ? hitD / hitDist : vec2(0.0, 1.0);",
    "    // Evaluated at the true contact instant (a's position advanced by",
    "    // t), not a's stale start-of-step position - otherwise rB below",
    "    // (point minus b's UNADVANCED center) picks up a spurious component",
    "    // along vRel*t instead of landing exactly on -n*rb, injecting",
    "    // phantom spin into a contact that should only ever be linear for",
    "    // two circles. rA/rB are the lever arms themselves, not derived by",
    "    // subtracting a center from .point at solve time - for a circle the",
    "    // lever arm is always exactly +-n*radius by construction, regardless",
    "    // of any sub-step timing.",
    "    vec2 posA = vec2(a.x, a.y) + vec2(a.vx, a.vy) * t;",
    "    c.hit = true;",
    "    c.normal = n;",
    "    c.point = posA + n * ra;",
    "    c.rA = n * ra;",
    "    c.rB = -n * rb;",
    "    c.penetration = 0.0;",
    "    c.tHit = t;",
    "    return c;",
    "  }",
    "  vec2 n = dist > 1e-9 ? d / dist : vec2(0.0, 1.0);",
    "  c.hit = true;",
    "  c.normal = n;",
    "  c.point = vec2(a.x + n.x * ra, a.y + n.y * ra);",
    "  c.rA = n * ra;",
    "  c.rB = -n * rb;",
    "  c.penetration = rsum - dist;",
    "  c.tHit = 0.0;",
    "  return c;",
    "}",
    "",
    "// Swept capsule (segment e0-e1, half-thickness halfThickness, moving at",
    "// constant velocity segVel, otherwise rigid - rotation during the step",
    "// is ignored) vs. circle. Shared by collideLineCircle (segment = the",
    "// line's own body, refCenter = its center) and every funnel edge",
    "// (segment = one of the funnel's edges, refCenter = the FUNNEL's",
    "// center, since rA is a lever arm on the whole funnel body, not on an",
    "// implicit sub-body) - same three sub-tests (flat side of the capsule",
    "// plus a cap at each endpoint), earliest valid t wins.",
    "Contact sweptCapsuleCircleContact(vec2 e0, vec2 e1, vec2 segVel, vec2 refCenter, Body circle, float radius, float halfThickness) {",
    "  vec2 p0 = vec2(circle.x, circle.y);",
    "  vec2 vRel = vec2(circle.vx, circle.vy) - segVel;",
    "  float rsum = halfThickness + radius;",
    "  Contact c = noContact();",
    "",
    "  float dist0 = length(p0 - closestPointOnSegment(e0, e1, p0));",
    "  float tHit = 0.0;",
    "",
    "  if (dist0 >= rsum) {",
    "    vec2 seg = e1 - e0;",
    "    float segLen = length(seg);",
    "    vec2 dir = segLen > 1e-9 ? seg / segLen : vec2(1.0, 0.0);",
    "",
    "    float best = -1.0;",
    "    float tSlab = sweepPointSlab(p0, vRel, e0, dir, segLen, rsum, DT);",
    "    if (tSlab >= 0.0) best = tSlab;",
    "    float tCap0 = sweepPointSphere(p0, vRel, e0, rsum, DT);",
    "    if (tCap0 >= 0.0 && (best < 0.0 || tCap0 < best)) best = tCap0;",
    "    float tCap1 = sweepPointSphere(p0, vRel, e1, rsum, DT);",
    "    if (tCap1 >= 0.0 && (best < 0.0 || tCap1 < best)) best = tCap1;",
    "    if (best < 0.0) return c;",
    "    tHit = best;",
    "  }",
    "",
    "  vec2 pHit = p0 + vRel * tHit;",
    "  vec2 closest = closestPointOnSegment(e0, e1, pHit);",
    "  vec2 d = pHit - closest;",
    "  float dist = length(d);",
    "  vec2 n = dist > 1e-9 ? d / dist : vec2(0.0, 1.0);",
    "",
    "  // Everything above is in the segment's frame; its own translation",
    "  // over tHit shifts .point and its reference center equally, so it",
    "  // cancels out of rA.",
    "  vec2 segOffset = segVel * tHit;",
    "  vec2 pt = closest + n * halfThickness;",
    "",
    "  c.hit = true;",
    "  c.normal = n;",
    "  c.point = pt + segOffset;",
    "  c.rA = pt - refCenter;",
    "  c.rB = -n * radius;",
    "  c.penetration = max(rsum - dist, 0.0);",
    "  c.tHit = tHit;",
    "  return c;",
    "}",
    "",
    "// line -> circle; normal points line -> circle. Swept, for the same",
    "// reason collideCircleCircle is: a discrete test only notices contact",
    "// once some step's STARTING configuration is already overlapping, and",
    "// which step that is jumps with the starting conditions. Runs in the",
    "// line's frame (relative velocity, endpoints held fixed), so it",
    "// ignores rotation of the line during the step.",
    "Contact collideLineCircle(Body line, float halfLen, Body circle, float radius) {",
    "  vec2 e0 = lineEndpoint0(line, halfLen);",
    "  vec2 e1 = lineEndpoint1(line, halfLen);",
    "  return sweptCapsuleCircleContact(e0, e1, vec2(line.vx, line.vy), vec2(line.x, line.y), circle, radius, LINE_THICKNESS * 0.5);",
    "}",
    "",
    "// Two contacts (both ends of the overlap) when near-parallel and",
    "// overlapping - a single point can't stop a rod from spinning around it -",
    "// otherwise falls back to a single closest-point contact.",
    "ContactPair collideLineLine(Body lineA, float halfLenA, Body lineB, float halfLenB) {",
    "  vec2 eA0 = lineEndpoint0(lineA, halfLenA);",
    "  vec2 eA1 = lineEndpoint1(lineA, halfLenA);",
    "  vec2 eB0 = lineEndpoint0(lineB, halfLenB);",
    "  vec2 eB1 = lineEndpoint1(lineB, halfLenB);",
    "",
    "  ContactPair result;",
    "  result.c0 = noContact();",
    "  result.c1 = noContact();",
    "",
    "  vec2 dirA = eA1 - eA0;",
    "  float lenA = length(dirA);",
    "  if (lenA < 1e-9) lenA = 1.0;",
    "  dirA /= lenA;",
    "  vec2 dirBraw = eB1 - eB0;",
    "  float lenB = length(dirBraw);",
    "  if (lenB < 1e-9) lenB = 1.0;",
    "  vec2 dirBn = dirBraw / lenB;",
    "  float crossVal = dirA.x * dirBn.y - dirA.y * dirBn.x;",
    "",
    "  if (abs(crossVal) < LINE_PARALLEL_EPS) {",
    "    vec2 perp = vec2(-dirA.y, dirA.x);",
    "    float offset = dot(eB0 - eA0, perp);",
    "    float distP = abs(offset);",
    "    if (distP < LINE_THICKNESS) {",
    "      float b0 = dot(eB0 - eA0, dirA);",
    "      float b1 = dot(eB1 - eA0, dirA);",
    "      float lo = max(0.0, min(b0, b1));",
    "      float hi = min(lenA, max(b0, b1));",
    "      if (hi > lo) {",
    "        float sgn = offset >= 0.0 ? 1.0 : -1.0;",
    "        vec2 normal = perp * sgn;",
    "        float penetration = LINE_THICKNESS - distP;",
    "        vec2 pOnA0 = eA0 + dirA * lo;",
    "        vec2 pOnA1 = eA0 + dirA * hi;",
    "        vec2 pt0 = pOnA0 + perp * offset * 0.5;",
    "        result.c0.hit = true;",
    "        result.c0.normal = normal;",
    "        result.c0.point = pt0;",
    "        result.c0.rA = pt0 - vec2(lineA.x, lineA.y);",
    "        result.c0.rB = pt0 - vec2(lineB.x, lineB.y);",
    "        result.c0.penetration = penetration;",
    "        result.c0.tHit = 0.0;",
    "        if (hi - lo > 1e-6) {",
    "          vec2 pt1 = pOnA1 + perp * offset * 0.5;",
    "          result.c1.hit = true;",
    "          result.c1.normal = normal;",
    "          result.c1.point = pt1;",
    "          result.c1.rA = pt1 - vec2(lineA.x, lineA.y);",
    "          result.c1.rB = pt1 - vec2(lineB.x, lineB.y);",
    "          result.c1.penetration = penetration;",
    "          result.c1.tHit = 0.0;",
    "        }",
    "        return result;",
    "      }",
    "    }",
    "  }",
    "",
    "  ClosestPair cp = closestPointsSegmentSegment(eA0, eA1, eB0, eB1);",
    "  vec2 d2 = cp.c2 - cp.c1;",
    "  float dist2 = length(d2);",
    "  if (dist2 >= LINE_THICKNESS) return result;",
    "  vec2 n2 = dist2 > 1e-9 ? d2 / dist2 : vec2(0.0, 1.0);",
    "  vec2 pt2 = (cp.c1 + cp.c2) * 0.5;",
    "  result.c0.hit = true;",
    "  result.c0.normal = n2;",
    "  result.c0.point = pt2;",
    "  result.c0.rA = pt2 - vec2(lineA.x, lineA.y);",
    "  result.c0.rB = pt2 - vec2(lineB.x, lineB.y);",
    "  result.c0.penetration = LINE_THICKNESS - dist2;",
    "  result.c0.tHit = 0.0;",
    "  return result;",
    "}",
    "",
    "// ---- Funnel: a trapezoid (throat 1, mouth 3, legs 2 each, all scaled",
    "// by `size`) that teleports a circle touching its mouth to the center",
    "// of its throat, velocity unchanged - direct port of",
    "// physics-engine.js's Funnel functions, see that file's header comment",
    "// for the geometry. physics-gpu-df.js carries the df port of all of it.",
    "const float FUNNEL_MOUTH_HALF = " + fnum(global.PhysicsEngine.FUNNEL_MOUTH_HALF) + ";",
    "const float FUNNEL_THROAT_HALF = " + fnum(global.PhysicsEngine.FUNNEL_THROAT_HALF) + ";",
    "const float FUNNEL_HALF_HEIGHT = " + fnum(global.PhysicsEngine.FUNNEL_HALF_HEIGHT) + ";",
    "struct FunnelVerts { vec2 mouthLeft; vec2 mouthRight; vec2 throatLeft; vec2 throatRight; };",
    "FunnelVerts funnelVertices(Body f, float size) {",
    "  float mh = FUNNEL_MOUTH_HALF * size, th = FUNNEL_THROAT_HALF * size, hh = FUNNEL_HALF_HEIGHT * size;",
    "  vec2 c = vec2(f.x, f.y);",
    "  FunnelVerts v;",
    "  v.mouthLeft = c + rotateVec(vec2(-mh, -hh), f.angle);",
    "  v.mouthRight = c + rotateVec(vec2(mh, -hh), f.angle);",
    "  v.throatLeft = c + rotateVec(vec2(-th, hh), f.angle);",
    "  v.throatRight = c + rotateVec(vec2(th, hh), f.angle);",
    "  return v;",
    "}",
    "",
    "struct MouthHit { bool hit; float tHit; vec2 target; };",
    "MouthHit noMouthHit() { MouthHit m; m.hit = false; m.tHit = 0.0; m.target = vec2(0.0); return m; }",
    "",
    "// Does circle's swept path touch funnel's mouth (the teleport trigger)",
    "// this step? Only tHit/target matter - no impulse is ever applied for a",
    "// teleport, unlike the 3 solid edges (see collideFunnelCircle in",
    "// physics-engine.js - this is its GLSL twin, minus the Contact-array",
    "// return since the caller here builds each edge separately). target is",
    "// the funnel's own throat center, advanced by the funnel's velocity to",
    "// the same tHit and rotated by its angle at the START of the step -",
    "// rotation during the step is ignored, the same simplification every",
    "// capsule test here already makes.",
    "MouthHit collideFunnelMouthTHit(Body funnel, float size, Body circle, float radius) {",
    "  FunnelVerts v = funnelVertices(funnel, size);",
    "  Contact c = sweptCapsuleCircleContact(v.mouthLeft, v.mouthRight, vec2(funnel.vx, funnel.vy), vec2(funnel.x, funnel.y), circle, radius, LINE_THICKNESS * 0.5);",
    "  MouthHit m = noMouthHit();",
    "  if (!c.hit) return m;",
    "  float hh = FUNNEL_HALF_HEIGHT * size;",
    "  vec2 rotated = rotateVec(vec2(0.0, hh), funnel.angle);",
    "  m.hit = true;",
    "  m.tHit = c.tHit;",
    "  m.target = vec2(funnel.x, funnel.y) + vec2(funnel.vx, funnel.vy) * c.tHit + rotated;",
    "  return m;",
    "}",
    "",
    "// ---- Splitter: the same trapezoid, with the roles of its two parallel",
    "// sides swapped. The long mouth is a wall (see the solid-edge codegen",
    "// in generateStepOnceGLSL) and the SHORT side is the trigger: a circle",
    "// crossing it becomes two on the long side. GLSL twin of",
    "// physics-engine.js's collideSplitterShortSideTHit - see that function",
    "// for why the answer is two displacements (the trapezoid's own leg",
    "// vectors) rather than two points on the long side.",
    "struct SplitHit { bool hit; float tHit; vec2 offset1; vec2 offset2; };",
    "SplitHit noSplitHit() { SplitHit s; s.hit = false; s.tHit = 0.0; s.offset1 = vec2(0.0); s.offset2 = vec2(0.0); return s; }",
    "",
    "SplitHit collideSplitterShortSideTHit(Body splitter, float size, Body circle, float radius) {",
    "  FunnelVerts v = funnelVertices(splitter, size);",
    "  SplitHit s = noSplitHit();",
    "  // Only a FRESH crossing splits. A circle already inside the trigger's",
    "  // capsule when the step began would otherwise re-split every step, and",
    "  // since each split adds a body that is exponential growth measured in",
    "  // steps. sweptCapsuleCircleContact reports exactly that case as a hit at",
    "  // tHit = 0 (its own dist0 branch), so the guard has to be here, ahead of",
    "  // it - the same order physics-engine.js uses.",
    "  vec2 p0 = vec2(circle.x, circle.y);",
    "  vec2 startClosest = closestPointOnSegment(v.throatLeft, v.throatRight, p0);",
    "  if (length(p0 - startClosest) < LINE_THICKNESS * 0.5 + radius) return s;",
    "  Contact c = sweptCapsuleCircleContact(v.throatLeft, v.throatRight, vec2(splitter.vx, splitter.vy), vec2(splitter.x, splitter.y), circle, radius, LINE_THICKNESS * 0.5);",
    "  if (!c.hit) return s;",
    "  // Leg vector plus one constant clearance out through the long side -",
    "  // see physics-engine.js\'s collideSplitterShortSideTHit for why the",
    "  // two SURFACES are matched up rather than the two centerlines (short",
    "  // version: the swept trigger fires while the ball is still",
    "  // halfThickness + radius short of the short side, and translating that",
    "  // faithfully would leave it embedded in the long side\'s wall).",
    "  vec2 exitDir = (v.mouthLeft + v.mouthRight) * 0.5 - (v.throatLeft + v.throatRight) * 0.5;",
    "  float exitLen = length(exitDir);",
    "  vec2 clear = (exitLen > 1e-9 ? exitDir / exitLen : vec2(0.0, 1.0)) * (LINE_THICKNESS + 2.0 * radius);",
    "  s.hit = true;",
    "  s.tHit = c.tHit;",
    "  s.offset1 = v.mouthLeft - v.throatLeft + clear;",
    "  s.offset2 = v.mouthRight - v.throatRight + clear;",
    "  return s;",
    "}",
    "",
    "// invMass/invInertia are 0 for static bodies, which already makes every",
    "// update below a no-op for them - no separate isAnchored branch needed.",
    "void applyImpulse(inout Body b, float invMass, float invInertia, vec2 impulse, vec2 r) {",
    "  b.vx += impulse.x * invMass;",
    "  b.vy += impulse.y * invMass;",
    "  b.w += invInertia * (r.x * impulse.y - r.y * impulse.x);",
    "}",
    "",
    "vec2 velocityAt(Body b, vec2 r) {",
    "  return vec2(b.vx - b.w * r.y, b.vy + b.w * r.x);",
    "}",
    "",
    "void solveContactVelocity(inout Body bodyA, float invMassA, float invInertiaA,",
    "                          inout Body bodyB, float invMassB, float invInertiaB,",
    "                          Contact contact) {",
    "  if (!contact.hit) return;",
    "  vec2 n = contact.normal;",
    "  // Lever arms recorded at the contact instant by the narrow phase, NOT",
    "  // re-derived as (point - center) here - the centers are mid-step and",
    "  // would contaminate the arms with up to a full step of travel, which",
    "  // changes invMassSum by an amount that depends on tHit.",
    "  vec2 rA = contact.rA;",
    "  vec2 rB = contact.rB;",
    "",
    "  vec2 vA = velocityAt(bodyA, rA);",
    "  vec2 vB = velocityAt(bodyB, rB);",
    "  vec2 rv = vB - vA;",
    "  float velAlongNormal = dot(rv, n);",
    "  if (velAlongNormal > 0.0) return;",
    "",
    "  float raCrossN = rA.x * n.y - rA.y * n.x;",
    "  float rbCrossN = rB.x * n.y - rB.y * n.x;",
    "  float invMassSum = invMassA + invMassB + raCrossN * raCrossN * invInertiaA + rbCrossN * rbCrossN * invInertiaB;",
    "  if (invMassSum <= 0.0) return;",
    "",
    "  // Was a hard step at RESTITUTION_THRESHOLD, which doubles j across a",
    "  // zero-width band. Smoothed so it still suppresses jitter at rest",
    "  // without being a cliff - this is also what keeps a grazing hit",
    "  // continuous with a near miss, since -velAlongNormal -> 0 as the",
    "  // impact goes tangential.",
    "  float e = smoothstep(0.5 * RESTITUTION_THRESHOLD, RESTITUTION_THRESHOLD, -velAlongNormal);",
    "  float j = -(1.0 + e) * velAlongNormal / invMassSum;",
    "  applyImpulse(bodyA, invMassA, invInertiaA, vec2(-n.x * j, -n.y * j), rA);",
    "  applyImpulse(bodyB, invMassB, invInertiaB, vec2(n.x * j, n.y * j), rB);",
    "  // Nothing along the tangent: every contact is frictionless.",
    "  // No position fixup here. stepOnce() integrates the step in two legs",
    "  // split at each body's own tHit, which accounts for the sub-step",
    "  // exactly; correcting here as well would double-count it.",
    "}",
    "",
    "void solveContactPosition(inout Body bodyA, float invMassA, inout Body bodyB, float invMassB, Contact contact) {",
    "  if (!contact.hit) return;",
    "  float invMassSum = invMassA + invMassB;",
    "  if (invMassSum <= 0.0) return;",
    "  float correction = max(contact.penetration - POSITION_SLOP, 0.0) / invMassSum * POSITION_PERCENT;",
    "  vec2 n = contact.normal;",
    "  bodyA.x -= n.x * correction * invMassA;",
    "  bodyA.y -= n.y * correction * invMassA;",
    "  bodyB.x += n.x * correction * invMassB;",
    "  bodyB.y += n.y * correction * invMassB;",
    "}",
    "",
    "vec2 solve2x2(float mA, float iA, vec2 rA, float mB, float iB, vec2 rB, float rhsX, float rhsY) {",
    "  if (mA + mB + iA + iB <= 0.0) return vec2(0.0);",
    "  float k11 = mA + mB + iA * rA.y * rA.y + iB * rB.y * rB.y;",
    "  float k12 = -iA * rA.x * rA.y - iB * rB.x * rB.y;",
    "  float k22 = mA + mB + iA * rA.x * rA.x + iB * rB.x * rB.x;",
    "  float det = k11 * k22 - k12 * k12;",
    "  float invDet = 1.0 / det;",
    "  return vec2(invDet * (k22 * rhsX - k12 * rhsY), invDet * (k11 * rhsY - k12 * rhsX));",
    "}",
    "",
    "void solveHingeVelocity(inout Body bodyA, float invMassA, float invInertiaA, vec2 localAnchorA,",
    "                        inout Body bodyB, float invMassB, float invInertiaB, vec2 localAnchorB) {",
    "  vec2 rA = rotateVec(localAnchorA, bodyA.angle);",
    "  vec2 rB = rotateVec(localAnchorB, bodyB.angle);",
    "  vec2 vA = velocityAt(bodyA, rA);",
    "  vec2 vB = velocityAt(bodyB, rB);",
    "  vec2 cdot = vB - vA;",
    "  vec2 impulse = solve2x2(invMassA, invInertiaA, rA, invMassB, invInertiaB, rB, -cdot.x, -cdot.y);",
    "  applyImpulse(bodyA, invMassA, invInertiaA, vec2(-impulse.x, -impulse.y), rA);",
    "  applyImpulse(bodyB, invMassB, invInertiaB, impulse, rB);",
    "}",
    "",
    "void solveHingePosition(inout Body bodyA, float invMassA, float invInertiaA, vec2 localAnchorA,",
    "                        inout Body bodyB, float invMassB, float invInertiaB, vec2 localAnchorB) {",
    "  vec2 rA = rotateVec(localAnchorA, bodyA.angle);",
    "  vec2 rB = rotateVec(localAnchorB, bodyB.angle);",
    "  vec2 worldA = vec2(bodyA.x, bodyA.y) + rA;",
    "  vec2 worldB = vec2(bodyB.x, bodyB.y) + rB;",
    "  vec2 c = worldB - worldA;",
    "  vec2 impulse = solve2x2(invMassA, invInertiaA, rA, invMassB, invInertiaB, rB, -c.x, -c.y);",
    "  bodyA.x -= impulse.x * invMassA;",
    "  bodyA.y -= impulse.y * invMassA;",
    "  bodyA.angle -= invInertiaA * (rA.x * impulse.y - rA.y * impulse.x);",
    "  bodyB.x += impulse.x * invMassB;",
    "  bodyB.y += impulse.y * invMassB;",
    "  bodyB.angle += invInertiaB * (rB.x * impulse.y - rB.y * impulse.x);",
    "}",
  ].join("\n");

  // The df physics library lives in physics-gpu-df.js - a port of
  // GLSL_LIBRARY above, function for function. It used to be enough to keep
  // only the six accumulators in df and run the collision/solver math in
  // float32 inside a local frame; measurement killed that idea (see
  // physics-gpu-df.js's header and the README), so the df path now carries
  // the entire step and needs no local-frame conversion at all.

  var VERTEX_SOURCE = [
    "#version 300 es",
    "in vec2 a_position;",
    "void main() { gl_Position = vec4(a_position, 0.0, 1.0); }",
  ].join("\n");

  // maxSpeed is per SCENE, not a fixed constant of the library: Mutual
  // Gravity runs a higher ceiling than ordinary downward gravity (see
  // PhysicsEngine.speedCapFor, which is the single source of truth for
  // which). It's prepended here rather than emitted with the other per-scene
  // constants because every caller puts this library FIRST - the functions
  // below reference MAX_SPEED, so its declaration has to come before them.
  // Defaults to the plain cap so a caller that doesn't care can omit it.
  function speedCapDecls(precision, maxSpeed) {
    var cap = maxSpeed === undefined ? global.PhysicsEngine.MAX_SPEED : maxSpeed;
    var lines = ["const float MAX_SPEED = " + fnum(cap) + ";"];
    if (global.PhysicsDF.isExtended(precision)) lines.push("const MF DF_MAX_SPEED = " + global.PhysicsDF.num(cap) + ";");
    return lines.join("\n") + "\n";
  }

  // Everything a df shader needs before any generated code: the uniform
  // dfv() hides behind, the df arithmetic itself, the float32 physics
  // library, and the DBody bridge between the last two. Assembled here so
  // no caller has to remember the order.
  function libraryGLSL(precision, maxSpeed) {
    if (!global.PhysicsDF.isExtended(precision)) return speedCapDecls(precision, maxSpeed) + GLSL_LIBRARY;
    // Everything multi-float from here to the end of this shader's code
    // generation is at THIS precision - see PhysicsDF.usePrecision. The
    // speed cap is declared after the arithmetic (it is an MF constant, and
    // MF is the arithmetic library's macro).
    global.PhysicsDF.usePrecision(precision);
    // Order matters: the df arithmetic defines DVec2 and the dv2* helpers
    // the df physics is written against, and the float32 library is still
    // included because the per-pixel cascade's f32 helpers and `Body` are
    // referenced by callers that mix the two.
    return [global.PhysicsDF.UNIFORM_DECL, "", global.PhysicsDF.GLSL_LIBRARY, "",
      speedCapDecls(precision, maxSpeed), GLSL_LIBRARY, "", global.PhysicsGPUDF.GLSL_LIBRARY].join("\n");
  }

  // ---- Scene -> GLSL codegen ----

  function bodyConst(body) {
    var copy = {};
    for (var k in body) if (Object.prototype.hasOwnProperty.call(body, k)) copy[k] = body[k];
    global.PhysicsEngine.computeMass(copy);
    return copy;
  }

  function shapeHalf(consts, i) {
    if (consts[i].type === "circle") return consts[i].radius;
    // A splitter is the same trapezoid as a funnel - same half-extent.
    if (consts[i].type === "funnel" || consts[i].type === "splitter") return consts[i].size / 2;
    return consts[i].length / 2;
  }

  // Every pair is unrolled at codegen time: we already know each body's
  // type, so we know exactly which collision function applies and in which
  // argument order - no runtime type dispatch needed at all.
  function collisionPairs(n, consts, hinges) {
    var pairs = [];
    for (var i = 0; i < n; i++) {
      for (var j = i + 1; j < n; j++) {
        if (consts[i].isAnchored && consts[j].isAnchored) continue;
        if (global.PhysicsEngine.hingeConnects(hinges, i, j)) continue;
        pairs.push([i, j]);
      }
    }
    return pairs;
  }

  // Per-body arguments stepOnce() needs, in a fixed order shared by both the
  // function's own parameter list and every call site, so the two can never
  // drift apart.
  // Hinge anchors are parameters too, not baked into stepOnce()'s body as
  // literals: a hinge anchor on a resized body is a runtime expression
  // (see physics-grid-codegen.js), and that expression is only in scope in
  // the CALLER (main()) that declared it - a value can't be embedded
  // directly into a separate function's body and still reach a variable
  // local to whoever calls that function. Passing it as a `vec2` parameter
  // sidesteps the scoping question entirely: the caller builds the
  // vec2(...) itself, wherever its inputs are actually in scope, and
  // stepOnce() just receives the resulting value.
  // In df mode every parameter is its df counterpart: DBody for state,
  // vec2 (a df scalar) for the shape constants, DVec2 for hinge anchors.
  // A world hinge's anchor is inout in both modes because stepOnce() wraps
  // it in place at the frame edges and that has to persist across calls.
  // spawnBase, when given, is the number of AUTHORED bodies in a splitter
  // scene - every slot from there up is a spawn slot, empty until some
  // circle splits into it (see generateStepOnceGLSL's splitting section).
  // Those slots differ from authored ones in three ways, all of which have
  // to survive from one stepOnce() call to the next and so have to be inout:
  // their shape constants aren't known at compile time (a spawn slot
  // inherits whichever ball split into it, and different balls have
  // different radii), they carry an alive flag, and they carry the lineage
  // of the authored body they descend from. Omitted (undefined) for every
  // scene without a splitter, which is what keeps those shaders spelled
  // exactly as they were before any of this existed.
  function spawnSlotsFrom(n, spawnBase) {
    if (spawnBase === undefined || spawnBase === null) return [];
    var out = [];
    for (var i = spawnBase; i < n; i++) out.push(i);
    return out;
  }

  // ---- Springs, as the generators see them ----
  //
  // `springs` is to a scene's springs what `hingeAnchors` is to its hinges:
  // one { aIsWorld, a, b, localA, localB, stiffness, restLength } per spring,
  // with the anchors already GLSL TEXT ({ x, y }, in the pass's own
  // precision) because a spring on a body whose size is linked to a pixel has
  // per-pixel anchors (see physics-grid-codegen.js), and stiffness/restLength
  // plain numbers because nothing can vary them. An anchor may carry
  // `zero: true` - attached dead center - which is worth knowing at compile
  // time: that end has no lever arm, so it needs no rotation (a sin/cos, the
  // dearest thing a multi-float pass can do), no torque and no parameter.
  // Omitted (undefined) by every caller with no springs to pass, which is
  // what keeps those shaders spelled exactly as they were.
  function springEndNeedsParam(sp, end) {
    return end === "A" ? (sp.aIsWorld || !sp.localA.zero) : !sp.localB.zero;
  }
  // The descriptors for a scene whose anchors are just its authored numbers.
  function springLinksFor(scene, lit) {
    return global.PhysicsEngine.sceneSprings(scene).map(function (s) {
      function anchor(a, isLocal) {
        return { x: lit(a.x), y: lit(a.y), zero: isLocal && a.x === 0 && a.y === 0 };
      }
      return {
        aIsWorld: s.bodyA === null, a: s.bodyA, b: s.bodyB,
        localA: anchor(s.localAnchorA, s.bodyA !== null), localB: anchor(s.localAnchorB, true),
        stiffness: s.stiffness, restLength: s.restLength,
      };
    });
  }

  // PhysicsEngine.springSpin, in GLSL: a body's spin after `t` of this step's
  // torque, explicit until the swing feeding it is too fast for the step and
  // implicit in the excess beyond that - see that function for the why.
  // Emitted only into a shader with a spring that can turn something. The
  // multi-float form branches rather than taking a max: its divide is the
  // expensive half, and on every ordinary step it is a divide by exactly one.
  function springSpinGLSL(df) {
    var stability = (df ? global.PhysicsDF.num : fnum)(global.PhysicsEngine.SPRING_STABILITY);
    return df ? [
      "MF dfSpringSpin(MF w, MF alpha, MF swing, MF t) {",
      "  MF spun = dfAdd(w, dfMul(alpha, t));",
      "  MF excess = dfSub(dfMul(swing, dfSqr(t)), " + stability + ");",
      "  if (dfGreater(excess, DF_ZERO)) spun = dfDiv(spun, dfAdd(DF_ONE, excess));",
      "  return spun;",
      "}",
    ].join("\n") : [
      "float springSpin(float w, float alpha, float swing, float t) {",
      "  return (w + alpha * t) / (1.0 + max(0.0, swing * t * t - " + stability + "));",
      "}",
    ].join("\n");
  }

  function stepOnceParams(n, hingeAnchors, precision, spawnBase, springs) {
    var df = global.PhysicsDF.isExtended(precision);
    // In df mode the shape constants are df too. They are per-pixel values
    // whenever a size axis is linked, so leaving them float32 would put a
    // ~1e-7 quantization back on exactly that axis - and now that the
    // collision math is df, they are what it multiplies against.
    var sc = df ? "MF " : "float ";
    var spawnSlots = spawnSlotsFrom(n, spawnBase);
    var isSpawn = {};
    spawnSlots.forEach(function (i) { isSpawn[i] = true; });
    var params = [];
    for (var i = 0; i < n; i++) {
      var mut = isSpawn[i] ? "inout " : "";
      params.push((df ? "inout DBody dbody" : "inout Body body") + i,
        mut + sc + "BODY" + i + "_INV_MASS", mut + sc + "BODY" + i + "_INV_INERTIA", mut + sc + "BODY" + i + "_HALF");
      if (isSpawn[i]) params.push("inout bool alive" + i, "inout int lineage" + i);
    }
    (hingeAnchors || []).forEach(function (hg, h) {
      // A world hinge's own anchor is a coordinate in the SAME frame space
      // a body's position is (see generateStepOnceGLSL's frame-wrap
      // comment) - inout so stepOnce() can wrap it in place and have that
      // persist to the next call, exactly like a body's own position
      // already does. A hinge to another body has no such thing:
      // localAnchorA there is a point in that OTHER body's own local
      // frame, never affected by world-space wrapping, so it stays a
      // plain (never mutated) parameter.
      // In df mode every anchor is a DVec2, the local ones included: the df
      // hinge solvers rotate them about df angles, and a resize-linked
      // anchor is a per-pixel value like any other.
      params.push((hg.aIsWorld ? "inout " : "") + (df ? "DVec2" : "vec2") + " HINGE" + h + "_A",
        (df ? "DVec2" : "vec2") + " HINGE" + h + "_B");
    });
    // A spring's anchors, for the reason a hinge's are parameters. Never
    // inout, the background end included: a group tethered to the background
    // never wraps (see PhysicsEngine.springGroups), so unlike a hinge's pin
    // that point has nothing to carry from one step to the next.
    (springs || []).forEach(function (sp, s) {
      if (springEndNeedsParam(sp, "A")) params.push((df ? "DVec2" : "vec2") + " SPRING" + s + "_A");
      if (springEndNeedsParam(sp, "B")) params.push((df ? "DVec2" : "vec2") + " SPRING" + s + "_B");
    });
    // How many slots are in use right now. The split that fills a slot has
    // to see what the split before it in this same step already took, and
    // the next STEP has to see both, so this is one counter threaded through
    // the whole run rather than anything recomputed from the alive flags.
    if (spawnSlots.length) params.push("inout int liveCount");
    // GLSL caps a function at 256 parameters, and this is the one function
    // whose signature grows with the scene - 4 per authored body, 6 per
    // spawn slot, 2 per hinge, plus liveCount. PhysicsEngine's
    // MAX_SIMULATION_BODIES_LIMIT is set to keep any authorable scene well
    // under it, but that bound can't know a particular scene's hinge count,
    // so the real number is counted here. Thrown rather than left to the
    // driver, whose own message for this is "'stepOnce' : Function has too
    // many parameters" against a line number in generated code.
    if (params.length > MAX_GLSL_FUNCTION_PARAMS) {
      throw new Error("This scene needs " + params.length + " stepOnce() parameters, past GLSL's limit of " +
        MAX_GLSL_FUNCTION_PARAMS + " - lower Max Objects (currently " + n + " slots) or remove a hinge or spring.");
    }
    return params;
  }

  // The anchor expressions in `hingeAnchors` are float32 GLSL text in f32
  // mode and df (vec2) GLSL text in df mode - whoever built them knows
  // which, and this just has to spell the right constructor.
  function stepOnceCallArgs(n, hingeAnchors, precision, spawnBase, springs) {
    var df = global.PhysicsDF.isExtended(precision);
    function localVec(a) {
      return df ? "dv2(" + a.x + ", " + a.y + ")" : "vec2(" + a.x + ", " + a.y + ")";
    }
    var spawnSlots = spawnSlotsFrom(n, spawnBase);
    var isSpawn = {};
    spawnSlots.forEach(function (i) { isSpawn[i] = true; });
    var args = [];
    for (var i = 0; i < n; i++) {
      args.push((df ? "dbody" : "body") + i, "BODY" + i + "_INV_MASS", "BODY" + i + "_INV_INERTIA", "BODY" + i + "_HALF");
      if (isSpawn[i]) args.push("alive" + i, "lineage" + i);
    }
    (hingeAnchors || []).forEach(function (hg, h) {
      // A world hinge's anchor is passed by reference (see
      // generateHingeAnchorLocalsGLSL) so stepOnce()'s wrap of it persists
      // across the step loop's repeated calls; a hinge to another body has
      // no persistent state to thread through, so it's still just
      // reconstructed fresh every call.
      args.push(hg.aIsWorld ? ("hingeAnchor" + h) : localVec(hg.localA), localVec(hg.localB));
    });
    (springs || []).forEach(function (sp) {
      if (springEndNeedsParam(sp, "A")) args.push(localVec(sp.localA));
      if (springEndNeedsParam(sp, "B")) args.push(localVec(sp.localB));
    });
    if (spawnSlots.length) args.push("liveCount");
    return args.join(", ");
  }

  // The persistent counterpart to stepOnceCallArgs's "hingeAnchor" + h
  // reference: declares one mutable vec2 per world hinge, initialized from
  // its (possibly per-pixel-symbolic) authored value, that the step loop's
  // repeated stepOnce() calls read and wrap in place across steps. Emitted
  // by whoever assembles the locals a step loop runs against (see
  // generateBodyLocalsGLSL) - nothing to declare for a hinge to another
  // body, which never needs persistent state.
  function generateHingeAnchorLocalsGLSL(hingeAnchors, precision) {
    var df = global.PhysicsDF.isExtended(precision);
    var lines = [];
    (hingeAnchors || []).forEach(function (hg, h) {
      if (!hg.aIsWorld) return;
      lines.push(df
        ? "DVec2 hingeAnchor" + h + " = dv2(" + hg.localA.x + ", " + hg.localA.y + ");"
        : "vec2 hingeAnchor" + h + " = vec2(" + hg.localA.x + ", " + hg.localA.y + ");");
    });
    return lines.join("\n");
  }

  // Goes wherever a pixel's bodies are declared. In df, stepOnce() builds the
  // geometry of every ANCHORED line and trapezoid once per run, the first
  // time it finds g_dfStaticGeomReady false (see generateStepOnceGLSL).
  // A fresh set of bodies is a fresh run: a shader that simulates more than
  // one starting point per invocation - the derived display modes' stencil -
  // would otherwise carry the previous point's geometry into the next.
  // Nothing to say in float32, which hoists nothing.
  function staticGeometryResetGLSL(precision) {
    return global.PhysicsDF.isExtended(precision) ? "g_dfStaticGeomReady = false;" : "";
  }

  // ---- Splitter scenes: pre-allocated spawn slots ----
  //
  // A split creates a body, and a compiled shader has nowhere to put one -
  // every body is its own unrolled GLSL variable, decided before the first
  // step runs. So the scene handed to the compiler is padded up front, out
  // to PhysicsEngine.MAX_SIMULATION_BODIES, with empty circles that start
  // dead. A split doesn't create a body; it wakes one up.
  //
  // A dead slot is a radius-0 circle, which computeMass already answers for
  // with invMass = invInertia = 0 (its `mass > 0` guard) - so it has no
  // shape to draw, no response to any impulse, and contributes no
  // gravitational mass. It is still integrated like anything else while
  // dead: it falls, and it wraps. That's deliberate rather than gated away,
  // because every interaction it could have is already suppressed (see the
  // alive gating in generateStepOnceGLSL) and the moment it is woken its
  // whole state is overwritten from the ball that split into it, so
  // whatever it did while dead is unobservable. Freezing it instead would
  // mean an `if (aliveN)` around three separate integration sites per slot,
  // for no difference in the answer.
  function sceneHasSplitter(scene) {
    return scene.bodies.some(function (b) { return b.type === "splitter"; });
  }

  // The padded scene, plus how many of its bodies were actually authored.
  // A scene with no splitter is returned untouched and reports spawnBase
  // null, which every downstream generator reads as "no spawn slots" and so
  // emits exactly the GLSL it always did.
  function padSceneForSplitting(scene) {
    if (!sceneHasSplitter(scene)) return { scene: scene, spawnBase: null };
    var authored = scene.bodies.length;
    // The scene's own ceiling, not the global default - this is the control
    // #editor-view exposes as "Max Objects", and it decides the compiled
    // shader's whole size.
    var cap = global.PhysicsEngine.maxSimulationBodiesFor(scene);
    if (authored >= cap) return { scene: scene, spawnBase: authored };
    var bodies = scene.bodies.slice();
    for (var i = authored; i < cap; i++) {
      // Parked at the origin. Position is irrelevant while dead (nothing
      // reads it and nothing collides with it) and overwritten on wake.
      bodies.push(global.PhysicsEngine.createCircle(0, 0, 0, false));
    }
    var padded = {};
    for (var k in scene) if (Object.prototype.hasOwnProperty.call(scene, k)) padded[k] = scene[k];
    padded.bodies = bodies;
    return { scene: padded, spawnBase: authored };
  }

  // The persistent per-spawn-slot state stepOnceCallArgs passes by
  // reference: one alive flag and one lineage tag per slot, plus the shared
  // liveCount. Emitted by whoever assembles the locals a step loop runs
  // against, alongside generateBodyLocalsGLSL / the grid's canonical
  // declarations - the slots' Body and BODYn_* locals come from those, since
  // a dead slot is an ordinary (radius-0) body as far as they're concerned.
  function generateSpawnSlotLocalsGLSL(n, spawnBase) {
    var slots = spawnSlotsFrom(n, spawnBase);
    if (!slots.length) return "";
    var lines = [];
    slots.forEach(function (i) {
      lines.push("bool alive" + i + " = false;");
      // -1 rather than i: a slot that has never been filled belongs to no
      // lineage, and must not be mistaken for one by the output average.
      lines.push("int lineage" + i + " = -1;");
    });
    lines.push("int liveCount = " + spawnBase + ";");
    return lines.join("\n");
  }

  // Generates the specialized stepOnce() for this scene's topology (body
  // types, which pairs can collide, which hinges connect what) as a function
  // of EXPLICIT body/mass parameters rather than implicit globals. This has
  // to be true for any caller whose initial body state isn't a compile-time
  // literal (the per-pixel fractal grid): GLSL requires GLOBAL variable
  // initializers to be constant expressions - the same restriction that
  // already forced per-pair contact variables to live inside stepOnce()
  // itself rather than at file scope - so once a body's starting position
  // depends on a runtime value, nothing about it can be a global, including
  // the function that mutates it.
  // frame ({ width, height }), when given, wraps every non-static body's
  // position Pac-Man-style once it crosses an edge - an object whose center
  // moves past the right edge reappears the same distance past the left
  // edge (and correspondingly for the other three edges), velocity
  // untouched. Omitted entirely (undefined) for every caller that doesn't
  // have a locked frame size yet - this is a per-scene opt-in, not a always
  // -on behavior, so existing scenes/tests with no frameWidth/frameHeight
  // keep exactly their old unbounded-fall behavior.
  // precision: "f32" (default), or one of the multi-float ones - "df", "tf",
  // "qf" (see PhysicsDF). Float32 and multi-float differ only in spelling -
  // same structure, same order of operations, same comments - because a
  // single generator emitting both is the only thing keeping them in step.
  // mutualGravity: bake the n-body attraction in place of the constant
  // downward pull. A codegen flag rather than a uniform because the scene is
  // already compiled per-scene, so the unused mode simply isn't emitted.
  // collisions: whether this scene's collisions are on. Everything else the
  // toggle controls is already carried by `pairs` being empty, but Mutual
  // Gravity's accel loop walks every body rather than the pair list, and it
  // needs to know - see PhysicsEngine.computeAccelerations for why the
  // touching-bodies rule becomes a discontinuity once collisions are off.
  // Defaults to on when omitted, matching PhysicsEngine.collisionsEnabled.
  // spawnBase: the authored body count of a splitter scene - see
  // padSceneForSplitting and spawnSlotsFrom. Omitted for every other scene.
  // springs: the scene's springs - see "Springs, as the generators see them"
  // above. Omitted for every scene without one.
  function generateStepOnceGLSL(n, consts, pairs, hingeAnchors, frame, precision, mutualGravity, collisions, spawnBase, springs) {
    var df = global.PhysicsDF.isExtended(precision);
    if (df) global.PhysicsDF.usePrecision(precision);
    var collisionsOn = collisions !== false;
    var springList = springs || [];
    var PE = global.PhysicsEngine;
    // Which bodies a spring pulls on at all, and which of those it can TURN
    // (attached off-center) - see the Springs section below, which is what
    // these are for. Worked out up here because the second decides whether
    // springSpinGLSL has to be emitted ahead of stepOnce().
    var sprung = {}, turned = {};
    springList.forEach(function (sp) {
      if (!sp.aIsWorld && !consts[sp.a].isAnchored) { sprung[sp.a] = true; if (!sp.localA.zero) turned[sp.a] = true; }
      if (!consts[sp.b].isAnchored) { sprung[sp.b] = true; if (!sp.localB.zero) turned[sp.b] = true; }
    });
    // One generator, two spellings. GLSL can't give a user type operators,
    // so the df path has to say dfAdd(a, b) where float32 says a + b - but
    // the STRUCTURE of the step is identical, and keeping it in one
    // function is what stops the two from drifting apart. Anything that
    // reads the same in both modes (a struct field assignment, a bool) is
    // simply not routed through here.
    var E = df ? {
      body: "dbody", bodyType: "DBody", scalarType: "MF", vecType: "DVec2",
      DT: "DF_DT", GRAVITY: "DF_GRAVITY",
      zero: "DF_ZERO", one: "DF_ONE",
      vec: function (x, y) { return "dv2(" + x + ", " + y + ")"; },
      add: function (a, b) { return "dfAdd(" + a + ", " + b + ")"; },
      sub: function (a, b) { return "dfSub(" + a + ", " + b + ")"; },
      mul: function (a, b) { return "dfMul(" + a + ", " + b + ")"; },
      min: function (a, b) { return "dfMin(" + a + ", " + b + ")"; },
      less: function (a, b) { return "dfLess(" + a + ", " + b + ")"; },
      // a <= b, spelled as "not greater" because that is the one the df
      // library has.
      lessEq: function (a, b) { return "!dfGreater(" + a + ", " + b + ")"; },
      negVec: function (v) { return "dv2Neg(" + v + ")"; },
      zeroVec: "dv2Zero()",
      advanceVelocity: "dfAdvanceVelocity", noContact: "dfNoContact()",
      contactType: "DContact", contactPairType: "DContactPair",
      collideCircleCircle: "dfCollideCircleCircle", collideLineCircle: "dfCollideLineCircle",
      collideLineLine: "dfCollideLineLine",
      sweptCapsule: "dfSweptCapsuleCircleContact", halfThickness: "DF_HALF_LINE_THICKNESS",
      mouthHitType: "DMouthHit", mouthHitFn: "dfCollideFunnelMouthTHit",
      splitHitType: "DSplitHit", splitHitFn: "dfCollideSplitterShortSideTHit",
      solveContactVelocity: "dfSolveContactVelocity", solveContactPosition: "dfSolveContactPosition",
      solveHingeVelocity: "dfSolveHingeVelocity", solveHingePosition: "dfSolveHingePosition",
    } : {
      body: "body", bodyType: "Body", scalarType: "float", vecType: "vec2",
      DT: "DT", GRAVITY: "GRAVITY",
      zero: "0.0", one: "1.0",
      vec: function (x, y) { return "vec2(" + x + ", " + y + ")"; },
      add: function (a, b) { return "(" + a + ") + (" + b + ")"; },
      sub: function (a, b) { return "(" + a + ") - (" + b + ")"; },
      mul: function (a, b) { return "(" + a + ") * (" + b + ")"; },
      min: function (a, b) { return "min(" + a + ", " + b + ")"; },
      less: function (a, b) { return "(" + a + ") < (" + b + ")"; },
      lessEq: function (a, b) { return "(" + a + ") <= (" + b + ")"; },
      negVec: function (v) { return "-" + v; },
      zeroVec: "vec2(0.0)",
      advanceVelocity: "advanceVelocity", noContact: "noContact()",
      contactType: "Contact", contactPairType: "ContactPair",
      collideCircleCircle: "collideCircleCircle", collideLineCircle: "collideLineCircle",
      collideLineLine: "collideLineLine",
      sweptCapsule: "sweptCapsuleCircleContact", halfThickness: "LINE_THICKNESS * 0.5",
      mouthHitType: "MouthHit", mouthHitFn: "collideFunnelMouthTHit",
      splitHitType: "SplitHit", splitHitFn: "collideSplitterShortSideTHit",
      solveContactVelocity: "solveContactVelocity", solveContactPosition: "solveContactPosition",
      solveHingeVelocity: "solveHingeVelocity", solveHingePosition: "solveHingePosition",
    };
    function B(i) { return E.body + i; }

    // Funnel<->circle pairs are handled entirely separately below (a mouth
    // teleport isn't expressible as a Contact at all, and the 3 solid edges
    // don't fit the fixed 2-slot ContactPair every other pair type uses) -
    // pulled out of `pairs` here so the existing per-pair blocks below
    // (contact building, tHit fold, g_contact flags, the two solve loops)
    // can keep iterating a plain list of circle/line pairs, completely
    // unchanged. funnel<->line and funnel<->funnel aren't modeled yet either
    // (see physics-engine.js's collidePair) - dropped silently, exactly like
    // JS's collidePair returning null for them, rather than falling through
    // to the collideLineLine branch below and reading a funnel's undefined
    // "length".
    //
    // A funnel and a splitter are the same trapezoid with opposite roles for
    // its two parallel sides: the funnel's long mouth teleports and its
    // throat is a wall; the splitter's short throat splits and its mouth is
    // a wall. Both are pulled out of `pairs` here so the ordinary per-pair
    // blocks below stay a plain list of circle/line pairs, and each carries
    // which of its edges are walls so the shared emission can serve both.
    function isTrapezoid(t) { return t === "funnel" || t === "splitter"; }
    // Which of a trapezoid's four sides are walls, and in which order, per
    // kind. The two differ in exactly one entry: the funnel's short side is
    // solid and its long side teleports; the splitter's long side is solid
    // and its short side splits. Everything downstream - contact building,
    // the tHit fold, the contact flags, both solve loops - walks this list
    // and so serves both without knowing which it has.
    function wallsFor(kind) {
      return kind === "splitter"
        ? [["mouth", "mouthLeft", "mouthRight"], ["leg1", "mouthLeft", "throatLeft"], ["leg2", "mouthRight", "throatRight"]]
        : [["throat", "throatLeft", "throatRight"], ["leg1", "mouthLeft", "throatLeft"], ["leg2", "mouthRight", "throatRight"]];
    }
    // "Is this circle going THROUGH this trapezoid right now?" - in which
    // case the trapezoid's own solid edges must not push on it this step.
    // A funnel excludes the one it teleported through; a splitter excludes
    // the one it split at (its mouth and legs reach past the short side's
    // corners, so a ball entering off-center clips one on the very step it
    // splits, and the split then carries that bounce out with it). GLSL
    // twin of the two contact filters in physics-engine.js's step().
    function trapezoidExclusion(fp, fi, ci) {
      if (consts[ci].isAnchored) return "false";
      if (fp.kind === "funnel") return "(teleWon_" + ci + " && teleFunnel_" + ci + " == " + fi + ")";
      if (splittableCircles.indexOf(ci) === -1) return "false";
      return "(splitFound_" + ci + " && splitBy_" + ci + " == " + fi + ")";
    }
    var trapezoidPairs = [];
    var ordinaryPairs = pairs.filter(function (pair) {
      var tA = consts[pair[0]].type, tB = consts[pair[1]].type;
      if (!isTrapezoid(tA) && !isTrapezoid(tB)) return true;
      if (isTrapezoid(tA) !== isTrapezoid(tB) && (tA === "circle" || tB === "circle")) {
        var ti = isTrapezoid(tA) ? pair[0] : pair[1];
        var ci = tA === "circle" ? pair[0] : pair[1];
        trapezoidPairs.push({ trap: ti, circle: ci, kind: consts[ti].type, walls: wallsFor(consts[ti].type) });
      }
      return false;
    });
    var funnelPairs = trapezoidPairs.filter(function (tp) { return tp.kind === "funnel"; });
    var splitterPairs = trapezoidPairs.filter(function (tp) { return tp.kind === "splitter"; });
    // Every circle that could split this step, in ascending body index -
    // the same order physics-engine.js's step() applies its own splits in,
    // which is what decides who gets the last free slot when more than one
    // ball splits on the same step.
    var splittableCircles = [];
    splitterPairs.forEach(function (sp) {
      if (consts[sp.circle].isAnchored) return; // mirrors physics-engine.js's own guard
      if (splittableCircles.indexOf(sp.circle) === -1) splittableCircles.push(sp.circle);
    });
    splittableCircles.sort(function (a, b) { return a - b; });
    if (splitterPairs.length && (spawnBase === undefined || spawnBase === null)) {
      throw new Error("A splitter scene must be compiled from a padded scene - see PhysicsGPU.padSceneForSplitting");
    }
    var spawnSlots = spawnSlotsFrom(n, spawnBase);
    var isSpawnSlot = {};
    spawnSlots.forEach(function (i) { isSpawnSlot[i] = true; });
    // "Are BOTH of these actually in play?" - null when neither is a spawn
    // slot, which is every body in every scene without a splitter, so those
    // shaders emit no test at all and stay spelled exactly as they were.
    function bothAliveExpr(i, j) {
      if (!isSpawnSlot[i] && !isSpawnSlot[j]) return null;
      if (!isSpawnSlot[i]) return "alive" + j;
      if (!isSpawnSlot[j]) return "alive" + i;
      return "(alive" + i + " && alive" + j + ")";
    }

    var lines = [];
    // See the g_contactN assignments inside stepOnce() below for what these
    // are and why they're globals.
    for (var cd = 0; cd < n; cd++) lines.push("bool g_contact" + cd + " = false;");

    // ---- df only: segment geometry, built as seldom as the physics allows ----
    //
    // See physics-gpu-df.js's header. A line in a collision pair needs its
    // DSegment, a funnel/splitter its DTrapezoid - each costing a df sin/cos,
    // the most expensive thing in that library. A MOVABLE one is rebuilt once
    // per step (shared by every pair it is in, where the straight port
    // rebuilt it per pair). An ANCHORED one never moves, so it is built once
    // per run: into a global, on the first stepOnce() call that finds
    // g_dfStaticGeomReady false. Whoever declares a pixel's bodies clears
    // that flag (see staticGeometryResetGLSL), so a shader that simulates
    // several starting points in one invocation - the derived display modes'
    // stencil - rebuilds it for each.
    //
    // The float32 path is untouched by any of this: its sin/cos is a
    // hardware instruction, and its arithmetic stays exactly what it was.
    var segLines = {}, trapBodies = {};
    ordinaryPairs.forEach(function (pair) {
      pair.forEach(function (idx) { if (consts[idx].type === "line") segLines[idx] = true; });
    });
    trapezoidPairs.forEach(function (tp) { trapBodies[tp.trap] = true; });
    function segExpr(idx) { return consts[idx].isAnchored ? "g_dfSeg" + idx : "seg" + idx; }
    function trapExpr(idx) { return consts[idx].isAnchored ? "g_dfTrap" + idx : "trap" + idx; }
    var staticGeomLines = [];
    if (df) {
      Object.keys(segLines).forEach(function (idx) {
        if (!consts[idx].isAnchored) return;
        lines.push("DSegment g_dfSeg" + idx + ";");
        staticGeomLines.push("    g_dfSeg" + idx + " = dfLineSegment(" + B(idx) + ", BODY" + idx + "_HALF);");
      });
      Object.keys(trapBodies).forEach(function (idx) {
        if (!consts[idx].isAnchored) return;
        lines.push("DTrapezoid g_dfTrap" + idx + ";");
        staticGeomLines.push("    g_dfTrap" + idx + " = dfTrapezoid(" + B(idx) + ", dfMulPow2(BODY" + idx + "_HALF, 2.0));");
      });
    }
    lines.push("");
    if (Object.keys(turned).length) lines.push(springSpinGLSL(df), "");
    lines.push("void stepOnce(" + stepOnceParams(n, hingeAnchors, precision, spawnBase, springList).join(", ") + ") {");
    if (staticGeomLines.length) {
      lines.push("  if (!g_dfStaticGeomReady) {");
      staticGeomLines.forEach(function (l) { lines.push(l); });
      lines.push("    g_dfStaticGeomReady = true;");
      lines.push("  }");
    }
    // The df path never needs a stand-in body for the world pin - its hinge
    // solvers have world-pin forms that leave side A out altogether.
    if (!df && hingeAnchors.some(function (h) { return h.aIsWorld; })) {
      lines.push("  " + E.bodyType + " worldBody = " + E.bodyType + "(" +
        [E.zero, E.zero, E.zero, E.zero, E.zero, E.zero].join(", ") + ");");
    }

    // ---- This step's acceleration, per body ----
    //
    // Uniform gravity bakes to the same constant for everyone. Mutual
    // Gravity instead sums an inverse-square pull toward every other body -
    // the GLSL port of PhysicsEngine.computeAccelerations, and kept
    // deliberately line-for-line comparable to it.
    //
    // Carried at the pass's OWN precision, force included. The df pass used
    // to collapse each separation to float32 and run the force math there, on
    // the theory that only the accumulators need the extra digits - the same
    // theory measurement killed for the collision math (see
    // physics-gpu-df.js's header), and it fails here the same way. A float32
    // separation cannot tell two pixels apart until they differ by one of ITS
    // ULPs (~1e-5 px at a 100px separation), so every pixel inside that block
    // was handed an identical acceleration: the df accumulators faithfully
    // carried a starting difference the dynamics never responded to, and a
    // Mutual Gravity scene got barely past the float32 wall.
    //
    // Gravitational mass and reach are derived from BODY{i}_HALF rather than
    // baked, because the fractal grid can link a body's radius or length to a
    // pixel's coordinate: its size, and so its mass, varies per pixel. gravK
    // folds together density, the anchored 10x, and the shape's own constant
    // factor; reachK is how far the shape extends per unit of HALF. Both come
    // from PhysicsEngine's own gravitationalMass/halfExtent, evaluated on a
    // unit-HALF body, so a trapezoid gets the same closed forms the JS engine
    // uses rather than being mistaken for a line of the same HALF.
    function unitBodyOf(c) {
      if (c.type === "circle") return { type: "circle", radius: 1, isAnchored: c.isAnchored };
      if (c.type === "funnel" || c.type === "splitter") return { type: c.type, size: 2, isAnchored: c.isAnchored };
      return { type: "line", length: 2, isAnchored: c.isAnchored };
    }

    var accelExpr = {};
    if (mutualGravity) {
      var gravK = consts.map(function (c) { return global.PhysicsEngine.gravitationalMass(unitBodyOf(c)); });
      var reachK = consts.map(function (c) { return global.PhysicsEngine.halfExtent(unitBodyOf(c)); });
      var GRAV_G = global.PhysicsEngine.MUTUAL_GRAVITY_CONSTANT;
      // A dead spawn slot is not a body yet: it neither pulls nor is pulled,
      // matching the JS engine, where it simply does not exist. (It is also
      // what keeps two dead slots parked on the same point from dividing
      // zero by zero.)
      function gravGate(i, j, cond) {
        var gate = bothAliveExpr(i, j);
        return gate ? "(" + cond + ") && " + gate : cond;
      }

      if (df) {
        var dfnumG = global.PhysicsDF.num;
        for (var mdf = 0; mdf < n; mdf++) {
          var halfDf = "BODY" + mdf + "_HALF";
          lines.push("  MF gravReach" + mdf + " = " +
            (reachK[mdf] === 1 ? halfDf : "dfMul(" + halfDf + ", " + dfnumG(reachK[mdf]) + ")") + ";");
          // G is folded into the mass here, once per body, so each pair below
          // pays one multiply for it rather than two.
          lines.push("  MF gravGM" + mdf + " = dfMul(" + dfnumG(GRAV_G * gravK[mdf]) + ", " +
            (consts[mdf].type === "circle" ? "dfSqr(" + halfDf + ")" : halfDf) + ");");
        }
        for (var adf = 0; adf < n; adf++) {
          if (!consts[adf].isAnchored) lines.push("  DVec2 gravAcc" + adf + " = dv2Zero();");
        }
        // Once per UNORDERED pair: the separation, its square and the
        // inverse-cube factor are shared by both directions, and in df those
        // are the expensive part. b pulls a along +d and a pulls b along -d,
        // and each body still accumulates its partners in ascending index
        // order, exactly as PhysicsEngine.computeAccelerations does.
        for (var pa = 0; pa < n; pa++) {
          for (var pb = pa + 1; pb < n; pb++) {
            if (consts[pa].isAnchored && consts[pb].isAnchored) continue;
            lines.push("  {");
            lines.push("    DVec2 gd = dv2(dfSub(dbody" + pb + ".x, dbody" + pa + ".x), dfSub(dbody" + pb + ".y, dbody" + pa + ".y));");
            lines.push("    MF gr2 = dv2LengthSq(gd);");
            lines.push("    MF gContact = dfAdd(gravReach" + pa + ", gravReach" + pb + ");");
            lines.push("    MF gContact2 = dfSqr(gContact);");
            // Compared in df: this is a branch, and a float32 comparison would
            // put its boundary on a float32 grid.
            var outside = "!dfLess(gr2, gContact2)";
            var applyLines = [];
            if (!consts[pa].isAnchored) applyLines.push("gravAcc" + pa + " = dv2Add(gravAcc" + pa + ", dv2Scale(gd, dfMul(gravGM" + pb + ", gk)));");
            if (!consts[pb].isAnchored) applyLines.push("gravAcc" + pb + " = dv2Sub(gravAcc" + pb + ", dv2Scale(gd, dfMul(gravGM" + pa + ", gk)));");
            if (collisionsOn) {
              // Touching bodies pull on each other not at all - see
              // PhysicsEngine.computeAccelerations for why.
              lines.push("    if (" + gravGate(pa, pb, outside) + ") {");
              lines.push("      MF gk = dfDiv(DF_ONE, dfMul(gr2, dfSqrt(gr2)));");
              applyLines.forEach(function (l) { lines.push("      " + l); });
              lines.push("    }");
            } else {
              // The smooth interior law - same formula, same reason, same
              // comment as the JS engine's branch.
              var aliveOnly = bothAliveExpr(pa, pb);
              lines.push("    " + (aliveOnly ? "if (" + aliveOnly + ") " : "") + "{");
              lines.push("      MF gk;");
              lines.push("      if (" + outside + ") {");
              lines.push("        gk = dfDiv(DF_ONE, dfMul(gr2, dfSqrt(gr2)));");
              lines.push("      } else {");
              lines.push("        MF gu2 = dfDiv(gr2, gContact2);");
              lines.push("        MF gPoly = dfAdd(dfSub(" + dfnumG(35 / 8) + ", dfMul(" + dfnumG(21 / 4) + ", gu2)), dfMul(" + dfnumG(15 / 8) + ", dfSqr(gu2)));");
              lines.push("        gk = dfDiv(gPoly, dfMul(gContact2, gContact));");
              lines.push("      }");
              applyLines.forEach(function (l) { lines.push("      " + l); });
              lines.push("    }");
            }
            lines.push("  }");
          }
        }
        for (var edf = 0; edf < n; edf++) {
          if (!consts[edf].isAnchored) accelExpr[edf] = "gravAcc" + edf;
        }
      } else {
        for (var h32 = 0; h32 < n; h32++) {
          lines.push("  float fHalf" + h32 + " = BODY" + h32 + "_HALF;");
        }
        for (var m = 0; m < n; m++) {
          lines.push("  float gravMass" + m + " = " + fnum(gravK[m]) + " * fHalf" + m +
            (consts[m].type === "circle" ? " * fHalf" + m : "") + ";");
        }
        var reachExpr = consts.map(function (c, i) {
          return reachK[i] === 1 ? "fHalf" + i : "(" + fnum(reachK[i]) + " * fHalf" + i + ")";
        });
        for (var a = 0; a < n; a++) {
          if (consts[a].isAnchored) continue; // never accelerates, so never needs a sum
          lines.push("  vec2 gravAcc" + a + " = vec2(0.0);");
          for (var b2 = 0; b2 < n; b2++) {
            if (b2 === a) continue;
            lines.push("  {");
            lines.push("    vec2 d = vec2(body" + b2 + ".x - body" + a + ".x, body" + b2 + ".y - body" + a + ".y);");
            // Bodies that are touching pull on each other not at all - see
            // PhysicsEngine.computeAccelerations for why (short version: the
            // contact solver's positional correction would otherwise be lifting
            // the body out of a very steep well for free, inventing energy).
            // It also bounds this expression: r2 can never get near zero, so
            // there is no singularity to guard against.
            // With collisions off nothing supplies that force and bodies pass
            // through each other, so inside `contact` the pull follows the
            // smooth interior law down to zero instead of being switched off at
            // its rim - same reason, same formula, same comment as the JS
            // engine's branch.
            lines.push("    float contact = " + reachExpr[a] + " + " + reachExpr[b2] + ";");
            lines.push("    float r2 = dot(d, d);");
            if (collisionsOn) {
              lines.push("    if (" + gravGate(a, b2, "r2 >= contact * contact") + ") gravAcc" + a + " += (" +
                fnum(GRAV_G) + " * gravMass" + b2 + " / (r2 * sqrt(r2))) * d;");
            } else {
              lines.push("    float u2_" + b2 + " = r2 / (contact * contact);");
              lines.push("    float pull" + b2 + " = (r2 >= contact * contact)");
              lines.push("      ? " + fnum(GRAV_G) + " * gravMass" + b2 + " / (r2 * sqrt(r2))");
              lines.push("      : " + fnum(GRAV_G) + " * gravMass" + b2 + " / (contact * contact * contact) *");
              lines.push("        (35.0 / 8.0 - 21.0 / 4.0 * u2_" + b2 + " + 15.0 / 8.0 * u2_" + b2 + " * u2_" + b2 + ");");
              var aliveGate32 = bothAliveExpr(a, b2);
              lines.push("    " + (aliveGate32 ? "if (" + aliveGate32 + ") " : "") + "gravAcc" + a + " += pull" + b2 + " * d;");
            }
            lines.push("  }");
          }
          accelExpr[a] = "gravAcc" + a;
        }
      }
      lines.push("");
    }
    function gravityAccelFor(i) {
      if (mutualGravity) return accelExpr[i];
      return df ? "dv2(DF_ZERO, DF_GRAVITY)" : "vec2(0.0, GRAVITY)";
    }

    // ---- Springs ----
    //
    // The GLSL port of PhysicsEngine.addSpringAccelerations - the same law,
    // the same softened length, the same stability limit on the stiffness,
    // written to be read against it line for line. Each spring adds to the
    // linear acceleration of whatever it is tied to (on top of gravity,
    // whichever kind) and, where it is attached off-center, to an ANGULAR
    // acceleration that nothing else in the step contributes to: sprAlphaN
    // exists only for a body some spring can actually turn, and the two legs
    // below only mention it for those, so every other body's integration is
    // spelled exactly as it was.
    //
    // The stiffness limit is evaluated here, per step, from BODYn_INV_MASS /
    // INV_INERTIA and the anchors rather than baked in: all of those are
    // per-pixel values once an X/Y Input is linked to a size, and a pixel
    // whose body has shrunk is exactly the one the limit exists for.
    if (springList.length) {
      var slit = df ? global.PhysicsDF.num : fnum;
      for (var sb = 0; sb < n; sb++) {
        if (!sprung[sb]) continue;
        lines.push("  " + E.vecType + " sprAcc" + sb + " = " + E.zeroVec + ";");
        if (turned[sb]) lines.push("  " + E.scalarType + " sprAlpha" + sb + " = " + E.zero + ", sprSwing" + sb + " = " + E.zero + ";");
      }
      // df only: one sin/cos per body a spring is attached to off-center, shared
      // by every spring on it (an anchored body's lever arm still has to be
      // rotated into place, even though nothing will turn it).
      var armed = {};
      springList.forEach(function (sp) {
        if (!sp.aIsWorld && !sp.localA.zero) armed[sp.a] = true;
        if (!sp.localB.zero) armed[sp.b] = true;
      });
      if (df) {
        Object.keys(armed).forEach(function (idx) {
          lines.push("  MF sprSin" + idx + ", sprCos" + idx + "; dfSinCos(" + B(idx) + ".angle, sprSin" + idx + ", sprCos" + idx + ");");
        });
      }
      springList.forEach(function (sp, s) {
        var aMoves = !sp.aIsWorld && !consts[sp.a].isAnchored, bMoves = !consts[sp.b].isAnchored;
        if (!aMoves && !bMoves) return; // nothing here can move - the JS engine skips it too
        // One end: where it is in the world, its lever arm (null dead center
        // or on the background), and how readily it gives way.
        function end(which) {
          var idx = which === "A" ? sp.a : sp.b;
          var param = "SPRING" + s + "_" + which;
          if (which === "A" && sp.aIsWorld) return { point: param, arm: null, weight: null };
          var center = E.vec(B(idx) + ".x", B(idx) + ".y");
          var moves = !consts[idx].isAnchored;
          var zero = which === "A" ? sp.localA.zero : sp.localB.zero;
          if (zero) return { point: center, arm: null, weight: moves ? "BODY" + idx + "_INV_MASS" : null };
          var arm = "sprR" + which + s;
          lines.push("    " + E.vecType + " " + arm + " = " + (df
            ? "dv2RotateBy(" + param + ", sprSin" + idx + ", sprCos" + idx + ")"
            : "rotateVec(" + param + ", " + B(idx) + ".angle)") + ";");
          return {
            point: df ? "dv2Add(" + center + ", " + arm + ")" : center + " + " + arm,
            arm: arm,
            // The lever arm's length, for the swing tally below. Rotation
            // does not change it, so it comes off the local anchor.
            armLength: df ? "dfSqrt(dv2LengthSq(" + param + "))" : "length(" + param + ")",
            weight: !moves ? null : (df
              ? "dfAdd(BODY" + idx + "_INV_MASS, dfMul(BODY" + idx + "_INV_INERTIA, dv2LengthSq(" + param + ")))"
              : "(BODY" + idx + "_INV_MASS + BODY" + idx + "_INV_INERTIA * dot(" + param + ", " + param + "))"),
          };
        }
        lines.push("  {");
        var endA = end("A"), endB = end("B");
        var weights = [endA.weight, endB.weight].filter(Boolean);
        var stable = slit(PE.SPRING_STABILITY / (FIXED_DT * FIXED_DT));
        // The law itself - PhysicsEngine.springForceFactor, and see the Springs
        // header there for why it leaves Hooke inside a core: exact
        // 1 - rest/r outside c = SPRING_CORE * rest, a polynomial in r^2
        // inside that meets it in value, slope and curvature and reaches zero
        // at zero length, so nothing flips as the ends pass through each
        // other. A rest length of exactly zero has no core and no flip - the
        // factor is exactly 1 in the JS engine too - so it needs no length at
        // all, unless an end that can turn has a lever arm for the swing
        // tally to weigh.
        var limited = (aMoves && endA.arm) || (bMoves && endB.arm);
        var hasRest = sp.restLength !== 0;
        var core = PE.SPRING_CORE * sp.restLength;
        if (df) {
          lines.push("    DVec2 sprD = dv2Sub(" + endB.point + ", " + endA.point + ");");
          lines.push("    MF sprK = dfMin(" + slit(sp.stiffness) + ", dfDiv(" + stable + ", " +
            (weights.length === 2 ? "dfAdd(" + weights[0] + ", " + weights[1] + ")" : weights[0]) + "));");
          if (hasRest || limited) lines.push("    MF sprR2 = dv2LengthSq(sprD);", "    MF sprR = dfSqrt(sprR2);");
          if (hasRest) {
            lines.push("    MF sprQ;");
            // Compared in df: this is a branch, and a float32 comparison
            // would put its boundary on a float32 grid.
            lines.push("    if (!dfLess(sprR2, " + slit(core * core) + ")) {");
            lines.push("      sprQ = dfSub(DF_ONE, dfDiv(" + slit(sp.restLength) + ", sprR));");
            lines.push("    } else {");
            lines.push("      MF sprU = dfDiv(sprR2, " + slit(core * core) + ");");
            lines.push("      sprQ = dfSub(DF_ONE, dfMul(" + slit(sp.restLength / core) + ", dfAdd(dfSub(" + slit(15 / 8) + ", dfMul(" + slit(5 / 4) + ", sprU)), dfMul(" + slit(3 / 8) + ", dfSqr(sprU)))));");
            lines.push("    }");
          }
          lines.push("    MF sprF = " + (hasRest ? "dfMul(sprK, sprQ)" : "sprK") + ";");
          lines.push("    DVec2 sprFv = dv2Scale(sprD, sprF);");
          if (limited) lines.push("    MF sprTension = dfMul(dfAbs(sprF), sprR);");
        } else {
          lines.push("    vec2 sprD = (" + endB.point + ") - (" + endA.point + ");");
          lines.push("    float sprK = min(" + slit(sp.stiffness) + ", " + stable + " / (" + weights.join(" + ") + "));");
          if (hasRest || limited) lines.push("    float sprR2 = dot(sprD, sprD);", "    float sprR = sqrt(sprR2);");
          if (hasRest) {
            lines.push("    float sprU = sprR2 / " + slit(core * core) + ";");
            lines.push("    float sprQ = (sprR2 >= " + slit(core * core) + ")");
            lines.push("      ? 1.0 - " + slit(sp.restLength) + " / sprR");
            lines.push("      : 1.0 - " + slit(sp.restLength / core) + " * (15.0 / 8.0 - 5.0 / 4.0 * sprU + 3.0 / 8.0 * sprU * sprU);");
          }
          lines.push("    float sprF = " + (hasRest ? "sprK * sprQ" : "sprK") + ";");
          lines.push("    vec2 sprFv = sprF * sprD;");
          if (limited) lines.push("    float sprTension = abs(sprF) * sprR;");
        }
        // The force on end A points at B while the spring is stretched; end B
        // gets its opposite.
        [[sp.a, endA, aMoves, true], [sp.b, endB, bMoves, false]].forEach(function (side) {
          var idx = side[0], e = side[1], plus = side[3];
          if (!side[2]) return;
          // The torque, and this end's share of the body's `swing` - the
          // pendulum-like oscillation about its own center that the spring's
          // TENSION drives, which springSpin integrates implicitly once it
          // is too fast for the step (see PhysicsEngine.springSpin).
          if (df) {
            lines.push("    sprAcc" + idx + " = " + (plus ? "dv2Add" : "dv2Sub") + "(sprAcc" + idx + ", dv2Scale(sprFv, BODY" + idx + "_INV_MASS));");
            if (e.arm) {
              lines.push("    sprAlpha" + idx + " = " + (plus ? "dfAdd" : "dfSub") + "(sprAlpha" + idx +
                ", dfMul(dv2Cross(" + e.arm + ", sprFv), BODY" + idx + "_INV_INERTIA));");
              lines.push("    sprSwing" + idx + " = dfAdd(sprSwing" + idx + ", dfMul(dfMul(sprTension, " + e.armLength + "), BODY" + idx + "_INV_INERTIA));");
            }
          } else {
            lines.push("    sprAcc" + idx + " " + (plus ? "+" : "-") + "= sprFv * BODY" + idx + "_INV_MASS;");
            if (e.arm) {
              lines.push("    sprAlpha" + idx + " " + (plus ? "+" : "-") + "= (" + e.arm + ".x * sprFv.y - " + e.arm + ".y * sprFv.x) * BODY" + idx + "_INV_INERTIA;");
              lines.push("    sprSwing" + idx + " += sprTension * " + e.armLength + " * BODY" + idx + "_INV_INERTIA;");
            }
          }
        });
        lines.push("  }");
      });
      for (var sa = 0; sa < n; sa++) {
        if (!sprung[sa]) continue;
        lines.push("  " + E.vecType + " accel" + sa + " = " + (df
          ? "dv2Add(" + gravityAccelFor(sa) + ", sprAcc" + sa + ")"
          : gravityAccelFor(sa) + " + sprAcc" + sa) + ";");
      }
      lines.push("");
    }
    function accelFor(i) { return sprung[i] ? "accel" + i : gravityAccelFor(i); }
    // A turned body's spin after `t` of this step's torque - see springSpinGLSL.
    function spinExpr(i, t) {
      return (df ? "dfSpringSpin(" : "springSpin(") + B(i) + ".w, sprAlpha" + i + ", sprSwing" + i + ", " + t + ")";
    }

    // Entering velocity (u, before any gravity this step) and the
    // whole-step gravity-advanced velocity (vFull) for every non-anchored
    // body. vFull drives both detection below AND leg 1's position move -
    // using anything else for one but not the other would let the body
    // travel along a different line than the one it was swept against.
    for (var g = 0; g < n; g++) {
      if (consts[g].isAnchored) continue;
      lines.push("  " + E.vecType + " u" + g + " = " + E.vec(B(g) + ".vx", B(g) + ".vy") + ";");
      lines.push("  " + E.vecType + " vFull" + g + " = " + E.advanceVelocity + "(u" + g + ", " + E.DT + ", " + accelFor(g) + ");");
    }
    lines.push("");

    // Detect against PROBE bodies (real position, velocity = vFull) rather
    // than the raw pre-gravity bodies, so the swept tests solve against the
    // same straight-line motion leg 1 is about to take. An anchored body's
    // probe is just itself - it never moves, so vFull was never computed
    // for it above.
    for (var p = 0; p < n; p++) {
      if (consts[p].isAnchored) continue;
      lines.push("  " + E.bodyType + " probe" + p + " = " + B(p) + "; probe" + p + ".vx = vFull" + p + ".x; probe" + p + ".vy = vFull" + p + ".y;");
    }
    lines.push("");

    function probeRef(idx) { return consts[idx].isAnchored ? B(idx) : "probe" + idx; }

    // df only: this step's geometry for every MOVABLE line and trapezoid a
    // pair below is about to test (the anchored ones were built once, above).
    // From the probe, like the tests themselves - same position and angle as
    // the body, which is all a segment is made of.
    if (df) {
      Object.keys(segLines).forEach(function (idx) {
        if (consts[idx].isAnchored) return;
        lines.push("  DSegment seg" + idx + " = dfLineSegment(probe" + idx + ", BODY" + idx + "_HALF);");
      });
      Object.keys(trapBodies).forEach(function (idx) {
        if (consts[idx].isAnchored) return;
        lines.push("  DTrapezoid trap" + idx + " = dfTrapezoid(probe" + idx + ", dfMulPow2(BODY" + idx + "_HALF, 2.0));");
      });
    }
    // A line's second argument to its collide function: its half-length in
    // float32 (the function derives the endpoints itself), its prebuilt
    // segment in df.
    function lineArg(idx) { return df ? segExpr(idx) : "BODY" + idx + "_HALF"; }
    // Only a line<->line pair can ever fill its second contact slot - see
    // the solve loops below, which skip c1 for every other pair.
    function pairSlots(pair) {
      return consts[pair[0]].type === "line" && consts[pair[1]].type === "line" ? ["c0", "c1"] : ["c0"];
    }

    // Contacts are computed ONCE per stepOnce() call and reused across every
    // velocity/position iteration within that step (matching JS: step()
    // detects contacts once, then solves them repeatedly) - so these must be
    // LOCAL variables, not global initializers, for the same reason as above.
    ordinaryPairs.forEach(function (pair) {
      var i = pair[0], j = pair[1];
      var tA = consts[i].type, tB = consts[j].type;
      var varName = "pair_" + i + "_" + j;
      var refI = probeRef(i), refJ = probeRef(j);
      if (tA === "circle" && tB === "circle") {
        lines.push("  " + E.contactPairType + " " + varName + " = " + E.contactPairType + "(" + E.collideCircleCircle + "(" + refI + ", BODY" + i + "_HALF, " + refJ + ", BODY" + j + "_HALF), " + E.noContact + ");");
      } else if (tA === "line" && tB === "circle") {
        lines.push("  " + E.contactPairType + " " + varName + " = " + E.contactPairType + "(" + E.collideLineCircle + "(" + refI + ", " + lineArg(i) + ", " + refJ + ", BODY" + j + "_HALF), " + E.noContact + ");");
      } else if (tA === "circle" && tB === "line") {
        // collideLineCircle(line, circle) always takes (line, circle) in
        // that order, so calling it as (body_j=line, body_i=circle) here
        // returns rA/rB for (line=j, circle=i) - the opposite of this
        // pair's own i/j. Swap them back along with flipping the normal,
        // matching physics-engine.js's collidePair - see its own comment.
        lines.push("  " + E.contactType + " " + varName + "_raw = " + E.collideLineCircle + "(" + refJ + ", " + lineArg(j) + ", " + refI + ", BODY" + i + "_HALF);");
        lines.push("  " + varName + "_raw.normal = " + E.negVec(varName + "_raw.normal") + ";");
        lines.push("  { " + E.vecType + " tmp_" + i + "_" + j + " = " + varName + "_raw.rA; " + varName + "_raw.rA = " + varName + "_raw.rB; " + varName + "_raw.rB = tmp_" + i + "_" + j + "; }");
        lines.push("  " + E.contactPairType + " " + varName + " = " + E.contactPairType + "(" + varName + "_raw, " + E.noContact + ");");
      } else {
        lines.push("  " + E.contactPairType + " " + varName + " = " + E.collideLineLine + "(" + refI + ", " + lineArg(i) + ", " + refJ + ", " + lineArg(j) + ");");
      }
    });
    // Any pair involving a spawn slot only counts while that slot is in
    // play. Emitted as a separate pass over the same list rather than
    // threaded into each branch above, so the four shape-specific spellings
    // stay exactly as they were. Everything downstream - the contact flags,
    // the tHit fold, both solve loops - already treats a !hit contact as
    // nothing happened, so clearing the flag is the whole suppression.
    ordinaryPairs.forEach(function (pair) {
      var gate = bothAliveExpr(pair[0], pair[1]);
      if (!gate) return;
      var varName = "pair_" + pair[0] + "_" + pair[1];
      lines.push("  if (!" + gate + ") { " + varName + ".c0.hit = false; " + varName + ".c1.hit = false; }");
    });
    // df only: everything about each contact that no solver iteration can
    // change, built once here instead of on all 8 + 4 of them - see
    // dfPrepareContact. After the gating above, so a suppressed contact is
    // never prepared.
    function prepareContactLine(contactExpr, a, b) {
      return "  dfPrepareContact(" + contactExpr + ", BODY" + a + "_INV_MASS, BODY" + a + "_INV_INERTIA, BODY" + b + "_INV_MASS, BODY" + b + "_INV_INERTIA);";
    }
    if (df) {
      ordinaryPairs.forEach(function (pair) {
        pairSlots(pair).forEach(function (slot) {
          lines.push(prepareContactLine("pair_" + pair[0] + "_" + pair[1] + "." + slot, pair[0], pair[1]));
        });
      });
    }
    lines.push("");

    // "Is this body touching anything at all this step?", published per body
    // for whoever called stepOnce() - the fractal grid's Bounce Count output
    // counts the steps where one of these flips false->true. Globals rather
    // than more inout parameters: every existing caller (the single-scene
    // trajectory player, the hover replay, the grid) would otherwise have to
    // thread a parameter it has no use for, and a bool with a constant
    // initializer is legal at global scope (unlike the ContactPairs above,
    // whose initializers are function calls - see their own comment).
    // Assigned (not accumulated) every call, so they always describe the step
    // that just ran.
    for (var cf = 0; cf < n; cf++) {
      var touching = [];
      ordinaryPairs.forEach(function (pair) {
        if (pair[0] !== cf && pair[1] !== cf) return;
        var vn = "pair_" + pair[0] + "_" + pair[1];
        touching.push("(" + pairSlots(pair).map(function (slot) { return vn + "." + slot + ".hit"; }).join(" || ") + ")");
      });
      lines.push("  g_contact" + cf + " = " + (touching.length ? touching.join(" || ") : "false") + ";");
    }
    lines.push("");

    // Per-body tHit: the earliest contact instant among everything that
    // body touches this step, defaulting to DT (no contact -> the whole
    // step is "leg 1", leg 2 never runs - see leg 2's own comment). A slot
    // that did not hit still carries a tHit (0.0, same as an
    // already-touching contact's), so an unguarded min() would drag every
    // body's tHit down to 0.0. Fold in a slot's tHit only when it actually
    // hit - and only the slots this kind of pair can fill at all.
    function contactTHitExpr(varName, slot) {
      return varName + "." + slot + ".hit ? " + varName + "." + slot + ".tHit : " + E.DT;
    }
    for (var q = 0; q < n; q++) {
      if (consts[q].isAnchored) continue;
      lines.push("  " + E.scalarType + " body" + q + "THit = " + E.DT + ";");
    }
    ordinaryPairs.forEach(function (pair) {
      var i = pair[0], j = pair[1];
      var varName = "pair_" + i + "_" + j;
      var pairMin = pairSlots(pair).map(function (slot) { return contactTHitExpr(varName, slot); })
        .reduce(function (acc, expr) { return E.min(acc, expr); });
      if (!consts[i].isAnchored) {
        lines.push("  body" + i + "THit = " + E.min("body" + i + "THit", pairMin) + ";");
      }
      if (!consts[j].isAnchored) {
        lines.push("  body" + j + "THit = " + E.min("body" + j + "THit", pairMin) + ";");
      }
    });
    lines.push("");

    // ---- Funnel/splitter <-> circle pairs ----
    //
    // A mouth teleport isn't a Contact (no impulse - see this file's Funnel
    // header comment and physics-engine.js's own), and 3 solid edges don't
    // fit the fixed 2-slot ContactPair every ordinary pair above uses, so
    // this is entirely separate codegen rather than a branch inside it.
    // Direct port of physics-engine.js's step(): fold the 3 solid edges'
    // tHit into both bodies' THit exactly like an ordinary contact would,
    // THEN resolve the teleport against that (a tie goes to the teleport),
    // THEN - only once teleWon is known - fold the solid edges' touching
    // flags into g_contact, excluding the specific funnel a teleport just
    // won against (its rA/rB would otherwise be evaluated against this
    // circle's stale PRE-teleport position).
    //
    // Written once for both precisions, like everything else in this
    // function. The one structural difference: float32 rebuilds the
    // trapezoid's vertices per pair (and again inside the trigger test),
    // where df reads the body's one prebuilt DTrapezoid - see segExpr above.
    var funnelPairsByCircle = {};
    funnelPairs.forEach(function (fp) {
      (funnelPairsByCircle[fp.circle] = funnelPairsByCircle[fp.circle] || []).push(fp.trap);
    });
    if (trapezoidPairs.length) {
      trapezoidPairs.forEach(function (fp) {
        var fi = fp.trap, ci = fp.circle;
        var refF = probeRef(fi), refC = probeRef(ci);
        var vn = "trap_" + fi + "_" + ci;
        // A dead spawn slot is a radius-0 circle parked at the origin: it
        // would still register capsule contacts against anything it happens
        // to be sitting inside, so every hit this pair can produce - walls
        // and trigger alike - is suppressed while either body is out of
        // play. Suppressing at the Contact rather than around the whole
        // block keeps the variables in scope for the solve loops below,
        // which run unconditionally and already no-op on a !hit contact.
        var gate = bothAliveExpr(fi, ci);
        var sizeArg = df ? trapExpr(fi) : "BODY" + fi + "_HALF * 2.0";
        if (!df) lines.push("  FunnelVerts " + vn + "_v = funnelVertices(" + refF + ", " + sizeArg + ");");
        fp.walls.forEach(function (w) {
          var segArgs = df ? trapExpr(fi) + "." + w[0] : vn + "_v." + w[1] + ", " + vn + "_v." + w[2];
          lines.push("  " + E.contactType + " " + vn + "_" + w[0] + " = " + E.sweptCapsule + "(" + segArgs +
            ", " + E.vec(refF + ".vx", refF + ".vy") + ", " + E.vec(refF + ".x", refF + ".y") + ", " + refC + ", BODY" + ci + "_HALF, " + E.halfThickness + ");");
          if (gate) lines.push("  if (!" + gate + ") " + vn + "_" + w[0] + ".hit = false;");
          // The trapezoid is side A of each wall contact, the circle side B -
          // the order both solve loops below pass them in.
          if (df) lines.push(prepareContactLine(vn + "_" + w[0], fi, ci));
        });
        if (fp.kind === "funnel") {
          lines.push("  " + E.mouthHitType + " " + vn + "_mouth = " + E.mouthHitFn + "(" + refF + ", " + sizeArg + ", " + refC + ", BODY" + ci + "_HALF);");
          if (gate) lines.push("  if (!" + gate + ") " + vn + "_mouth.hit = false;");
        } else {
          // NOT folded into either body's tHit, matching
          // physics-engine.js's step(): a split is applied at the very end
          // of the step, off the fully integrated position, so it takes no
          // part in the leg-1/leg-2 sub-stepping the way a funnel teleport
          // does.
          lines.push("  " + E.splitHitType + " " + vn + "_split = " + E.splitHitFn + "(" + refF + ", " + sizeArg + ", " + refC + ", BODY" + ci + "_HALF);");
          if (gate) lines.push("  if (!" + gate + ") " + vn + "_split.hit = false;");
        }
        var wallTHits = fp.walls.map(function (w) { return vn + "_" + w[0] + ".hit ? " + vn + "_" + w[0] + ".tHit : " + E.DT; });
        lines.push("  " + E.scalarType + " " + vn + "_solidTHit = " + E.min(wallTHits[0], E.min(wallTHits[1], wallTHits[2])) + ";");
        if (!consts[fi].isAnchored) lines.push("  body" + fi + "THit = " + E.min("body" + fi + "THit", vn + "_solidTHit") + ";");
        if (!consts[ci].isAnchored) lines.push("  body" + ci + "THit = " + E.min("body" + ci + "THit", vn + "_solidTHit") + ";");
      });
      lines.push("");

      Object.keys(funnelPairsByCircle).forEach(function (ciStr) {
        var ci = Number(ciStr);
        if (consts[ci].isAnchored) return; // never moves - leg 1 skips it entirely, so a teleport would be meaningless
        // teleFound_{ci} matters as its own flag, separate from comparing
        // tHit values: DT is both "the whole step, no funnel mouth found"
        // AND (by default) "the whole step, no ordinary contact either" -
        // without a found flag, a step with neither would compare DT <= DT
        // and read as a trivially-true teleport with a meaningless zero
        // target, exactly the bug this comment is here to keep from coming
        // back (mirrors physics-engine.js's `if (tp && ...)`, where tp is
        // null - not a tHit value - when nothing was found).
        lines.push("  " + E.scalarType + " teleTHit_" + ci + " = " + E.DT + ";");
        lines.push("  " + E.vecType + " teleTarget_" + ci + " = " + E.zeroVec + ";");
        lines.push("  int teleFunnel_" + ci + " = -1;");
        lines.push("  bool teleFound_" + ci + " = false;");
        funnelPairsByCircle[ci].forEach(function (fi) {
          var vn = "trap_" + fi + "_" + ci;
          lines.push("  if (" + vn + "_mouth.hit && (!teleFound_" + ci + " || " + E.less(vn + "_mouth.tHit", "teleTHit_" + ci) + ")) { teleTHit_" + ci + " = " +
            vn + "_mouth.tHit; teleTarget_" + ci + " = " + vn + "_mouth.target; teleFunnel_" + ci + " = " + fi + "; teleFound_" + ci + " = true; }");
        });
        lines.push("  bool teleWon_" + ci + " = teleFound_" + ci + " && " + E.lessEq("teleTHit_" + ci, "body" + ci + "THit") + ";");
        lines.push("  if (teleWon_" + ci + ") body" + ci + "THit = teleTHit_" + ci + ";");
      });
      lines.push("");

      // Which splitter (if any) each circle is passing through this step,
      // resolved HERE - before the contact flags and both solve loops below
      // - rather than where the split is applied at the end of the step,
      // because those three all have to know about it. Earliest hit wins
      // when a circle crosses more than one short side in the same step, the
      // same shape as the funnel mouth's resolution just above and as
      // physics-engine.js's own splitHit[] fold.
      splittableCircles.forEach(function (ci) {
        lines.push("  bool splitFound_" + ci + " = false;");
        lines.push("  int splitBy_" + ci + " = -1;");
        lines.push("  " + E.scalarType + " splitTHit_" + ci + " = " + E.DT + ";");
        lines.push("  " + E.vecType + " splitOff1_" + ci + " = " + E.zeroVec + ";");
        lines.push("  " + E.vecType + " splitOff2_" + ci + " = " + E.zeroVec + ";");
        splitterPairs.forEach(function (sp) {
          if (sp.circle !== ci) return;
          var vn = "trap_" + sp.trap + "_" + ci;
          lines.push("  if (" + vn + "_split.hit && (!splitFound_" + ci + " || " + E.less(vn + "_split.tHit", "splitTHit_" + ci) + ")) { " +
            "splitTHit_" + ci + " = " + vn + "_split.tHit; " +
            "splitOff1_" + ci + " = " + vn + "_split.offset1; " +
            "splitOff2_" + ci + " = " + vn + "_split.offset2; " +
            "splitBy_" + ci + " = " + sp.trap + "; " +
            "splitFound_" + ci + " = true; }");
        });
      });
      if (splittableCircles.length) lines.push("");

      trapezoidPairs.forEach(function (fp) {
        var fi = fp.trap, ci = fp.circle;
        var vn = "trap_" + fi + "_" + ci;
        var excluded = trapezoidExclusion(fp, fi, ci);
        var anyHit = "(" + fp.walls.map(function (w) { return vn + "_" + w[0] + ".hit"; }).join(" || ") + ")";
        lines.push("  g_contact" + fi + " = g_contact" + fi + " || (!" + excluded + " && " + anyHit + ");");
        lines.push("  g_contact" + ci + " = g_contact" + ci + " || (!" + excluded + " && " + anyHit + ");");
      });
      lines.push("");
    }

    // Leg 1: move at vFull for tHit - matching detection exactly - then
    // drop velocity to vPre (gravity applied only up to tHit, not the whole
    // step) before the impulse solve runs. Reflection doesn't commute with
    // adding gravity: reflecting v+g*DT (this step's full gravity, as if
    // the contact had waited until the very end to be noticed) differs from
    // reflecting v and then adding g*DT (as if it were noticed at the very
    // start) by 2*(g.n)*DT along the normal - up to a real, visible amount
    // per step. That gap is what made a bounce's outcome depend on which
    // discrete step happened to catch it. Using each contact's own tHit
    // here closes it: the impulse always reflects the velocity the body
    // actually had at the true contact instant, not a full step of gravity
    // early or late.
    for (var g3 = 0; g3 < n; g3++) {
      if (consts[g3].isAnchored) continue;
      var t1 = "body" + g3 + "THit";
      // A body that WON a teleport this step (see the Funnel block above)
      // gets its position OVERRIDDEN to the funnel's throat center instead
      // of moved by vFull*tHit - that is the entire teleport. Velocity
      // below is computed exactly the same way regardless: gravity applied
      // up to tHit, nothing reflected - "keeps the same velocity" through a
      // position discontinuity.
      if (funnelPairsByCircle[g3]) {
        lines.push("  if (teleWon_" + g3 + ") { " + B(g3) + ".x = teleTarget_" + g3 + ".x; " + B(g3) + ".y = teleTarget_" + g3 + ".y; } else { " +
          (df
            ? B(g3) + ".x = " + E.add(B(g3) + ".x", E.mul("vFull" + g3 + ".x", t1)) + "; " + B(g3) + ".y = " + E.add(B(g3) + ".y", E.mul("vFull" + g3 + ".y", t1)) + "; }"
            : B(g3) + ".x += vFull" + g3 + ".x * " + t1 + "; " + B(g3) + ".y += vFull" + g3 + ".y * " + t1 + "; }"));
      } else {
        lines.push("  " + B(g3) + ".x = " + E.add(B(g3) + ".x", E.mul("vFull" + g3 + ".x", t1)) + ";");
        lines.push("  " + B(g3) + ".y = " + E.add(B(g3) + ".y", E.mul("vFull" + g3 + ".y", t1)) + ";");
      }
      if (turned[g3]) {
        // The angular twin of the lines around it, for a body a spring can
        // turn: rotate at the WHOLE step's spin (as the position moves at
        // vFull), then leave `w` with only the torque that had acted by tHit.
        lines.push("  " + B(g3) + ".angle = " + E.add(B(g3) + ".angle", E.mul(spinExpr(g3, E.DT), t1)) + ";");
        lines.push("  " + B(g3) + ".w = " + spinExpr(g3, t1) + ";");
      } else {
        lines.push("  " + B(g3) + ".angle = " + E.add(B(g3) + ".angle", E.mul(B(g3) + ".w", t1)) + ";");
      }
      lines.push("  " + E.vecType + " vPre" + g3 + " = " + E.advanceVelocity + "(u" + g3 + ", " + t1 + ", " + accelFor(g3) + ");");
      lines.push("  " + B(g3) + ".vx = vPre" + g3 + ".x; " + B(g3) + ".vy = vPre" + g3 + ".y;");
    }
    lines.push("");

    // ---- The two solve loops ----
    //
    // float32 is the straight port: every call re-derives what it needs.
    //
    // df lifts everything a loop cannot change out of that loop - see
    // physics-gpu-df.js's header for the full list and for why each item
    // computes the same values the straight port would:
    //   - each hinged body's sin/cos, once, after leg 1 has set its angle;
    //   - each hinge's rotated anchors and factored 2x2 matrix
    //     (dfPrepareHinge), which no velocity iteration can change;
    //   - each contact's effective mass and positional push
    //     (dfPrepareContact, emitted back where the contact was detected);
    //   - and nothing at all for a side that cannot move - an anchored body,
    //     or the world pin, which has solver forms of its own.
    // The position loop DOES turn bodies, so there each hinged body's sin/cos
    // is carried through the loop and advanced by the turn itself (dfTurn)
    // rather than re-evaluated before every solve.
    function moves(idx) { return consts[idx].isAnchored ? "false" : "true"; }
    function massArgs(idx) { return "BODY" + idx + "_INV_MASS, BODY" + idx + "_INV_INERTIA"; }
    var hingeBodies = {};
    hingeAnchors.forEach(function (hg) {
      if (!hg.aIsWorld) hingeBodies[hg.a] = true;
      hingeBodies[hg.b] = true;
    });
    function trig(idx) { return "sinB" + idx + ", cosB" + idx; }
    if (df) {
      Object.keys(hingeBodies).forEach(function (idx) {
        lines.push("  MF sinB" + idx + ", cosB" + idx + "; dfSinCos(" + B(idx) + ".angle, sinB" + idx + ", cosB" + idx + ");");
      });
      hingeAnchors.forEach(function (hg, hi) {
        lines.push("  DHingePre hingePre" + hi + " = " + (hg.aIsWorld
          ? "dfPrepareWorldHinge(HINGE" + hi + "_A, " + massArgs(hg.b) + ", HINGE" + hi + "_B, " + trig(hg.b) + ");"
          : "dfPrepareHinge(" + massArgs(hg.a) + ", HINGE" + hi + "_A, " + trig(hg.a) + ", " +
            massArgs(hg.b) + ", HINGE" + hi + "_B, " + trig(hg.b) + ");"));
      });
      if (hingeAnchors.length) lines.push("");
    }

    // Reads the HINGEn_A/B parameters stepOnceParams declared above, rather
    // than constructing vec2(...) here - see stepOnceParams's comment.
    function hingeCall(hg, hi, velocityOrPosition) {
      var velocity = velocityOrPosition === "velocity";
      if (df) {
        if (hg.aIsWorld) {
          return velocity
            ? "dfSolveWorldHingeVelocity(" + B(hg.b) + ", " + massArgs(hg.b) + ", hingePre" + hi + ");"
            : "dfSolveWorldHingePosition(HINGE" + hi + "_A, " + B(hg.b) + ", " + massArgs(hg.b) + ", HINGE" + hi + "_B, " + trig(hg.b) + ");";
        }
        return velocity
          ? "dfSolveHingeVelocity(" + B(hg.a) + ", " + massArgs(hg.a) + ", " + moves(hg.a) + ", " +
            B(hg.b) + ", " + massArgs(hg.b) + ", " + moves(hg.b) + ", hingePre" + hi + ");"
          : "dfSolveHingePosition(" + B(hg.a) + ", " + massArgs(hg.a) + ", HINGE" + hi + "_A, " + trig(hg.a) + ", " + moves(hg.a) + ", " +
            B(hg.b) + ", " + massArgs(hg.b) + ", HINGE" + hi + "_B, " + trig(hg.b) + ", " + moves(hg.b) + ");";
      }
      var fn = velocity ? E.solveHingeVelocity : E.solveHingePosition;
      var aExpr = hg.aIsWorld ? "worldBody" : B(hg.a);
      var aMass = hg.aIsWorld ? E.zero + ", " + E.zero : massArgs(hg.a);
      return fn + "(" + aExpr + ", " + aMass + ", HINGE" + hi + "_A, " +
        B(hg.b) + ", " + massArgs(hg.b) + ", HINGE" + hi + "_B);";
    }
    function contactVelocityCall(a, b, contactExpr) {
      return df
        ? "dfSolveContactVelocity(" + B(a) + ", " + massArgs(a) + ", " + moves(a) + ", " + B(b) + ", " + massArgs(b) + ", " + moves(b) + ", " + contactExpr + ");"
        : "solveContactVelocity(" + B(a) + ", " + massArgs(a) + ", " + B(b) + ", " + massArgs(b) + ", " + contactExpr + ");";
    }
    function contactPositionCall(a, b, contactExpr) {
      return df
        ? "dfSolveContactPosition(" + B(a) + ", " + moves(a) + ", " + B(b) + ", " + moves(b) + ", " + contactExpr + ");"
        : "solveContactPosition(" + B(a) + ", BODY" + a + "_INV_MASS, " + B(b) + ", BODY" + b + "_INV_MASS, " + contactExpr + ");";
    }

    lines.push("  for (int iter = 0; iter < " + VELOCITY_ITERATIONS + "; iter++) {");
    hingeAnchors.forEach(function (hg, hi) { lines.push("    " + hingeCall(hg, hi, "velocity")); });
    ordinaryPairs.forEach(function (pair) {
      var varName = "pair_" + pair[0] + "_" + pair[1];
      // c1 only where it can ever be filled: for every pair but line<->line
      // it is noContact() by construction, so solving it was 8 + 4 calls a
      // step that could only return at their first line.
      pairSlots(pair).forEach(function (slot) {
        lines.push("    " + contactVelocityCall(pair[0], pair[1], varName + "." + slot));
      });
    });
    trapezoidPairs.forEach(function (fp) {
      var fi = fp.trap, ci = fp.circle;
      var vn = "trap_" + fi + "_" + ci;
      var excluded = trapezoidExclusion(fp, fi, ci);
      lines.push("    if (!" + excluded + ") {");
      fp.walls.forEach(function (w) {
        lines.push("      " + contactVelocityCall(fi, ci, vn + "_" + w[0]));
      });
      lines.push("    }");
    });
    lines.push("  }");
    lines.push("");
    // Leg 2: the remainder of the step, with the remainder of gravity
    // applied to the POST-impulse velocity - never the whole DT applied
    // before the solve, for the same reason as leg 1. A body with no
    // contact this step has tHit=DT, tRest=0.0: vPost reduces to an
    // already-clamped vFull advanced by 0.0 (the identity), so this whole
    // leg is a no-op and the body's motion is exactly what stepOnce()
    // produced before this restructuring.
    for (var g2 = 0; g2 < n; g2++) {
      if (consts[g2].isAnchored) continue;
      var t2 = "body" + g2 + "TRest";
      lines.push("  " + E.scalarType + " " + t2 + " = " + E.sub(E.DT, "body" + g2 + "THit") + ";");
      lines.push("  " + E.vecType + " vPost" + g2 + " = " + E.advanceVelocity + "(" + E.vec(B(g2) + ".vx", B(g2) + ".vy") + ", " + t2 + ", " + accelFor(g2) + ");");
      lines.push("  " + B(g2) + ".vx = vPost" + g2 + ".x; " + B(g2) + ".vy = vPost" + g2 + ".y;");
      // The rest of a spring's torque onto the post-impulse spin, before the
      // turn below reads it - the same order as the velocity and the position.
      if (turned[g2]) lines.push("  " + B(g2) + ".w = " + spinExpr(g2, t2) + ";");
      lines.push("  " + B(g2) + ".x = " + E.add(B(g2) + ".x", E.mul("vPost" + g2 + ".x", t2)) + ";");
      lines.push("  " + B(g2) + ".y = " + E.add(B(g2) + ".y", E.mul("vPost" + g2 + ".y", t2)) + ";");
      if (df && hingeBodies[g2]) {
        // A hinged body's carried sin/cos has to follow its angle into the
        // position loop. On the everyday no-contact step tRest is exactly
        // zero, the turn is exactly zero, and dfTurn leaves both untouched.
        lines.push("  dfTurn(" + B(g2) + ".angle, " + trig(g2) + ", " + E.mul(B(g2) + ".w", t2) + ");");
      } else {
        lines.push("  " + B(g2) + ".angle = " + E.add(B(g2) + ".angle", E.mul(B(g2) + ".w", t2)) + ";");
      }
    }
    lines.push("");
    lines.push("  for (int iter = 0; iter < " + POSITION_ITERATIONS + "; iter++) {");
    hingeAnchors.forEach(function (hg, hi) { lines.push("    " + hingeCall(hg, hi, "position")); });
    ordinaryPairs.forEach(function (pair) {
      var varName = "pair_" + pair[0] + "_" + pair[1];
      pairSlots(pair).forEach(function (slot) {
        lines.push("    " + contactPositionCall(pair[0], pair[1], varName + "." + slot));
      });
    });
    trapezoidPairs.forEach(function (fp) {
      var fi = fp.trap, ci = fp.circle;
      var vn = "trap_" + fi + "_" + ci;
      var excluded = trapezoidExclusion(fp, fi, ci);
      lines.push("    if (!" + excluded + ") {");
      fp.walls.forEach(function (w) {
        lines.push("      " + contactPositionCall(fi, ci, vn + "_" + w[0]));
      });
      lines.push("    }");
    });
    lines.push("  }");

    // Last thing stepOnce() does, so a wrap this step never feeds a
    // teleported position into this same step's own position-correction
    // iterations above - any hinge/contact response to it plays out
    // starting next step instead.
    //
    // Only ever decided by a "root" body - one with no hinge to another
    // body (either completely free, or hinged straight to the world).
    // A hinge child is never independently wrapped: its position is a
    // rigid consequence of its parent, not an independent choice, so it
    // only ever moves as a cascade of the parent's own wrap below (a pure
    // translation of the whole rigid assembly by one frame period, which
    // changes nothing physically on a wrapped/toroidal space - every hinge
    // in the subtree stays exactly satisfied regardless of how many hops
    // deep it is). A world-hinged root wraps by its PIN's position
    // (HINGEh_A, inout per stepOnceParams), not its own center - see
    // stepOnceParams's comment for why the pin has to be the thing that
    // lives in wrapped frame-space.
    if (frame) {
      var isChild = {};
      var ownWorldHingeIdx = {};
      hingeAnchors.forEach(function (hg, hi) {
        if (hg.aIsWorld) ownWorldHingeIdx[hg.b] = hi;
        else isChild[hg.b] = true;
      });
      function collectDescendants(root, visited) {
        visited[root] = true;
        hingeAnchors.forEach(function (hg) {
          if (!hg.aIsWorld && hg.a === root && !visited[hg.b]) collectDescendants(hg.b, visited);
        });
      }
      // A body joined to anything by a spring answers to its GROUP instead:
      // a tethered group never wraps, and any other wraps as one when its
      // leader does. PhysicsEngine.springGroups is the single definition of
      // that, run here at codegen time over the same topology the JS engine
      // runs it over every step - null for a scene with no springs, which
      // then emits exactly what it always did.
      var springGroups = PE.springGroups({
        bodies: consts,
        hinges: hingeAnchors.map(function (hg) { return { bodyA: hg.aIsWorld ? null : hg.a, bodyB: hg.b }; }),
        springs: springList.map(function (sp) { return { bodyA: sp.aIsWorld ? null : sp.a, bodyB: sp.b }; }),
      });
      var frameW = fnum(frame.width), frameH = fnum(frame.height);
      lines.push("");
      for (var root = 0; root < n; root++) {
        if (consts[root].isAnchored || isChild[root]) continue;
        var springGroup = springGroups ? springGroups.groupOf[root] : null;
        if (springGroup && (springGroup.tethered || springGroup.leader !== root)) continue;
        var hasWorldHinge = ownWorldHingeIdx[root] !== undefined;
        var wrapTarget = hasWorldHinge ? "HINGE" + ownWorldHingeIdx[root] + "_A" : B(root);
        var refX = wrapTarget + ".x", refY = wrapTarget + ".y";
        var dxVar = "wrapDx" + root, dyVar = "wrapDy" + root;
        lines.push("  float " + dxVar + " = 0.0;");
        lines.push("  float " + dyVar + " = 0.0;");
        if (df) {
          // Compared in df rather than through dfToFloat(): the collapse
          // would throw away exactly the low bits that decide WHICH SIDE of
          // the edge a body is on for the pixels nearest it, turning a
          // continuous boundary into a quantized one.
          lines.push("  if (dfGreater(" + refX + ", dfFromFloat(" + frameW + "))) " + dxVar + " = -" + frameW + "; else if (dfLess(" + refX + ", DF_ZERO)) " + dxVar + " = " + frameW + ";");
          lines.push("  if (dfGreater(" + refY + ", dfFromFloat(" + frameH + "))) " + dyVar + " = -" + frameH + "; else if (dfLess(" + refY + ", DF_ZERO)) " + dyVar + " = " + frameH + ";");
        } else {
          lines.push("  if (" + refX + " > " + frameW + ") " + dxVar + " = -" + frameW + "; else if (" + refX + " < 0.0) " + dxVar + " = " + frameW + ";");
          lines.push("  if (" + refY + " > " + frameH + ") " + dyVar + " = -" + frameH + "; else if (" + refY + " < 0.0) " + dyVar + " = " + frameH + ";");
        }
        // What moves with this root: its own pin and its hinge descendants -
        // or, for a spring group's leader, every member of the group and
        // every background pin any of them hangs from (see
        // PhysicsEngine.translateSpringGroup).
        var movedPins = [], descendants = {};
        if (springGroup) {
          springGroup.members.forEach(function (m) { descendants[m] = true; });
          hingeAnchors.forEach(function (hg, hi) { if (hg.aIsWorld && descendants[hg.b]) movedPins.push(hi); });
        } else {
          if (hasWorldHinge) movedPins.push(ownWorldHingeIdx[root]);
          collectDescendants(root, descendants);
        }
        movedPins.forEach(function (hi) {
          var hv = "HINGE" + hi + "_A";
          lines.push(df
            ? "  " + hv + ".x = dfAddFloat(" + hv + ".x, " + dxVar + "); " + hv + ".y = dfAddFloat(" + hv + ".y, " + dyVar + ");"
            : "  " + hv + " += vec2(" + dxVar + ", " + dyVar + ");");
        });
        Object.keys(descendants).forEach(function (memberStr) {
          lines.push(df
            ? "  " + E.body + memberStr + ".x = dfAddFloat(" + E.body + memberStr + ".x, " + dxVar + "); " + E.body + memberStr + ".y = dfAddFloat(" + E.body + memberStr + ".y, " + dyVar + ");"
            : "  body" + memberStr + ".x += " + dxVar + "; body" + memberStr + ".y += " + dyVar + ";");
        });
      }
    }

    // ---- Splitting: the very last thing the step does ----
    //
    // Genuinely last, matching physics-engine.js's step(): each splitting
    // circle is displaced from its fully integrated (leg 1 + solve + leg 2 +
    // position solve + wrap) end-of-step state, and a slot woken here takes
    // no part in the step it was born in - it starts fresh next step, like
    // any body added between steps.
    //
    // The circle that hit keeps its own slot as the first of the two (moved
    // by offset1, velocity untouched) and a spawn slot becomes the second.
    // Since an authored body's lineage is implicitly its own index, the
    // in-place half stays in its lineage for free however many times it
    // splits again, and only the woken slot has to be told.
    if (splittableCircles.length) {
      lines.push("");
      // Applied in ascending body index, the order physics-engine.js's own
      // loop runs in - which is what decides who gets the last free slot
      // when several balls split on the same step.
      splittableCircles.forEach(function (ci) {
        var lineage = isSpawnSlot[ci] ? "lineage" + ci : String(ci);
        lines.push("  if (splitFound_" + ci + ") {");
        // Read the child's position off the parent BEFORE the parent moves:
        // both offsets displace the same pre-split position, not each other.
        lines.push("    " + E.scalarType + " childX_" + ci + " = " + E.add(B(ci) + ".x", "splitOff2_" + ci + ".x") + ";");
        lines.push("    " + E.scalarType + " childY_" + ci + " = " + E.add(B(ci) + ".y", "splitOff2_" + ci + ".y") + ";");
        lines.push("    " + B(ci) + ".x = " + E.add(B(ci) + ".x", "splitOff1_" + ci + ".x") + ";");
        lines.push("    " + B(ci) + ".y = " + E.add(B(ci) + ".y", "splitOff1_" + ci + ".y") + ";");
        if (spawnSlots.length) {
          // At the ceiling the ball still passes through - the offset above
          // has already been applied - it just doesn't duplicate.
          lines.push("    if (liveCount < " + n + ") {");
          spawnSlots.forEach(function (k, si) {
            lines.push("      " + (si === 0 ? "if" : "else if") + " (liveCount == " + k + ") { " +
              B(k) + " = " + E.bodyType + "(childX_" + ci + ", childY_" + ci + ", " + B(ci) + ".angle, " + B(ci) + ".vx, " + B(ci) + ".vy, " + B(ci) + ".w); " +
              // A split never changes size, so the child's shape constants
              // are the parent's, verbatim - no re-derivation from a radius
              // that would have to agree with computeMass all over again.
              "BODY" + k + "_HALF = BODY" + ci + "_HALF; " +
              "BODY" + k + "_INV_MASS = BODY" + ci + "_INV_MASS; " +
              "BODY" + k + "_INV_INERTIA = BODY" + ci + "_INV_INERTIA; " +
              "alive" + k + " = true; lineage" + k + " = " + lineage + "; }");
          });
          lines.push("      liveCount += 1;");
          lines.push("    }");
        }
        lines.push("  }");
      });
    }

    lines.push("}");
    return lines.join("\n");
  }

  // Per-body local declarations (LOCAL, not global - see generateStepOnceGLSL
  // above) with literal initial values baked straight from the scene as
  // authored. The per-pixel fractal grid emits its own version of this for
  // whichever body/property is linked (computed from that pixel's world X/Y
  // instead of a literal) and reuses generateStepOnceGLSL unchanged.
  function generateBodyLocalsGLSL(consts, precision) {
    var df = global.PhysicsDF.isExtended(precision);
    if (df) global.PhysicsDF.usePrecision(precision);
    // JS numbers are float64, so an authored coordinate already has more
    // precision than a single float32 literal can carry - dfnum splits it
    // across both words instead of rounding it away at codegen time.
    var dfnum = df ? global.PhysicsDF.num : null;
    var lines = [];
    for (var i = 0; i < consts.length; i++) {
      var b = consts[i];
      lines.push(df
        ? "DBody dbody" + i + " = DBody(" +
          dfnum(b.x) + ", " + dfnum(b.y) + ", " + dfnum(b.angle) + ", " +
          dfnum(b.vx) + ", " + dfnum(b.vy) + ", " + dfnum(b.w) + ");"
        : "Body body" + i + " = Body(" +
          fnum(b.x) + ", " + fnum(b.y) + ", " + fnum(b.angle) + ", " +
          fnum(b.vx) + ", " + fnum(b.vy) + ", " + fnum(b.w) + ");"
      );
      var num = df ? dfnum : fnum;
      var sc = df ? "MF " : "float ";
      lines.push(sc + "BODY" + i + "_INV_MASS = " + num(b.invMass) + ";");
      lines.push(sc + "BODY" + i + "_INV_INERTIA = " + num(b.invInertia) + ";");
      lines.push(sc + "BODY" + i + "_HALF = " + num(shapeHalf(consts, i)) + ";");
    }
    var geomReset = staticGeometryResetGLSL(precision);
    if (geomReset) lines.push(geomReset);
    return lines.join("\n");
  }

  // Every step gets its own row of an (numBodies x maxSteps) texture: texel
  // (body, step) redundantly re-simulates from scratch up to `step`, then
  // reports that one body's (x, y, angle) - "acceptable at this tiny scale
  // since it's per-Play-click [or per-hover-point], not per-fractal-pixel."
  // Shared by the single-scene compiler below (bodies declared as globals
  // with baked literals) and the fractal grid's hover-replay compiler
  // (bodies declared from the same offset+cascade expressions the grid
  // shader itself uses) - bodyDeclarationsGLSL is the only thing that
  // differs between the two, so it's the one parameter. (An earlier version
  // of this function could also freeze a runaway body's position early -
  // removed once frame wrapping made a position genuinely unbounded a
  // non-issue: a non-anchored body's x/y is now always kept in
  // [0, frameWidth)/[0, frameHeight) by PhysicsEngine.step's own wrap, not
  // by freezing the simulation and hoping nothing downstream needed it to
  // keep running.)
  // ---- The trajectory program: every body's state at every step ----
  //
  // Texel (b, r) of the output is body b after r + 1 steps. The obvious way to
  // fill it - and what this did for a long time - is for every texel to run
  // its own r + 1 steps from the start, all in one draw. That is quadratic in
  // the run length, and worse, the last row's pixels each do the WHOLE run
  // inside a single invocation: a few hundred steps of a heavy scene (or of
  // anything at all above float32) is long enough for the OS to abort the
  // draw, which comes back as zeros.
  //
  // So it runs in CHUNKS, carrying the simulation's state between them in a
  // float texture - the same packing grid playback uses
  // (playbackStateVariables), laid out as a strip: texel (l, 0) is state
  // layer l. Each chunk is two kinds of draw by the same program:
  //   LOG      (u_trajAdvance == 0) - the chunk's rows. Row r starts from the
  //            saved state at step u_trajBase and runs (r - u_trajBase + 1)
  //            steps, at most one chunk's worth.
  //   ADVANCE  (u_trajAdvance  > 0) - the strip: every texel runs that many
  //            steps from the saved state and keeps its own layer of the
  //            result. (The texels all repeat the same run. That is the cheap
  //            way round: they shade in parallel, so the strip takes about
  //            as long as one texel, and writing a strip needs only the one
  //            color attachment the LOG draw already uses - several
  //            attachments would be a second pipeline for the driver to
  //            build, which above float32 is seconds.)
  // RGBA32F stores every float exactly, so stopping and resuming lands on the
  // same bits as running straight through; no invocation ever runs more than
  // a chunk, and the total work is linear in the run length.
  //
  // HOW LONG a chunk may be is a property of the machine, not of this code,
  // and the limit is far lower than "a few hundred steps": measured on an
  // Apple-silicon Mac WITH ITS DISPLAY ON, a fragment invocation that runs
  // past roughly 30-45ms is reported by Metal as a GPU hang
  // (kIOGPUCommandBufferCallbackErrorHang) and its command buffer thrown
  // away - the compositor wants the GPU back every frame, and fragment work
  // cannot be preempted mid-tile. (With the display asleep the same draw is
  // allowed to run for seconds, which is how this hid for so long; compute
  // work is preemptible and is not subject to it, but WebGL has none.)
  // Nothing tells WebGL: no error, no lost context, just a texture that
  // was never written - and after a few of them the OS ignores everything
  // the GPU process submits. A 20-slot splitter scene costs 0.4ms a step in
  // float32, so even 96 steps is too many there, while 96 steps of a small
  // scene is nothing. So the runner MEASURES: it times every chunk and sizes
  // the next one to take about TRAJECTORY_TARGET_MS (see
  // runCompiledTrajectoryOnGPU), starting from a single step.
  //
  // The shader's own loop bound - the most steps a chunk can ever be.
  var TRAJECTORY_MAX_CHUNK = 256;
  // What a draw's longest run is steered towards. Several times under the
  // limit above, because the estimate comes from the chunks already run and
  // a step can get dearer as the run goes on (a split wakes more bodies).
  var TRAJECTORY_TARGET_MS = 4;
  // Written beside the data by every draw, so a draw the GPU dropped is
  // noticed instead of being read back as a trajectory: see
  // generateTrajectoryMainGLSL.
  var TRAJECTORY_SENTINEL = 8191;

  function trajectoryChunkInfo(n, consts, hingeAnchors, precision, spawnBase) {
    // Anchored bodies are left OUT of the carried state (nothing ever writes
    // one - see playbackStateVariables), which is fine here too: every
    // invocation re-declares them from the scene before anything else.
    var vars = playbackStateVariables({ precision: precision, n: n, consts: consts, spawnBase: spawnBase, hingeAnchors: hingeAnchors });
    return {
      vars: vars,
      maxSteps: TRAJECTORY_MAX_CHUNK,
      layers: playbackStateLayerCount(vars),
    };
  }

  // The uniforms and the output the chunked main needs, for the caller's
  // header (in place of the single `out vec4 fragColor` the old main wrote).
  function generateTrajectoryHeaderGLSL(chunk) {
    return [
      "uniform sampler2D u_trajState;",
      "uniform bool u_trajInit;",
      "uniform int u_trajBase;",
      "uniform int u_trajAdvance;",
      "const int TRAJECTORY_CHUNK = " + chunk.maxSteps + ";",
      "const float TRAJECTORY_SENTINEL = " + TRAJECTORY_SENTINEL + ".0;",
      "layout(location = 0) out vec4 pbOut0;",
    ].join("\n");
  }

  function generateTrajectoryMainGLSL(n, bodyDeclarationsGLSL, hingeAnchors, precision, spawnBase, chunk, springs) {
    var df = global.PhysicsDF.isExtended(precision);
    var isSpawnSlot = {};
    spawnSlotsFrom(n, spawnBase).forEach(function (i) { isSpawnSlot[i] = true; });
    function readField(i, field) { return df ? "dfToFloat(dbody" + i + "." + field + ")" : "body" + i + "." + field; }
    var stepCall = "stepOnce(" + stepOnceCallArgs(n, hingeAnchors, precision, spawnBase, springs) + ");";
    var lines = [];
    lines.push("void main() {");
    lines.push("  " + bodyDeclarationsGLSL.split("\n").join("\n  "));
    lines.push("  if (!u_trajInit) {");
    generatePlaybackStateLoadGLSL(chunk.vars, "u_trajState", null, true).forEach(function (l) { lines.push("    " + l); });
    lines.push("  }");
    // Row 0 reports the state after 1 step (not 0) so that every row is a
    // real, distinct simulation step and trajectory[maxSteps-1] is the state
    // after exactly maxSteps steps - matching how PhysicsEngine.step() is
    // called maxSteps times, not maxSteps-1.
    //
    // ONE loop, and so one call site, serves both kinds of draw - only the
    // step count differs. The compiler inlines stepOnce() wherever it is
    // called, and it is by far the largest thing in the shader: a second
    // call site doubles the program, and with it the seconds the driver
    // spends building it.
    lines.push("  int stepTarget = u_trajAdvance > 0 ? u_trajAdvance : int(gl_FragCoord.y) - u_trajBase + 1;");
    lines.push("  for (int i = 0; i < TRAJECTORY_CHUNK; i++) {");
    lines.push("    if (i >= stepTarget) break;");
    lines.push("    " + stepCall);
    lines.push("  }");
    lines.push("  if (u_trajAdvance > 0) {");
    // The texel one past the last layer is the sentinel: how many steps the
    // state now stands at, and a constant no stale texel would hold.
    lines.push("    pbOut0 = vec4(float(u_trajBase + u_trajAdvance), TRAJECTORY_SENTINEL, 0.0, 0.0);");
    generateStateStripStoreGLSL(chunk.vars, "int(gl_FragCoord.x)", "pbOut0").forEach(function (l) { lines.push("    " + l); });
    lines.push("    return;");
    lines.push("  }");
    lines.push("  int bodyIdx = int(gl_FragCoord.x);");
    lines.push("  vec3 outVal = vec3(0.0);");
    // The alpha channel is otherwise unused (nothing about position/angle
    // needs a 4th component) - carrying BODYn_HALF through it costs
    // nothing and lets a reader recover each body's actual rendered size,
    // which the fractal grid's hover-replay needs (a resize-linked body's
    // HALF is a per-hover-point value, not the scene's authored radius/
    // length) but the single-scene trajectory player has simply never had
    // a use for.
    lines.push("  float outHalf = 0.0;");
    for (var o = 0; o < n; o++) {
      // BODYn_HALF is a multi-float scalar above float32, but the alpha
      // channel it lands in is a plain float either way - this is a rendered
      // size for the replay to draw with, not state.
      var half = df ? "dfToFloat(BODY" + o + "_HALF)" : "BODY" + o + "_HALF";
      // A spawn slot nobody has split into yet reports size 0 - the same
      // signal a reader already uses to draw nothing, and what tells the
      // replay how many balls existed at this step without a second channel.
      if (isSpawnSlot[o]) half = "(alive" + o + " ? " + half + " : 0.0)";
      lines.push((o === 0 ? "  if" : "  else if") + " (bodyIdx == " + o + ") { outVal = vec3(" +
        readField(o, "x") + ", " + readField(o, "y") + ", " + readField(o, "angle") + "); outHalf = " + half + "; }");
    }
    // The column past the last body is each row's sentinel - see the runner.
    lines.push("  if (bodyIdx == " + n + ") { outVal = vec3(gl_FragCoord.y + 0.5, TRAJECTORY_SENTINEL, 0.0); }");
    lines.push("  pbOut0 = vec4(outVal, outHalf);");
    lines.push("}");
    return lines.join("\n");
  }

  // precision is "f32" (default) or "df". #editor-view's Play button never
  // needs df - it runs one scene at one set of starting conditions, where
  // float32 was never the limit - but the regression suite compiles the
  // same scene both ways to check the two agree, so it's a parameter here
  // rather than a hardcoded "f32".
  function compileSceneToTrajectoryGLSL(scene, maxSteps, precision) {
    var df = global.PhysicsDF.isExtended(precision);
    if (df) global.PhysicsDF.usePrecision(precision);
    var dfnum = df ? global.PhysicsDF.num : null;
    if (scene.bodies.length > MAX_BODIES) {
      throw new Error("GPU physics supports at most " + MAX_BODIES + " bodies (scene has " + scene.bodies.length + ")");
    }
    // Checked against the AUTHORED count above, then padded: the spawn slots
    // a splitter scene gets here are not something the user drew, and
    // counting them against the authoring limit would reject every splitter
    // scene there is.
    var padded = padSceneForSplitting(scene);
    var spawnBase = padded.spawnBase;
    scene = padded.scene;
    var bodies = scene.bodies;
    var n = bodies.length;
    var consts = bodies.map(bodyConst);
    // Empty rather than filtered post-hoc: generateStepOnceGLSL's funnel
    // codegen (mouth teleport) is itself derived by pulling matching entries
    // OUT of this same list (see its own comment), so handing it none at
    // all is what turns off both the ordinary bounce/stick contacts AND a
    // funnel's mouth in one place - exactly "never check for collisions,
    // objects pass right through each other" applied uniformly, with no
    // separate flag to keep in sync inside the generator itself.
    var pairs = PhysicsEngine.collisionsEnabled(scene) ? collisionPairs(n, consts, scene.hinges) : [];
    var hingeAnchors = scene.hinges.map(function (hg) {
      return {
        aIsWorld: hg.bodyA === null,
        a: hg.bodyA,
        b: hg.bodyB,
        localA: df ? { x: dfnum(hg.localAnchorA.x), y: dfnum(hg.localAnchorA.y) }
                   : { x: fnum(hg.localAnchorA.x), y: fnum(hg.localAnchorA.y) },
        localB: df ? { x: dfnum(hg.localAnchorB.x), y: dfnum(hg.localAnchorB.y) }
                   : { x: fnum(hg.localAnchorB.x), y: fnum(hg.localAnchorB.y) },
      };
    });
    // Only scenes with a locked frame size wrap at the edges - see
    // generateStepOnceGLSL's own comment.
    // undefined in Infinite Space: no frame means the step loop emits no
    // wrap at all, which is exactly what that mode is.
    var frame = global.PhysicsEngine.wrapsAtEdges(scene) ? { width: scene.frameWidth, height: scene.frameHeight } : undefined;

    var lines = [];
    lines.push("#version 300 es");
    var chunk = trajectoryChunkInfo(n, consts, hingeAnchors, precision, spawnBase);
    lines.push("precision highp float;");
    lines.push(generateTrajectoryHeaderGLSL(chunk));
    lines.push("");
    lines.push(libraryGLSL(precision, global.PhysicsEngine.speedCapFor(scene)));
    lines.push("");
    // Nothing in the source depends on maxSteps any more - the runner walks
    // the run a chunk at a time - so a different run length reuses the
    // compiled program instead of building another.
    var springs = springLinksFor(scene, df ? dfnum : fnum);
    lines.push(generateStepOnceGLSL(n, consts, pairs, hingeAnchors, frame, precision, scene.mutualGravity, PhysicsEngine.collisionsEnabled(scene), spawnBase, springs));
    lines.push("");
    var locals = generateBodyLocalsGLSL(consts, precision) + "\n" + generateHingeAnchorLocalsGLSL(hingeAnchors, precision);
    var spawnLocals = generateSpawnSlotLocalsGLSL(n, spawnBase);
    if (spawnLocals) locals += "\n" + spawnLocals;
    lines.push(generateTrajectoryMainGLSL(n, locals, hingeAnchors, precision, spawnBase, chunk, springs));

    return { fragmentSource: lines.join("\n"), numBodies: n, precision: df ? precision : "f32", chunk: chunk };
  }

  // ---- Carrying a pixel's simulation across draws (grid playback) ----
  //
  // The grid's normal render starts every pixel from step 0 and runs it to
  // the end inside one draw. Playback can't afford that: showing step N+1
  // would redo all N steps before it, so the work grows with every frame.
  // Instead each pixel's state is written to float textures at the end of a
  // draw and read back at the start of the next, so a frame only pays for
  // the steps it actually adds.
  //
  // "State" is exactly what a stepOnce() call can change and the next call
  // must see: the inout parameters stepOnceParams declares. Everything else
  // a draw needs (inverse masses, sizes, hinge local anchors, anchored
  // bodies) is a pure function of the pixel's world X/Y, so each draw
  // recomputes it from generateGridInitialStateGLSL's declarations instead.
  //
  // The textures are RGBA32F, which store float32 values exactly - so as
  // long as the same program does the stepping, stopping after k steps,
  // saving, reloading and running the rest lands on the same bits as one
  // uninterrupted run. physics-tests.js checks that.
  //
  // A state variable is { name, type }, where type is how the step loop
  // declares that local: "Body"/"DBody" (a body's six accumulators), "float",
  // "df" (one df scalar, a vec2), "vec2", "DVec2", "bool" or "int".
  // The multi-float kinds ("DBody", "df", "DVec2") are as many floats per
  // scalar as the precision has words, so their field lists are built for a
  // word count rather than written out: a df scalar is .x/.y, a tf one
  // .x/.y/.z, a qf one .x/.y/.z/.w.
  var WORD_FIELDS = [".x", ".y", ".z", ".w"];
  function stateTypeFields(type, words) {
    var w = WORD_FIELDS.slice(0, words);
    function each(prefixes) {
      var out = [];
      prefixes.forEach(function (pre) { w.forEach(function (c) { out.push(pre + c); }); });
      return out;
    }
    if (type === "Body") return [".x", ".y", ".angle", ".vx", ".vy", ".w"];
    if (type === "DBody") return each([".x", ".y", ".angle", ".vx", ".vy", ".w"]);
    if (type === "df") return each([""]);
    if (type === "DVec2") return each([".x", ".y"]);
    if (type === "vec2") return [".x", ".y"];
    if (type === "float" || type === "bool" || type === "int") return [""];
    return null;
  }
  // The GLSL type a local of each kind is declared with.
  var STATE_TYPE_GLSL = { Body: "Body", DBody: "DBody", float: "float", df: "MF", vec2: "vec2", DVec2: "DVec2", bool: "bool", int: "int" };
  // Four floats per texel, so one texture layer per four state floats.
  var STATE_FLOATS_PER_LAYER = 4;

  // The state variables of a scene compiled by generateGridInitialStateGLSL.
  //
  // Anchored bodies are left out: stepOnce() never writes one (see the
  // `if (consts[g].isAnchored) continue` guards around every integration
  // site in generateStepOnceGLSL, and invMass/invInertia of 0 in
  // every solver), so its value at any step is its starting value, which
  // each draw recomputes anyway. extraBodies names any that must be carried
  // regardless - a reader that has no starting state of its own, like the
  // playback color pass reading an anchored Output body, needs them.
  //
  // A world hinge's anchor is carried because the frame wrap moves it in
  // place (see stepOnceParams). Spawn slots carry the shape constants a split
  // overwrites, plus alive/lineage, and the scene carries liveCount.
  function playbackStateVariables(result, extraBodies) {
    var df = global.PhysicsDF.isExtended(result.precision);
    var extra = extraBodies || [];
    var vars = [];
    for (var i = 0; i < result.n; i++) {
      if (result.consts[i].isAnchored && extra.indexOf(i) === -1) continue;
      vars.push({ name: (df ? "dbody" : "body") + i, type: df ? "DBody" : "Body" });
    }
    var hasSpawn = result.spawnBase !== null && result.spawnBase !== undefined;
    if (hasSpawn) {
      for (var k = result.spawnBase; k < result.n; k++) {
        ["_INV_MASS", "_INV_INERTIA", "_HALF"].forEach(function (suffix) {
          vars.push({ name: "BODY" + k + suffix, type: df ? "df" : "float" });
        });
        vars.push({ name: "alive" + k, type: "bool" });
        vars.push({ name: "lineage" + k, type: "int" });
      }
      vars.push({ name: "liveCount", type: "int" });
    }
    result.hingeAnchors.forEach(function (hg, h) {
      if (hg.aIsWorld) vars.push({ name: "hingeAnchor" + h, type: df ? "DVec2" : "vec2" });
    });
    return withWords(vars, result.precision);
  }

  // Stamps each state variable with its precision's word count - see
  // stateFloats. Exported for callers that add state variables of their own
  // (the grid's sticky-edge bookkeeping).
  function withWords(vars, precision) {
    var words = global.PhysicsDF.wordsFor(precision);
    vars.forEach(function (v) { v.words = words; });
    return vars;
  }

  // Every float the variables pack into, in order, as { variable, field }.
  function stateFloats(vars) {
    var out = [];
    vars.forEach(function (v) {
      // `words` rides on the variable (see withWords): how many floats a
      // multi-float scalar packs into depends on the precision it was
      // declared at, and this function is handed variables, not a precision.
      var fields = stateTypeFields(v.type, v.words || 2);
      if (!fields) throw new Error("Unknown playback state type: " + v.type);
      fields.forEach(function (f) { out.push({ variable: v, field: f }); });
    });
    return out;
  }

  function playbackStateLayerCount(vars) {
    return Math.max(1, Math.ceil(stateFloats(vars).length / STATE_FLOATS_PER_LAYER));
  }

  // Uninitialized declarations, for a program that has no step loop of its
  // own to declare them (the playback color pass). Every field is assigned
  // by the load below before anything reads it.
  function generatePlaybackStateDeclarationsGLSL(vars) {
    return vars.map(function (v) { return STATE_TYPE_GLSL[v.type] + " " + v.name + ";"; });
  }

  // Reads every state variable from a sampler2DArray at an integer texel.
  // Layer temporaries are prefixed pbState so they can't collide with the
  // gv_/pair_/probe names the rest of the generated code uses.
  //
  // `strip` reads the other layout instead - a sampler2D whose texel (l, 0)
  // is layer l, which is how the trajectory runner carries one simulation's
  // state (there is no lattice of them, so no texel to index by).
  function generatePlaybackStateLoadGLSL(vars, samplerName, texelExpr, strip) {
    var floats = stateFloats(vars);
    var lines = [];
    var layers = playbackStateLayerCount(vars);
    for (var l = 0; l < layers; l++) {
      var texel = strip ? "ivec2(" + l + ", 0)" : "ivec3(" + texelExpr + ", " + l + ")";
      lines.push("vec4 pbState" + l + " = texelFetch(" + samplerName + ", " + texel + ", 0);");
    }
    floats.forEach(function (f, i) {
      var src = "pbState" + Math.floor(i / STATE_FLOATS_PER_LAYER) + "." + "xyzw"[i % STATE_FLOATS_PER_LAYER];
      if (f.variable.type === "bool") lines.push(f.variable.name + " = " + src + " > 0.5;");
      else if (f.variable.type === "int") lines.push(f.variable.name + " = int(" + src + ");");
      else lines.push(f.variable.name + f.field + " = " + src + ";");
    });
    return lines;
  }

  // Fragment outputs for writing state: one per texture layer a single draw
  // can attach. A WebGL2 draw writes at most MAX_DRAW_BUFFERS attachments, so
  // a state with more layers than that is written in groups - one draw per
  // group, each running the same steps and keeping a different slice.
  function generatePlaybackStateOutputsGLSL(layersPerGroup) {
    var lines = [];
    for (var k = 0; k < layersPerGroup; k++) lines.push("layout(location = " + k + ") out vec4 pbOut" + k + ";");
    return lines;
  }

  // Writes the slice of state belonging to group `groupExpr` (an int
  // expression) into the outputs declared above.
  function generatePlaybackStateStoreGLSL(vars, groupExpr, layersPerGroup) {
    var floats = stateFloats(vars);
    var layers = playbackStateLayerCount(vars);
    var groups = Math.ceil(layers / layersPerGroup);
    function floatExpr(i) {
      if (i >= floats.length) return "0.0";
      var v = floats[i].variable;
      if (v.type === "bool") return "(" + v.name + " ? 1.0 : 0.0)";
      if (v.type === "int") return "float(" + v.name + ")";
      return v.name + floats[i].field;
    }
    var lines = [];
    for (var g = 0; g < groups; g++) {
      lines.push((g === 0 ? "if" : "} else if") + " (" + groupExpr + " == " + g + ") {");
      for (var k = 0; k < layersPerGroup; k++) {
        var layer = g * layersPerGroup + k;
        if (layer >= layers) break;
        var base = layer * STATE_FLOATS_PER_LAYER;
        lines.push("  pbOut" + k + " = vec4(" + [0, 1, 2, 3].map(function (c) { return floatExpr(base + c); }).join(", ") + ");");
      }
    }
    lines.push("}");
    return lines;
  }

  // The strip layout's store: writes layer `layerExpr` (an int expression) to
  // the one output. Flat ifs rather than an else-if chain - a quad-float
  // splitter scene has a couple of hundred layers, and that deep a nest is
  // the kind of thing shader translators put a limit on.
  function generateStateStripStoreGLSL(vars, layerExpr, outName) {
    var floats = stateFloats(vars);
    var layers = playbackStateLayerCount(vars);
    function floatExpr(i) {
      if (i >= floats.length) return "0.0";
      var v = floats[i].variable;
      if (v.type === "bool") return "(" + v.name + " ? 1.0 : 0.0)";
      if (v.type === "int") return "float(" + v.name + ")";
      return v.name + floats[i].field;
    }
    var lines = ["int pbLayer = " + layerExpr + ";"];
    for (var l = 0; l < layers; l++) {
      var base = l * STATE_FLOATS_PER_LAYER;
      lines.push("if (pbLayer == " + l + ") " + outName + " = vec4(" + [0, 1, 2, 3].map(function (c) { return floatExpr(base + c); }).join(", ") + ");");
    }
    return lines;
  }

  // ---- WebGL orchestration ----

  function compileShader(gl, type, source) {
    var shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      var info = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error((type === gl.VERTEX_SHADER ? "Vertex" : "Fragment") + " shader error:\n" + info);
    }
    return shader;
  }

  function linkProgram(gl, vs, fs) {
    var program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      var info = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error("Program link error:\n" + info);
    }
    return program;
  }

  // ---- The trajectory runner: one context and its compiled programs, kept ----
  //
  // This used to build everything from nothing on every call - a fresh
  // OffscreenCanvas and context, a compile, a link - and lose the context on
  // the way out. That is invisible for a Play click and ruinous for hover
  // replay, which calls it per mouse move and up to 300 times for one
  // Inspect line: in df the compile alone is seconds.
  //
  // Now there is one context for the life of the page, and programs are
  // cached by their SOURCE. The hover replay's source no longer depends on
  // the hovered point (see compileHoverTrajectoryGLSL - the point is a
  // uniform), so for a given scene, step count and precision every call
  // after the first is a draw and a readback.
  //
  // One context, not one per call, is also what the browser's cap on live
  // WebGL contexts wants: the old code had to lose each context explicitly
  // to stay under it, and this never holds more than the one.
  var TRAJECTORY_PROGRAM_CACHE_SIZE = 6;
  var trajectoryRunner = null;

  function getTrajectoryRunner() {
    if (trajectoryRunner && !trajectoryRunner.gl.isContextLost()) return trajectoryRunner;
    var canvas = new OffscreenCanvas(1, 1);
    var gl = canvas.getContext("webgl2");
    if (!gl) throw new Error("WebGL2 is not available for GPU physics.");
    if (!gl.getExtension("EXT_color_buffer_float")) {
      throw new Error("EXT_color_buffer_float is not available for GPU physics.");
    }
    var quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    trajectoryRunner = {
      gl: gl,
      vs: compileShader(gl, gl.VERTEX_SHADER, VERTEX_SOURCE),
      quadBuffer: quadBuffer,
      programs: [], // { source, program, posLoc }, most recently used last
      fbo: gl.createFramebuffer(),
    };
    return trajectoryRunner;
  }

  function trajectoryProgramFor(runner, fragmentSource) {
    var gl = runner.gl, cache = runner.programs;
    for (var i = 0; i < cache.length; i++) {
      if (cache[i].source === fragmentSource) {
        var hit = cache.splice(i, 1)[0];
        cache.push(hit);
        return hit;
      }
    }
    var fs = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    var program;
    try {
      program = linkProgram(gl, runner.vs, fs);
    } finally {
      gl.deleteShader(fs);
    }
    var entry = { source: fragmentSource, program: program, posLoc: gl.getAttribLocation(program, "a_position") };
    cache.push(entry);
    while (cache.length > TRAJECTORY_PROGRAM_CACHE_SIZE) gl.deleteProgram(cache.shift().program);
    return entry;
  }

  // Runs an already-compiled { fragmentSource, numBodies, chunk, uniforms? }
  // (from either compileSceneToTrajectoryGLSL or the fractal grid's
  // hover-replay compiler - same shape, same texture-logging convention) and
  // reads back the resulting trajectory. `uniforms` is { name: [components...] },
  // all floats - what the hover replay passes its world point in by. See
  // generateTrajectoryMainGLSL for the chunked LOG / ADVANCE scheme this
  // drives.
  function runCompiledTrajectoryOnGPU(compiled, maxSteps) {
    var numBodies = compiled.numBodies;
    if (numBodies === 0) return [];
    var chunk = compiled.chunk;

    var runner = getTrajectoryRunner();
    var gl = runner.gl;
    var entry = trajectoryProgramFor(runner, compiled.fragmentSource);
    var prog = entry.program;
    gl.useProgram(prog);
    Object.keys(compiled.uniforms || {}).forEach(function (name) {
      var loc = gl.getUniformLocation(prog, name);
      var v = compiled.uniforms[name];
      if (!loc) return;
      if (v.length === 1) gl.uniform1f(loc, v[0]);
      else if (v.length === 2) gl.uniform2f(loc, v[0], v[1]);
      else if (v.length === 3) gl.uniform3f(loc, v[0], v[1], v[2]);
      else gl.uniform4f(loc, v[0], v[1], v[2], v[3]);
    });
    var u = {
      state: gl.getUniformLocation(prog, "u_trajState"),
      init: gl.getUniformLocation(prog, "u_trajInit"),
      base: gl.getUniformLocation(prog, "u_trajBase"),
      advance: gl.getUniformLocation(prog, "u_trajAdvance"),
    };

    gl.bindBuffer(gl.ARRAY_BUFFER, runner.quadBuffer);
    gl.enableVertexAttribArray(entry.posLoc);
    gl.vertexAttribPointer(entry.posLoc, 2, gl.FLOAT, false, 0, 0);

    function floatTexture(w, h) {
      var t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    }
    // Where the trajectory is logged - a column wider than the bodies, for
    // each row's sentinel...
    var logWidth = numBodies + 1;
    var texture = floatTexture(logWidth, maxSteps);
    // ...and the pair of state strips the chunks hand the simulation along
    // in (one read, one written, swapped each chunk), a texel longer than
    // the layers for the same reason.
    var stripWidth = chunk.layers + 1;
    var states = [floatTexture(stripWidth, 1), floatTexture(stripWidth, 1)];
    var logFbo = runner.fbo, stateFbo = gl.createFramebuffer();
    var sentinel = new Float32Array(4);
    var failure = null;

    function release() {
      gl.bindFramebuffer(gl.FRAMEBUFFER, logFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(stateFbo);
      gl.deleteTexture(states[0]);
      gl.deleteTexture(states[1]);
      gl.deleteTexture(texture);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, logFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    var status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      release();
      throw new Error("GPU physics framebuffer incomplete (status " + status + ")");
    }
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(u.state, 0);

    function drawLog(base, rows, current) {
      gl.bindTexture(gl.TEXTURE_2D, states[current]);
      gl.uniform1i(u.init, base === 0 ? 1 : 0);
      gl.uniform1i(u.base, base);
      gl.uniform1i(u.advance, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, logFbo);
      gl.viewport(0, base, logWidth, rows);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    // The program's first draw is where the driver really builds it, which
    // can be seconds and says nothing about how long a step takes - so it is
    // spent on a draw nobody times: row 0, which the loop below draws again.
    if (!entry.warmed) {
      drawLog(0, 1, 0);
      gl.readPixels(numBodies, 0, 1, 1, gl.RGBA, gl.FLOAT, sentinel);
      entry.warmed = true;
    }

    // Chunk by chunk, each one timed and the next sized from it (see
    // TRAJECTORY_TARGET_MS). A chunk is two draws of `rows` steps, and the
    // time includes the round trip that measured it - both of which make a
    // step look dearer than it is, which is the safe direction to be wrong
    // in. Growth is capped at doubling, so one optimistic estimate cannot
    // jump straight past the limit; the size it settles on is kept with the
    // program, so the next replay of the same scene starts there.
    var steps = entry.chunkSteps || 1;
    var current = 0;
    for (var base = 0; base < maxSteps && !failure;) {
      var rows = Math.min(steps, chunk.maxSteps, maxSteps - base);
      var startedAt = performance.now();
      drawLog(base, rows, current);
      if (base + rows < maxSteps) {
        // ADVANCE: carry the state to the start of the next chunk.
        gl.bindFramebuffer(gl.FRAMEBUFFER, stateFbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, states[1 - current], 0);
        gl.viewport(0, 0, stripWidth, 1);
        gl.uniform1i(u.advance, rows);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        gl.readPixels(chunk.layers, 0, 1, 1, gl.RGBA, gl.FLOAT, sentinel);
        if (sentinel[0] !== base + rows || sentinel[1] !== TRAJECTORY_SENTINEL) {
          failure = "the state after step " + (base + rows) + " was never written";
        }
        var perStep = (performance.now() - startedAt) / (2 * rows);
        steps = Math.max(1, Math.min(Math.floor(TRAJECTORY_TARGET_MS / perStep), rows * 2, chunk.maxSteps));
        current = 1 - current;
      }
      base += rows;
    }
    entry.chunkSteps = steps;

    var pixels = new Float32Array(logWidth * maxSteps * 4);
    if (!failure) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, logFbo);
      gl.readPixels(0, 0, logWidth, maxSteps, gl.RGBA, gl.FLOAT, pixels);
    }
    // The readback above has already waited for the GPU, so asking for the
    // error flag costs nothing more.
    var glError = gl.getError();

    var trajectory = new Array(maxSteps);
    for (var step = 0; step < maxSteps && !failure; step++) {
      var row = new Array(numBodies);
      for (var b = 0; b < numBodies; b++) {
        var idx = (step * logWidth + b) * 4;
        row[b] = { x: pixels[idx], y: pixels[idx + 1], angle: pixels[idx + 2], half: pixels[idx + 3] };
      }
      trajectory[step] = row;
      var mark = (step * logWidth + numBodies) * 4;
      if (pixels[mark] !== step + 1 || pixels[mark + 1] !== TRAJECTORY_SENTINEL) failure = "step " + (step + 1) + " was never written";
    }

    release();
    if (glError !== gl.NO_ERROR) throw new Error("GPU physics draw failed (GL error 0x" + glError.toString(16) + ")");
    // A draw the GPU gave up on reports nothing - no error, no lost context -
    // and reads back as whatever the texture held. Every caller would take
    // that for a trajectory, so it is an error here instead. (Seen when a
    // single step is itself too long for the GPU's watchdog, which is a
    // scene too heavy for this precision on this machine; the size the
    // chunks had reached is forgotten so the next attempt starts over.)
    if (failure) {
      entry.chunkSteps = 1;
      throw new Error("The GPU dropped a physics draw (" + failure + ") - the scene is too heavy for it at this precision.");
    }
    return trajectory;
  }

  function runSceneOnGPU(scene, maxSteps, precision) {
    return runCompiledTrajectoryOnGPU(compileSceneToTrajectoryGLSL(scene, maxSteps, precision), maxSteps);
  }

  global.PhysicsGPU = {
    MAX_BODIES: MAX_BODIES,
    runSceneOnGPU: runSceneOnGPU,
    runCompiledTrajectoryOnGPU: runCompiledTrajectoryOnGPU,
    generateTrajectoryMainGLSL: generateTrajectoryMainGLSL,
    generateTrajectoryHeaderGLSL: generateTrajectoryHeaderGLSL,
    trajectoryChunkInfo: trajectoryChunkInfo,
    compileSceneToTrajectoryGLSL: compileSceneToTrajectoryGLSL,
    // Exposed so other GLSL-generating code (the per-pixel fractal grid) can
    // reuse the exact same physics formulas and step logic instead of a
    // third hand-maintained copy - see generateStepOnceGLSL's own comment.
    GLSL_LIBRARY: GLSL_LIBRARY,
    // Assembles the full preamble for a given precision - df shaders need
    // the veil uniform, physics-df.js's arithmetic and the DBody bridge in
    // front of the float32 library, in that order.
    libraryGLSL: libraryGLSL,
    VERTEX_SOURCE: VERTEX_SOURCE,
    fnum: fnum,
    bodyConst: bodyConst,
    shapeHalf: shapeHalf,
    collisionPairs: collisionPairs,
    sceneHasSplitter: sceneHasSplitter,
    padSceneForSplitting: padSceneForSplitting,
    generateSpawnSlotLocalsGLSL: generateSpawnSlotLocalsGLSL,
    staticGeometryResetGLSL: staticGeometryResetGLSL,
    playbackStateVariables: playbackStateVariables,
    withWords: withWords,
    playbackStateLayerCount: playbackStateLayerCount,
    generatePlaybackStateDeclarationsGLSL: generatePlaybackStateDeclarationsGLSL,
    generatePlaybackStateLoadGLSL: generatePlaybackStateLoadGLSL,
    generatePlaybackStateOutputsGLSL: generatePlaybackStateOutputsGLSL,
    generatePlaybackStateStoreGLSL: generatePlaybackStateStoreGLSL,
    generateStepOnceGLSL: generateStepOnceGLSL,
    stepOnceCallArgs: stepOnceCallArgs,
    springLinksFor: springLinksFor,
    generateBodyLocalsGLSL: generateBodyLocalsGLSL,
    generateHingeAnchorLocalsGLSL: generateHingeAnchorLocalsGLSL,
    compileShader: compileShader,
    linkProgram: linkProgram,
    FIXED_DT: FIXED_DT,
  };
})(window);
