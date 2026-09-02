/**
 * UPTICK — light or dark, remembered.
 *
 * Light is the default. The choice lives in localStorage and is applied to
 * <html> as data-theme, which every colour token keys off.
 *
 * The APPLYING happens in a tiny inline script in each page's <head>, before
 * the browser paints — doing it here, after the stylesheet has already drawn
 * the light page, would flash white at someone who chose dark. This file only
 * wires the button.
 *
 * The landing page is not in this: it is black by design, has no toggle, and
 * loads none of this.
 */

(function (global) {
  "use strict";

  var KEY = "uptick_theme";

  function current() {
    return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  }

  function apply(theme) {
    var dark = theme === "dark";
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    try { localStorage.setItem(KEY, dark ? "dark" : "light"); } catch (e) {}

    // The browser chrome around the page should match the page.
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", dark ? "#07070a" : "#f7f7fb");

    Array.prototype.forEach.call(document.querySelectorAll("[data-theme-toggle]"), function (b) {
      b.setAttribute("aria-pressed", String(dark));
      b.setAttribute("title", dark ? "Switch to light" : "Switch to dark");
      var l = b.querySelector("[data-theme-label]");
      if (l) l.textContent = dark ? "Light" : "Dark";
    });
  }

  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-theme-toggle]");
    if (!b) return;
    apply(current() === "dark" ? "light" : "dark");
  });

  // Reflect whatever the head script decided, so the button starts correct.
  apply(current());

  global.UptickTheme = { apply: apply, current: current };
})(window);
