/**
 * UPTICK — the terminal's screens.
 *
 * Rebuilt against screenshots of the app. The details that were wrong the
 * first time and are the whole character of the thing:
 *
 *   · Trade is three dotted-leader figures, not a headline and a stat grid.
 *     Margin and Level join them only once margin is in use, which is what
 *     the app does — an empty account shows three lines, not five.
 *   · A price reads 1.16 **13** ², the last two significant digits large and
 *     the final one raised. Every price on every screen is written that way.
 *   · The tab bar's middle item has no word: it carries the balance in a pill,
 *     and only the icon turns blue when Trade is the screen you are on.
 *   · Each screen brings its own toolbar actions, so the bar is rebuilt on
 *     every change rather than hiding one button.
 *
 * Reads from engine.js and writes back through it; owns no money and no
 * prices, only what is on screen.
 */

(function (global) {
  "use strict";

  var T = global.EvieTerminal;
  if (!T) return;

  var $ = function (id) { return document.getElementById(id); };
  var tab = "trade";
  var seg = "positions";
  var chartSym = "";   // set from the first instrument the feed delivers
  var menuFor = null;

  /* ── formatting ─────────────────────────────────────────────────────────
     Money with a space for thousands, the way the app writes 100 000.00. */

  function money(n) {
    var s = Math.abs(Number(n)).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
    return (n < 0 ? "-" : "") + s;
  }
  function signed(n) { return (n > 0 ? "+" : n < 0 ? "-" : "") + money(Math.abs(n)); }
  function cls(n) { return n > 0 ? "up" : n < 0 ? "down" : ""; }

  /** The balance pill: 100 000 becomes 100K, 2 500 becomes 2.5K. */
  function short(n) {
    var a = Math.abs(n);
    if (a >= 1000000) return Math.round(n / 100000) / 10 + "M";
    if (a >= 10000) return Math.round(n / 1000) + "K";
    if (a >= 1000) return Math.round(n / 100) / 10 + "K";
    return String(Math.round(n));
  }

  /**
   * A price, in the app's own typography: everything but the last three
   * characters at reading size, the next two large, the final one raised.
   * 1.16132 → 1.16 · 13 · 2.
   */
  function priceHtml(v, digits, dir) {
    var s = Number(v).toFixed(digits);
    /* Blue up, red down, and the neutral grey-over-white pair when this side
       did not move. Each price carries its own, because each moves on its own. */
    var k = dir > 0 ? " up" : dir < 0 ? " down" : "";
    /* The raised digit is the FRACTIONAL pip, so it only exists where the
       instrument quotes one — three decimals or more. On a two-decimal index
       there is no fractional pip, and taking the last three characters anyway
       drags the decimal point into the large pair: 9214.6 came out as 921 4. 6.
       Two decimals or fewer: the last two digits are large and nothing is
       raised, which is how the app prints them. */
    /* One decimal or none leaves nothing sensible to split — the last two
       characters would straddle the point — so the whole figure is set large. */
    if (digits < 2) return '<span class="px' + k + '"><b>' + s + "</b></span>";
    if (digits < 3) {
      return '<span class="px' + k + '">' + s.slice(0, -2) + "<b>" + s.slice(-2) + "</b></span>";
    }
    return '<span class="px' + k + '">' + s.slice(0, -3) +
      "<b>" + s.slice(-3, -1) + "</b><sup>" + s.slice(-1) + "</sup></span>";
  }

  function clock(ms) {
    var d = new Date(ms);
    var p = function (x) { return String(x).padStart(2, "0"); };
    return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }
  function stamp(ms) {
    var d = new Date(ms);
    var p = function (x) { return String(x).padStart(2, "0"); };
    return d.getFullYear() + "." + p(d.getMonth() + 1) + "." + p(d.getDate()) +
      " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }

  function esc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /** One dotted-leader line. */
  /**
   * A price as it appears in a LINE of text — the open-to-current pair on a
   * position, the low and high under a quote. Thousands are grouped with a
   * space: the app writes 848 568.89, not 848568.89.
   *
   * The large typography above a quote is deliberately NOT grouped. 4430.16 is
   * set solid there, and running this over it would wrongly split the head.
   */
  function px(v, digits) {
    var t = Number(v).toFixed(digits).split(".");
    return t[0].replace(/\B(?=(\d{3})+(?!\d))/g, " ") + (t[1] ? "." + t[1] : "");
  }

  function lead(label, value, klass) {
    return '<div class="tm-lead"><dt>' + esc(label) + "</dt><i></i>" +
      '<dd class="num ' + (klass || "") + '">' + value + "</dd></div>";
  }

  /* ── the toolbars ───────────────────────────────────────────────────────
     Each screen carries its own, so the bar is rebuilt rather than having
     buttons hidden inside it. */

  var ICON = {
    sort: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 20V5M5 8l3-3 3 3M16 4v15M13 16l3 3 3-3"/></svg>',
    newOrder: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M12 11v6M9 14h6"/></svg>',
    plus: '<svg viewBox="0 0 24 24" width="29" height="29" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M12 4v16M4 12h16"/></svg>',
    pencil: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3z"/></svg>',
    /* Two arcs around an S — the symbol filter, not a dollar sign in a ring. */
    currency: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20.4 9.6A8.7 8.7 0 0 0 5.6 5.6"/><path d="M3.6 14.4a8.7 8.7 0 0 0 14.8 4"/><path d="M5.6 2.4v3.4h3.4M18.4 21.6v-3.4H15"/><path d="M14 9.6a2.4 2.4 0 0 0-4.1 1.5c0 2.3 4.3 1.4 4.3 3.6a2.4 2.4 0 0 1-4.2 1.4"/></svg>',
    calendar: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 9.5h16M8.5 3v4M15.5 3v4"/><circle cx="9" cy="13.5" r="1" fill="currentColor" stroke="none"/><circle cx="12.5" cy="13.5" r="1" fill="currentColor" stroke="none"/><circle cx="16" cy="13.5" r="1" fill="currentColor" stroke="none"/></svg>',
    mqid: '<svg viewBox="0 0 34 20" width="34" height="20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1" y="2" width="32" height="16" rx="3"/><text x="17" y="13.6" text-anchor="middle" font-size="8.5" font-weight="700" fill="currentColor" stroke="none" font-family="Roboto, Arial, sans-serif">MQID</text></svg>',
    search: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>',
    cross: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M12 3v18M3 12h18"/></svg>',
    indicator: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17c3 0 3-10 6-10s3 10 6 10 3-7 6-7"/></svg>',
    /* The split disc, and the two-tone tag beside it. */
    period: '<svg viewBox="0 0 24 24" width="24" height="24"><circle cx="12" cy="12" r="9.5" fill="#2f6fd0"/><path d="M12 2.5a9.5 9.5 0 0 1 0 19z" fill="#d93a2b"/><circle cx="12" cy="12" r="9.5" fill="none" stroke="#000" stroke-opacity="0.25"/></svg>',
    objects: '<svg viewBox="0 0 24 24" width="24" height="24"><rect x="2.5" y="6.5" width="19" height="11" rx="2.5" fill="#d93a2b"/><rect x="12" y="6.5" width="9.5" height="11" rx="2.5" fill="#2f6fd0"/><circle cx="8" cy="12" r="2.1" fill="#fff"/></svg>'
  };

  var BARS = {
    trade:    { title: "Trade",    sub: "",            acts: ["sort", "newOrder"] },
    quotes:   { title: "Quotes",   sub: "",            acts: ["plus", "pencil"] },
    charts:   { title: "",         sub: "",            acts: [] },
    history:  { title: "History",  sub: "All symbols", acts: ["currency", "sort", "calendar"] },
    messages: { title: "Messages", sub: "",            acts: ["mqid", "search"] }
  };

  function drawBar() {
    var b = BARS[tab];
    $("tm-title").textContent = b.title;
    $("tm-sub").textContent = b.sub;
    $("tm-actions").innerHTML = b.acts.map(function (k) {
      return '<button class="tm-ico" type="button" data-act="' + k + '">' + ICON[k] + "</button>";
    }).join("");
    /* The chart's toolbar is its own — a crosshair, an indicator and the
       timeframe where the title would be. */
    /* Charts has no title at all: the burger sits on the left and five
       controls are spread across the rest of the bar, evenly, which is why it
       reads as a chart toolbar rather than a screen header. */
    document.querySelector(".tm-bar").classList.toggle("tm-bar--chart", tab === "charts");
    if (tab === "charts") {
      $("tm-actions").innerHTML =
        '<button class="tm-ico" type="button">' + ICON.cross + "</button>" +
        '<button class="tm-ico" type="button">' + ICON.indicator + "</button>" +
        '<button class="tm-ico tm-tf" type="button">M5</button>' +
        '<button class="tm-ico" type="button">' + ICON.period + "</button>" +
        '<button class="tm-ico" type="button">' + ICON.objects + "</button>";
    }
  }

  /* ── Trade ─────────────────────────────────────────────────────────────── */

  function drawTrade() {
    var s = T.summary();
    /* Balance, Equity, Margin, Free margin, Margin Level — in that order,
       which is the app's. Free margin used to sit third, above Margin, and the
       level was labelled "Level" with the per-cent hung on the value; the app
       names the row "Margin Level (%)" and leaves the number bare. */
    var rows = lead("Balance:", money(s.balance)) +
               lead("Equity:", money(s.equity));
    if (s.margin > 0) {
      rows += lead("Margin:", money(s.margin)) +
              lead("Free margin:", money(s.free)) +
              lead("Margin Level (%):", money(s.level));
    } else {
      /* Nothing open: three lines, no margin and no level. A level with no
         margin behind it is a division by zero wearing a percentage sign. */
      rows += lead("Free margin:", money(s.free));
    }
    $("tm-figures").innerHTML = rows;

    var ps = T.positions();
    $("tm-poshead").hidden = !ps.length;
    if (!ps.length) { $("tm-pos").innerHTML = ""; return; }

    $("tm-pos").innerHTML = ps.map(function (p) {
      var sym = T.symbol(p.symbol);
      var now = p.type === "buy" ? T.bid(sym) : T.ask(sym);
      var profit = T.profitOf(p);
      /* "Volatility 25 (1s) Index, sell 1.00" — the comma belongs to the
         symbol, and the direction and size carry the colour. The figure on the
         right is plain: a gain is not written with a leading plus. */
      return '<div class="tm-row" data-ticket="' + p.ticket + '">' +
        '<div class="tm-row-h"><b>' + esc(p.symbol) + ",</b>" +
          '<span class="' + (p.type === "buy" ? "up" : "down") + '">' +
          p.type + " " + p.volume.toFixed(2) + "</span></div>" +
        '<div class="tm-row-sub num">' + px(p.open, sym.digits) +
          " &rarr; " + px(now, sym.digits) + "</div>" +
        '<div class="tm-row-v num ' + cls(profit) + '">' + money(profit) + "</div>" +
      "</div>";
    }).join("");
  }

  /* ── Quotes ────────────────────────────────────────────────────────────── */

  function drawQuotes() {
    $("tm-quotes").innerHTML = T.quotes().map(function (q) {
      var dir = cls(q.points);
      return '<div class="tm-q" data-sym="' + esc(q.name) + '">' +
        '<div class="tm-q-chg num"><b>' + (q.points > 0 ? "+" : "") + q.points + "</b> " +
          '<span class="' + dir + '">' + (q.percent > 0 ? "+" : "") +
          q.percent.toFixed(2) + "%</span></div>" +
        '<div class="tm-q-name">' + esc(q.name) + "</div>" +
        '<div class="tm-q-meta num">' + clock(q.time) +
          '<i>&#8866;</i>' + q.spread + "</div>" +
        '<div class="tm-q-px">' + priceHtml(q.bid, q.digits, q.bidDir) +
          priceHtml(q.ask, q.digits, q.askDir) + "</div>" +
        '<div class="tm-q-lh num"><span>L: ' + px(q.low, q.digits) +
          "</span><span>H: " + px(q.high, q.digits) + "</span></div>" +
      "</div>";
    }).join("");
  }

  /* ── Charts ────────────────────────────────────────────────────────────── */

  /* The line under the symbol in the app's own overlay. */
  /* The line under the symbol.

     Deriv does not publish one. `active_symbols` has ten fields and a
     description is not among them, even asking for the full set — so this is
     derived from the instrument's own name rather than fetched. It is a label,
     not a number: nothing here feeds a price or a position. */
  var CUR = {
    EUR: "Euro", USD: "US Dollar", GBP: "Great Britain Pound", JPY: "Japanese Yen",
    AUD: "Australian Dollar", NZD: "New Zealand Dollar", CAD: "Canadian Dollar",
    CHF: "Swiss Franc", NOK: "Norwegian Krone", SEK: "Swedish Krona",
    PLN: "Polish Zloty", MXN: "Mexican Peso", ZAR: "South African Rand",
    XAU: "Gold", XAG: "Silver", XPT: "Platinum", XPD: "Palladium",
    BTC: "Bitcoin", ETH: "Ethereum", LTC: "Litecoin", BCH: "Bitcoin Cash",
    XRP: "Ripple", BNB: "Binance Coin", SOL: "Solana", ADA: "Cardano"
  };

  function describe(name) {
    var m = /^Volatility (\d+) \((\d+)s\) Index$/.exec(name);
    if (m) {
      return "Constant Volatility of " + m[1] + "% with a tick every " +
        m[2] + " second" + (m[2] === "1" ? "" : "s");
    }
    m = /^Volatility (\d+) Index$/.exec(name);
    if (m) return "Constant Volatility of " + m[1] + "% with a tick every 2 seconds";
    m = /^Jump (\d+) Index$/.exec(name);
    if (m) return "Average 1 jump every 20 minutes with constant volatility of " + m[1] + "%";
    m = /^(Boom|Crash) (\d+) Index$/.exec(name);
    if (m) return "Average 1 " + m[1].toLowerCase() + " every " + m[2] + " ticks";
    if (/^Step Index/.test(name)) return "Equal probability of up and down steps";
    m = /^([A-Z]{3})([A-Z]{3})$/.exec(name);
    if (m && CUR[m[1]] && CUR[m[2]]) return CUR[m[1]] + " vs " + CUR[m[2]];
    return name;
  }

  /* Seconds left on the candle currently forming, as the app counts it down. */
  function candleLeft() {
    var left = 300 - Math.floor(Date.now() / 1000) % 300;
    return String(Math.floor(left / 60)).padStart(2, "0") + ":" +
      String(left % 60).padStart(2, "0");
  }

  function drawChart() {
    var bars = T.bars(chartSym);
    var s = T.symbol(chartSym);
    if (!bars.length || !s) return;

    /* Measured, not assumed. A fixed viewBox scaled to the width leaves the
       chart the wrong height for the screen — short on a tall phone, clipped
       on a short one. Taking the box the pane actually has and using it as the
       viewBox means one SVG unit is one CSS pixel: nothing is stretched and
       the plot ends exactly where the tab bar starts. */
    var host = $("tm-chart");
    var W = host.clientWidth || 360;
    var H = host.clientHeight || 470;
    if (W < 40 || H < 40) return;

    var AXIS = 60, TIMES = 22;
    var boxL = 3, boxT = 3, boxR = W - AXIS, boxB = H - TIMES;
    var boxW = boxR - boxL, boxH = boxB - boxT;

    var lo = Infinity, hi = -Infinity;
    bars.forEach(function (b) { if (b.l < lo) lo = b.l; if (b.h > hi) hi = b.h; });
    var span = (hi - lo) || 1;
    lo -= span * 0.12; hi += span * 0.12; span = hi - lo;

    var step = boxW / bars.length;
    var y = function (v) { return boxT + boxH - (v - lo) / span * boxH; };

    var grid = "";
    var ROWS = Math.max(6, Math.min(20, Math.round(boxH / 46)));
    for (var g = 0; g <= ROWS; g++) {
      var gy = boxT + (boxH / ROWS) * g;
      grid += '<line x1="' + boxL + '" y1="' + gy + '" x2="' + boxR + '" y2="' + gy +
        '" stroke="currentColor" stroke-opacity="0.14" stroke-dasharray="1.5 4"/>';
      grid += '<text x="' + (boxR + 8) + '" y="' + (gy + 4) +
        '" font-size="11.5" fill="currentColor" fill-opacity="0.8">' +
        (hi - (span / ROWS) * g).toFixed(s.digits) + "</text>";
    }
    /* Vertical rules every ten bars, with the time under each. */
    var times = "";
    var everyN = Math.max(8, Math.round(bars.length / Math.max(2, Math.floor(boxW / 92))));
    for (var v = 0; v < bars.length; v += everyN) {
      var vx = boxL + v * step;
      grid += '<line x1="' + vx + '" y1="' + boxT + '" x2="' + vx + '" y2="' + boxB +
        '" stroke="currentColor" stroke-opacity="0.14" stroke-dasharray="1.5 4"/>';
      var d = new Date(bars[v].t);
      var MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
      times += '<text x="' + (vx + 2) + '" y="' + (boxB + 17) +
        '" font-size="10.5" fill="currentColor" fill-opacity="0.8">' +
        d.getDate() + " " + MON[d.getMonth()] + " " +
        String(d.getHours()).padStart(2, "0") + ":" +
        String(d.getMinutes()).padStart(2, "0") + "</text>";
    }

    var candles = bars.map(function (b, i) {
      var x = boxL + i * step + step / 2;
      var col = b.c >= b.o ? "#26a69a" : "#e2483c";
      var top = y(Math.max(b.o, b.c));
      var bot = y(Math.min(b.o, b.c));
      var w = Math.max(1.6, step * 0.56);
      return '<line x1="' + x + '" y1="' + y(b.h) + '" x2="' + x + '" y2="' + y(b.l) +
          '" stroke="' + col + '" stroke-width="1.1"/>' +
        '<rect x="' + (x - w / 2) + '" y="' + top + '" width="' + w +
          '" height="' + Math.max(1, bot - top) + '" fill="' + col + '"/>';
    }).join("");

    /* Ask in red and bid in teal, each carrying its price in a filled tag that
       sits over the scale. */
    /* The bid's tag is the taller of the two: it carries the time left on the
       candle under the price, which is where the app puts that clock. */
    function level(v, col, countdown) {
      var ly = y(v);
      var h = countdown ? 34 : 19;
      return '<line x1="' + boxL + '" y1="' + ly + '" x2="' + boxR + '" y2="' + ly +
          '" stroke="' + col + '" stroke-width="1"/>' +
        '<rect x="' + boxR + '" y="' + (ly - 9.5) + '" width="' + (W - boxR) +
          '" height="' + h + '" fill="' + col + '"/>' +
        '<text x="' + (boxR + 5) + '" y="' + (ly + 4.5) +
          '" font-size="11.5" fill="#fff">' + v.toFixed(s.digits) + "</text>" +
        (countdown ? '<text x="' + (boxR + 5) + '" y="' + (ly + 19) +
          '" font-size="11.5" fill="#fff">' + countdown + "</text>" : "");
    }

    $("tm-chart").innerHTML =
      '<svg viewBox="0 0 ' + W + " " + H + '">' +
        grid + times + candles +
        level(T.ask(s), "#e2483c") + level(T.bid(s), "#26a69a", candleLeft()) +
        '<rect x="' + boxL + '" y="' + boxT + '" width="' + boxW + '" height="' + boxH +
          '" fill="none" stroke="currentColor" stroke-opacity="0.45"/>' +
        /* The app's own overflow dots, just inside the bottom right corner. */
        '<text x="' + (boxR - 6) + '" y="' + (boxB + 15) + '" text-anchor="end"' +
          ' font-size="15" fill="currentColor" fill-opacity="0.85">&#8226;&#8226;&#8226;</text>' +
      "</svg>" +
      '<div class="tm-chart-tag">' +
        /* The caret is drawn, not typed: the glyph is missing from enough
           fallback fonts that it came out as a dash. */
        "<b>" + esc(chartSym) +
          '<svg class="c" viewBox="0 0 10 10" width="9" height="9" aria-hidden="true">' +
          '<path d="M1 3.5h8L5 8z" fill="currentColor"/></svg>' +
          '<span class="tf">M5</span></b>' +
        "<span>" + esc(describe(chartSym)) + "</span>" +
      "</div>";
  }

  /* ── History ───────────────────────────────────────────────────────────── */

  function drawHistory() {
    var ds = T.deals();
    var trades = ds.filter(function (d) { return d.type !== "balance"; });
    var deposits = ds.filter(function (d) { return d.type === "balance"; });

    var profit = 0; trades.forEach(function (d) { profit += d.profit; });
    var dep = 0; deposits.forEach(function (d) { dep += d.profit; });
    /* The bottom line is what this period came to — profit plus deposits plus
       swap and commission — not the account's current balance. Showing the
       balance there made the column stop adding up: four figures and a total
       that had nothing to do with them. */
    var net = Math.round((profit + dep) * 100) / 100;

    $("tm-hfigures").innerHTML =
      lead("Profit:", money(profit), cls(profit)) +
      lead("Deposit", money(dep)) +
      lead("Swap:", money(0)) +
      lead("Commission:", money(0)) +
      lead("Balance:", money(net), cls(net));

    var list = seg === "orders" ? [] : ds;
    if (!list.length) { $("tm-hist").innerHTML = ""; return; }

    $("tm-hist").innerHTML = list.map(function (d) {
      if (d.type === "balance") {
        return '<div class="tm-hrow">' +
          '<div class="h"><b>Balance</b></div>' +
          '<div class="t num">' + stamp(d.closeTime) + "</div>" +
          '<div class="v num up">' + money(d.profit) + "</div>" +
        "</div>";
      }
      var sym = T.symbol(d.symbol) || { digits: 2 };
      /* Line one is the instrument and the order, with the stamp opposite it;
         line two is the two prices with the result opposite them. The direction
         and size used to sit on line two beside the prices, which is not where
         the app puts them. */
      return '<div class="tm-hrow">' +
        '<div class="h"><b>' + esc(d.symbol) + ',</b> ' +
          '<span class="' + (d.type === "buy" ? "up" : "down") + '">' +
          d.type + " " + d.volume.toFixed(2) + "</span></div>" +
        '<div class="t num">' + stamp(d.closeTime) + "</div>" +
        '<div class="s num">' + px(d.open, sym.digits) +
          " &rarr; " + px(d.close, sym.digits) + "</div>" +
        '<div class="v num ' + cls(d.profit) + '">' + money(d.profit) + "</div>" +
      "</div>";
    }).join("");
  }

  /* ── the ticket ────────────────────────────────────────────────────────── */

  function ticketSymbol() { return T.symbol($("tm-osym").value); }

  function drawTicket() {
    if ($("tm-order").hidden) return;
    var s = ticketSymbol();
    if (!s) return;
    $("tm-obid").innerHTML = priceHtml(T.bid(s), s.digits);
    $("tm-oask").innerHTML = priceHtml(T.ask(s), s.digits);
    $("tm-ospread").textContent = s.spread;
  }

  function send(type) {
    var s = ticketSymbol();
    var out = T.open(s.name, type, $("tm-ovol").value, $("tm-osl").value, $("tm-otp").value);
    if (typeof out === "string") return toast(out);
    closeSheet("tm-order");
    toast(type + " " + out.volume.toFixed(2) + " " + s.name + " at " + Number(out.open).toFixed(s.digits));
    go("trade");
  }

  /* ── sheets and the toast ──────────────────────────────────────────────── */

  function openSheet(id) { $(id).hidden = false; }
  function closeSheet(id) { $(id).hidden = true; }

  function openMenu(ticket) {
    menuFor = ticket;
    var p = T.positions().filter(function (x) { return x.ticket === ticket; })[0];
    if (!p) return;
    var s = T.symbol(p.symbol);
    $("tm-menu-h").textContent = p.symbol + ", " + p.type + " " + p.volume.toFixed(2) + ", #" + p.ticket;
    $("tm-msl").value = p.sl ? Number(p.sl).toFixed(s.digits) : "";
    $("tm-mtp").value = p.tp ? Number(p.tp).toFixed(s.digits) : "";
    openSheet("tm-posmenu");
  }

  var toastTimer = null;
  function toast(text) {
    var el = $("tm-toast");
    el.textContent = text;
    el.classList.add("on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove("on"); }, 2600);
  }

  /* ── tabs ──────────────────────────────────────────────────────────────── */

  function go(name) {
    tab = name;
    ["quotes", "charts", "trade", "history", "messages"].forEach(function (n) {
      var pane = $("tm-pane-" + n);
      var btn = document.querySelector('.tm-tab[data-tab="' + n + '"]');
      if (pane) pane.classList.toggle("on", n === name);
      if (btn) btn.classList.toggle("on", n === name);
    });
    drawBar();
    draw();
  }

  function draw() {
    /* The middle tab shows the account balance until something is open, and
       the floating profit from then on — coloured, on a tinted pill. The bar
       does the same above it: the screen name shrinks and the figure takes
       over, which is what makes an open account read at a glance. */
    var sm = T.summary();
    var live = T.positions().length > 0;
    var pill = $("tm-bal");
    pill.textContent = live ? money(sm.floating) : short(sm.balance);
    pill.className = "tm-bal" + (live ? " " + cls(sm.floating) : "");
    if (tab === "trade") {
      $("tm-sub").textContent = live ? money(sm.floating) + " USD" : "";
      $("tm-sub").className = live ? cls(sm.floating) : "";
      document.querySelector(".tm-bar").classList.toggle("tm-bar--pl", live);
    } else {
      $("tm-sub").className = "";
      document.querySelector(".tm-bar").classList.remove("tm-bar--pl");
    }
    if (tab === "trade") drawTrade();
    else if (tab === "quotes") drawQuotes();
    else if (tab === "charts") drawChart();
    else if (tab === "history") drawHistory();
    drawTicket();
  }

  /* ── wiring ────────────────────────────────────────────────────────────── */

  function bind() {
    $("tm-osym").innerHTML = T.symbols().map(function (s) {
      return '<option value="' + esc(s.name) + '">' + esc(s.name) + "</option>";
    }).join("");

    document.querySelectorAll(".tm-tab").forEach(function (b) {
      b.addEventListener("click", function () { go(b.getAttribute("data-tab")); });
    });

    /* The toolbar is rebuilt per screen, so its buttons are caught by
       delegation rather than bound once and lost on the next redraw. */
    $("tm-actions").addEventListener("click", function (e) {
      var b = e.target.closest("[data-act]");
      if (!b) return;
      var act = b.getAttribute("data-act");
      if (act === "newOrder" || act === "plus") {
        $("tm-osl").value = "";
        $("tm-otp").value = "";
        openSheet("tm-order");
        drawTicket();
      }
    });

    document.querySelectorAll(".tm-seg button").forEach(function (b) {
      b.addEventListener("click", function () {
        seg = b.getAttribute("data-seg");
        document.querySelectorAll(".tm-seg button").forEach(function (x) {
          x.classList.toggle("on", x === b);
        });
        drawHistory();
      });
    });

    $("tm-vminus").addEventListener("click", function () {
      $("tm-ovol").value = Math.max(0.01, Math.round((Number($("tm-ovol").value) - 0.01) * 100) / 100).toFixed(2);
    });
    $("tm-vplus").addEventListener("click", function () {
      $("tm-ovol").value = (Math.round((Number($("tm-ovol").value) + 0.01) * 100) / 100).toFixed(2);
    });
    $("tm-osym").addEventListener("change", drawTicket);
    $("tm-sell").addEventListener("click", function () { send("sell"); });
    $("tm-buy").addEventListener("click", function () { send("buy"); });

    $("tm-pos").addEventListener("click", function (e) {
      var row = e.target.closest(".tm-row");
      if (row) openMenu(Number(row.getAttribute("data-ticket")));
    });

    /* Tapping a quote opens its chart, which is what the app does. */
    $("tm-quotes").addEventListener("click", function (e) {
      var row = e.target.closest(".tm-q");
      if (!row) return;
      chartSym = row.getAttribute("data-sym");
      if (global.EvieFeed) global.EvieFeed.chart(chartSym);
      go("charts");
    });

    $("tm-close").addEventListener("click", function () {
      var p = T.positions().filter(function (x) { return x.ticket === menuFor; })[0];
      var profit = T.close(menuFor);
      closeSheet("tm-posmenu");
      if (profit != null && p) toast("Closed " + p.symbol + "  " + signed(profit));
      draw();
    });
    $("tm-save").addEventListener("click", function () {
      T.modify(menuFor, $("tm-msl").value, $("tm-mtp").value);
      closeSheet("tm-posmenu");
      toast("Position modified");
      draw();
    });

    document.querySelectorAll(".tm-sheet").forEach(function (sh) {
      sh.addEventListener("click", function (e) { if (e.target === sh) sh.hidden = true; });
    });
    document.querySelectorAll("[data-close]").forEach(function (b) {
      b.addEventListener("click", function () { closeSheet(b.getAttribute("data-close")); });
    });

    /* The drawer: the burger opens it, the strip of screen beside it closes
       it, and the items that lead somewhere lead there. */
    $("tm-burger").addEventListener("click", function () { $("tm-scrim").hidden = false; });
    $("tm-scrim").addEventListener("click", function (e) {
      if (e.target === $("tm-scrim")) $("tm-scrim").hidden = true;
    });
    document.querySelectorAll("[data-go]").forEach(function (b) {
      b.addEventListener("click", function () {
        $("tm-scrim").hidden = true;
        go(b.getAttribute("data-go"));
      });
    });
    $("tm-manage").addEventListener("click", function () {
      $("tm-scrim").hidden = true;
      openSheet("tm-accts");
    });
    $("tm-add").addEventListener("click", function () {
      $("tm-scrim").hidden = true;
      openSheet("tm-accts");
    });

    $("tm-deposit").addEventListener("click", function () {
      var v = prompt("Deposit", "1000");
      if (v == null) return;
      T.deposit(v);
      closeSheet("tm-accts");
      toast("Balance updated");
      draw();
    });
    $("tm-reset").addEventListener("click", function () {
      T.reset();
      closeSheet("tm-accts");
      toast("Account reset");
      draw();
    });
    $("tm-exit").addEventListener("click", function () { global.location.href = "/mt5.html"; });

    go("trade");
    /* Redrawing, not stepping. There is no tape to advance any more: prices
       arrive from Deriv and the engine applies them as they land, so this only
       repaints what is already true. */
    setInterval(draw, 700);

    if (global.EvieFeed) {
      global.EvieFeed.start(function () {
        /* The chart follows whatever the feed actually carries. Naming a
           default instrument here would be naming one that may not exist on
           this socket, and the chart would then have nothing to draw. */
        if (!T.symbol(chartSym)) {
          var first = T.symbols()[0];
          if (first) { chartSym = first.name; global.EvieFeed.chart(chartSym); }
        }
        draw();
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bind);
  } else {
    bind();
  }
})(window);
