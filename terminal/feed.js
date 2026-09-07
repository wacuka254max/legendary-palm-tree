/**
 * UPTICK — the terminal's market data.
 *
 * Every price on every screen comes from Deriv, over the public market socket:
 *
 *     wss://api.derivws.com/trading/v1/options/ws/public
 *
 * No OTP, no token, no account. That matters more than it sounds: an earlier
 * draft of this file went through the connected account's trading socket,
 * because the older API's tick stream carried a single `quote` and no sides,
 * and because the endpoint it used refuses an OIDC app id. Both problems belong
 * to that older API. This one hands over a real `bid` and a real `ask` on every
 * tick, to anyone, unauthenticated — so the terminal shows the actual market
 * whether or not anybody has connected anything.
 *
 * What arrives, and what is done with it:
 *
 *   · `active_symbols` names the instruments and gives each one its pip size.
 *   · `ticks` streams bid, ask and quote. The engine takes those unaltered;
 *     nothing about a price is modelled here or anywhere else.
 *   · A daily candle gives each row its true open, low and high.
 *   · Five-minute candles feed the chart, and `ohlc` keeps the last one live.
 *
 * The one thing Deriv does not have is a lot size — that is an MT5 notion with
 * no field in this API — so contract sizes are assigned by instrument below and
 * are the only assumption left in the whole price path.
 */

