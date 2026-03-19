import { useEffect, useMemo, useRef, useState } from "react";
import {
  createUserWithEmailAndPassword,
  deleteUser,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithCredential,
  signInWithPopup,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
} from "firebase/auth";
import {
  addDoc,
  arrayUnion,
  arrayRemove,
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
import { Capacitor } from "@capacitor/core";
import { PushNotifications } from "@capacitor/push-notifications";
import { SocialLogin } from "@capgo/capacitor-social-login";
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
const IS_NATIVE_APP = Capacitor.getPlatform() !== "web";
const IS_NATIVE_MOBILE_APP = Capacitor.getPlatform() === "android" || Capacitor.getPlatform() === "ios";
const GOOGLE_WEB_CLIENT_ID =
  import.meta.env.VITE_GOOGLE_WEB_CLIENT_ID ||
  "732830287788-ujcbdnppln993d0qrgkskqua47bq1u6s.apps.googleusercontent.com";
const QUICK_REACTION_DEFAULTS = ["👍", "❤️", "😂", "🔥"];
const TIMED_MESSAGE_OPTIONS = [
  { label: "10s", value: 10 * 1000 },
  { label: "30s", value: 30 * 1000 },
  { label: "1m", value: 60 * 1000 },
  { label: "5m", value: 5 * 60 * 1000 },
];
const SPECIAL_MESSAGE_DAILY_LIMIT = 5;
const GAME_COUNTDOWN_MS = 3 * 1000;
const GAME_TYPES = {
  tictactoe: "tictactoe",
  rps: "rps",
  ludo: "ludo",
};
const RPS_CHOICES = ["rock", "paper", "scissors"];
const LUDO_GRID_SIZE = 15;
const LUDO_OUTER_TRACK_LENGTH = 52;
const LUDO_HOME_STEPS = 6;
const LUDO_FINISH_INDEX = LUDO_OUTER_TRACK_LENGTH + LUDO_HOME_STEPS - 1;
const LUDO_TOKEN_COUNT = 2;
const LUDO_PLAYER_OFFSETS = [0, 13, 26, 39];
const LUDO_LOOP_CELLS = [
  [6, 13], [6, 12], [6, 11], [6, 10], [6, 9],
  [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8], [0, 7], [0, 6],
  [1, 6], [2, 6], [3, 6], [4, 6], [5, 6],
  [6, 5], [6, 4], [6, 3], [6, 2], [6, 1], [6, 0],
  [7, 0], [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5],
  [9, 6], [10, 6], [11, 6], [12, 6], [13, 6], [14, 6], [14, 7], [14, 8],
  [13, 8], [12, 8], [11, 8], [10, 8], [9, 8],
  [8, 9], [8, 10], [8, 11], [8, 12], [8, 13], [8, 14], [7, 14], [6, 14],
];
const LUDO_HOME_COORDS = [
  [
    { x: 22.5, y: 77.5 },
    { x: 31.5, y: 77.5 },
  ],
  [
    { x: 22.5, y: 22.5 },
    { x: 31.5, y: 22.5 },
  ],
  [
    { x: 68.5, y: 22.5 },
    { x: 77.5, y: 22.5 },
  ],
  [
    { x: 68.5, y: 77.5 },
    { x: 77.5, y: 77.5 },
  ],
];
const LUDO_HOME_LANE_CELLS = [
  [[7, 13], [7, 12], [7, 11], [7, 10], [7, 9], null],
  [[1, 7], [2, 7], [3, 7], [4, 7], [5, 7], null],
  [[7, 1], [7, 2], [7, 3], [7, 4], [7, 5], null],
  [[13, 7], [12, 7], [11, 7], [10, 7], [9, 7], null],
];

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

function formatReactionCount(list) {
  return Array.isArray(list) ? list.length : 0;
}

function buildMessagePreviewLabel(payload) {
  if (payload?.timedOut) return "Message timed out";
  if (payload?.isEvent) return `[Event] ${payload.eventTitle || "Scheduled Event"}`;
  if (payload?.isGameInvite) return `[Game Invite] ${formatGameTypeLabel(payload.gameType)}`;
  if (payload?.isGameSession) return `[Game] ${formatGameTypeLabel(payload.gameType || payload.gameSessionType)}`;
  if (payload?.viewOnce) return "One-time message";
  if (payload?.expiresAt) return "Timed message";
  return (
    payload.text ||
    (payload.mediaType?.startsWith("image/")
      ? "Photo"
      : payload.mediaType?.startsWith("video/")
        ? "Video"
        : payload.mediaType?.startsWith("audio/")
          ? "Audio"
          : payload.mediaURL
            ? "File"
            : "No messages yet")
  );
}

function formatGameTypeLabel(type) {
  if (type === GAME_TYPES.tictactoe) return "Tic-Tac-Toe";
  if (type === GAME_TYPES.rps) return "Rock Paper Scissors";
  if (type === GAME_TYPES.ludo) return "Ludo";
  return "Game";
}

function createGameSession(type, players, startedBy) {
  const startsAt = Timestamp.fromMillis(Date.now() + GAME_COUNTDOWN_MS);
  const gamePlayers = (players || []).filter(Boolean);
  const opponentId = gamePlayers.find((uid) => uid !== startedBy) || "";
  const sessionId = `${type}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  if (type === GAME_TYPES.tictactoe) {
    return {
      sessionId,
      type,
      status: "countdown",
      startedBy,
      startsAt,
      players: gamePlayers,
      board: Array(9).fill(""),
      turn: startedBy,
      marks: {
        [startedBy]: "X",
        [opponentId]: "O",
      },
      winner: "",
      winnerLine: [],
      updatedAt: serverTimestamp(),
    };
  }

  if (type === GAME_TYPES.ludo) {
    return {
      sessionId,
      type,
      status: "countdown",
      startedBy,
      startsAt,
      players: gamePlayers,
      turn: startedBy,
      currentRoll: 0,
      lastRoll: 0,
      tokens: Object.fromEntries(gamePlayers.map((uid) => [uid, Array(LUDO_TOKEN_COUNT).fill(-1)])),
      finishedCounts: Object.fromEntries(gamePlayers.map((uid) => [uid, 0])),
      resultText: "",
      winner: "",
      updatedAt: serverTimestamp(),
    };
  }

  return {
    sessionId,
    type,
    status: "countdown",
    startedBy,
    startsAt,
    players: gamePlayers,
    picks: {},
    round: 1,
    resultText: "",
    winner: "",
    updatedAt: serverTimestamp(),
  };
}

function getNextLudoPlayer(players, currentUid) {
  if (!Array.isArray(players) || players.length === 0) return currentUid || "";
  const currentIndex = players.findIndex((uid) => uid === currentUid);
  if (currentIndex === -1) return players[0] || currentUid || "";
  return players[(currentIndex + 1) % players.length] || currentUid || "";
}

function getLudoMovableTokenIndexes(tokens, roll) {
  if (!Array.isArray(tokens) || !roll) return [];
  return tokens
    .map((position, index) => {
      if (position === LUDO_FINISH_INDEX) return null;
      if (position === -1) return roll === 6 ? index : null;
      const next = position + roll;
      return next <= LUDO_FINISH_INDEX ? index : null;
    })
    .filter((value) => value !== null);
}

function moveLudoTokenState(tokens, index, roll) {
  const nextTokens = [...tokens];
  const current = nextTokens[index];
  if (current === -1) {
    nextTokens[index] = 0;
  } else {
    nextTokens[index] = Math.min(LUDO_FINISH_INDEX, current + roll);
  }
  return nextTokens;
}

function gridCellToPercent(col, row) {
  return {
    x: ((col + 0.5) / LUDO_GRID_SIZE) * 100,
    y: ((row + 0.5) / LUDO_GRID_SIZE) * 100,
  };
}

function getLudoBoardCell(position, playerIndex) {
  if (position < 0) return null;
  if (position < LUDO_OUTER_TRACK_LENGTH) {
    const offset = LUDO_PLAYER_OFFSETS[playerIndex] || 0;
    return LUDO_LOOP_CELLS[(position + offset) % LUDO_OUTER_TRACK_LENGTH];
  }
  const laneIndex = position - LUDO_OUTER_TRACK_LENGTH;
  return LUDO_HOME_LANE_CELLS[playerIndex]?.[laneIndex] || null;
}

function getLudoTokenCoords(position, tokenIndex, playerIndex) {
  if (position === -1) {
    return LUDO_HOME_COORDS[playerIndex]?.[tokenIndex] || { x: 50, y: 50 };
  }
  if (position === LUDO_FINISH_INDEX) {
    return { x: 50, y: 50 };
  }
  const cell = getLudoBoardCell(position, playerIndex);
  return cell ? gridCellToPercent(cell[0], cell[1]) : { x: 50, y: 50 };
}

function countTruthyValues(record) {
  if (!record || typeof record !== "object") return 0;
  return Object.values(record).filter(Boolean).length;
}

function cloneGameTokens(tokens, players) {
  return Object.fromEntries(
    (players || []).map((uid) => [uid, Array.isArray(tokens?.[uid]) ? [...tokens[uid]] : Array(LUDO_TOKEN_COUNT).fill(-1)]),
  );
}

function getTicTacToeWinner(board) {
  const lines = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8],
    [0, 4, 8],
    [2, 4, 6],
  ];
  for (const line of lines) {
    const [a, b, c] = line;
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return { symbol: board[a], line };
    }
  }
  return null;
}

function getRpsWinner(picks, players) {
  if (!Array.isArray(players) || players.length < 2) return { winner: "", resultText: "Waiting for players." };
  const [firstPlayer, secondPlayer] = players;
  const firstPick = picks?.[firstPlayer];
  const secondPick = picks?.[secondPlayer];
  if (!firstPick || !secondPick) return { winner: "", resultText: "Waiting for both players." };
  if (firstPick === secondPick) {
    return {
      winner: "draw",
      resultText: `Draw. Both picked ${firstPick}.`,
    };
  }
  const winsAgainst = {
    rock: "scissors",
    paper: "rock",
    scissors: "paper",
  };
  const winner = winsAgainst[firstPick] === secondPick ? firstPlayer : secondPlayer;
  const winnerPick = winner === firstPlayer ? firstPick : secondPick;
  const loserPick = winner === firstPlayer ? secondPick : firstPick;
  return {
    winner,
    resultText: `${winnerPick} beats ${loserPick}.`,
  };
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
  const [viewOnceOverlay, setViewOnceOverlay] = useState(null);
  const [editingMessageId, setEditingMessageId] = useState("");
  const [editingText, setEditingText] = useState("");
  const [openMessageMenuId, setOpenMessageMenuId] = useState("");
  const [openReactionPickerId, setOpenReactionPickerId] = useState("");
  const [customReactionEmoji, setCustomReactionEmoji] = useState("");
  const [friendEmail, setFriendEmail] = useState("");
  const [friendStatus, setFriendStatus] = useState("");
  const [profileStatus, setProfileStatus] = useState("");
  const [profileNameDraft, setProfileNameDraft] = useState("");
  const [profileBioDraft, setProfileBioDraft] = useState("");

  const [showAddFriend, setShowAddFriend] = useState(false);
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [showGamesMenu, setShowGamesMenu] = useState(false);
  const [showGameOverlay, setShowGameOverlay] = useState(false);
  const [showGameCloseOptions, setShowGameCloseOptions] = useState(false);
  const [showEditProfile, setShowEditProfile] = useState(false);
  const [showSavedContent, setShowSavedContent] = useState(false);
  const [showUserProfileView, setShowUserProfileView] = useState(false);
  const [showEventScheduler, setShowEventScheduler] = useState(false);
  const [eventTitleDraft, setEventTitleDraft] = useState("");
  const [eventDescriptionDraft, setEventDescriptionDraft] = useState("");
  const [eventTimeDraft, setEventTimeDraft] = useState("");
  const [eventStatus, setEventStatus] = useState("");
  const [gameStatus, setGameStatus] = useState("");
  const [gameToast, setGameToast] = useState("");
  const [gameNowMs, setGameNowMs] = useState(Date.now());
  const [diceAnimating, setDiceAnimating] = useState(false);
  const [rpsRevealTick, setRpsRevealTick] = useState(0);
  const [animatedLudoTokens, setAnimatedLudoTokens] = useState(null);
  const [eventPulseChatIds, setEventPulseChatIds] = useState([]);
  const [eventToast, setEventToast] = useState(null);
  const [mobileMessageToast, setMobileMessageToast] = useState(null);
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
  const [messageMode, setMessageMode] = useState({ type: "normal", durationMs: 0 });
  const [timedMenuOpen, setTimedMenuOpen] = useState(false);
  const [showSpamWarning, setShowSpamWarning] = useState(false);
  const [isMobileLayout, setIsMobileLayout] = useState(() => {
    if (typeof window === "undefined") return false;
    return IS_NATIVE_MOBILE_APP || window.innerWidth <= MOBILE_BREAKPOINT;
  });
  const [mobileScreen, setMobileScreen] = useState("list");
  const [mobileNavSection, setMobileNavSection] = useState("messages");
  const [mobileSubgroupsOpen, setMobileSubgroupsOpen] = useState(false);
  const [chatListCollapsed, setChatListCollapsed] = useState(false);
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
  const [openedViewOnceMessageIds, setOpenedViewOnceMessageIds] = useState([]);
  const [soundEnabled, setSoundEnabled] = useState(() => {
    if (typeof window === "undefined") return true;
    const stored = localStorage.getItem("textinger_sound_enabled");
    return stored === null ? true : stored === "1";
  });
  const [soundVolume, setSoundVolume] = useState(() => {
    if (typeof window === "undefined") return 0.7;
    const stored = Number(localStorage.getItem("textinger_sound_volume") || "0.7");
    return Number.isFinite(stored) ? Math.min(1, Math.max(0, stored)) : 0.7;
  });
  const mediaInputRef = useRef(null);
  const documentInputRef = useRef(null);
  const cameraInputRef = useRef(null);
  const composerFormRef = useRef(null);
  const messagesRef = useRef(null);
  const nearBottomRef = useRef(true);
  const lastScrollChatIdRef = useRef("");
  const lastMessageCountRef = useRef(0);
  const forceScrollToBottomRef = useRef(false);
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
  const messageLongPressTimerRef = useRef(null);
  const reactionPickerLockUntilRef = useRef(0);
  const reactionPickerAutoCloseRef = useRef(null);
  const gameAudioContextRef = useRef(null);
  const previousGameSnapshotRef = useRef(null);
  const ludoAnimationTimerRef = useRef(null);
  const ludoRenderedTokensRef = useRef(null);
  const soundPrefsHydratedRef = useRef(false);
  const socialLoginInitRef = useRef(false);
  const isTrueMobileDevice = useMemo(() => {
    if (typeof window === "undefined") return false;
    const ua = window.navigator.userAgent || "";
    return /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || IS_NATIVE_MOBILE_APP;
  }, []);

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
  const activeGame = selectedChat?.activeGame || null;
  const gameOpponentId = useMemo(() => {
    if (!activeGame || !currentUser) return "";
    return (activeGame.players || []).find((uid) => uid !== currentUser.uid) || "";
  }, [activeGame, currentUser]);
  const activeGameOpponent = useMemo(
    () => (gameOpponentId ? usersById.get(gameOpponentId) : null),
    [gameOpponentId, usersById],
  );
  const activeGameStartsAtMs = activeGame?.startsAt?.toMillis?.() || 0;
  const activeGameCountdown = activeGame?.status === "countdown" && activeGameStartsAtMs
    ? Math.max(0, Math.ceil((activeGameStartsAtMs - gameNowMs) / 1000))
    : 0;
  const canUseGamesInChat = Boolean(selectedChat && !selectedChat.isGroup && (selectedChat.members || []).length === 2);
  const canUseLudoInChat = Boolean(
    selectedChat &&
    (
      (!selectedChat.isGroup && (selectedChat.members || []).length === 2) ||
      (selectedChat.isGroup && (selectedChat.members || []).length === 4)
    ),
  );
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
  const hasPendingGameInvite = useMemo(
    () => messages.some((message) => message.isGameInvite && message.inviteStatus === "pending"),
    [messages],
  );
  const groupedMessages = useMemo(() => {
    const groups = [];
    for (const message of visibleMessages) {
      if (message.isEvent || message.isGameInvite || message.isGameSession) {
        groups.push({
          id: message.id,
          senderId: "",
          items: [message],
          isTemplateGroup: true,
        });
        continue;
      }
      const prev = groups[groups.length - 1];
      if (prev && !prev.isTemplateGroup && prev.senderId === message.senderId) {
        prev.items.push(message);
      } else {
        groups.push({
          id: message.id,
          senderId: message.senderId || "",
          items: [message],
          isTemplateGroup: false,
        });
      }
    }
    return groups;
  }, [visibleMessages]);
  const quickReactionOptions = useMemo(() => {
    const next = [...QUICK_REACTION_DEFAULTS];
    if (customReactionEmoji) {
      next[next.length - 1] = customReactionEmoji;
    }
    return next;
  }, [customReactionEmoji]);

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

  function resetMessageMode() {
    setMessageMode({ type: "normal", durationMs: 0 });
    setTimedMenuOpen(false);
  }

  function describeMessageMode() {
    if (messageMode.type === "viewOnce") return "One-time message";
    if (messageMode.type === "timed" && messageMode.durationMs > 0) {
      const option = TIMED_MESSAGE_OPTIONS.find((item) => item.value === messageMode.durationMs);
      return option ? `Timed: ${option.label}` : "Timed message";
    }
    return "";
  }

  function persistCustomReactionEmoji(nextEmoji) {
    setCustomReactionEmoji(nextEmoji);
    if (typeof window === "undefined") return;
    const key = currentUser ? getSessionKey("custom_reaction_emoji") : "textinger_custom_reaction_emoji_guest";
    if (nextEmoji) {
      localStorage.setItem(key, nextEmoji);
    } else {
      localStorage.removeItem(key);
    }
  }

  function isInteractiveMessageTarget(target) {
    if (!(target instanceof Element)) return false;
    return Boolean(target.closest("button, a, input, textarea, video, audio, img"));
  }

  function toggleReactionPicker(messageId) {
    if (reactionPickerAutoCloseRef.current) {
      clearTimeout(reactionPickerAutoCloseRef.current);
      reactionPickerAutoCloseRef.current = null;
    }
    setOpenMessageMenuId("");
    setOpenReactionPickerId((prev) => (prev === messageId ? "" : messageId));
  }

  function beginMessageLongPress(messageId) {
    if (messageLongPressTimerRef.current) {
      clearTimeout(messageLongPressTimerRef.current);
    }
    messageLongPressTimerRef.current = setTimeout(() => {
      reactionPickerLockUntilRef.current = Date.now() + 4000;
      toggleReactionPicker(messageId);
      reactionPickerAutoCloseRef.current = setTimeout(() => {
        reactionPickerLockUntilRef.current = 0;
        setOpenReactionPickerId((prev) => (prev === messageId ? "" : prev));
        reactionPickerAutoCloseRef.current = null;
      }, 4000);
      messageLongPressTimerRef.current = null;
    }, 420);
  }

  function cancelMessageLongPress() {
    if (!messageLongPressTimerRef.current) return;
    clearTimeout(messageLongPressTimerRef.current);
    messageLongPressTimerRef.current = null;
  }

  function chooseCustomReactionEmoji() {
    const nextEmoji = window.prompt("Enter one emoji for quick reactions", customReactionEmoji || QUICK_REACTION_DEFAULTS[QUICK_REACTION_DEFAULTS.length - 1]);
    if (!nextEmoji) return;
    const trimmed = nextEmoji.trim();
    if (!trimmed) return;
    persistCustomReactionEmoji(Array.from(trimmed)[0]);
  }

  function canUseSpecialMessageMode() {
    if (!currentUser || typeof window === "undefined") return true;
    const today = new Date().toISOString().slice(0, 10);
    const key = getSessionKey("special_message_quota");
    try {
      const raw = JSON.parse(localStorage.getItem(key) || "{}");
      const used = raw?.date === today ? Number(raw.count || 0) : 0;
      if (used >= SPECIAL_MESSAGE_DAILY_LIMIT) {
        setComposerStatus(`Timed and one-time messages are limited to ${SPECIAL_MESSAGE_DAILY_LIMIT} per day.`);
        return false;
      }
      localStorage.setItem(key, JSON.stringify({ date: today, count: used + 1 }));
      return true;
    } catch {
      localStorage.setItem(key, JSON.stringify({ date: today, count: 1 }));
      return true;
    }
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
    if (isMobileLayout) {
      setMobileScreen("chat");
      setMobileNavSection("messages");
    }
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
    playAppSound("open");
    setShowAddFriend(true);
    setShowCreateGroup(false);
    setShowNotifications(false);
    setShowProfile(false);
    setShowGamesMenu(false);
  }

  function openCreateGroupPopup() {
    playAppSound("open");
    setShowCreateGroup(true);
    setShowAddFriend(false);
    setShowNotifications(false);
    setShowProfile(false);
    setShowGamesMenu(false);
    setGroupStep("select");
    setSelectedGroupMemberIds([]);
    setGroupNameDraft("");
    setGroupPhotoFile(null);
    setGroupStatus("");
  }

  function openNotificationPopup() {
    playAppSound("open");
    setShowNotifications(true);
    setShowAddFriend(false);
    setShowCreateGroup(false);
    setShowProfile(false);
    setShowGamesMenu(false);
  }

  function openProfilePopup() {
    playAppSound("open");
    setShowProfile(true);
    setShowAddFriend(false);
    setShowCreateGroup(false);
    setShowNotifications(false);
    setShowGamesMenu(false);
  }

  function openGamesPopup() {
    playAppSound("open");
    setShowGamesMenu(true);
    setShowAddFriend(false);
    setShowCreateGroup(false);
    setShowNotifications(false);
    setShowProfile(false);
    setShowEventScheduler(false);
    setGameStatus("");
  }

  function showGameToastMessage(message) {
    setGameToast(message);
  }

  function openGameOverlay() {
    if (!activeGame) return;
    playAppSound("open");
    setShowGameOverlay(true);
  }

  function closeGameOverlay() {
    setShowGameOverlay(false);
    setShowGameCloseOptions(false);
  }

  function openEventSchedulerPopup() {
    if (!selectedChatId) return;
    playAppSound("open");
    setShowEventScheduler(true);
    setShowAddFriend(false);
    setShowCreateGroup(false);
    setShowNotifications(false);
    setShowProfile(false);
    setShowGamesMenu(false);
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
    setShowGamesMenu(false);
    setShowGroupProfile(false);
    setViewedUserId("");
    setGroupProfileStatus("");
    setSubgroupStatus("");
    setGameStatus("");
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
    playAppSound("open");
    setShowGroupProfile(true);
    setShowAddFriend(false);
    setShowCreateGroup(false);
    setShowNotifications(false);
    setShowProfile(false);
    setShowGamesMenu(false);
    setShowEventScheduler(false);
    setGroupProfileNameDraft(selectedChat.groupName || "");
    setGroupDescriptionDraft(selectedChat.groupDescription || "");
    setGroupProfileStatus("");
    setSubgroupNameDraft("");
    setSubgroupStatus("");
    setSelectedSubgroupMemberIds([]);
    setMemberToAddId("");
  }

  async function startChatGame(type) {
    if (!selectedChat || !currentUser) return;
    const canStartGame =
      type === GAME_TYPES.ludo
        ? canUseLudoInChat
        : canUseGamesInChat;
    if (!canStartGame) {
      setGameStatus(
        type === GAME_TYPES.ludo
          ? "Ludo works in direct chats or in groups with exactly 4 members."
          : "Games are available in direct chats only.",
      );
      return;
    }
    if (activeGame || hasPendingGameInvite) {
      setGameStatus("Only one game can be active or pending in this chat.");
      showGameToastMessage("Finish or decide the current game request first.");
      return;
    }
    if (!Object.values(GAME_TYPES).includes(type)) {
      setGameStatus("Unsupported game type.");
      return;
    }

    try {
      await addDoc(collection(db, "chats", selectedChat.id, "messages"), {
        senderId: currentUser.uid,
        senderName: username,
        createdAt: serverTimestamp(),
        text: `${username} invited you to ${formatGameTypeLabel(type)}.`,
        isGameInvite: true,
        gameType: type,
        inviteStatus: "pending",
      });
      await updateDoc(doc(db, "chats", selectedChat.id), {
        lastMessage: `[Game Invite] ${formatGameTypeLabel(type)}`,
        lastSenderId: currentUser.uid,
        updatedAt: serverTimestamp(),
      });
      setShowGamesMenu(false);
      setGameStatus("");
      setMobileScreen("chat");
    } catch {
      setGameStatus("Failed to send game invite.");
    }
  }

  async function acceptGameInvite(message) {
    if (!selectedChat || !currentUser || !message?.id || !message.gameType) return;
    if (message.inviteStatus !== "pending") return;
    if (activeGame) {
      setGameStatus("Only one game can be active in this chat.");
      return;
    }
    try {
      const gamePlayers =
        message.gameType === GAME_TYPES.ludo && selectedChat.isGroup
          ? (selectedChat.members || []).slice(0, 4)
          : (selectedChat.members || []);
      const session = createGameSession(message.gameType, gamePlayers, message.senderId || currentUser.uid);
      const chatRef = doc(db, "chats", selectedChat.id);
      const inviteRef = doc(db, "chats", selectedChat.id, "messages", message.id);
      await updateDoc(chatRef, {
        activeGame: {
          ...session,
          inviteMessageId: message.id,
          acceptedBy: currentUser.uid,
        },
        lastMessage: `[Game] ${formatGameTypeLabel(message.gameType)} started`,
        lastSenderId: currentUser.uid,
        updatedAt: serverTimestamp(),
      });
      await updateDoc(inviteRef, {
        inviteStatus: "accepted",
        acceptedBy: currentUser.uid,
        acceptedAt: serverTimestamp(),
        gameSessionId: session.sessionId,
      });
      await addDoc(collection(db, "chats", selectedChat.id, "messages"), {
        senderId: "",
        senderName: "Game",
        createdAt: serverTimestamp(),
        text: `${formatGameTypeLabel(message.gameType)} started`,
        isGameSession: true,
        gameType: message.gameType,
        gameSessionId: session.sessionId,
        gameStartedBy: message.senderId || currentUser.uid,
      });
      setGameStatus("");
    } catch {
      setGameStatus("Failed to accept game invite.");
    }
  }

  async function declineGameInvite(message) {
    if (!selectedChat || !message?.id || message.inviteStatus !== "pending") return;
    try {
      await updateDoc(doc(db, "chats", selectedChat.id, "messages", message.id), {
        inviteStatus: "declined",
        declinedAt: serverTimestamp(),
      });
      await syncChatLastMessage(selectedChat.id).catch(() => {});
      setGameStatus("");
      showGameToastMessage("Game invite declined.");
    } catch {
      setGameStatus("Failed to decline game invite.");
    }
  }

  async function closeActiveGame() {
    if (!selectedChatId || !activeGame) return;
    try {
      setShowGameOverlay(false);
      setShowGameCloseOptions(false);
      await updateDoc(doc(db, "chats", selectedChatId), {
        activeGame: null,
        updatedAt: serverTimestamp(),
      });
    } catch {
      setGameStatus("Failed to close the game.");
    }
  }

  async function requestCloseActiveGame() {
    if (!selectedChatId || !activeGame || !currentUser) return;
    try {
      await updateDoc(doc(db, "chats", selectedChatId), {
        "activeGame.closeRequestBy": currentUser.uid,
        "activeGame.closeRequestedAt": serverTimestamp(),
        "activeGame.updatedAt": serverTimestamp(),
      });
      setShowGameCloseOptions(false);
      setGameStatus("Close request sent.");
    } catch {
      setGameStatus("Failed to send close request.");
    }
  }

  async function clearCloseGameRequest() {
    if (!selectedChatId || !activeGame) return;
    try {
      await updateDoc(doc(db, "chats", selectedChatId), {
        "activeGame.closeRequestBy": "",
        "activeGame.closeRequestedAt": null,
        "activeGame.updatedAt": serverTimestamp(),
      });
      setGameStatus("");
    } catch {
      setGameStatus("Failed to update close request.");
    }
  }

  async function acceptCloseGameRequest() {
    await closeActiveGame();
  }

  async function playTicTacToe(index) {
    if (!selectedChatId || !currentUser || activeGame?.type !== GAME_TYPES.tictactoe || activeGame?.status !== "active") return;
    try {
      await runTransaction(db, async (transaction) => {
        const chatRef = doc(db, "chats", selectedChatId);
        const snapshot = await transaction.get(chatRef);
        const chatData = snapshot.data() || {};
        const game = chatData.activeGame;
        if (!game || game.type !== GAME_TYPES.tictactoe || game.status !== "active") return;
        if (game.turn !== currentUser.uid) return;
        const board = Array.isArray(game.board) ? [...game.board] : Array(9).fill("");
        if (board[index] || game.winner) return;
        const symbol = game.marks?.[currentUser.uid] || "X";
        board[index] = symbol;
        const winnerState = getTicTacToeWinner(board);
        const filled = board.every(Boolean);
        const nextPlayer = (game.players || []).find((uid) => uid !== currentUser.uid) || currentUser.uid;

        transaction.update(chatRef, {
          "activeGame.board": board,
          "activeGame.turn": winnerState || filled ? "" : nextPlayer,
          "activeGame.status": winnerState || filled ? "finished" : "active",
          "activeGame.winner": winnerState
            ? currentUser.uid
            : filled
              ? "draw"
              : "",
          "activeGame.winnerLine": winnerState?.line || [],
          "activeGame.updatedAt": serverTimestamp(),
        });
      });
    } catch {
      setGameStatus("Move failed.");
    }
  }

  async function playRps(choice) {
    if (!selectedChatId || !currentUser || activeGame?.type !== GAME_TYPES.rps || activeGame?.status !== "active") return;
    if (!RPS_CHOICES.includes(choice)) return;
    try {
      await runTransaction(db, async (transaction) => {
        const chatRef = doc(db, "chats", selectedChatId);
        const snapshot = await transaction.get(chatRef);
        const chatData = snapshot.data() || {};
        const game = chatData.activeGame;
        if (!game || game.type !== GAME_TYPES.rps || game.status !== "active") return;
        const picks = { ...(game.picks || {}), [currentUser.uid]: choice };
        const players = Array.isArray(game.players) ? game.players : [];
        const allPicked = players.length === 2 && players.every((uid) => Boolean(picks[uid]));
        const outcome = allPicked ? getRpsWinner(picks, players) : null;
        transaction.update(chatRef, {
          "activeGame.picks": picks,
          "activeGame.status": allPicked ? "finished" : "active",
          "activeGame.winner": outcome?.winner || "",
          "activeGame.resultText": outcome?.resultText || "",
          "activeGame.updatedAt": serverTimestamp(),
        });
      });
    } catch {
      setGameStatus("Pick failed.");
    }
  }

  async function rollLudoDice() {
    if (!selectedChatId || !currentUser || activeGame?.type !== GAME_TYPES.ludo || activeGame?.status !== "active") return;
    try {
      await runTransaction(db, async (transaction) => {
        const chatRef = doc(db, "chats", selectedChatId);
        const snapshot = await transaction.get(chatRef);
        const chatData = snapshot.data() || {};
        const game = chatData.activeGame;
        if (!game || game.type !== GAME_TYPES.ludo || game.status !== "active") return;
        if (game.turn !== currentUser.uid || game.currentRoll) return;

        const roll = Math.floor(Math.random() * 6) + 1;
        const myTokens = Array.isArray(game.tokens?.[currentUser.uid]) ? game.tokens[currentUser.uid] : Array(LUDO_TOKEN_COUNT).fill(-1);
        const movable = getLudoMovableTokenIndexes(myTokens, roll);
        if (movable.length === 0) {
          const nextPlayer = getNextLudoPlayer(game.players || [], currentUser.uid);
          transaction.update(chatRef, {
            "activeGame.lastRoll": roll,
            "activeGame.currentRoll": 0,
            "activeGame.turn": nextPlayer,
            "activeGame.resultText": `Rolled ${roll}. No valid move.`,
            "activeGame.updatedAt": serverTimestamp(),
          });
          return;
        }

        transaction.update(chatRef, {
          "activeGame.lastRoll": roll,
          "activeGame.currentRoll": roll,
          "activeGame.resultText": `Rolled ${roll}. Pick a token.`,
          "activeGame.updatedAt": serverTimestamp(),
        });
      });
    } catch {
      setGameStatus("Dice roll failed.");
    }
  }

  async function moveLudoToken(tokenIndex) {
    if (!selectedChatId || !currentUser || activeGame?.type !== GAME_TYPES.ludo || activeGame?.status !== "active") return;
    try {
      await runTransaction(db, async (transaction) => {
        const chatRef = doc(db, "chats", selectedChatId);
        const snapshot = await transaction.get(chatRef);
        const chatData = snapshot.data() || {};
        const game = chatData.activeGame;
        if (!game || game.type !== GAME_TYPES.ludo || game.status !== "active") return;
        if (game.turn !== currentUser.uid || !game.currentRoll) return;

        const players = Array.isArray(game.players) ? game.players : [];
        const myTokens = Array.isArray(game.tokens?.[currentUser.uid]) ? [...game.tokens[currentUser.uid]] : Array(LUDO_TOKEN_COUNT).fill(-1);
        const movable = getLudoMovableTokenIndexes(myTokens, game.currentRoll);
        if (!movable.includes(tokenIndex)) return;

        const updatedMyTokens = moveLudoTokenState(myTokens, tokenIndex, game.currentRoll);
        const landingSpot = updatedMyTokens[tokenIndex];
        const currentPlayerIndex = players.findIndex((uid) => uid === currentUser.uid);
        const tokensUpdate = {
          ...(game.tokens || {}),
          [currentUser.uid]: updatedMyTokens,
        };
        let captured = false;
        if (landingSpot >= 0 && landingSpot < LUDO_OUTER_TRACK_LENGTH) {
          const landingBoardCell = getLudoBoardCell(landingSpot, currentPlayerIndex);
          for (const playerId of players) {
            if (!playerId || playerId === currentUser.uid) continue;
            const playerIndex = players.findIndex((uid) => uid === playerId);
            const otherTokens = Array.isArray(game.tokens?.[playerId]) ? [...game.tokens[playerId]] : Array(LUDO_TOKEN_COUNT).fill(-1);
            for (let index = 0; index < otherTokens.length; index += 1) {
              const opponentSpot = otherTokens[index];
              const opponentBoardCell =
                opponentSpot >= 0 && opponentSpot < LUDO_OUTER_TRACK_LENGTH
                  ? getLudoBoardCell(opponentSpot, playerIndex)
                  : null;
              if (
                landingBoardCell &&
                opponentBoardCell &&
                opponentBoardCell[0] === landingBoardCell[0] &&
                opponentBoardCell[1] === landingBoardCell[1]
              ) {
                otherTokens[index] = -1;
                captured = true;
              }
            }
            tokensUpdate[playerId] = otherTokens;
          }
        }

        const finishedCounts = { ...(game.finishedCounts || {}) };
        finishedCounts[currentUser.uid] = updatedMyTokens.filter((position) => position === LUDO_FINISH_INDEX).length;
        const didWin = finishedCounts[currentUser.uid] >= LUDO_TOKEN_COUNT;
        const keepTurn = game.currentRoll === 6 && !didWin;
        const nextPlayer = keepTurn ? currentUser.uid : getNextLudoPlayer(players, currentUser.uid);

        transaction.update(chatRef, {
          "activeGame.tokens": tokensUpdate,
          "activeGame.finishedCounts": finishedCounts,
          "activeGame.currentRoll": 0,
          "activeGame.turn": didWin ? "" : nextPlayer,
          "activeGame.status": didWin ? "finished" : "active",
          "activeGame.winner": didWin ? currentUser.uid : "",
          "activeGame.resultText": didWin
            ? "Both tokens reached home."
            : captured
              ? "Captured an opponent token."
              : keepTurn
                ? "Rolled 6. Take another turn."
                : `Moved token ${tokenIndex + 1}.`,
          "activeGame.updatedAt": serverTimestamp(),
        });
      });
    } catch {
      setGameStatus("Move failed.");
    }
  }

  async function restartActiveGame() {
    if (!selectedChat || !currentUser || !activeGame?.type) return;
    await startChatGame(activeGame.type);
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

  function playAppSound(kind) {
    if (!soundEnabled || soundVolume <= 0) return;
    if (typeof window === "undefined") return;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    try {
      if (!gameAudioContextRef.current) {
        gameAudioContextRef.current = new AudioContextClass();
      }
      const context = gameAudioContextRef.current;
      if (context.state === "suspended") {
        context.resume().catch(() => {});
      }
      const masterGain = context.createGain();
      masterGain.connect(context.destination);
      masterGain.gain.value = 0.045 * soundVolume;
      const now = context.currentTime;
      const soundMap = {
        open: { steps: [410, 560], type: "sine", duration: 0.08, gap: 0.05, volume: 0.45 },
        send: { steps: [320, 420, 580], type: "sine", duration: 0.08, gap: 0.05, volume: 0.5 },
        event: { steps: [392, 523.25, 659.25], type: "triangle", duration: 0.11, gap: 0.08, volume: 0.5 },
        success: { steps: [440, 554.37, 659.25], type: "sine", duration: 0.09, gap: 0.06, volume: 0.5 },
        accept: { steps: [392, 493.88, 587.33], type: "sine", duration: 0.09, gap: 0.06, volume: 0.52 },
        decline: { steps: [370, 293.66], type: "triangle", duration: 0.1, gap: 0.07, volume: 0.45 },
        copy: { steps: [660], type: "square", duration: 0.06, gap: 0.05, volume: 0.35 },
        delete: { steps: [260, 180], type: "triangle", duration: 0.09, gap: 0.07, volume: 0.45 },
        lock: { steps: [330, 262], type: "triangle", duration: 0.1, gap: 0.07, volume: 0.45 },
        unlock: { steps: [262, 330, 440], type: "sine", duration: 0.08, gap: 0.05, volume: 0.45 },
        error: { steps: [240, 180, 140], type: "sawtooth", duration: 0.09, gap: 0.06, volume: 0.35 },
        dice: { steps: [220, 280, 340], type: "sine", duration: 0.12, gap: 0.08, volume: 0.8 },
        move: { steps: [420, 520], type: "sine", duration: 0.12, gap: 0.08, volume: 0.8 },
        win: { steps: [523.25, 659.25, 783.99], type: "sine", duration: 0.12, gap: 0.08, volume: 0.8 },
        lose: { steps: [392, 311.13, 220], type: "sine", duration: 0.12, gap: 0.08, volume: 0.8 },
        shake: { steps: [180, 160, 180], type: "triangle", duration: 0.12, gap: 0.08, volume: 0.8 },
        reveal: { steps: [330, 392, 494], type: "sine", duration: 0.12, gap: 0.08, volume: 0.8 },
      };
      const preset = soundMap[kind] || soundMap.open;

      preset.steps.forEach((frequency, index) => {
        const oscillator = context.createOscillator();
        const gainNode = context.createGain();
        const startAt = now + index * preset.gap;
        oscillator.type = preset.type;
        oscillator.frequency.setValueAtTime(frequency, startAt);
        gainNode.gain.setValueAtTime(0.0001, startAt);
        gainNode.gain.exponentialRampToValueAtTime(preset.volume, startAt + 0.01);
        gainNode.gain.exponentialRampToValueAtTime(0.0001, startAt + preset.duration);
        oscillator.connect(gainNode);
        gainNode.connect(masterGain);
        oscillator.start(startAt);
        oscillator.stop(startAt + preset.duration + 0.01);
      });
    } catch {
      // Audio is optional.
    }
  }

  function playGameSound(kind) {
    playAppSound(kind);
  }

  async function updateSoundPreferences(nextEnabled, nextVolume) {
    const normalizedVolume = Math.min(1, Math.max(0, Number(nextVolume)));
    setSoundEnabled(Boolean(nextEnabled));
    setSoundVolume(normalizedVolume);

    if (typeof window !== "undefined") {
      localStorage.setItem("textinger_sound_enabled", nextEnabled ? "1" : "0");
      localStorage.setItem("textinger_sound_volume", `${normalizedVolume}`);
    }

    if (!currentUser) return;
    try {
      await setDoc(
        doc(db, "users", currentUser.uid),
        {
          soundEnabled: Boolean(nextEnabled),
          soundVolume: normalizedVolume,
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
    } catch {
      // Sound preferences can stay local if sync fails.
    }
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
    if (IS_NATIVE_APP) {
      await enableNativePushNotificationsForCurrentUser();
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

  async function enableNativePushNotificationsForCurrentUser() {
    if (!currentUser || !IS_NATIVE_APP) return;
    try {
      let permission = await PushNotifications.checkPermissions();
      if (permission.receive === "prompt") {
        permission = await PushNotifications.requestPermissions();
      }
      setNotificationPermission(permission.receive || "default");
      if (permission.receive !== "granted") {
        setFcmStatus("Native notification permission was not granted.");
        return;
      }
      await PushNotifications.register();
      setFcmStatus("Native push registration requested.");
    } catch {
      setFcmStatus("Native push setup failed.");
    }
  }

  async function requestNotificationPermission() {
    if (IS_NATIVE_APP) {
      await enableNativePushNotificationsForCurrentUser();
      return;
    }
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
    const updateLayout = () => setIsMobileLayout(IS_NATIVE_MOBILE_APP || window.innerWidth <= MOBILE_BREAKPOINT);
    updateLayout();
    window.addEventListener("resize", updateLayout);
    return () => window.removeEventListener("resize", updateLayout);
  }, []);

  useEffect(() => {
    if (!IS_NATIVE_MOBILE_APP || socialLoginInitRef.current) return;
    socialLoginInitRef.current = true;
    SocialLogin.initialize({
      google: {
        webClientId: GOOGLE_WEB_CLIENT_ID,
        mode: "online",
      },
    }).catch(() => {
      socialLoginInitRef.current = false;
    });
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
    if (!IS_NATIVE_APP) return undefined;
    const registrationListener = PushNotifications.addListener("registration", async (token) => {
      if (!currentUser || !token?.value) return;
      try {
        await setDoc(
          doc(db, "users", currentUser.uid),
          {
            fcmTokens: arrayUnion(token.value),
            nativePushTokens: arrayUnion(token.value),
            nativePushPlatform: Capacitor.getPlatform(),
            pushEnabledAt: serverTimestamp(),
          },
          { merge: true },
        );
        setFcmStatus("Native push token saved for this device.");
      } catch {
        setFcmStatus("Native push token was received but could not be saved.");
      }
    });

    const registrationErrorListener = PushNotifications.addListener("registrationError", () => {
      setFcmStatus("Native push registration failed.");
    });

    const receivedListener = PushNotifications.addListener("pushNotificationReceived", (notification) => {
      const title = notification?.title || "Textinger";
      const body = notification?.body || "You have a new message.";
      setMobileMessageToast({
        chatId: notification?.data?.chatId || "",
        title,
        preview: body,
      });
    });

    const actionListener = PushNotifications.addListener("pushNotificationActionPerformed", (event) => {
      const chatId = event?.notification?.data?.chatId || "";
      if (chatId) {
        openChat(chatId);
      }
    });

    return () => {
      registrationListener.then((handle) => handle.remove()).catch(() => {});
      registrationErrorListener.then((handle) => handle.remove()).catch(() => {});
      receivedListener.then((handle) => handle.remove()).catch(() => {});
      actionListener.then((handle) => handle.remove()).catch(() => {});
    };
  }, [currentUser]);

  useEffect(() => {
    if (!currentUser) {
      if (window.OneSignal && oneSignalReadyRef.current) {
        window.OneSignal.logout().catch(() => {});
      }
      setFcmStatus("");
      soundPrefsHydratedRef.current = false;
      return;
    }
    if (notificationPermission !== "granted") return;
    enablePushNotificationsForCurrentUser().catch(() => {});
  }, [currentUser, notificationPermission]);

  useEffect(() => {
    if (!currentUser || !userProfile || soundPrefsHydratedRef.current) return;
    const nextEnabled = typeof userProfile.soundEnabled === "boolean" ? userProfile.soundEnabled : soundEnabled;
    const nextVolume = Number.isFinite(Number(userProfile.soundVolume))
      ? Math.min(1, Math.max(0, Number(userProfile.soundVolume)))
      : soundVolume;
    soundPrefsHydratedRef.current = true;
    setSoundEnabled(nextEnabled);
    setSoundVolume(nextVolume);
    if (typeof window !== "undefined") {
      localStorage.setItem("textinger_sound_enabled", nextEnabled ? "1" : "0");
      localStorage.setItem("textinger_sound_volume", `${nextVolume}`);
    }
  }, [currentUser, userProfile, soundEnabled, soundVolume]);

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
    if (!isMobileLayout || mobileScreen !== "chat") return;
    forceScrollToBottomRef.current = true;
    const attemptScroll = () => {
      const target = messagesRef.current;
      if (!target) return;
      target.scrollTop = target.scrollHeight;
      nearBottomRef.current = true;
    };
    requestAnimationFrame(() => {
      requestAnimationFrame(attemptScroll);
    });
    const timer = setTimeout(attemptScroll, 140);
    return () => clearTimeout(timer);
  }, [isMobileLayout, mobileScreen, selectedChatId]);

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
    setShowGamesMenu(false);
    setGameStatus("");
    forceScrollToBottomRef.current = true;
  }, [selectedChatId]);

  useEffect(() => {
    if (!gameToast) return undefined;
    const timer = setTimeout(() => setGameToast(""), 2600);
    return () => clearTimeout(timer);
  }, [gameToast]);

  useEffect(() => {
    setShowGameOverlay(false);
  }, [selectedChatId]);

  useEffect(() => {
    if (!activeGameStartsAtMs || activeGame?.status !== "countdown") return undefined;
    setGameNowMs(Date.now());
    const interval = setInterval(() => setGameNowMs(Date.now()), 250);
    return () => clearInterval(interval);
  }, [activeGame?.status, activeGameStartsAtMs]);

  useEffect(() => {
    if (!selectedChatId || !activeGame || activeGame.status !== "countdown" || !activeGameStartsAtMs) return undefined;
    const remainingMs = activeGameStartsAtMs - Date.now();
    if (remainingMs <= 0) {
      updateDoc(doc(db, "chats", selectedChatId), {
        "activeGame.status": "active",
        "activeGame.updatedAt": serverTimestamp(),
      }).catch(() => {});
      return undefined;
    }
    const timer = setTimeout(() => {
      updateDoc(doc(db, "chats", selectedChatId), {
        "activeGame.status": "active",
        "activeGame.updatedAt": serverTimestamp(),
      }).catch(() => {});
    }, remainingMs + 40);
    return () => clearTimeout(timer);
  }, [activeGame, activeGameStartsAtMs, selectedChatId]);

  useEffect(() => {
    if (!activeGame) {
      if (ludoAnimationTimerRef.current) {
        clearTimeout(ludoAnimationTimerRef.current);
        ludoAnimationTimerRef.current = null;
      }
      setAnimatedLudoTokens(null);
      ludoRenderedTokensRef.current = null;
      previousGameSnapshotRef.current = null;
      setShowGameOverlay(false);
      return;
    }

    const previous = previousGameSnapshotRef.current;
    if (!previous || previous.sessionId !== activeGame.sessionId) {
      previousGameSnapshotRef.current = activeGame;
      setShowGameOverlay(true);
      return;
    }

    if (activeGame.type === GAME_TYPES.ludo && previous.lastRoll !== activeGame.lastRoll && activeGame.lastRoll) {
      setDiceAnimating(true);
      playGameSound("dice");
      setTimeout(() => setDiceAnimating(false), 700);
    }

    if (activeGame.type === GAME_TYPES.ludo && JSON.stringify(previous.tokens || {}) !== JSON.stringify(activeGame.tokens || {})) {
      playGameSound("move");
    }

    if (activeGame.type === GAME_TYPES.rps) {
      const previousPickCount = countTruthyValues(previous.picks);
      const nextPickCount = countTruthyValues(activeGame.picks);
      if (nextPickCount > previousPickCount) {
        setRpsRevealTick(Date.now());
        playGameSound(nextPickCount >= 2 ? "reveal" : "shake");
      }
    }

    if (previous.winner !== activeGame.winner && activeGame.winner) {
      playGameSound(activeGame.winner === currentUser?.uid ? "win" : "lose");
    }

    previousGameSnapshotRef.current = activeGame;
  }, [activeGame]);

  useEffect(() => {
    if (activeGame?.type !== GAME_TYPES.ludo) {
      if (ludoAnimationTimerRef.current) {
        clearTimeout(ludoAnimationTimerRef.current);
        ludoAnimationTimerRef.current = null;
      }
      setAnimatedLudoTokens(null);
      ludoRenderedTokensRef.current = null;
      return undefined;
    }

    const players = Array.isArray(activeGame.players) ? activeGame.players : [];
    const targetTokens = cloneGameTokens(activeGame.tokens, players);
    const previousTokens = ludoRenderedTokensRef.current || targetTokens;

    let changedPlayerId = "";
    let changedTokenIndex = -1;
    let fromPosition = -1;
    let toPosition = -1;

    for (const uid of players) {
      const prevList = previousTokens?.[uid] || [];
      const nextList = targetTokens?.[uid] || [];
      for (let index = 0; index < Math.max(prevList.length, nextList.length); index += 1) {
        if ((prevList[index] ?? -1) !== (nextList[index] ?? -1)) {
          changedPlayerId = uid;
          changedTokenIndex = index;
          fromPosition = prevList[index] ?? -1;
          toPosition = nextList[index] ?? -1;
          break;
        }
      }
      if (changedPlayerId) break;
    }

    if (!changedPlayerId || toPosition < fromPosition || toPosition === -1) {
      setAnimatedLudoTokens(targetTokens);
      ludoRenderedTokensRef.current = targetTokens;
      return undefined;
    }

    if (ludoAnimationTimerRef.current) {
      clearTimeout(ludoAnimationTimerRef.current);
      ludoAnimationTimerRef.current = null;
    }

    setAnimatedLudoTokens(previousTokens);
    const path = [];
    if (fromPosition === -1 && toPosition >= 0) {
      path.push(0);
      for (let step = 1; step <= toPosition; step += 1) {
        path.push(step);
      }
    } else {
      for (let step = fromPosition + 1; step <= toPosition; step += 1) {
        path.push(step);
      }
    }

    let stepIndex = 0;
    const tick = () => {
      setAnimatedLudoTokens((currentTokens) => {
        const base = cloneGameTokens(currentTokens || previousTokens, players);
        base[changedPlayerId][changedTokenIndex] = path[Math.min(stepIndex, path.length - 1)];
        ludoRenderedTokensRef.current = cloneGameTokens(base, players);
        return base;
      });
      stepIndex += 1;
      if (stepIndex < path.length) {
        ludoAnimationTimerRef.current = setTimeout(tick, 170);
      } else {
        ludoAnimationTimerRef.current = null;
        setAnimatedLudoTokens(targetTokens);
        ludoRenderedTokensRef.current = targetTokens;
      }
    };

    if (path.length > 0) {
      ludoAnimationTimerRef.current = setTimeout(tick, 90);
    } else {
      setAnimatedLudoTokens(targetTokens);
      ludoRenderedTokensRef.current = targetTokens;
    }

    return () => {
      if (ludoAnimationTimerRef.current) {
        clearTimeout(ludoAnimationTimerRef.current);
        ludoAnimationTimerRef.current = null;
      }
    };
  }, [activeGame?.type, activeGame?.tokens, activeGame?.players, activeGame?.sessionId]);

  useEffect(() => {
    if (!selectedChatId) return undefined;
    setMessagesLoading(true);
    const unsub = onSnapshot(
      query(collection(db, "chats", selectedChatId, "messages"), orderBy("createdAt", "asc")),
      (snapshot) => {
        const nextMessages = [];
        const expiredIds = [];
        const now = Date.now();
        for (const entry of snapshot.docs) {
          const message = { id: entry.id, ...entry.data() };
          const expiresAtMs = message.expiresAt?.toMillis?.() || 0;
          if (expiresAtMs && expiresAtMs <= now) {
            if (!message.timedOut) {
              expiredIds.push(entry.id);
            }
            nextMessages.push({
              ...message,
              timedOut: true,
              text: "",
              mediaURL: "",
              mediaType: "",
              mediaName: "",
            });
            continue;
          }
          nextMessages.push(message);
        }
        setMessages(nextMessages);
        setMessagesLoading(false);
        if (expiredIds.length > 0) {
          applyTimedOutMessages(selectedChatId, expiredIds).catch(() => {});
        }
      },
      () => {
        setMessagesLoading(false);
      },
    );
    return () => unsub();
  }, [selectedChatId]);

  useEffect(() => {
    if (!selectedChatId || messages.length === 0) return undefined;
    const pendingExpirations = messages
      .map((message) => ({
        id: message.id,
        expiresAtMs: message.expiresAt?.toMillis?.() || 0,
        timedOut: Boolean(message.timedOut),
      }))
      .filter((message) => message.expiresAtMs > Date.now() && !message.timedOut)
      .sort((a, b) => a.expiresAtMs - b.expiresAtMs);

    if (pendingExpirations.length === 0) return undefined;

    const nextExpiration = pendingExpirations[0];
    const delay = Math.max(0, nextExpiration.expiresAtMs - Date.now());
    const timer = setTimeout(() => {
      const now = Date.now();
      const expiredNow = messages
        .filter((message) => {
          const expiresAtMs = message.expiresAt?.toMillis?.() || 0;
          return expiresAtMs > 0 && expiresAtMs <= now && !message.timedOut;
        })
        .map((message) => message.id);
      if (expiredNow.length > 0) {
        applyTimedOutMessages(selectedChatId, expiredNow).catch(() => {});
      }
    }, delay + 20);

    return () => clearTimeout(timer);
  }, [selectedChatId, messages]);

  useEffect(() => {
    if (!selectedChatId || !messagesRef.current) return;
    if (lastScrollChatIdRef.current !== selectedChatId || forceScrollToBottomRef.current) {
      const target = messagesRef.current;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          target.scrollTop = target.scrollHeight;
          nearBottomRef.current = true;
        });
      });
      setTimeout(() => {
        if (messagesRef.current) {
          messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
          nearBottomRef.current = true;
        }
      }, 110);
      lastScrollChatIdRef.current = selectedChatId;
      lastMessageCountRef.current = messages.length;
      forceScrollToBottomRef.current = false;
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
    if (!openReactionPickerId) return undefined;
    const handleGlobalClick = () => {
      if (Date.now() < reactionPickerLockUntilRef.current) return;
      setOpenReactionPickerId("");
    };
    document.addEventListener("click", handleGlobalClick);
    return () => document.removeEventListener("click", handleGlobalClick);
  }, [openReactionPickerId]);

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
    if (typeof window === "undefined") return;
    const key = currentUser ? getSessionKey("custom_reaction_emoji") : "textinger_custom_reaction_emoji_guest";
    setCustomReactionEmoji(localStorage.getItem(key) || "");
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
      if (chat.id === selectedChatId) continue;

      setUnreadChatIds((prev) => (prev.includes(chat.id) ? prev : [...prev, chat.id]));

      const otherUid = (chat.members || []).find((member) => member !== currentUser.uid);
      if (!chat.isGroup && otherUid && blockedUserIds.includes(otherUid)) continue;
      if (!chat.isGroup && otherUid && mutedUserIds.includes(otherUid)) continue;
      const other = otherUid ? usersById.get(otherUid) : null;
      const chatTitle = chat.isGroup
        ? chat.groupName || "Group Chat"
        : other?.username || "New Message";
      if (isMobileLayout && document.visibilityState === "visible") {
        setMobileMessageToast({
          chatId: chat.id,
          title: chatTitle,
          text: truncateText(currentMeta.lastMessage || "You have a new message.", 80),
        });
      }
      pushBrowserNotification(chatTitle, currentMeta.lastMessage || "You have a new message.");
    }

    chatMetaRef.current = nextMap;
  }, [chats, currentUser, usersById, selectedChatId, blockedUserIds, mutedUserIds, isMobileLayout]);

  useEffect(() => {
    if (!mobileMessageToast) return undefined;
    const timer = setTimeout(() => {
      setMobileMessageToast((prev) => (prev?.chatId === mobileMessageToast.chatId ? null : prev));
    }, 6000);
    return () => clearTimeout(timer);
  }, [mobileMessageToast]);

  useEffect(() => {
    if (!viewOnceOverlay) return undefined;
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") {
        closeViewOnceOverlay().catch(() => {});
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [viewOnceOverlay, selectedChatId, currentUser]);

  useEffect(() => {
    if (!mobileMessageToast) return;
    if (selectedChatId === mobileMessageToast.chatId) {
      setMobileMessageToast(null);
    }
  }, [selectedChatId, mobileMessageToast]);

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
    playAppSound(blockedUserIds.includes(userId) ? "unlock" : "lock");
    setBlockedUserIds((prev) =>
      prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId],
    );
  }

  function toggleMutedUser(userId) {
    if (!userId) return;
    playAppSound(mutedUserIds.includes(userId) ? "unlock" : "lock");
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
        playAppSound("error");
        setProfileStatus("Incorrect PIN. Could not unlock chat permanently.");
        return;
      }
      setChatLocks((prev) => {
        const next = { ...prev };
        delete next[chatId];
        return next;
      });
      setUnlockedChatIds((prev) => prev.filter((id) => id !== chatId));
      playAppSound("unlock");
      setProfileStatus("Chat lock removed permanently.");
      return;
    }
    const pin = window.prompt("Set a 4-digit PIN for this chat lock:");
    if (!pin) return;
    if (!/^\d{4}$/.test(pin.trim())) {
      playAppSound("error");
      setProfileStatus("PIN must be exactly 4 digits.");
      return;
    }
    const answer = window.prompt("Security question setup: What is your best friend name?");
    if (!answer?.trim()) {
      playAppSound("error");
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
    playAppSound("lock");
    setProfileStatus("Chat lock enabled.");
  }

  function unlockCurrentChat() {
    if (!selectedChatId) return;
    const lockConfig = getChatLockConfig(chatLocks, selectedChatId);
    if (!lockConfig) return;
    if (unlockPinDraft.trim() !== lockConfig.pin) {
      playAppSound("error");
      setUnlockStatus("Incorrect PIN.");
      return;
    }
    setUnlockedChatIds((prev) => (prev.includes(selectedChatId) ? prev : [...prev, selectedChatId]));
    playAppSound("unlock");
    setUnlockPinDraft("");
    setUnlockStatus("");
  }

  function recoverLockedChat() {
    if (!selectedChatId) return;
    const lockConfig = getChatLockConfig(chatLocks, selectedChatId);
    if (!lockConfig) return;
    const normalized = recoveryAnswerDraft.trim().toLowerCase();
    if (!normalized || normalized !== lockConfig.recoveryAnswer) {
      playAppSound("error");
      setUnlockStatus("Incorrect answer for recovery question.");
      return;
    }
    if (!/^\d{4}$/.test(newPinDraft.trim())) {
      playAppSound("error");
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
    playAppSound("unlock");
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
    const nextLastMessage = buildMessagePreviewLabel(latest);
    await updateDoc(doc(db, "chats", chatId), {
      lastMessage: nextLastMessage,
      lastSenderId: latest.senderId || "",
      updatedAt: serverTimestamp(),
    });
  }

  async function applyTimedOutMessages(chatId, messageIds) {
    if (!chatId || !Array.isArray(messageIds) || messageIds.length === 0) return;
    const uniqueIds = Array.from(new Set(messageIds.filter(Boolean)));
    if (uniqueIds.length === 0) return;

    setMessages((prev) =>
      prev.map((message) =>
        uniqueIds.includes(message.id)
          ? {
              ...message,
              timedOut: true,
              text: "",
              mediaURL: "",
              mediaType: "",
              mediaName: "",
            }
          : message,
      ),
    );

    setChats((prev) =>
      prev.map((chat) => {
        if (chat.id !== chatId) return chat;
        const latestVisibleMessage = [...messages]
          .map((message) =>
            uniqueIds.includes(message.id)
              ? {
                  ...message,
                  timedOut: true,
                  text: "",
                  mediaURL: "",
                  mediaType: "",
                  mediaName: "",
                }
              : message,
          )
          .sort((a, b) => (a.createdAt?.toMillis?.() || 0) - (b.createdAt?.toMillis?.() || 0))
          .at(-1);
        return latestVisibleMessage
          ? {
              ...chat,
              lastMessage: buildMessagePreviewLabel(latestVisibleMessage),
            }
          : chat;
      }),
    );

    await Promise.all(
      uniqueIds.map((messageId) =>
        updateDoc(doc(db, "chats", chatId, "messages", messageId), {
          timedOut: true,
          text: "",
          mediaURL: "",
          mediaType: "",
          mediaName: "",
          timedOutAt: serverTimestamp(),
        }).catch(() => {}),
      ),
    );
    await syncChatLastMessage(chatId).catch(() => {});
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
      playAppSound("success");
    } catch (error) {
      playAppSound("error");
      setAuthError(normalizeAuthError(error));
    } finally {
      setBusyLabel("");
    }
  }

  async function handleGoogleSignIn() {
    setAuthError("");
    setCapacityError("");
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    const usersRef = collection(db, "users");

    try {
      setBusyLabel("Signing in with Google...");
      let cred;
      if (IS_NATIVE_MOBILE_APP) {
        if (!socialLoginInitRef.current) {
          await SocialLogin.initialize({
            google: {
              webClientId: GOOGLE_WEB_CLIENT_ID,
              mode: "online",
            },
          });
          socialLoginInitRef.current = true;
        }
        const nativeResult = await SocialLogin.login({
          provider: "google",
          options: {
            scopes: ["email", "profile"],
            filterByAuthorizedAccounts: false,
          },
        });
        const idToken = nativeResult?.result?.responseType === "online" ? nativeResult.result.idToken : "";
        if (!idToken) {
          throw new Error("Native Google sign-in did not return an ID token.");
        }
        cred = await signInWithCredential(auth, GoogleAuthProvider.credential(idToken));
      } else {
        cred = await signInWithPopup(auth, provider);
      }
      const existingUserSnap = await getDoc(doc(db, "users", cred.user.uid));
      const isFirstLogin = !existingUserSnap.exists();

      if (isFirstLogin) {
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
            await deleteUser(cred.user).catch(() => {});
            await signOut(auth).catch(() => {});
            if (totalUsers >= MAX_TOTAL_USERS) {
              setCapacityError(`Signup closed: max ${MAX_TOTAL_USERS} accounts reached.`);
            } else {
              setCapacityError(`Try later: max ${MAX_ACTIVE_USERS} active users reached.`);
            }
            return;
          }
        } catch (capacityError) {
          if (!isPermissionDenied(capacityError)) throw capacityError;
        }
      } else {
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
            await signOut(auth).catch(() => {});
            setCapacityError(`Try later: max ${MAX_ACTIVE_USERS} active users reached.`);
            return;
          }
        } catch (capacityError) {
          if (!isPermissionDenied(capacityError)) throw capacityError;
        }
      }

      const displayName = `${cred.user.displayName || authForm.username || cred.user.email?.split("@")[0] || "User"}`.trim();
      await setDoc(
        doc(db, "users", cred.user.uid),
        {
          email: (cred.user.email || "").toLowerCase(),
          emailLower: (cred.user.email || "").toLowerCase(),
          username: displayName,
          bio: existingUserSnap.data()?.bio || "",
          photoURL: cred.user.photoURL || existingUserSnap.data()?.photoURL || "",
          isOnline: true,
          lastActiveAt: serverTimestamp(),
          createdAt: existingUserSnap.data()?.createdAt || serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
      playAppSound("success");
    } catch (error) {
      playAppSound("error");
      setAuthError(normalizeAuthError(error) === "Authentication failed." ? "Google sign-in failed." : normalizeAuthError(error));
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
      playAppSound("success");
      setForgotStatus("If this email is registered, a password reset mail has been sent.");
    } catch {
      playAppSound("error");
      setForgotStatus("Unable to process reset right now. Please try again.");
    } finally {
      setBusyLabel("");
    }
  }

  async function handleLogout() {
    playAppSound("decline");
    await signOut(auth);
  }

  async function sendPayload(payload, options = {}) {
    if (!selectedChat || !currentUser) return;
    await addDoc(collection(db, "chats", selectedChat.id, "messages"), payload);
    playAppSound(payload?.isEvent ? "event" : "send");
    const lastMessage = options.lastMessage || buildMessagePreviewLabel(payload);
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
    if (messageMode.type !== "normal" && !canUseSpecialMessageMode()) return;
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
        viewOnce: messageMode.type === "viewOnce",
        expiresAt:
          messageMode.type === "timed" && messageMode.durationMs > 0
            ? Timestamp.fromDate(new Date(Date.now() + messageMode.durationMs))
            : null,
        createdAt: serverTimestamp(),
      });

      await sendPayload(payload);
      setText("");
      setReplyingTo(null);
      resetMessageMode();
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
    if (messageMode.type !== "normal" && !canUseSpecialMessageMode()) return;
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
          viewOnce: messageMode.type === "viewOnce",
          expiresAt:
            messageMode.type === "timed" && messageMode.durationMs > 0
              ? Timestamp.fromDate(new Date(Date.now() + messageMode.durationMs))
              : null,
          createdAt: serverTimestamp(),
        }),
        { lastMessage: messageMode.type === "normal" ? `Contact: ${name.trim()}` : undefined },
      );
      setReplyingTo(null);
      resetMessageMode();
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
    if (messageMode.type !== "normal" && !canUseSpecialMessageMode()) return;
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
          viewOnce: messageMode.type === "viewOnce",
          expiresAt:
            messageMode.type === "timed" && messageMode.durationMs > 0
              ? Timestamp.fromDate(new Date(Date.now() + messageMode.durationMs))
              : null,
          createdAt: serverTimestamp(),
        }),
        { lastMessage: messageMode.type === "normal" ? "Location shared" : undefined },
      );
      setReplyingTo(null);
      resetMessageMode();
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
      playAppSound("success");
      setFriendEmail("");
    } catch (error) {
      playAppSound("error");
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
      playAppSound(status === "accepted" ? "accept" : "decline");
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
      playAppSound("success");
      setProfileStatus("Profile picture updated.");
    } catch (error) {
      playAppSound("error");
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
      playAppSound("success");
      setProfileStatus("Profile updated.");
    } catch (error) {
      playAppSound("error");
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
      playAppSound("success");
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
      playAppSound("delete");
    } finally {
      setBusyLabel("");
    }
  }

  async function copyMessage(msg) {
    const content = (msg.text || "").trim() || msg.mediaURL || "";
    if (!content) return;
    try {
      await navigator.clipboard.writeText(content);
      playAppSound("copy");
      setOpenMessageMenuId("");
    } catch {
      playAppSound("error");
      setOpenMessageMenuId("");
    }
  }

  async function toggleReaction(messageId, emoji, hasReacted) {
    if (!selectedChatId || !currentUser || !emoji) return;
    try {
      await updateDoc(doc(db, "chats", selectedChatId, "messages", messageId), {
        [`reactions.${emoji}`]: hasReacted ? arrayRemove(currentUser.uid) : arrayUnion(currentUser.uid),
      });
      playAppSound(hasReacted ? "decline" : "accept");
    } finally {
      setOpenMessageMenuId("");
      setOpenReactionPickerId("");
    }
  }

  async function openViewOnceMessage(msg) {
    if (!selectedChatId || !currentUser || !msg?.id) return;
    setOpenedViewOnceMessageIds((prev) => (prev.includes(msg.id) ? prev : [...prev, msg.id]));
    setViewOnceOverlay({
      messageId: msg.id,
      senderId: msg.senderId || "",
      senderName: msg.senderName || msg.user || "User",
      text: msg.text || "",
      mediaURL: msg.mediaURL || "",
      mediaType: msg.mediaType || "",
      mediaName: msg.mediaName || "",
    });
    playAppSound("open");
  }

  async function closeViewOnceOverlay() {
    if (!selectedChatId || !viewOnceOverlay) {
      setViewOnceOverlay(null);
      return;
    }
    const shouldConsume = viewOnceOverlay.senderId !== currentUser?.uid;
    const messageId = viewOnceOverlay.messageId;
    setViewOnceOverlay(null);
    if (!shouldConsume || !messageId) return;

    setBusyLabel("Closing one-time message...");
    try {
      await deleteDoc(doc(db, "chats", selectedChatId, "messages", messageId));
      await syncChatLastMessage(selectedChatId);
      playAppSound("delete");
    } finally {
      setBusyLabel("");
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
      playAppSound("success");
      setSavedStatus("Message saved.");
      setOpenMessageMenuId("");
    } catch (error) {
      playAppSound("error");
      setSavedStatus(error.message || "Failed to save message.");
    } finally {
      setBusyLabel("");
    }
  }

  async function removeSavedMessage(savedId) {
    if (!currentUser) return;
    await deleteDoc(doc(db, "users", currentUser.uid, "savedMessages", savedId));
    playAppSound("delete");
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
      playAppSound("success");
      setGroupStatus("Group created.");
      closePopups();
    } catch (error) {
      playAppSound("error");
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
      playAppSound("success");
      setGroupProfileStatus("Group profile updated.");
    } catch (error) {
      playAppSound("error");
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
      playAppSound("success");
      setGroupProfileStatus("Member added.");
    } catch (error) {
      playAppSound("error");
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
      playAppSound("delete");
      setGroupProfileStatus("Member removed.");
    } catch (error) {
      playAppSound("error");
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
      playAppSound("success");
      setGroupProfileStatus("Role updated.");
    } catch (error) {
      playAppSound("error");
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
      playAppSound("success");
      setSubgroupStatus("Subgroup created.");
    } catch (error) {
      playAppSound("error");
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
      playAppSound("event");
      setEventStatus("Event scheduled.");
      setShowEventScheduler(false);
    } catch (error) {
      playAppSound("error");
      setEventStatus(error.message || "Failed to schedule event.");
    } finally {
      setBusyLabel("");
    }
  }

  function renderTicTacToeCard() {
    if (!activeGame) return null;
    const board = Array.isArray(activeGame.board) ? activeGame.board : Array(9).fill("");
    const currentMark = activeGame.marks?.[currentUser?.uid] || "";
    const opponentMark = activeGame.marks?.[gameOpponentId] || "";
    const statusText =
      activeGame.status === "countdown"
        ? `Starting in ${activeGameCountdown}s`
        : activeGame.winner === "draw"
          ? "Draw game."
          : activeGame.status === "finished" && activeGame.winner
            ? `${activeGame.winner === currentUser?.uid ? "You" : activeGameOpponent?.username || "Opponent"} won.`
            : activeGame.turn === currentUser?.uid
              ? "Your turn."
              : `${activeGameOpponent?.username || "Opponent"} is playing.`;

    return (
      <section className={`chatGameCard ${activeGame.status === "countdown" ? "countdown" : ""}`}>
        <div className="chatGameHead">
          <div>
            <span className="chatGameEyebrow">Live game</span>
            <h3>{formatGameTypeLabel(activeGame.type)}</h3>
            <p>{statusText}</p>
          </div>
          <div className="chatGameHeadActions">
            <span className="chatGameBadge">You: {currentMark || "-"}</span>
            <span className="chatGameBadge">{activeGameOpponent?.username || "Opponent"}: {opponentMark || "-"}</span>
          </div>
        </div>
        {renderGameCloseNotice()}
        <div className="ticTacToeBoard">
          {board.map((cell, index) => (
            <button
              type="button"
              key={`cell_${index}`}
              className={`ticTacToeCell ${activeGame.winnerLine?.includes(index) ? "winnerCell" : ""}`}
              disabled={activeGame.status !== "active" || activeGame.turn !== currentUser?.uid || Boolean(cell)}
              onClick={() => playTicTacToe(index)}
            >
              {cell || "·"}
            </button>
          ))}
        </div>
        <div className="chatGameFooter">
          {activeGame.status === "finished" ? (
            <button type="button" className="ghost" onClick={restartActiveGame}>
              Rematch
            </button>
          ) : (
            <small>Leave the chat and come back later. The board stays here until someone closes it.</small>
          )}
          {renderGameFooterActions()}
        </div>
      </section>
    );
  }

  function renderRpsCard() {
    if (!activeGame) return null;
    const myPick = activeGame.picks?.[currentUser?.uid] || "";
    const opponentPick = activeGame.status === "finished" ? activeGame.picks?.[gameOpponentId] || "" : "";
    const shouldShake = activeGame.status === "active" && countTruthyValues(activeGame.picks) < 2;
    const shouldReveal = activeGame.status === "finished" || rpsRevealTick > 0;
    const myHand = shouldReveal ? (myPick || "rock") : "rock";
    const opponentHand = shouldReveal ? (opponentPick || "rock") : "rock";
    const handIcon = {
      rock: "✊",
      paper: "✋",
      scissors: "✌",
    };
    const resultLabel =
      activeGame.status === "countdown"
        ? `Starting in ${activeGameCountdown}s`
        : activeGame.status === "finished"
          ? activeGame.winner === "draw"
            ? activeGame.resultText || "Draw."
            : `${activeGame.winner === currentUser?.uid ? "You won." : `${activeGameOpponent?.username || "Opponent"} won.`} ${activeGame.resultText || ""}`.trim()
          : myPick
            ? `You picked ${myPick}. Waiting for ${activeGameOpponent?.username || "opponent"}.`
            : "Choose your move.";

    return (
      <section className={`chatGameCard ${activeGame.status === "countdown" ? "countdown" : ""}`}>
        <div className="chatGameHead">
          <div>
            <span className="chatGameEyebrow">Live game</span>
            <h3>{formatGameTypeLabel(activeGame.type)}</h3>
            <p>{resultLabel}</p>
          </div>
          <div className="chatGameHeadActions">
            <span className="chatGameBadge">You: {myPick || "..."}</span>
            <span className="chatGameBadge">{activeGameOpponent?.username || "Opponent"}: {opponentPick || (activeGame.status === "finished" ? "..." : "Hidden")}</span>
          </div>
        </div>
        {renderGameCloseNotice()}
        <div className="rpsStage">
          <div className={`rpsHandCard left ${shouldShake ? "shaking" : ""} ${shouldReveal ? "revealed" : ""}`}>
            <span className="rpsPlayerLabel">You</span>
            <div className="rpsHand">{handIcon[myHand]}</div>
          </div>
          <div className="rpsVsPill">VS</div>
          <div className={`rpsHandCard right ${shouldShake ? "shaking" : ""} ${shouldReveal ? "revealed" : ""}`}>
            <span className="rpsPlayerLabel">{activeGameOpponent?.username || "Opponent"}</span>
            <div className="rpsHand">{handIcon[opponentHand]}</div>
          </div>
        </div>
        <div className="rpsGrid">
          {RPS_CHOICES.map((choice) => (
            <button
              type="button"
              key={choice}
              className={`rpsChoice ${myPick === choice ? "active" : ""}`}
              disabled={activeGame.status !== "active" || Boolean(myPick)}
              onClick={() => playRps(choice)}
            >
              <strong>{choice}</strong>
            </button>
          ))}
        </div>
        <div className="chatGameFooter">
          {activeGame.status === "finished" ? (
            <button type="button" className="ghost" onClick={restartActiveGame}>
              Play again
            </button>
          ) : (
            <small>Your pick stays hidden until both players commit.</small>
          )}
          {renderGameFooterActions()}
        </div>
      </section>
    );
  }

  function renderLudoCard() {
    if (!activeGame || !currentUser) return null;
    const playerIds = Array.isArray(activeGame.players) ? activeGame.players : [];
    const displayedTokens = animatedLudoTokens || activeGame.tokens || {};
    const myTokens = Array.isArray(displayedTokens?.[currentUser.uid]) ? displayedTokens[currentUser.uid] : Array(LUDO_TOKEN_COUNT).fill(-1);
    const movable = activeGame.turn === currentUser.uid ? getLudoMovableTokenIndexes(myTokens, activeGame.currentRoll) : [];
    const activeTurnName =
      activeGame.turn === currentUser.uid
        ? "Your"
        : usersById.get(activeGame.turn)?.username || "Player";
    const winnerName =
      activeGame.winner === currentUser.uid
        ? "You"
        : usersById.get(activeGame.winner)?.username || "Player";
    const statusText =
      activeGame.status === "countdown"
        ? `Starting in ${activeGameCountdown}s`
        : activeGame.status === "finished"
          ? `${winnerName} won. ${activeGame.resultText || ""}`.trim()
          : activeGame.turn === currentUser.uid
            ? activeGame.currentRoll
              ? `Rolled ${activeGame.currentRoll}. Choose a token.`
              : "Your turn. Roll the dice."
            : `${activeTurnName} is taking a turn.`;

    return (
      <section className={`chatGameCard ${activeGame.status === "countdown" ? "countdown" : ""}`}>
        <div className="chatGameHead">
          <div>
            <span className="chatGameEyebrow">Live game</span>
            <h3>{formatGameTypeLabel(activeGame.type)}</h3>
            <p>{statusText}</p>
          </div>
          <div className="chatGameHeadActions">
            {playerIds.map((playerId, index) => (
              <span key={`ludo_badge_${playerId}`} className={`chatGameBadge ludoBadge ludoBadge${index}`}>
                {(playerId === currentUser.uid ? "You" : usersById.get(playerId)?.username || `Player ${index + 1}`)} home: {activeGame.finishedCounts?.[playerId] || 0}/{LUDO_TOKEN_COUNT}
              </span>
            ))}
          </div>
        </div>
        {renderGameCloseNotice()}
        <div className="ludoBoard">
          <div className="ludoBoardMap">
            <img src="/games/ludo-board.svg" alt="Ludo board" className="ludoBoardImage" />
            {playerIds.flatMap((playerId, playerIndex) => {
              const playerTokens = Array.isArray(displayedTokens?.[playerId]) ? displayedTokens[playerId] : Array(LUDO_TOKEN_COUNT).fill(-1);
              return playerTokens.map((position, index) => {
                const coords = getLudoTokenCoords(position, index, playerIndex);
                const isMe = playerId === currentUser.uid;
                const isMovable = isMe && movable.includes(index);
                const tokenLabel = isMe ? `Your token ${index + 1}` : `${usersById.get(playerId)?.username || `Player ${playerIndex + 1}`} token ${index + 1}`;
                if (isMe) {
                  return (
                    <button
                      type="button"
                      key={`ludo_piece_${playerId}_${index}`}
                      className={`ludoPiece ludoPiece${playerIndex} ${isMovable ? "active" : ""}`}
                      style={{ left: `${coords.x}%`, top: `${coords.y}%` }}
                      disabled={!isMovable}
                      onClick={() => moveLudoToken(index)}
                      title={tokenLabel}
                    >
                      <span>{index + 1}</span>
                    </button>
                  );
                }
                return (
                  <span
                    key={`ludo_piece_${playerId}_${index}`}
                    className={`ludoPiece ludoPiece${playerIndex}`}
                    style={{ left: `${coords.x}%`, top: `${coords.y}%` }}
                    title={tokenLabel}
                  >
                    <span>{index + 1}</span>
                  </span>
                );
              });
            })}
          </div>
          <div className="ludoDicePanel">
            <div className={`ludoDieFace ${activeGame.turn === currentUser.uid && !activeGame.currentRoll && activeGame.status === "active" ? "rollingReady" : ""}`}>
              {activeGame.currentRoll || activeGame.lastRoll || "?"}
            </div>
            <button
              type="button"
              disabled={activeGame.status !== "active" || activeGame.turn !== currentUser.uid || Boolean(activeGame.currentRoll)}
              onClick={rollLudoDice}
            >
              Roll Dice
            </button>
          </div>
        </div>
        <div className="chatGameFooter">
          <small>{activeGame.resultText || "Roll 6 to bring a token out. Exact roll is needed to reach home."}</small>
          <div className="chatGameInlineActions">
            {activeGame.status === "finished" && (
              <button type="button" className="ghost" onClick={restartActiveGame}>
                Play again
              </button>
            )}
            {renderGameFooterActions()}
          </div>
        </div>
      </section>
    );
  }

  function renderGameCloseNotice() {
    if (!activeGame || !currentUser) return null;
    if (!activeGame.closeRequestBy) return null;
    const requesterName =
      activeGame.closeRequestBy === currentUser.uid
        ? "You"
        : usersById.get(activeGame.closeRequestBy)?.username || "Player";
    if (activeGame.closeRequestBy === currentUser.uid) {
      return (
        <div className="gameCloseNotice">
          <p>{requesterName} asked to end this game. Waiting for the others.</p>
          <button type="button" className="ghost" onClick={clearCloseGameRequest}>
            Cancel Request
          </button>
        </div>
      );
    }
    return (
      <div className="gameCloseNotice">
        <p>{requesterName} asked to end this game.</p>
        <div className="gameTemplateActions">
          <button type="button" onClick={acceptCloseGameRequest}>
            Accept End
          </button>
          <button type="button" className="ghost" onClick={clearCloseGameRequest}>
            Keep Playing
          </button>
        </div>
      </div>
    );
  }

  function renderGameFooterActions() {
    if (!activeGame || !currentUser) return null;
    const isStarter = activeGame.startedBy === currentUser.uid;
    const hasPendingCloseRequest = Boolean(activeGame.closeRequestBy);
    if (activeGame.status === "finished") {
      return (
        <button type="button" className="ghost dangerGhost" onClick={closeActiveGame}>
          End Game
        </button>
      );
    }
    if (isStarter) {
      if (showGameCloseOptions) {
        return (
          <div className="chatGameInlineActions">
            <button type="button" className="ghost" onClick={closeGameOverlay}>
              Close View
            </button>
            <button
              type="button"
              className="ghost dangerGhost"
              onClick={requestCloseActiveGame}
              disabled={hasPendingCloseRequest}
            >
              Ask to End
            </button>
            <button type="button" className="ghost" onClick={() => setShowGameCloseOptions(false)}>
              Cancel
            </button>
          </div>
        );
      }
      return (
        <button type="button" className="ghost dangerGhost" onClick={() => setShowGameCloseOptions(true)}>
          Close
        </button>
      );
    }
    return (
      <button type="button" className="ghost dangerGhost" onClick={closeGameOverlay}>
        Close
      </button>
    );
  }

  function renderActiveGameCard() {
    if (!activeGame) return null;
    if (activeGame.type === GAME_TYPES.tictactoe) return renderTicTacToeCard();
    if (activeGame.type === GAME_TYPES.rps) return renderRpsCard();
    if (activeGame.type === GAME_TYPES.ludo) return renderLudoCard();
    return null;
  }

  function renderNavIcon(type) {
    if (type === "messages") {
      return (
        <span className="navIconWrap" aria-hidden="true">
          <svg viewBox="0 0 24 24" className="navIconSvg">
            <path
              d="M5 6.5a2.5 2.5 0 0 1 2.5-2.5h9A2.5 2.5 0 0 1 19 6.5v6A2.5 2.5 0 0 1 16.5 15H11l-3.8 3.4c-.5.4-1.2.1-1.2-.5V15.2A2.5 2.5 0 0 1 5 12.5z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      );
    }
    if (type === "notifications") {
      return (
        <span className="navIconWrap" aria-hidden="true">
          <svg viewBox="0 0 24 24" className="navIconSvg">
            <path
              d="M12 4.5a4 4 0 0 0-4 4v2.2c0 .7-.2 1.4-.6 2l-1.1 1.7c-.4.7.1 1.6.9 1.6h9.6c.8 0 1.3-.9.9-1.6l-1.1-1.7c-.4-.6-.6-1.3-.6-2V8.5a4 4 0 0 0-4-4Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M10.2 17.2a2 2 0 0 0 3.6 0"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
        </span>
      );
    }
    return (
      <span className="navProfileWrap">
        <Avatar
          name={username}
          photoURL={userProfile?.photoURL || currentUser?.photoURL || ""}
          className="navAvatar"
        />
        <span className="navPresenceDot" />
      </span>
    );
  }

  function renderUiIcon(type) {
    if (type === "add-friend") {
      return (
        <svg viewBox="0 0 24 24" className="actionIconSvg" aria-hidden="true">
          <path d="M15 19a5 5 0 0 0-10 0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <circle cx="10" cy="9" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <path d="M18 8v6M15 11h6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      );
    }
    if (type === "create-group") {
      return (
        <svg viewBox="0 0 24 24" className="actionIconSvg" aria-hidden="true">
          <circle cx="8" cy="9" r="2.7" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <circle cx="15.5" cy="8" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <path d="M4 18a4 4 0 0 1 8 0M13 17.2a3.2 3.2 0 0 1 6.1 0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      );
    }
    return null;
  }

  function renderNotificationsContent(showClose = true) {
    return (
      <>
        <div className="popupHead">
          <h3>Friend Requests</h3>
          {showClose && (
            <button type="button" className="ghost" onClick={closePopups}>
              Close
            </button>
          )}
        </div>
        <div className="notifyTools">
          <p className="muted">Browser alerts: {notificationPermission}</p>
          <p className="muted">
            Cloud messaging: {notificationPermission === "granted" ? "Access is granted" : fcmStatus || "not configured"}
          </p>
          {notificationPermission !== "granted" && (
            <button type="button" className="ghost" onClick={() => requestNotificationPermission().catch(() => {})}>
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
      </>
    );
  }

  function renderProfileContent(showClose = true) {
    return (
      <>
        <div className="popupHead">
          <h3>Profile</h3>
          {showClose && (
            <button type="button" className="ghost" onClick={closePopups}>
              Close
            </button>
          )}
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
          <button type="button" className="ghost" onClick={() => handleLogout().catch(() => {})}>
            Logout
          </button>
        </div>
      </>
    );
  }

  function renderGameTemplateMessage(message) {
    if (message.isGameInvite) {
      const canAccept = message.inviteStatus === "pending" && message.senderId !== currentUser?.uid;
      const canDecline = message.inviteStatus === "pending" && message.senderId !== currentUser?.uid;
      return (
        <article className="gameTemplateStack" key={message.id}>
          <div className="gameTemplateCard invite">
            <span className="eventTemplateLabel">Game Invite</span>
            <strong>{formatGameTypeLabel(message.gameType)}</strong>
            <p>{message.text || `${message.senderName || "Someone"} invited you to play.`}</p>
            <small>{formatTime(message.createdAt)}</small>
            <div className="gameTemplateActions">
              {canAccept ? (
                <>
                  <button type="button" onClick={() => acceptGameInvite(message)}>
                    Accept
                  </button>
                  {canDecline && (
                    <button type="button" className="ghost" onClick={() => declineGameInvite(message)}>
                      Decline
                    </button>
                  )}
                </>
              ) : (
                <span className="rolePill">
                  {message.inviteStatus === "accepted" ? "Accepted" : message.inviteStatus === "declined" ? "Declined" : "Pending"}
                </span>
              )}
            </div>
          </div>
        </article>
      );
    }

    if (message.isGameSession) {
      const isCurrentSession = activeGame?.sessionId && activeGame.sessionId === message.gameSessionId;
      return (
        <article className="gameTemplateStack" key={message.id}>
          <div className="gameTemplateCard session">
            <span className="eventTemplateLabel">Game</span>
            <strong>{formatGameTypeLabel(message.gameType || message.gameSessionType)}</strong>
            <p>{message.text || "Game session created."}</p>
            <small>{formatTime(message.createdAt)}</small>
            <div className="gameTemplateActions">
              {isCurrentSession ? (
                <button type="button" onClick={openGameOverlay}>
                  Open Game
                </button>
              ) : (
                <span className="rolePill">Closed</span>
              )}
            </div>
          </div>
        </article>
      );
    }

    return null;
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
          <div className="stack authAltActions">
            <button type="button" className="googleAuthBtn" onClick={handleGoogleSignIn}>
              <span className="googleAuthLogo" aria-hidden="true">
                <svg viewBox="0 0 24 24" focusable="false">
                  <path fill="#EA4335" d="M12 10.2v3.9h5.5c-.2 1.3-1.5 3.9-5.5 3.9-3.3 0-6-2.7-6-6s2.7-6 6-6c1.9 0 3.2.8 3.9 1.5l2.7-2.6C16.9 3.2 14.7 2.2 12 2.2 6.9 2.2 2.8 6.3 2.8 11.4S6.9 20.6 12 20.6c6.9 0 8.6-4.8 8.6-7.2 0-.5 0-.9-.1-1.3H12z" />
                  <path fill="#34A853" d="M3.6 7.3l3.2 2.3C7.6 7.7 9.6 6 12 6c1.9 0 3.2.8 3.9 1.5l2.7-2.6C16.9 3.2 14.7 2.2 12 2.2c-3.6 0-6.8 2.1-8.4 5.1z" />
                  <path fill="#FBBC05" d="M12 20.6c2.6 0 4.8-.9 6.4-2.5l-3-2.4c-.8.6-1.9 1.1-3.4 1.1-3.9 0-5.3-2.6-5.5-3.9l-3.2 2.5c1.6 3 4.7 5.2 8.7 5.2z" />
                  <path fill="#4285F4" d="M20.6 13.4c0-.5 0-.9-.1-1.3H12v3.9h5.5c-.1.9-.7 2.1-2.1 3l3 2.4c1.8-1.7 2.8-4.1 2.8-8z" />
                </svg>
              </span>
              <span>Continue with Google</span>
            </button>
          </div>

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
        className={`appShell ${isMobileLayout ? "mobileLayout" : ""} ${mobileScreen === "chat" ? "showMobileChat" : "showMobileList"} ${chatListCollapsed && !isMobileLayout ? "chatListCollapsed" : ""}`}
      >
        {!isMobileLayout && (
          <nav className="sideNavRail">
            <button
              type="button"
              className="ghost sideNavBtn active"
              onClick={() => {
                closePopups();
                setMobileNavSection("messages");
              }}
              aria-label="Messages"
              title="Messages"
            >
              {renderNavIcon("messages")}
              <span className="navTextLabel">Messages</span>
            </button>
            <button
              type="button"
              className={`ghost sideNavBtn ${showNotifications ? "active" : ""}`}
              onClick={openNotificationPopup}
              aria-label="Notifications"
              title="Notifications"
            >
              {renderNavIcon("notifications")}
              <span className="navTextLabel">Notifications</span>
            </button>
            <button
              type="button"
              className={`ghost sideNavBtn ${showProfile ? "active" : ""}`}
              onClick={openProfilePopup}
              aria-label="Profile"
              title="Profile"
            >
              {renderNavIcon("profile")}
              <span className="navTextLabel">You</span>
            </button>
          </nav>
        )}
        {isMobileLayout && mobileNavSection !== "messages" ? (
          <section className="mobileSectionView">
            <div className="mobileSectionCard">
              {mobileNavSection === "notifications" ? renderNotificationsContent(false) : renderProfileContent(false)}
            </div>
          </section>
        ) : (
          <>
        <aside className="sidebar">
        <div className="sidebarTop">
          <div className="sidebarTitleRow">
            <h2>Chats</h2>
          </div>
          <div className="sideActions">
            <button
              type="button"
              className="sidebarActionBtn iconOnly"
              onClick={openAddFriendPopup}
              aria-label="Add friend"
              title="Add friend"
            >
              <span className="actionIconWrap">{renderUiIcon("add-friend")}</span>
            </button>
            {availableGroupFriends.length > 0 && (
              <button
                type="button"
                className="ghost sidebarActionBtn iconOnly"
                onClick={openCreateGroupPopup}
                aria-label="Create group"
                title="Create group"
              >
                <span className="actionIconWrap">{renderUiIcon("create-group")}</span>
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
          {mainChatList.length === 0 && !chatListCollapsed && <p className="muted">There is no message here.</p>}
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
                <span className="panelNameChip">{selectedChatOtherUser?.username || "Textinger"}</span>
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
        </header>

        <div className={`panelBody ${selectedChat?.isGroup ? "withSubgroups" : ""} ${selectedChatIsLocked ? "chatLocked" : ""}`}>
        <section className={`messageArea ${activeGame?.status === "countdown" ? "gameCountdownGlow" : ""}`}>
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
                  if (group.items.every((item) => item.isEvent)) {
                    return (
                      <article key={group.id} className="eventBubbleStack">
                        {group.items.map((msg) => (
                          <div key={msg.id} className="eventMessageCard">
                            <span className="eventTemplateLabel">Event</span>
                            <strong>{msg.eventTitle || "Scheduled Event"}</strong>
                            <p>{msg.eventDescription || msg.text || "Event started."}</p>
                            <small>{formatTime(msg.createdAt)}</small>
                          </div>
                        ))}
                      </article>
                    );
                  }
                  if (group.items.every((item) => item.isGameInvite || item.isGameSession)) {
                    return group.items.map((msg) => renderGameTemplateMessage(msg));
                  }

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
                          const isViewOnceLocked = Boolean(msg.viewOnce && msg.senderId !== currentUser.uid && !openedViewOnceMessageIds.includes(msg.id));
                          const reactions = Object.entries(msg.reactions || {}).filter(([, ids]) => Array.isArray(ids) && ids.length > 0);
                          return (
                            <div
                              key={msg.id}
                              className={`groupedMessageItem ${openReactionPickerId === msg.id ? "reactionPickerOpen" : ""}`}
                              onClick={(event) => {
                                if (isInteractiveMessageTarget(event.target)) return;
                                if (editingMessageId === msg.id || isViewOnceLocked) return;
                                toggleReactionPicker(msg.id);
                              }}
                              onPointerDown={(event) => {
                                if (isInteractiveMessageTarget(event.target)) return;
                                if (editingMessageId === msg.id || isViewOnceLocked) return;
                                beginMessageLongPress(msg.id);
                              }}
                              onPointerUp={cancelMessageLongPress}
                              onPointerLeave={cancelMessageLongPress}
                              onPointerCancel={cancelMessageLongPress}
                            >
                              <div className="messageMetaBadges">
                                {msg.viewOnce && <span className="messageBadge">One-time</span>}
                                {msg.expiresAt && <span className="messageBadge">Timed</span>}
                                {msg.timedOut && <span className="messageBadge timedOut">Timed out</span>}
                              </div>
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
                                <>
                                  {msg.timedOut ? (
                                    <div className="timedOutCard">
                                      <strong>Message timed out</strong>
                                      <small>This timed message is no longer available.</small>
                                    </div>
                                  ) : isViewOnceLocked ? (
                                    <button
                                      type="button"
                                      className="viewOnceCard"
                                      onClick={() => openViewOnceMessage(msg)}
                                    >
                                      <strong>Open one-time message</strong>
                                      <small>This message disappears after opening.</small>
                                    </button>
                                  ) : (
                                    msg.text && <p>{renderTextWithLinks(msg.text)}</p>
                                  )}
                                </>
                              )}
                              {msg.mediaURL && !isViewOnceLocked && (
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
                              <div className="reactionRow">
                                {reactions.map(([emoji, ids]) => {
                                  const hasReacted = Array.isArray(ids) && ids.includes(currentUser.uid);
                                  return (
                                    <button
                                      key={emoji}
                                      type="button"
                                      className={`reactionPill ${hasReacted ? "active" : ""}`}
                                      onClick={() => toggleReaction(msg.id, emoji, hasReacted)}
                                    >
                                      <span>{emoji}</span>
                                      <small>{formatReactionCount(ids)}</small>
                                    </button>
                                  );
                                })}
                                {!isViewOnceLocked && openReactionPickerId === msg.id && (
                                  <div className="reactionTray">
                                    {quickReactionOptions.map((emoji) => {
                                      const hasReacted = Array.isArray(msg.reactions?.[emoji]) && msg.reactions[emoji].includes(currentUser.uid);
                                      return (
                                        <button
                                          key={emoji}
                                          type="button"
                                          className={`reactionQuickBtn ${hasReacted ? "active" : ""}`}
                                          onClick={(event) => {
                                            event.stopPropagation();
                                            toggleReaction(msg.id, emoji, hasReacted);
                                          }}
                                        >
                                          {emoji}
                                        </button>
                                      );
                                    })}
                                    <button
                                      type="button"
                                      className="reactionAddBtn"
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        chooseCustomReactionEmoji();
                                      }}
                                      title="Choose quick reaction emoji"
                                      aria-label="Choose quick reaction emoji"
                                    >
                                      +
                                    </button>
                                  </div>
                                )}
                              </div>
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
                                        onClick={() => toggleReactionPicker(msg.id)}
                                      >
                                        React
                                      </button>
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
              {describeMessageMode() && (
                <div className="messageModeBar">
                  <span>{describeMessageMode()}</span>
                  <button type="button" className="ghost" onClick={resetMessageMode}>
                    Clear
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
                          setMessageMode({ type: "viewOnce", durationMs: 0 });
                          setTimedMenuOpen(false);
                          setAttachMenuOpen(false);
                        }}
                      >
                        One-time
                      </button>
                      <button
                        type="button"
                        className={`ghost menuItem timedParentBtn ${timedMenuOpen ? "active" : ""}`}
                        onClick={() => setTimedMenuOpen((prev) => !prev)}
                      >
                        Timed
                      </button>
                      {timedMenuOpen && (
                        <div className="timedMenuGroup">
                          <div className="timedMenuOptions">
                            {TIMED_MESSAGE_OPTIONS.map((option) => (
                              <button
                                key={option.value}
                                type="button"
                                className={`ghost timedOptionBtn ${messageMode.type === "timed" && messageMode.durationMs === option.value ? "active" : ""}`}
                                onClick={() => {
                                  setMessageMode({ type: "timed", durationMs: option.value });
                                  setTimedMenuOpen(false);
                                  setAttachMenuOpen(false);
                                }}
                              >
                                {option.label}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                      <button
                        type="button"
                        className="ghost menuItem"
                        onClick={() => {
                          setTimedMenuOpen(false);
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
                          setTimedMenuOpen(false);
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
                          setTimedMenuOpen(false);
                          openGamesPopup();
                          setAttachMenuOpen(false);
                        }}
                      >
                        Games
                      </button>
                      <button
                        type="button"
                        className="ghost menuItem"
                        onClick={() => {
                          setTimedMenuOpen(false);
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
                          setTimedMenuOpen(false);
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
                          setTimedMenuOpen(false);
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
                            setTimedMenuOpen(false);
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
              {isMobileLayout && mainChatList.length === 0 && (
                <button type="button" onClick={openAddFriendPopup}>
                  Add Friend
                </button>
              )}
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
        </>
        )}

        {(showAddFriend || showCreateGroup || showNotifications || showProfile || showEventScheduler || showGroupProfile || showGamesMenu) && (
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
              {renderNotificationsContent()}
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

          {showGamesMenu && (
            <section className="popupCard" onClick={(event) => event.stopPropagation()}>
              <div className="popupHead">
                <h3>Chat Games</h3>
                <button type="button" className="ghost" onClick={closePopups}>
                  Close
                </button>
              </div>
              <p className="muted">
                {canUseGamesInChat || canUseLudoInChat
                  ? "Pick a game. Ludo also works in group chats with exactly 4 members."
                  : "Games work in direct chats only, except Ludo which supports 4-member groups."}
              </p>
              <div className="gamesMenuGrid">
                <button
                  type="button"
                  className="gameMenuCard"
                  onClick={() => startChatGame(GAME_TYPES.tictactoe)}
                  disabled={!canUseGamesInChat || activeGame || hasPendingGameInvite}
                >
                  <span className="gameMenuBadge">Board</span>
                  <strong>Tic-Tac-Toe</strong>
                  <small>Turn-based board game with persistent state in the chat.</small>
                </button>
                <button
                  type="button"
                  className="gameMenuCard"
                  onClick={() => startChatGame(GAME_TYPES.rps)}
                  disabled={!canUseGamesInChat || activeGame || hasPendingGameInvite}
                >
                  <span className="gameMenuBadge">Quick</span>
                  <strong>Rock Paper Scissors</strong>
                  <small>Both players choose privately, then the result resolves in-chat.</small>
                </button>
                <button
                  type="button"
                  className="gameMenuCard"
                  onClick={() => startChatGame(GAME_TYPES.ludo)}
                  disabled={!canUseLudoInChat || activeGame || hasPendingGameInvite}
                >
                  <span className="gameMenuBadge">Race</span>
                  <strong>Ludo</strong>
                  <small>Two tokens each, dice rolls, captures, and now up to 4 players in group chats.</small>
                </button>
              </div>
              {activeGame && (
                <p className="muted">
                  Active session: <strong>{formatGameTypeLabel(activeGame.type)}</strong> ({activeGame.status})
                </p>
              )}
              {!activeGame && hasPendingGameInvite && <p className="muted">A game invite is already pending in this chat.</p>}
              {gameStatus && <p className="muted">{gameStatus}</p>}
            </section>
          )}

          {showProfile && (
            <section className="popupCard" onClick={(event) => event.stopPropagation()}>
              {renderProfileContent()}
            </section>
          )}
          </div>
        )}
      </main>
      {isMobileLayout && isTrueMobileDevice && mobileScreen !== "chat" && (
        <nav className="mobileBottomNav">
          <button
            type="button"
            className={`ghost mobileBottomNavBtn ${mobileNavSection === "messages" ? "active" : ""}`}
            onClick={() => {
              setMobileNavSection("messages");
              setMobileScreen("list");
            }}
            aria-label="Messages"
          >
            {renderNavIcon("messages")}
            <span className="navTextLabel">Messages</span>
          </button>
          <button
            type="button"
            className={`ghost mobileBottomNavBtn ${mobileNavSection === "notifications" ? "active" : ""}`}
            onClick={() => {
              closePopups();
              setMobileNavSection("notifications");
            }}
            aria-label="Notifications"
          >
            {renderNavIcon("notifications")}
            <span className="navTextLabel">Notifications</span>
          </button>
          <button
            type="button"
            className={`ghost mobileBottomNavBtn ${mobileNavSection === "profile" ? "active" : ""}`}
            onClick={() => {
              closePopups();
              setMobileNavSection("profile");
            }}
            aria-label="Profile"
          >
            {renderNavIcon("profile")}
            <span className="navTextLabel">You</span>
          </button>
        </nav>
      )}

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

      {showGameOverlay && activeGame && (
        <div className="gameOverlay" onClick={closeGameOverlay}>
          <div className="gameOverlayShell" onClick={(event) => event.stopPropagation()}>
            <div className="gameOverlayHead">
              <div>
                <strong>{formatGameTypeLabel(activeGame.type)}</strong>
                <small>{selectedChat?.isGroup ? selectedChat.groupName || "Group" : selectedChatOtherUser?.username || "Chat"}</small>
              </div>
              <button type="button" className="ghost" onClick={closeGameOverlay}>
                Close
              </button>
            </div>
            <div className="gameOverlayBody">
              {renderActiveGameCard()}
            </div>
          </div>
        </div>
      )}

      {viewOnceOverlay && (
        <div
          className="viewOnceOverlay"
          onClick={() => closeViewOnceOverlay().catch(() => {})}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div className="viewOnceOverlayCard" onClick={(event) => event.stopPropagation()}>
            <div className="viewOnceOverlayHead">
              <div>
                <strong>One-time message</strong>
                <small>{viewOnceOverlay.senderName}</small>
              </div>
              <button type="button" className="ghost" onClick={() => closeViewOnceOverlay().catch(() => {})}>
                Close
              </button>
            </div>
            <div className="viewOnceShield">Private view</div>
            {viewOnceOverlay.text && <p className="viewOnceOverlayText">{renderTextWithLinks(viewOnceOverlay.text)}</p>}
            {viewOnceOverlay.mediaURL && (
              <div className="viewOnceOverlayMedia">
                {viewOnceOverlay.mediaType?.startsWith("image/") ? (
                  <img
                    src={viewOnceOverlay.mediaURL}
                    alt={viewOnceOverlay.mediaName || "One-time media"}
                    className="viewOnceOverlayImage"
                    draggable="false"
                  />
                ) : viewOnceOverlay.mediaType?.startsWith("video/") ? (
                  <video controls className="viewOnceOverlayVideo">
                    <source src={viewOnceOverlay.mediaURL} type={viewOnceOverlay.mediaType} />
                  </video>
                ) : viewOnceOverlay.mediaType?.startsWith("audio/") ? (
                  <audio controls className="msgAudio">
                    <source src={viewOnceOverlay.mediaURL} type={viewOnceOverlay.mediaType} />
                  </audio>
                ) : (
                  <a href={viewOnceOverlay.mediaURL} target="_blank" rel="noreferrer" className="fileLink">
                    {viewOnceOverlay.mediaName || "Open file"}
                  </a>
                )}
              </div>
            )}
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

      {gameToast && (
        <div className="eventToast gameToast">
          <strong>Games</strong>
          <p>{gameToast}</p>
        </div>
      )}

      {isMobileLayout && mobileMessageToast && (
        <button
          type="button"
          className="mobileMessageToast"
          onClick={() => {
            openChat(mobileMessageToast.chatId);
            setMobileMessageToast(null);
          }}
        >
          <strong>{mobileMessageToast.title}</strong>
          <p>{mobileMessageToast.text}</p>
        </button>
      )}
    </>
  );
}

