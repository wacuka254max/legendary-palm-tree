/**
 * EVIE — the floating bot.
 *
 * Does by itself exactly what the cards let a person do by hand, and nothing
 * more: it reads the same percentages, and places trades through the same
 * function the buttons call.
 *
 * Choosing a PAIR rather than a side is the point. Told "Even/Odd", it looks at
 * the market immediately before every trade and takes whichever of the two is
 * ahead — so a run that starts on Even follows the market onto Odd if that is
 * where the edge went. The check happens before each trade, never once at the
 * start.
 *
 * Two rules keep it steady, and both were learned from it not being:
 *
 *   Its figures come from the TRANSACTIONS LEDGER, not from a tally it keeps
 *   as it goes. A separate count can miss a result — and then it reports a
 *   loss the ledger already shows recovered.
 *
 *   Every start takes the next GENERATION number, and only the loop holding
 *   the current one may touch the panel. A run still unwinding can therefore
 *   never switch off a run that has just begun, which is how the card came to
 *   read "Stop" with nothing running behind it.
 *
 * When it stops:
 *
 *   Take profit reached   → stop, in front.
 *   Stop loss reached     → stop, and this one overrides everything below. It
 *                           is the number set to be protected by, so a
 *                           martingale ladder does not get to overrule it.
 *   Neither set, in front → stop; the ladder has recovered.
 *   Neither set, behind   → keep going, staking up, until it is in front.
 */

