/**
 * EVIE — a service worker that caches nothing.
 *
 * It exists for one reason: Chrome will not offer to install a site that has
 * no service worker with a fetch handler. This is that handler and no more.
 *
 * Caching is deliberately absent. This is a page that shows live prices and
 * places real trades, and a stale shell served from a cache is the one failure
 * that would matter — an old build talking to Deriv with settings the user
 * cannot see. Offline is not a state this site has anything useful to say in,
 * so every request goes to the network exactly as it would without this file.
 */

self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", function () { /* straight to the network */ });
