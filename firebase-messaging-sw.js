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
  const { title, body } = payload.data || {};
  self.registration.showNotification(title || "Bandinha", {
    body: body || "",
    icon: "header.png"
  });
});
