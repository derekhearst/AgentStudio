# Authentication

## Overview

AgentStudio is a single-owner application. One person owns an instance: they create the account once, then sign in with a password. There are no other user accounts, no roles, no invitations and no passkeys.

Everything the app can do — chat with agents, run shell commands in the sandbox, edit the skills that shape every agent's instructions, see spend — is available only to a signed-in owner. Authentication is therefore the main thing standing between the internet and a machine that will run commands on request, and it is enforced twice: once at the front door for every request, and again inside every piece of server code a page can call.

## Key concepts

| Concept | What it means |
| ------- | ------------- |
| **Owner** | The one row in the `users` table. The database refuses a second row. |
| **Provisioned** | The owner exists *and* has a password. Until then the instance is in first-run mode. |
| **Session** | A random token stored in the `AgentStudio_session` cookie (HTTP-only, 30 days). The database keeps only a hash of it in `auth_sessions`. |
| **Public path** | A URL a visitor without a session may load. Everything else redirects to `/login`. |
| **Remote function** | A server function a page calls directly (a `query` or `command` in a `*.remote.ts` file). These are checked separately from pages — see "Remote functions" below. |
| **AUTH_DEV_BYPASS** | A developer convenience that signs every visitor in as the owner. Works only on a development server. |

## User flows

### First run

1. A fresh instance has no owner. Every page redirects to `/setup`.
2. The visitor picks a display name, a username and a password (at least 8 characters).
3. The owner account is created, the visitor is signed in, and the app opens on the home page.
4. From then on `/setup` redirects away, and a second setup attempt is refused with "Setup already completed".

`/setup` is open to whoever reaches it first, and nothing else protects it. **Finish setup before the instance is reachable from the internet.** There is no setup token or claim key.

### Signing in

1. A visitor without a session who opens any page other than a public one is sent to `/login`.
2. They enter the password. A wrong password shows an error and nothing else happens.
3. A correct password creates a session, sets the cookie, and opens the home page with the full app shell (sidebar, credit balance) already showing the signed-in state.

### Signing out and expiry

Sessions last 30 days. The server has a sign-out command (it deletes the session row and clears the cookie), but no page offers a button for it yet. An expired or deleted session is treated exactly like no session.

## Roles and permissions

There is one role: the owner. What a visitor *without* a session can reach:

| Path | Why it is public | What protects it instead |
| ---- | ---------------- | ------------------------ |
| `/login` | Where you sign in | — |
| `/setup` | First run | Refuses once an owner exists |
| `/demo/*` | Static UI demos | Show no data |
| `/api/health` | Health checks | Reports status only |
| `/api/webhooks/*` | GitHub posts here without cookies | Each handler verifies the provider's signature |
| `/api/cron` | An external scheduler has no session | Requires a session or the `CRON_SECRET` bearer token; otherwise 401 |

Everything else — every page and every API route — redirects an anonymous visitor to `/login` (API routes that check for themselves answer 401).

### Remote functions

Pages call server code through remote functions, which SvelteKit serves under `/_app/remote/…`. For these calls, the "which page is this?" value SvelteKit hands to the server comes from a header the caller writes, so it cannot be used to decide who may call what. The rules are:

1. **The front door decides on the real address.** A remote call from a visitor without a session is refused with `401 Not authenticated` unless it is one of exactly two functions: the sign-in command and the setup command. Nothing else runs without a session, whatever page the call claims to come from.
2. **Every remote function checks again itself.** Each one starts by confirming there is a signed-in user, and data that belongs to a user (conversations, runs, automations, budgets, notifications, repositories) is read and written only for that user. An automated check fails the test suite if a remote function is added without this first line.

The second rule exists because the first one once had a hole: until September 2026 an anonymous caller could claim to be on `/login` and reach any remote function that lacked its own check, including the one that imports skills into every agent's instructions.

## Integrations

None. Passwords are hashed with Argon2id on the server; there is no external identity provider.

## Business rules

- Only one owner can ever exist; the database enforces it.
- A password must be at least 8 characters. A username is 3–32 letters, numbers, `_` or `-`.
- Sessions are stored as hashes, so a leaked database does not leak usable cookies.
- The session cookie is `Secure` when the server runs with `NODE_ENV=production` (the Docker image does).
- `AUTH_DEV_BYPASS=1` signs every request without a session in as the owner, for local development only. A production build (`bun run build`) ignores it completely, whatever `NODE_ENV` says; the test server forces it off.
- Remote functions reachable without a session are limited to sign-in and setup. Adding another one makes it callable by anyone on the internet and needs an explicit reason in `src/lib/auth/remote-gate.server.ts`.
