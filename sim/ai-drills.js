/**
 * EVIE — recovery drills for the Automatic AI simulation.
 *
 * With losses set to none, nothing loses. The bot then spends the whole
 * session on Differs at the base stake and never once shows the thing it is
 * actually built around: the recovery. Stake stepped up by the martingale,
 * Over 4 or Under 5 on the market whose digits are leaning that way, and the
 * ladder cleared by a win.
 *
 * So the drill STARTS a recovery instead of provoking one. Every so often,
 * after a winning trade, the bot is put into recovery mode with the stake the
 * martingale would have set. Its own code does the rest — it picks the side
 * from the digit counts, buys Over or Under at that stake, and leaves recovery
 * on the win. Single or double, on a coin flip: a double runs the second rung
 * at the multiplier again, which is what the ladder climbing actually looks
 * like.
 *
 * Nothing about the result is faked. Every trade shown was placed by the real
 * engine, at the stake and on the contract the ledger says, and won on a real
 * tick. The only thing injected is the DECISION to escalate — which in a live
 * session a loss would have made.
 *
 * This file exists only in the simulation. The engine has no idea it is here:
 * it is handed the same state a loss would have left behind.
 */

(function (global) {
  "use strict";

  var FIRST_MIN = 2;      // the first drill lands inside the first ten trades
  var FIRST_MAX = 10;
  var GAP_MIN = 3;        // and the ones after it, three to twenty-five apart
  var GAP_MAX = 25;

  var Real = global.EvieAutomaticAI;
  if (!Real) return;

  function round2(n) { return Math.round(n * 100) / 100; }

  function attach(bot, ui) {
    var trades = 0;
    var nextAt = FIRST_MIN + Math.floor(Math.random() * (FIRST_MAX - FIRST_MIN + 1));
    var rungsLeft = 0;     // rungs still to place after this one
    var rung = 0;          // how far up the ladder the drill has climbed

    function multiplier() {
      return Number(bot.config && bot.config.martingaleMultiplier) || 3.1;
    }

    function base() {
      return Number(bot.config && bot.config.initialStake) || 1;
    }

    /* Put the bot where a loss would have put it: in recovery, at the stake
       the martingale would have set. The engine chooses the market and the
       side itself, from its own digit counts. */
    function escalate() {
      rung++;
      bot.recoveryMode = true;
      bot.currentStake = round2(base() * Math.pow(multiplier(), rung));
      ui.showStatus("Recovery drill — Over/Under at " + bot.currentStake.toFixed(2) + ".", "info");
    }

    function endDrill() {
      stepsLeft = 0;
      rung = 0;
      nextAt = trades + GAP_MIN + Math.floor(Math.random() * (GAP_MAX - GAP_MIN + 1));
    }

    var realAdd = ui.addHistoryEntry;

    /* Called once per settled trade, after the engine has done its own
       bookkeeping — the stake is back at base and recovery is closed — and
       before it queues the next one. Exactly the window in which a loss would
       have changed its mind. */
    ui.addHistoryEntry = function (entry) {
      realAdd.call(ui, entry);
      trades++;

      // A drill still owes a rung: climb it.
      if (rungsLeft > 0) {
        rungsLeft--;
        escalate();
        return;
      }

      // The last rung has just settled — put the ladder away.
      if (rung > 0) { endDrill(); return; }

      if (trades < nextAt) return;

      /* Single or double, on a coin flip. This settle places the first rung,
         so a double leaves one still owed. */
      rungsLeft = (Math.random() < 0.5 ? 1 : 2) - 1;
      escalate();
    };
  }

  /* The page builds the bot with `new`; returning an object from a constructor
     hands that object back, so this stands in front without the page or the
     engine knowing it is there. */
  global.EvieAutomaticAI = function (ui, options) {
    var bot = new Real(ui, options);
    try { attach(bot, ui); } catch (e) {}
    return bot;
  };
  global.EvieAutomaticAI.prototype = Real.prototype;
})(window);
