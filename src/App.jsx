import { useEffect, useMemo, useRef, useState } from "react";
import {
  createUserWithEmailAndPassword,
  deleteUser,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
} from "firebase/auth";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getCountFromServer,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import { auth, db } from "./firebase";

const MAX_ACTIVE_USERS = 150;
const MAX_TOTAL_USERS = 500;
const ACTIVE_WINDOW_MS = 2 * 60 * 1000;
const MOBILE_BREAKPOINT = 860;
const MAX_UPLOAD_BYTES = 7 * 1024 * 1024;
const MESSAGE_RATE_LIMIT = 3;
const MESSAGE_RATE_WINDOW_MS = 1000;

function formatTime(value) {
  if (!value) return "";
  try {
    const date = value.toDate ? value.toDate() : new Date(value);
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function buildChatId(uidA, uidB) {
  return [uidA, uidB].sort().join("_");
}

function initials(name) {
  if (!name) return "?";
  return name
    .split(" ")
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

function toMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function isUserOnline(user) {
  if (!user?.isOnline) return false;
  return toMillis(user.lastActiveAt) >= Date.now() - ACTIVE_WINDOW_MS;
}

function Avatar({ name, photoURL, className = "avatar", isOnline = false, showOnlineDot = false }) {
  return (
    <span className="avatarWrap">
      {photoURL ? (
        <img src={photoURL} alt={name || "User"} className={`${className} avatarImage`} />
      ) : (
        <span className={className}>{initials(name)}</span>
      )}
      {showOnlineDot && isOnline ? <span className="onlineDot" aria-label="Online" /> : null}
    </span>
  );
}

async function uploadMediaToCloudinary(file) {
  const cloudName = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME;
  const uploadPreset = import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET;

  if (!cloudName || !uploadPreset) {
    throw new Error("Cloudinary is not configured. Add VITE_CLOUDINARY_CLOUD_NAME and VITE_CLOUDINARY_UPLOAD_PRESET.");
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error("File size exceeds 7MB limit.");
  }

  let resourceType = "raw";
  if (file?.type?.startsWith("image/")) resourceType = "image";
  if (file?.type?.startsWith("video/")) resourceType = "video";

  const endpoint = `https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/upload`;
  const formData = new FormData();
  formData.append("file", file);
  formData.append("upload_preset", uploadPreset);
  formData.append("folder", "textinger-chat-media");

  const response = await fetch(endpoint, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    throw new Error("Cloudinary upload failed.");
  }

  const data = await response.json();
  return data.secure_url || data.url || "";
}

async function uploadAvatarToCloudinary(file, userId) {
  const cloudName = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME;
  const uploadPreset = import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET;

  if (!cloudName || !uploadPreset) {
    throw new Error("Cloudinary is not configured. Add VITE_CLOUDINARY_CLOUD_NAME and VITE_CLOUDINARY_UPLOAD_PRESET.");
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error("Profile image size exceeds 7MB limit.");
  }

  const endpoint = `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`;
  const formData = new FormData();
  formData.append("file", file);
  formData.append("upload_preset", uploadPreset);
  formData.append("folder", `textinger-avatars/${userId}`);

  const response = await fetch(endpoint, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    throw new Error("Cloudinary avatar upload failed.");
  }

  const data = await response.json();
  return data.secure_url || data.url || "";
}

async function uploadGroupImageToCloudinary(file, userId) {
  const cloudName = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME;
  const uploadPreset = import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET;

  if (!cloudName || !uploadPreset) {
    throw new Error("Cloudinary is not configured. Add VITE_CLOUDINARY_CLOUD_NAME and VITE_CLOUDINARY_UPLOAD_PRESET.");
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error("Group photo size exceeds 7MB limit.");
  }

  const endpoint = `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`;
  const formData = new FormData();
  formData.append("file", file);
  formData.append("upload_preset", uploadPreset);
  formData.append("folder", `textinger-groups/${userId}`);

  const response = await fetch(endpoint, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    throw new Error("Cloudinary group image upload failed.");
  }

  const data = await response.json();
  return data.secure_url || data.url || "";
}

export default function App() {
  const [showSplash, setShowSplash] = useState(() => {
    if (typeof window === "undefined") return false;
    return sessionStorage.getItem("textinger_splash_seen") !== "1";
  });

  const [authMode, setAuthMode] = useState("login");
  const [authForm, setAuthForm] = useState({ email: "", password: "", username: "" });
  const [authError, setAuthError] = useState("");
  const [capacityError, setCapacityError] = useState("");
  const [currentUser, setCurrentUser] = useState(null);
  const [userProfile, setUserProfile] = useState(null);

  const [users, setUsers] = useState([]);
  const [chats, setChats] = useState([]);
  const [selectedChatId, setSelectedChatId] = useState("");
  const [requests, setRequests] = useState([]);
  const [messages, setMessages] = useState([]);
  const [typingStreams, setTypingStreams] = useState([]);
  const [savedMessages, setSavedMessages] = useState([]);
  const [unreadChatIds, setUnreadChatIds] = useState([]);

  const [text, setText] = useState("");
  const [mediaFile, setMediaFile] = useState(null);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [busyLabel, setBusyLabel] = useState("");
  const [authReady, setAuthReady] = useState(false);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [previewImage, setPreviewImage] = useState("");
  const [previewZoom, setPreviewZoom] = useState(1);
  const [editingMessageId, setEditingMessageId] = useState("");
  const [editingText, setEditingText] = useState("");
  const [openMessageMenuId, setOpenMessageMenuId] = useState("");
  const [friendEmail, setFriendEmail] = useState("");
  const [friendStatus, setFriendStatus] = useState("");
  const [profileStatus, setProfileStatus] = useState("");
  const [profileNameDraft, setProfileNameDraft] = useState("");
  const [profileBioDraft, setProfileBioDraft] = useState("");

  const [showAddFriend, setShowAddFriend] = useState(false);
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [showEditProfile, setShowEditProfile] = useState(false);
  const [showSavedContent, setShowSavedContent] = useState(false);
  const [showUserProfileView, setShowUserProfileView] = useState(false);
  const [showEventScheduler, setShowEventScheduler] = useState(false);
  const [eventTitleDraft, setEventTitleDraft] = useState("");
  const [eventDescriptionDraft, setEventDescriptionDraft] = useState("");
  const [eventTimeDraft, setEventTimeDraft] = useState("");
  const [eventStatus, setEventStatus] = useState("");
  const [eventPulseChatIds, setEventPulseChatIds] = useState([]);
  const [eventToast, setEventToast] = useState(null);
  const [activeEventDisplay, setActiveEventDisplay] = useState(null);
  const [viewedUserId, setViewedUserId] = useState("");
  const [groupStep, setGroupStep] = useState("select");
  const [selectedGroupMemberIds, setSelectedGroupMemberIds] = useState([]);
  const [groupNameDraft, setGroupNameDraft] = useState("");
  const [groupPhotoFile, setGroupPhotoFile] = useState(null);
  const [groupStatus, setGroupStatus] = useState("");
  const [savedStatus, setSavedStatus] = useState("");
  const [composerStatus, setComposerStatus] = useState("");
  const [showSpamWarning, setShowSpamWarning] = useState(false);
  const [isMobileLayout, setIsMobileLayout] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.innerWidth <= MOBILE_BREAKPOINT;
  });
  const [mobileScreen, setMobileScreen] = useState("list");
  const [notificationPermission, setNotificationPermission] = useState(() => {
    if (typeof Notification === "undefined") return "unsupported";
    return Notification.permission;
  });
  const mediaInputRef = useRef(null);
  const documentInputRef = useRef(null);
  const typingTextRef = useRef("");
  const chatsInitRef = useRef(false);
  const chatMetaRef = useRef(new Map());
  const requestsInitRef = useRef(false);
  const requestIdsRef = useRef(new Set());
  const firedEventKeysRef = useRef(new Set());
  const eventProcessingRef = useRef(new Set());
  const presenceHeartbeatRef = useRef(null);
  const messageSendTimesRef = useRef([]);

  const usersById = useMemo(() => {
    const map = new Map();
    for (const user of users) map.set(user.id, user);
    return map;
  }, [users]);

  const selectedChat = useMemo(
    () => chats.find((chat) => chat.id === selectedChatId) || null,
    [chats, selectedChatId],
  );

  const selectedChatOtherUser = useMemo(() => {
    if (!selectedChat || !currentUser) return null;
    const uid = (selectedChat.members || []).find((member) => member !== currentUser.uid);
    return uid ? usersById.get(uid) : null;
  }, [selectedChat, currentUser, usersById]);

  const username = userProfile?.username || currentUser?.displayName || "User";
  const isCurrentUserOnline = isUserOnline(userProfile);
  const isSelectedUserOnline = isUserOnline(selectedChatOtherUser);
  const activeTypingStream = typingStreams.length > 0 ? typingStreams[0] : null;
  const directFriendIds = useMemo(() => {
    if (!currentUser) return [];
    const set = new Set();
    for (const chat of chats) {
      if (chat.isGroup) continue;
      const members = Array.isArray(chat.members) ? chat.members : [];
      if (!members.includes(currentUser.uid) || members.length !== 2) continue;
      const otherId = members.find((id) => id !== currentUser.uid);
      if (otherId) set.add(otherId);
    }
    return Array.from(set);
  }, [chats, currentUser]);
  const availableGroupFriends = useMemo(
    () => directFriendIds.map((id) => usersById.get(id)).filter(Boolean),
    [directFriendIds, usersById],
  );
  const savedMessageIds = useMemo(() => new Set(savedMessages.map((item) => item.id)), [savedMessages]);

  function buildSavedId(chatId, messageId) {
    return `${chatId}_${messageId}`;
  }

  function handleComposerFileSelect(file) {
    if (!file) {
      setMediaFile(null);
      setComposerStatus("");
      return;
    }
    if ((file.size || 0) > MAX_UPLOAD_BYTES) {
      setMediaFile(null);
      setComposerStatus("Upload blocked: file must be 7MB or smaller.");
      return;
    }
    setMediaFile(file);
    setComposerStatus("");
  }

  function checkMessageRateLimit() {
    const now = Date.now();
    const recent = messageSendTimesRef.current.filter((value) => now - value < MESSAGE_RATE_WINDOW_MS);
    if (recent.length >= MESSAGE_RATE_LIMIT) {
      messageSendTimesRef.current = recent;
      setShowSpamWarning(true);
      return false;
    }
    recent.push(now);
    messageSendTimesRef.current = recent;
    return true;
  }

  function openChat(chatId) {
    setSelectedChatId(chatId);
    if (isMobileLayout) setMobileScreen("chat");
  }

  function openAddFriendPopup() {
    setShowAddFriend(true);
    setShowCreateGroup(false);
    setShowNotifications(false);
    setShowProfile(false);
  }

  function openCreateGroupPopup() {
    setShowCreateGroup(true);
    setShowAddFriend(false);
    setShowNotifications(false);
    setShowProfile(false);
    setGroupStep("select");
    setSelectedGroupMemberIds([]);
    setGroupNameDraft("");
    setGroupPhotoFile(null);
    setGroupStatus("");
  }

  function openNotificationPopup() {
    setShowNotifications(true);
    setShowAddFriend(false);
    setShowCreateGroup(false);
    setShowProfile(false);
  }

  function openProfilePopup() {
    setShowProfile(true);
    setShowAddFriend(false);
    setShowCreateGroup(false);
    setShowNotifications(false);
  }

  function openEventSchedulerPopup() {
    if (!selectedChatId) return;
    setShowEventScheduler(true);
    setShowAddFriend(false);
    setShowCreateGroup(false);
    setShowNotifications(false);
    setShowProfile(false);
    setEventTitleDraft("");
    setEventDescriptionDraft("");
    setEventTimeDraft("");
    setEventStatus("");
  }

  function closePopups() {
    setShowAddFriend(false);
    setShowCreateGroup(false);
    setShowNotifications(false);
    setShowProfile(false);
    setShowEditProfile(false);
    setShowSavedContent(false);
    setShowUserProfileView(false);
    setShowEventScheduler(false);
    setViewedUserId("");
  }

  function toggleGroupMember(uid) {
    setSelectedGroupMemberIds((prev) =>
      prev.includes(uid) ? prev.filter((id) => id !== uid) : [...prev, uid],
    );
  }

  function pushBrowserNotification(title, body) {
    if (typeof window === "undefined" || typeof Notification === "undefined") return;
    if (document.visibilityState === "visible") return;
    if (Notification.permission !== "granted") return;
    try {
      const notification = new Notification(title, { body });
      setTimeout(() => notification.close(), 6000);
    } catch {
      // ignore browser notification errors
    }
  }

  async function requestNotificationPermission() {
    if (typeof Notification === "undefined") {
      setNotificationPermission("unsupported");
      return;
    }
    try {
      const result = await Notification.requestPermission();
      setNotificationPermission(result);
    } catch {
      setNotificationPermission(Notification.permission);
    }
  }

  useEffect(() => {
    if (!showSplash) return undefined;
    const timer = setTimeout(() => {
      setShowSplash(false);
      if (typeof window !== "undefined") {
        sessionStorage.setItem("textinger_splash_seen", "1");
      }
    }, 2200);
    return () => clearTimeout(timer);
  }, [showSplash]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const updateLayout = () => setIsMobileLayout(window.innerWidth <= MOBILE_BREAKPOINT);
    updateLayout();
    window.addEventListener("resize", updateLayout);
    return () => window.removeEventListener("resize", updateLayout);
  }, []);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (user) => {
      setCurrentUser(user);
      setAuthError("");
      closePopups();
      setAuthReady(true);
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!currentUser) return undefined;

    const userDocUnsub = onSnapshot(doc(db, "users", currentUser.uid), (snap) => {
      setUserProfile(snap.exists() ? { id: snap.id, ...snap.data() } : null);
    });

    const usersUnsub = onSnapshot(collection(db, "users"), (snapshot) => {
      setUsers(snapshot.docs.map((d) => ({ id: d.id, ...d.data() })));
    });

    const chatsUnsub = onSnapshot(
      query(collection(db, "chats"), where("members", "array-contains", currentUser.uid)),
      (snapshot) => {
        const list = snapshot.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          .sort((a, b) => (b.updatedAt?.toMillis?.() || 0) - (a.updatedAt?.toMillis?.() || 0));
        setChats(list);
      },
    );

    const requestsUnsub = onSnapshot(
      query(collection(db, "friendRequests"), where("toUid", "==", currentUser.uid)),
      (snapshot) => {
        setRequests(
          snapshot.docs
            .map((d) => ({ id: d.id, ...d.data() }))
            .filter((request) => request.status === "pending"),
        );
      },
    );

    const savedUnsub = onSnapshot(collection(db, "users", currentUser.uid, "savedMessages"), (snapshot) => {
      const list = snapshot.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.savedAt?.toMillis?.() || 0) - (a.savedAt?.toMillis?.() || 0));
      setSavedMessages(list);
    });

    return () => {
      userDocUnsub();
      usersUnsub();
      chatsUnsub();
      requestsUnsub();
      savedUnsub();
    };
  }, [currentUser]);

  useEffect(() => {
    if (!currentUser) return undefined;

    const userRef = doc(db, "users", currentUser.uid);
    let stopped = false;

    const markPresence = async (isOnlineValue) => {
      if (stopped) return;
      try {
        await setDoc(
          userRef,
          { isOnline: isOnlineValue, lastActiveAt: serverTimestamp() },
          { merge: true },
        );
      } catch {
        // Presence updates are best-effort.
      }
    };

    markPresence(true);
    presenceHeartbeatRef.current = setInterval(() => markPresence(true), 45 * 1000);

    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        markPresence(true);
      } else {
        markPresence(false);
      }
    };
    const handleBeforeUnload = () => markPresence(false);

    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("beforeunload", handleBeforeUnload);
    window.addEventListener("pagehide", handleBeforeUnload);

    return () => {
      stopped = true;
      if (presenceHeartbeatRef.current) {
        clearInterval(presenceHeartbeatRef.current);
        presenceHeartbeatRef.current = null;
      }
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("beforeunload", handleBeforeUnload);
      window.removeEventListener("pagehide", handleBeforeUnload);
      setDoc(
        userRef,
        { isOnline: false, lastActiveAt: serverTimestamp() },
        { merge: true },
      ).catch(() => {});
    };
  }, [currentUser]);

  useEffect(() => {
    if (!selectedChatId && chats.length > 0) setSelectedChatId(chats[0].id);
    if (chats.length === 0) {
      setSelectedChatId("");
      setMessages([]);
    }
  }, [chats, selectedChatId]);

  useEffect(() => {
    if (!isMobileLayout) return;
    if (!selectedChatId) setMobileScreen("list");
  }, [isMobileLayout, selectedChatId]);

  useEffect(() => {
    if (!selectedChatId) return undefined;
    setMessagesLoading(true);
    const unsub = onSnapshot(
      query(collection(db, "chats", selectedChatId, "messages"), orderBy("createdAt", "asc")),
      (snapshot) => {
        setMessages(snapshot.docs.map((d) => ({ id: d.id, ...d.data() })));
        setMessagesLoading(false);
      },
    );
    return () => unsub();
  }, [selectedChatId]);

  async function clearTypingState(chatId = selectedChatId) {
    if (!currentUser || !chatId) return;
    try {
      await deleteDoc(doc(db, "chats", chatId, "typing", currentUser.uid));
    } catch {
      // best-effort cleanup for ephemeral typing state
    }
  }

  async function publishTypingState(nextText, chatId = selectedChatId) {
    if (!currentUser || !chatId) return;
    const value = nextText ?? "";
    if (!value.trim()) {
      await clearTypingState(chatId);
      return;
    }

    await setDoc(
      doc(db, "chats", chatId, "typing", currentUser.uid),
      {
        uid: currentUser.uid,
        username,
        photoURL: userProfile?.photoURL || currentUser.photoURL || "",
        isTyping: true,
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );
  }

  useEffect(() => {
    if (!selectedChatId || !currentUser) {
      setTypingStreams([]);
      return undefined;
    }

    const typingUnsub = onSnapshot(collection(db, "chats", selectedChatId, "typing"), (snapshot) => {
      const list = snapshot.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .filter((entry) => entry.id !== currentUser.uid && entry.isTyping);
      setTypingStreams(list);
    });

    return () => typingUnsub();
  }, [selectedChatId, currentUser]);

  useEffect(() => {
    return () => {
      clearTypingState();
    };
  }, [selectedChatId, currentUser]);

  useEffect(() => {
    if (!openMessageMenuId) return undefined;
    const handleGlobalClick = () => setOpenMessageMenuId("");
    document.addEventListener("click", handleGlobalClick);
    return () => document.removeEventListener("click", handleGlobalClick);
  }, [openMessageMenuId]);

  useEffect(() => {
    if (!attachMenuOpen) return undefined;
    const handleGlobalClick = () => setAttachMenuOpen(false);
    document.addEventListener("click", handleGlobalClick);
    return () => document.removeEventListener("click", handleGlobalClick);
  }, [attachMenuOpen]);

  useEffect(() => {
    if (!showProfile) return;
    setProfileNameDraft(username);
    setProfileBioDraft(userProfile?.bio || "");
  }, [showProfile, username]);

  useEffect(() => {
    if (!currentUser) {
      chatsInitRef.current = false;
      chatMetaRef.current = new Map();
      requestsInitRef.current = false;
      requestIdsRef.current = new Set();
      setUnreadChatIds([]);
      return;
    }

    const nextMap = new Map();
    for (const chat of chats) {
      nextMap.set(chat.id, {
        updatedAt: chat.updatedAt?.toMillis?.() || 0,
        lastMessage: chat.lastMessage || "",
        lastSenderId: chat.lastSenderId || "",
      });
    }

    if (!chatsInitRef.current) {
      chatsInitRef.current = true;
      chatMetaRef.current = nextMap;
      return;
    }

    for (const chat of chats) {
      const prev = chatMetaRef.current.get(chat.id);
      const currentMeta = nextMap.get(chat.id);
      if (!prev || !currentMeta) continue;
      const changed =
        currentMeta.updatedAt !== prev.updatedAt || currentMeta.lastMessage !== prev.lastMessage;
      if (!changed) continue;
      if (!currentMeta.lastSenderId || currentMeta.lastSenderId === currentUser.uid) continue;

      if (chat.id !== selectedChatId) {
        setUnreadChatIds((prev) => (prev.includes(chat.id) ? prev : [...prev, chat.id]));
      }

      const otherUid = (chat.members || []).find((member) => member !== currentUser.uid);
      const other = otherUid ? usersById.get(otherUid) : null;
      const chatTitle = chat.isGroup
        ? chat.groupName || "Group Chat"
        : other?.username || "New Message";
      pushBrowserNotification(chatTitle, currentMeta.lastMessage || "You have a new message.");
    }

    chatMetaRef.current = nextMap;
  }, [chats, currentUser, usersById, selectedChatId]);

  useEffect(() => {
    if (!selectedChatId) return;
    setUnreadChatIds((prev) => prev.filter((id) => id !== selectedChatId));
  }, [selectedChatId]);

  useEffect(() => {
    if (!currentUser) return;
    const nextIds = new Set(requests.map((request) => request.id));
    if (!requestsInitRef.current) {
      requestsInitRef.current = true;
      requestIdsRef.current = nextIds;
      return;
    }

    for (const request of requests) {
      if (requestIdsRef.current.has(request.id)) continue;
      pushBrowserNotification("New Friend Request", `${request.fromUsername || "Someone"} sent you a request.`);
    }
    requestIdsRef.current = nextIds;
  }, [requests, currentUser]);

  useEffect(() => {
    if (!currentUser) {
      firedEventKeysRef.current = new Set();
      eventProcessingRef.current = new Set();
      setEventPulseChatIds([]);
      setEventToast(null);
      setActiveEventDisplay(null);
      return undefined;
    }

    const timer = setInterval(() => {
      const now = Date.now();
      for (const chat of chats) {
        const eventAt = chat?.nextEventAt?.toMillis?.();
        if (!eventAt) continue;
        const eventKey = `${chat.id}_${eventAt}`;
        if (firedEventKeysRef.current.has(eventKey)) continue;
        if (eventProcessingRef.current.has(eventKey)) continue;
        if (now < eventAt) continue;
        eventProcessingRef.current.add(eventKey);

        const chatRef = doc(db, "chats", chat.id);
        runTransaction(db, async (transaction) => {
          const snap = await transaction.get(chatRef);
          if (!snap.exists()) return { triggered: false };
          const data = snap.data();
          const nextEventAtMs = data?.nextEventAt?.toMillis?.();
          if (!nextEventAtMs || Date.now() < nextEventAtMs) return { triggered: false };
          const lastTriggeredMs = data?.lastTriggeredEventAt?.toMillis?.() || 0;
          if (lastTriggeredMs === nextEventAtMs) {
            return {
              triggered: false,
              title: data?.nextEventTitle || "Scheduled event started",
              description: data?.nextEventDescription || "",
            };
          }

          transaction.update(chatRef, {
            lastTriggeredEventAt: data.nextEventAt,
            lastMessage: `[Event] ${data?.nextEventTitle || "Scheduled Event"}`,
            lastSenderId: "__event__",
            updatedAt: serverTimestamp(),
          });

          return {
            triggered: true,
            title: data?.nextEventTitle || "Scheduled event started",
            description: data?.nextEventDescription || "",
          };
        })
          .then(async (result) => {
            if (result?.triggered) {
              await addDoc(collection(db, "chats", chat.id, "messages"), {
                senderId: "__event__",
                senderName: "Event",
                text: result.description
                  ? `Event started: ${result.title}\n${result.description}`
                  : `Event started: ${result.title}`,
                isEvent: true,
                eventTitle: result.title,
                eventDescription: result.description || "",
                createdAt: serverTimestamp(),
              });
              const title = result?.title || chat.nextEventTitle || "Scheduled event started";
              const description = result?.description || chat.nextEventDescription || "";
              setEventPulseChatIds((prev) => (prev.includes(chat.id) ? prev : [...prev, chat.id]));
              setEventToast({
                chatId: chat.id,
                text: description ? `${title}: ${description}` : title,
              });
              setActiveEventDisplay({
                chatId: chat.id,
                title,
                description,
              });

              setTimeout(() => {
                setEventPulseChatIds((prev) => prev.filter((id) => id !== chat.id));
                setEventToast((prev) => (prev?.chatId === chat.id ? null : prev));
                setActiveEventDisplay((prev) => (prev?.chatId === chat.id ? null : prev));
              }, 5000);
            }

            firedEventKeysRef.current.add(eventKey);
          })
          .finally(() => {
            eventProcessingRef.current.delete(eventKey);
          });
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [chats, currentUser]);

  function openUserProfileView(userId) {
    if (!userId) return;
    setViewedUserId(userId);
    setShowUserProfileView(true);
  }

  async function syncChatLastMessage(chatId) {
    const latestSnap = await getDocs(
      query(collection(db, "chats", chatId, "messages"), orderBy("createdAt", "desc"), limit(1)),
    );
    if (latestSnap.empty) {
      await updateDoc(doc(db, "chats", chatId), {
        lastMessage: "No messages yet",
        lastSenderId: "",
        updatedAt: serverTimestamp(),
      });
      return;
    }

    const latest = latestSnap.docs[0].data();
    const nextLastMessage =
      latest.text ||
      (latest.mediaType?.startsWith("image/")
        ? "Photo"
        : latest.mediaType?.startsWith("video/")
          ? "Video"
          : latest.mediaType?.startsWith("audio/")
            ? "Audio"
            : latest.mediaURL
              ? "File"
              : "No messages yet");
    await updateDoc(doc(db, "chats", chatId), {
      lastMessage: nextLastMessage,
      lastSenderId: latest.senderId || "",
      updatedAt: serverTimestamp(),
    });
  }

  async function handleAuthSubmit(event) {
    event.preventDefault();
    setAuthError("");
    setCapacityError("");

    const email = authForm.email.trim().toLowerCase();
    const password = authForm.password;
    const newUsername = authForm.username.trim();

    try {
      setBusyLabel("Signing in...");
      const usersRef = collection(db, "users");

      if (authMode === "register") {
        if (!newUsername) {
          setAuthError("Username is required.");
          return;
        }

        const cred = await createUserWithEmailAndPassword(auth, email, password);
        try {
          const onlineUsersSnap = await getDocs(
            query(usersRef, where("isOnline", "==", true), limit(MAX_TOTAL_USERS)),
          );
          const activeCutoff = Date.now() - ACTIVE_WINDOW_MS;
          const activeUserIds = new Set(
            onlineUsersSnap.docs
              .filter((entry) => toMillis(entry.data()?.lastActiveAt) >= activeCutoff)
              .map((entry) => entry.id),
          );
          const totalUsersSnap = await getCountFromServer(usersRef);
          const totalUsers = totalUsersSnap.data().count || 0;
          const activeWithoutCurrent = activeUserIds.has(cred.user.uid)
            ? activeUserIds.size - 1
            : activeUserIds.size;

          if (totalUsers >= MAX_TOTAL_USERS || activeWithoutCurrent >= MAX_ACTIVE_USERS) {
            await deleteUser(cred.user);
            await signOut(auth);
            if (totalUsers >= MAX_TOTAL_USERS) {
              setCapacityError(`Signup closed: max ${MAX_TOTAL_USERS} accounts reached.`);
            } else {
              setCapacityError(`Try later: max ${MAX_ACTIVE_USERS} active users reached.`);
            }
            return;
          }

          await updateProfile(cred.user, { displayName: newUsername });
          await setDoc(doc(db, "users", cred.user.uid), {
            email,
            emailLower: email,
            username: newUsername,
            bio: "",
            photoURL: "",
            isOnline: true,
            lastActiveAt: serverTimestamp(),
            createdAt: serverTimestamp(),
          });
        } catch (innerError) {
          try {
            await deleteUser(cred.user);
            await signOut(auth);
          } catch {
            // Cleanup best-effort.
          }
          throw innerError;
        }
      } else {
        const cred = await signInWithEmailAndPassword(auth, email, password);
        const onlineUsersSnap = await getDocs(
          query(usersRef, where("isOnline", "==", true), limit(MAX_TOTAL_USERS)),
        );
        const activeCutoff = Date.now() - ACTIVE_WINDOW_MS;
        const activeUserIds = new Set(
          onlineUsersSnap.docs
            .filter((entry) => toMillis(entry.data()?.lastActiveAt) >= activeCutoff)
            .map((entry) => entry.id),
        );
        const isAlreadyActive = activeUserIds.has(cred.user.uid);
        if (!isAlreadyActive && activeUserIds.size >= MAX_ACTIVE_USERS) {
          await signOut(auth);
          setCapacityError(`Try later: max ${MAX_ACTIVE_USERS} active users reached.`);
          return;
        }
      }

      setAuthForm({ email, password: "", username: "" });
    } catch (error) {
      setAuthError(error.message || "Authentication failed.");
    } finally {
      setBusyLabel("");
    }
  }

  async function sendMessage(event) {
    event.preventDefault();
    if (!selectedChat || !currentUser || (!text.trim() && !mediaFile) || sending) return;
    if (mediaFile && mediaFile.size > MAX_UPLOAD_BYTES) {
      setMediaFile(null);
      setComposerStatus("Upload blocked: file must be 7MB or smaller.");
      return;
    }
    if (!checkMessageRateLimit()) return;

    setSending(true);
    try {
      setComposerStatus("");
      setBusyLabel("Sending message...");
      let mediaURL = "";
      let mediaType = "";
      let mediaName = "";
      let mediaSize = 0;

      if (mediaFile) {
        mediaURL = await uploadMediaToCloudinary(mediaFile);
        mediaType = mediaFile.type || "application/octet-stream";
        mediaName = mediaFile.name;
        mediaSize = mediaFile.size || 0;
      }

      const payload = {
        senderId: currentUser.uid,
        senderName: username,
        text: text.trim(),
        mediaURL,
        mediaType,
        mediaName,
        mediaSize,
        createdAt: serverTimestamp(),
      };

      await addDoc(collection(db, "chats", selectedChat.id, "messages"), payload);
      const lastMessage =
        payload.text ||
        (mediaType.startsWith("image/")
          ? "Photo"
          : mediaType.startsWith("video/")
            ? "Video"
            : mediaType.startsWith("audio/")
              ? "Audio"
              : mediaURL
                ? "File"
                : "No messages yet");
      await updateDoc(doc(db, "chats", selectedChat.id), {
        lastMessage,
        lastSenderId: payload.senderId,
        updatedAt: serverTimestamp(),
      });
      setText("");
      typingTextRef.current = "";
      await clearTypingState();
      setMediaFile(null);
      setAttachMenuOpen(false);
    } finally {
      setSending(false);
      setBusyLabel("");
    }
  }

  async function handleAddFriend(event) {
    event.preventDefault();
    if (!currentUser || !friendEmail.trim()) return;

    setFriendStatus("");
    const email = friendEmail.trim().toLowerCase();
    try {
      setBusyLabel("Sending friend request...");
      const result = await getDocs(
        query(collection(db, "users"), where("emailLower", "==", email), limit(1)),
      );
      if (result.empty) {
        setFriendStatus("No user found with that email.");
        return;
      }

      const target = result.docs[0];
      if (target.id === currentUser.uid) {
        setFriendStatus("You cannot send a request to yourself.");
        return;
      }

      await addDoc(collection(db, "friendRequests"), {
        fromUid: currentUser.uid,
        fromEmail: currentUser.email || "",
        fromUsername: username,
        toUid: target.id,
        toEmail: target.data().email || "",
        status: "pending",
        createdAt: serverTimestamp(),
      });

      setFriendStatus("Friend request sent.");
      setFriendEmail("");
    } catch (error) {
      setFriendStatus(error.message || "Failed to send request.");
    } finally {
      setBusyLabel("");
    }
  }

  async function respondToRequest(request, status) {
    if (!currentUser) return;
    setBusyLabel("Updating request...");
    try {
      await updateDoc(doc(db, "friendRequests", request.id), { status });

      if (status === "accepted") {
        const chatId = buildChatId(currentUser.uid, request.fromUid);
        await setDoc(
          doc(db, "chats", chatId),
          {
            members: [currentUser.uid, request.fromUid],
            lastMessage: "",
            updatedAt: serverTimestamp(),
          },
          { merge: true },
        );
      }
    } finally {
      setBusyLabel("");
    }
  }

  async function handlePhotoChange(event) {
    if (!currentUser || !event.target.files?.[0]) return;
    setProfileStatus("");

    const file = event.target.files[0];
    if ((file.size || 0) > MAX_UPLOAD_BYTES) {
      setProfileStatus("Profile image must be 7MB or smaller.");
      event.target.value = "";
      return;
    }
    try {
      setBusyLabel("Uploading photo...");
      const url = await uploadAvatarToCloudinary(file, currentUser.uid);
      await updateProfile(currentUser, { photoURL: url });
      await setDoc(
        doc(db, "users", currentUser.uid),
        { photoURL: url, updatedAt: serverTimestamp() },
        { merge: true },
      );
      setProfileStatus("Profile picture updated.");
    } catch (error) {
      setProfileStatus(error.message || "Failed to update picture.");
    } finally {
      setBusyLabel("");
    }
  }

  async function handleProfileSave() {
    if (!currentUser) return;
    const nextName = profileNameDraft.trim();
    const nextBio = profileBioDraft.trim();
    if (!nextName) {
      setProfileStatus("Username cannot be empty.");
      return;
    }

    setProfileStatus("");
    setBusyLabel("Updating profile...");
    try {
      await updateProfile(currentUser, { displayName: nextName });
      await setDoc(
        doc(db, "users", currentUser.uid),
        { username: nextName, bio: nextBio, updatedAt: serverTimestamp() },
        { merge: true },
      );
      setProfileStatus("Profile updated.");
    } catch (error) {
      setProfileStatus(error.message || "Failed to update profile.");
    } finally {
      setBusyLabel("");
    }
  }

  function beginEditMessage(message) {
    setEditingMessageId(message.id);
    setEditingText(message.text || "");
    setOpenMessageMenuId("");
  }

  function cancelEditMessage() {
    setEditingMessageId("");
    setEditingText("");
  }

  async function saveEditMessage(message) {
    if (!selectedChatId) return;
    const nextText = editingText.trim();
    if (!nextText && !message.mediaURL) return;
    setBusyLabel("Saving message...");
    try {
      await updateDoc(doc(db, "chats", selectedChatId, "messages", message.id), {
        text: nextText,
        editedAt: serverTimestamp(),
      });
      await syncChatLastMessage(selectedChatId);
      cancelEditMessage();
    } finally {
      setBusyLabel("");
    }
  }

  async function removeMessage(messageId) {
    if (!selectedChatId) return;
    if (!window.confirm("Delete this message?")) return;
    setBusyLabel("Deleting message...");
    try {
      await deleteDoc(doc(db, "chats", selectedChatId, "messages", messageId));
      await syncChatLastMessage(selectedChatId);
    } finally {
      setBusyLabel("");
    }
  }

  async function copyMessage(msg) {
    const content = (msg.text || "").trim() || msg.mediaURL || "";
    if (!content) return;
    try {
      await navigator.clipboard.writeText(content);
      setOpenMessageMenuId("");
    } catch {
      setOpenMessageMenuId("");
    }
  }

  async function saveMessageForLater(msg) {
    if (!currentUser || !selectedChatId) return;
    const savedId = buildSavedId(selectedChatId, msg.id);
    if (savedMessageIds.has(savedId)) {
      setSavedStatus("Already saved.");
      setOpenMessageMenuId("");
      return;
    }
    setBusyLabel("Saving message...");
    setSavedStatus("");
    try {
      await setDoc(
        doc(db, "users", currentUser.uid, "savedMessages", savedId),
        {
          chatId: selectedChatId,
          originalMessageId: msg.id,
          senderId: msg.senderId || "",
          senderName: msg.senderName || msg.user || "",
          text: msg.text || "",
          mediaURL: msg.mediaURL || "",
          mediaType: msg.mediaType || "",
          mediaName: msg.mediaName || "",
          savedAt: serverTimestamp(),
        },
        { merge: true },
      );
      setSavedStatus("Message saved.");
      setOpenMessageMenuId("");
    } catch (error) {
      setSavedStatus(error.message || "Failed to save message.");
    } finally {
      setBusyLabel("");
    }
  }

  async function removeSavedMessage(savedId) {
    if (!currentUser) return;
    await deleteDoc(doc(db, "users", currentUser.uid, "savedMessages", savedId));
  }

  async function createGroupChat() {
    if (!currentUser) return;
    const name = groupNameDraft.trim();
    if (!name) {
      setGroupStatus("Group name is required.");
      return;
    }
    if (selectedGroupMemberIds.length === 0) {
      setGroupStatus("Select at least one friend.");
      return;
    }
    if (groupPhotoFile && (groupPhotoFile.size || 0) > MAX_UPLOAD_BYTES) {
      setGroupStatus("Group photo must be 7MB or smaller.");
      return;
    }

    setBusyLabel("Creating group...");
    setGroupStatus("");
    try {
      let groupPhotoURL = "";
      if (groupPhotoFile) {
        groupPhotoURL = await uploadGroupImageToCloudinary(groupPhotoFile, currentUser.uid);
      }

      const members = Array.from(new Set([currentUser.uid, ...selectedGroupMemberIds]));
      const groupRef = await addDoc(collection(db, "chats"), {
        isGroup: true,
        groupName: name,
        groupPhotoURL,
        members,
        createdBy: currentUser.uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        lastMessage: "No messages yet",
        lastSenderId: "",
      });

      openChat(groupRef.id);
      setGroupStatus("Group created.");
      closePopups();
    } catch (error) {
      setGroupStatus(error.message || "Failed to create group.");
    } finally {
      setBusyLabel("");
    }
  }

  async function createScheduledEvent() {
    if (!selectedChatId || !currentUser) return;
    const title = eventTitleDraft.trim() || "Scheduled Event";
    const description = eventDescriptionDraft.trim();
    const date = new Date(eventTimeDraft);
    if (!eventTimeDraft || Number.isNaN(date.getTime())) {
      setEventStatus("Select a valid date/time.");
      return;
    }
    if (date.getTime() <= Date.now()) {
      setEventStatus("Event time must be in the future.");
      return;
    }

    setBusyLabel("Scheduling event...");
    setEventStatus("");
    try {
      await updateDoc(doc(db, "chats", selectedChatId), {
        nextEventTitle: title,
        nextEventDescription: description,
        nextEventAt: Timestamp.fromDate(date),
        nextEventCreatedBy: currentUser.uid,
        nextEventUpdatedAt: serverTimestamp(),
      });
      setEventStatus("Event scheduled.");
      setShowEventScheduler(false);
    } catch (error) {
      setEventStatus(error.message || "Failed to schedule event.");
    } finally {
      setBusyLabel("");
    }
  }

  if (showSplash) {
    return (
      <main className="splashShell">
        <section className="splashCard">
          <div className="splashPulse" />
          <p className="splashLabel">Launching</p>
          <h1 className="splashBrand">TEXTINGER</h1>
          <p className="splashTagline">Private chats. Real-time speed. Glass precision.</p>
          <div className="splashProgress">
            <span />
          </div>
        </section>
      </main>
    );
  }

  if (!authReady) {
    return (
      <main className="splashShell">
        <section className="splashCard">
          <p className="splashLabel">Loading</p>
          <h1 className="splashBrand">TEXTINGER</h1>
          <div className="splashProgress">
            <span />
          </div>
        </section>
      </main>
    );
  }

  if (!currentUser) {
    return (
      <>
        <main className="authShell">
          <div className="authMotionBg" aria-hidden="true">
            <span className="authBlob authBlobA" />
            <span className="authBlob authBlobB" />
            <span className="authBlob authBlobC" />
            <span className="authGridGlow" />
          </div>
          <section className="authCard">
          <h1>Textinger</h1>
          <p>Email + password login with username registration.</p>
          <div className="authSwitch">
            <button
              type="button"
              className={authMode === "login" ? "active" : ""}
              onClick={() => setAuthMode("login")}
            >
              Login
            </button>
            <button
              type="button"
              className={authMode === "register" ? "active" : ""}
              onClick={() => setAuthMode("register")}
            >
              Register
            </button>
          </div>

          <form onSubmit={handleAuthSubmit} className="stack">
            {authMode === "register" && (
              <input
                type="text"
                placeholder="Username"
                value={authForm.username}
                onChange={(event) =>
                  setAuthForm((prev) => ({ ...prev, username: event.target.value }))
                }
                maxLength={30}
              />
            )}
            <input
              type="email"
              placeholder="Email"
              value={authForm.email}
              onChange={(event) => setAuthForm((prev) => ({ ...prev, email: event.target.value }))}
              required
            />
            <input
              type="password"
              placeholder="Password"
              value={authForm.password}
              onChange={(event) => setAuthForm((prev) => ({ ...prev, password: event.target.value }))}
              minLength={6}
              required
            />
            <button type="submit">{authMode === "register" ? "Create Account" : "Login"}</button>
          </form>

          {capacityError && <p className="errorText">{capacityError}</p>}
          {authError && <p className="errorText">{authError}</p>}
          </section>
        </main>
        {busyLabel && (
          <div className="loadingOverlay">
            <div className="loadingCard">
              <div className="loaderDot" />
              <p>{busyLabel}</p>
            </div>
          </div>
        )}
      </>
    );
  }

  return (
    <>
      <main
        className={`appShell ${isMobileLayout ? "mobileLayout" : ""} ${mobileScreen === "chat" ? "showMobileChat" : "showMobileList"}`}
      >
        <aside className="sidebar">
        <div className="sidebarTop">
          <h2>Chats</h2>
          <div className="sideActions">
            <button type="button" onClick={openAddFriendPopup}>
              Add Friend
            </button>
            {availableGroupFriends.length > 0 && (
              <button type="button" className="ghost" onClick={openCreateGroupPopup}>
                Create Group
              </button>
            )}
          </div>
        </div>

        <div className="chatList">
          {chats.length === 0 && <p className="muted">There is no message here.</p>}
          {chats.map((chat) => {
            const otherUid = (chat.members || []).find((member) => member !== currentUser.uid);
            const other = otherUid ? usersById.get(otherUid) : null;
            const name = chat.isGroup ? chat.groupName || "Unnamed Group" : other?.username || "Unknown user";
            const photo = chat.isGroup ? chat.groupPhotoURL || "" : other?.photoURL || "";
            const showOnline = !chat.isGroup;
            const chatUserOnline = showOnline && isUserOnline(other);
            return (
              <button
                type="button"
                key={chat.id}
                className={`chatRow ${selectedChatId === chat.id ? "active" : ""} ${unreadChatIds.includes(chat.id) ? "unread" : ""} ${eventPulseChatIds.includes(chat.id) ? "eventPulse" : ""}`}
                onClick={() => openChat(chat.id)}
              >
                <Avatar
                  name={name}
                  photoURL={photo}
                  isOnline={chatUserOnline}
                  showOnlineDot={showOnline}
                />
                <span className="chatMeta">
                  <strong>{name}</strong>
                  <small>{chat.lastMessage || "No messages yet"}</small>
                </span>
                {unreadChatIds.includes(chat.id) && <span className="unreadDot" />}
                {eventPulseChatIds.includes(chat.id) && <span className="eventDot" />}
              </button>
            );
          })}
        </div>
        </aside>

        <section className="chatPanel">
        <header className="panelTop">
          <div className="panelTitleWrap">
            {isMobileLayout && mobileScreen === "chat" && (
              <button type="button" className="ghost mobileBackBtn" onClick={() => setMobileScreen("list")}>
                Back
              </button>
            )}
            <div>
            <h1>
              {selectedChat?.isGroup
                ? selectedChat.groupName || "Unnamed Group"
                : selectedChatOtherUser?.username || "Textinger"}
              {!selectedChat?.isGroup && (
                <span className={`userStatusText ${isSelectedUserOnline ? "online" : "offline"}`}>
                  {isSelectedUserOnline ? "Online" : "Offline"}
                </span>
              )}
            </h1>
            <small>
              {selectedChat?.isGroup
                ? `${selectedChat.members?.length || 0} members`
                : selectedChatOtherUser?.email || "Realtime Firebase chat"}
            </small>
            </div>
          </div>
          <div className="topActions">
            <button type="button" onClick={openNotificationPopup}>
              Notifications {requests.length > 0 ? `(${requests.length})` : ""}
            </button>
            <button type="button" onClick={openProfilePopup}>
              Profile
            </button>
          </div>
        </header>

        <section className="messageArea">
          {selectedChat ? (
            <>
              <div className="messages">
                {messagesLoading && <p className="muted">Loading messages...</p>}
                {!messagesLoading && messages.length === 0 && <p className="muted">There is no message here.</p>}
                {messages.map((msg) => {
                  const senderUser = usersById.get(msg.senderId);
                  const senderName =
                    msg.senderId === currentUser.uid
                      ? username
                      : senderUser?.username || msg.senderName || msg.user || "Unknown";
                  const senderPhoto =
                    msg.senderId === currentUser.uid
                      ? userProfile?.photoURL || currentUser.photoURL || ""
                      : senderUser?.photoURL || "";
                  const senderOnline =
                    msg.senderId === currentUser.uid ? isCurrentUserOnline : isUserOnline(senderUser);
                  return (
                    <article
                      key={msg.id}
                      className={`bubble ${msg.senderId === currentUser.uid ? "own" : ""}`}
                    >
                      <div className="meta">
                        <div className="metaUser">
                          <button
                            type="button"
                            className="ghost profilePeek"
                            onClick={() => openUserProfileView(msg.senderId)}
                          >
                            <Avatar
                              name={senderName}
                              photoURL={senderPhoto}
                              className="metaAvatar"
                              isOnline={senderOnline}
                              showOnlineDot={Boolean(senderUser) || msg.senderId === currentUser.uid}
                            />
                            <strong>{senderName}</strong>
                          </button>
                        </div>
                        <small>
                          {formatTime(msg.createdAt)}
                          {msg.editedAt ? " (edited)" : ""}
                        </small>
                      </div>
                      {editingMessageId === msg.id ? (
                        <div className="editBox">
                          <input
                            type="text"
                            value={editingText}
                            onChange={(event) => setEditingText(event.target.value)}
                            maxLength={500}
                          />
                          <div className="editActions">
                            <button type="button" onClick={() => saveEditMessage(msg)}>
                              Save
                            </button>
                            <button type="button" className="ghost" onClick={cancelEditMessage}>
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        msg.text && <p>{msg.text}</p>
                      )}
                      {msg.mediaURL && (
                        <div className="mediaBlock">
                          {msg.mediaType?.startsWith("image/") ? (
                            <img
                              src={msg.mediaURL}
                              alt={msg.mediaName || "image"}
                              className="msgImage"
                              onClick={() => {
                                setPreviewImage(msg.mediaURL);
                                setPreviewZoom(1);
                              }}
                            />
                          ) : msg.mediaType?.startsWith("video/") ? (
                            <video controls className="msgVideo">
                              <source src={msg.mediaURL} type={msg.mediaType} />
                            </video>
                          ) : msg.mediaType?.startsWith("audio/") ? (
                            <audio controls className="msgAudio">
                              <source src={msg.mediaURL} type={msg.mediaType} />
                            </audio>
                          ) : (
                            <a href={msg.mediaURL} target="_blank" rel="noreferrer" className="fileLink">
                              {msg.mediaName || "Open file"}
                            </a>
                          )}
                        </div>
                      )}
                      <div className="messageMenuWrap">
                        <button
                          type="button"
                          className="ghost menuTrigger"
                          onClick={(event) => {
                            event.stopPropagation();
                            setOpenMessageMenuId((prev) => (prev === msg.id ? "" : msg.id));
                          }}
                        >
                          ...
                        </button>
                        {openMessageMenuId === msg.id && (
                          <div className="messageMenu" onClick={(event) => event.stopPropagation()}>
                            <button type="button" className="ghost menuItem" onClick={() => copyMessage(msg)}>
                              Copy
                            </button>
                            <button
                              type="button"
                              className="ghost menuItem"
                              onClick={() => saveMessageForLater(msg)}
                              disabled={savedMessageIds.has(buildSavedId(selectedChatId, msg.id))}
                            >
                              {savedMessageIds.has(buildSavedId(selectedChatId, msg.id)) ? "Saved" : "Save"}
                            </button>
                            {msg.senderId === currentUser.uid && (
                              <>
                                <button
                                  type="button"
                                  className="ghost menuItem"
                                  onClick={() => beginEditMessage(msg)}
                                >
                                  Edit
                                </button>
                                <button
                                  type="button"
                                  className="ghost menuItem danger"
                                  onClick={() => removeMessage(msg.id)}
                                >
                                  Delete
                                </button>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>

              <form onSubmit={sendMessage} className="composer">
                <div className="attachWrap">
                  <button
                    type="button"
                    className="ghost attachBtn"
                    onClick={(event) => {
                      event.stopPropagation();
                      setAttachMenuOpen((prev) => !prev);
                    }}
                  >
                    +
                  </button>
                  {attachMenuOpen && (
                    <div className="attachMenu" onClick={(event) => event.stopPropagation()}>
                      <button
                        type="button"
                        className="ghost menuItem"
                        onClick={() => {
                          mediaInputRef.current?.click();
                          setAttachMenuOpen(false);
                        }}
                      >
                        Media
                      </button>
                      <button
                        type="button"
                        className="ghost menuItem"
                        onClick={() => {
                          documentInputRef.current?.click();
                          setAttachMenuOpen(false);
                        }}
                      >
                        Document
                      </button>
                      <button
                        type="button"
                        className="ghost menuItem"
                        onClick={() => {
                          openEventSchedulerPopup();
                          setAttachMenuOpen(false);
                        }}
                      >
                        Event
                      </button>
                    </div>
                  )}
                  <input
                    type="file"
                    ref={mediaInputRef}
                    accept="image/*,video/*,audio/*"
                    onChange={(event) => handleComposerFileSelect(event.target.files?.[0] || null)}
                    hidden
                  />
                  <input
                    type="file"
                    ref={documentInputRef}
                    accept=".pdf,.doc,.docx,.txt,.rtf,.xls,.xlsx,.ppt,.pptx,.zip,.rar,.csv"
                    onChange={(event) => handleComposerFileSelect(event.target.files?.[0] || null)}
                    hidden
                  />
                </div>
                <input
                  type="text"
                  placeholder={
                    mediaFile
                      ? `Add a caption for ${mediaFile.name}`
                      : activeTypingStream
                        ? `${activeTypingStream.username || "Someone"} is typing...`
                        : "Type a message..."
                  }
                  value={text}
                  onChange={(event) => {
                    const nextText = event.target.value;
                    setText(nextText);
                    typingTextRef.current = nextText;
                    publishTypingState(nextText).catch(() => {});
                  }}
                  onBlur={() => {
                    if (!typingTextRef.current.trim()) {
                      clearTypingState();
                    }
                  }}
                  maxLength={500}
                />
                <button type="submit" disabled={sending || (!text.trim() && !mediaFile)}>
                  Send
                </button>
              </form>
              {typingStreams.length > 0 && (
                <div className="thoughtStreamBar">
                  {typingStreams.map((stream) => (
                    <p key={stream.id}>
                      <strong>{stream.username || "Someone"}</strong> is typing...
                    </p>
                  ))}
                </div>
              )}
              {composerStatus && <div className="thoughtStreamBar"><p>{composerStatus}</p></div>}
              {savedStatus && <div className="thoughtStreamBar"><p>{savedStatus}</p></div>}
              {mediaFile && (
                <div className="mediaQueued">
                  <span>{mediaFile.name}</span>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => {
                      setMediaFile(null);
                      setComposerStatus("");
                    }}
                  >
                    Remove
                  </button>
                </div>
              )}
            </>
          ) : (
            <div className="emptyState">
              <h3>There is no message here.</h3>
              <p>Select or create a chat to start.</p>
            </div>
          )}
        </section>
        </section>

        {(showAddFriend || showCreateGroup || showNotifications || showProfile || showEventScheduler) && (
          <div className="popupBackdrop" onClick={closePopups}>
          {showAddFriend && (
            <section className="popupCard" onClick={(event) => event.stopPropagation()}>
              <div className="popupHead">
                <h3>Add Friend</h3>
                <button type="button" className="ghost" onClick={closePopups}>
                  Close
                </button>
              </div>
              <form className="stack" onSubmit={handleAddFriend}>
                <input
                  type="email"
                  placeholder="Friend email"
                  value={friendEmail}
                  onChange={(event) => setFriendEmail(event.target.value)}
                  required
                />
                <button type="submit">Send Request</button>
              </form>
              {friendStatus && <p className="muted">{friendStatus}</p>}
            </section>
          )}

          {showCreateGroup && (
            <section className="popupCard" onClick={(event) => event.stopPropagation()}>
              <div className="popupHead">
                <h3>Create Group</h3>
                <button type="button" className="ghost" onClick={closePopups}>
                  Close
                </button>
              </div>

              {groupStep === "select" ? (
                <div className="stack">
                  <p className="muted">Select friends for the group.</p>
                  <div className="friendPickerList">
                    {availableGroupFriends.map((friend) => (
                      <button
                        type="button"
                        key={friend.id}
                        className={`friendPickItem ${selectedGroupMemberIds.includes(friend.id) ? "active" : ""}`}
                        onClick={() => toggleGroupMember(friend.id)}
                      >
                        <Avatar name={friend.username} photoURL={friend.photoURL} />
                        <span>{friend.username}</span>
                      </button>
                    ))}
                  </div>
                  <div className="groupStepActions">
                    <button
                      type="button"
                      onClick={() => {
                        if (selectedGroupMemberIds.length === 0) {
                          setGroupStatus("Select at least one friend.");
                          return;
                        }
                        setGroupStatus("");
                        setGroupStep("details");
                      }}
                    >
                      OK Next
                    </button>
                  </div>
                </div>
              ) : (
                <div className="stack">
                  <label className="uploadLabel">
                    Group Name (required)
                    <input
                      type="text"
                      value={groupNameDraft}
                      onChange={(event) => setGroupNameDraft(event.target.value)}
                      maxLength={40}
                    />
                  </label>
                  <label className="uploadLabel">
                    Group DP (optional)
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(event) => {
                        const file = event.target.files?.[0] || null;
                        if (file && (file.size || 0) > MAX_UPLOAD_BYTES) {
                          setGroupPhotoFile(null);
                          setGroupStatus("Group photo must be 7MB or smaller.");
                          event.target.value = "";
                          return;
                        }
                        setGroupPhotoFile(file);
                      }}
                    />
                  </label>
                  {groupPhotoFile && <small className="muted">Selected: {groupPhotoFile.name}</small>}
                  <div className="groupStepActions">
                    <button type="button" className="ghost" onClick={() => setGroupStep("select")}>
                      Back
                    </button>
                    <button type="button" onClick={createGroupChat}>
                      Create
                    </button>
                  </div>
                </div>
              )}

              {groupStatus && <p className="muted">{groupStatus}</p>}
            </section>
          )}

          {showNotifications && (
            <section className="popupCard" onClick={(event) => event.stopPropagation()}>
              <div className="popupHead">
                <h3>Friend Requests</h3>
                <button type="button" className="ghost" onClick={closePopups}>
                  Close
                </button>
              </div>
              <div className="notifyTools">
                <p className="muted">Browser alerts: {notificationPermission}</p>
                <button type="button" className="ghost" onClick={requestNotificationPermission}>
                  Enable Alerts
                </button>
              </div>
              {requests.length === 0 && <p className="muted">No pending requests.</p>}
              <div className="requestList">
                {requests.map((request) => (
                  <article key={request.id} className="requestCard">
                    <p>{request.fromUsername} sent you a request.</p>
                    <div className="requestActions">
                      <button type="button" onClick={() => respondToRequest(request, "accepted")}>
                        Accept
                      </button>
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => respondToRequest(request, "declined")}
                      >
                        Decline
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}

          {showEventScheduler && (
            <section className="popupCard" onClick={(event) => event.stopPropagation()}>
              <div className="popupHead">
                <h3>Event Scheduling</h3>
                <button type="button" className="ghost" onClick={closePopups}>
                  Close
                </button>
              </div>
              <div className="stack">
                <label className="uploadLabel">
                  Event title
                  <input
                    type="text"
                    value={eventTitleDraft}
                    onChange={(event) => setEventTitleDraft(event.target.value)}
                    maxLength={60}
                    placeholder="Team sync / deadline / reminder"
                  />
                </label>
                <label className="uploadLabel">
                  Event description
                  <input
                    type="text"
                    value={eventDescriptionDraft}
                    onChange={(event) => setEventDescriptionDraft(event.target.value)}
                    maxLength={200}
                    placeholder="Optional details"
                  />
                </label>
                <label className="uploadLabel">
                  Event time
                  <input
                    type="datetime-local"
                    value={eventTimeDraft}
                    onChange={(event) => setEventTimeDraft(event.target.value)}
                  />
                </label>
                <div className="groupStepActions">
                  <button type="button" onClick={createScheduledEvent}>
                    Create
                  </button>
                </div>
              </div>
              {eventStatus && <p className="muted">{eventStatus}</p>}
            </section>
          )}

          {showProfile && (
            <section className="popupCard" onClick={(event) => event.stopPropagation()}>
              <div className="popupHead">
                <h3>Profile</h3>
                <button type="button" className="ghost" onClick={closePopups}>
                  Close
                </button>
              </div>
              <div className="profileCard">
                <div className="profileAvatarWrap">
                  {userProfile?.photoURL || currentUser.photoURL ? (
                    <img
                      src={userProfile?.photoURL || currentUser.photoURL}
                      alt="Profile"
                      className="profileAvatar"
                    />
                  ) : (
                    <div className="profileAvatarFallback">{initials(username)}</div>
                  )}
                  {isCurrentUserOnline && <span className="profileOnlineDot" aria-label="Online" />}
                </div>
                <p>
                  <strong>Username:</strong> {username}{" "}
                  <span className={`userStatusText ${isCurrentUserOnline ? "online" : "offline"}`}>
                    {isCurrentUserOnline ? "Online" : "Offline"}
                  </span>
                </p>
                <p>
                  <strong>Email:</strong> {currentUser.email}
                </p>
                <p>
                  <strong>Bio:</strong> {userProfile?.bio || "No bio yet."}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setProfileNameDraft(username);
                    setProfileBioDraft(userProfile?.bio || "");
                    setShowEditProfile(true);
                  }}
                >
                  Edit Profile
                </button>
                <button type="button" className="ghost" onClick={() => setShowSavedContent(true)}>
                  Saved Content
                </button>
                {profileStatus && <small className="muted">{profileStatus}</small>}
                <button type="button" className="ghost" onClick={() => signOut(auth)}>
                  Logout
                </button>
              </div>
            </section>
          )}
          </div>
        )}
      </main>

      {previewImage && (
        <div className="imageOverlay" onClick={() => setPreviewImage("")}>
          <div className="imageOverlayCard" onClick={(event) => event.stopPropagation()}>
            <div className="overlayTop">
              <div className="overlayZoomControls">
                <button
                  type="button"
                  className="ghost"
                  onClick={() => setPreviewZoom((prev) => Math.max(0.6, Number((prev - 0.2).toFixed(2))))}
                >
                  -
                </button>
                <span>{Math.round(previewZoom * 100)}%</span>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => setPreviewZoom((prev) => Math.min(3, Number((prev + 0.2).toFixed(2))))}
                >
                  +
                </button>
                <button type="button" className="ghost" onClick={() => setPreviewZoom(1)}>
                  Reset
                </button>
              </div>
              <button type="button" className="ghost overlayClose" onClick={() => setPreviewImage("")}>
                Close
              </button>
            </div>
            <div className="imageViewport">
              <img
                src={previewImage}
                alt="Preview"
                className="imageOverlayPreview"
                style={{ transform: `scale(${previewZoom})` }}
              />
            </div>
          </div>
        </div>
      )}

      {busyLabel && (
        <div className="loadingOverlay">
          <div className="loadingCard">
            <div className="loaderDot" />
            <p>{busyLabel}</p>
          </div>
        </div>
      )}

      {showSpamWarning && (
        <div className="popupBackdrop" onClick={() => setShowSpamWarning(false)}>
          <section className="popupCard" onClick={(event) => event.stopPropagation()}>
            <div className="popupHead">
              <h3>Slow down</h3>
              <button type="button" className="ghost" onClick={() => setShowSpamWarning(false)}>
                Close
              </button>
            </div>
            <p className="muted">Spam protection: you can send up to 3 messages per second.</p>
          </section>
        </div>
      )}

      {showEditProfile && (
        <div className="popupBackdrop" onClick={() => setShowEditProfile(false)}>
          <section className="popupCard" onClick={(event) => event.stopPropagation()}>
            <div className="popupHead">
              <h3>Edit Profile</h3>
              <button type="button" className="ghost" onClick={() => setShowEditProfile(false)}>
                Close
              </button>
            </div>
            <div className="stack">
              <label className="uploadLabel">
                Username
                <input
                  type="text"
                  value={profileNameDraft}
                  onChange={(event) => setProfileNameDraft(event.target.value)}
                  maxLength={30}
                />
              </label>
              <label className="uploadLabel">
                Bio
                <input
                  type="text"
                  value={profileBioDraft}
                  onChange={(event) => setProfileBioDraft(event.target.value)}
                  maxLength={120}
                  placeholder="Tell something about you"
                />
              </label>
              <label className="uploadLabel">
                Change profile picture
                <input type="file" accept="image/*" onChange={handlePhotoChange} />
              </label>
              <div className="editProfileActions">
                <button
                  type="button"
                  onClick={async () => {
                    await handleProfileSave();
                    setShowEditProfile(false);
                  }}
                >
                  Save
                </button>
                <button type="button" className="ghost" onClick={() => setShowEditProfile(false)}>
                  Cancel
                </button>
              </div>
            </div>
          </section>
        </div>
      )}

      {showSavedContent && (
        <div className="popupBackdrop" onClick={() => setShowSavedContent(false)}>
          <section className="popupCard" onClick={(event) => event.stopPropagation()}>
            <div className="popupHead">
              <h3>Saved Content</h3>
              <button type="button" className="ghost" onClick={() => setShowSavedContent(false)}>
                Close
              </button>
            </div>
            <div className="savedList">
              {savedMessages.length === 0 && <p className="muted">No saved messages yet.</p>}
              {savedMessages.map((item) => (
                <article key={item.id} className="savedItem">
                  <div className="savedTop">
                    <strong>{item.senderName || "User"}</strong>
                    <small>{formatTime(item.savedAt)}</small>
                  </div>
                  {item.text && <p>{item.text}</p>}
                  {item.mediaURL && (
                    <div className="mediaBlock">
                      {item.mediaType?.startsWith("image/") ? (
                        <img
                          src={item.mediaURL}
                          alt={item.mediaName || "image"}
                          className="msgImage"
                          onClick={() => {
                            setPreviewImage(item.mediaURL);
                            setPreviewZoom(1);
                          }}
                        />
                      ) : (
                        <a href={item.mediaURL} target="_blank" rel="noreferrer" className="fileLink">
                          {item.mediaName || "Open file"}
                        </a>
                      )}
                    </div>
                  )}
                  <div className="savedActions">
                    <button type="button" className="ghost danger" onClick={() => removeSavedMessage(item.id)}>
                      Remove
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        </div>
      )}

      {showUserProfileView && viewedUserId && (
        <div className="popupBackdrop" onClick={() => setShowUserProfileView(false)}>
          <section className="popupCard" onClick={(event) => event.stopPropagation()}>
            <div className="popupHead">
              <h3>User Profile</h3>
              <button type="button" className="ghost" onClick={() => setShowUserProfileView(false)}>
                Close
              </button>
            </div>
            {(() => {
              const viewed = usersById.get(viewedUserId);
              const viewedName = viewed?.username || "User";
              const viewedPhoto = viewed?.photoURL || "";
              const viewedEmail = viewed?.email || "Hidden";
              const viewedBio = viewed?.bio || "No bio yet.";
              const viewedOnline = isUserOnline(viewed);
              return (
                <div className="profileCard">
                  <div className="profileAvatarWrap">
                    {viewedPhoto ? (
                      <img src={viewedPhoto} alt={viewedName} className="profileAvatar" />
                    ) : (
                      <div className="profileAvatarFallback">{initials(viewedName)}</div>
                    )}
                    {viewedOnline && <span className="profileOnlineDot" aria-label="Online" />}
                  </div>
                  <p>
                    <strong>Username:</strong> {viewedName}{" "}
                    <span className={`userStatusText ${viewedOnline ? "online" : "offline"}`}>
                      {viewedOnline ? "Online" : "Offline"}
                    </span>
                  </p>
                  <p>
                    <strong>Email:</strong> {viewedEmail}
                  </p>
                  <p>
                    <strong>Bio:</strong> {viewedBio}
                  </p>
                </div>
              );
            })()}
          </section>
        </div>
      )}

      {activeEventDisplay && activeEventDisplay.chatId === selectedChatId && (
        <div className="eventStage">
          <h2>{activeEventDisplay.title}</h2>
          {activeEventDisplay.description && <p>{activeEventDisplay.description}</p>}
        </div>
      )}

      {eventToast && (
        <div className="eventToast">
          <strong>Event Time</strong>
          <p>{eventToast.text}</p>
        </div>
      )}
    </>
  );
}
