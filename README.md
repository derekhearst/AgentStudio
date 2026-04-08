# AgentStudio

Self-hosted autonomous AI agent platform with persistent memory, user-scoped tool sandboxes, and passkey authentication.

## Feature Overview

### Chat and Tooling

AgentStudio provides a streaming chat interface where the assistant can call tools such as web search and sandboxed code execution. The filesystem toolset supports ranged file reads, full writes, unified-diff patch apply, deterministic string replace, recursive directory listing, search, move/rename, delete, and file metadata lookups. Chat supports editing and branching, interleaved tool and thinking blocks, per-message performance and cost metrics, model selection, and per-prompt reasoning effort selection.

Creation workflows are chat-led: New Project, New Agent, New Task, and New Skill actions now launch a fresh conversation with a seeded creation prompt. The assistant runs a cooperative planning flow (asks follow-up questions first), presents an execution plan card, and only executes tool calls after explicit plan approval.

### Agents and Tasks

You can create specialized agents, assign tasks, and review results in a branch-based code review flow. Task lifecycle is managed in a Kanban-style board with clear status transitions.

### Projects Control Plane (Foundation)

Projects are now the unified top-level workspace for orchestration. The initial foundation includes project lifecycle management, goal hierarchy scaffolding, and strategy governance APIs (submit, approve, reject) with project-scoped data hooks for agents, tasks, and runs.

### Memory and Dream Cycles

The memory system stores, retrieves, and consolidates facts over time using PostgreSQL + pgvector. Periodic dream cycles merge duplicates, resolve contradictions, and prune stale knowledge.

### Dashboard and Settings

The dashboard is available at a dedicated route and shows live system totals, task status distribution, and recent activity across conversations and tasks. Settings persist default model, theme, notification preferences, and dream-cycle behavior in the database.

Tool execution has three approval modes: `auto`, `confirm`, and `plan` (plan-first). In plan-first mode, tool calls are grouped into a plan and require Approve, Cancel, or Continue Planning before execution.

### Database Bootstrap

On server startup, AgentStudio now ensures the configured PostgreSQL database exists, installs the required extensions, and applies bundled Drizzle migrations before serving requests. The Postgres role in `DATABASE_URL` must be allowed to create the target database and install `pgcrypto` and `vector`.

If the target database already contains AgentStudio tables or enums but has no recorded Drizzle migrations, startup treats that state as legacy unmanaged schema, wipes the app schemas, and then reapplies the bundled migrations from scratch.

Build note: `bun run build` skips database bootstrap entirely. `DATABASE_URL` is only required when the server actually starts.

## Tech Stack

- SvelteKit (Svelte 5, TypeScript)
- TailwindCSS v4 + DaisyUI
- PostgreSQL + pgvector
- Drizzle ORM + postgres.js
- OpenRouter SDK
- Playwright E2E
- Adapter Node + Docker (TrueNAS deployment target)

## Responsive Breakpoints

AgentStudio now uses a canonical three-tier responsive system:

- mobile: default styles below 48rem (768px)
- tablet: `tablet:` utilities at 48rem and above
- desktop: `desktop:` utilities at 80rem (1280px) and above

Implementation details:

- The canonical tokens are defined in `src/routes/layout.css` via Tailwind v4 `@theme` breakpoint variables.
- Legacy aliases (`sm`, `md`, `lg`, `xl`) are mapped to these tiers for compatibility, but new work should prefer `tablet:` and `desktop:` utilities.

## Getting Started

1. Install dependencies:

```sh
bun install
```

2. Copy environment variables:

```sh
cp .env.example .env
```

3. Update `.env` values for your services:

- `DATABASE_URL`
- `OPENROUTER_API_KEY`
- `SEARXNG_URL` and `SEARXNG_PASSWORD`
- `SANDBOX_WORKSPACE` (base root for per-user workspaces; defaults to `/workspace/users`)
- `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`
- `ORIGIN`

Database note:

