/**
 * EVIE — the six digit contracts, and the rules that make each one different.
 *
 * Every digit contract lasts ONE tick on a volatility index, and settles on the
 * LAST DIGIT of the next quote. That much they share. What differs — and what
 * gets a trade rejected if you get it wrong — is the barrier:
 *
 *   Matches  DIGITMATCH  barrier 0-9  wins when the last digit IS the barrier
 *   Differs  DIGITDIFF   barrier 0-9  wins when the last digit is NOT the barrier
 *   Over     DIGITOVER   barrier 0-8  wins when the last digit is GREATER
 *   Under    DIGITUNDER  barrier 1-9  wins when the last digit is LESS
 *   Even     DIGITEVEN   no barrier   wins on 0 2 4 6 8
 *   Odd      DIGITODD    no barrier   wins on 1 3 5 7 9
 *
 * Rise and Fall are not digit contracts at all — they are CALL and PUT on the
 * price itself, take no barrier, and win if the exit quote is above (or below)
 * the entry. They sit on the same card because the same tick stream answers
 * both questions.
 *
 * The two narrowed ranges are not arbitrary and are the usual cause of an
 * "invalid barrier" error: nothing is over 9, so DIGITOVER stops at 8, and
 * nothing is under 0, so DIGITUNDER starts at 1. Sending Even or Odd WITH a
 * barrier is rejected too, so the builder omits the field entirely for those.
 */

(function (global) {
  "use strict";

  var TYPES = {
    match: {
      id: "match", label: "Matches", contract: "DIGITMATCH",
      barrier: true, min: 0, max: 9,
      explain: "Wins if the last digit is exactly this digit."
    },
    differ: {
      id: "differ", label: "Differs", contract: "DIGITDIFF",
      barrier: true, min: 0, max: 9,
      explain: "Wins if the last digit is anything but this digit."
    },
    over: {
      id: "over", label: "Over", contract: "DIGITOVER",
      barrier: true, min: 0, max: 8,
      explain: "Wins if the last digit is greater than this digit."
    },
    under: {
      id: "under", label: "Under", contract: "DIGITUNDER",
      barrier: true, min: 1, max: 9,
      explain: "Wins if the last digit is less than this digit."
    },
    even: {
      id: "even", label: "Even", contract: "DIGITEVEN",
      barrier: false,
      explain: "Wins if the last digit is 0, 2, 4, 6 or 8."
    },
    odd: {
      id: "odd", label: "Odd", contract: "DIGITODD",
      barrier: false,
      explain: "Wins if the last digit is 1, 3, 5, 7 or 9."
    },
    rise: {
      id: "rise", label: "Rise", contract: "CALL",
      barrier: false,
      explain: "Wins if the price ends higher than it started."
    },
    fall: {
      id: "fall", label: "Fall", contract: "PUT",
      barrier: false,
      explain: "Wins if the price ends lower than it started."
    }
  };

  /** The barrier this type would actually accept, nearest to what was asked. */
  function clampBarrier(type, digit) {
    var t = TYPES[type];
    if (!t || !t.barrier) return null;
    var d = Number(digit);
    if (isNaN(d)) d = t.min;
    return Math.min(t.max, Math.max(t.min, Math.round(d)));
  }

  /**
   * The proposal Deriv expects. `underlying_symbol` (not `symbol`) — the new API
   * renamed it, and the old name is silently ignored.
   */
  function proposal(opts) {
    var t = TYPES[opts.type];
    if (!t) throw new Error("Unknown trade type.");

    /* At the CURRENCY's precision, not two places. A BTC stake of 0.00000023
       rounded to two is "0.00", which Deriv refuses — see currency.js. */
    var cur = opts.currency || "USD";
    var req = {
      proposal: 1,
      amount: global.EvieCurrency
        ? global.EvieCurrency.amount(opts.stake, cur)
        : Number(opts.stake).toFixed(2),
      basis: "stake",
      contract_type: t.contract,
      currency: cur,
      duration: 1,
      duration_unit: "t",
      underlying_symbol: opts.market
    };

    // Present only where the contract takes one. Even/Odd are rejected with it.
    if (t.barrier) req.barrier = String(clampBarrier(opts.type, opts.barrier));

    return req;
  }

  /** Would this digit have won? Used to describe a settled trade in words. */
  function wouldWin(type, barrier, digit) {
    switch (type) {
      case "match": return digit === Number(barrier);
      case "differ": return digit !== Number(barrier);
      case "over": return digit > Number(barrier);
      case "under": return digit < Number(barrier);
      case "even": return digit % 2 === 0;
      case "odd": return digit % 2 === 1;
      // Rise and Fall settle on the price, not the digit, so a digit cannot
      // answer for them.
      default: return false;
    }
  }

  global.EvieContracts = {
    TYPES: TYPES,
    order: ["rise", "fall", "even", "odd", "over", "under", "match", "differ"],
    clampBarrier: clampBarrier,
    proposal: proposal,
    wouldWin: wouldWin
  };
})(window);
