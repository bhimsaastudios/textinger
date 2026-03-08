const admin = require("firebase-admin");
const { logger } = require("firebase-functions");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");

admin.initializeApp();
const db = admin.firestore();

const MAX_NOTIFICATION_BODY = 140;
const ONE_SIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID || "";
const ONE_SIGNAL_API_KEY = process.env.ONESIGNAL_REST_API_KEY || "";

function buildMessagePreview(message) {
  const text = (message.text || "").trim();
  if (text) {
    return text.length > MAX_NOTIFICATION_BODY
      ? `${text.slice(0, MAX_NOTIFICATION_BODY - 1)}...`
      : text;
  }

  const mediaType = (message.mediaType || "").toLowerCase();
  if (mediaType.startsWith("image/")) return "sent a photo";
  if (mediaType.startsWith("video/")) return "sent a video";
  if (mediaType.startsWith("audio/")) return "sent an audio";
  if (message.mediaURL) return "sent a file";
  return "sent a message";
}

function isInvalidFcmTokenError(code) {
  return (
    code === "messaging/invalid-registration-token" ||
    code === "messaging/registration-token-not-registered"
  );
}

async function sendOneSignalPush({ recipientIds, title, body, chatId, senderId, senderName }) {
  if (!ONE_SIGNAL_APP_ID || !ONE_SIGNAL_API_KEY) return false;
  if (!Array.isArray(recipientIds) || recipientIds.length === 0) return false;

  const response = await fetch("https://api.onesignal.com/notifications?c=push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Key ${ONE_SIGNAL_API_KEY}`,
    },
    body: JSON.stringify({
      app_id: ONE_SIGNAL_APP_ID,
      include_aliases: { external_id: recipientIds },
      target_channel: "push",
      headings: { en: title },
      contents: { en: body },
      data: {
        chatId,
        senderId,
        senderName,
        link: "/",
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    logger.error("OneSignal push failed.", { status: response.status, errorText });
    return false;
  }

  const payload = await response.json().catch(() => ({}));
  const recipients = Number(payload?.recipients || 0);
  if (recipients <= 0) {
    logger.warn("OneSignal accepted request but delivered to 0 recipients.", { payload });
    return false;
  }
  return true;
}

exports.sendPushOnNewMessage = onDocumentCreated(
  {
    document: "chats/{chatId}/messages/{messageId}",
    region: "us-central1",
  },
  async (event) => {
    const snap = event.data;
    if (!snap) return;

    const message = snap.data() || {};
    const chatId = event.params.chatId;
    const senderId = message.senderId || "";
    const senderName = (message.senderName || "Someone").trim() || "Someone";

    const chatRef = db.collection("chats").doc(chatId);
    const chatSnap = await chatRef.get();
    if (!chatSnap.exists) return;

    const chat = chatSnap.data() || {};
    const members = Array.isArray(chat.members) ? chat.members : [];
    const recipientIds = members.filter((uid) => uid && uid !== senderId);
    if (recipientIds.length === 0) return;

    const userRefs = recipientIds.map((uid) => db.collection("users").doc(uid));
    const userSnaps = await db.getAll(...userRefs);

    const tokenOwners = new Map();
    for (const userSnap of userSnaps) {
      if (!userSnap.exists) continue;
      const tokens = Array.isArray(userSnap.data()?.fcmTokens) ? userSnap.data().fcmTokens : [];
      for (const token of tokens) {
        if (typeof token !== "string" || !token.trim()) continue;
        const normalized = token.trim();
        if (!tokenOwners.has(normalized)) tokenOwners.set(normalized, new Set());
        tokenOwners.get(normalized).add(userSnap.id);
      }
    }

    const preview = buildMessagePreview(message);
    const isGroup = !!chat.isGroup;
    const title = isGroup ? chat.groupName || "Group Chat" : senderName;
    const body = isGroup ? `${senderName}: ${preview}` : preview;

    const oneSignalSent = await sendOneSignalPush({
      recipientIds,
      title,
      body,
      chatId,
      senderId,
      senderName,
    });
    if (oneSignalSent) {
      logger.info("OneSignal push sent.", {
        chatId,
        recipients: recipientIds.length,
      });
      return;
    }

    const tokens = Array.from(tokenOwners.keys());
    if (tokens.length === 0) {
      logger.warn("No valid FCM tokens and OneSignal push not delivered.", {
        chatId,
        recipients: recipientIds.length,
      });
      return;
    }

    const response = await admin.messaging().sendEachForMulticast({
      tokens,
      data: {
        chatId,
        senderId,
        senderName,
        type: "chat_message",
        title,
        body,
        link: "/",
        icon: "/app-logo.png",
        badge: "/app-logo.png",
        tag: `chat-${chatId}`,
      },
      webpush: {
        headers: {
          Urgency: "high",
          TTL: "2419200",
        },
        fcmOptions: {
          link: "/",
        },
      },
    });

    const invalidTokens = [];
    response.responses.forEach((res, index) => {
      if (!res.success && isInvalidFcmTokenError(res.error?.code)) {
        invalidTokens.push(tokens[index]);
      }
    });

    if (invalidTokens.length > 0) {
      const removalsByUser = new Map();
      for (const token of invalidTokens) {
        const owners = tokenOwners.get(token);
        if (!owners) continue;
        for (const uid of owners) {
          if (!removalsByUser.has(uid)) removalsByUser.set(uid, []);
          removalsByUser.get(uid).push(token);
        }
      }

      const batch = db.batch();
      for (const [uid, userTokens] of removalsByUser.entries()) {
        batch.update(db.collection("users").doc(uid), {
          fcmTokens: admin.firestore.FieldValue.arrayRemove(...userTokens),
        });
      }
      await batch.commit();
    }

    logger.info("Push notifications processed.", {
      chatId,
      sentTo: tokens.length,
      successCount: response.successCount,
      failureCount: response.failureCount,
      invalidTokensRemoved: invalidTokens.length,
    });
  },
);
