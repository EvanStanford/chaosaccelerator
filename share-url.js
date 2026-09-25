// This file is part of Chaos Accelerator, licensed under the Common Public
// Attribution License, Version 1.0 (CPAL-1.0): see LICENSE in the project
// root, or https://chaosaccelerator.com/license for a hosted copy.

// The whole app state as a URL fragment, and back, so sharing a scene (or a
// view of its map) is just sharing the address bar. Pure text in, plain data
// out: no DOM, no storage, nothing here knows a page exists. transition.js
// decides WHEN the address bar is read and written; this only says what it
// says.
//
//   #bldr/body:ci:-132.1:321.4:.0021:30;ln:-334:-173.5:-.7679:479!,xinp:0.x,
//         yinp:0.y,outp:0.y,edge:wrap,frmw:1192,frmh:809
//   #map/<the same scene>,ctrx:-14.318359,ctry:57.44,zoom:3.2,disp:lapl,
//         insp:p:.0115:.0075;l:-.2875:-.1018:.2973:.143:30
//   chaosplayback.html#movi/<the same scene>,disp:lapl,
//         kfrm:0:0:1:1000;-14.318359:57.44:3.2:500:4
//
// The page comes first ("bldr" is the scene builder, "map" the fractal
// grid, "movi" the movie player), then comma-separated key:value fields.
// Inside a value, ":" separates the parts of one thing and ";" separates
// things in a list. Every one of those characters is legal unescaped in a
// fragment (RFC 3986's pchar plus "/" and "?"), so nothing is
// percent-encoded and the address stays legible.
//
// Made to be read by a person, barely: four-letter keys, plain decimals. It
// costs about twice the characters of a packed binary form, and a full scene
// plus view still comes to a few hundred against the ~2,000 that every
// browser, chat app and mail client is safe with.
//
// WIRE DEFAULTS. A field at its default is left out: most scenes have no
// starting velocities, run the usual duration and so on, which is a third of
// the length. Those defaults belong to THIS FORMAT, not to the app: they are
// what an absent field means in every link already out in the world, so they
// must never follow a change to what the editor starts a new scene with.
// decode() always fills them in, so what it returns names every field.
//
// A link never ends in punctuation: chat apps and mail clients leave a
// trailing "!" or "," out of the link they detect. The one value that can end
// in "!" (an anchored body) is therefore never the last field: the frame
// size follows the scene, and every view field ends in a letter or digit.
(function (global) {
  "use strict";

  var PAGE_BUILDER = "bldr";
  var PAGE_MAP = "map";
  var PAGE_MOVIE = "movi";
  var PAGES = [PAGE_BUILDER, PAGE_MAP, PAGE_MOVIE];

  var DEFAULT_STEPS = 1000;
  var DEFAULT_MAX_BODIES = 20;
  var DEFAULT_EDGE = "sticky";
  // A movie's resolution setting (see MOVIE_QUALITIES in fractal-grid.js):
  // 4 is full resolution with antialiasing, and each step down is cheaper.
  var DEFAULT_MOVIE_QUALITY = 4;

  var TYPE_CODES = { circle: "ci", line: "ln", funnel: "fu", splitter: "sp" };
  // Which field holds a body's one size: the same split serializeScene
  // writes and parseSceneData reads.
  var SIZE_FIELDS = { circle: "radius", line: "length", funnel: "size", splitter: "size" };
  var PROPERTY_CODES = {
    x: "x", y: "y", angle: "ang", radius: "rad", length: "len", size: "siz", vx: "vx", vy: "vy",
    bounces: "bnce", distance: "dist", lifespan: "life",
  };
  var EDGE_CODES = { sticky: "stik", wrap: "wrap", infinite: "infi" };
  // Color Zoom is a switch on Standard rather than a mode of its own in the
  // page, but it is one of five things the picture can be showing, and that
  // is how a link says it.
  var DISPLAY_CODES = { standard: "std", colorzoom: "czom", gradient: "grad", laplacian: "lapl", contours: "cont" };
  var PRECISIONS = ["f32", "df", "tf", "qf", "auto"];

  function invert(map) {
    var out = {};
    Object.keys(map).forEach(function (k) { out[map[k]] = k; });
    return out;
  }
  var TYPES_BY_CODE = invert(TYPE_CODES);
  var PROPERTIES_BY_CODE = invert(PROPERTY_CODES);
  var EDGES_BY_CODE = invert(EDGE_CODES);
  var DISPLAYS_BY_CODE = invert(DISPLAY_CODES);

  // ---- Numbers ----

  // The shortest text that reads back as exactly this number (String() is
  // specified to be that), less the characters a reader doesn't need: ".5"
  // for "0.5", "1e21" for "1e+21". "+" is dropped for a second reason: some
  // software still reads it as a space.
  function num(v) {
    if (!isFinite(v) || v === 0) return "0";
    return String(v).replace("e+", "e").replace(/^(-?)0\./, "$1.");
  }
  // Scene numbers, to the four decimals serializeScene itself keeps.
  function sceneNum(v) {
    return num(Math.round((Number(v) || 0) * 1e4) / 1e4);
  }
  // Number() alone is far too forgiving for text out of an address bar: ""
  // and " " are 0, "0x10" is 16. This is a plain decimal, optionally with an
  // exponent, and nothing else.
  var NUMBER_RE = /^-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?$/i;
  function parseNum(text, what) {
    if (!NUMBER_RE.test(text)) throw new Error(what + " is not a number: \"" + text + "\"");
    var v = Number(text);
    if (!isFinite(v)) throw new Error(what + " is out of range");
    return v;
  }
  function parseIndex(text, what) {
    if (!/^\d+$/.test(text)) throw new Error(what + " is not a whole number: \"" + text + "\"");
    return Number(text);
  }

  // ---- Double-double decimals ----
  //
  // The map's view center is held as a double-double (hi + lo, ~106 bits:
  // see view.center in fractal-grid.js), because at a deep zoom one float64
  // cannot tell a pixel from its neighbour. It travels as ONE decimal with
  // as many places as the zoom can use, so a link's center reads as an
  // ordinary coordinate that simply grows digits as the view goes deeper.
  // Converting exactly in both directions needs integers wider than a
  // float64, hence BigInt: written as BigInt(n) calls rather than 10n
  // literals, which a browser without BigInt could not even parse (the same
  // care physics-df.js takes). Without it a center keeps float64 precision,
  // which is as deep as such a browser can render anyway.
  var HAS_BIGINT = typeof BigInt === "function";
  var bits = new DataView(new ArrayBuffer(8));

  // x === m * 2^e exactly, for any finite float64.
  function exactParts(x) {
    bits.setFloat64(0, x);
    var top = bits.getUint32(0), low = bits.getUint32(4);
    var exponent = (top >>> 20) & 0x7FF;
    var m = BigInt(top & 0xFFFFF) * BigInt(4294967296) + BigInt(low);
    if (exponent !== 0) m += BigInt(4503599627370496); // the implicit leading bit, 2^52
    if (top >>> 31) m = -m;
    return { m: m, e: exponent === 0 ? -1074 : exponent - 1075 };
  }
  function pow10(n) {
    var r = BigInt(1), ten = BigInt(10);
    for (var i = 0; i < n; i++) r *= ten;
    return r;
  }

  // hi + lo, rounded to `decimals` places, trailing zeros dropped.
  function formatDD(hi, lo, decimals) {
    hi = Number(hi) || 0; lo = Number(lo) || 0;
    // toFixed is exact arithmetic on the float64 itself, so with nothing in
    // the low half it is already the right answer.
    if (!HAS_BIGINT || lo === 0) return trimFixed(hi.toFixed(Math.min(decimals, 100)));
    var a = exactParts(hi), b = exactParts(lo);
    var e = Math.min(a.e, b.e);
    var m = (a.m << BigInt(a.e - e)) + (b.m << BigInt(b.e - e));
    var scaled = m * pow10(decimals); // the value * 10^decimals, as scaled * 2^e
    var negative = scaled < BigInt(0);
    if (negative) scaled = -scaled;
    var n;
    if (e >= 0) {
      n = scaled << BigInt(e);
    } else {
      var den = BigInt(1) << BigInt(-e);
      n = (scaled + (den >> BigInt(1))) / den; // to nearest, halves away from zero
    }
    var digits = n.toString();
    while (digits.length <= decimals) digits = "0" + digits;
    var cut = digits.length - decimals;
    return trimFixed((negative ? "-" : "") + digits.slice(0, cut) + (decimals ? "." + digits.slice(cut) : ""));
  }
  function trimFixed(text) {
    if (text.indexOf(".") !== -1) text = text.replace(/0+$/, "").replace(/\.$/, "");
    text = text.replace(/^(-?)0\./, "$1.");
    return (text === "" || text === "-" || text === "-0") ? "0" : text;
  }

  // p / q as the nearest float64 (to within a small fraction of a unit in
  // the last place, which for a low half is far finer than anything reads).
  function ratioToNumber(p, q) {
    var zero = BigInt(0);
    if (p === zero) return 0;
    var negative = p < zero;
    if (negative) p = -p;
    var shift = Math.max(0, 64 + q.toString(2).length - p.toString(2).length);
    if (shift > 1000) return 0; // below anything a double-double's low half can hold
    var v = Number((p << BigInt(shift)) / q) * Math.pow(2, -shift);
    return negative ? -v : v;
  }

  var PLAIN_DECIMAL_RE = /^-?(?:\d+\.?\d*|\.\d+)$/;
  // The way back: [hi, lo] with hi + lo the decimal to ~32 digits. hi is
  // simply the float64 nearest the text; lo is what that rounding left out,
  // taken exactly.
  function parseDD(text, what) {
    // Long enough for any center this format writes, short enough that a
    // hostile link can't buy seconds of BigInt arithmetic with a megabyte of
    // digits.
    if (text.length > 80 || !PLAIN_DECIMAL_RE.test(text)) return [parseNum(text, what), 0];
    var hi = Number(text);
    if (!HAS_BIGINT || !isFinite(hi)) return [hi, 0];
    var negative = text.charAt(0) === "-";
    var body = negative ? text.slice(1) : text;
    var dot = body.indexOf(".");
    var fraction = dot === -1 ? "" : body.slice(dot + 1);
    var s = BigInt(((dot === -1 ? body : body.slice(0, dot)) + fraction) || "0");
    if (negative) s = -s;
    // text: hi, as the exact fraction p / q.
    var h = exactParts(hi), q = pow10(fraction.length), p;
    if (h.e >= 0) {
      p = s - (h.m << BigInt(h.e)) * q;
    } else {
      var two = BigInt(1) << BigInt(-h.e);
      p = s * two - h.m * q;
      q *= two;
    }
    var lo = ratioToNumber(p, q);
    // Renormalized, so the pair is a proper double-double even on an engine
    // whose Number() rounded the text a hair differently.
    var sum = hi + lo, bb = sum - hi;
    return [sum, (hi - (sum - bb)) + (lo - bb)];
  }

  // How many decimal places of a center are worth writing at this view
  // scale (world units per view height): a millionth of a pixel on a
  // thousand-pixel screen, far below anything the picture can show. At the
  // default framing that is 6 places; at the deepest zoom, 32.
  function centerDecimals(scale) {
    if (!(scale > 0)) return 6;
    return Math.min(45, Math.max(0, Math.ceil(9 - Math.log10(scale))));
  }
  // The same from a zoom alone, for a caller with no map of its own to ask
  // what scale that is (the movie player, writing the link back to the map).
  // Only ever decides how many digits to WRITE, so it needs the map's
  // framing at 1x no more exactly than this.
  var SCALE_AT_ZOOM_ONE = 200 / 0.17;
  function decimalsFor(view) {
    return centerDecimals(view.scale > 0 ? view.scale : SCALE_AT_ZOOM_ONE / view.zoom);
  }

  // ---- The scene ----
  //
  // Takes and returns the AUTHORED scene JSON, centered, +y up, exactly
  // what Export writes and Import reads (see physics-coords.js), so a link
  // goes through the same validation a pasted scene does, and describes the
  // scene relative to the middle of its frame rather than to one screen.

  function encodeBody(b) {
    var parts = [
      TYPE_CODES[b.type], sceneNum(b.x), sceneNum(b.y), sceneNum(b.angle), sceneNum(b[SIZE_FIELDS[b.type]]),
      sceneNum(b.vx), sceneNum(b.vy), sceneNum(b.w),
    ];
    // Most bodies start at rest: the three velocities are optional from
    // the right.
    while (parts.length > 5 && parts[parts.length - 1] === "0") parts.pop();
    return parts.join(":") + (b.isAnchored ? "!" : "");
  }
  function decodeBody(text, i) {
    var what = "body " + (i + 1);
    var anchored = text.charAt(text.length - 1) === "!";
    var parts = (anchored ? text.slice(0, -1) : text).split(":");
    var type = TYPES_BY_CODE[parts[0]];
    if (!type) throw new Error(what + " has an unknown shape: \"" + parts[0] + "\"");
    if (parts.length < 5 || parts.length > 8) throw new Error(what + " needs a shape, x, y, angle and size");
    var body = {
      type: type,
      x: parseNum(parts[1], what + "'s x"),
      y: parseNum(parts[2], what + "'s y"),
      angle: parseNum(parts[3], what + "'s angle"),
      isAnchored: anchored,
    };
    var size = parseNum(parts[4], what + "'s size");
    if (!(size > 0)) throw new Error(what + "'s size must be more than zero");
    body[SIZE_FIELDS[type]] = size;
    body.vx = parts.length > 5 ? parseNum(parts[5], what + "'s vx") : 0;
    body.vy = parts.length > 6 ? parseNum(parts[6], what + "'s vy") : 0;
    body.w = parts.length > 7 ? parseNum(parts[7], what + "'s spin") : 0;
    return body;
  }

  // "w" is the world: a hinge pinning a body to the background.
  function encodeHinge(h) {
    return [
      h.bodyA === null || h.bodyA === undefined ? "w" : h.bodyA, h.bodyB,
      sceneNum(h.localAnchorA.x), sceneNum(h.localAnchorA.y), sceneNum(h.localAnchorB.x), sceneNum(h.localAnchorB.y),
    ].join(":");
  }
  function decodeHinge(text, i) {
    var what = "hinge " + (i + 1);
    var parts = text.split(":");
    if (parts.length !== 6) throw new Error(what + " needs two bodies and two anchor points");
    return {
      bodyA: parts[0] === "w" ? null : parseIndex(parts[0], what + "'s first body"),
      bodyB: parseIndex(parts[1], what + "'s second body"),
      localAnchorA: { x: parseNum(parts[2], what), y: parseNum(parts[3], what) },
      localAnchorB: { x: parseNum(parts[4], what), y: parseNum(parts[5], what) },
    };
  }

  // A spring is a hinge's six parts and two more: its stiffness and its rest
  // length. "w" is the background here too.
  function encodeSpring(sp) {
    return [
      sp.bodyA === null || sp.bodyA === undefined ? "w" : sp.bodyA, sp.bodyB,
      sceneNum(sp.localAnchorA.x), sceneNum(sp.localAnchorA.y), sceneNum(sp.localAnchorB.x), sceneNum(sp.localAnchorB.y),
      sceneNum(sp.stiffness), sceneNum(sp.restLength),
    ].join(":");
  }
  function decodeSpring(text, i) {
    var what = "spring " + (i + 1);
    var parts = text.split(":");
    if (parts.length !== 8) throw new Error(what + " needs two ends, two anchor points, a stiffness and a rest length");
    return {
      bodyA: parts[0] === "w" ? null : parseIndex(parts[0], what + "'s first end"),
      bodyB: parseIndex(parts[1], what + "'s second end"),
      localAnchorA: { x: parseNum(parts[2], what), y: parseNum(parts[3], what) },
      localAnchorB: { x: parseNum(parts[4], what), y: parseNum(parts[5], what) },
      stiffness: parseNum(parts[6], what + "'s stiffness"),
      restLength: parseNum(parts[7], what + "'s rest length"),
    };
  }

  // "0.ang" is body 0's rotation; "1.2.dist" an Output read from a pair;
  // "life" alone is Scene Lifespan, which belongs to no body.
  function encodeMapping(m) {
    var parts = [];
    if (m.body !== null && m.body !== undefined) parts.push(m.body);
    if (typeof m.bodyB === "number") parts.push(m.bodyB);
    parts.push(PROPERTY_CODES[m.property]);
    return parts.join(".");
  }
  function decodeMapping(text, what, isOutput) {
    var parts = text.split(".");
    var property = PROPERTIES_BY_CODE[parts[parts.length - 1]];
    if (!property || parts.length > 3) throw new Error(what + " is not a mapping: \"" + text + "\"");
    var body = parts.length > 1 ? parseIndex(parts[0], what + "'s body") : null;
    if (!isOutput) return { body: body, property: property };
    return { body: body, bodyB: parts.length > 2 ? parseIndex(parts[1], what + "'s second body") : null, property: property };
  }

  function encodeScene(scene) {
    var fields = [];
    var bodies = scene.bodies || [], hinges = scene.hinges || [], springs = scene.springs || [];
    if (bodies.length) fields.push("body:" + bodies.map(encodeBody).join(";"));
    if (hinges.length) fields.push("hnge:" + hinges.map(encodeHinge).join(";"));
    if (springs.length) fields.push("sprg:" + springs.map(encodeSpring).join(";"));
    if (scene.xInput) fields.push("xinp:" + encodeMapping(scene.xInput));
    if (scene.yInput) fields.push("yinp:" + encodeMapping(scene.yInput));
    if (scene.output) fields.push("outp:" + encodeMapping(scene.output));
    if (scene.edgeMode && scene.edgeMode !== DEFAULT_EDGE) fields.push("edge:" + EDGE_CODES[scene.edgeMode]);
    if (scene.mutualGravity) fields.push("mgrv:t");
    if (scene.collisionsEnabled === false) fields.push("coll:f");
    if (scene.simulationSteps && scene.simulationSteps !== DEFAULT_STEPS) fields.push("step:" + scene.simulationSteps);
    if (scene.maxSimulationBodies && scene.maxSimulationBodies !== DEFAULT_MAX_BODIES) fields.push("maxb:" + scene.maxSimulationBodies);
    // Last on purpose: see this file's head on how a link must not end.
    fields.push("frmw:" + sceneNum(scene.frameWidth));
    fields.push("frmh:" + sceneNum(scene.frameHeight));
    return fields;
  }

  function parseBool(text, what) {
    if (text !== "t" && text !== "f") throw new Error(what + " must be t or f");
    return text === "t";
  }
  function splitList(text) { return text === "" ? [] : text.split(";"); }

  // Null when the link names no bodies: a page with nothing to load, which
  // is not the same as a scene that failed to parse (that throws).
  function decodeScene(fields) {
    if (!fields.body) return null;
    if (fields.edge !== undefined && !EDGES_BY_CODE[fields.edge]) throw new Error("edge is not a known mode: \"" + fields.edge + "\"");
    return {
      mutualGravity: fields.mgrv === undefined ? false : parseBool(fields.mgrv, "mgrv"),
      collisionsEnabled: fields.coll === undefined ? true : parseBool(fields.coll, "coll"),
      simulationSteps: fields.step === undefined ? DEFAULT_STEPS : parseNum(fields.step, "step"),
      bodies: splitList(fields.body).map(decodeBody),
      hinges: splitList(fields.hnge || "").map(decodeHinge),
      springs: splitList(fields.sprg || "").map(decodeSpring),
      xInput: fields.xinp ? decodeMapping(fields.xinp, "xinp", false) : null,
      yInput: fields.yinp ? decodeMapping(fields.yinp, "yinp", false) : null,
      output: fields.outp ? decodeMapping(fields.outp, "outp", true) : null,
      frameWidth: fields.frmw === undefined ? 0 : parseNum(fields.frmw, "frmw"),
      frameHeight: fields.frmh === undefined ? 0 : parseNum(fields.frmh, "frmh"),
      edgeMode: fields.edge === undefined ? DEFAULT_EDGE : EDGES_BY_CODE[fields.edge],
      maxSimulationBodies: fields.maxb === undefined ? DEFAULT_MAX_BODIES : parseNum(fields.maxb, "maxb"),
    };
  }

  // ---- The map's view ----
  //
  // What FractalGrid.shareState() hands over and applyShareView() takes
  // back:
  //
  //   { center: { x, xLo, y, yLo }, scale, zoom,
  //     display: "standard" | "colorzoom" | "gradient" | "laplacian" | "contours",
  //     lowSaturation: bool,
  //     precision, speed, volume,
  //     inspect: [ { type: "point", a: [u, v] },
  //                { type: "line", a: [u, v], b: [u, v], count: n },
  //                { type: "grid", a: [u, v], b: [u, v], size: n, twoPart: bool } ],
  //     movie: { keyframes: [ { center: { x, xLo, y, yLo }, scale, zoom, step, seconds } ],
  //              quality, loop } }
  //
  // A movie link ("movi") has no view of its own, its keyframes are its
  // views, so there `center`, `zoom` and `inspect` are simply absent.
  //
  // `zoom` is the number the map's own readout shows, `scale` the world
  // units per view height behind it (only used here to decide how many
  // digits of the center are worth writing). Inspection points are (u, v) in
  // VIEW HEIGHTS FROM THE CENTER rather than world coordinates: at a deep
  // zoom a world coordinate needs thirty-odd digits to land on the right
  // pixel, where an offset from a center that already carries them needs
  // nine, and nine is what they get, a millionth of a pixel.

  function uvNum(v) {
    v = Number(v) || 0;
    return num(Math.abs(v) < 1e6 ? Math.round(v * 1e9) / 1e9 : v);
  }
  function encodeInspect(group) {
    if (group.type === "point") return "p:" + uvNum(group.a[0]) + ":" + uvNum(group.a[1]);
    var ends = [uvNum(group.a[0]), uvNum(group.a[1]), uvNum(group.b[0]), uvNum(group.b[1])].join(":");
    if (group.type === "line") return "l:" + ends + ":" + group.count;
    return "g:" + ends + ":" + group.size + (group.twoPart ? "t" : "");
  }
  function decodeInspect(text) {
    var parts = text.split(":"), what = "insp";
    if (parts[0] === "p" && parts.length === 3) {
      return { type: "point", a: [parseNum(parts[1], what), parseNum(parts[2], what)] };
    }
    if ((parts[0] !== "l" && parts[0] !== "g") || parts.length !== 6) throw new Error("insp has an entry that is not a point, line or grid");
    var group = {
      type: parts[0] === "l" ? "line" : "grid",
      a: [parseNum(parts[1], what), parseNum(parts[2], what)],
      b: [parseNum(parts[3], what), parseNum(parts[4], what)],
    };
    if (group.type === "line") {
      group.count = parseIndex(parts[5], "insp's sample count");
    } else {
      group.twoPart = /t$/.test(parts[5]);
      group.size = parseIndex(parts[5].replace(/t$/, ""), "insp's grid size");
    }
    return group;
  }

  // Ten significant digits: a zoom off by more than that would shift the
  // pixels at the edge of the screen by more than the center's own
  // millionth.
  function zoomNum(zoom) {
    return num(Number(Number(zoom).toPrecision(10)));
  }
  function parseZoom(text, what) {
    var zoom = parseNum(text, what);
    if (!(zoom > 0)) throw new Error(what + " must be more than zero");
    return zoom;
  }

  // A movie keyframe (see movie-path.js): "x:y:zoom:frame", and a fifth part
  // when the move arriving at it has been given a length in seconds rather
  // than left to work one out. Each center gets the digits ITS OWN zoom can
  // use, so a movie that dives in costs long coordinates only where it is
  // deep.
  function encodeKeyframe(k) {
    var decimals = decimalsFor(k);
    var parts = [
      formatDD(k.center.x, k.center.xLo, decimals), formatDD(k.center.y, k.center.yLo, decimals),
      zoomNum(k.zoom), Math.round(k.step),
    ];
    if (Number(k.seconds) > 0) parts.push(num(Math.round(k.seconds * 10) / 10));
    return parts.join(":");
  }
  function decodeKeyframe(text) {
    var parts = text.split(":"), what = "kfrm";
    if (parts.length < 4 || parts.length > 5) throw new Error("kfrm has a keyframe that is not x, y, zoom and frame");
    var cx = parseDD(parts[0], what), cy = parseDD(parts[1], what);
    var seconds = parts.length > 4 ? parseNum(parts[4], what) : null;
    return {
      center: { x: cx[0], xLo: cx[1], y: cy[0], yLo: cy[1] },
      zoom: parseZoom(parts[2], what),
      step: parseIndex(parts[3], "kfrm's frame"),
      seconds: seconds > 0 ? seconds : null,
    };
  }

  function encodeView(view) {
    var fields = [];
    if (view.center) {
      var decimals = decimalsFor(view);
      var cx = formatDD(view.center.x, view.center.xLo, decimals), cy = formatDD(view.center.y, view.center.yLo, decimals);
      if (cx !== "0") fields.push("ctrx:" + cx);
      if (cy !== "0") fields.push("ctry:" + cy);
      var zoom = zoomNum(view.zoom);
      if (zoom !== "1") fields.push("zoom:" + zoom);
    }
    if (view.display && view.display !== "standard") fields.push("disp:" + DISPLAY_CODES[view.display]);
    // Standard's other switch, independent of the mode word above: it is
    // off by default and only ever recolors Standard, so it rides along on
    // its own rather than multiplying DISPLAY_CODES.
    if (view.lowSaturation === true) fields.push("lsat:t");
    if (view.precision && view.precision !== "f32") fields.push("prec:" + view.precision);
    if (view.speed !== undefined && num(view.speed) !== "1") fields.push("sped:" + num(view.speed));
    if (view.volume !== undefined && num(view.volume) !== "1") fields.push("snd:" + num(view.volume));
    if (view.inspect && view.inspect.length) fields.push("insp:" + view.inspect.map(encodeInspect).join(";"));
    // The settings ride along only with keyframes to apply them to.
    var movie = view.movie;
    if (movie && movie.keyframes && movie.keyframes.length) {
      fields.push("kfrm:" + movie.keyframes.map(encodeKeyframe).join(";"));
      if (movie.quality !== undefined && movie.quality !== DEFAULT_MOVIE_QUALITY) fields.push("qual:" + movie.quality);
      if (movie.loop === false) fields.push("loop:f");
    }
    return fields;
  }

  // Lenient where the scene is strict: a view field that doesn't parse is
  // dropped and the rest of the link still opens, since a slightly wrong
  // framing of the right map beats refusing to show it.
  function decodeView(fields) {
    function attempt(key, read, fallback) {
      if (fields[key] === undefined) return fallback;
      try { return read(fields[key]); } catch (err) { return fallback; }
    }
    var cx = attempt("ctrx", function (t) { return parseDD(t, "ctrx"); }, [0, 0]);
    var cy = attempt("ctry", function (t) { return parseDD(t, "ctry"); }, [0, 0]);
    return {
      center: { x: cx[0], xLo: cx[1], y: cy[0], yLo: cy[1] },
      zoom: attempt("zoom", function (t) { return parseZoom(t, "zoom"); }, 1),
      display: attempt("disp", function (t) { return DISPLAYS_BY_CODE[t] || "standard"; }, "standard"),
      lowSaturation: attempt("lsat", function (t) { return parseBool(t, "lsat"); }, false),
      precision: attempt("prec", function (t) { return PRECISIONS.indexOf(t) === -1 ? "f32" : t; }, "f32"),
      speed: attempt("sped", function (t) { return parseNum(t, "sped"); }, 1),
      volume: attempt("snd", function (t) { return Math.min(1, Math.max(0, parseNum(t, "snd"))); }, 1),
      inspect: attempt("insp", function (t) { return splitList(t).map(decodeInspect); }, []),
      movie: {
        keyframes: attempt("kfrm", function (t) { return splitList(t).map(decodeKeyframe); }, []),
        quality: attempt("qual", function (t) { return Math.min(DEFAULT_MOVIE_QUALITY, parseIndex(t, "qual")); }, DEFAULT_MOVIE_QUALITY),
        loop: attempt("loop", function (t) { return parseBool(t, "loop"); }, true),
      },
    };
  }

  // ---- The fragment ----

  // { page: "bldr" | "map" | "movi", scene, view } -> the fragment, without
  // its "#". The builder's link is the scene and nothing else; the other two
  // add their view of it.
  function encode(state) {
    var fields = encodeScene(state.scene);
    if (state.page !== PAGE_BUILDER && state.view) fields = fields.concat(encodeView(state.view));
    return state.page + "/" + fields.join(",");
  }

  // The fields of "key:value,key:value", as a plain map. A key this version
  // has never heard of is carried along and simply never read, which is what
  // lets a later version add one without breaking the links it writes for
  // anyone still on this one.
  function readFields(text) {
    var fields = {};
    text.split(",").forEach(function (field) {
      var colon = field.indexOf(":");
      if (colon > 0) fields[field.slice(0, colon)] = field.slice(colon + 1);
    });
    return fields;
  }

  // A fragment as it comes out of location.hash, down to the text encode()
  // wrote: some software percent-encodes the punctuation on the way through
  // (nothing here contains a literal "%", so undoing that is always safe),
  // and a link lifted out of a sentence can arrive with the sentence's own
  // closing punctuation still attached, which no link written here ends in.
  function cleanFragment(fragment) {
    var text = String(fragment || "").replace(/^#/, "");
    try { text = decodeURIComponent(text); } catch (err) { /* a stray %: read it as it stands */ }
    return text.replace(/[^A-Za-z0-9]+$/, "");
  }

  // null: not one of this app's links at all (no fragment, someone else's
  // anchor). Otherwise { page, scene, view }: scene null when the link
  // names a page but no bodies, view null for the builder. THROWS, with a
  // message fit to show, when it is one of these links and the scene in it
  // can't be read.
  function decode(fragment) {
    var text = cleanFragment(fragment);
    var slash = text.indexOf("/");
    var page = slash === -1 ? text : text.slice(0, slash);
    if (PAGES.indexOf(page) === -1) return null;
    var fields = readFields(slash === -1 ? "" : text.slice(slash + 1));
    return {
      page: page,
      scene: decodeScene(fields),
      view: page === PAGE_BUILDER ? null : decodeView(fields),
    };
  }

  global.ShareUrl = {
    PAGE_BUILDER: PAGE_BUILDER,
    PAGE_MAP: PAGE_MAP,
    PAGE_MOVIE: PAGE_MOVIE,
    encode: encode,
    decode: decode,
    // The pieces, for a page with fields of its own to add around them.
    encodeScene: encodeScene,
    decodeScene: decodeScene,
    readFields: readFields,
    cleanFragment: cleanFragment,
    num: num,
    parseNum: parseNum,
    parseIndex: parseIndex,
    formatDD: formatDD,
    parseDD: parseDD,
    centerDecimals: centerDecimals,
  };
})(typeof window !== "undefined" ? window : globalThis);
