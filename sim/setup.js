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
        ? " Recovery still runs from time to time, on Over/Under at the martingale stake, so you can watch it work."
        : "";
      return (first
        ? "The first trade loses. Every trade after it wins."
        : "Every trade wins.") + drill;
    }
    if (mode === "consecutive") {
      if (!n) return first ? "The first trade loses. Everything else wins." : "Every trade wins.";
      return (first ? "Starting with the first trade, " : "After the first win, ") +
        n + " trade" + (n === 1 ? "" : "s") + " in a row lose. Everything after that wins.";
    }
    return (first ? "The first trade loses, then " : "") +
      n + " in every 10 trades lose, in a random order.";
  }

  function refresh() {
    var needsCount = mode !== "none";
    $("sim-count-fld").hidden = !needsCount;
    $("sim-count-k").textContent = mode === "random" ? "How many in every 10" : "How many in a row";
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

  $("sim-go").addEventListener("click", function () {
    var balance = Number($("sim-balance").value);
    if (isNaN(balance) || balance < 1) return say("Give the simulation a balance to start with.");

    var cfg = {
      balance: balance,
      currency: "USD",
      mode: mode,
      count: Math.max(0, Math.round(Number($("sim-count").value) || 0)),
      firstLoss: $("sim-first").getAttribute("aria-checked") === "true"
    };

    try { sessionStorage.setItem(global.EvieDeriv.sim.CFG_KEY, JSON.stringify(cfg)); } catch (e) {}
    // fake-deriv.js read the old plan when it loaded; this is the new one.
    global.EvieDeriv.sim.reboot();

    $("setup").hidden = true;
    document.body.classList.add("sim-running");

    loadNext(0, function () { /* the page is now the analysis page */ });
  });

  refresh();
})(window);
