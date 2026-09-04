/**
 * UPTICK — the MT5 automation page.
 *
 * Three things happen here, in the order the page presents them: the file is
 * downloaded and installed, a risk profile is chosen, and the signals the
 * engine is producing right now are shown.
 *
 * The third one is the point. The Expert Advisor reads exactly the same feed
 * this panel does — same URL, same engine, only the format differs — so what
 * is on screen is what the bot in the terminal is acting on, not a marketing
 * approximation of it. When the panel is empty, the bot is holding fire too.
 *
 * Nothing on this page touches a Deriv account. Market data needs no token, so
 * this works for somebody who has not connected one and never asks them to.
 */

(function (global) {
  "use strict";

  var API = "/api/mt5/signals";
  var CATEGORIES = "forex,volatility";
  var REFRESH_MS = 60000;      // the panel re-reads the market every minute
  var KEY = "uptick_mt5_profile";

  /* Where somebody with no MT5 account has to go before any of this is any
     use to them. Opened once, alongside the first download. */
  var DERIV_SIGNUP = "https://t.deriv.link?t=8XPRHR2Y8SN8";
  var GOT_EA_KEY = "uptick_mt5_got_ea";

  /* Drawn before the first response so the choice is never an empty row. The
     server sends its own copy with every answer and that one wins — these are
     the fallback for a first paint and for a feed that is down. */
  var PROFILES = [
    { key: "conservative", label: "Conservative", riskPerTradePct: 0.4,
      blurb: "Fewer, high-conviction trades. No adding to positions. Tight risk, wide stops." },
    { key: "moderate", label: "Moderate", riskPerTradePct: 0.75,
      blurb: "Balanced. Trades the clean trends and ranges, scales in up to twice on strength." },
    { key: "aggressive", label: "Aggressive", riskPerTradePct: 1.5,
      blurb: "Presses winners hard — pyramids into strong trends, trades more setups, bigger runners." }
  ];

  var ICONS = {
    conservative: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    moderate: '<path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/><path d="M12 2v3m0 14v3m10-10h-3M5 12H2m15.1-7.1-2.1 2.1M8.6 15.4l-2.1 2.1m0-11.9 2.1 2.1m6.8 6.8 2.1 2.1"/>',
    aggressive: '<path d="M13 2 4.1 12.6a1 1 0 0 0 .8 1.6H11l-1 7.8 8.9-10.6a1 1 0 0 0-.8-1.6H12z"/>'
  };

  var el = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  };
  var svg = function (body, size) {
    return '<svg viewBox="0 0 24 24" width="' + (size || 15) + '" height="' + (size || 15) +
      '" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' + body + "</svg>";
  };

  var profile = "aggressive";
  var loading = false;
  var timer = null;

  /* ── the risk profiles ─────────────────────────────────────────────── */

  function drawProfiles(list) {
    if (list && list.length) PROFILES = list;
    el("profiles").innerHTML = PROFILES.map(function (p) {
      var on = p.key === profile;
      return '<button class="mt5-prof' + (on ? " is-on" : "") + '" type="button" data-p="' + esc(p.key) + '"' +
        ' aria-pressed="' + on + '">' +
        '<span class="mt5-prof-h">' +
          svg(ICONS[p.key] || ICONS.moderate, 17) +
          '<span class="mt5-prof-t">' + esc(p.label) + "</span>" +
          '<span class="mt5-prof-tick">' + svg('<path d="M20 6 9 17l-5-5"/>', 15) + "</span>" +
        "</span>" +
        '<p class="mt5-prof-s">' + esc(p.blurb) + "</p>" +
        '<div class="mt5-prof-r">Risk per trade ' + esc(p.riskPerTradePct) + "%</div>" +
      "</button>";
    }).join("");
  }

  function choose(key) {
    if (key === profile) return;
    profile = key;
    try { localStorage.setItem(KEY, key); } catch (e) { /* private mode */ }
    drawProfiles();
    load();
  }

  /* ── the signals ───────────────────────────────────────────────────── */

  function money(v, digits) {
    var n = Number(v);
    return isFinite(n) ? n.toFixed(digits || 2) : "—";
  }

  function signalCard(s) {
    var buy = s.side === "buy";
    var arrow = buy
      ? '<path d="M22 7 13.5 15.5 8.5 10.5 2 17"/><path d="M16 7h6v6"/>'
      : '<path d="M22 17 13.5 8.5 8.5 13.5 2 7"/><path d="M16 17h6v-6"/>';

    var legs = [
      ["Entry", s.entry, ""],
      ["Stop", s.stopLoss, " mt5-leg--stop"],
      ["Target", s.takeProfit, " mt5-leg--target"]
    ].map(function (l) {
      return '<div class="mt5-leg' + l[2] + '">' +
        '<div class="mt5-leg-k">' + l[0] + "</div>" +
        '<div class="mt5-leg-v">' + money(l[1], s.digits) + "</div>" +
      "</div>";
    }).join("");

    return '<article class="mt5-sig">' +
      '<div class="mt5-sig-h">' +
        svg('<path d="M12 2 2 7l10 5 10-5-10-5z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/>', 15) +
        '<span class="mt5-sig-n">' + esc(s.name) + "</span>" +
        '<span class="mt5-side mt5-side--' + (buy ? "buy" : "sell") + '">' +
          svg(arrow, 12) + esc(s.side) +
        "</span>" +
      "</div>" +
      '<p class="mt5-sig-why">' + esc(s.reason) + "</p>" +
      '<div class="mt5-legs">' + legs + "</div>" +
      '<div class="mt5-sig-f">' +
        "<span>Risk " + esc(s.riskPct) + "% · " + esc(String(s.regime).replace("_", " ")) + "</span>" +
        '<span class="mt5-conf">' +
          '<span class="mt5-bar' + (buy ? "" : " mt5-bar--sell") + '">' +
            '<span style="width:' + Math.max(0, Math.min(100, Number(s.confidence) || 0)) + '%"></span>' +
          "</span>" + esc(s.confidence) + "%" +
        "</span>" +
      "</div>" +
    "</article>";
  }

  function draw(d) {
    var sigs = el("signals");
    var aside = el("aside");

    if (d.signals.length) {
      sigs.className = "mt5-sigs";
      sigs.innerHTML = d.signals.map(signalCard).join("");
    } else {
      sigs.className = "mt5-quiet";
      sigs.innerHTML = "<span>No entries right now — the engine only fires on a clean setup. " +
        "It re-scans continuously and refreshes here every minute.</span>";
    }

    el("sig-meta").textContent = d.signals.length + " active · " +
      d.meta.withData + "/" + d.meta.evaluated + " markets scanned · highest-confidence first";

    if (d.standAside && d.standAside.length) {
      aside.innerHTML = '<details class="mt5-aside">' +
        "<summary>Standing aside on " + d.standAside.length + " markets</summary>" +
        '<div class="mt5-aside-l">' + d.standAside.map(function (a) {
          return '<div class="mt5-aside-r"><span class="mt5-aside-s">' + esc(a.name) +
            '</span><span class="mt5-aside-w">' + esc(a.reason) + "</span></div>";
        }).join("") + "</div></details>";
    } else {
      aside.innerHTML = "";
    }
  }

  function busy(on) {
    loading = on;
    document.body.classList.toggle("is-busy", on);
    el("refresh").disabled = on;
  }

  function fail(message) {
    var e = el("err");
    e.textContent = message;
    e.hidden = false;
  }

  function load() {
    if (loading) return;
    busy(true);

    // The first read has nothing on screen yet, so it says what it is doing.
    // Later ones must not blank a panel the bot is acting on.
    var sigs = el("signals");
    if (!sigs.innerHTML) {
      sigs.className = "mt5-quiet";
      sigs.innerHTML = '<span class="mt5-quiet-in">' +
        svg('<path d="M21 12a9 9 0 1 1-6.2-8.6"/>', 16) +
        "Scanning forex + Volatility…</span>";
    }

    fetch(API + "?profile=" + encodeURIComponent(profile) + "&categories=" + CATEGORIES, { cache: "no-store" })
      .then(function (r) {
        return r.json().catch(function () { return null; }).then(function (j) {
          if (!r.ok || !j || j.error) {
            throw new Error((j && j.error) || "Couldn't load signals.");
          }
          return j;
        });
      }, function () {
        // A dropped connection throws "Failed to fetch", which tells somebody
        // nothing they can act on. Say what happened and that it is temporary.
        throw new Error("Couldn't reach the signal feed. This panel tries again every minute.");
      })
      .then(function (d) {
        el("err").hidden = true;
        if (d.profiles) drawProfiles(d.profiles);
        draw(d);
        var stamp = el("stamp");
        stamp.textContent = "updated " + new Date().toLocaleTimeString() + " · auto every 60s";
        stamp.hidden = false;
      })
      .catch(function (e) {
        fail(e && e.message ? e.message : "Couldn't load signals.");
      })
      .then(function () { busy(false); });
  }

  /* ── wiring ────────────────────────────────────────────────────────── */

  try {
    var saved = localStorage.getItem(KEY);
    if (saved === "conservative" || saved === "moderate" || saved === "aggressive") profile = saved;
  } catch (e) { /* private mode — the default stands */ }

  drawProfiles();

  el("profiles").addEventListener("click", function (ev) {
    var b = ev.target.closest("[data-p]");
    if (b) choose(b.getAttribute("data-p"));
  });

  el("refresh").addEventListener("click", function () { load(); });

  /* The file is no use without an MT5 account to run it against, and the
     download itself takes a moment during which there is nothing to look at.
     So the FIRST time somebody takes the EA, Deriv opens alongside it and
     they can be signing up while the file lands. Once only — after that they
     have an account, and a tab they did not ask for is just rude.

     The window is opened inside the click, which is what keeps the browser
     from treating it as a pop-up. The download is untouched: the link's own
     default behaviour still runs. */
  var opened = false;
  el("get-ea").addEventListener("click", function () {
    var first;
    try { first = !localStorage.getItem(GOT_EA_KEY); }
    catch (e) { first = !opened; }   // private mode: at least not twice a session
    if (!first) return;
    opened = true;
    try { localStorage.setItem(GOT_EA_KEY, "1"); } catch (e) { /* private mode */ }
    global.open(DERIV_SIGNUP, "_blank", "noopener,noreferrer");
  });

  // A minute of polling behind a hidden tab is a minute of nothing anybody can
  // see, so the clock stops when the page is not on screen and the panel is
  // brought up to date the moment it comes back.
  function tick() {
    clearInterval(timer);
    timer = setInterval(function () { if (!document.hidden) load(); }, REFRESH_MS);
  }
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) { load(); tick(); }
  });

  load();
  tick();

  global.UptickMt5 = { load: load, profile: function () { return profile; } };
})(window);
