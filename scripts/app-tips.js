// CPAL-1.0 License. See chaosaccelerator.com/license.html

// Tool tips for the builder and the map: one popover, one tip at a time, each shown
// until answered and then never again.
(function (global) {
  "use strict";

  // ok: the colored button. "OK" when the page passes an action for it, "Got it" when it only closes.
  // wait: how long the condition must hold first, when not SHOW_DELAY_MS.
  var TIPS = {
    "add-object": { text: "Add an object to your simulation", ok: "OK" },
    "place-object": { text: "Click the grid to place the object", ok: "Got it" },
    "anchor-object": { text: "Try anchoring an object to prevent it from falling", ok: "OK" },
    "try-play": { text: "Try playing your scene", ok: "OK" },
    "set-input": { text: "Choose an object as the input", ok: "OK" },
    "set-output": { text: "Choose an object as the output", ok: "OK" },
    "fractalize": { text: "Click Fractal-ize to see what map your scene creates", ok: "OK" },
    "map-intro": { text: "Each pixel is a different simulation! Click on a pixel to view the simulation.", ok: "Got it" },
    "velocity-speed-cap": { text: "Radial lines are an artifact of the maximum speed cap.", ok: "Got it" },
    "zoom-in": { text: "Try zooming in on interesting sections of the map", ok: "Got it" },
    "color-zoom": { text: "Try Color Zoom to highlight subtle color differences", ok: "OK" },
    "advanced-mode": { text: "Try advanced mode for more options", ok: "OK", wait: 15000 },
  };
  // Time each tip was answered, by id. Also holds "all" (every tip off) and facts like "played".
  var STORE_KEY = "physicsAppDismissedTips";

  var popover = document.getElementById("tip-popover");
  var textEl = document.getElementById("tip-popover-text");
  var okButton = document.getElementById("tip-popover-ok");
  var offButton = document.getElementById("tip-popover-dismiss");
  var settingsButton = document.getElementById("grid-btn-tips");

  // The challenge pages and the movie renderer show the app in a frame: no tips there.
  var framed;
  try { framed = global.top !== global; } catch (err) { framed = true; }

  var store = load();
  // A visitor arriving on a scene link from outside the site gets no tips.
  if (!framed && global.AppMode.landedFromSceneLink() && !store.all) {
    store.all = Date.now();
    save();
  }
  var view = null;
  var active = null; // { id, anchor, onOk }
  var listeners = [];
  // A tip shows only once its condition has held this long, so the user can get there first.
  var SHOW_DELAY_MS = 3000;
  var waiting = {}; // id -> { since, timer }

  function load() {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY)) || {};
    } catch (err) {
      return {};
    }
  }

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(store));
    } catch (err) {
    }
  }

  function notify() {
    listeners.forEach(function (fn) { fn(); });
  }

  function doneAt(id) {
    return store[id] ? Number(store[id]) : 0;
  }

  function isDone(id) {
    return !!(store.all || store[id]);
  }

  function done(id) {
    var changed = !store[id];
    if (changed) {
      store[id] = Date.now();
      save();
      syncSettingsButton();
    }
    if (active && (active.id === id || id === "all")) {
      hidePopover();
      changed = true;
    }
    if (changed) notify();
  }

  function canShow(id) {
    return !framed && !!view && !active && !isDone(id);
  }

  // True once `id` has been asked for its wait without a drop in between.
  function waitedFor(id) {
    var delay = (TIPS[id] && TIPS[id].wait) || SHOW_DELAY_MS;
    var w = waiting[id];
    if (!w) {
      w = waiting[id] = { since: Date.now(), timer: null };
      w.timer = setTimeout(function () { w.timer = null; notify(); }, delay);
    }
    return Date.now() - w.since >= delay;
  }

  // A fact that holds a value rather than a time.
  function remember(id, value) {
    store[id] = value;
    save();
  }

  // The page calls this when the condition for `id` stops holding: its wait starts over.
  function drop(id) {
    if (!waiting[id]) return;
    clearTimeout(waiting[id].timer);
    delete waiting[id];
  }

  // Call while the tip's condition holds: true once it has waited. No other tip open is part of every
  // condition, so a wait starts over once the open tip is gone.
  function ready(id) {
    if (framed || !view || isDone(id)) return false;
    if (active) {
      drop(id);
      return false;
    }
    return waitedFor(id);
  }

  // anchor: an element, a viewport point {x, y}, or null for no arrow at the top of the window.
  function show(id, anchor, onOk) {
    if (!ready(id) || !anchorVisible(anchor)) return false;
    active = { id: id, anchor: anchor, onOk: onOk || null };
    Object.keys(waiting).forEach(drop);
    textEl.textContent = TIPS[id].text;
    okButton.textContent = TIPS[id].ok;
    popover.hidden = false;
    position();
    return true;
  }

  function hidePopover() {
    popover.hidden = true;
    active = null;
  }

  // Hides the tip on screen without answering it, so it can come back. With an id, only that tip.
  function hide(id) {
    if (!active || (id && active.id !== id)) return;
    hidePopover();
    notify();
  }

  function anchorRect(anchor) {
    if (anchor.getBoundingClientRect) return anchor.getBoundingClientRect();
    return { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y, width: 0, height: 0 };
  }

  function anchorVisible(anchor) {
    if (!anchor || !anchor.getBoundingClientRect) return true;
    var rect = anchor.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    return rect.bottom > 0 && rect.top < global.innerHeight && rect.right > 0 && rect.left < global.innerWidth;
  }

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  function position() {
    var width = popover.offsetWidth, height = popover.offsetHeight;
    var anchor = active.anchor;
    popover.classList.toggle("tip-no-arrow", !anchor);
    if (!anchor) {
      popover.classList.remove("tip-above");
      popover.style.left = Math.max(12, (global.innerWidth - width) / 2) + "px";
      popover.style.top = "72px";
      return;
    }
    var rect = anchorRect(anchor);
    var centerX = rect.left + rect.width / 2;
    var left = clamp(anchor.getBoundingClientRect ? rect.left : centerX - width / 2, 12, global.innerWidth - width - 12);
    var above = rect.bottom + 10 + height > global.innerHeight - 12 && rect.top - 10 - height >= 12;
    popover.classList.toggle("tip-above", above);
    popover.style.top = clamp(above ? rect.top - 10 - height : rect.bottom + 10, 12, Math.max(12, global.innerHeight - height - 12)) + "px";
    popover.style.left = left + "px";
    var ARROW_SIZE = 10, CORNER_INSET = 10;
    popover.style.setProperty("--tip-arrow-left",
      clamp(centerX - left - ARROW_SIZE / 2, CORNER_INSET, Math.max(CORNER_INSET, width - CORNER_INSET - ARROW_SIZE)) + "px");
  }

  // A tip whose button scrolled out of sight waits to be shown again.
  function follow() {
    if (!active) return;
    if (anchorVisible(active.anchor)) position();
    else hide();
  }
  global.addEventListener("resize", follow);
  document.addEventListener("scroll", follow, true);

  okButton.addEventListener("click", function () {
    var onOk = active && active.onOk;
    if (active) done(active.id);
    if (onOk) onOk();
  });
  offButton.addEventListener("click", function () {
    done("all");
  });

  function anyTipDone() {
    return Object.keys(TIPS).some(function (id) { return store[id]; });
  }

  function syncSettingsButton() {
    if (!settingsButton) return;
    var allOff = !!store.all || Object.keys(TIPS).every(function (id) { return store[id]; });
    settingsButton.textContent = allOff ? "Show Tool Tips" : anyTipDone() ? "Show All Tool Tips" : "Don't Show Tool Tips";
  }
  if (settingsButton) {
    syncSettingsButton();
    settingsButton.addEventListener("click", function () {
      if (store.all || anyTipDone()) {
        store = {};
        save();
        syncSettingsButton();
        notify();
      } else {
        done("all");
      }
    });
  }

  // "editor", "grid", or null while the two views animate between each other.
  function setView(which) {
    if (which === view) return;
    view = which;
    if (active) hidePopover();
    Object.keys(waiting).forEach(drop);
    if (which === "grid") {
      done("fractalize");
      done("try-play");
      if (store["visited-map"]) done("map-intro");
      else done("visited-map");
    }
    notify();
  }

  global.AppTips = {
    show: show,
    hide: hide,
    drop: drop,
    ready: ready,
    done: done,
    doneAt: doneAt,
    remember: remember,
    recall: function (id) { return store[id]; },
    canShow: canShow,
    showing: function () { return active ? active.id : null; },
    follow: follow,
    setView: setView,
    view: function () { return view; },
    onChange: function (fn) { listeners.push(fn); },
  };
})(window);
