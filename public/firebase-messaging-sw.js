/* global self, clients */

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data?.json?.() || {};
  } catch {
    payload = {};
  }
  if (payload?.notification?.title || payload?.notification?.body) return;

  const data = payload?.data || {};
  const title = data.title || payload?.notification?.title || "Textinger";
  const body = data.body || payload?.notification?.body || "You have a new message.";
  const link = data.link || "/";
  const icon = data.icon || "/app-logo.png";
  const badge = data.badge || "/app-logo.png";
  const tag = data.tag || "textinger-message";

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon,
      badge,
      tag,
      data: { link },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification?.data?.link || "/";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (typeof client.focus === "function") {
          client.postMessage({ type: "OPEN_CHAT_FROM_NOTIFICATION", link: target });
          return client.focus();
        }
      }
      return clients.openWindow(target);
    }),
  );
});
