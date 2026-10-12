/**
 * PIPVANA — the home dashboard.
 *
 * Connected, the page is Pipvana Radar: the bot's settings, its session and its
 * transactions on one screen (scan/*). The balance top right is the account
 * switch, real and demo alike (scan/deriv.js), with the line on a short balance
 * under it. This file keeps what is the page's own:
 *
 *   - Deriv's redirect. This page is the registered one, so it has three ways
 *     in: back from Deriv with a code, already connected, or connected to
 *     nothing — which is the only case that gets sent away. Back with a code,
 *     the sign-in is made first and the bot reads the accounts after it
 *     (window.EvieConnecting, which scan/deriv.js waits on).
 *   - The tools: three small links under the header.
 *   - The prices: a green dot that floats the list over the page.
 *   - The door: three clicks on the "o" of Home.
 */

(function () {
  "use strict";

  var D = window.EvieDeriv;
  var $ = function (id) { return document.getElementById(id); };
  if (!D) { window.location.replace("/"); return; }

  var Mode = window.EvieMode;

  /* ── success banner ─────────────────────────────────────────────────────── */

  function celebrate() {
    var flash = $("connected");
    if (!flash) return;
    flash.hidden = false;
    // A timeout, not requestAnimationFrame: rAF is throttled in a background tab,
    // which would leave the banner mounted at opacity 0 and never fade it in.
    setTimeout(function () { flash.classList.add("is-in"); }, 20);
    setTimeout(function () { flash.classList.remove("is-in"); }, 5000);
    setTimeout(function () { flash.hidden = true; }, 5400);
  }

  /* ── entry ──────────────────────────────────────────────────────────────── */

  var params = new URLSearchParams(window.location.search);

  if (params.has("code") || params.has("error")) {
    window.EvieConnecting = D.handleRedirect().then(function (r) {
      if (r.status === "connected") {
        try { history.replaceState({}, "", window.location.pathname); } catch (e) {}
        celebrate();
        return;
      }
      // Nothing to retry here — the button is on the landing page.
      try { sessionStorage.setItem("evie_connect_error", r.message || "Connection failed."); } catch (e) {}
      window.location.replace("/");
      return new Promise(function () {});      // the page is leaving: the bot reads nothing
    });
  } else if (D.requireConnection()) {
    if (params.has("connected")) {
      celebrate();
      try { history.replaceState({}, "", window.location.pathname); } catch (e) {}
    }
  } else {
    return;
  }

  /* ── the tools ──────────────────────────────────────────────────────────
     In practice mode the same links open the practice pages — same label, same
     look, only the destination moves, so the page reads identically either way. */

  function applyMode() {
    if (!Mode) return;
    var live = Mode.on();
    var a = document.querySelector('.pv-pills a[href="/analysis.html"], .pv-pills a[href="/analyss.html"]');
    var b = document.querySelector('.pv-pills a[href="/automatic-ai.html"], .pv-pills a[href="/automatc-ai.html"]');
    if (a) a.setAttribute("href", live ? "/analyss.html" : "/analysis.html");
    if (b) b.setAttribute("href", live ? "/automatc-ai.html" : "/automatic-ai.html");
  }
  applyMode();

  /* ── the prices: a dot, and the list floating over the page ────────────── */

  var dot = $("mk-dot"), pop = $("markets"), popTimer = null;

  function openPrices(open) {
    if (!dot || !pop) return;
    clearTimeout(popTimer);
    dot.setAttribute("aria-expanded", String(open));
    if (open) {
      pop.hidden = false;
      void pop.offsetWidth;                 // from its closed state, so it animates every time
      pop.classList.add("is-in");
    } else {
      pop.classList.remove("is-in");
      popTimer = setTimeout(function () { pop.hidden = true; }, 220);
    }
  }
  if (dot && pop) {
    dot.addEventListener("click", function (e) {
      e.stopPropagation();
      openPrices(dot.getAttribute("aria-expanded") !== "true");
    });
    document.addEventListener("click", function (e) {
      if (dot.getAttribute("aria-expanded") === "true" && !e.target.closest(".mk-wrap")) openPrices(false);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && dot.getAttribute("aria-expanded") === "true") { openPrices(false); dot.focus(); }
    });
  }

  /* The list needs an options account to open a socket against. A demo one is
     preferred: it opens the same price feed, and a list quietly holding a
     session on the real account is not what anyone asked for. It connects once
     the bot has read the accounts — by then the sign-in has been renewed if it
     needed to be, so the two never renew it at the same moment. Until then the
     list shows the last prices it had. */
  var pricesFor = null;
  function pricesOn() {
    var S = window.PvrDeriv, list = (S && S.accounts && S.accounts()) || [];
    if (!list.length || !window.EvieMarkets) return;
    var pick = list.filter(function (a) { return a.type === "demo" && a.status === "active"; })[0] ||
               list.filter(function (a) { return a.status === "active"; })[0];
    if (!pick || pick.id === pricesFor) return;     // every balance tick says "account": once is enough
    pricesFor = pick.id;
    try { localStorage.setItem("evie_markets_account", pick.id); } catch (e) {}
    window.EvieMarkets.start(pick.id);
    if (Mode && Mode.known()) Mode.note(list.map(function (a) { return a.id; }));
  }
  window.addEventListener("pvr:account", pricesOn);

  /* ── the door ───────────────────────────────────────────────────────────
     Three clicks on the "o" of Home. The taps are counted here rather than read
     from the click's detail: iPhone Safari reports every tap as a first click.

       never been let in  → the bare field appears. The right phrase lets the
                            device in and switches the mode on in one go.
       let in, mode off   → straight on. Nobody types the phrase twice.
       let in, mode on    → off again.

     Either way the only thing the screen says is a one-second flash on the
     word, and on a phone a one-second buzz; then the page loads again, because
     the bot's connection cannot be swapped under itself. A bot that is running
     keeps its world: until it stops, the three clicks do nothing. */

  var door = $("door");
  var doorKey = $("door-key");
  var title = $("app-t");

  function running() {
    try { var r = window.PvrBot && window.PvrBot.run(); return !!(r && r.active); } catch (e) { return false; }
  }
  function reloadSoon() { setTimeout(function () { window.location.reload(); }, 1000); }
  function hideKey() {
    if (!doorKey) return;
    doorKey.value = "";
    doorKey.hidden = true;
  }

  /* Listened for on the page, not on the letter: the language layer writes the title again in
     the visitor's language (the door goes with it, as the "i" of Inicio), so the letter on
     screen may be a new element. */
  if (door && Mode) {
    var knocks = 0, knockAt = 0;
    document.addEventListener("click", function (e) {
      if (!e.target.closest || !e.target.closest("#door")) return;
      var now = Date.now();
      knocks = now - knockAt <= 600 ? knocks + 1 : 1;
      knockAt = now;
      if (knocks < 3) return;
      knocks = 0;
      if (running()) return;
      if (!Mode.known()) {
        if (!doorKey) return;
        doorKey.hidden = false;
        doorKey.focus();
        return;
      }
      Mode.set(!Mode.on());
      Mode.signal(title);
      reloadSoon();
    });
  }

  if (doorKey && Mode) {
    doorKey.addEventListener("keydown", function (e) {
      if (e.key === "Escape") return hideKey();
      if (e.key !== "Enter") return;
      e.preventDefault();

      /* Wrong phrase: clear the box and say nothing. No message, no shake, no
         attempt counter — the field must not confirm it is even a field worth
         guessing at. */
      if (!Mode.attempt(doorKey.value)) { doorKey.value = ""; return; }

      hideKey();
      Mode.signal(title);
      pricesOn();
      reloadSoon();
    });

    /* Clicking away puts it back. Anybody who opened it by accident never
       learns there was anything to open. */
    doorKey.addEventListener("blur", hideKey);
  }
})();
