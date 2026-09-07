/**
 * UPTICK — the terminal's account.
 *
 * A MetaTrader 5 account with nothing behind it but this file: no Expert
 * Advisor, no broker, no socket. Prices are generated here, orders are filled
 * here, and the money is a number in localStorage.
 *
 * It is written to behave the way MT5 actually behaves rather than the way a
 * mock usually does, because the arithmetic IS the product here — somebody
 * learning the platform on this should not have to unlearn anything when they
 * open the real one:
 *
 *   · A buy fills at the ASK and is valued at the BID; a sell is the reverse.
 *     That is why every position opens showing a small loss, which is the
 *     spread, and it is the first thing a new trader asks about.
 *   · Profit is (close - open) x volume x contract size, signed by direction.
 *   · Equity is balance plus floating profit. Free margin is equity minus
 *     margin. Margin level is equity over margin as a percentage, and it is
 *     blank rather than infinite when nothing is open.
 *   · Stop loss and take profit are checked against the price the position
 *     would CLOSE at, not the one it opened at.
 *
 * Everything persists. Positions survive a reload the way they survive closing
 * the app on a phone, and prices carry on from where they were rather than
 * snapping back to a seed.
 */

(function (global) {
  "use strict";

  var KEY = "evie_terminal";
  var LEVERAGE = 400;

  /* The account's leverage. MT5 has two and uses the tighter of them: the
     account's, set by the broker, and the instrument's own cap. An account at
     1:400 does not get 1:6000 on Volatility 5 because the symbol allows it —
     the account is the ceiling. Margin here is worked out against whichever
     binds. */
  var accountLeverage = LEVERAGE;

  /* The instruments, with the two numbers that decide everything: how many
     decimals a price carries, and how much one lot is worth. Volatility
     indices are one-contract-per-lot; the currency pairs use the standard
     100,000 units. Spreads are in points, as a broker quotes them. */
  /* ── the instruments ────────────────────────────────────────────────────
     Nothing here is invented. The list, both sides of every price, the spread
     between them and the day's range all arrive from Deriv's public market
     feed — see feed.js. This file holds them and prices positions against them.

     There was a seeded table of twelve made-up instruments here, walked by a
     random number generator, with the spread modelled because the older API
     gave only a single quote. The public feed gives a real bid and a real ask
     on every tick, so all of that is gone: there is nothing left to model.

     Contract size is the one assumption remaining, and it has to be. A lot is
     an MT5 notion and Deriv's API has no field for it, so it is assigned by
     instrument in feed.js and marked there as the assumption it is. */

  var book = {};

  function point(sym) { return Math.pow(10, -sym.digits); }
  function round(sym, v) { return Number(v.toFixed(sym.digits)); }

  /* Both sides are QUOTED values now, held on the symbol, rather than one price
     with a constant added to it.
     That was the flaw behind the flat-looking Quotes screen: bid was the mid
     itself, so it never saw the spread, and ask was bid plus a fixed number.
     Two numbers moving in lockstep can only ever be coloured the same, which is
     not what the app shows — it shows one side ticking while the other sits, and
     the two disagreeing constantly. They do that because a real bid and a real
     ask are quoted separately, so here they are too. */
  function bid(sym) { return sym.bidPx; }
  function ask(sym) { return sym.askPx; }

  /* ── the money ──────────────────────────────────────────────────────────
     Seeded once from the balance the rest of the site remembers, so the first
     visit does not open on a round thousand nobody chose. After that it is its
     own account: an MT5 balance is not the options balance, and trading here
     must not move a figure the other pages are showing. */

  var state = null;

  function seedBalance() {
    try {
      var c = JSON.parse(localStorage.getItem("evie_sim_setup") || "null");
      var v = c && c.balance != null ? Number(c.balance) : null;
      if (v != null && isFinite(v) && v > 0) return Math.round(v * 100) / 100;
    } catch (e) {}
    return 1000;
  }

  function load() {
    var s = null;
    try { s = JSON.parse(localStorage.getItem(KEY) || "null"); } catch (e) {}
    if (!s || typeof s.balance !== "number") {
      /* A funded account has a deposit behind it. Without one History shows
         "Deposit 0.00" beside a balance of a hundred thousand, and no opening
         line — which is not what an account that has been funded looks like. */
      var opening = seedBalance();
      s = { balance: opening, positions: [], deals: [], ticket: 100000000, prices: null };
      s.deals.push({
        ticket: ++s.ticket, symbol: "", type: "balance", volume: 0,
        open: 0, close: 0, profit: opening,
        openTime: Date.now(), closeTime: Date.now()
      });
    }
    s.positions = s.positions || [];
    s.deals = s.deals || [];
    /* Prices are no longer carried across a reload, and must not be: they
       come from the market now, and a saved price is a stale one. Only the
       account travels — the balance, the open positions and the deals. */
    return s;
  }

  function save() {
    /* Written by an earlier version that cached the tape. Left in place they
       would be reloaded forever, so they are cleared on the first save. */
    if (state.prices || state.session) { delete state.prices; delete state.session; }
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
  }

  state = load();

  /* ── prices ─────────────────────────────────────────────────────────────
     A tick is applied exactly as the market sent it. Both sides are compared
     against what THIS side last printed, which is what colours a quote: blue
     up, red down, and neither when it did not move. They disagree constantly
     because a real bid and a real ask are quoted separately. */

  function tick(name, b, a, q) {
    var s = book[name];
    if (!s) return;
    if (!isFinite(b) || !isFinite(a) || b <= 0 || a <= 0) return;

    s.prevBid = s.bidPx;
    s.prevAsk = s.askPx;
    s.bidPx = b;
    s.askPx = a;
    s.prev = s.price;
    s.price = isFinite(q) && q > 0 ? q : (b + a) / 2;

    s.bidDir = b > s.prevBid ? 1 : b < s.prevBid ? -1 : 0;
    s.askDir = a > s.prevAsk ? 1 : a < s.prevAsk ? -1 : 0;
    /* The figure beside the clock is the real distance between the two prices
       on the row, in this instrument's points. */
    s.spread = Math.max(0, Math.round((a - b) / point(s)));
    s.time = Date.now();

    if (s.price > s.high) s.high = s.price;
    if (s.price < s.low) s.low = s.price;

    var bar = s.bars[s.bars.length - 1];
    if (bar) {
      bar.c = s.price;
      if (s.price > bar.h) bar.h = s.price;
      if (s.price < bar.l) bar.l = s.price;
    }

    sweep();
    save();
  }

  /* ── positions ──────────────────────────────────────────────────────────
     Profit in account currency. `size` carries the instrument: one lot of
     EURUSD is 100,000 units, one lot of a Volatility index is one contract,
     and that single number is the whole difference between the two. */

  function profitOf(p) {
    var s = book[p.symbol];
    if (!s) return 0;
    var now = p.type === "buy" ? bid(s) : ask(s);
    var diff = p.type === "buy" ? now - p.open : p.open - now;
    var v = diff * p.volume * s.size;
    /* USDJPY is quoted in yen, so a move of it earns YEN, and the account is
       in dollars. Without this a 1.5-pip move on one lot showed as $1,500
       instead of $10 — the yen figure printed straight onto a dollar balance.
       Everything else here is quoted in dollars already. */
    if (s.usdBase) v /= now;
    return Math.round(v * 100) / 100;
  }

  /* Margin is the position's size in its BASE currency, converted to the
     account's. For EURUSD the base is euros and the rate does that; for USDJPY
     the base is already dollars, so the rate must not be applied.

     One function, because there were two: open() carried its own copy of this
     formula to decide whether an order could be afforded, and it did not learn
     the USDJPY case when marginOf did. The order was then refused for want of
     margin it would never actually have used. */
  /**
   * Volume held to what this instrument actually accepts.
   *
   * Deriv publishes a minimum and a maximum per instrument and they are not
   * alike: Volatility 50 starts at 4 lots, Volatility 25 (1s) at 0.005, gold at
   * 0.01. It does not publish a step, but the minimum is the step — a minimum
   * of 0.005 could not be expressed on a 0.01 step at all, which is what makes
   * those varied figures (0.005, 0.05, 0.2, 4, 10) the grid rather than
   * arbitrary floors.
   *
   * Everything here used to be `Math.round(v * 100) / 100` against a flat floor
   * of 0.01, which was wrong three ways at once: it let 0.10 lots of an
   * instrument whose minimum is 4 through, it rounded a 0.005 minimum up to
   * 0.01, and it never looked at the maximum at all.
   */
  function stepOf(s) { return s && s.minVol > 0 ? s.minVol : 0.01; }

  function snapVolume(s, v) {
    var step = stepOf(s);
    v = Number(v);
    if (!isFinite(v) || v <= 0) return null;
    v = Math.round(v / step) * step;
    if (v < step) v = step;
    var max = s.maxVol || Infinity;
    if (v > max) v = Math.floor(max / step) * step;
    /* Snapping leaves a float tail: 0.30000000000000004 lots is not a size. */
    return Number(v.toFixed(6));
  }

  /** As many decimals as the step has, so 0.005 does not print as 0.01. */
  function volDigits(s) {
    var t = String(stepOf(s)), i = t.indexOf(".");
    return i < 0 ? 0 : t.length - i - 1;
  }

  function marginFor(s, volume, price) {
    var lev = Math.min(accountLeverage || LEVERAGE, s.leverage || LEVERAGE);
    /* Notional in the account's currency, over the leverage that binds.
       For EURUSD the base is euros and the rate converts it; for USDJPY the
       base is already dollars, so the rate must not be applied. */
    return (s.usdBase ? volume * s.size : volume * s.size * price) / lev;
  }

  function marginOf(p) {
    var s = book[p.symbol];
    if (!s) return 0;
    return marginFor(s, p.volume, p.open);
  }

  function summary() {
    var floating = 0, margin = 0;
    state.positions.forEach(function (p) {
      floating += profitOf(p);
      margin += marginOf(p);
    });
    var equity = Math.round((state.balance + floating) * 100) / 100;
    margin = Math.round(margin * 100) / 100;
    return {
      balance: state.balance,
      equity: equity,
      margin: margin,
      free: Math.round((equity - margin) * 100) / 100,
      /* MT5 shows nothing at all when no position is open, rather than a
         division by zero dressed up as a percentage. */
      level: margin > 0 ? Math.round((equity / margin) * 10000) / 100 : null,
      floating: Math.round(floating * 100) / 100
    };
  }

  /** Open at the market. Returns the position, or a string if it was refused. */
  function open(symbolName, type, volume, sl, tp) {
    var s = book[symbolName];
    if (!s) return "Invalid request";
    var asked = Number(volume);
    volume = snapVolume(s, asked);
    if (volume === null) return "Invalid volume";
    /* Deriv refuses a size outside the instrument's range rather than quietly
       trimming it, and so does this. */
    if (asked < s.minVol - 1e-9) return "Invalid volume";
    if (asked > (s.maxVol || Infinity) + 1e-9) return "Invalid volume";

    var price = type === "buy" ? ask(s) : bid(s);
    var need = marginFor(s, volume, price);
    /* The real terminal's wording, and the real rule: free margin, not
       balance, is what has to cover it. */
    if (need > summary().free) return "No money";

    var p = {
      ticket: ++state.ticket,
      symbol: symbolName,
      type: type,
      volume: volume,
      open: price,
      sl: sl ? Number(sl) : 0,
      tp: tp ? Number(tp) : 0,
      time: Date.now()
    };
    state.positions.push(p);
    save();
    return p;
  }

  /** Close at the market, bank the profit, and file the deal in History. */
  /**
   * @param why "sl" if a stop loss took it, "tp" if a take profit did,
   *            "" when it was closed by hand. The history marks its rows with
   *            this, and there is no way to work it out afterwards: once the
   *            position is gone, a close price sitting on the stop is
   *            indistinguishable from one that happened to land there.
   */
  /* Comfortably past the longest run the simulator will write (500), so the
     trim below never bites during ordinary use. At the cap it would still shed
     the oldest trade while the balance went on counting it, and the column
     would be a trade out. */
  var MAX_DEALS = 1000;

  /**
   * Hold the history to a length, without ever dropping the deposit.
   *
   * This was `state.deals.length = 200`, which cuts from the END — and the
   * deposit line sits at the end, because the list runs newest first. Any close
   * on a history longer than two hundred therefore threw away the deposit and
   * three hundred trades while the balance kept counting them, and History's
   * own figures stopped agreeing with the account: 659.01 against 11,151.06 in
   * the case that found it. The balance lines are what the column is footed on,
   * so they are the one thing that cannot be trimmed.
   */
  function trimDeals() {
    if (state.deals.length <= MAX_DEALS) return;
    var keep = [], money = [];
    state.deals.forEach(function (d) {
      if (d.type === "balance") money.push(d);
      else if (keep.length < MAX_DEALS - 1) keep.push(d);
    });
    state.deals = keep.concat(money);
  }

  function close(ticket, why) {
    var i = -1;
    state.positions.forEach(function (p, k) { if (p.ticket === ticket) i = k; });
    if (i < 0) return null;

    var p = state.positions[i];
    var s = book[p.symbol];
    var out = p.type === "buy" ? bid(s) : ask(s);
    var profit = profitOf(p);

    state.balance = Math.round((state.balance + profit) * 100) / 100;
    state.positions.splice(i, 1);
    state.deals.unshift({
      ticket: p.ticket, symbol: p.symbol, type: p.type, volume: p.volume,
      open: p.open, close: out, profit: profit,
      reason: why || "",
      openTime: p.time, closeTime: Date.now()
    });
    trimDeals();
    save();
    return profit;
  }

  function modify(ticket, sl, tp) {
    state.positions.forEach(function (p) {
      if (p.ticket !== ticket) return;
      p.sl = sl ? Number(sl) : 0;
      p.tp = tp ? Number(tp) : 0;
    });
    save();
  }

  /* Stop loss and take profit, checked against the price the position would
     close at — the bid for a buy, the ask for a sell. Checking against the
     other side is the classic mock's mistake and it makes stops fire early. */
  function sweep() {
    state.positions.slice().forEach(function (p) {
      var s = book[p.symbol];
      if (!s) return;
      var out = p.type === "buy" ? bid(s) : ask(s);
      var sl = p.sl && (p.type === "buy" ? out <= p.sl : out >= p.sl);
      var tp = p.tp && p.tp > 0 && (p.type === "buy" ? out >= p.tp : out <= p.tp);
      /* Both at once is possible on a gap. The stop wins, because that is the
         side the account cannot afford to have guessed wrong. */
      if (sl) close(p.ticket, "sl");
      else if (tp) close(p.ticket, "tp");
    });
  }

  function deposit(amount) {
    amount = Math.round(Number(amount) * 100) / 100;
    if (!isFinite(amount)) return;
    state.balance = Math.round((state.balance + amount) * 100) / 100;
    state.deals.unshift({
      ticket: ++state.ticket, symbol: "", type: "balance", volume: 0,
      open: 0, close: 0, profit: amount, openTime: Date.now(), closeTime: Date.now()
    });
    save();
  }

  function setBalance(v) {
    v = Math.round(Number(v) * 100) / 100;
    if (!isFinite(v) || v < 0) return;
    state.balance = v;
    save();
  }

  /** Everything a Quotes row shows, computed rather than stored. */
  function quote(s) {
    var pts = Math.round((s.price - s.open24) / point(s));
    return {
      name: s.name, digits: s.digits,
      /* The figure printed beside the clock is the distance between the two
         prices actually on the row, not the nominal spread they were quoted
         around — otherwise the number contradicts the pair above it. */
      spread: Math.max(1, Math.round((ask(s) - bid(s)) / point(s))),
      bid: bid(s), ask: ask(s),
      bidDir: s.bidDir, askDir: s.askDir,
      low: round(s, s.low), high: round(s, s.high),
      isOpen: s.isOpen !== false,
      points: pts,
      percent: s.open24 ? (s.price - s.open24) / s.open24 * 100 : 0,
      time: s.time
    };
  }

  /* ── what the feed hands in ─────────────────────────────────────────── */

  function makeSymbol(d) {
    return {
      name: d.name, digits: d.digits, size: d.size, usdBase: !!d.usdBase,
      /* Deriv's own figures for this instrument — see specs.js. Leverage is
         per-symbol, not one number for the account: 1:1000 on EURUSD, 1:800 on
         gold, 1:4000 on Volatility 25 (1s). */
      leverage: d.leverage || LEVERAGE,
      minVol: d.minVol || 0.01, maxVol: d.maxVol || 100,
      swapLong: d.swapLong || 0, swapShort: d.swapShort || 0,
      /* Whether its exchange is trading. A closed market still shows — with
         the last price it had — but it sorts below the ones that are moving. */
      isOpen: d.isOpen !== false,
      price: d.quote, prev: d.quote,
      bidPx: d.bid, askPx: d.ask,
      prevBid: d.bid, prevAsk: d.ask, bidDir: 0, askDir: 0,
      spread: Math.max(0, Math.round((d.ask - d.bid) * Math.pow(10, d.digits))),
      /* Replaced by the real day candle the moment it lands; until then the
         row simply reads no change rather than inventing one. */
      open24: d.quote, low: d.quote, high: d.quote,
      time: Date.now(), bars: []
    };
  }

  /**
   * Adopt the instruments the feed is carrying.
   *
   * Any symbol holding an open position is KEPT whatever the feed says. A
   * position whose instrument vanished would price at zero and silently wipe
   * its own profit, and closing it would write that zero into the balance — so
   * the book only ever grows to meet the feed, never drops something the
   * account is standing in.
   */
  function applySymbols(defs) {
    if (!defs || !defs.length) return;
    var held = {};
    state.positions.forEach(function (p) { held[p.symbol] = true; });

    var next = {};
    defs.forEach(function (d) {
      if (!d || !d.name || !isFinite(d.bid) || !isFinite(d.ask)) return;
      next[d.name] = book[d.name] || makeSymbol(d);
    });
    Object.keys(book).forEach(function (n) {
      if (held[n] && !next[n]) next[n] = book[n];
    });
    if (!Object.keys(next).length) return;
    book = next;
  }

  /**
   * Correct an instrument's precision to what its quotes actually carry.
   *
   * Deriv's declared pip_size is not always the number of decimals it quotes:
   * ETHUSD declares five and has never sent more than three, so the price read
   * 2494.00500 — two of those digits were padding, and the spread came out as
   * 58,000 points instead of 580. Every other instrument measured matched its
   * declaration exactly, so this only ever fires where the feed disagrees with
   * itself. Raising only: a price that has shown five decimals has five.
   */
  function setDigits(name, d) {
    var s = book[name];
    if (!s || !(d >= 0 && d <= 8) || d === s.digits) return;
    s.digits = d;
    s.spread = Math.max(0, Math.round((s.askPx - s.bidPx) / point(s)));
  }

  /**
   * Replace the account with a simulated run.
   *
   * The deposit goes in as the opening balance line, exactly as a funded
   * account shows it, and the trades follow. Open positions are cleared: a run
   * is a finished history, and leaving a live position priced against it would
   * mix a simulated balance with a real floating one.
   */
  function applyRun(deposit, balance, deals, opens) {
    state.positions = [];
    state.balance = Math.round(Number(balance) * 100) / 100;
    state.deals = (deals || []).slice(0, MAX_DEALS - 1);
    state.deals.push({
      ticket: ++state.ticket, symbol: "", type: "balance", volume: 0,
      open: 0, close: 0, profit: Math.round(Number(deposit) * 100) / 100,
      openTime: Date.now(), closeTime: Date.now()
    });
    state.deals.forEach(function (d) { if (!d.ticket) d.ticket = ++state.ticket; });
    trimDeals();

    /* The open positions go through open() like any other order: filled at the
       live ask or bid, refused if the free margin will not carry them. Writing
       them straight into the list would have let a run stand a position the
       account could not afford, and priced it at a figure nobody quoted. */
    (opens || []).forEach(function (o) {
      var p = open(o.symbol, o.type, o.volume);
      if (typeof p !== "object" || !p) return;

      /* Filled at the live price above, then moved back to where it was
         actually entered. The entry is worked out from the profit it should be
         showing NOW against the price it would close at now — so the position
         is consistent with the tape rather than decorated on top of it, and
         from here the engine prices it like any other. */
      var s2 = book[o.symbol];
      if (s2 && o.profit != null) {
        var out = o.type === "buy" ? bid(s2) : ask(s2);
        var per = p.volume * s2.size;
        if (per > 0) {
          var diff = o.profit / per;
          if (s2.usdBase) diff = diff * out;
          var entry = o.type === "buy" ? out - diff : out + diff;
          if (entry > 0) p.open = round(s2, entry);
        }
      }
      if (o.time) p.time = o.time;
    });
    save();
  }

  /** Deriv's word on whether this market is currently trading. */
  function setOpen(name, on) {
    var s = book[name];
    if (s) s.isOpen = !!on;
  }

  /** The day's open, low and high, from Deriv's own daily candle. */
  function setSession(name, o, l, h) {
    var s = book[name];
    if (!s || !isFinite(o) || o <= 0) return;
    s.open24 = o;
    s.low = isFinite(l) && l > 0 ? Math.min(l, s.price) : s.low;
    s.high = isFinite(h) && h > 0 ? Math.max(h, s.price) : s.high;
  }

  /** Candles straight from the feed, oldest first. */
  function setBars(name, bars) {
    var s = book[name];
    if (!s || !bars || !bars.length) return;
    s.bars = bars.slice(-90).map(function (b) {
      return { o: +b.o, h: +b.h, l: +b.l, c: +b.c, t: +b.t };
    });
  }

  global.EvieTerminal = {
    symbols: function () { return Object.keys(book).map(function (n) { return book[n]; }); },
    quote: function (n) { return quote(book[n]); },
    quotes: function () { return Object.keys(book).map(function (n) { return quote(book[n]); }); },
    bars: function (n) { return (book[n] || { bars: [] }).bars; },
    symbol: function (n) { return book[n]; },
    bid: bid, ask: ask, point: point, round: round,
    tick: tick, setBars: setBars, setSession: setSession,
    applySymbols: applySymbols, setOpen: setOpen, setDigits: setDigits,
    applyRun: applyRun,
    summary: summary,
    positions: function () { return state.positions; },
    deals: function () { return state.deals; },
    profitOf: profitOf,
    open: open, close: close, modify: modify,
    deposit: deposit, setBalance: setBalance,
    leverage: function () { return accountLeverage; },
    setLeverage: function (n) {
      n = Number(n);
      if (isFinite(n) && n > 0) accountLeverage = Math.round(n);
    },
    /* What actually binds for this instrument, which is the tighter of the two. */
    leverageFor: function (name) {
      var s = book[name];
      return s ? Math.min(accountLeverage, s.leverage || accountLeverage) : accountLeverage;
    },
    snapVolume: snapVolume, stepOf: stepOf, volDigits: volDigits,
    specOf: function (n) { return book[n] || null; },
    reset: function () {
      try { localStorage.removeItem(KEY); } catch (e) {}
      state = load();
      save();
    }
  };
})(window);
