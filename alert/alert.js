/**
 * PIPVANA — the take profit / stop loss card.
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

  /* The platform's own mark, so the card is plainly Pipvana's and not the
     browser's or Deriv's. Inline rather than an <img>: it must paint with the
     card, and a request that has not landed yet is a hole in it. */
  var MARK =
    '<svg viewBox="0 0 32 32" width="34" height="34" aria-hidden="true">' +
    '<circle cx="16" cy="16" r="16" fill="#7c5cff"/>' +
    '<g transform="translate(-1.1 -0.3)"><path d="M12.2 24V8.6h4.9a4.85 4.85 0 0 1 0 9.7h-4.9" fill="none" stroke="#fff" stroke-width="3.3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="21.6" cy="22.6" r="2.05" fill="#fff"/></g>' +
    "</svg>";

  /* Deriv's own portfolio, where money is moved into the options account the
     bots trade. The referral token is this platform's, so a deposit made from
     here is still attributed to it — Deriv attribute a Trader's Hub deep link
     by the `t` parameter appended to the destination, which is why this is not
     the bare referral link: that would land them on the front page, one more
     hop from the thing they came to do. */
  var DEPOSIT_URL = "https://home.deriv.com/dashboard/portfolio?t=8XPRHR2Y8SN8";
  /* Where a login opens its real account: Deriv's own dashboard, with the same attribution. */
  var OPEN_REAL_URL = "https://home.deriv.com/dashboard/home?t=8XPRHR2Y8SN8";

  var open = null;   // only ever one: a second card over the first says nothing

  /* What went wrong (risk.js mistakes): the points come in the page's language already; the
     heading and the closing note are put in it here. */
  var tr = function (s) { return typeof global.t === "function" ? global.t(s) : s; };
  var WHY_NOTE = "Raising the stake, aiming for too much profit in one run, overtrading and trading without enough balance are why most traders fail.";
  function whyBox(list) {
    if (!list || !list.length) return "";
    // The points, then the note as a tip of its own (green: advice, not a warning).
    return '<div class="tpop-why" data-i18n-skip><div class="tpop-why-box"><p class="tpop-why-h">' + esc(tr("What went wrong")) + "</p><ul>" +
      list.map(function (x) { return "<li>" + esc(x) + "</li>"; }).join("") + '</ul></div><div class="tpop-why-tip"><span class="tpop-why-tip-i" aria-hidden="true"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14"/></svg></span><p><b>' +
      esc(tr("Tip")) + "</b>" + esc(tr(WHY_NOTE)) + "</p></div></div>";
  }
  /** The points show in full: the card grows to hold them, their box never scrolls. */
  function fitWhy() {
    var box = open && open.querySelector(".tpop-why");
    if (!box) return;
    open.classList.add("has-why");   // the card set closer while its points show
    box.style.maxHeight = ""; box.classList.remove("is-more");
  }
  function moreWhy() {
    var box = open && open.querySelector(".tpop-why");
    if (box) box.classList.toggle("is-more", box.scrollTop + box.clientHeight < box.scrollHeight - 2);
  }
  global.addEventListener("resize", function () { if (open) fitWhy(); });

  function esc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  /* The account's own currency at its own precision: a euro account showing
     a dollar figure, or a BTC one rounded to cents, is a lie about money in
     the one place it matters most. */
  function money(n, cur) {
    var v = Number(n);
    if (!isFinite(v)) return null;
    var abs = global.EvieCurrency
      ? global.EvieCurrency.bare(Math.abs(v), cur)
      : Math.abs(v).toFixed(2);
    return (v >= 0 ? "+" : "−") + abs;
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
    if (details.profit != null && money(details.profit, details.currency) != null) figs += figure("profit", money(details.profit, details.currency));
    if (details.trades != null) figs += figure("trades", details.trades);
    if (details.time) figs += figure("time", details.time);

    var el = document.createElement("div");
    el.className = "tpop tpop--" + (kind === "win" ? "win" : kind === "real" ? "real" : "loss");
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
        (details.more ? '<p class="tpop-p tpop-p--more">' + esc(details.more) + "</p>" : "") +
        (details.steps ? '<ol class="tpop-steps">' + details.steps.map(function (s) { return "<li>" + esc(s) + "</li>"; }).join("") + "</ol>" : "") +
        whyBox(details.why) +
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
    if (details.why && details.why.length) {
      fitWhy();
      var wb = el.querySelector(".tpop-why");
      if (wb) wb.addEventListener("scroll", moreWhy, { passive: true });
    }

    /* A timeout rather than requestAnimationFrame: rAF is throttled in a
       background tab, and a bot that finishes while the tab is in the
       background is the ordinary case, not the odd one. The card would mount
       at opacity 0 and stay there. */
    setTimeout(function () { el.classList.add("is-in"); }, 20);

    var go = el.querySelector(".tpop-go");
    if (go && go.focus) go.focus();

    return el;
  }

  /* A wait a running bot is in — Deriv's rate limit, the line coming back, a contract update
     asked for again, the last trade settling: a card that keeps moving, put just before
     `anchor` (the trades list, or the bot's status line), until `text` is "" again. */
  var WAIT_SUB = "The bot carries on by itself — no need to do anything.";
  function waitCard(anchor, text) {
    var box = anchor && anchor.parentNode;
    if (!box) return;
    var w = null;
    for (var n = box.firstElementChild; n; n = n.nextElementSibling) if (n.classList.contains("bot-wait")) w = n;
    if (!text) { if (w) w.hidden = true; return; }
    // Deriv's rate limit reads as what the bot is doing meanwhile (owner): analysing.
    if (!w) {
      w = document.createElement("div");
      w.className = "bot-wait";
      w.setAttribute("role", "status");
      w.setAttribute("aria-live", "polite");
      w.setAttribute("data-i18n-skip", "");
      w.innerHTML = '<span class="bot-wait-mark" aria-hidden="true"><i></i><i></i><i></i></span><span class="bot-wait-t"><strong></strong><span></span></span>';
      box.insertBefore(w, anchor);
    }
    w.querySelector("strong").textContent = tr(text);
    w.querySelector(".bot-wait-t > span").textContent = tr(WAIT_SUB);
    w.hidden = false;
  }

  global.PopupNotifications = {
    /* A running bot's wait, shown moving before `anchor`; "" puts it away. */
    wait: waitCard,

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
      // details.why: what the run did past the risk guide (risk.js), when it did.
      return show("loss", "Limit reached", "Stop loss hit",
        "Try the minimum stake on the next run — a smaller stake rides out more losing streaks.", details);
    },

    /* Not a result — a wall. The run stopped because the account cannot cover
       the next stake, and no amount of waiting fixes that, so the card carries
       the one thing that does. The figures are left off: what the session made
       is beside the point when the answer is "top it up". */
    showNeedsDeposit: function (details) {
      // Only the points (details.why), if any: the figures stay off this card.
      return show("loss", "Bot stopped", "Your account balance is insufficient",
        "There is not enough in the options account to place the next trade.",
        details && details.why ? { why: details.why } : details, { href: DEPOSIT_URL, label: "Deposit" });
    },

    /* No real account yet (real.js): why it is needed, the three steps, and the way to
       open it on Deriv. Once a visit by itself, and again on Start. */
    showNeedsReal: function (demo) {
      return show("real", "Real account needed", "Open your real account to start trading",
        demo ? "This Deriv login has only a demo account so far." : "This Deriv login has no trading account yet.",
        {
          more: demo
            ? "Your demo account is there for practice. To trade real money, the bots need a real Deriv account. Setting one up on Deriv takes a few minutes, and it appears here the moment it is ready."
            : "The bots trade on a real Deriv account. Setting one up on Deriv takes a few minutes, and they are ready the moment it appears here.",
          steps: ["Open your real account on Deriv", "Add funds to it", "Come back here and start the bot"]
        },
        { href: OPEN_REAL_URL, label: "Set up my real account" });
    },

    close: function () { close(); }
  };
})(window);