- `DATABASE_URL` should point at the final application database name even if that database does not exist yet.
- The configured Postgres role must be able to create that database on first start and run `CREATE EXTENSION IF NOT EXISTS pgcrypto` and `CREATE EXTENSION IF NOT EXISTS vector`.
- A database with existing AgentStudio schema objects but no Drizzle migration history will be reset on startup before migrations are applied.

4. Run the app:

```sh
bun run dev
```

5. Run checks/tests:

```sh
bun run check
bun run test:e2e
```

Playwright E2E policy:

- `bun run test:e2e` runs with real external integrations (OpenRouter, SearXNG, sandbox tools).
- Required env vars for E2E: `DATABASE_URL`, `AUTH_PASSWORD`, `OPENROUTER_API_KEY`, `SEARXNG_URL`, `SANDBOX_WORKSPACE`.
- The suite fails fast during global setup if any required dependency is missing or unreachable.

## Native Release Builds

- GitHub Releases now trigger a workflow that builds native artifacts and attaches them to the release.
- If repository secret `TAURI_REMOTE_URL` is set, native builds open that hosted URL in the Tauri webview instead of bundled frontend assets. This is the intended mode for thin-shell desktop/mobile releases backed by the Docker-hosted Node app.
- Outputs:
  - Windows installer `.exe`
  - Android `.apk`
- Workflow file: `.github/workflows/release-native-builds.yml`
- Trigger: publish a GitHub Release (tag-based release flow)
- Icon source-of-truth: `static/icon.svg`.
- Generated platform icon files under `src-tauri/icons` are recreated automatically by `bun run tauri:icons` in CI and before Tauri dev/build.

### Local Android Commands (Windows)

- `bun run android:build:local` builds a debug APK using the known-good local SDK/NDK + MSVC setup and `TAURI_REMOTE_URL=https://agentstudio.derekhearst.com`.
- `bun run android:install:local` installs the latest built APK to a connected device and launches the app.
- `bun run android:run:local` builds, installs, and launches in one command.

Optional script args:

- Build with a different URL: `powershell -ExecutionPolicy Bypass -File scripts/android-build-local.ps1 -RemoteUrl "https://your-host"`
- Install a specific APK file: `powershell -ExecutionPolicy Bypass -File scripts/android-install-local.ps1 -ApkPath "path\\to\\app.apk"`

For an explicit live-focused subset:

```sh
bun run test:e2e:live
```

Notes:

- `bun run test:e2e` is the primary CI path and uses real integrations.
- `bun run test:e2e:live` remains available for targeted provider-focused runs.
- Provider auth errors (for example `User not found`) indicate credential/account issues rather than app test harness issues.

## Docs

- High-level contract: `docs/features.md`
- Full implementation plan: `docs/plan.md`

## Architecture Conventions

- Domain-first API boundaries: browser-consumed remote functions live in `src/lib/{domain}`.
- Server-only internals are colocated in domain folders under `src/lib/**` and are only imported by remote functions or `+server` routes.
- Route and component imports should prefer domain barrels (for example, `$lib/chat`, `$lib/agents`) over deep `*.remote` paths.

## Auth and Users

- Authentication uses WebAuthn passkeys (no OAuth or password login).
- Native mobile/desktop webviews that do not expose WebAuthn now show an Open in browser to sign in fallback on the login page.
- On first startup, the server seeds an unclaimed `admin` account and logs a one-time bootstrap claim URL/key.
- Admins create new accounts from `/users`.
- Accounts are claimed by the first successful passkey registration for that username.
- User removal is soft-delete; access is blocked while historical data remains owned by that user.

## Route Map

- `/` Redirects to chat
- `/login` Authentication
- `/users` Admin user management
- `/chat` Conversations
- `/chat/[id]` Chat detail
- `/dashboard` System dashboard
- `/cost` Cost dashboard
- `/projects` Projects control plane (foundation)
- `/agents` Agent management
- `/tasks` Task board
- `/memory` Memory explorer
- `/settings` App configuration