(function (global) {
  "use strict";

  var host = null;
  var el = function (id) { return document.getElementById(id); };

  /* The pairs it can be pointed at. Each is two contract types; the bot picks
     whichever is ahead at the moment it trades. */
  var PAIRS = [
    { id: "even_odd", label: "Even / Odd", a: "even", b: "odd" },
    { id: "rise_fall", label: "Rise / Fall", a: "rise", b: "fall" },
    { id: "over_under", label: "Over / Under", a: "over", b: "under" },
    { id: "match_differ", label: "Matches / Differs", a: "match", b: "differ" }
  ];

  var running = false;
  var stopping = false;
  var generation = 0;      // only the current one may act
  var runId = 0;           // the ledger's name for this run
  var totals = { trades: 0, won: 0, profit: 0 };

  /* Resolved the moment Stop is pressed, so the loop can race it against
     whatever it is waiting on and feel the press at once. */
  var stopSignal = null;
  var fireStop = null;

  /* ── the panel ──────────────────────────────────────────────────────── */

  function say(msg, kind) {
    var s = el("bot-status");
    if (!s) return;
    s.textContent = msg || "";
    s.className = "bot-status" + (kind ? " bot-status--" + kind : "");
  }

  /** Read this run's figures back off the ledger and show them. */
  function syncStats() {
    totals = runId && host ? host.runTotals(runId) : { trades: 0, won: 0, profit: 0 };

    el("bot-trades").textContent = totals.trades || 0;
    el("bot-wr").textContent = totals.trades
      ? Math.round((totals.won / totals.trades) * 100) + "%" : "—";

    var p = el("bot-pl");
    var v = totals.profit || 0;
    p.textContent = (v >= 0 ? "+" : "") + v.toFixed(2);
    p.className = "bot-v " + (v > 0 ? "is-up" : v < 0 ? "is-down" : "");
  }

  function setRunning(on) {
    running = on;
    el("bot-run").textContent = on ? "Stop" : "Start";
    el("bot-run").classList.toggle("is-running", on);
    ["bot-market", "bot-pair", "bot-tp", "bot-sl", "bot-tp-tog", "bot-sl-tog"].forEach(function (id) {
      var e = el(id);
      if (e) e.disabled = on;
    });
    paintOpener();
  }

  /* The button that stands in for a closed card has to say whether the bot is
     still working — closing it hides the card, it does not stop the run. */
  function paintOpener() {
    var open = el("bot-open");
    if (!open) return;
    open.classList.toggle("is-running", running);
    var label = el("bot-open-label");
    if (label) label.textContent = running ? "Bot running" : "Open bot";
  }

  /* ── deciding ───────────────────────────────────────────────────────── */

  /** The side of the chosen pair that is ahead right now. */
  function pickSide(pair, sym) {
    var s = host.statsFor(sym);
    if (!s || !s.total) return null;

    var av = s[pair.a], bv = s[pair.b];

    // Over is impossible above reference 8, Under below 1 — Deriv rejects the
    // barrier, so those are not choices even when they lead.
    var aOK = !(pair.a === "over" && s.reference > 8);
    var bOK = !(pair.b === "under" && s.reference < 1);

    if (!aOK && !bOK) return null;
    if (!aOK) return { type: pair.b, pct: bv };
    if (!bOK) return { type: pair.a, pct: av };
    return av >= bv ? { type: pair.a, pct: av } : { type: pair.b, pct: bv };
  }

  function limits() {
    var tpOn = el("bot-tp-tog").getAttribute("aria-checked") === "true";
    var slOn = el("bot-sl-tog").getAttribute("aria-checked") === "true";
    return {
      tp: tpOn ? parseFloat(el("bot-tp").value) : null,
      sl: slOn ? parseFloat(el("bot-sl").value) : null
    };
  }

  /** Why the run should end, or null to carry on. Judged on the ledger. */
  function stopReason(t) {
    var l = limits();
    var profit = t.profit || 0;

    if (l.sl != null && !isNaN(l.sl) && profit <= -Math.abs(l.sl)) {
      return { msg: "Stop loss hit at " + profit.toFixed(2) + ".", kind: "warning" };
    }
    if (l.tp != null && !isNaN(l.tp) && profit >= Math.abs(l.tp)) {
      return { msg: "Take profit hit at +" + profit.toFixed(2) + ".", kind: "success" };
    }

    var noLimits = (l.tp == null || isNaN(l.tp)) && (l.sl == null || isNaN(l.sl));
    /* No limits: stop once the RUN is in front, which is what recovery means.
       Stopping merely because the last trade won called a ladder recovered
       while it was still behind. */
    if (noLimits && t.trades > 0 && profit > 0) {
      return { msg: "Recovered. Stopped in front at +" + profit.toFixed(2) + ".", kind: "success" };
    }
    return null;
  }

  /* ── the loop ───────────────────────────────────────────────────────── */

  function armStop() {
    stopSignal = new Promise(function (r) { fireStop = r; });
  }

  function sleep(ms) {
    // Interruptible: a wait between trades must not outlive a Stop.
    return Promise.race([
      new Promise(function (r) { setTimeout(r, ms); }),
      stopSignal
    ]);
  }

  async function loop(mine) {
    var pair = PAIRS.filter(function (p) { return p.id === el("bot-pair").value; })[0];
    var sym = el("bot-market").value;
    var ended = null;

    var alive = function () { return mine === generation && running && !stopping; };

    /* Refusals in a row end the run. Deriv rejects a stake bigger than the
       balance, and a martingale ladder eventually gets there — retrying that
       for ever is not persistence, it is a loop that never ends. */
    var fails = 0;
    var MAX_FAILS = 5;

    try {
      host.activate(sym);

      while (alive()) {
        if (!host.isLive()) { say("Waiting for Deriv…", "warning"); await sleep(1200); continue; }
        if (host.busy()) { await sleep(300); continue; }

        var side = pickSide(pair, sym);
        if (!side) { say("Waiting for enough ticks…", "warning"); await sleep(1200); continue; }

        var stake = host.nextStake();
        say("Trading " + host.types[side.type].label + " at " +
            side.pct.toFixed(1) + "% · " + stake.toFixed(2), "info");

        var r;
        try {
          /* Raced against Stop so a press is felt at once. The trade itself is
             not cancelled — it settles and is recorded either way, it simply
             stops being waited on. */
          r = await Promise.race([
            host.place(side.type, sym, stake, runId),
            stopSignal.then(function () { return null; })
          ]);
        } catch (e) {
          if (!alive()) break;
          fails++;
          if (fails >= MAX_FAILS) {
            ended = {
              msg: "Deriv refused " + fails + " trades in a row — stopped. " +
                   "The stake may be larger than the balance.",
              kind: "error"
            };
            break;
          }
          say((e && e.message) || "Trade refused — retrying.", "warning");
          await sleep(2500);
          continue;
        }

        if (!r) break;          // stopped while the trade was in flight
        if (!alive()) break;

        fails = 0;              // a trade got through; the count starts over
        syncStats();

        var stop = stopReason(totals);
        if (stop) { ended = stop; break; }

        await sleep(900);       // a breath; Deriv rate-limits a tight loop
      }
    } catch (e) {
      // Nothing may leave the card reading "Stop" with no loop behind it.
      ended = { msg: (e && e.message) || "The bot stopped unexpectedly.", kind: "error" };
    } finally {
      if (mine === generation) {
        syncStats();
        setRunning(false);
        stopping = false;
        if (ended) say(ended.msg, ended.kind);
        else if (!el("bot-status").textContent) say("Stopped.", "info");
      }
    }
  }

  /* ── dragging ───────────────────────────────────────────────────────── */

  var POS_KEY = "evie_bot_pos";

  function place(card, x, y) {
    // Never off screen, however the window is resized afterwards.
    var w = card.offsetWidth, h = card.offsetHeight;
    x = Math.max(8, Math.min(x, global.innerWidth - w - 8));
    y = Math.max(8, Math.min(y, global.innerHeight - h - 8));
    card.style.left = x + "px";
    card.style.top = y + "px";
    card.style.right = "auto";
    card.style.bottom = "auto";
    try { localStorage.setItem(POS_KEY, JSON.stringify({ x: x, y: y })); } catch (e) {}
  }

  function draggable(card, handle) {
    var dx = 0, dy = 0, dragging = false;

    handle.addEventListener("pointerdown", function (e) {
      if (e.target.closest("button:not([data-drag])")) return;
      dragging = true;
      var r = card.getBoundingClientRect();
      dx = e.clientX - r.left;
      dy = e.clientY - r.top;
      try { handle.setPointerCapture(e.pointerId); } catch (x) {}
      card.classList.add("is-dragging");
    });

    handle.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      e.preventDefault();
      // Moving the card only moves the card. Nothing here touches the run.
      place(card, e.clientX - dx, e.clientY - dy);
    });

    var end = function (e) {
      if (!dragging) return;
      dragging = false;
      card.classList.remove("is-dragging");
      try { handle.releasePointerCapture(e.pointerId); } catch (x) {}
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);

    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(POS_KEY) || "null"); } catch (e) {}
    if (saved) {
      place(card, saved.x, saved.y);
    } else {
      // Centred to begin with; it can be dragged aside the moment it is in the way.
      place(card,
        Math.round((global.innerWidth - card.offsetWidth) / 2),
        Math.round((global.innerHeight - card.offsetHeight) / 2));
    }

    global.addEventListener("resize", function () {
      var r = card.getBoundingClientRect();
      place(card, r.left, r.top);
    });
  }

  /* ── wiring ─────────────────────────────────────────────────────────── */

  function attach(h) {
    host = h;
    var card = el("bot");
    if (!card) return;

    el("bot-market").innerHTML = h.markets.map(function (m) {
      return '<option value="' + m.sym + '">' + m.name + "</option>";
    }).join("");

    el("bot-pair").innerHTML = PAIRS.map(function (p) {
      return '<option value="' + p.id + '">' + p.label + "</option>";
    }).join("");

    // Take profit and stop loss are hidden until asked for.
    [["bot-tp-tog", "bot-tp-row"], ["bot-sl-tog", "bot-sl-row"]].forEach(function (pair) {
      var tog = el(pair[0]), row = el(pair[1]);
      tog.addEventListener("click", function () {
        var on = tog.getAttribute("aria-checked") !== "true";
        tog.setAttribute("aria-checked", String(on));
        row.hidden = !on;
      });
    });

    el("bot-run").addEventListener("click", function () {
      if (running) {
        stopping = true;
        generation++;                // whatever is running is no longer current
        if (fireStop) fireStop();    // felt immediately, not after the trade
        setRunning(false);
        say("Stopped.", "warning");
        return;
      }
      /* Start is a clean slate: a new run id, an emptied ledger, the
         martingale back at the base stake, and the card's own figures
         cleared. Nothing from the last run is carried into this one. */
      stopping = false;
      armStop();
      runId = host.startRun();
      syncStats();
      setRunning(true);
      say("Starting…", "info");
      loop(++generation);
    });

    /* Close HIDES. It does not stop: a run in progress carries on, which is
       the point on a small screen where the card is covering the analysis or
       the transactions the user wants to watch it against. */
    el("bot-close").addEventListener("click", function () {
      card.hidden = true;
      var open = el("bot-open");
      if (open) { open.hidden = false; paintOpener(); }
    });

    var open = el("bot-open");
    if (open) {
      open.addEventListener("click", function () {
        card.hidden = false;
        open.hidden = true;
      });
    }

    armStop();
    draggable(card, el("bot-head"));
    syncStats();

    /* On a narrow screen the card would sit on top of the analysis the moment
       the page opened. It starts closed there, and the button brings it up
       when there is actually something to trade. */
    if (global.innerWidth < 900) {
      card.hidden = true;
      var opener = el("bot-open");
      if (opener) opener.hidden = false;
    }

    paintOpener();
  }

  global.EvieBot = { attach: attach, PAIRS: PAIRS };
})(window);
