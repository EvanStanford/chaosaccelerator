// CPAL-1.0 License. See chaosaccelerator.com/license.html

// The Color Blind Support dropdown in Settings (color-blind.js keeps the choice).
(function () {
  "use strict";

  var field = document.getElementById("color-blind-field");
  var button = document.getElementById("color-blind-button");
  var list = document.getElementById("color-blind-list");
  var options = Array.prototype.slice.call(list.querySelectorAll('[role="option"]'));
  var active = 0;

  function selectedIndex() {
    for (var i = 0; i < options.length; i++) {
      if (options[i].getAttribute("aria-selected") === "true") return i;
    }
    return 0;
  }

  function setActive(i) {
    active = (i + options.length) % options.length;
    options.forEach(function (opt, j) { opt.classList.toggle("is-active", j === active); });
  }

  function open() {
    list.hidden = false;
    button.setAttribute("aria-expanded", "true");
    setActive(selectedIndex());
    list.focus();
  }

  function close(refocus) {
    list.hidden = true;
    button.setAttribute("aria-expanded", "false");
    if (refocus) button.focus();
  }

  function show(i) {
    options.forEach(function (opt, j) { opt.setAttribute("aria-selected", j === i ? "true" : "false"); });
    button.dataset.value = options[i].dataset.value;
    button.textContent = options[i].textContent;
  }

  function choose(i) {
    show(i);
    close(true);
    ColorBlind.set(options[i].dataset.value);
  }

  button.addEventListener("click", function () {
    if (list.hidden) open();
    else close(false);
  });

  options.forEach(function (opt, i) {
    opt.addEventListener("click", function () { choose(i); });
    opt.addEventListener("mousemove", function () { setActive(i); });
  });

  list.addEventListener("keydown", function (event) {
    if (event.key === "ArrowDown") setActive(active + 1);
    else if (event.key === "ArrowUp") setActive(active - 1);
    else if (event.key === "Home") setActive(0);
    else if (event.key === "End") setActive(options.length - 1);
    else if (event.key === "Enter" || event.key === " ") choose(active);
    else if (event.key === "Escape") close(true);
    else {
      if (event.key === "Tab") close(false);
      return;
    }
    event.preventDefault();
  });

  document.addEventListener("pointerdown", function (event) {
    if (!list.hidden && !field.contains(event.target)) close(false);
  });

  function showMode() {
    options.forEach(function (opt, i) {
      if (opt.dataset.value === ColorBlind.mode()) show(i);
    });
  }
  showMode();
  ColorBlind.onChange(showMode);
})();
