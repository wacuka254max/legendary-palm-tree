/**
 * EVIE — connecting a Deriv account, and reading what is in it.
 *
 * The same shape magicbotslab.com and clunoid.com use, because the app id here
 * is the same kind: a 21-character OIDC client id, not a classic numeric
 * app_id. That decides the whole flow —
 *
 *   1. authorize → auth.deriv.com/oauth2/auth with PKCE (S256). Public client,
 *      no secret, so the verifier never leaves this browser.
 *   2. token     → auth.deriv.com/oauth2/token, exchanging the code + verifier
 *      for an access token and a refresh token.
 *   3. balances  → wss://ws.derivws.com, authorize(access_token), then ask for
 *      every account's balance at once.
 *
 * Nothing is stored on a server. The tokens live in this browser and only this
 * browser; Evie never sees them, and there is no account to sign in to.
 *
 * The stored token EXPIRES — about an hour. That single fact is what makes a
 * connection look like it "failed" a day later, so every read goes through
 * validToken(), which spends the refresh token before handing anything back.
 */

(function (global) {
  "use strict";

  /* ── configuration ─────────────────────────────────────────────────────── */

  var APP_ID = "34gG4jgJ0gHGbGDC2XvY5";
  var AUTH_URL = "https://auth.deriv.com/oauth2/auth";
  var TOKEN_URL = "https://auth.deriv.com/oauth2/token";
  var WS_URL = "wss://ws.derivws.com/websockets/v3?app_id=" + encodeURIComponent(APP_ID);

  /**
   * Where Deriv sends the user back.
   *
   * Deriv compares this against the app's pre-registered redirect URLs BYTE FOR
   * BYTE. A trailing slash, http vs https, www vs bare host — any one of them
   * differing produces:
   *
   *   invalid_request … 'redirect_uri' does not match any of the OAuth 2.0
   *   Client's pre-registered redirect urls
   *
   * Clunoid pins this to one fixed registered URL rather than deriving it from
   * whatever page the user happened to click on, because deriving it means a
   * preview deployment, a www hop or a bare /index.html all send something
   * different and all get rejected. We do the same: one value, set once.
   *
   * Set it by defining window.EVIE_DERIV_REDIRECT_URI before this script loads
   * (see the <script> block in index.html). It must equal the URL registered on
   * the Deriv app exactly. With nothing set we fall back to this origin's root,
   * which is right for the common case of the app being registered against the
   * live domain.
   */
  function redirectUri() {
    return global.EVIE_DERIV_REDIRECT_URI || (global.location.origin + "/");
  }

  var TOKEN_KEY = "evie_deriv_token";
  var SESSION_KEY = "evie_deriv_session";
  var VERIFIER_KEY = "evie_pkce_verifier";
  var STATE_KEY = "evie_oauth_state";

  /** Deriv is normally quick; past this, waiting helps nobody. */
  var TIMEOUT_MS = 12000;

  /* ── session storage ───────────────────────────────────────────────────── */

  function readSession() {
    try {
      var raw = localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function saveSession(s) {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify(s));
      if (s && s.access_token) localStorage.setItem(TOKEN_KEY, s.access_token);
    } catch (e) {}
  }

  function clearSession() {
    try {
      localStorage.removeItem(SESSION_KEY);
      localStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(VERIFIER_KEY);
      sessionStorage.removeItem(STATE_KEY);
    } catch (e) {}
  }

  /**
   * Is there a connection worth acting on?
   *
   * A session with a refresh token counts even once the access token has
   * expired — that is exactly the case refresh exists for, and treating it as
   * disconnected is what makes a connection seem to "drop" overnight.
   */
  function isConnected() {
    var s = readSession();
    if (!s || !s.access_token) return false;
    if (s.refresh_token) return true;
    return !s.expires_at || Date.now() < Number(s.expires_at) - 60000;
  }

  /* ── PKCE ──────────────────────────────────────────────────────────────── */

  function randomString(len) {
    var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    var arr = new Uint8Array(len || 64);
    crypto.getRandomValues(arr);
    return Array.prototype.map.call(arr, function (v) { return chars[v % chars.length]; }).join("");
  }

  function base64Url(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function challengeFor(verifier) {
    return crypto.subtle
      .digest("SHA-256", new TextEncoder().encode(verifier))
      .then(function (d) { return base64Url(new Uint8Array(d)); });
  }

  /* ── step 1: send them to Deriv ────────────────────────────────────────── */

  function connect() {
    var verifier = randomString(64);
    var state = randomString(32);

    return challengeFor(verifier).then(function (challenge) {
      try {
        sessionStorage.setItem(VERIFIER_KEY, verifier);
        sessionStorage.setItem(STATE_KEY, state);
      } catch (e) {}

      var u = new URL(AUTH_URL);
      u.searchParams.set("response_type", "code");
      u.searchParams.set("client_id", APP_ID);
      u.searchParams.set("redirect_uri", redirectUri());
      // The scopes this newer client actually allows — trade reaches the
      // options accounts, payment the wallets, account_manage the profile.
      // The older read/openid scopes are rejected outright.
      u.searchParams.set("scope", "trade payment account_manage");
      u.searchParams.set("brand", "deriv");
      u.searchParams.set("state", state);
      u.searchParams.set("code_challenge", challenge);
      u.searchParams.set("code_challenge_method", "S256");

      global.location.href = u.toString();
    });
  }

  /* ── step 2: the code that comes back ──────────────────────────────────── */

  function exchange(code) {
    var verifier = "";
    try { verifier = sessionStorage.getItem(VERIFIER_KEY) || ""; } catch (e) {}
    if (!verifier) return Promise.reject(new Error("missing verifier"));

    return fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: APP_ID,
        code: code,
        code_verifier: verifier,
        redirect_uri: redirectUri()
      })
    })
      .then(function (r) {
        if (!r.ok) throw new Error("token exchange failed (" + r.status + ")");
        return r.json();
      })
      .then(function (d) {
        if (!d || !d.access_token) throw new Error("no access token");
        saveSession({
          access_token: d.access_token,
          refresh_token: d.refresh_token || null,
          expires_at: Date.now() + ((d.expires_in || 3600) * 1000)
        });
        try {
          sessionStorage.removeItem(VERIFIER_KEY);
          sessionStorage.removeItem(STATE_KEY);
        } catch (e) {}
        return d.access_token;
      });
  }

  /**
   * Handle a return from Deriv on whatever page is the redirect target.
   * Resolves {status:"connected"|"none"|"error", message}.
   */
  function handleRedirect() {
    var params = new URLSearchParams(global.location.search);
    var err = params.get("error");
    var code = params.get("code");
    var state = params.get("state");

    var scrub = function () {
      try { history.replaceState({}, "", global.location.pathname); } catch (e) {}
    };

    if (err) {
      scrub();
      return Promise.resolve({
        status: "error",
        message: params.get("error_description") || "Authorisation was cancelled."
      });
    }
    if (!code) return Promise.resolve({ status: "none" });

    var stored = "";
    try { stored = sessionStorage.getItem(STATE_KEY) || ""; } catch (e) {}
    // The state check is what stops a link someone else crafted from planting
    // their account in this browser.
    if (!stored || state !== stored) {
      scrub();
      return Promise.resolve({ status: "error", message: "Could not verify that sign-in. Please connect again." });
    }

    return exchange(code)
      .then(function () { scrub(); return { status: "connected" }; })
      .catch(function (e) { scrub(); return { status: "error", message: e.message || "Connection failed." }; });
  }

  /* ── keeping it alive ──────────────────────────────────────────────────── */

  /** An access token Deriv will actually accept, refreshing it if it is stale. */
  function validToken() {
    var s = readSession();
    if (!s || !s.access_token) return Promise.resolve("");

    var fresh = !s.expires_at || Date.now() < Number(s.expires_at) - 60000;
    if (fresh) return Promise.resolve(s.access_token);
    if (!s.refresh_token) return Promise.resolve(s.access_token);

    return fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: APP_ID,
        refresh_token: s.refresh_token
      })
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.access_token) return s.access_token;
        saveSession({
          access_token: d.access_token,
          refresh_token: d.refresh_token || s.refresh_token,
          expires_at: Date.now() + ((d.expires_in || 3600) * 1000)
        });
        return d.access_token;
      })
      .catch(function () { return s.access_token; });
  }

  /* ── step 3: what is in the account ────────────────────────────────────── */

  /**
   * Every account this token reaches, with an accurate balance for each.
   *
   * authorize gives the roster (which id, which currency, real or demo). It is
   * not a reliable source of balances, so we then ask for balances explicitly
   * with account:"all" — that is the figure Deriv shows the user, per account,
   * and the reason this reads the same number as their own portfolio page.
   */
  function accounts() {
    return validToken().then(function (token) {
      if (!token) return Promise.reject(new Error("not connected"));

      return new Promise(function (resolve, reject) {
        var ws, done = false, roster = [];

        var finish = function (fn, arg) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          try { if (ws) ws.close(); } catch (e) {}
          fn(arg);
        };
        var ok = function (v) { finish(resolve, v); };
        var bad = function (m) { finish(reject, new Error(m)); };

        var timer = setTimeout(function () { bad("Deriv did not respond."); }, TIMEOUT_MS);

        try { ws = new WebSocket(WS_URL); }
        catch (e) { return bad("Could not reach Deriv."); }

        ws.onopen = function () { ws.send(JSON.stringify({ authorize: token })); };

        ws.onmessage = function (ev) {
          var msg;
          try { msg = JSON.parse(ev.data); } catch (e) { return; }

          if (msg.error) {
            return bad(msg.error.message || "Deriv rejected the connection.");
          }

          if (msg.msg_type === "authorize" && msg.authorize) {
            roster = (msg.authorize.account_list || []).map(function (a) {
              return {
                id: a.loginid,
                currency: a.currency || "USD",
                demo: !!a.is_virtual,
                balance: typeof a.balance === "number" ? a.balance : null
              };
            });
            // Fall back to the authorised account if the roster came back thin.
            if (!roster.length && msg.authorize.loginid) {
              roster = [{
                id: msg.authorize.loginid,
                currency: msg.authorize.currency || "USD",
                demo: /^vr/i.test(msg.authorize.loginid),
                balance: typeof msg.authorize.balance === "number" ? msg.authorize.balance : null
              }];
            }
            ws.send(JSON.stringify({ balance: 1, account: "all" }));
            return;
          }

          if (msg.msg_type === "balance" && msg.balance) {
            var per = msg.balance.accounts || {};
            roster.forEach(function (a) {
              var row = per[a.id];
              if (row && typeof row.balance === "number") {
                a.balance = row.balance;
                if (row.currency) a.currency = row.currency;
              }
            });
            // The single authorised account is reported at the top level.
            if (typeof msg.balance.balance === "number" && msg.balance.loginid) {
              roster.forEach(function (a) {
                if (a.id === msg.balance.loginid && a.balance == null) a.balance = msg.balance.balance;
              });
            }
            return ok(roster);
          }
        };

        ws.onerror = function () { bad("Could not reach Deriv."); };
        ws.onclose = function () { if (!done) bad("Deriv closed the connection."); };
      });
    });
  }

  global.EvieDeriv = {
    APP_ID: APP_ID,
    /* The exact string sent as redirect_uri. Deriv's rejection message never
       says what it received, so surfacing it is the difference between fixing
       this in a minute and guessing at trailing slashes. */
    redirectUri: redirectUri,
    connect: connect,
    handleRedirect: handleRedirect,
    isConnected: isConnected,
    disconnect: clearSession,
    accounts: accounts
  };
})(window);
