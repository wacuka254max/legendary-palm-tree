/**
 * EVIE — what the page remembers for the length of a tab.
 *
 * A refresh should cost nothing. Someone who has set a stake, turned the
 * martingale down to 2.4 and armed a take profit has made four decisions, and
 * an accidental reload — or the reload Deriv's own redirect causes — should not
 * hand them back the defaults.
 *
 * Closing the tab is different. That is a deliberate end to a session, and the
 * next one should start clean rather than inheriting the risk settings of
 * whatever was being tried an hour ago. Stake and stop loss are exactly the
 * settings you do not want quietly restored on a page you opened to try
 * something small.
 *
 * sessionStorage draws that line for us: it survives reloads and restores, and
 * it dies with the tab. Nothing here is written to localStorage.
 *
 * Restoring is done by REPLAYING the interaction rather than by writing state:
 * a stored value is put in the field and a `change` fired, a stored switch is
 * clicked if it is not already where it should be. The page's own handlers
 * then run exactly as they would have for a person, so anything that depends
 * on a setting — a hidden row, a re-subscription, the next stake — follows on
 * its own. No second copy of that logic to keep in step here.
 */

(function (global) {
  "use strict";

  var PREFIX = "evie_prefs_";

  function readAll(key) {
    try { return JSON.parse(global.sessionStorage.getItem(key) || "{}") || {}; }
    catch (e) { return {}; }
  }

  function Prefs(name) {
    this.key = PREFIX + name;
    this.data = readAll(this.key);
  }

  Prefs.prototype.save = function () {
    try { global.sessionStorage.setItem(this.key, JSON.stringify(this.data)); } catch (e) {}
  };

  Prefs.prototype.get = function (k, fallback) {
    return this.data[k] === undefined ? fallback : this.data[k];
  };

  Prefs.prototype.set = function (k, v) {
    this.data[k] = v;
    this.save();
  };

  function byId(id) { return document.getElementById(id); }

  function fire(el, type) {
    var ev;
    try { ev = new Event(type, { bubbles: true }); }
    catch (e) { ev = document.createEvent("Event"); ev.initEvent(type, true, false); }
    el.dispatchEvent(ev);
  }

  /**
   * Text, number and select fields.
   *
   * A restored value is announced with `change`, not `input`: the pages debounce
   * `input` for typing, and there is nothing to wait for when the value arrives
   * all at once.
   */
  Prefs.prototype.fields = function (ids) {
    var self = this;
    ids.forEach(function (id) {
      var el = byId(id);
      if (!el) return;

      var saved = self.get("f:" + id);
      if (saved !== undefined && saved !== null && String(saved) !== "") {
        var before = el.value;
        el.value = saved;
        // A select given a value it has no option for keeps the old one; that
        // is not a restore, and firing change would save the wrong thing back.
        if (el.value !== String(saved)) el.value = before;
        else if (el.value !== before) fire(el, "change");
      }

      var remember = function () { self.set("f:" + id, el.value); };
      el.addEventListener("input", remember);
      el.addEventListener("change", remember);
    });
  };

  /**
   * Switches — the aria-checked buttons.
   *
   * Restored with a click when the stored state differs from the markup's, so
   * the page's own handler does the rest: the take-profit row unhides, the
   * martingale field enables, the status line says what changed.
   */
  Prefs.prototype.switches = function (ids) {
    var self = this;
    ids.forEach(function (id) {
      var el = byId(id);
      if (!el) return;

      var saved = self.get("s:" + id);
      var now = el.getAttribute("aria-checked") === "true";
      if (saved !== undefined && saved !== now) el.click();

      el.addEventListener("click", function () {
        // After the page's own handler, so we store where it landed.
        setTimeout(function () {
          self.set("s:" + id, el.getAttribute("aria-checked") === "true");
        }, 0);
      });
    });
  };

  global.EviePrefs = {
    scope: function (name) { return new Prefs(name); }
  };
})(window);
