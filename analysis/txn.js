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
    this.currency = opts.currency || "USD";
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

  /**
   * Raise the sheet, hold it long enough to read, then put it back.
   *
   * Only on the narrow layout, where the sheet is parked at the bottom and a
   * result would otherwise land out of sight. On the wide layout the rail is
   * already open and there is nothing to do. A second call while a peek is in
   * progress restarts the clock rather than stacking timers.
   */
  Txn.prototype.peek = function (ms) {
    var self = this;
    var handle = this.q("[data-handle]");
    // The handle is only shown on the narrow layout; on the rail it is hidden.
    if (!handle || !handle.offsetParent) return;

    var wasOpen = this.root.classList.contains("is-open");
    clearTimeout(this.peekTimer);
    if (wasOpen) return;            // already showing; nothing to reveal

    this.root.classList.add("is-open");
    handle.setAttribute("aria-expanded", "true");

    this.peekTimer = setTimeout(function () {
      self.root.classList.remove("is-open");
      handle.setAttribute("aria-expanded", "false");
    }, ms || 3800);
  };

  /** Whatever the account is denominated in. Every figure follows it. */
  Txn.prototype.setCurrency = function (cur) {
    if (!cur || cur === this.currency) return;
    this.currency = cur;
    this.render();
  };

  Txn.prototype.reset = function () {
    this.rows = [];
    this.render();
  };

  Txn.prototype.add = function (r) {
    this.rows.unshift(r);
    // A session can run long; the panel keeps what a person would scroll.
    if (this.rows.length > 200) this.rows.pop();
    /* Only this render paints the top row as arriving. render() rebuilds the
       whole list, so without the flag every row would slide in again each time
       a trade settled — a panel that jumps rather than one that receives. */
    this.arriving = true;
    this.render();
    this.arriving = false;
  };

  /**
   * Totals for one bot run, or for everything when no run is named.
   *
   * The bot reads its figures from here rather than keeping its own running
   * count. A separate tally is a tally that can drift — miss one result and it
   * reports a loss the ledger says was recovered.
   */
  Txn.prototype.totalsFor = function (run) {
    var stake = 0, payout = 0, won = 0, lost = 0, n = 0;
    this.rows.forEach(function (r) {
      if (r.run !== run) return;
      n++;
      stake += r.stake || 0;
      payout += r.payout || 0;
      if (r.win) won++; else lost++;
    });
    return { stake: stake, payout: payout, trades: n, won: won, lost: lost, profit: payout - stake };
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

  /* The account's own currency, at its own precision. This printed " USD"
     against every figure, which is a lie about money on a EUR account and
     unreadable on a BTC one. The currency is set by app.js when the account
     is known — see Txn.prototype.setCurrency. */
  function money(n, cur) {
    return window.EvieCurrency
      ? window.EvieCurrency.fmt(Number(n || 0), cur)
      : Number(n || 0).toFixed(2) + " " + (cur || "USD");
  }

  /* The same figure inside a ROW, where the rail is 340px wide. At eight
     decimals "0.00000023 BTC" does not fit and ellipsis eats the digits that
     matter — and the column heading and the totals underneath both name the
     currency already, so repeating it on every row buys nothing. Two-decimal
     accounts keep the suffix: it fits, and it always read that way. */
  function rowMoney(n, cur) {
    var d = window.EvieCurrency ? window.EvieCurrency.digits(cur) : 2;
    if (d <= 2) return money(n, cur);
    return window.EvieCurrency ? window.EvieCurrency.bare(Number(n || 0), cur)
                               : Number(n || 0).toFixed(d);
  }

  Txn.prototype.render = function () {
    var self = this;
    var body = this.q("[data-rows]");
    var t = this.totals();

    body.innerHTML = this.rows.length
      ? this.rows.map(function (r, i) {
          return '<li class="tx' + (i === 0 && self.arriving ? " tx--in" : "") + '">' +
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
              '<span class="tx-buy">' + rowMoney(r.stake, self.currency) + "</span>" +
              '<span class="tx-pl ' + (r.win ? "is-up" : "is-down") + '">' +
                (r.profit >= 0 ? "+" : "") + rowMoney(r.profit, self.currency) +
              "</span>" +
            "</span>" +
          "</li>";
        }).join("")
      : '<li class="tx-none">No transactions yet.</li>';

    this.q("[data-stake]").textContent = money(t.stake, this.currency);
    this.q("[data-payout]").textContent = money(t.payout, this.currency);
    this.q("[data-runs]").textContent = t.runs;
    this.q("[data-lost]").textContent = t.lost;
    this.q("[data-won]").textContent = t.won;

    var pl = this.q("[data-pl]");
    pl.textContent = (t.profit >= 0 ? "+" : "") + money(t.profit, this.currency);
    pl.className = "sum-v " + (t.profit > 0 ? "is-up" : t.profit < 0 ? "is-down" : "");

    var badge = this.q("[data-count]");
    if (badge) badge.textContent = t.runs ? t.runs : "";
  };

  global.EvieTxn = Txn;
})(window);
