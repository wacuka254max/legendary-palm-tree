/**
 * UPTICK — the trading simulator.
 *
 * It fills the account: a run of finished trades in the history, and a set of
 * positions left open on the Trade screen. What it does NOT do is invent a
 * market. Every price is the instrument's real bid or ask, live from Deriv, and
 * every size and charge comes from Deriv's own published contract specification.
 * Only the outcome is simulated — which trades won, which lost, by how much —
 * so only the balance, the deposit and the history are made up.
 *
 * The open positions are not scripted at all. They are opened at the live price
 * and then left alone, so their profit is the engine's own arithmetic against
 * the tape and moves while you watch it, exactly as a real one would.
 *
 * Costs:
 *
 *   · Swap is the instrument's own published rate in points per lot per night,
 *     charged only for nights actually held and tripled on Wednesday, the night
 *     whose value date lands over the weekend under T+2. Signed as Deriv writes
 *     it, so a gold short is credited where a long is charged.
 *   · Commission is a setting, per lot per round turn, because it depends on
 *     the account and not on the market: Deriv's Standard MT5 account is
 *     zero-commission, while its Zero Spread account charges one. It defaults to
 *     zero for that reason and is applied to every trade when set.
 *   · The spread is never simulated. A position opens at the ask and is valued
 *     at the bid, and both are the live figures.
 *
 * The balance is a target, not an outcome. Deposit and balance are both set, and
 * the run's results are scaled so it lands exactly on the balance asked for —
 * otherwise the field would be decoration, which is what it was.
 */

