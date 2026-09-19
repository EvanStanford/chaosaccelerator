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
    "// for the geometry. Float32 only (no df port yet).",
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
    if (precision === "df") lines.push("const vec2 DF_MAX_SPEED = " + global.PhysicsDF.num(cap) + ";");
    return lines.join("\n") + "\n";
  }

  // Everything a df shader needs before any generated code: the uniform
  // dfv() hides behind, the df arithmetic itself, the float32 physics
  // library, and the DBody bridge between the last two. Assembled here so
  // no caller has to remember the order.
  function libraryGLSL(precision, maxSpeed) {
    if (precision !== "df") return speedCapDecls(precision, maxSpeed) + GLSL_LIBRARY;
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

  function stepOnceParams(n, hingeAnchors, precision, spawnBase) {
    var df = precision === "df";
    // In df mode the shape constants are df too. They are per-pixel values
    // whenever a size axis is linked, so leaving them float32 would put a
    // ~1e-7 quantization back on exactly that axis - and now that the
    // collision math is df, they are what it multiplies against.
    var sc = df ? "vec2 " : "float ";
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
      // In df mode only the WORLD anchor is extended-precision. The other
      // two are offsets in some body's own local frame - bounded by that
      // body's size, never a world coordinate, and consumed directly by
      // float32 rotateVec() - so they stay plain vec2 and are collapsed at
      // the call site.
      params.push((hg.aIsWorld ? "inout " : "") + (df ? "DVec2" : "vec2") + " HINGE" + h + "_A",
        (df ? "DVec2" : "vec2") + " HINGE" + h + "_B");
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
        MAX_GLSL_FUNCTION_PARAMS + " - lower Max Objects (currently " + n + " slots) or remove a hinge.");
    }
    return params;
  }

  // The anchor expressions in `hingeAnchors` are float32 GLSL text in f32
  // mode and df (vec2) GLSL text in df mode - whoever built them knows
  // which, and this just has to spell the right constructor.
  function stepOnceCallArgs(n, hingeAnchors, precision, spawnBase) {
    var df = precision === "df";
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
    var df = precision === "df";
    var lines = [];
    (hingeAnchors || []).forEach(function (hg, h) {
      if (!hg.aIsWorld) return;
      lines.push(df
        ? "DVec2 hingeAnchor" + h + " = dv2(" + hg.localA.x + ", " + hg.localA.y + ");"
        : "vec2 hingeAnchor" + h + " = vec2(" + hg.localA.x + ", " + hg.localA.y + ");");
    });
    return lines.join("\n");
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
  // precision: "f32" (default) or "df". The two differ only in spelling -
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
  function generateStepOnceGLSL(n, consts, pairs, hingeAnchors, frame, precision, mutualGravity, collisions, spawnBase) {
    var df = precision === "df";
    var collisionsOn = collisions !== false;
    // One generator, two spellings. GLSL can't give a user type operators,
    // so the df path has to say dfAdd(a, b) where float32 says a + b - but
    // the STRUCTURE of the step is identical, and keeping it in one
    // function is what stops the two from drifting apart. Anything that
    // reads the same in both modes (a struct field assignment, a bool) is
    // simply not routed through here.
    var E = df ? {
      body: "dbody", bodyType: "DBody", scalarType: "vec2", vecType: "DVec2",
      DT: "DF_DT", GRAVITY: "DF_GRAVITY",
      zero: "DF_ZERO", one: "DF_ONE",
      vec: function (x, y) { return "dv2(" + x + ", " + y + ")"; },
      add: function (a, b) { return "dfAdd(" + a + ", " + b + ")"; },
      sub: function (a, b) { return "dfSub(" + a + ", " + b + ")"; },
      mul: function (a, b) { return "dfMul(" + a + ", " + b + ")"; },
      min: function (a, b) { return "dfMin(" + a + ", " + b + ")"; },
      negVec: function (v) { return "dv2Neg(" + v + ")"; },
      advanceVelocity: "dfAdvanceVelocity", noContact: "dfNoContact()",
      contactType: "DContact", contactPairType: "DContactPair",
      collideCircleCircle: "dfCollideCircleCircle", collideLineCircle: "dfCollideLineCircle",
      collideLineLine: "dfCollideLineLine",
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
      negVec: function (v) { return "-" + v; },
      advanceVelocity: "advanceVelocity", noContact: "noContact()",
      contactType: "Contact", contactPairType: "ContactPair",
      collideCircleCircle: "collideCircleCircle", collideLineCircle: "collideLineCircle",
      collideLineLine: "collideLineLine",
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
    // Not supported in df mode: the funnel GLSL functions (see GLSL_LIBRARY)
    // only exist in float32. A funnel is only reachable via the fractal grid
    // at all once physics-grid-codegen.js/fractal-grid.js opt it in, and
    // those force f32 precision whenever a funnel is present for exactly
    // this reason - this check exists as a loud failure if that guard is
    // ever bypassed, rather than silently compiling wrong GLSL.
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
    if (df && consts.some(function (c) { return isTrapezoid(c.type); })) {
      throw new Error("Funnel and splitter bodies are not supported in double-float precision mode yet");
    }
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
    lines.push("");
    lines.push("void stepOnce(" + stepOnceParams(n, hingeAnchors, precision, spawnBase).join(", ") + ") {");
    if (hingeAnchors.some(function (h) { return h.aIsWorld; })) {
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
    // The force math runs in float32 in BOTH precision modes. In df mode the
    // body fields and BODY{i}_HALF are df (vec2) values, so this collapses
    // them with dfToFloat - and does it on the SEPARATION, dfSub'd first, not
    // on the two absolute coordinates. That ordering is the whole point: the
    // separation is a small, well-conditioned number float32 handles easily,
    // whereas collapsing the coordinates first would throw away the very
    // distinction the df pass exists to keep. Only the accumulators - the
    // velocities this feeds - need the extra precision, so the result is
    // widened back to df at the point of use and nowhere earlier.
    //
    // Gravitational mass is derived from BODY{i}_HALF rather than baked,
    // because the fractal grid can link a body's radius or length to a
    // pixel's coordinate: its size, and so its mass, varies per pixel.
    // GRAV_K folds together density, the anchored 10x, and the shape's own
    // constant factor (pi for a circle's area, 2 for a line's half-length).
    // b's position minus a's, as a plain float32 vec2 in either precision.
    // In df the subtraction happens FIRST, at full precision, and only the
    // (small) result is collapsed.
    function separationExpr(a, b) {
      if (!df) return "vec2(body" + b + ".x - body" + a + ".x, body" + b + ".y - body" + a + ".y)";
      return "vec2(dfToFloat(dfSub(dbody" + b + ".x, dbody" + a + ".x)), " +
        "dfToFloat(dfSub(dbody" + b + ".y, dbody" + a + ".y)))";
    }

    // The body of a weld: one velocity for both, momentum-weighted. Shared
    // by the two places a merge can happen (already-overlapping at the start
    // of the step, and a contact the swept detection found during it), so
    // the two can't drift apart. Mirrors PhysicsEngine.weldPair.
    function weldLines(mi, mj, indent) {
      var out = [];
      var anchored = consts[mi].isAnchored ? mi : (consts[mj].isAnchored ? mj : -1);
      if (anchored !== -1) {
        // An anchor absorbs whatever lands on it: the free body stops.
        var free = anchored === mi ? mj : mi;
        ["vx", "vy", "w"].forEach(function (f) {
          out.push(indent + B(free) + "." + f + " = " + E.zero + ";");
        });
        return out;
      }
      // Masses are only carried as their reciprocals, so the momentum
      // weights are written with those directly: weighting v_i by m_i and
      // v_j by m_j, then dividing by (m_i + m_j), is the same as weighting
      // v_i by invMass_j and v_j by invMass_i over (invMass_i + invMass_j) -
      // no mass is ever formed, so an anchored body's zero can't divide.
      var weightI = "BODY" + mj + "_INV_MASS", weightJ = "BODY" + mi + "_INV_MASS";
      var denom = E.add(weightI, weightJ);
      var recip = df ? "dfDiv(DF_ONE, " + denom + ")" : "(1.0 / (" + denom + "))";
      out.push(indent + E.scalarType + " mvScale = " + recip + ";");
      ["vx", "vy", "w"].forEach(function (f) {
        out.push(indent + E.scalarType + " mv_" + f + " = " +
          E.mul(E.add(E.mul(weightI, B(mi) + "." + f), E.mul(weightJ, B(mj) + "." + f)), "mvScale") + ";");
      });
      ["vx", "vy", "w"].forEach(function (f) {
        out.push(indent + B(mi) + "." + f + " = mv_" + f + "; " + B(mj) + "." + f + " = mv_" + f + ";");
      });
      return out;
    }

    var accelExpr = {};
    if (mutualGravity) {
      var gravK = consts.map(function (c) {
        var density = c.isAnchored ? global.PhysicsEngine.ANCHORED_GRAVITY_DENSITY : 1;
        return c.type === "circle"
          ? density * global.PhysicsEngine.DENSITY * Math.PI
          : density * global.PhysicsEngine.LINE_LINEAR_DENSITY * 2;
      });
      // A plain float32 half-extent for every body, so the force math below
      // (and the merge above) can be written once for both precisions.
      for (var h32 = 0; h32 < n; h32++) {
        lines.push("  float fHalf" + h32 + " = " +
          (df ? "dfToFloat(BODY" + h32 + "_HALF)" : "BODY" + h32 + "_HALF") + ";");
      }
      for (var m = 0; m < n; m++) {
        lines.push("  float gravMass" + m + " = " + fnum(gravK[m]) + " * fHalf" + m +
          (consts[m].type === "circle" ? " * fHalf" + m : "") + ";");
      }

      // ---- Merge on contact: the port of PhysicsEngine.applyContactMerge ----
      //
      // Touching bodies move as one. Emitted before anything reads a
      // velocity, exactly as the JS engine applies it before reading its
      // own - see applyContactMerge for why that ordering is what makes the
      // merged state hold instead of being re-launched within the same step.
      // Stateless by design, so nothing has to persist between shader
      // invocations, which the Body struct has nowhere to put.
      pairs.forEach(function (pair) {
        var mi = pair[0], mj = pair[1];
        lines.push("  {");
        lines.push("    vec2 md = " + separationExpr(mi, mj) + ";");
        lines.push("    float mc = fHalf" + mi + " + fHalf" + mj + ";");
        var weldGate = bothAliveExpr(mi, mj);
        lines.push("    if (dot(md, md) <= mc * mc" + (weldGate ? " && " + weldGate : "") + ") {");
        weldLines(mi, mj, "      ").forEach(function (l) { lines.push(l); });
        lines.push("    }");
        lines.push("  }");
      });
      lines.push("");
      for (var a = 0; a < n; a++) {
        if (consts[a].isAnchored) continue; // never accelerates, so never needs a sum
        lines.push("  vec2 gravAcc" + a + " = vec2(0.0);");
        for (var b2 = 0; b2 < n; b2++) {
          if (b2 === a) continue;
          lines.push("  {");
          lines.push("    vec2 d = " + separationExpr(a, b2) + ";");
          // Bodies that are touching pull on each other not at all - see
          // PhysicsEngine.computeAccelerations for why (short version: the
          // contact solver's positional correction would otherwise be lifting
          // the body out of a very steep well for free, inventing energy).
          // It also bounds this expression: r2 can never get near zero, so
          // there is no singularity to guard against.
          // With collisions off nothing supplies that force and bodies pass
          // through each other, so the pull ramps linearly to zero inside
          // `contact` instead of being switched off at its rim - same reason,
          // same formula, same comment as the JS engine's branch.
          lines.push("    float contact = fHalf" + a + " + fHalf" + b2 + ";");
          lines.push("    float r2 = dot(d, d);");
          if (collisionsOn) {
            lines.push("    if (r2 >= contact * contact) gravAcc" + a + " += (" +
              fnum(global.PhysicsEngine.MUTUAL_GRAVITY_CONSTANT) +
              " * gravMass" + b2 + " / (r2 * sqrt(r2))) * d;");
          } else {
            lines.push("    float pull" + b2 + " = (r2 >= contact * contact)");
            lines.push("      ? " + fnum(global.PhysicsEngine.MUTUAL_GRAVITY_CONSTANT) +
              " * gravMass" + b2 + " / (r2 * sqrt(r2))");
            lines.push("      : " + fnum(global.PhysicsEngine.MUTUAL_GRAVITY_CONSTANT) +
              " * gravMass" + b2 + " / (contact * contact * contact);");
            lines.push("    gravAcc" + a + " += pull" + b2 + " * d;");
          }
          lines.push("  }");
        }
        accelExpr[a] = df ? "dv2(dfFromFloat(gravAcc" + a + ".x), dfFromFloat(gravAcc" + a + ".y))"
                          : "gravAcc" + a;
      }
      lines.push("");
    }
    function accelFor(i) {
      if (mutualGravity) return accelExpr[i];
      return df ? "dv2(DF_ZERO, DF_GRAVITY)" : "vec2(0.0, GRAVITY)";
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
        lines.push("  " + E.contactPairType + " " + varName + " = " + E.contactPairType + "(" + E.collideLineCircle + "(" + refI + ", BODY" + i + "_HALF, " + refJ + ", BODY" + j + "_HALF), " + E.noContact + ");");
      } else if (tA === "circle" && tB === "line") {
        // collideLineCircle(line, circle) always takes (line, circle) in
        // that order, so calling it as (body_j=line, body_i=circle) here
        // returns rA/rB for (line=j, circle=i) - the opposite of this
        // pair's own i/j. Swap them back along with flipping the normal,
        // matching physics-engine.js's collidePair - see its own comment.
        lines.push("  " + E.contactType + " " + varName + "_raw = " + E.collideLineCircle + "(" + refJ + ", BODY" + j + "_HALF, " + refI + ", BODY" + i + "_HALF);");
        lines.push("  " + varName + "_raw.normal = " + E.negVec(varName + "_raw.normal") + ";");
        lines.push("  { " + E.vecType + " tmp_" + i + "_" + j + " = " + varName + "_raw.rA; " + varName + "_raw.rA = " + varName + "_raw.rB; " + varName + "_raw.rB = tmp_" + i + "_" + j + "; }");
        lines.push("  " + E.contactPairType + " " + varName + " = " + E.contactPairType + "(" + varName + "_raw, " + E.noContact + ");");
      } else {
        lines.push("  " + E.contactPairType + " " + varName + " = " + E.collideLineLine + "(" + refI + ", BODY" + i + "_HALF, " + refJ + ", BODY" + j + "_HALF);");
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
        touching.push("(" + vn + ".c0.hit || " + vn + ".c1.hit)");
      });
      lines.push("  g_contact" + cf + " = " + (touching.length ? touching.join(" || ") : "false") + ";");
    }
    lines.push("");

    // Per-body tHit: the earliest contact instant among everything that
    // body touches this step, defaulting to DT (no contact -> the whole
    // step is "leg 1", leg 2 never runs - see leg 2's own comment). Every
    // circle-circle/line-circle pair fills BOTH ContactPair slots even
    // though only one is ever real - c1 is noContact() - so an unguarded
    // min() would let a not-hit placeholder's tHit (0.0, same as an
    // already-touching contact's) drag every body's tHit down to 0.0.
    // Fold in a slot's tHit only when it actually hit.
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
      var pairMin = E.min(contactTHitExpr(varName, "c0"), contactTHitExpr(varName, "c1"));
      if (!consts[i].isAnchored) {
        lines.push("  body" + i + "THit = " + E.min("body" + i + "THit", pairMin) + ";");
      }
      if (!consts[j].isAnchored) {
        lines.push("  body" + j + "THit = " + E.min("body" + j + "THit", pairMin) + ";");
      }
    });
    lines.push("");

    // ---- Funnel<->circle pairs (float32 only - see the throw above) ----
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
        lines.push("  FunnelVerts " + vn + "_v = funnelVertices(" + refF + ", BODY" + fi + "_HALF * 2.0);");
        fp.walls.forEach(function (w) {
          lines.push("  Contact " + vn + "_" + w[0] + " = sweptCapsuleCircleContact(" + vn + "_v." + w[1] + ", " + vn + "_v." + w[2] +
            ", vec2(" + refF + ".vx, " + refF + ".vy), vec2(" + refF + ".x, " + refF + ".y), " + refC + ", BODY" + ci + "_HALF, LINE_THICKNESS * 0.5);");
          if (gate) lines.push("  if (!" + gate + ") " + vn + "_" + w[0] + ".hit = false;");
        });
        if (fp.kind === "funnel") {
          lines.push("  MouthHit " + vn + "_mouth = collideFunnelMouthTHit(" + refF + ", BODY" + fi + "_HALF * 2.0, " + refC + ", BODY" + ci + "_HALF);");
          if (gate) lines.push("  if (!" + gate + ") " + vn + "_mouth.hit = false;");
        } else {
          // NOT folded into either body's tHit, matching
          // physics-engine.js's step(): a split is applied at the very end
          // of the step, off the fully integrated position, so it takes no
          // part in the leg-1/leg-2 sub-stepping the way a funnel teleport
          // does.
          lines.push("  SplitHit " + vn + "_split = collideSplitterShortSideTHit(" + refF + ", BODY" + fi + "_HALF * 2.0, " + refC + ", BODY" + ci + "_HALF);");
          if (gate) lines.push("  if (!" + gate + ") " + vn + "_split.hit = false;");
        }
        var wallTHits = fp.walls.map(function (w) { return vn + "_" + w[0] + ".hit ? " + vn + "_" + w[0] + ".tHit : DT"; });
        lines.push("  float " + vn + "_solidTHit = min(" + wallTHits[0] + ", min(" + wallTHits[1] + ", " + wallTHits[2] + "));");
        if (!consts[fi].isAnchored) lines.push("  body" + fi + "THit = min(body" + fi + "THit, " + vn + "_solidTHit);");
        if (!consts[ci].isAnchored) lines.push("  body" + ci + "THit = min(body" + ci + "THit, " + vn + "_solidTHit);");
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
        lines.push("  float teleTHit_" + ci + " = DT;");
        lines.push("  vec2 teleTarget_" + ci + " = vec2(0.0);");
        lines.push("  int teleFunnel_" + ci + " = -1;");
        lines.push("  bool teleFound_" + ci + " = false;");
        funnelPairsByCircle[ci].forEach(function (fi) {
          var vn = "trap_" + fi + "_" + ci;
          lines.push("  if (" + vn + "_mouth.hit && (!teleFound_" + ci + " || " + vn + "_mouth.tHit < teleTHit_" + ci + ")) { teleTHit_" + ci + " = " +
            vn + "_mouth.tHit; teleTarget_" + ci + " = " + vn + "_mouth.target; teleFunnel_" + ci + " = " + fi + "; teleFound_" + ci + " = true; }");
        });
        lines.push("  bool teleWon_" + ci + " = teleFound_" + ci + " && teleTHit_" + ci + " <= body" + ci + "THit;");
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
        lines.push("  float splitTHit_" + ci + " = DT;");
        lines.push("  vec2 splitOff1_" + ci + " = vec2(0.0);");
        lines.push("  vec2 splitOff2_" + ci + " = vec2(0.0);");
        splitterPairs.forEach(function (sp) {
          if (sp.circle !== ci) return;
          var vn = "trap_" + sp.trap + "_" + ci;
          lines.push("  if (" + vn + "_split.hit && (!splitFound_" + ci + " || " + vn + "_split.tHit < splitTHit_" + ci + ")) { " +
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
          B(g3) + ".x += vFull" + g3 + ".x * " + t1 + "; " + B(g3) + ".y += vFull" + g3 + ".y * " + t1 + "; }");
      } else {
        lines.push("  " + B(g3) + ".x = " + E.add(B(g3) + ".x", E.mul("vFull" + g3 + ".x", t1)) + ";");
        lines.push("  " + B(g3) + ".y = " + E.add(B(g3) + ".y", E.mul("vFull" + g3 + ".y", t1)) + ";");
      }
      lines.push("  " + B(g3) + ".angle = " + E.add(B(g3) + ".angle", E.mul(B(g3) + ".w", t1)) + ";");
      lines.push("  " + E.vecType + " vPre" + g3 + " = " + E.advanceVelocity + "(u" + g3 + ", " + t1 + ", " + accelFor(g3) + ");");
      lines.push("  " + B(g3) + ".vx = vPre" + g3 + ".x; " + B(g3) + ".vy = vPre" + g3 + ".y;");
    }
    lines.push("");

    // Merge whatever the swept detection actually hit this step - the port
    // of PhysicsEngine.mergeDetectedContacts, and emitted at the matching
    // point: bodies are at the contact instant carrying their pre-impulse
    // velocities, so the solver below finds nothing left to bounce. Without
    // this a collision fast enough to begin and end inside one step is never
    // seen overlapping at a step boundary and rebounds straight through the
    // merge.
    if (mutualGravity) {
      // ordinaryPairs, not pairs: a trapezoid<->circle pair is handled by
      // its own codegen above and never declares a pair_i_j ContactPair, so
      // naming one here emitted GLSL that referenced an undeclared variable
      // whenever Mutual Gravity met a funnel. The contacts it does name are
      // already alive-gated, so no separate spawn-slot test is needed.
      ordinaryPairs.forEach(function (pair) {
        var varName = "pair_" + pair[0] + "_" + pair[1];
        lines.push("  if (" + varName + ".c0.hit || " + varName + ".c1.hit) {");
        weldLines(pair[0], pair[1], "    ").forEach(function (l) { lines.push(l); });
        lines.push("  }");
      });
      lines.push("");
    }

    // A df sin/cos is a Cody-Waite reduction plus a Taylor series, easily
    // the most expensive routine in that library - and the velocity solve
    // below rotates each hinge anchor about its body's angle on every one
    // of its 8 iterations, even though nothing in that loop can change an
    // angle. So hoist it: compute each participating body's sin/cos once
    // and pass it in. Exact, not an approximation, and it removes ~4/5 of
    // the trig from a hinge-heavy scene. The float32 path has a hardware
    // instruction for this and doesn't care, so it keeps recomputing.
    var hingeBodies = {};
    hingeAnchors.forEach(function (hg) {
      if (!hg.aIsWorld) hingeBodies[hg.a] = true;
      hingeBodies[hg.b] = true;
    });
    if (df) {
      Object.keys(hingeBodies).forEach(function (idx) {
        lines.push("  vec2 sinB" + idx + ", cosB" + idx + "; dfSinCos(" + B(idx) + ".angle, sinB" + idx + ", cosB" + idx + ");");
      });
      if (Object.keys(hingeBodies).length) lines.push("");
    }

    // Reads the HINGEn_A/B parameters stepOnceParams declared above, rather
    // than constructing vec2(...) here - see stepOnceParams's comment.
    function hingeArgs(hg, hi, velocityOrPosition) {
      var velocity = velocityOrPosition === "velocity";
      var fn = velocity ? E.solveHingeVelocity : E.solveHingePosition;
      var aExpr, aInvMass, aInvInertia, aTrig, bTrig;
      if (hg.aIsWorld) {
        aExpr = "worldBody";
        aInvMass = E.zero;
        aInvInertia = E.zero;
        // The world pin never rotates, so its sin/cos are the constants.
        aTrig = E.zero + ", " + E.one;
      } else {
        aExpr = B(hg.a);
        aInvMass = "BODY" + hg.a + "_INV_MASS";
        aInvInertia = "BODY" + hg.a + "_INV_INERTIA";
        aTrig = "sinB" + hg.a + ", cosB" + hg.a;
      }
      bTrig = "sinB" + hg.b + ", cosB" + hg.b;
      // Only the velocity solver takes hoisted trig - the position solver
      // moves bodies, so it has to recompute its own or it would go stale
      // between iterations.
      var trigA = (df && velocity) ? ", " + aTrig : "";
      var trigB = (df && velocity) ? ", " + bTrig : "";
      return fn + "(" + aExpr + ", " + aInvMass + ", " + aInvInertia + ", HINGE" + hi + "_A" + trigA + ", " +
        B(hg.b) + ", BODY" + hg.b + "_INV_MASS, BODY" + hg.b + "_INV_INERTIA, HINGE" + hi + "_B" + trigB + ");";
    }

    lines.push("  for (int iter = 0; iter < " + VELOCITY_ITERATIONS + "; iter++) {");
    hingeAnchors.forEach(function (hg, hi) { lines.push("    " + hingeArgs(hg, hi, "velocity")); });
    ordinaryPairs.forEach(function (pair) {
      var varName = "pair_" + pair[0] + "_" + pair[1];
      ["c0", "c1"].forEach(function (slot) {
        lines.push("    " + E.solveContactVelocity + "(" + B(pair[0]) + ", BODY" + pair[0] + "_INV_MASS, BODY" + pair[0] + "_INV_INERTIA, " +
          B(pair[1]) + ", BODY" + pair[1] + "_INV_MASS, BODY" + pair[1] + "_INV_INERTIA, " + varName + "." + slot + ");");
      });
    });
    trapezoidPairs.forEach(function (fp) {
      var fi = fp.trap, ci = fp.circle;
      var vn = "trap_" + fi + "_" + ci;
      var excluded = trapezoidExclusion(fp, fi, ci);
      lines.push("    if (!" + excluded + ") {");
      fp.walls.forEach(function (w) {
        lines.push("      solveContactVelocity(" + B(fi) + ", BODY" + fi + "_INV_MASS, BODY" + fi + "_INV_INERTIA, " +
          B(ci) + ", BODY" + ci + "_INV_MASS, BODY" + ci + "_INV_INERTIA, " + vn + "_" + w[0] + ");");
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
      lines.push("  " + B(g2) + ".x = " + E.add(B(g2) + ".x", E.mul("vPost" + g2 + ".x", t2)) + ";");
      lines.push("  " + B(g2) + ".y = " + E.add(B(g2) + ".y", E.mul("vPost" + g2 + ".y", t2)) + ";");
      lines.push("  " + B(g2) + ".angle = " + E.add(B(g2) + ".angle", E.mul(B(g2) + ".w", t2)) + ";");
    }
    lines.push("");
    lines.push("  for (int iter = 0; iter < " + POSITION_ITERATIONS + "; iter++) {");
    hingeAnchors.forEach(function (hg, hi) { lines.push("    " + hingeArgs(hg, hi, "position")); });
    ordinaryPairs.forEach(function (pair) {
      var varName = "pair_" + pair[0] + "_" + pair[1];
      ["c0", "c1"].forEach(function (slot) {
        lines.push("    " + E.solveContactPosition + "(" + B(pair[0]) + ", BODY" + pair[0] + "_INV_MASS, " +
          B(pair[1]) + ", BODY" + pair[1] + "_INV_MASS, " + varName + "." + slot + ");");
      });
    });
    trapezoidPairs.forEach(function (fp) {
      var fi = fp.trap, ci = fp.circle;
      var vn = "trap_" + fi + "_" + ci;
      var excluded = trapezoidExclusion(fp, fi, ci);
      lines.push("    if (!" + excluded + ") {");
      fp.walls.forEach(function (w) {
        lines.push("      solveContactPosition(" + B(fi) + ", BODY" + fi + "_INV_MASS, " + B(ci) + ", BODY" + ci + "_INV_MASS, " + vn + "_" + w[0] + ");");
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
      var frameW = fnum(frame.width), frameH = fnum(frame.height);
      lines.push("");
      for (var root = 0; root < n; root++) {
        if (consts[root].isAnchored || isChild[root]) continue;
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
          lines.push("  if (dfGreater(" + refX + ", vec2(" + frameW + ", 0.0))) " + dxVar + " = -" + frameW + "; else if (dfLess(" + refX + ", vec2(0.0, 0.0))) " + dxVar + " = " + frameW + ";");
          lines.push("  if (dfGreater(" + refY + ", vec2(" + frameH + ", 0.0))) " + dyVar + " = -" + frameH + "; else if (dfLess(" + refY + ", vec2(0.0, 0.0))) " + dyVar + " = " + frameH + ";");
        } else {
          lines.push("  if (" + refX + " > " + frameW + ") " + dxVar + " = -" + frameW + "; else if (" + refX + " < 0.0) " + dxVar + " = " + frameW + ";");
          lines.push("  if (" + refY + " > " + frameH + ") " + dyVar + " = -" + frameH + "; else if (" + refY + " < 0.0) " + dyVar + " = " + frameH + ";");
        }
        if (hasWorldHinge) {
          var hv = "HINGE" + ownWorldHingeIdx[root] + "_A";
          lines.push(df
            ? "  " + hv + ".x = dfAddFloat(" + hv + ".x, " + dxVar + "); " + hv + ".y = dfAddFloat(" + hv + ".y, " + dyVar + ");"
            : "  " + hv + " += vec2(" + dxVar + ", " + dyVar + ");");
        }
        var descendants = {};
        collectDescendants(root, descendants);
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
        lines.push("    float childX_" + ci + " = body" + ci + ".x + splitOff2_" + ci + ".x;");
        lines.push("    float childY_" + ci + " = body" + ci + ".y + splitOff2_" + ci + ".y;");
        lines.push("    body" + ci + ".x += splitOff1_" + ci + ".x;");
        lines.push("    body" + ci + ".y += splitOff1_" + ci + ".y;");
        if (spawnSlots.length) {
          // At the ceiling the ball still passes through - the offset above
          // has already been applied - it just doesn't duplicate.
          lines.push("    if (liveCount < " + n + ") {");
          spawnSlots.forEach(function (k, si) {
            lines.push("      " + (si === 0 ? "if" : "else if") + " (liveCount == " + k + ") { " +
              "body" + k + " = Body(childX_" + ci + ", childY_" + ci + ", body" + ci + ".angle, body" + ci + ".vx, body" + ci + ".vy, body" + ci + ".w); " +
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
    var df = precision === "df";
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
      var sc = df ? "vec2 " : "float ";
      lines.push(sc + "BODY" + i + "_INV_MASS = " + num(b.invMass) + ";");
      lines.push(sc + "BODY" + i + "_INV_INERTIA = " + num(b.invInertia) + ";");
      lines.push(sc + "BODY" + i + "_HALF = " + num(shapeHalf(consts, i)) + ";");
    }
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
  function generateTrajectoryMainGLSL(n, bodyDeclarationsGLSL, hingeAnchors, precision, spawnBase) {
    var df = precision === "df";
    var isSpawnSlot = {};
    spawnSlotsFrom(n, spawnBase).forEach(function (i) { isSpawnSlot[i] = true; });
    function readField(i, field) { return df ? "dfToFloat(dbody" + i + "." + field + ")" : "body" + i + "." + field; }
    var lines = [];
    lines.push("void main() {");
    lines.push("  " + bodyDeclarationsGLSL.split("\n").join("\n  "));
    // Row 0 reports the state after 1 step (not 0) so that every row is a
    // real, distinct simulation step and trajectory[maxSteps-1] is the state
    // after exactly maxSteps steps - matching how PhysicsEngine.step() is
    // called maxSteps times, not maxSteps-1.
    lines.push("  int stepTarget = int(gl_FragCoord.y) + 1;");
    lines.push("  int bodyIdx = int(gl_FragCoord.x);");
    lines.push("  for (int i = 0; i < MAX_STEPS; i++) {");
    lines.push("    if (i >= stepTarget) break;");
    lines.push("    stepOnce(" + stepOnceCallArgs(n, hingeAnchors, precision, spawnBase) + ");");
    lines.push("  }");
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
      // BODYn_HALF is a df scalar in df mode, but the alpha channel it
      // lands in is a plain float either way - this is a rendered size for
      // the replay to draw with, not state.
      var half = df ? "dfToFloat(BODY" + o + "_HALF)" : "BODY" + o + "_HALF";
      // A spawn slot nobody has split into yet reports size 0 - the same
      // signal a reader already uses to draw nothing, and what tells the
      // replay how many balls existed at this step without a second channel.
      if (isSpawnSlot[o]) half = "(alive" + o + " ? " + half + " : 0.0)";
      lines.push((o === 0 ? "  if" : "  else if") + " (bodyIdx == " + o + ") { outVal = vec3(" +
        readField(o, "x") + ", " + readField(o, "y") + ", " + readField(o, "angle") + "); outHalf = " + half + "; }");
    }
    lines.push("  fragColor = vec4(outVal, outHalf);");
    lines.push("}");
    return lines.join("\n");
  }

  // precision is "f32" (default) or "df". #editor-view's Play button never
  // needs df - it runs one scene at one set of starting conditions, where
  // float32 was never the limit - but the regression suite compiles the
  // same scene both ways to check the two agree, so it's a parameter here
  // rather than a hardcoded "f32".
  function compileSceneToTrajectoryGLSL(scene, maxSteps, precision) {
    var df = precision === "df";
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
    lines.push("precision highp float;");
    lines.push("out vec4 fragColor;");
    lines.push("");
    lines.push(libraryGLSL(precision, global.PhysicsEngine.speedCapFor(scene)));
    lines.push("");
    lines.push("const int MAX_STEPS = " + maxSteps + ";");
    lines.push("");
    lines.push(generateStepOnceGLSL(n, consts, pairs, hingeAnchors, frame, precision, scene.mutualGravity, PhysicsEngine.collisionsEnabled(scene), spawnBase));
    lines.push("");
    var locals = generateBodyLocalsGLSL(consts, precision) + "\n" + generateHingeAnchorLocalsGLSL(hingeAnchors, precision);
    var spawnLocals = generateSpawnSlotLocalsGLSL(n, spawnBase);
    if (spawnLocals) locals += "\n" + spawnLocals;
    lines.push(generateTrajectoryMainGLSL(n, locals, hingeAnchors, precision, spawnBase));

    return { fragmentSource: lines.join("\n"), numBodies: n };
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

  // Runs an already-compiled { fragmentSource, numBodies } (from either
  // compileSceneToTrajectoryGLSL or the fractal grid's hover-replay
  // compiler - same shape, same texture-logging convention) and reads back
  // the resulting trajectory. Split out from runSceneOnGPU so hover-replay
  // can reuse this WebGL orchestration (and its context disposal - see the
  // comment at the bottom) without a scene of its own to compile from.
  function runCompiledTrajectoryOnGPU(compiled, maxSteps) {
    var numBodies = compiled.numBodies;
    if (numBodies === 0) return [];

    var canvas = new OffscreenCanvas(numBodies, maxSteps);
    var gl = canvas.getContext("webgl2");
    if (!gl) throw new Error("WebGL2 is not available for GPU physics.");
    if (!gl.getExtension("EXT_color_buffer_float")) {
      throw new Error("EXT_color_buffer_float is not available for GPU physics.");
    }

    var vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SOURCE);
    var fs = compileShader(gl, gl.FRAGMENT_SHADER, compiled.fragmentSource);
    var program = linkProgram(gl, vs, fs);
    gl.useProgram(program);

    var quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    var posLoc = gl.getAttribLocation(program, "a_position");
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    var texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, numBodies, maxSteps, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    var fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    var status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error("GPU physics framebuffer incomplete (status " + status + ")");
    }

    gl.viewport(0, 0, numBodies, maxSteps);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    var pixels = new Float32Array(numBodies * maxSteps * 4);
    gl.readPixels(0, 0, numBodies, maxSteps, gl.RGBA, gl.FLOAT, pixels);

    var trajectory = new Array(maxSteps);
    for (var step = 0; step < maxSteps; step++) {
      var row = new Array(numBodies);
      for (var b = 0; b < numBodies; b++) {
        var idx = (step * numBodies + b) * 4;
        row[b] = { x: pixels[idx], y: pixels[idx + 1], angle: pixels[idx + 2], half: pixels[idx + 3] };
      }
      trajectory[step] = row;
    }

    gl.deleteTexture(texture);
    gl.deleteFramebuffer(fbo);
    gl.deleteBuffer(quadBuffer);
    gl.deleteProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);

    // Deleting the individual GL objects above frees GPU memory, but the
    // context itself stays alive until garbage collection gets around to
    // the canvas - and browsers cap live WebGL contexts per page (single
    // digits to low teens). A fresh context per Play click is fine for
    // occasional clicks, but anything that calls this in a loop (bulk runs,
    // hover scrubbing) would exhaust that budget and start silently losing
    // older contexts mid-run. Releasing it explicitly avoids relying on GC
    // timing for something with a hard, small limit.
    var loseCtx = gl.getExtension("WEBGL_lose_context");
    if (loseCtx) loseCtx.loseContext();

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
    generateStepOnceGLSL: generateStepOnceGLSL,
    stepOnceCallArgs: stepOnceCallArgs,
    generateBodyLocalsGLSL: generateBodyLocalsGLSL,
    generateHingeAnchorLocalsGLSL: generateHingeAnchorLocalsGLSL,
    compileShader: compileShader,
    linkProgram: linkProgram,
    FIXED_DT: FIXED_DT,
  };
})(window);
