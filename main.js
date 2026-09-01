/* Evie — the small amount of behaviour the page needs.
   No dependencies; everything degrades to a working static page. */

(function () {
  "use strict";

  var nav = document.querySelector(".nav");

  /* ── Nav gets a solid background once the hero scrolls under it ── */
  if (nav) {
    var onScroll = function () {
      nav.classList.toggle("is-stuck", window.scrollY > 12);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
  }

  /* ── Reveal sections as they come into view ── */
  var targets = document.querySelectorAll(".hero-inner > *");

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
