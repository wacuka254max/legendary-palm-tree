/**
 * EVIE — the home dashboard.
 *
 * Shows the whole Deriv portfolio, not just the options account: every options
 * account and every wallet, each with its own id and balance, under a headline
 * total and the id of the account they connected with.
 *
 * The headline is the largest single-currency bucket rather than a sum of
 * everything. Adding USD to EUR would produce a number that is not money, so
 * the per-account rows carry the detail instead.
 *
 * Real and demo both come back from the same read, so the badge is a toggle
 * rather than a second request: double-click flips the whole card between
 * them, with no waiting.
 */

(function () {
  "use strict";

  var D = window.EvieDeriv;
  var $ = function (id) { return document.getElementById(id); };

  if (!D) { window.location.replace("/"); return; }

  var amountEl = $("amount");
  var accountEl = $("account");
  var badgeEl = $("badge");
  var hintEl = $("hint");
  var noticeEl = $("notice");

  var acctsEl = $("accts");
  var state = { data: null, showing: "real" };

  function money(n, currency) {
    var v = Number(n || 0).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
    return (currency || "USD") + " " + v;
  }

  /* ── success banner ─────────────────────────────────────────────────────── */

  function celebrate() {
    var flash = $("connected");
    if (!flash) return;
    flash.hidden = false;
    // A timeout, not requestAnimationFrame: rAF is throttled in a background
    // tab, which would leave the banner mounted at opacity 0 and never fade
    // it in for someone who opened this in a tab they were not looking at.
    setTimeout(function () { flash.classList.add("is-in"); }, 20);
    setTimeout(function () { flash.classList.remove("is-in"); }, 5000);
  }

  /* ── painting ───────────────────────────────────────────────────────────── */

  function esc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function render() {
    var d = state.data;
    if (!d) return;

    var isDemo = state.showing === "demo";
    var side = isDemo ? d.demo : d.real;
    var rows = d.accounts.filter(function (a) { return !!a.demo === isDemo; });

    badgeEl.textContent = isDemo ? "Demo" : "Real";
    badgeEl.classList.toggle("badge--demo", isDemo);

    /* The headline is the biggest single-currency bucket. Adding USD to EUR
       would invent a number, so the per-account rows below carry the rest. */
    amountEl.textContent = side ? money(side.amount, side.currency) : "—";

    /* Who this is: the profile name where Deriv gave us one, and the id of the
       account they actually connected with. */
    var primary = rows.filter(function (a) { return a.kind === "Options"; })[0] || rows[0];
    var who = [];
    if (d.nickname) who.push(d.nickname);
    if (primary) who.push(primary.id);
    accountEl.textContent = who.join(" · ");
    accountEl.classList.remove("is-error");

    if (!rows.length) {
      acctsEl.innerHTML = '<li class="acct acct--none">No ' +
        (isDemo ? "demo" : "real") + " accounts on this login.</li>";
      if (noticeEl) noticeEl.hidden = isDemo;
      return;
    }

    acctsEl.innerHTML = rows.map(function (a) {
      return '<li class="acct">' +
        '<span class="acct-kind">' + esc(a.kind) + "</span>" +
        '<span class="acct-id">' + esc(a.id) + "</span>" +
        '<span class="acct-bal">' +
          (a.balance == null ? "—" : esc(money(a.balance, a.currency))) +
        "</span>" +
      "</li>";
    }).join("");

    // The transfer notice is about a real account reading low. On demo it is noise.
    if (noticeEl) noticeEl.hidden = isDemo;
  }

  function fail(message) {
    amountEl.textContent = "Unavailable";
    accountEl.textContent = message || "Could not reach Deriv.";
    accountEl.classList.add("is-error");
    if (acctsEl) acctsEl.innerHTML = "";
  }

  /* ── the badge is a toggle ──────────────────────────────────────────────── */

  badgeEl.addEventListener("dblclick", function () {
    if (!state.data) return;
    state.showing = state.showing === "real" ? "demo" : "real";
    render();
  });

  /* Double-click has no touch equivalent, so a phone gets a plain tap. */
  badgeEl.addEventListener("click", function (e) {
    if (e.detail === 0 || matchMedia("(hover: none)").matches) {
      if (!state.data) return;
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

  /* ── entry ──────────────────────────────────────────────────────────────
     This page is the registered Deriv redirect, so it has three ways in:
     coming back from Deriv with a code, arriving already connected, or
     arriving with nothing — which is the one case that gets sent away. */

  var params = new URLSearchParams(window.location.search);

  if (params.has("code") || params.has("error")) {
    amountEl.textContent = "Connecting…";
    D.handleRedirect().then(function (r) {
      if (r.status === "connected") { celebrate(); return load(); }
      // Nothing to show and nothing to retry here — the button is on the
      // landing page, so hand them back to it with the reason.
      try { sessionStorage.setItem("evie_connect_error", r.message || "Connection failed."); } catch (e) {}
      window.location.replace("/");
    });
  } else if (!D.isConnected()) {
    window.location.replace("/");
  } else {
    if (params.has("connected")) {
      celebrate();
      try { history.replaceState({}, "", window.location.pathname); } catch (e) {}
    }
    load();
  }

  /* ── read the accounts ──────────────────────────────────────────────────── */

  function load() {
    return D.portfolio()
      .then(function (d) {
        state.data = d;
        // Open on whichever side actually has money to show.
        state.showing = d.real ? "real" : (d.demo ? "demo" : "real");
        if (hintEl && d.real && d.demo) hintEl.hidden = false;
        render();
      })
      .catch(function (e) {
        // An expired session cannot be fixed by staring at it — send them back
        // to the button that fixes it.
        if (e && e.expired) {
          D.disconnect();
          try { sessionStorage.setItem("evie_connect_error", e.message); } catch (x) {}
          window.location.replace("/");
          return;
        }
        fail(e && e.message);
      });
  }
})();
