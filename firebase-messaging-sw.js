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
