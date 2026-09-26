// CPAL-1.0 License. See chaosaccelerator.com/license.html

// Which layout, input style and performance profile applies now: three separate questions (viewport
// size; could there be a finger; phone-class GPU), published as <html> classes and window.LayoutMode.
(function (global) {
  "use strict";

  var root = document.documentElement;

  var COMPACT_QUERY = "(max-width: 760px), (max-height: 520px)";

  function mq(query) {
    if (!global.matchMedia) return { matches: false, addEventListener: function () {} };
    var list = global.matchMedia(query);
    // Safari before 14 only has the deprecated addListener.
    if (!list.addEventListener && list.addListener) {
      list.addEventListener = function (type, fn) { list.addListener(fn); };
    }
    return list;
  }

  var compactQuery = mq(COMPACT_QUERY);
  var coarseQuery = mq("(pointer: coarse)");
  var anyCoarseQuery = mq("(any-pointer: coarse)");
  var noHoverQuery = mq("(hover: none)");

  // ?profile=mobile|desktop forces the performance profile, for trying a phone's caps on a desktop.
  var forcedProfile = (function () {
    var m = /[?&]profile=(mobile|desktop)\b/.exec(global.location.search || "");
    return m ? m[1] : null;
  })();

  // The movie player's renderer frame (chaosplayback.html): window size decides nothing, desktop always.
  var isMovieRenderer = (function () {
    try {
      return !!global.frameElement && global.frameElement.id === "engine";
    } catch (err) {
      return false;
    }
  })();

  // Inside a challenge frame (challenges/): "?goal=1.0.2" is a Trick Shot, the bounce order the goal region
  // starts with (fractal-grid.js paints goal pixels clear); "?rose=1" is Analysis Maxing. The classes trim
  // the map's cards (challenges/challenge-frame.css).
  var challengeGoal = (function () {
    var m = /[?&]goal=([0-9.]+)/.exec(global.location.search || "");
    if (!m) return null;
    var order = m[1].split(".").filter(function (t) { return t !== ""; }).map(Number);
    return order.length ? order : null;
  })();
  var challengeKind = challengeGoal ? "trick" : (/[?&]rose=1\b/.test(global.location.search || "") ? "rose" : null);
  if (challengeKind) {
    root.classList.add("challenge", "challenge-" + challengeKind);
    var challengeSheet = document.createElement("link");
    challengeSheet.rel = "stylesheet";
    challengeSheet.href = "challenges/challenge-frame.css";
    document.head.appendChild(challengeSheet);
  }

  function computeConstrained() {
    if (forcedProfile) return forcedProfile === "mobile";
    if (coarseQuery.matches) return true;
    return typeof global.navigator.deviceMemory === "number" && global.navigator.deviceMemory <= 2;
  }
  var constrained = computeConstrained();

  var state = { mobile: false, orientation: "landscape" };
  var listeners = [];

  function compute() {
    var w = global.innerWidth || root.clientWidth || 0;
    var h = global.innerHeight || root.clientHeight || 0;
    return {
      mobile: !!compactQuery.matches && !isMovieRenderer,
      // Window shape, not the orientation media feature, which flips while an on-screen keyboard is up.
      orientation: h >= w ? "portrait" : "landscape",
    };
  }

  function applyClasses() {
    root.classList.toggle("layout-mobile", state.mobile);
    root.classList.toggle("layout-mobile-portrait", state.mobile && state.orientation === "portrait");
    root.classList.toggle("layout-mobile-landscape", state.mobile && state.orientation === "landscape");
    root.classList.toggle("input-coarse", !!coarseQuery.matches);
    root.classList.toggle("input-touch", !!anyCoarseQuery.matches);
    root.classList.toggle("perf-constrained", constrained);
  }

  function refresh() {
    var next = compute();
    var changed = next.mobile !== state.mobile || next.orientation !== state.orientation;
    state = next;
    applyClasses();
    if (!changed) return;
    listeners.slice().forEach(function (fn) {
      try { fn(api); } catch (err) { if (global.console) global.console.error(err); }
    });
  }

  var api = {
    isMobile: function () { return state.mobile; },
    orientation: function () { return state.orientation; },
    hasTouch: function () { return !!anyCoarseQuery.matches; },
    canHover: function () { return !noHoverQuery.matches; },
    isConstrained: function () { return constrained; },
    challengeGoal: function () { return challengeGoal; },
    challengeKind: function () { return challengeKind; },
    onChange: function (fn) { listeners.push(fn); },
    refresh: refresh,
  };
  global.LayoutMode = api;

  compactQuery.addEventListener("change", refresh);
  coarseQuery.addEventListener("change", refresh);
  anyCoarseQuery.addEventListener("change", refresh);
  global.addEventListener("resize", refresh);
  global.addEventListener("orientationchange", refresh);
  // Resize/media events are skipped while a page isn't shown (background tab, bfcache); ask again.
  document.addEventListener("visibilitychange", function () { if (!document.hidden) refresh(); });
  global.addEventListener("pageshow", refresh);
  state = compute();
  applyClasses();

  // ---- Bottom chrome: publishes how much of the window's bottom/right edge the editor panel or
  // grid dock covers, as --chrome-bottom/--chrome-right for the watermark (see mobile.css).
  function startChromeWatch() {
    var editorView = document.getElementById("editor-view");
    var gridView = document.getElementById("grid-view");
    var panel = document.getElementById("panel");
    var dock = document.getElementById("grid-dock");
    if (!editorView || !gridView) return;

    function update() {
      var bottom = 0, right = 0;
      if (state.mobile) {
        var el = !gridView.hidden ? dock : panel;
        if (el) {
          var rect = el.getBoundingClientRect();
          var winW = global.innerWidth, winH = global.innerHeight;
          if (rect.width > 0 && rect.height > 0) {
            if (rect.width >= winW - 1 && rect.bottom >= winH - 1) bottom = Math.max(0, winH - rect.top);
            else if (rect.height >= winH - 1 && rect.right >= winW - 1) right = Math.max(0, winW - rect.left);
          }
        }
      }
      root.style.setProperty("--chrome-bottom", bottom + "px");
      root.style.setProperty("--chrome-right", right + "px");
    }

    if (global.ResizeObserver) {
      var ro = new ResizeObserver(update);
      if (panel) ro.observe(panel);
      if (dock) ro.observe(dock);
    }
    if (global.MutationObserver) {
      var mo = new MutationObserver(update);
      mo.observe(editorView, { attributes: true, attributeFilter: ["hidden"] });
      mo.observe(gridView, { attributes: true, attributeFilter: ["hidden"] });
    }
    global.addEventListener("resize", update);
    listeners.push(update);
    update();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", startChromeWatch);
  else startChromeWatch();
})(window);
