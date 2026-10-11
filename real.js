/**
 * EVIE — a login with no real account.
 *
 * The bots trade a real Deriv account. A login that has only a demo (hidden
 * here) or no options account at all gets, as on the other sites, a red
 * "Create real account" button in the header where the balance would be, and
 * the card that says why and how: once a visit by itself, and again on Start.
 *
 *   EvieReal.set(kind)   null (a real account is there) / "real" (only a demo)
 *                        / "none" (no options account) — the pages call it
 *                        whenever they learn which.
 *   EvieReal.kind()      the last of those.
 *   EvieReal.offer()     the card, now (Start, a trade button).
 */
(function (global) {
  "use strict";
  var kind = null, offered = false;

  function paint() {
    var perch = document.querySelector(".perch"), btn = document.getElementById("acct-real");
    if (perch) perch.classList.toggle("is-noreal", !!kind);
    if (btn) btn.hidden = !kind;
    // On small screens the button sits under the header; the page makes room for it (the sites' CSS).
    document.documentElement.classList.toggle("has-noreal", !!kind);
  }

  function offer() {
    if (!kind || !global.PopupNotifications || !global.PopupNotifications.showNeedsReal) return;
    global.PopupNotifications.showNeedsReal(kind === "real");
  }

  function set(k) {
    kind = k || null;
    paint();
    // Once a visit by itself — after the page has painted, so it lands on the page and not before it.
    if (kind && !offered) { offered = true; setTimeout(offer, 600); }
  }

  global.EvieReal = { set: set, kind: function () { return kind; }, offer: offer };
})(window);
