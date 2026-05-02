# Notifications Spec

## Overview

Notifications delivers real-time alerts to users when significant events require their attention — task completions, agent errors, pending approvals, and daily summaries. Delivery is via Web Push (push to device/browser) and in-app (persisted inbox). Both channels write to the same `notifications` table so the inbox is always consistent with what was pushed.

## Data Model

### `notifications` table

| Column      | Type        | Notes                                             |
| ----------- | ----------- | ------------------------------------------------- |
| `id`        | uuid        | Primary key                                       |
| `userId`    | uuid        | FK → `users` (nullable for broadcast)             |
| `title`     | text        | Short notification title                          |
| `body`      | text        | Notification body text                            |
| `url`       | text        | Deep-link URL, opened when notification is tapped |
| `read`      | boolean     | Whether user has dismissed/read it                |
| `createdAt` | timestamptz |                                                   |

### `pushSubscriptions` table

| Column        | Type        | Notes                                       |
| ------------- | ----------- | ------------------------------------------- |
| `id`          | uuid        | Primary key                                 |
| `userId`      | uuid        | FK → `users`                                |
| `endpoint`    | text        | Push service endpoint URL                   |
| `keys`        | jsonb       | `{ p256dh, auth }` — encryption keys        |
| `deviceLabel` | text        | Human label (e.g. "iPhone", "Work browser") |
| `createdAt`   | timestamptz |                                             |
| `updatedAt`   | timestamptz |                                             |

One user can have multiple push subscriptions (one per device/browser). Subscriptions are upserted by endpoint — registering the same endpoint updates keys and label.

## Notification Categories

Notification preferences are stored in `appSettings.notificationPrefs` and control which categories are sent:

| Key             | Description                                    |
| --------------- | ---------------------------------------------- |
| `taskCompleted` | Task transitions to `completed` or `failed`    |
| `needsInput`    | Agent pauses waiting for `ask_user` answer     |
| `dreamSummary`  | Overnight dream run summary                    |
| `agentErrors`   | Agent encounters a hard error during execution |

## Key Functions

| Function                            | Purpose                                                                             |
| ----------------------------------- | ----------------------------------------------------------------------------------- |
| `sendNotification(userId, payload)` | Persists to `notifications` table + sends push to all active subscriptions for user |
| `upsertPushSubscription(input)`     | Registers or updates a device push subscription                                     |
| `removePushSubscription(endpoint)`  | Removes a subscription (user unsubscribed or browser expired)                       |
| `getVapidPublicKey()`               | Returns the VAPID public key for client-side push registration                      |
| `listNotifications(userId)`         | Returns unread + recent read notifications for inbox                                |
| `markRead(id)`                      | Marks a notification as read                                                        |

## Web Push Setup

Push delivery requires VAPID keys:

```
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
```

If these are not set, push delivery is skipped silently (in-app notifications still persist).

## Roles & Permissions

| Action                            | Who can do it       |
| --------------------------------- | ------------------- |
| Receive own notifications         | Authenticated users |
| Register push subscription        | Authenticated users |
| Send notifications                | Server-side only    |
| View another user's notifications | Admin only          |

## Integrations

Notifications are emitted by:

- `tasks/` — task completed, task failed
- `runs/` — agent needs input, agent error
- `jobs/` — dream run summary
- `observability/` — review item requires action
