// CPAL-1.0 License. See chaosaccelerator.com/license.html

// Compiles a scene into a specialized GLSL program (every pair and hinge
// unrolled, since the scene is fixed when Play is clicked), runs it on an
// offscreen WebGL2 context and logs every body's (x, y, angle) per step.
(function (global) {
  "use strict";

  var MAX_BODIES = 6;

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

  function factorial(n) { var r = 1; for (var i = 2; i <= n; i++) r *= i; return r; }
  // phi(x) = (1 - e^-x)/x, six terms: x = FRICTION * dt stays under 0.12 (a kick leg runs to 1.5 steps), so the
  // rest is below float32.
  function frictionPhiGLSL() {
    var expr = fnum(-1 / factorial(6));
    for (var n = 4; n >= 0; n--) expr = fnum((n % 2 ? -1 : 1) / factorial(n + 1)) + " + x * (" + expr + ")";
    return "float frictionPhi(float x) {\n  return " + expr + ";\n}";
  }
  // PhysicsEngine.advanceVelocity; accel is the body's whole acceleration (per-body under Mutual Gravity).
  // With friction the leg is the exact solution of dv/dt = a - FRICTION v; at 0 the text has no friction in it.
  function advanceVelocityGLSL(friction) {
    return [
      friction > 0 ? frictionPhiGLSL() : "",
      "vec2 advanceVelocity(vec2 v, float dt, vec2 accel) {",
      friction > 0 ? "  float x = FRICTION * dt, phi = frictionPhi(x);\n  v = v * (1.0 - x * phi) + accel * (dt * phi);" : "  v += accel * dt;",
      "  float sq = dot(v, v);",
      "  if (sq > MAX_SPEED * MAX_SPEED) v *= MAX_SPEED / sqrt(sq);",
      "  return v;",
      "}",
      // Gravity Substeps: the constant acceleration a whole leg takes from u to v.
      "vec2 legAcceleration(vec2 u, vec2 v, float dt) {",
      friction > 0 ? "  float x = FRICTION * dt, phi = frictionPhi(x);\n  return (v - u * (1.0 - x * phi)) / (dt * phi);" : "  return (v - u) / dt;",
      "}",
    ].filter(Boolean).join("\n");
  }

  function glslLibrary(friction) {
    return [
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
    "vec2 rotateBy(vec2 v, float sn, float cs) {",
    "  return vec2(v.x * cs - v.y * sn, v.x * sn + v.y * cs);",
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
    "// One leg of a step: gravity, friction and the speed clamp, continuous in dt (dt=0 is the identity).",
    advanceVelocityGLSL(friction),
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
    "// is ignored) vs. circle: three sub-tests (flat side of the capsule",
    "// plus a cap at each endpoint), earliest valid t wins. refCenter is the",
    "// line's center, since rA is a lever arm on its body.",
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
    "// ---- Port hole outline (PhysicsEngine.portholeOval): two big arcs and two tip circles ----",
    "const float PORTHOLE_TIP_RADIUS = " + fnum(global.PhysicsEngine.PORTHOLE_TIP_RADIUS) + ";",
    "struct Oval { float a; float b; float r; float R; float cy; float ax; };",
    "Oval portholeOval(float halfLen) {",
    "  Oval o;",
    "  o.b = LINE_THICKNESS * 0.5; o.r = PORTHOLE_TIP_RADIUS; o.a = halfLen + o.b;",
    "  o.R = ((o.a - o.r) * (o.a - o.r) + o.b * o.b - o.r * o.r) / (2.0 * (o.b - o.r));",
    "  o.cy = o.R - o.b; o.ax = o.a - o.r;",
    "  return o;",
    "}",
    "// kind: 0 the back arc, 1 the front arc, 2 the left tip, 3 the right tip.",
    "struct Feature { int kind; vec2 c; float radius; float dist; float d; };",
    "Feature portholeFeatureCircle(Oval o, int kind) {",
    "  Feature f;",
    "  f.kind = kind;",
    "  if (kind == 0) { f.c = vec2(0.0, -o.cy); f.radius = o.R; }",
    "  else if (kind == 1) { f.c = vec2(0.0, o.cy); f.radius = o.R; }",
    "  else if (kind == 2) { f.c = vec2(-o.ax, 0.0); f.radius = o.r; }",
    "  else { f.c = vec2(o.ax, 0.0); f.radius = o.r; }",
    "  f.dist = 0.0; f.d = 0.0;",
    "  return f;",
    "}",
    "// The feature owning a local point (x along the port hole, y toward its back): a tip past",
    "// the junction rays, else the arc on the point's side. d is the signed distance to the outline.",
    "Feature portholeFeature(Oval o, vec2 p) {",
    "  int kind = abs(p.x) * o.cy > o.ax * (abs(p.y) + o.cy) ? (p.x < 0.0 ? 2 : 3) : (p.y < 0.0 ? 1 : 0);",
    "  Feature f = portholeFeatureCircle(o, kind);",
    "  f.dist = length(p - f.c);",
    "  f.d = f.dist - f.radius;",
    "  return f;",
    "}",
    "vec2 portholeToLocal(vec2 w, float sn, float cs) { return vec2(w.x * cs + w.y * sn, w.y * cs - w.x * sn); }",
    "",
    "void portholeSweep(Oval o, vec2 p0, vec2 v, int kind, float radius, inout float best) {",
    "  Feature fc = portholeFeatureCircle(o, kind);",
    "  float t = sweepPointSphere(p0, v, fc.c, fc.radius + radius, DT);",
    "  if (t < 0.0 || (best >= 0.0 && t >= best)) return;",
    "  if (portholeFeature(o, p0 + v * t).kind == kind) best = t;",
    "}",
    "// Port hole = A (its oval, moving with it), circle = B, swept in the port hole's frame: the",
    "// earliest sweep onto a feature circle whose hit point that feature owns.",
    "Contact collidePortholeCircle(Body ph, float halfLen, Body circle, float radius) {",
    "  Oval o = portholeOval(halfLen);",
    "  float cs = cos(ph.angle), sn = sin(ph.angle);",
    "  vec2 p0 = portholeToLocal(vec2(circle.x - ph.x, circle.y - ph.y), sn, cs);",
    "  vec2 v = portholeToLocal(vec2(circle.vx - ph.vx, circle.vy - ph.vy), sn, cs);",
    "  Contact c = noContact();",
    "  float tHit = 0.0;",
    "  if (portholeFeature(o, p0).d >= radius) {",
    "    float best = -1.0;",
    "    portholeSweep(o, p0, v, 0, radius, best);",
    "    portholeSweep(o, p0, v, 1, radius, best);",
    "    portholeSweep(o, p0, v, 2, radius, best);",
    "    portholeSweep(o, p0, v, 3, radius, best);",
    "    if (best < 0.0) return c;",
    "    tHit = best;",
    "  }",
    "  vec2 p = p0 + v * tHit;",
    "  Feature f = portholeFeature(o, p);",
    "  vec2 nl = f.dist > 1e-9 ? (p - f.c) / f.dist : vec2(0.0, 1.0);",
    "  vec2 n = rotateBy(nl, sn, cs);",
    "  vec2 s = rotateBy(f.c + nl * f.radius, sn, cs);",
    "  c.hit = true;",
    "  c.normal = n;",
    "  c.point = vec2(ph.x, ph.y) + s + vec2(ph.vx, ph.vy) * tHit;",
    "  c.rA = s;",
    "  c.rB = -n * radius;",
    "  c.penetration = max(f.radius + radius - f.dist, 0.0);",
    "  c.tHit = tHit;",
    "  return c;",
    "}",
    "",
    "void portholeFoot(Oval o, vec2 e0, vec2 e1, int kind, inout vec2 bestQ, inout Feature bestF) {",
    "  Feature fc = portholeFeatureCircle(o, kind);",
    "  vec2 q = closestPointOnSegment(e0, e1, fc.c);",
    "  Feature f = portholeFeature(o, q);",
    "  if (f.kind == kind && f.d < bestF.d) { bestQ = q; bestF = f; }",
    "}",
    "// Port hole = A (its oval), line = B (its capsule): the segment's nearest point to the oval is",
    "// an endpoint or the foot of a feature circle's center, when that feature owns the foot. One contact.",
    "ContactPair collidePortholeLine(Body ph, float halfLen, Body line, float halfLenB) {",
    "  Oval o = portholeOval(halfLen);",
    "  float cs = cos(ph.angle), sn = sin(ph.angle);",
    "  vec2 phC = vec2(ph.x, ph.y);",
    "  vec2 e0 = portholeToLocal(lineEndpoint0(line, halfLenB) - phC, sn, cs);",
    "  vec2 e1 = portholeToLocal(lineEndpoint1(line, halfLenB) - phC, sn, cs);",
    "  ContactPair result;",
    "  result.c0 = noContact();",
    "  result.c1 = noContact();",
    "  vec2 bestQ = e0;",
    "  Feature bestF = portholeFeature(o, e0);",
    "  Feature f1 = portholeFeature(o, e1);",
    "  if (f1.d < bestF.d) { bestQ = e1; bestF = f1; }",
    "  portholeFoot(o, e0, e1, 0, bestQ, bestF);",
    "  portholeFoot(o, e0, e1, 1, bestQ, bestF);",
    "  portholeFoot(o, e0, e1, 2, bestQ, bestF);",
    "  portholeFoot(o, e0, e1, 3, bestQ, bestF);",
    "  float halfT = LINE_THICKNESS * 0.5;",
    "  if (bestF.d >= halfT) return result;",
    "  vec2 nl = bestF.dist > 1e-9 ? (bestQ - bestF.c) / bestF.dist : vec2(0.0, 1.0);",
    "  vec2 ml = (bestF.c + nl * bestF.radius + bestQ - nl * halfT) * 0.5;",
    "  vec2 n = rotateBy(nl, sn, cs);",
    "  vec2 m = rotateBy(ml, sn, cs);",
    "  vec2 pt = phC + m;",
    "  result.c0.hit = true;",
    "  result.c0.normal = n;",
    "  result.c0.point = pt;",
    "  result.c0.rA = m;",
    "  result.c0.rB = pt - vec2(line.x, line.y);",
    "  result.c0.penetration = halfT - bestF.d;",
    "  result.c0.tHit = 0.0;",
    "  return result;",
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
  }
  var GLSL_LIBRARY = glslLibrary(0);

  // The df port of GLSL_LIBRARY lives in physics-gpu-df.js and carries the whole step.

  var VERTEX_SOURCE = [
    "#version 300 es",
    "in vec2 a_position;",
    "void main() { gl_Position = vec4(a_position, 0.0, 1.0); }",
  ].join("\n");

  // Per-scene constants the library reads (PhysicsEngine.speedCapFor, frictionRate); must precede it.
  function sceneDecls(precision, maxSpeed, friction, frictionUniform) {
    var cap = maxSpeed === undefined ? global.PhysicsEngine.MAX_SPEED : maxSpeed;
    var lines = ["const float MAX_SPEED = " + fnum(cap) + ";"];
    if (friction > 0) lines.push(frictionUniform ? "uniform float FRICTION;" : "const float FRICTION = " + fnum(friction) + ";");
    if (global.PhysicsDF.isExtended(precision)) {
      lines.push("const MF DF_MAX_SPEED = " + global.PhysicsDF.num(cap) + ";");
      if (friction > 0) lines.push(global.PhysicsGPUDF.frictionDecls(friction, frictionUniform));
    }
    return lines.join("\n") + "\n";
  }

  // The rate at PhysicsEngine.FRICTION_MAX. Uniform mode builds for it so the df phi series covers every value.
  var MAX_FRICTION_RATE = -Math.log(1 - global.PhysicsEngine.FRICTION_MAX);

  // The full preamble a shader needs before generated code, in the right order.
  // Whole libraries: pruneUnusedGLSL drops what the finished program never names.
  // frictionUniform declares the friction names as uniforms (values from frictionUniforms).
  function libraryGLSL(precision, maxSpeed, friction, frictionUniform) {
    if (frictionUniform) friction = MAX_FRICTION_RATE;
    if (!global.PhysicsDF.isExtended(precision)) return sceneDecls(precision, maxSpeed, friction, frictionUniform) + glslLibrary(friction);
    // Everything multi-float from here on is at this precision (PhysicsDF.usePrecision).
    global.PhysicsDF.usePrecision(precision);
    // Order matters: df arithmetic, then the f32 library (a df grid still reads its DT), then df physics.
    return [global.PhysicsDF.UNIFORM_DECL, "", global.PhysicsDF.GLSL_LIBRARY, "",
      sceneDecls(precision, maxSpeed, friction, frictionUniform), glslLibrary(friction), "", global.PhysicsGPUDF.libraryGLSL(friction)].join("\n");
  }

  // { name: [floats] } for libraryGLSL's uniform mode at a friction fraction.
  function frictionUniforms(precision, friction) {
    var rate = global.PhysicsEngine.frictionRate({ friction: friction });
    var out = { FRICTION: [rate] };
    if (global.PhysicsDF.isExtended(precision)) {
      var vals = global.PhysicsGPUDF.frictionUniformValues(rate, global.PhysicsDF.wordsFor(precision));
      for (var name in vals) out[name] = vals[name];
    }
    return out;
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

  // Bit of pair (i, j), i < j, in a trajectory row's contact bits: (0,1), (0,2), ..., (1,2), ...
  function pairContactBit(i, j, n) {
    return i * n - i * (i + 1) / 2 + (j - i - 1);
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

  function stepOnceParams(n, hingeAnchors, precision, springs) {
    var df = global.PhysicsDF.isExtended(precision);
    // Parameter order is shared with stepOnceCallArgs. Hinge anchors are parameters,
    // not baked literals: a resize-linked anchor is a runtime expression only in
    // scope in main(). In df the shape constants are df too (per-pixel when linked).
    var sc = df ? "MF " : "float ";
    var params = [];
    for (var i = 0; i < n; i++) {
      params.push((df ? "inout DBody dbody" : "inout Body body") + i,
        sc + "BODY" + i + "_INV_MASS", sc + "BODY" + i + "_INV_INERTIA", sc + "BODY" + i + "_HALF");
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
    return params;
  }

  // hingeAnchors' text is already in the pass's precision; this just picks the constructor.
  function stepOnceCallArgs(n, hingeAnchors, precision, springs) {
    var df = global.PhysicsDF.isExtended(precision);
    function localVec(a) {
      return df ? "dv2(" + a.x + ", " + a.y + ")" : "vec2(" + a.x + ", " + a.y + ")";
    }
    var args = [];
    for (var i = 0; i < n; i++) {
      args.push((df ? "dbody" : "body") + i, "BODY" + i + "_INV_MASS", "BODY" + i + "_INV_INERTIA", "BODY" + i + "_HALF");
    }
    (hingeAnchors || []).forEach(function (hg, h) {
      // World hinge: by reference, so stepOnce()'s wrap persists across calls.
      args.push(hg.aIsWorld ? ("hingeAnchor" + h) : localVec(hg.localA), localVec(hg.localB));
    });
    (springs || []).forEach(function (sp) {
      if (springEndNeedsParam(sp, "A")) args.push(localVec(sp.localA));
      if (springEndNeedsParam(sp, "B")) args.push(localVec(sp.localB));
    });
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

  // The scene's specialized stepOnce(), taking bodies/masses as explicit
  // parameters: GLSL globals need constant initializers and the fractal grid's
  // initial state is per-pixel. One generator emits both float32 and multi-float.
  // frame { width, height }: wrap positions at the edges; omitted = unbounded fall.
  // precision: "f32" or "df"/"tf"/"qf" (see PhysicsDF). mutualGravity: n-body pull.
  // collisions: only Mutual Gravity's accel loop needs it (touching-bodies rule).
  // springs: see the Springs section above.
  // flags { contactBody, touchBody, pairContacts, warpBody, warpFrom, warpBits }: g_contactN for that one
  // body (the map's Bounce Count), g_touchK per other body for that one (the goal order), g_pairContacts,
  // every pair's contact as a bit (the trajectory log), g_warp and g_warpTurn, whether that one body went
  // through a port hole and the turn the crossing gave it, with warpFrom g_warpFrom, the port hole it went
  // in by (the goal order), and g_warpBits, every body's warp as a bit (the trajectory log); none by default.
  function generateStepOnceGLSL(n, consts, pairs, hingeAnchors, frame, precision, mutualGravity, collisions, springs, flags) {
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
      DT: "DF_DT", halfDT: "DF_HALF_DT",
      zero: "DF_ZERO",
      vec: function (x, y) { return "dv2(" + x + ", " + y + ")"; },
      add: function (a, b) { return "dfAdd(" + a + ", " + b + ")"; },
      sub: function (a, b) { return "dfSub(" + a + ", " + b + ")"; },
      mul: function (a, b) { return "dfMul(" + a + ", " + b + ")"; },
      min: function (a, b) { return "dfMin(" + a + ", " + b + ")"; },
      less: function (a, b) { return "dfLess(" + a + ", " + b + ")"; },
      div: function (a, b) { return "dfDiv(" + a + ", " + b + ")"; },
      neg: function (a) { return "dfNeg(" + a + ")"; },
      vadd: function (a, b) { return "dv2Add(" + a + ", " + b + ")"; },
      vsub: function (a, b) { return "dv2Sub(" + a + ", " + b + ")"; },
      rotateBy: function (v, sn, cs) { return "dv2RotateBy(" + v + ", " + sn + ", " + cs + ")"; },
      spinOk: function (w) { return "!dfGreater(dfMul(dfAbs(" + w + "), DF_DT), DF_ONE)"; },
      negVec: function (v) { return "dv2Neg(" + v + ")"; },
      zeroVec: "dv2Zero()",
      advanceVelocity: "dfAdvanceVelocity", noContact: "dfNoContact()",
      contactType: "DContact", contactPairType: "DContactPair",
      collideCircleCircle: "dfCollideCircleCircle", collideLineCircle: "dfCollideLineCircle",
      collideLineLine: "dfCollideLineLine",
      collidePortholeCircle: "dfCollidePortholeCircle", collidePortholeLine: "dfCollidePortholeLine",
      solveHingeVelocity: "dfSolveHingeVelocity", solveHingePosition: "dfSolveHingePosition",
    } : {
      body: "body", bodyType: "Body", scalarType: "float", vecType: "vec2",
      DT: "DT", halfDT: "0.5 * DT",
      zero: "0.0",
      vec: function (x, y) { return "vec2(" + x + ", " + y + ")"; },
      add: function (a, b) { return "(" + a + ") + (" + b + ")"; },
      sub: function (a, b) { return "(" + a + ") - (" + b + ")"; },
      mul: function (a, b) { return "(" + a + ") * (" + b + ")"; },
      min: function (a, b) { return "min(" + a + ", " + b + ")"; },
      less: function (a, b) { return a + " < " + b; },
      div: function (a, b) { return "(" + a + ") / (" + b + ")"; },
      neg: function (a) { return "-(" + a + ")"; },
      vadd: function (a, b) { return "(" + a + ") + (" + b + ")"; },
      vsub: function (a, b) { return "(" + a + ") - (" + b + ")"; },
      rotateBy: function (v, sn, cs) { return "rotateBy(" + v + ", " + sn + ", " + cs + ")"; },
      spinOk: function (w) { return "abs(" + w + ") * DT <= " + fnum(global.PhysicsEngine.HINGE_SHAKE_SPIN_LIMIT); },
      negVec: function (v) { return "-" + v; },
      zeroVec: "vec2(0.0)",
      advanceVelocity: "advanceVelocity", noContact: "noContact()",
      contactType: "Contact", contactPairType: "ContactPair",
      collideCircleCircle: "collideCircleCircle", collideLineCircle: "collideLineCircle",
      collideLineLine: "collideLineLine",
      collidePortholeCircle: "collidePortholeCircle", collidePortholeLine: "collidePortholeLine",
      solveHingeVelocity: "solveHingeVelocity", solveHingePosition: "solveHingePosition",
    };
    function B(i) { return E.body + i; }

    // ---- Port holes (PhysicsEngine.step's rules): both placed, and the chain leaders they take ----
    var portals = PE.portholePair(consts);
    var passGroup = portals ? PE.portholeGroups({
      bodies: consts,
      hinges: hingeAnchors.map(function (hg) { return { bodyA: hg.aIsWorld ? null : hg.a, bodyB: hg.b }; }),
      springs: springList.map(function (sp) { return { bodyA: sp.aIsWorld ? null : sp.a, bodyB: sp.b }; }),
    }) : null;
    var leaders = [];
    if (portals) for (var li = 0; li < n; li++) if (passGroup[li].leader === li && !passGroup[li].tethered) leaders.push(li);
    if (!leaders.length) portals = null;
    var phLit = df ? global.PhysicsDF.num : fnum;
    // A port hole's tangent (the line's direction) and front normal (t.y, -t.x). An anchored one's
    // frame is per run (df: once, into a global); a movable one's per step, at the start and the end.
    function phT(idx, end) {
      if (consts[idx].isAnchored) return df ? "g_dfPhT" + idx : "phT" + idx;
      return "phT" + idx + (end ? "e" : "s");
    }
    function phNormal(t) { return df ? "dv2(" + t + ".y, dfNeg(" + t + ".x))" : "vec2(" + t + ".y, -" + t + ".x)"; }
    function phTangentDecl(name, bodyVar) {
      return df
        ? "DVec2 " + name + "; { MF phSn, phCs; dfSinCos(" + bodyVar + ".angle, phSn, phCs); " + name + " = dv2(phCs, phSn); }"
        : "vec2 " + name + " = vec2(cos(" + bodyVar + ".angle), sin(" + bodyVar + ".angle));";
    }

    var lines = [];
    var contactBody = flags && typeof flags.contactBody === "number" ? flags.contactBody : -1;
    var touchBody = flags && typeof flags.touchBody === "number" ? flags.touchBody : -1;
    var pairContacts = !!(flags && flags.pairContacts);
    var warpBody = flags && typeof flags.warpBody === "number" ? flags.warpBody : -1;
    var warpBits = !!(flags && flags.warpBits);
    var warpFrom = warpBody >= 0 && !!(flags && flags.warpFrom);
    if (contactBody >= 0) lines.push("bool g_contact" + contactBody + " = false;");
    if (pairContacts) lines.push("float g_pairContacts = 0.0;");
    if (warpBody >= 0) lines.push("bool g_warp = false;", E.scalarType + " g_warpTurn;");
    if (warpFrom) lines.push("int g_warpFrom = -1;");
    if (warpBits) lines.push("float g_warpBits = 0.0;");
    for (var td = 0; td < n; td++) if (touchBody >= 0 && td !== touchBody) lines.push("bool g_touch" + td + " = false;");
    // The step's edge wrap per body, 0.0 or a frame span: the sticky stop and the trajectory log read these.
    for (var wd = 0; wd < n; wd++) lines.push("float g_wrapDx" + wd + " = 0.0, g_wrapDy" + wd + " = 0.0;");

    function moves(idx) { return consts[idx].isAnchored ? "false" : "true"; }
    // ---- df only: segment geometry, built as seldom as possible ----
    // A df sin/cos is the dearest thing in that library. A movable line is built
    // once per step; an anchored one once per run, into a global.
    var segLines = {};
    pairs.forEach(function (pair) {
      pair.forEach(function (idx) { if (consts[idx].type !== "circle") segLines[idx] = true; });
    });
    function segExpr(idx) { return consts[idx].isAnchored ? "g_dfSeg" + idx : "seg" + idx; }
    var staticGeomLines = [];
    if (df) {
      Object.keys(segLines).forEach(function (idx) {
        if (!consts[idx].isAnchored) return;
        lines.push("DSegment g_dfSeg" + idx + ";");
        staticGeomLines.push("    g_dfSeg" + idx + " = dfLineSegment(" + B(idx) + ", BODY" + idx + "_HALF);");
      });
      (portals || []).forEach(function (idx) {
        if (!consts[idx].isAnchored) return;
        lines.push("DVec2 g_dfPhT" + idx + ";");
        staticGeomLines.push("    { MF phSn, phCs; dfSinCos(" + B(idx) + ".angle, phSn, phCs); g_dfPhT" + idx + " = dv2(phCs, phSn); }");
      });
    }
    lines.push("");
    if (Object.keys(turned).length) lines.push(springSpinGLSL(df), "");
    lines.push("void stepOnce(" + stepOnceParams(n, hingeAnchors, precision, springList).join(", ") + ") {");
    if (staticGeomLines.length) {
      lines.push("  if (!g_dfStaticGeomReady) {");
      staticGeomLines.forEach(function (l) { lines.push(l); });
      lines.push("    g_dfStaticGeomReady = true;");
      lines.push("  }");
    }
    if (warpBody >= 0) lines.push("  g_warp = false; g_warpTurn = " + E.zero + ";");
    if (warpBits) lines.push("  g_warpBits = 0.0;");
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
      return { type: "line", length: 2, isAnchored: c.isAnchored };
    }

    var accelExpr = {};
    // gravityLines(pos, acc, apart): the pull on every free body from positions pos(i).x/.y, summed into acc(i).
    // apart(a, b), substeps under collisions only: a bool name; the pair pulls only if set, at least from contact distance.
    var gravityLines = null, apartLines = null;
    function eachGravityPair(fn) {
      for (var pa = 0; pa < n; pa++) {
        for (var pb = pa + 1; pb < n; pb++) if (!(consts[pa].isAnchored && consts[pb].isAnchored)) fn(pa, pb);
      }
    }
    if (mutualGravity) {
      var gravK = consts.map(function (c) { return global.PhysicsEngine.gravitationalMass(unitBodyOf(c)); });
      var reachK = consts.map(function (c) { return global.PhysicsEngine.halfExtent(unitBodyOf(c)); });
      var GRAV_G = global.PhysicsEngine.MUTUAL_GRAVITY_CONSTANT;

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
        apartLines = function (apart) {
          var out = [];
          eachGravityPair(function (pa, pb) {
            out.push("  bool " + apart(pa, pb) + "; { DVec2 gd = dv2(dfSub(" + B(pb) + ".x, " + B(pa) + ".x), dfSub(" + B(pb) + ".y, " + B(pa) + ".y)); " +
              "MF gContact = dfAdd(gravReach" + pa + ", gravReach" + pb + "); " + apart(pa, pb) + " = !dfLess(dv2LengthSq(gd), dfSqr(gContact)); }");
          });
          return out;
        };
        gravityLines = function (pos, acc, apart) {
          var out = [];
          for (var adf = 0; adf < n; adf++) {
            if (!consts[adf].isAnchored) out.push("  DVec2 " + acc(adf) + " = dv2Zero();");
          }
          // Once per unordered pair; each body still accumulates in ascending index order.
          eachGravityPair(function (pa, pb) {
            out.push("  {");
            out.push("    DVec2 gd = dv2(dfSub(" + pos(pb) + ".x, " + pos(pa) + ".x), dfSub(" + pos(pb) + ".y, " + pos(pa) + ".y));");
            out.push("    MF gr2 = dv2LengthSq(gd);");
            out.push("    MF gContact = dfAdd(gravReach" + pa + ", gravReach" + pb + ");");
            out.push("    MF gContact2 = dfSqr(gContact);");
            // Compared in df: a float32 comparison would quantize the boundary.
            var outside = "!dfLess(gr2, gContact2)";
            var applyLines = [];
            if (!consts[pa].isAnchored) applyLines.push(acc(pa) + " = dv2Add(" + acc(pa) + ", dv2Scale(gd, dfMul(gravGM" + pb + ", gk)));");
            if (!consts[pb].isAnchored) applyLines.push(acc(pb) + " = dv2Sub(" + acc(pb) + ", dv2Scale(gd, dfMul(gravGM" + pa + ", gk)));");
            if (collisionsOn) {
              // Touching bodies do not pull: see PhysicsEngine.computeAccelerations.
              out.push("    if (" + (apart ? apart(pa, pb) : outside) + ") {");
              if (apart) out.push("      if (dfLess(gr2, gContact2)) gr2 = gContact2;");
              out.push("      MF gk = dfDiv(DF_ONE, dfMul(gr2, dfSqrt(gr2)));");
              applyLines.forEach(function (l) { out.push("      " + l); });
              out.push("    }");
            } else {
              // Collisions off: the smooth interior law, as in the JS engine.
              out.push("    {");
              out.push("      MF gk;");
              out.push("      if (" + outside + ") {");
              out.push("        gk = dfDiv(DF_ONE, dfMul(gr2, dfSqrt(gr2)));");
              out.push("      } else {");
              out.push("        MF gu2 = dfDiv(gr2, gContact2);");
              out.push("        MF gPoly = dfAdd(dfSub(" + dfnumG(35 / 8) + ", dfMul(" + dfnumG(21 / 4) + ", gu2)), dfMul(" + dfnumG(15 / 8) + ", dfSqr(gu2)));");
              out.push("        gk = dfDiv(gPoly, dfMul(gContact2, gContact));");
              out.push("      }");
              applyLines.forEach(function (l) { out.push("      " + l); });
              out.push("    }");
            }
            out.push("  }");
          });
          return out;
        };
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
        // Once per unordered pair: d is shared, and the second body's pull is along -d.
        // Each body still accumulates in ascending index order.
        function pull32(toward, r3) {
          return "(" + fnum(GRAV_G) + " * gravMass" + toward + " / " + r3 + ") * d";
        }
        apartLines = function (apart) {
          var out = [];
          eachGravityPair(function (pa, pb) {
            out.push("  bool " + apart(pa, pb) + "; { vec2 d = vec2(" + B(pb) + ".x - " + B(pa) + ".x, " + B(pb) + ".y - " + B(pa) + ".y); " +
              "float contact = " + reachExpr[pa] + " + " + reachExpr[pb] + "; " + apart(pa, pb) + " = dot(d, d) >= contact * contact; }");
          });
          return out;
        };
        gravityLines = function (pos, acc, apart) {
          var out = [];
          for (var a = 0; a < n; a++) {
            if (!consts[a].isAnchored) out.push("  vec2 " + acc(a) + " = vec2(0.0);");
          }
          eachGravityPair(function (pa, pb) {
            var aMoves = !consts[pa].isAnchored, bMoves = !consts[pb].isAnchored;
            out.push("  {");
            out.push("    vec2 d = vec2(" + pos(pb) + ".x - " + pos(pa) + ".x, " + pos(pb) + ".y - " + pos(pa) + ".y);");
            // Touching bodies do not pull (PhysicsEngine.computeAccelerations); collisions off: smooth interior law.
            out.push("    float contact = " + reachExpr[pa] + " + " + reachExpr[pb] + ";");
            out.push("    float r2 = dot(d, d);");
            if (collisionsOn) {
              out.push("    if (" + (apart ? apart(pa, pb) : "r2 >= contact * contact") + ") {");
              if (apart) out.push("      r2 = max(r2, contact * contact);");
              if (aMoves) out.push("      " + acc(pa) + " += " + pull32(pb, "(r2 * sqrt(r2))") + ";");
              if (bMoves) out.push("      " + acc(pb) + " -= " + pull32(pa, "(r2 * sqrt(r2))") + ";");
              out.push("    }");
            } else {
              out.push("    {");
              out.push("      float u2 = r2 / (contact * contact);");
              out.push("      bool outside = r2 >= contact * contact;");
              out.push("      float poly = (35.0 / 8.0 - 21.0 / 4.0 * u2 + 15.0 / 8.0 * u2 * u2);");
              [[pa, pb, aMoves, "+="], [pb, pa, bMoves, "-="]].forEach(function (side) {
                if (!side[2]) return;
                out.push("      " + acc(side[0]) + " " + side[3] + " (outside");
                out.push("        ? " + fnum(GRAV_G) + " * gravMass" + side[1] + " / (r2 * sqrt(r2))");
                out.push("        : " + fnum(GRAV_G) + " * gravMass" + side[1] + " / (contact * contact * contact) * poly) * d;");
              });
              out.push("    }");
            }
            out.push("  }");
          });
          return out;
        };
      }
      gravityLines(B, function (i) { return "gravAcc" + i; }).forEach(function (l) { lines.push(l); });
      for (var ga = 0; ga < n; ga++) {
        if (!consts[ga].isAnchored) accelExpr[ga] = "gravAcc" + ga;
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
    // Past the substep loop, every leg reads the constant acceleration it found.
    var substeps = mutualGravity && flags && flags.gravitySubsteps > 1 ? flags.gravitySubsteps : 1;
    var substepped = false;
    function accelFor(i) {
      if (substepped) return "gsAcc" + i;
      return sprung[i] ? "accel" + i : gravityAccelFor(i);
    }
    // Plain gravity in df takes the form that skips the zero x component.
    function advance(i, vExpr, dtExpr) {
      if (df && !mutualGravity && !sprung[i]) return "dfAdvanceVelocityGravity(" + vExpr + ", " + dtExpr + ")";
      return E.advanceVelocity + "(" + vExpr + ", " + dtExpr + ", " + accelFor(i) + ")";
    }
    // A turned body's spin after `t` of this step's torque: see springSpinGLSL.
    function spinExpr(i, t) {
      return (df ? "dfSpringSpin(" : "springSpin(") + B(i) + ".w, sprAlpha" + i + ", sprSwing" + i + ", " + t + ")";
    }

    // vFull drives both detection and leg 1, so the body moves along the line it was swept against.
    for (var g = 0; g < n; g++) {
      if (consts[g].isAnchored) continue;
      lines.push("  " + E.vecType + " u" + g + " = " + E.vec(B(g) + ".vx", B(g) + ".vy") + ";");
      if (substeps === 1) lines.push("  " + E.vecType + " vFull" + g + " = " + advance(g, "u" + g, E.DT) + ";");
    }
    // ---- Gravity Substeps: PhysicsEngine.substepGravity, the first kick on the start-of-step pull ----
    if (substeps > 1) {
      var lit = df ? global.PhysicsDF.num : fnum;
      var gsH = lit(FIXED_DT / substeps);
      var free = [];
      for (var gf = 0; gf < n; gf++) if (!consts[gf].isAnchored) free.push(gf);
      function gsDrift(i) {
        return "gsP" + i + " = " + (df ? "dv2Add(gsP" + i + ", dv2Scale(gsV" + i + ", " + gsH + "))" : "gsP" + i + " + gsV" + i + " * " + gsH) + ";";
      }
      free.forEach(function (i) {
        lines.push("  " + E.vecType + " gsV" + i + " = " + E.advanceVelocity + "(u" + i + ", " + gsH + ", " + accelFor(i) + ");");
        lines.push("  " + E.vecType + " gsP" + i + " = " + E.vec(B(i) + ".x", B(i) + ".y") + "; " + gsDrift(i));
      });
      var gsApart = collisionsOn ? function (a, b) { return "gsApart" + a + "_" + b; } : null;
      if (gsApart) apartLines(gsApart).forEach(function (l) { lines.push(l); });
      lines.push("  for (int gs = 1; gs < " + substeps + "; gs++) {");
      gravityLines(function (i) { return consts[i].isAnchored ? B(i) : "gsP" + i; }, function (i) { return "gsGrav" + i; }, gsApart)
        .forEach(function (l) { lines.push("  " + l); });
      free.forEach(function (i) {
        var a = sprung[i] ? E.vadd("gsGrav" + i, "sprAcc" + i) : "gsGrav" + i;
        lines.push("    gsV" + i + " = " + E.advanceVelocity + "(gsV" + i + ", " + gsH + ", " + a + ");");
        lines.push("    " + gsDrift(i));
      });
      lines.push("  }");
      free.forEach(function (i) {
        lines.push("  " + E.vecType + " gsAcc" + i + " = " + (df ? "dfLegAcceleration" : "legAcceleration") + "(u" + i + ", gsV" + i + ", " + E.DT + ");");
        lines.push("  " + E.vecType + " vFull" + i + " = " + (df
          ? "dv2Scale(dv2Sub(gsP" + i + ", dv2(" + B(i) + ".x, " + B(i) + ".y)), " + lit(1 / FIXED_DT) + ")"
          : "(gsP" + i + " - vec2(" + B(i) + ".x, " + B(i) + ".y)) * " + fnum(1 / FIXED_DT)) + ";");
      });
      substepped = true;
    }
    lines.push("");

    // ---- Hinge impulses for the start pose: PhysicsEngine.shakeHinges, unrolled ----
    // Hinges with a side that can move; the free bodies they move; each side as the engine sees it.
    var shaken = hingeAnchors.filter(function (hg) {
      return !((hg.aIsWorld || consts[hg.a].isAnchored) && consts[hg.b].isAnchored);
    });
    var shakeBodies = [];
    shaken.forEach(function (hg) {
      [hg.aIsWorld ? null : hg.a, hg.b].forEach(function (idx) {
        if (idx !== null && !consts[idx].isAnchored && shakeBodies.indexOf(idx) === -1) shakeBodies.push(idx);
      });
    });
    shakeBodies.sort(function (a, b) { return a - b; });
    var shakeSides = shaken.map(function (hg, h) {
      function side(idx, isWorld, param, sign) {
        if (isWorld) return { fixed: param, world: true };
        if (consts[idx].isAnchored) return { fixed: "shF" + param, body: idx, param: param };
        return { body: idx, sign: sign, param: param, r0: "shR0" + param };
      }
      return [side(hg.a, hg.aIsWorld, "HINGE" + h + "_A", -1), side(hg.b, false, "HINGE" + h + "_B", 1)];
    });
    var H = shaken.length, N = 2 * H, shakeIters = global.PhysicsEngine.hingeShakeIterations(H);
    function shJ(r, c) { return "shJ" + r + "_" + c; }
    if (H) {
      shakeBodies.forEach(function (i) {
        lines.push("  " + E.scalarType + " shW" + i + " = " + (turned[i] ? spinExpr(i, E.DT) : B(i) + ".w") + ";");
        lines.push("  " + E.vecType + " shDv" + i + " = " + E.zeroVec + "; " + E.scalarType + " shDw" + i + " = " + E.zero + ";");
        lines.push(df
          ? "  MF shS0_" + i + ", shC0_" + i + "; dfSinCos(" + B(i) + ".angle, shS0_" + i + ", shC0_" + i + ");"
          : "  float shS0_" + i + " = sin(" + B(i) + ".angle), shC0_" + i + " = cos(" + B(i) + ".angle);");
      });
      lines.push("  bool shOk = " + shakeBodies.map(function (i) { return E.spinOk("shW" + i); }).join(" && ") + ";");
      shaken.forEach(function (hg, h) {
        shakeSides[h].forEach(function (sd) {
          if (sd.world) return;
          if (sd.fixed) {
            // An anchored body: its anchor stays where it is all step.
            var arm = df ? "dfRotate(" + sd.param + ".x, " + sd.param + ".y, " + B(sd.body) + ".angle)" : "rotateVec(" + sd.param + ", " + B(sd.body) + ".angle)";
            lines.push("  " + E.vecType + " " + sd.fixed + " = " + E.vadd(E.vec(B(sd.body) + ".x", B(sd.body) + ".y"), arm) + ";");
            return;
          }
          lines.push("  " + E.vecType + " " + sd.r0 + " = " + E.rotateBy(sd.param, "shS0_" + sd.body, "shC0_" + sd.body) + ";");
        });
      });
      lines.push("  if (shOk) {");
      lines.push("    for (int sh = 0; sh < " + shakeIters + "; sh++) {");
      shakeBodies.forEach(function (i) {
        lines.push("      " + E.scalarType + " shAE" + i + " = " + E.add(B(i) + ".angle", E.mul(E.add("shW" + i, "shDw" + i), E.DT)) + ";");
        lines.push(df
          ? "      MF shSE" + i + ", shCE" + i + "; dfSinCos(shAE" + i + ", shSE" + i + ", shCE" + i + ");"
          : "      float shSE" + i + " = sin(shAE" + i + "), shCE" + i + " = cos(shAE" + i + ");");
        lines.push("      " + E.vecType + " shPE" + i + " = " + E.vec(
          E.add(B(i) + ".x", E.mul(E.add("vFull" + i + ".x", "shDv" + i + ".x"), E.DT)),
          E.add(B(i) + ".y", E.mul(E.add("vFull" + i + ".y", "shDv" + i + ".y"), E.DT))) + ";");
      });
      shaken.forEach(function (hg, h) {
        var ends = shakeSides[h].map(function (sd, k) {
          if (sd.fixed) return sd.fixed;
          var arm = "shRE" + sd.param;
          lines.push("      " + E.vecType + " " + arm + " = " + E.rotateBy(sd.param, "shSE" + sd.body, "shCE" + sd.body) + ";");
          return E.vadd("shPE" + sd.body, arm);
        });
        lines.push("      " + E.vecType + " shG" + h + " = " + E.vsub(ends[1], ends[0]) + ";");
      });
      for (var r = 0; r < N; r++) {
        lines.push("      " + E.scalarType + " " + (function () {
          var decl = [];
          for (var c = 0; c < N; c++) decl.push(shJ(r, c) + " = " + E.zero);
          return decl.join(", ");
        })() + ";");
      }
      shaken.forEach(function (hg, h) {
        lines.push("      " + E.scalarType + " shB" + (2 * h) + " = " + E.div(E.neg("shG" + h + ".x"), E.DT) + ", shB" + (2 * h + 1) + " = " + E.div(E.neg("shG" + h + ".y"), E.DT) + ";");
      });
      // dGap_h / dP_k: every body both hinges touch, end arm of h paired with start arm of k.
      function addTo(name, expr, plus) {
        return name + " = " + (plus ? E.add(name, expr) : E.sub(name, expr)) + ";";
      }
      shaken.forEach(function (hg, h) {
        shaken.forEach(function (hk, k) {
          shakeSides[h].forEach(function (sh) {
            if (sh.fixed) return;
            shakeSides[k].forEach(function (sk) {
              if (sk.fixed || sk.body !== sh.body) return;
              var plus = sh.sign === sk.sign, m = "BODY" + sh.body + "_INV_MASS", inv = "BODY" + sh.body + "_INV_INERTIA";
              var rn = "shRE" + sh.param, r0 = sk.r0;
              lines.push("      " + addTo(shJ(2 * h, 2 * k), E.add(m, E.mul(E.mul(inv, rn + ".y"), r0 + ".y")), plus));
              lines.push("      " + addTo(shJ(2 * h, 2 * k + 1), E.mul(E.mul(E.neg(inv), rn + ".y"), r0 + ".x"), plus));
              lines.push("      " + addTo(shJ(2 * h + 1, 2 * k), E.mul(E.mul(E.neg(inv), rn + ".x"), r0 + ".y"), plus));
              lines.push("      " + addTo(shJ(2 * h + 1, 2 * k + 1), E.add(m, E.mul(E.mul(inv, rn + ".x"), r0 + ".x")), plus));
            });
          });
        });
      });
      // Elimination without pivoting, then back substitution, in the engine's order.
      for (var ei = 0; ei < N; ei++) {
        for (var ej = ei + 1; ej < N; ej++) {
          var f = "shF" + ej + "_" + ei;
          lines.push("      " + E.scalarType + " " + f + " = " + E.div(shJ(ej, ei), shJ(ei, ei)) + ";");
          for (var ek = ei + 1; ek < N; ek++) lines.push("      " + shJ(ej, ek) + " = " + E.sub(shJ(ej, ek), E.mul(f, shJ(ei, ek))) + ";");
          lines.push("      shB" + ej + " = " + E.sub("shB" + ej, E.mul(f, "shB" + ei)) + ";");
        }
      }
      for (var bi = N - 1; bi >= 0; bi--) {
        var sum = "shB" + bi;
        for (var bj = bi + 1; bj < N; bj++) sum = E.sub(sum, E.mul(shJ(bi, bj), "shB" + bj));
        lines.push("      shB" + bi + " = " + E.div(sum, shJ(bi, bi)) + ";");
      }
      shaken.forEach(function (hg, h) {
        var Px = "shB" + (2 * h), Py = "shB" + (2 * h + 1);
        shakeSides[h].forEach(function (sd) {
          if (sd.fixed) return;
          var plus = sd.sign > 0, m = "BODY" + sd.body + "_INV_MASS", inv = "BODY" + sd.body + "_INV_INERTIA";
          lines.push("      " + addTo("shDv" + sd.body + ".x", E.mul(Px, m), plus));
          lines.push("      " + addTo("shDv" + sd.body + ".y", E.mul(Py, m), plus));
          lines.push("      " + addTo("shDw" + sd.body, E.mul(inv, E.sub(E.mul(sd.r0 + ".x", Py), E.mul(sd.r0 + ".y", Px))), plus));
        });
      });
      lines.push("    }");
      lines.push("  }");
      shakeBodies.forEach(function (i) {
        lines.push("  vFull" + i + " = " + E.vadd("vFull" + i, "shDv" + i) + ";");
        if (substepped) lines.push("  gsV" + i + " = " + E.vadd("gsV" + i, "shDv" + i) + ";");
      });
      lines.push("");
    }
    function isShaken(idx) { return shakeBodies.indexOf(idx) !== -1; }

    // Probes: real position, velocity vFull, so swept tests match leg 1's motion.
    for (var p = 0; p < n; p++) {
      if (consts[p].isAnchored) continue;
      lines.push("  " + E.bodyType + " probe" + p + " = " + B(p) + "; probe" + p + ".vx = vFull" + p + ".x; probe" + p + ".vy = vFull" + p + ".y;");
    }
    lines.push("");

    function probeRef(idx) { return consts[idx].isAnchored ? B(idx) : "probe" + idx; }

    // df only: this step's geometry for every movable line, from its probe.
    if (df) {
      Object.keys(segLines).forEach(function (idx) {
        if (consts[idx].isAnchored) return;
        lines.push("  DSegment seg" + idx + " = dfLineSegment(probe" + idx + ", BODY" + idx + "_HALF);");
      });
    }
    // Port hole frames at the step's start, and where every free body began.
    if (portals) {
      portals.forEach(function (idx) {
        if (consts[idx].isAnchored) {
          if (!df) lines.push("  " + phTangentDecl("phT" + idx, B(idx)));
        } else {
          lines.push("  " + phTangentDecl("phT" + idx + "s", B(idx)));
          lines.push("  " + E.vecType + " phC" + idx + "s = " + E.vec(B(idx) + ".x", B(idx) + ".y") + ";");
        }
        lines.push("  " + E.vecType + " phN" + idx + "s = " + phNormal(phT(idx, false)) + ";");
      });
      for (var ps = 0; ps < n; ps++) {
        if (consts[ps].isAnchored) continue;
        lines.push("  " + E.vecType + " phS" + ps + " = " + E.vec(B(ps) + ".x", B(ps) + ".y") + ";");
        if (portals.indexOf(ps) !== -1) lines.push("  " + E.scalarType + " phAng" + ps + "s = " + B(ps) + ".angle, phSpin" + ps + "s = " + B(ps) + ".w;");
      }
      lines.push("");
    }
    // A line's collide argument: half-length in float32, prebuilt segment in df.
    function lineArg(idx) { return df ? segExpr(idx) : "BODY" + idx + "_HALF"; }
    // df sweeps against an anchored segment skip its zero velocity; float32 folds it.
    function isStatic(idx) { return df && consts[idx].isAnchored; }
    function lineCircleCall(li, ci) {
      if (consts[li].type === "porthole") {
        // A port hole meets a circle as its oval; df reads the tangent off its segment and the reach off its half.
        return df
          ? (isStatic(li) ? "dfCollidePortholeCircleStatic" : E.collidePortholeCircle) + "(" + probeRef(li) + ", " + segExpr(li) + ", BODY" + li + "_HALF, " + probeRef(ci) + ", BODY" + ci + "_HALF)"
          : E.collidePortholeCircle + "(" + probeRef(li) + ", BODY" + li + "_HALF, " + probeRef(ci) + ", BODY" + ci + "_HALF)";
      }
      return (isStatic(li) ? "dfCollideLineCircleStatic" : E.collideLineCircle) + "(" + probeRef(li) + ", " + lineArg(li) + ", " + probeRef(ci) + ", BODY" + ci + "_HALF)";
    }
    // A port hole meets a plain line as its oval (two port holes meet as capsules).
    function portholeLineCall(pi, li) {
      return df
        ? E.collidePortholeLine + "(" + probeRef(pi) + ", " + segExpr(pi) + ", BODY" + pi + "_HALF, " + probeRef(li) + ", " + segExpr(li) + ")"
        : E.collidePortholeLine + "(" + probeRef(pi) + ", BODY" + pi + "_HALF, " + probeRef(li) + ", BODY" + li + "_HALF)";
    }
    // Only a line<->line pair can fill its second contact slot.
    function pairSlots(pair) {
      return consts[pair[0]].type !== "circle" && consts[pair[1]].type !== "circle" ? ["c0", "c1"] : ["c0"];
    }

    // Contacts are computed once per step and reused by every solver iteration.
    function detected(type, name, expr) {
      return "  " + type + " " + name + " = " + expr + ";";
    }
    pairs.forEach(function (pair) {
      var i = pair[0], j = pair[1];
      var tA = consts[i].type, tB = consts[j].type;
      var varName = "pair_" + i + "_" + j;
      var refI = probeRef(i), refJ = probeRef(j);
      if (tA === "circle" && tB === "circle") {
        lines.push(detected(E.contactPairType, varName, E.contactPairType + "(" + E.collideCircleCircle + "(" + refI + ", BODY" + i + "_HALF, " + refJ + ", BODY" + j + "_HALF), " + E.noContact + ")"));
      } else if (tB === "circle") {
        lines.push(detected(E.contactPairType, varName, E.contactPairType + "(" + lineCircleCall(i, j) + ", " + E.noContact + ")"));
      } else if (tA === "circle") {
        // collideLineCircle takes (line, circle): swap rA/rB back and flip the normal.
        lines.push(detected(E.contactType, varName + "_raw", lineCircleCall(j, i)));
        lines.push("  " + varName + "_raw.normal = " + E.negVec(varName + "_raw.normal") + ";");
        lines.push("  { " + E.vecType + " tmp_" + i + "_" + j + " = " + varName + "_raw.rA; " + varName + "_raw.rA = " + varName + "_raw.rB; " + varName + "_raw.rB = tmp_" + i + "_" + j + "; }");
        lines.push("  " + E.contactPairType + " " + varName + " = " + E.contactPairType + "(" + varName + "_raw, " + E.noContact + ");");
      } else if (tA === "porthole" && tB !== "porthole") {
        lines.push(detected(E.contactPairType, varName, portholeLineCall(i, j)));
      } else if (tB === "porthole" && tA !== "porthole") {
        // collidePortholeLine takes (port hole, line): swap rA/rB back and flip the normal.
        lines.push(detected(E.contactPairType, varName, portholeLineCall(j, i)));
        lines.push("  " + varName + ".c0.normal = " + E.negVec(varName + ".c0.normal") + ";");
        lines.push("  { " + E.vecType + " tmp_" + i + "_" + j + " = " + varName + ".c0.rA; " + varName + ".c0.rA = " + varName + ".c0.rB; " + varName + ".c0.rB = tmp_" + i + "_" + j + "; }");
      } else {
        lines.push(detected(E.contactPairType, varName, E.collideLineLine + "(" + refI + ", " + lineArg(i) + ", " + refJ + ", " + lineArg(j) + ")"));
      }
    });
    // A leader's contact on a port hole's front is no contact: its point (the port hole's lever arm)
    // sits in front of the center line.
    if (portals) pairs.forEach(function (pair) {
      var pi = portals.indexOf(pair[0]) !== -1 ? pair[0] : (portals.indexOf(pair[1]) !== -1 ? pair[1] : -1);
      if (pi === -1) return;
      var oi = pi === pair[0] ? pair[1] : pair[0];
      if (leaders.indexOf(oi) === -1) return;
      var arm = pi === pair[0] ? "rA" : "rB";
      pairSlots(pair).forEach(function (slot) {
        var c = "pair_" + pair[0] + "_" + pair[1] + "." + slot, r = c + "." + arm;
        lines.push(df
          ? "  if (" + c + ".hit && dfGreater(dv2Dot(" + r + ", phN" + pi + "s), DF_ZERO)) " + c + ".hit = false;"
          : "  if (" + c + ".hit && dot(" + r + ", phN" + pi + "s) > 0.0) " + c + ".hit = false;");
      });
    });
    // df only: per-contact constants no solver iteration changes (dfPrepareContact).
    function prepareContactLine(contactExpr, a, b) {
      return "  dfPrepareContact(" + contactExpr + ", BODY" + a + "_INV_MASS, BODY" + a + "_INV_INERTIA, " + moves(a) + ", BODY" + b + "_INV_MASS, BODY" + b + "_INV_INERTIA, " + moves(b) + ");";
    }
    if (df) {
      pairs.forEach(function (pair) {
        pairSlots(pair).forEach(function (slot) {
          lines.push(prepareContactLine("pair_" + pair[0] + "_" + pair[1] + "." + slot, pair[0], pair[1]));
        });
      });
    }
    lines.push("");

    // "Touching anything this step?" for the flagged body. Globals: a constant-initialized
    // bool is legal there, and no inout to thread.
    if (contactBody >= 0) {
      var touching = [];
      pairs.forEach(function (pair) {
        if (pair[0] !== contactBody && pair[1] !== contactBody) return;
        var vn = "pair_" + pair[0] + "_" + pair[1];
        touching.push("(" + pairSlots(pair).map(function (slot) { return vn + "." + slot + ".hit"; }).join(" || ") + ")");
      });
      lines.push("  g_contact" + contactBody + " = " + (touching.length ? touching.join(" || ") : "false") + ";");
    }
    for (var tk = 0; touchBody >= 0 && tk < n; tk++) {
      if (tk === touchBody) continue;
      var touchHits = [];
      pairs.forEach(function (pair) {
        if (!((pair[0] === touchBody && pair[1] === tk) || (pair[0] === tk && pair[1] === touchBody))) return;
        var vn = "pair_" + pair[0] + "_" + pair[1];
        touchHits.push("(" + pairSlots(pair).map(function (slot) { return vn + "." + slot + ".hit"; }).join(" || ") + ")");
      });
      lines.push("  g_touch" + tk + " = " + (touchHits.length ? touchHits.join(" || ") : "false") + ";");
    }
    if (pairContacts && pairs.length) {
      var pairBits = pairs.map(function (pair) {
        var vn = "pair_" + pair[0] + "_" + pair[1];
        var hit = pairSlots(pair).map(function (slot) { return vn + "." + slot + ".hit"; }).join(" || ");
        return "((" + hit + ") ? " + fnum(Math.pow(2, pairContactBit(pair[0], pair[1], n))) + " : 0.0)";
      });
      lines.push("  g_pairContacts = " + pairBits.join(" + ") + ";");
    }
    lines.push("");

    // Per-body earliest contact tHit, default DT; folded only when a slot hit (a miss carries 0.0).
    // A body in no pair keeps the whole step: no tHit, vPre is vFull, and leg 2 is skipped.
    var paired = {};
    pairs.forEach(function (pair) { paired[pair[0]] = true; paired[pair[1]] = true; });
    function contactTHitExpr(varName, slot) {
      return varName + "." + slot + ".hit ? " + varName + "." + slot + ".tHit : " + E.DT;
    }
    for (var q = 0; q < n; q++) {
      if (consts[q].isAnchored || !paired[q]) continue;
      lines.push("  " + E.scalarType + " body" + q + "THit = " + E.DT + ";");
    }
    pairs.forEach(function (pair) {
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

    // Leg 1: move at vFull for tHit (matching detection). A hit body's kick before the solve runs to tHit plus
    // half a (sub)step and leg 2 takes the rest (PhysicsEngine.step's bodyTKick).
    for (var g3 = 0; g3 < n; g3++) {
      if (consts[g3].isAnchored) continue;
      var t1 = paired[g3] ? "body" + g3 + "THit" : E.DT;
      lines.push("  " + B(g3) + ".x = " + E.add(B(g3) + ".x", E.mul("vFull" + g3 + ".x", t1)) + ";");
      lines.push("  " + B(g3) + ".y = " + E.add(B(g3) + ".y", E.mul("vFull" + g3 + ".y", t1)) + ";");
      var spinFull = turned[g3] ? spinExpr(g3, E.DT) : B(g3) + ".w", spinHit = turned[g3] ? spinExpr(g3, t1) : B(g3) + ".w";
      if (isShaken(g3)) {
        // The hinge impulse (already in vFull) joins the spin and the velocity here.
        lines.push("  " + B(g3) + ".angle = " + E.add(B(g3) + ".angle", E.mul(E.add(spinFull, "shDw" + g3), t1)) + ";");
        lines.push("  " + B(g3) + ".w = " + E.add(spinHit, "shDw" + g3) + ";");
      } else if (turned[g3]) {
        // Angular twin: rotate at the whole step's spin, leave w with the torque by tHit.
        lines.push("  " + B(g3) + ".angle = " + E.add(B(g3) + ".angle", E.mul(spinFull, t1)) + ";");
        lines.push("  " + B(g3) + ".w = " + spinHit + ";");
      } else {
        lines.push("  " + B(g3) + ".angle = " + E.add(B(g3) + ".angle", E.mul(B(g3) + ".w", t1)) + ";");
      }
      if (paired[g3]) {
        var tk1 = "body" + g3 + "TKick";
        lines.push("  " + E.scalarType + " " + tk1 + " = " + E.DT + ";");
        lines.push("  if (" + E.less(t1, E.DT) + ") " + tk1 + " = " + E.add(t1, substepped ? lit(FIXED_DT / substeps / 2) : E.halfDT) + ";");
        lines.push("  " + E.vecType + " vPre" + g3 + " = " + (isShaken(g3) ? E.vadd(advance(g3, "u" + g3, tk1), "shDv" + g3) : advance(g3, "u" + g3, tk1)) + ";");
        lines.push("  " + B(g3) + ".vx = vPre" + g3 + ".x; " + B(g3) + ".vy = vPre" + g3 + ".y;");
      } else {
        // Substepped, vFull is the chord; the velocity the body keeps is the loop's.
        var vKept = substepped ? "gsV" + g3 : "vFull" + g3;
        lines.push("  " + B(g3) + ".vx = " + vKept + ".x; " + B(g3) + ".vy = " + vKept + ".y;");
      }
    }
    lines.push("");

    // ---- The two solve loops ----
    // float32 re-derives everything per call. df lifts what a loop cannot change out
    // of it (hinged sin/cos, dfPrepareHinge, dfPrepareContact); the position loop turns bodies, so dfTurn.
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

    var solves = hingeAnchors.length || pairs.length;
    // One 2x2 solve is exact for a lone hinge with nothing else to solve (PhysicsEngine.step).
    var velIterCount = hingeAnchors.length === 1 && !pairs.length ? 1 : VELOCITY_ITERATIONS;
    if (solves) lines.push("  for (int iter = 0; iter < " + velIterCount + "; iter++) {");
    hingeAnchors.forEach(function (hg, hi) { lines.push("    " + hingeCall(hg, hi, "velocity")); });
    pairs.forEach(function (pair) {
      var varName = "pair_" + pair[0] + "_" + pair[1];
      // c1 only for line<->line: elsewhere it is noContact() by construction.
      pairSlots(pair).forEach(function (slot) {
        lines.push("    " + contactVelocityCall(pair[0], pair[1], varName + "." + slot));
      });
    });
    if (solves) lines.push("  }");
    lines.push("");
    // Leg 2: the rest of the step, and of the kick, on the post-impulse velocity; no contact means identity.
    for (var g2 = 0; g2 < n; g2++) {
      if (consts[g2].isAnchored || !paired[g2]) continue;
      var t2 = "body" + g2 + "TRest";
      lines.push("  " + E.scalarType + " " + t2 + " = " + E.sub(E.DT, "body" + g2 + "THit") + ";");
      lines.push("  " + E.vecType + " vPost" + g2 + " = " + advance(g2, E.vec(B(g2) + ".vx", B(g2) + ".vy"), E.sub(E.DT, "body" + g2 + "TKick")) + ";");
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
    // The shake lands the joints closed; hinges project only on steps a contact or the spin guard spoiled.
    var projectWhen = [];
    if (hingeAnchors.length && pairs.length) {
      var hits = [];
      pairs.forEach(function (pair) {
        var vn = "pair_" + pair[0] + "_" + pair[1];
        pairSlots(pair).forEach(function (slot) { hits.push(vn + "." + slot + ".hit"); });
      });
      lines.push("  bool shAnyHit = " + hits.join(" || ") + ";");
      projectWhen.push("shAnyHit");
    }
    if (hingeAnchors.length && H) projectWhen.push("!shOk");
    if (solves) lines.push("  for (int iter = 0; iter < " + POSITION_ITERATIONS + "; iter++) {");
    if (hingeAnchors.length) {
      if (projectWhen.length) lines.push("    if (" + projectWhen.join(" || ") + ") {");
      hingeAnchors.forEach(function (hg, hi) { lines.push("    " + (projectWhen.length ? "  " : "") + hingeCall(hg, hi, "position")); });
      if (projectWhen.length) lines.push("    }");
    }
    pairs.forEach(function (pair) {
      var varName = "pair_" + pair[0] + "_" + pair[1];
      pairSlots(pair).forEach(function (slot) {
        lines.push("    " + contactPositionCall(pair[0], pair[1], varName + "." + slot));
      });
    });
    if (solves) lines.push("  }");

    // ---- Port holes: a leader that crossed a front band this step leaves through the other ----
    // The crossing is read from the actual step (in front at its start, behind at its end) in the
    // port hole's own frames at both ends; the mapping, and the re-integration of the step's share
    // past the crossing on the exit side, are PhysicsEngine.applyPortholeTransports'.
    if (portals) {
      lines.push("");
      portals.forEach(function (idx) {
        if (!consts[idx].isAnchored) lines.push("  " + phTangentDecl("phT" + idx + "e", B(idx)));
        lines.push("  " + E.vecType + " phN" + idx + "e = " + phNormal(phT(idx, true)) + ";");
      });
      function phRot(v) { return (df ? "dv2RotateBy(" : "rotateBy(") + v + ", phSn, phCs)"; }
      function phPos(idx) { return consts[idx].isAnchored ? E.vec(B(idx) + ".x", B(idx) + ".y") : "phS" + idx; }
      // Mutual Gravity's pull on member m at `pos` from every body outside its chain, at their step-start poses.
      function outsidePullLines(target, m, members, pos) {
        var out = [];
        for (var j = 0; j < n; j++) {
          if (members.indexOf(j) !== -1) continue;
          if (df) {
            out.push("      { DVec2 gd = dv2Sub(" + phPos(j) + ", " + pos + "); MF gr2 = dv2LengthSq(gd); MF gContact = dfAdd(gravReach" + m + ", gravReach" + j + "); MF gContact2 = dfSqr(gContact);");
            if (collisionsOn) {
              out.push("        if (!dfLess(gr2, gContact2)) { MF gk = dfDiv(DF_ONE, dfMul(gr2, dfSqrt(gr2))); " + target + " = dv2Add(" + target + ", dv2Scale(gd, dfMul(gravGM" + j + ", gk))); } }");
            } else {
              out.push("        MF gk; if (!dfLess(gr2, gContact2)) { gk = dfDiv(DF_ONE, dfMul(gr2, dfSqrt(gr2))); } else { MF gu2 = dfDiv(gr2, gContact2); MF gPoly = dfAdd(dfSub(" + dfnumG(35 / 8) + ", dfMul(" + dfnumG(21 / 4) + ", gu2)), dfMul(" + dfnumG(15 / 8) + ", dfSqr(gu2))); gk = dfDiv(gPoly, dfMul(gContact2, gContact)); }");
              out.push("        " + target + " = dv2Add(" + target + ", dv2Scale(gd, dfMul(gravGM" + j + ", gk))); }");
            }
          } else {
            out.push("      { vec2 d = " + phPos(j) + " - " + pos + "; float contact = " + reachExpr[m] + " + " + reachExpr[j] + "; float r2 = dot(d, d);");
            if (collisionsOn) {
              out.push("        if (r2 >= contact * contact) " + target + " += (" + fnum(GRAV_G) + " * gravMass" + j + " / (r2 * sqrt(r2))) * d; }");
            } else {
              out.push("        float u2 = r2 / (contact * contact); float poly = (35.0 / 8.0 - 21.0 / 4.0 * u2 + 15.0 / 8.0 * u2 * u2);");
              out.push("        " + target + " += (r2 >= contact * contact ? " + fnum(GRAV_G) + " * gravMass" + j + " / (r2 * sqrt(r2)) : " +
                fnum(GRAV_G) + " * gravMass" + j + " / (contact * contact * contact) * poly) * d; }");
            }
          }
        }
        return out;
      }
      var phOutsideInit = mutualGravity ? E.zeroVec : (df ? "dv2(DF_ZERO, DF_GRAVITY)" : "vec2(0.0, GRAVITY)");
      leaders.forEach(function (oi) {
        [0, 1].forEach(function (k) {
          var pi = portals[k], t = "_" + oi + "_" + pi;
          var startC = consts[pi].isAnchored ? E.vec(B(pi) + ".x", B(pi) + ".y") : "phC" + pi + "s";
          var tS = phT(pi, false), tE = phT(pi, true);
          if (df) {
            lines.push("  DVec2 phD0" + t + " = dv2Sub(phS" + oi + ", " + startC + ");");
            lines.push("  DVec2 phD1" + t + " = dv2(dfSub(" + B(oi) + ".x, " + B(pi) + ".x), dfSub(" + B(oi) + ".y, " + B(pi) + ".y));");
            lines.push("  MF phF0" + t + " = dv2Dot(phD0" + t + ", phN" + pi + "s), phF1" + t + " = dv2Dot(phD1" + t + ", phN" + pi + "e);");
            lines.push("  MF phS1" + t + " = dv2Dot(phD1" + t + ", " + tE + "), phSx" + t + " = DF_ZERO, phLam" + t + " = DF_ZERO;");
            lines.push("  bool phCross" + t + " = false;");
            lines.push("  if (!dfLess(phF0" + t + ", DF_ZERO) && dfLess(phF1" + t + ", DF_ZERO)) {");
            lines.push("    phLam" + t + " = dfDiv(phF0" + t + ", dfSub(phF0" + t + ", phF1" + t + "));");
            lines.push("    MF phS0 = dv2Dot(phD0" + t + ", " + tS + ");");
            lines.push("    phSx" + t + " = dfAdd(phS0, dfMul(dfSub(phS1" + t + ", phS0), phLam" + t + "));");
            lines.push("    phCross" + t + " = !dfGreater(dfAbs(phSx" + t + "), dfAdd(dfAdd(BODY" + pi + "_HALF, DF_HALF_LINE_THICKNESS), BODY" + oi + "_HALF));");
            lines.push("  }");
          } else {
            lines.push("  vec2 phD0" + t + " = phS" + oi + " - " + startC + ";");
            lines.push("  vec2 phD1" + t + " = vec2(" + B(oi) + ".x - " + B(pi) + ".x, " + B(oi) + ".y - " + B(pi) + ".y);");
            lines.push("  float phF0" + t + " = dot(phD0" + t + ", phN" + pi + "s), phF1" + t + " = dot(phD1" + t + ", phN" + pi + "e);");
            lines.push("  float phS1" + t + " = dot(phD1" + t + ", " + tE + "), phSx" + t + " = 0.0, phLam" + t + " = 0.0;");
            lines.push("  bool phCross" + t + " = false;");
            lines.push("  if (phF0" + t + " >= 0.0 && phF1" + t + " < 0.0) {");
            lines.push("    phLam" + t + " = phF0" + t + " / (phF0" + t + " - phF1" + t + ");");
            lines.push("    float phS0 = dot(phD0" + t + ", " + tS + ");");
            lines.push("    phSx" + t + " = phS0 + (phS1" + t + " - phS0) * phLam" + t + ";");
            lines.push("    phCross" + t + " = abs(phSx" + t + ") <= BODY" + pi + "_HALF + LINE_THICKNESS * 0.5 + BODY" + oi + "_HALF;");
            lines.push("  }");
          }
        });
        [0, 1].forEach(function (k) {
          var pi = portals[k], qi = portals[1 - k], t = "_" + oi + "_" + pi;
          var members = passGroup[oi].members;
          var pMoves = !consts[pi].isAnchored, qMoves = !consts[qi].isAnchored;
          // Each port hole as it stood at the crossing instant: pose, velocity and spin interpolated
          // between the step's start and end. An anchored one is its constant self.
          function midState(idx, X) {
            if (consts[idx].isAnchored) return [];
            var c = "phC" + idx + "s", a = "phAng" + idx + "s", w = "phSpin" + idx + "s", u = "u" + idx;
            var pos = E.vec(B(idx) + ".x", B(idx) + ".y"), vel = E.vec(B(idx) + ".vx", B(idx) + ".vy"), out = [];
            if (df) {
              out.push("    DVec2 ph" + X + "c = dv2Add(" + c + ", dv2Scale(dv2Sub(" + pos + ", " + c + "), phLam" + t + "));");
              out.push("    MF ph" + X + "a = dfAdd(" + a + ", dfMul(dfSub(" + B(idx) + ".angle, " + a + "), phLam" + t + "));");
              out.push("    DVec2 ph" + X + "t; { MF tsn, tcs; dfSinCos(ph" + X + "a, tsn, tcs); ph" + X + "t = dv2(tcs, tsn); }");
              out.push("    DVec2 ph" + X + "v = dv2Add(" + u + ", dv2Scale(dv2Sub(" + vel + ", " + u + "), phLam" + t + "));");
              out.push("    MF ph" + X + "w = dfAdd(" + w + ", dfMul(dfSub(" + B(idx) + ".w, " + w + "), phLam" + t + "));");
            } else {
              out.push("    vec2 ph" + X + "c = " + c + " + (" + pos + " - " + c + ") * phLam" + t + ";");
              out.push("    float ph" + X + "a = " + a + " + (" + B(idx) + ".angle - " + a + ") * phLam" + t + ";");
              out.push("    vec2 ph" + X + "t = vec2(cos(ph" + X + "a), sin(ph" + X + "a));");
              out.push("    vec2 ph" + X + "v = " + u + " + (" + vel + " - " + u + ") * phLam" + t + ";");
              out.push("    float ph" + X + "w = " + w + " + (" + B(idx) + ".w - " + w + ") * phLam" + t + ";");
            }
            return out;
          }
          function midCenter(idx, X) { return consts[idx].isAnchored ? E.vec(B(idx) + ".x", B(idx) + ".y") : "ph" + X + "c"; }
          function midAngle(idx, X) { return consts[idx].isAnchored ? B(idx) + ".angle" : "ph" + X + "a"; }
          function midTangent(idx, X) { return consts[idx].isAnchored ? phT(idx, true) : "ph" + X + "t"; }
          // A movable port hole's velocity at a member's spot; velocity and spin are kept relative to it.
          function frameVelocity(X, pos) {
            return df
              ? "dv2(dfSub(ph" + X + "v.x, dfMul(ph" + X + "w, dfSub(" + pos + ".y, ph" + X + "c.y))), dfAdd(ph" + X + "v.y, dfMul(ph" + X + "w, dfSub(" + pos + ".x, ph" + X + "c.x))))"
              : "vec2(ph" + X + "v.x - ph" + X + "w * (" + pos + ".y - ph" + X + "c.y), ph" + X + "v.y + ph" + X + "w * (" + pos + ".x - ph" + X + "c.x))";
          }
          function phRel(v) { return pMoves ? (df ? "dv2Sub(" + v + ", phFin)" : v + " - phFin") : v; }
          function phOut(v) { return qMoves ? (df ? "dv2Add(" + v + ", phFout)" : "(" + v + " + phFout)") : v; }
          // The spin handed over, and the travel past the crossing carried into the exit's frame.
          var phSpinDiff = !pMoves && !qMoves ? null
            : (df ? (pMoves && qMoves ? "dfSub(phQw, phPw)" : (qMoves ? "phQw" : "dfNeg(phPw)")) : (pMoves && qMoves ? "(phQw - phPw)" : (qMoves ? "phQw" : "(-phPw)")));
          function phCarry() {
            var v = "phDv";
            if (qMoves) v = df ? "dv2Add(" + v + ", phFout)" : v + " + phFout";
            if (pMoves) v = df ? "dv2Sub(" + v + ", " + phRot("phFin") + ")" : v + " - " + phRot("phFin");
            return v;
          }
          var tP = midTangent(pi, "P"), tQ = midTangent(qi, "Q");
          lines.push("  " + (k === 0 ? "if" : "else if") + " (phCross" + t + ") {");
          midState(pi, "P").concat(midState(qi, "Q")).forEach(function (l) { lines.push(l); });
          if (df) {
            lines.push("    DVec2 phCrossPt = dv2Sub(" + midCenter(qi, "Q") + ", dv2Scale(" + tQ + ", dfMul(phSx" + t + ", dfDiv(BODY" + qi + "_HALF, BODY" + pi + "_HALF))));");
            lines.push("    MF phCs = dfNeg(dv2Dot(" + tQ + ", " + tP + ")), phSn = dfNeg(dv2Cross(" + tP + ", " + tQ + "));");
            lines.push("    MF phPhi = dfAdd(dfSub(" + midAngle(qi, "Q") + ", " + midAngle(pi, "P") + "), " + phLit(Math.PI) + ");");
            lines.push("    MF phTs = dfMul(phLam" + t + ", DF_DT), phTau = dfSub(DF_DT, phTs);");
            lines.push("    DVec2 phLead = dv2(" + B(oi) + ".x, " + B(oi) + ".y);");
            lines.push("    DVec2 phLeadStar = dv2Add(phS" + oi + ", dv2Scale(dv2Sub(phLead, phS" + oi + "), phLam" + t + "));");
          } else {
            lines.push("    vec2 phCrossPt = " + midCenter(qi, "Q") + " - (phSx" + t + " * (BODY" + qi + "_HALF / BODY" + pi + "_HALF)) * " + tQ + ";");
            lines.push("    float phCs = -dot(" + tQ + ", " + tP + "), phSn = -(" + tP + ".x * " + tQ + ".y - " + tP + ".y * " + tQ + ".x);");
            lines.push("    float phPhi = " + midAngle(qi, "Q") + " - " + midAngle(pi, "P") + " + " + fnum(Math.PI) + ";");
            lines.push("    float phTs = phLam" + t + " * DT, phTau = DT - phTs;");
            lines.push("    vec2 phLead = vec2(" + B(oi) + ".x, " + B(oi) + ".y);");
            lines.push("    vec2 phLeadStar = phS" + oi + " + (phLead - phS" + oi + ") * phLam" + t + ";");
          }
          members.forEach(function (m) {
            lines.push("    {");
            if (df) {
              lines.push("      DVec2 phHere = dv2(" + B(m) + ".x, " + B(m) + ".y);");
              lines.push("      DVec2 phStar = dv2Add(phS" + m + ", dv2Scale(dv2Sub(phHere, phS" + m + "), phLam" + t + "));");
              lines.push("      DVec2 phExitStar = dv2Add(phCrossPt, " + phRot("dv2Sub(phStar, phLeadStar)") + ");");
            } else {
              lines.push("      vec2 phHere = vec2(" + B(m) + ".x, " + B(m) + ".y);");
              lines.push("      vec2 phStar = phS" + m + " + (phHere - phS" + m + ") * phLam" + t + ";");
              lines.push("      vec2 phExitStar = phCrossPt + " + phRot("phStar - phLeadStar") + ";");
            }
            lines.push("      " + E.vecType + " phA = " + accelFor(m) + ";");
            lines.push("      " + E.vecType + " phExtIn = " + phOutsideInit + ", phExtOut = " + phOutsideInit + ";");
            if (mutualGravity) {
              outsidePullLines("phExtIn", m, members, "phS" + m).forEach(function (l) { lines.push(l); });
              outsidePullLines("phExtOut", m, members, "phExitStar").forEach(function (l) { lines.push(l); });
            }
            if (pMoves) lines.push("      " + E.vecType + " phFin = " + frameVelocity("P", "phStar") + ";");
            if (qMoves) lines.push("      " + E.vecType + " phFout = " + frameVelocity("Q", "phExitStar") + ";");
            if (df) {
              lines.push("      DVec2 phAOut = dv2Add(" + phRot("dv2Sub(phA, phExtIn)") + ", phExtOut);");
              lines.push("      DVec2 phVPre = " + advance(m, "u" + m, "phTs") + ";");
              lines.push("      DVec2 phDv = dv2Sub(" + E.advanceVelocity + "(" + phOut(phRot(phRel("phVPre"))) + ", phTau, phAOut), " + phOut(phRot(phRel(advance(m, "phVPre", "phTau")))) + ");");
              lines.push("      DVec2 phV = dv2Add(" + phOut(phRot(phRel("dv2(" + B(m) + ".vx, " + B(m) + ".vy)"))) + ", phDv); " + B(m) + ".vx = phV.x; " + B(m) + ".vy = phV.y;");
              lines.push("      DVec2 phAt = dv2Add(dv2Add(phCrossPt, " + phRot("dv2Sub(phHere, phLeadStar)") + "), dv2Scale(" + phCarry() + ", phTau)); " + B(m) + ".x = phAt.x; " + B(m) + ".y = phAt.y;");
            } else {
              lines.push("      vec2 phAOut = " + phRot("phA - phExtIn") + " + phExtOut;");
              lines.push("      vec2 phVPre = " + advance(m, "u" + m, "phTs") + ";");
              lines.push("      vec2 phDv = " + E.advanceVelocity + "(" + phOut(phRot(phRel("phVPre"))) + ", phTau, phAOut) - " + phOut(phRot(phRel(advance(m, "phVPre", "phTau")))) + ";");
              lines.push("      vec2 phV = " + phOut(phRot(phRel("vec2(" + B(m) + ".vx, " + B(m) + ".vy)"))) + " + phDv; " + B(m) + ".vx = phV.x; " + B(m) + ".vy = phV.y;");
              lines.push("      vec2 phAt = phCrossPt + " + phRot("phHere - phLeadStar") + " + (" + phCarry() + ") * phTau; " + B(m) + ".x = phAt.x; " + B(m) + ".y = phAt.y;");
            }
            if (phSpinDiff) {
              lines.push(df
                ? "      " + B(m) + ".w = dfAdd(" + B(m) + ".w, " + phSpinDiff + "); " + B(m) + ".angle = dfAdd(" + B(m) + ".angle, dfAdd(phPhi, dfMul(" + phSpinDiff + ", phTau)));"
                : "      " + B(m) + ".w += " + phSpinDiff + "; " + B(m) + ".angle += phPhi + " + phSpinDiff + " * phTau;");
            } else {
              lines.push(df ? "      " + B(m) + ".angle = dfAdd(" + B(m) + ".angle, phPhi);" : "      " + B(m) + ".angle += phPhi;");
            }
            if (m === warpBody) lines.push("      g_warp = true; g_warpTurn = phPhi;" + (warpFrom ? " g_warpFrom = " + pi + ";" : ""));
            if (warpBits) lines.push("      g_warpBits += " + fnum(Math.pow(2, m)) + ";");
            lines.push("    }");
          });
          lines.push("  }");
        });
      });
    }

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
        lines.push("  g_wrapDx" + root + " = " + dxVar + "; g_wrapDy" + root + " = " + dyVar + ";");
        // What moves with this root: pin and hinge descendants, or the whole spring group and its pins.
        var movedPins = [], descendants = {};
        if (springGroup) {
          springGroup.members.forEach(function (m) { descendants[m] = true; });
          hingeAnchors.forEach(function (hg, hi) { if (hg.aIsWorld && descendants[hg.b]) movedPins.push(hi); });
        } else {
          if (hasWorldHinge) movedPins.push(ownWorldHingeIdx[root]);
          collectDescendants(root, descendants);
        }
        // df adds are real work even by zero: only on a wrap step.
        var wrapIndent = df ? "    " : "  ";
        if (df) lines.push("  if (" + dxVar + " != 0.0 || " + dyVar + " != 0.0) {");
        movedPins.forEach(function (hi) {
          var hv = "HINGE" + hi + "_A";
          lines.push(df
            ? wrapIndent + hv + ".x = dfAddFloat(" + hv + ".x, " + dxVar + "); " + hv + ".y = dfAddFloat(" + hv + ".y, " + dyVar + ");"
            : wrapIndent + hv + " += vec2(" + dxVar + ", " + dyVar + ");");
        });
        Object.keys(descendants).forEach(function (memberStr) {
          lines.push(df
            ? wrapIndent + E.body + memberStr + ".x = dfAddFloat(" + E.body + memberStr + ".x, " + dxVar + "); " + E.body + memberStr + ".y = dfAddFloat(" + E.body + memberStr + ".y, " + dyVar + ");"
            : wrapIndent + "body" + memberStr + ".x += " + dxVar + "; body" + memberStr + ".y += " + dyVar + ";");
        });
        if (df) lines.push("  }");
      }
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
  // Texel (b, r) of the output is body b after r + 1 steps, and the sentinel column past the
  // bodies carries that step's wrap bits (x at bit 2b, y at bit 2b + 1), warp bits (bit
  // TRAJECTORY_WARP_SHIFT + b) and, in alpha, its contact bits (pairContactBit; the step code
  // needs the pairContacts and warpBits flags). Running every texel
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
  // Steered chunk time: well under the limit.
  var TRAJECTORY_TARGET_MS = 4;
  // Written beside the data by every draw so a dropped draw is noticed.
  var TRAJECTORY_SENTINEL = 8191;
  // Past the 2 * MAX_BODIES wrap bits; all of them stay under float32's 24 exact integer bits.
  var TRAJECTORY_WARP_SHIFT = 2 * MAX_BODIES;

  function trajectoryChunkInfo(n, consts, hingeAnchors, precision) {
    // Anchored bodies are not carried: every invocation re-declares them from the scene.
    var vars = playbackStateVariables({ precision: precision, n: n, consts: consts, hingeAnchors: hingeAnchors });
    var words = global.PhysicsDF.wordsFor(precision);
    return {
      vars: vars,
      maxSteps: TRAJECTORY_MAX_CHUNK,
      layers: playbackStateLayerCount(vars),
      words: words,
      // Extra render targets for the lower words of x and y, two words each (see loWordsGLSL).
      loOutputs: Math.ceil((words - 1) / 2),
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
    ].concat(loOutputNames(chunk).map(function (name, k) { return "layout(location = " + (k + 1) + ") out vec4 " + name + ";"; })).join("\n");
  }
  function loOutputNames(chunk) {
    var names = [];
    for (var k = 1; k <= (chunk.loOutputs || 0); k++) names.push("pbOut" + k);
    return names;
  }
  // Body o's lower position words, (x.y, y.y, x.z, y.z) then (x.w, y.w, 0, 0): the hi word alone cannot tell
  // two Inspect runs apart below float32 resolution.
  function loWordsGLSL(o, chunk) {
    var comps = ["x", "y", "z", "w"], lines = [];
    for (var k = 1; k <= chunk.loOutputs; k++) {
      var parts = [];
      for (var w = 2 * k - 1; w <= 2 * k; w++) {
        parts.push(w < chunk.words ? "dbody" + o + ".x." + comps[w] : "0.0");
        parts.push(w < chunk.words ? "dbody" + o + ".y." + comps[w] : "0.0");
      }
      lines.push("outLo" + k + " = vec4(" + parts.join(", ") + ");");
    }
    return lines.join(" ");
  }

  // batched: several runs side by side, run trajPoint in columns [trajPoint * (n + 1), ...) of the log and
  // [trajPoint * (layers + 1), ...) of the state strip; bodyDeclarationsGLSL may read trajPoint.
  function generateTrajectoryMainGLSL(n, bodyDeclarationsGLSL, hingeAnchors, precision, chunk, springs, batched) {
    var df = global.PhysicsDF.isExtended(precision);
    function readField(i, field) { return df ? "dfToFloat(dbody" + i + "." + field + ")" : "body" + i + "." + field; }
    var stepCall = "stepOnce(" + stepOnceCallArgs(n, hingeAnchors, precision, springs) + ");";
    var logStride = n + 1, stripStride = chunk.layers + 1;
    var lines = [];
    lines.push("void main() {");
    if (batched) lines.push("  int trajPoint = int(gl_FragCoord.x) / (u_trajAdvance > 0 ? " + stripStride + " : " + logStride + ");");
    lines.push("  " + bodyDeclarationsGLSL.split("\n").join("\n  "));
    lines.push("  if (!u_trajInit) {");
    generatePlaybackStateLoadGLSL(chunk.vars, "u_trajState", null, true, batched ? "trajPoint * " + stripStride : null)
      .forEach(function (l) { lines.push("    " + l); });
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
    generateStateStripStoreGLSL(chunk.vars, batched ? "int(gl_FragCoord.x) - trajPoint * " + stripStride : "int(gl_FragCoord.x)", "pbOut0")
      .forEach(function (l) { lines.push("    " + l); });
    lines.push("    return;");
    lines.push("  }");
    lines.push(batched ? "  int bodyIdx = int(gl_FragCoord.x) - trajPoint * " + logStride + ";" : "  int bodyIdx = int(gl_FragCoord.x);");
    lines.push("  vec3 outVal = vec3(0.0);");
    // Alpha carries BODYn_HALF: the grid's hover replay needs a resize-linked body's per-point size.
    lines.push("  float outHalf = 0.0;");
    var loNames = loOutputNames(chunk);
    loNames.forEach(function (name, k) { lines.push("  vec4 outLo" + (k + 1) + " = vec4(0.0);"); });
    for (var o = 0; o < n; o++) {
      var half = df ? "dfToFloat(BODY" + o + "_HALF)" : "BODY" + o + "_HALF";
      lines.push((o === 0 ? "  if" : "  else if") + " (bodyIdx == " + o + ") { outVal = vec3(" +
        readField(o, "x") + ", " + readField(o, "y") + ", " + readField(o, "angle") + "); outHalf = " + half + ";" +
        (loNames.length ? " " + loWordsGLSL(o, chunk) : "") + " }");
    }
    // The column past the last body is each row's sentinel, with the step's wrap and contact bits: see the runner.
    var wrapBits = [];
    for (var wb = 0; wb < n; wb++) {
      wrapBits.push("(g_wrapDx" + wb + " != 0.0 ? " + fnum(Math.pow(2, 2 * wb)) + " : 0.0) + (g_wrapDy" + wb + " != 0.0 ? " + fnum(Math.pow(2, 2 * wb + 1)) + " : 0.0)");
    }
    wrapBits.push("g_warpBits * " + fnum(Math.pow(2, TRAJECTORY_WARP_SHIFT)));
    lines.push("  if (bodyIdx == " + n + ") { outVal = vec3(gl_FragCoord.y + 0.5, TRAJECTORY_SENTINEL, " + wrapBits.join(" + ") + "); outHalf = g_pairContacts; }");
    lines.push("  pbOut0 = vec4(outVal, outHalf);");
    loNames.forEach(function (name, k) { lines.push("  " + name + " = outLo" + (k + 1) + ";"); });
    lines.push("}");
    return lines.join("\n");
  }

  // precision is a parameter (not always "f32") so the test suite can compile both ways.
  function compileSceneToTrajectoryGLSL(scene, maxSteps, precision, opts) {
    var frictionUniform = !!(opts && opts.frictionUniform);
    var df = global.PhysicsDF.isExtended(precision);
    if (df) global.PhysicsDF.usePrecision(precision);
    var dfnum = df ? global.PhysicsDF.num : null;
    if (scene.bodies.length > MAX_BODIES) {
      throw new Error("GPU physics supports at most " + MAX_BODIES + " bodies (scene has " + scene.bodies.length + ")");
    }
    var bodies = scene.bodies;
    var n = bodies.length;
    var consts = bodies.map(bodyConst);
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
    var chunk = trajectoryChunkInfo(n, consts, hingeAnchors, precision);
    lines.push("precision highp float;");
    lines.push(generateTrajectoryHeaderGLSL(chunk));
    lines.push("");
    lines.push(libraryGLSL(precision, global.PhysicsEngine.speedCapFor(scene), global.PhysicsEngine.frictionRate(scene), frictionUniform));
    lines.push("");
    // Nothing here depends on maxSteps, so different run lengths reuse the program.
    var springs = springLinksFor(scene, df ? dfnum : fnum);
    lines.push(generateStepOnceGLSL(n, consts, pairs, hingeAnchors, frame, precision, scene.mutualGravity, PhysicsEngine.collisionsEnabled(scene), springs,
      { pairContacts: true, warpBits: true, gravitySubsteps: PhysicsEngine.gravitySubstepsFor(scene) }));
    lines.push("");
    var locals = generateBodyLocalsGLSL(consts, precision) + "\n" + generateHingeAnchorLocalsGLSL(hingeAnchors, precision);
    lines.push(generateTrajectoryMainGLSL(n, locals, hingeAnchors, precision, chunk, springs));

    var compiled = { fragmentSource: pruneUnusedGLSL(lines.join("\n")), numBodies: n, precision: df ? precision : "f32", chunk: chunk };
    if (frictionUniform) compiled.uniforms = frictionUniforms(precision, global.PhysicsEngine.frictionOf(scene));
    return compiled;
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
    if (type === "BodyNoAngle") return [".x", ".y", ".vx", ".vy", ".w"];
    if (type === "DBodyNoAngle") return each([".x", ".y", ".vx", ".vy", ".w"]);
    if (type === "df") return each([""]);
    if (type === "DVec2") return each([".x", ".y"]);
    if (type === "vec2") return [".x", ".y"];
    if (type === "float" || type === "bool" || type === "int") return [""];
    return null;
  }
  // The GLSL type a local of each kind is declared with.
  var STATE_TYPE_GLSL = {
    Body: "Body", DBody: "DBody", BodyNoAngle: "Body", DBodyNoAngle: "DBody",
    float: "float", df: "MF", vec2: "vec2", DVec2: "DVec2", bool: "bool", int: "int",
  };
  // Four floats per texel, so one texture layer per four state floats.
  var STATE_FLOATS_PER_LAYER = 4;

  // Anchored bodies are left out (stepOnce() never writes one) unless named in
  // extraBodies (a reader with no starting state, like the playback color pass).
  // Bodies in angleFree carry no angle: nothing but their own spin reads it.
  function playbackStateVariables(result, extraBodies, angleFree) {
    var df = global.PhysicsDF.isExtended(result.precision);
    var extra = extraBodies || [];
    var vars = [];
    for (var i = 0; i < result.n; i++) {
      if (result.consts[i].isAnchored && extra.indexOf(i) === -1) continue;
      var noAngle = !!angleFree && angleFree.indexOf(i) !== -1;
      vars.push({ name: (df ? "dbody" : "body") + i, type: (df ? "DBody" : "Body") + (noAngle ? "NoAngle" : "") });
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
    return vars.map(function (v) {
      var decl = STATE_TYPE_GLSL[v.type] + " " + v.name + ";";
      if (v.type === "BodyNoAngle") return decl + " " + v.name + ".angle = 0.0;";
      if (v.type === "DBodyNoAngle") return decl + " " + v.name + ".angle = MF(0.0);";
      return decl;
    });
  }

  // Reads state from a sampler2DArray at a texel, or with `strip` from a sampler2D of texel (l, 0) = layer l,
  // shifted along the strip by stripStart when given.
  function generatePlaybackStateLoadGLSL(vars, samplerName, texelExpr, strip, stripStart) {
    var floats = stateFloats(vars);
    var lines = [];
    var layers = playbackStateLayerCount(vars);
    for (var l = 0; l < layers; l++) {
      var texel = strip ? "ivec2(" + (stripStart ? stripStart + " + " : "") + l + ", 0)" : "ivec3(" + texelExpr + ", " + l + ")";
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

  // Strip store. Flat ifs, not else-if: a qf scene has dozens of layers.
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

  // ---- Dead-definition pruning ----
  // Every program is assembled from whole libraries, so most of a small scene's
  // source is functions, structs and constants nothing reaches. Drops each
  // top-level definition main() never names, transitively, with the comment block
  // above it. Lines it does not recognize (#version, uniforms, outputs) stay.
  function pruneUnusedGLSL(source) {
    var lines = source.split("\n");
    var defs = [], kept = {}, i = 0, comment = -1;
    function define(name, first, last) { defs.push({ name: name, first: first, start: i, last: last }); i = last + 1; comment = -1; }
    while (i < lines.length) {
      var line = lines[i], m;
      if (line === "") { comment = -1; i++; continue; }
      if (line.indexOf("//") === 0) { if (comment === -1) comment = i; i++; continue; }
      var first = comment === -1 ? i : comment;
      if (/^(#|precision |uniform |layout\(|in |out )/.test(line)) {
        for (var k = first; k <= i; k++) kept[k] = true;
        i++; comment = -1; continue;
      }
      if ((m = /^struct\s+(\w+)/.exec(line))) {
        var s = i;
        while (!/\};\s*$/.test(lines[s])) s++;
        define(m[1], first, s); continue;
      }
      if ((m = /^const\s+\w+\s+(\w+)\s*=/.exec(line))) { define(m[1], first, i); continue; }
      if ((m = /^\w+\s+(\w+)\s*\(/.exec(line))) {
        var end = i;
        if (!(line.indexOf("{") !== -1 && /\}\s*$/.test(line))) {
          while (!/\{\s*$/.test(lines[end])) end++;
          end++;
          while (lines[end] !== "}") end++;
        }
        define(m[1], first, end); continue;
      }
      if ((m = /^\w+\s+(\w+)\s*(=[^;]*)?;\s*$/.exec(line))) { define(m[1], first, i); continue; }
      for (var h = first; h <= i; h++) kept[h] = true;
      i++; comment = -1;
    }
    var byName = {};
    defs.forEach(function (d) { byName[d.name] = d; });
    function namesIn(text) {
      var out = {}, re = /[A-Za-z_]\w*/g, hit;
      text = text.replace(/\/\/.*$/gm, "");
      while ((hit = re.exec(text))) out[hit[0]] = true;
      return out;
    }
    var live = {}, queue = [];
    function reach(name) {
      if (!byName[name] || live[name]) return;
      live[name] = true;
      queue.push(byName[name]);
    }
    var header = [];
    Object.keys(kept).forEach(function (k) { header.push(lines[k]); });
    Object.keys(namesIn(header.join("\n"))).forEach(reach);
    reach("main");
    while (queue.length) {
      var d = queue.shift();
      Object.keys(namesIn(lines.slice(d.start, d.last + 1).join("\n"))).forEach(reach);
    }
    defs.forEach(function (d) {
      if (!live[d.name]) return;
      for (var k = d.first; k <= d.last; k++) kept[k] = true;
    });
    var out = [], blank = false;
    lines.forEach(function (line, idx) {
      if (kept[idx]) { out.push(line); blank = false; }
      else if (line === "" && !blank) { out.push(line); blank = true; }
    });
    return out.join("\n");
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

  // Most log texels one batched run holds (each texture: the log and its lower-word twins).
  var TRAJECTORY_BATCH_TEXELS = 2097152;
  var TRAJECTORY_BATCH_MAX = 128;

  // Runs a compiled { fragmentSource, numBodies, chunk, uniforms? } and reads back
  // the trajectory. `uniforms` is { name: [floats] } (the hover replay's world point).
  function runCompiledTrajectoryOnGPU(compiled, maxSteps) {
    return runCompiledTrajectoriesOnGPU(compiled, maxSteps)[0];
  }

  // As above, one trajectory per start point when compiled is batched ({ pointCount, points }: a P x 2
  // RGBA32F texture of x words then y words, see compileHoverBatchGLSL). Runs side by side cost about
  // one: a run is a sequence of steps, so a few columns leave the GPU idle. Too many for one texture split up.
  function runCompiledTrajectoriesOnGPU(compiled, maxSteps) {
    var numBodies = compiled.numBodies;
    var count = compiled.pointCount || 1;
    if (numBodies === 0) return new Array(count).fill([]);
    var runner = getTrajectoryRunner();
    var gl = runner.gl;
    var maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    var textures = 1 + (compiled.chunk.loOutputs || 0);
    var perBatch = Math.max(1, Math.min(TRAJECTORY_BATCH_MAX,
      Math.floor(maxTexture / (numBodies + 1)), Math.floor(maxTexture / (compiled.chunk.layers + 1)),
      Math.floor(TRAJECTORY_BATCH_TEXELS / textures / ((numBodies + 1) * maxSteps))));
    if (!compiled.pointCount || count <= perBatch) return runTrajectoryBatch(compiled, maxSteps, count);
    var out = [];
    for (var first = 0; first < count; first += perBatch) {
      var n = Math.min(perBatch, count - first);
      var part = Object.assign({}, compiled, { pointCount: n, points: pointsSlice(compiled.points, count, first, n) });
      out = out.concat(runTrajectoryBatch(part, maxSteps, n));
    }
    return out;
  }
  // Points first..first+n of a P x 2 points texture's data.
  function pointsSlice(points, count, first, n) {
    var out = new Float32Array(n * 8);
    out.set(points.subarray(first * 4, (first + n) * 4), 0);
    out.set(points.subarray((count + first) * 4, (count + first + n) * 4), n * 4);
    return out;
  }

  function runTrajectoryBatch(compiled, maxSteps, count) {
    var numBodies = compiled.numBodies;
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
      points: gl.getUniformLocation(prog, "u_hoverPoints"),
    };

    gl.bindBuffer(gl.ARRAY_BUFFER, runner.quadBuffer);
    gl.enableVertexAttribArray(entry.posLoc);
    gl.vertexAttribPointer(entry.posLoc, 2, gl.FLOAT, false, 0, 0);

    function floatTexture(w, h, data) {
      var t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, data || null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    }
    var pointsTexture = null;
    if (compiled.pointCount) {
      gl.activeTexture(gl.TEXTURE1);
      pointsTexture = floatTexture(count, 2, compiled.points);
      gl.uniform1i(u.points, 1);
      gl.activeTexture(gl.TEXTURE0);
    }
    // The log: a column wider than the bodies for each row's sentinel, per run...
    var runWidth = numBodies + 1;
    var logWidth = runWidth * count;
    var texture = floatTexture(logWidth, maxSteps);
    var loTextures = [];
    for (var lo = 0; lo < (chunk.loOutputs || 0); lo++) loTextures.push(floatTexture(logWidth, maxSteps));
    // ...and two state strips, swapped each chunk, a texel longer per run for the same reason.
    var runStrip = chunk.layers + 1;
    var stripWidth = runStrip * count;
    var states = [floatTexture(stripWidth, 1), floatTexture(stripWidth, 1)];
    var logFbo = runner.fbo, stateFbo = gl.createFramebuffer();
    var sentinels = new Float32Array(stripWidth * 4);
    var failure = null;

    var drawBuffers = [gl.COLOR_ATTACHMENT0];
    loTextures.forEach(function (_, k) { drawBuffers.push(gl.COLOR_ATTACHMENT0 + 1 + k); });
    function release() {
      gl.bindFramebuffer(gl.FRAMEBUFFER, logFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, null, 0);
      loTextures.forEach(function (t, k) { gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + 1 + k, gl.TEXTURE_2D, null, 0); });
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(stateFbo);
      gl.deleteTexture(states[0]);
      gl.deleteTexture(states[1]);
      gl.deleteTexture(texture);
      loTextures.forEach(function (t) { gl.deleteTexture(t); });
      if (pointsTexture) gl.deleteTexture(pointsTexture);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, logFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    loTextures.forEach(function (t, k) { gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + 1 + k, gl.TEXTURE_2D, t, 0); });
    var status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      release();
      throw new Error("GPU physics framebuffer incomplete (status " + status + ")");
    }
    gl.drawBuffers(drawBuffers);
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
      gl.readPixels(numBodies, 0, 1, 1, gl.RGBA, gl.FLOAT, sentinels);
      entry.warmed = true;
    }

    // Each chunk is timed and the next sized from it (TRAJECTORY_TARGET_MS); the time
    // includes the readback, erring safe. Growth caps at doubling; the size is kept with the program,
    // scaled down for a batch wider than the one it was measured on.
    var steps = Math.max(1, Math.floor((entry.chunkSteps || 1) * Math.min(1, (entry.chunkRuns || 1) / count)));
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
        gl.readPixels(0, 0, stripWidth, 1, gl.RGBA, gl.FLOAT, sentinels);
        for (var r = 0; r < count && !failure; r++) {
          var s = (r * runStrip + chunk.layers) * 4;
          if (sentinels[s] !== base + rows || sentinels[s + 1] !== TRAJECTORY_SENTINEL) {
            failure = "the state after step " + (base + rows) + " was never written";
          }
        }
        var perStep = (performance.now() - startedAt) / (2 * rows);
        steps = Math.max(1, Math.min(Math.floor(TRAJECTORY_TARGET_MS / perStep), rows * 2, chunk.maxSteps));
        current = 1 - current;
      }
      base += rows;
    }
    entry.chunkSteps = steps;
    entry.chunkRuns = count;

    var pixels = new Float32Array(logWidth * maxSteps * 4);
    var loPixels = loTextures.map(function () { return new Float32Array(logWidth * maxSteps * 4); });
    if (!failure) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, logFbo);
      gl.readPixels(0, 0, logWidth, maxSteps, gl.RGBA, gl.FLOAT, pixels);
      loPixels.forEach(function (buf, k) {
        gl.readBuffer(gl.COLOR_ATTACHMENT0 + 1 + k);
        gl.readPixels(0, 0, logWidth, maxSteps, gl.RGBA, gl.FLOAT, buf);
      });
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
    }
    // The readback already waited for the GPU, so the error flag is free.
    var glError = gl.getError();

    var trajectories = [];
    for (var run = 0; run < count && !failure; run++) {
      var first = run * runWidth;
      var trajectory = new Array(maxSteps);
      for (var step = 0; step < maxSteps && !failure; step++) {
        var row = new Array(numBodies);
        var mark = (step * logWidth + first + numBodies) * 4, wrapBits = pixels[mark + 2] | 0, pairBits = pixels[mark + 3] | 0;
        for (var b = 0; b < numBodies; b++) {
          var idx = (step * logWidth + first + b) * 4;
          row[b] = {
            x: pixels[idx], y: pixels[idx + 1], angle: pixels[idx + 2], half: pixels[idx + 3],
            wrapX: !!(wrapBits & (1 << (2 * b))), wrapY: !!(wrapBits & (2 << (2 * b))),
            warped: !!(wrapBits & (1 << (TRAJECTORY_WARP_SHIFT + b))), contacts: 0,
          };
          if (loPixels.length) {
            // xLo/yLo: the position's lower words (loWordsGLSL's packing), so x + sum(xLo) is the full value.
            var xLo = [], yLo = [];
            for (var w = 1; w < chunk.words; w++) {
              var at = idx + ((w - 1) % 2) * 2, buf = loPixels[(w - 1) >> 1];
              xLo.push(buf[at]);
              yLo.push(buf[at + 1]);
            }
            row[b].xLo = xLo;
            row[b].yLo = yLo;
          }
        }
        // contacts: bit j set when the body touched body j in this step.
        for (var ci = 0; pairBits && ci < numBodies; ci++) {
          for (var cj = ci + 1; cj < numBodies; cj++) {
            if (!(pairBits & (1 << pairContactBit(ci, cj, numBodies)))) continue;
            row[ci].contacts |= 1 << cj;
            row[cj].contacts |= 1 << ci;
          }
        }
        trajectory[step] = row;
        if (pixels[mark] !== step + 1 || pixels[mark + 1] !== TRAJECTORY_SENTINEL) failure = "step " + (step + 1) + " was never written";
      }
      trajectories.push(trajectory);
    }

    release();
    if (glError !== gl.NO_ERROR) throw new Error("GPU physics draw failed (GL error 0x" + glError.toString(16) + ")");
    // A dropped draw reports no error: only the sentinel notices. Chunk size forgotten so the retry starts over.
    if (failure) {
      entry.chunkSteps = 1;
      throw new Error("The GPU dropped a physics draw (" + failure + "): the scene is too heavy for it at this precision.");
    }
    return trajectories;
  }

  function runSceneOnGPU(scene, maxSteps, precision) {
    return runCompiledTrajectoryOnGPU(compileSceneToTrajectoryGLSL(scene, maxSteps, precision), maxSteps);
  }

  global.PhysicsGPU = {
    MAX_BODIES: MAX_BODIES,
    runSceneOnGPU: runSceneOnGPU,
    runCompiledTrajectoryOnGPU: runCompiledTrajectoryOnGPU,
    runCompiledTrajectoriesOnGPU: runCompiledTrajectoriesOnGPU,
    generateTrajectoryMainGLSL: generateTrajectoryMainGLSL,
    generateTrajectoryHeaderGLSL: generateTrajectoryHeaderGLSL,
    trajectoryChunkInfo: trajectoryChunkInfo,
    compileSceneToTrajectoryGLSL: compileSceneToTrajectoryGLSL,
    // Exposed so the per-pixel fractal grid reuses the same physics and step logic.
    GLSL_LIBRARY: GLSL_LIBRARY,
    libraryGLSL: libraryGLSL,
    frictionUniforms: frictionUniforms,
    VERTEX_SOURCE: VERTEX_SOURCE,
    fnum: fnum,
    bodyConst: bodyConst,
    shapeHalf: shapeHalf,
    collisionPairs: collisionPairs,
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
    pruneUnusedGLSL: pruneUnusedGLSL,
    compileShader: compileShader,
    linkProgram: linkProgram,
    FIXED_DT: FIXED_DT,
  };
})(window);
