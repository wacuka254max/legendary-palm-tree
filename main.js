/* Evie — the small amount of behaviour the page needs.
   No dependencies; everything degrades to a working static page. */

(function () {
  "use strict";

  var nav = document.querySelector(".nav");
  var toggle = document.querySelector(".nav-toggle");
  var menu = document.getElementById("mobile-menu");

  /* ── Nav gets a solid background once the hero scrolls under it ── */
  if (nav) {
    var onScroll = function () {
      nav.classList.toggle("is-stuck", window.scrollY > 12);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
  }

  /* ── Mobile menu ── */
  if (toggle && menu) {
    var setOpen = function (open) {
      toggle.setAttribute("aria-expanded", String(open));
      menu.hidden = !open;
    };

    toggle.addEventListener("click", function () {
      setOpen(toggle.getAttribute("aria-expanded") !== "true");
    });

    // Tapping any link closes it, so the anchor jump isn't hidden behind the panel.
    menu.addEventListener("click", function (e) {
      if (e.target.closest("a")) setOpen(false);
    });

    // The menu only exists below 900px — leaving it open through a resize
    // would strand a panel on a desktop layout that has no way to close it.
    window.addEventListener("resize", function () {
      if (window.innerWidth > 900) setOpen(false);
    });
  }

  /* ── Reveal sections as they come into view ── */
  var targets = document.querySelectorAll(
    ".section > .shell > *, .hero-inner > *, .cta-box"
  );

  if (!("IntersectionObserver" in window)) return; // no observer → content stays visible

  Array.prototype.forEach.call(targets, function (el) {
    el.classList.add("reveal");
  });

  var io = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-in");
        io.unobserve(entry.target); // reveal once, never re-hide
      });
    },
    { rootMargin: "0px 0px -12% 0px", threshold: 0.05 }
  );

  Array.prototype.forEach.call(targets, function (el) {
    io.observe(el);
  });
})();
