// CPAL-1.0 License. See chaosaccelerator.com/license.html

// The eighties theme's shared page parts: the corner menu's X, the '80s switch (a copy at the end of the
// corner menu, synced with any other on the page and remembered), and the grid behind the page.
(function (global) {
  "use strict";

  var X_ICON = "<svg viewBox=\"0 0 24 24\" width=\"20\" height=\"20\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" " +
    "stroke-linecap=\"round\" aria-hidden=\"true\"><path d=\"M6 6l12 12M18 6L6 18\"></path></svg>";
  var SWITCH = "<label class=\"eighties-toggle\"><span class=\"toggle-switch\"><input type=\"checkbox\">" +
    "<span class=\"toggle-slider\"></span></span><span class=\"eighties-toggle-label\"></span></label>";

  function item(html) {
    var li = document.createElement("li");
    li.innerHTML = html;
    document.getElementById("corner-menu-list").appendChild(li);
    return li.firstChild;
  }

  // rideOptions: EightiesRide.start's options, started the first time the '80s are shown.
  function start(rideOptions) {
    var root = document.documentElement;
    var btn = document.getElementById("corner-menu-btn");

    // The X sits over the spot where the menu's button is.
    item("<button class=\"corner-menu-close\" type=\"button\" aria-label=\"Close menu\">" + X_ICON + "</button>")
      .addEventListener("click", function (e) {
        e.stopPropagation();
        btn.click();
        btn.focus();
      });

    item(SWITCH);
    var boxes = document.querySelectorAll(".eighties-toggle input");
    var labels = document.querySelectorAll(".eighties-toggle-label");
    var ride = null;
    function set(on) {
      root.classList.toggle("eighties-off", !on);
      Array.prototype.forEach.call(boxes, function (box) { box.checked = on; });
      Array.prototype.forEach.call(labels, function (label) { label.textContent = on ? "Disable '80s" : "Enable '80s"; });
      try { localStorage.setItem("eightiesOff", on ? "0" : "1"); } catch (e) {}
      if (on && !ride && global.EightiesRide) ride = EightiesRide.start(rideOptions) || { run: function () {} };
      if (ride) ride.run(on);
    }
    Array.prototype.forEach.call(boxes, function (box) {
      box.addEventListener("change", function () { set(box.checked); });
    });
    set(!root.classList.contains("eighties-off"));
  }

  global.EightiesTheme = { start: start };
})(window);
