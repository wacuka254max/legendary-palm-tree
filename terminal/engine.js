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
  var LEVERAGE = 500;

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
  function marginFor(s, volume, price) {
    return (s.usdBase ? volume * s.size : volume * s.size * price) / LEVERAGE;
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
    volume = Math.round(Number(volume) * 100) / 100;
    if (!(volume >= 0.01)) return "Invalid volume";

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
  function close(ticket) {
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
      openTime: p.time, closeTime: Date.now()
    });
    if (state.deals.length > 200) state.deals.length = 200;
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
      var hit =
        (p.sl && (p.type === "buy" ? out <= p.sl : out >= p.sl)) ||
        (p.tp && (p.tp > 0) && (p.type === "buy" ? out >= p.tp : out <= p.tp));
      if (hit) close(p.ticket);
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
      points: pts,
      percent: s.open24 ? (s.price - s.open24) / s.open24 * 100 : 0,
      time: s.time
    };
  }

  /* ── what the feed hands in ─────────────────────────────────────────── */

  function makeSymbol(d) {
    return {
      name: d.name, digits: d.digits, size: d.size, usdBase: !!d.usdBase,
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
    applySymbols: applySymbols,
    summary: summary,
    positions: function () { return state.positions; },
    deals: function () { return state.deals; },
    profitOf: profitOf,
    open: open, close: close, modify: modify,
    deposit: deposit, setBalance: setBalance,
    leverage: LEVERAGE,
    reset: function () {
      try { localStorage.removeItem(KEY); } catch (e) {}
      state = load();
      save();
    }
  };
})(window);
