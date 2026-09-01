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
  var settings = { stake: 1, ref: 5, count: 130 };

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
      Array.prototype.forEach.call(document.querySelectorAll(".act"), function (b) {
        b.disabled = on;
      });
      $("account").disabled = on;
    },

    result: function (r) {
      var t = C.TYPES[r.type];
      txn.add({
        label: t.label + (t.barrier ? " " + r.barrier : ""),
        market: r.market,
        win: r.win,
        stake: r.stake,
        profit: r.profit,
        payout: r.payout,
        entry: r.entry,
        exit: r.exit
      });
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
    if (!want.length) host.innerHTML = '<p class="cards-none">No symbols selected. Pick one above.</p>';
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
      if (d.subscription && d.subscription.id) subs[sym] = d.subscription.id;
      paint(sym);
      return;
    }

    if (d.msg_type === "tick" && d.tick && d.tick.symbol) {
      var t = d.tick;
      if (!active[t.symbol]) return;
      if (!analysers[t.symbol]) analysers[t.symbol] = new A.Analyser(t.symbol, settings.count);
      analysers[t.symbol].push(t.quote, t.pip_size);
      markDirty(t.symbol);
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
    if (!session.isOpen()) return status("No trading session — pick an account.", "error");

    var type = b.getAttribute("data-type");
    var sym = b.getAttribute("data-sym");
    var stake = parseFloat($("stake").value);

    if (isNaN(stake) || stake < window.EvieTrader.MIN_STAKE) {
      return status("Deriv's minimum stake is " + window.EvieTrader.MIN_STAKE.toFixed(2) + ".", "error");
    }

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
  });

  function currencyOf() {
    var a = accounts.filter(function (x) { return x.id === $("account").value; })[0];
    return (a && a.currency) || "USD";
  }

  /* ── settings ───────────────────────────────────────────────────────── */

  $("apply").addEventListener("click", function () {
    var ref = parseInt($("ref").value, 10);
    var count = parseInt($("count").value, 10);
    var stake = parseFloat($("stake").value);

    if (isNaN(ref) || ref < 0 || ref > 9) return status("Reference digit must be 0 to 9.", "error");
    if (isNaN(count) || count < 10) return status("Analysis count must be at least 10.", "error");
    if (isNaN(stake) || stake < window.EvieTrader.MIN_STAKE) {
      return status("Deriv's minimum stake is " + window.EvieTrader.MIN_STAKE.toFixed(2) + ".", "error");
    }

    var countChanged = count !== settings.count;
    settings = { stake: stake, ref: ref, count: count };

    // A longer window needs history we do not hold, so re-request it; a shorter
    // one only needs trimming, which setCount does.
    if (countChanged) { unsubscribeAll(); subscribeAll(); }
    else Object.keys(analysers).forEach(function (s) { analysers[s].setCount(count); paint(s); });

    renderCards();
    status("Settings applied — reference digit " + ref + ", " + count + " ticks.", "success");
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

  function openSession() {
    var id = $("account").value;
    if (!id) return;
    status("Opening a session on " + id + "…", "info");

    session.close();
    subs = {};

    session.open(id).then(function () {
      trader = new window.EvieTrader(session, ui);
      session.send({ balance: 1, subscribe: 1 });
      subscribeAll();
      status("Live — watching " + activeCount() + " market(s).", "success");
    }).catch(function (e) {
      if (e && e.expired) {
        D.disconnect();
        try { sessionStorage.setItem("evie_connect_error", e.message); } catch (x) {}
        return window.location.replace("/");
      }
      status((e && e.message) || "Could not open a trading session.", "error");
    });
  }

  $("account").addEventListener("change", function () { describeAccount(); openSession(); });

  /* ── go ─────────────────────────────────────────────────────────────── */

  renderSyms();
  renderCards();

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

    $("account").value = accounts[0].id;
    describeAccount();
    openSession();
  }).catch(function (e) {
    if (e && e.expired) {
      D.disconnect();
      try { sessionStorage.setItem("evie_connect_error", e.message); } catch (x) {}
      return window.location.replace("/");
    }
    status((e && e.message) || "Could not read your Deriv accounts.", "error");
  });

  window.addEventListener("beforeunload", function () { session.close(); });
})();
