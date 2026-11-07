// CPAL-1.0 License. See chaosaccelerator.com/license.html

// Keyboard shortcuts for the builder and the map, the Show Keyboard Shortcuts setting and the "?" list.
(function (global) {
  "use strict";

  var STORE_KEY = "showShortcuts";
  var root = document.documentElement;

  function $(id) { return document.getElementById(id); }
  function tool(name) { return document.querySelector('.tool-btn[data-tool="' + name + '"]'); }
  function toggleLabel(checkbox) { return checkbox.closest("label").querySelector("span"); }

  // On screen, except that a shut card still counts: its keys work without opening it.
  function available(el) {
    if (!el || el.disabled) return false;
    for (var n = el; n && n !== document.body; n = n.parentElement) {
      if (n.classList.contains("menu-card")) continue;
      if (global.getComputedStyle(n).display === "none") return false;
    }
    return true;
  }

  function fire(el, type) { el.dispatchEvent(new Event(type, { bubbles: true })); }

  function press(el) {
    return function () { if (available(el)) el.click(); };
  }

  function choose(select, value) {
    return function () {
      if (!available(select) || select.value === value || !select.querySelector('option[value="' + value + '"]')) return;
      select.value = value;
      fire(select, "input");
      fire(select, "change");
    };
  }

  // One step up the log2 speed slider, wrapping to the slowest.
  function nextSpeed(button, slider) {
    if (!available(button)) return;
    var v = Number(slider.value) + 1;
    slider.value = String(v > Number(slider.max) ? Number(slider.min) : v);
    fire(slider, "input");
  }

  function card(itemId, toggleId) {
    var item = $(itemId);
    return {
      run: function () {
        if (!available(item)) return;
        if (item.classList.contains("is-open")) item.querySelector(".menu-card-header").click();
        else $(toggleId).click();
      },
      label: $(toggleId),
    };
  }

  // name: for the "?" list. label: what shows the key. listed: in the list without a label. editing: off while the builder is playing.
  function entry(key, name, el, opts) {
    var e = { key: key, name: name, run: press(el), label: el };
    for (var k in opts || {}) e[k] = opts[k];
    return e;
  }
  function toggleEntry(key, name, checkbox, opts) {
    return entry(key, name, checkbox, Object.assign({ label: toggleLabel(checkbox) }, opts));
  }
  function optionEntry(key, name, select, value, opts) {
    return entry(key, name, select, Object.assign({
      run: choose(select, value),
      label: select.querySelector('option[value="' + value + '"]'),
    }, opts));
  }

  var EDITING = { editing: true };
  var edgeSelect = $("edge-mode-select");
  var EDITOR = [
    entry("k", "Play / Pause", $("btn-play-pause"), { list: "k or space", both: true }),
    entry("m", "Mute", $("btn-mute"), { both: true }),
    entry("x", "Speed", $("btn-speed"), { both: true, run: function () { nextSpeed($("btn-speed"), $("speed-slider")); } }),
    entry("r", "Reset", $("btn-reset"), { both: true }),
    entry(",", "Settings", $("btn-settings"), { both: true }),
    entry("c", "+ Circle", tool("circle"), EDITING),
    entry("l", "+ Line", tool("line"), EDITING),
    entry("p", "+ Portals", tool("portal"), EDITING),
    entry("a", "+ Anchor", tool("anchor"), EDITING),
    entry("h", "+ Hinge", tool("hinge"), EDITING),
    entry("s", "+ Spring", tool("spring"), EDITING),
    entry("e", "Set Velocity", tool("velocity"), EDITING),
    entry("i", "Set Input (Location)", tool("input"), EDITING),
    entry("v", "Set Input (Velocity)", tool("input-velocity"), EDITING),
    entry("o", "Set Output", tool("output"), EDITING),
    entry("b", "+ Basin", tool("basin"), EDITING),
    entry("delete", "Delete selected object", $("btn-delete-spring"), { run: null }),
    toggleEntry("g", "Planet Mode", $("mutual-gravity-checkbox"), EDITING),
    toggleEntry("u", "Collisions", $("collisions-checkbox"), EDITING),
    optionEntry("1", "Sticky Edges", edgeSelect, "sticky", EDITING),
    optionEntry("2", "Pac-Man Warp", edgeSelect, "wrap", EDITING),
    optionEntry("3", "Infinite Space", edgeSelect, "infinite", EDITING),
    entry("f", "Fractal-ize", $("btn-send-to-grid")),
  ];

  // Play, speed and reset drive Map Evolution while its card is open with Playback on, the Inspect preview otherwise.
  function evolutionOpen() { return $("menu-playback").classList.contains("is-open") && $("evolution-inspect-checkbox").checked; }
  function transport(evolutionId, inspectId) {
    return function () { press($(evolutionOpen() ? evolutionId : inspectId))(); };
  }
  var precisionSelect = $("precision-select");
  var GRID = [
    entry("k", "Play / Pause", $("hover-play-pause"), { run: transport("grid-play-pause", "hover-play-pause"), also: $("grid-play-pause") }),
    entry("m", "Mute", $("hover-mute")),
    entry("x", "Speed", $("hover-speed-btn"), {
      also: $("grid-speed-btn"),
      run: function () {
        if (evolutionOpen()) nextSpeed($("grid-speed-btn"), $("grid-speed-slider"));
        else nextSpeed($("hover-speed-btn"), $("hover-speed-slider"));
      },
    }),
    entry("r", "Reset", $("hover-reset"), { run: transport("grid-restart", "hover-reset"), also: $("grid-restart") }),
    entry(",", "Settings", null, card("menu-settings", "grid-btn-settings")),
    entry("i", "Inspect", null, card("menu-inspect", "grid-btn-inspect")),
    entry("a", "Analysis", null, card("menu-stats", "grid-btn-stats")),
    entry("d", "Display", null, card("menu-display", "grid-btn-display")),
    entry("e", "Evolution", null, card("menu-playback", "grid-btn-playback")),
    entry("v", "Movie", null, card("menu-movie", "grid-btn-movie")),
    entry("c", "Challenges", null, card("menu-challenges", "grid-btn-challenges")),
    entry("q", "Inspect (Point)", $("btn-inspect-point")),
    entry("w", "Inspect (Line)", $("btn-inspect-line")),
    toggleEntry("n", "Nerd Stats", $("perf-readout-checkbox")),
    toggleEntry("z", "Color Zoom", $("color-zoom-checkbox")),
    toggleEntry("s", "Low Saturation", $("low-saturation-checkbox")),
    entry("h", "Reset View", $("btn-reset-view")),
    entry("t", "Measuring Tape (esc to cancel)", null, { listed: true, run: function () { global.MeasuringTape.toggle(); } }),
    optionEntry("0", "Precision: Auto", precisionSelect, "auto"),
    optionEntry("1", "Precision: float32", precisionSelect, "f32"),
    optionEntry("2", "Precision: double-float", precisionSelect, "df"),
    optionEntry("3", "Precision: triple-float", precisionSelect, "tf"),
    optionEntry("4", "Precision: quad-float", precisionSelect, "qf"),
  ];
  // The rows are built when the map first boots.
  var displayList = $("grid-display-mode-list");
  [["standard", "Standard"], ["laplacian", "Laplacian"], ["contours", "Contours"], ["ftle", "FTLE"], ["gradient", "Gradient"]].forEach(function (mode, i) {
    function row() { return displayList.querySelector('.display-mode-row[data-mode="' + mode[0] + '"]'); }
    GRID.push(entry(String(5 + i), mode[1], null, {
      label: function () { return row() && row().querySelector(".display-mode-name"); },
      run: function () { if (row() && available($("menu-display"))) row().click(); },
    }));
  });

  // ---- Labels ----
  var checkbox = $("show-shortcuts-checkbox");
  var showLabels = false;
  try { showLabels = localStorage.getItem(STORE_KEY) === "1"; } catch (err) { /* off */ }

  function applyLabels() {
    var on = showLabels && !root.classList.contains("input-coarse");
    root.classList.toggle("show-shortcuts", on);
    EDITOR.concat(GRID).forEach(function (e) {
      [typeof e.label === "function" ? e.label() : e.label, e.also].forEach(function (el) {
        if (!el) return;
        // An <option> draws no ::after, so its text carries the key.
        if (el.tagName === "OPTION") {
          if (el.dataset.text === undefined) el.dataset.text = el.textContent;
          el.textContent = el.dataset.text + (on ? " (" + e.key + ")" : "");
        } else el.setAttribute("data-shortcut", e.key);
      });
    });
  }
  checkbox.checked = showLabels;
  checkbox.addEventListener("change", function () {
    showLabels = checkbox.checked;
    try { localStorage.setItem(STORE_KEY, showLabels ? "1" : "0"); } catch (err) { /* this page only */ }
    applyLabels();
  });
  applyLabels();
  new MutationObserver(applyLabels).observe(displayList, { childList: true });

  // ---- The "?" list ----
  var listBackdrop = null;
  function listSection(title, entries) {
    var section = document.createElement("section");
    var h = document.createElement("h3");
    h.textContent = title;
    section.appendChild(h);
    var dl = document.createElement("dl");
    entries.forEach(function (e) {
      if (!e.label && !e.listed) return;
      var dt = document.createElement("dt");
      dt.textContent = e.list || e.key;
      var dd = document.createElement("dd");
      dd.textContent = e.name;
      dl.appendChild(dt);
      dl.appendChild(dd);
    });
    section.appendChild(dl);
    return section;
  }
  function openList() {
    listBackdrop = document.createElement("div");
    listBackdrop.className = "app-dialog-backdrop";
    var box = document.createElement("div");
    box.className = "app-dialog shortcut-list";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-label", "Keyboard Shortcuts");
    var h = document.createElement("h2");
    h.textContent = "Keyboard Shortcuts";
    box.appendChild(h);
    var columns = document.createElement("div");
    columns.className = "shortcut-list-columns";
    columns.appendChild(listSection("Builder and map", EDITOR.filter(function (e) { return e.both; })));
    columns.appendChild(listSection("Builder", EDITOR.filter(function (e) { return !e.both; })));
    columns.appendChild(listSection("Map", GRID.filter(function (e) {
      return !EDITOR.some(function (b) { return b.both && b.key === e.key; });
    })));
    box.appendChild(columns);
    var actions = document.createElement("div");
    actions.className = "app-dialog-actions";
    var ok = document.createElement("button");
    ok.textContent = "OK";
    ok.addEventListener("click", closeList);
    actions.appendChild(ok);
    box.appendChild(actions);
    listBackdrop.appendChild(box);
    listBackdrop.addEventListener("click", function (e) { if (e.target === listBackdrop) closeList(); });
    document.body.appendChild(listBackdrop);
    ok.focus({ preventScroll: true });
  }
  function closeList() {
    if (!listBackdrop) return;
    listBackdrop.remove();
    listBackdrop = null;
  }

  // ---- Keys ----
  function typing(el) {
    if (!el) return false;
    if (el.isContentEditable || el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
    return el.tagName === "INPUT" && !/^(range|checkbox|radio|button)$/.test(el.type);
  }

  global.addEventListener("keydown", function (e) {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    if (typing(document.activeElement)) return;
    if (e.key === "?") {
      e.preventDefault();
      if (listBackdrop) closeList(); else openList();
      return;
    }
    if (listBackdrop) {
      if (e.key === "Escape") closeList();
      return;
    }
    if (e.key === "Escape" && global.MeasuringTape.isActive()) {
      global.MeasuringTape.stop();
      return;
    }
    if (e.shiftKey || document.querySelector(".app-dialog-backdrop") || !$("transition-layer").hidden) return;
    if (!global.AppShell) return;
    var key = e.key === " " ? "k" : e.key.toLowerCase();
    var list = global.AppShell.currentView() === "grid" ? GRID : EDITOR;
    var match = null;
    for (var i = 0; i < list.length; i++) if (list[i].key === key && list[i].run) match = list[i];
    if (!match) return;
    if (match.editing && global.PhysicsUI.isPlaying()) return;
    e.preventDefault();
    // A focused button would also take the Space as a click of its own.
    if (e.key === " " && document.activeElement && document.activeElement.blur) document.activeElement.blur();
    match.run();
  });

  global.KeyboardShortcuts = { STORE_KEY: STORE_KEY };
})(window);
