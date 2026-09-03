/**
 * UPTICK — the take profit / stop loss card.
 *
 * Both bots already knew when a run had hit a target the user typed in; they
 * said so in a status line and stopped. But the person who set a take profit
 * is, by definition, not watching — that is what setting one is for — so the
 * one moment worth interrupting for was the one that whispered.
 *
 * It fires on exactly two outcomes:
 *
 *   take profit  a run that reached the target. Congratulations, and the
 *                figures, and nothing else: they got what they asked for.
 *   stop loss    a run that reached the limit. No congratulations, and no
 *                dressing it up — one piece of advice they can act on next
 *                run, which is to come back down to the minimum stake.
 *
 * Neither fires unless the user SET that target. A run that ends any other way
 * — stopped by hand, recovered, refused — says so in the status line as it
 * always did. This is not a general notifier.
 *
 * The name on the API is PopupNotifications because that is what the Automatic
 * AI engine already calls, on the two lines it was carrying from the platform
 * it was written for. Those calls have been dead here for want of this file.
 */

(function (global) {
  "use strict";

  /* The platform's own mark, so the card is plainly Uptick's and not the
     browser's or Deriv's. Inline rather than an <img>: it must paint with the
     card, and a request that has not landed yet is a hole in it. */
  var MARK =
    '<svg viewBox="0 0 32 32" width="34" height="34" aria-hidden="true">' +
    '<circle cx="16" cy="16" r="16" fill="#7c5cff"/>' +
    '<path d="M9 20.5 16 9l7 11.5-7-4.2-7 4.2z" fill="#fff"/>' +
    "</svg>";

  /* Deriv's own portfolio, where money is moved into the options account the
     bots trade. The referral token is this platform's, so a deposit made from
     here is still attributed to it — Deriv attribute a Trader's Hub deep link
     by the `t` parameter appended to the destination, which is why this is not
     the bare referral link: that would land them on the front page, one more
     hop from the thing they came to do. */
  var DEPOSIT_URL = "https://home.deriv.com/dashboard/portfolio?t=8XPRHR2Y8SN8";

  var open = null;   // only ever one: a second card over the first says nothing

  function esc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function money(n) {
    var v = Number(n);
    if (!isFinite(v)) return null;
    return (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(2);
  }

  function figure(key, value) {
    return '<div class="tpop-fig tpop-fig--' + key + '"><dt>' + esc(key === "profit" ? "Profit" : key === "trades" ? "Trades" : "Running") +
      "</dt><dd>" + esc(value) + "</dd></div>";
  }

  function close() {
    if (!open) return;
    var card = open;
    open = null;
    card.classList.remove("is-in");
    document.removeEventListener("keydown", onKey);
    setTimeout(function () { if (card.parentNode) card.parentNode.removeChild(card); }, 240);
  }

  function onKey(e) {
    if (e.key === "Escape") close();
  }

  function show(kind, kicker, title, message, details, action) {
    if (!document.body) return null;

    // A run cannot hit two targets, but a stray second call must not stack.
    close();

    details = details || {};
    var figs = "";
    if (details.profit != null && money(details.profit) != null) figs += figure("profit", money(details.profit));
    if (details.trades != null) figs += figure("trades", details.trades);
    if (details.time) figs += figure("time", details.time);

    var el = document.createElement("div");
    el.className = "tpop tpop--" + (kind === "win" ? "win" : "loss");
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-labelledby", "tpop-t");
    el.innerHTML =
      '<div class="tpop-back" data-tpop-close></div>' +
      '<div class="tpop-card">' +
        '<div class="tpop-mark">' + MARK + "</div>" +
        '<p class="tpop-k">' + esc(kicker) + "</p>" +
        '<h2 class="tpop-t" id="tpop-t">' + esc(title) + "</h2>" +
        '<p class="tpop-p">' + esc(message) + "</p>" +
        (figs ? '<dl class="tpop-figs">' + figs + "</dl>" : "") +
        (action
          ? '<div class="tpop-actions">' +
              '<a class="tpop-go" href="' + esc(action.href) + '" target="_blank" rel="noopener noreferrer sponsored">' +
                esc(action.label) +
              "</a>" +
              '<button class="tpop-quit" type="button" data-tpop-close>Not now</button>' +
            "</div>"
          : '<button class="tpop-go" type="button" data-tpop-close>Done</button>') +
      "</div>";

    el.addEventListener("click", function (e) {
      if (e.target.closest("[data-tpop-close]")) close();
    });

    document.body.appendChild(el);
    open = el;
    document.addEventListener("keydown", onKey);

    /* A timeout rather than requestAnimationFrame: rAF is throttled in a
       background tab, and a bot that finishes while the tab is in the
       background is the ordinary case, not the odd one. The card would mount
       at opacity 0 and stay there. */
    setTimeout(function () { el.classList.add("is-in"); }, 20);

    var go = el.querySelector(".tpop-go");
    if (go && go.focus) go.focus();

    return el;
  }

  global.PopupNotifications = {
    /* Reached what they asked for. Say so and get out of the way. */
    showTakeProfit: function (details) {
      return show("win", "Target reached", "Congratulations!",
        "Your take profit was hit and the bot stopped itself.", details);
    },

    /* Reached the limit instead. No congratulations, and no consolation
       either — one thing they can do differently, which is the smallest stake
       the market allows: it is what survives a losing streak long enough for
       the recovery to work. */
    showStopLoss: function (details) {
      return show("loss", "Limit reached", "Stop loss hit",
        "Try the minimum stake on the next run — a smaller stake rides out more losing streaks.", details);
    },

    /* Not a result — a wall. The run stopped because the account cannot cover
       the next stake, and no amount of waiting fixes that, so the card carries
       the one thing that does. The figures are left off: what the session made
       is beside the point when the answer is "top it up". */
    showNeedsDeposit: function (details) {
      return show("loss", "Bot stopped", "Your account balance is insufficient",
        "There is not enough in the options account to place the next trade.",
        details, { href: DEPOSIT_URL, label: "Deposit" });
    },

    close: function () { close(); }
  };
})(window);
