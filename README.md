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
- Cloudinary values for chat media:
  - `VITE_CLOUDINARY_CLOUD_NAME`
  - `VITE_CLOUDINARY_UPLOAD_PRESET` (unsigned preset)

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
