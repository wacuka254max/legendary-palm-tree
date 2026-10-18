/**
 * PIPVANA — Pipvana Radar — the dashboard's Deriv connection and the live balance.
 *
 * The same connection Magic Bots Lab already makes (the OAuth token index.html
 * stores after the sign-in, app 338udJBKn1EbT7Tc29Snv, Deriv's options REST
 * API and its one-time WebSocket URLs), kept up the way a bot needs it:
 *
 *   1. The token: the stored session, renewed with its refresh token when it
 *      has one and is near its end. No token: back to index.html, where
 *      connecting starts.
 *   2. The accounts: GET /trading/v1/options/accounts, with their balances.
 *   3. One socket per account (Deriv authorises a socket for exactly one
 *      account), each subscribed to balance. Real and demo are both live, so
 *      switching is instant and both figures are always current. The same
 *      socket carries the scan's questions and the trades: one connection per
 *      account, two in all, where Deriv allows five per person.
 *
 * Staying connected, which is the whole point:
 *
 *   - a ping every 20 s keeps proxies from closing a quiet socket and proves
 *     the line is alive; a socket that has said nothing for 50 s is treated as
 *     dead even if the browser still calls it open (a phone that slept, a
 *     network that changed under it) and is replaced;
 *   - every reopen asks for a NEW one-time URL (single use, about 120 s) and
 *     backs off 0.5 s, 1 s, 2 s … up to 30 s, with jitter, which also keeps
 *     well inside Deriv's 60 REST calls a minute for one token;
 *   - coming back online, or back to the tab, reopens anything not live at
 *     once instead of waiting out a backoff the browser froze; a network
 *     change pings every socket and replaces one that does not answer in 6 s;
 *     a check every 30 s reopens any feed left closed with nothing scheduled;
 *   - while a feed is down the balance is still read over REST every 15 s.
 *
 * Nothing here ever interrupts a running bot: a token that has lapsed waits
 * until no run is going (the open sockets stay authorised meanwhile).
 *
 * The demo account is listed under the real one (owner, Oct 12: no longer out of
 * sight). A login with only a demo trades on it, and is offered a real account.
 */

