/**
 * EVIE — the simulation's front door.
 *
 * Two jobs, in order.
 *
 * First it collects the conditions: the balance to start with, whether losses
 * come in a run, at random or not at all, how many, and whether the very first
 * trade loses. Those are written where fake-deriv.js reads them.
 *
 * Then — and only then — it loads the analysis page's own scripts. Holding
 * them back matters: app.js opens a socket and starts subscribing the moment
 * it runs, and a balance chosen after the first tick has already landed is a
 * balance applied to a simulation that has already begun. Nothing starts until
 * the conditions are set.
 *
 * Restarting is a reload. The plan lives in the session, so reloading with the
 * card open is the honest way to begin again from a known state, and closing
 * the tab clears it like everything else here.
 */

(function (global) {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };

  /* Which page is being simulated. Each names the scripts it would have loaded
     had it been the real thing — in the same order, minus deriv.js, which
     fake-deriv.js has already stood in for. Order matters: contracts before
     the session, the session before the app, the bot before the app that
     attaches it. */
  var SCRIPTS = global.EVIE_SIM_SCRIPTS || [
    "/analysis/contracts.js",
    "/analysis/session.js",
    "/analysis/analyser.js",
    "/analysis/txn.js",
    "/analysis/bot.js",
    "/analysis/app.js"
  ];

  function loadNext(i, done) {
    if (i >= SCRIPTS.length) return done();
    var s = document.createElement("script");
    s.src = SCRIPTS[i];
    s.onload = function () { loadNext(i + 1, done); };
    s.onerror = function () { loadNext(i + 1, done); };
    document.body.appendChild(s);
  }

  /* The simulation runs the real page's scripts, which ask for their own prefs
     scope by name. Left alone, a stake set here would be waiting on the real
     page in the same tab — practice settings arriving on an account that
     trades real money. Every scope the simulation opens is renamed, so the two
     never meet. */
  if (global.EviePrefs) {
    var realScope = global.EviePrefs.scope;
    global.EviePrefs.scope = function (name) { return realScope("sim-" + name); };
  }

  var mode = "none";

  /* What was set last time, kept in localStorage rather than the session.
     Everything else about a simulation is deliberately per-tab and starts
     clean, but the setup card is a form somebody fills in before they can get
     to the thing they came for — and typing the same balance every time is a
     toll, not a decision. */
  var LAST_KEY = "evie_sim_setup";

  function remember(cfg) {
    try { localStorage.setItem(LAST_KEY, JSON.stringify(cfg)); } catch (e) {}
  }

  function recall() {
    try { return JSON.parse(localStorage.getItem(LAST_KEY) || "null"); }
    catch (e) { return null; }
  }

  function say(text) { $("sim-say").textContent = text; }

  /** What the chosen conditions actually mean, in a sentence. */
  function describe() {
    var n = Math.max(0, Math.round(Number($("sim-count").value) || 0));
    var first = $("sim-first").getAttribute("aria-checked") === "true";

    if (mode === "none") {
      /* On a page that runs recovery drills the recovery still happens, so the
         card says so — without walking through the mechanics of how it is
         provoked, which is the simulator's business and not a setting. */
      var drill = global.EVIE_SIM_DRILLS
        ? " The recovery still runs from time to time — Over 4 or Under 5 at the martingale stake — and wins too."
        : "";
      return (first
        ? "The first trade loses. Every trade after it wins."
        : "Every trade wins.") + drill;
    }
    if (mode === "consecutive") {
      if (!n) return first ? "The first trade loses. Everything else wins." : "Every trade wins.";
      return (first ? "Starting with the first trade, " : "After a few wins, ") +
        n + " trade" + (n === 1 ? "" : "s") + " in a row lose — at a different point each run. " +
        "Everything after that wins.";
    }
    /* Five is the ceiling and the card says so rather than quietly ignoring a
       six: with a win required between any two losses, five in ten is simply
       the most that fits. */
    var capped = Math.min(5, n);
    return (first ? "The first trade loses, then about " : "About ") +
      capped + " in every 10 lose, spread at random and never two together" +
      (n > 5 ? " (five is the most that fits)" : "") + "." +
      (first ? "" : " The first trade always wins.");
  }

  function refresh() {
    var needsCount = mode !== "none";
    $("sim-count-fld").hidden = !needsCount;
    $("sim-count-k").textContent = mode === "random" ? "How many in every 10" : "How many in a row";
    /* Random tops out at five for the reason above; in a row has no such
       limit, since consecutive losses are the entire point of it. */
    $("sim-count").max = mode === "random" ? "5" : "10";
    say(describe());
  }

  $("sim-mode").addEventListener("click", function (e) {
    var b = e.target.closest(".seg-b");
    if (!b) return;
    mode = b.getAttribute("data-mode");
    [].forEach.call(this.querySelectorAll(".seg-b"), function (x) {
      var on = x === b;
      x.classList.toggle("is-on", on);
      x.setAttribute("aria-checked", String(on));
    });
    refresh();
  });

  $("sim-first").addEventListener("click", function () {
    var on = this.getAttribute("aria-checked") !== "true";
    this.setAttribute("aria-checked", String(on));
    refresh();
  });

  $("sim-count").addEventListener("input", refresh);

  /* A balance that looks like somebody's actual account: an odd number of
     dollars and an odd number of cents, between fifty and twenty-five
     thousand. */
  $("sim-random").addEventListener("click", function () {
    var dollars = 50 + Math.floor(Math.random() * 24951);
    var cents = Math.floor(Math.random() * 100);
    $("sim-balance").value = (dollars + cents / 100).toFixed(2);
  });

  /* Put the remembered answers into the fields. Done up front rather than when
     the card opens, because `describe()` reads them and the card must be
     correct the instant it appears. */
  function fill() {
    var last = recall() || {};
    /* `!= null`, not a truth test: a balance of zero is a real outcome — it is
       what a session that ran out looks like — and treating it as "nothing
       remembered" would hand the money back every time the tab reloaded. */
    if (last.balance != null) $("sim-balance").value = last.balance;
    if (last.count != null) $("sim-count").value = last.count;

    if (last.mode) {
      var b = $("sim-mode").querySelector('[data-mode="' + last.mode + '"]');
      if (b) b.click();                    // click, so the panel follows it
    }
    // Click it only if it is not already where it should be.
    var firstOn = $("sim-first").getAttribute("aria-checked") === "true";
    if (!!last.firstLoss !== firstOn) $("sim-first").click();
  }

  fill();

  /** What the fields currently say, as the shape fake-deriv.js reads. */
  function readCard() {
    return {
      balance: Number($("sim-balance").value),
      currency: "USD",
      mode: mode,
      count: Math.max(0, Math.round(Number($("sim-count").value) || 0)),
      firstLoss: $("sim-first").getAttribute("aria-checked") === "true"
    };
  }

  function writeCfg(cfg) {
    try { sessionStorage.setItem(global.EvieDeriv.sim.CFG_KEY, JSON.stringify(cfg)); } catch (e) {}
  }

  /* ── straight in ─────────────────────────────────────────────────────────
     The card used to stand in front of the page and nothing ran until it was
     answered. That made this the one place on the site with a step real
     trading does not have: pick Analysis, get a form. It now boots on the
     settings already remembered, so choosing Analysis opens Analysis — the
     same as every other day.

     Holding the scripts back still matters and still happens: app.js opens its
     socket the moment it runs, so the balance and the plan are written and
     rebooted here, BEFORE a line of the page's own code executes. Nothing has
     changed about the order; only about who is asked. */
  var boot = readCard();
  /* Zero is allowed through — an account that ran out stays run out, and the
     card or the home header is where it gets topped back up. Only a value that
     is not a number at all falls back to the default. */
  if (!isFinite(boot.balance) || boot.balance < 0) boot.balance = 1000;
  writeCfg(boot);
  global.EvieDeriv.sim.reboot();

  $("setup").hidden = true;
  document.body.classList.add("sim-running");
  loadNext(0, function () { /* the page is now the analysis page */ });

  /* ── the card, on demand ─────────────────────────────────────────────────
     Three clicks on the account badge in the header, the same gesture the rest
     of the site uses for the things it does not advertise. */

  function openCard() { $("setup").hidden = false; refresh(); }
  function closeCard() { $("setup").hidden = true; }

  var badge = $("acct-badge");
  if (badge) {
    badge.style.cursor = "default";
    badge.addEventListener("click", function (e) {
      if (e.detail < 3) return;
      openCard();
    });
  }

  /* Escape, and the space around the card. A panel opened by a gesture needs
     an obvious way back out, or the only exit is the browser's Back button. */
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !$("setup").hidden) closeCard();
  });
  $("setup").addEventListener("click", function (e) {
    if (e.target === this) closeCard();
  });
  if ($("sim-close")) $("sim-close").addEventListener("click", closeCard);

  /* Applying restarts. The settings are read before the first tick, so there
     is no honest way to change the balance or the run of losses underneath a
     session already in flight — and a reload now lands straight back in the
     simulation rather than on the card, so it costs nothing to be strict. */
  $("sim-go").addEventListener("click", function () {
    var cfg = readCard();
    if (isNaN(cfg.balance) || cfg.balance < 1) {
      return say("Give the simulation a balance to start with.");
    }
    writeCfg(cfg);
    remember(cfg);
    global.location.reload();
  });

  refresh();
})(window);
