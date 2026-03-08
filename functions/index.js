const admin = require("firebase-admin");
const { logger } = require("firebase-functions");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");

admin.initializeApp();
const db = admin.firestore();

const MAX_NOTIFICATION_BODY = 140;

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

    const tokens = Array.from(tokenOwners.keys());
    if (tokens.length === 0) return;

    const preview = buildMessagePreview(message);
    const isGroup = !!chat.isGroup;
    const title = isGroup ? chat.groupName || "Group Chat" : senderName;
    const body = isGroup ? `${senderName}: ${preview}` : preview;

    const response = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: { title, body },
      data: {
        chatId,
        senderId,
        senderName,
        type: "chat_message",
        title,
        body,
        link: "/",
      },
      webpush: {
        headers: {
          Urgency: "high",
          TTL: "2419200",
        },
        notification: {
          icon: "/app-logo.png",
          badge: "/app-logo.png",
          tag: `chat-${chatId}`,
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
