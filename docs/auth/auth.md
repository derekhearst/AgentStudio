# Authentication

## Overview

AgentStudio is a single-owner application. One person owns an instance: they create the account once, then sign in with a password. There are no other user accounts, no roles, no invitations and no passkeys.

Everything the app can do — chat with agents, run shell commands in the sandbox, edit the skills that shape every agent's instructions, see spend — is available only to a signed-in owner. Authentication is therefore the main thing standing between the internet and a machine that will run commands on request, and it is enforced twice: once at the front door for every request, and again inside every piece of server code a page can call.

## Key concepts

| Concept | What it means |
| ------- | ------------- |
| **Owner** | The one row in the `users` table. The database refuses a second row. |
| **Provisioned** | The owner exists *and* has a password. Until then the instance is in first-run mode. |
| **`AUTH_PASSWORD`** | A server setting. If it is set when the server starts and there is no owner yet, the server creates the owner with that password. It never replaces an existing password. |
| **Setup token** | A one-time code a production server prints in its log while it has no owner. `/setup` asks for it, so only someone who can read the server's log can create the owner. |
| **System checklist** | The read-only Settings → System panel showing which deploy-time settings (Claude sign-in, workspace, gateway, integrations) are in place. |
| **Session** | A random token stored in the `AgentStudio_session` cookie (HTTP-only, 30 days). The database keeps only a hash of it in `auth_sessions`. |
| **Public path** | A URL a visitor without a session may load. Everything else redirects to `/login`. |
| **Remote function** | A server function a page calls directly (a `query` or `command` in a `*.remote.ts` file). These are checked separately from pages — see "Remote functions" below. |
| **AUTH_DEV_BYPASS** | A developer convenience that signs every visitor in as the owner. Works only on a development server, and only once an owner with a password exists. |

## User flows

### First run

First run creates the owner account and nothing else. Everything else an instance needs — the Claude sign-in, the workspace folder, the model gateway, the integrations — is set where the server is deployed, and can be checked afterwards under Settings → System.

There are two ways to create the owner.

**Without a browser (the Docker deployment, CI, local development).**

1. Set `AUTH_PASSWORD` (and optionally `AUTH_OWNER_NAME` and `AUTH_OWNER_USERNAME`; they default to "Owner" and "owner").
2. Start the server. While it prepares the database it sees there is no owner and creates one with that password. The log says `Created the owner account "owner" from AUTH_PASSWORD`.
3. `/setup` never opens. Sign in at `/login`.

On later starts nothing happens: an owner exists, and `AUTH_PASSWORD` is never used to overwrite its password. The server also removes `AUTH_PASSWORD` from its own environment once it has used it. The agents' shell commands never see the server's environment in the first place (see "The agent process gets a minimal environment" in [../runtime/spec.md](../runtime/spec.md)), but nothing else the server starts needs the password either.

The placeholder from `.env.example` ("change-me") is refused, with a warning in the log, so an unedited copy cannot create an owner whose password is public.

For local development, `bun run db:bootstrap` does the same from the command line — creates the database, the owner and the workspace folder — and reports what it did without printing the password.

**In the browser.**

1. A fresh instance started without `AUTH_PASSWORD` has no owner. Every page redirects to `/setup` (the health check at `/api/health` still answers, and reports `ownerProvisioned: false`).
2. On a production server, the log shows a one-time **setup token** the first time the server is asked for anything. The setup page asks for it. A development server does not.
3. The visitor enters a display name and a password (at least 8 characters, typed twice). A username is optional, under "Advanced"; nobody types it to sign in.
4. The owner account is created, the visitor is signed in, and the app opens on the home page. The setup token stops working.
5. From then on `/setup` redirects away, and another setup attempt is refused with "Setup already completed".

A wrong setup token is refused with "That setup token is not right". The token lives only in the server's memory: a restart prints a new one.

Two setup submissions at the same moment cannot both succeed: exactly one creates the owner and the other is told setup is already complete.

### Recovering a lost password

