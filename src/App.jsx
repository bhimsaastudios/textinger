import { useEffect, useMemo, useRef, useState } from "react";
import {
  createUserWithEmailAndPassword,
  deleteUser,
  onAuthStateChanged,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
} from "firebase/auth";
import {
  addDoc,
  arrayUnion,
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
import { getToken, onMessage } from "firebase/messaging";
import { auth, db, getFirebaseMessaging } from "./firebase";

const MAX_ACTIVE_USERS = 150;
const MAX_TOTAL_USERS = 500;
const ACTIVE_WINDOW_MS = 2 * 60 * 1000;
const MOBILE_BREAKPOINT = 860;
const MAX_UPLOAD_BYTES = 7 * 1024 * 1024;
const MESSAGE_RATE_LIMIT = 3;
const MESSAGE_RATE_WINDOW_MS = 1000;
const CHAT_PREVIEW_MAX_LENGTH = 72;
const GROUP_ROLES = ["member", "editor", "admin", "owner"];
const ONE_SIGNAL_APP_ID = import.meta.env.VITE_ONESIGNAL_APP_ID || "";
const ONE_SIGNAL_NOTIFY_URL = import.meta.env.VITE_ONESIGNAL_NOTIFY_URL || "";

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

function truncateText(value, maxLength = CHAT_PREVIEW_MAX_LENGTH) {
  const text = `${value || ""}`.trim();
  if (!text) return "";
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 3))}...` : text;
}

function renderTextWithLinks(value) {
  const text = `${value || ""}`;
  if (!text) return "";
  const linkPattern = /((https?:\/\/|www\.)[^\s]+)/gi;
  const parts = text.split(linkPattern);
  return parts.map((part, index) => {
    const isLink = /^(https?:\/\/|www\.)[^\s]+$/i.test(part);
    if (!isLink) return <span key={`text_${index}`}>{part}</span>;
    const href = /^https?:\/\//i.test(part) ? part : `https://${part}`;
    return (
      <a key={`link_${index}`} href={href} target="_blank" rel="noreferrer" className="textLink">
        {part}
      </a>
    );
  });
}

function getGroupRole(chat, uid) {
  if (!chat?.isGroup || !uid) return "member";
  if (chat.createdBy === uid) return "creator";
  const role = chat.groupRoles?.[uid];
  return GROUP_ROLES.includes(role) ? role : "member";
}

function canManageGroupCore(chat, uid) {
  if (!chat?.isGroup || !uid) return false;
  const role = getGroupRole(chat, uid);
  return role === "creator" || role === "owner";
}

function canManageGroupSubgroups(chat, uid) {
  if (!chat?.isGroup || !uid) return false;
  const role = getGroupRole(chat, uid);
  return role === "creator" || role === "owner" || role === "admin";
}

function canDeleteGroupMessage(chat, message, uid) {
  if (!uid || !message) return false;
  if (message.senderId === uid) return true;
  if (!chat?.isGroup) return false;
  const role = getGroupRole(chat, uid);
  return role === "creator" || role === "owner" || role === "editor";
}

