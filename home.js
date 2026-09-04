/**
 * EVIE — the home dashboard.
 *
 * The page itself shows one number: the real balance, top right. That is the
 * figure somebody opens this for, and everything else — the demo account, the
 * wallets, the per-account ids — is detail they want occasionally and not while
 * they are deciding what to do next. So it lives behind the badge, one
 * double-click away, in a sheet.
 *
 * The headline is the largest single-currency bucket rather than a sum of
 * everything. Adding USD to EUR would produce a figure that is not money.
 *
 * This page is also the registered Deriv redirect, so it has three ways in:
 * back from Deriv with a code, already connected, or connected to nothing —
 * which is the only case that gets sent away.
 */

(function () {
  "use strict";

  var D = window.EvieDeriv;
  var $ = function (id) { return document.getElementById(id); };
  if (!D) { window.location.replace("/"); return; }

  var amountEl = $("amount");
  var badgeEl = $("badge");
  var sheetEl = $("sheet");
  var sheetBody = $("sheet-body");

  var data = null;

  function money(n, currency) {
    if (n == null) return "—";
    var d = window.EvieCurrency ? window.EvieCurrency.digits(currency) : 2;
    return (currency || "USD") + " " + Number(n).toLocaleString(undefined, {
      minimumFractionDigits: d,
      maximumFractionDigits: d
    });
  }

  function esc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /* ── success banner ─────────────────────────────────────────────────────── */

  function celebrate() {
    var flash = $("connected");
    if (!flash) return;
    flash.hidden = false;
    // A timeout, not requestAnimationFrame: rAF is throttled in a background tab,
    // which would leave the banner mounted at opacity 0 and never fade it in.
    setTimeout(function () { flash.classList.add("is-in"); }, 20);
    setTimeout(function () { flash.classList.remove("is-in"); }, 5000);
  }

  /* ── the one number on the page ─────────────────────────────────────────── */

  function paint() {
    amountEl.textContent = data && data.real ? money(data.real.amount, data.real.currency) : "—";
    fillPanel();
  }

  function fail(message) {
    /* A dash, not the word "Unavailable". The header is where a balance goes,
       and a sentence sitting in it reads as a broken number rather than as an
       explanation — the explanation belongs in the panel, which has room for
       one and is where somebody looks next. */
    amountEl.textContent = "—";
    amountEl.title = message || "Could not reach Deriv.";

    /* deriv.js says "not connected" to its own callers, which is the right
       length for a log and the wrong one for a panel. */
    var human = !message || message === "not connected"
      ? "No Deriv account connected yet."
      : message;
    sayPanel(human);

    /* Nothing to disconnect from: a button that undoes nothing is a button
       that makes somebody wonder what it did. */
    ["disconnect", "disconnect-inline"].forEach(function (id) {
      var b = $(id);
      if (b) b.hidden = true;
    });
  }

  /** Put a plain sentence where the accounts would have been. */
  function sayPanel(message) {
    var body = $("acctp-body");
    if (!body) return;
    body.innerHTML = '<p class="acct acct--none">' + esc(message) + "</p>";
  }

  /* ── the detail sheet ───────────────────────────────────────────────────── */

  function group(title, rows, emptyText) {
    var body = rows.length
      ? rows.map(function (a) {
          return '<li class="acct">' +
            '<span class="acct-kind">' + esc(a.kind) + "</span>" +
            '<span class="acct-id">' + esc(a.id) + "</span>" +
            '<span class="acct-bal">' + esc(money(a.balance, a.currency)) + "</span>" +
          "</li>";
        }).join("")
      : '<li class="acct acct--none">' + esc(emptyText) + "</li>";

    return '<section class="grp"><h3 class="grp-t">' + esc(title) + "</h3>" +
           '<ul class="accts">' + body + "</ul></section>";
  }

  /* The accounts, as markup. Written once and used twice — the sheet on a
     narrow screen and the panel on a wide one — so the two can never come to
     disagree about what this login holds. */
  function accountsHtml() {
    var reals = data.accounts.filter(function (a) { return !a.demo; });
    var demos = data.accounts.filter(function (a) { return a.demo; });

    return (data.nickname ? '<p class="sheet-who">' + esc(data.nickname) + "</p>" : "") +
      group("Real", reals, "No real accounts on this login.") +
      group("Demo", demos, "No demo account on this login.");
  }

  function fillSheet() {
    if (!data) return;
    sheetBody.innerHTML = accountsHtml() +
      '<p class="sheet-note">Balance missing? Transfer it to your <strong>options</strong> ' +
      "account in your Deriv portfolio to see all of it here.</p>";
  }

  /* The panel carries its own note and buttons in the markup, so it only ever
     needs the accounts themselves. */
  /* The panel is already on the page holding its own shape; this only
     replaces what is inside it. Nothing appears, nothing moves. */
  function fillPanel() {
    var body = $("acctp-body");
    if (!body || !data) return;
    body.innerHTML = accountsHtml();
  }

  function openSheet() {
    if (!data) return;
    fillSheet();
    sheetEl.hidden = false;
    setTimeout(function () { sheetEl.classList.add("is-in"); }, 10);
    badgeEl.setAttribute("aria-expanded", "true");
  }

  function closeSheet() {
    sheetEl.classList.remove("is-in");
    badgeEl.setAttribute("aria-expanded", "false");
    setTimeout(function () { sheetEl.hidden = true; }, 200);
  }

  badgeEl.addEventListener("dblclick", openSheet);

  /* A phone has no double-click, so a single tap opens it there. */
  badgeEl.addEventListener("click", function (e) {
    if (e.detail === 0 || matchMedia("(hover: none)").matches) openSheet();
  });

  sheetEl.addEventListener("click", function (e) {
    if (e.target.closest("[data-close]")) closeSheet();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !sheetEl.hidden) closeSheet();
  });

  /* ── disconnect, inside the sheet ───────────────────────────────────────── */

  ["disconnect", "disconnect-inline"].forEach(function (id) {
    var dc = $(id);
    if (!dc) return;
    dc.addEventListener("click", function () {
      D.disconnect();
      window.location.replace("/");
    });
  });

  /* ── the simulator's door ───────────────────────────────────────────────
     Three clicks on the "o" of Home. `detail` counts the clicks in a run for
     us, so this is the browser's own idea of a triple click rather than a
     hand-rolled timer that would disagree with it.

     Once open it stays open for the visit: someone who has found it should not
     have to find it again on the way back from the simulation. */

  var door = $("door");
  var simCard = $("sim-card");
  if (door && simCard) {
    var DOOR_KEY = "evie_sim_door";
    try { if (sessionStorage.getItem(DOOR_KEY) === "1") simCard.hidden = false; } catch (e) {}

    door.addEventListener("click", function (e) {
      if (e.detail < 3) return;
      simCard.hidden = false;
      try { sessionStorage.setItem(DOOR_KEY, "1"); } catch (x) {}
    });
  }


  /* ── reading it ─────────────────────────────────────────────────────────── */

  function load() {
    return D.portfolio()
      .then(function (d) {
        data = d;
        paint();

        // The markets rail needs an options account to open a socket against.
        // Prefer a demo one: it opens the same price feed, and a rail quietly
        // holding a session on the real account is not what anyone asked for.
        if (window.EvieMarkets) {
          var opts = d.accounts.filter(function (a) { return a.kind === "Options"; });
          var pick = opts.filter(function (a) { return a.demo; })[0] || opts[0];
          if (pick) {
            try { localStorage.setItem("evie_markets_account", pick.id); } catch (x) {}
            window.EvieMarkets.start(pick.id);
          }
        }
      })
      .catch(function (e) {
        // An expired session cannot be fixed by staring at it — the refresh
        // already ran before the call, so send them back to Connect.
        if (e && e.expired) {
          D.disconnect();
          try { sessionStorage.setItem("evie_connect_error", e.message); } catch (x) {}
          window.location.replace("/");
          return;
        }
        fail(e && e.message);
      });
  }

  /* The rail connects on the account used last, straight away. Waiting for the
     portfolio call means a dashboard that is blank for as long as that takes. */
  (function () {
    if (!window.EvieMarkets) return;
    var id = null;
    try { id = localStorage.getItem("evie_markets_account"); } catch (e) {}
    if (id) window.EvieMarkets.start(id);
  })();

  /* ── entry ──────────────────────────────────────────────────────────────── */

  var params = new URLSearchParams(window.location.search);

  if (params.has("code") || params.has("error")) {
    D.handleRedirect().then(function (r) {
      if (r.status === "connected") { celebrate(); return load(); }
      // Nothing to retry here — the button is on the landing page.
      try { sessionStorage.setItem("evie_connect_error", r.message || "Connection failed."); } catch (e) {}
      window.location.replace("/");
    });
  } else if (D.requireConnection()) {
    if (params.has("connected")) {
      celebrate();
      try { history.replaceState({}, "", window.location.pathname); } catch (e) {}
    }
    load();
  }
})();
