/**
 * EVIE — what a stake and a take profit risk on this balance.
 *
 * Two answers, for the bots on Analysis and Automatic AI:
 *
 *   The starting figures. A stake sized so the martingale ladder it starts can
 *   be paid for a set number of losses in a row on this balance, and a take
 *   profit of 10% of the balance — never under 3 USD: a run should end on a
 *   profit that means something.
 *
 *   A word on each figure: Safe, High or Too high. The stake by the losses in
 *   a row it survives; the take profit by its share of the balance — up to
 *   10% safe, up to 16% high, more too high. When one is not safe, a line
 *   says why and gives the safe figure.
 *
 * Each kind of trade is a ladder of chances and payouts (per 1 staked, the
 * app's markup in):
 *
 *   evenodd   50%, 1.845            risefall  50%, 1.783 (Volatility indices)
 *   ou:N      Over N / Under 9−N — the likelier side of the pair (N 0–7)
 *   differ    Differs, 90% at 1.06; after a loss the recovery is a 50/50
 *             trade at 1.85 (Over 4 / Under 5 on Automatic AI; the best of
 *             the other types on the Analysis bot), until it wins.
 *
 * One cycle of the ladder — up the martingale until a win or until the balance
 * cannot pay the next stake — gives the chance a cycle ends short and the
 * profit of one that wins. A run is cycles until the take profit: its risk is
 * 1 − (1 − short)^(target ÷ profit).
 *
 * Dollars only: the 3 USD floor and the payouts are the dollar account's. Any
 * other currency keeps the page's own figures and shows no word.
 */
