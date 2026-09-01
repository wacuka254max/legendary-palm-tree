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
  var trader = null;
  var accounts = [];
  var analysers = {};          // sym -> Analyser
  var active = { R_10: true }; // which symbols have a card
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
  var resultWaiter = null;
  var resultFailer = null;

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

  /* ── what the trader talks to ───────────────────────────────────────── */

  var ui = {
    status: status,

    /* The panel keeps the running total, so there is nothing to do here —
       but the trader calls it, so it has to exist. */
    net: function () {},

    runState: function (on) {
      trading = on;

      /* A run that ends without having produced a result FAILED — Deriv
         refused it, or the socket went. Whoever is waiting has to be told, or
         they wait for the timeout instead: which is exactly how the bot came
         to place one trade and then sit there, unresponsive to Stop. */
      if (!on && resultWaiter) {
        var fail = resultFailer;
        resultWaiter = null; resultFailer = null;
        if (fail) fail(new Error("Deriv did not accept that trade."));
      }
      Array.prototype.forEach.call(document.querySelectorAll(".act"), function (b) {
        b.disabled = on;
      });
      $("account").disabled = on;
    },

    result: function (r) {
      /* The ladder. A loss multiplies the next stake so the win after it
         recovers what came before; a win puts it back to the base. Off, the
         stake never moves. */
      if (settings.martingale && !r.win) nextStake = nextStake * settings.multiplier;
      else nextStake = settings.stake;
      showNextStake();

      var t = C.TYPES[r.type];

      /* Prefer what Deriv reported; fall back to the ticks we were already
         streaming. A one-tick contract enters on the quote that was live when
         it was bought and exits on the next one, which is exactly what these
         two hold. */
      var entry = r.entry || entryHint;
      var exit = r.exit || lastSpot[r.market] || null;

      txn.add({
        label: t.label + (t.barrier ? " " + r.barrier : ""),
        market: r.market,
        win: r.win,
        stake: r.stake,
        profit: r.profit,
        payout: r.payout,
        entry: entry,
        exit: exit
      });

      if (resultWaiter) {
        var w = resultWaiter;
        resultWaiter = null; resultFailer = null;
        w(r);
      }
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

    var type = b.getAttribute("data-type");
    var sym = b.getAttribute("data-sym");
    var stake = settings.martingale ? nextStake : settings.stake;

    if (isNaN(stake) || stake < window.EvieTrader.MIN_STAKE) {
      return status("Deriv's minimum stake is " + window.EvieTrader.MIN_STAKE.toFixed(2) + ".", "error");
    }

    /* One trade per click. The ladder lives here rather than inside the
       trader, because each click is its own run and the recovery has to
       survive between them. */
    placeTrade(type, sym, stake).catch(function () { /* the panel already said */ });
  });

  /**
   * Place one trade and resolve with its result. The single path both the
   * buttons and the bot go through, so they can never disagree about stake,
   * barrier or which account is being used.
   */
  function placeTrade(type, sym, stake) {
    if (!session.isLive()) return Promise.reject(new Error("Not connected."));
    if (trading) return Promise.reject(new Error("A trade is already running."));

    entryHint = lastSpot[sym] || null;

    var settled = new Promise(function (resolve, reject) {
      resultWaiter = resolve;
      resultFailer = reject;
    });

    trader.run({
      type: type,
      barrier: C.TYPES[type].barrier ? C.clampBarrier(type, settings.ref) : null,
      stake: stake,
      count: 1,
      martingale: false,
      multiplier: 1,
      currency: currencyOf(),
      market: sym
    });

    /* A one-tick contract settles in seconds. If nothing has come back in
       forty-five, something is wrong and saying so beats waiting. */
    return Promise.race([
      settled,
      new Promise(function (_, rej) {
        setTimeout(function () {
          if (resultWaiter) {
            resultWaiter = null; resultFailer = null;
            rej(new Error("The trade did not settle."));
          }
        }, 45000);
      })
    ]);
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
    if (isNaN(stake) || stake < window.EvieTrader.MIN_STAKE) {
      return status("Deriv's minimum stake is " + window.EvieTrader.MIN_STAKE.toFixed(2) + ".", "error");
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
    try { localStorage.setItem(ACCOUNT_KEY, id); } catch (e) {}

    /* Whatever was subscribed before belongs to the old socket. Clearing the
       ids here means the reconnect below re-requests them rather than trying
       to forget subscriptions that no longer exist. */
    subs = {};
    session.resubscribe = function () { subscribeAll(); session.send({ balance: 1, subscribe: 1 }); };

    session.open(id).then(function () {
      if (!trader) trader = new window.EvieTrader(session, ui);
      status("Live — " + activeCount() + " market(s).", "success");
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

  /* ── go ─────────────────────────────────────────────────────────────── */

  /* Restore the last view first: which symbols were on, and the window each
     was showing. The page therefore opens on data, not on a placeholder. */
  var cached = readCache();
  if (cached && cached.active && Object.keys(cached.active).length) active = cached.active;

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
    accounts = d.accounts
      .filter(function (a) { return a.kind === "Options"; })
      .sort(function (x, y) {
        if (x.demo !== y.demo) return x.demo ? 1 : -1;
        return (y.balance || 0) - (x.balance || 0);
      });

    if (!accounts.length) return status("This login has no Deriv options account.", "error");

    $("account").innerHTML = accounts.map(function (a) {
      return '<option value="' + esc(a.id) + '">' + esc(a.id) + " · " +
        (a.demo ? "Demo" : "Real") + " · " + esc(money(a.balance, a.currency)) + "</option>";
    }).join("");

    // Keep the remembered account if it is still one of theirs.
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
      busy: function () { return trading; },
      settings: settings,
      nextStake: function () { return settings.martingale ? nextStake : settings.stake; },
      statsFor: function (sym) {
        return analysers[sym] ? analysers[sym].stats(settings.ref) : null;
      },
      isActive: function (sym) { return !!active[sym]; },
      activate: function (sym) {
        if (active[sym]) return;
        active[sym] = true;
        var b = document.querySelector('.sym[data-sym="' + sym + '"]');
        if (b) b.classList.add("is-on");
        subscribe(sym);
        renderCards();
      },
      place: placeTrade,
      types: C.TYPES
    });
  }

  window.addEventListener("beforeunload", function () { session.close(); });
})();
