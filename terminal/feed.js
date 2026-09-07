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
  var DEAD_AFTER = 45000;    // a socket can stay open and go quiet
  var M5 = 300, DAY = 86400;

  var ws = null, closed = false, attempt = 0;
  var watchdog = null, pinger = null, lastTickAt = 0;
  var meta = {};             // deriv symbol -> its active_symbols entry
  var named = {};            // deriv symbol -> the name we show
  var defs = {};             // our name -> definition handed to the engine
  var candleFor = null;
  var onChange = null;
  var askedAt = 0, asking = null;
  var order = [];            // the names in the order the feed chose them
  var resync = null;

  /* The definitions in that order, so the book is built the way the screen
     should read: everything trading first. */
  function ordered() {
    var seen = {}, out = [];
    order.forEach(function (n) { if (defs[n] && !seen[n]) { seen[n] = 1; out.push(defs[n]); } });
    Object.keys(defs).forEach(function (n) { if (!seen[n]) out.push(defs[n]); });
    return out;
  }

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
  /**
   * Deriv's published figures for an instrument, or a fallback shaped like
   * them.
   *
   * These used to be guessed from the market — gold 100, forex 100,000 and so
   * on — which was right often enough to be misleading. Deriv publishes the
   * real table and it does not follow the pattern: Volatility 25 (1s) takes a
   * minimum volume of 0.005 against Volatility 10's 0.5, and leverage runs from
   * 1:100 to 1:6000 by instrument. Guessing a contract size scales that
   * instrument's profit by the error; guessing leverage does the same to its
   * margin. See specs.js.
   */
  function spec(name, sym, market) {
    var s = global.EvieSpecs && global.EvieSpecs.get(name);
    if (s) return s;
    return {
      size: /XAU|XPT|XPD/.test(sym) ? 100 : /XAG/.test(sym) ? 5000
        : market === "forex" ? 100000 : 1,
      min: 0.01, max: 100, leverage: 500, swapLong: 0, swapShort: 0
    };
  }

  /* How many decimals a quote actually carries. */
  function decimals(v) {
    var t = String(v), i = t.indexOf(".");
    return i < 0 ? 0 : t.length - i - 1;
  }

  function digitsOf(pip) {
    var d = Math.round(-Math.log(Number(pip)) / Math.LN10);
    return d >= 0 && d <= 8 ? d : 5;
  }

  /**
   * The instruments the terminal carries — the same twenty the dashboard's own
   * price rail follows, and deliberately no more.
   *
   * Taking whatever the feed offered filled the screen with Jump indices, Step
   * Index 500, Netherlands 25 and the rest, which is a different product every
   * time it reloads and nothing anyone chose. One list, matching what the site
   * already shows, keeps Quotes, Charts, Trade and History talking about the
   * same markets.
   */
  var WANTED = [
    "R_10", "R_25", "R_50", "R_75", "R_100",
    "1HZ10V", "1HZ25V", "1HZ50V", "1HZ75V", "1HZ100V",
    "frxXAUUSD", "frxXAGUSD", "frxXPTUSD",
    "frxEURUSD", "frxGBPUSD", "frxUSDJPY",
    "frxAUDUSD", "frxUSDCAD", "frxUSDCHF", "frxNZDUSD"
  ];

  function choose(list) {
    var by = {};
    list.forEach(function (a) {
      if (a && a.underlying_symbol && a.pip_size && !a.is_trading_suspended) {
        by[a.underlying_symbol] = a;
      }
    });

    /* Kept in the order above, then everything trading lifted over everything
       that is not — which at the weekend is the ten synthetics over the ten that
       keep market hours. Array.prototype.sort is stable, so the order within
       each half survives the lift. */
    var out = [];
    WANTED.forEach(function (sym) { if (by[sym]) out.push(by[sym]); });
    return out.sort(function (x, y) {
      if (!!x.exchange_is_open === !!y.exchange_is_open) return 0;
      return x.exchange_is_open ? -1 : 1;
    });
  }

  /* ── the socket ───────────────────────────────────────────────────────── */

  function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }

  /**
   * Ask for the instrument list, and keep asking until it arrives.
   *
   * This was sent once on connect. If it came back an error, or the reply was
   * simply lost, nothing asked again — the terminal sat with no instruments at
   * all, which is to say a blank Quotes screen, a blank chart and a settings
   * sheet that could not run, for the forty-five seconds until the watchdog
   * noticed and only if it did. One dropped message should not cost the whole
   * screen.
   */
  function askSymbols() {
    askedAt = Date.now();
    send({ active_symbols: "brief" });
    clearTimeout(asking);
    asking = setTimeout(function () {
      if (closed || !ws || ws.readyState !== 1) return;
      /* The LIST arriving is what this is waiting on, not the first tick.
         Checking for defined instruments re-asked every six seconds until a
         price landed, which is traffic for nothing. */
      if (Object.keys(named).length) return;
      askSymbols();
    }, 6000);
  }

  function open() {
    ws = new WebSocket(URL);

    ws.onopen = function () {
      attempt = 0;
      lastTickAt = Date.now();
      askSymbols();

      clearInterval(watchdog);
      watchdog = setInterval(function () {
        if (closed || !ws) return;
        if (Date.now() - lastTickAt > DEAD_AFTER) {
          try { ws.close(); } catch (e) {}   // onclose reconnects
        }
      }, 10000);

      clearInterval(pinger);
      pinger = setInterval(function () { send({ ping: 1 }); }, 25000);

      /* Markets open and close while the screen is up, and a list fetched once
         does not know. Without this a market that closed on Friday evening kept
         the last price it had and went on looking live all weekend. */
      clearInterval(resync);
      resync = setInterval(function () { send({ active_symbols: "brief" }); }, 300000);
    };

    ws.onmessage = function (ev) {
      var d;
      try { d = JSON.parse(ev.data); } catch (e) { return; }
      /* An instrument this socket will not serve simply never appears — there is
         nothing the person looking at the screen can do about one of those. The
         instrument LIST is different: without it there is no screen at all, so
         that one is asked for again rather than shrugged off. */
      if (d.error) {
        if (d.echo_req && d.echo_req.active_symbols) {
          clearTimeout(asking);
          asking = setTimeout(askSymbols, 2000);
        }
        return;
      }

      if (d.msg_type === "active_symbols" && d.active_symbols) {
        clearTimeout(asking);
        var picked = choose(d.active_symbols);
        /* An empty pick means the list arrived but carried none of ours — a
           shape change at Deriv's end. Asking again is the only useful move,
           and it must not be silent for ever. */
        if (!picked.length) { asking = setTimeout(askSymbols, 5000); return; }
        order = picked.map(function (a) { return nameOf(a.underlying_symbol, a.underlying_symbol_name); });
        picked.forEach(function (a) {
          var sym = a.underlying_symbol;
          var n = nameOf(sym, a.underlying_symbol_name);
          var was = meta[sym];
          meta[sym] = a;
          named[sym] = n;

          if (T()) T().setOpen(n, !!a.exchange_is_open);

          /* Already streaming and still open: nothing to do. */
          if (defs[n]) defs[n].isOpen = !!a.exchange_is_open;
          if (was && !!was.exchange_is_open === !!a.exchange_is_open && defs[n]) return;

          if (a.exchange_is_open) {
            send({ ticks: sym, subscribe: 1 });
          } else if (!defs[n]) {
            /* A closed market cannot be streamed, so its last traded price is
               asked for once. Deriv gives no bid or ask on a history record —
               only the price — so a closed row carries that price on both
               sides. It is the honest reading: there is no live quote to show,
               and inventing a spread around a market that is not trading would
               be worse than showing none. */
            send({ ticks_history: sym, end: "latest", count: 1, style: "ticks" });
          }
        });
        /* Re-laid in the refreshed order, so a market that has just closed
           drops below the ones still trading instead of holding its place. */
        if (T()) T().applySymbols(ordered());
        if (onChange) onChange();
        return;
      }

      /* The last price of a market that is not trading. */
      if (d.msg_type === "history" && d.history) {
        var hs = d.echo_req && d.echo_req.ticks_history;
        var hm = meta[hs], hn = named[hs];
        if (!hm || !hn || !T() || defs[hn]) return;
        var last = Number((d.history.prices || [])[(d.history.prices || []).length - 1]);
        if (!isFinite(last) || last <= 0) return;
        var hsp = spec(hn, hs, hm.market);
        defs[hn] = {
          name: hn, digits: digitsOf(hm.pip_size),
          size: hsp.size, leverage: hsp.leverage,
          minVol: hsp.min, maxVol: hsp.max,
          swapLong: hsp.swapLong, swapShort: hsp.swapShort,
          usdBase: /^frxUSD/.test(hs), isOpen: false,
          bid: last, ask: last, quote: last
        };
        T().applySymbols(ordered());
        send({ ticks_history: hs, end: "latest", count: 1, style: "candles", granularity: DAY });
        if (onChange) onChange();
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
          var sp = spec(n, sym, m.market);
          defs[n] = {
            name: n,
            /* What this first quote actually shows, never more than Deriv
               declares. It climbs from here as longer prices arrive. */
            declared: isFinite(t.pip_size) ? Number(t.pip_size) : digitsOf(m.pip_size),
            digits: Math.min(
              isFinite(t.pip_size) ? Number(t.pip_size) : digitsOf(m.pip_size),
              Math.max(decimals(b), decimals(a))),
            size: sp.size, leverage: sp.leverage,
            minVol: sp.min, maxVol: sp.max,
            swapLong: sp.swapLong, swapShort: sp.swapShort,
            usdBase: /^frxUSD/.test(sym),
            isOpen: true,
            bid: b, ask: a, quote: Number(t.quote)
          };
          T().applySymbols(ordered());
          /* Its true day open, low and high — not the first price seen. */
          send({
            ticks_history: sym, end: "latest", count: 1,
            style: "candles", granularity: DAY
          });
          if (onChange) onChange();
        }

        /* Precision climbs to whatever the feed has shown, capped by the
           declaration. One tick landing on a round number must not permanently
           shorten an instrument, so this only ever goes up. */
        var dd = Math.min(defs[n].declared, Math.max(decimals(b), decimals(a)));
        if (dd > defs[n].digits) {
          defs[n].digits = dd;
          T().setDigits(n, dd);
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
      clearInterval(watchdog); clearInterval(pinger); clearInterval(resync);
      clearTimeout(asking);
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
    /** For the screens: is this still waiting on its first instrument? */
    waiting: function () {
      return !Object.keys(defs).length;
    },

    stop: function () {
      closed = true;
      clearInterval(watchdog); clearInterval(pinger); clearInterval(resync);
      clearTimeout(asking);
      if (ws) { try { ws.close(); } catch (e) {} }
    }
  };
})(typeof window !== "undefined" ? window : this);