(function (global) {
  "use strict";

  var OU_PAY = [1.06, 1.19, 1.35, 1.56, 1.85, 2.26, 2.92, 4.13];
  var HALF_PAY = 1.845, RISE_PAY = 1.783, RECOVER = [0.5, 1.85];
  /* The losses in a row each kind's starting stake is sized to survive — Differs and its
     kind (Over/Under at 90–60%) 3 or more, Even/Odd, Rise/Fall and Over/Under at 50% 6 —
     and its take profit as a share of the balance. */
  var DEPTH = { evenodd: 6, risefall: 6, differ: 4, ou: [3, 3, 4, 5, 6, 6, 9, 14] };
  var TP_SHARE = 0.10, TP_HIGH = 0.16;
  var TP_MIN = 3;
  /* Deriv pays at most 10,000 on one contract and refuses a stake whose payout would be
     more ("Your payout exceeds the maximum payout"); the bots stay half a percent under. */
  var MAX_PAYOUT = 10000, PAYOUT_CAP = MAX_PAYOUT * 0.995;

  function round2(v) { return Math.round(v * 100) / 100; }
  function cents(v, up) { return (up ? Math.ceil(v * 100 - 1e-9) : Math.floor(v * 100 + 1e-9)) / 100; }
  function ouOf(kind) { return Number(String(kind).split(":")[1]); }
  function perKind(table, kind) { return kind.indexOf("ou:") === 0 ? table.ou[ouOf(kind)] : table[kind]; }

  /** The Over/Under kind a reference digit trades: the likelier of Over r and Under r. */
  function ouFor(ref) { var r = Number(ref); return "ou:" + (r <= 4 ? r : 9 - r); }

  /** Step i of the ladder: [chance of a win, payout per 1 staked]. */
  function step(kind, i) {
    if (kind === "differ") return i ? RECOVER : [0.9, OU_PAY[0]];
    if (kind === "evenodd") return [0.5, HALF_PAY];
    if (kind === "risefall") return [0.5, RISE_PAY];
    var n = ouOf(kind);
    return [(9 - n) / 10, OU_PAY[n]];
  }

  /** The largest stake whose payout Deriv takes, for a contract that wins with chance p
   *  (its payout before any markup is under 0.99 / p per 1 staked). */
  function maxStake(p) { return cents(PAYOUT_CAP * p / 0.99); }

  function cycle(kind, balance, stake, mult, min) {
    var st = Math.max(min, stake), spent = 0, prob = 1, depth = 0, e = 0, ok = 0;
    while (depth < 300) {
      var s = step(kind, depth);
      if (spent + st > balance + 1e-9 || st * s[1] > PAYOUT_CAP) break;
      e += prob * s[0] * (cents(st * s[1]) - st - spent); ok += prob * s[0];
      spent += st; prob *= 1 - s[0]; st = round2(st * mult); depth++;
    }
    return { depth: depth, bust: prob, profit: ok > 0 ? e / ok : 0 };
  }

  /** The starting stake and take profit for this kind on this balance (null with the
   *  martingale off: a flat stake is no ladder, and the page keeps its own figures). */
  function defaults(kind, balance, mult, min) {
    if (!(mult > 1)) return null;
    var d = perKind(DEPTH, kind), m = mult, stake = min, tp = 0;
    if (balance > 0) {
      stake = cents(balance * (m - 1) / (Math.pow(m, d) - 1));
      // On a large balance the ladder's last step must stay under Deriv's maximum payout too.
      stake = Math.min(stake, cents(PAYOUT_CAP / (step(kind, d - 1)[1] * Math.pow(m, d - 1))));
      // Cent rounding up the ladder can cost a step: the largest stake that still covers them all.
      for (var k = 0; k < 100 && stake > min && cycle(kind, balance, stake, m, min).depth < d; k++) stake = round2(stake - 0.01);
      stake = Math.max(min, stake);
      /* A martingale below the one that wins back a loss on this trade (Over 0–2 at
         ×3.1 need 17.7, 6.3, 3.9) is no recovery ladder: the smallest stake, not a large one. */
      var rec = step(kind, 1);
      if (m < rec[1] / (rec[1] - 1)) stake = min;
      tp = cents(balance * TP_SHARE);   // to the cent below: never a hair over 10%
    }
    return { stake: Math.max(min, stake), tp: Math.max(TP_MIN, tp) };
  }

  /** The balance this stake's ladder needs to cover the kind's losses in a row (0: none —
   *  a step's payout would pass Deriv's maximum first). */
  function balanceFor(kind, stake, mult, d, min) {
    var st = Math.max(min, stake), sum = 0;
    for (var i = 0; i < d; i++) {
      if (st * step(kind, i)[1] > PAYOUT_CAP) return 0;
      sum += st; st = round2(st * mult);
    }
    return cents(sum, true);
  }

  /** Safe / high / over for the stake and the take profit, and the safe figures (null
   *  with the martingale off). */
  function assess(kind, balance, stake, mult, tp, min) {
    if (!(mult > 1) || !(balance >= 0) || !(stake > 0) || !(tp > 0)) return null;
    var d = perKind(DEPTH, kind), m = mult, c = cycle(kind, balance, stake, m, min);
    var safeStake = defaults(kind, balance, m, min).stake;
    return {
      stake: c.depth >= d ? "safe" : c.depth === d - 1 ? "high" : "over", depth: c.depth,
      // The balance the kind needs at the smallest stake (0.35), with this martingale.
      atMin: stake <= min + 1e-9, needBal: c.depth >= d ? 0 : balanceFor(kind, min, m, d, min),
      safeStake: cycle(kind, balance, safeStake, m, min).depth >= d ? safeStake : 0,
      // In whole cents, as the figures are typed: 10% of 1,036.67 is 103.66, and 103.67 is over it.
      tp: tp <= cents(balance * TP_SHARE) + 1e-9 ? "safe" : tp <= cents(balance * TP_HIGH) + 1e-9 ? "high" : "over", safeTp: cents(balance * TP_SHARE),
    };
  }

  /* ── what went wrong: a run that ended on its stop loss or the balance ── */

  /* Read against this guide's own figures for the balance the run started on, whether the
     guide was on or not: a stake whose martingale ladder rides out fewer losses in a row than
     the kind needs (and the safe stake, and the balance that stake needed), a martingale too
     high for any stake to be safe when the page's own would have been, a balance too small for
     the kind at any stake (and the balance it needed), a take profit over 10% of the balance on
     one run, and, at a stop loss, one that ended the ladder before the losses the kind needs.
     One point each, with the figure that keeps to the guide; none when the run kept to it (the
     card then says what it always said). Defaults are never a mistake: the smallest stake, a
     3 USD take profit. The martingale off is no ladder, and the guide says nothing about it. */
  var WHY = {
    stake: "Stake too high ({stake}) — safe stake: {safe}.",
    mult: "Martingale too high (×{m}) — use ×{def}.",
    bal: "Balance too small for this type ({bal}) — recommended balance: {need}.",
    balOnly: "Balance too small for this type ({bal}).",
    tp: "Take profit too high ({tp}) — safe target: {safe}.",
    sl: "Stop loss too small ({sl}) — set at least {need}.",
    note: "Raising the stake, aiming for too much profit in one run, overtrading and trading without enough balance are why most traders fail.",
  };
  /** o: { kind, balance (at the start), stake, mult, defMult (the page's own), tp (0: none set),
   *  sl (0: none), why ("sl" or "funds"), min, money(v) }. The points, in the page's language. */
  function mistakes(o) {
    var B = o && o.balance, kind = o && o.kind, min = (o && o.min) || 0.35, m = o && o.mult, M = o && o.money;
    if (!(B > 0) || !kind || !(o.stake > 0) || !(m > 1) || typeof M !== "function") return [];
    var d = perKind(DEPTH, kind), out = [], c = cycle(kind, B, o.stake, m, min);
    var def = o.defMult > 1 ? o.defMult : m;
    var safeM = defaults(kind, B, m, min).stake, roomM = cycle(kind, B, safeM, m, min).depth >= d;
    var safeD = defaults(kind, B, def, min).stake, roomD = cycle(kind, B, safeD, def, min).depth >= d;
    if (c.depth < d) {
      if (roomM && o.stake > safeM + 1e-9) out.push(T(WHY.stake, { stake: M(o.stake), safe: M(safeM) }));
      else if (!roomM && roomD && m > def + 1e-9) out.push(T(WHY.mult, { m: m, def: def }));
      else if (!roomM) {
        // The balance the kind needs at the smallest stake (0.35) and the page's own martingale,
        // the guide's figures; a martingale above the page's is a point of its own.
        var need = balanceFor(kind, min, def, d, min);
        out.push(need > 0 ? T(WHY.bal, { bal: M(B), need: M(need) }) : T(WHY.balOnly, { bal: M(B) }));
        if (m > def + 1e-9) out.push(T(WHY.mult, { m: m, def: def }));
      }
    }
    if (o.tp > TP_MIN + 1e-9 && o.tp > cents(B * TP_SHARE) + 1e-9) {
      out.push(T(WHY.tp, { tp: M(o.tp), safe: M(Math.max(TP_MIN, cents(B * TP_SHARE))) }));
    }
    if (o.why === "sl" && o.sl > 0) {
      for (var st = Math.max(min, o.stake), sum = 0, k = 0; k < 300 && sum < o.sl - 1e-9; k++) { sum = round2(sum + st); st = round2(st * m); }
      // The room the ladder needs: the run's own when its stake was safe, else the guide's
      // (its safe stake, or the smallest, 0.35, at the page's own martingale), as the other points say.
      var needSl = c.depth >= d ? balanceFor(kind, o.stake, m, d, min) : roomM ? balanceFor(kind, safeM, m, d, min) : balanceFor(kind, min, def, d, min);
      if (k < d && needSl > 0) out.push(T(WHY.sl, { sl: M(o.sl), need: M(needSl) }));
    }
    return out;
  }

  /* ── painting ───────────────────────────────────────────────────────── */

  var T = function (s, vars) {
    var out = typeof global.t === "function" ? global.t(s) : s;
    if (vars) for (var k in vars) out = out.split("{" + k + "}").join(String(vars[k]));
    return out;
  };
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };
  // Keys of their own ("Safe" may be another control's word): the English is the part after "risk: ".
  var WORD = { safe: "risk: Safe", high: "risk: High", over: "risk: Too high" };
  function word(level) { var w = T(WORD[level]); return w === WORD[level] ? w.slice(6) : w; }

  /**
   * The words on the page: `tags` {stake, tp} are the elements beside the two
   * labels, `note` the box under the fields; `r` an assess() result or null
   * (no balance, another currency) to clear them. `money` formats a figure.
   * The safe figures are buttons: a click hands `use` ("stake" or "tp", value)
   * to the page, which puts it in its field as typing would. No safe target
   * under 1 USD is offered — the word on the field stands alone then.
   */
  var CHECK = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
  function paint(tags, note, r, money, use) {
    // The smallest stake Deriv accepts cannot go lower: Safe, or no word on it.
    var stakeWord = r && (r.atMin && r.stake !== "safe" ? null : r.stake);
    [["stake", stakeWord], ["tp", r && r.tp]].forEach(function (x) {
      var el = tags[x[0]];
      if (!el) return;
      el.hidden = !x[1];
      if (x[1]) { el.setAttribute("data-risk", x[1]); el.textContent = word(x[1]); }
    });
    if (!note) return;
    var USE = "\u0001", lines = [];
    // No stake safe on this balance: it says so, and the balance this one needs (at the smallest stake, in green — advice, not a warning).
    if (r && r.stake && r.stake !== "safe") lines.push([r.atMin ? "safe" : r.stake, T("Stake"),
      (r.depth === 1 ? T("survives 1 loss in a row.") : r.depth ? T("survives {n} losses in a row.", { n: r.depth }) : T("is more than the balance.")) + " " +
      (r.safeStake > 0 ? T("Safe stake: {v}.", { v: USE }) : T("The balance is small for this type.") +
        (r.needBal > 0 ? " " + T("Recommended balance: {v}.", { v: money(r.needBal) }) : "")), r.safeStake > 0 && ["stake", r.safeStake]]);
    if (r && r.tp && r.tp !== "safe" && r.safeTp >= 1 && isFinite(r.safeTp)) lines.push([r.tp, T("Take profit"), T("Safe target: {v}.", { v: USE }), ["tp", r.safeTp]]);
    note.hidden = !lines.length;
    note.innerHTML = lines.map(function (l) {
      var text = esc(l[2]);
      if (l[3]) {
        var m = money(l[3][1]);
        text = text.replace(USE + ".", USE).replace(USE, '<button class="fig-use" type="button" data-use="' + l[3][0] + '" data-v="' + l[3][1] + '" title="' +
          esc(T("Use {v}", { v: m })) + '">' + CHECK + esc(m) + "</button>");
      }
      return '<p class="fig-line" data-risk="' + l[0] + '"><b>' + esc(l[1]) + ":</b> " + text + "</p>";
    }).join("");
    note.__use = use;
    if (!note.__bound) {
      note.__bound = true;
      note.addEventListener("click", function (e) {
        var b = e.target.closest && e.target.closest("[data-use]");
        if (b && note.__use) note.__use(b.getAttribute("data-use"), Number(b.getAttribute("data-v")));
      });
    }
  }

  /* ── the Risk guide switch ───────────────────────────────────────────────
     Off unless turned on, remembered in this browser (the simulation pages keep their own).
     On: the words. Off: none. Either way the inputs start from the figures above. */
  var GUIDE_KEY = document.body && document.body.classList.contains("sim-body") ? "evie_sim_guide" : "evie_risk_guide";
  function guide() { try { return global.localStorage.getItem(GUIDE_KEY) === "1"; } catch (e) { return false; } }
  /** A .tog switch for the guide: its state on the button; a press turns it over, then `after`. */
  function wireGuide(btn, after) {
    if (!btn) return;
    btn.setAttribute("aria-checked", String(guide()));
    btn.addEventListener("click", function () {
      var on = btn.getAttribute("aria-checked") !== "true";
      btn.setAttribute("aria-checked", String(on));
      try { if (on) global.localStorage.setItem(GUIDE_KEY, "1"); else global.localStorage.removeItem(GUIDE_KEY); } catch (e) {}
      if (after) after(on);
    });
  }

  global.EvieRisk = { ouFor: ouFor, defaults: defaults, assess: assess, paint: paint, maxStake: maxStake, TP_MIN: TP_MIN, guide: guide, wireGuide: wireGuide,
    mistakes: mistakes, WHY_NOTE: WHY.note };
})(window);
