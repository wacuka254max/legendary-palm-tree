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
 * When it stops:
 *
 *   Take profit reached          → stop, in front.
 *   Stop loss reached            → stop, and it wins over everything below.
 *                                  It is the one number the user set to be
 *                                  protected by, so a martingale ladder does
 *                                  not get to overrule it.
 *   Neither set, and a win       → stop. The ladder has recovered.
 *   Neither set, and a loss      → keep going, staking up, until it recovers.
 *
 * A failed trade does not end the run — the socket reconnects underneath it, so
 * the bot waits and tries again rather than giving up on a blip.
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
  /* Resolved the moment Stop is pressed. The loop races it against whatever it
     is waiting on, so pressing Stop is felt at once rather than whenever the
     current trade happens to finish. */
  var stopSignal = null;
  var fireStop = null;
  var session = { trades: 0, wins: 0, losses: 0, profit: 0 };

  /* ── the panel ──────────────────────────────────────────────────────── */

  function say(msg, kind) {
    var s = el("bot-status");
    s.textContent = msg || "";
    s.className = "bot-status" + (kind ? " bot-status--" + kind : "");
  }

  function paintStats() {
    el("bot-trades").textContent = session.trades;
    el("bot-wr").textContent = session.trades
      ? Math.round((session.wins / session.trades) * 100) + "%" : "—";
    var p = el("bot-pl");
    p.textContent = (session.profit >= 0 ? "+" : "") + session.profit.toFixed(2);
    p.className = "bot-v " + (session.profit > 0 ? "is-up" : session.profit < 0 ? "is-down" : "");
  }

  function setRunning(on) {
    running = on;
    el("bot-run").textContent = on ? "Stop" : "Start";
    el("bot-run").classList.toggle("is-running", on);
    ["bot-market", "bot-pair", "bot-tp", "bot-sl", "bot-tp-tog", "bot-sl-tog"].forEach(function (id) {
      var e = el(id);
      if (e) e.disabled = on;
    });
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
    return {
      tp: el("bot-tp-tog").getAttribute("aria-checked") === "true" ? parseFloat(el("bot-tp").value) : null,
      sl: el("bot-sl-tog").getAttribute("aria-checked") === "true" ? parseFloat(el("bot-sl").value) : null
    };
  }

  /** Why the run should end, or null to carry on. */
  function stopReason(lastWin) {
    var l = limits();

    if (l.sl != null && !isNaN(l.sl) && session.profit <= -Math.abs(l.sl)) {
      return { msg: "Stop loss hit at " + session.profit.toFixed(2) + ".", kind: "warning" };
    }
    if (l.tp != null && !isNaN(l.tp) && session.profit >= Math.abs(l.tp)) {
      return { msg: "Take profit hit at +" + session.profit.toFixed(2) + ".", kind: "success" };
    }

    var noLimits = (l.tp == null || isNaN(l.tp)) && (l.sl == null || isNaN(l.sl));
    if (noLimits && lastWin) {
      return { msg: "Recovered. Stopped on the win.", kind: "success" };
    }
    return null;
  }

  /* ── the loop ───────────────────────────────────────────────────────── */

  function sleep(ms) {
    // Interruptible: a wait between trades must not outlive a Stop.
    return Promise.race([
      new Promise(function (r) { setTimeout(r, ms); }),
      stopSignal
    ]);
  }

  function armStop() {
    stopSignal = new Promise(function (r) { fireStop = r; });
  }

  async function loop() {
    var pair = PAIRS.filter(function (p) { return p.id === el("bot-pair").value; })[0];
    var sym = el("bot-market").value;

    host.activate(sym);   // its market must be on the page to be analysed

    while (running && !stopping) {
      if (!host.isLive()) { say("Waiting for Deriv…", "warning"); await sleep(1200); continue; }
      if (host.busy()) { await sleep(300); continue; }

      // The check that has to happen every time, not once at the start.
      var side = pickSide(pair, sym);
      if (!side) { say("Waiting for enough ticks…", "warning"); await sleep(1200); continue; }

      var stake = host.nextStake();
      var label = host.types[side.type].label;
      say("Trading " + label + " at " + side.pct.toFixed(1) + "% · " + stake.toFixed(2), "info");

      var r;
      try {
        /* Race the trade against Stop. If the user stops mid-trade the loop
           leaves now; the trade itself still settles and still lands in the
           transactions panel, it simply is not waited on. */
        r = await Promise.race([
          host.place(side.type, sym, stake),
          stopSignal.then(function () { return null; })
        ]);
      } catch (e) {
        // A refusal is a blip, not an ending — the socket reconnects under us.
        say((e && e.message) || "Trade failed — retrying.", "warning");
        await sleep(2500);
        continue;
      }

      if (!r) break;          // stopped while the trade was in flight
      if (stopping) break;

      session.trades++;
      session.profit = Math.round((session.profit + r.profit) * 100) / 100;
      if (r.win) session.wins++; else session.losses++;
      paintStats();

      var stop = stopReason(r.win);
      if (stop) { say(stop.msg, stop.kind); break; }

      await sleep(900);   // a breath; Deriv rate-limits a tight loop
    }

    setRunning(false);
    stopping = false;
    if (!el("bot-status").textContent) say("Stopped.", "info");
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
      handle.setPointerCapture(e.pointerId);
      card.classList.add("is-dragging");
    });

    handle.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      e.preventDefault();
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
      // Centred to begin with; it is the thing being introduced, and it can be
      // dragged out of the way the moment it is in the way.
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
        if (fireStop) fireStop();      // felt immediately, not after the trade
        say("Stopped.", "warning");
        setRunning(false);
        return;
      }
      session = { trades: 0, wins: 0, losses: 0, profit: 0 };
      stopping = false;
      armStop();
      paintStats();
      setRunning(true);
      say("Starting…", "info");
      loop();
    });

    el("bot-close").addEventListener("click", function () {
      stopping = true;
      if (fireStop) fireStop();
      card.hidden = true;
      var open = el("bot-open");
      if (open) open.hidden = false;
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
    paintStats();
  }

  global.EvieBot = { attach: attach, PAIRS: PAIRS };
})(window);
