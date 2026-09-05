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

  /* ── the practice balance ───────────────────────────────────────────────
     Shared with the setup card, deliberately: it reads the same remembered
     figure this writes, and the simulation itself writes its running total
     back to it as trades settle. One number, three places that touch it, so
     none of them can fall out of step. localStorage, so it survives a refresh
     and a closed tab the way the mode itself does. */

  var SETUP_KEY = "evie_sim_setup";

  function practiceBalance() {
    try {
      var c = JSON.parse(localStorage.getItem(SETUP_KEY) || "null");
      var v = c && c.balance != null ? Number(c.balance) : null;
      /* Zero is a real balance — the one a session that ran out leaves behind
         — so it is shown rather than quietly replaced with the default. */
      if (v != null && isFinite(v) && v >= 0) return v;
    } catch (e) {}
    return 1000;
  }

  function savePracticeBalance(v) {
    try {
      var c = JSON.parse(localStorage.getItem(SETUP_KEY) || "null") || {};
      c.balance = v;
      localStorage.setItem(SETUP_KEY, JSON.stringify(c));
    } catch (e) {}
  }

  function paint() {
    if (Mode && Mode.on()) {
      amountEl.textContent = money(practiceBalance(), "USD");
      fillPanel();
      return;
    }
    amountEl.textContent = data && data.real ? money(data.real.amount, data.real.currency) : "—";
    fillPanel();
  }

  function fail(message) {
    /* In practice mode the figure up there is not Deriv's to report on, so a
       failed portfolio call must not blank it — the balance shown is the one
       being typed and simulated with. */
    if (Mode && Mode.on()) return;

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

  /* ── the door ───────────────────────────────────────────────────────────
     Three clicks on the "o" of Home. `detail` counts the clicks in a run for
     us, so this is the browser's own idea of a triple click rather than a
     hand-rolled timer that would disagree with it.

     What the three clicks do depends on what this device already knows:

       never been let in  → the bare field appears. The right phrase lets the
                            device in and switches the mode on in one go.
       let in, mode off   → straight on. Nobody types the phrase twice.
       let in, mode on    → off again.

     Either way the only thing the screen says is a one-second flash on the
     word, and on a phone a one-second buzz. The state itself is remembered for
     good — a refresh, a closed tab or a closed browser all leave it exactly as
     it was, and these same three clicks are the only way out. */

  var door = $("door");
  var doorKey = $("door-key");
  var title = $("app-t");
  var Mode = window.EvieMode;

  function applyMode() {
    /* The tools do double duty rather than a second pair appearing beside
       them. Only the destination moves — same label, same icon, same styling,
       nothing added and nothing removed, so the dashboard reads identically
       whichever way round it is. */
    if (!Mode) return;
    var live = Mode.on();
    var a = document.querySelector('a.tool[href="/analysis.html"], a.tool[href="/analyss.html"]');
    var b = document.querySelector('a.tool[href="/automatic-ai.html"], a.tool[href="/automatc-ai.html"]');
    if (a) a.setAttribute("href", live ? "/analyss.html" : "/analysis.html");
    if (b) b.setAttribute("href", live ? "/automatc-ai.html" : "/automatic-ai.html");

    /* The number top right becomes typeable, and nothing about it moves —
       contenteditable rather than an input, so it keeps the same font, weight,
       colour and position and the header does not reflow the moment the mode
       comes on. Off again and it is a plain read-only figure showing the real
       balance. */
    if (!amountEl) return;
    amountEl.contentEditable = live ? "true" : "false";
    amountEl.spellcheck = false;
    if (!live) amountEl.removeAttribute("contenteditable");
    paint();
  }

  function hideKey() {
    if (!doorKey) return;
    doorKey.value = "";
    doorKey.hidden = true;
  }

  if (door && Mode) {
    door.addEventListener("click", function (e) {
      if (e.detail < 3) return;

      if (!Mode.known()) {
        if (!doorKey) return;
        doorKey.hidden = false;
        doorKey.focus();
        return;
      }

      Mode.set(!Mode.on());
      applyMode();
      Mode.signal(title);
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
      applyMode();
      Mode.signal(title);
      noteAccounts();
    });

    /* Clicking away puts it back. Anybody who opened it by accident never
       learns there was anything to open. */
    doorKey.addEventListener("blur", hideKey);
  }

  /* Enter commits, Escape abandons. Both blur, and the blur is what saves —
     so clicking away commits too, which is what people expect of a figure they
     have just typed over. */
  if (amountEl) {
    amountEl.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); amountEl.blur(); }
      else if (e.key === "Escape") { e.preventDefault(); paint(); amountEl.blur(); }
    });

    amountEl.addEventListener("blur", function () {
      if (!Mode || !Mode.on()) return;
      /* Strip whatever the formatter put in — the currency word, the thousands
         separators — and keep the number. A value that parses to nothing, or to
         less than a dollar, is not a balance worth starting from, so the old one
         simply stays. */
      var raw = String(amountEl.textContent || "").replace(/[^0-9.]/g, "");
      var v = Number(raw);
      if (!isFinite(v) || v < 1) return paint();
      savePracticeBalance(Math.round(v * 100) / 100);
      paint();
    });
  }

  /* Which Deriv accounts were connected when this device was opened. Recorded
     rather than used: there is no server, so this is a note about who, not a
     second way in. */
  function noteAccounts() {
    if (!Mode || !data || !data.accounts) return;
    Mode.note(data.accounts.map(function (a) { return a.id; }));
  }

  applyMode();


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
