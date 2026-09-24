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

### `pushDeliveries` table

Audit record of every push delivery attempt.

| Column           | Type        | Notes                                    |
| ---------------- | ----------- | ---------------------------------------- |
| `id`             | uuid        | Primary key                              |
| `notificationId` | uuid        | FK → `notifications`                     |
| `subscriptionId` | uuid        | FK → `pushSubscriptions`                 |
| `status`         | enum        | `sent`, `failed`, `expired`              |
| `statusCode`     | integer?    | HTTP status returned by the push service |
| `error`          | text?       | Error message on failure                 |
| `sentAt`         | timestamptz |                                          |

Delivery rows are written for every subscription attempted. A notification with 3 devices produces 3 rows. Failed deliveries with HTTP 410 (subscription expired) trigger automatic removal of the `pushSubscriptions` row.

## Notification Categories

Notification preferences are stored in `appSettings.notificationPrefs` and control which categories are sent. Every notification the server sends goes through one sender (`notifyUser`), which checks the user's switch for its category first. A switched-off category is skipped completely: no push and no in-app row. A user who has never saved the page gets every category, as the switches show.

| Key             | Switch in Settings | What it sends today |
| --------------- | ------------------ | ------------------- |
| `taskCompleted` | Task completed     | A research run finished its report |
| `needsInput`    | Needs input        | A chat run has been waiting for a tool approval or an answer to an `ask_user` question for a minute. Not straight away: someone watching the chat answers in seconds. The run gives up after five minutes, so this leaves about four to answer. The notification links to the chat |
| `agentErrors`   | Agent errors       | An automation run failed for good, or a check failed on a pull request an agent opened |

Two kinds of notification are sent whatever these switches say, because the user set each one up on purpose and turns it off where they set it up:

- **Monitor pushes.** A monitor whose action is "send a push" sends it. Turn the monitor off to stop it.
- **Budget alerts.** When a budget limit reaches its warning level or its limit, the user is told once per limit and period. Clear the limit to stop it.

Before 2026-09-23 these switches were saved and never read, so turning "Agent errors" off changed nothing, and no "Needs input" notification was ever sent.

## Key Functions

| Function                            | Purpose                                                                             |
| ----------------------------------- | ----------------------------------------------------------------------------------- |
| `notifyUser({ userId, category, payload })` | The one sender: skips a switched-off category, then persists to the `notifications` table and sends push to every subscription. Never throws |
| `upsertPushSubscription(input)`     | Registers or updates a device push subscription                                     |
| `removePushSubscription(endpoint)`  | Removes a subscription (user unsubscribed or browser expired)                       |
| `getVapidPublicKey()`               | Returns the VAPID public key for client-side push registration                      |
| `listNotifications(userId)`         | Returns unread + recent read notifications for inbox                                |
| `markRead(id)`                      | Marks a notification as read                                                        |
| `markAllRead(userId)`               | Marks all unread notifications as read                                              |

## In-App Inbox

All notifications are persisted to the `notifications` table regardless of whether push is configured. The in-app inbox at `/notifications` (and as a slide-over panel accessible from any route) shows:

- Unread count badge on the bell icon in the top navigation
- Chronological list with title, body, relative timestamp, and read/unread state
- Tap/click navigates to the `url` deep-link
- Mark individual or all as read
- Notifications older than 90 days are soft-hidden (not deleted)

The inbox is the fallback for users without push subscriptions. For approvals and `ask_user` blocks, the chat session UI is the primary surface — the notification is a secondary signal for users who are not actively watching the chat.

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

- `research/` — research report complete (`taskCompleted`)
- `runs/` — a chat run still waiting on the user after a minute (`needsInput`)
- `automations/` — an automation run that failed for good (`agentErrors`)
- `source-control/` — a failed check on an agent's pull request (`agentErrors`)
- `monitors/` — a monitor whose action is a push (always sent)
- `cost/` — budget warn and block threshold events (always sent)

## Rewrite Authority

The current implementation is a baseline, not a constraint. This domain may be rewritten, restyled, reorganized, or replaced as needed to achieve the target product quality. No code path is off-limits if behavior contracts, safety controls, tests, and documentation remain correct.

## UI Contract

This domain follows the shared UX system in [../ui/spec.md](../ui/spec.md).

- Surfaces: notifications inbox panel/page, push-subscription device manager, and per-category preference toggles in settings.
- States and badges: unread, read, action-required, delivery-failed, muted-category, and broadcast.
- Delivery feedback: push registration failures and invalid subscriptions surface actionable remediation (retry, re-register, remove device).
- Blocking actions: disabling critical categories (for example needs-input) requires confirmation with consequence text.
- Mobile behavior: inbox supports quick mark-read gestures, grouped cards by recency, and sticky filter chips.
- Deep links: tapping a notification must navigate to the owning route and preserve return path to inbox.
