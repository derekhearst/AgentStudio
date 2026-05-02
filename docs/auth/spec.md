# Auth Spec

## Overview

Auth handles user identity, session management, and access control for AgentStudio. Two authentication methods are supported: username/password (the default) and passkeys (WebAuthn, optional per-user). The first admin account is created through a guided setup page shown when no users exist — no environment variable bootstrap required. New users are added by an admin directly or via invite links.

## Data Model

### `users` table

| Column         | Type        | Notes                                                     |
| -------------- | ----------- | --------------------------------------------------------- |
| `id`           | uuid        | Primary key                                               |
| `name`         | text        | Display name                                              |
| `username`     | text        | Unique, URL-safe (letters, numbers, `_`, `-`, 3–32 chars) |
| `role`         | enum        | `admin` or `user`                                         |
| `passwordHash` | text?       | bcrypt hash of password; null if user has no password set |
| `isActive`     | boolean     | Soft-disabled users cannot log in                         |
| `lastLoginAt`  | timestamptz | Updated on each successful login                          |
| `deletedAt`    | timestamptz | Soft delete timestamp                                     |
| `createdAt`    | timestamptz |                                                           |

### `userPasskeys` table

| Column         | Type        | Notes                                             |
| -------------- | ----------- | ------------------------------------------------- |
| `id`           | uuid        | Primary key                                       |
| `userId`       | uuid        | FK → `users`                                      |
| `credentialId` | text        | WebAuthn credential ID (unique)                   |
| `publicKey`    | text        | Stored public key                                 |
| `counter`      | integer     | Replay-attack counter                             |
| `label`        | text        | Human label (e.g., "Touch ID", "YubiKey")         |
| `transports`   | text[]      | Authenticator transports                          |
| `createdAt`    | timestamptz |                                                   |
| `lastUsedAt`   | timestamptz | Updated on each successful auth                   |

### `authChallenges` table

Short-lived rows used during WebAuthn registration and authentication ceremonies.

| Column      | Type        | Notes                                         |
| ----------- | ----------- | --------------------------------------------- |
| `id`        | uuid        | Primary key                                   |
| `userId`    | uuid        | FK → `users` (nullable for new registrations) |
| `purpose`   | enum        | `register` or `authenticate`                  |
| `challenge` | text        | Random challenge bytes                        |
| `expiresAt` | timestamptz | 10 minutes from creation                      |
| `createdAt` | timestamptz |                                               |

### `authSessions` table

| Column      | Type        | Notes                                 |
| ----------- | ----------- | ------------------------------------- |
| `id`        | uuid        | Primary key                           |
| `userId`    | uuid        | FK → `users`                          |
| `tokenHash` | text        | SHA-256 of the session token (unique) |
| `expiresAt` | timestamptz | 30 days from creation                 |
| `createdAt` | timestamptz |                                       |

The raw session token is stored only in the HTTP-only cookie. Only the hash is persisted.

### `userInvites` table

| Column      | Type        | Notes                                                   |
| ----------- | ----------- | ------------------------------------------------------- |
| `id`        | uuid        | Primary key                                             |
| `tokenHash` | text        | SHA-256 of the invite code (unique)                     |
| `role`      | enum        | `admin` or `user` — role granted on registration        |
| `createdBy` | uuid        | FK → `users` — admin who created the invite             |
| `expiresAt` | timestamptz | Configurable; default 7 days                            |
| `usedAt`    | timestamptz | Set when invite is consumed                             |
| `usedBy`    | uuid?       | FK → `users` — user who registered with this invite     |
| `createdAt` | timestamptz |                                                         |

---

## Authentication Flows

### First-run setup

When no users exist in the database, the application redirects all routes to `/setup`. The setup page:

1. Prompts for a display name, username, and password.
2. Creates the first user with `role = 'admin'` and the hashed password.
3. Creates an `authSessions` row and sets the session cookie.
4. Redirects to `/`.

Once any user exists, `/setup` is permanently unavailable (returns 404).

### Username / password login

1. User submits username and password via `POST /auth/login`.
2. Server loads the user by username. If not found or `isActive = false`, return a generic "invalid credentials" error — do not distinguish missing user from wrong password.
3. Server compares the submitted password against `passwordHash` using bcrypt.
4. On success: create `authSessions` row, set `HttpOnly; SameSite=Strict; Secure` cookie, update `lastLoginAt`.
5. On failure: return error after a minimum constant response delay (prevents timing attacks).

