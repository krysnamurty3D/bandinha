importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyDU22nU2MOfb-3Z9xBHYVxrXtFDaG5_93g",
  authDomain: "bandinha-a22ce.firebaseapp.com",
  projectId: "bandinha-a22ce",
  storageBucket: "bandinha-a22ce.firebasestorage.app",
  messagingSenderId: "808882413270",
  appId: "1:808882413270:web:91dbb55bc2256847ae3377"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage(payload => {
  const { title, body, url } = payload.data || {};
  self.registration.showNotification(title || "Bandinha", {
    body: body || "",
    icon: "header.png",
    data: { url: url || "publico.html" }
  });
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const url = event.notification.data?.url || "publico.html";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if ("focus" in client) {
          client.postMessage({ type: "goto", url });
          return client.focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});

const CACHE_NAME = "bandinha-shell-v1";
const APP_SHELL = ["publico.html", "manifest.json", "header.png"];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(names => Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === "navigate" || APP_SHELL.some(p => url.pathname.endsWith(p))) {
    event.respondWith(
      fetch(req)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
          return res;
        })
        .catch(() => caches.match(req).then(cached => cached || caches.match("publico.html")))
    );
  }
});
