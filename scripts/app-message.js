// CPAL-1.0 License. See chaosaccelerator.com/license.html

// Messages for the builder and the map: a toast that fades on its own, an alert
// answered with OK, and a prompt with two or more answers. The last 20 toasts and
// alerts are kept for Nerd Stats.
(function (global) {
  "use strict";

  var TOAST_MS = 4000;
  var MAX_LOGGED = 20;
  var logged = [];
  var listeners = [];
  var toastTimer = null;
  var toastMessage = null;
  var dialogQueue = [];

  function twoDigits(n) { return (n < 10 ? "0" : "") + n; }
  function timeText(d) {
    return twoDigits(d.getHours()) + ":" + twoDigits(d.getMinutes()) + ":" + twoDigits(d.getSeconds());
  }

  function log(message) {
    logged.push({ at: new Date(), message: message });
    if (logged.length > MAX_LOGGED) logged.shift();
    listeners.forEach(function (fn) { fn(); });
  }

  function toast(message) {
    // A repeat of the toast on screen keeps it up without logging it again.
    if (message !== toastMessage) log(message);
    toastMessage = message;
    // One .app-toast per view; the one on screen is the one with a layout box.
    var toasts = document.querySelectorAll(".app-toast");
    if (toastTimer) clearTimeout(toastTimer);
    for (var i = 0; i < toasts.length; i++) {
      var on = toasts[i].getClientRects().length > 0;
      if (on) toasts[i].textContent = message;
      toasts[i].classList.toggle("visible", on);
    }
    toastTimer = setTimeout(function () {
      toastTimer = null;
      toastMessage = null;
      for (var j = 0; j < toasts.length; j++) toasts[j].classList.remove("visible");
    }, TOAST_MS);
  }

  // Alerts and prompts share one dialog; a later one waits until the first is answered.
  function queueDialog(message, answers, recommended, onAnswer) {
    dialogQueue.push({ message: message, answers: answers, recommended: recommended, onAnswer: onAnswer });
    if (dialogQueue.length === 1) showDialog(dialogQueue[0]);
  }

  function showDialog(d) {
    var backdrop = document.createElement("div");
    backdrop.className = "app-dialog-backdrop";
    var box = document.createElement("div");
    box.className = "app-dialog";
    box.setAttribute("role", "alertdialog");
    box.setAttribute("aria-modal", "true");
    var text = document.createElement("p");
    text.textContent = d.message;
    var actions = document.createElement("div");
    actions.className = "app-dialog-actions";
    var recommendedBtn = null;
    d.answers.forEach(function (answer) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = answer;
      if (answer === d.recommended) recommendedBtn = btn;
      else btn.className = "secondary";
      btn.addEventListener("click", function () {
        backdrop.remove();
        dialogQueue.shift();
        if (d.onAnswer) d.onAnswer(answer);
        if (dialogQueue.length) showDialog(dialogQueue[0]);
      });
      actions.appendChild(btn);
    });
    box.appendChild(text);
    box.appendChild(actions);
    backdrop.appendChild(box);
    document.body.appendChild(backdrop);
    if (recommendedBtn) recommendedBtn.focus();
  }

  function showAlert(message, onOk) {
    log(message);
    queueDialog(message, ["OK"], "OK", onOk ? function () { onOk(); } : null);
  }

  // answers in display order; onAnswer gets the chosen one's text.
  function showPrompt(message, answers, recommended, onAnswer) {
    queueDialog(message, answers, recommended, onAnswer);
  }

  // Nerd Stats lines, in the readout's "label  text" layout.
  function readoutLines() {
    if (!logged.length) return ["errors none"];
    return ["errors " + logged.length].concat(logged.map(function (e) {
      return "       " + timeText(e.at) + " " + e.message;
    }));
  }

  function onChange(fn) { listeners.push(fn); }

  global.AppMessage = {
    toast: toast,
    alert: showAlert,
    prompt: showPrompt,
    readoutLines: readoutLines,
    onChange: onChange,
  };
})(window);
