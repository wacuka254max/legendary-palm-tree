/**
 * PIPVANA — Pipvana AI, wired to the connected Deriv account.
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
 * The picker offers real accounts only. A demo sitting beside them every time
 * is an invitation to trade the wrong one, so it is hidden until asked for:
 * double-click the A in "Account" and the demo accounts appear.
 */

(function () {
  "use strict";
  /* The language layer's t() when it is on the page, English otherwise; and a
     {name} filler for the strings built with numbers in them. */
  var T = function (s, vars) {
    var out = (typeof window !== "undefined" && typeof window.t === "function") ? window.t(s) : s;
    if (vars) for (var k in vars) out = out.split("{" + k + "}").join(String(vars[k]));
    return out;
  };


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

  var allAccounts = [];   // every options account this login reaches
  var accounts = [];      // the ones currently offered in the picker
  var showDemo = true;    // the demo is listed under the real account, always
  var bot = null;
  var running = false;

  function money(n, cur) {
    if (n == null || isNaN(Number(n))) return "—";
    var d = window.EvieCurrency ? window.EvieCurrency.digits(cur) : 2;
    return (cur || "USD") + " " + Number(n).toLocaleString(undefined, {
      minimumFractionDigits: d, maximumFractionDigits: d
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

  /** Point the stake field at whatever the chosen account is denominated in:
      its floor, the size of one step, and the name on the label. A crypto
      account steps in hundred-millionths, not cents. */
  function applyCurrency() {
    var a = chosen();
    var cur = (a && a.currency) || "USD";
    var stakeEl = $("stake");
    if (stakeEl && window.EvieCurrency) {
      var floor = window.EvieCurrency.min(cur);
      if (floor == null) stakeEl.removeAttribute("min");
      else stakeEl.setAttribute("min", String(floor));
      stakeEl.setAttribute("step", window.EvieCurrency.step(cur));
    }
    var fld = stakeEl && stakeEl.closest(".fld");
    var k = fld && (fld.querySelector(".fld-k [data-k]") || fld.querySelector(".fld-k"));
    if (k) k.textContent = "Stake (" + cur + ")";
  }

  /* ── the UI the engine talks to ─────────────────────────────────────────
     The engine calls these eight methods and nothing else; this object is the
     whole contract between it and the page. */

  /* The waits the engine says it is in, by its own words: Deriv's rate limit, the line coming
     back (each attempt), an authorisation renewed, a contract update asked for again. */
  var WAITS = /^(Analyzing the markets…|Authorization expired\. Reconnecting\.\.\.|Waiting on a contract update — re-asking Deriv\.\.\.)$|\(Attempt \d+\/10\)$/;
  function waitShow(text) {
    if (window.PopupNotifications && window.PopupNotifications.wait) window.PopupNotifications.wait(histEl, text);
  }

  var ui = {
    showStatus: function (message, type) {
      statusEl.textContent = message || "";
      statusEl.className = "status" + (type ? " status--" + type : "");
      // A wait while running (Deriv's rate limit, the line, a contract update): the trades show it.
      waitShow(running && WAITS.test(message || "") ? message : "");
    },

    setRunningState: function (on) {
      running = !!on;
      if (!running) waitShow("");
      if (!running) figures();
      startBtn.disabled = running;
      stopBtn.disabled = !running;
      selectEl.disabled = running;
      if ($("sl-tog")) $("sl-tog").disabled = running;
      startBtn.textContent = running ? "Running…" : "Start";
    },

    updateBalance: function (balance, currency) {
      balanceEl.textContent = money(balance, currency);
    },

    updateStats: function (s) {
      var p = $("s-profit");
      p.textContent = (s.totalProfit >= 0 ? "+" : "") + (window.EvieCurrency
        ? window.EvieCurrency.bare(s.totalProfit || 0, s.currency)
        : Number(s.totalProfit || 0).toFixed(2));
      p.className = s.totalProfit > 0 ? "is-up" : (s.totalProfit < 0 ? "is-down" : "");
      $("s-trades").textContent = s.totalTrades || 0;

      /* The win rate is coloured by what it says, like the profit above it:
         green while more than half the trades are winning, pink once they are
         not. Grey until there is a trade to rate. */
      var rate = $("s-rate");
      var pct = Number(s.winRate);
      rate.textContent = (s.winRate || "0.00") + "%";
      rate.className = "stat--rate" +
        (!s.totalTrades || isNaN(pct) ? "" : (pct >= 50 ? " is-up" : " is-down"));


      $("s-stake").textContent = window.EvieCurrency
        ? window.EvieCurrency.bare(s.currentStake || 0, s.currency)
        : Number(s.currentStake || 0).toFixed(2);
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
      waitShow("");   // a trade landed: the wait is over
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
    // Only the real account carries a warning. The demo is hidden behind a
    // deliberate gesture, and the badge beside the balance already says Demo.
    riskEl.textContent = a.demo ? "" : "Real account — every trade placed here uses your own money.";
    riskEl.className = "risk" + (a.demo ? "" : " risk--real");

    // The stake field belongs to this account's currency, not to the dollar.
    applyCurrency();
    figures();
  }

  /* ── the figures: defaults and risk words (risk.js) ─────────────────────
     Differs, with a 50/50 recovery after a loss: the stake starts where the
     martingale ladder survives four losses in a row on this balance, the take
     profit at 1.5% of it (never under 3 USD) — until the user types their own —
     and each carries Safe, High or Too high. Dollar accounts only. A run's own
     balance is the engine's; between runs it is the account's. */
  var own = { stake: false, tp: false };
  function figures() {
    var R = window.EvieRisk, a = chosen();
    if (!R) return;
    // A run's figures and words stay as they were at its start; read again when it stops.
    if (running) return;
    var cur = (a && a.currency) || "USD";
    var min = window.EvieCurrency ? window.EvieCurrency.min(cur) : 0.35;
    var bal = a ? Number(a.balance) : NaN, mult = num($("mart"), 3.1);
    /* A dollar balance known — 0 included: then the smallest stake and 3 USD, as on a
       balance too small to size — starts the figures; the words need money in it (none at
       0, as on the other sites). */
    var known = cur === "USD" && min != null && isFinite(bal) && bal >= 0, ok = known && bal > 0;
    var on = R.guide();
    if (known && !running) {
      // The same starting figures, the guide on or off: it only says what they risk.
      var d = ok ? R.defaults("differ", bal, mult, min) : mult > 1 ? { stake: min, tp: R.TP_MIN } : null;
      // On a demo account the take profit starts at a quarter of the usual one, so a test run ends quickly.
      if (d && a && a.demo) d.tp = Math.floor(d.tp * 25 + 1e-9) / 100;
      if (d) {
        if (!own.stake && Math.abs(num($("stake"), 0) - d.stake) > 1e-9) $("stake").value = String(d.stake);
        if (!own.tp && Math.abs(num($("tp"), 0) - d.tp) > 1e-9) $("tp").value = String(d.tp);
      }
    }
    var r = ok && on ? R.assess("differ", bal, num($("stake"), 0), mult, num($("tp"), 0), min) : null;
    R.paint({ stake: $("stake-risk"), tp: $("tp-risk") }, $("fig-note"), r, function (v) {
      return (window.EvieCurrency ? window.EvieCurrency.bare(v, cur) : Number(v).toFixed(2)) + " " + cur;
    }, function (k, v) {
      // A safe figure clicked: into its field, as if typed.
      var f = $(k === "stake" ? "stake" : "tp");
      if (running || !f || f.disabled || !(v > 0)) return;
      f.value = String(v);
      f.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  /* Typed — or restored from this tab — is the user's. Listening before the
     prefs restore them, at the foot. */
  ["stake", "tp"].forEach(function (id) {
    ["input", "change"].forEach(function (ev) { $(id).addEventListener(ev, function () { own[id] = true; figures(); }); });
  });
  ["input", "change"].forEach(function (ev) { $("mart").addEventListener(ev, figures); });
  if (window.EvieRisk) window.EvieRisk.wireGuide($("guide-tog"), figures);
  window.addEventListener("langchange", figures);

  selectEl.addEventListener("change", describeChoice);

  function fillAccounts(list) {
    // Only options accounts can trade. A wallet holds money but cannot take a
    // position, so offering one would be a promise the API cannot keep.
    allAccounts = list.filter(function (a) { return a.kind === "Options"; });

    // Best-funded first within each side, so the default matches the balance
    // shown on the dashboard.
    allAccounts.sort(function (x, y) {
      if (x.demo !== y.demo) return x.demo ? 1 : -1;
      return (y.balance || 0) - (x.balance || 0);
    });

    renderAccounts();
  }

  /** Paint the picker: the real accounts first, the demo under them. */
  function renderAccounts() {
    var keep = selectEl.value;

    accounts = showDemo
      ? allAccounts
      : allAccounts.filter(function (a) { return !a.demo; });

    if (!accounts.length) {
      selectEl.innerHTML = "";
      ui.showStatus(
        showDemo
          ? "This login has no Deriv options account to trade."
          : "This login has no real Deriv options account to trade.",
        "error"
      );
      startBtn.disabled = false;   // Start offers the real account (real.js)
      riskEl.textContent = "";
      if (window.EvieReal) window.EvieReal.set(allAccounts.length ? "real" : "none");

      /* Blank, not the demo's figure. A balance beside a badge reading Real is
         a claim about how much money is at stake, and showing a practice
         balance there is the wrong claim to make. */
      balanceEl.textContent = "—";
      acctBadge.textContent = "Real";
      acctBadge.classList.remove("badge--demo");
      return;
    }

    startBtn.disabled = running;
    if (window.EvieReal) window.EvieReal.set(null);

    selectEl.innerHTML = accounts.map(function (a) {
      return '<option value="' + esc(a.id) + '">' +
        esc(a.id) + " · " + (a.demo ? "Demo" : "Real") + " · " + esc(money(a.balance, a.currency)) +
        "</option>";
    }).join("");

    // Keep the current choice where it survives the change of list.
    var stillThere = accounts.some(function (a) { return a.id === keep; });
    selectEl.value = stillThere ? keep : accounts[0].id;
    describeChoice();
  }

  /* ── run it ─────────────────────────────────────────────────────────── */

  function num(el, fallback) {
    var v = parseFloat(el.value);
    return isNaN(v) ? fallback : v;
  }

  /* The stop loss has a switch, off unless turned on (as the Analysis bot's): off, a run has no
     stop loss at all and the field is hidden, so the risk guide's figures carry it; on, the field
     is back with its figure. Remembered for the tab (prefs.js), like the figures. */
  function slOn() { return $("sl-tog") ? $("sl-tog").getAttribute("aria-checked") === "true" : true; }
  if ($("sl-tog")) {
    $("sl-tog").addEventListener("click", function () {
      if (running) return;   // a run keeps the stop loss it started with
      var on = !slOn();
      $("sl-tog").setAttribute("aria-checked", String(on));
      if ($("sl-row")) $("sl-row").hidden = !on;
    });
  }

  /* What the run did past the risk guide, for its stop-loss or insufficient-balance card: its
     figures at its start against the guide's for the balance it started on (risk.js). */
  var runFig = null;
  function whyFor(reason) {
    var R = window.EvieRisk, f = runFig;
    if (!R || !R.mistakes || !f || f.currency !== "USD") return [];
    return R.mistakes(Object.assign({}, f, { sl: reason === "sl" ? f.sl : 0, why: reason === "sl" ? "sl" : "funds",
      money: function (v) { return (window.EvieCurrency ? window.EvieCurrency.bare(v, f.currency) : Number(v).toFixed(2)) + " " + f.currency; } }));
  }

  startBtn.addEventListener("click", function () {
    var account = chosen();
    if (running) return;
    if (!account) {
      if (window.EvieReal && window.EvieReal.kind()) window.EvieReal.offer();   // no real account: the way to open one
      return;
    }

    var config = {
      initialStake: num($("stake"), 1),
      martingaleMultiplier: num($("mart"), 3.1),
      takeProfit: num($("tp"), 100),
      // No stop loss while its switch is off (the engine reads 0 as none).
      stopLoss: slOn() ? num($("sl"), 1000) : 0
    };

    /* The floor belongs to the account's currency. Where Deriv's moves with
       the exchange rate we do not guess it — refusing here would block a
       trade the account could place. See currency.js. */
    var cur = (account && account.currency) || "USD";
    var floor = window.EvieCurrency ? window.EvieCurrency.min(cur) : 0.35;
    if (floor != null && config.initialStake < floor) {
      return ui.showStatus(T("Deriv's minimum stake is {min}.", { min: floor + " " + cur }), "error");
    }

    runFig = { kind: "differ", balance: Number(account.balance), stake: config.initialStake, mult: config.martingaleMultiplier, defMult: 3.1,
      tp: config.takeProfit, sl: config.stopLoss, min: floor != null ? floor : 0.35, currency: cur };
    startBtn.disabled = true;
    ui.showStatus(T("Opening a trading session on {account}…", { account: account.id }), "info");

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
          otpAuthenticated: true,
          whyFor: whyFor
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
        ui.showStatus((e && e.message) || "Could not start Pipvana AI.", "error");
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

  /* Stake, martingale and the two limits survive a reload but not the tab —
     see prefs.js. Bound last so the page's own handlers hear the restore. */
  if (window.EviePrefs) {
    // One scope for both: each keeps its own copy of what is stored, and two would overwrite each other.
    var prefs = window.EviePrefs.scope("automatic-ai");
    prefs.fields(["stake", "mart", "tp", "sl"]);
    if ($("sl-tog")) prefs.switches(["sl-tog"]);
  }
})();
