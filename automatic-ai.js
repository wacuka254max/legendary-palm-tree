/**
 * EVIE — Automatic AI, wired to the connected Deriv account.
 *
 * The engine in automatic-ai-engine.js does the trading. This file is only the
 * plumbing between it and the account the user connected on the landing page:
 *
 *   1. Read the portfolio (the same REST call the dashboard uses) to find the
 *      options accounts. Only options accounts can trade — a wallet cannot.
 *   2. Ask Deriv for an OTP socket for the CHOSEN account. That account id is
 *      the demo/real decision; there is no separate flag.
 *   3. Hand the engine that URL with otpAuthenticated, so it skips `authorize`
 *      — the socket is already authorised, and the legacy a1- token it would
 *      otherwise send does not exist in this flow.
 *
 * The picker defaults to the real account, the one shown on the dashboard, but
 * the demo is always one choice away and the page says plainly which of the two
 * is about to be traded. Real money deserves that much.
 */

(function () {
  "use strict";

  var D = window.EvieDeriv;
  if (!D || !D.requireConnection()) return;

  var $ = function (id) { return document.getElementById(id); };

  var balanceEl = $("balance");
  var acctBadge = $("acct-badge");
  var selectEl = $("account");
  var startBtn = $("start");
  var stopBtn = $("stop");
  var statusEl = $("status");
  var riskEl = $("risk");
  var histEl = $("hist");

  var accounts = [];
  var bot = null;
  var running = false;

  function money(n, cur) {
    if (n == null || isNaN(Number(n))) return "—";
    return (cur || "USD") + " " + Number(n).toLocaleString(undefined, {
      minimumFractionDigits: 2, maximumFractionDigits: 2
    });
  }

  function esc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function chosen() {
    return accounts.filter(function (a) { return a.id === selectEl.value; })[0] || null;
  }

  /* ── the UI the engine talks to ─────────────────────────────────────────
     The engine calls these eight methods and nothing else; this object is the
     whole contract between it and the page. */

  var ui = {
    showStatus: function (message, type) {
      statusEl.textContent = message || "";
      statusEl.className = "status" + (type ? " status--" + type : "");
    },

    setRunningState: function (on) {
      running = !!on;
      startBtn.disabled = running;
      stopBtn.disabled = !running;
      selectEl.disabled = running;
      startBtn.textContent = running ? "Running…" : "Start";
    },

    updateBalance: function (balance, currency) {
      balanceEl.textContent = money(balance, currency);
    },

    updateStats: function (s) {
      var p = $("s-profit");
      p.textContent = (s.totalProfit >= 0 ? "+" : "") + Number(s.totalProfit || 0).toFixed(2);
      p.className = s.totalProfit > 0 ? "is-up" : (s.totalProfit < 0 ? "is-down" : "");
      $("s-trades").textContent = s.totalTrades || 0;
      $("s-rate").textContent = (s.winRate || "0.00") + "%";
      $("s-stake").textContent = Number(s.currentStake || 0).toFixed(2);
      $("s-market").textContent = s.market || "—";
      if (s.balance != null) balanceEl.textContent = money(s.balance, s.currency);
    },

    updateTargets: function (market, target) {
      $("s-market").textContent = market + (target != null ? " · " + target : "");
    },

    updateRunningTime: function (t) { $("s-time").textContent = t; },

    resetHistory: function () {
      histEl.innerHTML = '<li class="acct acct--none">No trades yet.</li>';
    },

    addHistoryEntry: function (e) {
      if (histEl.querySelector(".acct--none")) histEl.innerHTML = "";
      var li = document.createElement("li");
      li.className = "trade " + (e.win ? "trade--win" : "trade--loss");
      li.innerHTML =
        '<span class="trade-r">' + (e.win ? "Win" : "Loss") + "</span>" +
        '<span class="trade-m">' + esc(e.market) + " · " + esc(e.digit) + "</span>" +
        '<span class="trade-p">' + (e.profit >= 0 ? "+" : "") + Number(e.profit).toFixed(2) + "</span>";
      histEl.insertBefore(li, histEl.firstChild);
      // A session can run for hours; the last 50 trades are enough to see it.
      while (histEl.children.length > 50) histEl.removeChild(histEl.lastChild);
    }
  };

  /* ── which account ──────────────────────────────────────────────────── */

  function describeChoice() {
    var a = chosen();
    if (!a) return;
    acctBadge.textContent = a.demo ? "Demo" : "Real";
    acctBadge.classList.toggle("badge--demo", a.demo);
    balanceEl.textContent = money(a.balance, a.currency);
    riskEl.textContent = a.demo
      ? "Demo account — this trades Deriv's practice money, not yours."
      : "Real account — every trade placed here uses your own money.";
    riskEl.className = "risk" + (a.demo ? "" : " risk--real");
  }

  selectEl.addEventListener("change", describeChoice);

  function fillAccounts(list) {
    // Only options accounts can trade. A wallet holds money but cannot take a
    // position, so offering one would be a promise the API cannot keep.
    accounts = list.filter(function (a) { return a.kind === "Options"; });

    if (!accounts.length) {
      ui.showStatus("This login has no Deriv options account to trade.", "error");
      startBtn.disabled = true;
      return;
    }

    // Real first, best-funded of those first, so the default matches the
    // balance shown on the dashboard.
    accounts.sort(function (x, y) {
      if (x.demo !== y.demo) return x.demo ? 1 : -1;
      return (y.balance || 0) - (x.balance || 0);
    });

    selectEl.innerHTML = accounts.map(function (a) {
      return '<option value="' + esc(a.id) + '">' +
        esc(a.id) + " · " + (a.demo ? "Demo" : "Real") + " · " + esc(money(a.balance, a.currency)) +
        "</option>";
    }).join("");

    selectEl.value = accounts[0].id;
    describeChoice();
  }

  /* ── run it ─────────────────────────────────────────────────────────── */

  function num(el, fallback) {
    var v = parseFloat(el.value);
    return isNaN(v) ? fallback : v;
  }

  startBtn.addEventListener("click", function () {
    var account = chosen();
    if (!account || running) return;

    var config = {
      initialStake: num($("stake"), 1),
      martingaleMultiplier: num($("mart"), 3.1),
      takeProfit: num($("tp"), 100),
      stopLoss: num($("sl"), 1000)
    };

    if (config.initialStake < 0.35) {
      return ui.showStatus("Deriv's minimum stake is 0.35.", "error");
    }

    startBtn.disabled = true;
    ui.showStatus("Opening a trading session on " + account.id + "…", "info");

    D.tradeSocket(account.id)
      .then(function (url) {
        bot = new window.EvieAutomaticAI(ui, {
          wsUrl: url,
          defaults: {
            initialStake: config.initialStake,
            takeProfit: config.takeProfit,
            stopLoss: config.stopLoss,
            martingaleMultiplier: config.martingaleMultiplier
          },
          markets: ["R_10", "R_25", "R_50", "R_75", "R_100"],
          // The OTP socket is already authorised, so there is no token to
          // resolve — but the engine checks for one before it starts, so this
          // stands in for it.
          resolveAuthToken: function () { return "otp"; },
          otpAuthenticated: true
        });
        return bot.start(config);
      })
      .catch(function (e) {
        startBtn.disabled = false;
        if (e && e.expired) {
          D.disconnect();
          try { sessionStorage.setItem("evie_connect_error", e.message); } catch (x) {}
          window.location.replace("/");
          return;
        }
        ui.showStatus((e && e.message) || "Could not start Automatic AI.", "error");
      });
  });

  stopBtn.addEventListener("click", function () {
    if (bot) bot.stop();
  });

  /* Closing the tab mid-session leaves a contract running with nothing
     watching it, so say so rather than let it happen silently. */
  window.addEventListener("beforeunload", function (e) {
    if (!running) return;
    e.preventDefault();
    e.returnValue = "";
  });

  /* ── load the accounts ──────────────────────────────────────────────── */

  D.portfolio()
    .then(function (d) { fillAccounts(d.accounts); })
    .catch(function (e) {
      if (e && e.expired) {
        D.disconnect();
        try { sessionStorage.setItem("evie_connect_error", e.message); } catch (x) {}
        window.location.replace("/");
        return;
      }
      ui.showStatus((e && e.message) || "Could not read your Deriv accounts.", "error");
      startBtn.disabled = true;
    });
})();
