/**
 * PIPVANA — the support bubble.
 *
 * Somebody stuck at eleven at night will not compose an email. They will type
 * one line into a box if there is a box. The name and email are remembered
 * across the site, so most people only ever type the message, and what they
 * sent stays on screen afterwards — a form that swallows your words and says
 * "thanks" leaves you unsure anything happened.
 *
 * Every message goes out as it is typed, a one-word "hi" included: it reaches
 * us and is answered like anything else (owner, 16 Nov 2026).
 *
 * It takes screenshots and documents, because "it looks wrong" and a picture of
 * it are two different amounts of help — and a set file or a log is exactly
 * what people get asked for and then have nowhere to put.
 *
 * Replies come back HERE, polled from the server, with the time they arrived, a
 * NEW mark until they are read and a badge on the launcher. Every reply alerts,
 * whether the panel is open or shut: a two-note chime, a short buzz on phones,
 * and the unread count in the tab's title while the page is in the background.
 * Which replies have been read is remembered in this browser, so the badge
 * survives a reload and stands until the panel is actually opened.
 *
 * Hooks for other code on the page:
 *   window.PIPVANA_SUPPORT_SOURCE    — label shown in Telegram for this page
 *   window.PIPVANA_SUPPORT_GREETING  — the first line in the panel
 *   window.PIPVANA_SUPPORT_IDENTITY(name, email)
 *   window.PIPVANA_SUPPORT_ASK({ name, email, text })  — fill, add as sent, open
 *   window.PIPVANA_SUPPORT_ID        — the browser id a code or reply is bound to
 */