(function (global) {
  "use strict";

  var URL = "wss://api.derivws.com/trading/v1/options/ws/public";
  var MAX_SYMBOLS = 24;      // a Quotes screen, not a data warehouse
  var DEAD_AFTER = 45000;    // a socket can stay open and go quiet
  var M5 = 300, DAY = 86400;

  var ws = null, closed = false, attempt = 0;
  var watchdog = null, pinger = null, lastTickAt = 0;
  var meta = {};             // deriv symbol -> its active_symbols entry
  var named = {};            // deriv symbol -> the name we show
  var defs = {};             // our name -> definition handed to the engine
  var candleFor = null;
  var onChange = null;

  var T = function () { return global.EvieTerminal; };

  /* ── naming ───────────────────────────────────────────────────────────
     MT5 writes XAGUSD, not "Silver/USD"; and "Volatility 75 (1s) Index", not
     1HZ75V. Deriv gives the first as a prefixed symbol and the second as its
     display name, so each is taken from wherever it is already right. */
  function nameOf(sym, display) {
    var m = /^(?:frx|cry|WLD)(.+)$/.exec(sym);
    return m ? m[1] : (display || sym);
  }

  /* MT5's standard contract sizes. Deriv has no field for this, so it is the
     one assumption in the price path. Getting one wrong scales that
     instrument's profit by the error and nothing else, which is why they sit
     in a single table rather than scattered through the code. */
  function contract(sym, market) {
    if (/XAU/.test(sym)) return 100;      // gold: 100 troy ounces
    if (/XAG/.test(sym)) return 5000;     // silver: 5,000
    if (/XPT|XPD/.test(sym)) return 100;  // platinum, palladium
    if (market === "forex") return 100000;
    return 1;                             // synthetics and crypto trade in units
  }

  function digitsOf(pip) {
    var d = Math.round(-Math.log(Number(pip)) / Math.LN10);
    return d >= 0 && d <= 8 ? d : 5;
  }

  /* Synthetics first: they never close, so at the weekend they are the only
     thing with a moving price on the screen. Then metals, forex, the rest —
     and within a group, whatever is most traded. */
  function rank(a) {
    if (a.market === "synthetic_index") return 0;
    if (a.submarket === "metals") return 1;
    if (a.market === "forex") return 2;
    return 3;
  }

  /**
   * A screen with every market on it, taken a few at a time from each in turn.
   *
   * Sorting by rank and slicing filled all twenty-four rows with synthetics,
   * because Deriv has forty-six of them open against four commodities. That is
   * not merely unbalanced, it is the wrong picture: a synthetic index is quoted
   * on a FIXED spread, so its bid and ask move in lockstep and the column sits
   * in one colour. The instruments whose two sides disagree — metals, forex,
   * crypto — were the ones being crowded out. Measured over eighteen seconds:
   * one distinct spread on every synthetic, four to fifteen on the others.
   */
  function choose(list) {
    var groups = [[], [], [], []];
    list.filter(function (a) {
      return a && a.underlying_symbol && a.pip_size &&
        a.exchange_is_open && !a.is_trading_suspended;
    }).sort(function (x, y) {
      return (y.trade_count || 0) - (x.trade_count || 0);
    }).forEach(function (a) { groups[rank(a)].push(a); });

    var out = [], i = 0;
    while (out.length < MAX_SYMBOLS) {
      var took = false;
      for (var g = 0; g < groups.length; g++) {
        if (groups[g][i] && out.length < MAX_SYMBOLS) { out.push(groups[g][i]); took = true; }
      }
      if (!took) break;
      i++;
    }
    return out;
  }

  /* ── the socket ───────────────────────────────────────────────────────── */

  function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }

  function open() {
    ws = new WebSocket(URL);

    ws.onopen = function () {
      attempt = 0;
      lastTickAt = Date.now();
      send({ active_symbols: "brief" });

      clearInterval(watchdog);
      watchdog = setInterval(function () {
        if (closed || !ws) return;
        if (Date.now() - lastTickAt > DEAD_AFTER) {
          try { ws.close(); } catch (e) {}   // onclose reconnects
        }
      }, 10000);

      clearInterval(pinger);
      pinger = setInterval(function () { send({ ping: 1 }); }, 25000);
    };

    ws.onmessage = function (ev) {
      var d;
      try { d = JSON.parse(ev.data); } catch (e) { return; }
      /* An instrument this socket will not serve simply never appears. There is
         nothing the person looking at the screen can do about it. */
      if (d.error) return;

      if (d.msg_type === "active_symbols" && d.active_symbols) {
        meta = {}; named = {};
        choose(d.active_symbols).forEach(function (a) {
          meta[a.underlying_symbol] = a;
          named[a.underlying_symbol] = nameOf(a.underlying_symbol, a.underlying_symbol_name);
          send({ ticks: a.underlying_symbol, subscribe: 1 });
        });
        return;
      }

      if (d.msg_type === "tick" && d.tick) {
        lastTickAt = Date.now();
        var t = d.tick;
        var sym = t.symbol;
        var n = named[sym];
        var m = meta[sym];
        if (!n || !m || !T()) return;

        var b = Number(t.bid), a = Number(t.ask);
        if (!isFinite(b) || !isFinite(a) || b <= 0 || a <= 0) return;

        /* The first tick for an instrument is what defines it — it is the only
           message carrying both sides, and a definition without them would have
           to guess a spread. */
        if (!defs[n]) {
          defs[n] = {
            name: n,
            digits: isFinite(t.pip_size) ? Number(t.pip_size) : digitsOf(m.pip_size),
            size: contract(sym, m.market),
            usdBase: /^frxUSD/.test(sym),
            bid: b, ask: a, quote: Number(t.quote)
          };
          T().applySymbols(Object.keys(defs).map(function (k) { return defs[k]; }));
          /* Its true day open, low and high — not the first price seen. */
          send({
            ticks_history: sym, end: "latest", count: 1,
            style: "candles", granularity: DAY
          });
          if (onChange) onChange();
        }

        T().tick(n, b, a, Number(t.quote));
        return;
      }

      if (d.msg_type === "candles" && d.candles && T()) {
        var cs = d.echo_req && d.echo_req.ticks_history;
        var g = d.echo_req && d.echo_req.granularity;
        var cn = named[cs];
        if (!cn) return;

        if (g === DAY) {
          var day = d.candles[d.candles.length - 1];
          if (day) T().setSession(cn, +day.open, +day.low, +day.high);
          return;
        }
        T().setBars(cn, d.candles.map(function (c) {
          return { o: +c.open, h: +c.high, l: +c.low, c: +c.close, t: c.epoch * 1000 };
        }));
        if (onChange) onChange();
        return;
      }

      /* The five-minute candle still forming. */
      if (d.msg_type === "ohlc" && d.ohlc && T()) {
        var on = named[d.ohlc.symbol];
        var bars = on && T().bars(on);
        if (!bars || !bars.length) return;
        var t2 = d.ohlc.open_time * 1000;
        var next = { o: +d.ohlc.open, h: +d.ohlc.high, l: +d.ohlc.low, c: +d.ohlc.close, t: t2 };
        if (bars[bars.length - 1].t === t2) bars[bars.length - 1] = next;
        else { bars.push(next); if (bars.length > 90) bars.shift(); }
      }
    };

    ws.onclose = function () {
      clearInterval(watchdog); clearInterval(pinger);
      ws = null;
      if (!closed) retry();
    };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  }

  function retry() {
    attempt++;
    setTimeout(function () { if (!closed) open(); },
      Math.min(1000 * Math.pow(2, attempt - 1), 8000));
  }

  /* ── out ──────────────────────────────────────────────────────────────── */

  global.EvieFeed = {
    /** @param cb called when the instrument list or the candles change. */
    start: function (cb) { onChange = cb || null; closed = false; open(); },

    /** The chart moved; ask for that instrument's five-minute candles. */
    chart: function (name) {
      if (!name || candleFor === name) return;
      candleFor = name;
      var sym = null;
      Object.keys(named).forEach(function (k) { if (named[k] === name) sym = k; });
      if (!sym) return;
      send({
        ticks_history: sym, end: "latest", count: 90,
        style: "candles", granularity: M5, subscribe: 1
      });
    },

    connected: function () { return !!(ws && ws.readyState === 1); },

    stop: function () {
      closed = true;
      clearInterval(watchdog); clearInterval(pinger);
      if (ws) { try { ws.close(); } catch (e) {} }
    }
  };
})(typeof window !== "undefined" ? window : this);
