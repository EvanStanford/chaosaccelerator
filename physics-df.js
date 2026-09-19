// This file is part of Chaos Accelerator, licensed under the Common Public
// Attribution License, Version 1.0 (CPAL-1.0) - see LICENSE in the project
// root, or https://chaosaccelerator.com/license for a hosted copy.

// Multi-float arithmetic for WebGL2 / GLSL ES 3.00: double-float ("df", two
// float32 words), triple-float ("tf", three) and quad-float ("qf", four).
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
//
// MORE THAN TWO WORDS
// -------------------
// The same idea carried further: a value is the unevaluated sum of N
// float32 words, each below the rounding error of the one before it, for
// ~24 bits of significand per word less a few lost to the algorithms -
// about 14 digits at two words, 21 at three, 28 at four. One library serves
// all of them. Every function keeps its "df" name whatever N is, and the
// scalar type is spelled MF, a macro this file defines as vec2, vec3 or
// vec4 - a shader is only ever built for one precision, so there is nothing
// for the names to collide with, and the physics port and the code
// generators are written once against MF.
//
// Two words is the hand-tuned case and its text is exactly what it was
// before the others existed. Three and four are GENERATED (see genAdd,
// genMul and friends): the structure is the same at every N - an error-free
// sum or product per pair of words, the errors cascaded down one level at a
// time, a renormalization at the end - so it is written as a loop here and
// unrolled into the GLSL. The algorithms are the quad-double library's
// "sloppy" forms (Hida, Li & Bailey), chosen for the same reason the
// two-word add is: what this project needs is absolute precision at the
// scale of the scene's coordinates, not a correctly rounded last bit.
//
// That far is as far as float32 words go. A fifth word of a coordinate of
// order 10^3 sits around 10^-33, a sixth around 10^-41 - below float32's
// smallest normal number, where GPUs are not obliged to keep anything.
//
// Constants past two words cannot come from a JS number, which only has 53
// bits to give: pi and the Taylor coefficients are generated from exact
// BigInt rationals (rationalWords). A value the scene itself supplies - an
// authored coordinate - is a float64 and simply has zeros in its low words.
(function (global) {
  "use strict";

  var f32 = Math.fround;

  // ---- Precisions ----
  //
  // The names the rest of the project passes around, and how many float32
  // words each carries. "f32" is here so that one table answers every
  // "which precision is this" question; nothing in this file is used for it.
  var WORDS = { f32: 1, df: 2, tf: 3, qf: 4 };
  var ORDER = ["f32", "df", "tf", "qf"];
  function wordsFor(precision) { return WORDS[precision] || 1; }
  function isExtended(precision) { return wordsFor(precision) > 1; }
  // float32 words can carry a value no further than this - see the header.
  // BigInt is what the constants past two words are generated with.
  function isSupported(precision) {
    return wordsFor(precision) <= 2 || typeof BigInt === "function";
  }

  // How many words num() writes, and buildLibrary() builds for by default.
  // Code generation for one shader runs start to finish without yielding,
  // so whoever starts one says which precision it is for (usePrecision) and
  // everything it calls - here and in physics-gpu-df.js - agrees.
  var currentWords = 2;
  function usePrecision(precision) {
    currentWords = Math.max(2, wordsFor(precision));
    return currentWords;
  }

  // Split a JS number (already float64) into the two float32s whose sum
  // reproduces it to ~48 bits. This is the ONLY place the extra precision
  // enters the GPU: JS has had it all along - uploading a single float32
  // uniform is what was throwing it away.
  function split(x) {
    var hi = f32(x);
    if (!isFinite(hi)) return [isFinite(x) ? 0 : hi, 0];
    return [hi, f32(x - hi)];
  }

  function twoSum64(a, b) {
    var s = a + b, bb = s - a;
    return [s, (a - (s - bb)) + (b - bb)];
  }

  // [p, e] with p + e = a * b EXACTLY, p the rounded product - Dekker's
  // split, since JavaScript has no fused multiply-add to get the error term
  // from. (2^27 + 1 splits a float64's 53 bits into halves whose products
  // are exact. Fine for anything within 2^970 or so of overflow, which a
  // view's scale is.)
  function twoProd64(a, b) {
    var p = a * b;
    var t = 134217729 * a, ah = t - (t - a), al = a - ah;
    t = 134217729 * b;
    var bh = t - (t - b), bl = b - bh;
    return [p, ((ah * bh - p) + ah * bl + al * bh) + al * bl];
  }

  // The same for a DOUBLE-DOUBLE - hi + lo, both float64, ~106 bits, which
  // is how the grid holds its view centre once a float64 alone can no longer
  // tell two pixels apart - into `count` float32 words. Each word is the
  // remainder rounded to float32, and `remainder - word` is exact in
  // float64 (the word agrees with the remainder's leading 24 bits), so
  // nothing is lost on the way down.
  function splitWords(hi, lo, count) {
    var words = [], rh = hi, rl = lo || 0;
    for (var i = 0; i < count; i++) {
      var w = f32(rh);
      if (!isFinite(w)) w = 0;
      words.push(w);
      var t = twoSum64(rh - w, rl);
      rh = t[0]; rl = t[1];
    }
    return words;
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

  function literal(words) { return "vec" + words.length + "(" + words.map(fnum).join(", ") + ")"; }

  // A literal at the current precision: `vec2(hi, lo)`, `vec3(...)`, ...
  function num(x) { return literal(splitWords(x, 0, currentWords)); }

  var TWO_PI = split(Math.PI * 2);

  // Must appear in every shader that includes GLSL_LIBRARY. Never assigned
  // - a uniform's default value is 0 by spec, which is exactly the identity
  // dfv() needs, and leaving it unset is what keeps it opaque.
  var UNIFORM_DECL = "uniform uint u_dfVeil;";

  // ---- Exact constants, for more words than a float64 has bits ----

  function big(n) { return BigInt(n); }
  function bitLength(v) { return (v < big(0) ? -v : v).toString(2).length; }

  // p/q as a float64, to float64's own accuracy, for BigInts far outside
  // float64's exact range.
  function ratioToNumber(p, q) {
    if (p === big(0)) return 0;
    var shift = 80 - (bitLength(p) - bitLength(q));
    var t = shift >= 0 ? (p << big(shift)) / q : p / (q << big(-shift));
    return Number(t) * Math.pow(2, -shift);
  }

  // A float32 as m * 2^e, exactly.
  function exactFloat32(w) {
    var view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, w);
    var bits = view.getUint32(0);
    var sign = bits >>> 31 ? -1 : 1, expBits = (bits >>> 23) & 0xff, frac = bits & 0x7fffff;
    if (expBits === 0) return { m: big(sign * frac), e: -149 };
    return { m: big(sign * (frac + 0x800000)), e: expBits - 150 };
  }

  // The rational p/q minus a float32, exactly, as a new [p, q].
  function subtractFloat32(p, q, w) {
    var x = exactFloat32(w);
    if (x.e >= 0) return [p - x.m * (big(1) << big(x.e)) * q, q];
    var scale = big(1) << big(-x.e);
    return [p * scale - x.m * q, q * scale];
  }

  // p/q as `count` float32 words.
  function rationalWords(p, q, count) {
    var words = [];
    for (var i = 0; i < count; i++) {
      var w = f32(ratioToNumber(p, q));
      words.push(w);
      var r = subtractFloat32(p, q, w);
      p = r[0]; q = r[1];
    }
    return words;
  }

  function bigFactorial(n) { var r = big(1); for (var i = 2; i <= n; i++) r *= big(i); return r; }

  // pi, to far more digits than four words can hold.
  var PI_DIGITS = "314159265358979323846264338327950288419716939937510582097494459230781640628620899";
  function piRational() { return [big(PI_DIGITS), big(10) ** big(PI_DIGITS.length - 1)]; }

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

  // The same from an exact rational, for as many pieces as it takes: 12 bits
  // each and a 24-bit tail has to reach past the last word of the result.
  function codyWaitePiecesExact(p, q, count) {
    var pieces = [];
    for (var i = 0; i < count - 1; i++) {
      var piece = trimTo12Bits(ratioToNumber(p, q));
      pieces.push(piece);
      var r = subtractFloat32(p, q, piece);
      p = r[0]; q = r[1];
    }
    pieces.push(f32(ratioToNumber(p, q)));
    return pieces;
  }

  function factorial(n) { var r = 1; for (var i = 2; i <= n; i++) r *= i; return r; }

  // Horner in df: c[0] + u*(c[1] + u*(c[2] + ...)), optionally times x.
  // `literals` are GLSL text already, one per coefficient.
  function hornerGLSL(name, literals, multiplyByX, square) {
    var lines = ["MF " + name + "(MF x) {", "  MF u = " + square + ";",
      "  MF p = " + literals[literals.length - 1] + ";"];
    for (var i = literals.length - 2; i >= 0; i--) {
      lines.push("  p = dfAdd(dfMul(p, u), " + literals[i] + ");");
    }
    lines.push("  return " + (multiplyByX ? "dfMul(x, p)" : "p") + ";", "}");
    return lines.join("\n");
  }

  // sin(x)/x and cos(x) as series in u = x^2. Enough terms that the first
  // DROPPED one is below 1e-16 at |x| = pi/4, i.e. under df's resolution.
  var SIN_COEFFS = [], COS_COEFFS = [];
  for (var si = 0; si <= 8; si++) SIN_COEFFS.push((si % 2 ? -1 : 1) / factorial(2 * si + 1));
  for (var cj = 0; cj <= 9; cj++) COS_COEFFS.push((cj % 2 ? -1 : 1) / factorial(2 * cj));

  // The same two series for N words: as many terms as it takes for the first
  // dropped one to fall below the last word at |x| = pi/4, each coefficient
  // an exact +-1/k! carried to N words. `offset` is 1 for sin(x)/x (odd
  // factorials) and 0 for cos (even).
  function taylorLiterals(words, offset) {
    var bound = Math.pow(2, -(24 * words + 8)), lits = [], x = Math.PI / 4;
    for (var k = 0; k < 40; k++) {
      var n = 2 * k + offset;
      if (Math.pow(x, n) / factorial(n) < bound) break;
      lits.push(literal(rationalWords(big(k % 2 ? -1 : 1), bigFactorial(n), words)));
    }
    return lits;
  }

  // ---- Kernel options ----
  //
  // Three of the two-word kernels below exist in two forms, because which
  // one is right is a measurement rather than an argument - df-probe.html
  // and physics-tests.js both render with either and compare. The defaults
  // are what that measurement chose; the alternatives stay buildable so the
  // comparison can be re-run on a new GPU or driver.
  //
  //   sloppyAdd  Dekker's add (11 float ops) in place of the IEEE-style one
  //              (20). Both carry ~48 bits of the OPERANDS; they differ only
  //              under heavy cancellation, where the accurate form returns
  //              the small result to 48 of ITS OWN bits and the sloppy one
  //              to 48 bits of the operands' magnitude. Every coordinate
  //              here is already rounded to the operands' magnitude, so the
  //              extra digits the accurate form keeps describe rounding
  //              noise, not the scene. Measured: about one bit at the very
  //              edge of df's range, for about a fifth off every df pixel.
  //   fastDiv    Two quotient words instead of three. The third is the
  //              correctly-rounded-last-bit word (~2^-48 of the quotient);
  //              dropping it costs at most about one df ulp. Measured: no
  //              visible difference.
  //   fastSqrt   s + (a - s*s) / 2s with the correction taken in float32,
  //              instead of a full df division. The correction is at most
  //              ~2^-23 of the root, so float32's 24 bits place it to ~2^-47.
  //              Measured: no visible difference.
  //
  //   words      2, 3 or 4 - defaults to whatever usePrecision() last set.
  //              The three options above only apply at 2; past that there
  //              is one form of each kernel, the generated one.
  var DEFAULT_OPTIONS = { sloppyAdd: true, fastDiv: true, fastSqrt: true };

  // ---- The generated kernels, for three and four words ----

  var COMP = ["x", "y", "z", "w"];

  // Sums `terms` (GLSL float expressions, all of one level of the cascade)
  // into `into`. While `exact`, every rounding error is captured by a
  // dfTwoSum and returned, to be added one level down; at the last level
  // they are simply let go, which is what bounds the result at N words.
  function genAccumulate(lines, into, terms, exact, tag) {
    var carries = [];
    if (!exact) {
      lines.push("  float " + into + " = dfv(" + terms.join(" + ") + ");");
      return carries;
    }
    var acc = terms[0];
    for (var i = 1; i < terms.length; i++) {
      var v = tag + "_" + i;
      lines.push("  vec2 " + v + " = dfTwoSum(" + acc + ", " + terms[i] + ");");
      acc = v + ".x";
      carries.push(v + ".y");
    }
    lines.push("  float " + into + " = " + acc + ";");
    return carries;
  }

  // The tail every generated kernel shares: `levels[k]` holds the terms of
  // magnitude ~2^(-24k) relative to the result.
  function genCascade(lines, levels, N) {
    var carries = [], names = [];
    for (var k = 0; k < N; k++) {
      var terms = (levels[k] || []).concat(carries);
      carries = genAccumulate(lines, "c" + k, terms.length ? terms : ["0.0"], k < N - 1, "k" + k);
      names.push("c" + k);
    }
    lines.push("  return dfRenorm(" + names.join(", ") + ");");
  }

  // N roughly ordered, possibly overlapping words into N that don't: one
  // pass up (each word absorbs everything below it, shedding an exact
  // error), one pass down (the errors become the low words). dfTwoSum
  // rather than dfQuickTwoSum wherever which operand is larger is not
  // certain - after a cancellation it isn't - because a quick-sum with its
  // operands the wrong way round returns a wrong error term and says nothing.
  function genRenorm(N) {
    var args = [], lines = [];
    for (var i = 0; i < N; i++) args.push("float c" + i);
    lines.push("MF dfRenorm(" + args.join(", ") + ") {");
    lines.push("  vec2 s = dfTwoSum(c" + (N - 2) + ", c" + (N - 1) + ");");
    lines.push("  float e" + (N - 1) + " = s.y;");
    for (var j = N - 3; j >= 0; j--) {
      lines.push("  s = dfTwoSum(c" + j + ", s.x);");
      lines.push("  float e" + (j + 1) + " = s.y;");
    }
    lines.push("  vec2 r = dfQuickTwoSum(s.x, e1);");
    lines.push("  float w0 = r.x;");
    for (var d = 1; d < N - 1; d++) {
      lines.push("  r = dfTwoSum(r.y, e" + (d + 1) + ");");
      lines.push("  float w" + d + " = r.x;");
    }
    var out = [];
    for (var o = 0; o < N - 1; o++) out.push("w" + o);
    out.push("r.y");
    lines.push("  return MF(" + out.join(", ") + ");", "}");
    return lines.join("\n");
  }

  function genAdd(N) {
    var lines = ["MF dfAdd(MF a, MF b) {"], levels = [];
    for (var i = 0; i < N; i++) {
      lines.push("  vec2 s" + i + " = dfTwoSum(a." + COMP[i] + ", b." + COMP[i] + ");");
      (levels[i] = levels[i] || []).push("s" + i + ".x");
      if (i + 1 < N) (levels[i + 1] = levels[i + 1] || []).push("s" + i + ".y");
    }
    genCascade(lines, levels, N);
    lines.push("}");
    return lines.join("\n");
  }

  function genAddFloat(N) {
    var lines = ["MF dfAddFloat(MF a, float b) {", "  vec2 s0 = dfTwoSum(a.x, b);"], levels = [["s0.x"], ["a.y", "s0.y"]];
    for (var i = 2; i < N; i++) levels[i] = ["a." + COMP[i]];
    genCascade(lines, levels, N);
    lines.push("}");
    return lines.join("\n");
  }

  // Products a_i * b_j land on level i + j. Below the last level each is a
  // dfTwoProd, whose error term lands one level down; ON the last level a
  // plain product is all that can be kept anyway. Operands are split once
  // each rather than once per product they appear in.
  function genMul(N) {
    var lines = ["MF dfMul(MF a, MF b) {"], levels = [];
    for (var s = 0; s < N - 1; s++) {
      lines.push("  vec2 as" + s + " = dfSplit(a." + COMP[s] + ");");
      lines.push("  vec2 bs" + s + " = dfSplit(b." + COMP[s] + ");");
    }
    for (var i = 0; i < N; i++) {
      for (var j = 0; i + j < N; j++) {
        var k = i + j;
        if (k < N - 1) {
          var v = "p" + i + j;
          lines.push("  vec2 " + v + " = dfTwoProdS(a." + COMP[i] + ", as" + i + ", b." + COMP[j] + ", bs" + j + ");");
          (levels[k] = levels[k] || []).push(v + ".x");
          (levels[k + 1] = levels[k + 1] || []).push(v + ".y");
        } else {
          (levels[k] = levels[k] || []).push("dfv(a." + COMP[i] + " * b." + COMP[j] + ")");
        }
      }
    }
    genCascade(lines, levels, N);
    lines.push("}");
    return lines.join("\n");
  }

  // a*a: the two cross terms a_i*a_j and a_j*a_i are the same number, and
  // doubling it is exact - so about half the products.
  function genSqr(N) {
    var lines = ["MF dfSqr(MF a) {"], levels = [];
    for (var s = 0; s < N - 1; s++) lines.push("  vec2 as" + s + " = dfSplit(a." + COMP[s] + ");");
    for (var i = 0; i < N; i++) {
      for (var j = i; i + j < N; j++) {
        var k = i + j, twice = i === j ? "" : "2.0 * ";
        if (k < N - 1) {
          var v = "p" + i + j;
          lines.push("  vec2 " + v + " = " + twice + "dfTwoProdS(a." + COMP[i] + ", as" + i + ", a." + COMP[j] + ", as" + j + ");");
          (levels[k] = levels[k] || []).push(v + ".x");
          (levels[k + 1] = levels[k + 1] || []).push(v + ".y");
        } else {
          (levels[k] = levels[k] || []).push("dfv(" + twice + "a." + COMP[i] + " * a." + COMP[j] + ")");
        }
      }
    }
    genCascade(lines, levels, N);
    lines.push("}");
    return lines.join("\n");
  }

  function genMulFloat(N) {
    var lines = ["MF dfMulFloat(MF a, float b) {", "  vec2 bs = dfSplit(b);"], levels = [];
    for (var i = 0; i < N; i++) {
      if (i < N - 1) {
        lines.push("  vec2 p" + i + " = dfTwoProdS(a." + COMP[i] + ", dfSplit(a." + COMP[i] + "), b, bs);");
        (levels[i] = levels[i] || []).push("p" + i + ".x");
        (levels[i + 1] = levels[i + 1] || []).push("p" + i + ".y");
      } else {
        (levels[i] = levels[i] || []).push("dfv(a." + COMP[i] + " * b)");
      }
    }
    genCascade(lines, levels, N);
    lines.push("}");
    return lines.join("\n");
  }

  // Long division, a float32 quotient word at a time against the exact
  // remainder. N words of quotient; the (N+1)th, which only rounds the last
  // bit, is left out for the same reason fastDiv leaves it out at two.
  function genDiv(N) {
    var lines = ["MF dfDiv(MF a, MF b) {", "  float q0 = a.x / b.x;", "  MF r = dfSub(a, dfMulFloat(b, q0));"], q = ["q0"];
    for (var i = 1; i < N; i++) {
      lines.push("  float q" + i + " = r.x / b.x;");
      if (i < N - 1) lines.push("  r = dfSub(r, dfMulFloat(b, q" + i + "));");
      q.push("q" + i);
    }
    lines.push("  return dfRenorm(" + q.join(", ") + ");", "}");
    return lines.join("\n");
  }

  // A two-word root by the same float32-corrected Newton step fastSqrt
  // uses (~47 bits), then ONE step at full precision, which squares that
  // error to ~2^-94. The step's correction is (a - s*s) / 2s: a residual of
  // ~2^-47 of the root, of which three words need the leading 24 bits - a
  // float32 division - and four need 48, hence the second quotient word.
  function genSqrt(N) {
    var lines = [
      "MF dfSqrt(MF a) {",
      "  if (a.x <= 0.0) return MF(0.0);",
      "  float s0 = sqrt(a.x);",
      "  vec2 p = dfTwoSqr(s0);",
      "  float r0 = dfv(dfv(a.x - p.x) + dfv(a.y - p.y));",
      "  MF s = MF(0.0);",
      "  s.xy = dfQuickTwoSum(s0, r0 / (2.0 * s0));",
      "  MF res = dfSub(a, dfSqr(s));",
      "  float q0 = res.x / (2.0 * s.x);",
    ];
    if (N >= 4) {
      lines.push("  res = dfSub(res, dfMulFloat(s, 2.0 * q0));");
      lines.push("  float q1 = res.x / (2.0 * s.x);");
      lines.push("  MF corr = MF(0.0);");
      lines.push("  corr.xy = dfQuickTwoSum(q0, q1);");
      lines.push("  return dfAdd(s, corr);");
    } else {
      lines.push("  return dfAddFloat(s, q0);");
    }
    lines.push("}");
    return lines.join("\n");
  }

  function genLess(N, op) {
    var expr = "a." + COMP[N - 1] + " " + op + " b." + COMP[N - 1];
    for (var i = N - 2; i >= 0; i--) expr = "a." + COMP[i] + " " + op + " b." + COMP[i] + " || (a." + COMP[i] + " == b." + COMP[i] + " && (" + expr + "))";
    return expr;
  }

  function buildLibrary(options) {
    var opt = {};
    for (var key in DEFAULT_OPTIONS) {
      opt[key] = options && options[key] !== undefined ? !!options[key] : DEFAULT_OPTIONS[key];
    }
    var N = options && options.words ? options.words : currentWords;
    var two = N === 2;
    var saved = currentWords;
    currentWords = N; // so num() below writes N-word literals
    try {
      return buildLibraryText(N, two, opt);
    } finally {
      currentWords = saved;
    }
  }

  function buildLibraryText(N, two, opt) {
    // pi/2 for the range reduction, and the series, at this word count.
    // From the exact rational wherever there is a BigInt to hold one - at two
    // words as well. The float64 fallback only knows pi/2 to 53 bits, and
    // the reduction multiplies that error by the quarter-turn count: measured
    // at 5e-13 for an angle of 3000 radians, six of df's bits. (Without
    // BigInt there are no three- or four-word precisions to build at all -
    // see isSupported.)
    var halfPiPieces = typeof BigInt === "function"
      ? (function () { var pi = piRational(); return codyWaitePiecesExact(pi[0], pi[1] * big(2), Math.max(5, 2 * N + 1)); })()
      : codyWaitePieces(Math.PI / 2, 5);
    var halfPiDecls = halfPiPieces.map(function (p, i) {
      return "const float DF_HPI_" + i + " = " + fnum(p) + ";";
    }).join("\n");
    var pieceIndices = halfPiPieces.map(function (p, i) { return i; });
    var twoPiLiteral = two ? "vec2(" + fnum(TWO_PI[0]) + ", " + fnum(TWO_PI[1]) + ")"
      : (function () { var pi = piRational(); return literal(rationalWords(pi[0] * big(2), pi[1], N)); })();
    var sinLiterals = two ? SIN_COEFFS.map(num) : taylorLiterals(N, 1);
    var cosLiterals = two ? COS_COEFFS.map(num) : taylorLiterals(N, 0);
    function exactLiteral(sign, denominator) {
      return two ? num(sign / denominator) : literal(rationalWords(big(sign), big(denominator), N));
    }
    // A delta this small needs this many terms of each series to be exact
    // to the last word: at two words, |delta| <= 2^-6 and terms through
    // delta^5 / delta^6; past that, |delta| <= 2^-10 and through delta^7 /
    // delta^8, whose first dropped terms (delta^9/9!, delta^10/10!) are
    // under 2^-108 - below a fourth word.
    var nudgeLimit = two ? 0.015625 : 0.0009765625;
    var nudgeSin = two ? [-6, 120] : [-6, 120, -5040];
    var nudgeCos = two ? [-2, 24, -720] : [-2, 24, -720, 40320];
    function nudgeSeries(denominators) {
      var expr = exactLiteral(denominators[denominators.length - 1] < 0 ? -1 : 1, Math.abs(denominators[denominators.length - 1]));
      for (var i = denominators.length - 2; i >= 0; i--) {
        expr = "dfAdd(" + exactLiteral(denominators[i] < 0 ? -1 : 1, Math.abs(denominators[i])) + ", dfMul(u, " + expr + "))";
      }
      return "dfAdd(DF_ONE_CONST, dfMul(u, " + expr + "))";
    }
    var isZero = function (v) { return "all(equal(" + v + ", MF(0.0)))"; };

    return [
    "// ---- Multi-float arithmetic: a value is MF(w0, w1, ...) = w0 + w1 + ... ----",
    "// See physics-df.js's header for what these are, and for why dfv()",
    "// wraps what look like pointless identities (short version: without",
    "// it, ANGLE/Metal folds every error term below to exactly 0.0).",
    "#define MF vec" + N,
    "",
    "const MF DF_TWO_PI = " + twoPiLiteral + ";",
    "const MF DF_ONE_CONST = " + literal([1].concat(new Array(N - 1).fill(0))) + ";",
    "",
    "// The optimizer barrier. u_dfVeil is 0, so this is the identity - but",
    "// that is only knowable at runtime, so no algebraic rewrite can reach",
    "// across it.",
    "float dfv(float x) { return uintBitsToFloat(floatBitsToUint(x) ^ u_dfVeil); }",
    "",
    two ? "MF dfFromFloat(float a) { return vec2(a, 0.0); }"
        : "MF dfFromFloat(float a) { MF r = MF(0.0); r.x = a; return r; }",
    two ? "float dfToFloat(MF a) { return a.x + a.y; }"
        : "float dfToFloat(MF a) { return " + COMP.slice(0, N).map(function (c) { return "a." + c; }).join(" + ") + "; }",
    two ? "MF dfNeg(MF a) { return vec2(-a.x, -a.y); }" : "MF dfNeg(MF a) { return -a; }",
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
    "// The same with the operands already split - the generated multi-word",
    "// kernels use each operand word in several products.",
    "vec2 dfTwoProdS(float a, vec2 as, float b, vec2 bs) {",
    "  float p = dfv(a * b);",
    "  float e = dfv(dfv(dfv(dfv(as.x * bs.x) - p) + dfv(as.x * bs.y)) + dfv(as.y * bs.x));",
    "  e = dfv(e + dfv(as.y * bs.y));",
    "  return vec2(p, e);",
    "}",
    "",
    "// a*a exactly. One split instead of two and three partial products",
    "// instead of four - the two cross terms are the same number, and",
    "// doubling it is exact.",
    "vec2 dfTwoSqr(float a) {",
    "  float p = dfv(a * a);",
    "  vec2 as = dfSplit(a);",
    "  float e = dfv(dfv(dfv(dfv(as.x * as.x) - p) + dfv(2.0 * dfv(as.x * as.y))) + dfv(as.y * as.y));",
    "  return vec2(p, e);",
    "}",
    "",
    !two ? genRenorm(N) + "\n\n" + genAdd(N) : opt.sloppyAdd ? [
    "// Dekker's add: one twoSum for the high words, the low words summed",
    "// in plain float32. See DEFAULT_OPTIONS in physics-df.js for why this",
    "// and not the 20-op form.",
    "MF dfAdd(MF a, MF b) {",
    "  vec2 s = dfTwoSum(a.x, b.x);",
    "  s.y = dfv(s.y + dfv(a.y + b.y));",
    "  return dfQuickTwoSum(s.x, s.y);",
    "}",
    ].join("\n") : [
    "MF dfAdd(MF a, MF b) {",
    "  vec2 s = dfTwoSum(a.x, b.x);",
    "  vec2 t = dfTwoSum(a.y, b.y);",
    "  s.y = dfv(s.y + t.x);",
    "  s = dfQuickTwoSum(s.x, s.y);",
    "  s.y = dfv(s.y + t.y);",
    "  return dfQuickTwoSum(s.x, s.y);",
    "}",
    ].join("\n"),
    "",
    "// The hot path: a df accumulator plus an ordinary float32 increment.",
    !two ? genAddFloat(N) : [
    "MF dfAddFloat(MF a, float b) {",
    "  vec2 s = dfTwoSum(a.x, b);",
    "  s.y = dfv(s.y + a.y);",
    "  return dfQuickTwoSum(s.x, s.y);",
    "}",
    ].join("\n"),
    "",
    "MF dfSub(MF a, MF b) { return dfAdd(a, dfNeg(b)); }",
    "MF dfSubFloat(MF a, float b) { return dfAddFloat(a, -b); }",
    "",
    !two ? genMul(N) : [
    "MF dfMul(MF a, MF b) {",
    "  vec2 p = dfTwoProd(a.x, b.x);",
    "  p.y = dfv(p.y + dfv(dfv(a.x * b.y) + dfv(a.y * b.x)));",
    "  return dfQuickTwoSum(p.x, p.y);",
    "}",
    ].join("\n"),
    "",
    !two ? genMulFloat(N) : [
    "MF dfMulFloat(MF a, float b) {",
    "  vec2 p = dfTwoProd(a.x, b);",
    "  p.y = dfv(p.y + dfv(a.y * b));",
    "  return dfQuickTwoSum(p.x, p.y);",
    "}",
    ].join("\n"),
    "",
    !two ? genSqr(N) : [
    "MF dfSqr(MF a) {",
    "  vec2 p = dfTwoSqr(a.x);",
    "  p.y = dfv(p.y + dfv(2.0 * dfv(a.x * a.y)));",
    "  return dfQuickTwoSum(p.x, p.y);",
    "}",
    ].join("\n"),
    "",
    "// Scaling by a power of two (2.0, 4.0, 0.5 ...) is exact word by word,",
    "// so it needs none of dfMulFloat's machinery - and being exact, there",
    "// is nothing in it for an optimizer to get wrong either.",
    "MF dfMulPow2(MF a, float p) { return a * p; }",
    "",
    !two ? genDiv(N) : opt.fastDiv ? [
    "// A float32 quotient, then one correction against the df remainder.",
    "// b*q1 agrees with a to ~24 bits, so the high words cancel EXACTLY and",
    "// what is left fits a float32 - which is all the second quotient word",
    "// needs. See DEFAULT_OPTIONS in physics-df.js for the third word this",
    "// leaves out.",
    "MF dfDiv(MF a, MF b) {",
    "  float q1 = a.x / b.x;",
    "  vec2 p = dfMulFloat(b, q1);",
    "  float r = dfv(dfv(a.x - p.x) + dfv(a.y - p.y));",
    "  float q2 = r / b.x;",
    "  return dfQuickTwoSum(q1, q2);",
    "}",
    ].join("\n") : [
    "// A float32 quotient, then two correction rounds against the df",
    "// remainder - the standard Newton-style df division.",
    "MF dfDiv(MF a, MF b) {",
    "  float q1 = a.x / b.x;",
    "  vec2 r = dfSub(a, dfMulFloat(b, q1));",
    "  float q2 = r.x / b.x;",
    "  r = dfSub(r, dfMulFloat(b, q2));",
    "  float q3 = r.x / b.x;",
    "  vec2 q = dfQuickTwoSum(q1, q2);",
    "  return dfAddFloat(q, q3);",
    "}",
    ].join("\n"),
    "",
    "MF dfDivFloat(MF a, float b) { return dfDiv(a, dfFromFloat(b)); }",
    "",
    "// Ordering. dfToFloat() would collapse exactly the distinction these",
    "// exist to preserve, so compare word by word from the top.",
    "bool dfLess(MF a, MF b) { return " + genLess(N, "<") + "; }",
    "bool dfGreater(MF a, MF b) { return " + genLess(N, ">") + "; }",
    "",
    "// GLSL's mod(a, m) == a - m * floor(a / m): always in [0, m) for m > 0,",
    "// which is the property the frame-wrap rules rely on. floor() of the",
    "// float32 quotient can land one off when a/m is a hair from an integer,",
    "// so the two guards below put it back.",
    "MF dfMod(MF a, float m) {",
    "  float k = floor(dfToFloat(a) / m);",
    "  MF r = dfSub(a, dfMulFloat(dfFromFloat(m), k));",
    "  if (dfLess(r, MF(0.0))) r = dfAddFloat(r, m);",
    "  if (!dfLess(r, dfFromFloat(m))) r = dfSubFloat(r, m);",
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
    "// By far the most expensive routine here (about forty dfMuls), and it",
    "// IS on the hot path: the whole step runs in df, so every hinge and",
    "// every line rotates about a df angle. The callers hoist it as far out",
    "// of their loops as the physics allows - see physics-gpu-df.js - and",
    "// dfSinCosNudge below covers the case where an angle only moved a hair.",
    halfPiDecls,
    "const float DF_INV_HALF_PI = " + fnum(f32(2 / Math.PI)) + ";",
    "",
    "// Subtract k*(pi/2) piecewise. Every piece but the last carries only 12",
    "// significand bits, so each k*piece is EXACT for |k| < 2^12 (~4000",
    "// quarter turns) and the reduced angle keeps every word. Reducing",
    "// against a single multi-float 2pi instead would leave a k*ulp*2pi",
    "// residue - 3.5e-11 at 1e4 radians in df, which is the entire reason",
    "// this is spelled out.",
    "MF dfReduceQuadrant(MF a, out int quadrant) {",
    "  float k = floor(dfToFloat(a) * DF_INV_HALF_PI + 0.5);",
    "  MF r = a;",
    ].concat(pieceIndices.map(function (i) { return "  r = dfSubFloat(r, k * DF_HPI_" + i + ");"; }), [
    "  quadrant = int(mod(k, 4.0) + 4.5) - 4;",
    "  return r;",
    "}",
    "",
    // Series in u = x*x, carried far enough that the first dropped term is
    // below the last word at |x| = pi/4.
    hornerGLSL("dfSinTaylor", sinLiterals, true, two ? "dfMul(x, x)" : "dfSqr(x)"),
    hornerGLSL("dfCosTaylor", cosLiterals, false, two ? "dfMul(x, x)" : "dfSqr(x)"),
    "",
    "void dfSinCos(MF a, out MF sn, out MF cs) {",
    "  // Exact fast path, and not a micro-optimisation: the hinge solvers",
    "  // rotate BOTH sides of every joint, and one side is very often the",
    "  // world pin, whose angle is a hard zero. Without this, a world-hinged",
    "  // scene spends half its trig budget evaluating a Taylor series to",
    "  // learn that sin(0) = 0. The branch is uniform across pixels for that",
    "  // case, so it costs nothing in divergence either.",
    "  if (" + isZero("a") + ") { sn = MF(0.0); cs = DF_ONE_CONST; return; }",
    "  int q;",
    "  MF x = dfReduceQuadrant(a, q);",
    "  MF sx = dfSinTaylor(x);",
    "  MF cx = dfCosTaylor(x);",
    "  if (q == 0) { sn = sx; cs = cx; }",
    "  else if (q == 1) { sn = cx; cs = dfNeg(sx); }",
    "  else if (q == 2) { sn = dfNeg(sx); cs = dfNeg(cx); }",
    "  else { sn = dfNeg(cx); cs = sx; }",
    "}",
    "MF dfCos(MF a) { MF s, c; dfSinCos(a, s, c); return c; }",
    "MF dfSin(MF a) { MF s, c; dfSinCos(a, s, c); return s; }",
    "",
    "// (sn, cs) of an angle that has just moved by a SMALL known delta, from",
    "// the pair it had before: the angle-sum identities, with the delta's own",
    "// sin/cos from a series short enough to be cheap, and with a limit on",
    "// the delta tight enough that the first dropped terms fall below the",
    "// last word - so this is as exact as dfSinCos itself, for a fraction of",
    "// the cost. The position solver nudges every hinged body's angle by a",
    "// tiny correction several times a step, which is the case this exists",
    "// for. Returns false (and leaves sn/cs alone) when the delta is too",
    "// large for the short series; the caller then recomputes.",
    "const float DF_NUDGE_LIMIT = " + fnum(nudgeLimit) + ";",
    "bool dfSinCosNudge(inout MF sn, inout MF cs, MF delta) {",
    "  if (abs(delta.x) > DF_NUDGE_LIMIT) return false;",
    "  if (" + isZero("delta") + ") return true;",
    "  MF u = dfSqr(delta);",
    "  MF sd = dfMul(delta, " + nudgeSeries(nudgeSin) + ");",
    "  MF cd = " + nudgeSeries(nudgeCos) + ";",
    "  MF sn2 = dfAdd(dfMul(sn, cd), dfMul(cs, sd));",
    "  cs = dfSub(dfMul(cs, cd), dfMul(sn, sd));",
    "  sn = sn2;",
    "  return true;",
    "}",
    "",
    "// Fold an angle into [0, 2pi). Used wherever an accumulated angle has",
    "// to be handed to float32 code: reducing first keeps that float32",
    "// value's resolution at ~1e-7 rad however many turns the body has",
    "// taken, instead of degrading with the turn count.",
    "// Reuses the quadrant reduction above rather than a dfMod against a df",
    "// 2pi, for the same range-reduction-accuracy reason: a mod 2pi is",
    "// (a - k*pi/2) + (k mod 4)*pi/2, and every piece of that is exact.",
    "MF dfReduceAngle(MF a) {",
    "  int q;",
    "  MF r = dfReduceQuadrant(a, q);",
    "  float qf = float(q < 0 ? q + 4 : q);",
    ], pieceIndices.map(function (i) { return "  r = dfAddFloat(r, qf * DF_HPI_" + i + ");"; }), [
    "  if (dfLess(r, MF(0.0))) r = dfAdd(r, DF_TWO_PI);",
    "  if (!dfLess(r, DF_TWO_PI)) r = dfSub(r, DF_TWO_PI);",
    "  return r;",
    "}",
    "MF dfAbs(MF a) { return a.x < 0.0 ? dfNeg(a) : a; }",
    "",
    !two ? genSqrt(N) : opt.fastSqrt ? [
    "// One Newton step from the hardware float32 root s, written as",
    "// s + (a - s*s) / 2s. s*s is formed exactly (dfTwoSqr) and agrees with a",
    "// to ~23 bits, so the high words cancel exactly and the remainder fits",
    "// a float32; the correction it yields is at most ~2^-23 of s, which",
    "// float32's 24 bits then place to ~2^-47. The step itself squares the",
    "// seed's ~6e-8 relative error into ~2e-15, about half a df ulp (a df",
    "// carries 48 bits, 3.6e-15) - so a second step would buy nothing a df",
    "// can hold.",
    "MF dfSqrt(MF a) {",
    "  if (a.x <= 0.0) return vec2(0.0, 0.0);",
    "  float s = sqrt(a.x);",
    "  vec2 p = dfTwoSqr(s);",
    "  float r = dfv(dfv(a.x - p.x) + dfv(a.y - p.y));",
    "  return dfQuickTwoSum(s, r / (2.0 * s));",
    "}",
    ].join("\n") : [
    "// Newton's x' = (x + a/x)/2, seeded with the hardware float32 sqrt.",
    "// One step squares the ~6e-8 relative error of that seed into ~2e-15 -",
    "// about half a df ulp (a df carries 48 bits, 3.6e-15), so a second",
    "// step would buy nothing a df value can hold.",
    "MF dfSqrt(MF a) {",
    "  if (a.x <= 0.0) return vec2(0.0, 0.0);",
    "  float s = sqrt(a.x);",
    "  return dfMulPow2(dfAdd(vec2(s, 0.0), dfDiv(a, vec2(s, 0.0))), 0.5);",
    "}",
    ].join("\n"),
    "",
    "MF dfMin(MF a, MF b) { return dfLess(a, b) ? a : b; }",
    "MF dfMax(MF a, MF b) { return dfLess(a, b) ? b : a; }",
    "MF dfClamp(MF v, MF lo, MF hi) { return dfMin(dfMax(v, lo), hi); }",
    "",
    "// Same cubic GLSL's smoothstep uses: t*t*(3 - 2t) on the clamped ramp.",
    "MF dfSmoothstep(MF e0, MF e1, MF x) {",
    "  MF span = dfSub(e1, e0);",
    "  if (" + isZero("span") + ") return dfLess(x, e0) ? MF(0.0) : DF_ONE_CONST;",
    "  MF t = dfClamp(dfDiv(dfSub(x, e0), span), MF(0.0), DF_ONE_CONST);",
    "  return dfMul(dfSqr(t), dfSub(dfFromFloat(3.0), dfMulPow2(t, 2.0)));",
    "}",
    "",
    "// ---- 2D vectors in df ----",
    "// A DVec2 is two df scalars, not a df-ified vec2 - GLSL has no way to",
    "// give a user type component-wise operators, so every operation is",
    "// spelled out. The physics port (physics-gpu-df.js) is written against",
    "// these; the per-pixel cascade uses DVec2 purely as a rotation result.",
    "struct DVec2 { MF x; MF y; };",
    "DVec2 dv2(MF x, MF y) { DVec2 r; r.x = x; r.y = y; return r; }",
    "DVec2 dv2Zero() { return dv2(MF(0.0), MF(0.0)); }",
    "DVec2 dv2FromVec2(vec2 v) { return dv2(dfFromFloat(v.x), dfFromFloat(v.y)); }",
    "vec2 dv2ToVec2(DVec2 a) { return vec2(dfToFloat(a.x), dfToFloat(a.y)); }",
    "DVec2 dv2Add(DVec2 a, DVec2 b) { return dv2(dfAdd(a.x, b.x), dfAdd(a.y, b.y)); }",
    "DVec2 dv2Sub(DVec2 a, DVec2 b) { return dv2(dfSub(a.x, b.x), dfSub(a.y, b.y)); }",
    "DVec2 dv2Neg(DVec2 a) { return dv2(dfNeg(a.x), dfNeg(a.y)); }",
    "DVec2 dv2Scale(DVec2 a, MF s) { return dv2(dfMul(a.x, s), dfMul(a.y, s)); }",
    "MF dv2Dot(DVec2 a, DVec2 b) { return dfAdd(dfMul(a.x, b.x), dfMul(a.y, b.y)); }",
    "MF dv2Cross(DVec2 a, DVec2 b) { return dfSub(dfMul(a.x, b.y), dfMul(a.y, b.x)); }",
    "MF dv2LengthSq(DVec2 a) { return dfAdd(dfSqr(a.x), dfSqr(a.y)); }",
    "MF dv2Length(DVec2 a) { return dfSqrt(dv2LengthSq(a)); }",
    "DVec2 dv2MulPow2(DVec2 a, float p) { return dv2(a.x * p, a.y * p); }",
    "DVec2 dv2Perp(DVec2 a) { return dv2(dfNeg(a.y), a.x); }",
    "",
    "// Rotation with sin/cos supplied by the caller. Every solver iteration",
    "// rotates an anchor about a body's angle, and a df sin/cos is by far",
    "// the most expensive thing in the library - so the callers hoist it out",
    "// of their loops and pass it in, rather than paying for it per rotate.",
    "DVec2 dv2RotateBy(DVec2 v, MF sn, MF cs) {",
    "  return dv2(dfSub(dfMul(v.x, cs), dfMul(v.y, sn)),",
    "             dfAdd(dfMul(v.x, sn), dfMul(v.y, cs)));",
    "}",
    "DVec2 dfRotate(MF vx, MF vy, MF angle) {",
    "  MF sn, cs;",
    "  dfSinCos(angle, sn, cs);",
    "  return dv2RotateBy(dv2(vx, vy), sn, cs);",
    "}",
    ]).join("\n");
  }

  // ---- A world coordinate pair, handed to a shader as uniforms ----
  //
  // One vec2 uniform per WORD, holding that word of x and of y:
  // <base>Hi, <base>Lo, <base>Lo2, <base>Lo3. Every program declares all
  // four whatever its precision and reads as many as it carries (float32
  // reads Hi alone), so the JS side sets them the same way for all of them.
  var WORD_SUFFIXES = ["Hi", "Lo", "Lo2", "Lo3"];
  function wordUniformDecls(base) {
    return WORD_SUFFIXES.map(function (sfx) { return "uniform vec2 " + base + sfx + ";"; });
  }
  // The GLSL for one axis ("x" or "y") of such a pair, at `precision`.
  function wordUniformValue(base, axis, precision) {
    var n = wordsFor(precision);
    if (n <= 1) return base + "Hi." + axis;
    return "MF(" + WORD_SUFFIXES.slice(0, n).map(function (sfx) { return base + sfx + "." + axis; }).join(", ") + ")";
  }
  // The four words of each axis, from a double-double pair - [[x words], [y words]].
  function wordUniformValues(xHi, xLo, yHi, yLo) {
    return [splitWords(xHi, xLo || 0, WORD_SUFFIXES.length), splitWords(yHi, yLo || 0, WORD_SUFFIXES.length)];
  }

  global.PhysicsDF = {
    split: split,
    splitWords: splitWords,
    WORD_SUFFIXES: WORD_SUFFIXES,
    wordUniformDecls: wordUniformDecls,
    wordUniformValue: wordUniformValue,
    wordUniformValues: wordUniformValues,
    twoSum64: twoSum64,
    twoProd64: twoProd64,
    num: num,
    fnum: fnum,
    literal: literal,
    rationalWords: rationalWords,
    wordsFor: wordsFor,
    isExtended: isExtended,
    isSupported: isSupported,
    usePrecision: usePrecision,
    PRECISIONS: ORDER,
    UNIFORM_DECL: UNIFORM_DECL,
    // The library at whatever precision usePrecision() last named - a getter
    // rather than a baked string for exactly that reason. A measurement page
    // can still pin one: assigning to it replaces the getter's answer until
    // it is assigned null again.
    get GLSL_LIBRARY() { return pinnedLibrary || buildLibrary(); },
    set GLSL_LIBRARY(text) { pinnedLibrary = text; },
    buildLibrary: buildLibrary,
    DEFAULT_OPTIONS: DEFAULT_OPTIONS,
  };
  var pinnedLibrary = null;
})(typeof window !== "undefined" ? window : globalThis);
