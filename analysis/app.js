/**
 * EVIE — Analysis: read the digits, then act on them.
 *
 * Ties this page's modules together: a Session holding one OTP socket, a Digits
 * window computing the percentages, the contract rules, and a Trader that
 * places what the buttons ask for.
 *
 * Markets are the five 2-second volatility indices. The 1-second (1HZ) versions
 * are deliberately absent — they were not asked for, and their digits turn over
 * faster than a table anyone can read.
 *
 * The account picker carries demo as well as real here, unlike Automatic AI:
 * this page exists to be tested against, and the OTP is per-account, so picking
 * the VRTC account genuinely opens a demo socket where every trade is practice.
 */

(function () {
  "use strict";

  var D = window.EvieDeriv;
  if (!D || !D.requireConnection()) return;

  var C = window.EvieContracts;
  var $ = function (id) { return document.getElementById(id); };

  var MARKETS = [
    { sym: "R_10", name: "Volatility 10" },
    { sym: "R_25", name: "Volatility 25" },
    { sym: "R_50", name: "Volatility 50" },
    { sym: "R_75", name: "Volatility 75" },
    { sym: "R_100", name: "Volatility 100" }
  ];

  var marketEl = $("market"), accountEl = $("account"), barrierEl = $("barrier");
  var recentEl = $("recent"), gridEl = $("grid"), statusEl = $("status");
  var balanceEl = $("balance"), badgeEl = $("acct-badge"), riskEl = $("risk");
  var histEl = $("hist"), netEl = $("net"), stopBtn = $("stop");
  var martTog = $("mart-tog"), martEl = $("mart"), typeNote = $("type-note");

  var session = new window.EvieSession();
  var digits = new window.EvieDigits.Digits();
  var trader = null;
  var accounts = [];
  var type = "match";
  var tickSub = null;
  var running = false;

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
    statusEl.textContent = msg || "";
    statusEl.className = "status" + (kind ? " status--" + kind : "");
  }

  /* ── what the trader talks to ───────────────────────────────────────── */

  var ui = {
    status: status,

    net: function (n) {
      netEl.textContent = (n >= 0 ? "+" : "") + n.toFixed(2);
      netEl.className = "grp-note " + (n > 0 ? "is-up" : n < 0 ? "is-down" : "");
    },

    runState: function (on) {
      running = on;
      stopBtn.disabled = !on;
      marketEl.disabled = on;
      accountEl.disabled = on;
      Array.prototype.forEach.call(document.querySelectorAll(".pair-b"), function (b) {
        b.disabled = on;
      });
    },

    result: function (r) {
      if (histEl.querySelector(".acct--none")) histEl.innerHTML = "";
      var t = C.TYPES[r.type];
      var what = t.label + (t.barrier ? " " + r.barrier : "");
      var li = document.createElement("li");
      li.className = "trade " + (r.win ? "trade--win" : "trade--loss");
      li.innerHTML =
        '<span class="trade-r">' + (r.win ? "Win" : "Loss") + "</span>" +
        '<span class="trade-m">' + esc(what) +
          (r.digit != null ? " · got " + r.digit : "") + "</span>" +
        '<span class="trade-p">' + (r.profit >= 0 ? "+" : "") + r.profit.toFixed(2) + "</span>";
      histEl.insertBefore(li, histEl.firstChild);
      while (histEl.children.length > 60) histEl.removeChild(histEl.lastChild);
    }
  };

  /* ── the digit tables ───────────────────────────────────────────────── */

  function paintDigits() {
    var last = digits.last(10);
    recentEl.innerHTML = last.length
      ? last.map(function (d) { return '<li class="dg-r">' + d + "</li>"; }).join("")
      : '<li class="dg-none">Waiting for ticks…</li>';

    var s = digits.stats();
    $("window-note").textContent = s.total ? "last " + s.total + " ticks" : "";

    gridEl.innerHTML = s.rows.map(function (r) {
      var mark = r.digit === s.high ? " dg-c--high"
               : r.digit === s.low ? " dg-c--low"
               : r.digit === s.rising ? " dg-c--rise" : "";
      return '<li class="dg-c' + mark + '">' +
               '<span class="dg-d">' + r.digit + "</span>" +
               '<span class="dg-p">' + r.pct.toFixed(1) + "%</span>" +
             "</li>";
    }).join("");
  }

  /* ── ticks ──────────────────────────────────────────────────────────── */

  function subscribeTicks() {
    var sym = marketEl.value;
    digits.reset();
    paintDigits();

    if (tickSub) {
      session.send({ forget: tickSub });
      tickSub = null;
    }

    // History first so the table is useful straight away, then live ticks.
    session.send({
      ticks_history: sym,
      end: "latest",
      count: window.EvieDigits.WINDOW,
      style: "ticks",
      subscribe: 1
    });
  }

  session.onMessage(function (d) {
    if (d.error) {
      if (!running) status(d.error.message || "Deriv refused that request.", "error");
      return;
    }

    if (d.msg_type === "history" && d.history) {
      var sym = (d.echo_req && d.echo_req.ticks_history) || marketEl.value;
      digits.seed(d.history.prices || [], sym);
      if (d.subscription && d.subscription.id) tickSub = d.subscription.id;
      paintDigits();
      return;
    }

    if (d.msg_type === "tick" && d.tick) {
      if (d.tick.symbol !== marketEl.value) return;
      digits.push(window.EvieDigits.lastDigitOf(d.tick.quote, d.tick.symbol, d.tick.pip_size));
      paintDigits();
      return;
    }

    if (d.msg_type === "balance" && d.balance) {
      balanceEl.textContent = money(d.balance.balance, d.balance.currency);
    }
  });

  /* ── the trade type buttons ─────────────────────────────────────────── */

  function currency() {
    var a = accounts.filter(function (x) { return x.id === accountEl.value; })[0];
    return (a && a.currency) || "USD";
  }

  function describeType() {
    var t = C.TYPES[type];
    typeNote.textContent = t.explain +
      (t.barrier
        ? " Allowed digits for " + t.label + ": " + t.min + "–" + t.max + "."
        : " No digit needed.");
    barrierEl.disabled = !t.barrier;

    // Rebuild the list to the range THIS type accepts, keeping the chosen
    // digit where it is still legal. Over stops at 8, Under starts at 1.
    if (t.barrier) {
      var keep = Number(barrierEl.value);
      var opts = [];
      for (var i = t.min; i <= t.max; i++) {
        opts.push('<option value="' + i + '">' + i + "</option>");
      }
      barrierEl.innerHTML = opts.join("");
      /* Clamp to the nearest legal digit rather than snapping to the bottom of
         the range: coming from 9 into Over, 8 is what was meant, and 0 is the
         opposite end of the scale to land on silently. */
      barrierEl.value = String(isNaN(keep) ? t.min : C.clampBarrier(type, keep));
    }
  }

  function buildPairs() {
    var pairs = [["match", "differ"], ["over", "under"], ["even", "odd"]];
    $("pairs").innerHTML = pairs.map(function (p) {
      return '<div class="pair">' + p.map(function (id) {
        return '<button class="pair-b" type="button" data-type="' + id + '">' +
          C.TYPES[id].label + "</button>";
      }).join("") + "</div>";
    }).join("");

    Array.prototype.forEach.call(document.querySelectorAll(".pair-b"), function (b) {
      b.addEventListener("click", function () {
        type = b.getAttribute("data-type");
        Array.prototype.forEach.call(document.querySelectorAll(".pair-b"), function (x) {
          x.classList.toggle("is-on", x === b);
        });
        describeType();
        place();
      });
    });
  }

  function place() {
    if (running) return;
    if (!session.isOpen()) return status("No trading session — pick an account.", "error");

    var stake = parseFloat($("stake").value);
    var count = parseInt($("count").value, 10);
    var mult = parseFloat(martEl.value);

    if (isNaN(stake) || stake < window.EvieTrader.MIN_STAKE) {
      return status("Deriv's minimum stake is " +
        window.EvieTrader.MIN_STAKE.toFixed(2) + ".", "error");
    }
    if (isNaN(count) || count < 1) return status("Enter how many trades to place.", "error");

    trader.run({
      type: type,
      barrier: C.clampBarrier(type, barrierEl.value),
      stake: stake,
      count: count,
      martingale: martTog.getAttribute("aria-checked") === "true",
      multiplier: isNaN(mult) ? 2 : mult,
      currency: currency(),
      market: marketEl.value
    });
  }

  stopBtn.addEventListener("click", function () { if (trader) trader.cancel(); });

  martTog.addEventListener("click", function () {
    var on = martTog.getAttribute("aria-checked") === "true";
    martTog.setAttribute("aria-checked", String(!on));
    martEl.disabled = on;
  });

  /* ── accounts + session ─────────────────────────────────────────────── */

  function describeAccount() {
    var a = accounts.filter(function (x) { return x.id === accountEl.value; })[0];
    if (!a) return;
    badgeEl.textContent = a.demo ? "Demo" : "Real";
    badgeEl.classList.toggle("badge--demo", a.demo);
    balanceEl.textContent = money(a.balance, a.currency);
    riskEl.textContent = a.demo
      ? "Demo account — trades here are practice money."
      : "Real account — every trade placed here uses your own money.";
    riskEl.className = "risk" + (a.demo ? "" : " risk--real");
  }

  function openSession() {
    var id = accountEl.value;
    if (!id) return;
    status("Opening a session on " + id + "…", "info");

    session.open(id).then(function () {
      trader = new window.EvieTrader(session, ui);
      session.send({ balance: 1, subscribe: 1 });
      subscribeTicks();
      status("Ready.", "success");
    }).catch(function (e) {
      if (e && e.expired) {
        D.disconnect();
        try { sessionStorage.setItem("evie_connect_error", e.message); } catch (x) {}
        return window.location.replace("/");
      }
      status((e && e.message) || "Could not open a trading session.", "error");
    });
  }

  marketEl.innerHTML = MARKETS.map(function (m) {
    return '<option value="' + m.sym + '">' + m.name + "</option>";
  }).join("");

  marketEl.addEventListener("change", subscribeTicks);
  accountEl.addEventListener("change", function () { describeAccount(); openSession(); });

  buildPairs();
  document.querySelector('.pair-b[data-type="match"]').classList.add("is-on");
  describeType();
  paintDigits();

  D.portfolio().then(function (d) {
    // Real first, then demo — but both, because testing is the point here.
    accounts = d.accounts
      .filter(function (a) { return a.kind === "Options"; })
      .sort(function (x, y) {
        if (x.demo !== y.demo) return x.demo ? 1 : -1;
        return (y.balance || 0) - (x.balance || 0);
      });

    if (!accounts.length) return status("This login has no Deriv options account.", "error");

    accountEl.innerHTML = accounts.map(function (a) {
      return '<option value="' + esc(a.id) + '">' + esc(a.id) + " · " +
        (a.demo ? "Demo" : "Real") + " · " + esc(money(a.balance, a.currency)) + "</option>";
    }).join("");

    accountEl.value = accounts[0].id;
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

  window.addEventListener("beforeunload", function (e) {
    session.close();
    if (!running) return;
    e.preventDefault();
    e.returnValue = "";
  });
})();
