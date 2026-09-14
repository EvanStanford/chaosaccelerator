// This file is part of Chaos Accelerator, licensed under the Common Public
// Attribution License, Version 1.0 (CPAL-1.0) - see LICENSE in the project
// root, or https://chaosaccelerator.com/license for a hosted copy.

// Double-float ("df") arithmetic for WebGL2 / GLSL ES 3.00.
//
// WHY THIS EXISTS
// ---------------
// Every pixel of the fractal grid is an independent simulation whose only
// difference from its neighbour is a tiny offset in the linked body
// property. GLSL's highp float is IEEE binary32: ~7 decimal digits, so at
// scene coordinates of order 10^3 the smallest distinguishable difference
// is ~10^-4 world units. Zoom the grid past that and neighbouring pixels
// round to the SAME float, so the image flattens into blocks. That is the
// 32-bit wall.
//
// A df value is an unevaluated sum of two float32s (hi + lo) with
// non-overlapping mantissas: ~48 significand bits (~14-15 decimal digits)
// for ~5-10x the ALU of a plain float. It is not float64 - the exponent
// range is still float32's - but the mantissa is what this project is
// short of, not the range.
//
// HOW IT WORKS
// ------------
// Everything is built from "error-free transformations": the float32
// result of an operation, plus the round-off that operation discarded,
// which is itself exactly representable. twoSum recovers the round-off of
// an add; twoProd does the same for a multiply, using a 12-bit/12-bit
// split of each operand so the partial products are exact (GLSL ES 3.00
// has no fma()).
//
// THE VEIL, AND WHY IT IS NOT OPTIONAL
// ------------------------------------
// twoSum's `(a - (s - bb)) + (b - bb)` is algebraically zero. It recovers
// anything at all only because IEEE rounding makes it NOT algebraically
// equivalent to its simplified form. A compiler that reassociates float
// arithmetic is free to fold it to nothing, and GLSL ES 3.00 has no
// `precise` qualifier to forbid that (it arrived in ES 3.20).
//
// This is not hypothetical. Measured on ANGLE's Metal backend (Apple
// silicon, the default for Chrome on macOS): `(a + b) - a` returns `b`,
// i.e. fast-math reassociation is on, and every unprotected EFT above
// returns an error term of exactly 0.0 - silently, with no warning, and
// with results that look plausible right up until you zoom in.
//
// dfv() is the fix: a bitcast to uint, an XOR against a uniform that
// happens to hold 0, and a bitcast back. It is the identity at runtime,
// but the optimizer cannot see through the uniform, so every expression
// it wraps becomes an opaque symbol that no algebraic rewrite applies to.
// Costs about one integer op (the bitcasts are register reinterpretation,
// not work). Every shader including this library must therefore declare
// `uniform uint u_dfVeil;` - DF_UNIFORM_DECL below - and leave it at its
// default of 0. df-probe.html measures all of this directly on whatever
// machine it is opened on, and physics-tests.js carries the same check as
// a regression test, because the failure mode is invisible otherwise.
(function (global) {
  "use strict";

  var f32 = Math.fround;

  // Split a JS number (already float64) into the two float32s whose sum
  // reproduces it to ~48 bits. This is the ONLY place the extra precision
  // enters the GPU: JS has had it all along - uploading a single float32
  // uniform is what was throwing it away.
  function split(x) {
    var hi = f32(x);
    if (!isFinite(hi)) return [isFinite(x) ? 0 : hi, 0];
    return [hi, f32(x - hi)];
  }

  // A GLSL float literal that survives a round trip. Same idea as
  // physics-gpu.js's fnum, duplicated so this file has no load-order
  // dependency on it.
  function fnum(n) {
    if (!isFinite(n)) n = 0;
    if (Object.is(n, -0)) n = 0;
    var s = String(n);
    if (s.indexOf(".") === -1 && s.indexOf("e") === -1 && s.indexOf("E") === -1) s += ".0";
    return s;
  }

  // A df literal: `vec2(hi, lo)`.
  function num(x) {
    var p = split(x);
    return "vec2(" + fnum(p[0]) + ", " + fnum(p[1]) + ")";
  }

  var TWO_PI = split(Math.PI * 2);

  // Must appear in every shader that includes GLSL_LIBRARY. Never assigned
  // - a uniform's default value is 0 by spec, which is exactly the identity
  // dfv() needs, and leaving it unset is what keeps it opaque.
  var UNIFORM_DECL = "uniform uint u_dfVeil;";

  // ---- Constants for the df sin/cos below, generated rather than
  // transcribed (a mistyped digit in a 17-digit constant is exactly the
  // kind of bug this whole file exists to avoid). ----

  // Round x to 12 significand bits. A float carrying only 12 bits
  // multiplies EXACTLY by any integer up to 2^12, which is what makes
  // Cody-Waite range reduction work.
  function trimTo12Bits(x) {
    var v = f32(x);
    if (v === 0 || !isFinite(v)) return 0;
    var q = Math.pow(2, Math.floor(Math.log2(Math.abs(v))) - 11);
    return f32(Math.round(v / q) * q);
  }

  // Split `value` into `count` floats summing to it, all but the last
  // trimmed to 12 bits. Four 12-bit pieces plus a 24-bit tail carries
  // pi/2 to ~72 bits - far past df's own 48.
  function codyWaitePieces(value, count) {
    var pieces = [], rest = value;
    for (var i = 0; i < count - 1; i++) {
      var p = trimTo12Bits(rest);
      pieces.push(p);
      rest = rest - p;
    }
    pieces.push(f32(rest));
    return pieces;
  }

  function factorial(n) { var r = 1; for (var i = 2; i <= n; i++) r *= i; return r; }

  // Horner in df: c[0] + u*(c[1] + u*(c[2] + ...)), optionally times x.
  function hornerGLSL(name, coeffs, multiplyByX) {
    var lines = ["vec2 " + name + "(vec2 x) {", "  vec2 u = dfMul(x, x);",
      "  vec2 p = " + num(coeffs[coeffs.length - 1]) + ";"];
    for (var i = coeffs.length - 2; i >= 0; i--) {
      lines.push("  p = dfAdd(dfMul(p, u), " + num(coeffs[i]) + ");");
    }
    lines.push("  return " + (multiplyByX ? "dfMul(x, p)" : "p") + ";", "}");
    return lines.join("\n");
  }

  var HALF_PI_PIECES = codyWaitePieces(Math.PI / 2, 5);
  var HALF_PI_DECLS = HALF_PI_PIECES.map(function (p, i) {
    return "const float DF_HPI_" + i + " = " + fnum(p) + ";";
  }).join("\n");

  // sin(x)/x and cos(x) as series in u = x^2. Enough terms that the first
  // DROPPED one is below 1e-16 at |x| = pi/4, i.e. under df's resolution.
  var SIN_COEFFS = [], COS_COEFFS = [];
  for (var si = 0; si <= 8; si++) SIN_COEFFS.push((si % 2 ? -1 : 1) / factorial(2 * si + 1));
  for (var cj = 0; cj <= 9; cj++) COS_COEFFS.push((cj % 2 ? -1 : 1) / factorial(2 * cj));

  var GLSL_LIBRARY = [
    "// ---- Double-float (df) arithmetic: a value is vec2(hi, lo) = hi + lo ----",
    "// See physics-df.js's header for what these are, and for why dfv()",
    "// wraps what look like pointless identities (short version: without",
    "// it, ANGLE/Metal folds every error term below to exactly 0.0).",
    "",
    "const vec2 DF_TWO_PI = vec2(" + fnum(TWO_PI[0]) + ", " + fnum(TWO_PI[1]) + ");",
    "",
    "// The optimizer barrier. u_dfVeil is 0, so this is the identity - but",
    "// that is only knowable at runtime, so no algebraic rewrite can reach",
    "// across it.",
    "float dfv(float x) { return uintBitsToFloat(floatBitsToUint(x) ^ u_dfVeil); }",
    "",
    "vec2 dfFromFloat(float a) { return vec2(a, 0.0); }",
    "float dfToFloat(vec2 a) { return a.x + a.y; }",
    "vec2 dfNeg(vec2 a) { return vec2(-a.x, -a.y); }",
    "",
    "// Requires |a| >= |b|. Two float ops instead of twoSum's six.",
    "vec2 dfQuickTwoSum(float a, float b) {",
    "  float s = dfv(a + b);",
    "  float e = dfv(b - dfv(s - a));",
    "  return vec2(s, e);",
    "}",
    "",
    "// Knuth's twoSum: exact for any a, b. s is the rounded sum; e is",
    "// exactly the part of a+b that rounding discarded.",
    "vec2 dfTwoSum(float a, float b) {",
    "  float s = dfv(a + b);",
    "  float bb = dfv(s - a);",
    "  float e = dfv(dfv(a - dfv(s - bb)) + dfv(b - bb));",
    "  return vec2(s, e);",
    "}",
    "",
    "// Split into two 12-significand-bit halves so that every partial",
    "// product in dfTwoProd is exact. Masking off the low 12 mantissa bits",
    "// does this directly - cheaper than Dekker's 4097*a trick, with no",
    "// overflow edge case, and inherently opaque to the optimizer since it",
    "// goes through integer bit operations. `a - hi` is then exact (hi has",
    "// a's sign and exponent and a smaller magnitude).",
    "vec2 dfSplit(float a) {",
    "  float hi = uintBitsToFloat(floatBitsToUint(a) & 0xfffff000u);",
    "  return vec2(hi, a - hi);",
    "}",
    "",
    "vec2 dfTwoProd(float a, float b) {",
    "  float p = dfv(a * b);",
    "  vec2 as = dfSplit(a);",
    "  vec2 bs = dfSplit(b);",
    "  float e = dfv(dfv(dfv(dfv(as.x * bs.x) - p) + dfv(as.x * bs.y)) + dfv(as.y * bs.x));",
    "  e = dfv(e + dfv(as.y * bs.y));",
    "  return vec2(p, e);",
    "}",
    "",
    "vec2 dfAdd(vec2 a, vec2 b) {",
    "  vec2 s = dfTwoSum(a.x, b.x);",
    "  vec2 t = dfTwoSum(a.y, b.y);",
    "  s.y = dfv(s.y + t.x);",
    "  s = dfQuickTwoSum(s.x, s.y);",
    "  s.y = dfv(s.y + t.y);",
    "  return dfQuickTwoSum(s.x, s.y);",
    "}",
    "",
    "// The hot path: a df accumulator plus an ordinary float32 increment.",
    "// Every integrate/impulse site in the engine is this shape - the",
    "// increment is small and was computed in plain float32.",
    "vec2 dfAddFloat(vec2 a, float b) {",
    "  vec2 s = dfTwoSum(a.x, b);",
    "  s.y = dfv(s.y + a.y);",
    "  return dfQuickTwoSum(s.x, s.y);",
    "}",
    "",
    "vec2 dfSub(vec2 a, vec2 b) { return dfAdd(a, dfNeg(b)); }",
    "vec2 dfSubFloat(vec2 a, float b) { return dfAddFloat(a, -b); }",
    "",
    "vec2 dfMul(vec2 a, vec2 b) {",
    "  vec2 p = dfTwoProd(a.x, b.x);",
    "  p.y = dfv(p.y + dfv(dfv(a.x * b.y) + dfv(a.y * b.x)));",
    "  return dfQuickTwoSum(p.x, p.y);",
    "}",
    "",
    "vec2 dfMulFloat(vec2 a, float b) {",
    "  vec2 p = dfTwoProd(a.x, b);",
    "  p.y = dfv(p.y + dfv(a.y * b));",
    "  return dfQuickTwoSum(p.x, p.y);",
    "}",
    "",
    "// A float32 quotient, then two correction rounds against the df",
    "// remainder - the standard Newton-style df division.",
    "vec2 dfDiv(vec2 a, vec2 b) {",
    "  float q1 = a.x / b.x;",
    "  vec2 r = dfSub(a, dfMulFloat(b, q1));",
    "  float q2 = r.x / b.x;",
    "  r = dfSub(r, dfMulFloat(b, q2));",
    "  float q3 = r.x / b.x;",
    "  vec2 q = dfQuickTwoSum(q1, q2);",
    "  return dfAddFloat(q, q3);",
    "}",
    "",
    "vec2 dfDivFloat(vec2 a, float b) { return dfDiv(a, vec2(b, 0.0)); }",
    "",
    "// Ordering. dfToFloat() would collapse exactly the distinction these",
    "// exist to preserve, so compare hi first and fall through to lo.",
    "bool dfLess(vec2 a, vec2 b) { return a.x < b.x || (a.x == b.x && a.y < b.y); }",
    "bool dfGreater(vec2 a, vec2 b) { return a.x > b.x || (a.x == b.x && a.y > b.y); }",
    "",
    "// GLSL's mod(a, m) == a - m * floor(a / m): always in [0, m) for m > 0,",
    "// which is the property the frame-wrap rules rely on. floor() of the",
    "// float32 quotient can land one off when a/m is a hair from an integer,",
    "// so the two guards below put it back.",
    "vec2 dfMod(vec2 a, float m) {",
    "  float k = floor(dfToFloat(a) / m);",
    "  vec2 r = dfSub(a, dfMulFloat(vec2(m, 0.0), k));",
    "  if (dfLess(r, vec2(0.0, 0.0))) r = dfAddFloat(r, m);",
    "  if (!dfLess(r, vec2(m, 0.0))) r = dfSubFloat(r, m);",
    "  return r;",
    "}",
    "",
    "// ---- Angle reduction, and sin/cos done entirely in df ----",
    "//",
    "// Hardware sin/cos are float32 functions with float32-sized error of",
    "// their own - measured at ~2.5e-10 relative on Apple silicon, which",
    "// throws away five of df's digits no matter how precise the argument",
    "// handed to them is. Correcting only the ARGUMENT (the usual",
    "// cos(hi+lo) = cos(hi) - sin(hi)*lo trick) does not help with that, so",
    "// this evaluates the FUNCTION in df too: Cody-Waite range reduction",
    "// down to [-pi/4, pi/4], then a Taylor series.",
    "//",
    "// Not on any hot path. Only the per-pixel initial-state cascade",
    "// rotates about a df angle; the step loop runs in float32 inside a",
    "// local frame, so it uses the hardware trig as before.",
    HALF_PI_DECLS,
    "const float DF_INV_HALF_PI = " + fnum(f32(2 / Math.PI)) + ";",
    "",
    "// Subtract k*(pi/2) piecewise. Every DF_HPI_0..3 carries only 12",
    "// significand bits, so each k*piece is EXACT for |k| < 2^12 (~4000",
    "// turns) and the reduced angle keeps all 48 bits. Reducing against a",
    "// single df 2pi instead would leave a k*2^-48*2pi residue - 3.5e-11 at",
    "// 1e4 radians, which is the entire reason this is spelled out.",
    "vec2 dfReduceQuadrant(vec2 a, out int quadrant) {",
    "  float k = floor(dfToFloat(a) * DF_INV_HALF_PI + 0.5);",
    "  vec2 r = a;",
    "  r = dfSubFloat(r, k * DF_HPI_0);",
    "  r = dfSubFloat(r, k * DF_HPI_1);",
    "  r = dfSubFloat(r, k * DF_HPI_2);",
    "  r = dfSubFloat(r, k * DF_HPI_3);",
    "  r = dfSubFloat(r, k * DF_HPI_4);",
    "  quadrant = int(mod(k, 4.0) + 4.5) - 4;",
    "  return r;",
    "}",
    "",
    // Series in u = x*x, carried far enough that the first dropped term is
    // below 1e-16 at |x| = pi/4.
    hornerGLSL("dfSinTaylor", SIN_COEFFS, true),
    hornerGLSL("dfCosTaylor", COS_COEFFS, false),
    "",
    "void dfSinCos(vec2 a, out vec2 sn, out vec2 cs) {",
    "  // Exact fast path, and not a micro-optimisation: the hinge solvers",
    "  // rotate BOTH sides of every joint, and one side is very often the",
    "  // world pin, whose angle is a hard zero. Without this, a world-hinged",
    "  // scene spends half its trig budget evaluating a Taylor series to",
    "  // learn that sin(0) = 0. The branch is uniform across pixels for that",
    "  // case, so it costs nothing in divergence either.",
    "  if (a.x == 0.0 && a.y == 0.0) { sn = vec2(0.0, 0.0); cs = vec2(1.0, 0.0); return; }",
    "  int q;",
    "  vec2 x = dfReduceQuadrant(a, q);",
    "  vec2 sx = dfSinTaylor(x);",
    "  vec2 cx = dfCosTaylor(x);",
    "  if (q == 0) { sn = sx; cs = cx; }",
    "  else if (q == 1) { sn = cx; cs = dfNeg(sx); }",
    "  else if (q == 2) { sn = dfNeg(sx); cs = dfNeg(cx); }",
    "  else { sn = dfNeg(cx); cs = sx; }",
    "}",
    "vec2 dfCos(vec2 a) { vec2 s, c; dfSinCos(a, s, c); return c; }",
    "vec2 dfSin(vec2 a) { vec2 s, c; dfSinCos(a, s, c); return s; }",
    "",
    "// Fold an angle into [0, 2pi). Used wherever an accumulated angle has",
    "// to be handed to float32 code: reducing first keeps that float32",
    "// value's resolution at ~1e-7 rad however many turns the body has",
    "// taken, instead of degrading with the turn count.",
    "// Reuses the quadrant reduction above rather than a dfMod against a df",
    "// 2pi, for the same range-reduction-accuracy reason: a mod 2pi is",
    "// (a - k*pi/2) + (k mod 4)*pi/2, and every piece of that is exact.",
    "vec2 dfReduceAngle(vec2 a) {",
    "  int q;",
    "  vec2 r = dfReduceQuadrant(a, q);",
    "  float qf = float(q < 0 ? q + 4 : q);",
    "  r = dfAddFloat(r, qf * DF_HPI_0);",
    "  r = dfAddFloat(r, qf * DF_HPI_1);",
    "  r = dfAddFloat(r, qf * DF_HPI_2);",
    "  r = dfAddFloat(r, qf * DF_HPI_3);",
    "  r = dfAddFloat(r, qf * DF_HPI_4);",
    "  if (dfLess(r, vec2(0.0, 0.0))) r = dfAdd(r, DF_TWO_PI);",
    "  if (!dfLess(r, DF_TWO_PI)) r = dfSub(r, DF_TWO_PI);",
    "  return r;",
    "}",
    "vec2 dfAbs(vec2 a) { return a.x < 0.0 ? dfNeg(a) : a; }",
    "",
    "// A 2D point in df. Only the per-pixel initial-state cascade needs",
    "// this (it rotates hinge anchors about df angles); the physics itself",
    "// runs in plain vec2 inside a local frame.",
    "// Newton's x' = (x + a/x)/2, seeded with the hardware float32 sqrt.",
    "// One step squares the ~6e-8 relative error of that seed into ~2e-15 -",
    "// within an order of magnitude of df's own 1e-16 floor, so a second",
    "// step would buy nothing a df value can hold.",
    "vec2 dfSqrt(vec2 a) {",
    "  if (a.x <= 0.0) return vec2(0.0, 0.0);",
    "  float s = sqrt(a.x);",
    "  return dfMulFloat(dfAdd(vec2(s, 0.0), dfDiv(a, vec2(s, 0.0))), 0.5);",
    "}",
    "",
    "vec2 dfMin(vec2 a, vec2 b) { return dfLess(a, b) ? a : b; }",
    "vec2 dfMax(vec2 a, vec2 b) { return dfLess(a, b) ? b : a; }",
    "vec2 dfClamp(vec2 v, vec2 lo, vec2 hi) { return dfMin(dfMax(v, lo), hi); }",
    "",
    "// Same cubic GLSL's smoothstep uses: t*t*(3 - 2t) on the clamped ramp.",
    "vec2 dfSmoothstep(vec2 e0, vec2 e1, vec2 x) {",
    "  vec2 span = dfSub(e1, e0);",
    "  if (span.x == 0.0 && span.y == 0.0) return dfLess(x, e0) ? vec2(0.0, 0.0) : vec2(1.0, 0.0);",
    "  vec2 t = dfClamp(dfDiv(dfSub(x, e0), span), vec2(0.0, 0.0), vec2(1.0, 0.0));",
    "  return dfMul(dfMul(t, t), dfSub(vec2(3.0, 0.0), dfMulFloat(t, 2.0)));",
    "}",
    "",
    "// ---- 2D vectors in df ----",
    "// A DVec2 is two df scalars, not a df-ified vec2 - GLSL has no way to",
    "// give a user type component-wise operators, so every operation is",
    "// spelled out. Only the physics port needs these; the per-pixel cascade",
    "// uses DVec2 purely as a rotation result.",
    "struct DVec2 { vec2 x; vec2 y; };",
    "DVec2 dv2(vec2 x, vec2 y) { DVec2 r; r.x = x; r.y = y; return r; }",
    "DVec2 dv2Zero() { return dv2(vec2(0.0, 0.0), vec2(0.0, 0.0)); }",
    "DVec2 dv2FromVec2(vec2 v) { return dv2(vec2(v.x, 0.0), vec2(v.y, 0.0)); }",
    "vec2 dv2ToVec2(DVec2 a) { return vec2(dfToFloat(a.x), dfToFloat(a.y)); }",
    "DVec2 dv2Add(DVec2 a, DVec2 b) { return dv2(dfAdd(a.x, b.x), dfAdd(a.y, b.y)); }",
    "DVec2 dv2Sub(DVec2 a, DVec2 b) { return dv2(dfSub(a.x, b.x), dfSub(a.y, b.y)); }",
    "DVec2 dv2Neg(DVec2 a) { return dv2(dfNeg(a.x), dfNeg(a.y)); }",
    "DVec2 dv2Scale(DVec2 a, vec2 s) { return dv2(dfMul(a.x, s), dfMul(a.y, s)); }",
    "vec2 dv2Dot(DVec2 a, DVec2 b) { return dfAdd(dfMul(a.x, b.x), dfMul(a.y, b.y)); }",
    "vec2 dv2Cross(DVec2 a, DVec2 b) { return dfSub(dfMul(a.x, b.y), dfMul(a.y, b.x)); }",
    "vec2 dv2LengthSq(DVec2 a) { return dv2Dot(a, a); }",
    "vec2 dv2Length(DVec2 a) { return dfSqrt(dv2Dot(a, a)); }",
    "DVec2 dv2Perp(DVec2 a) { return dv2(dfNeg(a.y), a.x); }",
    "",
    "// Rotation with sin/cos supplied by the caller. Every solver iteration",
    "// rotates an anchor about a body's angle, and a df sin/cos is by far",
    "// the most expensive thing in the library - so the callers hoist it out",
    "// of their loops and pass it in, rather than paying for it per rotate.",
    "DVec2 dv2RotateBy(DVec2 v, vec2 sn, vec2 cs) {",
    "  return dv2(dfSub(dfMul(v.x, cs), dfMul(v.y, sn)),",
    "             dfAdd(dfMul(v.x, sn), dfMul(v.y, cs)));",
    "}",
    "DVec2 dfRotate(vec2 vx, vec2 vy, vec2 angle) {",
    "  vec2 sn, cs;",
    "  dfSinCos(angle, sn, cs);",
    "  return dv2RotateBy(dv2(vx, vy), sn, cs);",
    "}",
  ].join("\n");

  global.PhysicsDF = {
    split: split,
    num: num,
    fnum: fnum,
    UNIFORM_DECL: UNIFORM_DECL,
    GLSL_LIBRARY: GLSL_LIBRARY,
  };
})(typeof window !== "undefined" ? window : globalThis);
