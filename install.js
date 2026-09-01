/**
 * EVIE — "Install app".
 *
 * Installing is a browser feature, not a page feature, and the three families
 * of browser expose it three different ways. This does the honest version of
 * each rather than one button that quietly does nothing on two of them:
 *
 *   Chrome, Edge, Samsung, Opera — on Android and desktop
 *     They fire `beforeinstallprompt`. We keep the event and the button calls
 *     it. This is the only case where a click really installs.
 *
 *   iPhone and iPad — every browser, Safari included
 *     There is no `beforeinstallprompt` on iOS and no way for a page to start
 *     an install. Installing is Share → Add to Home Screen, so the button says
 *     so instead of pretending.
 *
 *   Firefox, and anything else
 *     No install path a page can reach. The button explains where the browser
 *     keeps it rather than disappearing, because a person who came looking for
 *     it deserves an answer.
 *
 * Inside an already-installed window there is nothing left to offer, so the
 * button removes itself.
 *
 * It binds to whatever carries [data-install] — the header on the landing page,
 * the dashboard on home — so a page opts in with markup and nothing else.
 */

(function (global) {
  "use strict";

  var deferred = null;

  function installed() {
    var standalone = global.matchMedia && global.matchMedia("(display-mode: standalone)").matches;
    return !!standalone || navigator.standalone === true;
  }

  function isApple() {
    var ua = navigator.userAgent;
    // iPadOS 13+ calls itself a Mac; the touch count is what gives it away.
    return /iPad|iPhone|iPod/.test(ua) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }

  function buttons() {
    return [].slice.call(document.querySelectorAll("[data-install]"));
  }

  function show() { buttons().forEach(function (b) { b.hidden = false; }); }
  function hide() { buttons().forEach(function (b) { b.hidden = true; }); }

  /* Everyone gets the button. Where a real prompt exists it is used; where it
     does not, the same button explains the two taps that do it. */
  function click() {
    if (deferred) {
      deferred.prompt();
      deferred.userChoice.then(function () { deferred = null; hide(); });
      return;
    }
    howTo();
  }

  function howTo() {
    var apple = isApple();
    var wrap = document.createElement("div");
    wrap.className = "how";
    wrap.setAttribute("role", "dialog");
    wrap.setAttribute("aria-label", "How to install Evie");
    wrap.innerHTML =
      '<div class="how-card">' +
        '<div class="how-head">' +
          "<h3>Add Evie to your home screen</h3>" +
          '<button type="button" class="how-x" aria-label="Close">' +
            '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>' +
          "</button>" +
        "</div>" +
        "<p>" + (apple
          ? "iPhone and iPad do not let a website install itself, so it takes two taps."
          : "This browser keeps installing in its own menu.") + "</p>" +
        '<ol class="how-steps">' +
          (apple
            ? "<li>Tap the <b>Share</b> button in the browser bar.</li>" +
              "<li>Choose <b>Add to Home Screen</b>, then <b>Add</b>.</li>"
            : "<li>Open the browser menu — the <b>⋮</b> or <b>≡</b> button.</li>" +
              "<li>Choose <b>Install</b> or <b>Add to Home screen</b>.</li>") +
        "</ol>" +
        '<button type="button" class="btn btn-line how-ok">Got it</button>' +
      "</div>";

    function close() { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); }
    wrap.addEventListener("click", function (e) { if (e.target === wrap) close(); });
    wrap.querySelector(".how-x").onclick = close;
    wrap.querySelector(".how-ok").onclick = close;
    document.body.appendChild(wrap);
  }

  function bind() {
    if (installed()) { hide(); return; }
    show();
    buttons().forEach(function (b) { b.addEventListener("click", click); });
  }

  global.addEventListener("beforeinstallprompt", function (e) {
    // Without this Chrome shows its own mini-infobar and takes the moment away.
    e.preventDefault();
    deferred = e;
  });

  global.addEventListener("appinstalled", function () { deferred = null; hide(); });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bind);
  else bind();

  /* Registered for one reason: Chrome will not offer to install a site with no
     service worker. It caches nothing — see sw.js. */
  if ("serviceWorker" in navigator) {
    global.addEventListener("load", function () {
      navigator.serviceWorker.register("/sw.js").catch(function () {});
    });
  }
})(window);
