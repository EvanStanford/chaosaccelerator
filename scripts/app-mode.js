// CPAL-1.0 License. See chaosaccelerator.com/license.html

// Simple Mode (the default) and Advanced Mode, published as the html.simple-mode class and window.AppMode.
// Loaded in <head> so the hidden parts never flash.
(function (global) {
  "use strict";

  var STORE_KEY = "appMode";
  var root = document.documentElement;

  // The challenge pages and the movie renderer show the app in a frame: always Advanced there.
  var framed;
  try { framed = global.top !== global; } catch (err) { framed = true; }

  // A scene link opened by navigating to it (a share, the gallery), not a reload or Back.
  function landedFromSceneLink() {
    if (!/^#(bldr|map|movie)\/./.test(global.location.hash)) return false;
    var nav = global.performance.getEntriesByType ? global.performance.getEntriesByType("navigation")[0] : null;
    return !nav || nav.type === "navigate";
  }
  var landed = !framed && landedFromSceneLink();
  // "bldr", "map" or "movie": the page a share opened on.
  var landedPage = landed ? /^#(\w+)\//.exec(global.location.hash)[1] : null;

  function save() {
    try {
      localStorage.setItem(STORE_KEY, mode);
    } catch (err) {
    }
  }

  var mode = "simple";
  try {
    if (localStorage.getItem(STORE_KEY) === "advanced") mode = "advanced";
  } catch (err) {
  }
  if (framed) {
    mode = "advanced";
  } else if (landed && mode !== "advanced") {
    mode = "advanced";
    save();
  }

  var listeners = [];
  var checkbox = null, labels = [];

  function sync() {
    root.classList.toggle("simple-mode", mode === "simple");
    if (checkbox) checkbox.checked = mode === "advanced";
    labels.forEach(function (l) { l.classList.toggle("is-current", l.getAttribute("data-mode") === mode); });
  }

  function set(next) {
    next = next === "advanced" ? "advanced" : "simple";
    if (next === mode) return;
    mode = next;
    save();
    sync();
    listeners.slice().forEach(function (fn) {
      try { fn(mode); } catch (err) { if (global.console) global.console.error(err); }
    });
  }

  function wire() {
    checkbox = document.getElementById("advanced-mode-checkbox");
    labels = Array.prototype.slice.call(document.querySelectorAll("#mode-switch [data-mode]"));
    if (checkbox) checkbox.addEventListener("change", function () { set(checkbox.checked ? "advanced" : "simple"); });
    labels.forEach(function (l) {
      l.addEventListener("click", function () { set(l.getAttribute("data-mode")); });
    });
    sync();
  }

  sync();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();

  global.AppMode = {
    isSimple: function () { return mode === "simple"; },
    set: set,
    onChange: function (fn) { listeners.push(fn); },
    landedFromSceneLink: function () { return landed; },
    landedPage: function () { return landedPage; },
    STORE_KEY: STORE_KEY,
  };
})(window);
