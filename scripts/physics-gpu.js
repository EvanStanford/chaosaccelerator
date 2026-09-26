// CPAL-1.0 License. See chaosaccelerator.com/license.html

// Compiles a scene into a specialized GLSL program (every pair and hinge
// unrolled, since the scene is fixed when Play is clicked), runs it on an
// offscreen WebGL2 context and logs every body's (x, y, angle) per step.
(function (global) {
  "use strict";

  var MAX_BODIES = 6;
  // GLSL ES 3.00's parameter-count ceiling; only stepOnce() approaches it.
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
    // tHit 0.0 = touching at the step's start; only collideCircleCircle's swept branch sets another.
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
    // accel is the body's whole acceleration (per-body under Mutual Gravity).
    "vec2 advanceVelocity(vec2 v, float dt, vec2 accel) {",
    "  v += accel * dt;",
    // PhysicsEngine.AIR_DRAG (experimental): no line at all when it is 0.
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
    "    // Not touching yet at the start of this step: solve for whether",
    "    // straight-line motion at the current velocities brings them",
    "    // together before this step's own DT elapses. Without this, a fast",
    "    // enough approach only gets caught once some future step's STARTING",
    "    // position happens to already be past the boundary, which step that",
    "    // ends up being is a discontinuous function of the starting",
    "    // conditions, so the resulting bounce is too (a tiny nudge to a",
    "    // starting position can shift which discrete step first notices",
    "    // contact, and each step's own velocity/penetration state differs).",
    "    // Solving the exact crossing time instead makes the contact normal -",
    "    // and everything downstream of it: a continuous function of where",
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
    "    // t), not a's stale start-of-step position, otherwise rB below",
    "    // (point minus b's UNADVANCED center) picks up a spurious component",
    "    // along vRel*t instead of landing exactly on -n*rb, injecting",
    "    // phantom spin into a contact that should only ever be linear for",
    "    // two circles. rA/rB are the lever arms themselves, not derived by",
    "    // subtracting a center from .point at solve time: for a circle the",
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
    "// constant velocity segVel, otherwise rigid: rotation during the step",
    "// is ignored) vs. circle. Shared by collideLineCircle (segment = the",
    "// line's own body, refCenter = its center) and every funnel edge",
    "// (segment = one of the funnel's edges, refCenter = the FUNNEL's",
    "// center, since rA is a lever arm on the whole funnel body, not on an",
    "// implicit sub-body): same three sub-tests (flat side of the capsule",
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
    "// overlapping: a single point can't stop a rod from spinning around it -",
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
    "// of its throat, velocity unchanged: direct port of",
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
    "// this step? Only tHit/target matter: no impulse is ever applied for a",
    "// teleport, unlike the 3 solid edges (see collideFunnelCircle in",
    "// physics-engine.js: this is its GLSL twin, minus the Contact-array",
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
    "// physics-engine.js's collideSplitterShortSideTHit: see that function",
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
    "  // it: the same order physics-engine.js uses.",
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
    "// update below a no-op for them: no separate isAnchored branch needed.",
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
    "  // re-derived as (point - center) here: the centers are mid-step and",
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
    "  // without being a cliff: this is also what keeps a grazing hit",
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

  // The df port of GLSL_LIBRARY lives in physics-gpu-df.js and carries the whole step.

  var VERTEX_SOURCE = [
    "#version 300 es",
    "in vec2 a_position;",
    "void main() { gl_Position = vec4(a_position, 0.0, 1.0); }",
  ].join("\n");

  // Per-scene cap (PhysicsEngine.speedCapFor); must precede the library, which references it.
  function speedCapDecls(precision, maxSpeed) {
    var cap = maxSpeed === undefined ? global.PhysicsEngine.MAX_SPEED : maxSpeed;
    var lines = ["const float MAX_SPEED = " + fnum(cap) + ";"];
    if (global.PhysicsDF.isExtended(precision)) lines.push("const MF DF_MAX_SPEED = " + global.PhysicsDF.num(cap) + ";");
    return lines.join("\n") + "\n";
  }

  // The full preamble a shader needs before generated code, in the right order.
  function libraryGLSL(precision, maxSpeed) {
    if (!global.PhysicsDF.isExtended(precision)) return speedCapDecls(precision, maxSpeed) + GLSL_LIBRARY;
    // Everything multi-float from here on is at this precision (PhysicsDF.usePrecision).
    global.PhysicsDF.usePrecision(precision);
    // Order matters: df arithmetic, then the f32 library (mixed callers still use it), then df physics.
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
    if (consts[i].type === "funnel" || consts[i].type === "splitter") return consts[i].size / 2;
    return consts[i].length / 2;
  }

  // Unrolled at codegen time: each pair's collision function is known statically.
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

  // Spawn slots: in a splitter scene every body from spawnBase up is a slot,
  // dead until a circle splits into it. Its shape constants, alive flag and
  // lineage persist across stepOnce() calls, so they are inout parameters.
  function spawnSlotsFrom(n, spawnBase) {
    if (spawnBase === undefined || spawnBase === null) return [];
    var out = [];
    for (var i = spawnBase; i < n; i++) out.push(i);
    return out;
  }

  // ---- Springs, as the generators see them ----
  // One { aIsWorld, a, b, localA, localB, stiffness, restLength } per spring, anchors
  // already GLSL text in the pass's precision (they can be per-pixel). An anchor
  // with `zero: true` is dead center: no rotation, torque or parameter needed.
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

  // PhysicsEngine.springSpin in GLSL; df branches instead of max() to skip a divide by one.
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
    // Parameter order is shared with stepOnceCallArgs. Hinge anchors are parameters,
    // not baked literals: a resize-linked anchor is a runtime expression only in
    // scope in main(). In df the shape constants are df too (per-pixel when linked).
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
      // A world hinge's anchor is wrapped in place by stepOnce(), so inout; a body-local one never is.
      params.push((hg.aIsWorld ? "inout " : "") + (df ? "DVec2" : "vec2") + " HINGE" + h + "_A",
        (df ? "DVec2" : "vec2") + " HINGE" + h + "_B");
    });
    // Spring anchors are never inout: a tethered group never wraps (PhysicsEngine.springGroups).
    (springs || []).forEach(function (sp, s) {
      if (springEndNeedsParam(sp, "A")) params.push((df ? "DVec2" : "vec2") + " SPRING" + s + "_A");
      if (springEndNeedsParam(sp, "B")) params.push((df ? "DVec2" : "vec2") + " SPRING" + s + "_B");
    });
    // liveCount is threaded through the run, not recomputed from the alive flags.
    if (spawnSlots.length) params.push("inout int liveCount");
    // Counted here: the driver's own error for this names a line in generated code.
    if (params.length > MAX_GLSL_FUNCTION_PARAMS) {
      throw new Error("This scene needs " + params.length + " stepOnce() parameters, past GLSL's limit of " +
        MAX_GLSL_FUNCTION_PARAMS + " - lower Max Objects (currently " + n + " slots) or remove a hinge or spring.");
    }
    return params;
  }

  // hingeAnchors' text is already in the pass's precision; this just picks the constructor.
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
      // World hinge: by reference, so stepOnce()'s wrap persists across calls.
      args.push(hg.aIsWorld ? ("hingeAnchor" + h) : localVec(hg.localA), localVec(hg.localB));
    });
    (springs || []).forEach(function (sp) {
      if (springEndNeedsParam(sp, "A")) args.push(localVec(sp.localA));
      if (springEndNeedsParam(sp, "B")) args.push(localVec(sp.localB));
    });
    if (spawnSlots.length) args.push("liveCount");
    return args.join(", ");
  }

  // One mutable vec2 per world hinge, wrapped in place across stepOnce() calls.
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

  // Goes wherever a pixel's bodies are declared: a fresh set of bodies must rebuild df's anchored geometry.
  function staticGeometryResetGLSL(precision) {
    return global.PhysicsDF.isExtended(precision) ? "g_dfStaticGeomReady = false;" : "";
  }

  // ---- Splitter scenes: pre-allocated spawn slots ----
  // A compiled shader cannot create a body, so a splitter scene is padded up to
  // its Max Objects with dead radius-0 circles (invMass = invInertia = 0) and a
  // split wakes one. A dead slot still integrates and wraps: unobservable, cheaper than gating.
  function sceneHasSplitter(scene) {
    return scene.bodies.some(function (b) { return b.type === "splitter"; });
  }

  // A scene with no splitter is returned untouched with spawnBase null.
  function padSceneForSplitting(scene) {
    if (!sceneHasSplitter(scene)) return { scene: scene, spawnBase: null };
    var authored = scene.bodies.length;
    // The scene's own "Max Objects", which decides the compiled shader's size.
    var cap = global.PhysicsEngine.maxSimulationBodiesFor(scene);
    if (authored >= cap) return { scene: scene, spawnBase: authored };
    var bodies = scene.bodies.slice();
    for (var i = authored; i < cap; i++) {
      bodies.push(global.PhysicsEngine.createCircle(0, 0, 0, false));
    }
    var padded = {};
    for (var k in scene) if (Object.prototype.hasOwnProperty.call(scene, k)) padded[k] = scene[k];
    padded.bodies = bodies;
    return { scene: padded, spawnBase: authored };
  }

  // Per-spawn-slot persistent state plus liveCount; the slots' Body locals come from generateBodyLocalsGLSL.
  function generateSpawnSlotLocalsGLSL(n, spawnBase) {
    var slots = spawnSlotsFrom(n, spawnBase);
    if (!slots.length) return "";
    var lines = [];
    slots.forEach(function (i) {
      lines.push("bool alive" + i + " = false;");
      // -1: a never-filled slot belongs to no lineage (the output average must not count it).
      lines.push("int lineage" + i + " = -1;");
    });
    lines.push("int liveCount = " + spawnBase + ";");
    return lines.join("\n");
  }

  // The scene's specialized stepOnce(), taking bodies/masses as explicit
  // parameters: GLSL globals need constant initializers and the fractal grid's
  // initial state is per-pixel. One generator emits both float32 and multi-float.
  // frame { width, height }: wrap positions at the edges; omitted = unbounded fall.
  // precision: "f32" or "df"/"tf"/"qf" (see PhysicsDF). mutualGravity: n-body pull.
  // collisions: only Mutual Gravity's accel loop needs it (touching-bodies rule).
  // spawnBase: see padSceneForSplitting. springs: see the Springs section above.
  function generateStepOnceGLSL(n, consts, pairs, hingeAnchors, frame, precision, mutualGravity, collisions, spawnBase, springs) {
    var df = global.PhysicsDF.isExtended(precision);
    if (df) global.PhysicsDF.usePrecision(precision);
    var collisionsOn = collisions !== false;
    var springList = springs || [];
    var PE = global.PhysicsEngine;
    // sprung: bodies a spring pulls; turned: those it can also turn (off-center anchor).
    var sprung = {}, turned = {};
    springList.forEach(function (sp) {
      if (!sp.aIsWorld && !consts[sp.a].isAnchored) { sprung[sp.a] = true; if (!sp.localA.zero) turned[sp.a] = true; }
      if (!consts[sp.b].isAnchored) { sprung[sp.b] = true; if (!sp.localB.zero) turned[sp.b] = true; }
    });
    // One generator, two spellings: df has no operators, so dfAdd(a, b) where f32 says a + b.
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
      // a <= b, spelled as "not greater": the one the df library has.
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

    // Trapezoid<->circle pairs are pulled out of `pairs`: a teleport/split is not
    // a Contact and 3 solid edges do not fit a ContactPair. Other trapezoid pairs are dropped.
    function isTrapezoid(t) { return t === "funnel" || t === "splitter"; }
    // Wall edges per kind: the funnel's short side is solid, the splitter's long side.
    function wallsFor(kind) {
      return kind === "splitter"
        ? [["mouth", "mouthLeft", "mouthRight"], ["leg1", "mouthLeft", "throatLeft"], ["leg2", "mouthRight", "throatRight"]]
        : [["throat", "throatLeft", "throatRight"], ["leg1", "mouthLeft", "throatLeft"], ["leg2", "mouthRight", "throatRight"]];
    }
    // A circle passing through this trapezoid (teleport/split) must not be pushed by its walls.
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
    // Ascending body index, the order the JS engine applies splits in (who gets the last slot).
    var splittableCircles = [];
    splitterPairs.forEach(function (sp) {
      if (consts[sp.circle].isAnchored) return;
      if (splittableCircles.indexOf(sp.circle) === -1) splittableCircles.push(sp.circle);
    });
    splittableCircles.sort(function (a, b) { return a - b; });
    if (splitterPairs.length && (spawnBase === undefined || spawnBase === null)) {
      throw new Error("A splitter scene must be compiled from a padded scene: see PhysicsGPU.padSceneForSplitting");
    }
    var spawnSlots = spawnSlotsFrom(n, spawnBase);
    var isSpawnSlot = {};
    spawnSlots.forEach(function (i) { isSpawnSlot[i] = true; });
    // null when neither is a spawn slot, so ordinary scenes emit no test.
    function bothAliveExpr(i, j) {
      if (!isSpawnSlot[i] && !isSpawnSlot[j]) return null;
      if (!isSpawnSlot[i]) return "alive" + j;
      if (!isSpawnSlot[j]) return "alive" + i;
      return "(alive" + i + " && alive" + j + ")";
    }

    var lines = [];
    for (var cd = 0; cd < n; cd++) lines.push("bool g_contact" + cd + " = false;");

    // ---- df only: segment geometry, built as seldom as possible ----
    // A df sin/cos is the dearest thing in that library. A movable line or trapezoid
    // is built once per step; an anchored one once per run, into a global.
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
    // df needs no stand-in world body: its hinge solvers have world-pin forms.
    if (!df && hingeAnchors.some(function (h) { return h.aIsWorld; })) {
      lines.push("  " + E.bodyType + " worldBody = " + E.bodyType + "(" +
        [E.zero, E.zero, E.zero, E.zero, E.zero, E.zero].join(", ") + ");");
    }

    // ---- This step's acceleration, per body ----
    // Mutual Gravity ports PhysicsEngine.computeAccelerations at the pass's own
    // precision (a float32 separation cannot tell nearby pixels apart). Mass and
    // reach derive from BODYn_HALF (per-pixel when linked) via the engine's unit-HALF formulas.
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
      // A dead spawn slot neither pulls nor is pulled (and cannot divide 0 by 0).
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
          // G folded into the mass once per body.
          lines.push("  MF gravGM" + mdf + " = dfMul(" + dfnumG(GRAV_G * gravK[mdf]) + ", " +
            (consts[mdf].type === "circle" ? "dfSqr(" + halfDf + ")" : halfDf) + ");");
        }
        for (var adf = 0; adf < n; adf++) {
          if (!consts[adf].isAnchored) lines.push("  DVec2 gravAcc" + adf + " = dv2Zero();");
        }
        // Once per unordered pair; each body still accumulates in ascending index order.
        for (var pa = 0; pa < n; pa++) {
          for (var pb = pa + 1; pb < n; pb++) {
            if (consts[pa].isAnchored && consts[pb].isAnchored) continue;
            lines.push("  {");
            lines.push("    DVec2 gd = dv2(dfSub(dbody" + pb + ".x, dbody" + pa + ".x), dfSub(dbody" + pb + ".y, dbody" + pa + ".y));");
            lines.push("    MF gr2 = dv2LengthSq(gd);");
            lines.push("    MF gContact = dfAdd(gravReach" + pa + ", gravReach" + pb + ");");
            lines.push("    MF gContact2 = dfSqr(gContact);");
            // Compared in df: a float32 comparison would quantize the boundary.
            var outside = "!dfLess(gr2, gContact2)";
            var applyLines = [];
            if (!consts[pa].isAnchored) applyLines.push("gravAcc" + pa + " = dv2Add(gravAcc" + pa + ", dv2Scale(gd, dfMul(gravGM" + pb + ", gk)));");
            if (!consts[pb].isAnchored) applyLines.push("gravAcc" + pb + " = dv2Sub(gravAcc" + pb + ", dv2Scale(gd, dfMul(gravGM" + pa + ", gk)));");
            if (collisionsOn) {
              // Touching bodies do not pull: see PhysicsEngine.computeAccelerations.
              lines.push("    if (" + gravGate(pa, pb, outside) + ") {");
              lines.push("      MF gk = dfDiv(DF_ONE, dfMul(gr2, dfSqrt(gr2)));");
              applyLines.forEach(function (l) { lines.push("      " + l); });
              lines.push("    }");
            } else {
              // Collisions off: the smooth interior law, as in the JS engine.
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
          if (consts[a].isAnchored) continue;
          lines.push("  vec2 gravAcc" + a + " = vec2(0.0);");
          for (var b2 = 0; b2 < n; b2++) {
            if (b2 === a) continue;
            lines.push("  {");
            lines.push("    vec2 d = vec2(body" + b2 + ".x - body" + a + ".x, body" + b2 + ".y - body" + a + ".y);");
            // Touching bodies do not pull (PhysicsEngine.computeAccelerations); collisions off: smooth interior law.
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
    // Port of PhysicsEngine.addSpringAccelerations. sprAlphaN exists only for a body
    // a spring can turn. The stiffness limit uses the (possibly per-pixel) masses.
    if (springList.length) {
      var slit = df ? global.PhysicsDF.num : fnum;
      for (var sb = 0; sb < n; sb++) {
        if (!sprung[sb]) continue;
        lines.push("  " + E.vecType + " sprAcc" + sb + " = " + E.zeroVec + ";");
        if (turned[sb]) lines.push("  " + E.scalarType + " sprAlpha" + sb + " = " + E.zero + ", sprSwing" + sb + " = " + E.zero + ";");
      }
      // df only: one sin/cos per off-center-attached body, shared by its springs.
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
        if (!aMoves && !bMoves) return; // nothing here can move: the JS engine skips it too
        // One end: world point, lever arm (null if none) and how readily it gives way.
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
        // The law: PhysicsEngine.springForceFactor (Hooke outside a core, smooth polynomial inside).
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
            // Compared in df: a float32 comparison would quantize the boundary.
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
        // Force on end A points at B while stretched; end B gets the opposite.
        [[sp.a, endA, aMoves, true], [sp.b, endB, bMoves, false]].forEach(function (side) {
          var idx = side[0], e = side[1], plus = side[3];
          if (!side[2]) return;
          // Torque, plus this end's share of the swing springSpin integrates implicitly.
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
    // A turned body's spin after `t` of this step's torque: see springSpinGLSL.
    function spinExpr(i, t) {
      return (df ? "dfSpringSpin(" : "springSpin(") + B(i) + ".w, sprAlpha" + i + ", sprSwing" + i + ", " + t + ")";
    }

    // vFull drives both detection and leg 1, so the body moves along the line it was swept against.
    for (var g = 0; g < n; g++) {
      if (consts[g].isAnchored) continue;
      lines.push("  " + E.vecType + " u" + g + " = " + E.vec(B(g) + ".vx", B(g) + ".vy") + ";");
      lines.push("  " + E.vecType + " vFull" + g + " = " + E.advanceVelocity + "(u" + g + ", " + E.DT + ", " + accelFor(g) + ");");
    }
    lines.push("");

    // Probes: real position, velocity vFull, so swept tests match leg 1's motion.
    for (var p = 0; p < n; p++) {
      if (consts[p].isAnchored) continue;
      lines.push("  " + E.bodyType + " probe" + p + " = " + B(p) + "; probe" + p + ".vx = vFull" + p + ".x; probe" + p + ".vy = vFull" + p + ".y;");
    }
    lines.push("");

    function probeRef(idx) { return consts[idx].isAnchored ? B(idx) : "probe" + idx; }

    // df only: this step's geometry for every movable line/trapezoid, from its probe.
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
    // A line's collide argument: half-length in float32, prebuilt segment in df.
    function lineArg(idx) { return df ? segExpr(idx) : "BODY" + idx + "_HALF"; }
    // Only a line<->line pair can fill its second contact slot.
    function pairSlots(pair) {
      return consts[pair[0]].type === "line" && consts[pair[1]].type === "line" ? ["c0", "c1"] : ["c0"];
    }

    // Contacts are computed once per step and reused by every solver iteration.
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
        // collideLineCircle takes (line, circle): swap rA/rB back and flip the normal.
        lines.push("  " + E.contactType + " " + varName + "_raw = " + E.collideLineCircle + "(" + refJ + ", " + lineArg(j) + ", " + refI + ", BODY" + i + "_HALF);");
        lines.push("  " + varName + "_raw.normal = " + E.negVec(varName + "_raw.normal") + ";");
        lines.push("  { " + E.vecType + " tmp_" + i + "_" + j + " = " + varName + "_raw.rA; " + varName + "_raw.rA = " + varName + "_raw.rB; " + varName + "_raw.rB = tmp_" + i + "_" + j + "; }");
        lines.push("  " + E.contactPairType + " " + varName + " = " + E.contactPairType + "(" + varName + "_raw, " + E.noContact + ");");
      } else {
        lines.push("  " + E.contactPairType + " " + varName + " = " + E.collideLineLine + "(" + refI + ", " + lineArg(i) + ", " + refJ + ", " + lineArg(j) + ");");
      }
    });
    // A pair involving a dead spawn slot counts for nothing: clearing hit is the whole suppression.
    ordinaryPairs.forEach(function (pair) {
      var gate = bothAliveExpr(pair[0], pair[1]);
      if (!gate) return;
      var varName = "pair_" + pair[0] + "_" + pair[1];
      lines.push("  if (!" + gate + ") { " + varName + ".c0.hit = false; " + varName + ".c1.hit = false; }");
    });
    // df only: per-contact constants no solver iteration changes (dfPrepareContact), after the gating.
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

    // "Touching anything this step?" per body, for the caller (the grid's Bounce
    // Count). Globals: a constant-initialized bool is legal there, and no inout to thread.
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

    // Per-body earliest contact tHit, default DT; folded only when a slot hit (a miss carries 0.0).
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
    // Port of physics-engine.js's step(): fold the solid edges' tHit into both bodies,
    // then resolve the teleport (a tie goes to it), then fold touching flags into g_contact.
    var funnelPairsByCircle = {};
    funnelPairs.forEach(function (fp) {
      (funnelPairsByCircle[fp.circle] = funnelPairsByCircle[fp.circle] || []).push(fp.trap);
    });
    if (trapezoidPairs.length) {
      trapezoidPairs.forEach(function (fp) {
        var fi = fp.trap, ci = fp.circle;
        var refF = probeRef(fi), refC = probeRef(ci);
        var vn = "trap_" + fi + "_" + ci;
        // A dead slot would still register hits: suppress at the Contact so the solve loops keep their variables.
        var gate = bothAliveExpr(fi, ci);
        var sizeArg = df ? trapExpr(fi) : "BODY" + fi + "_HALF * 2.0";
        if (!df) lines.push("  FunnelVerts " + vn + "_v = funnelVertices(" + refF + ", " + sizeArg + ");");
        fp.walls.forEach(function (w) {
          var segArgs = df ? trapExpr(fi) + "." + w[0] : vn + "_v." + w[1] + ", " + vn + "_v." + w[2];
          lines.push("  " + E.contactType + " " + vn + "_" + w[0] + " = " + E.sweptCapsule + "(" + segArgs +
            ", " + E.vec(refF + ".vx", refF + ".vy") + ", " + E.vec(refF + ".x", refF + ".y") + ", " + refC + ", BODY" + ci + "_HALF, " + E.halfThickness + ");");
          if (gate) lines.push("  if (!" + gate + ") " + vn + "_" + w[0] + ".hit = false;");
          // Trapezoid is side A, circle side B: the order both solve loops use.
          if (df) lines.push(prepareContactLine(vn + "_" + w[0], fi, ci));
        });
        if (fp.kind === "funnel") {
          lines.push("  " + E.mouthHitType + " " + vn + "_mouth = " + E.mouthHitFn + "(" + refF + ", " + sizeArg + ", " + refC + ", BODY" + ci + "_HALF);");
          if (gate) lines.push("  if (!" + gate + ") " + vn + "_mouth.hit = false;");
        } else {
          // Not folded into tHit: a split is applied at the end of the step, unlike a teleport.
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
        if (consts[ci].isAnchored) return;
        // teleFound is its own flag: DT also means "no contact", so tHits alone would read as a teleport.
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

      // Which splitter each circle passes through, resolved here for the flags and solve loops; earliest wins.
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

    // Leg 1: move at vFull for tHit (matching detection), then drop velocity to vPre
    // (gravity only up to tHit): reflecting with a full step of gravity early or late differs by 2*(g.n)*DT.
    for (var g3 = 0; g3 < n; g3++) {
      if (consts[g3].isAnchored) continue;
      var t1 = "body" + g3 + "THit";
      // A teleport winner's position is overridden to the throat center; velocity is unchanged.
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
        // Angular twin: rotate at the whole step's spin, leave w with the torque by tHit.
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
    // float32 re-derives everything per call. df lifts what a loop cannot change out
    // of it (hinged sin/cos, dfPrepareHinge, dfPrepareContact); the position loop turns bodies, so dfTurn.
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

    // Reads the HINGEn_A/B parameters rather than constructing vec2(...) here.
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
      // c1 only for line<->line: elsewhere it is noContact() by construction.
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
    // Leg 2: the rest of the step and of gravity on the post-impulse velocity; no contact means identity.
    for (var g2 = 0; g2 < n; g2++) {
      if (consts[g2].isAnchored) continue;
      var t2 = "body" + g2 + "TRest";
      lines.push("  " + E.scalarType + " " + t2 + " = " + E.sub(E.DT, "body" + g2 + "THit") + ";");
      lines.push("  " + E.vecType + " vPost" + g2 + " = " + E.advanceVelocity + "(" + E.vec(B(g2) + ".vx", B(g2) + ".vy") + ", " + t2 + ", " + accelFor(g2) + ");");
      lines.push("  " + B(g2) + ".vx = vPost" + g2 + ".x; " + B(g2) + ".vy = vPost" + g2 + ".y;");
      // The rest of a spring's torque onto the post-impulse spin, before the turn reads it.
      if (turned[g2]) lines.push("  " + B(g2) + ".w = " + spinExpr(g2, t2) + ";");
      lines.push("  " + B(g2) + ".x = " + E.add(B(g2) + ".x", E.mul("vPost" + g2 + ".x", t2)) + ";");
      lines.push("  " + B(g2) + ".y = " + E.add(B(g2) + ".y", E.mul("vPost" + g2 + ".y", t2)) + ";");
      if (df && hingeBodies[g2]) {
        // A hinged body's carried sin/cos follows its angle into the position loop.
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

    // Frame wrap, last so it never feeds this step's position solve. Decided only
    // by a root body (free, or hinged to the world); hinge children follow their
    // parent. A world-hinged root wraps by its PIN (HINGEh_A, inout), which lives in frame space.
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
      // A spring group wraps as one with its leader, or never if tethered (PhysicsEngine.springGroups).
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
          // Compared in df: collapsing to float32 would quantize which side of the edge a pixel is on.
          lines.push("  if (dfGreater(" + refX + ", dfFromFloat(" + frameW + "))) " + dxVar + " = -" + frameW + "; else if (dfLess(" + refX + ", DF_ZERO)) " + dxVar + " = " + frameW + ";");
          lines.push("  if (dfGreater(" + refY + ", dfFromFloat(" + frameH + "))) " + dyVar + " = -" + frameH + "; else if (dfLess(" + refY + ", DF_ZERO)) " + dyVar + " = " + frameH + ";");
        } else {
          lines.push("  if (" + refX + " > " + frameW + ") " + dxVar + " = -" + frameW + "; else if (" + refX + " < 0.0) " + dxVar + " = " + frameW + ";");
          lines.push("  if (" + refY + " > " + frameH + ") " + dyVar + " = -" + frameH + "; else if (" + refY + " < 0.0) " + dyVar + " = " + frameH + ";");
        }
        // What moves with this root: pin and hinge descendants, or the whole spring group and its pins.
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
    // Each splitting circle is displaced from its end-of-step state; a slot woken here
    // starts next step. The hit circle keeps its slot (offset1, lineage implicit); a spawn slot is the second.
    if (splittableCircles.length) {
      lines.push("");
      splittableCircles.forEach(function (ci) {
        var lineage = isSpawnSlot[ci] ? "lineage" + ci : String(ci);
        lines.push("  if (splitFound_" + ci + ") {");
        // Child position read before the parent moves: both offsets displace the pre-split position.
        lines.push("    " + E.scalarType + " childX_" + ci + " = " + E.add(B(ci) + ".x", "splitOff2_" + ci + ".x") + ";");
        lines.push("    " + E.scalarType + " childY_" + ci + " = " + E.add(B(ci) + ".y", "splitOff2_" + ci + ".y") + ";");
        lines.push("    " + B(ci) + ".x = " + E.add(B(ci) + ".x", "splitOff1_" + ci + ".x") + ";");
        lines.push("    " + B(ci) + ".y = " + E.add(B(ci) + ".y", "splitOff1_" + ci + ".y") + ";");
        if (spawnSlots.length) {
          // At the ceiling the ball still passes through; it just does not duplicate.
          lines.push("    if (liveCount < " + n + ") {");
          spawnSlots.forEach(function (k, si) {
            lines.push("      " + (si === 0 ? "if" : "else if") + " (liveCount == " + k + ") { " +
              B(k) + " = " + E.bodyType + "(childX_" + ci + ", childY_" + ci + ", " + B(ci) + ".angle, " + B(ci) + ".vx, " + B(ci) + ".vy, " + B(ci) + ".w); " +
              // A split never changes size: the child's shape constants are the parent's.
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

  // Per-body locals with literal initial values; the grid emits its own for linked bodies.
  function generateBodyLocalsGLSL(consts, precision) {
    var df = global.PhysicsDF.isExtended(precision);
    if (df) global.PhysicsDF.usePrecision(precision);
    // dfnum splits a float64 coordinate across both words instead of rounding it away.
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

  // ---- The trajectory program: every body's state at every step ----
  // Texel (b, r) of the output is body b after r + 1 steps. Running every texel
  // from step 0 is quadratic, and the last row's invocation runs the whole run,
  // which the OS's GPU watchdog aborts (zeros, no error). So it runs in CHUNKS,
  // carrying state in an RGBA32F strip (playbackStateVariables layout, texel
  // (l, 0) = layer l): a LOG draw (u_trajAdvance == 0) fills the chunk's rows from
  // the saved state at u_trajBase; an ADVANCE draw (u_trajAdvance > 0) runs that
  // many steps and every texel keeps its own layer. Floats are exact, so resuming
  // lands on the same bits. Chunk length is a property of the machine (a Mac with
  // its display on kills fragment work past ~30-45ms, silently), so the runner
  // times each chunk and sizes the next. bodyDeclarationsGLSL is what differs
  // between the single-scene compiler and the grid's hover replay.
  // The most steps a chunk can ever be: the shader's own loop bound.
  var TRAJECTORY_MAX_CHUNK = 256;
  // Steered chunk time: well under the limit, since a step can get dearer (splits).
  var TRAJECTORY_TARGET_MS = 4;
  // Written beside the data by every draw so a dropped draw is noticed.
  var TRAJECTORY_SENTINEL = 8191;

  function trajectoryChunkInfo(n, consts, hingeAnchors, precision, spawnBase) {
    // Anchored bodies are not carried: every invocation re-declares them from the scene.
    var vars = playbackStateVariables({ precision: precision, n: n, consts: consts, spawnBase: spawnBase, hingeAnchors: hingeAnchors });
    return {
      vars: vars,
      maxSteps: TRAJECTORY_MAX_CHUNK,
      layers: playbackStateLayerCount(vars),
    };
  }

  // Uniforms and output the chunked main needs, for the caller's header.
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
    // Row 0 is the state after 1 step, so trajectory[maxSteps-1] is after exactly maxSteps.
    // One loop serves both draw kinds: stepOnce() is inlined, and a second call site doubles the program.
    lines.push("  int stepTarget = u_trajAdvance > 0 ? u_trajAdvance : int(gl_FragCoord.y) - u_trajBase + 1;");
    lines.push("  for (int i = 0; i < TRAJECTORY_CHUNK; i++) {");
    lines.push("    if (i >= stepTarget) break;");
    lines.push("    " + stepCall);
    lines.push("  }");
    lines.push("  if (u_trajAdvance > 0) {");
    // The texel past the last layer is the sentinel: the step count the state stands at.
    lines.push("    pbOut0 = vec4(float(u_trajBase + u_trajAdvance), TRAJECTORY_SENTINEL, 0.0, 0.0);");
    generateStateStripStoreGLSL(chunk.vars, "int(gl_FragCoord.x)", "pbOut0").forEach(function (l) { lines.push("    " + l); });
    lines.push("    return;");
    lines.push("  }");
    lines.push("  int bodyIdx = int(gl_FragCoord.x);");
    lines.push("  vec3 outVal = vec3(0.0);");
    // Alpha carries BODYn_HALF: the grid's hover replay needs a resize-linked body's per-point size.
    lines.push("  float outHalf = 0.0;");
    for (var o = 0; o < n; o++) {
      var half = df ? "dfToFloat(BODY" + o + "_HALF)" : "BODY" + o + "_HALF";
      // A dead spawn slot reports size 0: what tells the replay to draw nothing.
      if (isSpawnSlot[o]) half = "(alive" + o + " ? " + half + " : 0.0)";
      lines.push((o === 0 ? "  if" : "  else if") + " (bodyIdx == " + o + ") { outVal = vec3(" +
        readField(o, "x") + ", " + readField(o, "y") + ", " + readField(o, "angle") + "); outHalf = " + half + "; }");
    }
    // The column past the last body is each row's sentinel: see the runner.
    lines.push("  if (bodyIdx == " + n + ") { outVal = vec3(gl_FragCoord.y + 0.5, TRAJECTORY_SENTINEL, 0.0); }");
    lines.push("  pbOut0 = vec4(outVal, outHalf);");
    lines.push("}");
    return lines.join("\n");
  }

  // precision is a parameter (not always "f32") so the test suite can compile both ways.
  function compileSceneToTrajectoryGLSL(scene, maxSteps, precision) {
    var df = global.PhysicsDF.isExtended(precision);
    if (df) global.PhysicsDF.usePrecision(precision);
    var dfnum = df ? global.PhysicsDF.num : null;
    if (scene.bodies.length > MAX_BODIES) {
      throw new Error("GPU physics supports at most " + MAX_BODIES + " bodies (scene has " + scene.bodies.length + ")");
    }
    // The authored count is checked before padding: spawn slots are not user-drawn.
    var padded = padSceneForSplitting(scene);
    var spawnBase = padded.spawnBase;
    scene = padded.scene;
    var bodies = scene.bodies;
    var n = bodies.length;
    var consts = bodies.map(bodyConst);
    // Empty, not filtered: the funnel codegen pulls from this list, so none turns everything off at once.
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
    // undefined in Infinite Space: no frame, no wrap emitted.
    var frame = global.PhysicsEngine.wrapsAtEdges(scene) ? { width: scene.frameWidth, height: scene.frameHeight } : undefined;

    var lines = [];
    lines.push("#version 300 es");
    var chunk = trajectoryChunkInfo(n, consts, hingeAnchors, precision, spawnBase);
    lines.push("precision highp float;");
    lines.push(generateTrajectoryHeaderGLSL(chunk));
    lines.push("");
    lines.push(libraryGLSL(precision, global.PhysicsEngine.speedCapFor(scene)));
    lines.push("");
    // Nothing here depends on maxSteps, so different run lengths reuse the program.
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
  // Each pixel's state is written to float textures at the end of a draw and read
  // back at the start of the next, so a frame only pays for the steps it adds.
  // State is exactly stepOnce()'s inout parameters; everything else is recomputed
  // from the pixel's world X/Y. RGBA32F is exact, so a resumed run lands on the
  // same bits (physics-tests.js checks that). A state variable is { name, type }:
  // "Body"/"DBody", "float", "df" (a vec2), "vec2", "DVec2", "bool" or "int";
  // multi-float kinds hold one float per word of the precision.
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

  // Anchored bodies are left out (stepOnce() never writes one) unless named in
  // extraBodies (a reader with no starting state, like the playback color pass).
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

  // Stamps each variable with its precision's word count (see stateFloats). Exported for the grid.
  function withWords(vars, precision) {
    var words = global.PhysicsDF.wordsFor(precision);
    vars.forEach(function (v) { v.words = words; });
    return vars;
  }

  // Every float the variables pack into, in order, as { variable, field }.
  function stateFloats(vars) {
    var out = [];
    vars.forEach(function (v) {
      // `words` rides on the variable (withWords): this is handed variables, not a precision.
      var fields = stateTypeFields(v.type, v.words || 2);
      if (!fields) throw new Error("Unknown playback state type: " + v.type);
      fields.forEach(function (f) { out.push({ variable: v, field: f }); });
    });
    return out;
  }

  function playbackStateLayerCount(vars) {
    return Math.max(1, Math.ceil(stateFloats(vars).length / STATE_FLOATS_PER_LAYER));
  }

  // Uninitialized declarations for a program with no step loop of its own (the playback color pass).
  function generatePlaybackStateDeclarationsGLSL(vars) {
    return vars.map(function (v) { return STATE_TYPE_GLSL[v.type] + " " + v.name + ";"; });
  }

  // Reads state from a sampler2DArray at a texel, or with `strip` from a sampler2D of texel (l, 0) = layer l.
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

  // One output per attachable layer; past MAX_DRAW_BUFFERS the state is written in groups.
  function generatePlaybackStateOutputsGLSL(layersPerGroup) {
    var lines = [];
    for (var k = 0; k < layersPerGroup; k++) lines.push("layout(location = " + k + ") out vec4 pbOut" + k + ";");
    return lines;
  }

  // Writes group `groupExpr`'s slice of state into the outputs declared above.
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

  // Strip store. Flat ifs, not else-if: a qf splitter scene has hundreds of layers.
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
  // One context for the life of the page (browsers cap live contexts) and programs
  // cached by source: hover replay calls this per mouse move, and a df compile is seconds.
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

  // Runs a compiled { fragmentSource, numBodies, chunk, uniforms? } and reads back
  // the trajectory. `uniforms` is { name: [floats] } (the hover replay's world point).
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
    // The log: a column wider than the bodies for each row's sentinel...
    var logWidth = numBodies + 1;
    var texture = floatTexture(logWidth, maxSteps);
    // ...and two state strips, swapped each chunk, a texel longer for the same reason.
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

    // The first draw is where the driver really builds the program: spend it untimed.
    if (!entry.warmed) {
      drawLog(0, 1, 0);
      gl.readPixels(numBodies, 0, 1, 1, gl.RGBA, gl.FLOAT, sentinel);
      entry.warmed = true;
    }

    // Each chunk is timed and the next sized from it (TRAJECTORY_TARGET_MS); the time
    // includes the readback, erring safe. Growth caps at doubling; the size is kept with the program.
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
    // The readback already waited for the GPU, so the error flag is free.
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
    // A dropped draw reports no error: only the sentinel notices. Chunk size forgotten so the retry starts over.
    if (failure) {
      entry.chunkSteps = 1;
      throw new Error("The GPU dropped a physics draw (" + failure + "): the scene is too heavy for it at this precision.");
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
    // Exposed so the per-pixel fractal grid reuses the same physics and step logic.
    GLSL_LIBRARY: GLSL_LIBRARY,
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