(function (global) {
  "use strict";

  var CLIENT_ID = "34hMNQ8a0upKxPhFT6O0X";
  var ACCOUNTS_URL = "https://api.derivws.com/trading/v1/options/accounts";
  var TOKEN_URL = "https://auth.deriv.com/oauth2/token";
  var TOKEN_KEY = "evie_deriv_token";        // deriv.js's keys: the connection itself
  var SESSION_KEY = "evie_deriv_session";
  var PICK = "pvr_smart_pick";                // the account last shown
  var LAST = "pvr_smart_last";                // the last balances seen — figures only, never a token

  var PING_MS = 20000;
  var STALE_MS = 50000;
  var POLL_MS = 15000;

  var $ = function (id) { return document.getElementById(id); };
  var T = function (s) { return typeof global.t === "function" ? global.t(s) : s; };

  /* Real is the account every visit opens on (owner, Oct 18). A demo picked stays for this visit
     only, or for a demo run a reload interrupted; a login with only a demo opens on the way to a
     real account, its demo one tap away ("or try the demo"). */
  function demoThisVisit(v) {
    try {
      if (v === true) sessionStorage.setItem(PICK + "_visit", "demo");
      else if (v === false) sessionStorage.removeItem(PICK + "_visit");
      return sessionStorage.getItem(PICK + "_visit") === "demo";
    } catch (e) { return false; }
  }
  /* "or try the demo" in every language the site speaks, carried here too (a dictionary cached before
     it existed must not leave it English). */
  function tryDemoWords() {
    var t = T("or try the demo");
    if (t !== "or try the demo") return t;
    var i = { es: 0, fr: 1, pt: 2 }[String(document.documentElement.lang || "").slice(0, 2).toLowerCase()];
    return i == null ? t : ["o prueba la demo", "ou essayez la démo", "ou experimente a demo"][i];
  }
  var tryDemoBack = null;
  function demoOffer(on, back) {
    if (back) tryDemoBack = back;
    var btn = document.getElementById("acctTryDemo");
    if (!btn) {
      if (!on) return;
      var real = document.getElementById("acctOpenReal") || document.querySelector("#acct .tbal-open-real, #acct .cs-open-real");
      if (!real || !real.parentNode) return;
      btn = document.createElement("button"); btn.type = "button"; btn.id = "acctTryDemo"; btn.className = "acct-try-demo";
      real.parentNode.insertBefore(btn, real.nextSibling);
      btn.addEventListener("click", function () { demoThisVisit(true); btn.hidden = true; if (tryDemoBack) tryDemoBack(); });
      global.addEventListener("langchange", function () { btn.textContent = tryDemoWords(); });
      var s = document.createElement("style");
      s.textContent = ".acct-try-demo{display:inline-flex;align-items:center;margin-left:8px;padding:4px 2px;background:none;border:0;font:inherit;font-size:12px;font-weight:600;color:inherit;opacity:.85;text-decoration:underline;text-underline-offset:2px;cursor:pointer;white-space:nowrap}.acct-try-demo[hidden]{display:none!important}";
      document.head.appendChild(s);
    }
    btn.textContent = tryDemoWords();
    btn.hidden = !on;
  }
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} },
  };

  /* ── the token ─────────────────────────────────────────────────────── */

  function session() { try { return JSON.parse(store.get(SESSION_KEY) || "null"); } catch (e) { return null; } }
  var renewing = null;
  /** A token Deriv accepts, renewed first when it is near its end and can be. */
  function token() {
    var s = session();
    if (s && s.access_token && s.expires_at && Date.now() < s.expires_at - 60000) return Promise.resolve(s.access_token);
    if (!s || !s.refresh_token) return Promise.resolve(store.get(TOKEN_KEY) || (s && s.access_token) || "");
    if (renewing) return renewing;
    renewing = fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: s.refresh_token }),
    }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
      renewing = null;
      if (!j || !j.access_token) return s.access_token || store.get(TOKEN_KEY) || "";
      var next = { access_token: j.access_token, refresh_token: j.refresh_token || s.refresh_token, expires_at: Date.now() + (j.expires_in || 3600) * 1000 };
      store.set(SESSION_KEY, JSON.stringify(next));
      store.set(TOKEN_KEY, next.access_token);
      return next.access_token;
    }, function () { renewing = null; return s.access_token || store.get(TOKEN_KEY) || ""; });
    return renewing;
  }
  function forget() { store.del(TOKEN_KEY); store.del(SESSION_KEY); }

  /** Deriv's REST API with the token. Resolves { status, body } for any answer;
   *  rejects only when nothing came back. */
  function rest(method, url) {
    return token().then(function (tk) {
      if (!tk) return { status: 401, body: {} };
      return fetch(url, { method: method, cache: "no-store", headers: { "Authorization": "Bearer " + tk, "Deriv-App-ID": CLIENT_ID } })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (b) { return { status: r.status, body: b || {} }; }); });
    });
  }

  /* ── the states the page shows before there are balances ───────────── */

  var painted = false;
  function showBusy(text) {
    if (painted) return;
    $("tState").hidden = false;
    $("tBusy").hidden = false;
    $("tNote").hidden = true;
    $("tBusyText").textContent = T(text || "Connecting to Deriv…");
  }
  function showNote(text) {
    painted = false;
    needReal = null;
    $("acct").classList.remove("is-noreal");
    $("acct").hidden = true;
    if ($("scan")) $("scan").hidden = true;
    $("tState").hidden = false;
    $("tBusy").hidden = true;
    $("tNote").hidden = false;
    $("tNoteText").textContent = T(text);
  }
  function clearState() { $("tState").hidden = true; }

  /** A bot run is going in this page (bot.js): nothing may navigate away. */
  function busy() {
    try { var r = global.PvrBot && global.PvrBot.run && global.PvrBot.run(); return !!(r && r.active); }
    catch (e) { return false; }
  }
  /** Not connected (or no longer): to index.html, where connecting starts. */
  function home() { global.location.replace("/"); }

  /* ── the accounts ──────────────────────────────────────────────────── */

  var accounts = [];      // { id, type, currency, balance, status }
  var feeds = {};         // id → Feed
  var picked = null;      // the id shown in the chip
  var showDemo = true;    // the demo is listed with the real account, always

  function isReal(a) {
    var t = String(a.account_type || a.type || "").toLowerCase(), id = String(a.account_id || a.loginid || "");
    if (t.indexOf("real") >= 0) return true;
    if (t.indexOf("demo") >= 0 || t.indexOf("virtual") >= 0) return false;
    return /^CR|^ROT/.test(id);
  }
  function normal(list) {
    return (list || []).map(function (a) {
      var id = String(a.account_id || a.loginid || a.id || "");
      return { id: id, type: isReal(a) ? "real" : "demo", currency: a.currency || "", balance: a.balance != null ? Number(a.balance) : null, status: a.status || "active", at: Date.now() };
    }).filter(function (a) { return a.id; });
  }
  function listOf(body) {
    return Array.isArray(body.data) ? body.data : Array.isArray(body.accounts) ? body.accounts : (body.data && Array.isArray(body.data.accounts) ? body.data.accounts : []);
  }

  var bootTries = 0;
  function boot() {
    showBusy();
    token().then(function (tk) {
      if (!tk) return home();
      return rest("GET", ACCOUNTS_URL).then(function (r) {
        if (r.status === 401) return expired();
        if (r.status >= 500 || r.status === 429) return bootLater();
        bootTries = 0;
        start(normal(listOf(r.body)));
      });
    }).catch(bootLater);
  }
  function bootLater() {
    bootTries++;
    showBusy("Deriv is not answering yet — trying again…");
    setTimeout(boot, Math.min(30000, 1000 * Math.pow(2, bootTries)) * (0.75 + Math.random() * 0.5));
  }

  /** A run this tab is carrying through a reload (bot.js keeps it in sessionStorage). */
  function savedRun() { try { return JSON.parse(sessionStorage.getItem("pvr_smart_run") || "null"); } catch (e) { return null; } }

  function start(list) {
    accounts = list;
    if (!accounts.length) return noReal("none");
    // A run on the demo that a reload interrupted resumes there: the chip shows the demo with it.
    var sv = savedRun(), on = sv && account(sv.account);
    if (on && on.type === "demo") { showDemo = true; store.set(PICK, on.id); demoThisVisit(true); }
    picked = pickShown();
    if (!picked) return noReal("real");
    // Only a demo: it is in use, and the bot offers a real account (needsReal() "real").
    needReal = accounts.some(function (a) { return a.type === "real"; }) ? null : "real";
    if (needReal === "real" && !demoThisVisit()) { var all = accounts; picked = null; demoOffer(true, function () { start(all); }); return noReal("real"); }
    demoOffer(false);
    $("acct").classList.remove("is-noreal");
    clearState();
    $("acct").hidden = false;
    painted = true;
    paint();
    accounts.forEach(function (a) {
      // A feed already open (the demo in use when a real account comes in) is left as it is.
      if (a.status !== "active" || feeds[a.id]) return;
      (feeds[a.id] = new Feed(a.id)).retry(true);
    });
    startPolling();
  }

  /* ── no real account yet ───────────────────────────────────────────── */

  /* A login with no real account (only a demo, or no account at all) sees the page as it
     is: the bot at rest, a red way to open one where the balance would be, and the popup
     saying why it is needed (bot.js). Coming back to the page reads the accounts again,
     so a real account opened on Deriv meanwhile takes over without a reload. */
  var needReal = null;           // null, or "real" (only a demo) / "none" (no account at all)
  function noReal(kind) {
    needReal = kind;
    painted = false;
    clearState();
    if (!$("acctMenu").hidden) openMenu(false);
    var box = $("acct");
    box.classList.remove("is-real", "is-demo", "is-live", "is-wait");
    box.classList.add("is-noreal");
    box.hidden = false;
    try { global.dispatchEvent(new CustomEvent("pvr:account")); } catch (e) {}
  }
  var lookedAt = 0;
  function lookAgain() {
    // Offline, nothing can be read: the "online" that follows looks at once.
    if (!needReal || gone || document.visibilityState === "hidden" || navigator.onLine === false || Date.now() - lookedAt < 4000) return;
    if (needReal === "real" && busy()) return;           // a run on the demo: the real account can wait
    lookedAt = Date.now();
    rest("GET", ACCOUNTS_URL).then(function (r) {
      if (!needReal) return;
      if (r.status === 401) return expired();              // refused, as everywhere else: back to sign in
      if (r.status !== 200) return;
      var list = normal(listOf(r.body));
      if (list.some(function (a) { return a.type === "real"; })) return start(list);
      var kind = list.length ? "real" : "none";
      if (kind !== needReal) noReal(kind);
    }).catch(function () { lookedAt = 0; });   // nothing came back: the next chance looks again
  }
  document.addEventListener("visibilitychange", lookAgain);
  global.addEventListener("focus", lookAgain);
  global.addEventListener("online", lookAgain);

  function account(id) { return accounts.filter(function (a) { return a.id === id; })[0] || null; }
  function shown(a) { return a.type === "real" || showDemo; }
  /** The account the chip shows: the last one picked if it is still shown, else
   *  the first active real one (the demo, when revealed, if there is no real). */
  function pickShown() {
    var list = accounts.filter(shown), saved = store.get(PICK);
    if (saved && list.some(function (a) { return a.id === saved && (a.type === "real" || demoThisVisit()); })) return saved;
    var active = list.filter(function (a) { return a.status === "active"; });
    var a = active.filter(function (x) { return x.type === "real"; })[0] || active[0] || list[0];
    return a ? a.id : null;
  }

  /* ── money ─────────────────────────────────────────────────────────── */

  var CRYPTO = /^(BTC|ETH|LTC|USDT|USDC|EUSDT|TUSDT|UST|XRP|BCH|TRX|DOGE)$/i;
  function money(v, cur) {
    if (v == null || !isFinite(v)) return "—";
    var max = CRYPTO.test(cur || "") ? 8 : 2;
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency: cur || "USD", currencyDisplay: "narrowSymbol", minimumFractionDigits: 2, maximumFractionDigits: max }).format(v);
    } catch (e) {
      return Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: max }) + " " + (cur || "");
    }
  }

  /* ── painting ──────────────────────────────────────────────────────── */

  function kindOf(a) { return a.type === "real" ? T("Real") : T("Demo"); }
  var CHECK = '<svg class="tbal-row-on" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };

  var savedAt = 0, saveLater = 0;
  function saveLast() {
    var wait = 2000 - (Date.now() - savedAt);
    if (wait > 0) { if (!saveLater) saveLater = setTimeout(function () { saveLater = 0; saveLast(); }, wait); return; }
    savedAt = Date.now();
    store.set(LAST, JSON.stringify(accounts.map(function (a) { return { id: a.id, type: a.type, currency: a.currency, balance: a.balance, status: a.status }; })));
  }
  /** The figures from last time, on screen before any request has gone out. */
  function paintLast() {
    var list = null;
    try { list = JSON.parse(store.get(LAST) || "null"); } catch (e) { list = null; }
    if (!Array.isArray(list) || !list.length) return;
    accounts = list.filter(function (a) { return a && a.id; }).map(function (a) {
      return { id: String(a.id), type: a.type === "real" ? "real" : "demo", currency: a.currency || "", balance: a.balance, status: a.status || "active", at: 0 };
    });
    picked = pickShown();
    if (picked && account(picked) && account(picked).type !== "real" && !demoThisVisit()) picked = null;   // only a demo: start() shows the way to a real one
    if (!picked) return;
    $("acct").hidden = false;
    painted = true;
    paint();
  }

  function paint() {
    var a = account(picked);
    if (!a) return;
    saveLast();
    var box = $("acct"), f = feeds[a.id];
    box.classList.toggle("is-real", a.type === "real");
    box.classList.toggle("is-demo", a.type !== "real");
    box.classList.toggle("is-live", !!(f && f.live));
    box.classList.toggle("is-wait", !!(f && !f.live && f.started));
    $("acctKind").textContent = kindOf(a);
    $("acctAmt").textContent = money(a.balance, a.currency);
    $("acctBtn").setAttribute("aria-label", kindOf(a) + " " + money(a.balance, a.currency));
    if (!$("acctMenu").hidden) paintMenu();
    // Anything else on the page that shows the account (the bot) follows it.
    try { global.dispatchEvent(new CustomEvent("pvr:account")); } catch (e) {}
  }

  function paintMenu() {
    var order = accounts.filter(shown).sort(function (x, y) {
      if (x.type !== y.type) return x.type === "real" ? -1 : 1;
      return (y.balance || 0) - (x.balance || 0);
    });
    $("acctList").innerHTML = order.map(function (a) {
      var real = a.type === "real";
      return '<button type="button" role="menuitemradio" class="tbal-row ' + (real ? "is-real" : "is-demo") + '" data-id="' + esc(a.id) + '"' +
        ' aria-checked="' + (a.id === picked) + '"' + (a.status !== "active" ? " disabled" : "") + ">" + CHECK +
        '<span class="tbal-row-t"><span class="tbal-row-k">' + esc(real ? T("Real account") : T("Demo account")) + "</span>" +
        '<span class="tbal-row-id" translate="no">' + esc(a.id) + (a.status !== "active" ? " · " + esc(T("inactive")) : "") + "</span></span>" +
        '<span class="tbal-row-v" translate="no">' + esc(money(a.balance, a.currency)) + "</span></button>";
    }).join("");
  }

  /* ── the switcher ──────────────────────────────────────────────────── */

  function openMenu(open) {
    var menu = $("acctMenu");
    menu.hidden = !open;
    $("acctBtn").setAttribute("aria-expanded", String(open));
    if (open) { paintMenu(); var on = menu.querySelector('[aria-checked="true"]'); if (on) on.focus(); }
  }
  function bindSwitcher() {
    $("acctBtn").addEventListener("click", function () { openMenu($("acctMenu").hidden); });
    document.addEventListener("click", function (e) {
      if (!$("acctMenu").hidden && !e.target.closest("#acct")) openMenu(false);
    }, true);
    $("acctMenu").addEventListener("click", function (e) {
      var row = e.target.closest(".tbal-row");
      if (!row || row.disabled) return;
      if (busy()) { openMenu(false); return; }          // a running bot keeps its account
      picked = row.getAttribute("data-id");
      demoThisVisit(!!(account(picked) && account(picked).type === "demo"));
      var a = account(picked);
      store.set(PICK, picked);
      openMenu(false);
      paint();
      $("acctBtn").focus();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && !$("acctMenu").hidden) { openMenu(false); $("acctBtn").focus(); }
    });
    $("acctOut").addEventListener("click", function () {
      if (busy()) { openMenu(false); return; }
      $("acctOut").disabled = true;
      Object.keys(feeds).forEach(function (id) { feeds[id].stop(); });
      forget(); store.del(PICK); store.del(LAST);
      home();
    });
  }

  /* ── one live feed per account ─────────────────────────────────────── */

  function Feed(id) {
    this.id = id;
    this.ws = null;
    this.live = false;       // a balance has arrived on the current socket
    this.started = false;    // has ever tried to connect
    this.tries = 0;
    this.last = 0;           // the last message of any kind
    this.timer = 0;
    this.pinger = 0;
    this.stopped = false;
    this.seq = 100;          // req_id 1 is the balance stream
    this.pending = {};       // req_id → { resolve, reject, timer }
    this.streams = {};       // req_id → function (message)
    this.waiting = false;    // a reconnect is scheduled
    this.fetching = false;   // a one-time URL is being asked for
  }
  /** Resolves once the socket is open, or rejects after `ms`. */
  Feed.prototype.whenOpen = function (ms) {
    var self = this;
    return new Promise(function (resolve, reject) {
      var until = Date.now() + (ms || 10000);
      (function check() {
        if (self.stopped) return reject(new Error("stopped"));
        if (self.ws && self.ws.readyState === 1) return resolve();
        if (Date.now() > until) return reject(new Error("Not connected to Deriv yet."));
        setTimeout(check, 120);
      })();
    });
  };
  /** One request, one answer — resolved even when the answer carries an error,
   *  so the caller reads Deriv's own reason. Rejects only when no answer could
   *  come: not connected, the line dropped, or `ms` passed. */
  Feed.prototype.ask = function (req, ms) {
    var self = this;
    return this.whenOpen(10000).then(function () {
      return new Promise(function (resolve, reject) {
        var id = ++self.seq;
        var t = setTimeout(function () { delete self.pending[id]; reject(new Error("Deriv did not answer in time.")); }, ms || 15000);
        self.pending[id] = { resolve: resolve, reject: reject, timer: t };
        try { self.ws.send(JSON.stringify(Object.assign({}, req, { req_id: id }))); }
        catch (e) { clearTimeout(t); delete self.pending[id]; reject(e); }
      });
    });
  };
  /** A request whose answers keep coming (a subscription, a buy with subscribe).
   *  `onMsg` gets every message for it, and { closed: true } if the line drops
   *  first. Returns the req_id, or 0 when it could not be sent. */
  Feed.prototype.stream = function (req, onMsg) {
    if (!this.ws || this.ws.readyState !== 1) return 0;
    var id = ++this.seq;
    this.streams[id] = onMsg;
    try { this.ws.send(JSON.stringify(Object.assign({}, req, { req_id: id }))); }
    catch (e) { delete this.streams[id]; return 0; }
    return id;
  };
  Feed.prototype.endStream = function (id) { delete this.streams[id]; };
  /** Everything waiting on this socket learns at once that it is gone. */
  Feed.prototype.failAll = function () {
    var p = this.pending, s = this.streams;
    this.pending = {}; this.streams = {};
    Object.keys(p).forEach(function (k) { clearTimeout(p[k].timer); p[k].reject(new Error("The connection to Deriv dropped.")); });
    Object.keys(s).forEach(function (k) { try { s[k]({ closed: true }); } catch (e) {} });
  };
  Feed.prototype.open = function (url) {
    var self = this;
    this.close();
    this.started = true;
    var ws;
    try { ws = new WebSocket(url); } catch (e) { return this.retry(); }
    this.ws = ws;
    // A socket that never opens is a socket that failed; do not wait on it.
    var guard = setTimeout(function () { if (ws.readyState !== 1) { try { ws.close(); } catch (e) {} } }, 12000);
    ws.onopen = function () {
      clearTimeout(guard);
      self.last = Date.now();
      ws.send(JSON.stringify({ balance: 1, subscribe: 1, req_id: 1 }));
      self.pinger = setInterval(function () { self.beat(); }, PING_MS);
    };
    ws.onmessage = function (ev) {
      self.last = Date.now();
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.req_id && m.req_id > 1) {
        var sub = self.streams[m.req_id];
        if (sub) { try { sub(m); } catch (e) {} return; }
        var w = self.pending[m.req_id];
        if (w) { delete self.pending[m.req_id]; clearTimeout(w.timer); w.resolve(m); }
        return;
      }
      if (m.error) {
        // A refused balance subscription: this socket cannot serve a balance — replace it.
        if (m.msg_type === "balance") self.drop();
        return;
      }
      if (m.msg_type === "balance" && m.balance) {
        var a = account(self.id);
        if (a) { a.balance = Number(m.balance.balance); if (m.balance.currency) a.currency = m.balance.currency; a.at = Date.now(); }
        self.live = true;
        self.tries = 0;
        paint();
      }
    };
    ws.onclose = function () {
      clearTimeout(guard);
      if (self.ws !== ws) return;          // an old socket we already replaced
      self.ws = null;
      self.live = false;
      clearInterval(self.pinger);
      self.failAll();
      paint();
      if (!self.stopped) self.retry();
    };
    ws.onerror = function () { /* onclose follows and handles it */ };
  };
  /** After a network change: is this socket still really there? */
  Feed.prototype.probe = function () {
    var self = this, ws = this.ws;
    if (!ws || ws.readyState !== 1) return;
    var at = Date.now();
    try { ws.send(JSON.stringify({ ping: 1 })); } catch (e) { return this.drop(); }
    setTimeout(function () { if (self.ws === ws && self.last < at) self.drop(); }, 6000);
  };
  Feed.prototype.beat = function () {
    if (!this.ws || this.ws.readyState !== 1) return;
    if (Date.now() - this.last > STALE_MS) return this.drop();
    try { this.ws.send(JSON.stringify({ ping: 1 })); } catch (e) { this.drop(); }
  };
  /** Close the current socket without counting it as a failure of the line. */
  Feed.prototype.close = function () {
    clearInterval(this.pinger);
    clearTimeout(this.timer);
    var ws = this.ws;
    this.ws = null;
    this.live = false;
    if (ws) { ws.onclose = null; try { ws.close(); } catch (e) {} }
    this.failAll();
  };
  /** Throw away a socket that has gone quiet or bad, and open another now. */
  Feed.prototype.drop = function () { this.close(); this.retry(true); };
  Feed.prototype.stop = function () { this.stopped = true; this.close(); };
  Feed.prototype.retry = function (now) {
    var self = this;
    if (this.stopped) return;
    clearTimeout(this.timer);
    var wait = now ? 0 : Math.min(30000, 500 * Math.pow(2, this.tries)) * (0.75 + Math.random() * 0.5);
    this.tries = Math.min(this.tries + 1, 10);
    this.waiting = true;
    if (painted) paint();
    this.timer = setTimeout(function () {
      self.waiting = false;
      // One request for a URL at a time: the one in flight opens the line or retries.
      if (self.stopped || self.fetching) return;
      // Offline: keep trying on the backoff (the "online" event brings it back sooner).
      if (navigator.onLine === false) return self.retry();
      self.fetching = true;
      rest("POST", ACCOUNTS_URL + "/" + encodeURIComponent(self.id) + "/otp").then(function (r) {
        self.fetching = false;
        if (self.stopped) return;
        var url = r.body && ((r.body.data && r.body.data.url) || r.body.url);
        if (url) return self.open(url);
        if (r.status === 401) return expired();
        self.retry();
      }, function () { self.fetching = false; self.retry(); });
    }, wait);
  };

  /** Reopen anything that is not live, at once. A line already on its way is left to
   *  arrive: one still opening (its own 12 s guard ends one that hangs), or one whose URL
   *  is being asked for. Waking phones fire online, visibility and network events
   *  together; each must not throw away the line the last one started. */
  function revive() {
    Object.keys(feeds).forEach(function (id) {
      var f = feeds[id], ws = f.ws;
      if (f.stopped || f.fetching || (ws && ws.readyState === 0)) return;
      var stale = ws && ws.readyState === 1 && Date.now() - f.last > STALE_MS;
      if (!ws || ws.readyState > 1 || stale) { f.close(); f.tries = 0; f.retry(true); }
    });
  }

  var gone = false, owed = false;
  /** Deriv refused the token. A run finishes first (its sockets stay authorised). */
  function expired() {
    if (gone) return;
    if (busy()) { owed = true; return; }
    gone = true;
    Object.keys(feeds).forEach(function (id) { feeds[id].stop(); });
    forget();
    home();
  }

  /* ── the REST safety net ───────────────────────────────────────────── */

  var polling = 0;
  function startPolling() {
    if (polling) return;
    polling = setInterval(function () {
      if (document.visibilityState === "hidden") return;
      var a = account(picked), f = a && feeds[a.id];
      if (f && f.live) return;                          // the socket is doing the job
      rest("GET", ACCOUNTS_URL).then(function (r) {
        if (r.status === 401) return expired();
        normal(listOf(r.body)).forEach(function (n) {
          var o = account(n.id), nf = feeds[n.id];
          if (o && !(nf && nf.live) && n.balance != null) { o.balance = n.balance; o.currency = n.currency || o.currency; o.at = Date.now(); }
        });
        paint();
      }, function () {});
    }, POLL_MS);
  }

  /* ── keeping it up, quietly ────────────────────────────────────────── */

  global.addEventListener("pvr:runend", function () { if (owed) setTimeout(expired, 0); });
  function probeAll() { Object.keys(feeds).forEach(function (id) { feeds[id].probe(); }); }
  if (navigator.connection && navigator.connection.addEventListener) navigator.connection.addEventListener("change", function () { revive(); probeAll(); });
  // Any feed left closed with nothing scheduled — whatever the reason — reopens.
  setInterval(function () {
    Object.keys(feeds).forEach(function (id) {
      var f = feeds[id];
      if (!f.stopped && !f.waiting && !f.fetching && (!f.ws || f.ws.readyState > 1)) { f.tries = 0; f.retry(true); }
    });
  }, 30000);
  // A token near its end is renewed in good time (when it can be), checked every 30 minutes.
  setInterval(function () { if (!gone) token(); }, 30 * 60000);

  /* ── the header fits ───────────────────────────────────────────────── */

  /* The brand, the language, Creator Program and the balance share one row at
     every width. When they do not fit, the header gives things up one at a
     time until they do (smart.css): the name beside the mark, the little
     arrows, the mark itself, and only then the words of Creator Program. */
  var NAV_STEPS = ["is-short", "is-snug", "is-bare", "is-tight"];
  function fitNav() {
    var nav = document.querySelector(".mnav-in"), end = nav && nav.querySelector(".mnav-end");
    if (!end) return;
    NAV_STEPS.forEach(function (c) { nav.classList.remove(c); });
    // Room: the right edge of everything in the group, inside the header's padding (the group
    // spans the row once the mark has gone, so its own box would always fit).
    var room = function () {
      var limit = nav.getBoundingClientRect().right - (parseFloat(global.getComputedStyle(nav).paddingRight) || 0) + 0.5;
      var right = end.getBoundingClientRect().right;
      Array.prototype.forEach.call(end.children, function (c) { if (c.getClientRects().length) right = Math.max(right, c.getBoundingClientRect().right); });
      return right <= limit && end.scrollWidth <= end.clientWidth + 0.5;
    };
    for (var i = 0; i < NAV_STEPS.length && !room(); i++) nav.classList.add(NAV_STEPS[i]);
  }
  function watchNav() {
    var nav = document.querySelector(".mnav-in");
    if (!nav) return;
    fitNav();
    if (!global.ResizeObserver) { global.addEventListener("resize", fitNav); return; }
    var ro = new global.ResizeObserver(function () { fitNav(); });
    [nav, nav.querySelector(".mnav-lang"), $("acctKind"), $("acctAmt")].forEach(function (el) { if (el) ro.observe(el); });
  }

  /* ── go ────────────────────────────────────────────────────────────── */

  watchNav();
  bindSwitcher();
  global.addEventListener("online", function () { revive(); probeAll(); });
  global.addEventListener("offline", function () { paint(); });
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") revive(); });
  global.addEventListener("pageshow", function (e) { if (e.persisted) revive(); });
  global.addEventListener("langchange", function () { paint(); });
  paintLast();
  var signing = global.EvieConnecting;
  if (signing && typeof signing.then === "function") signing.then(boot, boot); else boot();

  /* What the bot uses: the account in the chip, and its socket. */
  function current() {
    var a = account(picked), f = a && feeds[a.id];
    return a ? { id: a.id, type: a.type, currency: a.currency, balance: a.balance, live: !!(f && f.live) } : null;
  }
  global.PvrDeriv = {
    accounts: function () { return accounts; },
    feeds: feeds,
    revive: revive,
    current: current,
    /** No real account yet: "real" (only a demo) or "none" (no account at all); else null. */
    needsReal: function () { return needReal; },
    /* Pinned to one account — what a running bot uses, so switching the chip
       mid-run never moves its trades to the other account. */
    accountOf: function (id) {
      var a = account(id), f = a && feeds[a.id];
      return a ? { id: a.id, type: a.type, currency: a.currency, balance: a.balance, live: !!(f && f.live) } : null;
    },
    askOn: function (id, req, ms) {
      var f = feeds[id];
      return f ? f.ask(req, ms) : Promise.reject(new Error("No live connection for this account yet."));
    },
    streamOn: function (id, req, onMsg) {
      var f = feeds[id];
      if (!f) return null;
      var sid = f.stream(req, onMsg);
      return sid ? { end: function () { f.endStream(sid); } } : null;
    },
    whenOpenOn: function (id, ms) {
      var f = feeds[id];
      return f ? f.whenOpen(ms) : Promise.reject(new Error("No live connection for this account yet."));
    },
  };
})(window);
