/**
 * EVIE — one Deriv socket, shared by the digit feed and the trader.
 *
 * The socket is the OTP one: POST the account id, get back a pre-authorised
 * WebSocket URL (see deriv.js). It is per-account, which is what makes the
 * demo/real switch real — picking a VRTC account opens a demo socket and every
 * trade on it is practice money.
 *
 * Three things keep it live rather than merely opened:
 *
 *   Sends are QUEUED, not dropped. Anything sent before the socket is ready is
 *   held and flushed on open. Callers therefore never have to know whether the
 *   connection has finished setting itself up — which is what produced "No
 *   trading session — pick an account" on a page that was in fact connected.
 *
 *   A dropped socket RECONNECTS by itself, backing off to a few seconds, and
 *   replays whatever it was subscribed to. Deriv drops idle connections; a page
 *   left open for an hour should still be streaming.
 *
 *   A PING every 25 seconds keeps it from going idle in the first place.
 */

(function (global) {
  "use strict";

  var PING_MS = 25000;
  var MAX_BACKOFF = 8000;

  function Session() {
    this.ws = null;
    this.accountId = null;
    this.handlers = [];
    this.openHandlers = [];
    this.queue = [];
    this.resubscribe = null;   // called after every (re)connect
    this.stopped = false;
    this.attempt = 0;
    this.pinger = null;
  }

  Session.prototype.onMessage = function (fn) { this.handlers.push(fn); };
  Session.prototype.onOpen = function (fn) { this.openHandlers.push(fn); };

  Session.prototype.isOpen = function () {
    return !!this.ws && this.ws.readyState === 1;
  };

  /** True once an account has been chosen, whether or not the socket is up. */
  Session.prototype.isLive = function () {
    return !this.stopped && !!this.accountId;
  };

  Session.prototype.send = function (obj) {
    if (this.isOpen()) { this.ws.send(JSON.stringify(obj)); return true; }
    // Held rather than lost — it goes out the moment the socket is ready.
    this.queue.push(obj);
    return false;
  };

  Session.prototype.flush = function () {
    var q = this.queue;
    this.queue = [];
    for (var i = 0; i < q.length; i++) {
      if (!this.isOpen()) { this.queue = q.slice(i); return; }
      this.ws.send(JSON.stringify(q[i]));
    }
  };

  Session.prototype.open = function (accountId) {
    this.stopped = false;
    this.accountId = accountId;
    this.attempt = 0;
    return this.connect();
  };

  Session.prototype.connect = function () {
    var self = this;
    if (this.stopped || !this.accountId) return Promise.resolve(this);

    this.teardown();

    return global.EvieDeriv.tradeSocket(this.accountId).then(function (url) {
      return new Promise(function (resolve) {
        var ws;
        try { ws = new WebSocket(url); }
        catch (e) { self.retry(); return resolve(self); }

        self.ws = ws;

        ws.onopen = function () {
          self.attempt = 0;
          self.flush();
          self.startPing();
          if (self.resubscribe) self.resubscribe();
          self.openHandlers.forEach(function (fn) { fn(); });
          resolve(self);
        };

        ws.onmessage = function (ev) {
          var d;
          try { d = JSON.parse(ev.data); } catch (e) { return; }
          self.handlers.forEach(function (fn) { fn(d); });
        };

        ws.onerror = function () { /* onclose does the reconnecting */ };

        ws.onclose = function () {
          self.stopPing();
          if (!self.stopped) self.retry();
          resolve(self);
        };
      });
    }).catch(function (e) {
      // An expired session is the one failure reconnecting cannot mend.
      if (e && e.expired) throw e;
      self.retry();
      return self;
    });
  };

  Session.prototype.retry = function () {
    var self = this;
    if (this.stopped) return;
    this.attempt++;
    var wait = Math.min(500 * Math.pow(2, this.attempt - 1), MAX_BACKOFF);
    setTimeout(function () { if (!self.stopped) self.connect(); }, wait);
  };

  Session.prototype.startPing = function () {
    var self = this;
    this.stopPing();
    this.pinger = setInterval(function () {
      if (self.isOpen()) self.ws.send(JSON.stringify({ ping: 1 }));
    }, PING_MS);
  };

  Session.prototype.stopPing = function () {
    if (this.pinger) { clearInterval(this.pinger); this.pinger = null; }
  };

  Session.prototype.teardown = function () {
    this.stopPing();
    if (this.ws) {
      try {
        this.ws.onopen = this.ws.onmessage = this.ws.onerror = this.ws.onclose = null;
        this.ws.close();
      } catch (e) {}
      this.ws = null;
    }
  };

  Session.prototype.close = function () {
    this.stopped = true;
    this.queue = [];
    this.teardown();
  };

  global.EvieSession = Session;
})(window);
