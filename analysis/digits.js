/**
 * EVIE — reading digits off the tick stream.
 *
 * The last digit is the whole game in these contracts, and getting it out of a
 * quote has one trap: JavaScript drops trailing zeros. 1234.50 arrives as the
 * number 1234.5, whose last character is "5" — but Deriv settles that tick on
 * a 0. So the quote is formatted to the market's own decimal count FIRST, and
 * the digit read from that string. Deriv sends `pip_size` on the tick; the
 * table is the fallback for when it does not.
 *
 * Percentages are over a rolling window of the last WINDOW ticks. "Fastest
 * growing" compares how often a digit came up in the most recent third against
 * the two thirds before it, so it means "picking up lately", not "common".
 */

(function (global) {
  "use strict";

  var PIP_DECIMALS = { R_10: 3, R_25: 3, R_50: 4, R_75: 4, R_100: 2 };

  var WINDOW = 120;   // ticks the percentages are computed over
  var RECENT = 40;    // the "lately" slice used for growth

  function lastDigitOf(quote, symbol, pipSize) {
    var decimals = typeof pipSize === "number" ? pipSize : (PIP_DECIMALS[symbol] != null ? PIP_DECIMALS[symbol] : 2);
    var s = Number(quote).toFixed(decimals);
    var d = parseInt(s.charAt(s.length - 1), 10);
    return isNaN(d) ? null : d;
  }

  function Digits() {
    this.list = [];   // most recent last
  }

  Digits.prototype.reset = function () { this.list = []; };

  Digits.prototype.push = function (digit) {
    if (digit == null) return;
    this.list.push(digit);
    if (this.list.length > WINDOW) this.list.splice(0, this.list.length - WINDOW);
  };

  Digits.prototype.seed = function (quotes, symbol) {
    var self = this;
    this.reset();
    (quotes || []).forEach(function (q) { self.push(lastDigitOf(q, symbol)); });
  };

  /** The last n digits, oldest first. */
  Digits.prototype.last = function (n) {
    return this.list.slice(Math.max(0, this.list.length - n));
  };

  Digits.prototype.count = function () { return this.list.length; };

  /**
   * Per-digit percentages plus the three digits worth pointing at.
   * Returns { rows:[{digit,pct,growth}], high, low, rising, total }.
   */
  Digits.prototype.stats = function () {
    var total = this.list.length;
    var rows = [];
    var i;

    if (!total) {
      for (i = 0; i < 10; i++) rows.push({ digit: i, pct: 0, growth: 0 });
      return { rows: rows, high: null, low: null, rising: null, total: 0 };
    }

    var counts = new Array(10).fill(0);
    for (i = 0; i < total; i++) counts[this.list[i]]++;

    // Growth: the recent slice against everything before it.
    var recentFrom = Math.max(0, total - RECENT);
    var recent = new Array(10).fill(0);
    var earlier = new Array(10).fill(0);
    for (i = 0; i < total; i++) {
      if (i >= recentFrom) recent[this.list[i]]++;
      else earlier[this.list[i]]++;
    }
    var nRecent = total - recentFrom;
    var nEarlier = recentFrom;

    for (i = 0; i < 10; i++) {
      var pct = (counts[i] / total) * 100;
      var rPct = nRecent ? (recent[i] / nRecent) * 100 : 0;
      var ePct = nEarlier ? (earlier[i] / nEarlier) * 100 : 0;
      // With no earlier slice yet there is no trend to claim, only noise.
      rows.push({ digit: i, pct: pct, growth: nEarlier ? rPct - ePct : 0 });
    }

    // Highest and lowest by share.
    var high = 0, low = 0;
    for (i = 1; i < 10; i++) {
      if (rows[i].pct > rows[high].pct) high = i;
      if (rows[i].pct < rows[low].pct) low = i;
    }

    /* Fastest growing, but never doubling up on a digit already marked — three
       highlights that can land on the same box would say less, not more. So it
       takes the best riser that is still free, and only if it is actually
       rising. */
    var rising = null;
    var order = rows.slice().sort(function (a, b) { return b.growth - a.growth; });
    for (i = 0; i < order.length; i++) {
      var d = order[i].digit;
      if (order[i].growth <= 0) break;
      if (d !== high && d !== low) { rising = d; break; }
    }

    return { rows: rows, high: high, low: low, rising: rising, total: total };
  };

  global.EvieDigits = {
    Digits: Digits,
    lastDigitOf: lastDigitOf,
    WINDOW: WINDOW,
    RECENT: RECENT,
    PIP_DECIMALS: PIP_DECIMALS
  };
})(window);
