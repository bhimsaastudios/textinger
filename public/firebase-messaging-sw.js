/* global importScripts, firebase */
importScripts("https://www.gstatic.com/firebasejs/10.13.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.13.2/firebase-messaging-compat.js");

const params = new URLSearchParams(self.location.search);
const firebaseConfig = {
  apiKey: params.get("apiKey") || "",
  authDomain: params.get("authDomain") || "",
  projectId: params.get("projectId") || "",
  storageBucket: params.get("storageBucket") || "",
  messagingSenderId: params.get("messagingSenderId") || "",
  appId: params.get("appId") || "",
};

if (firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.messagingSenderId && firebaseConfig.appId) {
  firebase.initializeApp(firebaseConfig);
  const messaging = firebase.messaging();

  messaging.onBackgroundMessage((payload) => {
    const title = payload?.notification?.title || "Textinger";
    const options = {
      body: payload?.notification?.body || "You have a new message.",
      icon: "/app-logo.png",
      data: {
        link: payload?.fcmOptions?.link || payload?.data?.link || "/",
      },
    };
    self.registration.showNotification(title, options);
  });
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification?.data?.link || "/";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        const hasClientFocus = typeof client.focus === "function";
        if (hasClientFocus) {
          client.postMessage({ type: "OPEN_CHAT_FROM_NOTIFICATION", link: target });
          return client.focus();
        }
      }
      return clients.openWindow(target);
    }),
  );
});

self.addEventListener("push", (event) => {
  try {
    const payload = event.data?.json?.() || {};
    if (payload?.notification?.title || payload?.notification?.body) return;
    const title = payload?.data?.title || "Textinger";
    const body = payload?.data?.body || "You have a new message.";
    const link = payload?.data?.link || "/";
    event.waitUntil(
      self.registration.showNotification(title, {
        body,
        icon: "/app-logo.png",
        data: { link },
      }),
    );
  } catch {
    // no-op
  }
});