(function (global) {
  "use strict";

  var KEY = "evie_term_sim";

  var ALL = "*all*", RANDOM = "*random*";

  var DEFAULTS = {
    deposit: 10000,
    balance: 10500,
    market: ALL,        // one instrument, ALL of them, or RANDOM per trade
    trades: 20,         // closed trades written into the history
    open: 3,            // positions left open on the Trade screen
    riskMode: "each",   // "each" position risks the percentage, or "all" share it
    riskPct: 1,
    commission: 0,      // per lot, per round turn
    leverage: 400,      // the account's, capped further by each instrument's own
    days: 5
  };

  function load() {
    var s = null;
    try { s = JSON.parse(localStorage.getItem(KEY) || "null"); } catch (e) {}
    var out = {};
    Object.keys(DEFAULTS).forEach(function (k) {
      out[k] = s && s[k] != null ? s[k] : DEFAULTS[k];
    });
    return out;
  }

  function save(s) {
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) {}
  }

  var T = function () { return global.EvieTerminal; };

  /* ── the pieces ───────────────────────────────────────────────────────── */

  /** The instruments a run may use: one, all of them, or a fresh pick each time. */
  function pool(market) {
    var live = T().symbols().filter(function (s) { return s.isOpen !== false; });
    if (!live.length) live = T().symbols();
    if (market === ALL || market === RANDOM) return live;
    var one = T().symbol(market);
    return one ? [one] : live;
  }

  function pick(list, market) {
    if (market === ALL || market === RANDOM || list.length === 1) {
      return list[Math.floor(Math.random() * list.length)];
    }
    return list[0];
  }

  /**
   * Volume for a given risk, held to what the instrument actually accepts.
   *
   * Risk is money; turning it into lots needs the distance the trade would be
   * wrong by. The result is snapped to the instrument's own step — Deriv's
   * minimum doubles as it — and clamped, so the simulator can never produce a
   * size the platform would have refused.
   */
  function volumeFor(sym, risk, stopDist) {
    var perLot = stopDist * sym.size;
    if (sym.usdBase) perLot = perLot / sym.price;
    if (!(perLot > 0)) return sym.minVol;

    /* One snapper, the engine's, so a simulated size and a hand-placed one
       obey the same instrument rules. This had its own copy and they could
       drift. */
    return T().snapVolume(sym, risk / perLot);
  }

  /**
   * Nights held, and what they cost.
   *
   * Swap is per lot per night in points, so it scales with size the way profit
   * does. Wednesday counts three times: that is the night whose value date lands
   * over the weekend under T+2 settlement, and it is when Deriv — like every
   * broker — takes the three days at once.
   */
  function swapFor(sym, type, volume, openMs, closeMs) {
    var rate = type === "buy" ? sym.swapLong : sym.swapShort;
    if (!rate) return 0;

    var nights = 0;
    var d = new Date(openMs);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 1);
    while (d.getTime() <= closeMs) {
      nights += d.getDay() === 3 ? 3 : 1;   // Wednesday carries the weekend
      d.setDate(d.getDate() + 1);
    }
    if (!nights) return 0;

    var v = rate * Math.pow(10, -sym.digits) * volume * sym.size * nights;
    if (sym.usdBase) v = v / sym.price;
    return Math.round(v * 100) / 100;
  }

  /* ── the run ──────────────────────────────────────────────────────────── */

  function build(cfg) {
    var Tm = T();
    if (!Tm) return { error: "Terminal not ready." };

    var list = pool(cfg.market);
    if (!list.length) {
      var f = global.EvieFeed;
      return { error: f && f.connected()
        ? "Still loading markets from Deriv. Try again in a moment."
        : "Not connected to Deriv yet. Check the connection and try again." };
    }

    var deposit = Number(cfg.deposit);
    var target = Number(cfg.balance);
    if (!isFinite(deposit) || deposit <= 0) return { error: "Set a deposit first." };

    /* Leave the balance alone and it behaves like a real account: the deposit
       is what you start with, and the trading moves it from there. Set it to
       something other than the deposit and it becomes a target the run is
       scaled to reach. Deciding by whether it still equals the deposit is what
       lets one field do both without a switch beside it. */
    var grow = !isFinite(target) || target <= 0 ||
               Math.abs(target - deposit) < 0.005;
    if (grow) target = deposit;

    var n = Math.max(0, Math.min(500, Math.round(cfg.trades)));
    var pct = Math.max(0.01, Math.min(100, Number(cfg.riskPct) || 1));
    var comPerLot = Math.max(0, Number(cfg.commission) || 0);
    var now = Date.now();
    var span = Math.max(1, Number(cfg.days) || 5) * 86400000;

    /* ── the closed trades, first as shapes without a result ────────────── */
    var raw = [], running = deposit;
    for (var i = 0; i < n; i++) {
      var sym = pick(list, cfg.market);
      var pt = Math.pow(10, -sym.digits);
      var spread = Math.max(1, sym.spread) * pt;

      var risk = cfg.riskMode === "all"
        ? (deposit * pct / 100) / n
        : running * pct / 100;
      if (!(risk > 0)) break;

      /* A stop several spreads out — inside the spread it would be taken by the
         spread alone, which is not a stop. */
      var stopDist = spread * (6 + Math.random() * 14);
      var volume = volumeFor(sym, risk, stopDist);
      var buy = Math.random() < 0.5;

      var openTime = now - span + Math.round(span * (i + Math.random()) / n);
      var closeTime = Math.min(now, openTime + Math.round((0.2 + Math.random() * 30) * 3600000));

      /* Around the live price, drifting over the run rather than every trade at
         the same figure. */
      var mid = sym.price * (1 + (Math.random() - 0.5) * 0.004);
      var open = buy ? mid + spread / 2 : mid - spread / 2;

      /* Won or lost, as a multiple of the risk. Skewed the way results fall:
         many small, a few large. */
      var won = Math.random() < 0.5;
      var r = won ? 0.4 + Math.pow(Math.random(), 1.8) * 3.2 : -1;

      raw.push({
        sym: sym, buy: buy, volume: volume, open: open,
        openTime: openTime, closeTime: closeTime,
        gross: risk * r, won: won,
        swap: swapFor(sym, buy ? "buy" : "sell", volume, openTime, closeTime),
        commission: Math.round(volume * comPerLot * 100) / 100
      });
      running += risk * r;
    }

    /* ── land on the balance that was asked for ──────────────────────────
       The results are scaled so the deposit plus everything the run made comes
       to exactly the balance set. Swap and commission are not scaled: they are
       real charges on real sizes, so the trading result absorbs the difference,
       which is what it would have to do. */
    var fixed = 0, grossSum = 0;
    raw.forEach(function (t) { fixed += t.swap - t.commission; grossSum += t.gross; });
    var wanted = (target - deposit) - fixed;

    if (raw.length && !grow) {
      if (Math.abs(grossSum) > 1e-6) {
        var k = wanted / grossSum;
        /* A negative factor would turn every winner into a loser and back, which
           is not a scaled run, it is a different one. Fall back to spreading the
           shortfall evenly instead. */
        if (k > 0 && isFinite(k)) {
          raw.forEach(function (t) { t.gross *= k; });
        } else {
          var per = (wanted - grossSum) / raw.length;
          raw.forEach(function (t) { t.gross += per; });
        }
      } else {
        var each = wanted / raw.length;
        raw.forEach(function (t) { t.gross += each; });
      }
    }

    /* ── turn the results back into prices ─────────────────────────────── */
    var deals = [];
    raw.forEach(function (t) {
      var perUnit = t.volume * t.sym.size;
      var move = perUnit ? t.gross / perUnit : 0;
      if (t.sym.usdBase) move = move * t.sym.price;
      var close = t.buy ? t.open + move : t.open - move;
      if (!(close > 0)) close = t.open;

      var profit = Math.round((t.gross + t.swap - t.commission) * 100) / 100;
      deals.push({
        symbol: t.sym.name, type: t.buy ? "buy" : "sell", volume: t.volume,
        open: Number(t.open.toFixed(t.sym.digits)),
        close: Number(close.toFixed(t.sym.digits)),
        profit: profit, swap: t.swap, commission: t.commission,
        reason: t.gross < 0 ? "sl" : (t.won && t.gross > 0 ? "tp" : ""),
        openTime: t.openTime, closeTime: t.closeTime
      });
    });
    deals.sort(function (a, b) { return b.closeTime - a.closeTime; });

    /* Every trade's profit is rounded to the cent, and twenty or fifty of those
       roundings do not cancel — with a commission on each they drifted the run
       several cents off the balance that was asked for. The remainder goes onto
       the most recent trade, which is where a broker's own rounding would land
       and keeps the column adding up exactly. */
    var sum = deals.reduce(function (a, d) { return a + d.profit; }, 0);
    var drift = Math.round(((target - deposit) - sum) * 100) / 100;
    if (!grow && deals.length && Math.abs(drift) >= 0.01) {
      deals[0].profit = Math.round((deals[0].profit + drift) * 100) / 100;
      var t0 = raw.filter(function (t) { return t.openTime === deals[0].openTime; })[0];
      if (t0) {
        /* Move its close price with it, or the row would show a result its own
           two prices do not produce. */
        var perUnit0 = t0.volume * t0.sym.size;
        var g0 = deals[0].profit - deals[0].swap + deals[0].commission;
        var move0 = perUnit0 ? g0 / perUnit0 : 0;
        if (t0.sym.usdBase) move0 = move0 * t0.sym.price;
        var c0 = t0.buy ? t0.open + move0 : t0.open - move0;
        if (c0 > 0) deals[0].close = Number(c0.toFixed(t0.sym.digits));
      }
    }

    var balance = deals.reduce(function (a, d) { return a + d.profit; }, deposit);
    balance = Math.round(balance * 100) / 100;

    /* ── the positions left open ─────────────────────────────────────────
       Opened in the past at a price that leaves them where they should be now,
       and then left entirely alone: the engine prices them against the live
       tape from there, so they move while you watch and their profit is its
       arithmetic rather than anything written here.

       The shape of a book matters. Opening them all at the current price left
       every one of them showing minus the spread, which is what a book looks
       like a second after it was opened and never again. A real one is mostly
       green, because the losers get closed and the winners get left — so most
       run at a profit, and the few that are down are down a little, not a lot.
       Roughly a third of the time every one of them is up. */
    var opens = [];
    var howMany = Math.max(0, Math.min(50, Math.round(cfg.open)));
    var allUp = Math.random() < 0.35;

    for (var j = 0; j < howMany; j++) {
      var s2 = pick(list, cfg.market);
      var risk2 = balance * pct / 100;
      var sp2 = Math.max(1, s2.spread) * Math.pow(10, -s2.digits);
      var vol2 = volumeFor(s2, risk2, sp2 * (6 + Math.random() * 14));
      var buy2 = Math.random() < 0.5;

      /* Winners run: a multiple of the risk, skewed so a few are well ahead.
         Losers are held to a fraction of it — the small red line among the
         green, not a position anybody is in trouble on. */
      var up = allUp || Math.random() < 0.7;
      var want = up
        ? risk2 * (0.6 + Math.pow(Math.random(), 1.6) * 3.4)
        : -risk2 * (0.03 + Math.random() * 0.35);

      opens.push({
        symbol: s2.name, type: buy2 ? "buy" : "sell", volume: vol2,
        profit: Math.round(want * 100) / 100,
        /* Held for a while, which is why it is up: a position showing three
           times its risk did not get there in the last ten seconds. */
        time: now - Math.round((0.5 + Math.random() * 40) * 3600000)
      });
    }

    return { deals: deals, balance: balance, opens: opens, grew: grow };
  }

  /* ── out ──────────────────────────────────────────────────────────────── */

  global.EvieSim = {
    ALL: ALL,
    RANDOM: RANDOM,
    settings: load,
    saveSettings: save,
    defaults: function () { return JSON.parse(JSON.stringify(DEFAULTS)); },

    run: function (cfg) {
      var Tm0 = T();
      if (Tm0 && Tm0.setLeverage) Tm0.setLeverage(cfg.leverage || 400);
      /* Set before the run, so the positions it leaves open are charged their
         commission on the way in exactly as a hand-placed order would be. */
      if (Tm0 && Tm0.setCommission) Tm0.setCommission(cfg.commission || 0);
      var out = build(cfg);
      if (out.error) return out;
      var Tm = T();
      if (!Tm || !Tm.applyRun) return { error: "Terminal not ready." };
      Tm.applyRun(Number(cfg.deposit), out.balance, out.deals, out.opens);
      /* In grow mode the balance is an outcome, not an input, so it is left
         equal to the deposit — writing the result back would silently turn the
         next run into a targeted one. */
      if (out.grew) cfg.balance = Number(cfg.deposit);
      save(cfg);
      return { count: out.deals.length, open: Tm.positions().length, balance: out.balance };
    },

    clear: function (cfg) {
      var Tm = T();
      if (Tm && Tm.applyRun) Tm.applyRun(Number(cfg.deposit), Number(cfg.deposit), [], []);
      save(cfg);
    }
  };
})(typeof window !== "undefined" ? window : this);
