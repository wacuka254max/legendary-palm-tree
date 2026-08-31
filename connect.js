/**
 * EVIE — the landing page's half of the Deriv connection.
 *
 * Three jobs, in the order they matter:
 *
 *  1. Somebody coming back who is already connected never sees this page argue
 *     with them — they go straight to the dashboard.
 *  2. Somebody returning FROM Deriv arrives here with ?code=…, because this
 *     page is the registered redirect. The code is exchanged, then they go on
 *     to the dashboard with a success flag.
 *  3. Start and Connect both begin the hop to Deriv rather than following
 *     their href — the href is the fallback for a browser with no JS, and the
 *     dashboard bounces an unconnected visitor straight back.
 */

(function () {
  "use strict";

  var D = window.EvieDeriv;
  if (!D) return; // deriv.js missing → the plain hrefs still work

  var HOME = "/home.html";

  function goHome(connected) {
    window.location.replace(connected ? HOME + "?connected=1" : HOME);
  }

  function banner(message, kind) {
    var el = document.createElement("div");
    el.className = "flash flash--" + (kind || "error");
    el.setAttribute("role", "status");
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(function () { el.classList.add("is-in"); }, 20);
    setTimeout(function () {
      el.classList.remove("is-in");
      setTimeout(function () { el.remove(); }, 300);
    }, 6000);
  }

  function busy(on) {
    document.querySelectorAll(".js-connect").forEach(function (b) {
      if (on) {
        b.dataset.label = b.textContent;
        b.textContent = "Connecting…";
        b.setAttribute("aria-disabled", "true");
        b.style.pointerEvents = "none";
      } else {
        if (b.dataset.label) b.textContent = b.dataset.label;
        b.removeAttribute("aria-disabled");
        b.style.pointerEvents = "";
      }
    });
  }

  document.querySelectorAll(".js-connect").forEach(function (btn) {
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      // Already connected? No reason to send them round Deriv again.
      if (D.isConnected()) return goHome(false);
      busy(true);
      D.connect().catch(function () {
        busy(false);
        banner("Could not start the Deriv connection. Please try again.");
      });
    });
  });

  var params = new URLSearchParams(window.location.search);
  var returning = params.has("code") || params.has("error");

  if (returning) {
    busy(true);
    D.handleRedirect().then(function (r) {
      if (r.status === "connected") return goHome(true);
      busy(false);
      if (r.status !== "error") return;

      // A redirect_uri rejection is the one failure the user can actually fix,
      // and Deriv's message never says which URL it received — so say it.
      if (/redirect_uri/i.test(r.message || "")) {
        banner(
          "Deriv rejected the redirect URL. Register this exact URL on the Deriv app: " +
            D.redirectUri()
        );
        console.error("[evie] Deriv redirect_uri sent:", D.redirectUri());
        return;
      }
      banner(r.message || "Connection failed.");
    });
  } else if (D.isConnected()) {
    goHome(false);
  }
})();
