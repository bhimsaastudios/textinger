# Textinger

Realtime Firebase chat app with:
- Email/password auth + username registration
- Direct chats and groups/subgroups
- Media sending (Cloudinary)
- Web push notifications (foreground + background + closed app)

## Setup

1. Install dependencies

```bash
npm install
```

2. Add `.env` values

```env
VITE_FIREBASE_API_KEY=
VITE_FIREBASE_AUTH_DOMAIN=
VITE_FIREBASE_PROJECT_ID=
VITE_FIREBASE_STORAGE_BUCKET=
VITE_FIREBASE_MESSAGING_SENDER_ID=
VITE_FIREBASE_APP_ID=
VITE_FIREBASE_VAPID_KEY=

VITE_CLOUDINARY_CLOUD_NAME=
VITE_CLOUDINARY_UPLOAD_PRESET=
```

3. Run app

```bash
npm run dev
```

## Cloud Messaging: Why

Browser local notifications only work while app page is active.  
For real mobile/background delivery, you need:
- Firebase Cloud Messaging (FCM) token per device
- Service worker to receive push while app is closed/backgrounded
- Server sender (Cloud Functions) to send push on new message

## Cloud Messaging: How (Project Setup)

1. Firebase Console -> Project Settings -> Cloud Messaging
- Enable Cloud Messaging API (if prompted)
- Generate Web Push certificate key pair
- Copy Public key to `.env` as `VITE_FIREBASE_VAPID_KEY`

2. Firebase Console -> Authentication
- Enable Email/Password provider

3. Firebase Console -> Firestore
- Create database
- Ensure rules allow authenticated users to update their own `users/{uid}` token field in dev/staging

4. Install Firebase CLI and login

```bash
npm install -g firebase-tools
firebase login
firebase use textinger-daf47
```

5. Install functions dependencies

```bash
cd functions
npm install
cd ..
```

6. Deploy

```bash
firebase deploy --only functions
firebase deploy --only hosting
```

## Mobile Push (Important)

For reliable mobile push:
- Use deployed HTTPS URL (not local network HTTP)
- Install app from Chrome menu: `Add to Home screen`
- Grant notification permission
- Open app once after deploy so token is refreshed
- Disable aggressive battery optimization for Chrome/PWA if device blocks background network

This project includes:
- `public/firebase-messaging-sw.js` for background push handling
- `public/manifest.webmanifest` for installable mobile web app behavior
- Cloud Function trigger at `chats/{chatId}/messages/{messageId}` to send push to `users/{uid}.fcmTokens`

## Quick Push Test

1. Login as User A and enable push in app.
2. Verify Firestore `users/{A_UID}.fcmTokens` has a token.
3. Login as User B and send message to User A.
4. Put User A app in background/close app.
5. User A should receive push notification.

## Troubleshooting

- No token in Firestore:
  - `VITE_FIREBASE_VAPID_KEY` missing/wrong
  - notification permission denied
  - service worker not registered

- Push not delivered:
  - functions not deployed
  - stale tokens (invalid token errors in function logs)
  - app tested on non-HTTPS URL

- Foreground push missing:
  - verify `onMessage` path and that permission is granted
