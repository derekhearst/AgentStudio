# Auth Spec

## Overview

Auth handles user identity, session management, and access control for AgentStudio. Authentication is exclusively passkey-based (WebAuthn) — no passwords. The first admin account is claimed via a one-time bootstrap token set in environment variables. Sessions are cookie-based with server-side token hashing.

## Data Model

### `users` table

| Column        | Type        | Notes                                                     |
| ------------- | ----------- | --------------------------------------------------------- |
| `id`          | uuid        | Primary key                                               |
| `name`        | text        | Display name                                              |
| `username`    | text        | Unique, URL-safe (letters, numbers, `_`, `-`, 3–32 chars) |
| `role`        | enum        | `admin` or `user`                                         |
| `isActive`    | boolean     | Soft-disabled users cannot log in                         |
| `claimedAt`   | timestamptz | Set when the bootstrap claim is consumed                  |
| `lastLoginAt` | timestamptz | Updated on each successful login                          |
| `deletedAt`   | timestamptz | Soft delete timestamp                                     |
| `createdAt`   | timestamptz |                                                           |

### `userPasskeys` table

| Column         | Type        | Notes                           |
| -------------- | ----------- | ------------------------------- |
| `id`           | uuid        | Primary key                     |
| `userId`       | uuid        | FK → `users`                    |
| `credentialId` | text        | WebAuthn credential ID (unique) |
| `publicKey`    | text        | Stored public key               |
| `counter`      | integer     | Replay-attack counter           |
| `transports`   | text[]      | Authenticator transports        |
| `createdAt`    | timestamptz |                                 |
| `lastUsedAt`   | timestamptz | Updated on each successful auth |

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

### `bootstrapClaims` table

| Column      | Type        | Notes                                               |
| ----------- | ----------- | --------------------------------------------------- |
| `id`        | uuid        | Primary key                                         |
| `tokenHash` | text        | SHA-256 of the claim key (unique)                   |
| `expiresAt` | timestamptz | 30 minutes from creation                            |
| `usedAt`    | timestamptz | Set when claimed; claim cannot be reused after this |
| `createdAt` | timestamptz |                                                     |

## Authentication Flow

### Bootstrap (first admin)

1. Admin sets `USER_NAME` and `CLAIM_KEY` environment variables.
2. On first boot, the server creates the admin user and a `bootstrapClaims` row hashed from `CLAIM_KEY`.
3. Admin navigates to `/login`, enters their username, and uses the claim key to register their first passkey.
4. `claimedAt` is set on the user; the bootstrap claim is marked as used. Cannot be replayed.

### Passkey registration

1. Client calls `generateRegistrationChallenge(userId)` — creates an `authChallenges` row and returns WebAuthn options.
2. User's device produces a credential response.
3. Client calls `verifyRegistration(userId, response)` — verifies the challenge, inserts a `userPasskeys` row, creates a session.

### Passkey authentication

1. Client calls `generateAuthenticationChallenge(userId)` — creates an `authChallenges` row, returns WebAuthn options.
2. User's device signs the challenge.
3. Client calls `verifyAuthentication(userId, response)` — verifies signature and counter, updates `lastUsedAt`, creates a session, sets cookie.

### Session validation

`requireAuth(cookies)` — reads the session cookie, hashes the token, looks up `authSessions`, validates expiry, returns `AuthenticatedUser`. Throws `401` if absent or expired. Used in every server load function and API route that requires authentication.

## Roles & Permissions

| Role    | Capabilities                                                   |
| ------- | -------------------------------------------------------------- |
| `admin` | Full access including user management, all observability views |
| `user`  | Access to own data, own sessions, own approvals                |

Role checks are enforced server-side. The `requireAdmin()` helper throws `403` if the authenticated user is not an admin.

## Key Functions

| Function                                | Purpose                                    |
| --------------------------------------- | ------------------------------------------ |
| `requireAuth(cookies)`                  | Returns `AuthenticatedUser` or throws 401  |
| `requireAdmin(cookies)`                 | Same as above but also enforces admin role |
| `createSessionForUser(userId, cookies)` | Creates session row + sets cookie          |
| `signOut(cookies)`                      | Deletes session row + clears cookie        |
| `normalizeUsername(input)`              | Trims input                                |
| `validateUsername(input)`               | Enforces character and length rules        |

## Security Notes

- Session tokens are never stored in plaintext — only their SHA-256 hash is persisted.
- Challenges expire after 10 minutes and are single-use.
- Bootstrap claims expire after 30 minutes and are single-use.
- WebAuthn counter validation prevents credential replay attacks.
- Cookies are `HttpOnly`, `SameSite=Strict`, and `Secure` in production.
- Soft-deleted users (`deletedAt` set) cannot authenticate.
