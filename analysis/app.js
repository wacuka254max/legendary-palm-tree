/**
 * EVIE — Analysis, laid out the way dbotzone's Advanced tool lays it out.
 *
 * One card per active symbol, each answering the same four questions at a
 * glance and offering the trade on both sides of each:
 *
 *   Rise / Fall     from the price
 *   Even / Odd      from the digit
 *   Over / Under    from the digit against the reference digit
 *   Matches/Differs the reference digit itself
 *
 * The side that is currently ahead is marked, because that is what the buttons
 * are for: see that Even is running at 54% and take Even.
 *
 * Every symbol shares ONE socket. Ticks arrive per symbol and only that card
 * is repainted, and no more than a few times a second — five markets streaming
 * into a full re-render is exactly how this kind of page starts to stutter.
 */

(function () {
  "use strict";

  var D = window.EvieDeriv;
  if (!D || !D.requireConnection()) return;

  var C = window.EvieContracts;
  var A = window.EvieAnalyser;
  var $ = function (id) { return document.getElementById(id); };

  var MARKETS = [
    { sym: "R_10", name: "Volatility 10" },
    { sym: "R_25", name: "Volatility 25" },
    { sym: "R_50", name: "Volatility 50" },
    { sym: "R_75", name: "Volatility 75" },
    { sym: "R_100", name: "Volatility 100" }
  ];

  /* What is on before anyone has chosen anything.

     A wide screen fits three cards side by side, so it opens on three rather
     than on one card and a lot of empty grid. They are picked at random so the
     page does not always suggest the same markets — every one of these is a
     fair choice, and a fixed trio quietly reads as a recommendation.

     A narrow screen shows one card at a time, so three would only be two
     screens of scrolling before the first decision.

     Either way this is a starting point, not a setting: the first tap on a
     symbol chip replaces it, and the choice is remembered from then on. */
  var WIDE_MIN = 1000;
  var WIDE_PICKS = 3;

  function defaultActive() {
    var pool = MARKETS.map(function (m) { return m.sym; });
    var wide = false;
    try { wide = window.innerWidth >= WIDE_MIN; } catch (e) {}
    var take = wide ? Math.min(WIDE_PICKS, pool.length) : 1;

    var out = {};
    for (var i = 0; i < take; i++) {
      out[pool.splice(Math.floor(Math.random() * pool.length), 1)[0]] = true;
    }
    return out;
  }

  /* The four pairs, in the order the card shows them. `key` reads the stat off
     a stats() result; `label` is what the percentage bar says. */
  var PAIRS = [
    { a: "rise", b: "fall", tone: "rise", labels: ["Rise", "Fall"] },
    { a: "even", b: "odd", tone: "even", labels: ["Even", "Odd"] },
    { a: "over", b: "under", tone: "over", labels: ["Over", "Under"], ref: true },
    { a: "match", b: "differ", tone: "match", labels: ["Matches", "Differs"], ref: true }
  ];

  var txn = new window.EvieTxn({ root: document.getElementById("txn"), nameOf: nameOf });

  var session = new window.EvieSession();
  var accounts = [];            // what the picker is offering
  var allAccounts = [];         // everything this login has, demo included

  /* Prices are streaming, but there is no real account to trade on. The cards
     fill in as usual; only placing a trade is refused. */
  var analysisOnly = false;
  var analysers = {};          // sym -> Analyser
  var active = defaultActive();  // which symbols have a card
  var subs = {};               // sym -> subscription id
  var trading = false;
  var settings = { stake: 1, ref: 5, count: 130, martingale: true, multiplier: 3.1 };

  /* The stake the NEXT trade will use. It only differs from the base stake
     while martingale is recovering a loss, and every win puts it back. */
  var nextStake = 1;

  /* The most recent quote per symbol, formatted the way Deriv displays it.
     Deriv does not always put entry/exit on the contract, and a blank spot in
     the transactions list is useless — the tick stream we are already reading
     answers the same question. */
  var lastSpot = {};
  var entryHint = null;

  /* Last window per symbol, kept so a reopened page is POPULATED on its first
     paint rather than showing an empty card for the second it takes Deriv to
     answer. The live history replaces it as soon as it lands; the cache only
     ever fills the gap. Anything older than this is not worth showing, so it
     is ignored and the skeleton stands instead. */
  var CACHE_KEY = "evie_analysis_cache";
  var CACHE_MAX_AGE = 10 * 60 * 1000;

  function readCache() {
    try {
      var raw = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
      if (!raw || Date.now() - raw.t > CACHE_MAX_AGE) return null;
      return raw;
    } catch (e) { return null; }
  }

  var cacheTimer = null;
  function writeCache() {
    clearTimeout(cacheTimer);
    // Written on a timer: this runs on every tick otherwise, and localStorage
    // is synchronous.
    cacheTimer = setTimeout(function () {
      try {
        var out = { t: Date.now(), active: active, syms: {} };
        Object.keys(analysers).forEach(function (sym) {
          if (!active[sym]) return;
          out.syms[sym] = { prices: analysers[sym].prices.slice(-settings.count) };
        });
        localStorage.setItem(CACHE_KEY, JSON.stringify(out));
      } catch (e) {}
    }, 2000);
  }

  /* Set while a trade is in flight so whoever asked for it — a click or the
     bot — is handed the result rather than having to watch the panel. */
  var inFlight = false;   // exactly one trade at a time, and one flag saying so

  /* Which bot run a trade belongs to, so the bot can read its own totals off
     the ledger instead of keeping a second copy that can disagree with it. */
  var runSeq = 0;       // the last run number handed out

  /** Deriv's floor. A stake under this is refused, so stop before sending. */
  var MIN_STAKE = 0.35;

  var pending = {};            // sym -> needs repaint
  var painter = null;

  function esc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function money(n, cur) {
    if (n == null || isNaN(Number(n))) return "—";
    return (cur || "USD") + " " + Number(n).toLocaleString(undefined, {
      minimumFractionDigits: 2, maximumFractionDigits: 2
    });
  }

  function status(msg, kind) {
    $("status").textContent = msg || "";
    $("status").className = "status" + (kind ? " status--" + kind : "");
  }

  function activeCount() {
    return MARKETS.filter(function (m) { return active[m.sym]; }).length;
  }

  function nameOf(sym) {
    for (var i = 0; i < MARKETS.length; i++) if (MARKETS[i].sym === sym) return MARKETS[i].name;
    return sym;
  }

  /* ── the page state a trade changes ─────────────────────────────────── */

  var ui = {
    status: status,

    /** While a trade is in flight the cards must not offer another. */
    runState: function (on) {
      trading = on;
      Array.prototype.forEach.call(document.querySelectorAll(".act"), function (b) {
        b.disabled = on;
      });
      $("account").disabled = on;
    }
  };

  /* ── the card ───────────────────────────────────────────────────────── */

  function cardShell(sym) {
    var el = document.createElement("article");
    el.className = "mkt";
    el.id = "card-" + sym;
    el.innerHTML =
      '<h2 class="mkt-h"><span class="mkt-n">' + esc(nameOf(sym)) + " Analysis</span>" +
        '<span class="mkt-c">Current: <b data-cur>—</b></span></h2>' +
      '<ul class="dgts" data-digits></ul>' +
      '<div class="rows" data-rows></div>' +
      '<p class="mkt-hint">Click a type to place that trade</p>' +
      '<ol class="ticks" data-ticks></ol>';
    return el;
  }

  function pairRow(p, s, sym) {
    var av = s[p.a], bv = s[p.b];
    var refTxt = p.ref ? " " + s.reference : "";
    var aLead = av > bv, bLead = bv > av;

    // Over is impossible above 8 and Under below 1 — Deriv rejects the barrier,
    // so the button says so rather than failing at the broker.
    var aOff = p.a === "over" && s.reference > 8;
    var bOff = p.b === "under" && s.reference < 1;

    var bar = function (side, val, lead) {
      return '<span class="pbar pbar--' + side + (lead ? " is-lead" : "") + '">' +
        C.TYPES[side] .label + refTxt + ": " + val.toFixed(1) + "%</span>";
    };

    return '<div class="row">' +
      bar(p.a, av, aLead) +
      '<span class="acts">' +
        '<button class="act act--' + p.a + (aLead ? " is-lead" : "") + '" type="button" ' +
          'data-sym="' + sym + '" data-type="' + p.a + '"' + (aOff ? " disabled" : "") + '>' +
          p.labels[0] + "</button>" +
        '<button class="act act--' + p.b + (bLead ? " is-lead" : "") + '" type="button" ' +
          'data-sym="' + sym + '" data-type="' + p.b + '"' + (bOff ? " disabled" : "") + '>' +
          p.labels[1] + "</button>" +
      "</span>" +
      bar(p.b, bv, bLead) +
    "</div>";
  }

  function paint(sym) {
    var host = $("card-" + sym);
    var an = analysers[sym];
    if (!host || !an) return;

    var s = an.stats(settings.ref);
    host.querySelector("[data-cur]").textContent = s.current == null ? "—" : s.current;

    host.querySelector("[data-digits]").innerHTML = s.digits.map(function (r) {
      var cls = "dgt";
      if (r.digit === s.current) cls += " is-cur";
      if (r.digit === s.high) cls += " is-high";
      else if (r.digit === s.low) cls += " is-low";
      return '<li class="' + cls + '"><b>' + r.digit + "</b><span>" + r.pct.toFixed(1) + "%</span></li>";
    }).join("");

    host.querySelector("[data-rows]").innerHTML = PAIRS.map(function (p) {
      return pairRow(p, s, sym);
    }).join("");

    host.querySelector("[data-ticks]").innerHTML = an.recent(10).map(function (d) {
      return '<li class="tk tk--' + (d % 2 === 0 ? "even" : "odd") + '">' + d + "</li>";
    }).join("");

    if (trading) {
      Array.prototype.forEach.call(host.querySelectorAll(".act"), function (b) { b.disabled = true; });
    }
  }

  /* Repaint at most every 250ms per symbol. Ticks arrive faster than anyone
     reads, and repainting five cards on every one of them is what makes a
     page like this stutter. */
  function markDirty(sym) {
    pending[sym] = true;
    if (painter) return;
    painter = setTimeout(function () {
      painter = null;
      Object.keys(pending).forEach(function (s) { paint(s); });
      pending = {};
    }, 250);
  }

  function renderCards() {
    var host = $("cards");
    var want = MARKETS.filter(function (m) { return active[m.sym]; }).map(function (m) { return m.sym; });

    // Drop cards for symbols switched off.
    Array.prototype.forEach.call(host.children, function (c) {
      var sym = c.id.replace("card-", "");
      if (want.indexOf(sym) === -1) c.remove();
    });

    want.forEach(function (sym) {
      if (!$("card-" + sym)) host.appendChild(cardShell(sym));
      paint(sym);
    });

    host.classList.toggle("is-empty", want.length === 0);
    if (!want.length) {
      host.innerHTML = '<p class="cards-none">Select a symbol above to see its analysis.</p>';
    }
  }

  /* ── symbols ────────────────────────────────────────────────────────── */

  function renderSyms() {
    $("syms").innerHTML = MARKETS.map(function (m) {
      return '<button class="sym' + (active[m.sym] ? " is-on" : "") + '" type="button" ' +
        'data-sym="' + m.sym + '" title="' + esc(m.name) + " (" + m.sym + ')">' +
        esc(m.name) + "</button>";
    }).join("");
  }

  $("syms").addEventListener("click", function (e) {
    var b = e.target.closest(".sym");
    if (!b) return;
    var sym = b.getAttribute("data-sym");
    active[sym] = !active[sym];
    b.classList.toggle("is-on", active[sym]);
    if (prefs) prefs.set("active", active);

    if (active[sym]) subscribe(sym);
    else unsubscribe(sym);

    renderCards();
    writeCache();
  });

  /* ── ticks ──────────────────────────────────────────────────────────── */

  function subscribe(sym) {
    if (!session.isOpen()) return;
    if (!analysers[sym]) analysers[sym] = new A.Analyser(sym, settings.count);
    analysers[sym].setCount(settings.count);
    session.send({
      ticks_history: sym,
      end: "latest",
      count: settings.count,
      style: "ticks",
      subscribe: 1
    });
  }

  function unsubscribe(sym) {
    if (subs[sym] && session.isOpen()) session.send({ forget: subs[sym] });
    delete subs[sym];
  }

  function subscribeAll() {
    MARKETS.forEach(function (m) { if (active[m.sym]) subscribe(m.sym); });
  }

  function unsubscribeAll() {
    Object.keys(subs).forEach(unsubscribe);
  }

  session.onOpen(function () {
    status("Live — " + activeCount() + " market(s).", "success");
  });

  session.onMessage(function (d) {
    if (d.error) {
      if (!trading) status(d.error.message || "Deriv refused that request.", "error");
      return;
    }

    if (d.msg_type === "history" && d.history) {
      var sym = d.echo_req && d.echo_req.ticks_history;
      if (!sym) return;
      if (!analysers[sym]) analysers[sym] = new A.Analyser(sym, settings.count);
      analysers[sym].setCount(settings.count);
      analysers[sym].seed(d.history.prices || []);

      /* Seed the spot from the history too. Otherwise a trade placed in the
         first seconds — before any live tick has landed — has nothing to fall
         back on and the entry column is blank again. */
      var prices = d.history.prices || [];
      if (prices.length) {
        var dec = A.PIP_DECIMALS[sym] != null ? A.PIP_DECIMALS[sym] : 2;
        lastSpot[sym] = Number(prices[prices.length - 1]).toFixed(dec);
      }

      if (d.subscription && d.subscription.id) subs[sym] = d.subscription.id;
      paint(sym);
      writeCache();
      return;
    }

    if (d.msg_type === "tick" && d.tick && d.tick.symbol) {
      var t = d.tick;
      var dec = t.pip_size != null ? t.pip_size
        : (A.PIP_DECIMALS[t.symbol] != null ? A.PIP_DECIMALS[t.symbol] : 2);
      lastSpot[t.symbol] = Number(t.quote).toFixed(dec);
      if (!active[t.symbol]) return;
      if (!analysers[t.symbol]) analysers[t.symbol] = new A.Analyser(t.symbol, settings.count);
      analysers[t.symbol].push(t.quote, t.pip_size);
      markDirty(t.symbol);
      writeCache();
      return;
    }

    if (d.msg_type === "balance" && d.balance) {
      $("balance").textContent = money(d.balance.balance, d.balance.currency);
    }
  });

  /* ── trading ────────────────────────────────────────────────────────── */

  $("cards").addEventListener("click", function (e) {
    var b = e.target.closest(".act");
    if (!b || b.disabled || trading) return;

    /* Not "pick an account" — an account IS picked, the socket is simply
       still coming up or has just blinked. The session queues what it cannot
       send yet, so the trade goes out the moment it can. */
    if (!session.isLive()) return status("Still connecting to Deriv…", "warning");

    if (analysisOnly) {
      return status(
        "This login has no real options account. The analysis is live; open a real account with Deriv to trade it.",
        "warning"
      );
    }

    var type = b.getAttribute("data-type");
    var sym = b.getAttribute("data-sym");
    var stake = settings.martingale ? nextStake : settings.stake;

    if (isNaN(stake) || stake < MIN_STAKE) {
      return status("Deriv's minimum stake is " + MIN_STAKE.toFixed(2) + ".", "error");
    }

    /* One trade per click. The ladder lives here rather than inside the
       trader, because each click is its own run and the recovery has to
       survive between them. */
    /* A hand-placed trade should show its own result. On a phone the
       transactions are parked at the bottom, so the sheet comes up for long
       enough to read the row and then puts itself away. */
    placeTrade(type, sym, stake)
      .then(function () { txn.peek(4200); })
      .catch(function (e) {
        /* This used to swallow the error on the assumption the panel had
           already spoken. It had not: the general handler stays quiet while a
           trade is in flight, precisely so it does not talk over this one. A
           refusal — a balance that will not cover the stake, a barrier Deriv
           would not take — therefore vanished, and the click looked ignored.
           A wait for the previous trade is the one case worth no words. */
        if (e && e.busy) return;
        status((e && e.message) || "That trade did not go through.", "error");
      });
  });

  /**
   * Place one trade and resolve with its result. The single path both the
   * buttons and the bot go through, so they can never disagree about stake,
   * barrier or which account is being used.
   */
  /**
   * ONE trade, start to finish, on the shared socket.
   *
   * Deliberately self-contained — this replaced going through the trader's run
   * machine, which carried its own busy flag, its own queue and its own
   * timeouts. Two flags that could disagree, and a run() that returned in
   * silence when it was already going, is what left the bot waiting on a
   * result nothing would ever send. There is nothing here to disagree with:
   * one contract, its own listener, its own timer, removed when it ends.
   *
   * The same four steps Deriv requires, and the same ones Automatic AI takes:
   *   proposal → buy → subscribe to the contract → settled.
   */
  function placeTrade(type, sym, stake, forRun) {
    if (!session.isLive()) return Promise.reject(new Error("Not connected."));

    /* The buttons check this too, with a friendlier sentence. This is the
       backstop: the bot places its trades through here as well, and a socket
       open for prices must not become a socket that trades. */
    if (analysisOnly) {
      return Promise.reject(new Error("No real options account to trade on."));
    }

    if (inFlight) {
      var busy = new Error("A trade is already running.");
      busy.busy = true;        // a wait, not a refusal
      return Promise.reject(busy);
    }

    inFlight = true;
    ui.runState(true);

    var spec = {
      type: type,
      barrier: C.TYPES[type].barrier ? C.clampBarrier(type, settings.ref) : null,
      stake: stake,
      currency: currencyOf(),
      market: sym
    };

    var entry = lastSpot[sym] || null;
    var decimals = A.PIP_DECIMALS[sym] != null ? A.PIP_DECIMALS[sym] : 2;

    return new Promise(function (resolve, reject) {
      var stage = "proposal";
      var contractId = null;
      var subId = null;
      var done = false;
      var seenEntry = entry;

      function finish(fn, arg) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        session.off(onMsg);
        if (subId) session.send({ forget: subId });
        inFlight = false;
        ui.runState(false);
        fn(arg);
      }

      /* A one-tick contract settles in seconds. Past this it is not coming,
         and the page must be released either way so the next attempt can run. */
      var timer = setTimeout(function () {
        finish(reject, new Error("Deriv did not settle that trade."));
      }, 25000);

      function spot(c, strs, nums) {
        var i, v;
        for (i = 0; i < strs.length; i++) {
          v = c[strs[i]];
          if (typeof v === "string" && v !== "") return v;
        }
        for (i = 0; i < nums.length; i++) {
          v = c[nums[i]];
          if (typeof v === "number" && isFinite(v)) return v.toFixed(decimals);
        }
        return null;
      }

      function onMsg(d) {
        if (done) return;

        if (d.error) {
          // Only our own request's failure ends this trade.
          var er = d.echo_req || {};
          if (er.proposal || er.buy || er.proposal_open_contract) {
            return finish(reject, new Error(d.error.message || "Deriv refused the trade."));
          }
          return;
        }

        if (stage === "proposal" && d.msg_type === "proposal" && d.proposal) {
          stage = "buy";
          session.send({ buy: d.proposal.id, price: d.proposal.ask_price });
          return;
        }

        if (stage === "buy" && d.msg_type === "buy" && d.buy) {
          stage = "settle";
          contractId = d.buy.contract_id;
          session.send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 });
          return;
        }

        if (d.msg_type === "proposal_open_contract" && d.proposal_open_contract) {
          var c = d.proposal_open_contract;
          if (stage !== "settle") return;
          if (contractId && c.contract_id !== contractId) return;
          if (d.subscription && d.subscription.id) subId = d.subscription.id;

          // The entry spot is reported when the contract OPENS, not at the end.
          var e = spot(c, ["entry_tick_display_value", "entry_spot_display_value"],
                          ["entry_tick", "entry_spot"]);
          if (e != null) seenEntry = e;

          if (!c.is_sold) return;

          var profit = parseFloat(c.profit) || 0;
          var paid = parseFloat(c.buy_price) || stake;
          var exit = spot(c, ["exit_tick_display_value", "current_spot_display_value"],
                             ["exit_tick", "current_spot"]) || lastSpot[sym] || null;

          finish(resolve, {
            win: profit > 0,
            profit: profit,
            stake: paid,
            /* What came BACK: a loss returns nothing, so it is not stake plus a
               negative profit. */
            payout: profit > 0 ? paid + profit : 0,
            entry: seenEntry,
            exit: exit,
            digit: typeof exit === "string"
              ? parseInt(exit.charAt(exit.length - 1), 10) : null,
            type: type,
            barrier: spec.barrier,
            market: sym,
            run: forRun || 0
          });
        }
      }

      session.on(onMsg);
      session.send(C.proposal(spec));
    }).then(function (r) {
      record(r);
      return r;
    });
  }

  /** Put a settled trade in the ledger and move the martingale on. */
  function record(r) {
    if (settings.martingale && !r.win) nextStake = nextStake * settings.multiplier;
    else nextStake = settings.stake;
    showNextStake();

    var t = C.TYPES[r.type];
    txn.add({
      label: t.label + (t.barrier ? " " + r.barrier : ""),
      market: r.market,
      win: r.win,
      stake: r.stake,
      profit: r.profit,
      payout: r.payout,
      entry: r.entry,
      exit: r.exit,
      run: r.run
    });
  }

  function currencyOf() {
    var a = accounts.filter(function (x) { return x.id === $("account").value; })[0];
    return (a && a.currency) || "USD";
  }

  /* ── settings ───────────────────────────────────────────────────────
     No Apply button: what is typed is what is used. Each change is read,
     validated and kept, and the page says so — a settings panel that needs
     a second confirming click is a panel that can silently disagree with
     what is on screen. */

  function showNextStake() {
    var el = $("next-stake");
    if (!settings.martingale) { el.textContent = ""; return; }
    var recovering = nextStake > settings.stake + 1e-9;
    el.textContent = "Next stake " + nextStake.toFixed(2) +
      (recovering ? " — recovering" : "");
    el.className = "next-stake" + (recovering ? " is-recovering" : "");
  }

  var saveTimer = null;

  /** Read the inputs, keep what is valid, and say what happened. */
  function saveSettings(reason) {
    var ref = parseInt($("ref").value, 10);
    var count = parseInt($("count").value, 10);
    var stake = parseFloat($("stake").value);
    var mult = parseFloat($("mart").value);

    if (isNaN(ref) || ref < 0 || ref > 9) return status("Reference digit must be 0 to 9.", "error");
    if (isNaN(count) || count < 10) return status("Analysis count must be at least 10.", "error");
    if (isNaN(stake) || stake < MIN_STAKE) {
      return status("Deriv's minimum stake is " + MIN_STAKE.toFixed(2) + ".", "error");
    }
    if (isNaN(mult) || mult < 1) return status("Martingale must be 1 or more.", "error");

    var countChanged = count !== settings.count;
    var stakeChanged = stake !== settings.stake;

    settings.ref = ref;
    settings.count = count;
    settings.stake = stake;
    settings.multiplier = mult;

    // Changing the base stake abandons any ladder in progress — continuing to
    // multiply an old number after the user has picked a new one is not
    // recovery, it is a stake nobody chose.
    if (stakeChanged || !settings.martingale) nextStake = stake;

    /* A longer window needs history we do not hold, so re-request it; a
       shorter one only needs trimming, which setCount does. */
    if (countChanged) { unsubscribeAll(); subscribeAll(); }
    else Object.keys(analysers).forEach(function (sym) { analysers[sym].setCount(count); paint(sym); });

    renderCards();
    showNextStake();
    status(reason || "Saved.", "success");
  }

  /* Typing is debounced — saving on every keystroke would fire "Saved" at
     someone halfway through typing 130. */
  function queueSave(reason) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { saveSettings(reason); }, 500);
  }

  ["stake", "ref", "count", "mart"].forEach(function (id) {
    $(id).addEventListener("input", function () { queueSave("Settings saved."); });
    $(id).addEventListener("change", function () { clearTimeout(saveTimer); saveSettings("Settings saved."); });
  });

  $("mart-tog").addEventListener("click", function () {
    settings.martingale = $("mart-tog").getAttribute("aria-checked") !== "true";
    $("mart-tog").setAttribute("aria-checked", String(settings.martingale));
    $("mart").disabled = !settings.martingale;
    nextStake = settings.stake;
    showNextStake();
    status(settings.martingale
      ? "Martingale on — a loss multiplies the next stake by " + settings.multiplier + "."
      : "Martingale off — the stake stays at " + settings.stake.toFixed(2) + ".", "success");
  });

  /* ── accounts ───────────────────────────────────────────────────────── */

  function describeAccount() {
    var a = accounts.filter(function (x) { return x.id === $("account").value; })[0];
    if (!a) return;
    $("acct-badge").textContent = a.demo ? "Demo" : "Real";
    $("acct-badge").classList.toggle("badge--demo", a.demo);
    $("balance").textContent = money(a.balance, a.currency);
    $("risk").textContent = a.demo
      ? "Demo account — trades here are practice money."
      : "Real account — every trade placed here uses your own money.";
    $("risk").className = "risk" + (a.demo ? "" : " risk--real");
  }

  var ACCOUNT_KEY = "evie_analysis_account";

  function openSession(id) {
    if (!id) return;

    /* Only a real account is remembered. The next visit opens on whatever is
       remembered before the portfolio has come back, so a remembered demo
       would put the page on a demo socket with the picker hidden and the badge
       still reading Real — the mismatch this page is built to make impossible. */
    var acct = allAccounts.filter(function (a) { return a.id === id; })[0];
    try {
      if (acct && acct.demo) localStorage.removeItem(ACCOUNT_KEY);
      else localStorage.setItem(ACCOUNT_KEY, id);
    } catch (e) {}

    /* Whatever was subscribed before belongs to the old socket. Clearing the
       ids here means the reconnect below re-requests them rather than trying
       to forget subscriptions that no longer exist. */
    subs = {};
    session.resubscribe = function () { subscribeAll(); session.send({ balance: 1, subscribe: 1 }); };

    /* A failed attempt is not a failure: another is already scheduled. Say
       that, rather than either claiming to be live or leaving Deriv's own
       "health probe in progress" on screen as though it were the end of it. */
    session.onTrouble = function () {
      if (!session.isOpen()) status("Deriv is briefly unavailable — reconnecting…", "warning");
    };

    session.open(id).then(function () {
      if (session.isOpen()) status("Live — " + activeCount() + " market(s).", "success");
    }).catch(function (e) {
      if (e && e.expired) {
        D.disconnect();
        try { sessionStorage.setItem("evie_connect_error", e.message); } catch (x) {}
        return window.location.replace("/");
      }
      status((e && e.message) || "Could not open a trading session.", "error");
    });
  }

  $("account").addEventListener("change", function () { describeAccount(); openSession($("account").value); });

  /* ── the account picker ─────────────────────────────────────────────────
     Real accounts only, and the picker is not on the page at all until the
     "a" of "analysis" is clicked three times. Trading the wrong account is the
     one mistake this page cannot take back, and a dropdown sitting open with a
     demo one line below the real one is how that mistake gets made.

     Three clicks, not two: a double click is something a person does to a word
     by accident. */

  var showDemo = false;

  /** Paint the picker. Real accounts only, unless the demo has been revealed. */
  function renderAccounts() {
    var keep = $("account").value;

    accounts = showDemo
      ? allAccounts
      : allAccounts.filter(function (a) { return !a.demo; });

    $("account").innerHTML = accounts.map(function (a) {
      return '<option value="' + esc(a.id) + '">' + esc(a.id) + " · " +
        (a.demo ? "Demo" : "Real") + " · " + esc(money(a.balance, a.currency)) + "</option>";
    }).join("");

    if (keep && accounts.some(function (a) { return a.id === keep; })) $("account").value = keep;
  }

  var key = $("acct-key");
  if (key) {
    key.addEventListener("click", function (e) {
      if (e.detail < 3) return;               // the browser counts them for us
      if (inFlight) return;                   // not mid-trade

      if (!showDemo && !allAccounts.some(function (a) { return a.demo; })) {
        return status("This login has no demo options account.", "warning");
      }

      showDemo = !showDemo;
      key.classList.toggle("acct-reveal--on", showDemo);
      $("acct-fld").hidden = !showDemo;
      renderAccounts();

      if (showDemo && accounts.length && !session.isLive()) {
        /* A login with no real account had nothing to open a session on, so
           revealing the demo is the moment there is finally something to
           trade. Without this the picker fills in and the page stays dead. */
        $("account").value = accounts[0].id;
        describeAccount();
        openSession(accounts[0].id);
      }

      if (!showDemo) {
        /* Coming back out, the real account is the one that must be live.
           Re-rendering the picker already drops the demo option and leaves the
           real one selected — which looked like nothing to do, and was the bug:
           the badge still said Demo and the SOCKET was still the demo one, with
           the picker now hidden. A hidden mismatch is the exact failure this
           arrangement exists to prevent, so the check is against the session,
           not against the dropdown. */
        var real = accounts.filter(function (a) { return !a.demo; })[0];
        if (real) {
          $("account").value = real.id;
          describeAccount();
          if (session.accountId !== real.id) openSession(real.id);
        } else {
          // Nothing real to fall back to: end the demo session rather than
          // leave it running behind a hidden picker.
          session.close();
          $("balance").textContent = "—";
          $("acct-badge").textContent = "Real";
          $("acct-badge").classList.remove("badge--demo");
          $("risk").textContent = "This login has no real options account.";
          $("risk").className = "risk";
        }
      }

      status(showDemo ? "Accounts shown — demo included." : "Back to the real account.", "info");
    });
  }

  /* ── go ─────────────────────────────────────────────────────────────── */

  /* Restore the last view first: which symbols were on, and the window each
     was showing. The page therefore opens on data, not on a placeholder. */
  var cached = readCache();
  var prefs = window.EviePrefs ? window.EviePrefs.scope("analysis") : null;

  /* Which symbols are on belongs to the TAB, not to the browser: the opening
     trio is meant to be a fresh suggestion each time the page is opened, and a
     choice made in one tab should not decide what the next one opens on. The
     price cache stays where it is — it only seeds the charts. */
  var savedActive = prefs && prefs.get("active");
  if (savedActive && Object.keys(savedActive).length) active = savedActive;

  renderSyms();

  if (cached) {
    Object.keys(cached.syms).forEach(function (sym) {
      if (!active[sym]) return;
      var an = new A.Analyser(sym, settings.count);
      an.seed(cached.syms[sym].prices || []);
      analysers[sym] = an;
      var p = cached.syms[sym].prices || [];
      if (p.length) {
        var dec = A.PIP_DECIMALS[sym] != null ? A.PIP_DECIMALS[sym] : 2;
        lastSpot[sym] = Number(p[p.length - 1]).toFixed(dec);
      }
    });
  }

  renderCards();
  showNextStake();

  /* Connect on the account used last, immediately, rather than waiting for the
     portfolio call to come back. Nobody wants to watch "Checking…" before the
     data they came for; the account list fills in behind it. */
  var remembered = null;
  try { remembered = localStorage.getItem(ACCOUNT_KEY); } catch (e) {}
  if (remembered) openSession(remembered);

  D.portfolio().then(function (d) {
    allAccounts = d.accounts
      .filter(function (a) { return a.kind === "Options"; })
      .sort(function (x, y) {
        if (x.demo !== y.demo) return x.demo ? 1 : -1;
        return (y.balance || 0) - (x.balance || 0);
      });

    if (!allAccounts.length) return status("This login has no Deriv options account.", "error");

    /* The page opens on the remembered account before the portfolio comes
       back, which is what keeps it quick — and means a remembered DEMO would
       briefly hold a demo socket on every visit. Now that the accounts are
       known, forget it. */
    var wasDemo = allAccounts.filter(function (a) { return a.id === remembered && a.demo; })[0];
    if (wasDemo) {
      remembered = null;
      try { localStorage.removeItem(ACCOUNT_KEY); } catch (e) {}
    }

    renderAccounts();

    /* No real account is not the same as no account.
       
       The header must not borrow the demo's balance — a figure beside a badge
       reading Real is a claim about how much money is at stake — so the perch
       stays blank. But the ANALYSIS is not about an account at all: it is the
       market, and someone who has connected Deriv should be able to read it
       while they wait for a real account to be approved. So a session still
       opens, on whatever options account this login has, purely for prices.
       
       Trading is what needs the real account, and that is what is held back. */
    if (!accounts.length) {
      $("balance").textContent = "—";
      $("acct-badge").textContent = "Real";
      $("acct-badge").classList.remove("badge--demo");
      $("risk").textContent = "No real options account yet — the analysis is live, trading is not.";
      $("risk").className = "risk";

      analysisOnly = true;
      var feed = allAccounts[0];          // a demo, since there is no real one
      if (feed && session.accountId !== feed.id) openSession(feed.id);

      return status("Analysis only: this login has no real options account to trade on.", "warning");
    }

    // A real account has appeared (or been revealed): trading is on again.
    analysisOnly = false;

    // Keep the remembered account if it is still one of the ones on offer.
    var keep = accounts.filter(function (a) { return a.id === remembered; })[0];
    $("account").value = keep ? keep.id : accounts[0].id;
    describeAccount();
    if (!keep) openSession($("account").value);
  }).catch(function (e) {
    if (e && e.expired) {
      D.disconnect();
      try { sessionStorage.setItem("evie_connect_error", e.message); } catch (x) {}
      return window.location.replace("/");
    }
    status((e && e.message) || "Could not read your Deriv accounts.", "error");
  });

  /* What the floating bot is allowed to touch. Deliberately small: it reads
     the same analysis the cards show and places trades through the same
     function the buttons use, so it can only ever do what a person could. */
  if (window.EvieBot) {
    window.EvieBot.attach({
      markets: MARKETS,
      isLive: function () { return session.isLive(); },
      busy: function () { return inFlight; },
      settings: settings,
      nextStake: function () { return settings.martingale ? nextStake : settings.stake; },
      statsFor: function (sym) {
        return analysers[sym] ? analysers[sym].stats(settings.ref) : null;
      },
      isActive: function (sym) { return !!active[sym]; },
      activate: function (sym) {
        if (active[sym]) return;
        active[sym] = true;
        if (prefs) prefs.set("active", active);
        var b = document.querySelector('.sym[data-sym="' + sym + '"]');
        if (b) b.classList.add("is-on");
        subscribe(sym);
        renderCards();
      },
      place: placeTrade,
      types: C.TYPES,

      /* The bot names its run, and asks for that run's totals. Whatever it
         shows is therefore exactly what the transactions list shows. */
      /* A new run starts from nothing: a fresh id, an empty ledger, and the
         martingale back at the base stake. Carrying any of those over is how a
         run began already showing someone else's trades. */
      /* A new run takes a fresh id and a fresh ladder. It does NOT clear the
         transactions: the id keeps its figures to its own trades, so the log
         can go on being the record of everything traded on this page. */
      startRun: function () {
        runSeq++;
        nextStake = settings.stake;
        showNextStake();
        return runSeq;
      },
      runTotals: function (id) { return txn.totalsFor(id); }
    });
  }

  window.addEventListener("beforeunload", function () { session.close(); });

  /* Last, so every handler above is already listening: a stored value is
     replayed as a real change and the page reacts to it exactly as it would to
     someone typing it. Lives for the tab, not the browser — see prefs.js. */
  if (prefs) {
    prefs.fields(["stake", "ref", "count", "mart"]);
    prefs.switches(["mart-tog"]);
  }
})();
