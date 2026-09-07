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
  var SYMBOLS = [
    { name: "Volatility 10 Index",  price: 6420.15,  digits: 2, spread: 30,  size: 1,      vol: 9.346e-06 },
    { name: "Volatility 25 Index",  price: 2851.44,  digits: 3, spread: 40,  size: 1,      vol: 2.806e-06 },
    { name: "Volatility 50 Index",  price: 248.9312, digits: 4, spread: 50,  size: 1,      vol: 4.017e-06 },
    { name: "Volatility 75 Index",  price: 118743.6, digits: 2, spread: 120, size: 1,      vol: 2.021e-06 },
    { name: "Volatility 100 Index", price: 1621.88,  digits: 2, spread: 80,  size: 1,      vol: 9.865e-05 },
    { name: "Boom 1000 Index",      price: 12084.55, digits: 3, spread: 90,  size: 1,      vol: 1.490e-06 },
    { name: "Crash 1000 Index",     price: 8455.21,  digits: 3, spread: 90,  size: 1,      vol: 2.129e-06 },
    { name: "Step Index",           price: 9214.7,   digits: 1, spread: 10,  size: 1,      vol: 2.170e-05 },
    { name: "EURUSD",               price: 1.08642,  digits: 5, spread: 8,   size: 100000, vol: 1.473e-05 },
    { name: "GBPUSD",               price: 1.26418,  digits: 5, spread: 11,  size: 100000, vol: 1.740e-05 },
    { name: "USDJPY",               price: 151.284,  digits: 3, spread: 9,   size: 100000, vol: 1.190e-05 },
    { name: "XAUUSD",               price: 2331.46,  digits: 2, spread: 25,  size: 100,    vol: 2.145e-05 }
  ];

  var book = {};
  SYMBOLS.forEach(function (s) {
    book[s.name] = {
      name: s.name, digits: s.digits, size: s.size, vol: s.vol,
      /* `base` is the spread this instrument sits at; `spread` is what it is
         quoting right now, which floats around that base tick by tick. That
         float is the whole reason bid and ask can colour differently: derived
         from one price with a fixed spread they could only ever move together,
         and the app plainly shows one side ticking while the other stands. */
      base: s.spread, spread: s.spread, price: s.price, prev: s.price,
      /* The last value each side actually printed, and which way it went.
         1 up, -1 down, 0 unmoved — read straight into the row's colour. */
      prevBid: 0, prevAsk: 0, bidDir: 0, askDir: 0,
      bidPx: Number((s.price - s.spread * Math.pow(10, -s.digits) / 2).toFixed(s.digits)),
      askPx: Number((s.price + s.spread * Math.pow(10, -s.digits) / 2).toFixed(s.digits)),
      /* What the Quotes row needs beside the pair: where the session opened,
         how far it has been either way since, and when the last tick landed.

         These are seeded as a session ALREADY under way rather than one
         starting at this instant. Opened at the current price they gave every
         row "+0.00%" with a low and a high a hair apart — the walk simply does
         not travel far enough in a sitting to build a day's range, and it
         should not have to. A quote screen is opened onto a market that has
         been trading since before anyone looked at it. */
      open24: 0, low: 0, high: 0, time: Date.now(),
      bars: []
    };

    /* Up to about 1.7% either side of where it stands, with a low and high
       bracketing both ends and a little beyond, the way a real session's
       extremes sit outside its open and its last price. */
    var b = book[s.name];
    var chg = (Math.random() - 0.5) * 0.035;
    var span = s.price * (0.012 + Math.random() * 0.03);
    b.open24 = s.price / (1 + chg);
    b.low = Math.min(s.price, b.open24) - Math.random() * span * 0.6;
    b.high = Math.max(s.price, b.open24) + Math.random() * span * 0.6;
  });

  /* ── candles ─────────────────────────────────────────────────────────────
     Seeded backwards from the current price so a chart opened for the first
     time is not an empty box waiting for sixty ticks to go by. Each bar walks
     the price the same way a tick does, then the series is reversed — which
     leaves the last bar sitting exactly on the live price. */
  function seedBars(s, n) {
    var out = [];
    var c = s.price;
    for (var i = 0; i < n; i++) {
      var o = c * (1 + (Math.random() - 0.5) * s.vol * 9);
      var hi = Math.max(o, c) * (1 + Math.random() * s.vol * 5);
      var lo = Math.min(o, c) * (1 - Math.random() * s.vol * 5);
      out.push({ o: o, h: hi, l: lo, c: c, t: Date.now() - i * 300000 });
      c = o;
    }
    return out.reverse();
  }
  Object.keys(book).forEach(function (n) { book[n].bars = seedBars(book[n], 60); });

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
    /* Prices resume where they stopped. A terminal reopened after lunch does
       not find every instrument back at its opening price. */
    if (s.prices) {
      Object.keys(s.prices).forEach(function (n) {
        if (book[n]) book[n].price = book[n].prev = s.prices[n];
      });
    }
    /* The session travels with the prices. Left behind, a reopened terminal
       showed the day's range collapsed back onto the seed while the price had
       moved on — a low above the last traded price, which is not a range. */
    if (s.session) {
      Object.keys(s.session).forEach(function (n) {
        var v = s.session[n];
        if (!book[n] || !v) return;
        book[n].open24 = v.o; book[n].low = v.l; book[n].high = v.h;
      });
    }
    return s;
  }

  function save() {
    state.prices = {};
    state.session = {};
    Object.keys(book).forEach(function (n) {
      state.prices[n] = book[n].price;
      state.session[n] = { o: book[n].open24, l: book[n].low, h: book[n].high };
    });
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
  }

  state = load();

  /* ── prices ─────────────────────────────────────────────────────────────
     A random walk with a gaussian-ish step, per instrument, at its own
     volatility. Not a model of anything — just a tape that moves the way a
     tape moves, so a position's profit changes while you watch it.

     The step used to be far too big: EURUSD moved 13 points every 0.7s, which
     is over a hundred pips a minute, and — more visibly — nearly twice its own
     spread on every tick. A mid that jumps further than the spread drags bid
     and ask along together every time, and the measured correlation between
     the two sides was 0.95: they could not disagree, so the Quotes column sat
     in one colour. A real tick is a fraction of the spread, which is exactly
     why the app's own screen shows the two sides flickering apart. */

  var barTicks = 0;

  function step() {
    Object.keys(book).forEach(function (n) {
      var s = book[n];
      var g = (Math.random() + Math.random() + Math.random() - 1.5) * 2;

      /* Both sides as they stand, before anything moves. Comparing ROUNDED
         prints rather than raw prices is the point: a move too small to change
         the digits on screen has not moved on screen either, and that is what
         leaves a price sitting grey while its partner ticks. */
      s.prevBid = bid(s);
      s.prevAsk = ask(s);

      s.prev = s.price;
      s.price = Math.max(point(s), s.price * (1 + g * s.vol));

      /* The spread breathes — most ticks, not every one. A broker's quote does
         this, and it is what lets the two sides diverge: a widening spread can
         carry the ask up while the bid falls. Never below a point. */
      if (Math.random() < 0.7) {
        s.spread = Math.max(1, Math.round(s.base * (0.7 + Math.random() * 0.6)));
      }

      /* The mid has moved and the spread has breathed; now each side is quoted
         around that mid with its own independent jitter. This is what makes the
         column behave: the two are no longer the same number twice, so one can
         print unchanged while the other ticks, and they disagree as often as
         they agree. Never crossed — an ask below its bid is not a market. */
      var pt = point(s), half = s.spread * pt / 2;
      /* Each side is quoted its OWN distance out from the mid, drawn fresh.
         Jittering the two prices symmetrically was the obvious way to do this
         and it was wrong: the draws crossed often, and clamping the ask back
         above the bid tied the two together again — which is why widening the
         jitter kept hitting a ceiling instead of decorrelating them. Pushing
         each side outward from the mid cannot cross at all, so both stay free. */
      /* Mean 1.0 so the spread averages exactly what the instrument quotes —
         an earlier draw averaged 1.25 and quietly widened every spread by a
         quarter, which is a real cost to every trade, not a cosmetic one. The
         floor keeps a market that always has a spread worth crossing. */
      var out = function () { return half * (0.25 + Math.random() * 1.5); };
      s.bidPx = round(s, s.price - out());
      s.askPx = round(s, s.price + out());

      var nb = bid(s), na = ask(s);
      s.bidDir = nb > s.prevBid ? 1 : nb < s.prevBid ? -1 : 0;
      s.askDir = na > s.prevAsk ? 1 : na < s.prevAsk ? -1 : 0;

      s.time = Date.now();
      if (s.price > s.high) s.high = s.price;
      if (s.price < s.low) s.low = s.price;

      /* The last bar tracks the live price; a new one starts every so often,
         which is what makes the chart advance rather than only wobble. */
      var bar = s.bars[s.bars.length - 1];
      if (bar) {
        bar.c = s.price;
        if (s.price > bar.h) bar.h = s.price;
        if (s.price < bar.l) bar.l = s.price;
      }
    });

    if (++barTicks >= 12) {
      barTicks = 0;
      Object.keys(book).forEach(function (n) {
        var s = book[n];
        s.bars.push({ o: s.price, h: s.price, l: s.price, c: s.price, t: Date.now() });
        if (s.bars.length > 90) s.bars.shift();
      });
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
    return Math.round(diff * p.volume * s.size * 100) / 100;
  }

  function marginOf(p) {
    var s = book[p.symbol];
    if (!s) return 0;
    return (p.volume * s.size * p.open) / LEVERAGE;
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
    var need = (volume * s.size * price) / LEVERAGE;
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

  global.EvieTerminal = {
    symbols: function () { return Object.keys(book).map(function (n) { return book[n]; }); },
    quote: function (n) { return quote(book[n]); },
    quotes: function () { return Object.keys(book).map(function (n) { return quote(book[n]); }); },
    bars: function (n) { return (book[n] || { bars: [] }).bars; },
    symbol: function (n) { return book[n]; },
    bid: bid, ask: ask, point: point, round: round,
    step: step,
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
