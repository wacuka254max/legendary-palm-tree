/**
 * EVIE — one market's analysis.
 *
 * Holds a rolling window of the last N ticks for a single symbol and answers
 * every question the card asks:
 *
 *   per digit    how much of the window each of 0-9 accounts for
 *   even / odd   the same split, folded in two
 *   over / under against the reference digit, which is EXCLUDED from both —
 *                over 5 means strictly greater, under 5 strictly less, and the
 *                5s themselves belong to neither. That is why the two never
 *                add up to 100 unless the reference digit never appeared.
 *   rise / fall  from the PRICE, not the digit: each tick against the one
 *                before it. Unchanged ticks count in the denominator and
 *                belong to neither side, so these two also fall short of 100.
 *
 * Reading the digit has one trap worth the separate function: JavaScript drops
 * trailing zeros, so 1234.50 arrives as 1234.5 and a naive read takes the 5
 * where Deriv settles a 0. The quote is formatted to the market's own decimal
 * count first. Deriv sends pip_size on the tick; the table is the fallback.
 */

(function (global) {
  "use strict";

  var PIP_DECIMALS = { R_10: 3, R_25: 3, R_50: 4, R_75: 4, R_100: 2 };

  function lastDigitOf(quote, symbol, pipSize) {
    var decimals = typeof pipSize === "number"
      ? pipSize
      : (PIP_DECIMALS[symbol] != null ? PIP_DECIMALS[symbol] : 2);
    var s = Number(quote).toFixed(decimals);
    var d = parseInt(s.charAt(s.length - 1), 10);
    return isNaN(d) ? null : d;
  }

  function Analyser(symbol, count) {
    this.symbol = symbol;
    this.count = count || 130;
    this.digits = [];
    this.prices = [];
  }

  Analyser.prototype.setCount = function (n) {
    this.count = Math.max(10, Math.min(5000, Number(n) || 130));
    this.trim();
  };

  Analyser.prototype.trim = function () {
    var over = this.digits.length - this.count;
    if (over > 0) { this.digits.splice(0, over); this.prices.splice(0, over); }
  };

  Analyser.prototype.reset = function () { this.digits = []; this.prices = []; };

  Analyser.prototype.push = function (quote, pipSize) {
    var d = lastDigitOf(quote, this.symbol, pipSize);
    if (d == null) return;
    this.digits.push(d);
    this.prices.push(Number(quote));
    this.trim();
  };

  Analyser.prototype.seed = function (quotes) {
    this.reset();
    for (var i = 0; i < quotes.length; i++) this.push(quotes[i]);
  };

  Analyser.prototype.ready = function () { return this.digits.length > 1; };
  Analyser.prototype.current = function () {
    return this.digits.length ? this.digits[this.digits.length - 1] : null;
  };
  Analyser.prototype.recent = function (n) {
    return this.digits.slice(Math.max(0, this.digits.length - n));
  };

  /** Everything the card renders, in one pass over the window. */
  Analyser.prototype.stats = function (reference) {
    var ref = Number(reference);
    if (isNaN(ref)) ref = 5;

    var total = this.digits.length;
    var counts = new Array(10).fill(0);
    var i;

    for (i = 0; i < total; i++) counts[this.digits[i]]++;

    var pct = counts.map(function (c) { return total ? (c / total) * 100 : 0; });

    var even = 0, odd = 0, over = 0, under = 0;
    for (i = 0; i < 10; i++) {
      if (i % 2 === 0) even += counts[i]; else odd += counts[i];
      if (i > ref) over += counts[i];
      else if (i < ref) under += counts[i];
      // i === ref belongs to neither, by design.
    }

    // Rise and fall from the price itself, one comparison per adjacent pair.
    var ups = 0, downs = 0, moves = 0;
    for (i = 1; i < this.prices.length; i++) {
      moves++;
      if (this.prices[i] > this.prices[i - 1]) ups++;
      else if (this.prices[i] < this.prices[i - 1]) downs++;
    }

    var high = 0, low = 0;
    for (i = 1; i < 10; i++) {
      if (pct[i] > pct[high]) high = i;
      if (pct[i] < pct[low]) low = i;
    }

    var p = function (n, d) { return d ? (n / d) * 100 : 0; };

    return {
      total: total,
      reference: ref,
      current: this.current(),
      digits: pct.map(function (v, d) { return { digit: d, pct: v, count: counts[d] }; }),
      high: total ? high : null,
      low: total ? low : null,
      even: p(even, total),
      odd: p(odd, total),
      over: p(over, total),
      under: p(under, total),
      match: pct[ref] || 0,
      differ: total ? 100 - (pct[ref] || 0) : 0,
      rise: p(ups, moves),
      fall: p(downs, moves)
    };
  };

  global.EvieAnalyser = {
    Analyser: Analyser,
    lastDigitOf: lastDigitOf,
    PIP_DECIMALS: PIP_DECIMALS
  };
})(window);