(function () {
  "use strict";
  /* The language layer's t() when it is on the page, English otherwise; and a
     {name} filler for the strings built with variables in them. */
  var T = function (s, vars) {
    var out = (typeof window !== "undefined" && typeof window.t === "function") ? window.t(s) : s;
    if (vars) for (var k in vars) out = out.split("{" + k + "}").join(String(vars[k]));
    return out;
  };

  var NAME_KEY = "pipvana_support_name";
  var MAIL_KEY = "pipvana_support_email";
  var ID_KEY = "pipvana_support_id";
  var THREAD_KEY = "pipvana_support_thread";
  /* Which replies have been READ. Unread is derived from the stored thread
     minus these, both of which survive a reload — an event counter did not. */
  var READ_KEY = "pipvana_support_read";

  /* 3MB: the file travels base64 in a JSON body and the server stops reading
     at 4.5MB. Held to formats that are inert when opened. */
  var MAX_BYTES = 3 * 1024 * 1024;
  var OK_IMAGES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
  var OK_DOCS = ["application/pdf", "text/plain", "text/csv", "application/json"];
  var OK_TYPES = OK_IMAGES.concat(OK_DOCS);

  var isEmail = function (v) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v || "").trim()); };
  var get = function (k) { try { return localStorage.getItem(k) || ""; } catch (e) { return ""; } };
  var set = function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} };
  var esc = function (v) {
    return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  };
  var isImage = function (t) { return !!t && String(t).indexOf("image/") === 0; };

  /** Only http(s) is linked, and only in what the owner typed. */
  var URLS = /(https?:\/\/[^\s<>()]+[^\s<>().,;:!?])/g;
  function linkify(text) {
    return esc(text).split(URLS).map(function (part, i) {
      return i % 2 === 1
        ? '<a href="' + part + '" target="_blank" rel="noopener noreferrer" class="sup-link">' + part + "</a>"
        : part;
    }).join("");
  }

  /** Two lines in a reply are drawn differently from the rest: a download
   *  code on a line of its own is green and large, so it is the one thing on
   *  the screen; a line beginning with ⚠ is red and bold, because it is the
   *  one thing they must not miss. Everything else is linkified text. */
  var CODE_LINE = /^[A-Z]{3,4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
  /* A line the server wrote, in the reader's language when the dictionary
     knows its shape; the English otherwise. */
  var TM = function (s) { return (typeof window.tm === "function") ? window.tm(s) : s; };
  function decorate(text) {
    return String(text || "").split("\n").map(function (line) {
      line = TM(line);
      var t = line.trim();
      if (CODE_LINE.test(t)) return '<b class="sup-code">' + esc(t) + "</b>";
      if (t.charAt(0) === "⚠") return '<b class="sup-warn">' + linkify(t) + "</b>";
      return linkify(line);
    }).join("\n");
  }

  /** Local time, short. The date is added only when it is not today. */
  function clockOf(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    var time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    var today = new Date();
    if (d.toDateString() === today.toDateString()) return time;
    var yesterday = new Date(today.getTime() - 86400000);
    if (d.toDateString() === yesterday.toDateString()) return T("Yesterday {time}", { time: time });
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short" }) + " " + time;
  }

  /**
   * The arrival alert, for EVERY reply, panel open or shut (owner, 16 Nov 2026:
   * "if user receives anything on the support widget everything they get a
   * notification sound"): a chime, a short buzz on phones that have one, and the
   * unread count in the tab's title while the page is in the background
   * (paintTitle) — what every messaging app does.
   *
   * The chime: two soft notes a fifth apart, the shape every messaging app uses
   * because it reads as "something for you" and not as an alarm. Built with
   * WebAudio, so nothing to host. Browsers only let a page make a sound once the
   * person has touched it, and iPhones only from inside the touch itself, so ONE
   * sound context is opened on a tap, click or key (only for someone talking to
   * us) and kept for the visit: a reply that arrives minutes later, with no touch
   * at that moment, still rings. A reply that lands before any touch at all (the
   * page just opened) rings at the first one. Every step is guarded — a missing
   * chime is not worth a broken bubble.
   */
  var audio = null, owed = false;
  function notes() {
    var ctx = audio, t0 = ctx.currentTime + 0.03;
    var note = function (freq, at, len) {
      var osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = "sine"; osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + at);
      gain.gain.exponentialRampToValueAtTime(0.3, t0 + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + len);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(t0 + at); osc.stop(t0 + at + len + 0.03);
    };
    note(784, 0, 0.16); note(1175, 0.13, 0.26);
  }
  /* Asleep (a call, the phone locked, a long time in the background): ask it to
     run again; if the browser wants a touch first, the chime waits for it. */
  function wake(then) {
    try {
      var p = audio.resume && audio.resume();
      if (p && p.then) p.then(function () { if (audio.state === "running") then(); else owed = true; }, function () { owed = true; });
      else owed = true;
    } catch (e) { owed = true; }
  }
  function ring() {
    try {
      if (!audio) { owed = true; return; }
      if (audio.state === "running") notes(); else wake(notes);
    } catch (e) {}
  }
  function unlockAudio() {
    try {
      if (audio && audio.state === "running" && !owed) return;
      if (!state.open && !state.thread.length) return;       // only for people talking to us
      if (!audio) {
        var Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        audio = new Ctx();
      }
      if (audio.state !== "running") {
        // iPhones open the sound only from inside a touch: a silent blip does it.
        var blip = audio.createBufferSource();
        blip.buffer = audio.createBuffer(1, 1, 22050);
        blip.connect(audio.destination);
        blip.start(0);
      }
      if (owed) { owed = false; ring(); }
      else if (audio.state !== "running") wake(function () {});
    } catch (e) {}
  }
  ["touchend", "mousedown", "keydown", "click"].forEach(function (ev) {
    document.addEventListener(ev, unlockAudio, true);
  });
  function alertArrival() {
    ring();
    try {
      var ua = navigator.userActivation;
      if (navigator.vibrate && (!ua || ua.hasBeenActive)) navigator.vibrate([90, 60, 90]);
    } catch (e) {}
  }

  var id = get(ID_KEY);
  if (!/^[0-9A-F]{8}$/.test(id)) {
    var b = new Uint8Array(4);
    (window.crypto || {}).getRandomValues ? crypto.getRandomValues(b) : b.forEach(function (_, i) { b[i] = Math.random() * 256; });
    id = Array.prototype.map.call(b, function (x) { return ("0" + x.toString(16)).slice(-2); }).join("").toUpperCase();
    set(ID_KEY, id);
  }

  var state = {
    open: false,
    busy: false,
    editWho: false,
    name: get(NAME_KEY),
    email: get(MAIL_KEY),
    file: null,
    err: null,
    /* What is in the box. Every redraw rebuilds the textarea, so without this
       a failed send — the one time you most want your words back — emptied it. */
    draft: "",
    thread: (function () { try { return JSON.parse(get(THREAD_KEY) || "[]").filter(function (l) { return l && typeof l.text === "string"; }); } catch (e) { return []; } })(),
    read: (function () { try { return JSON.parse(get(READ_KEY) || "[]").filter(function (x) { return typeof x === "string"; }); } catch (e) { return []; } })()
  };

  var CHAT_ICON = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.5 8.5 0 0 1-3.9-.9L3 21l1.9-5A8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5z"/></svg>';
  var CLOSE_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  var CLIP_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>';

  var btn = document.createElement("button");
  btn.className = "sup-btn";
  btn.type = "button";
  btn.setAttribute("aria-label", "Message support");
  btn.setAttribute("aria-expanded", "false");
  btn.innerHTML = CHAT_ICON;
  /* The analysis page keeps its own floating bot launcher and a transactions
     rail down the right, so there the bubble lives on the left. */
  var LEFT = !!document.querySelector(".bot-open, .txn");
  if (LEFT) btn.classList.add("sup-left");
  document.body.appendChild(btn);

  var panel = document.createElement("div");
  panel.className = "sup";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Message support");
  panel.hidden = true;
  if (LEFT) panel.classList.add("sup-left");
  document.body.appendChild(panel);

  /* Everything from us that has not been read. Derived, not counted. */
  function unreadLines() {
    return state.thread.filter(function (l) { return l.from === "us" && !l.system && state.read.indexOf(l.id) < 0; });
  }

  /** Anything on the page can ask for the bubble, and hand it what was just
   *  sent on the page's behalf — a page can, so the person opens
   *  onto the request already in the thread the answer will arrive in. */
  window.PIPVANA_SUPPORT_ASK = function (d) {
    d = d || {};
    if (d.name) { state.name = d.name; set(NAME_KEY, d.name); }
    if (isEmail(d.email)) { state.email = d.email; set(MAIL_KEY, d.email); }
    if (d.text) remember({ id: newId(), text: d.text, at: new Date().toISOString(), from: "them", sent: true });
    toggle(true);
    schedule();
    poll();
  };
  window.PIPVANA_SUPPORT_ID = id;

  /** Details the page already knows beat anything cached here. */
  window.PIPVANA_SUPPORT_IDENTITY = function (name, email) {
    if (name) { state.name = name; set(NAME_KEY, name); }
    if (isEmail(email)) { state.email = email; set(MAIL_KEY, email); }
    if (state.open) draw();
  };
  // A language arriving after the panel was drawn redraws it.
  window.addEventListener("langchange", function () { if (state.open) draw(); paintBadge(); });

  function newId() { return String(Date.now()) + Math.random().toString(16).slice(2); }

  function attachmentHtml(f, bare) {
    if (!f || !f.url) return "";
    if (isImage(f.type)) {
      return '<a href="' + esc(f.url) + '" target="_blank" rel="noopener noreferrer" class="sup-att-img' + (bare ? " bare" : "") + '">' +
        '<img src="' + esc(f.url) + '" alt="' + esc(f.name) + '" /></a>';
    }
    return '<a href="' + esc(f.url) + '" target="_blank" rel="noopener noreferrer" class="sup-att-file' + (bare ? " bare" : "") + '">' +
      CLIP_ICON + '<span>' + esc(f.name) + "</span></a>";
  }

  function draw() {
    var needsWho = state.editWho || !isEmail(state.email) || !state.name.trim();

    panel.innerHTML =
      '<div class="sup-head">' +
        '<span class="sup-avatar">' +
          '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.5 8.5 0 0 1-3.9-.9L3 21l1.9-5A8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5z"/></svg>' +
        "</span>" +
        '<div class="sup-title"><div class="sup-title-main">Talk to us</div>' +
        '<div class="sup-title-sub"><i></i>Usually answered within a day</div></div>' +
        '<button type="button" id="supClose" class="sup-close" aria-label="Close support">' +
          '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>' +
        "</button>" +
      "</div>" +

      '<div class="sup-body" id="supBody">' +
        '<div class="sup-msg">' + esc(T("Hi{name} — {greeting} The answer comes back here.", {
          name: state.name ? " " + state.name.split(" ")[0] : "",
          greeting: T(window.PIPVANA_SUPPORT_GREETING || "ask us anything about the bots, the analysis tools or your account. Tell us what happened and what you expected, and add a screenshot if you have one."),
        })) + "</div>" +
        state.thread.map(function (l) {
          if (l.from === "us") {
            if (l.system) return '<div class="sup-msg">' + esc(l.text) + "</div>";
            var hasText = String(l.text || "").trim().length > 0;
            var fresh = state.read.indexOf(l.id) < 0;
            /* Marked on the reply itself, not only on the launcher: opening a
               conversation you have read before, you still need to see WHICH
               message is new. A picture-only reply has no text element and no
               padding held open for one — that was the "tiny empty card". */
            return '<div class="sup-reply">' +
              '<div class="sup-reply-who"><i></i>Pipvana support' +
                (fresh ? '<span class="sup-new">NEW</span>' : "") +
                (l.at ? '<span class="sup-time">' + esc(clockOf(l.at)) + "</span>" : "") +
              "</div>" +
              '<div class="sup-reply-body' + (hasText ? "" : " bare") + '">' +
                (hasText ? decorate(l.text) : "") + attachmentHtml(l.file, !hasText) +
              "</div></div>";
          }
          return '<div><div class="sup-mine">' + esc(l.text) +
            (l.shot ? '<span class="sup-shot">' + CLIP_ICON + " " + esc(l.shot) + "</span>" : "") + "</div>" +
            (l.sent === false ? "" : '<div class="sup-sent">✓ Sent' + (l.at ? ' <span class="sup-time-mine">· ' + esc(clockOf(l.at)) + "</span>" : "") + "</div>") + "</div>";
        }).join("") +
      "</div>" +

      '<div class="sup-who">' +
        (needsWho
          ? '<div class="sup-who-row">' +
              '<div class="sup-who-hint">' +
                (state.editWho ? "Change these, then tap Done." : "Fill these in first so we can reply — then type what you need below.") +
              "</div>" +
              (state.editWho && isEmail(state.email) && state.name.trim()
                ? '<button type="button" id="supDone" class="sup-done">Done</button>' : "") +
            "</div>" +
            '<input class="field" id="supName" placeholder="Your name" value="' + esc(state.name) + '" />' +
            '<input class="field" id="supMail" type="email" placeholder="Your email for the reply" value="' + esc(state.email) + '" />'
          : '<button type="button" id="supChange" class="sup-change">' +
            '<span class="mono">' + esc(state.email) + "</span>" +
            '<span class="sup-change-cta">Change</span></button>') +
      "</div>" +

      (state.err ? '<div class="sup-err">' + esc(TM(state.err)) + "</div>" : "") +
      (state.file
        ? '<div class="sup-picked">' + CLIP_ICON + '<span>' + esc(state.file.name) + "</span>" +
          '<button type="button" id="supUnpick" aria-label="Remove attachment">&times;</button></div>'
        : "") +

      '<div class="sup-foot">' +
        '<input type="file" id="supFile" accept="' + OK_TYPES.join(",") + '" hidden />' +
        '<button type="button" class="sup-attach" id="supAttach" aria-label="Attach a screenshot or document" title="Screenshot or document">' + CLIP_ICON + "</button>" +
        '<textarea class="field" id="supText" rows="1" placeholder="Type what you need…" aria-label="Your message"></textarea>' +
        '<button type="button" class="sup-send" id="supSend" aria-label="Send">' +
          '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4z"/></svg>' +
        "</button>" +
      "</div>";

    var body = panel.querySelector("#supBody");
    body.scrollTop = body.scrollHeight;
    // A picture grows the thread after it is drawn; stay at the bottom.
    Array.prototype.forEach.call(body.querySelectorAll("img"), function (im) {
      im.addEventListener("load", function () { body.scrollTop = body.scrollHeight; });
    });

    panel.querySelector("#supClose").onclick = function () { toggle(false); };

    var change = panel.querySelector("#supChange");
    if (change) change.onclick = function () { state.editWho = true; draw(); };

    var done = panel.querySelector("#supDone");
    if (done) done.onclick = function () {
      set(NAME_KEY, state.name.trim());
      set(MAIL_KEY, state.email.trim());
      state.editWho = false;
      draw();
    };
    var nameEl = panel.querySelector("#supName"), mailEl = panel.querySelector("#supMail");
    if (nameEl) nameEl.oninput = function () { state.name = nameEl.value; };
    if (mailEl) mailEl.oninput = function () { state.email = mailEl.value; };

    var fileEl = panel.querySelector("#supFile");
    panel.querySelector("#supAttach").onclick = function () { fileEl.click(); };
    fileEl.onchange = function () { pick(fileEl.files && fileEl.files[0]); };
    var unpick = panel.querySelector("#supUnpick");
    if (unpick) unpick.onclick = function () { pick(null); };

    var box = panel.querySelector("#supText");
    box.value = state.draft;
    box.oninput = function () { state.draft = box.value; };
    box.onkeydown = function (e) {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
    };
    // Most screenshots arrive on the clipboard, not as a saved file.
    box.onpaste = function (e) {
      var files = Array.prototype.slice.call((e.clipboardData && e.clipboardData.files) || []);
      var f = files.filter(function (x) { return OK_TYPES.indexOf(x.type) >= 0; })[0];
      if (f) { e.preventDefault(); pick(f); }
    };
    panel.querySelector("#supSend").onclick = send;
    setTimeout(function () { box.focus(); }, 60);
  }

  function pick(f) {
    state.err = null;
    if (!f) { state.file = null; draw(); return; }
    if (OK_TYPES.indexOf(f.type) < 0) { state.err = "Send a screenshot (PNG, JPG, WEBP, GIF) or a document (PDF, TXT, CSV, JSON)."; draw(); return; }
    if (f.size > MAX_BYTES) { state.err = "That file is too large — keep it under 3MB."; draw(); return; }
    state.file = f;
    draw();
  }

  function remember(line) {
    if (!line.id) line.id = newId();
    if (!line.at) line.at = new Date().toISOString();
    state.thread = state.thread.concat([line]).slice(-30);
    set(THREAD_KEY, JSON.stringify(state.thread));
  }

  /* Merge server replies over what is stored, matching on id. Not an append:
     the same reply may already be here from an earlier poll — possibly saved
     by an older version of this widget that kept only the text. Patching by id
     repairs those lines instead of showing them twice. */
  function mergeReplies(reps) {
    if (!reps || !reps.length) return;
    var next = state.thread.slice();
    reps.forEach(function (rep) {
      var line = { id: rep.id, text: rep.body, at: rep.createdAt, from: "us", file: rep.attachment || null };
      var at = -1;
      for (var i = 0; i < next.length; i++) if (next[i].id === rep.id) { at = i; break; }
      if (at >= 0) next[at] = Object.assign({}, next[at], line); else next.push(line);
    });
    next.sort(function (a, b) { return String(a.at || "").localeCompare(String(b.at || "")); });
    state.thread = next.slice(-30);
    set(THREAD_KEY, JSON.stringify(state.thread));
    // Anything else on the page that waits for our answer — the EA sheet does.
    try { window.dispatchEvent(new CustomEvent("pipvana:support-reply")); } catch (e) {}
  }

  function markRead() {
    var ids = state.thread.filter(function (l) { return l.from === "us" && !l.system; }).map(function (l) { return l.id; });
    var merged = state.read.slice();
    ids.forEach(function (i) { if (merged.indexOf(i) < 0) merged.push(i); });
    state.read = merged.slice(-80);
    set(READ_KEY, JSON.stringify(state.read));
  }

  function readFileAsBase64(f) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result).split(",")[1] || ""); };
      r.onerror = function () { reject(new Error("read failed")); };
      r.readAsDataURL(f);
    });
  }

  function send() {
    if (state.busy) return;

    var box = panel.querySelector("#supText");
    var message = (box.value || "").trim();
    if (!message && !state.file) return;

    var nameEl = panel.querySelector("#supName");
    var mailEl = panel.querySelector("#supMail");
    if (nameEl) state.name = nameEl.value.trim();
    if (mailEl) state.email = mailEl.value.trim();

    if (!state.name) { state.err = "Add your name so we know who we are replying to."; draw(); return; }
    if (!isEmail(state.email)) { state.err = "Add the email we should reply to."; draw(); return; }

    set(NAME_KEY, state.name);
    set(MAIL_KEY, state.email);

    state.busy = true; state.err = null;
    var file = state.file;
    var shot = file ? file.name : null;

    (file ? readFileAsBase64(file) : Promise.resolve(null)).then(function (data) {
      return fetch("/api/support", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: state.name, email: state.email, message: message,
          source: window.PIPVANA_SUPPORT_SOURCE || "Pipvana",
          visitorId: id, page: location.pathname,
          file: file ? { name: file.name, type: file.type, data: data } : undefined
        })
      });
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, d: d }; });
    }).then(function (r) {
      state.busy = false;
      if (!r.ok) { state.err = r.d.error || "We could not send that just now."; draw(); return; }
      remember({ text: message || "(attachment)", from: "them", sent: true, shot: shot });
      state.draft = "";
      state.file = null;
      state.editWho = false;
      draw();
      schedule();
    }).catch(function () {
      state.busy = false;
      state.err = "We could not reach you just now. Try again in a minute.";
      draw();
    });
  }

  /* While the page is in the background, the tab's title carries the count of
     unread replies — the "(1)" every messaging site shows — so a reply is seen
     from another tab. Back on the page, the title is the page's own again. The
     language layer keeps the page's own title to translate from
     (document.__origTitle); it never keeps ours. */
  var TITLE_MARK = /^\(\d+\+?\) /;
  function paintTitle(n) {
    try {
      if (document.__origTitle) document.__origTitle = String(document.__origTitle).replace(TITLE_MARK, "");
      var bare = document.title.replace(TITLE_MARK, "");
      var want = document.hidden && n > 0 ? "(" + (n > 9 ? "9+" : n) + ") " + bare : bare;
      if (document.title !== want) document.title = want;
    } catch (e) {}
  }

  function paintBadge() {
    var old = btn.querySelector(".sup-badge");
    if (old) old.remove();
    var n = unreadLines().length;
    paintTitle(n);
    if (state.open || !n) return;
    var b = document.createElement("span");
    b.className = "sup-badge";
    b.setAttribute("aria-label", T(n === 1 ? "{n} new reply" : "{n} new replies", { n: n }));
    /* A ring that fades outward: the badge alone is easy to miss on a page
       somebody is reading. */
    b.innerHTML = (n > 9 ? "9+" : String(n)) + '<i class="sup-ping" aria-hidden="true"></i>';
    btn.appendChild(b);
  }

  function toggle(open) {
    state.open = open === undefined ? !state.open : open;
    panel.hidden = !state.open;
    btn.setAttribute("aria-label", state.open ? "Close support" : "Message support");
    btn.setAttribute("aria-expanded", state.open ? "true" : "false");
    btn.innerHTML = state.open ? CLOSE_ICON : CHAT_ICON;
    if (state.open) {
      draw();
      // Opening it is reading them — but only after the draw, so the NEW marks
      // are visible for this one look.
      markRead();
      paintBadge();
      refetchRecent();
    } else {
      paintBadge();
      btn.focus();
    }
  }

  /* Opening the bubble re-asks for the recent replies, marking nothing. It is
     the only way a browser recovers from having stored a reply in an older
     shape — the row is already marked seen, so the ordinary poll never offers
     it again — and it refills the thread on a device that cleared storage. */
  function refetchRecent() {
    fetch("/api/support-replies?visitorId=" + encodeURIComponent(id) + "&recent=1", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        var reps = (d && d.replies) || [];
        if (!reps.length) return;
        var before = JSON.stringify(state.thread);
        mergeReplies(reps);
        if (JSON.stringify(state.thread) !== before && state.open) { draw(); markRead(); }
      })
      .catch(function () { /* offline — the poll will catch up */ });
  }

  /**
   * Collect anything the owner has replied. Polled rather than pushed: a
   * websocket for a bubble that is open for two minutes at a time is not worth
   * the moving parts. 7s open, 20s shut — most of a minute before a reply
   * showed did not feel like support. Only runs once they have asked something.
   */
  var polling = null;

  function poll() {
    if (!state.thread.length) return;
    fetch("/api/support-replies?visitorId=" + encodeURIComponent(id), { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        var fresh = (d && d.replies) || [];
        if (!fresh.length) return;
        /* An arrival is a reply this browser did not have yet. One already here
           (from the look on opening, or an old line being repaired) is not, so
           nothing rings twice for the same reply. */
        var had = {};
        state.thread.forEach(function (l) { if (l.from === "us" && l.id) had[l.id] = 1; });
        var arrived = fresh.filter(function (r) { return r && r.id && r.from !== "them" && !had[r.id]; }).length;
        mergeReplies(fresh);
        if (state.open) {
          draw();
          /* Read once it can be seen: with the page in the background it stays
             new, and counted in the tab's title, until they come back to it. */
          if (!document.hidden) markRead();
        }
        paintBadge();
        if (arrived) alertArrival();
      })
      .catch(function () { /* offline, or the tab is asleep — try again next tick */ });
  }

  function schedule() {
    if (polling) clearInterval(polling);
    polling = setInterval(poll, state.open ? 7000 : 20000);
  }

  btn.onclick = function () { toggle(); schedule(); poll(); };

  // A reply may have landed while they were away, so look once on arrival and
  // then keep a heartbeat going. The badge is drawn from storage straight away.
  paintBadge();
  if (state.thread.length) { poll(); }
  schedule();

  /* Leaving the page puts the unread count in the tab's title; coming back
     takes it off, and with the panel open what arrived meanwhile is read now. */
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && state.open) markRead();
    paintBadge();
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && state.open) toggle(false);
  });
})();
