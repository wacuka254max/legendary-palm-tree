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
 *   3. balances  → api.derivws.com REST, Bearer access token + Deriv-App-ID.
 *      NOT the WebSocket: that wants a numeric app_id and a legacy a1- token,
 *      and this app has neither, which is what "Could not reach Deriv" was.
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
   * Nothing here names a domain. The ORIGIN is read from wherever the site is
   * being served, and only the PATH is fixed — so moving from the Vercel URL to
   * a bought domain needs no code change at all: register
   * https://<the-new-domain>/home.html on the Deriv app and it works.
   *
   * The path is the dashboard, not the landing page, because that is what is
   * registered — Deriv hands the code back there. Clunoid points at a dashboard
   * route the same way (/trading/command), not at its front door.
   *
   * window.EVIE_DERIV_REDIRECT_URI still overrides the whole thing, for the odd
   * case of the app being registered against a different host than the one
   * serving the page.
   */
  var REDIRECT_PATH = "/home.html";

  function redirectUri() {
    return global.EVIE_DERIV_REDIRECT_URI || (global.location.origin + REDIRECT_PATH);
  }

  var TOKEN_KEY = "evie_deriv_token";
  var SESSION_KEY = "evie_deriv_session";
  var VERIFIER_KEY = "evie_pkce_verifier";
  var STATE_KEY = "evie_oauth_state";

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

  /* ── step 3: what is in the account ──────────────────────────────────────
     Over the REST API, not the WebSocket.

     The WebSocket was the wrong door and produced "Could not reach Deriv":
     ws.derivws.com wants a NUMERIC app_id and a legacy a1- account token,
     and this app has neither — the id is a 21-character OIDC client id and
     OAuth hands back an ory_at_ access token. So the socket refused the
     connection every time, whatever the account held.

     api.derivws.com is the door that matches these credentials: Bearer access
     token plus the app id in a Deriv-App-ID header, CORS-open to the browser.
     Three endpoints, matching the three scopes we asked for:

       trade          → /trading/v1/options/accounts
       payment        → /wallet/v1/wallets
       account_manage → /account/v1/nickname

     Only the options call is required. The other two are best-effort, so a
     scope Deriv declines to grant costs a section of the page, not the page. */

  var REST_BASE = "https://api.derivws.com";

  function get(path, token) {
    return fetch(REST_BASE + path, {
      headers: { Authorization: "Bearer " + token, "Deriv-App-ID": APP_ID },
      cache: "no-store"
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (json) {
        if (res.status === 401) {
          var e401 = new Error("Your Deriv session has expired. Please connect again.");
          e401.expired = true;
          throw e401;
        }
        if (!res.ok) {
          var msg = (json && json.errors && json.errors[0] && json.errors[0].message) ||
            (json && (json.message || json.error)) || ("Deriv API error (" + res.status + ")");
          throw new Error(String(msg));
        }
        return json && json.data;
      });
    });
  }

  /* Deriv marks demo money several ways: options report account_type "demo",
     and every virtual id starts VR (VRTC options, VRW wallet). Any one of them
     is enough — a demo balance shown as real would be a lie about money. */
  function isDemo() {
    for (var i = 0; i < arguments.length; i++) {
      var v = arguments[i];
      if (v && (/demo|virtual/i.test(v) || /^vr/i.test(v))) return true;
    }
    return false;
  }

  function num(v) {
    if (typeof v === "number") return v;
    if (typeof v === "string" && v.trim() !== "" && !isNaN(Number(v))) return Number(v);
    return null;
  }

  /**
   * The whole portfolio: every options account and every wallet, real and demo,
   * plus the profile nickname and the id of the account they connected with.
   */
  function portfolio() {
    return validToken().then(function (token) {
      if (!token) return Promise.reject(new Error("not connected"));

      var settled = function (p) {
        return p.then(
          function (v) { return { ok: true, value: v }; },
          function (e) { return { ok: false, error: e }; }
        );
      };

      return Promise.all([
        settled(get("/trading/v1/options/accounts", token)),
        settled(get("/wallet/v1/wallets", token)),
        settled(get("/account/v1/nickname", token))
      ]).then(function (r) {
        var optsR = r[0], walletsR = r[1], nickR = r[2];

        // Options are the backbone. If that failed, there is nothing to show.
        if (!optsR.ok) throw optsR.error;

        var accounts = [];

        (Array.isArray(optsR.value) ? optsR.value : []).forEach(function (a) {
          var id = String(a.account_id || "");
          if (!id) return;
          accounts.push({
            id: id,
            kind: "Options",
            currency: String(a.currency || ""),
            balance: num(a.balance),
            demo: isDemo(a.account_type, a.group, a.status, id)
          });
        });

        if (walletsR.ok) {
          (Array.isArray(walletsR.value) ? walletsR.value : []).forEach(function (w) {
            var id = String(w.wallet_id || "");
            if (!id) return;
            var tb = w.total_balance || {};
            accounts.push({
              id: id,
              kind: "Wallet",
              currency: String(tb.converted_to || ""),
              balance: num(tb.approximate_total_balance),
              demo: isDemo(w.type, id)
            });
          });
        }

        var nickname = "";
        if (nickR.ok && nickR.value && typeof nickR.value === "object") {
          nickname = String(nickR.value.nickname || "");
        }

        /* Balances can arrive in more than one currency, and adding those
           together would invent a number. Sum per currency instead and lead
           with the biggest bucket, with every account still listed. */
        function totals(demo) {
          var byCur = {};
          accounts.forEach(function (a) {
            if (a.balance == null || !!a.demo !== demo) return;
            var cur = a.currency || "";
            byCur[cur] = (byCur[cur] || 0) + a.balance;
          });
          var bestCur = "", best = -Infinity;
          Object.keys(byCur).forEach(function (c) {
            if (byCur[c] > best) { best = byCur[c]; bestCur = c; }
          });
          return Object.keys(byCur).length
            ? { amount: byCur[bestCur], currency: bestCur, split: byCur }
            : null;
        }

        return {
          nickname: nickname,
          accounts: accounts,
          real: totals(false),
          demo: totals(true)
        };
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
    portfolio: portfolio,

    /* Every page behind the connection opens the same way: no session means
       nothing to show, so go back to the door. Shared so a page added later
       cannot forget it. Returns false when it has sent them away. */
    requireConnection: function () {
      if (isConnected()) return true;
      global.location.replace("/");
      return false;
    }
  };
})(window);
