/**
 * PIPVANA — Pipvana Radar's panel, in Pipvana's own design.
 *
 * scan/bot.js trades and paints its own counters (profit, trades, next stake,
 * losses in a row, the live scan, the popups); this file draws the rest of the
 * page from the run bot.js keeps:
 *
 *   - Start and Stop, as on Pipvana AI, and Run / Stop under the
 *     Transactions bar on a narrow screen (bot.js has one button that does
 *     both; it is kept out of sight and these press it);
 *   - the session's win rate and running time;
 *   - Transactions, Analysis's own panel (analysis/txn.js): every trade of the
 *     run with the two spots it settled between, what it cost and what it
 *     made, the totals underneath, the newest arriving at the top. Reset
 *     clears what is shown; the run itself is not touched;
 *   - the screen it is on: the page always fits, whatever the window, the
 *     device or the browser's zoom — nothing scrolls but the trades.
 *
 * It only reads: nothing here can start, buy or stop anything bot.js did not
 * ask for.
 */

(function (global) {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var T = function (s) { return typeof global.t === "function" ? global.t(s) : s; };
  var B = function () { return global.PvrBot && global.PvrBot.run ? global.PvrBot.run() : null; };
  if (!$("scan") || !$("botGo")) return;

  var go = $("botGo");
  function active() { var r = B(); return !!(r && r.active); }

  /* ── Start / Stop, and Run / Stop under the Transactions bar ──────── */

  var start = $("botStart"), stop = $("botStop"), runBtn = $("txn-run");
  start.addEventListener("click", function () { if (!active() && !go.disabled) go.click(); });
  stop.addEventListener("click", function () { var r = B(); if (r && r.active && !r.stopping && !go.disabled) go.click(); });
  if (runBtn) runBtn.addEventListener("click", function () {
    var r = B();
    if (r && r.active) { if (!r.stopping && !go.disabled) go.click(); }
    else if (!go.disabled) go.click();
  });
  function paintButtons() {
    var r = B(), running = !!(r && r.active), stopping = !!(running && r.stopping);
    start.disabled = running || go.disabled;
    stop.disabled = !running || stopping;
    stop.classList.toggle("is-stopping", stopping);
    if (runBtn) {
      runBtn.classList.toggle("is-running", running);
      runBtn.disabled = stopping || (!running && go.disabled);
      $("txn-run-label").textContent = T(running ? (stopping ? "Stopping…" : "Stop") : "Run");
    }
  }

  /* ── the session ───────────────────────────────────────────────────── */

  function clock(ms) {
    var s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    s = s % 60;
    return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
  }
  function paintStats() {
    var r = B(), n = r ? r.n : 0, won = r ? r.won : 0;
    var rate = $("pRate");
    rate.textContent = (n ? Math.round(won / n * 100) : 0) + "%";
    rate.classList.toggle("is-up", n > 0 && won / n >= 0.5);
    rate.classList.toggle("is-down", n > 0 && won / n < 0.5);
    var end = r ? (r.active ? Date.now() : (r.ended && r.ended.at ? r.ended.at * 1000 : Date.now())) : 0;
    $("pTime").textContent = r && r.startedAt ? clock(end - r.startedAt * 1000) : "00:00:00";
    // The live strip at rest says when it starts; while a run goes it is the run's.
    var scan = document.querySelector(".sh-scan");
    if (scan) scan.classList.toggle("is-on", !$("botNow").hidden);
  }

  /* ── Transactions ──────────────────────────────────────────────────── */

  function marketOf(code) {
    var h = global.PvrBot && global.PvrBot.hub, m = h && h.markets && h.markets[code];
    return (m && m.name) || code;
  }
  var txn = global.EvieTxn ? new global.EvieTxn({ root: $("txn"), nameOf: marketOf }) : null;

  /* Reset clears what the list shows, as on Analysis; the run and its figures go on. Kept for
     the tab, so a reload does not bring the cleared trades back. */
  var CLEARED = "pvr_txn_cleared";
  var cleared = 0;
  try { cleared = Number(sessionStorage.getItem(CLEARED)) || 0; } catch (e) {}
  var shownTop = null, shownN = 0, drawnSig = null;
  if (txn) {
    txn.reset = function () {
      cleared = Date.now();
      try { sessionStorage.setItem(CLEARED, String(cleared)); } catch (e) {}
      drawnSig = null;
      syncTrades();
    };
  }
  function key(x) { return x.id ? String(x.id) : x.at + ":" + x.stake + ":" + x.pl; }
  function syncTrades() {
    if (!txn) return;
    var r = B(), log = ((r && r.log) || []).filter(function (x) { return (x.at || 0) > cleared; });
    // Newest first by the time each trade settled: one booked late takes its own place.
    log.sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
    var top = log.length ? key(log[0]) : null;
    // Nothing new since the last paint: the list stays as it is (no redraw, nothing moves).
    var sig = ((r && r.currency) || "") + "|" + log.map(function (x) { return key(x) + (x.won ? "w" : "l") + x.pl + (x.entry || "") + (x.exit || ""); }).join(",");
    if (sig === drawnSig) { paintBarPl(); return; }
    drawnSig = sig;
    txn.setCurrency((r && r.currency) || "USD");
    txn.rows = log.map(function (x) {
      var stake = Number(x.stake) || 0, pl = Number(x.pl) || 0;
      return {
        label: x.label, market: x.market,
        entry: x.entry ? x.entry : null, exit: x.exit ? x.exit : null,
        stake: stake, payout: x.won ? stake + pl : 0, profit: pl, win: !!x.won,
      };
    });
    // One or two new trades slide in at the top; a burst (a reload catching up) just appears.
    txn.arriving = !!top && top !== shownTop && log.length > shownN && log.length - shownN <= 2;
    txn.render();
    txn.arriving = false;
    // The rows are never translated (markets and figures); the line for none is, in the page's language.
    var none = txnEl.querySelector(".tx-none");
    if (none) none.textContent = T("No transactions yet.");
    shownTop = top; shownN = log.length;
    paintBarPl();
  }

  /* Run / Stop sits under the Transactions bar while the sheet is parked, and just above Reset
     while the transactions are open (the raised sheet, or the card on a wide screen). html gets
     "txn-open" while the sheet is raised, so the floating buttons keep to its foot. */
  var box = runBtn && runBtn.parentNode, txnEl = $("txn");
  function sheet() { return !!(txn && txn.isSheet()); }
  function placeRun() {
    if (!box || !txnEl) return;
    var narrow = sheet(), raised = txnEl.classList.contains("is-open");
    var reset = txnEl.querySelector("[data-reset]"), handle = txnEl.querySelector("[data-handle]");
    if (!narrow || raised) { if (reset && box.nextElementSibling !== reset) reset.parentNode.insertBefore(box, reset); }
    else if (handle && handle.nextElementSibling !== box) handle.parentNode.insertBefore(box, handle.nextSibling);
    box.classList.toggle("is-in", !narrow || raised);
    document.documentElement.classList.toggle("txn-open", narrow && raised);
    paintBarPl();
  }
  /* The run's P/L on the parked bar (narrow screens only), at its right end: the bar keeps its size. */
  function paintBarPl() {
    var b = $("txn-pl");
    if (!b || !txnEl) return;
    var r = B(), show = !!(r && r.active) && sheet() && !txnEl.classList.contains("is-open");
    b.hidden = !show;
    if (!show) return;
    var v = r.pl || 0, cur = r.currency || "USD";
    var d = global.EvieCurrency ? global.EvieCurrency.digits(cur) : 2;
    b.textContent = (v >= 0 ? "+" : "") + Number(v).toFixed(d);
    b.className = "txn-pl" + (v > 0 ? " is-up" : v < 0 ? " is-down" : "");
  }
  if (txnEl && global.MutationObserver) {
    new MutationObserver(placeRun).observe(txnEl, { attributes: true, attributeFilter: ["class"] });
  }

  /* A run that starts on a narrow screen raises the trades, where they arrive; the sheet stays
     up until it is put away (Analysis does the same). Not where Start and Stop stay on the page
     (a phone on its side): there the sheet would cover them. */
  var wasActive = active();
  function onRunChange() {
    var now = active();
    if (now && !wasActive && txn && sheet() && box && box.offsetParent) txn.open();
    wasActive = now;
  }

  /* ── the result popups' details ────────────────────────────────────── */

  function fillResult() {
    var r = B();
    if (!r) return;
    var end = r.ended && r.ended.at ? r.ended.at * 1000 : Date.now();
    var time = r.startedAt ? clock(end - r.startedAt * 1000) : "00:00:00";
    ["Win", "Loss"].forEach(function (k) {
      if (!$("bm" + k + "N")) return;
      $("bm" + k + "N").textContent = String(r.n);
      $("bm" + k + "WL").textContent = r.won + " / " + r.lost;
      $("bm" + k + "Time").textContent = time;
    });
  }
  if (global.MutationObserver) {
    var res = new MutationObserver(fillResult);
    ["bmWinAmt", "bmLossAmt"].forEach(function (id) { if ($(id)) res.observe($(id), { childList: true, characterData: true, subtree: true }); });
  }

  /* ── the screen it is on ───────────────────────────────────────────────
     Header, the tools, the bot, the session, the trades and the small print are
     one screen at every size: the page never scrolls. The layout does it at the
     sizes it was drawn for; anywhere tighter (a short window, a phone on its
     side, the browser zoomed right in) the page is set a little smaller, as
     much as it takes and no more. Only the trade list scrolls, inside itself. */
  var fitEl = $("sh-fit"), MIN_Z = 0.5;
  function over() {
    if (fitEl.scrollHeight > fitEl.clientHeight + 1) return true;
    var scan = $("scan");
    if (!scan.hidden && scan.scrollHeight > scan.clientHeight + 1) return true;
    var cards = fitEl.querySelectorAll("[data-fit]");
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i];
      if (c.offsetParent && c.scrollHeight > c.clientHeight + 1) return true;
    }
    // The trades keep a few rows' room on a wide screen.
    var rows = txnEl && !sheet() && txnEl.querySelector(".txn-rows");
    if (rows && rows.offsetParent && rows.clientHeight < 60) return true;
    return false;
  }
  function fit() {
    if (!fitEl) return;
    var nav = document.querySelector(".top");
    var top = nav ? nav.getBoundingClientRect().height : 0;
    var h = global.innerHeight;
    // The sheet keeps its own size whatever the page is set to (its zoom undoes the page's), so
    // its bar, Run / Stop and the chat button on it always line up.
    var parked = function () {
      if (!sheet() || $("scan").hidden) return 0;
      var hd = txnEl.querySelector("[data-handle]");
      return (hd ? hd.offsetHeight : 46) + (box && !box.classList.contains("is-in") ? box.offsetHeight : 0);
    };
    var z = 1;
    var size = function () {
      fitEl.style.zoom = z === 1 ? "" : String(z);
      txnEl.style.zoom = z === 1 || !sheet() ? "" : String(1 / z);
      fitEl.style.height = Math.floor((h - top - parked()) / z) + "px";
    };
    size();
    while (over() && z > MIN_Z) { z = Math.max(MIN_Z, Math.round((z - 0.03) * 100) / 100); size(); }
    fitEl.classList.toggle("is-tight", over());
    document.documentElement.style.setProperty("--sh-z", String(z));
  }
  var fitQueued = false;
  function fitSoon() {
    if (fitQueued) return;
    fitQueued = true;
    setTimeout(function () { fitQueued = false; try { fit(); } catch (e) {} }, 30);
  }
  global.addEventListener("resize", fitSoon);
  global.addEventListener("orientationchange", fitSoon);
  global.addEventListener("langchange", fitSoon);
  global.addEventListener("load", fitSoon);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitSoon);
  if (global.visualViewport) global.visualViewport.addEventListener("resize", fitSoon);
  if (global.MutationObserver) {
    // Anything that comes or goes in the bot (a field, a note, the live scan) is measured again.
    var fo = new MutationObserver(fitSoon);
    fo.observe($("scan"), { attributes: true, attributeFilter: ["hidden"], subtree: true, childList: true });
    fo.observe($("tState"), { attributes: true, attributeFilter: ["hidden"], subtree: true });
  }

  /* ── keeping up ────────────────────────────────────────────────────── */

  var queued = false;
  function paint() {
    if (queued) return;
    queued = true;
    setTimeout(function () {
      queued = false;
      try { paintButtons(); } catch (e) {}
      try { paintStats(); } catch (e) {}
      try { syncTrades(); } catch (e) {}
      try { onRunChange(); } catch (e) {}
      try { placeRun(); } catch (e) {}
    }, 16);
  }
  if (global.MutationObserver) {
    var mo = new MutationObserver(paint);
    [go, $("botGoText"), $("botN"), $("botPl"), $("botNext"), $("botStreak"), $("botStateText"), $("botLog"), $("botNow"), $("nowMarket"), $("nowSide"), $("acctAmt")].forEach(function (el) {
      if (el) mo.observe(el, { attributes: true, childList: true, characterData: true, subtree: true });
    });
  }
  global.addEventListener("pvr:account", paint);
  global.addEventListener("pvr:runend", paint);
  global.addEventListener("resize", function () { placeRun(); });
  global.addEventListener("langchange", function () { drawnSig = null; paint(); });
  setInterval(function () { if (active()) paint(); }, 1000);

  // iPhones show a button's pressed state only on a page that listens to touches.
  document.addEventListener("touchstart", function () {}, { passive: true });

  paint();
  placeRun();
  fit();
})(window);
