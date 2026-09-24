// This file is part of Chaos Accelerator, licensed under the Common Public
// Attribution License, Version 1.0 (CPAL-1.0): see LICENSE in the project
// root, or https://chaosaccelerator.com/license for a hosted copy.

// Which of the app's layouts, input styles and performance profiles applies
// right now: answered in ONE place, as three separate questions, because a
// device does not answer them all the same way:
//
//   LAYOUT      - is the window small? Purely the viewport's size, never the
//                 device: a desktop window dragged narrow gets exactly the
//                 phone layout, which is also what makes that layout testable
//                 without a phone (the same reasoning responsive-layout.css
//                 already gives for keying on orientation alone).
//   INPUT       - is there a finger? A touch laptop has the desktop layout
//                 AND a finger; a phone with a mouse paired has the phone
//                 layout and a cursor. Whether a given TAP was a finger is
//                 decided per event where it matters (see fractal-grid.js);
//                 this only answers "could there be one", for what to show.
//   PERFORMANCE: is this a phone/tablet-class GPU? Those share memory with
//                 the whole system and are killed for using much of it, and
//                 their screens report three device pixels per CSS pixel,
//                 which nobody can see and every one of which is a whole
//                 simulation here.
//
// The answers are published as classes on <html> (mobile.css is written
// against them) and as window.LayoutMode for the scripts. Loaded in <head>,
// before anything is laid out, so the first layout is already the right one:
// both views measure their canvas area as they start up.
(function (global) {
  "use strict";

  var root = document.documentElement;

  // Narrow (a phone upright) or short (a phone on its side). An upright
  // tablet is 768 CSS pixels and up, and keeps the desktop layout: its
  // floating cards fit with room to spare.
  var COMPACT_QUERY = "(max-width: 760px), (max-height: 520px)";

  function mq(query) {
    // Anything without matchMedia is far too old to run the rest of the app;
    // this only has to not throw before that becomes apparent.
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

  // ?profile=mobile / ?profile=desktop in the address forces the performance
  // profile, so the phone's caps can be tried (and measured) on a desktop GPU
  // and the reverse. Read once: it describes the device, which doesn't change.
  var forcedProfile = (function () {
    var m = /[?&]profile=(mobile|desktop)\b/.exec(global.location.search || "");
    return m ? m[1] : null;
  })();

  // The movie player (chaosplayback.html) runs this whole app inside a frame
  // as its renderer, sized in pixels to the movie's resolution: 640x360 at
  // the lower qualities, which by size alone is "a phone on its side". But
  // every frame of a movie is the map filling that frame edge to edge; a
  // dock taking its bottom half would change the picture's shape and what is
  // in it. So in there the window's size decides nothing: desktop layout,
  // always. (frameElement throws for a cross-origin parent, which is someone
  // else's page embedding this one, and gets the ordinary rules.)
  var isMovieRenderer = (function () {
    try {
      return !!global.frameElement && global.frameElement.id === "engine";
    } catch (err) {
      return false;
    }
  })();

  function computeConstrained() {
    if (forcedProfile) return forcedProfile === "mobile";
    // A finger as the PRIMARY pointer is a phone or a tablet. deviceMemory
    // (Chrome only) catches the low-end laptop the first test can't see.
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
      // By the window's own shape rather than the orientation media feature:
      // the two agree except while an on-screen keyboard is up, when the
      // feature flips to landscape on a phone that is plainly still upright.
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
    // The small-window layout: the grid's cards in a dock along the bottom
    // (or, on its side, along the right) instead of floating over the map.
    isMobile: function () { return state.mobile; },
    // "portrait" | "landscape", only meaningful while isMobile().
    orientation: function () { return state.orientation; },
    // A touchscreen is present at all (it may not be the only pointer).
    hasTouch: function () { return !!anyCoarseQuery.matches; },
    // The primary pointer can hover: false on a phone, where anything that
    // says "hover over..." is describing something that cannot be done.
    canHover: function () { return !noHoverQuery.matches; },
    // A phone/tablet-class GPU. Decides nothing by itself any more: it is
    // only which performance preset the map STARTS at (Low here, High
    // everywhere else), what the presets do, and every value in them, is
    // Settings > Performance Settings, in fractal-grid.js, and can be changed
    // on any device.
    isConstrained: function () { return constrained; },
    // Called with this object whenever isMobile() or orientation() changes.
    onChange: function (fn) { listeners.push(fn); },
    refresh: refresh,
  };
  global.LayoutMode = api;

  compactQuery.addEventListener("change", refresh);
  coarseQuery.addEventListener("change", refresh);
  anyCoarseQuery.addEventListener("change", refresh);
  global.addEventListener("resize", refresh);
  global.addEventListener("orientationchange", refresh);
  // Resize and media-query events are delivered as part of rendering, which a
  // page that isn't being shown doesn't do: a phone turned while the tab was
  // in the background, or a page brought back from the back/forward cache,
  // can come up having missed one. Asking again costs nothing.
  document.addEventListener("visibilitychange", function () { if (!document.hidden) refresh(); });
  global.addEventListener("pageshow", refresh);
  state = compute();
  applyClasses();

  // ---- Where the bottom chrome ends ----
  //
  // The watermark is position:fixed in the window's lower right, which in
  // the small-window layout is exactly where the editor's panel and the
  // grid's dock sit. Rather than teach it about either, this measures
  // whichever of them is on screen and publishes how much of the window's
  // bottom (upright) or right (on its side) edge it covers, as two custom
  // properties the watermark's own rule reads (see mobile.css).
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
            // Along the bottom edge if it spans the window's width; along
            // the right edge if it spans its height and touches that side.
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
