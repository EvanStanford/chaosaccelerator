// CPAL-1.0 License. See chaosaccelerator.com/license.html

// Back links (a[data-back]) go back in history when the page before this one is where they lead, else they are links.
(function () {
  "use strict";

  // The landing entry keeps its referrer: after a scripted reload document.referrer is the page itself.
  try {
    var forwarded = sessionStorage.getItem("backLinkForwarded") !== null;
    sessionStorage.removeItem("backLinkForwarded");
    var load = performance.getEntriesByType("navigation")[0];
    if (!forwarded && load && load.type === "navigate" && history.state === null) history.replaceState({ landed: true, from: document.referrer }, "");
  } catch (err) { /* unmarked: links are followed */ }

  function page(url) {
    return url.origin + url.pathname.replace(/\/index\.html$/, "/");
  }

  function cameFrom(href) {
    var state = history.state;
    if (history.length < 2 || !state || !state.landed || !state.from) return false;
    try {
      return page(new URL(state.from)) === page(new URL(href, location.href));
    } catch (err) {
      return false;
    }
  }

  document.addEventListener("click", function (e) {
    var link = e.target.closest ? e.target.closest("a[data-back]") : null;
    if (!link || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (!cameFrom(link.href)) return;
    e.preventDefault();
    history.back();
  });
})();
