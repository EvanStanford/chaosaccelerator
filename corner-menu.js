// The corner menu: everything about the site that is not the site, behind
// one button at the top right of every page (index.html and the pages it
// leads to). Each entry's icon is a plain one-color drawing, so the menu
// reads as a list rather than a row of logos. The markup is written here,
// once, and put in the page where this script's tag is, so the pages
// include one line instead of a copy each; the links are resolved against
// this file, so the same script works from gallery/ too.
//
// Open and shut by its button; shut again by a click anywhere else, or
// Escape. The entries are ordinary links, so choosing one just leaves.
(function () {
  var script = document.currentScript;
  var root = new URL(".", script.src);
  var html = 
    "<nav class=\"corner-menu\" id=\"corner-menu\" aria-label=\"About this site\">\n" +
    "  <button class=\"corner-menu-btn\" id=\"corner-menu-btn\" type=\"button\" aria-label=\"Menu\" aria-expanded=\"false\" aria-controls=\"corner-menu-list\">\n" +
    "    <svg viewBox=\"0 0 24 24\" width=\"22\" height=\"22\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" aria-hidden=\"true\"><path d=\"M4 7h16M4 12h16M4 17h16\"></path></svg>\n" +
    "  </button>\n" +
    "  <ul class=\"corner-menu-list\" id=\"corner-menu-list\" hidden>\n" +
    "    <li><a href=\"readme.html\">\n" +
    "      <svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><circle cx=\"12\" cy=\"12\" r=\"9.25\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\"></circle><path d=\"M12 10.75v6.5\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\"></path><circle cx=\"12\" cy=\"7.5\" r=\"1.25\" fill=\"currentColor\"></circle></svg>\n" +
    "      About</a></li>\n" +
    "    <li><a href=\"gallery/gallery.html\">\n" +
    "      <svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><g fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\"><rect x=\"3.25\" y=\"3.25\" width=\"7\" height=\"7\" rx=\"1.5\"></rect><rect x=\"13.75\" y=\"3.25\" width=\"7\" height=\"7\" rx=\"1.5\"></rect><rect x=\"3.25\" y=\"13.75\" width=\"7\" height=\"7\" rx=\"1.5\"></rect><rect x=\"13.75\" y=\"13.75\" width=\"7\" height=\"7\" rx=\"1.5\"></rect></g></svg>\n" +
    "      Gallery</a></li>\n" +
    "    <li><a href=\"other.html\">\n" +
    "      <svg class=\"wide\" viewBox=\"0 7.75 24 8.5\" aria-hidden=\"true\"><path fill=\"currentColor\" d=\"M0 8.23H8.24A1.66 1.66 0 0 0 11.19 9.61L11.43 8.62 11.66 9.49A0.65 0.65 0 0 1 12.34 9.49L12.57 8.62 12.81 9.61A1.66 1.66 0 0 0 15.76 8.23H24Q21.69 8.97 19.73 12.7Q16.38 13.23 12 15.77Q7.62 13.23 4.27 12.7Q2.31 8.97 0 8.23Z\"></path></svg>\n" +
    "      Other Projects by Me</a></li>\n" +
    "    <li><a href=\"https://github.com/EvanStanford/chaosaccelerator\">\n" +
    "      <svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path fill=\"currentColor\" d=\"M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12\"></path></svg>\n" +
    "      Source Code</a></li>\n" +
    "    <li><a href=\"license.html\">\n" +
    "      <svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path fill=\"currentColor\" d=\"M8.8 22A10.5 10.5 0 1 1 15.2 22L13.6 13.72A3.6 3.6 0 1 0 10.4 13.72Z\"></path></svg>\n" +
    "      CPAL-1.0 Open Source License</a></li>\n" +
    "  </ul>\n" +
    "</nav>\n";
  var holder = document.createElement("div");
  holder.innerHTML = html;
  var nav = holder.firstElementChild;
  Array.prototype.forEach.call(nav.querySelectorAll("a[href]"), function (a) {
    var href = a.getAttribute("href");
    if (!/^[a-z]+:/i.test(href)) a.href = new URL(href, root).href;
  });
  script.parentNode.insertBefore(nav, script);

  var btn = nav.querySelector("#corner-menu-btn");
  var list = nav.querySelector("#corner-menu-list");
  function setOpen(open) {
    list.hidden = !open;
    btn.setAttribute("aria-expanded", open ? "true" : "false");
  }
  btn.addEventListener("click", function (e) { e.stopPropagation(); setOpen(list.hidden); });
  document.addEventListener("click", function (e) {
    if (!list.hidden && !list.contains(e.target)) setOpen(false);
  });
  window.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !list.hidden) { setOpen(false); btn.focus(); }
  });
})();
