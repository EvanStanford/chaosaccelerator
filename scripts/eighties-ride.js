// CPAL-1.0 License. See chaosaccelerator.com/license.html

// The eighties landing page's background: a glowing floor grid rushing at the viewer under a banded
// setting sun, drawn by one full-screen shader. The carousel steers it; the sun's title is HTML on top.
(function (global) {
  "use strict";

  var CELLS_PER_SECOND = 2;
  var BANDS_PER_SECOND = 0.1225;
  var LANE_CELLS = 6;      // sideways travel per carousel slide
  var MAX_DPR = 2;

  var VERTEX = [
    "#version 300 es",
    "void main() {",
    "  gl_Position = vec4(vec2(gl_VertexID & 1, gl_VertexID >> 1) * 4.0 - 1.0, 0.0, 1.0);",
    "}",
  ].join("\n");

  // Screen space is in canvas heights from the vanishing point, y up.
  var FRAGMENT = [
    "#version 300 es",
    "precision highp float;",
    "uniform vec2 u_vanish;",
    "uniform float u_height;",
    "uniform vec2 u_cam;",   // sideways position and forward travel, in grid cells
    "uniform vec3 u_sun;",   // radius, depth of its center below the horizon, band phase
    "uniform float u_blur;", // cells the grid slid sideways since the last frame
    "out vec4 fragColor;",
    "const float EYE = 4.0;",   // camera height, cells
    "const float FOCAL = 1.1;",
    "const float FOG = 22.0;",
    "const float BANDS = 4.2;",
    "vec3 sunColor(float t) {",
    "  vec3 c = mix(vec3(0.6, 0.15, 0.95), vec3(1.0, 0.2, 0.42), smoothstep(0.0, 0.4, t));",
    "  c = mix(c, vec3(1.0, 0.58, 0.18), smoothstep(0.4, 0.7, t));",
    "  return mix(c, vec3(1.0, 0.93, 0.35), smoothstep(0.7, 1.0, t));",
    "}",
    // One family of lines as (core, halo). Where cells shrink under a pixel, or slide by faster
    // than the frame rate can show (they would strobe backward), their average.
    "vec2 lines(float g, float fw, float blur) {",
    "  float d = abs(fract(g + 0.5) - 0.5);",
    "  vec2 near = vec2(1.0 - smoothstep(0.4, 1.4, d / fw), exp(-20.0 * d));",
    "  vec2 far = vec2(min(1.2 * fw, 1.0), 0.1);",
    "  return mix(near, far, smoothstep(0.12, 1.0, max(fw, blur)));",
    "}",
    "void main() {",
    "  vec2 q = (gl_FragCoord.xy - u_vanish) / u_height;",
    "  float px = 1.0 / u_height;",
    "  float below = max(-q.y, 1e-5);",
    "  float depth = FOCAL * EYE / below;",
    "  vec2 g = vec2(q.x * EYE / below + u_cam.x, depth + u_cam.y);",
    "  vec2 fw = max(fwidth(g), vec2(1e-6));",
    "  vec2 l = lines(g.x, fw.x, u_blur) + lines(g.y, fw.y, 0.0);",
    "  vec3 ground = (vec3(0.95, 0.85, 1.0) * l.x + vec3(0.6, 0.2, 1.0) * 0.6 * l.y) * exp(-depth / FOG);",
    // Bands evenly spaced in sqrt(depth into the band zone), so they slow and thin as they rise.
    "  float r = length(q - vec2(0.0, -u_sun.y));",
    "  float t = q.y / max(u_sun.x - u_sun.y, 1e-4);",
    "  float u = clamp((0.6 - t) / 0.6, 0.0, 1.0);",
    "  float w = sqrt(u) * BANDS + u_sun.z;",
    "  float bw = max(fwidth(w), 1e-4);",
    "  float band = (1.0 - smoothstep(0.091 * u - bw, 0.091 * u + bw, abs(fract(w) - 0.5))) * smoothstep(0.0, 0.05, u);",
    "  float disc = 1.0 - smoothstep(u_sun.x - px, u_sun.x + px, r);",
    "  vec3 sky = sunColor(t) * disc * (1.0 - band)",
    "    + vec3(1.0, 0.25, 0.55) * 0.3 * exp(-12.0 * max(r - u_sun.x, 0.0)) * (1.0 - disc);",
    "  vec3 col = mix(sky, ground, 1.0 - smoothstep(-px, px, q.y));",
    "  col += vec3(0.85, 0.3, 1.0) * 0.5 * exp(-120.0 * abs(q.y));",
    "  fragColor = vec4(min(col, 1.0), 1.0);",
    "}",
  ].join("\n");

  // opts: canvas; sun, the page's box the sun is drawn in; lane(now), the carousel's position in slides.
  function start(opts) {
    var canvas = opts.canvas, root = document.documentElement;
    var still = !!(global.matchMedia && global.matchMedia("(prefers-reduced-motion: reduce)").matches);
    var gl = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: "low-power" });
    if (!gl) return;

    var program = null, loc = {}, raf = 0, dpr = 0, paused = false;
    var vanish = [0, 0], sun = [0, 0];
    var travel = 0, bands = 0, pace = 1, last = 0, lastCamX = null;

    function compile(type, source) {
      var shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) console.warn(gl.getShaderInfoLog(shader));
      return shader;
    }
    function build() {
      program = gl.createProgram();
      gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
      gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { program = null; return false; }
      ["u_vanish", "u_height", "u_cam", "u_sun", "u_blur"].forEach(function (name) {
        loc[name] = gl.getUniformLocation(program, name);
      });
      return true;
    }

    // The horizon and sun come from the page's layout, so the title stays on the sun.
    function resize() {
      if (!canvas.clientWidth) return; // hidden with the '80s off; run(true) measures again
      dpr = global.devicePixelRatio || 1;
      var scale = Math.min(dpr, MAX_DPR);
      var w = Math.max(1, Math.round(canvas.clientWidth * scale));
      var h = Math.max(1, Math.round(canvas.clientHeight * scale));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      var box = opts.sun.getBoundingClientRect(), r = box.width / 2, H = canvas.clientHeight || 1;
      vanish = [(box.left + r) * h / H, h - box.bottom * h / H];
      sun = [r / H, (r - box.height) / H];
    }

    function draw(camX, blur) {
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(program);
      gl.uniform2f(loc.u_vanish, vanish[0], vanish[1]);
      gl.uniform1f(loc.u_height, canvas.height);
      gl.uniform2f(loc.u_cam, camX, travel);
      gl.uniform3f(loc.u_sun, sun[0], sun[1], bands);
      gl.uniform1f(loc.u_blur, blur);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (!root.classList.contains("ride-on")) root.classList.add("ride-on");
    }

    function tick(now) {
      raf = requestAnimationFrame(tick);
      var dt = last ? Math.min((now - last) / 1000, 0.1) : 0;
      last = now;
      if ((global.devicePixelRatio || 1) !== dpr) resize();
      // The video has the stage: slow down while it has focus.
      var watching = document.activeElement && document.activeElement.tagName === "IFRAME";
      pace += ((watching ? 0.2 : 1) - pace) * Math.min(1, dt * 2);
      travel = (travel + CELLS_PER_SECOND * pace * dt) % 1;
      bands = (bands + BANDS_PER_SECOND * pace * dt) % 1;
      var camX = opts.lane(now) * LANE_CELLS;
      draw(camX, lastCamX === null ? 0 : Math.abs(camX - lastCamX));
      lastCamX = camX;
    }

    function begin() {
      if (!build()) return;
      resize();
      last = 0;
      if (still) draw(0, 0);
      else if (!paused) raf = requestAnimationFrame(tick);
    }

    global.addEventListener("resize", function () {
      if (!program) return;
      resize();
      if (still) draw(0, 0);
    });
    canvas.addEventListener("webglcontextlost", function (e) {
      e.preventDefault();
      cancelAnimationFrame(raf);
      program = null;
      root.classList.remove("ride-on");
    });
    canvas.addEventListener("webglcontextrestored", begin);
    begin();

    return {
      // Stops or restarts the animation; the page hides the canvas while it is off.
      run: function (on) {
        paused = !on;
        if (paused) { cancelAnimationFrame(raf); raf = 0; }
        else if (program) {
          resize();
          if (still) draw(0, 0);
          else if (!raf) { last = 0; raf = requestAnimationFrame(tick); }
        }
      },
    };
  }

  global.EightiesRide = { start: start };
})(window);
