/**
 * EVIE — one Deriv socket, shared by the digit feed and the trader.
 *
 * The socket is the OTP one: POST the account id, get back a pre-authorised
 * WebSocket URL (see deriv.js). It is per-account, which is what makes the
 * demo/real switch real — picking a VRTC account opens a demo socket and every
 * trade on it is practice money.
 *
 * Ticks and trades share the connection because Deriv is happy to carry both,
 * and two sockets would mean two OTPs and two things to reconnect.
 */

(function (global) {
  "use strict";

  function Session() {
    this.ws = null;
    this.accountId = null;
    this.handlers = [];
    this.openHandlers = [];
    this.closed = false;
  }

  Session.prototype.onMessage = function (fn) { this.handlers.push(fn); };
  Session.prototype.onOpen = function (fn) { this.openHandlers.push(fn); };

  Session.prototype.send = function (obj) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    this.ws.send(JSON.stringify(obj));
    return true;
  };

  Session.prototype.isOpen = function () {
    return !!this.ws && this.ws.readyState === 1;
  };

  /** Open against an account. Closes any socket already held. */
  Session.prototype.open = function (accountId) {
    var self = this;
    this.close();
    this.closed = false;
    this.accountId = accountId;

    return global.EvieDeriv.tradeSocket(accountId).then(function (url) {
      return new Promise(function (resolve, reject) {
        var ws = new WebSocket(url);
        self.ws = ws;

        var settled = false;

        ws.onopen = function () {
          settled = true;
          self.openHandlers.forEach(function (fn) { fn(); });
          resolve(self);
        };

        ws.onmessage = function (ev) {
          var d;
          try { d = JSON.parse(ev.data); } catch (e) { return; }
          self.handlers.forEach(function (fn) { fn(d); });
        };

        ws.onerror = function () {
          if (!settled) { settled = true; reject(new Error("Could not reach Deriv.")); }
        };

        ws.onclose = function () {
          if (!settled) { settled = true; reject(new Error("Deriv closed the connection.")); }
        };
      });
    });
  };

  Session.prototype.close = function () {
    this.closed = true;
    if (this.ws) {
      try {
        this.ws.onopen = this.ws.onmessage = this.ws.onerror = this.ws.onclose = null;
        this.ws.close();
      } catch (e) {}
      this.ws = null;
    }
  };

  global.EvieSession = Session;
})(window);
