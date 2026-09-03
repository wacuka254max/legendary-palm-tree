/**
 * EVIE — what a currency is, so the pages stop assuming dollars.
 *
 * A Deriv options account is denominated in whatever the user opened it in:
 * USD, EUR, GBP, AUD, one of the stablecoins, or a crypto account in BTC, ETH,
 * LTC or BCH. Two of those differences matter enough to break trading, and one
 * merely tells a lie.
 *
 *   DIGITS break it. Deriv takes the stake as a string with the currency's own
 *   number of decimals. A BTC stake of 0.00000023, rounded to two, is "0.00" —
 *   the proposal is refused and no amount of retrying helps. Fiat and the
 *   stablecoins carry 2; the four crypto currencies carry 8.
 *
 *   MINIMUMS break it the other way. Deriv's floor is 0.35 in USD, and a page
 *   that enforces 0.35 against a BTC account refuses every trade the account
 *   could actually place. The fiat floors are fixed and worth checking before
 *   sending; the crypto ones move with the exchange rate, so they are NOT
 *   guessed here. An unknown floor is left to Deriv, which answers with the
 *   real number — a wrong guess of our own would block a valid trade, and that
 *   is the worse failure.
 *
 *   The SYMBOL only misleads. A EUR account showing "1.00 USD" is a lie about
 *   money even when the trade goes through.
 *
 * Deriv publishes all of this in website_status.currencies_config, but that is
 * a WebSocket call this app's OIDC credentials cannot make — see deriv.js. So
 * the table is local, and anything not in it is treated as two digits with no
 * floor of our own: the safe direction on both counts.
 */

(function (global) {
  "use strict";

  var CONFIG = {
    /* Fiat and the stablecoins: two digits, and a floor that does not move. */
    USD:   { digits: 2, min: 0.35 },
    EUR:   { digits: 2, min: 0.30 },
    GBP:   { digits: 2, min: 0.30 },
    AUD:   { digits: 2, min: 0.50 },
    USDC:  { digits: 2, min: 0.35 },
    USDT:  { digits: 2, min: 0.35 },
    eUSDT: { digits: 2, min: 0.35 },
    tUSDT: { digits: 2, min: 0.35 },
    UST:   { digits: 2, min: 0.35 },

    /* Crypto: eight digits, and a floor that moves with the rate — Deriv's to
       state, not ours to guess. */
    BTC:   { digits: 8, min: null },
    ETH:   { digits: 8, min: null },
    LTC:   { digits: 8, min: null },
    BCH:   { digits: 8, min: null }
  };

  var FALLBACK = { digits: 2, min: null };

  function conf(cur) {
    if (!cur) return CONFIG.USD;
    return CONFIG[String(cur)] || CONFIG[String(cur).toUpperCase()] || FALLBACK;
  }

  function digits(cur) { return conf(cur).digits; }

  /** Deriv's floor, or null when it is not ours to know. */
  function min(cur) { return conf(cur).min; }

  /**
   * What one press of an input's spinner should move, as a plain decimal
   * STRING. Not the number: 10^-8 stringifies to "1e-8", which is not a valid
   * step attribute — the browser discards it, falls back to a step of 1, and
   * then reports every fractional stake as invalid. toFixed gives
   * "0.00000001", which it accepts.
   */
  function step(cur) {
    var d = digits(cur);
    return d > 0 ? Math.pow(10, -d).toFixed(d) : "1";
  }

  /**
   * The stake as Deriv wants it: a plain decimal string at the currency's own
   * precision. toFixed rather than toLocaleString — this goes on the wire, and
   * a thousands separator or a comma decimal point would be rejected.
   */
  function amount(n, cur) {
    return Number(n || 0).toFixed(digits(cur));
  }

  /** The same figure for a person: grouped, and with the currency named. */
  function fmt(n, cur) {
    if (n == null || isNaN(Number(n))) return "—";
    var d = digits(cur);
    return Number(n).toLocaleString(undefined, {
      minimumFractionDigits: d,
      maximumFractionDigits: d
    }) + " " + (cur || "USD");
  }

  /** Signed, for a profit or a loss, where the sign is the point. */
  function signed(n, cur) {
    var v = Number(n || 0);
    return (v >= 0 ? "+" : "-") + fmt(Math.abs(v), cur);
  }

  /** Just the number, no currency — for a line that names it separately. */
  function bare(n, cur) {
    if (n == null || isNaN(Number(n))) return "—";
    var d = digits(cur);
    return Number(n).toLocaleString(undefined, {
      minimumFractionDigits: d,
      maximumFractionDigits: d
    });
  }

  global.EvieCurrency = {
    digits: digits,
    min: min,
    step: step,
    amount: amount,
    fmt: fmt,
    signed: signed,
    bare: bare
  };
})(window);
