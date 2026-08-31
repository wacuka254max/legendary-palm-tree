/**
 * EVIE — the volatility markets rail.
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
     every one. A symbol this login cannot reach simply never renders a row. */
  var MARKETS = [
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

  var WINDOW_S = 300;      // the five minutes the panel is about
  var REDRAW_MS = 1000;    // ticks arrive faster than the eye needs redrawing

  var listEl = null;
  var ws = null;
  var series = {};         // sym -> { t: [], p: [] }
  var redrawTimer = null;
  var closed = false;

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

  function draw() {
    if (!listEl) return;
    var nowS = Math.floor(Date.now() / 1000);

    var rows = MARKETS.map(function (m) {
      var s = series[m.sym];
      if (!s || s.p.length < 2) return null;
      trim(s, nowS);
      if (s.p.length < 2) return null;

      var first = s.p[0];
      var last = s.p[s.p.length - 1];
      var pct = first ? ((last - first) / first) * 100 : 0;
      // A flat market is not an up market: the sign follows the movement,
      // and the colour follows the sign.
      var up = pct >= 0;

      return '<li class="mk">' +
               '<span class="mk-name">' + m.name + "</span>" +
               spark(s.p, up) +
               '<span class="mk-pct ' + (up ? "mk-pct--up" : "mk-pct--down") + '">' +
                 (up ? "+" : "") + pct.toFixed(2) + "%" +
               "</span>" +
             "</li>";
    }).filter(Boolean);

    listEl.innerHTML = rows.length
      ? rows.join("")
      : '<li class="mk mk--none">Waiting for prices…</li>';
  }

  /* ── the socket ────────────────────────────────────────────────────── */

  function open(url) {
    ws = new WebSocket(url);

    ws.onopen = function () {
      var start = Math.floor(Date.now() / 1000) - WINDOW_S;
      MARKETS.forEach(function (m) {
        ws.send(JSON.stringify({
          ticks_history: m.sym,
          start: start,
          end: "latest",
          style: "ticks",
          subscribe: 1
        }));
      });
      redrawTimer = setInterval(draw, REDRAW_MS);
    };

    ws.onmessage = function (ev) {
      var d;
      try { d = JSON.parse(ev.data); } catch (e) { return; }

      // A market this login cannot read just never appears; there is nothing
      // for the user to do about it, so there is nothing to say.
      if (d.error) return;

      if (d.msg_type === "history" && d.history) {
        var sym = (d.echo_req && d.echo_req.ticks_history) || "";
        if (!sym) return;
        series[sym] = {
          t: (d.history.times || []).map(Number),
          p: (d.history.prices || []).map(Number)
        };
        return;
      }

      if (d.msg_type === "tick" && d.tick && d.tick.symbol) {
        var s = series[d.tick.symbol] || (series[d.tick.symbol] = { t: [], p: [] });
        s.t.push(Number(d.tick.epoch));
        s.p.push(Number(d.tick.quote));
      }
    };

    ws.onclose = function () {
      if (redrawTimer) { clearInterval(redrawTimer); redrawTimer = null; }
      // One quiet retry. The rail is a nicety; it must never nag.
      if (!closed) setTimeout(function () { if (!closed) restart(); }, 5000);
    };

    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  }

  var lastAccount = null;

  function restart() {
    if (!lastAccount || !global.EvieDeriv) return;
    global.EvieDeriv.tradeSocket(lastAccount).then(open).catch(function () {});
  }

  /* ── in ────────────────────────────────────────────────────────────── */

  function start(accountId) {
    listEl = el("mk-list");
    if (!listEl || !accountId || !global.EvieDeriv) return;
    lastAccount = accountId;

    global.EvieDeriv.tradeSocket(accountId)
      .then(open)
      .catch(function () {
        listEl.innerHTML = '<li class="mk mk--none">Prices unavailable.</li>';
      });

    // The panel folds away; a rail nobody wants should not be unavoidable.
    var head = el("mk-head");
    var panel = el("markets");
    if (head && panel) {
      head.addEventListener("click", function () {
        var open_ = panel.classList.toggle("is-open");
        head.setAttribute("aria-expanded", String(open_));
      });
    }
  }

  global.addEventListener("beforeunload", function () {
    closed = true;
    try { if (ws) ws.close(); } catch (e) {}
  });

  global.EvieMarkets = { start: start };
})(window);