- **Development:** `bun run db:bootstrap --reset-password` sets the owner's password to `AUTH_PASSWORD` (or to `--password`). Every existing session is signed out; nothing else about the account changes.
- **Production:** clear the password and end every session in the database:

  ```sql
  UPDATE users SET password_hash = NULL;
  DELETE FROM auth_sessions;
  ```

  The owner and everything they own are kept. Then either restart with `AUTH_PASSWORD` set to the new password — the server fills it in at boot — or restart without it and complete `/setup` with the setup token from the log. Either way the same account is kept, so conversations, runs and settings survive.

What recovery keeps and what it changes:

| | Kept | Changed |
| - | ---- | ------- |
| Account id, conversations, runs, settings | Always | — |
| Display name | When recovering through `AUTH_PASSWORD` without `AUTH_OWNER_NAME` | To what `/setup` was given (the form asks for one), or to `AUTH_OWNER_NAME` when set |
| Username | Unless a new one is given | To the `/setup` "Username" field, or `AUTH_OWNER_USERNAME`, when set |
| Sessions | Never | All signed out |

Recovery signs everyone out even if the `DELETE` is skipped: a session stops counting the moment its account has no password, and setting the new password deletes the old sessions. This matters when the reason for the reset is a leaked password — a session opened with it must not outlive it.

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

### The System checklist

Settings → System lists what the deployment provides, read-only, with the environment variable that controls each row:

| Row | Required | What "ready" means |
| --- | -------- | ------------------ |
| Database | Yes | Reachable, and every migration the running build ships has been applied |
| Claude sign-in | Yes | A Claude Code login is on the server (`claude login`), or `CLAUDE_CODE_OAUTH_TOKEN` is set (from `claude setup-token`). `ANTHROPIC_API_KEY` does not count: the agent process never receives the server's `ANTHROPIC_*` variables (see the runtime spec). This checks that a credential is present, not that it still works — a stale login shows up at the first chat |
| Workspace folder | Yes | `SANDBOX_WORKSPACE` exists and the server can write to it |
| Shell sandbox | No | bubblewrap can confine shell commands (Linux only; installed in the Docker image) |
| Model gateway | No | `LLM_GATEWAY_URL` and `LLM_GATEWAY_TOKEN` are set, so non-Claude models can run |
| OpenRouter, Web search, GitHub connection, GitHub webhooks, Push notifications, External scheduler | No | Their variables are set |

Only whether something is set is shown — never its value.

These are not asked for at first run on purpose. The workspace is a mount chosen when the container is created; the Claude sign-in is the Claude Code CLI's own login, which a web form cannot perform; and a form that stored API keys would be a second copy of settings the deployment already owns.

## Business rules

- Only one owner can ever exist; the database enforces it.
- A password must be at least 8 characters. A username is 3–32 letters, numbers, `_` or `-`, and defaults to `owner`.
- `AUTH_PASSWORD` creates the owner only when there is none; it never overwrites a password, and the `.env.example` placeholder is refused.
- On a production build `/setup` requires the setup token from the server log. The token is random, lives only in memory, changes on every restart, and stops working once setup completes.
- Before an owner exists, only `/setup`, `/api/health` and the app's static files are reachable; everything else (including `/login`) redirects to `/setup`.
- Sessions are stored as hashes, so a leaked database does not leak usable cookies.
- A session counts only while its account has a password. Setting a password on an existing account — through `/setup`, `AUTH_PASSWORD` at boot, or `db:bootstrap --reset-password` — ends every session that account had.
- The session cookie is `Secure` when the server runs with `NODE_ENV=production` (the Docker image does).
- `AUTH_DEV_BYPASS=1` signs every request without a session in as the owner, for local development only — typically to let a viewer or agent that cannot type the password drive the app. It attaches only to an owner that has a password; on an instance without one it does nothing and the setup page applies. A production build (`bun run build`) ignores it completely, whatever `NODE_ENV` says; the test server forces it off.
- Remote functions reachable without a session are limited to sign-in and setup. Adding another one makes it callable by anyone on the internet and needs an explicit reason in `src/lib/auth/remote-gate.server.ts`.
