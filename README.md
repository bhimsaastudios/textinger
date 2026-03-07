# Textinger

Realtime Firebase chat app with:
- Email/password auth + username registration
- Chat sidebar + add friend flow
- Main realtime chat panel
- Notifications for friend requests
- Profile panel with editable username, bio, and Cloudinary profile image upload
- Chat media upload via Cloudinary

## Setup

1. Install dependencies:

```bash
npm install
```

2. Update values inside `.env`:
- Firebase credentials (`VITE_FIREBASE_*`)
- Firebase Web Push key:
  - `VITE_FIREBASE_VAPID_KEY`
- Cloudinary values for chat media:
  - `VITE_CLOUDINARY_CLOUD_NAME`
  - `VITE_CLOUDINARY_UPLOAD_PRESET` (unsigned preset)

For background notifications when the app is closed, also deploy a server-side sender (for example Firebase Cloud Functions) that sends FCM notifications to the stored `users/{uid}.fcmTokens`.

## Backend Push Sender (Cloud Functions)

This repo now includes a Firebase Cloud Function:
- Trigger: `chats/{chatId}/messages/{messageId}` document create
- Function: `sendPushOnNewMessage`
- Behavior: sends FCM web push notifications to chat recipients using tokens stored in `users/{uid}.fcmTokens`

### Deploy steps

1. Install Firebase CLI (if not installed):

```bash
npm install -g firebase-tools
```

2. Login and confirm project:

```bash
firebase login
firebase use textinger-daf47
```

3. Install function dependencies:

```bash
cd functions
npm install
cd ..
```

4. Deploy the function:

```bash
firebase deploy --only functions
```

After deploy, new messages will trigger push notifications (including when app is closed), as long as recipient users have valid `fcmTokens`.

3. Start development server:

```bash
npm run dev
```

## Firestore Rules (development only)

```txt
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read, write: if request.auth != null;
    }

    match /users/{userId}/savedMessages/{savedId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }

    match /friendRequests/{requestId} {
      allow read, write: if request.auth != null;
    }

    match /chats/{chatId} {
      allow read, write: if request.auth != null;

      match /messages/{messageId} {
        allow read, write: if request.auth != null;
      }

      match /typing/{typingId} {
        allow read, write: if request.auth != null;
      }
    }
  }
}
```

For production, tighten Firestore rules with stricter ownership and validation checks.
