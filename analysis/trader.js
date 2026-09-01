/**
 * EVIE — placing the trades.
 *
 * A run is N trades, one after another, never overlapping. Each one is the same
 * four steps Deriv requires:
 *
 *   proposal  → Deriv prices the contract and returns an id
 *   buy       → that id, at the price it quoted
 *   proposal_open_contract (subscribe) → updates until it settles
 *   is_sold   → the profit, and the digit it settled on
 *
 * Trades run strictly in sequence because martingale depends on the previous
 * result: staking the next trade before this one settles would size it off a
 * number that does not exist yet.
 *
 * Martingale multiplies the stake after a LOSS and resets to the base stake
 * after a win. With the toggle off the stake never moves.
 */

(function (global) {
  "use strict";

  var C = global.EvieContracts;

  /** Deriv's floor. A stake under this is rejected, so stop before sending. */
  var MIN_STAKE = 0.35;

  function Trader(session, ui) {
    this.s = session;
    this.ui = ui;
    this.running = false;
    this.cancelled = false;

    var self = this;
    session.onMessage(function (d) { self.onMessage(d); });
  }

  Trader.prototype.onMessage = function (d) {
    if (!this.pending) return;

    if (d.error) {
      // Deriv's own words are better than a guess at what went wrong.
      return this.pending.reject(new Error(d.error.message || "Deriv rejected the trade."));
    }

    if (d.msg_type === "proposal" && d.proposal && this.pending.stage === "proposal") {
      this.pending.stage = "buy";
      this.s.send({ buy: d.proposal.id, price: d.proposal.ask_price });
      return;
    }

    if (d.msg_type === "buy" && d.buy && this.pending.stage === "buy") {
      this.pending.stage = "settle";
      this.pending.contractId = d.buy.contract_id;
      this.s.send({ proposal_open_contract: 1, contract_id: d.buy.contract_id, subscribe: 1 });
      return;
    }

    if (d.msg_type === "proposal_open_contract" && d.proposal_open_contract) {
      var c = d.proposal_open_contract;
      if (this.pending.stage !== "settle") return;
      if (this.pending.contractId && c.contract_id !== this.pending.contractId) return;
      if (!c.is_sold) return;

      var profit = parseFloat(c.profit) || 0;
      this.pending.resolve({
        win: profit > 0,
        profit: profit,
        stake: parseFloat(c.buy_price) || this.pending.stake,
        // Deriv reports the settling tick; it is what makes a result checkable.
        digit: typeof c.exit_tick_display_value === "string"
          ? parseInt(c.exit_tick_display_value.slice(-1), 10)
          : null
      });
    }
  };

  /** One trade, start to settled. */
  Trader.prototype.one = function (spec) {
    var self = this;
    return new Promise(function (resolve, reject) {
      var done = false;
      var finish = function (fn, v) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        self.pending = null;
        fn(v);
      };

      // A one-tick contract that has said nothing for this long is not coming.
      var timer = setTimeout(function () {
        finish(reject, new Error("Deriv did not settle that trade in time."));
      }, 60000);

      self.pending = {
        stage: "proposal",
        stake: spec.stake,
        contractId: null,
        resolve: function (v) { finish(resolve, v); },
        reject: function (e) { finish(reject, e); }
      };

      self.s.send(C.proposal(spec));
    });
  };

  /**
   * Run `count` trades. Resolves when the last one settles, or when a trade
   * fails — a failure stops the run rather than staking again into whatever
   * caused it.
   */
  Trader.prototype.run = function (opts) {
    var self = this;
    if (this.running) return Promise.resolve();

    this.running = true;
    this.cancelled = false;

    var base = Number(opts.stake);
    var stake = base;
    var placed = 0;
    var net = 0;

    this.ui.runState(true);

    function step() {
      if (self.cancelled || placed >= opts.count) return Promise.resolve();

      if (stake < MIN_STAKE) {
        self.ui.status("Next stake would be " + stake.toFixed(2) +
          ", below Deriv's minimum of " + MIN_STAKE.toFixed(2) + ". Stopped.", "warning");
        return Promise.resolve();
      }

      self.ui.status("Trade " + (placed + 1) + " of " + opts.count +
        " — " + C.TYPES[opts.type].label + " at " + stake.toFixed(2) + "…", "info");

      return self.one({
        type: opts.type,
        barrier: opts.barrier,
        stake: stake,
        currency: opts.currency,
        market: opts.market
      }).then(function (r) {
        placed++;
        net += r.profit;
        self.ui.result({
          index: placed,
          win: r.win,
          profit: r.profit,
          stake: r.stake,
          digit: r.digit,
          type: opts.type,
          barrier: opts.barrier,
          // Which market it was — with several cards on screen, a result that
          // does not say is a result you cannot place.
          market: opts.market
        });
        self.ui.net(net);

        // The whole point of martingale: recover the loss on the next one.
        if (opts.martingale && !r.win) stake = stake * opts.multiplier;
        else stake = base;

        // A breath BETWEEN trades; Deriv rate-limits a tight loop. Not after
        // the last one — that would just hold the buttons disabled for no
        // reason once the run is already over.
        if (self.cancelled || placed >= opts.count) return;
        return new Promise(function (r2) { setTimeout(r2, 700); }).then(step);
      });
    }

    return step()
      .then(function () {
        if (!self.cancelled) {
          self.ui.status(
            placed + (placed === 1 ? " trade" : " trades") + " done. Net " +
            (net >= 0 ? "+" : "") + net.toFixed(2) + ".",
            net >= 0 ? "success" : "warning"
          );
        }
      })
      .catch(function (e) {
        self.ui.status((e && e.message) || "The trade failed.", "error");
      })
      .then(function () {
        self.running = false;
        self.pending = null;
        self.ui.runState(false);
      });
  };

  Trader.prototype.cancel = function () {
    this.cancelled = true;
    this.ui.status("Stopping after this trade…", "warning");
  };

  Trader.MIN_STAKE = MIN_STAKE;
  global.EvieTrader = Trader;
})(window);
