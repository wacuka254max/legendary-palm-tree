/**
 * UPTICK — the prices rail.
 *
 * Five minutes of price movement for every Deriv volatility index, live: a
 * sparkline of the window and the percentage it moved across it.
 *
 * The data comes over the same OTP socket the bot trades on, because that is
 * the only socket these credentials can open — the plain ws.derivws.com endpoint
 * refuses an OIDC app id (see deriv.js). One socket serves every market:
 * `ticks_history` with subscribe:1 returns the window once and then streams each
 * new tick, so the rail stays current without polling.
 *
 * Every figure is computed from real ticks. The change is the last price against
 * the first price INSIDE the five-minute window, and old ticks are dropped as
 * they age out, so what is on screen is always the last five minutes and never a
 * widening average.
 */

(function (global) {
  "use strict";

  /* Deriv's volatility indices. The R_ set ticks every two seconds; the 1HZ set
     every one. A symbol this login cannot reach simply never renders a row.
     These never close — they are the only thing to show at the weekend. */
  var VOLATILITY = [
    { sym: "R_10", name: "Volatility 10" },
    { sym: "R_25", name: "Volatility 25" },
    { sym: "R_50", name: "Volatility 50" },
    { sym: "R_75", name: "Volatility 75" },
    { sym: "R_100", name: "Volatility 100" },
    { sym: "1HZ10V", name: "Volatility 10 (1s)" },
    { sym: "1HZ25V", name: "Volatility 25 (1s)" },
    { sym: "1HZ50V", name: "Volatility 50 (1s)" },
    { sym: "1HZ75V", name: "Volatility 75 (1s)" },
    { sym: "1HZ100V", name: "Volatility 100 (1s)" }
  ];

  /* The real markets people actually watch: gold at the front, then the seven
     dollar majors and the other two metals. Every one is quoted in USD, and
     every one was checked against Deriv's live feed rather than assumed.

     These keep market hours — Sunday evening to Friday evening — which is why
     they are a separate list from the indices above. */
  var FOREX = [
    { sym: "frxXAUUSD", name: "Gold/USD" },
    { sym: "frxEURUSD", name: "EUR/USD" },
    { sym: "frxGBPUSD", name: "GBP/USD" },
    { sym: "frxUSDJPY", name: "USD/JPY" },
    { sym: "frxAUDUSD", name: "AUD/USD" },
    { sym: "frxUSDCAD", name: "USD/CAD" },
    { sym: "frxUSDCHF", name: "USD/CHF" },
    { sym: "frxNZDUSD", name: "NZD/USD" },
    { sym: "frxXAGUSD", name: "Silver/USD" },
    { sym: "frxXPTUSD", name: "Platinum/USD" }
  ];

  var WINDOW_S = 300;      // the five minutes the panel is about
  var REDRAW_MS = 1000;    // ticks arrive faster than the eye needs redrawing
  var SHUFFLE_MS = 300000; // the mix is redealt on the same five minutes
  var MIN_ROWS = 5;        // below this the panel stops being worth showing
  var STACKED_ROWS = 10;   // under the tiles, where the page scrolls anyway
  var ROW_H = 53;          // fallback until a real row can be measured
  var BOTTOM_GAP = 24;     // air under the card, so it never touches the edge

  /**
   * Whether Deriv's forex and metals are trading.
   *
   * Their week runs from Sunday 21:00 UTC to Friday 21:00 UTC. Outside it the
   * prices are frozen at Friday's close, and a row showing a stale figure
   * beside indices that are genuinely moving is worse than no row — so at the
   * weekend the panel is volatility only.
   *
   * A public holiday is not modelled: those markets go quiet rather than
   * disappearing, and a row that has not ticked keeps the dash it started
   * with instead of inventing a number.
   */
  function forexOpen(now) {
    var day = now.getUTCDay();                              // 0 Sun … 6 Sat
    var mins = now.getUTCHours() * 60 + now.getUTCMinutes();
    if (day === 6) return false;                            // Saturday, all day
    if (day === 0) return mins >= 21 * 60;                  // Sunday, from 21:00
    if (day === 5) return mins < 21 * 60;                   // Friday, until 21:00
    return true;                                            // Monday to Thursday
  }

  /* Symbols this login turned out not to be able to read.
   *
   * The rail runs on the OTP trading socket, and which markets that socket
   * serves is decided by Deriv from the account behind it — an account that
   * only reaches synthetics will refuse the currency pairs. Rather than leave
   * ten rows sitting on a dash forever, a refusal takes that symbol out of the
   * pool for the session and the panel carries on with what it does have. On
   * an account with no forex the rail is then exactly what it was before these
   * markets were added.
   *
   * Only the added markets can be struck off. The indices are the panel's
   * floor: if THOSE start being refused the socket is having a bad day rather
   * than the account lacking a market, and emptying the card would turn a
   * temporary fault into a blank panel. They keep their dash and wait, which
   * is what they have always done.
   */
  var dead = {};
  var canStrike = {};
  FOREX.forEach(function (m) { canStrike[m.sym] = true; });

  /** Everything that is open right now, minus anything Deriv has refused. */
  function pool() {
    var all = forexOpen(new Date()) ? VOLATILITY.concat(FOREX) : VOLATILITY.slice();
    return all.filter(function (m) { return !dead[m.sym]; });
  }

  /** Fisher-Yates, on a copy. */
  function shuffled(list) {
    var a = list.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* The current deal, and the markets it was dealt from. */
  var order = [];
  var poolKey = "";

  /* The last window per market, so a reopened dashboard shows the rail
     already drawn instead of "Waiting for prices…" for the second it takes
     Deriv to answer. Live data overwrites it as soon as it arrives; older
     than the window itself is not worth showing, so it is dropped. */
  var CACHE_KEY = "evie_markets_cache";

  function readCache() {
    try {
      var raw = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
      if (!raw || Date.now() - raw.t > WINDOW_S * 1000) return null;
      return raw.syms || null;
    } catch (e) { return null; }
  }

  var cacheTimer = null;
  function writeCache() {
    clearTimeout(cacheTimer);
    cacheTimer = setTimeout(function () {
      try {
        var out = {};
        Object.keys(series).forEach(function (sym) {
          var s = series[sym];
          // Sixty points still draw a faithful sparkline and keep this small.
          out[sym] = { t: s.t.slice(-60), p: s.p.slice(-60) };
        });
        localStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), syms: out }));
      } catch (e) {}
    }, 3000);
  }

  var listEl = null;
  var ws = null;
  var series = {};         // sym -> { t: [], p: [] }
  var redrawTimer = null;
  var closed = false;
  var attempt = 0;
  var pinger = null;
  var watchdog = null;
  var connecting = false;
  var lastTickAt = 0;

  function el(id) { return document.getElementById(id); }

  /* ── the sparkline ─────────────────────────────────────────────────────
     A plain polyline over a solid low-opacity area. No gradient — the page
     does not use them — and no library. */
  function spark(prices, up) {
    var w = 96, h = 34, pad = 3;
    if (!prices || prices.length < 2) return "";

    var min = Math.min.apply(null, prices);
    var max = Math.max.apply(null, prices);
    var span = max - min || 1;
    var stepX = (w - pad * 2) / (prices.length - 1);

    var pts = prices.map(function (p, i) {
      var x = pad + i * stepX;
      var y = pad + (h - pad * 2) * (1 - (p - min) / span);
      return x.toFixed(1) + "," + y.toFixed(1);
    });

    var colour = up ? "#5fd39a" : "#ff3d87";
    var area = "M" + pts[0] + " L" + pts.join(" L") + " L" + (pad + (prices.length - 1) * stepX).toFixed(1) +
               "," + (h - pad) + " L" + pad + "," + (h - pad) + " Z";

    return '<svg class="mk-spark" viewBox="0 0 ' + w + " " + h + '" width="' + w + '" height="' + h +
           '" aria-hidden="true" preserveAspectRatio="none">' +
             '<path d="' + area + '" fill="' + colour + '" fill-opacity="0.10"/>' +
             '<polyline points="' + pts.join(" ") + '" fill="none" stroke="' + colour +
               '" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/>' +
           "</svg>";
  }

  /** Drop everything older than the window, so the figure never widens. */
  function trim(s, nowS) {
    var cut = nowS - WINDOW_S;
    var i = 0;
    while (i < s.t.length && s.t[i] < cut) i++;
    if (i > 0) { s.t.splice(0, i); s.p.splice(0, i); }
  }

  /**
   * How many rows the screen has room for.
   *
   * The card is never given a height and never scrolls inside itself — it
   * shows the number of markets that fit and no more, so it ends above the
   * bottom of the screen instead of running past it. Stacked under the tiles
   * the question does not arise: the page scrolls there, so it keeps the ten
   * it always had.
   */
  function fits() {
    if (!listEl) return STACKED_ROWS;
    if (global.matchMedia && global.matchMedia("(max-width: 1100px)").matches) {
      return STACKED_ROWS;
    }

    // A real row if one is on screen, so the sum survives a font or padding
    // change without anybody remembering to update a number here.
    var sample = listEl.querySelector(".mk");
    var rowH = (sample && sample.getBoundingClientRect().height) || ROW_H;
    if (rowH < 1) rowH = ROW_H;

    // Measured from the top of the page, so a scrolled window gives the same
    // answer as one at rest.
    var top = listEl.getBoundingClientRect().top + (global.scrollY || 0);
    var room = global.innerHeight - top - BOTTOM_GAP;

    var n = Math.floor(room / rowH);
    if (!isFinite(n)) return STACKED_ROWS;
    return Math.max(MIN_ROWS, n);
  }

  /** The markets on screen right now: the deal, cut to what fits. */
  function visible() {
    return order.slice(0, Math.min(fits(), order.length));
  }

  /* The rows exist before any price does.

     They used to be written only once data arrived, so a refresh showed an
     empty card that grew to full height a second later and shoved the page
     down as it went. Now the rail is its final size from the first paint and
     each row fills itself in where it already stands — the card never moves,
     the numbers just stop being dashes.

     Rebuilt only when the set of rows actually changes: a redeal, or a window
     resize that changes how many fit. Rewriting it every second would throw
     away the sparklines and flicker. */
  var built = "";

  function skeleton() {
    if (!listEl) return;
    if (!order.length) deal();

    var rows = visible();
    var key = rows.map(function (m) { return m.sym; }).join(",");
    if (key === built) return;
    built = key;

    listEl.innerHTML = rows.map(function (m) {
      return '<li class="mk" data-sym="' + m.sym + '">' +
               '<span class="mk-name">' + m.name + "</span>" +
               '<span class="mk-slot" data-spark></span>' +
               '<span class="mk-pct mk-pct--idle" data-pct>&mdash;</span>' +
             "</li>";
    }).join("");
  }

  /** Redeal the mix. Called on load and every five minutes after. */
  function deal() {
    var open = pool();
    poolKey = open.map(function (m) { return m.sym; }).join(",");
    order = shuffled(open);
  }

  function draw() {
    if (!listEl) return;
    skeleton();
    var nowS = Math.floor(Date.now() / 1000);

    visible().forEach(function (m) {
      var row = listEl.querySelector('.mk[data-sym="' + m.sym + '"]');
      if (!row) return;

      var s = series[m.sym];
      if (!s || s.p.length < 2) return;        // leave the dash where it is
      trim(s, nowS);
      if (s.p.length < 2) return;

      var first = s.p[0];
      var last = s.p[s.p.length - 1];
      var pct = first ? ((last - first) / first) * 100 : 0;
      var up = pct >= 0;

      row.querySelector("[data-spark]").innerHTML = spark(s.p, up);

      var pctEl = row.querySelector("[data-pct]");
      pctEl.textContent = (up ? "+" : "") + pct.toFixed(2) + "%";
      pctEl.className = "mk-pct " + (up ? "mk-pct--up" : "mk-pct--down");
    });
  }

  /* ── the socket ────────────────────────────────────────────────────── */

  function open(url) {
    ws = new WebSocket(url);

    ws.onopen = function () {
      var start = Math.floor(Date.now() / 1000) - WINDOW_S;
      /* Every open market, not only the ones on screen. A redeal five minutes
         from now can promote any of them, and a row that arrives already
         holding five minutes of history is the difference between a mix that
         changes and one that blinks through a row of dashes first. */
      pool().forEach(function (m) {
        ws.send(JSON.stringify({
          ticks_history: m.sym,
          start: start,
          end: "latest",
          style: "ticks",
          subscribe: 1
        }));
      });
      attempt = 0;
      lastTickAt = Date.now();
      redrawTimer = setInterval(draw, REDRAW_MS);

      /* A socket can stay open and stop sending. Nothing notices that on its
         own, so if no tick has arrived in forty seconds the connection is
         treated as dead and replaced. */
      clearInterval(watchdog);
      watchdog = setInterval(function () {
        if (closed || !ws) return;
        if (Date.now() - lastTickAt > 40000) {
          try { ws.close(); } catch (e) {}   // onclose schedules the retry
        }
      }, 10000);
      // Deriv closes a silent socket; a ping keeps the prices coming.
      clearInterval(pinger);
      pinger = setInterval(function () {
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ ping: 1 }));
      }, 25000);
    };

    ws.onmessage = function (ev) {
      var d;
      try { d = JSON.parse(ev.data); } catch (e) { return; }

      /* A market this login cannot read just never appears; there is nothing
         for the user to do about it, so there is nothing to say. It is struck
         off so a later redeal cannot put it back on screen as a permanent
         dash, and the row it was occupying goes to a market that works. */
      if (d.error) {
        var bad = d.echo_req && d.echo_req.ticks_history;
        if (bad && canStrike[bad] && !dead[bad]) {
          dead[bad] = true;
          deal();
          built = "";
          draw();
        }
        return;
      }

      if (d.msg_type === "history" && d.history) {
        lastTickAt = Date.now();
        var sym = (d.echo_req && d.echo_req.ticks_history) || "";
        if (!sym) return;
        series[sym] = {
          t: (d.history.times || []).map(Number),
          p: (d.history.prices || []).map(Number)
        };
        writeCache();
        return;
      }

      if (d.msg_type === "tick" && d.tick && d.tick.symbol) {
        lastTickAt = Date.now();
        var s = series[d.tick.symbol] || (series[d.tick.symbol] = { t: [], p: [] });
        s.t.push(Number(d.tick.epoch));
        s.p.push(Number(d.tick.quote));
        writeCache();
      }
    };

    ws.onclose = function () {
      if (redrawTimer) { clearInterval(redrawTimer); redrawTimer = null; }
      clearInterval(watchdog); watchdog = null;
      clearInterval(pinger); pinger = null;
      ws = null;
      /* Keep coming back, backing off to a few seconds. Deriv drops idle
         connections, and a rail that gives up after one try is a rail that is
         blank for anyone who leaves the page open. */
      if (closed) return;
      attempt++;
      setTimeout(function () { if (!closed) connect(); },
        Math.min(1000 * Math.pow(2, attempt - 1), 8000));
    };

    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  }

  var lastAccount = null;

  /* ── in ────────────────────────────────────────────────────────────── */

  function start(accountId) {
    listEl = el("mk-list");
    if (!listEl) return;

    /* The rows go up before anything else is known — before the account, the
       socket, or the first price. The rail is then its full height from the
       first paint whatever happens next, including nothing happening at all. */
    skeleton();

    if (!accountId || !global.EvieDeriv) return;

    /* start() is called twice by design — once on the remembered account
       before the portfolio returns, once after it comes back. Without this it
       opened a SECOND socket over the first, and both wrote the same series.
       Same account, already going: nothing to do. */
    if (lastAccount === accountId && (ws || connecting)) return;

    lastAccount = accountId;
    closed = false;

    // Draw the last known prices at once, so the rail is never an empty box.
    var cached = readCache();
    if (cached) { series = cached; draw(); }

    connect();
  }

  /**
   * Open, and keep trying. The first attempt used to be the only one: a failure
   * there printed "Prices unavailable" and the rail never came back for as long
   * as the page stayed open.
   */
  function connect() {
    if (closed || !lastAccount || connecting) return;
    connecting = true;

    global.EvieDeriv.tradeSocket(lastAccount)
      .then(function (url) { connecting = false; open(url); })
      .catch(function () {
        connecting = false;
        attempt++;
        setTimeout(function () { if (!closed) connect(); },
          Math.min(1000 * Math.pow(2, attempt - 1), 8000));
      });
  }

  /* ── the redeal ─────────────────────────────────────────────────────────
     A fresh mix on the same five minutes the panel measures, so which markets
     you are shown changes as often as the figures beside them do.

     When the redeal crosses the Friday or Sunday boundary the pool itself
     changes, and the socket is holding subscriptions to a set that is no
     longer right — so it is dropped and reopened against the new one. That
     happens twice a week and nowhere else. */
  setInterval(function () {
    var before = poolKey;
    deal();
    built = "";                  // the rows are a different set now
    draw();
    if (poolKey !== before && ws) {
      try { ws.close(); } catch (e) {}   // onclose reconnects and resubscribes
    }
  }, SHUFFLE_MS);

  /* A window that got taller has room for markets it was not showing, and one
     that got shorter must give some back. Debounced, because a drag fires this
     continuously and each one can rebuild the list. */
  var resizeTimer = null;
  global.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(draw, 200);
  });

  /**
   * Measure again once the page has actually been laid out.
   *
   * The first skeleton goes up before the stylesheet has finished with the
   * page, when the list has no rows to measure and is not yet where it will
   * end up — so the count it works out there is a guess. These re-runs replace
   * it with the real one. Without them the panel kept that first guess for as
   * long as the tab stayed open, because everything else that redraws is
   * driven by the socket, and there may not be a socket.
   */
  function settle() {
    if (global.requestAnimationFrame) global.requestAnimationFrame(draw);
    else setTimeout(draw, 0);
  }
  global.addEventListener("load", settle);

  global.addEventListener("beforeunload", function () {
    closed = true;
    try { if (ws) ws.close(); } catch (e) {}
  });

  /* Paint before anything is asked of the network. start() is called once the
     portfolio comes back, which is far too late for a rail that should never
     look empty. */
  function prime() {
    listEl = el("mk-list");
    if (!listEl) return;
    var cached = readCache();
    if (cached) { series = cached; draw(); }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", prime);
  else prime();

  /* A dashboard that cannot connect should still look like a dashboard. */
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      listEl = el("mk-list");
      skeleton();
      settle();
    });
  } else {
    listEl = el("mk-list");
    skeleton();
    settle();
  }

  global.EvieMarkets = { start: start };
})(window);
