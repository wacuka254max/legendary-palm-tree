/**
 * UPTICK — practice mode.
 *
 * A mode the dashboard does not advertise. Three clicks on the "o" of Home
 * open a bare field; the right phrase turns the mode on and is remembered on
 * that device for good. From then on the same three clicks toggle it, and the
 * only thing the screen ever says about it is a one-second flash on the word
 * Home.
 *
 * ── Where the state lives ───────────────────────────────────────────────────
 *
 * localStorage, not sessionStorage. The rule is that switching it on survives a
 * refresh, a closed tab and a closed browser — the only way out is the same
 * three clicks that let you in. sessionStorage would have quietly dropped it on
 * every tab close, which is the one behaviour explicitly not wanted.
 *
 * There is no server and no sync. A second device is a second first time: the
 * phrase is entered once there too, and then that device remembers as well. The
 * Deriv account ids that unlocked here are recorded alongside, so the record
 * says who did it and not only that somebody did.
 *
 * ── On the phrase check ─────────────────────────────────────────────────────
 *
 * The phrase is compared as a hash so it is not sitting in the bundle as a
 * readable word. Be clear about what that is worth: this runs in the browser,
 * so anyone who opens devtools and reads this file can work out how it is
 * checked. It keeps the door shut against somebody idly poking at the page. It
 * is NOT security, and nothing behind it is treated as if it were — practice
 * mode only ever swaps which page a tile opens.
 *
 * ── The naming ──────────────────────────────────────────────────────────────
 *
 * No identifier, key or string in this file says what the mode is for. That is
 * deliberate: the storage keys read like interface preferences because a
 * curious person's first move is to open Application → Local Storage.
 */

(function (global) {
  "use strict";

  var K_KNOWN = "evie_ui_k";  // this device has passed the phrase, once, ever
  var K_ON = "evie_ui_m";     // the mode is currently on
  var K_WHO = "evie_ui_a";    // the Deriv account ids that unlocked it here

  /* djb2. Small, synchronous and dependency-free — the page must decide in the
     same tick as the keypress, and a crypto digest is a promise. */
  var PHRASE = 2088338501;

  function hash(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h;
  }

  function get(k) {
    try { return localStorage.getItem(k); } catch (e) { return null; }
  }
  function put(k, v) {
    try { localStorage.setItem(k, v); } catch (e) {}
  }
  function drop(k) {
    try { localStorage.removeItem(k); } catch (e) {}
  }

  /** Has this device ever been let in? */
  function known() {
    return get(K_KNOWN) === "1";
  }

  /** Is the mode on right now? Only true on a device that has been let in — a
   *  stale flag on its own must never be enough. */
  function on() {
    return known() && get(K_ON) === "1";
  }

  function set(v) {
    if (v && !known()) return false;      // cannot switch on what was never opened
    if (v) put(K_ON, "1"); else drop(K_ON);
    return true;
  }

  /**
   * Try a phrase. Right one: this device is remembered from now on and the mode
   * comes on with it — somebody who has just typed it wants it on, and making
   * them click again would be a second lock on the same door.
   *
   * Wrong one: false, and nothing else. No message, no shake, no count. The
   * field gives away nothing about whether it is even the right field.
   */
  function attempt(text) {
    if (hash(String(text || "")) !== PHRASE) return false;
    put(K_KNOWN, "1");
    put(K_ON, "1");
    return true;
  }

  /** Record which Deriv accounts were connected when this device was opened. */
  function note(ids) {
    if (!known() || !ids || !ids.length) return;
    var seen = [];
    try { seen = JSON.parse(get(K_WHO) || "[]") || []; } catch (e) { seen = []; }
    ids.forEach(function (id) {
      if (id && seen.indexOf(id) === -1) seen.push(id);
    });
    put(K_WHO, JSON.stringify(seen));
  }

  /**
   * The whole of the feedback: a one-second flash on the word, and a buzz on a
   * phone that offers one.
   *
   * Both, not either. Vibration is ignored outright on desktop and on iOS, so a
   * device-only signal would leave most people pressing three times and seeing
   * nothing happen at all. The flash is the one that always lands.
   */
  function signal(el) {
    try { if (global.navigator && navigator.vibrate) navigator.vibrate(1000); } catch (e) {}
    if (!el) return;
    el.classList.remove("lit");
    void el.offsetWidth;               // restart the animation on a repeat press
    el.classList.add("lit");
    global.setTimeout(function () { el.classList.remove("lit"); }, 1000);
  }

  global.EvieMode = {
    known: known,
    on: on,
    set: set,
    attempt: attempt,
    note: note,
    signal: signal
  };
})(window);
