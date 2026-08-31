/**
 * EVIE — the home dashboard.
 *
 * Shows the one number a bot can actually trade on: the balance of the Deriv
 * OPTIONS account. That distinction is the whole reason the notice below it
 * exists — a funded Deriv user can read zero here and be entirely correct,
 * because their money is in a wallet or an MT5 account instead.
 *
 * Real and demo both come back from the same read, so the badge is a toggle
 * rather than a second request: double-click flips the figure and the account
 * id between them, with no waiting.
 */

(function () {
  "use strict";

  var D = window.EvieDeriv;
  var $ = function (id) { return document.getElementById(id); };

  /* An unconnected visitor has nothing to look at — send them to the door. */
  if (!D || !D.isConnected()) {
    window.location.replace("/");
    return;
  }

  var amountEl = $("amount");
  var accountEl = $("account");
  var badgeEl = $("badge");
  var hintEl = $("hint");
  var noticeEl = $("notice");

  var state = { real: null, demo: null, showing: "real" };

  function money(n, currency) {
    var v = Number(n || 0).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
    return (currency || "USD") + " " + v;
  }

  /* ── success banner, only when they have just connected ─────────────────── */

  if (new URLSearchParams(window.location.search).has("connected")) {
    var flash = $("connected");
    if (flash) {
      flash.hidden = false;
      // A timeout, not requestAnimationFrame: rAF is throttled in a background
      // tab, which would leave the banner mounted at opacity 0 and never fade
      // it in for someone who opened this in a tab they were not looking at.
      setTimeout(function () { flash.classList.add("is-in"); }, 20);
      setTimeout(function () { flash.classList.remove("is-in"); }, 5000);
    }
    try { history.replaceState({}, "", window.location.pathname); } catch (e) {}
  }

  /* ── painting ───────────────────────────────────────────────────────────── */

  function render() {
    var a = state[state.showing];
    var isDemo = state.showing === "demo";

    badgeEl.textContent = isDemo ? "Demo" : "Real";
    badgeEl.classList.toggle("badge--demo", isDemo);

    if (!a) {
      amountEl.textContent = isDemo ? "No demo account" : "No real account";
      accountEl.textContent = "";
      return;
    }

    amountEl.textContent = money(a.balance, a.currency);
    accountEl.textContent = a.id;

    // The notice is about a real account reading low. On the demo it is noise.
    if (noticeEl) noticeEl.hidden = isDemo;
  }

  function fail(message) {
    amountEl.textContent = "Unavailable";
    accountEl.textContent = message || "Could not reach Deriv.";
    accountEl.classList.add("is-error");
  }

  /* ── the badge is a toggle ──────────────────────────────────────────────── */

  badgeEl.addEventListener("dblclick", function () {
    if (!state.real && !state.demo) return;
    state.showing = state.showing === "real" ? "demo" : "real";
    render();
  });

  /* Double-click has no touch equivalent, so a phone gets a plain tap. */
  badgeEl.addEventListener("click", function (e) {
    if (e.detail === 0 || matchMedia("(hover: none)").matches) {
      if (!state.real && !state.demo) return;
      state.showing = state.showing === "real" ? "demo" : "real";
      render();
    }
  });

  /* ── disconnect ─────────────────────────────────────────────────────────── */

  var dc = $("disconnect");
  if (dc) {
    dc.addEventListener("click", function () {
      D.disconnect();
      window.location.replace("/");
    });
  }

  /* ── read the accounts ──────────────────────────────────────────────────── */

  D.accounts()
    .then(function (list) {
      var reals = list.filter(function (a) { return !a.demo && typeof a.balance === "number"; });
      var demos = list.filter(function (a) { return a.demo && typeof a.balance === "number"; });

      // Where there are several real accounts, the funded one is the one they
      // mean — a second currency sitting at 0.00 is not the answer.
      reals.sort(function (x, y) { return y.balance - x.balance; });

      state.real = reals[0] || null;
      state.demo = demos[0] || null;
      state.showing = state.real ? "real" : (state.demo ? "demo" : "real");

      if (hintEl && state.real && state.demo) hintEl.hidden = false;
      render();
    })
    .catch(function (e) { fail(e && e.message); });
})();
