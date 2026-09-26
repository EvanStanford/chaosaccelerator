// CPAL-1.0 License. See chaosaccelerator.com/license.html

// The whole app state as a URL fragment, and back: pure text, no DOM or storage.
//   #bldr/body:ci:-132.1:321.4:.0021:30;ln:-334:-173.5:-.7679:479!,xinp:0.x,
//         yinp:0.y,outp:0.y,edge:wrap,frmw:1192,frmh:809
//   #map/<the same scene>,ctrx:-14.318359,ctry:57.44,zoom:3.2,disp:lapl,
//         insp:p:.0115:.0075;l:-.2875:-.1018:.2973:.143:30
//   chaosplayback.html#movi/<the same scene>,disp:lapl,
//         kfrm:0:0:1:1000;-14.318359:57.44:3.2:500:4
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

  var DEFAULT_STEPS = 1000;
  var DEFAULT_MAX_BODIES = 20;
  var DEFAULT_EDGE = "sticky";
  var DEFAULT_MOVIE_QUALITY = 4;

  var TYPE_CODES = { circle: "ci", line: "ln", funnel: "fu", splitter: "sp" };
  var SIZE_FIELDS = { circle: "radius", line: "length", funnel: "size", splitter: "size" };
  var PROPERTY_CODES = {
    x: "x", y: "y", angle: "ang", radius: "rad", length: "len", size: "siz", vx: "vx", vy: "vy",
    bounces: "bnce", distance: "dist", lifespan: "life",
  };
  var EDGE_CODES = { sticky: "stik", wrap: "wrap", infinite: "infi" };
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
  function pow10(n) {
    var r = BigInt(1), ten = BigInt(10);
    for (var i = 0; i < n; i++) r *= ten;
    return r;
  }

  // hi + lo, rounded to `decimals` places, trailing zeros dropped.
  function formatDD(hi, lo, decimals) {
    hi = Number(hi) || 0; lo = Number(lo) || 0;
    if (!HAS_BIGINT || lo === 0) return trimFixed(hi.toFixed(Math.min(decimals, 100)));
    var a = exactParts(hi), b = exactParts(lo);
    var e = Math.min(a.e, b.e);
    var m = (a.m << BigInt(a.e - e)) + (b.m << BigInt(b.e - e));
    var scaled = m * pow10(decimals);
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
  function parseDD(text, what) {
    // Bounded so a hostile link can't buy seconds of BigInt arithmetic.
    if (text.length > 80 || !PLAIN_DECIMAL_RE.test(text)) return [parseNum(text, what), 0];
    var hi = Number(text);
    if (!HAS_BIGINT || !isFinite(hi)) return [hi, 0];
    var negative = text.charAt(0) === "-";
    var body = negative ? text.slice(1) : text;
    var dot = body.indexOf(".");
    var fraction = dot === -1 ? "" : body.slice(dot + 1);
    var s = BigInt(((dot === -1 ? body : body.slice(0, dot)) + fraction) || "0");
    if (negative) s = -s;
    var h = exactParts(hi), q = pow10(fraction.length), p;
    if (h.e >= 0) {
      p = s - (h.m << BigInt(h.e)) * q;
    } else {
      var two = BigInt(1) << BigInt(-h.e);
      p = s * two - h.m * q;
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

  // ---- The scene ---- the AUTHORED scene JSON (centered, +y up), what Export writes and Import reads.

  function encodeBody(b) {
    var parts = [
      TYPE_CODES[b.type], sceneNum(b.x), sceneNum(b.y), sceneNum(b.angle), sceneNum(b[SIZE_FIELDS[b.type]]),
      sceneNum(b.vx), sceneNum(b.vy), sceneNum(b.w),
    ];
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
    if (scene.edgeMode && scene.edgeMode !== DEFAULT_EDGE) fields.push("edge:" + EDGE_CODES[scene.edgeMode]);
    if (scene.mutualGravity) fields.push("mgrv:t");
    if (scene.collisionsEnabled === false) fields.push("coll:f");
    if (scene.simulationSteps && scene.simulationSteps !== DEFAULT_STEPS) fields.push("step:" + scene.simulationSteps);
    if (scene.maxSimulationBodies && scene.maxSimulationBodies !== DEFAULT_MAX_BODIES) fields.push("maxb:" + scene.maxSimulationBodies);
    fields.push("frmw:" + sceneNum(scene.frameWidth));
    fields.push("frmh:" + sceneNum(scene.frameHeight));
    return fields;
  }

  function parseBool(text, what) {
    if (text !== "t" && text !== "f") throw new Error(what + " must be t or f");
    return text === "t";
  }
  function splitList(text) { return text === "" ? [] : text.split(";"); }

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

  // ---- The map's view ---- what FractalGrid.shareState() hands over and applyShareView()
  // takes back: { center: {x, xLo, y, yLo}, scale, zoom, display, lowSaturation, precision, speed,
  // volume, inspect: [{type, a, b, count|size, twoPart}], movie: {keyframes, quality, loop} }.
  // Inspect points are (u, v) in VIEW HEIGHTS FROM THE CENTER, not world coordinates.

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

  function zoomNum(zoom) {
    return num(Number(Number(zoom).toPrecision(10)));
  }
  function parseZoom(text, what) {
    var zoom = parseNum(text, what);
    if (!(zoom > 0)) throw new Error(what + " must be more than zero");
    return zoom;
  }

  // "x:y:zoom:frame", plus seconds when the move was given a length. Each center gets the digits ITS OWN zoom needs.
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
    if (view.lowSaturation === true) fields.push("lsat:t");
    if (view.precision && view.precision !== "f32") fields.push("prec:" + view.precision);
    if (view.speed !== undefined && num(view.speed) !== "1") fields.push("sped:" + num(view.speed));
    if (view.volume !== undefined && num(view.volume) !== "1") fields.push("snd:" + num(view.volume));
    if (view.inspect && view.inspect.length) fields.push("insp:" + view.inspect.map(encodeInspect).join(";"));
    var movie = view.movie;
    if (movie && movie.keyframes && movie.keyframes.length) {
      fields.push("kfrm:" + movie.keyframes.map(encodeKeyframe).join(";"));
      if (movie.quality !== undefined && movie.quality !== DEFAULT_MOVIE_QUALITY) fields.push("qual:" + movie.quality);
      if (movie.loop === false) fields.push("loop:f");
    }
    return fields;
  }

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

  function encode(state) {
    var fields = encodeScene(state.scene);
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

  // null when not one of this app's links. THROWS, with a message fit to show, when the scene can't be read.
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