### Password change

`POST /auth/change-password` — requires current session + current password confirmation. Hashes the new password and updates `users.passwordHash`. All existing sessions except the current one are invalidated by deleting their `authSessions` rows.

### Passkey registration (optional)

Any authenticated user can add one or more passkeys from `/settings/security`:

1. Client calls `GET /auth/passkey/register/begin` — server creates an `authChallenges` row and returns WebAuthn registration options.
2. User completes authenticator gesture.
3. Client calls `POST /auth/passkey/register/complete` — server verifies the response, creates a `userPasskeys` row, deletes the challenge.

Passkeys are additive. A user with both a password and passkeys can use either to log in. Removing all passkeys does not affect password login.

### Passkey login

1. Client calls `POST /auth/passkey/login/begin` with username — server creates a challenge if the user has passkeys registered.
2. User completes authenticator gesture.
3. Client calls `POST /auth/passkey/login/complete` — server verifies assertion, updates `userPasskeys.counter` and `lastUsedAt`, creates session.

### Invite-based registration

Admin generates an invite link from `/admin/users/invite`:

1. Server creates a `userInvites` row with a secure random token (only the hash is stored).
2. Admin shares the link: `/register?invite=<token>`.
3. New user opens the link, enters display name, username, and password.
4. Server verifies the invite token (hash match, not expired, not used), creates the user, marks the invite used.

---

## Session Management

Sessions expire after 30 days. On each request the server reads the cookie, hashes it, and looks up the `authSessions` row. If found and not expired, the request is authenticated. Sessions are not automatically renewed — users re-login after expiry.

Admins can invalidate all sessions for a user from `/admin/users/[id]` (deletes all their `authSessions` rows).

---

## User Management

`/admin/users` — list all users with role, last login, and active status.
`/admin/users/invite` — generate invite links with configurable expiry and role.
`/admin/users/[id]` — view user, change role, activate/deactivate, force-expire all sessions.

Admins cannot view another user's password hash. Password resets are done by generating a new invite link and having the user re-register — invite registration overwrites `passwordHash` if the username is already claimed.

---

## Key Functions

| Function                                | Purpose                                    |
| --------------------------------------- | ------------------------------------------ |
| `requireAuth(cookies)`                  | Returns `AuthenticatedUser` or throws 401  |
| `requireAdmin(cookies)`                 | Same but also enforces admin role          |
| `createSessionForUser(userId, cookies)` | Creates session row + sets cookie          |
| `signOut(cookies)`                      | Deletes session row + clears cookie        |
| `normalizeUsername(input)`              | Trims and lowercases input                 |
| `validateUsername(input)`               | Enforces character and length rules        |

## Roles & Permissions

| Role    | Capabilities                                                    |
| ------- | --------------------------------------------------------------- |
| `admin` | Full access including user management, all observability views  |
| `user`  | Access to own data, own sessions, own approvals                 |

## Security Notes

- Passwords are hashed with bcrypt, work factor ≥ 12.
- Login errors never distinguish "user not found" from "wrong password."
- Session tokens are 32 random bytes; only their SHA-256 hash is persisted — a stolen DB row cannot be used directly.
- All auth cookies are `HttpOnly`, `SameSite=Strict`, `Secure`.
- Challenge rows expire in 10 minutes and are single-use.
- Invite tokens follow the same hash-only storage pattern as session tokens.
- Soft-deleted users (`deletedAt` set) cannot authenticate.
- WebAuthn counter validation prevents credential replay attacks.

## UI Contract

This domain follows the shared UX system in [../ui/spec.md](../ui/spec.md).

- Surfaces: `/setup` first-run wizard, `/login` (password + passkey toggle), `/register` invite flow, `/settings/security` passkey management, `/admin/users` management list.
- Validation and error behavior: username format errors shown inline; WebAuthn ceremony failures show a retry prompt with a non-technical summary.
- Blocking actions: account disable and role change require explicit confirmation.
- Mobile behavior: login and setup forms use single-column layout with persistent primary action.
