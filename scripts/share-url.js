// CPAL-1.0 License. See chaosaccelerator.com/license.html

// The whole app state as a URL fragment, and back: pure text, no DOM or storage.
//   #bldr/v:1.0,body:ci:-132.1:321.4:.0021:30;ln:-334:-173.5:-.7679:479!,xinp:0.x,
//         yinp:0.y,outp:0.y,edge:wrap,frmw:1192,frmh:809
//   #map/v:1.0,<the same scene>,ctrx:-14.318359,ctry:57.44,zoom:3.2,disp:lapl,
//         insp:p:.0115:.0075;l:-.2875:-.1018:.2973:.143:30
//   chaosplayback.html#movi/v:1.0,<the same scene>,disp:lapl,
//         kfrm:0:0:1:1000;-14.318359:57.44:3.2:500:4
// v is the link format version, always the first field, and required in a link with a scene.
// Page first, then comma-separated key:value fields; ":" splits the parts of one
// thing, ";" items in a list; nothing is percent-encoded. WIRE DEFAULTS: a field
// at its default is left out, and those defaults belong to THIS FORMAT, never to
// the editor's new-scene settings. A link never ends in punctuation: chat apps
// drop a trailing "!" or "," from links.
(function (global) {
  "use strict";

  var PAGE_BUILDER = "bldr";
  var PAGE_MAP = "map";
  var PAGE_MOVIE = "movi";
  var PAGES = [PAGE_BUILDER, PAGE_MAP, PAGE_MOVIE];
  var VERSION = "1.0";
  var NEWER_VERSION_MESSAGE = "Attempting to load a scene created with a newer version. Consider upgrading and then loading again.";

  var DEFAULT_STEPS = 1000;
  var DEFAULT_EDGE = "sticky";
  var DEFAULT_MOVIE_SIZE = { width: 1280, height: 720 };

  // A portal's code carries its color.
  var TYPE_CODES = { circle: "ci", line: "ln", "portal orange": "po", "portal green": "pg" };
  var SIZE_FIELDS = { circle: "radius", line: "length", portal: "length" };
  function shapeKey(b) { return b.type === "portal" ? "portal " + b.color : b.type; }
  var PROPERTY_CODES = {
    x: "x", y: "y", angle: "ang", radius: "rad", length: "len", vx: "vx", vy: "vy",
    bounces: "bnce", distance: "dist", lifespan: "life", totalRotation: "turn", warps: "warp", basin: "basn",
  };
  var EDGE_CODES = { sticky: "stik", wrap: "wrap", infinite: "infi" };
  var DISPLAY_CODES = { standard: "std", colorzoom: "czom", gradient: "grad", laplacian: "lapl", contours: "cont", ftle: "ftle" };
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

  // Shortest exact text, minus what a reader doesn't need (".5", "1e21"; "+" reads as a space in some software).
  function num(v) {
    if (!isFinite(v) || v === 0) return "0";
    return String(v).replace("e+", "e").replace(/^(-?)0\./, "$1.");
  }
  function sceneNum(v) {
    return num(Math.round((Number(v) || 0) * 1e4) / 1e4);
  }
  // Number() alone accepts "", " " and "0x10": only a plain decimal with optional exponent passes.
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

  // ---- Double-double decimals ---- the map's center is hi + lo (~106 bits), sent as ONE
  // decimal. BigInt(n) calls rather than 10n literals: a browser without BigInt must still parse.
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
  // Two exact values added; a zero never drags the exponent down.
  function addExact(a, b) {
    if (a.m === BigInt(0)) return b;
    if (b.m === BigInt(0)) return a;
    var e = Math.min(a.e, b.e);
    return { m: (a.m << BigInt(a.e - e)) + (b.m << BigInt(b.e - e)), e: e };
  }
  // hi + lo === m * 2^e exactly.
  function exactSum(hi, lo) {
    return addExact(exactParts(hi), exactParts(lo));
  }
  function pow10(n) {
    var r = BigInt(1), ten = BigInt(10);
    for (var i = 0; i < n; i++) r *= ten;
    return r;
  }

  // num / den (den > 0) to `decimals` places, halves away from zero, trailing zeros kept.
  function fixedRatio(num, den, decimals) {
    var negative = num < BigInt(0);
    if (negative) num = -num;
    var two = BigInt(2);
    var digits = ((num * pow10(decimals) * two + den) / (den * two)).toString();
    while (digits.length <= decimals) digits = "0" + digits;
    var cut = digits.length - decimals;
    return (negative ? "-" : "") + digits.slice(0, cut) + (decimals ? "." + digits.slice(cut) : "");
  }

  // hi + lo to `decimals` places, trailing zeros kept and never "-0": for showing.
  function fixedDD(hi, lo, decimals) {
    hi = Number(hi) || 0; lo = Number(lo) || 0;
    var text;
    if (!HAS_BIGINT || lo === 0) {
      text = hi.toFixed(Math.min(decimals, 100));
    } else {
      var x = exactSum(hi, lo);
      text = x.e >= 0 ? fixedRatio(x.m << BigInt(x.e), BigInt(1), decimals) : fixedRatio(x.m, BigInt(1) << BigInt(-x.e), decimals);
    }
    return /^-[0.]*$/.test(text) ? text.slice(1) : text;
  }
  // hi + lo, rounded to `decimals` places, trailing zeros dropped.
  function formatDD(hi, lo, decimals) {
    return trimFixed(fixedDD(hi, lo, decimals));
  }
  function trimFixed(text) {
    if (text.indexOf(".") !== -1) text = text.replace(/0+$/, "").replace(/\.$/, "");
    text = text.replace(/^(-?)0\./, "$1.");
    return (text === "" || text === "-" || text === "-0") ? "0" : text;
  }

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

  // p / q (q > 0) as a double-double: the nearest double, then what it misses.
  function ddFromRatio(p, q) {
    var hi = ratioToNumber(p, q);
    var h = exactParts(hi), r, rq = q;
    if (h.e >= 0) {
      r = p - (h.m << BigInt(h.e)) * q;
    } else {
      r = (p << BigInt(-h.e)) - h.m * q;
      rq = q << BigInt(-h.e);
    }
    var lo = ratioToNumber(r, rq);
    var sum = hi + lo, bb = sum - hi;
    return [sum, (hi - (sum - bb)) + (lo - bb)];
  }

  var PLAIN_DECIMAL_RE = /^-?(?:\d+\.?\d*|\.\d+)$/;
  // A plain decimal's exact value, num / den.
  function decimalRatio(text) {
    var negative = text.charAt(0) === "-";
    var body = negative ? text.slice(1) : text;
    var dot = body.indexOf(".");
    var fraction = dot === -1 ? "" : body.slice(dot + 1);
    var num = BigInt(((dot === -1 ? body : body.slice(0, dot)) + fraction) || "0");
    return { num: negative ? -num : num, den: pow10(fraction.length) };
  }
  function parseDD(text, what) {
    // Bounded so a hostile link can't buy seconds of BigInt arithmetic.
    if (text.length > 80 || !PLAIN_DECIMAL_RE.test(text)) return [parseNum(text, what), 0];
    var hi = Number(text);
    if (!HAS_BIGINT || !isFinite(hi)) return [hi, 0];
    var exact = decimalRatio(text);
    var h = exactParts(hi), q = exact.den, p;
    if (h.e >= 0) {
      p = exact.num - (h.m << BigInt(h.e)) * q;
    } else {
      var two = BigInt(1) << BigInt(-h.e);
      p = exact.num * two - h.m * q;
      q *= two;
    }
    var lo = ratioToNumber(p, q);
    var sum = hi + lo, bb = sum - hi;
    return [sum, (hi - (sum - bb)) + (lo - bb)];
  }

  // Decimal places worth writing at this scale: a millionth of a pixel. 6 at default framing, 32 deepest.
  function centerDecimals(scale) {
    if (!(scale > 0)) return 6;
    return Math.min(45, Math.max(0, Math.ceil(9 - Math.log10(scale))));
  }
  var SCALE_AT_ZOOM_ONE = 200 / 0.17;
  function decimalsFor(view) {
    return centerDecimals(view.scale > 0 ? view.scale : SCALE_AT_ZOOM_ONE / view.zoom);
  }

  // ---- The scene ---- the AUTHORED scene JSON (centered, +y up), as the samples and the editor's autosave hold it.

  function encodeBody(b) {
    var parts = [
      TYPE_CODES[shapeKey(b)], sceneNum(b.x), sceneNum(b.y), sceneNum(b.angle), sceneNum(b[SIZE_FIELDS[b.type]]),
      sceneNum(b.vx), sceneNum(b.vy), sceneNum(b.w),
    ];
    while (parts.length > 5 && parts[parts.length - 1] === "0") parts.pop();
    return parts.join(":") + (b.isAnchored ? "!" : "");
  }
  function decodeBody(text, i) {
    var what = "body " + (i + 1);
    var anchored = text.charAt(text.length - 1) === "!";
    var parts = (anchored ? text.slice(0, -1) : text).split(":");
    var shape = TYPES_BY_CODE[parts[0]];
    if (!shape) throw new Error(what + " has an unknown shape: \"" + parts[0] + "\"");
    if (parts.length < 5 || parts.length > 8) throw new Error(what + " needs a shape, x, y, angle and size");
    var type = shape.split(" ")[0];
    var body = {
      type: type,
      x: parseNum(parts[1], what + "'s x"),
      y: parseNum(parts[2], what + "'s y"),
      angle: parseNum(parts[3], what + "'s angle"),
      isAnchored: anchored,
    };
    if (type === "portal") body.color = shape.split(" ")[1];
    var size = parseNum(parts[4], what + "'s size");
    if (!(size > 0)) throw new Error(what + "'s size must be more than zero");
    body[SIZE_FIELDS[type]] = size;
    body.vx = parts.length > 5 ? parseNum(parts[5], what + "'s vx") : 0;
    body.vy = parts.length > 6 ? parseNum(parts[6], what + "'s vy") : 0;
    body.w = parts.length > 7 ? parseNum(parts[7], what + "'s spin") : 0;
    return body;
  }

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

  // x:y:color, color being the basin's color index.
  function encodeBasin(b) {
    return [sceneNum(b.x), sceneNum(b.y), b.color].join(":");
  }
  function decodeBasin(text, i) {
    var what = "basin " + (i + 1);
    var parts = text.split(":");
    if (parts.length !== 3) throw new Error(what + " needs an x, a y and a color");
    return { x: parseNum(parts[0], what + "'s x"), y: parseNum(parts[1], what + "'s y"), color: parseIndex(parts[2], what + "'s color") };
  }

  // "0.ang" is body 0's rotation; "1.2.dist" an Output read from a pair; "life" alone is Scene Lifespan.
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
    if (scene.basins && scene.basins.length) fields.push("basn:" + scene.basins.map(encodeBasin).join(";"));
    if (scene.edgeMode && scene.edgeMode !== DEFAULT_EDGE) fields.push("edge:" + EDGE_CODES[scene.edgeMode]);
    if (scene.mutualGravity) fields.push("mgrv:t");
    if (scene.collisionsEnabled === false) fields.push("coll:f");
    if (scene.friction > 0) fields.push("fric:" + sceneNum(scene.friction));
    if (scene.simulationSteps && scene.simulationSteps !== DEFAULT_STEPS) fields.push("step:" + scene.simulationSteps);
    fields.push("frmw:" + sceneNum(scene.frameWidth));
    fields.push("frmh:" + sceneNum(scene.frameHeight));
    return fields;
  }

  function parseBool(text, what) {
    if (text !== "t" && text !== "f") throw new Error(what + " must be t or f");
    return text === "t";
  }
  function splitList(text) { return text === "" ? [] : text.split(";"); }

  // "body:" with nothing after it is an empty scene; no body field at all is no scene.
  function decodeScene(fields) {
    if (fields.body === undefined) return null;
    if (fields.edge !== undefined && !EDGES_BY_CODE[fields.edge]) throw new Error("edge is not a known mode: \"" + fields.edge + "\"");
    var bodies = splitList(fields.body).map(decodeBody);
    var portals = {};
    bodies.forEach(function (b, i) {
      if (b.type !== "portal") return;
      if (portals[b.color]) throw new Error("body " + (i + 1) + " is a second " + b.color + " portal");
      portals[b.color] = true;
    });
    var scene = {
      mutualGravity: fields.mgrv === undefined ? false : parseBool(fields.mgrv, "mgrv"),
      collisionsEnabled: fields.coll === undefined ? true : parseBool(fields.coll, "coll"),
      friction: fields.fric === undefined ? 0 : parseNum(fields.fric, "fric"),
      simulationSteps: fields.step === undefined ? DEFAULT_STEPS : parseNum(fields.step, "step"),
      bodies: bodies,
      hinges: splitList(fields.hnge || "").map(decodeHinge),
      springs: splitList(fields.sprg || "").map(decodeSpring),
      xInput: fields.xinp ? decodeMapping(fields.xinp, "xinp", false) : null,
      yInput: fields.yinp ? decodeMapping(fields.yinp, "yinp", false) : null,
      output: fields.outp ? decodeMapping(fields.outp, "outp", true) : null,
      frameWidth: fields.frmw === undefined ? 0 : parseNum(fields.frmw, "frmw"),
      frameHeight: fields.frmh === undefined ? 0 : parseNum(fields.frmh, "frmh"),
      edgeMode: fields.edge === undefined ? DEFAULT_EDGE : EDGES_BY_CODE[fields.edge],
    };
    if (fields.basn !== undefined) scene.basins = splitList(fields.basn).map(decodeBasin);
    return scene;
  }

  // ---- The map's view ---- what FractalGrid.shareState() hands over and applyShareView()
  // A missing precision, speed or volume reads as undefined: the viewer keeps their own setting.
  // takes back: { center: {x, xLo, y, yLo}, scale, zoom, display, lowSaturation, precision, speed,
  // volume, inspect: [{type, a, b, count|size, twoPart, places}], movie: {keyframes, size: {width, height}, antialias, loop, subject, background, filled, pace} }.
  // A movie's subject is "map" (its keyframes) or "inspect" (the Inspect tab's points, played once, on a
  // "plain", "grid" or "black" background, bodies it outlines drawn solid if filled, slowed to a pace of 0.5 or 0.25).
  // A keyframe is {center, zoom, step, seconds, friction}; seconds and friction (a fraction 0 to 0.99) are null when unset.
  // Inspect a and b are world points {x, xLo, y, yLo}, written as view heights from the center to the places
  // (centerDecimals) of the zoom they were picked at; places is written only when it isn't the view's own.

  // The center and zoom as a reader of the link gets them back.
  function inspectFrame(center, zoom) {
    var scale = SCALE_AT_ZOOM_ONE / zoom;
    return { x: center.x, xLo: center.xLo, y: center.y, yLo: center.yLo, scale: scale, places: centerDecimals(scale) };
  }
  // (hi + lo - centerHi - centerLo) / scale, exactly, to `decimals` places.
  function offsetText(hi, lo, centerHi, centerLo, scale, decimals) {
    hi = Number(hi) || 0; lo = Number(lo) || 0;
    if (!HAS_BIGINT) return trimFixed((((hi - centerHi) + (lo - centerLo)) / scale).toFixed(Math.min(decimals, 100)));
    var d = addExact(exactSum(hi, lo), exactSum(-centerHi, -centerLo)), s = exactParts(scale);
    var num = d.m, den = s.m;
    if (d.e >= s.e) num <<= BigInt(d.e - s.e);
    else den <<= BigInt(s.e - d.e);
    return trimFixed(fixedRatio(num, den, decimals));
  }
  // center + text * scale, exactly, as a double-double. Older links wrote floats, some with exponents.
  function offsetPoint(text, centerHi, centerLo, scale, what) {
    var u = parseNum(text, what);
    if (!HAS_BIGINT) return [centerHi + u * scale, 0];
    var num, den;
    if (text.length <= 100 && PLAIN_DECIMAL_RE.test(text)) {
      var exact = decimalRatio(text);
      num = exact.num; den = exact.den;
    } else {
      var x = exactParts(u);
      num = x.e >= 0 ? x.m << BigInt(x.e) : x.m;
      den = x.e >= 0 ? BigInt(1) : BigInt(1) << BigInt(-x.e);
    }
    // (center * den + num * scale) / den
    var c = exactSum(centerHi, centerLo), s = exactParts(scale);
    var p = addExact({ m: c.m * den, e: c.e }, { m: num * s.m, e: s.e });
    return p.e >= 0 ? ddFromRatio(p.m << BigInt(p.e), den) : ddFromRatio(p.m, den << BigInt(-p.e));
  }

  function encodeInspect(group, frame) {
    var places = group.places >= 0 ? Math.min(45, Math.round(group.places)) : frame.places;
    var decimals = Math.min(60, Math.max(0, Math.ceil(places + Math.log10(frame.scale))));
    function at(p) {
      return offsetText(p.x, p.xLo, frame.x, frame.xLo, frame.scale, decimals) + ":" + offsetText(p.y, p.yLo, frame.y, frame.yLo, frame.scale, decimals);
    }
    var text;
    if (group.type === "point") text = "p:" + at(group.a);
    else if (group.type === "line") text = "l:" + at(group.a) + ":" + at(group.b) + ":" + group.count;
    else text = "g:" + at(group.a) + ":" + at(group.b) + ":" + group.size + (group.twoPart ? "t" : "");
    return places === frame.places ? text : text + ":" + places;
  }
  function decodeInspect(text, frame) {
    var parts = text.split(":"), what = "insp";
    var length = parts[0] === "p" ? 3 : 6;
    if ((parts[0] !== "p" && parts[0] !== "l" && parts[0] !== "g") || (parts.length !== length && parts.length !== length + 1)) {
      throw new Error("insp has an entry that is not a point, line or grid");
    }
    function at(i) {
      var x = offsetPoint(parts[i], frame.x, frame.xLo, frame.scale, what), y = offsetPoint(parts[i + 1], frame.y, frame.yLo, frame.scale, what);
      return { x: x[0], xLo: x[1], y: y[0], yLo: y[1] };
    }
    var places = parts.length > length ? Math.min(45, parseIndex(parts[length], "insp's places")) : frame.places;
    if (parts[0] === "p") return { type: "point", a: at(1), places: places };
    var group = { type: parts[0] === "l" ? "line" : "grid", a: at(1), b: at(3), places: places };
    if (group.type === "line") {
      group.count = parseIndex(parts[5], "insp's sample count");
    } else {
      group.twoPart = /t$/.test(parts[5]);
      group.size = parseIndex(parts[5].replace(/t$/, ""), "insp's grid size");
    }
    return group;
  }

  function zoomNum(zoom) {
    return num(Number(Number(zoom).toPrecision(10)));
  }
  function parseZoom(text, what) {
    var zoom = parseNum(text, what);
    if (!(zoom > 0)) throw new Error(what + " must be more than zero");
    return zoom;
  }

  // "x:y:zoom:frame[:seconds][:friction]", an empty seconds slot when only friction is set.
  // Each center gets the digits its own zoom needs.
  function encodeKeyframe(k) {
    var decimals = decimalsFor(k);
    var parts = [
      formatDD(k.center.x, k.center.xLo, decimals), formatDD(k.center.y, k.center.yLo, decimals),
      zoomNum(k.zoom), Math.round(k.step),
      Number(k.seconds) > 0 ? num(Math.round(k.seconds * 10) / 10) : "",
      k.friction === null || k.friction === undefined ? "" : sceneNum(k.friction),
    ];
    while (parts.length > 4 && parts[parts.length - 1] === "") parts.pop();
    return parts.join(":");
  }
  function decodeKeyframe(text) {
    var parts = text.split(":"), what = "kfrm";
    if (parts.length < 4 || parts.length > 6) throw new Error("kfrm has a keyframe that is not x, y, zoom and frame");
    var cx = parseDD(parts[0], what), cy = parseDD(parts[1], what);
    var seconds = parts.length > 4 && parts[4] !== "" ? parseNum(parts[4], what) : null;
    var friction = parts.length > 5 ? Math.min(0.99, Math.max(0, parseNum(parts[5], "kfrm's friction"))) : null;
    return {
      center: { x: cx[0], xLo: cx[1], y: cy[0], yLo: cy[1] },
      zoom: parseZoom(parts[2], what),
      step: parseIndex(parts[3], "kfrm's frame"),
      seconds: seconds > 0 ? seconds : null,
      friction: friction,
    };
  }

  // "1920x1080": the movie's frame in pixels.
  function parseMovieSize(text) {
    var m = /^(\d+)x(\d+)$/.exec(text);
    var width = m ? Number(m[1]) : 0, height = m ? Number(m[2]) : 0;
    if (!(width >= 16 && width <= 4096 && height >= 16 && height <= 4096)) throw new Error("size must be pixels across and down, 16 to 4096 each");
    return { width: width, height: height };
  }

  // The precision a link leaves out: this device's default, set by the map. null writes any precision.
  var omittedPrecision = null;
  function setOmittedPrecision(p) { omittedPrecision = p || null; }

  function encodeView(view) {
    var fields = [];
    // Inspect points are written against the center and zoom as a reader gets them back.
    var center = { x: 0, xLo: 0, y: 0, yLo: 0 }, readZoom = 1;
    if (view.center) {
      var decimals = decimalsFor(view);
      var cx = formatDD(view.center.x, view.center.xLo, decimals), cy = formatDD(view.center.y, view.center.yLo, decimals);
      if (cx !== "0") fields.push("ctrx:" + cx);
      if (cy !== "0") fields.push("ctry:" + cy);
      var zoom = zoomNum(view.zoom);
      if (zoom !== "1") fields.push("zoom:" + zoom);
      var x = parseDD(cx, "ctrx"), y = parseDD(cy, "ctry");
      center = { x: x[0], xLo: x[1], y: y[0], yLo: y[1] };
      readZoom = Number(zoom) > 0 ? Number(zoom) : 1;
    }
    if (view.display && view.display !== "standard") fields.push("disp:" + DISPLAY_CODES[view.display]);
    if (view.lowSaturation === true) fields.push("lsat:t");
    if (view.precision && view.precision !== omittedPrecision) fields.push("prec:" + view.precision);
    if (view.samplePrecision === true) fields.push("spre:t");
    if (view.speed !== undefined && num(view.speed) !== "1") fields.push("sped:" + num(view.speed));
    if (view.volume !== undefined && num(view.volume) !== "0") fields.push("snd:" + num(view.volume));
    if (view.inspect && view.inspect.length) {
      var frame = inspectFrame(center, readZoom);
      fields.push("insp:" + view.inspect.map(function (group) { return encodeInspect(group, frame); }).join(";"));
    }
    var movie = view.movie;
    var hasKeyframes = movie && movie.keyframes && movie.keyframes.length, ofInspect = movie && movie.subject === "inspect";
    if (hasKeyframes) fields.push("kfrm:" + movie.keyframes.map(encodeKeyframe).join(";"));
    // Also with Inspect points: a movie of the Inspect tab is made at this size.
    if (movie && (hasKeyframes || ofInspect || (view.inspect && view.inspect.length))) {
      var size = movie.size || DEFAULT_MOVIE_SIZE;
      if (size.width !== DEFAULT_MOVIE_SIZE.width || size.height !== DEFAULT_MOVIE_SIZE.height) fields.push("size:" + size.width + "x" + size.height);
      if (movie.antialias === false) fields.push("aa:f");
      if (movie.loop === false) fields.push("loop:f");
    }
    if (ofInspect) fields.push("subj:insp");
    if (ofInspect && movie.background && movie.background !== "plain") fields.push("bkgd:" + movie.background);
    if (ofInspect && movie.filled) fields.push("fill:t");
    if (ofInspect && movie.pace && movie.pace !== 1) fields.push("pace:" + num(movie.pace));
    return fields;
  }

  function decodeView(fields) {
    var unread = [];
    function attempt(key, read, fallback) {
      if (fields[key] === undefined) return fallback;
      try { return read(fields[key]); } catch (err) { unread.push(key); return fallback; }
    }
    var cx = attempt("ctrx", function (t) { return parseDD(t, "ctrx"); }, [0, 0]);
    var cy = attempt("ctry", function (t) { return parseDD(t, "ctry"); }, [0, 0]);
    var center = { x: cx[0], xLo: cx[1], y: cy[0], yLo: cy[1] };
    var zoom = attempt("zoom", function (t) { return parseZoom(t, "zoom"); }, 1);
    var frame = inspectFrame(center, zoom);
    return {
      center: center,
      zoom: zoom,
      display: attempt("disp", function (t) { return DISPLAYS_BY_CODE[t] || "standard"; }, "standard"),
      lowSaturation: attempt("lsat", function (t) { return parseBool(t, "lsat"); }, false),
      precision: attempt("prec", function (t) { return PRECISIONS.indexOf(t) === -1 ? undefined : t; }, undefined),
      samplePrecision: attempt("spre", function (t) { return parseBool(t, "spre"); }, undefined),
      speed: attempt("sped", function (t) { return parseNum(t, "sped"); }, undefined),
      volume: attempt("snd", function (t) { return Math.min(1, Math.max(0, parseNum(t, "snd"))); }, undefined),
      inspect: attempt("insp", function (t) { return splitList(t).map(function (entry) { return decodeInspect(entry, frame); }); }, []),
      movie: {
        keyframes: attempt("kfrm", function (t) { return splitList(t).map(decodeKeyframe); }, []),
        size: attempt("size", parseMovieSize, { width: DEFAULT_MOVIE_SIZE.width, height: DEFAULT_MOVIE_SIZE.height }),
        antialias: attempt("aa", function (t) { return parseBool(t, "aa"); }, true),
        loop: attempt("loop", function (t) { return parseBool(t, "loop"); }, true),
        subject: attempt("subj", function (t) { return t === "insp" ? "inspect" : "map"; }, "map"),
        background: attempt("bkgd", function (t) { return t === "grid" || t === "black" ? t : "plain"; }, "plain"),
        filled: attempt("fill", function (t) { return parseBool(t, "fill"); }, false),
        pace: attempt("pace", function (t) { var v = parseNum(t, "pace"); return v === 0.5 || v === 0.25 ? v : 1; }, 1),
      },
      unread: unread, // keys of fields that were there but couldn't be read, so are at their defaults
    };
  }

  // ---- The fragment ----

  function encode(state) {
    var fields = ["v:" + VERSION].concat(encodeScene(state.scene));
    if (state.page !== PAGE_BUILDER && state.view) fields = fields.concat(encodeView(state.view));
    return state.page + "/" + fields.join(",");
  }

  // Unknown keys are carried along unread, so a later version can add one.
  function readFields(text) {
    var fields = {};
    text.split(",").forEach(function (field) {
      var colon = field.indexOf(":");
      if (colon > 0) fields[field.slice(0, colon)] = field.slice(colon + 1);
    });
    return fields;
  }

  // Undoes percent-encoding added in transit (nothing here has a literal "%") and strips trailing punctuation.
  function cleanFragment(fragment) {
    var text = String(fragment || "").replace(/^#/, "");
    try { text = decodeURIComponent(text); } catch (err) { /* a stray %: read it as it stands */ }
    return text.replace(/[^A-Za-z0-9]+$/, "");
  }

  // "1.0" or "2": compared part by part, so 1.10 is newer than 1.9.
  function versionParts(text) {
    if (!/^\d+(\.\d+)?$/.test(text)) throw new Error("v is not a version: \"" + text + "\"");
    var parts = text.split(".");
    return [Number(parts[0]), Number(parts[1] || 0)];
  }
  function isNewerVersion(text) {
    var a = versionParts(text), b = versionParts(VERSION);
    return a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);
  }

  // null when not one of this app's links. THROWS, with a message fit to show, when the scene can't be read.
  // A bare "#bldr/" carries no scene and needs no v.
  function decode(fragment) {
    var text = cleanFragment(fragment);
    var slash = text.indexOf("/");
    var page = slash === -1 ? text : text.slice(0, slash);
    if (PAGES.indexOf(page) === -1) return null;
    var fields = readFields(slash === -1 ? "" : text.slice(slash + 1));
    if (fields.v === undefined && fields.body !== undefined) throw new Error("the link has no version");
    var newer = fields.v !== undefined && isNewerVersion(fields.v);
    var scene;
    try {
      scene = decodeScene(fields);
    } catch (err) {
      if (newer) err.message += ". " + NEWER_VERSION_MESSAGE;
      throw err;
    }
    return {
      page: page,
      version: fields.v,
      newerVersion: newer,
      scene: scene,
      view: page === PAGE_BUILDER ? null : decodeView(fields),
    };
  }

  global.ShareUrl = {
    PAGE_BUILDER: PAGE_BUILDER,
    PAGE_MAP: PAGE_MAP,
    PAGE_MOVIE: PAGE_MOVIE,
    VERSION: VERSION,
    NEWER_VERSION_MESSAGE: NEWER_VERSION_MESSAGE,
    encode: encode,
    decode: decode,
    encodeScene: encodeScene,
    decodeScene: decodeScene,
    readFields: readFields,
    cleanFragment: cleanFragment,
    num: num,
    parseNum: parseNum,
    parseIndex: parseIndex,
    formatDD: formatDD,
    fixedDD: fixedDD,
    parseDD: parseDD,
    centerDecimals: centerDecimals,
    setOmittedPrecision: setOmittedPrecision,
  };
})(typeof window !== "undefined" ? window : globalThis);