function roleLabel(role) {
  if (role === "creator") return "Creator";
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function getChatLockConfig(chatLocks, chatId) {
  const raw = chatLocks?.[chatId];
  if (!raw) return null;
  if (typeof raw === "string") {
    return { pin: raw, recoveryAnswer: "" };
  }
  if (typeof raw === "object") {
    return {
      pin: `${raw.pin || ""}`.trim(),
      recoveryAnswer: `${raw.recoveryAnswer || ""}`.trim().toLowerCase(),
    };
  }
  return null;
}

function normalizeAuthError(error) {
  const code = error?.code || "";
  if (
    code === "auth/invalid-credential" ||
    code === "auth/user-not-found" ||
    code === "auth/wrong-password"
  ) {
    return "Invalid credentials.";
  }
  if (code === "auth/email-already-in-use") return "This email is already registered.";
  if (code === "auth/invalid-email") return "Please enter a valid email address.";
  if (code === "auth/weak-password") return "Password must be at least 6 characters.";
  if (code === "auth/operation-not-allowed") return "Email/password sign-in is disabled in Firebase Auth.";
  if (code === "auth/too-many-requests") return "Too many attempts. Please try again later.";
  if (code === "auth/network-request-failed") return "Network error. Check your internet and try again.";
  if (code === "permission-denied") return "Access blocked by Firestore rules. Update your Firestore rules and try again.";
  if (code === "failed-precondition") return "Firebase project setup is incomplete. Check Firestore/Auth configuration.";
  if (code === "unavailable") return "Firebase service is temporarily unavailable. Please try again.";
  return "Authentication failed.";
}

function isPermissionDenied(error) {
  return (error?.code || "") === "permission-denied";
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

function Avatar({
  name,
  photoURL,
  className = "avatar",
  isOnline = false,
  showOnlineDot = false,
  onClick,
}) {
  return (
    <span className={`avatarWrap ${onClick ? "avatarWrapClickable" : ""}`} onClick={onClick}>
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
  const [showForgotPassword, setShowForgotPassword] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotStatus, setForgotStatus] = useState("");
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
  const [mediaPreviewURL, setMediaPreviewURL] = useState("");
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
  const [showGroupProfile, setShowGroupProfile] = useState(false);
  const [groupProfileNameDraft, setGroupProfileNameDraft] = useState("");
  const [groupDescriptionDraft, setGroupDescriptionDraft] = useState("");
  const [groupProfileStatus, setGroupProfileStatus] = useState("");
  const [memberToAddId, setMemberToAddId] = useState("");
  const [subgroupNameDraft, setSubgroupNameDraft] = useState("");
  const [subgroupStatus, setSubgroupStatus] = useState("");
  const [selectedSubgroupMemberIds, setSelectedSubgroupMemberIds] = useState([]);
  const [savedStatus, setSavedStatus] = useState("");
  const [composerStatus, setComposerStatus] = useState("");
  const [replyingTo, setReplyingTo] = useState(null);
  const [showSpamWarning, setShowSpamWarning] = useState(false);
  const [isMobileLayout, setIsMobileLayout] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.innerWidth <= MOBILE_BREAKPOINT;
  });
  const [mobileScreen, setMobileScreen] = useState("list");
  const [mobileSubgroupsOpen, setMobileSubgroupsOpen] = useState(false);
  const [notificationPermission, setNotificationPermission] = useState(() => {
    if (typeof Notification === "undefined") return "unsupported";
    return Notification.permission;
  });
  const [fcmStatus, setFcmStatus] = useState("");
  const [blockedUserIds, setBlockedUserIds] = useState([]);
  const [mutedUserIds, setMutedUserIds] = useState([]);
  const [chatLocks, setChatLocks] = useState({});
  const [unlockedChatIds, setUnlockedChatIds] = useState([]);
  const [unlockPinDraft, setUnlockPinDraft] = useState("");
  const [unlockStatus, setUnlockStatus] = useState("");
  const [showRecovery, setShowRecovery] = useState(false);
  const [recoveryAnswerDraft, setRecoveryAnswerDraft] = useState("");
  const [newPinDraft, setNewPinDraft] = useState("");
  const mediaInputRef = useRef(null);
  const documentInputRef = useRef(null);
  const cameraInputRef = useRef(null);
  const composerFormRef = useRef(null);
  const messagesRef = useRef(null);
  const nearBottomRef = useRef(true);
  const lastScrollChatIdRef = useRef("");
  const lastMessageCountRef = useRef(0);
  const typingTextRef = useRef("");
  const chatsInitRef = useRef(false);
  const chatMetaRef = useRef(new Map());
  const requestsInitRef = useRef(false);
  const requestIdsRef = useRef(new Set());
  const firedEventKeysRef = useRef(new Set());
  const eventProcessingRef = useRef(new Set());
  const presenceHeartbeatRef = useRef(null);
  const messageSendTimesRef = useRef([]);
  const oneSignalReadyRef = useRef(false);
  const oneSignalScriptLoadingRef = useRef(null);

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
  const selectedChatIsLocked = useMemo(
    () => Boolean(selectedChatId && getChatLockConfig(chatLocks, selectedChatId) && !unlockedChatIds.includes(selectedChatId)),
    [selectedChatId, chatLocks, unlockedChatIds],
  );
  const selectedGroupRole = useMemo(
    () => getGroupRole(selectedChat, currentUser?.uid),
    [selectedChat, currentUser],
  );
  const canEditSelectedGroupCore = useMemo(
    () => canManageGroupCore(selectedChat, currentUser?.uid),
    [selectedChat, currentUser],
  );
  const canManageSelectedSubgroups = useMemo(
    () => canManageGroupSubgroups(selectedChat, currentUser?.uid),
    [selectedChat, currentUser],
  );
  const activeGroupRootId = useMemo(() => {
    if (!selectedChat?.isGroup) return "";
    return selectedChat.parentGroupId || selectedChat.id;
  }, [selectedChat]);
  const selectedGroupSubgroups = useMemo(() => {
    if (!activeGroupRootId) return [];
    return chats.filter((chat) => chat.parentGroupId === activeGroupRootId);
  }, [chats, activeGroupRootId]);
  const activeGroupRoot = useMemo(() => {
    if (!activeGroupRootId) return null;
    if (selectedChat?.id === activeGroupRootId) return selectedChat;
    return chats.find((chat) => chat.id === activeGroupRootId) || null;
  }, [activeGroupRootId, selectedChat, chats]);
  const mainChatList = useMemo(
    () =>
      chats.filter((chat) => {
        if (chat.isSubgroup) return false;
        if (chat.isGroup) return true;
        const otherId = (chat.members || []).find((id) => id !== currentUser?.uid);
        return otherId ? !blockedUserIds.includes(otherId) : true;
      }),
    [chats, currentUser, blockedUserIds],
  );
  const subgroupNavItems = useMemo(() => {
    if (!activeGroupRoot) return [];
    return [activeGroupRoot, ...selectedGroupSubgroups.filter((chat) => chat.id !== activeGroupRoot.id)];
  }, [activeGroupRoot, selectedGroupSubgroups]);
  const selectedGroupMembers = useMemo(() => {
    if (!selectedChat?.isGroup) return [];
    return (selectedChat.members || []).map((uid) => ({
      uid,
      user: usersById.get(uid) || null,
      role: getGroupRole(selectedChat, uid),
    }));
  }, [selectedChat, usersById]);

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
  const addableGroupFriends = useMemo(() => {
    if (!selectedChat?.isGroup) return [];
    const memberSet = new Set(selectedChat.members || []);
    return availableGroupFriends.filter((friend) => !memberSet.has(friend.id));
  }, [availableGroupFriends, selectedChat]);
  const subgroupCandidateMembers = useMemo(() => {
    if (!selectedChat?.isGroup) return [];
    return (selectedChat.members || [])
      .filter((uid) => uid !== currentUser?.uid)
      .map((uid) => usersById.get(uid))
      .filter(Boolean);
  }, [selectedChat, usersById, currentUser]);
  const savedMessageIds = useMemo(() => new Set(savedMessages.map((item) => item.id)), [savedMessages]);
  const visibleMessages = useMemo(() => {
    if (!selectedChat || selectedChat.isGroup || !currentUser) return messages;
    const otherId = (selectedChat.members || []).find((id) => id !== currentUser.uid);
    if (!otherId || !blockedUserIds.includes(otherId)) return messages;
    return messages.filter((item) => item.senderId === currentUser.uid);
  }, [messages, selectedChat, currentUser, blockedUserIds]);
  const groupedMessages = useMemo(() => {
    const groups = [];
    for (const message of visibleMessages) {
      const prev = groups[groups.length - 1];
      if (prev && prev.senderId === message.senderId) {
        prev.items.push(message);
      } else {
        groups.push({
          id: message.id,
          senderId: message.senderId || "",
          items: [message],
        });
      }
    }
    return groups;
  }, [visibleMessages]);

  function buildSavedId(chatId, messageId) {
    return `${chatId}_${messageId}`;
  }

  function getSessionKey(name) {
    const uid = currentUser?.uid || "guest";
    return `textinger_${name}_${uid}`;
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
    setMobileSubgroupsOpen(false);
  }

  function handleComposerKeyDown(event) {
    if (event.key !== "Enter") return;
    if (isMobileLayout) return;
    if (event.shiftKey) return;
    event.preventDefault();
    composerFormRef.current?.requestSubmit();
  }

  function beginReplyToMessage(message) {
    if (!message) return;
    const senderUser = usersById.get(message.senderId);
    const senderName =
      message.senderId === currentUser?.uid
        ? username
        : senderUser?.username || message.senderName || message.user || "User";
    const preview =
      truncateText((message.text || "").trim(), 80) ||
      (message.mediaType?.startsWith("image/")
        ? "Photo"
        : message.mediaType?.startsWith("video/")
          ? "Video"
          : message.mediaType?.startsWith("audio/")
            ? "Audio"
            : message.mediaURL
              ? "File"
              : "Message");
    setReplyingTo({
      id: message.id,
      senderId: message.senderId || "",
      senderName,
      text: preview,
    });
    setOpenMessageMenuId("");
  }

  function attachReplyMetadata(payload) {
    if (!replyingTo?.id) return payload;
    return {
      ...payload,
      replyToMessageId: replyingTo.id,
      replyToSenderId: replyingTo.senderId || "",
      replyToSenderName: replyingTo.senderName || "User",
      replyToText: replyingTo.text || "",
    };
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
    setShowGroupProfile(false);
    setViewedUserId("");
    setGroupProfileStatus("");
    setSubgroupStatus("");
  }

  function toggleGroupMember(uid) {
    setSelectedGroupMemberIds((prev) =>
      prev.includes(uid) ? prev.filter((id) => id !== uid) : [...prev, uid],
    );
  }

  function toggleSubgroupMember(uid) {
    setSelectedSubgroupMemberIds((prev) =>
      prev.includes(uid) ? prev.filter((id) => id !== uid) : [...prev, uid],
    );
  }

  function openGroupProfilePopup() {
    if (!selectedChat?.isGroup) return;
    setShowGroupProfile(true);
    setShowAddFriend(false);
    setShowCreateGroup(false);
    setShowNotifications(false);
    setShowProfile(false);
    setShowEventScheduler(false);
    setGroupProfileNameDraft(selectedChat.groupName || "");
    setGroupDescriptionDraft(selectedChat.groupDescription || "");
    setGroupProfileStatus("");
    setSubgroupNameDraft("");
    setSubgroupStatus("");
    setSelectedSubgroupMemberIds([]);
    setMemberToAddId("");
  }

  function pushBrowserNotification(title, body) {
    if (typeof window === "undefined" || typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return;
    const isVisible = document.visibilityState === "visible";
    const isMobileDevice = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || "");
    if (isVisible && !isMobileDevice) return;
    if (isMobileDevice && "serviceWorker" in navigator) {
      navigator.serviceWorker
        .getRegistration()
        .then((registration) =>
          registration?.showNotification(title, {
            body,
            icon: "/app-logo.png",
            badge: "/app-logo.png",
            tag: "textinger-mobile-alert",
            renotify: true,
            data: { link: "/" },
          }),
        )
        .catch(() => {});
      return;
    }
    try {
      const notification = new Notification(title, { body });
      setTimeout(() => notification.close(), 6000);
    } catch {}
  }

  async function ensureOneSignalLoaded() {
    if (typeof window === "undefined" || !ONE_SIGNAL_APP_ID) return null;
    if (window.OneSignal) return window.OneSignal;
    if (oneSignalScriptLoadingRef.current) {
      await oneSignalScriptLoadingRef.current;
      return window.OneSignal || null;
    }

    oneSignalScriptLoadingRef.current = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.js";
      script.defer = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("OneSignal SDK failed to load."));
      document.head.appendChild(script);
    });

    try {
      await oneSignalScriptLoadingRef.current;
      return window.OneSignal || null;
    } finally {
      oneSignalScriptLoadingRef.current = null;
    }
  }

  async function initOneSignalForCurrentUser() {
    if (!currentUser || !ONE_SIGNAL_APP_ID || typeof window === "undefined") return false;
    const OneSignal = await ensureOneSignalLoaded();
    if (!OneSignal) return false;

    if (!oneSignalReadyRef.current) {
      await OneSignal.init({
        appId: ONE_SIGNAL_APP_ID,
        serviceWorkerPath: "/OneSignalSDKWorker.js",
        serviceWorkerUpdaterPath: "/OneSignalSDKUpdaterWorker.js",
        notifyButton: { enable: false },
      });
      oneSignalReadyRef.current = true;
    }

    await OneSignal.login(currentUser.uid);
    await setDoc(
      doc(db, "users", currentUser.uid),
      {
        oneSignalExternalId: currentUser.uid,
        oneSignalLinkedAt: serverTimestamp(),
      },
      { merge: true },
    );
    return true;
  }

  async function sendClosedAppNotification(recipientIds, title, body, chatId) {
    if (!ONE_SIGNAL_NOTIFY_URL || !Array.isArray(recipientIds) || recipientIds.length === 0) return;
    try {
      await fetch(ONE_SIGNAL_NOTIFY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipientIds,
          title: title || "Textinger",
          body: body || "You have a new message.",
          chatId: chatId || "",
        }),
      });
    } catch {
      // OneSignal relay is best-effort and should not block messaging.
    }
  }

  async function registerMessagingServiceWorker() {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return null;
    return navigator.serviceWorker.register("/firebase-messaging-sw.js");
  }

  async function enablePushNotificationsForCurrentUser() {
    if (!currentUser) {
      setFcmStatus("Sign in first, then enable push notifications.");
      return;
    }

    const vapidKey = import.meta.env.VITE_FIREBASE_VAPID_KEY;
    if (!vapidKey) {
      setFcmStatus("Missing VITE_FIREBASE_VAPID_KEY in .env.");
      return;
    }

    const messaging = await getFirebaseMessaging();
    if (!messaging) {
      setFcmStatus("Push messaging is not supported in this browser.");
      return;
    }

    const registration = await registerMessagingServiceWorker();
    if (!registration) {
      setFcmStatus("Service worker is not available for push notifications.");
      return;
    }

    const token = await getToken(messaging, { vapidKey, serviceWorkerRegistration: registration });
    if (!token) {
      setFcmStatus("Could not get an FCM token for this device.");
      return;
    }

    await setDoc(
      doc(db, "users", currentUser.uid),
      {
        fcmTokens: arrayUnion(token),
        pushEnabledAt: serverTimestamp(),
      },
      { merge: true },
    );
    await initOneSignalForCurrentUser().catch(() => false);
    setFcmStatus("Push notifications enabled on this device.");
  }

  async function requestNotificationPermission() {
    if (typeof Notification === "undefined") {
      setNotificationPermission("unsupported");
      setFcmStatus("Notifications are not supported in this browser.");
      return;
    }
    try {
      const result = await Notification.requestPermission();
      setNotificationPermission(result);
      if (result !== "granted") {
        setFcmStatus("Notification permission was not granted.");
        return;
      }
      await enablePushNotificationsForCurrentUser();
      const oneSignalReady = await initOneSignalForCurrentUser().catch(() => false);
      if (oneSignalReady && window.OneSignal?.Notifications?.permission !== "granted") {
        await window.OneSignal.Notifications.requestPermission();
      }
    } catch {
      setNotificationPermission(Notification.permission);
      setFcmStatus("Failed to enable push notifications.");
    }
  }

  function handleListenerError(error) {
    if (isPermissionDenied(error)) {
      setAuthError("Access blocked by Firestore rules. Update your Firestore rules and try again.");
      signOut(auth).catch(() => {});
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
    registerMessagingServiceWorker().catch(() => {});
  }, []);

  useEffect(() => {
    if (!currentUser) {
      if (window.OneSignal && oneSignalReadyRef.current) {
        window.OneSignal.logout().catch(() => {});
      }
      setFcmStatus("");
      return;
    }
    if (notificationPermission !== "granted") return;
    enablePushNotificationsForCurrentUser().catch(() => {});
  }, [currentUser, notificationPermission]);

  useEffect(() => {
    if (notificationPermission !== "granted") return undefined;
    let unsub = () => {};
    getFirebaseMessaging()
      .then((messaging) => {
        if (!messaging) return;
        unsub = onMessage(messaging, (payload) => {
          const title = payload.notification?.title || payload.data?.title || "Textinger";
          const body = payload.notification?.body || payload.data?.body || "You have a new notification.";
          pushBrowserNotification(title, body);
        });
      })
      .catch(() => {});
    return () => unsub();
  }, [notificationPermission]);

  useEffect(() => {
    if (!currentUser) return undefined;

    const userDocUnsub = onSnapshot(
      doc(db, "users", currentUser.uid),
      (snap) => {
        setUserProfile(snap.exists() ? { id: snap.id, ...snap.data() } : null);
      },
      handleListenerError,
    );

    const usersUnsub = onSnapshot(
      collection(db, "users"),
      (snapshot) => {
        setUsers(snapshot.docs.map((d) => ({ id: d.id, ...d.data() })));
      },
      handleListenerError,
    );

    const chatsUnsub = onSnapshot(
      query(collection(db, "chats"), where("members", "array-contains", currentUser.uid)),
      (snapshot) => {
        const list = snapshot.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          .sort((a, b) => (b.updatedAt?.toMillis?.() || 0) - (a.updatedAt?.toMillis?.() || 0));
        setChats(list);
      },
      handleListenerError,
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
      handleListenerError,
    );

    const savedUnsub = onSnapshot(
      collection(db, "users", currentUser.uid, "savedMessages"),
      (snapshot) => {
        const list = snapshot.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          .sort((a, b) => (b.savedAt?.toMillis?.() || 0) - (a.savedAt?.toMillis?.() || 0));
        setSavedMessages(list);
      },
      handleListenerError,
    );

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
    if (!selectedChatId && chats.length > 0) {
      const storedId =
        typeof window !== "undefined" && currentUser
          ? localStorage.getItem(getSessionKey("last_chat"))
          : "";
      if (storedId && chats.some((chat) => chat.id === storedId)) {
        setSelectedChatId(storedId);
      } else {
        setSelectedChatId(chats[0].id);
      }
    }
    if (chats.length === 0) {
      setSelectedChatId("");
      setMessages([]);
    }
  }, [chats, selectedChatId, currentUser]);

  useEffect(() => {
    if (!currentUser || !selectedChatId || typeof window === "undefined") return;
    localStorage.setItem(getSessionKey("last_chat"), selectedChatId);
  }, [currentUser, selectedChatId]);

  useEffect(() => {
    if (!isMobileLayout) return;
    if (!selectedChatId) setMobileScreen("list");
  }, [isMobileLayout, selectedChatId]);

  useEffect(() => {
    if (!isMobileLayout) {
      setMobileSubgroupsOpen(false);
    }
  }, [isMobileLayout, selectedChatId]);

  useEffect(() => {
    setUnlockPinDraft("");
    setUnlockStatus("");
    setShowRecovery(false);
    setRecoveryAnswerDraft("");
    setNewPinDraft("");
    setReplyingTo(null);
  }, [selectedChatId]);

  useEffect(() => {
    if (!selectedChatId) return undefined;
    setMessagesLoading(true);
    const unsub = onSnapshot(
      query(collection(db, "chats", selectedChatId, "messages"), orderBy("createdAt", "asc")),
      (snapshot) => {
        setMessages(snapshot.docs.map((d) => ({ id: d.id, ...d.data() })));
        setMessagesLoading(false);
      },
      () => {
        setMessagesLoading(false);
      },
    );
    return () => unsub();
  }, [selectedChatId]);

  useEffect(() => {
    if (!selectedChatId || !messagesRef.current) return;
    if (lastScrollChatIdRef.current !== selectedChatId) {
      const target = messagesRef.current;
      requestAnimationFrame(() => {
        target.scrollTop = target.scrollHeight;
        nearBottomRef.current = true;
      });
      lastScrollChatIdRef.current = selectedChatId;
      lastMessageCountRef.current = messages.length;
      return;
    }

    const hasNewMessages = messages.length > lastMessageCountRef.current;
    if (hasNewMessages && nearBottomRef.current) {
      const target = messagesRef.current;
      requestAnimationFrame(() => {
        target.scrollTop = target.scrollHeight;
      });
    }
    lastMessageCountRef.current = messages.length;
  }, [selectedChatId, messages.length]);

  useEffect(() => {
    if (!messagesRef.current) return undefined;
    const target = messagesRef.current;
    const onScroll = () => {
      const distanceFromBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
      nearBottomRef.current = distanceFromBottom <= 140;
    };
    onScroll();
    target.addEventListener("scroll", onScroll);
    return () => target.removeEventListener("scroll", onScroll);
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

    const typingUnsub = onSnapshot(
      collection(db, "chats", selectedChatId, "typing"),
      (snapshot) => {
        const list = snapshot.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          .filter((entry) => entry.id !== currentUser.uid && entry.isTyping);
        setTypingStreams(list);
      },
      () => {},
    );

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
    if (!mediaFile) {
      setMediaPreviewURL("");
      return undefined;
    }
    if (!(mediaFile.type || "").startsWith("image/") && !(mediaFile.type || "").startsWith("video/")) {
      setMediaPreviewURL("");
      return undefined;
    }
    const url = URL.createObjectURL(mediaFile);
    setMediaPreviewURL(url);
    return () => URL.revokeObjectURL(url);
  }, [mediaFile]);

  useEffect(() => {
    if (!currentUser || typeof window === "undefined") return;
    const key = `textinger_privacy_${currentUser.uid}`;
    try {
      const parsed = JSON.parse(localStorage.getItem(key) || "{}");
      setBlockedUserIds(Array.isArray(parsed.blockedUserIds) ? parsed.blockedUserIds : []);
      setMutedUserIds(Array.isArray(parsed.mutedUserIds) ? parsed.mutedUserIds : []);
      setChatLocks(parsed.chatLocks && typeof parsed.chatLocks === "object" ? parsed.chatLocks : {});
    } catch {
      setBlockedUserIds([]);
      setMutedUserIds([]);
      setChatLocks({});
    }
    setUnlockedChatIds([]);
  }, [currentUser]);

  useEffect(() => {
    if (!currentUser || typeof window === "undefined") return;
    const key = `textinger_privacy_${currentUser.uid}`;
    localStorage.setItem(
      key,
      JSON.stringify({
        blockedUserIds,
        mutedUserIds,
        chatLocks,
      }),
    );
  }, [currentUser, blockedUserIds, mutedUserIds, chatLocks]);

  useEffect(() => {
    if (!showGroupProfile || !selectedChat?.isGroup) return;
    setGroupProfileNameDraft(selectedChat.groupName || "");
    setGroupDescriptionDraft(selectedChat.groupDescription || "");
  }, [showGroupProfile, selectedChat]);

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
      if (!chat.isGroup && otherUid && blockedUserIds.includes(otherUid)) continue;
      if (!chat.isGroup && otherUid && mutedUserIds.includes(otherUid)) continue;
      const other = otherUid ? usersById.get(otherUid) : null;
      const chatTitle = chat.isGroup
        ? chat.groupName || "Group Chat"
        : other?.username || "New Message";
      pushBrowserNotification(chatTitle, currentMeta.lastMessage || "You have a new message.");
    }

    chatMetaRef.current = nextMap;
  }, [chats, currentUser, usersById, selectedChatId, blockedUserIds, mutedUserIds]);

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

  function toggleBlockedUser(userId) {
    if (!userId) return;
    setBlockedUserIds((prev) =>
      prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId],
    );
  }

  function toggleMutedUser(userId) {
    if (!userId) return;
    setMutedUserIds((prev) =>
      prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId],
    );
  }

  function toggleChatLockForUser(userId) {
    if (!currentUser || !userId) return;
    const chatId = buildChatId(currentUser.uid, userId);
    const lockConfig = getChatLockConfig(chatLocks, chatId);
    if (lockConfig) {
      const enteredPin = window.prompt("Enter current PIN to permanently unlock this chat:");
      if (!enteredPin) return;
      if (enteredPin.trim() !== lockConfig.pin) {
        setProfileStatus("Incorrect PIN. Could not unlock chat permanently.");
        return;
      }
      setChatLocks((prev) => {
        const next = { ...prev };
        delete next[chatId];
        return next;
      });
      setUnlockedChatIds((prev) => prev.filter((id) => id !== chatId));
      setProfileStatus("Chat lock removed permanently.");
      return;
    }
    const pin = window.prompt("Set a 4-digit PIN for this chat lock:");
    if (!pin) return;
    if (!/^\d{4}$/.test(pin.trim())) {
      setProfileStatus("PIN must be exactly 4 digits.");
      return;
    }
    const answer = window.prompt("Security question setup: What is your best friend name?");
    if (!answer?.trim()) {
      setProfileStatus("Security answer is required to enable chat lock.");
      return;
    }
    setChatLocks((prev) => ({
      ...prev,
      [chatId]: {
        pin: pin.trim(),
        recoveryAnswer: answer.trim().toLowerCase(),
      },
    }));
    setUnlockedChatIds((prev) => (prev.includes(chatId) ? prev : [...prev, chatId]));
    setProfileStatus("Chat lock enabled.");
  }

  function unlockCurrentChat() {
    if (!selectedChatId) return;
    const lockConfig = getChatLockConfig(chatLocks, selectedChatId);
    if (!lockConfig) return;
    if (unlockPinDraft.trim() !== lockConfig.pin) {
      setUnlockStatus("Incorrect PIN.");
      return;
    }
    setUnlockedChatIds((prev) => (prev.includes(selectedChatId) ? prev : [...prev, selectedChatId]));
    setUnlockPinDraft("");
    setUnlockStatus("");
  }

  function recoverLockedChat() {
    if (!selectedChatId) return;
    const lockConfig = getChatLockConfig(chatLocks, selectedChatId);
    if (!lockConfig) return;
    const normalized = recoveryAnswerDraft.trim().toLowerCase();
    if (!normalized || normalized !== lockConfig.recoveryAnswer) {
      setUnlockStatus("Incorrect answer for recovery question.");
      return;
    }
    if (!/^\d{4}$/.test(newPinDraft.trim())) {
      setUnlockStatus("Set a valid new 4-digit PIN.");
      return;
    }
    setChatLocks((prev) => ({
      ...prev,
      [selectedChatId]: {
        pin: newPinDraft.trim(),
        recoveryAnswer: lockConfig.recoveryAnswer,
      },
    }));
    setUnlockedChatIds((prev) => (prev.includes(selectedChatId) ? prev : [...prev, selectedChatId]));
    setUnlockStatus("PIN reset successful. Chat unlocked.");
    setShowRecovery(false);
    setRecoveryAnswerDraft("");
    setNewPinDraft("");
    setUnlockPinDraft("");
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
          } catch (capacityError) {
            // Do not block signup when optional capacity checks are denied by rules.
            if (!isPermissionDenied(capacityError)) throw capacityError;
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
          await sendEmailVerification(cred.user).catch(() => {});
          setAuthError("Account created. Verification email sent.");
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
        await cred.user.reload();
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
          const isAlreadyActive = activeUserIds.has(cred.user.uid);
          if (!isAlreadyActive && activeUserIds.size >= MAX_ACTIVE_USERS) {
            await signOut(auth);
            setCapacityError(`Try later: max ${MAX_ACTIVE_USERS} active users reached.`);
            return;
          }
        } catch (capacityError) {
          // Do not block login when optional capacity checks are denied by rules.
          if (!isPermissionDenied(capacityError)) throw capacityError;
        }
      }

      setAuthForm({ email, password: "", username: "" });
    } catch (error) {
      setAuthError(normalizeAuthError(error));
    } finally {
      setBusyLabel("");
    }
  }

  async function handleForgotPasswordSubmit(event) {
    event.preventDefault();
    setForgotStatus("");
    const email = forgotEmail.trim().toLowerCase();
    if (!email) {
      setForgotStatus("Please enter your email.");
      return;
    }

    try {
      setBusyLabel("Sending reset email...");
      await sendPasswordResetEmail(auth, email);
      setForgotStatus("If this email is registered, a password reset mail has been sent.");
    } catch {
      setForgotStatus("Unable to process reset right now. Please try again.");
    } finally {
      setBusyLabel("");
    }
  }

  async function sendPayload(payload, options = {}) {
    if (!selectedChat || !currentUser) return;
    await addDoc(collection(db, "chats", selectedChat.id, "messages"), payload);
    const lastMessage =
      options.lastMessage ||
      payload.text ||
      (payload.mediaType?.startsWith("image/")
        ? "Photo"
        : payload.mediaType?.startsWith("video/")
          ? "Video"
          : payload.mediaType?.startsWith("audio/")
            ? "Audio"
            : payload.mediaURL
              ? "File"
              : "No messages yet");
    await updateDoc(doc(db, "chats", selectedChat.id), {
      lastMessage,
      lastSenderId: payload.senderId || currentUser.uid,
      updatedAt: serverTimestamp(),
    });

    const recipientIds = (selectedChat.members || [])
      .filter((uid) => uid && uid !== currentUser.uid)
      .filter((uid) => {
        const recipient = usersById.get(uid);
        if (!recipient) return true;
        return recipient.isOnline !== true;
      });
    if (recipientIds.length > 0) {
      const title = selectedChat.isGroup
        ? `${selectedChat.groupName || "Group"}`
        : username;
      await sendClosedAppNotification(recipientIds, title, lastMessage, selectedChat.id);
    }
  }

  async function sendMessage(event) {
    event.preventDefault();
    if (!selectedChat || !currentUser || (!text.trim() && !mediaFile) || sending || selectedChatIsLocked) return;
    if (!selectedChat.isGroup && selectedChatOtherUser && blockedUserIds.includes(selectedChatOtherUser.id)) {
      setComposerStatus("Unblock this user first to send messages.");
      return;
    }
    if (mediaFile && mediaFile.size > MAX_UPLOAD_BYTES) {
      setMediaFile(null);
      setComposerStatus("Upload blocked: file must be 7MB or smaller.");
      return;
    }
    if (!checkMessageRateLimit()) return;

    setSending(true);
    try {
      setComposerStatus("");
      if (mediaFile) setBusyLabel("Uploading media...");
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

      const payload = attachReplyMetadata({
        senderId: currentUser.uid,
        senderName: username,
        text: text.trim(),
        mediaURL,
        mediaType,
        mediaName,
        mediaSize,
        createdAt: serverTimestamp(),
      });

      await sendPayload(payload);
      setText("");
      setReplyingTo(null);
      typingTextRef.current = "";
      await clearTypingState();
      setMediaFile(null);
      setAttachMenuOpen(false);
    } finally {
      setSending(false);
      setBusyLabel("");
    }
  }

  async function sendContactCard() {
    if (!selectedChat || !currentUser || sending || selectedChatIsLocked) return;
    if (!selectedChat.isGroup && selectedChatOtherUser && blockedUserIds.includes(selectedChatOtherUser.id)) {
      setComposerStatus("Unblock this user first to send messages.");
      return;
    }
    const name = window.prompt("Contact name");
    if (!name?.trim()) return;
    const phone = window.prompt("Contact phone number");
    if (!phone?.trim()) return;
    setBusyLabel("Sending contact...");
    try {
      await sendPayload(
        attachReplyMetadata({
          senderId: currentUser.uid,
          senderName: username,
          text: `Contact: ${name.trim()} (${phone.trim()})`,
          messageType: "contact",
          contactName: name.trim(),
          contactPhone: phone.trim(),
          createdAt: serverTimestamp(),
        }),
        { lastMessage: `Contact: ${name.trim()}` },
      );
      setReplyingTo(null);
      setAttachMenuOpen(false);
    } finally {
      setBusyLabel("");
    }
  }

  async function sendCurrentLocation() {
    if (!selectedChat || !currentUser || sending || selectedChatIsLocked) return;
    if (!selectedChat.isGroup && selectedChatOtherUser && blockedUserIds.includes(selectedChatOtherUser.id)) {
      setComposerStatus("Unblock this user first to send messages.");
      return;
    }
    if (!navigator.geolocation) {
      setComposerStatus("Location is not supported in this browser.");
      return;
    }
    setBusyLabel("Fetching location...");
    try {
      const position = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 10000,
        });
      });
      const latitude = Number(position.coords.latitude || 0);
      const longitude = Number(position.coords.longitude || 0);
      const mapsURL = `https://maps.google.com/?q=${latitude},${longitude}`;
      await sendPayload(
        attachReplyMetadata({
          senderId: currentUser.uid,
          senderName: username,
          text: `Location: ${mapsURL}`,
          messageType: "location",
          location: { latitude, longitude },
          createdAt: serverTimestamp(),
        }),
        { lastMessage: "Location shared" },
      );
      setReplyingTo(null);
      setAttachMenuOpen(false);
    } catch {
      setComposerStatus("Unable to fetch location.");
    } finally {
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
    const message = messages.find((entry) => entry.id === messageId);
    if (!canDeleteGroupMessage(selectedChat, message, currentUser?.uid)) return;
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
      const groupRoles = members.reduce((acc, uid) => {
        acc[uid] = uid === currentUser.uid ? "owner" : "member";
        return acc;
      }, {});
      const groupRef = await addDoc(collection(db, "chats"), {
        isGroup: true,
        groupName: name,
        groupDescription: "",
        groupPhotoURL,
        members,
        groupRoles,
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

  async function saveGroupProfile() {
    if (!currentUser || !selectedChat?.isGroup) return;
    if (!canManageGroupCore(selectedChat, currentUser.uid)) {
      setGroupProfileStatus("Only the creator or an owner can edit this group.");
      return;
    }

    const nextName = groupProfileNameDraft.trim();
    if (!nextName) {
      setGroupProfileStatus("Group name is required.");
      return;
    }

    setBusyLabel("Saving group profile...");
    setGroupProfileStatus("");
    try {
      await updateDoc(doc(db, "chats", selectedChat.id), {
        groupName: nextName,
        groupDescription: groupDescriptionDraft.trim(),
        updatedAt: serverTimestamp(),
      });
      setGroupProfileStatus("Group profile updated.");
    } catch (error) {
      setGroupProfileStatus(error.message || "Failed to update group profile.");
    } finally {
      setBusyLabel("");
    }
  }

  async function addMemberToGroup(memberId) {
    if (!currentUser || !selectedChat?.isGroup || !memberId) return;
    if (!canManageGroupCore(selectedChat, currentUser.uid)) {
      setGroupProfileStatus("Only the creator or an owner can add members.");
      return;
    }

    setBusyLabel("Adding member...");
    setGroupProfileStatus("");
    try {
      const chatRef = doc(db, "chats", selectedChat.id);
      await runTransaction(db, async (transaction) => {
        const snap = await transaction.get(chatRef);
        if (!snap.exists()) throw new Error("Group no longer exists.");
        const data = snap.data();
        if (!canManageGroupCore(data, currentUser.uid)) {
          throw new Error("Permission denied.");
        }
        const members = Array.isArray(data.members) ? [...data.members] : [];
        if (members.includes(memberId)) return;
        members.push(memberId);
        const roles = { ...(data.groupRoles || {}) };
        if (!GROUP_ROLES.includes(roles[memberId])) roles[memberId] = "member";
        transaction.update(chatRef, {
          members,
          groupRoles: roles,
          updatedAt: serverTimestamp(),
        });
      });
      setMemberToAddId("");
      setGroupProfileStatus("Member added.");
    } catch (error) {
      setGroupProfileStatus(error.message || "Failed to add member.");
    } finally {
      setBusyLabel("");
    }
  }

  async function removeMemberFromGroup(memberId) {
    if (!currentUser || !selectedChat?.isGroup || !memberId) return;
    if (!canManageGroupCore(selectedChat, currentUser.uid)) {
      setGroupProfileStatus("Only the creator or an owner can remove members.");
      return;
    }
    if (memberId === selectedChat.createdBy) {
      setGroupProfileStatus("The creator cannot be removed.");
      return;
    }

    setBusyLabel("Removing member...");
    setGroupProfileStatus("");
    try {
      const chatRef = doc(db, "chats", selectedChat.id);
      await runTransaction(db, async (transaction) => {
        const snap = await transaction.get(chatRef);
        if (!snap.exists()) throw new Error("Group no longer exists.");
        const data = snap.data();
        if (!canManageGroupCore(data, currentUser.uid)) throw new Error("Permission denied.");
        if (memberId === data.createdBy) throw new Error("The creator cannot be removed.");
        const members = (Array.isArray(data.members) ? data.members : []).filter((uid) => uid !== memberId);
        const roles = { ...(data.groupRoles || {}) };
        delete roles[memberId];
        transaction.update(chatRef, {
          members,
          groupRoles: roles,
          updatedAt: serverTimestamp(),
        });
      });
      setGroupProfileStatus("Member removed.");
    } catch (error) {
      setGroupProfileStatus(error.message || "Failed to remove member.");
    } finally {
      setBusyLabel("");
    }
  }

  async function updateGroupMemberRole(memberId, nextRole) {
    if (!currentUser || !selectedChat?.isGroup || !memberId) return;
    if (!GROUP_ROLES.includes(nextRole)) return;
    if (!canManageGroupCore(selectedChat, currentUser.uid)) {
      setGroupProfileStatus("Only the creator or an owner can change roles.");
      return;
    }

    setBusyLabel("Updating role...");
    setGroupProfileStatus("");
    try {
      const chatRef = doc(db, "chats", selectedChat.id);
      await runTransaction(db, async (transaction) => {
        const snap = await transaction.get(chatRef);
        if (!snap.exists()) throw new Error("Group no longer exists.");
        const data = snap.data();
        if (!canManageGroupCore(data, currentUser.uid)) throw new Error("Permission denied.");
        if (memberId === data.createdBy) throw new Error("Creator role cannot be changed.");
        const members = Array.isArray(data.members) ? data.members : [];
        if (!members.includes(memberId)) throw new Error("User is not in this group.");
        const roles = { ...(data.groupRoles || {}) };
        roles[memberId] = nextRole;
        transaction.update(chatRef, {
          groupRoles: roles,
          updatedAt: serverTimestamp(),
        });
      });
      setGroupProfileStatus("Role updated.");
    } catch (error) {
      setGroupProfileStatus(error.message || "Failed to update role.");
    } finally {
      setBusyLabel("");
    }
  }

  async function createSubgroup() {
    if (!currentUser || !selectedChat?.isGroup) return;
    if (!canManageGroupSubgroups(selectedChat, currentUser.uid)) {
      setSubgroupStatus("Only creator, owner, or admin can create subgroups.");
      return;
    }
    const name = subgroupNameDraft.trim();
    if (!name) {
      setSubgroupStatus("Subgroup name is required.");
      return;
    }

    const parentMembers = new Set(selectedChat.members || []);
    const filteredMemberIds = selectedSubgroupMemberIds.filter((uid) => parentMembers.has(uid));
    const members = Array.from(new Set([currentUser.uid, ...filteredMemberIds]));
    const groupRoles = members.reduce((acc, uid) => {
      acc[uid] = uid === currentUser.uid ? "owner" : "member";
      return acc;
    }, {});

    setBusyLabel("Creating subgroup...");
    setSubgroupStatus("");
    try {
      const subgroupRef = await addDoc(collection(db, "chats"), {
        isGroup: true,
        isSubgroup: true,
        parentGroupId: selectedChat.id,
        groupName: name,
        groupDescription: "",
        groupPhotoURL: "",
        members,
        groupRoles,
        createdBy: currentUser.uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        lastMessage: "No messages yet",
        lastSenderId: "",
      });
      await updateDoc(doc(db, "chats", selectedChat.id), {
        subgroupIds: arrayUnion(subgroupRef.id),
        updatedAt: serverTimestamp(),
      });
      setSubgroupNameDraft("");
      setSelectedSubgroupMemberIds([]);
      setSubgroupStatus("Subgroup created.");
    } catch (error) {
      setSubgroupStatus(error.message || "Failed to create subgroup.");
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
          <p>Email and password login with username registration.</p>
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
            {authMode === "login" && (
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  setForgotEmail(authForm.email || "");
                  setForgotStatus("");
                  setShowForgotPassword(true);
                }}
              >
                Forgot Password?
              </button>
            )}
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
        {showForgotPassword && (
          <div className="popupBackdrop" onClick={() => setShowForgotPassword(false)}>
            <section className="popupCard" onClick={(event) => event.stopPropagation()}>
              <div className="popupHead">
                <h3>Reset Password</h3>
                <button type="button" className="ghost" onClick={() => setShowForgotPassword(false)}>
                  Close
                </button>
              </div>
              <form className="stack" onSubmit={handleForgotPasswordSubmit}>
                <input
                  type="email"
                  placeholder="Registered email"
                  value={forgotEmail}
                  onChange={(event) => setForgotEmail(event.target.value)}
                  required
                />
                <button type="submit">Send Reset Mail</button>
              </form>
              {forgotStatus && <p className="muted">{forgotStatus}</p>}
            </section>
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
            {isMobileLayout && (
              <button type="button" className="ghost" onClick={openProfilePopup}>
                Profile
              </button>
            )}
          </div>
        </div>

        <div className="chatList">
          {mainChatList.length === 0 && <p className="muted">There is no message here.</p>}
          {mainChatList.map((chat) => {
            const otherUid = (chat.members || []).find((member) => member !== currentUser.uid);
            const other = otherUid ? usersById.get(otherUid) : null;
            const name = chat.isGroup ? chat.groupName || "Unnamed Group" : other?.username || "Unknown user";
            const photo = chat.isGroup ? chat.groupPhotoURL || "" : other?.photoURL || "";
            const showOnline = !chat.isGroup;
            const chatUserOnline = showOnline && isUserOnline(other);
            const preview = truncateText(chat.lastMessage || "No messages yet");
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
                  onClick={(event) => {
                    event.stopPropagation();
                    if (!chat.isGroup && otherUid) openUserProfileView(otherUid);
                  }}
                />
                <span className="chatMeta">
                  <strong>{truncateText(name, 24)}</strong>
                  <small>{preview}</small>
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
              {selectedChat?.isGroup ? (
                <button type="button" className="groupTitleBtn" onClick={openGroupProfilePopup}>
                  {selectedChat.groupName || "Unnamed Group"}
                </button>
              ) : (
                selectedChatOtherUser?.username || "Textinger"
              )}
              {!selectedChat?.isGroup && (
                <span className={`userStatusText ${isSelectedUserOnline ? "online" : "offline"}`}>
                  {isSelectedUserOnline ? "Online" : "Offline"}
                </span>
              )}
            </h1>
            <small>
              {selectedChat?.isGroup
                ? `${selectedChat.members?.length || 0} members • ${roleLabel(selectedGroupRole)}${selectedChat?.isSubgroup ? " • Subgroup" : ""}`
                : isSelectedUserOnline
                  ? "Online"
                  : "Offline"}
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
            {isMobileLayout && selectedChat?.isGroup && (
              <button
                type="button"
                className="ghost mobileSubgroupToggle"
                onClick={() => setMobileSubgroupsOpen((prev) => !prev)}
              >
                {mobileSubgroupsOpen ? "→" : "←"}
              </button>
            )}
          </div>
        </header>

        <div className={`panelBody ${selectedChat?.isGroup ? "withSubgroups" : ""} ${selectedChatIsLocked ? "chatLocked" : ""}`}>
        <section className="messageArea">
          {selectedChat ? (
            <>
              <div className="messages" ref={messagesRef}>
                {messagesLoading && <p className="muted">Loading messages...</p>}
                {!messagesLoading && visibleMessages.length === 0 && <p className="muted">There is no message here.</p>}
                {groupedMessages.map((group) => {
                  const senderUser = usersById.get(group.senderId);
                  const senderName =
                    group.senderId === currentUser.uid
                      ? username
                      : senderUser?.username || group.items[0]?.senderName || group.items[0]?.user || "Unknown";
                  const senderPhoto =
                    group.senderId === currentUser.uid
                      ? userProfile?.photoURL || currentUser.photoURL || ""
                      : senderUser?.photoURL || "";
                  const senderOnline =
                    group.senderId === currentUser.uid ? isCurrentUserOnline : isUserOnline(senderUser);
                  return (
                    <article
                      key={group.id}
                      className={`bubble ${group.senderId === currentUser.uid ? "own" : ""}`}
                    >
                      <div className="meta">
                        <div className="metaUser">
                          <button
                            type="button"
                            className="ghost profilePeek"
                            onClick={() => openUserProfileView(group.senderId)}
                          >
                            <Avatar
                              name={senderName}
                              photoURL={senderPhoto}
                              className="metaAvatar"
                              isOnline={senderOnline}
                              showOnlineDot={Boolean(senderUser) || group.senderId === currentUser.uid}
                            />
                            <strong>{senderName}</strong>
                          </button>
                        </div>
                      </div>
                      <div className="groupedMessageStack">
                        {group.items.map((msg) => {
                          const canDeleteMessage = canDeleteGroupMessage(selectedChat, msg, currentUser?.uid);
                          return (
                            <div key={msg.id} className="groupedMessageItem">
                              {msg.replyToMessageId && (
                                <div className="replyContext">
                                  <strong>{msg.replyToSenderName || "User"}</strong>
                                  <small>{msg.replyToText || "Message"}</small>
                                </div>
                              )}
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
                                msg.text && <p>{renderTextWithLinks(msg.text)}</p>
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
                              <div className="messageFoot">
                                <small className="messageTime">
                                  {formatTime(msg.createdAt)}
                                  {msg.editedAt ? " (edited)" : ""}
                                </small>
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
                                      <button
                                        type="button"
                                        className="ghost menuItem"
                                        onClick={() => beginReplyToMessage(msg)}
                                      >
                                        Reply
                                      </button>
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
                                        <button
                                          type="button"
                                          className="ghost menuItem"
                                          onClick={() => beginEditMessage(msg)}
                                        >
                                          Edit
                                        </button>
                                      )}
                                      {canDeleteMessage && (
                                        <button
                                          type="button"
                                          className="ghost menuItem danger"
                                          onClick={() => removeMessage(msg.id)}
                                        >
                                          Delete
                                        </button>
                                      )}
                                    </div>
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </article>
                  );
                })}
              </div>

              {(mediaPreviewURL || mediaFile) && (
                <div className="mediaPreviewCard">
                  {mediaPreviewURL && (mediaFile?.type || "").startsWith("image/") && (
                    <img src={mediaPreviewURL} alt={mediaFile?.name || "Preview"} className="composerPreviewImage" />
                  )}
                  {mediaPreviewURL && (mediaFile?.type || "").startsWith("video/") && (
                    <video controls className="composerPreviewVideo">
                      <source src={mediaPreviewURL} type={mediaFile?.type || "video/mp4"} />
                    </video>
                  )}
                  {!mediaPreviewURL && mediaFile && <p className="muted">Ready to send: {mediaFile.name}</p>}
                </div>
              )}
              {replyingTo && (
                <div className="replyComposerBar">
                  <div>
                    <strong>Replying to {replyingTo.senderName}</strong>
                    <small>{replyingTo.text}</small>
                  </div>
                  <button type="button" className="ghost" onClick={() => setReplyingTo(null)}>
                    Cancel
                  </button>
                </div>
              )}

              <form onSubmit={sendMessage} className="composer" ref={composerFormRef}>
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
                      <button
                        type="button"
                        className="ghost menuItem"
                        onClick={() => {
                          sendContactCard().catch(() => {});
                          setAttachMenuOpen(false);
                        }}
                      >
                        Contact
                      </button>
                      <button
                        type="button"
                        className="ghost menuItem"
                        onClick={() => {
                          sendCurrentLocation().catch(() => {});
                          setAttachMenuOpen(false);
                        }}
                      >
                        Location
                      </button>
                      {isMobileLayout && (
                        <button
                          type="button"
                          className="ghost menuItem"
                          onClick={() => {
                            cameraInputRef.current?.click();
                            setAttachMenuOpen(false);
                          }}
                        >
                          Camera
                        </button>
                      )}
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
                  <input
                    type="file"
                    ref={cameraInputRef}
                    accept="image/*"
                    capture="environment"
                    onChange={(event) => handleComposerFileSelect(event.target.files?.[0] || null)}
                    hidden
                  />
                </div>
                <textarea
                  placeholder={
                    mediaFile
                      ? `Add a caption for ${mediaFile.name}`
                      : activeTypingStream
                        ? `${activeTypingStream.username || "Someone"} is typing...`
                        : "Type a message..."
                  }
                  value={text}
                  rows={2}
                  onChange={(event) => {
                    const nextText = event.target.value;
                    setText(nextText);
                    typingTextRef.current = nextText;
                    publishTypingState(nextText).catch(() => {});
                  }}
                  onKeyDown={handleComposerKeyDown}
                  onBlur={() => {
                    if (!typingTextRef.current.trim()) {
                      clearTypingState();
                    }
                  }}
                  maxLength={500}
                />
                <button type="submit" disabled={sending || selectedChatIsLocked || (!text.trim() && !mediaFile)}>
                  {isMobileLayout ? "Enter" : "Send"}
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
        {selectedChat && selectedChatIsLocked && (
          <div className="chatLockOverlay">
            <div className="chatLockGate">
              <h3>Chat Locked</h3>
              <p className="muted">Enter your 4-digit PIN to continue this session.</p>
              <input
                type="password"
                value={unlockPinDraft}
                maxLength={4}
                placeholder="PIN"
                onChange={(event) => setUnlockPinDraft(event.target.value.replace(/\D/g, ""))}
              />
              <div className="groupStepActions">
                <button type="button" onClick={unlockCurrentChat}>
                  Unlock
                </button>
              </div>
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  setShowRecovery((prev) => !prev);
                  setUnlockStatus("");
                }}
              >
                {showRecovery ? "Cancel Recovery" : "Forgot PIN?"}
              </button>
              {showRecovery && (
                <div className="stack lockRecoveryBox">
                  <p className="muted"><strong>Security question:</strong> What is your best friend name?</p>
                  <input
                    type="text"
                    value={recoveryAnswerDraft}
                    placeholder="Your answer"
                    onChange={(event) => setRecoveryAnswerDraft(event.target.value)}
                    maxLength={60}
                  />
                  <input
                    type="password"
                    value={newPinDraft}
                    maxLength={4}
                    placeholder="New 4-digit PIN"
                    onChange={(event) => setNewPinDraft(event.target.value.replace(/\D/g, ""))}
                  />
                  <div className="groupStepActions">
                    <button type="button" onClick={recoverLockedChat}>
                      Reset PIN & Unlock
                    </button>
                  </div>
                </div>
              )}
              {unlockStatus && <p className="muted">{unlockStatus}</p>}
            </div>
          </div>
        )}
        {isMobileLayout && selectedChat?.isGroup && mobileSubgroupsOpen && (
          <button
            type="button"
            className="subgroupBackdrop"
            onClick={() => setMobileSubgroupsOpen(false)}
            aria-label="Close subgroup panel"
          />
        )}
        {selectedChat?.isGroup && (!isMobileLayout || mobileSubgroupsOpen) && (
          <aside className={`subgroupRail ${isMobileLayout ? "mobileOpen" : ""}`}>
            <div className="subgroupRailHead">
              <h3>Subgroups</h3>
              <small>{activeGroupRoot?.groupName || selectedChat.groupName || "Group"}</small>
            </div>
            <div className="subgroupList">
              {subgroupNavItems.length === 0 && (
                <p className="muted">No subgroups yet.</p>
              )}
              {subgroupNavItems.map((item) => {
                const isMainGroup = item.id === activeGroupRoot?.id;
                const preview = truncateText(item.lastMessage || "No messages yet", 48);
                return (
                  <button
                    type="button"
                    key={item.id}
                    className={`subgroupRow ${selectedChatId === item.id ? "active" : ""} ${isMainGroup ? "mainGroup" : ""}`}
                    onClick={() => openChat(item.id)}
                  >
                    <Avatar
                      name={item.groupName || (isMainGroup ? "Main Group" : "Subgroup")}
                      photoURL={item.groupPhotoURL || ""}
                    />
                    <span className="chatMeta">
                      <strong>
                        {isMainGroup
                          ? `# ${truncateText(item.groupName || "Main Group", 22)}`
                          : `# ${truncateText(item.groupName || "Unnamed Subgroup", 22)}`}
                      </strong>
                      <small>{preview}</small>
                    </span>
                  </button>
                );
              })}
            </div>
          </aside>
        )}
        </div>
        </section>

        {(showAddFriend || showCreateGroup || showNotifications || showProfile || showEventScheduler || showGroupProfile) && (
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
                <p className="muted">
                  Cloud messaging: {notificationPermission === "granted" ? "Access is granted" : fcmStatus || "not configured"}
                </p>
                {notificationPermission !== "granted" && (
                  <button type="button" className="ghost" onClick={requestNotificationPermission}>
                    Enable Push Notifications
                  </button>
                )}
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

          {showGroupProfile && selectedChat?.isGroup && (
            <section className="popupCard" onClick={(event) => event.stopPropagation()}>
              <div className="popupHead">
                <h3>Group Profile</h3>
                <button type="button" className="ghost" onClick={() => setShowGroupProfile(false)}>
                  Close
                </button>
              </div>

              <div className="stack">
                <p className="muted">
                  Your role: <strong>{roleLabel(selectedGroupRole)}</strong>
                </p>
                {selectedChat.parentGroupId && <p className="muted">This is a subgroup.</p>}
              </div>

              <div className="stack groupBlock">
                <h4>Group Details</h4>
                {canEditSelectedGroupCore ? (
                  <>
                    <label className="uploadLabel">
                      Group name
                      <input
                        type="text"
                        value={groupProfileNameDraft}
                        onChange={(event) => setGroupProfileNameDraft(event.target.value)}
                        maxLength={40}
                      />
                    </label>
                    <label className="uploadLabel">
                      Description
                      <input
                        type="text"
                        value={groupDescriptionDraft}
                        onChange={(event) => setGroupDescriptionDraft(event.target.value)}
                        maxLength={180}
                        placeholder="What this group is about"
                      />
                    </label>
                    <div className="groupStepActions">
                      <button type="button" onClick={saveGroupProfile}>
                        Save Details
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <p>
                      <strong>Name:</strong> {selectedChat.groupName || "Unnamed Group"}
                    </p>
                    <p>
                      <strong>Description:</strong> {selectedChat.groupDescription || "No description yet."}
                    </p>
                  </>
                )}
              </div>

              <div className="stack groupBlock">
                <h4>Members & Roles</h4>
                {canEditSelectedGroupCore && (
                  <div className="groupMemberAddRow">
                    <select
                      value={memberToAddId}
                      onChange={(event) => setMemberToAddId(event.target.value)}
                      className="groupSelect"
                    >
                      <option value="">Select friend to add</option>
                      {addableGroupFriends.map((friend) => (
                        <option key={friend.id} value={friend.id}>
                          {friend.username || friend.email || friend.id}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => addMemberToGroup(memberToAddId)}
                      disabled={!memberToAddId}
                    >
                      Add
                    </button>
                  </div>
                )}
                <div className="groupMemberList">
                  {selectedGroupMembers.map((member) => (
                    <div key={member.uid} className="groupMemberCard">
                      <div>
                        <strong>{member.user?.username || member.user?.email || member.uid}</strong>
                        <p className="muted">{member.user?.email || member.uid}</p>
                      </div>
                      <div className="groupMemberActions">
                        {canEditSelectedGroupCore && member.uid !== selectedChat.createdBy ? (
                          <>
                            <select
                              className="groupSelect"
                              value={member.role === "creator" ? "owner" : member.role}
                              onChange={(event) => updateGroupMemberRole(member.uid, event.target.value)}
                            >
                              {GROUP_ROLES.map((role) => (
                                <option key={role} value={role}>
                                  {roleLabel(role)}
                                </option>
                              ))}
                            </select>
                            <button
                              type="button"
                              className="ghost danger"
                              onClick={() => removeMemberFromGroup(member.uid)}
                            >
                              Remove
                            </button>
                          </>
                        ) : (
                          <span className="rolePill">{roleLabel(member.role)}</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="stack groupBlock">
                <h4>Subgroups</h4>
                {selectedGroupSubgroups.length > 0 ? (
                  <div className="groupSubgroupList">
                    {selectedGroupSubgroups.map((subgroup) => (
                      <button
                        type="button"
                        key={subgroup.id}
                        className="ghost subgroupBtn"
                        onClick={() => {
                          openChat(subgroup.id);
                          setShowGroupProfile(false);
                        }}
                      >
                        {subgroup.groupName || "Unnamed Subgroup"}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="muted">No subgroups yet.</p>
                )}
                {canManageSelectedSubgroups ? (
                  <div className="stack">
                    <label className="uploadLabel">
                      New subgroup name
                      <input
                        type="text"
                        value={subgroupNameDraft}
                        onChange={(event) => setSubgroupNameDraft(event.target.value)}
                        maxLength={40}
                        placeholder="Design Team / Planning / QA"
                      />
                    </label>
                    <p className="muted">Choose subgroup members from this group.</p>
                    <div className="friendPickerList">
                      {subgroupCandidateMembers.map((member) => (
                        <button
                          type="button"
                          key={member.id}
                          className={`friendPickItem ${selectedSubgroupMemberIds.includes(member.id) ? "active" : ""}`}
                          onClick={() => toggleSubgroupMember(member.id)}
                        >
                          <Avatar name={member.username} photoURL={member.photoURL} />
                          <span>{member.username || member.email || member.id}</span>
                        </button>
                      ))}
                    </div>
                    <div className="groupStepActions">
                      <button type="button" onClick={createSubgroup}>
                        Create Subgroup
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="muted">Admins, owners, and the creator can create subgroups.</p>
                )}
                {subgroupStatus && <p className="muted">{subgroupStatus}</p>}
              </div>

              {groupProfileStatus && <p className="muted">{groupProfileStatus}</p>}
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
                  {item.text && <p>{renderTextWithLinks(item.text)}</p>}
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
              const viewedChatId =
                currentUser && viewedUserId ? buildChatId(currentUser.uid, viewedUserId) : "";
              const isBlocked = blockedUserIds.includes(viewedUserId);
              const isMuted = mutedUserIds.includes(viewedUserId);
              const isLocked = viewedChatId ? Boolean(getChatLockConfig(chatLocks, viewedChatId)) : false;
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
                  {currentUser && viewedUserId !== currentUser.uid && (
                    <div className="requestActions">
                      <button type="button" className="ghost" onClick={() => toggleBlockedUser(viewedUserId)}>
                        {isBlocked ? "Unblock" : "Block"}
                      </button>
                      <button type="button" className="ghost" onClick={() => toggleMutedUser(viewedUserId)}>
                        {isMuted ? "Unmute" : "Mute"}
                      </button>
                      <button type="button" className="ghost" onClick={() => toggleChatLockForUser(viewedUserId)}>
                        {isLocked ? "Unlock Chat" : "Lock Chat"}
                      </button>
                    </div>
                  )}
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
