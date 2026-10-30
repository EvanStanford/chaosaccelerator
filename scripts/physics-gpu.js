// CPAL-1.0 License. See chaosaccelerator.com/license.html

// Compiles a scene into a specialized GLSL program (every pair and hinge
// unrolled, since the scene is fixed when Play is clicked), runs it on an
// offscreen WebGL2 context and logs every body's (x, y, angle) per step.
(function (global) {
  "use strict";

  var MAX_BODIES = 6;

  var LINE_THICKNESS = global.PhysicsEngine.LINE_THICKNESS;
  var PORTAL_THICKNESS = global.PhysicsEngine.PORTAL_THICKNESS;
  var LINE_PARALLEL_EPS = 0.05;
  var RESTITUTION_THRESHOLD = 30;
  var VELOCITY_ITERATIONS = 8;
  var POSITION_ITERATIONS = 4;
  var POSITION_SLOP = 0.01;
  var POSITION_PERCENT = 0.2;
  var LINE_END_SHARE = 0.99;
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
      // PhysicsEngine.segmentField: the pull per unit mass at p from a segment (center c, axis e, half length h, G*mass/length k).
      "vec2 segmentField(vec2 p, vec2 c, vec2 e, float h, float k, float eps) {",
      "  vec2 r = p - c;",
      "  float along = dot(r, e), d = r.y * e.x - r.x * e.y, u1 = -h - along, u2 = h - along, d2 = d * d, soft = d2;",
      "  if (d2 < eps * eps) {",
      "    float over = clamp(1.0 - (abs(along) - h) / eps, 0.0, 1.0);",
      "    soft = d2 + over * (eps * eps * 0.5 + d2 * d2 / (2.0 * eps * eps) - d2);",
      "  }",
      "  float r1 = sqrt(u1 * u1 + soft), r2 = sqrt(u2 * u2 + soft), du = u2 * u2 - u1 * u1;",
      "  float fa = k * du / (r1 * r2 * (r1 + r2));",
      "  float fd = u1 * u2 > 0.0 ? k * d * du / (r1 * r2 * (u2 * r1 + u1 * r2)) : k * d * (u2 / r2 - u1 / r1) / soft;",
      "  return vec2(fa * e.x + fd * e.y, fa * e.y - fd * e.x);",
      "}",
      "float pointSegmentDistance(vec2 p, vec2 c, vec2 e, float h) {",
      "  vec2 r = p - c;",
      "  return length(r - e * clamp(dot(r, e), -h, h));",
      "}",
      // PhysicsEngine.segmentsDistance: 0 where they cross, else the nearest end to the other segment.
      "float segmentsDistance(vec2 ca, vec2 ea, float ha, vec2 cb, vec2 eb, float hb) {",
      "  vec2 a0 = ca - ea * ha, a1 = ca + ea * ha, b0 = cb - eb * hb, b1 = cb + eb * hb;",
      "  float s0 = (a1.x - a0.x) * (b0.y - a0.y) - (a1.y - a0.y) * (b0.x - a0.x), s1 = (a1.x - a0.x) * (b1.y - a0.y) - (a1.y - a0.y) * (b1.x - a0.x);",
      "  float t0 = (b1.x - b0.x) * (a0.y - b0.y) - (b1.y - b0.y) * (a0.x - b0.x), t1 = (b1.x - b0.x) * (a1.y - b0.y) - (b1.y - b0.y) * (a1.x - b0.x);",
      "  if (s0 * s1 < 0.0 && t0 * t1 < 0.0) return 0.0;",
      "  return min(min(pointSegmentDistance(a0, cb, eb, hb), pointSegmentDistance(a1, cb, eb, hb)),",
      "    min(pointSegmentDistance(b0, ca, ea, ha), pointSegmentDistance(b1, ca, ea, ha)));",
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
    "const float PORTAL_THICKNESS = " + fnum(PORTAL_THICKNESS) + ";",
    "const float LINE_PARALLEL_EPS = " + fnum(LINE_PARALLEL_EPS) + ";",
    "const float LINE_END_SHARE = " + fnum(LINE_END_SHARE) + ";",
    "const float RESTITUTION_THRESHOLD = " + fnum(RESTITUTION_THRESHOLD) + ";",
    "const float POSITION_SLOP = " + fnum(POSITION_SLOP) + ";",
    "const float POSITION_PERCENT = " + fnum(POSITION_PERCENT) + ";",
    "const float DT = " + fnum(FIXED_DT) + ";",
    "const float GRAVITY = " + fnum(global.PhysicsEngine.GRAVITY) + ";",
    "",
    // tHit 0.0 = touching at the step's start; a swept test sets the instant of a later touch.
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
    "// point traveling from p at constant velocity v first reaches distance",
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
    "// ---- Swept line contacts (PhysicsEngine's): f is the fraction of the step, a line's ends run their chords ----",
    "bool sweptReachMeets(vec2 d, vec2 m, float reach) {",
    "  float r2 = reach * reach;",
    "  if (dot(d, d) <= r2) return true;",
    "  float dm = dot(d, m);",
    "  if (dm >= 0.0) return false;",
    "  float mm = dot(m, m);",
    "  if (-dm >= mm) { vec2 e = d + m; return dot(e, e) <= r2; }",
    "  float cr = d.x * m.y - d.y * m.x;",
    "  return cr * cr <= r2 * mm;",
    "}",
    "// PhysicsEngine.linesMayTouch.",
    "bool linesMayTouch(vec2 a0, vec2 a1, vec2 b0, vec2 b1, float travel) {",
    "  ClosestPair cp = closestPointsSegmentSegment(a0, a1, b0, b1);",
    "  vec2 d = cp.c2 - cp.c1;",
    "  float room = 2.0 * LINE_THICKNESS + travel;",
    "  return dot(d, d) <= room * room;",
    "}",
    "// Smallest root in [0, 1] of a f^2 + b f + c with c > 0, or -1.",
    "float firstRoot(float a, float b, float c) {",
    "  float f;",
    "  if (a == 0.0) {",
    "    if (b >= 0.0) return -1.0;",
    "    f = -c / b;",
    "  } else {",
    "    float disc = b * b - 4.0 * a * c;",
    "    if (disc < 0.0) return -1.0;",
    "    float q = -0.5 * (b < 0.0 ? b - sqrt(disc) : b + sqrt(disc));",
    "    if (q == 0.0) return -1.0;",
    "    float r1 = q / a, r2 = c / q;",
    "    f = min(r1, r2);",
    "    if (f < 0.0) f = max(r1, r2);",
    "  }",
    "  return f >= 0.0 && f <= 1.0 ? f : -1.0;",
    "}",
    "float sweepPointMovingSlab(vec2 p, vec2 dp, vec2 q0, vec2 dq0, vec2 q1, vec2 dq1, float len, float R) {",
    "  vec2 D = q1 - q0, mD = dq1 - dq0, P = p - q0, mP = dp - dq0;",
    "  float c0 = D.x * P.y - D.y * P.x;",
    "  float side = c0 < 0.0 ? -1.0 : 1.0;",
    "  float c = side * c0 - R * len;",
    "  if (c <= 0.0) return -1.0;",
    "  float f = firstRoot(side * (mD.x * mP.y - mD.y * mP.x), side * (D.x * mP.y - D.y * mP.x + mD.x * P.y - mD.y * P.x), c);",
    "  if (f < 0.0) return -1.0;",
    "  vec2 Df = D + mD * f;",
    "  float s = dot(P + mP * f, Df);",
    "  return s >= 0.0 && s <= dot(Df, Df) ? f : -1.0;",
    "}",
    "// How far a line's half vector h turns over the step, at its spin.",
    "vec2 lineTurn(Body line, float halfLen, vec2 h) {",
    "  if (line.w == 0.0) return vec2(0.0);",
    "  float a = line.angle + line.w * DT;",
    "  return vec2(cos(a), sin(a)) * halfLen - h;",
    "}",
    "struct LineSweep { vec2 e0; vec2 d0; vec2 e1; vec2 d1; };",
    "LineSweep lineSweep(vec2 c, vec2 h, vec2 m, vec2 t) {",
    "  LineSweep s;",
    "  s.e0 = c - h; s.e1 = c + h; s.d0 = m - t; s.d1 = m + t;",
    "  return s;",
    "}",
    "// .f < 0.0: no touch. While searching, p and u are the touching point and the way to the other",
    "// surface, own 1.0 for A's point and -1.0 for B's; then normal (A -> B) and point (midway).",
    "struct SweptHit { float f; vec2 p; vec2 u; float own; vec2 normal; vec2 point; };",
    "// An end p onto the other's flat side.",
    "void sweptSlabHit(vec2 p, vec2 dp, LineSweep s, float len, float own, inout SweptHit best) {",
    "  float f = sweepPointMovingSlab(p, dp, s.e0, s.d0, s.e1, s.d1, len, LINE_THICKNESS);",
    "  if (f <= 0.0 || (best.f >= 0.0 && f >= best.f)) return;",
    "  vec2 q0 = s.e0 + s.d0 * f, q1 = s.e1 + s.d1 * f, pf = p + dp * f, D = q1 - q0;",
    "  float k = D.x * (pf.y - q0.y) - D.y * (pf.x - q0.x) < 0.0 ? 1.0 : -1.0;",
    "  best.f = f; best.p = pf; best.u = vec2(-D.y, D.x) * k; best.own = own;",
    "}",
    "void sweptCapHit(vec2 a, vec2 da, vec2 b, vec2 db, inout SweptHit best) {",
    "  float f = sweepPointSphere(a, da - db, b, LINE_THICKNESS, 1.0);",
    "  if (f <= 0.0 || (best.f >= 0.0 && f >= best.f)) return;",
    "  vec2 af = a + da * f;",
    "  best.f = f; best.p = af; best.u = b + db * f - af; best.own = 1.0;",
    "}",
    "SweptHit lineLineFirstTouch(LineSweep a, float lenA, LineSweep b, float lenB) {",
    "  SweptHit best;",
    "  best.f = -1.0; best.p = vec2(0.0); best.u = vec2(0.0); best.own = 1.0; best.normal = vec2(0.0); best.point = vec2(0.0);",
    "  sweptSlabHit(a.e0, a.d0, b, lenB, 1.0, best);",
    "  sweptSlabHit(a.e1, a.d1, b, lenB, 1.0, best);",
    "  sweptSlabHit(b.e0, b.d0, a, lenA, -1.0, best);",
    "  sweptSlabHit(b.e1, b.d1, a, lenA, -1.0, best);",
    "  sweptCapHit(a.e0, a.d0, b.e0, b.d0, best);",
    "  sweptCapHit(a.e0, a.d0, b.e1, b.d1, best);",
    "  sweptCapHit(a.e1, a.d1, b.e0, b.d0, best);",
    "  sweptCapHit(a.e1, a.d1, b.e1, b.d1, best);",
    "  float ul = length(best.u);",
    "  vec2 n = best.u / (ul > 0.0 ? ul : 1.0);",
    "  best.normal = n * best.own;",
    "  best.point = best.p + n * (LINE_THICKNESS * 0.5);",
    "  return best;",
    "}",
    "// PhysicsEngine.crossedSegments; .penetration is the depth alone, rA/rB are the caller's.",
    "Contact crossedSegments(vec2 a0, vec2 a1, vec2 b0, vec2 b1, vec2 back) {",
    "  Contact c = noContact();",
    "  vec2 u = a1 - a0, v = b1 - b0;",
    "  float ul = length(u), vl = length(v);",
    "  u /= ul > 0.0 ? ul : 1.0;",
    "  v /= vl > 0.0 ? vl : 1.0;",
    "  float sa0 = v.x * (a0.y - b0.y) - v.y * (a0.x - b0.x), sa1 = v.x * (a1.y - b0.y) - v.y * (a1.x - b0.x);",
    "  float sb0 = u.x * (b0.y - a0.y) - u.y * (b0.x - a0.x), sb1 = u.x * (b1.y - a0.y) - u.y * (b1.x - a0.x);",
    "  if (!(sa0 * sa1 < 0.0 && sb0 * sb1 < 0.0)) return c;",
    "  bool upA = (sb0 + sb1) * 0.5 - (u.x * back.y - u.y * back.x) > 0.0;",
    "  bool upB = (sa0 + sa1) * 0.5 + (v.x * back.y - v.y * back.x) > 0.0;",
    "  float depthA = upA ? -min(sb0, sb1) : max(sb0, sb1), depthB = upB ? -min(sa0, sa1) : max(sa0, sa1);",
    "  vec2 sideA = upA ? vec2(-u.y, u.x) : vec2(u.y, -u.x);",
    "  vec2 n = depthA <= depthB ? sideA : (upB ? vec2(v.y, -v.x) : vec2(-v.y, v.x));",
    "  c.hit = true;",
    "  c.normal = n;",
    "  c.point = a0 + (a1 - a0) * (sa0 / (sa0 - sa1)) + n * (LINE_THICKNESS * 0.5);",
    "  c.penetration = min(depthA, depthB);",
    "  return c;",
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
    "// PhysicsEngine.overlapEnds' end at A's span t: A's own end (A-end 0 or 1) on B's flat side, else B's end",
    "// bi on A's. normal is that side's (A -> B), gap its own, end 0-3 (A's two, B's two), s its foot's fraction.",
    "struct OverlapEnd { vec2 point; vec2 normal; float gap; int end; float s; };",
    "OverlapEnd overlapEnd(vec2 a0, vec2 u, float lenA, vec2 b0, vec2 b1, vec2 v, float lenB, vec2 nA, vec2 nB, float t, bool ownA, int bi) {",
    "  OverlapEnd e;",
    "  if (ownA) {",
    "    vec2 p = a0 + u * t;",
    "    e.gap = dot(b0 - p, nB);",
    "    e.point = p + nB * (e.gap * 0.5);",
    "    e.normal = nB;",
    "    e.end = t > 0.0 ? 1 : 0;",
    "    e.s = dot(p - b0, v) / lenB;",
    "  } else {",
    "    vec2 q = bi == 1 ? b1 : b0;",
    "    e.gap = dot(q - a0, nA);",
    "    e.point = q - nA * (e.gap * 0.5);",
    "    e.normal = nA;",
    "    e.end = bi + 2;",
    "    e.s = t / lenA;",
    "  }",
    "  return e;",
    "}",
    "struct Overlap { bool ok; bool two; OverlapEnd e0; OverlapEnd e1; };",
    "// PhysicsEngine.overlapEnds: sgn is the side of A that B is on.",
    "Overlap overlapEnds(vec2 a0, vec2 a1, vec2 b0, vec2 b1, float sgn) {",
    "  Overlap o;",
    "  vec2 u = a1 - a0, v = b1 - b0;",
    "  float lenA = length(u), lenB = length(v);",
    "  if (lenA == 0.0) lenA = 1.0;",
    "  if (lenB == 0.0) lenB = 1.0;",
    "  u /= lenA;",
    "  v /= lenB;",
    "  float t0 = dot(b0 - a0, u), t1 = dot(b1 - a0, u);",
    "  float lo = max(0.0, min(t0, t1)), hi = min(lenA, max(t0, t1));",
    "  o.ok = hi > lo;",
    "  o.two = hi - lo > 1e-6;",
    "  vec2 nA = vec2(-u.y, u.x) * sgn, nB = vec2(-v.y, v.x) * (dot(u, v) < 0.0 ? -sgn : sgn);",
    "  o.e0 = overlapEnd(a0, u, lenA, b0, b1, v, lenB, nA, nB, lo, min(t0, t1) <= 0.0, t0 <= t1 ? 0 : 1);",
    "  o.e1 = overlapEnd(a0, u, lenA, b0, b1, v, lenB, nA, nB, hi, max(t0, t1) >= lenA, t0 >= t1 ? 0 : 1);",
    "  return o;",
    "}",
    "// PhysicsEngine.endClosing: how far an overlap end closes on the other line over the whole step.",
    "float endClosing(OverlapEnd e, LineSweep a, LineSweep b) {",
    "  vec2 own = e.end == 0 ? a.d0 : (e.end == 1 ? a.d1 : (e.end == 2 ? b.d0 : b.d1));",
    "  vec2 s0 = e.end < 2 ? b.d0 : a.d0, s1 = e.end < 2 ? b.d1 : a.d1;",
    "  return (e.end < 2 ? 1.0 : -1.0) * dot(own - s0 - (s1 - s0) * e.s, e.normal);",
    "}",
    "Contact endContact(OverlapEnd e, vec2 cA, vec2 cB, float penetration, float tHit) {",
    "  Contact c = noContact();",
    "  c.hit = true; c.normal = e.normal; c.point = e.point; c.rA = e.point - cA; c.rB = e.point - cB;",
    "  c.penetration = penetration; c.tHit = tHit;",
    "  return c;",
    "}",
    "// PhysicsEngine.lineLineContacts' choice: within slop, or closing slowly within the step.",
    "bool keepEnd(OverlapEnd e, LineSweep a, LineSweep b) {",
    "  float gap = e.gap - LINE_THICKNESS;",
    "  if (gap <= POSITION_SLOP) return true;",
    "  float closing = endClosing(e, a, b);",
    "  return gap < closing && closing < RESTITUTION_THRESHOLD * DT;",
    "}",
    "// PhysicsEngine.closesFast.",
    "bool closesFast(Contact c, Body a, Body b) {",
    "  vec2 v = vec2(b.vx - b.w * c.rB.y, b.vy + b.w * c.rB.x) - vec2(a.vx - a.w * c.rA.y, a.vy + a.w * c.rA.x);",
    "  return -dot(v, c.normal) >= RESTITUTION_THRESHOLD;",
    "}",
    "",
    "// Touching at the step's start (tHit 0): crossed, or each end of a near-parallel overlap that touches or",
    "// closes slowly (PhysicsEngine.lineLineContacts), else the closest points.",
    "ContactPair lineLineContacts(Body lineA, vec2 eA0, vec2 eA1, Body lineB, vec2 eB0, vec2 eB1, LineSweep sA, LineSweep sB) {",
    "  ContactPair result;",
    "  result.c0 = noContact();",
    "  result.c1 = noContact();",
    "  vec2 cA = vec2(lineA.x, lineA.y), cB = vec2(lineB.x, lineB.y);",
    "  Contact cr = crossedSegments(eA0, eA1, eB0, eB1, (vec2(lineB.vx, lineB.vy) - vec2(lineA.vx, lineA.vy)) * DT);",
    "  if (cr.hit) {",
    "    result.c0 = cr;",
    "    result.c0.rA = cr.point - cA;",
    "    result.c0.rB = cr.point - cB;",
    "    result.c0.penetration = cr.penetration + LINE_THICKNESS;",
    "    return result;",
    "  }",
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
    "  ClosestPair cp = closestPointsSegmentSegment(eA0, eA1, eB0, eB1);",
    "  vec2 d2 = cp.c2 - cp.c1;",
    "  float dist2 = length(d2);",
    "  if (dist2 >= LINE_THICKNESS) return result;",
    "",
    "  if (abs(crossVal) < LINE_PARALLEL_EPS) {",
    "    Overlap ov = overlapEnds(eA0, eA1, eB0, eB1, dot(d2, vec2(-dirA.y, dirA.x)) >= 0.0 ? 1.0 : -1.0);",
    "    bool k0 = ov.ok && keepEnd(ov.e0, sA, sB), k1 = ov.ok && ov.two && keepEnd(ov.e1, sA, sB);",
    "    if (k0) result.c0 = endContact(ov.e0, cA, cB, LINE_THICKNESS - ov.e0.gap, 0.0);",
    "    if (k1) {",
    "      Contact c1 = endContact(ov.e1, cA, cB, LINE_THICKNESS - ov.e1.gap, 0.0);",
    "      if (k0) result.c1 = c1;",
    "      else result.c0 = c1;",
    "    }",
    "    if (k0 || k1) return result;",
    "  }",
    "",
    "  vec2 n2 = dist2 > 1e-9 ? d2 / dist2 : vec2(0.0, 1.0);",
    "  vec2 pt2 = (cp.c1 + cp.c2) * 0.5;",
    "  result.c0.hit = true;",
    "  result.c0.normal = n2;",
    "  result.c0.point = pt2;",
    "  result.c0.rA = pt2 - cA;",
    "  result.c0.rB = pt2 - cB;",
    "  result.c0.penetration = LINE_THICKNESS - dist2;",
    "  result.c0.tHit = 0.0;",
    "  return result;",
    "}",
    "",
    "// PhysicsEngine.collideLineLine: the overlap at the start and the first touch within the step",
    "// anywhere else, at most two contacts. Bounding circles that never meet skip all of it.",
    "ContactPair collideLineLine(Body lineA, float halfLenA, Body lineB, float halfLenB) {",
    "  ContactPair result;",
    "  result.c0 = noContact();",
    "  result.c1 = noContact();",
    "  vec2 cA = vec2(lineA.x, lineA.y), cB = vec2(lineB.x, lineB.y), vA = vec2(lineA.vx, lineA.vy), vB = vec2(lineB.vx, lineB.vy);",
    "  vec2 mRel = (vB - vA) * DT;",
    "  if (!sweptReachMeets(cB - cA, mRel, halfLenA + halfLenB + LINE_THICKNESS)) return result;",
    "  vec2 hA = vec2(cos(lineA.angle), sin(lineA.angle)) * halfLenA, hB = vec2(cos(lineB.angle), sin(lineB.angle)) * halfLenB;",
    "  float travel = length(mRel) + (abs(lineA.w) * halfLenA + abs(lineB.w) * halfLenB) * DT;",
    "  if (!linesMayTouch(cA - hA, cA + hA, cB - hB, cB + hB, travel)) return result;",
    "  LineSweep sA = lineSweep(cA, hA, vA * DT, lineTurn(lineA, halfLenA, hA));",
    "  LineSweep sB = lineSweep(cB, hB, vB * DT, lineTurn(lineB, halfLenB, hB));",
    "  result = lineLineContacts(lineA, cA - hA, cA + hA, lineB, cB - hB, cB + hB, sA, sB);",
    "  if (result.c1.hit || result.c0.penetration > LINE_THICKNESS) return result;",
    "  SweptHit hit = lineLineFirstTouch(sA, 2.0 * halfLenA, sB, 2.0 * halfLenB);",
    "  if (hit.f < 0.0) return result;",
    "  float tHit = hit.f * DT;",
    "  vec2 pA = cA + vA * tHit, pB = cB + vB * tHit;",
    "  Contact c = noContact();",
    "  c.hit = true; c.normal = hit.normal; c.point = hit.point; c.rA = hit.point - pA; c.rB = hit.point - pB; c.tHit = tHit;",
    "  if (result.c0.hit) {",
    "    // A slow later touch waits; a fast one goes alone unless the one touching closes fast too.",
    "    if (!closesFast(c, lineA, lineB)) return result;",
    "    if (closesFast(result.c0, lineA, lineB)) result.c1 = c;",
    "    else result.c0 = c;",
    "    return result;",
    "  }",
    "  result.c0 = c;",
    "  // Near-parallel then: the nearer end of the overlap, and the other if it closes within the step.",
    "  vec2 a0 = sA.e0 + sA.d0 * hit.f, a1 = sA.e1 + sA.d1 * hit.f, b0 = sB.e0 + sB.d0 * hit.f, b1 = sB.e1 + sB.d1 * hit.f;",
    "  vec2 dirA = a1 - a0, dirB = b1 - b0;",
    "  float lenA = length(dirA), lenB = length(dirB);",
    "  if (lenA == 0.0) lenA = 1.0;",
    "  if (lenB == 0.0) lenB = 1.0;",
    "  if (abs((dirA.x * dirB.y - dirA.y * dirB.x) / (lenA * lenB)) >= LINE_PARALLEL_EPS) return result;",
    "  Overlap ov = overlapEnds(a0, a1, b0, b1, dirA.x * hit.normal.y - dirA.y * hit.normal.x < 0.0 ? -1.0 : 1.0);",
    "  if (!ov.ok) return result;",
    "  OverlapEnd first = ov.e0, other = ov.e1;",
    "  if (ov.two && ov.e1.gap < ov.e0.gap) { first = ov.e1; other = ov.e0; }",
    "  result.c0 = endContact(first, pA, pB, 0.0, tHit);",
    "  if (!ov.two) return result;",
    "  float gap = max(other.gap - LINE_THICKNESS, 0.0);",
    "  if (gap <= POSITION_SLOP || gap < endClosing(other, sA, sB) * (1.0 - hit.f)) result.c1 = endContact(other, pA, pB, -gap, tHit);",
    "  return result;",
    "}",
    "",
    "// ---- Portal outline (PhysicsEngine.portalOval): two big arcs and two tip circles ----",
    "const float PORTAL_TIP_RADIUS = " + fnum(global.PhysicsEngine.PORTAL_TIP_RADIUS) + ";",
    "struct Oval { float a; float b; float r; float R; float cy; float ax; };",
    "Oval portalOval(float halfLen) {",
    "  Oval o;",
    "  o.b = PORTAL_THICKNESS * 0.5; o.r = PORTAL_TIP_RADIUS; o.a = halfLen + o.b;",
    "  o.R = ((o.a - o.r) * (o.a - o.r) + o.b * o.b - o.r * o.r) / (2.0 * (o.b - o.r));",
    "  o.cy = o.R - o.b; o.ax = o.a - o.r;",
    "  return o;",
    "}",
    "// kind: 0 the back arc, 1 the front arc, 2 the left tip, 3 the right tip.",
    "struct Feature { int kind; vec2 c; float radius; float dist; float d; };",
    "Feature portalFeatureCircle(Oval o, int kind) {",
    "  Feature f;",
    "  f.kind = kind;",
    "  if (kind == 0) { f.c = vec2(0.0, -o.cy); f.radius = o.R; }",
    "  else if (kind == 1) { f.c = vec2(0.0, o.cy); f.radius = o.R; }",
    "  else if (kind == 2) { f.c = vec2(-o.ax, 0.0); f.radius = o.r; }",
    "  else { f.c = vec2(o.ax, 0.0); f.radius = o.r; }",
    "  f.dist = 0.0; f.d = 0.0;",
    "  return f;",
    "}",
    "// The feature owning a local point (x along the portal, y toward its back): a tip past",
    "// the junction rays, else the arc on the point's side. d is the signed distance to the outline.",
    "Feature portalFeature(Oval o, vec2 p) {",
    "  int kind = abs(p.x) * o.cy > o.ax * (abs(p.y) + o.cy) ? (p.x < 0.0 ? 2 : 3) : (p.y < 0.0 ? 1 : 0);",
    "  Feature f = portalFeatureCircle(o, kind);",
    "  f.dist = length(p - f.c);",
    "  f.d = f.dist - f.radius;",
    "  return f;",
    "}",
    "vec2 portalToLocal(vec2 w, float sn, float cs) { return vec2(w.x * cs + w.y * sn, w.y * cs - w.x * sn); }",
    "",
    "void portalSweep(Oval o, vec2 p0, vec2 v, int kind, float radius, inout float best) {",
    "  Feature fc = portalFeatureCircle(o, kind);",
    "  float t = sweepPointSphere(p0, v, fc.c, fc.radius + radius, DT);",
    "  if (t < 0.0 || (best >= 0.0 && t >= best)) return;",
    "  if (portalFeature(o, p0 + v * t).kind == kind) best = t;",
    "}",
    "// Portal = A (its oval, moving with it), circle = B, swept in the portal's frame: the",
    "// earliest sweep onto a feature circle whose hit point that feature owns.",
    "Contact collidePortalCircle(Body ph, float halfLen, Body circle, float radius) {",
    "  Oval o = portalOval(halfLen);",
    "  float cs = cos(ph.angle), sn = sin(ph.angle);",
    "  vec2 p0 = portalToLocal(vec2(circle.x - ph.x, circle.y - ph.y), sn, cs);",
    "  vec2 v = portalToLocal(vec2(circle.vx - ph.vx, circle.vy - ph.vy), sn, cs);",
    "  Contact c = noContact();",
    "  float tHit = 0.0;",
    "  if (portalFeature(o, p0).d >= radius) {",
    "    float best = -1.0;",
    "    portalSweep(o, p0, v, 0, radius, best);",
    "    portalSweep(o, p0, v, 1, radius, best);",
    "    portalSweep(o, p0, v, 2, radius, best);",
    "    portalSweep(o, p0, v, 3, radius, best);",
    "    if (best < 0.0) return c;",
    "    tHit = best;",
    "  }",
    "  vec2 p = p0 + v * tHit;",
    "  Feature f = portalFeature(o, p);",
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
    "void portalFoot(Oval o, vec2 e0, vec2 e1, int kind, inout vec2 bestQ, inout Feature bestF) {",
    "  Feature fc = portalFeatureCircle(o, kind);",
    "  vec2 q = closestPointOnSegment(e0, e1, fc.c);",
    "  Feature f = portalFeature(o, q);",
    "  if (f.kind == kind && f.d < bestF.d) { bestQ = q; bestF = f; }",
    "}",
    "// One of PhysicsEngine.collidePortalLine's Newton steps on the gap of point q0 moving at v in the port",
    "// hole's frame, now at q with feature f; tHit at DT is a miss.",
    "void portalLineStep(Oval o, vec2 q0, vec2 v, inout float tHit, inout vec2 q, inout Feature f) {",
    "  float gap = f.d - LINE_THICKNESS * 0.5;",
    "  if (gap <= POSITION_SLOP || tHit >= DT) return;",
    "  float along = -dot(v, q - f.c);",
    "  tHit = along > 0.0 ? tHit + gap * f.dist / along : DT;",
    "  if (tHit >= DT) return;",
    "  q = q0 + v * tHit;",
    "  f = portalFeature(o, q);",
    "}",
    "// Portal = A (its oval), line = B (its capsule): PhysicsEngine.collidePortalLine. The segment's nearest",
    "// point to the oval, touching or reaching it within the step. One contact.",
    "ContactPair collidePortalLine(Body ph, float halfLen, Body line, float halfLenB) {",
    "  Oval o = portalOval(halfLen);",
    "  float cs = cos(ph.angle), sn = sin(ph.angle);",
    "  vec2 phC = vec2(ph.x, ph.y);",
    "  vec2 e0 = portalToLocal(lineEndpoint0(line, halfLenB) - phC, sn, cs);",
    "  vec2 e1 = portalToLocal(lineEndpoint1(line, halfLenB) - phC, sn, cs);",
    "  ContactPair result;",
    "  result.c0 = noContact();",
    "  result.c1 = noContact();",
    "  vec2 bestQ = e0;",
    "  Feature bestF = portalFeature(o, e0);",
    "  Feature f1 = portalFeature(o, e1);",
    "  if (f1.d < bestF.d) { bestQ = e1; bestF = f1; }",
    "  portalFoot(o, e0, e1, 0, bestQ, bestF);",
    "  portalFoot(o, e0, e1, 1, bestQ, bestF);",
    "  portalFoot(o, e0, e1, 2, bestQ, bestF);",
    "  portalFoot(o, e0, e1, 3, bestQ, bestF);",
    "  float halfT = LINE_THICKNESS * 0.5, tHit = 0.0;",
    "  vec2 q = bestQ;",
    "  Feature f = bestF;",
    "  if (bestF.d >= halfT) {",
    "    vec2 qw = rotateBy(bestQ, sn, cs), r = phC + qw - vec2(line.x, line.y);",
    "    vec2 v = portalToLocal(vec2(line.vx - line.w * r.y - ph.vx + ph.w * qw.y, line.vy + line.w * r.x - ph.vy - ph.w * qw.x), sn, cs);",
    "    portalLineStep(o, bestQ, v, tHit, q, f);",
    "    portalLineStep(o, bestQ, v, tHit, q, f);",
    "    if (tHit >= DT || f.d - halfT > POSITION_SLOP) return result;",
    "  }",
    "  vec2 nl = f.dist > 1e-9 ? (q - f.c) / f.dist : vec2(0.0, 1.0);",
    "  vec2 n = rotateBy(nl, sn, cs), ml = f.c + nl * f.radius;",
    "  // Touching: midway between the two surfaces, as collideLineLine puts it.",
    "  if (bestF.d < halfT) ml = (ml + q - nl * halfT) * 0.5;",
    "  vec2 m = rotateBy(ml, sn, cs);",
    "  vec2 pt = phC + m + vec2(ph.vx, ph.vy) * tHit;",
    "  result.c0.hit = true;",
    "  result.c0.normal = n;",
    "  result.c0.point = pt;",
    "  result.c0.rA = m;",
    "  result.c0.rB = pt - vec2(line.x, line.y) - vec2(line.vx, line.vy) * tHit;",
    "  result.c0.penetration = max(halfT - bestF.d, 0.0);",
    "  result.c0.tHit = tHit;",
    "  return result;",
    "}",
    "",
    "// ---- Float32 ranking for physics-gpu-df.js's sweeps: touch fractions with near misses kept, or -1 ----",
    "float rankSphere(vec2 p, vec2 v, vec2 c, float R) {",
    "  vec2 d = p - c;",
    "  float qa = dot(v, v), qb = 2.0 * dot(d, v), qc = dot(d, d) - R * R;",
    "  if (qa <= 1e-9 || qb >= 0.0 || qc < -1e-3 * R * R) return -1.0;",
    "  float disc = qb * qb - 4.0 * qa * qc;",
    "  if (disc < -1e-4 * qb * qb) return -1.0;",
    "  float f = (-qb - sqrt(max(disc, 0.0))) / (2.0 * qa);",
    "  return f < 1.001 ? max(f, 0.0) : -1.0;",
    "}",
    "float rankSlab(vec2 p, vec2 dp, vec2 q0, vec2 dq0, vec2 q1, vec2 dq1, float len, float R) {",
    "  vec2 D = q1 - q0, mD = dq1 - dq0, P = p - q0, mP = dp - dq0;",
    "  float c0 = D.x * P.y - D.y * P.x;",
    "  float side = c0 < 0.0 ? -1.0 : 1.0;",
    "  float c = side * c0 - R * len;",
    "  if (c < -1e-3 * R * len) return -1.0;",
    "  float a = side * (mD.x * mP.y - mD.y * mP.x), b = side * (D.x * mP.y - D.y * mP.x + mD.x * P.y - mD.y * P.x);",
    "  float f;",
    "  if (abs(a) * 1e6 <= abs(b)) {",
    "    if (b >= 0.0) return -1.0;",
    "    f = -c / b;",
    "  } else {",
    "    float disc = b * b - 4.0 * a * c;",
    "    if (disc < -1e-4 * b * b) return -1.0;",
    "    float sq = sqrt(max(disc, 0.0));",
    "    float q = -0.5 * (b < 0.0 ? b - sq : b + sq);",
    "    if (q == 0.0) return -1.0;",
    "    float r1 = q / a, r2 = c / q;",
    "    f = min(r1, r2);",
    "    if (f < -1e-3) f = max(r1, r2);",
    "  }",
    "  if (f < -1e-3 || f > 1.001) return -1.0;",
    "  f = clamp(f, 0.0, 1.0);",
    "  vec2 Df = D + mD * f;",
    "  float s = dot(P + mP * f, Df), l2 = dot(Df, Df);",
    "  return s >= -1e-3 * l2 && s <= 1.001 * l2 ? f : -1.0;",
    "}",
    "void rankKeep(float f, int code, inout float f1, inout int c1, inout float f2, inout int c2) {",
    "  if (f < 0.0) return;",
    "  if (c1 < 0 || f < f1) { f2 = f1; c2 = c1; f1 = f; c1 = code; }",
    "  else if (c2 < 0 || f < f2) { f2 = f; c2 = code; }",
    "}",
    "// lineLineFirstTouch's candidates in its order: 0-1 A's ends onto B's flat side, 2-3 B's onto A's,",
    "// 4-7 A's end i against B's end j (4 + 2i + j).",
    "void rankLineLine(vec2 a0, vec2 da0, vec2 a1, vec2 da1, float lenA, vec2 b0, vec2 db0, vec2 b1, vec2 db1, float lenB, out int c1, out int c2) {",
    "  float f1 = -1.0, f2 = -1.0, R = LINE_THICKNESS;",
    "  c1 = -1; c2 = -1;",
    "  rankKeep(rankSlab(a0, da0, b0, db0, b1, db1, lenB, R), 0, f1, c1, f2, c2);",
    "  rankKeep(rankSlab(a1, da1, b0, db0, b1, db1, lenB, R), 1, f1, c1, f2, c2);",
    "  rankKeep(rankSlab(b0, db0, a0, da0, a1, da1, lenA, R), 2, f1, c1, f2, c2);",
    "  rankKeep(rankSlab(b1, db1, a0, da0, a1, da1, lenA, R), 3, f1, c1, f2, c2);",
    "  rankKeep(rankSphere(a0, da0 - db0, b0, R), 4, f1, c1, f2, c2);",
    "  rankKeep(rankSphere(a0, da0 - db1, b1, R), 5, f1, c1, f2, c2);",
    "  rankKeep(rankSphere(a1, da1 - db0, b0, R), 6, f1, c1, f2, c2);",
    "  rankKeep(rankSphere(a1, da1 - db1, b1, R), 7, f1, c1, f2, c2);",
    "  if (c2 >= 0 && c2 < c1) { int t = c1; c1 = c2; c2 = t; }",
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
    "// ---- A line pair's two contacts solved together (PhysicsEngine.contactPairMatrix and its users) ----",
    "// m: the matrix as (k00, k01, k11, det); not ok, c0 alone as solveContactVelocity and solveContactPosition",
    "// would. e: each contact's restitution (pairRamps).",
    "struct ContactPairSolve { bool ok; vec4 m; vec2 g0; vec2 g1; vec2 e; vec2 pushA; vec2 pushB; float turnA; float turnB; };",
    "// PhysicsEngine.pairMatrix, the lever arms g0, g1 across each normal on A (x) and B (y).",
    "vec4 pairMatrix(Contact c0, Contact c1, vec2 g0, vec2 g1, float invMassA, float invInertiaA, float invMassB, float invInertiaB) {",
    "  float mSum = invMassA + invMassB;",
    "  float k00 = mSum + g0.x * g0.x * invInertiaA + g0.y * g0.y * invInertiaB, k11 = mSum + g1.x * g1.x * invInertiaA + g1.y * g1.y * invInertiaB;",
    "  float k01 = mSum * dot(c0.normal, c1.normal) + g0.x * g1.x * invInertiaA + g0.y * g1.y * invInertiaB;",
    "  return vec4(k00, k01, k11, k00 * k11 - k01 * k01);",
    "}",
    "bool pairOk(vec4 m) { return m.x > 0.0 && m.z > 0.0 && m.w > 1e-9 * m.x * m.z; }",
    "// PhysicsEngine.pairImpulses: j >= 0 bringing each contact's closing rate to its target, or false.",
    "bool pairImpulses(vec4 m, float b0, float b1, out vec2 j) {",
    "  j = vec2((m.z * b0 - m.y * b1) / m.w, (m.x * b1 - m.y * b0) / m.w);",
    "  if (j.x >= 0.0 && j.y >= 0.0) return true;",
    "  j = vec2(b0 / m.x, 0.0);",
    "  if (j.x > 0.0 && m.y * j.x >= b1) return true;",
    "  j = vec2(0.0, b1 / m.z);",
    "  return j.y > 0.0 && m.y * j.y >= b0;",
    "}",
    "vec2 leverArms(Contact c) { return vec2(c.rA.x * c.normal.y - c.rA.y * c.normal.x, c.rB.x * c.normal.y - c.rB.y * c.normal.x); }",
    "// PhysicsEngine.pushArms, with each line's half-length.",
    "vec2 pushArms(vec2 g, float halfA, bool movesA, float halfB, bool movesB) {",
    "  bool endA = abs(g.x) >= LINE_END_SHARE * halfA, endB = abs(g.y) >= LINE_END_SHARE * halfB;",
    "  if (endA && !endB && movesA) g.y = 0.0;",
    "  else if (endB && !endA && movesB) g.x = 0.0;",
    "  return g;",
    "}",
    "// The pair's matrix, and its push-out per position pass with the turn it gives (contactPairPush).",
    "ContactPairSolve prepareContactPair(Contact c0, Contact c1, float invMassA, float invInertiaA, bool movesA, float halfA, float invMassB, float invInertiaB, bool movesB, float halfB) {",
    "  ContactPairSolve k;",
    "  k.g0 = leverArms(c0);",
    "  k.g1 = leverArms(c1);",
    "  k.m = pairMatrix(c0, c1, k.g0, k.g1, invMassA, invInertiaA, invMassB, invInertiaB);",
    "  k.ok = c0.hit && c1.hit && pairOk(k.m);",
    "  k.e = vec2(0.0); k.pushA = vec2(0.0); k.pushB = vec2(0.0); k.turnA = 0.0; k.turnB = 0.0;",
    "  float mSum = invMassA + invMassB;",
    "  if (!k.ok) {",
    "    float cor = c0.hit && mSum > 0.0 ? max(c0.penetration - POSITION_SLOP, 0.0) / mSum * POSITION_PERCENT : 0.0;",
    "    k.pushA = -c0.normal * cor * invMassA; k.pushB = c0.normal * cor * invMassB;",
    "    return k;",
    "  }",
    "  float b0 = POSITION_PERCENT * (c0.penetration - POSITION_SLOP), b1 = POSITION_PERCENT * (c1.penetration - POSITION_SLOP);",
    "  if (b0 <= 0.0 && b1 <= 0.0) return k;",
    "  vec2 p0 = pushArms(k.g0, halfA, movesA, halfB, movesB), p1 = pushArms(k.g1, halfA, movesA, halfB, movesB);",
    "  vec4 m = pairMatrix(c0, c1, p0, p1, invMassA, invInertiaA, invMassB, invInertiaB);",
    "  vec2 j;",
    "  if (pairOk(m) && pairImpulses(m, b0, b1, j)) {",
    "    vec2 push = c0.normal * j.x + c1.normal * j.y;",
    "    k.pushA = -push * invMassA; k.pushB = push * invMassB;",
    "    k.turnA = -invInertiaA * (p0.x * j.x + p1.x * j.y); k.turnB = invInertiaB * (p0.y * j.x + p1.y * j.y);",
    "  }",
    "  return k;",
    "}",
    "// After leg 1: each contact's restitution off the speed ramp at the rate it closes then.",
    "void pairRamps(inout ContactPairSolve k, Contact c0, Contact c1, Body bodyA, Body bodyB) {",
    "  float v0 = dot(velocityAt(bodyB, c0.rB) - velocityAt(bodyA, c0.rA), c0.normal);",
    "  float v1 = dot(velocityAt(bodyB, c1.rB) - velocityAt(bodyA, c1.rA), c1.normal);",
    "  k.e = vec2(smoothstep(0.5 * RESTITUTION_THRESHOLD, RESTITUTION_THRESHOLD, -v0), smoothstep(0.5 * RESTITUTION_THRESHOLD, RESTITUTION_THRESHOLD, -v1));",
    "}",
    "// Its bounce (or, still gap away, the closing that covers the gap in a step).",
    "float pairTarget(Contact c, float v, float e) {",
    "  return -e * v - (c.penetration < 0.0 ? (1.0 - e) * -c.penetration / DT : 0.0);",
    "}",
    "void solveContactPairVelocity(inout Body bodyA, float invMassA, float invInertiaA, inout Body bodyB, float invMassB, float invInertiaB,",
    "                              Contact c0, Contact c1, ContactPairSolve k) {",
    "  float v0 = dot(velocityAt(bodyB, c0.rB) - velocityAt(bodyA, c0.rA), c0.normal);",
    "  float v1 = dot(velocityAt(bodyB, c1.rB) - velocityAt(bodyA, c1.rA), c1.normal);",
    "  vec2 j;",
    "  if (k.ok) {",
    "    float b0 = pairTarget(c0, v0, k.e.x) - v0, b1 = pairTarget(c1, v1, k.e.y) - v1;",
    "    if ((b0 <= 0.0 && b1 <= 0.0) || !pairImpulses(k.m, b0, b1, j)) return;",
    "  } else {",
    "    if (!c0.hit || v0 > 0.0 || k.m.x <= 0.0) return;",
    "    j = vec2(-(1.0 + smoothstep(0.5 * RESTITUTION_THRESHOLD, RESTITUTION_THRESHOLD, -v0)) * v0 / k.m.x, 0.0);",
    "  }",
    "  vec2 impulse = c0.normal * j.x + c1.normal * j.y;",
    "  bodyA.vx -= impulse.x * invMassA; bodyA.vy -= impulse.y * invMassA; bodyA.w -= invInertiaA * (k.g0.x * j.x + k.g1.x * j.y);",
    "  bodyB.vx += impulse.x * invMassB; bodyB.vy += impulse.y * invMassB; bodyB.w += invInertiaB * (k.g0.y * j.x + k.g1.y * j.y);",
    "}",
    "void solveContactPairPosition(inout Body bodyA, inout Body bodyB, ContactPairSolve k) {",
    "  bodyA.x += k.pushA.x; bodyA.y += k.pushA.y;",
    "  bodyB.x += k.pushB.x; bodyB.y += k.pushB.y;",
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
  // through a portal and the turn the crossing gave it, with warpFrom g_warpFrom, the portal it went
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
    // Under Mutual Gravity a pull along a free line or portal twists it.
    var gravTurned = consts.map(function (c) { return !!mutualGravity && !c.isAnchored && c.type !== "circle"; });
    gravTurned.forEach(function (on, i) { if (on) turned[i] = true; });
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
      collidePortalCircle: "dfCollidePortalCircle", collidePortalLine: "dfCollidePortalLine",
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
      collidePortalCircle: "collidePortalCircle", collidePortalLine: "collidePortalLine",
      solveHingeVelocity: "solveHingeVelocity", solveHingePosition: "solveHingePosition",
    };
    function B(i) { return E.body + i; }

    // ---- Portals (PhysicsEngine.step's rules): both placed, and the chain leaders they take ----
    var portals = PE.portalPair(consts);
    var passGroup = portals ? PE.portalGroups({
      bodies: consts,
      hinges: hingeAnchors.map(function (hg) { return { bodyA: hg.aIsWorld ? null : hg.a, bodyB: hg.b }; }),
      springs: springList.map(function (sp) { return { bodyA: sp.aIsWorld ? null : sp.a, bodyB: sp.b }; }),
    }) : null;
    var leaders = [];
    if (portals) for (var li = 0; li < n; li++) if (passGroup[li].leader === li && !passGroup[li].tethered) leaders.push(li);
    if (!leaders.length) portals = null;
    var phLit = df ? global.PhysicsDF.num : fnum;
    // A portal's tangent (the line's direction) and front normal (t.y, -t.x). An anchored one's
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
    // gravityLines(): this step's pull on every free body, into gravAccN (and gravWN, a free segment's twist).
    // apartLines(apart): apart(a, b) names a bool, set for bodies whose shapes are apart at the step's start.
    // segmentPullLines: the pull on one body from another at given poses, for the bounce and the portal pass.
    var gravityLines = null, apartLines = null, segmentPullLines = null, touchLine = null;
    function eachGravityPair(fn) {
      for (var pa = 0; pa < n; pa++) {
        for (var pb = pa + 1; pb < n; pb++) if (!(consts[pa].isAnchored && consts[pb].isAnchored)) fn(pa, pb);
      }
    }
    function isSeg(i) { return consts[i].type !== "circle"; }
    function halfThick(i) { return (consts[i].type === "portal" ? PORTAL_THICKNESS : LINE_THICKNESS) / 2; }
    var GAUSS_N = [-Math.sqrt(0.6), 0, Math.sqrt(0.6)], GAUSS_W = [5 / 18, 8 / 18, 5 / 18];
    if (mutualGravity) {
      var gravK = consts.map(function (c) { return global.PhysicsEngine.gravitationalMass(unitBodyOf(c)); });
      var reachK = consts.map(function (c) { return global.PhysicsEngine.halfExtent(unitBodyOf(c)); });
      var GRAV_G = global.PhysicsEngine.MUTUAL_GRAVITY_CONSTANT;
      var glit = df ? global.PhysicsDF.num : fnum;
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
      }
      // Each segment's axis at the step's start, and G * mass / length.
      for (var sg = 0; sg < n; sg++) {
        if (!isSeg(sg)) continue;
        if (df) {
          lines.push("  MF gSn" + sg + ", gCs" + sg + "; dfSinCos(" + B(sg) + ".angle, gSn" + sg + ", gCs" + sg + "); DVec2 gE" + sg + " = dv2(gCs" + sg + ", gSn" + sg + ");");
          lines.push("  MF gravLam" + sg + " = dfDiv(gravGM" + sg + ", dfMulPow2(BODY" + sg + "_HALF, 2.0));");
        } else {
          lines.push("  vec2 gE" + sg + " = vec2(cos(" + B(sg) + ".angle), sin(" + B(sg) + ".angle));");
          lines.push("  float gravLam" + sg + " = " + fnum(GRAV_G) + " * gravMass" + sg + " / (2.0 * fHalf" + sg + ");");
        }
      }
      // Precision-neutral pieces for the segment pulls (PhysicsEngine.pairPull).
      var V = df ? {
        half: function (i) { return "BODY" + i + "_HALF"; },
        mass: function (i) { return "gravGM" + i; },
        field: function (p, j, eps) { return "dfSegmentField(" + p + ", " + V.at(j) + ", gE" + j + ", BODY" + j + "_HALF, gravLam" + j + ", " + eps + ")"; },
        eps: function (c, sgi) { return c < 0 ? glit(halfThick(-c - 1) + halfThick(sgi)) : "dfAdd(BODY" + c + "_HALF, " + glit(halfThick(sgi)) + ")"; },
        cross: function (a, b) { return "dfSub(dfMul(" + a + ".x, " + b + ".y), dfMul(" + a + ".y, " + b + ".x))"; },
        add: function (t, v) { return t + " = dv2Add(" + t + ", " + v + ");"; },
        sub: function (t, v) { return t + " = dv2Sub(" + t + ", " + v + ");"; },
        scale: function (v, k) { return "dv2Scale(" + v + ", " + k + ")"; },
        ratio: function (a, b) { return "dfDiv(" + a + ", " + b + ")"; },
        twist: function (k, crossE, over) { return "dfDiv(dfMul(" + k + ", " + crossE + "), " + over + ")"; },
        times: function (a, b) { return "dfMul(" + a + ", " + b + ")"; },
        sq: function (a) { return "dfSqr(" + a + ")"; },
        sAdd: function (t, v) { return t + " = dfAdd(" + t + ", " + v + ");"; },
        sSub: function (t, v) { return t + " = dfSub(" + t + ", " + v + ");"; },
        gauss: function (i, p, g) { return "dv2Add(" + p + ", dv2Scale(gE" + i + ", dfMul(BODY" + i + "_HALF, " + glit(GAUSS_N[g]) + ")))"; },
        vsub: function (a, b) { return "dv2Sub(" + a + ", " + b + ")"; },
        touch: function (i, pi, j, pj) {
          if (!isSeg(i)) return "dfLess(dfPointSegmentDistance(" + pi + ", " + pj + ", gE" + j + ", BODY" + j + "_HALF), dfAdd(BODY" + i + "_HALF, " + glit(halfThick(j)) + "))";
          if (!isSeg(j)) return "dfLess(dfPointSegmentDistance(" + pj + ", " + pi + ", gE" + i + ", BODY" + i + "_HALF), dfAdd(BODY" + j + "_HALF, " + glit(halfThick(i)) + "))";
          return "dfLess(dfSegmentsDistance(" + pi + ", gE" + i + ", BODY" + i + "_HALF, " + pj + ", gE" + j + ", BODY" + j + "_HALF), " + glit(halfThick(i) + halfThick(j)) + ")";
        },
        vecT: "DVec2", sclT: "MF",
      } : {
        half: function (i) { return "fHalf" + i; },
        mass: function (i) { return "gravMass" + i; },
        field: function (p, j, eps) { return "segmentField(" + p + ", " + V.at(j) + ", gE" + j + ", fHalf" + j + ", gravLam" + j + ", " + eps + ")"; },
        eps: function (c, sgi) { return c < 0 ? fnum(halfThick(-c - 1) + halfThick(sgi)) : "(fHalf" + c + " + " + fnum(halfThick(sgi)) + ")"; },
        cross: function (a, b) { return "(" + a + ".x * " + b + ".y - " + a + ".y * " + b + ".x)"; },
        add: function (t, v) { return t + " += " + v + ";"; },
        sub: function (t, v) { return t + " -= " + v + ";"; },
        scale: function (v, k) { return v + " * (" + k + ")"; },
        ratio: function (a, b) { return a + " / " + b; },
        twist: function (k, crossE, over) { return k + " * " + crossE + " / (" + over + ")"; },
        times: function (a, b) { return "(" + a + ") * (" + b + ")"; },
        sq: function (a) { return a + " * " + a; },
        sAdd: function (t, v) { return t + " += " + v + ";"; },
        sSub: function (t, v) { return t + " -= " + v + ";"; },
        gauss: function (i, p, g) { return p + " + gE" + i + " * (fHalf" + i + " * " + fnum(GAUSS_N[g]) + ")"; },
        vsub: function (a, b) { return a + " - " + b; },
        touch: function (i, pi, j, pj) {
          if (!isSeg(i)) return "pointSegmentDistance(" + pi + ", " + pj + ", gE" + j + ", fHalf" + j + ") < fHalf" + i + " + " + fnum(halfThick(j));
          if (!isSeg(j)) return "pointSegmentDistance(" + pj + ", " + pi + ", gE" + i + ", fHalf" + i + ") < fHalf" + j + " + " + fnum(halfThick(i));
          return "segmentsDistance(" + pi + ", gE" + i + ", fHalf" + i + ", " + pj + ", gE" + j + ", fHalf" + j + ") < " + fnum(halfThick(i) + halfThick(j));
        },
        vecT: "vec2", sclT: "float",
      };
      var vAt = {};
      V.at = function (j) { return vAt[j]; };
      // The pull between i and j (one of them a segment) at poses pi, pj (vec expressions), into the free sides'
      // acc(i) and, for a free segment, twist(i). onlyOn: just that body's pull.
      function segPairLines(i, pi, j, pj, acc, twist, onlyOn) {
        var out = [], three = glit(3);
        vAt[i] = pi; vAt[j] = pj;
        var want = function (b) { return !consts[b].isAnchored && (onlyOn === undefined || onlyOn === b); };
        if (!isSeg(i) || !isSeg(j)) {
          var c = isSeg(i) ? j : i, sgi = isSeg(i) ? i : j, pc = c === i ? pi : pj, ps = c === i ? pj : pi;
          out.push("    { " + V.vecT + " gf = " + V.field(pc, sgi, V.eps(c, sgi)) + ";");
          if (want(c)) out.push("      " + V.add(acc(c), "gf"));
          if (want(sgi)) {
            out.push("      " + V.sub(acc(sgi), V.scale("gf", V.ratio(V.mass(c), V.mass(sgi)))));
            if (twist) {
              out.push("      " + V.vecT + " ga = " + V.vsub(pc, ps) + ";");
              out.push("      " + V.sSub(twist(sgi), V.twist(V.times(three, V.mass(c)), V.cross("ga", "gf"), V.times(V.mass(sgi), V.sq(V.half(sgi))))));
            }
          }
          out.push("    }");
          return out;
        }
        for (var g = 0; g < GAUSS_N.length; g++) {
          var w = glit(GAUSS_W[g]);
          out.push("    { " + V.vecT + " gq = " + V.gauss(i, pi, g) + "; " + V.vecT + " gf = " + V.field("gq", j, V.eps(-i - 1, j)) + ";");
          if (want(i)) {
            out.push("      " + V.add(acc(i), V.scale("gf", w)));
            if (twist) {
              out.push("      " + V.vecT + " ga = " + V.vsub("gq", pi) + ";");
              out.push("      " + V.sAdd(twist(i), V.twist(V.times(three, w), V.cross("ga", "gf"), V.sq(V.half(i)))));
            }
          }
          if (want(j)) {
            out.push("      " + V.sub(acc(j), V.scale("gf", V.times(w, V.ratio(V.mass(i), V.mass(j))))));
            if (twist) {
              out.push("      " + V.vecT + " gb = " + V.vsub("gq", pj) + ";");
              out.push("      " + V.sSub(twist(j), V.twist(V.times(V.times(three, w), V.mass(i)), V.cross("gb", "gf"), V.times(V.mass(j), V.sq(V.half(j))))));
            }
          }
          out.push("    }");
        }
        return out;
      }
      function posVec(i) { return E.vec(B(i) + ".x", B(i) + ".y"); }
      // The pull on k at pk from j at pj (vec expressions) into `target`; gate: an expression that skips it.
      segmentPullLines = function (k, pk, j, pj, target, gate, twistTarget) {
        var out = [];
        var a = k < j ? k : j, b = k < j ? j : k;
        out.push("    if (!(" + gate + ")) {");
        segPairLines(a, k < j ? pk : pj, b, k < j ? pj : pk, function () { return target; }, twistTarget ? function () { return twistTarget; } : null, k)
          .forEach(function (l) { out.push("  " + l); });
        out.push("    }");
        return out;
      };
      touchLine = function (i, pi, j, pj) { return V.touch(i, pi, j, pj); };

      if (df) {
        apartLines = function (apart) {
          var out = [];
          eachGravityPair(function (pa, pb) {
            if (isSeg(pa) || isSeg(pb)) {
              out.push("  bool " + apart(pa, pb) + " = !(" + touchLine(pa, posVec(pa), pb, posVec(pb)) + ");");
              return;
            }
            out.push("  bool " + apart(pa, pb) + "; { DVec2 gd = dv2(dfSub(" + B(pb) + ".x, " + B(pa) + ".x), dfSub(" + B(pb) + ".y, " + B(pa) + ".y)); " +
              "MF gContact = dfAdd(gravReach" + pa + ", gravReach" + pb + "); " + apart(pa, pb) + " = !dfLess(dv2LengthSq(gd), dfSqr(gContact)); }");
          });
          return out;
        };
        gravityLines = function () {
          var out = [], pos = B, acc = function (i) { return "gravAcc" + i; };
          for (var adf = 0; adf < n; adf++) {
            if (!consts[adf].isAnchored) out.push("  DVec2 " + acc(adf) + " = dv2Zero();");
            if (gravTurned[adf]) out.push("  MF gravW" + adf + " = DF_ZERO;");
          }
          // Once per unordered pair; each body still accumulates in ascending index order.
          eachGravityPair(function (pa, pb) {
            if (isSeg(pa) || isSeg(pb)) {
              out.push("  " + (collisionsOn ? "if (!(" + touchLine(pa, posVec(pa), pb, posVec(pb)) + ")) {" : "{"));
              segPairLines(pa, posVec(pa), pb, posVec(pb), acc, function (i) { return "gravW" + i; }).forEach(function (l) { out.push(l); });
              out.push("  }");
              return;
            }
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
              // Touching bodies do not pull: see PhysicsEngine.mutualPull.
              out.push("    if (" + outside + ") {");
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
        // Once per unordered pair: d is shared, and the second body's pull is along -d.
        // Each body still accumulates in ascending index order.
        function pull32(toward, r3) {
          return "(" + fnum(GRAV_G) + " * gravMass" + toward + " / " + r3 + ") * d";
        }
        apartLines = function (apart) {
          var out = [];
          eachGravityPair(function (pa, pb) {
            if (isSeg(pa) || isSeg(pb)) {
              out.push("  bool " + apart(pa, pb) + " = !(" + touchLine(pa, posVec(pa), pb, posVec(pb)) + ");");
              return;
            }
            out.push("  bool " + apart(pa, pb) + "; { vec2 d = vec2(" + B(pb) + ".x - " + B(pa) + ".x, " + B(pb) + ".y - " + B(pa) + ".y); " +
              "float contact = " + reachExpr[pa] + " + " + reachExpr[pb] + "; " + apart(pa, pb) + " = dot(d, d) >= contact * contact; }");
          });
          return out;
        };
        gravityLines = function () {
          var out = [], pos = B, acc = function (i) { return "gravAcc" + i; };
          for (var a = 0; a < n; a++) {
            if (!consts[a].isAnchored) out.push("  vec2 " + acc(a) + " = vec2(0.0);");
            if (gravTurned[a]) out.push("  float gravW" + a + " = 0.0;");
          }
          eachGravityPair(function (pa, pb) {
            if (isSeg(pa) || isSeg(pb)) {
              out.push("  " + (collisionsOn ? "if (!(" + touchLine(pa, posVec(pa), pb, posVec(pb)) + ")) {" : "{"));
              segPairLines(pa, posVec(pa), pb, posVec(pb), acc, function (i) { return "gravW" + i; }).forEach(function (l) { out.push(l); });
              out.push("  }");
              return;
            }
            var aMoves = !consts[pa].isAnchored, bMoves = !consts[pb].isAnchored;
            out.push("  {");
            out.push("    vec2 d = vec2(" + pos(pb) + ".x - " + pos(pa) + ".x, " + pos(pb) + ".y - " + pos(pa) + ".y);");
            // Touching bodies do not pull (PhysicsEngine.mutualPull); collisions off: smooth interior law.
            out.push("    float contact = " + reachExpr[pa] + " + " + reachExpr[pb] + ";");
            out.push("    float r2 = dot(d, d);");
            if (collisionsOn) {
              out.push("    if (r2 >= contact * contact) {");
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
      gravityLines().forEach(function (l) { lines.push(l); });
      for (var ga = 0; ga < n; ga++) {
        if (!consts[ga].isAnchored) accelExpr[ga] = "gravAcc" + ga;
        // A segment's twist joins its spin the way a spring's does (springSpin).
        if (gravTurned[ga] && !sprung[ga]) lines.push("  " + E.scalarType + " sprAlpha" + ga + " = gravW" + ga + ", sprSwing" + ga + " = " + E.zero + ";");
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
        if (turned[sb]) lines.push("  " + E.scalarType + " sprAlpha" + sb + " = " + (gravTurned[sb] ? "gravW" + sb : E.zero) + ", sprSwing" + sb + " = " + E.zero + ";");
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
    function accelFor(i) {
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
      lines.push("  " + E.vecType + " vFull" + g + " = " + advance(g, "u" + g, E.DT) + ";");
    }
    // ---- Bounces under Mutual Gravity: PhysicsEngine.step's three-point pull (bouncePull) ----
    var bounceBody = consts.map(function (c, i) {
      return mutualGravity && collisionsOn && !c.isAnchored && pairs.some(function (pair) { return pair[0] === i || pair[1] === i; });
    });
    var anyBounce = bounceBody.some(Boolean), bLit = df ? global.PhysicsDF.num : fnum;
    // (a + b) / 2, and a body's parabola off the chord at t: a t (t - dt) / 2 (PhysicsEngine.step's bendAt).
    function bAvg(a, b) {
      return df ? "dv2(dfMulPow2(dfAdd(" + a + ".x, " + b + ".x), 0.5), dfMulPow2(dfAdd(" + a + ".y, " + b + ".y), 0.5))" : "((" + a + ") + (" + b + ")) * 0.5";
    }
    function bBendAt(i, t) {
      if (consts[i].isAnchored) return E.zeroVec;
      return df ? "dv2Scale(" + accelFor(i) + ", dfMul(dfMulPow2(" + t + ", 0.5), dfSub(" + t + ", DF_DT)))"
        : "(" + accelFor(i) + ") * (0.5 * (" + t + ") * ((" + t + ") - DT))";
    }
    function bApart(a, b) { return "bApart" + Math.min(a, b) + "_" + Math.max(a, b); }
    // Assigns to `out` the pull on free body k standing at (px, py), the others at the poses `at` names.
    // outW, for a segment Mutual Gravity twists: its twist, the same way.
    function bouncePullLines(k, px, py, out, at, outW) {
      var res = ["    " + out + " = " + (sprung[k] ? "sprAcc" + k : E.zeroVec) + ";"];
      if (outW) res.push("    " + outW + " = " + E.zero + ";");
      for (var j = 0; j < n; j++) {
        if (j === k) continue;
        var pj = consts[j].isAnchored ? B(j) : at + j;
        if (consts[k].type !== "circle" || consts[j].type !== "circle") {
          var pjVec = consts[j].isAnchored ? E.vec(B(j) + ".x", B(j) + ".y") : pj;
          segmentPullLines(k, E.vec(px, py), j, pjVec, out, "!" + bApart(k, j), outW).forEach(function (l) { res.push(l); });
          continue;
        }
        if (df) {
          res.push("    { DVec2 gd = dv2(dfSub(" + pj + ".x, " + px + "), dfSub(" + pj + ".y, " + py + ")); MF gr2 = dv2LengthSq(gd);");
          res.push("      MF gContact = dfAdd(gravReach" + k + ", gravReach" + j + "); MF gContact2 = dfSqr(gContact);");
          res.push("      if (" + bApart(k, j) + ") {");
          res.push("        if (dfLess(gr2, gContact2)) gr2 = gContact2;");
          res.push("        " + out + " = dv2Add(" + out + ", dv2Scale(gd, dfMul(gravGM" + j + ", dfDiv(DF_ONE, dfMul(gr2, dfSqrt(gr2))))));");
          res.push("      } }");
        } else {
          res.push("    { vec2 d = vec2(" + pj + ".x - (" + px + "), " + pj + ".y - (" + py + ")); float contact = " + reachExpr[k] + " + " + reachExpr[j] + ";");
          res.push("      if (" + bApart(k, j) + ") {");
          res.push("        float r2 = max(dot(d, d), contact * contact);");
          res.push("        " + out + " += (" + fnum(GRAV_G) + " * gravMass" + j + " / (r2 * sqrt(r2))) * d;");
          res.push("      } }");
        }
      }
      return res;
    }

    lines.push("");

    // ---- Hinge impulses for the start pose: PhysicsEngine.shakeHinges, unrolled ----
    // Hinges with a side that can move; the free bodies they move; each side as the engine sees it.
    // shakenIndex keeps each one's place in hingeAnchors, which names its HINGEn parameters.
    var shakenIndex = [];
    var shaken = hingeAnchors.filter(function (hg, hi) {
      var live = !((hg.aIsWorld || consts[hg.a].isAnchored) && consts[hg.b].isAnchored);
      if (live) shakenIndex.push(hi);
      return live;
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
      var hi = shakenIndex[h];
      return [side(hg.a, hg.aIsWorld, "HINGE" + hi + "_A", -1), side(hg.b, false, "HINGE" + hi + "_B", 1)];
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
      });
      lines.push("");
    }
    function isShaken(idx) { return shakeBodies.indexOf(idx) !== -1; }

    // Probes: real position, velocity vFull, so swept tests match leg 1's motion. A line swept against
    // another line or a portal also turns at leg 1's spin.
    var linePaired = {};
    pairs.forEach(function (pair) {
      if (consts[pair[0]].type !== "circle" && consts[pair[1]].type !== "circle") { linePaired[pair[0]] = true; linePaired[pair[1]] = true; }
    });
    for (var p = 0; p < n; p++) {
      if (consts[p].isAnchored) continue;
      var probeDecl = "  " + E.bodyType + " probe" + p + " = " + B(p) + "; probe" + p + ".vx = vFull" + p + ".x; probe" + p + ".vy = vFull" + p + ".y;";
      if (linePaired[p] && (turned[p] || isShaken(p))) {
        var probeSpin = turned[p] ? spinExpr(p, E.DT) : B(p) + ".w";
        probeDecl += " probe" + p + ".w = " + (isShaken(p) ? E.add(probeSpin, "shDw" + p) : probeSpin) + ";";
      }
      lines.push(probeDecl);
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
    // Portal frames at the step's start, and where every free body began.
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
      if (consts[li].type === "portal") {
        // A portal meets a circle as its oval; df reads the tangent off its segment and the reach off its half.
        return df
          ? (isStatic(li) ? "dfCollidePortalCircleStatic" : E.collidePortalCircle) + "(" + probeRef(li) + ", " + segExpr(li) + ", BODY" + li + "_HALF, " + probeRef(ci) + ", BODY" + ci + "_HALF)"
          : E.collidePortalCircle + "(" + probeRef(li) + ", BODY" + li + "_HALF, " + probeRef(ci) + ", BODY" + ci + "_HALF)";
      }
      return (isStatic(li) ? "dfCollideLineCircleStatic" : E.collideLineCircle) + "(" + probeRef(li) + ", " + lineArg(li) + ", " + probeRef(ci) + ", BODY" + ci + "_HALF)";
    }
    // A portal meets a plain line as its oval (two portals meet as capsules).
    function portalLineCall(pi, li) {
      return df
        ? E.collidePortalLine + "(" + probeRef(pi) + ", " + segExpr(pi) + ", BODY" + pi + "_HALF, " + moves(pi) + ", " + probeRef(li) + ", " + segExpr(li) + ")"
        : E.collidePortalLine + "(" + probeRef(pi) + ", BODY" + pi + "_HALF, " + probeRef(li) + ", BODY" + li + "_HALF)";
    }
    // Only a line<->line pair can fill its second contact slot.
    function pairSlots(pair) {
      return consts[pair[0]].type !== "circle" && consts[pair[1]].type !== "circle" ? ["c0", "c1"] : ["c0"];
    }
    // Pairs that meet in collideLineLine (two portals meet as two lines); they solve both slots together.
    function twoSlots(pair) {
      var tA = consts[pair[0]].type, tB = consts[pair[1]].type;
      return tA !== "circle" && tB !== "circle" && (tA === "portal") === (tB === "portal");
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
      } else if (tA === "portal" && tB !== "portal") {
        lines.push(detected(E.contactPairType, varName, portalLineCall(i, j)));
      } else if (tB === "portal" && tA !== "portal") {
        // collidePortalLine takes (portal, line): swap rA/rB back and flip the normal.
        lines.push(detected(E.contactPairType, varName, portalLineCall(j, i)));
        lines.push("  " + varName + ".c0.normal = " + E.negVec(varName + ".c0.normal") + ";");
        lines.push("  { " + E.vecType + " tmp_" + i + "_" + j + " = " + varName + ".c0.rA; " + varName + ".c0.rA = " + varName + ".c0.rB; " + varName + ".c0.rB = tmp_" + i + "_" + j + "; }");
      } else {
        // df also takes the half-lengths, for the step's end pose.
        var halves = df ? [", BODY" + i + "_HALF", ", BODY" + j + "_HALF"] : ["", ""];
        lines.push(detected(E.contactPairType, varName, E.collideLineLine + "(" + refI + ", " + lineArg(i) + halves[0] + ", " + refJ + ", " + lineArg(j) + halves[1] + ")"));
      }
    });
    // A leader's contact on a portal's front is no contact: its point (the portal's lever arm)
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
        if (twoSlots(pair)) return;
        pairSlots(pair).forEach(function (slot) {
          lines.push(prepareContactLine("pair_" + pair[0] + "_" + pair[1] + "." + slot, pair[0], pair[1]));
        });
      });
    }
    // A line pair's two slots solve together (PhysicsEngine.contactPairMatrix).
    pairs.forEach(function (pair) {
      if (!twoSlots(pair)) return;
      var a = pair[0], b = pair[1], vn = "pair_" + a + "_" + b;
      lines.push("  " + (df ? "DContactPairSolve " : "ContactPairSolve ") + vn + "_k = " + (df ? "dfPrepareContactPair(" : "prepareContactPair(") +
        vn + ".c0, " + vn + ".c1, " + massArgs(a) + ", " + moves(a) + ", BODY" + a + "_HALF, " + massArgs(b) + ", " + moves(b) + ", BODY" + b + "_HALF);");
    });
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
      if (!anyBounce) {
        [i, j].forEach(function (b) {
          if (!consts[b].isAnchored) lines.push("  body" + b + "THit = " + E.min("body" + b + "THit", pairMin) + ";");
        });
        return;
      }
      // Each hit moved onto the step's parabola by one Newton step along its normal (PhysicsEngine.step).
      var vOf = function (b) { return consts[b].isAnchored ? E.zeroVec : "vFull" + b; };
      pairSlots(pair).forEach(function (slot) {
        var c = varName + "." + slot;
        lines.push("  if (" + c + ".hit) {");
        lines.push("    " + E.scalarType + " tc = " + c + ".tHit;");
        lines.push("    if (" + E.less(E.zero, "tc") + ") {");
        lines.push("      " + E.scalarType + " closing = " + (df ? "dv2Dot(" + E.vsub(vOf(j), vOf(i)) + ", " + c + ".normal)" : "dot(" + E.vsub(vOf(j), vOf(i)) + ", " + c + ".normal)") + ";");
        lines.push("      " + E.scalarType + " off = " + (df ? "dv2Dot(" + E.vsub(bBendAt(j, "tc"), bBendAt(i, "tc")) + ", " + c + ".normal)" : "dot(" + E.vsub(bBendAt(j, "tc"), bBendAt(i, "tc")) + ", " + c + ".normal)") + ";");
        lines.push(df
          ? "      if (dfLess(closing, DF_ZERO)) tc = dfMin(DF_DT, dfMax(DF_ZERO, dfSub(tc, dfDiv(off, closing))));"
          : "      if (closing < 0.0) tc = min(DT, max(0.0, tc - off / closing));");
        lines.push("    }");
        [i, j].forEach(function (b) {
          if (!consts[b].isAnchored) lines.push("    if (" + E.less("tc", "body" + b + "THit") + ") body" + b + "THit = tc;");
        });
        lines.push("  }");
      });
    });
    if (anyBounce) apartLines(bApart).forEach(function (l) { lines.push(l); });
    lines.push("");

    bounceBody.forEach(function (on, g) { if (on && gravTurned[g]) lines.push("  " + E.scalarType + " bSpin0" + g + " = " + B(g) + ".w;"); });
    // Leg 1: move at vFull for tHit (matching detection). A hit body's kick before the solve runs to tHit plus
    // half a step and leg 2 takes the rest (PhysicsEngine.step's bodyTKick).
    for (var g3 = 0; g3 < n; g3++) {
      if (consts[g3].isAnchored) continue;
      var t1 = paired[g3] ? "body" + g3 + "THit" : E.DT;
      lines.push("  " + B(g3) + ".x = " + E.add(B(g3) + ".x", E.mul("vFull" + g3 + ".x", t1)) + ";");
      lines.push("  " + B(g3) + ".y = " + E.add(B(g3) + ".y", E.mul("vFull" + g3 + ".y", t1)) + ";");
      if (bounceBody[g3]) {
        lines.push("  if (" + E.less(t1, E.DT) + ") { " + E.vecType + " bd = " + bBendAt(g3, t1) + "; " +
          B(g3) + ".x = " + E.add(B(g3) + ".x", "bd.x") + "; " + B(g3) + ".y = " + E.add(B(g3) + ".y", "bd.y") + "; }");
      }
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
        lines.push("  if (" + E.less(t1, E.DT) + ") " + tk1 + " = " + E.add(t1, E.halfDT) + ";");
        lines.push("  " + E.vecType + " vPre" + g3 + " = " + (isShaken(g3) ? E.vadd(advance(g3, "u" + g3, tk1), "shDv" + g3) : advance(g3, "u" + g3, tk1)) + ";");
        lines.push("  " + B(g3) + ".vx = vPre" + g3 + ".x; " + B(g3) + ".vy = vPre" + g3 + ".y;");
      } else {
        lines.push("  " + B(g3) + ".vx = vFull" + g3 + ".x; " + B(g3) + ".vy = vFull" + g3 + ".y;");
      }
    }
    lines.push("");
    // A bounce's kick in, once every body stands at its leg-1 pose (PhysicsEngine.step).
    if (anyBounce) {
      for (var lp = 0; lp < n; lp++) {
        if (!consts[lp].isAnchored) lines.push("  " + E.vecType + " bLeg" + lp + " = " + E.vec(B(lp) + ".x", B(lp) + ".y") + ";");
      }
    }
    bounceBody.forEach(function (on, g) {
      if (!on) return;
      var tHit = "body" + g + "THit";
      var tw = gravTurned[g] ? "bAcW" + g : null;
      lines.push("  " + E.vecType + " bAc" + g + " = " + E.zeroVec + ";" + (tw ? " " + E.scalarType + " " + tw + " = " + E.zero + ";" : ""));
      lines.push("  if (" + E.less(tHit, E.DT) + ") {");
      // From the step's start velocity on the pull there and at the contact, linear between.
      lines.push("    " + E.vecType + " bv0 = " + E.advanceVelocity + "(u" + g + ", " + E.halfDT + ", " + accelFor(g) + ");");
      bouncePullLines(g, B(g) + ".x", B(g) + ".y", "bAc" + g, "bLeg", tw).forEach(function (l) { lines.push(l); });
      lines.push("    " + E.vecType + " bv = " + E.advanceVelocity + "(bv0, " + tHit + ", " + bAvg(accelFor(g), "bAc" + g) + ");");
      if (isShaken(g)) lines.push("    bv = " + E.vadd("bv", "shDv" + g) + ";");
      lines.push("    " + B(g) + ".vx = bv.x; " + B(g) + ".vy = bv.y;");
      if (tw) {
        // The twist the same way: from the step's start and at the contact, linear between.
        var a0 = df ? "dfAdd(sprAlpha" + g + ", dfMulPow2(dfSub(" + tw + ", gravW" + g + "), 0.5))" : "sprAlpha" + g + " + (" + tw + " - gravW" + g + ") * 0.5";
        var wIn = (df ? "dfSpringSpin(" : "springSpin(") + "bSpin0" + g + ", " + a0 + ", sprSwing" + g + ", " + tHit + ")";
        lines.push("    " + B(g) + ".w = " + (isShaken(g) ? E.add(wIn, "shDw" + g) : wIn) + ";");
      }
      lines.push("  }");
    });
    if (anyBounce) lines.push("");

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

    // A line pair's restitution, from the velocities leg 1 left.
    pairs.forEach(function (pair) {
      if (!twoSlots(pair)) return;
      var a = pair[0], b = pair[1], vn = "pair_" + a + "_" + b;
      lines.push("  " + (df
        ? "dfPairRamps(" + vn + "_k, " + vn + ".c0, " + vn + ".c1, " + B(a) + ", " + moves(a) + ", " + B(b) + ", " + moves(b) + ");"
        : "pairRamps(" + vn + "_k, " + vn + ".c0, " + vn + ".c1, " + B(a) + ", " + B(b) + ");"));
    });
    var solves = hingeAnchors.length || pairs.length;
    // One 2x2 solve is exact for a lone hinge with nothing else to solve (PhysicsEngine.step).
    var velIterCount = hingeAnchors.length === 1 && !pairs.length ? 1 : VELOCITY_ITERATIONS;
    if (solves) lines.push("  for (int iter = 0; iter < " + velIterCount + "; iter++) {");
    hingeAnchors.forEach(function (hg, hi) { lines.push("    " + hingeCall(hg, hi, "velocity")); });
    pairs.forEach(function (pair) {
      var varName = "pair_" + pair[0] + "_" + pair[1], a = pair[0], b = pair[1];
      // c1 only for line<->line: elsewhere it is noContact() by construction.
      if (twoSlots(pair)) {
        lines.push("    " + (df
          ? "dfSolveContactPairVelocity(" + B(a) + ", " + massArgs(a) + ", " + moves(a) + ", " + B(b) + ", " + massArgs(b) + ", " + moves(b) + ", "
          : "solveContactPairVelocity(" + B(a) + ", " + massArgs(a) + ", " + B(b) + ", " + massArgs(b) + ", ") +
          varName + ".c0, " + varName + ".c1, " + varName + "_k);");
        return;
      }
      pairSlots(pair).forEach(function (slot) { lines.push("    " + contactVelocityCall(a, b, varName + "." + slot)); });
    });
    if (solves) lines.push("  }");
    lines.push("");
    // A line pair's turns, whole, per body: they land after leg 2, before the position passes (PhysicsEngine.step).
    var pairTurns = {};
    pairs.forEach(function (pair) {
      if (!twoSlots(pair)) return;
      var vn = "pair_" + pair[0] + "_" + pair[1] + "_k";
      [[pair[0], "turnA"], [pair[1], "turnB"]].forEach(function (side) {
        if (consts[side[0]].isAnchored) return;
        var turn = E.mul(df ? global.PhysicsDF.num(POSITION_ITERATIONS) : fnum(POSITION_ITERATIONS), vn + "." + side[1]);
        pairTurns[side[0]] = pairTurns[side[0]] ? E.add(pairTurns[side[0]], turn) : turn;
      });
    });
    // A bounce's way out: every hit body moves on its contact pull first, so the end pulls are taken between end poses.
    bounceBody.forEach(function (on, g) {
      if (!on) return;
      var tOut = E.sub(E.DT, "body" + g + "THit");
      lines.push("  if (" + E.less("body" + g + "THit", E.DT) + ") {");
      ["x", "y"].forEach(function (c) {
        var drift = E.mul(E.add(B(g) + ".v" + c, E.mul("bAc" + g + "." + c, df ? "dfMulPow2(" + tOut + ", 0.5)" : E.mul(tOut, "0.5"))), tOut);
        lines.push("    " + B(g) + "." + c + " = " + E.add(B(g) + "." + c, drift) + ";");
      });
      lines.push("  }");
    });
    if (anyBounce) {
      for (var ep = 0; ep < n; ep++) {
        if (!consts[ep].isAnchored) lines.push("  " + E.vecType + " bEnd" + ep + " = " + E.vec(B(ep) + ".x", B(ep) + ".y") + ";");
      }
    }
    // Leg 2: the rest of the step, and of the kick, on the post-impulse velocity; no contact means identity.
    for (var g2 = 0; g2 < n; g2++) {
      if (consts[g2].isAnchored || !paired[g2]) continue;
      var t2 = "body" + g2 + "TRest";
      lines.push("  " + E.scalarType + " " + t2 + " = " + E.sub(E.DT, "body" + g2 + "THit") + ";");
      if (bounceBody[g2]) {
        // From the contact: move on its pull, then the velocity on the pull there and at the end, linear between,
        // stored half a step behind as every other step leaves it.
        var bt = "body" + g2 + "THit", bAc = "bAc" + g2;
        lines.push("  if (" + E.less(bt, E.DT) + ") {");
        lines.push("    " + E.vecType + " bv = " + E.vec(B(g2) + ".vx", B(g2) + ".vy") + ";");
        var tw2 = gravTurned[g2];
        lines.push("    " + E.vecType + " bA1 = " + E.zeroVec + ";" + (tw2 ? " " + E.scalarType + " bA1W = " + E.zero + ";" : ""));
        bouncePullLines(g2, B(g2) + ".x", B(g2) + ".y", "bA1", "bEnd", tw2 ? "bA1W" : null).forEach(function (l) { lines.push(l); });
        lines.push("    bv = " + E.advanceVelocity + "(bv, " + t2 + ", " + bAvg(bAc, "bA1") + ");");
        lines.push("    bv = " + E.advanceVelocity + "(bv, " + E.neg(E.halfDT) + ", bA1);");
        lines.push("    " + B(g2) + ".vx = bv.x; " + B(g2) + ".vy = bv.y;");
        if (tw2) {
          var a2 = df ? "dfSub(dfAdd(sprAlpha" + g2 + ", dfMulPow2(dfAdd(bAcW" + g2 + ", bA1W), 0.5)), gravW" + g2 + ")"
            : "sprAlpha" + g2 + " + (bAcW" + g2 + " + bA1W) * 0.5 - gravW" + g2;
          lines.push("    " + B(g2) + ".w = " + (df ? "dfSpringSpin(" : "springSpin(") + B(g2) + ".w, " + a2 + ", sprSwing" + g2 + ", " + t2 + ");");
        } else if (turned[g2]) {
          lines.push("    " + B(g2) + ".w = " + spinExpr(g2, t2) + ";");
        }
        lines.push("  } else {");
        lines.push("    " + E.vecType + " vPost" + g2 + " = " + advance(g2, E.vec(B(g2) + ".vx", B(g2) + ".vy"), E.sub(E.DT, "body" + g2 + "TKick")) + ";");
        lines.push("    " + B(g2) + ".vx = vPost" + g2 + ".x; " + B(g2) + ".vy = vPost" + g2 + ".y;");
        if (turned[g2]) lines.push("    " + B(g2) + ".w = " + spinExpr(g2, t2) + ";");
        lines.push("  }");
      } else {
      lines.push("  " + E.vecType + " vPost" + g2 + " = " + advance(g2, E.vec(B(g2) + ".vx", B(g2) + ".vy"), E.sub(E.DT, "body" + g2 + "TKick")) + ";");
      lines.push("  " + B(g2) + ".vx = vPost" + g2 + ".x; " + B(g2) + ".vy = vPost" + g2 + ".y;");
      // The rest of a spring's torque onto the post-impulse spin, before the turn reads it.
      if (turned[g2]) lines.push("  " + B(g2) + ".w = " + spinExpr(g2, t2) + ";");
      lines.push("  " + B(g2) + ".x = " + E.add(B(g2) + ".x", E.mul("vPost" + g2 + ".x", t2)) + ";");
      lines.push("  " + B(g2) + ".y = " + E.add(B(g2) + ".y", E.mul("vPost" + g2 + ".y", t2)) + ";");
      }
      if (df && hingeBodies[g2]) {
        // A hinged body's carried sin/cos follows its angle into the position loop, in one turn.
        var spun = E.mul(B(g2) + ".w", t2);
        lines.push("  dfTurn(" + B(g2) + ".angle, " + trig(g2) + ", " + (pairTurns[g2] ? E.add(spun, pairTurns[g2]) : spun) + ");");
        delete pairTurns[g2];
      } else {
        lines.push("  " + B(g2) + ".angle = " + E.add(B(g2) + ".angle", E.mul(B(g2) + ".w", t2)) + ";");
      }
    }
    Object.keys(pairTurns).forEach(function (idx) {
      lines.push("  " + B(idx) + ".angle = " + E.add(B(idx) + ".angle", pairTurns[idx]) + ";");
    });
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
      var varName = "pair_" + pair[0] + "_" + pair[1], a = pair[0], b = pair[1];
      if (twoSlots(pair)) {
        lines.push("    " + (df
          ? "dfSolveContactPairPosition(" + B(a) + ", " + moves(a) + ", " + B(b) + ", " + moves(b) + ", "
          : "solveContactPairPosition(" + B(a) + ", " + B(b) + ", ") + varName + "_k);");
        return;
      }
      pairSlots(pair).forEach(function (slot) { lines.push("    " + contactPositionCall(a, b, varName + "." + slot)); });
    });
    if (solves) lines.push("  }");

    // ---- Portals: a leader that crossed a front band this step leaves through the other ----
    // The crossing is read from the actual step (in front at its start, behind at its end) in the
    // portal's own frames at both ends; the mapping, and the re-integration of the step's share
    // past the crossing on the exit side, are PhysicsEngine.applyPortalTransports'.
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
          if (members.indexOf(j) !== -1 || j === m) continue;
          if (consts[m].type !== "circle" || consts[j].type !== "circle") {
            segmentPullLines(m, pos, j, phPos(j), target, collisionsOn ? touchLine(m, pos, j, phPos(j)) : "false").forEach(function (l) { out.push("  " + l); });
            continue;
          }
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
            lines.push("    phCross" + t + " = !dfGreater(dfAbs(phSx" + t + "), dfAdd(dfAdd(BODY" + pi + "_HALF, DF_HALF_PORTAL_THICKNESS), BODY" + oi + "_HALF));");
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
            lines.push("    phCross" + t + " = abs(phSx" + t + ") <= BODY" + pi + "_HALF + PORTAL_THICKNESS * 0.5 + BODY" + oi + "_HALF;");
            lines.push("  }");
          }
        });
        [0, 1].forEach(function (k) {
          var pi = portals[k], qi = portals[1 - k], t = "_" + oi + "_" + pi;
          var members = passGroup[oi].members;
          var pMoves = !consts[pi].isAnchored, qMoves = !consts[qi].isAnchored;
          // Each portal as it stood at the crossing instant: pose, velocity and spin interpolated
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
          // A movable portal's velocity at a member's spot; velocity and spin are kept relative to it.
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

    // Frame wrap, last so it never feeds this step's position solve; PhysicsEngine.step's rule.
    if (frame) {
      var linkScene = {
        bodies: consts,
        hinges: hingeAnchors.map(function (hg) { return { bodyA: hg.aIsWorld ? null : hg.a, bodyB: hg.b }; }),
        springs: springList.map(function (sp) { return { bodyA: sp.aIsWorld ? null : sp.a, bodyB: sp.b }; }),
      };
      var springGroups = PE.springGroups(linkScene), assemblies = PE.hingeAssemblies(linkScene);
      var frameW = fnum(frame.width), frameH = fnum(frame.height);
      lines.push("");
      for (var root = 0; root < n; root++) {
        var springGroup = springGroups ? springGroups.groupOf[root] : null;
        var wrapGroup = springGroup || assemblies.groupOf[root];
        if (springGroup ? springGroup.tethered || springGroup.leader !== root : wrapGroup.held || wrapGroup.leader !== root) continue;
        var refX = B(root) + ".x", refY = B(root) + ".y";
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
        // What moves with the leader: every member and the pins they hang from.
        var movedPins = [], moved = {};
        wrapGroup.members.forEach(function (m) { moved[m] = true; });
        hingeAnchors.forEach(function (hg, hi) { if (hg.aIsWorld && moved[hg.b]) movedPins.push(hi); });
        // df adds are real work even by zero: only on a wrap step.
        var wrapIndent = df ? "    " : "  ";
        if (df) lines.push("  if (" + dxVar + " != 0.0 || " + dyVar + " != 0.0) {");
        movedPins.forEach(function (hi) {
          var hv = "HINGE" + hi + "_A";
          lines.push(df
            ? wrapIndent + hv + ".x = dfAddFloat(" + hv + ".x, " + dxVar + "); " + hv + ".y = dfAddFloat(" + hv + ".y, " + dyVar + ");"
            : wrapIndent + hv + " += vec2(" + dxVar + ", " + dyVar + ");");
        });
        Object.keys(moved).forEach(function (memberStr) {
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
  // A chunk slower than this is believed at once, not taken for a wait behind other work.
  var TRAJECTORY_SLOW_MS = 4 * TRAJECTORY_TARGET_MS;
  // Recent chunk timings the sizing compares.
  var TRAJECTORY_TIMINGS_KEPT = 8;
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
      { pairContacts: true, warpBits: true }));
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
      parallel: gl.getExtension("KHR_parallel_shader_compile"),
      builds: {}, // background builds by source (trajectoryProgramPending)
    };
    return trajectoryRunner;
  }

  function cachedTrajectoryProgram(runner, fragmentSource) {
    var cache = runner.programs;
    for (var i = 0; i < cache.length; i++) {
      if (cache[i].source === fragmentSource) {
        var hit = cache.splice(i, 1)[0];
        cache.push(hit);
        return hit;
      }
    }
    return null;
  }

  function cacheTrajectoryProgram(runner, entry) {
    var cache = runner.programs;
    cache.push(entry);
    while (cache.length > TRAJECTORY_PROGRAM_CACHE_SIZE) {
      var old = cache.shift();
      // A run still using it deletes it when it ends.
      if (old.runs > 0) old.evicted = true;
      else runner.gl.deleteProgram(old.program);
    }
  }

  function trajectoryProgramFor(runner, fragmentSource) {
    var hit = cachedTrajectoryProgram(runner, fragmentSource);
    if (hit) return hit;
    var build = runner.builds[fragmentSource];
    if (build) {
      if (pumpTrajectoryBuild(runner, build, true) === "failed") {
        delete runner.builds[fragmentSource];
        throw new Error(build.error);
      }
      return cachedTrajectoryProgram(runner, fragmentSource);
    }
    var gl = runner.gl;
    var fs = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    var program;
    try {
      program = linkProgram(gl, runner.vs, fs);
    } finally {
      gl.deleteShader(fs);
    }
    var entry = { source: fragmentSource, program: program, posLoc: gl.getAttribLocation(program, "a_position") };
    cacheTrajectoryProgram(runner, entry);
    return entry;
  }

  // Whether a run of `compiled` would build its program first: true while it links and warms in the background,
  // starting that build if need be. Always false without KHR_parallel_shader_compile (the run builds it on the spot).
  function trajectoryProgramPending(compiled) {
    if (compiled.numBodies === 0) return false;
    var runner = getTrajectoryRunner();
    var source = compiled.fragmentSource;
    if (!runner.parallel || cachedTrajectoryProgram(runner, source)) return false;
    var build = runner.builds[source];
    if (!build) {
      dropStaleTrajectoryBuilds(runner);
      var gl = runner.gl, shader = gl.createShader(gl.FRAGMENT_SHADER), program = gl.createProgram();
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      gl.attachShader(program, runner.vs);
      gl.attachShader(program, shader);
      gl.linkProgram(program);
      build = runner.builds[source] = { source: source, shader: shader, program: program, outputs: 1 + (compiled.chunk.loOutputs || 0), precision: compiled.precision,
        status: "linking", sync: null, entry: null, error: null };
    }
    return pumpTrajectoryBuild(runner, build, false) === "pending";
  }

  // linking -> warming -> cached, or "failed" with the error kept for the run to throw. `wait` finishes it on the spot.
  function pumpTrajectoryBuild(runner, build, wait) {
    var gl = runner.gl;
    build.polledAt = performance.now();
    if (build.status === "linking") {
      if (!wait && !gl.getProgramParameter(build.program, runner.parallel.COMPLETION_STATUS_KHR)) return "pending";
      if (!gl.getProgramParameter(build.program, gl.LINK_STATUS)) {
        build.error = gl.getShaderParameter(build.shader, gl.COMPILE_STATUS)
          ? "Program link error:\n" + gl.getProgramInfoLog(build.program)
          : "Fragment shader error:\n" + gl.getShaderInfoLog(build.shader);
        gl.deleteShader(build.shader);
        gl.deleteProgram(build.program);
        build.status = "failed";
        return build.status;
      }
      if (!wait && warmGate && !warmGate(build.precision)) return "pending";
      gl.deleteShader(build.shader);
      build.entry = { source: build.source, program: build.program, posLoc: gl.getAttribLocation(build.program, "a_position") };
      warmTrajectoryProgram(runner, build.entry, build.outputs);
      build.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      build.status = "warming";
    }
    if (build.status !== "warming") return build.status;
    // A fence never signals within the task that made it.
    if (!wait && gl.getSyncParameter(build.sync, gl.SYNC_STATUS) !== gl.SIGNALED) return "pending";
    gl.deleteSync(build.sync);
    build.entry.warmed = true;
    delete runner.builds[build.source];
    cacheTrajectoryProgram(runner, build.entry);
    return "ready";
  }

  // Asked before a background build's first draw, which pauses the screen; false puts the draw off to a later poll.
  var warmGate = null;
  function setWarmGate(fn) { warmGate = fn; }

  // Precisions of the background builds still being asked after (a loading notice).
  function pendingTrajectoryPrecisions() {
    if (!trajectoryRunner) return [];
    var now = performance.now();
    return Object.keys(trajectoryRunner.builds).map(function (source) { return trajectoryRunner.builds[source]; })
      .filter(function (build) { return build.status !== "failed" && now - build.polledAt < 1000; })
      .map(function (build) { return build.precision; });
  }

  // Builds nobody asked after for a while (the scene or view moved on) are dropped when a new one starts.
  var TRAJECTORY_BUILD_STALE_MS = 5000;
  function dropStaleTrajectoryBuilds(runner) {
    var gl = runner.gl, now = performance.now();
    Object.keys(runner.builds).forEach(function (source) {
      var build = runner.builds[source];
      if (now - build.polledAt < TRAJECTORY_BUILD_STALE_MS) return;
      if (build.status === "linking") gl.deleteShader(build.shader);
      if (build.status !== "failed") gl.deleteProgram(build.program);
      if (build.sync) gl.deleteSync(build.sync);
      delete runner.builds[source];
    });
  }

  // On ANGLE/Metal a program's first draw into a framebuffer shape builds its pipeline (seconds for df):
  // a 1x1 draw into the shape a run uses, so the run finds it built.
  function warmTrajectoryProgram(runner, entry, outputs) {
    var gl = runner.gl;
    gl.useProgram(entry.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, runner.quadBuffer);
    gl.enableVertexAttribArray(entry.posLoc);
    gl.vertexAttribPointer(entry.posLoc, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1i(gl.getUniformLocation(entry.program, "u_trajInit"), 1);
    gl.uniform1i(gl.getUniformLocation(entry.program, "u_trajBase"), 0);
    gl.uniform1i(gl.getUniformLocation(entry.program, "u_trajAdvance"), 0);
    gl.viewport(0, 0, 1, 1);
    gl.activeTexture(gl.TEXTURE0);
    var fbo = gl.createFramebuffer(), textures = [], buffers = [];
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    for (var k = 0; k < outputs; k++) {
      textures.push(floatTexture(gl, 1, 1));
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + k, gl.TEXTURE_2D, textures[k], 0);
      buffers.push(gl.COLOR_ATTACHMENT0 + k);
    }
    // Left bound, a target would also be the sampled state: a feedback loop, and the draw is refused.
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.drawBuffers(buffers);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    textures.forEach(function (t) { gl.deleteTexture(t); });
  }

  function floatTexture(gl, w, h, data) {
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, data || null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
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
    var job = startTrajectoryRun(compiled, maxSteps);
    job.step(Infinity);
    return job.trajectories;
  }

  // The same run as a job for callers that spread it over tasks: step(budgetMs) works until about budgetMs has
  // passed and returns true once job.trajectories is set; it throws as the run would. progress is 0 to 1. ready
  // holds the trajectories so far, in order: a batch too wide for one texture finishes a part at a time.
  function startTrajectoryRun(compiled, maxSteps) {
    var count = compiled.pointCount || 1;
    var job = { trajectories: null, ready: [], progress: 0, step: null, cancel: null };
    var parts = [], batch = null, part = null;
    if (compiled.numBodies === 0) {
      job.ready = new Array(count).fill([]);
    } else {
      var runner = getTrajectoryRunner();
      var gl = runner.gl;
      var maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      var textures = 1 + (compiled.chunk.loOutputs || 0);
      var perBatch = Math.max(1, Math.min(TRAJECTORY_BATCH_MAX,
        Math.floor(maxTexture / (compiled.numBodies + 1)), Math.floor(maxTexture / (compiled.chunk.layers + 1)),
        Math.floor(TRAJECTORY_BATCH_TEXELS / textures / ((compiled.numBodies + 1) * maxSteps))));
      if (!compiled.pointCount || count <= perBatch) {
        parts.push({ compiled: compiled, n: count });
      } else {
        for (var first = 0; first < count; first += perBatch) {
          var n = Math.min(perBatch, count - first);
          parts.push({ compiled: Object.assign({}, compiled, { pointCount: n, points: pointsSlice(compiled.points, count, first, n) }), n: n });
        }
      }
    }
    job.step = function (budgetMs) {
      var until = performance.now() + budgetMs;
      try {
        while (batch || parts.length) {
          if (!batch) {
            part = parts.shift();
            batch = startTrajectoryBatch(part.compiled, maxSteps, part.n);
          }
          var result = batch.advance(until);
          job.progress = (job.ready.length + batch.progress() * part.n) / count;
          if (!result) return false;
          Array.prototype.push.apply(job.ready, result);
          batch = null;
          if (parts.length && performance.now() >= until) return false;
        }
      } catch (err) {
        job.cancel();
        throw err;
      }
      job.trajectories = job.ready;
      job.progress = 1;
      return true;
    };
    job.cancel = function () {
      if (batch) batch.cancel();
      batch = null;
      parts = [];
    };
    return job;
  }
  // Points first..first+n of a P x 2 points texture's data.
  function pointsSlice(points, count, first, n) {
    var out = new Float32Array(n * 8);
    out.set(points.subarray(first * 4, (first + n) * 4), 0);
    out.set(points.subarray((count + first) * 4, (count + first + n) * 4), n * 4);
    return out;
  }

  // One batch, resumable: advance(until) runs chunks, then the readback and the rows, until the clock passes
  // `until`, and returns the trajectories when done (null before). Each batch owns its textures and framebuffers.
  function startTrajectoryBatch(compiled, maxSteps, count) {
    var numBodies = compiled.numBodies;
    var chunk = compiled.chunk;

    var runner = getTrajectoryRunner();
    var gl = runner.gl;
    var entry = trajectoryProgramFor(runner, compiled.fragmentSource);
    var prog = entry.program;
    entry.runs = (entry.runs || 0) + 1;
    var u = {
      state: gl.getUniformLocation(prog, "u_trajState"),
      init: gl.getUniformLocation(prog, "u_trajInit"),
      base: gl.getUniformLocation(prog, "u_trajBase"),
      advance: gl.getUniformLocation(prog, "u_trajAdvance"),
      points: gl.getUniformLocation(prog, "u_hoverPoints"),
    };

    var pointsTexture = compiled.pointCount ? floatTexture(gl, count, 2, compiled.points) : null;
    // The log: a column wider than the bodies for each row's sentinel, per run...
    var runWidth = numBodies + 1;
    var logWidth = runWidth * count;
    var texture = floatTexture(gl, logWidth, maxSteps);
    var loTextures = [];
    for (var lo = 0; lo < (chunk.loOutputs || 0); lo++) loTextures.push(floatTexture(gl, logWidth, maxSteps));
    // ...and two state strips, swapped each chunk, a texel longer per run for the same reason.
    var runStrip = chunk.layers + 1;
    var stripWidth = runStrip * count;
    var states = [floatTexture(gl, stripWidth, 1), floatTexture(gl, stripWidth, 1)];
    // Padded to the log framebuffer's shape, so both draws share one pipeline.
    var pads = loTextures.map(function () { return floatTexture(gl, stripWidth, 1); });
    var logFbo = gl.createFramebuffer(), stateFbo = gl.createFramebuffer();
    var sentinels = new Float32Array(stripWidth * 4);
    var failure = null;
    var released = false;

    var drawBuffers = [gl.COLOR_ATTACHMENT0];
    loTextures.forEach(function (_, k) { drawBuffers.push(gl.COLOR_ATTACHMENT0 + 1 + k); });
    function release() {
      if (released) return;
      released = true;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(logFbo);
      gl.deleteFramebuffer(stateFbo);
      gl.deleteTexture(states[0]);
      gl.deleteTexture(states[1]);
      gl.deleteTexture(texture);
      loTextures.concat(pads).forEach(function (t) { gl.deleteTexture(t); });
      if (pointsTexture) gl.deleteTexture(pointsTexture);
      entry.runs -= 1;
      if (entry.evicted && entry.runs === 0) gl.deleteProgram(prog);
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
    gl.bindFramebuffer(gl.FRAMEBUFFER, stateFbo);
    pads.forEach(function (t, k) { gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + 1 + k, gl.TEXTURE_2D, t, 0); });
    gl.drawBuffers(drawBuffers);

    // Everything the draws rely on, set again on each resume: another run may have used the context since.
    function bind() {
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
      gl.bindBuffer(gl.ARRAY_BUFFER, runner.quadBuffer);
      gl.enableVertexAttribArray(entry.posLoc);
      gl.vertexAttribPointer(entry.posLoc, 2, gl.FLOAT, false, 0, 0);
      if (pointsTexture) {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, pointsTexture);
        gl.uniform1i(u.points, 1);
      }
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform1i(u.state, 0);
    }

    function drawLog(base, rows, current) {
      gl.bindTexture(gl.TEXTURE_2D, states[current]);
      gl.uniform1i(u.init, base === 0 ? 1 : 0);
      gl.uniform1i(u.base, base);
      gl.uniform1i(u.advance, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, logFbo);
      gl.viewport(0, base, logWidth, rows);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    // Each chunk is timed and the next sized from it (TRAJECTORY_TARGET_MS); the time
    // includes the readback, erring safe. Growth caps at doubling; the size and the best per-step time are
    // kept with the program, scaled for a batch wider than the one they were measured on.
    var widthScale = Math.min(1, (entry.chunkRuns || 1) / count);
    var steps = Math.max(1, Math.floor((entry.chunkSteps || 1) * widthScale));
    var stepTimes = entry.stepMs ? [entry.stepMs / widthScale] : [];
    var current = 0, base = 0, run = 0;
    var phase = "chunks";
    var pixels = null, loPixels = null, glError = gl.NO_ERROR;
    var trajectories = [];

    function advance(until) {
      bind();
      // The first draw is where the driver really builds the program: spend it untimed.
      if (!entry.warmed) {
        drawLog(0, 1, 0);
        gl.readPixels(numBodies, 0, 1, 1, gl.RGBA, gl.FLOAT, sentinels);
        entry.warmed = true;
      }
      while (phase === "chunks") {
        if (base >= maxSteps || failure) {
          entry.chunkSteps = steps;
          entry.chunkRuns = count;
          entry.stepMs = stepTimes.length ? Math.min.apply(null, stepTimes) : 0;
          phase = "read";
          break;
        }
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
          var took = performance.now() - startedAt, perStep = took / (2 * rows);
          stepTimes.push(perStep);
          if (stepTimes.length > TRAJECTORY_TIMINGS_KEPT) stepTimes.shift();
          var want = Math.floor(TRAJECTORY_TARGET_MS / perStep);
          // A slow chunk may have waited behind another context's draws (the map's): below TRAJECTORY_SLOW_MS it
          // shrinks the next one only as far as the best recent timing says.
          if (took < TRAJECTORY_SLOW_MS) {
            want = Math.min(Math.floor(TRAJECTORY_TARGET_MS / Math.min.apply(null, stepTimes)), Math.max(rows, want));
          }
          steps = Math.max(1, Math.min(want, rows * 2, chunk.maxSteps));
          current = 1 - current;
        }
        base += rows;
        if (performance.now() >= until) return null;
      }

      if (phase === "read") {
        pixels = new Float32Array(logWidth * maxSteps * 4);
        loPixels = loTextures.map(function () { return new Float32Array(logWidth * maxSteps * 4); });
        if (!failure) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, logFbo);
          gl.readBuffer(gl.COLOR_ATTACHMENT0);
          gl.readPixels(0, 0, logWidth, maxSteps, gl.RGBA, gl.FLOAT, pixels);
          loPixels.forEach(function (buf, k) {
            gl.readBuffer(gl.COLOR_ATTACHMENT0 + 1 + k);
            gl.readPixels(0, 0, logWidth, maxSteps, gl.RGBA, gl.FLOAT, buf);
          });
          gl.readBuffer(gl.COLOR_ATTACHMENT0);
        }
        // The readback already waited for the GPU, so the error flag is free.
        glError = gl.getError();
        phase = "rows";
        if (performance.now() >= until) return null;
      }

      for (var firstRun = run; run < count && !failure; run++) {
        if (run > firstRun && performance.now() >= until) return null;
        trajectories.push(decodeRun(run));
      }

      release();
      if (glError !== gl.NO_ERROR) throw new Error("GPU physics draw failed (GL error 0x" + glError.toString(16) + ")");
      // A dropped draw reports no error: only the sentinel notices. Chunk size forgotten so the retry starts over.
      if (failure) {
        entry.chunkSteps = 1;
        entry.stepMs = 0;
        throw new Error("The GPU dropped a physics draw (" + failure + "): the scene is too heavy for it at this precision.");
      }
      return trajectories;
    }

    function decodeRun(run) {
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
      return trajectory;
    }

    return {
      advance: advance,
      progress: function () { return phase === "chunks" ? 0.9 * base / maxSteps : 0.9 + 0.1 * run / count; },
      cancel: release,
    };
  }

  function runSceneOnGPU(scene, maxSteps, precision) {
    return runCompiledTrajectoryOnGPU(compileSceneToTrajectoryGLSL(scene, maxSteps, precision), maxSteps);
  }

  global.PhysicsGPU = {
    MAX_BODIES: MAX_BODIES,
    runSceneOnGPU: runSceneOnGPU,
    runCompiledTrajectoryOnGPU: runCompiledTrajectoryOnGPU,
    runCompiledTrajectoriesOnGPU: runCompiledTrajectoriesOnGPU,
    startTrajectoryRun: startTrajectoryRun,
    trajectoryProgramPending: trajectoryProgramPending,
    setWarmGate: setWarmGate,
    pendingTrajectoryPrecisions: pendingTrajectoryPrecisions,
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
