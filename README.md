# AgentStudio

Self-hosted autonomous AI agent platform for a single owner, with a sandboxed workspace and password sign-in.

## Feature Overview

### Chat and Tooling

AgentStudio provides a streaming chat interface where the assistant can call tools such as web search and sandboxed code execution. The filesystem toolset supports ranged file reads, full writes, unified-diff patch apply, deterministic string replace, recursive directory listing, search, move/rename, delete, and file metadata lookups. Chat supports editing and branching, interleaved tool and thinking blocks, per-message performance and cost metrics, model selection, and per-prompt reasoning effort selection.

Conversations can be pinned to the top of the sidebar, archived (the everyday way to tidy the list: hidden, never deleted, restored from the Archived view or by replying), renamed, deleted behind a confirmation, and exported as a Markdown transcript or a complete JSON file. The sidebar's search box also searches the whole history on the server — message text and the work each turn did (file paths, commands, links a tool printed) — and shows highlighted extracts. See [docs/chat/chat.md](docs/chat/chat.md).

Shell commands render as a small terminal: the command, its output in a fixed-width font with colour codes cleaned out, the last 20 lines first with a control to show the rest, a copy button, and a badge for how it ended (such as `exit 2`). A command the agent runs in the background (a dev server, a long build) streams its output into that card while the turn runs, shows as a header chip with a stop button, and ends when the reply does; the card and the agent both say so. Deleting a conversation stops its running turn and those commands first. See [docs/chat/spec.md](docs/chat/spec.md#command-output).

Editing a message or regenerating a reply cuts the conversation back so the model sees only what was kept plus the message it is answering. In a project (or an agent with a persistent workspace) the agent's file changes are checkpointed every turn, and Edit and Regenerate offer to restore the files the dropped replies changed — showing the files and line counts first, and asking again before overwriting uncommitted changes in an imported repository. **Compact Conversation** runs the SDK's own `/compact`. See [docs/chat/chat.md](docs/chat/chat.md).

When the agent needs a decision it asks with the Agent SDK's own AskUserQuestion, shown as a question card: a header chip, option cards with a recommended badge, a sandboxed HTML preview of each option where one helps, multi-select, and a free-text "Other". It can be answered in the chat, from the composer, or from the /review inbox, and never answers itself. See [docs/chat/spec.md](docs/chat/spec.md#questions-from-the-agent).

Chats run on Claude models through the Claude subscription, at no per-token cost. The model pickers — the composer (its model pill and the `/model` command), the default model and each agent's model — offer only models that can actually run here: the current Claude models Claude Code knows, plus, when the operator configures an Anthropic-compatible gateway such as OpenRouter's, the gateway's models, labelled **Gateway · paid** and priced per token in the usage ledger. The gateway is off by default. See [docs/llm/llm.md](docs/llm/llm.md).

The message box has two shortcuts. Typing `@` lists the files in the chat's workspace (a bound project's folder, or an agent's persistent workspace) and inserts the chosen file's relative path. Typing `/` at the start opens a command palette over the app's own actions: `/compact`, `/model`, `/agent`, `/research`, `/plan`, `/effort`, `/attach` and `/voice`. Both work from the keyboard and by tapping on a phone. See "Composer shortcuts" in [docs/chat/spec.md](docs/chat/spec.md).

Replies can be read aloud: a speaker button on each reply plays it through an OpenRouter text-to-speech model (code blocks are skipped), and an opt-in, per-device **Auto-read** switch above the message box reads each new reply when its turn finishes, for hands-free use. The model and voice are set in Settings → Model & AI; spend is recorded in the usage ledger under "Read Aloud" and counts toward budget limits. See [docs/speech/speech.md](docs/speech/speech.md).

Beside each chat sits a right rail with two tabs: **Preview** (a workspace file or a web page) and **Files** (every file the agent changed in the chat, with +/- counts; click one to preview it). It stays folded to a thin strip until something opens a preview or you expand it, and remembers whether you left it open; on a phone it is a drawer. The context ring and metered cost sit in the chat's header, and each reply links to its run's full tool timeline. See [docs/chat-console/chat-console.md](docs/chat-console/chat-console.md).

Creation workflows are chat-led: New Agent and New Skill actions launch a fresh conversation with a seeded creation prompt. The assistant gathers missing requirements (optionally with a question card), then executes directly with tool-level approvals where configured.

### Agents

Autonomous agents with custom roles, system prompts, and model assignments. Agents are created and managed via the chat orchestrator. The agents page lists every agent with its status — Available or Paused — and lets you pause or resume a custom agent: a paused agent is not offered for delegation and its automations and monitors are skipped, but you can still chat with it. Agent detail pages allow editing the assigned model, system prompt and hook bindings; hooks run for an agent's chats as well as its automations (see [docs/hooks/hooks.md](docs/hooks/hooks.md)). The Plan and Research agents hand an approved plan to another agent — usually Chat or Autonomous — and find its id with the read-only `list_agents` tool. A built-in agent can also fan work out to several custom agents at once: up to four children run in parallel inside the turn, one level deep, each budget-checked against its own agent before it starts and charged to it in the usage ledger; each child shows in the reply as a collapsed card that expands to its own transcript, and Stop stops them all. See [docs/agents/agents.md](docs/agents/agents.md).

### Skills

Reusable instruction sets agents load on demand, managed at `/skills`. A skill exports as a `SKILL.md` package with its resource files, and importing that package recreates it exactly. See [docs/skills/skills.md](docs/skills/skills.md).

### Activity and Usage

`/activity` opens with a usage strip for the last 24 hours, 7 days or 30 days: runs and their failure rate, tokens (the real measure, since Claude subscription runs record $0) with metered dollars underneath, automation runs, the top models and agents (each with its metered dollars), the most-used tools, the review inbox, budget headroom, and a short list of anomalies such as a spend spike or an automation that started failing. Below it is the chronological activity feed. The same numbers can be sent every Monday as a weekly usage digest to the review inbox or a chat thread; it is opt-in and written by code, with no model call. See [docs/activity/spec.md](docs/activity/spec.md).

### Settings

Settings persist default model, transcription and read-aloud (text-to-speech) model and voice, theme, notification preferences, per-tool approval requirements, context window configuration, and budget limits. The daily and monthly budget limits block new chat and automation runs once spend reaches them, alert at 80% and 100%, and show as headroom on `/activity` (see [`docs/cost/spec.md`](docs/cost/spec.md)); the notification switches decide which notifications are sent (see [`docs/notifications/spec.md`](docs/notifications/spec.md)).

Settings → System is a read-only checklist of what the deployment provides: the database and its migrations, the Claude sign-in, the workspace folder, the shell sandbox, the model gateway and each integration (OpenRouter, web search, GitHub, push, external cron). These are environment settings, not stored in the app; each row names the variable that controls it and never shows its value.

Tool execution approvals are configured per tool in Settings. Tools marked for approval pause execution until approved. See [docs/tools/tools.md](docs/tools/tools.md) for what each kind of run can call, how approvals work, and how code runs (through the sandboxed shell; the separate `run_code` tool was retired).

### Database Bootstrap

On server startup, AgentStudio now ensures the configured PostgreSQL database exists, installs the required extensions, and applies bundled Drizzle migrations before serving requests. The Postgres role in `DATABASE_URL` must be allowed to create the target database and install `pgcrypto` and `vector`.

Startup never deletes data on its own. Only one process migrates a database at a time, a failed migration stops startup with an explanation, and a database that has tables but no migration history is refused rather than wiped (an old AgentStudio schema can be rebuilt by starting once with `DB_ALLOW_LEGACY_SCHEMA_RESET=1`). If Postgres is unreachable, startup retries for a few minutes; if it still fails, requests return errors instead of running against a half-initialised database. Details in [`docs/database/database.md`](docs/database/database.md#how-migrations-are-applied).

Build note: `bun run build` skips database bootstrap entirely. `DATABASE_URL` is only required when the server actually starts.

Schema changes go through `bun run db:generate` — never hand-write a migration or hand-edit `drizzle/meta/_journal.json`. See [`docs/database/database.md`](docs/database/database.md) for the migration workflow, the 2026 snapshot rebaseline, and the known schema drift.

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
- `AUTH_PASSWORD` (creates the owner account the first time the server starts against an empty database; never overwrites an existing password. Optional `AUTH_OWNER_NAME` / `AUTH_OWNER_USERNAME` default to `Owner` / `owner`)
- `OPENROUTER_API_KEY` (also powers voice transcription and read-aloud)
- `SEARXNG_URL` and `SEARXNG_PASSWORD`
- `SANDBOX_WORKSPACE` (base root for per-user workspaces; defaults to `/workspace/users`). It must be a directory the app can create folders in: every chat turn creates its workspace there before the agent starts, and a turn fails with "Could not prepare the workspace for this run." when it cannot. On a development machine without a writable `/workspace`, point it at a local folder such as `./.sandbox` (gitignored).
- `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`
- `ORIGIN`
- `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `APP_ENCRYPTION_KEY` (only needed if connecting GitHub from the Connections panel at `/projects` for repo sync, clone, push, and PR creation). Server-side git ignores the host's own git configuration — credential managers, URL rewrites, a global identity — so nothing needs setting up there. A corporate certificate authority goes in the server's environment (`GIT_SSL_CAINFO`, `GIT_SSL_CAPATH` or `SSL_CERT_FILE`), not a global `http.sslCAInfo`, which is not read; see [docs/source-control/spec.md](docs/source-control/spec.md#running-git-safely).
- `GITHUB_WEBHOOK_SECRET` (only needed to ingest `pull_request` / `check_run` events at `POST /api/webhooks/github`; missing → endpoint returns 503)
- `LLM_GATEWAY_URL` and `LLM_GATEWAY_TOKEN` (optional, off by default; only needed to chat with non-Claude models, which run through an Anthropic-compatible gateway and are billed per token. For OpenRouter: `LLM_GATEWAY_URL="https://openrouter.ai/api"` and an OpenRouter key as the token. Unset, only Claude models are offered. See [docs/llm/llm.md](docs/llm/llm.md))
- `CRON_SECRET` (optional; lets an external scheduler fire `POST /api/cron` with `Authorization: Bearer <secret>` when the in-process scheduler is turned off; unset → only a signed-in session can fire it)
- `BODY_SIZE_LIMIT` (production only; the largest request body the server accepts, e.g. `25M`). The Docker image sets `25M`, which fits a 20MB project knowledge file or chat attachment. Without it the server's own default of 512K refuses every upload over half a megabyte. Raise it (e.g. `110M`) for 100MB video attachments; never set it to an empty value, which the server reads as 0 and refuses every upload. `bun run dev` enforces no limit. See [`src/lib/server/body-limit.ts`](src/lib/server/body-limit.ts).

The Claude Code process that runs each chat turn does **not** inherit these. It gets a short allow-list — `PATH`, `HOME` / `USERPROFILE`, temp and locale variables, proxy and CA settings, `CLAUDE_CONFIG_DIR` / `CLAUDE_CODE_OAUTH_TOKEN` for its own login, and for gateway models only the gateway's own `ANTHROPIC_*` (address, token, a blank API key and the chosen model) in place of the login token — so an agent's shell command cannot read the server's secrets. A proxy or certificate setting the agent needs must use one of those names. See [`docs/runtime/spec.md`](docs/runtime/spec.md).

Database note:

- `DATABASE_URL` should point at the final application database name even if that database does not exist yet. Use `agentstudiodev` for local development; names follow the lowercase `agentstudio<env>` rule in [`docs/database/database.md`](docs/database/database.md#databases).
- The configured Postgres role must be able to create that database on first start and run `CREATE EXTENSION IF NOT EXISTS pgcrypto` and `CREATE EXTENSION IF NOT EXISTS vector`.
- A database with existing tables but no Drizzle migration history is refused at startup, never wiped automatically. See the database doc for the one-time `DB_ALLOW_LEGACY_SCHEMA_RESET=1` escape hatch.
- To force a clean rebuild of a development database, run `bun run db:reset` — drops the target database and reruns the same ensure-exists → migrate → seed bootstrap the server runs at boot. It refuses any database whose name does not end in `dev`, `test` or `ci`, and any name containing `prod`.

4. Provision the instance (optional — the server does the same on first start when `AUTH_PASSWORD` is set):

```sh
bun run db:bootstrap                    # create the database, the owner (from AUTH_PASSWORD) and the sandbox folder
bun run db:bootstrap --reset-password   # forgot the dev password: set it to AUTH_PASSWORD again (signs every session out)
bun run db:bootstrap --reset            # start over: drops the database first (dev/test/ci names only)
```

It is idempotent, never prints the password, and refuses to run with `NODE_ENV=production`. Like `db:reset`, `--reset` refuses any database whose name does not end in `dev`, `test` or `ci`, or that contains `prod`.

5. Run the app:

```sh
bun run dev
```

6. Run checks/tests:

```sh
bun run check
bun run test:e2e
```

Playwright E2E policy:

- `bun run test:e2e` runs with real external integrations (OpenRouter, SearXNG, sandbox tools).
- Required env vars for E2E: `DATABASE_URL`, `AUTH_PASSWORD`, `OPENROUTER_API_KEY`, `SEARXNG_URL`, `SANDBOX_WORKSPACE`.
- The suite fails fast during global setup if any required dependency is missing or unreachable.

### Running the suite quickly

Playwright boots its own dev server, and ~45s of every run is Vite compiling from cold.
Start one and leave it up instead:

```bash
bun run dev:test          # terminal 1 — leave running
bunx playwright test      # terminal 2 — reuses it, ~12s instead of ~55s
```

Use `bun run dev:test` rather than `bun run dev`. Playwright reuses whatever is already on
port 4173, and a plain dev server does not carry the env the config injects
(`AUTH_DEV_BYPASS=0`, `GITHUB_WEBHOOK_SECRET`, test VAPID keys), so the suite would
quietly test a differently-configured app. Both read the same `tests/server-env.ts`.

### Reproducing CI's credentials locally

A developer machine has a working Claude session and a real `OPENROUTER_API_KEY`; CI has
neither. A spec that quietly depends on a model answering therefore passes locally and
fails in CI — which is how `automations.output-routing` was taken off the quarantine on a
green local run and then failed CI with `UnauthorizedResponseError`.

To run as CI does:

```bash
bun run dev:test:nocreds                              # terminal 1
E2E_NO_MODEL_CREDENTIALS=1 bunx playwright test       # terminal 2
```

The flag is needed in **both** places. It strips every `ANTHROPIC_*` / `CLAUDE_*`
variable, points `CLAUDE_CONFIG_DIR` at an empty directory so the Agent SDK cannot fall
back to the logged-in session, replaces `OPENROUTER_API_KEY` with CI's placeholder, and
unsets the LLM gateway. Several specs import `src/lib/automations/engine` and run the
model inside the Playwright worker rather than through the dev server, so stripping only
the server leaves exactly those specs still passing.

A spec that genuinely needs a model belongs in `LIVE_SPECS` in `tests/quarantine.ts`,
not in `KNOWN_FAILING`.

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

Notes:

- `bun run test:e2e` is the primary CI path and uses real integrations.
- Provider auth errors (for example `User not found`) indicate credential/account issues rather than app test harness issues.

## Docs

- Master implementation order: `docs/structure/implementation-order.md`
- Architecture refactor plan: `docs/structure/plan.md`
- Runtime spec: `docs/runtime/spec.md`
- Tools (what agents can call, approvals, code execution): `docs/tools/tools.md`
- Chat plan: `docs/chat/plan.md`
- Chat spec (composer shortcuts, attachments, safe rendering): `docs/chat/spec.md`
- Chat (conversations: pin, archive, search, export; editing, regenerating, restoring files and compacting): `docs/chat/chat.md`
- Models, the subscription and the optional gateway: `docs/llm/llm.md`
- Memory spec: `docs/memory/spec.md`
- Automations: `docs/automations/automations.md`
- Monitors: `docs/monitors/monitors.md`
- Background jobs: `docs/jobs/jobs.md`
- UI spec: `docs/ui/spec.md`
- Chat console and its right rail (Preview + Files): `docs/chat-console/chat-console.md`
- Operations spec: `docs/operations/spec.md`
- Authentication (owner account, sessions, what is public): `docs/auth/auth.md`
- Agents: `docs/agents/agents.md`
- Hooks (what runs when, on chats and automations): `docs/hooks/hooks.md`
- Skills (including export and import): `docs/skills/skills.md`
- Read aloud (text-to-speech, auto-read): `docs/speech/speech.md`

## Background Jobs

Scheduled automations, monitor checks, PR CI polling, memory mining, research runs and workspace cleanup run on a durable job queue in PostgreSQL. Every server process runs a worker and the scheduler by default; `bun run worker` starts a worker without the web tier, for deployments that scale them separately. Workers are configured with optional `JOBS_WORKER_*` environment variables (queues, job types, poll interval, lease length, worker id, shutdown drain time), and `JOBS_WORKER_ENABLED=0` / `JOBS_SCHEDULER_ENABLED=0` turn them off. Job history is at `/settings/jobs`. See [docs/jobs/jobs.md](docs/jobs/jobs.md) for how the queue behaves and the full variable list.

## Projects

Projects are durable containers for the work users produce with their agents. Most projects have a real working directory on disk — either a fresh `git init` or a clone imported from GitHub — and the agent writes files there, with git as the version history. Browse at `/projects`; a conversation can be bound to a project with `set_project_context` so the agent knows where to work. A project can also hold knowledge files (up to 20MB each) that the agent reads like any other file; deleting a project removes its directory, knowledge included. See [docs/projects/projects.md](docs/projects/projects.md) for the user-facing domain doc, [docs/projects/spec.md](docs/projects/spec.md) for the full data model + behavior contracts, or [docs/projects/plan.md](docs/projects/plan.md) for the phased build sequence.

## Memory Palace

AgentStudio includes an in-house port of [MemPalace](https://github.com/wcw9/mempalace) for long-term memory. Conversations are auto-mined into a Wing → Room → Closet → Drawer hierarchy with vector + tsvector + temporal hybrid recall, and recalled drawers are injected as a `<memory_context>` system block before each user turn. Configurable from **Settings → Memory Palace**, browsable at `/memory`. The palace is also manageable: rewrite a drawer (which re-embeds it), pin it or mark it never-recall, forget everything mined from one conversation, see the semantic/keyword/temporal scores that caused a recall, and keep content out in the first place with exclusion rules that run before the miner embeds anything — credential patterns are built in. See [docs/memory/memory.md](docs/memory/memory.md) for the user-facing domain doc, [docs/memory/spec.md](docs/memory/spec.md) for the full pipeline + schema, or [docs/memory/plan.md](docs/memory/plan.md) for the build sequence + bench harness.

A LongMemEval evaluation harness mirrors the upstream methodology:

```bash
bun run bench:longmemeval:download
bun run bench:longmemeval:smoke --dataset=oracle --limit=5
```

## Architecture Conventions

- Domain-first API boundaries: browser-consumed remote functions live in `src/lib/{domain}`.
- Server-only internals are colocated in domain folders under `src/lib/**` and are only imported by remote functions or `+server` routes.
- Route and component imports should prefer domain barrels (for example, `$lib/chat`, `$lib/agents`) over deep `*.remote` paths.
- Every remote function starts with `requireAuthenticatedRequestUser()` and scopes owned data to that user. The hook also refuses anonymous remote calls on its own, but a spec (`tests/auth.remote-guards.spec.ts`) fails if a remote function is added without the check.

## Authentication

- One owner account per instance, signed in with a password. There are no other users, roles, invitations or passkeys.
- First run creates that account and nothing else. Two ways: set `AUTH_PASSWORD` and the server creates the owner when it starts (the Docker deployment does this), or open the app and fill in `/setup` (display name and password). Until an owner exists every page redirects to `/setup`; `/api/health` stays reachable and reports `ownerProvisioned`.
- On a production build, `/setup` also asks for a **one-time setup token printed in the server log**, so the first visitor to a public URL cannot claim a fresh or reset instance. A development server does not ask.
- Model credential, workspace, gateway and integrations are deploy-time environment settings, shown read-only under Settings → System.
- Sessions are 30-day HTTP-only cookies, and setting a new password on an existing account ends all of them (see "Recovering a lost password" in the auth doc). Everything except `/login`, `/setup`, `/demo`, `/api/health`, `/api/webhooks` (signature-checked) and `/api/cron` (session or `CRON_SECRET`) requires one.
- Remote functions are gated on the real request path: without a session only the sign-in and setup commands can run.
- `AUTH_DEV_BYPASS=1` signs every visitor in as the owner on a development server only, and only once an owner with a password exists; production builds ignore it.
- See [docs/auth/auth.md](docs/auth/auth.md) for the flows and rules.

## Route Map

- `/` Redirects to chat
- `/login` Sign in
- `/setup` First-run owner account creation (only until an owner exists; asks for the setup token on a production build)
- `/chat` Conversations
- `/chat/[id]` Chat detail, with the Preview + Files rail ([docs](docs/chat-console/chat-console.md))
- `GET /chat/[id]/export?format=md|json` Download one conversation as a Markdown transcript or complete JSON ([docs](docs/chat/chat.md#export-a-conversation))
- `/runs/[id]` One run's event timeline: every tool call, result and approval ([docs](docs/runs/spec.md))
- `/activity` Usage strip (runs, tokens, tools, budget headroom, anomalies) above the activity feed ([docs](docs/activity/spec.md))
- `/review` Cost, recent failures, logs and the review inbox
- `/agents` Agent management
- `/automations` Scheduled automation workflows ([docs](docs/automations/automations.md))
- `/monitors` Long-horizon monitors — watch a condition, act when it changes ([docs](docs/monitors/monitors.md))
- `/observability/logs` Server-side log viewer (warn/error events, filterable, mobile-friendly)
- `/settings` App configuration, including the read-only System checklist
- `POST /api/tts` Read-aloud: one chunk of reply text in, MP3 out ([docs](docs/speech/speech.md))
