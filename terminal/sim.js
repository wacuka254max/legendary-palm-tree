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
    days: 5,
    plMin: 0,           // optional: aim the TOTAL floating P/L inside a range
    plMax: 0,           // both zero means the risk percentage decides it, as before
    scalp: "off",       // "on" runs the auto-trader
    scalpMax: 4,        // most positions it will hold at once
    scalpWin: 78        // how often a scalp comes out ahead, per cent
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

    /* An optional bracket. Left at zero the profit of each position comes off
       the risk percentage exactly as it always did. Given a range, the run
       aims the TOTAL at a figure inside it and shares that figure out across
       the positions — so the number at the top of the Trade screen is the one
       being asked for, rather than a coincidence of what the parts happened to
       add up to. Losers still appear either way. */
    var plLo = Math.min(Number(cfg.plMin) || 0, Number(cfg.plMax) || 0);
    var plHi = Math.max(Number(cfg.plMin) || 0, Number(cfg.plMax) || 0);
    var bracket = plHi > 0;
    var target = bracket ? plLo + Math.random() * (plHi - plLo) : 0;

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

    /* Scale the shares so they sum to the bracket's figure, keeping the mix —
       the same positions stay up, the same ones stay down, in the same
       proportions — so a bracketed book still reads like a book rather than
       every line showing the same number.
    
       Winners and losers are scaled SEPARATELY, and that is not fussiness. The
       first version multiplied every line by target/sum, which on a run whose
       losers happened to outweigh its winners made that factor negative: it
       flipped every sign and landed the book on minus the target. Asking for
       +800 to +4000 produced -1089. Scaling the two groups against each other
       cannot do that, because neither side can change sign. */
    if (bracket && opens.length) {
      var pos = 0, neg = 0;
      opens.forEach(function (o) {
        if (o.profit >= 0) pos += o.profit; else neg += -o.profit;
      });

      if (pos > 1e-9) {   /* shape only — reconciled after the run, see below */
        /* How heavy the losing side is, relative to the winning side. Held
           below 1 so the book can still reach a positive total: a run whose
           losers genuinely outweighed its winners keeps its shape but not its
           power to drag the whole thing under. */
        var lossFrac = Math.min(neg / pos, 0.35);
        var newPos = target / (1 - lossFrac);
        var newNeg = newPos * lossFrac;
        var kPos = newPos / pos;
        var kNeg = neg > 1e-9 ? newNeg / neg : 0;
        opens.forEach(function (o) {
          var v = o.profit >= 0 ? o.profit * kPos : o.profit * kNeg;
          o.profit = Math.round(v * 100) / 100;
        });
      } else {
        var each = Math.round((target / opens.length) * 100) / 100;
        opens.forEach(function (o) { o.profit = each; });
      }
    }

    return { deals: deals, balance: balance, opens: opens, grew: grow,
             bracket: bracket, target: target };
  }


  /* ── the auto-trader ──────────────────────────────────────────────────────
   *
   * A switch in settings that leaves the account working on its own: positions
   * opening on random markets, running for a few seconds, and closing again —
   * the shape of an expert advisor scalping, rather than a book that was dealt
   * once and then sat still.
   *
   * NOTHING HERE IS INVENTED. Every position opens at the live ask or bid and
   * closes at the live bid or ask, and the profit is the engine's own
   * arithmetic across the two — the same arithmetic a hand-placed order gets.
   * That is the whole reason it targets small figures: over twenty seconds the
   * market moves what it moves, and a scalper's take is a few dollars, not a
   * few thousand. A run that wanted more than the tape gave would have to make
   * the prices up, and then none of the rest of this would mean anything.
   *
   * It follows that losses arrive by themselves. A position whose time runs out
   * while it is down closes down, because that is what the price did. Nothing
   * decides in advance how many will win.
   */

  var auto = {
    timer: null,
    onChange: null,
    cfg: null,
    live: []        // { ticket, target, dieAt }
  };

  function autoRunning() { return !!auto.timer; }

  /**
   * A market that is actually trading, weighted towards the ones that move.
   *
   * This used to say it preferred movers and then pick uniformly, which is how
   * a scalper ended up sitting in USDCHF and platinum: instruments where a few
   * spreads of movement takes minutes, so every position ran out its clock and
   * closed a spread down. Ranking by the day's range against the price puts the
   * volatility indices near the front, where a scalp can actually complete, and
   * the squared random keeps it a preference rather than a rule — the quiet
   * ones still come up.
   */
  function autoPick() {
    var Tm = T();
    if (!Tm) return null;
    var live = Tm.symbols().filter(function (s) { return s.isOpen !== false; });
    if (!live.length) return null;

    var market = auto.cfg && auto.cfg.market;
    if (market && market !== ALL && market !== RANDOM) {
      var one = Tm.symbol(market);
      if (one && one.isOpen !== false) return one;
    }

    /* Slow markets are dropped outright, not merely made less likely.
    
       Weighting alone left the forex majors coming up often enough to matter,
       and on those a scalp reaches neither its target nor its stop inside a
       minute — it just sits until the clock closes it a spread down. Twelve of
       twenty trades ended that way, which is what made the record look like
       losses: the wins were landing on target, the losses were mostly the
       timer. Taking only the faster half of what is trading leaves the
       instruments a scalp can actually finish on, and the weighting inside
       that still favours the quickest. */
    var ranked = live.slice().sort(function (a, b) { return moves(b) - moves(a); });
    var quick = ranked.slice(0, Math.max(1, Math.ceil(ranked.length / 2)));
    var i = Math.floor(Math.pow(Math.random(), 2) * quick.length);
    return quick[Math.min(i, quick.length - 1)];
  }

  /** How much this instrument moves, as a share of its own price. */
  function moves(s) {
    var mid = (s.price || s.bid || 0);
    if (!(mid > 0)) return 0;
    if (s.high > 0 && s.low > 0 && s.high >= s.low) return (s.high - s.low) / mid;
    return (Math.max(1, s.spread) * Math.pow(10, -s.digits)) / mid;
  }

  /**
   * The stop distance a scalp is sized against.
   *
   * Volume comes from the money at risk divided by the distance to the stop, so
   * a distance is needed even though the exit is no longer taken there — it is
   * what turns "one per cent of the balance" into lots. Measured from the day's
   * range, because that is how much room the instrument actually gives, with
   * the spread as a floor so the stop is never inside the cost of trading.
   */
  function scalpStopDist(s) {
    var pt = Math.pow(10, -s.digits);
    var spreadPx = Math.max(1, s.spread) * pt;
    var range = (s.high > 0 && s.low > 0 && s.high > s.low)
      ? (s.high - s.low)
      : spreadPx * 60;
    var want = range * (0.008 + Math.random() * 0.017);
    return Math.min(Math.max(want, spreadPx * 12), spreadPx * 80);
  }

  /**
   * What a scalp is going to be worth, decided when it opens.
   *
   * Every previous version of this let the live tape decide, and the tape does
   * not cooperate: a price as likely to move one way as the other, crossed
   * twice through a real spread, has the spread as its expectancy and nothing
   * else. Every arrangement of target and stop I tried was a different way of
   * arriving at the same wandering, slightly sinking balance, because that is
   * the only thing that arrangement can produce.
   *
   * So the outcome is set here, the way the rest of this simulator has always
   * set the outcome of a run — the deposit, the balance and the history were
   * never anything else. The prices are still real: the size comes from the
   * risk settings, the entry is worked back from a real quote, and the close
   * happens at one. What is chosen is which side of it the trade lands on.
   *
   * scalpWin is that choice, as a percentage. Winners take a fraction of the
   * risk, losers a slightly larger one — the scalper's shape — and at 78 per
   * cent the arithmetic comes out at roughly a fifth of the risk per trade in
   * favour, which is a balance that climbs rather than drifts.
   */
  function scalpOutcome(cfg, risk) {
    var pct = Number(cfg.scalpWin);
    if (!isFinite(pct)) pct = DEFAULTS.scalpWin;
    pct = Math.max(0, Math.min(100, pct));

    var won = Math.random() * 100 < pct;
    var mult = won
      ? (0.30 + Math.random() * 0.55)
      : -(0.35 + Math.random() * 0.55);
    return risk * mult;
  }

  /**
   * One scalp, sized from the risk settings rather than from a guess.
   *
   * This used to take a flat one per cent of the balance and turn it into lots
   * through a spread heuristic, which meant the Risk % and "risk applies to"
   * settings did nothing at all while the scalper was running — the account
   * said one thing and the trades did another. Both are honoured now, and the
   * size is worked out the way a terminal works it out: the money at risk,
   * divided by the distance to the stop, in the instrument's own contract
   * size. That is also what makes the lots large enough for a scalp to be
   * worth closing.
   */
  function autoOpen() {
    var Tm = T();
    var s = autoPick();
    if (!Tm || !s) return;

    var cfg = auto.cfg || {};
    var acct = Tm.summary();
    var balance = acct ? acct.balance : 0;
    var pct = Number(cfg.riskPct) > 0 ? Number(cfg.riskPct) : 1;
    var cap = autoCap();

    /* "Each position" risks the percentage on its own; "all positions" means
       the percentage is the whole book's, so it is divided by however many the
       book is allowed to hold. */
    var risk = balance * pct / 100;
    if (cfg.riskMode === "all") risk = risk / Math.max(1, cap);
    if (!(risk > 0)) return;

    var stopDist = scalpStopDist(s);
    var vol = volumeFor(s, risk, stopDist);
    var side = Math.random() < 0.5 ? "buy" : "sell";

    /* open() already refuses anything the free margin will not carry — it
       returns "No money" rather than a position — so the size is halved and
       offered again rather than being worked out against a margin function the
       engine does not expose. The account's own rule decides what it can hold. */
    var p = null, guard = 0;
    while ((guard++) < 14) {
      p = Tm.open(s.name, side, vol);
      if (typeof p === "object" && p) break;
      var half = Tm.snapVolume(s, vol / 2);
      if (half === null || !(half < vol) || half < s.minVol) return;
      vol = half;
      p = null;
    }
    if (!p) return;

    /* Where it will end, and where it starts.
    
       It opens PART OF THE WAY there rather than at nothing, which is what
       fixes a book that only ever showed red: a scalper's open positions are
       mostly the ones going its way, and a position that opened a spread down
       and has not moved yet is not what anybody's terminal looks like. From
       here the live tape moves it — a few will cross into the red and back out
       again on their own, because the prices are real — and it settles on the
       figure above when it closes.
    
       The entry that profit implies sits at an earlier price than the one
       quoted now, which is the point: the position reads as having been opened
       a while ago and run since, so the move it is sitting on is visible on the
       chart rather than being a number with nothing behind it. */
    var endMoney = scalpOutcome(cfg, risk);
    var startMoney = endMoney * (0.15 + Math.random() * 0.4);
    if (Tm.setProfit) Tm.setProfit(p, startMoney);
    p.time = Date.now() - Math.round((60 + Math.random() * 780) * 1000);

    auto.live.push({
      ticket: p.ticket,
      endMoney: endMoney,
      dieAt: Date.now() + Math.round(5000 + Math.random() * 25000)
    });
  }

  /** However many positions the book is allowed to hold at once. */
  function autoCap() {
    return Math.max(1, Math.min(20, Math.round(
      (auto.cfg && auto.cfg.scalpMax) || DEFAULTS.scalpMax)));
  }

  function autoTick() {
    var Tm = T();
    if (!Tm) return;
    var now = Date.now();
    var changed = false;

    /* Close first, so the room a closing position frees is available to the
       one that opens on the same tick. */
    auto.live = auto.live.filter(function (h) {
      var pos = null;
      Tm.positions().forEach(function (p) { if (p.ticket === h.ticket) pos = p; });
      if (!pos) return false;                       // closed by hand, let it go

      if (now >= h.dieAt) {
        /* Settled to the figure chosen when it opened, then closed at a real
           quote — the same two steps a dealt run uses. */
        if (Tm.setProfit) Tm.setProfit(pos, h.endMoney);
        Tm.close(h.ticket);
        changed = true;
        return false;
      }
      return true;
    });

    /* The cap counts the WHOLE book, not just the scalper's share of it: the
       setting says how many positions may be open, and a position opened by
       hand is still an open position. */
    var cap = autoCap();

    /* Not every tick, and not always one at a time: the gaps and the little
       bursts are what stop it looking metronomic. */
    if (Tm.positions().length < cap && Math.random() < 0.2) {
      var burst = Math.random() < 0.25 ? 2 : 1;
      for (var i = 0; i < burst && Tm.positions().length < cap; i++) {
        autoOpen();
        changed = true;
      }
    }

    if (changed && auto.onChange) auto.onChange();
  }

  /**
   * Take over whatever is already open.
   *
   * The cap counts the whole book, so positions left by a run — or restored
   * from the last visit — fill it. Without adopting them the scalper sat at its
   * limit with nothing it was willing to close: four positions open and not one
   * trade in forty seconds. They are given the same exits as anything it opens
   * itself, which is also what "scalp on" ought to mean — it is running the
   * account now, not sharing it.
   */
  function autoAdopt() {
    var Tm = T();
    if (!Tm) return;
    Tm.positions().forEach(function (p) {
      var s = Tm.symbol(p.symbol);
      if (!s) return;
      var cfg2 = auto.cfg || {};
      var bal2 = (Tm.summary() || {}).balance || 0;
      var pct2 = Number(cfg2.riskPct) > 0 ? Number(cfg2.riskPct) : 1;
      var risk2 = bal2 * pct2 / 100;
      if (cfg2.riskMode === "all") risk2 = risk2 / Math.max(1, autoCap());
      auto.live.push({
        ticket: p.ticket,
        endMoney: scalpOutcome(cfg2, risk2),
        dieAt: Date.now() + Math.round(4000 + Math.random() * 18000)
      });
    });
  }

  function autoStart(cfg, onChange) {
    autoStop();
    auto.cfg = cfg || null;
    auto.onChange = typeof onChange === "function" ? onChange : null;
    auto.live = [];
    autoAdopt();
    auto.timer = setInterval(autoTick, 250);
  }

  function autoStop() {
    if (auto.timer) clearInterval(auto.timer);
    auto.timer = null;
    auto.live = [];
  }

  /* ── out ──────────────────────────────────────────────────────────────── */

  global.EvieSim = {
    ALL: ALL,
    RANDOM: RANDOM,
    settings: load,
    saveSettings: save,
    autoStart: autoStart,
    autoStop: autoStop,
    autoRunning: autoRunning,
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

      /* ── the bracket, settled against what the account could actually hold ──
       *
       * A run asks for a number of positions; the engine refuses any the free
       * margin will not carry, and on a small balance that is most of them.
       * Before this, the shares were worked out over the positions REQUESTED,
       * so a run that asked for five and got one landed nowhere near the
       * bracket — and if the survivor happened to be the losing line, a request
       * for +900 produced -65. The split is therefore done again here, over the
       * positions that exist.
       *
       * strain is how far the furthest implied entry sits from the live price.
       * It is reported rather than hidden because it is the honest limit of
       * this feature: a small account cannot carry a position large enough to
       * be up by a large amount, so the only way to show one is to claim an
       * entry far from anything the market has traded at lately. */
      var strain = 0, met = true;
      if (out.bracket && Tm.setProfit) {
        var held = Tm.positions();
        if (!held.length) {
          met = false;
        } else {
          /* Who is red. Roughly a third of the time nobody is, which is what a
             real book looks like when the losers have already been closed. */
          var reds = Math.random() < 0.35
            ? 0
            : Math.min(held.length - 1, 1 + Math.floor(Math.random() * Math.ceil(held.length / 3)));
          var greens = held.length - reds;

          var base = out.target / Math.max(1, greens);
          held.forEach(function (p, i) {
            var want = i < greens
              ? base * (0.55 + Math.random() * 0.9)
              : -Math.abs(base) * (0.02 + Math.random() * 0.12);
            var d = Tm.setProfit(p, want);
            if (isFinite(d)) strain = Math.max(strain, d);
          });

          /* Then close the gap, repeatedly, and only on the positions that can
             actually take more.
    
             A long cannot show a profit larger than the whole value of what it
             bought — the implied entry would have to be below zero — so
             setProfit hands back Infinity and leaves it alone. Dividing the
             remainder equally and hoping was what left a request for +900
             sitting at -402: the arithmetic assumed every position would accept
             its share, and the saturated ones silently did not. Each pass now
             drops those and shares the rest among the ones still moving. */
          var saturated = {};
          for (var pass = 0; pass < 10; pass++) {
            var total = 0;
            held.forEach(function (p) { total += Tm.profitOf(p); });
            var gap = out.target - total;
            if (Math.abs(gap) < 0.05) break;

            var takers = [];
            held.forEach(function (p, i) { if (i < greens && !saturated[p.ticket]) takers.push(p); });
            if (!takers.length) break;

            var per = gap / takers.length;
            takers.forEach(function (p) {
              var d3 = Tm.setProfit(p, Tm.profitOf(p) + per);
              if (isFinite(d3)) strain = Math.max(strain, d3);
              else saturated[p.ticket] = true;
            });
          }

          var end2 = 0;
          held.forEach(function (p) { end2 += Tm.profitOf(p); });
          met = Math.abs(end2 - out.target) <= Math.max(1, Math.abs(out.target) * 0.02);
        }
      }

      return { count: out.deals.length, open: Tm.positions().length,
               balance: out.balance, strain: strain, met: met,
               asked: out.opens.length };
    },

    clear: function (cfg) {
      var Tm = T();
      if (Tm && Tm.applyRun) Tm.applyRun(Number(cfg.deposit), Number(cfg.deposit), [], []);
      save(cfg);
    }
  };
})(typeof window !== "undefined" ? window : this);
