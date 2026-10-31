// CPAL-1.0 License. See chaosaccelerator.com/license.html

// Color Blind Support: the viewer's own setting (stored, never in links), published as html[data-color-blind]
// and window.ColorBlind. Loaded in <head> so nothing paints in the wrong colors first.
(function (global) {
  "use strict";

  var STORE_KEY = "colorBlindMode";
  var MODES = ["off", "red-green", "blue-yellow", "monochrome"];
  var root = document.documentElement;
  var listeners = [];

  var mode = "off";
  try {
    var stored = localStorage.getItem(STORE_KEY);
    if (MODES.indexOf(stored) !== -1) mode = stored;
  } catch (err) {
  }

  function apply() {
    if (mode === "off") root.removeAttribute("data-color-blind");
    else root.setAttribute("data-color-blind", mode);
  }
  apply();

  // ---- The map's scales, shared with the shaders (glsl below) so a swatch matches its pixel ----
  function stops(list) {
    return list.split(" ").map(function (h) {
      return [0, 2, 4].map(function (i) { return parseInt(h.substr(i, 2), 16) / 255; });
    });
  }
  // Sequential: cividis for red-green, inferno for blue-yellow.
  var CIVIDIS = stops("00204d 00336f 39486b 575c6d 707173 8a8779 a69d75 c4b56c e4cf5b ffea46");
  var INFERNO = stops("000004 1b0c42 4b0c6b 781c6d a52c60 cf4446 ed6925 fb9a06 f7d03c fcffa4");
  // Cyclic: OKLab loops through white, yellow, black, blue (red-green) and white, teal, black, red (blue-yellow).
  var RG_LOOP = stops("e8e8e8 f8f3d3 fff7c7 fff5b8 feeb76 efd84f d6bf1f b5a111 918009 6e6102 4f4602 363118 " +
    "242424 141f33 0b1f48 082663 0d3583 1c4aa4 3263c3 4d7fde 6b9af1 8bb3fb acc9fd cbdaf6");
  var BY_LOOP = stops("e8e8e8 d4f6f5 bdfdfc a3fcfb 87f2f2 69e0e0 47c7c7 21a8a8 0a8686 036666 004a4a 173434 " +
    "242424 321a17 47120e 620a09 830b0b a71e1a c83b32 e45b4f f67d6f fd9e92 febbb2 f7d4cf");
  // The loops' gray middle, as OKLab lightness.
  var LOOP_CENTER_L = 0.6275;

  function mixRgb(a, b, f) {
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  }
  // A neutral gray of OKLab lightness L.
  function gray(L) {
    var c = Math.min(1, Math.max(0, L * L * L));
    var v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    return [v, v, v];
  }
  function sequential(t) {
    t = Math.min(1, Math.max(0, t));
    if (mode === "monochrome") return gray(0.30 + 0.67 * t);
    var lut = mode === "red-green" ? CIVIDIS : INFERNO;
    var x = t * 9, i = Math.min(Math.floor(x), 8);
    return mixRgb(lut[i], lut[i + 1], x - i);
  }
  function cyclic(t) {
    t -= Math.floor(t);
    if (mode === "monochrome") return gray(0.62 - 0.33 * Math.cos(2 * Math.PI * t));
    var lut = mode === "red-green" ? RG_LOOP : BY_LOOP;
    var x = t * 24, i = Math.min(Math.floor(x), 23);
    return mixRgb(lut[i], lut[i === 23 ? 0 : i + 1], x - i);
  }
  // A direction and strength m (0 to 1): round the loop and out from its gray middle; monochrome shades it as relief lit from the upper left.
  function vector(gx, gy, m) {
    if (!(m > 0)) return gray(mode === "monochrome" ? 0.55 : LOOP_CENTER_L);
    var len = Math.hypot(gx, gy);
    if (mode === "monochrome") return gray(0.55 - 0.40 * m * (-gx + gy) / len * Math.SQRT1_2);
    return mixRgb(gray(LOOP_CENTER_L), cyclic(Math.atan2(gy, gx) / (2 * Math.PI)), m);
  }
  // Monochrome's signed scale: dips darker, ridges lighter than the flat middle; s in -1 to 1.
  function diverging(s) {
    return gray(0.55 + 0.40 * s);
  }
  function css(rgb) {
    return "rgb(" + rgb.map(function (v) { return Math.round(255 * Math.min(1, Math.max(0, v))); }).join(", ") + ")";
  }

  function vec3List(lut) {
    return lut.map(function (c) {
      return "vec3(" + c.map(function (v) { return v.toFixed(6); }).join(", ") + ")";
    }).join(", ");
  }
  // The same scales in GLSL; mode is ColorBlind.id().
  var GLSL = [
    "const vec3 CB_CIVIDIS[10] = vec3[10](" + vec3List(CIVIDIS) + ");",
    "const vec3 CB_INFERNO[10] = vec3[10](" + vec3List(INFERNO) + ");",
    "const vec3 CB_RG_LOOP[24] = vec3[24](" + vec3List(RG_LOOP) + ");",
    "const vec3 CB_BY_LOOP[24] = vec3[24](" + vec3List(BY_LOOP) + ");",
    "const float CB_LOOP_CENTER_L = " + LOOP_CENTER_L.toFixed(6) + ";",
    "vec3 cbGray(float L) {",
    "  float c = clamp(L * L * L, 0.0, 1.0);",
    "  return vec3(c <= 0.0031308 ? 12.92 * c : 1.055 * pow(c, 1.0 / 2.4) - 0.055);",
    "}",
    "vec3 cbSequential(int mode, float t) {",
    "  t = clamp(t, 0.0, 1.0);",
    "  if (mode == 3) return cbGray(0.30 + 0.67 * t);",
    "  float x = t * 9.0;",
    "  int i = min(int(x), 8);",
    "  float f = x - float(i);",
    "  return mode == 1 ? mix(CB_CIVIDIS[i], CB_CIVIDIS[i + 1], f) : mix(CB_INFERNO[i], CB_INFERNO[i + 1], f);",
    "}",
    "vec3 cbCyclic(int mode, float t) {",
    "  t = fract(t);",
    "  if (mode == 3) return cbGray(0.62 - 0.33 * cos(6.28318530718 * t));",
    "  float x = t * 24.0;",
    "  int i = min(int(x), 23);",
    "  int j = i == 23 ? 0 : i + 1;",
    "  float f = x - float(i);",
    "  return mode == 1 ? mix(CB_RG_LOOP[i], CB_RG_LOOP[j], f) : mix(CB_BY_LOOP[i], CB_BY_LOOP[j], f);",
    "}",
    "vec3 cbVector(int mode, vec2 g, float m) {",
    "  if (m <= 0.0) return cbGray(mode == 3 ? 0.55 : CB_LOOP_CENTER_L);",
    "  vec2 dir = g / length(g);",
    "  if (mode == 3) return cbGray(0.55 - 0.40 * m * dot(dir, vec2(-0.70710678, 0.70710678)));",
    "  return mix(cbGray(CB_LOOP_CENTER_L), cbCyclic(mode, atan(dir.y, dir.x) / 6.28318530718), m);",
    "}",
    "vec3 cbDiverging(float s) {",
    "  return cbGray(0.55 + 0.40 * s);",
    "}",
    "",
  ];

  // ---- Canvas colors: "off" is the app's own; the others change only what they must ----
  var OFF = {
    bodyFill: "#3a63d1", bodyStroke: "#7ea0ff", anchoredFill: "#5a6178", anchoredStroke: "#7a8199",
    selected: "#ffcf4d", selectedDark: "#8a6d1a", selectedWash: "rgba(255, 207, 77, 0.15)",
    portal: { orange: "#ff8a1f", green: "#36d399" }, portalName: { orange: "orange", green: "green" },
    velocity: "#e06bff", spring: "#c8d3e6", hole: "#1b1e27",
    danger: "#ff5f56", dangerArmed: "#ff7a72",
    axisX: "#ff6b6b", axisY: "#6bafff", axisO: "#7ee0a0",
    stars: ["255,255,255", "207,220,255", "255,240,214"],
    seam: "#a855ff", seamGlow: "#9933ff",
    ridge: "#ffd479", valley: "#7fd4ff", saddle: "#c58cff", flat: "#6b7280",
    median: "#ffffff", mean: "#9399ad", gold: "#c9a227", accent: "#5b8cff", accentWash: "rgba(91, 140, 255, 0.28)",
    confetti: ["#c9a227", "#5b8cff", "#36d399", "#ff8a1f", "#ff5f9e", "#ffffff"],
  };
  function variant(changes) {
    var p = {};
    Object.keys(OFF).forEach(function (k) { p[k] = OFF[k]; });
    Object.keys(changes).forEach(function (k) { p[k] = changes[k]; });
    return p;
  }
  var PALETTES = {
    off: OFF,
    "red-green": variant({
      portal: { orange: "#ff8a1f", green: "#2fa3ff" }, portalName: { orange: "orange", green: "blue" },
      velocity: "#ffffff", danger: "#d55e00", dangerArmed: "#e8743a",
      axisX: "#d55e00", axisO: "#f0e442", saddle: "#2f6fe0",
    }),
    "blue-yellow": variant({
      anchoredFill: "#3a3f4f", axisO: "#ffffff",
    }),
    monochrome: variant({
      bodyFill: "#8a8a8a", bodyStroke: "#c4c4c4", anchoredFill: "#4d4d4d", anchoredStroke: "#8a8a8a",
      selected: "#ffffff", selectedDark: "#555555", selectedWash: "rgba(255, 255, 255, 0.15)",
      portal: { orange: "#bebebe", green: "#636363" }, portalName: { orange: "light", green: "dark" },
      velocity: "#9e9e9e", spring: "#c4c4c4", hole: "#1e1e1e",
      danger: "#555555", dangerArmed: "#808080",
      axisX: "#ffffff", axisY: "#dedede", axisO: "#bebebe",
      stars: ["255,255,255"],
      seam: "#9e9e9e", seamGlow: "#808080",
      ridge: "#eeeeee", valley: "#aeaeae", saddle: "#717171", flat: "#3d3d3d",
      mean: "#9e9e9e", gold: "#dedede", accent: "#9e9e9e", accentWash: "rgba(255, 255, 255, 0.2)",
      confetti: ["#ffffff", "#bebebe", "#808080", "#dedede", "#9e9e9e"],
    }),
  };
  // Inspect points one after another: Okabe-Ito for both dichromacies, gray steps for monochrome.
  var CATEGORICAL = {
    "red-green": ["#e69f00", "#56b4e9", "#009e73", "#f0e442", "#0072b2", "#d55e00", "#cc79a7"],
    "blue-yellow": ["#e69f00", "#56b4e9", "#009e73", "#f0e442", "#0072b2", "#d55e00", "#cc79a7"],
    monochrome: ["#eeeeee", "#636363", "#bebebe", "#424242", "#929292"],
  };
  function categoricalIn(list, i) {
    return list[((i % list.length) + list.length) % list.length];
  }
  // Closest Basin colors, one per basin (PhysicsEngine.MAX_BASINS is the list's length).
  var BASIN_COLORS = ["#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f", "#edc948", "#b07aa1", "#ff9da7", "#9c755f", "#bab0ac"];
  function basinRgb(colorIndex, inMode) {
    if (inMode === "off") return stops(categoricalIn(BASIN_COLORS, colorIndex).slice(1))[0];
    var list = CATEGORICAL[inMode];
    return stops(categoricalIn(list, colorIndex + Math.floor(list.length / 2)).slice(1))[0];
  }
  // Inspect (Grid)'s two directions: corners [x0y0, x1y0, x0y1, x1y1], blended in between.
  var GRID_CORNERS = {
    "red-green": stops("0d3583 918009 acc9fd fff5b8"),
    "blue-yellow": stops("036666 830b0b a3fcfb febbb2"),
    monochrome: [gray(0.35), gray(0.55), gray(0.75), gray(0.95)],
  };

  global.ColorBlind = {
    STORE_KEY: STORE_KEY,
    modes: MODES,
    mode: function () { return mode; },
    on: function () { return mode !== "off"; },
    // The shaders' u_colorBlind.
    id: function () { return MODES.indexOf(mode); },
    set: function (next) {
      if (MODES.indexOf(next) === -1 || next === mode) return;
      mode = next;
      try {
        localStorage.setItem(STORE_KEY, mode);
      } catch (err) {
      }
      apply();
      listeners.slice().forEach(function (fn) { fn(mode); });
    },
    onChange: function (fn) { listeners.push(fn); },
    // [r, g, b] in 0 to 1 for the current mode; only while on().
    sequential: sequential,
    cyclic: cyclic,
    vector: vector,
    diverging: diverging,
    gray: gray,
    css: css,
    palette: function () { return PALETTES[mode]; },
    categorical: function (i) {
      return categoricalIn(CATEGORICAL[mode], i);
    },
    // A basin's color index as [r, g, b] in 0 to 1, in the current mode or the one named.
    basinRgb: function (colorIndex, inMode) { return basinRgb(colorIndex, inMode || mode); },
    gridColor: function (x, y) {
      var c = GRID_CORNERS[mode];
      return mixRgb(mixRgb(c[0], c[1], x), mixRgb(c[2], c[3], x), y);
    },
    glsl: GLSL,
  };
})(window);
