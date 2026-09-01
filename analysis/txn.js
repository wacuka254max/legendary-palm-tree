/**
 * EVIE — the transactions panel.
 *
 * The same account of a session Deriv's own run panel keeps: every contract as
 * a row of type, the two spots it settled between, and what it cost against
 * what it made — then the totals underneath.
 *
 * Two of those totals are easy to get wrong.
 *
 *   Total payout is what came BACK, not what was staked plus profit. A losing
 *   contract returns nothing at all, so it contributes 0 — otherwise a run of
 *   losses would still show a growing payout, which is nonsense.
 *
 *   Total profit/loss is payout minus stake, and falls out of the other two
 *   rather than being summed separately, so the three can never disagree.
 *
 * On a wide screen it is a rail down the right. On a narrow one it becomes a
 * sheet that rises from the bottom, because the rail would eat half the width
 * a market card needs.
 */

(function (global) {
  "use strict";

  function Txn(opts) {
    this.root = opts.root;
    this.nameOf = opts.nameOf || function (s) { return s; };
    this.rows = [];
    this.bind();
  }

  Txn.prototype.q = function (sel) { return this.root.querySelector(sel); };

  Txn.prototype.bind = function () {
    var self = this;

    var reset = this.q("[data-reset]");
    if (reset) reset.addEventListener("click", function () { self.reset(); });

    // The handle only does anything on the narrow layout, where the panel is a
    // sheet; on the rail it is inert and hidden.
    var handle = this.q("[data-handle]");
    if (handle) {
      handle.addEventListener("click", function () {
        var open = self.root.classList.toggle("is-open");
        handle.setAttribute("aria-expanded", String(open));
      });
    }
  };

  Txn.prototype.reset = function () {
    this.rows = [];
    this.render();
  };

  Txn.prototype.add = function (r) {
    this.rows.unshift(r);
    // A session can run long; the panel keeps what a person would scroll.
    if (this.rows.length > 200) this.rows.pop();
    this.render();
  };

  Txn.prototype.totals = function () {
    var stake = 0, payout = 0, won = 0, lost = 0;
    this.rows.forEach(function (r) {
      stake += r.stake || 0;
      payout += r.payout || 0;
      if (r.win) won++; else lost++;
    });
    return {
      stake: stake,
      payout: payout,
      runs: this.rows.length,
      won: won,
      lost: lost,
      profit: payout - stake
    };
  };

  function esc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function usd(n) {
    return Number(n || 0).toFixed(2) + " USD";
  }

  Txn.prototype.render = function () {
    var self = this;
    var body = this.q("[data-rows]");
    var t = this.totals();

    body.innerHTML = this.rows.length
      ? this.rows.map(function (r) {
          return '<li class="tx">' +
            '<span class="tx-type">' +
              '<span class="tx-dot tx-dot--' + (r.win ? "win" : "loss") + '"></span>' +
              '<span class="tx-type-t">' + esc(r.label) + "</span>" +
              '<span class="tx-type-s">' + esc(self.nameOf(r.market)) + "</span>" +
            "</span>" +
            '<span class="tx-spot">' +
              '<span class="tx-in">' + esc(r.entry == null ? "—" : r.entry) + "</span>" +
              '<span class="tx-out">' + esc(r.exit == null ? "—" : r.exit) + "</span>" +
            "</span>" +
            '<span class="tx-money">' +
              '<span class="tx-buy">' + usd(r.stake) + "</span>" +
              '<span class="tx-pl ' + (r.win ? "is-up" : "is-down") + '">' +
                (r.profit >= 0 ? "+" : "") + usd(r.profit) +
              "</span>" +
            "</span>" +
          "</li>";
        }).join("")
      : '<li class="tx-none">No transactions yet.</li>';

    this.q("[data-stake]").textContent = usd(t.stake);
    this.q("[data-payout]").textContent = usd(t.payout);
    this.q("[data-runs]").textContent = t.runs;
    this.q("[data-lost]").textContent = t.lost;
    this.q("[data-won]").textContent = t.won;

    var pl = this.q("[data-pl]");
    pl.textContent = (t.profit >= 0 ? "+" : "") + usd(t.profit);
    pl.className = "sum-v " + (t.profit > 0 ? "is-up" : t.profit < 0 ? "is-down" : "");

    var badge = this.q("[data-count]");
    if (badge) badge.textContent = t.runs ? t.runs : "";
  };

  global.EvieTxn = Txn;
})(window);
