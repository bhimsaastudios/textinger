# Textinger

Realtime Firebase chat app with:
- Email/password auth + username registration
- Direct chats and groups/subgroups
- Media sending (Cloudinary)
- Firebase notifications for open app + OneSignal for closed/background app
- Capacitor Android shell for native mobile app builds

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
VITE_ONESIGNAL_APP_ID=
VITE_ONESIGNAL_NOTIFY_URL=
```

3. Run app

```bash
npm run dev
```

## Web + Capacitor

This project now keeps both:
- `Web app`: Vite build deployed to Firebase Hosting
- `Mobile app`: Capacitor Android shell using the same `dist` build

Useful commands:

```bash
npm run build
npm run cap:sync
npm run cap:android
npm run cap:open:android
```

What they do:
- `cap:sync`: builds web and syncs assets/plugins into native platforms
- `cap:android`: builds web and syncs Android specifically
- `cap:open:android`: opens the Android project in Android Studio

Files added for this:
- `capacitor.config.json`
- `android/`

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

4. Login to Firebase CLI

```bash
npx firebase-tools login
npx firebase-tools use textinger-daf47
```

5. Install functions dependencies

```bash
cd functions
npm install
cd ..
```

6. Build + Deploy

```bash
npm run build
npx firebase-tools deploy --only functions
npx firebase-tools deploy --only hosting
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

## Native Android Push With Capacitor

If you want reliable background notifications on mobile, use the Capacitor Android app instead of depending only on the PWA.

Current state:
- Capacitor packages are installed
- Android project is created in `android/`
- The web app setup is kept unchanged
- Native Android push registration is wired in the app
- Native tokens are stored in Firestore on login/permission grant

What you still need for native push:
1. Add Firebase Android app in Firebase Console
2. Download `google-services.json`
3. Place it in `android/app/google-services.json`
4. Open Android Studio and build/run the app once
5. Add a backend sender for native FCM notifications

Important:
- PWA notifications and native Android push are different delivery paths
- Capacitor is the correct path for dependable background notifications
- The current repository now supports both paths side by side
- Token registration alone does not send notifications; a server/backend must send to those tokens

## Free Closed-App Push (No Blaze): OneSignal + Cloudflare Worker

Use this path if you don't want to upgrade Firebase to Blaze:

1. OneSignal setup
- Create OneSignal app (Web Push)
- Add your domain (`https://textinger-daf47.web.app`)
- Copy OneSignal App ID to `.env` as `VITE_ONESIGNAL_APP_ID`

2. Cloudflare Worker setup
- Create a Worker and paste code from `cloudflare/worker.js`
- Add Worker environment variables:
  - `ONESIGNAL_APP_ID` (same OneSignal app id)
  - `ONESIGNAL_REST_API_KEY` (OneSignal REST API key)
- Deploy Worker and copy the Worker URL
- Put Worker URL in `.env` as `VITE_ONESIGNAL_NOTIFY_URL`

3. App behavior
- Firebase handles in-app/open notifications
- OneSignal is called only for offline recipients (closed/background users)
- Users are mapped in OneSignal using Firebase UID as `external_id`

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
