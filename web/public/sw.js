const CACHE_NAME = "aonarr-shell-v2";
// The folder this worker is served from: "/" normally, "/aonarr/" when AoNarr runs under a URL base
// (URL_BASE, see web/url-base.sh). Reading it from the script's own address keeps this file the same either way.
const BASE = new URL("./", self.location).pathname;
const SHELL_FILES = [BASE, BASE + "manifest.json", BASE + "icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// Network-first for everything (this is a live dashboard, not a static site) — cache is only a
// fallback so the app shell still opens offline instead of showing a browser error page.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || event.request.url.includes("/api/")) return;
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request).then((res) => res || caches.match(BASE)))
  );
});

self.addEventListener("push", (event) => {
  if (!event.data) return;
  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: "AoNarr", body: event.data.text() };
  }
  event.waitUntil(
    self.registration.showNotification(payload.title || "AoNarr", {
      body: payload.body || "",
      icon: BASE + "icon.svg",
      badge: BASE + "icon.svg",
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow(BASE));
});
