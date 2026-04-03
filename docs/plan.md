# DrokBot - Full Implementation Plan

## Summary

Build a self-hosted SvelteKit PWA for autonomous AI agents with chat, tool use, task orchestration, persistent memory, and TrueNAS Docker deployment.

## Current Status

- Phase 1 completed
- Phase 2 completed
- Phase 3 completed
- Phase 4 completed
- Phase 5 completed: storage/retrieval, relation-aware extraction, dream-cycle persistence, chat memory-context injection, and memory explorer UI are implemented
- Phase 6 completed: orchestration engine/scheduler with tool loop, retries, delegation, queue drain, and full agent/task management UI workflows are implemented
- Phase 7 completed in code: PWA shell (service worker + manifest), push subscription storage, push delivery backend, and settings notification controls are implemented
- Phase 8 completed: persisted app settings (default model, theme, notification preferences, dream cycle configuration) and settings UI wiring are implemented
- Phase 9 completed: Playwright E2E config plus expanded seeded UI coverage for auth, dashboard, chat, agents, tasks, memory, settings, and PWA flows are implemented and passing, including mocked external integration flows and visual regression snapshots

Key architectural rule:

- Use remote functions (`query`, `command`, `form`) for all data operations.
- Use SSE only for chat streaming at `/chat/[id]/stream/+server.ts`.

## Phase 1: Project Foundation

### Step 1 - Scaffold SvelteKit App

1. Run `bunx sv create drokbot` (TypeScript + TailwindCSS v4).
2. Install core deps:
   - `drizzle-orm`
   - `postgres`
   - `@openrouter/sdk`
   - `daisyui`
3. Install dev deps:
   - `drizzle-kit`
   - `@sveltejs/adapter-node`
   - `playwright`
   - `@playwright/test`
4. Configure `svelte.config.js`:
   - `adapter-node`
   - `experimental.remoteFunctions = true`
   - `experimental.async = true`
5. Add `@plugin "daisyui"` after `@import "tailwindcss"` in app stylesheet.

### Step 2 - Environment & Config

Create `.env`:

- `DATABASE_URL=postgresql://derek:***@192.168.0.2:5432/drokbot`
- `OPENROUTER_API_KEY=***`
- `AUTH_PASSWORD=***`
- `SEARXNG_URL=http://192.168.0.2:8070`
- `SEARXNG_PASSWORD=***`
- `SANDBOX_URL=http://192.168.0.2:8060`
- `VAPID_PUBLIC_KEY=***`
- `VAPID_PRIVATE_KEY=***`
- `ORIGIN=https://drokbot.local`

Create `.env.example` with placeholders only.

### Step 3 - Database Schema (Drizzle + pgvector)

Create:

- `src/lib/server/db/index.ts` (postgres.js + drizzle client)
- `src/lib/server/db/schema.ts`
- `drizzle.config.ts`

Initial tables:

- `users`
- `conversations`
- `messages` (includes branch/fork + metrics fields)
- `memories`
- `memory_relations`
- `agents`
- `agent_tasks`
- `agent_runs`
- `dream_cycles`
- `notifications`

Migration must include:

- `CREATE EXTENSION IF NOT EXISTS vector;`

### Step 4 - Auth (Simple Cookie-Based)

Create:

- `src/lib/server/auth.ts`
  - `login(password)` constant-time compare
  - session token creation
  - session validation
- `src/hooks.server.ts`
  - auth guard for all routes except `/login`
- `src/routes/login/data.remote.ts`
  - `form()` login action
- `src/routes/login/+page.svelte`
- `src/lib/server/auth.remote.ts`
  - `getSession` query
  - `logout` command

## Phase 2: UI Shell & Design System

### Step 5 - DaisyUI Theme & UI Primitives

Create `src/lib/components/ui/`:

- `ThemeToggle.svelte`
- `Avatar.svelte`
- `ColorChip.svelte`
- `Sidebar.svelte`
- `CommandInput.svelte`

Theme goals:

- Script.io-inspired colorful identity
- light default, optional dark mode
- clear semantic color map by agent/tool/status

### Step 6 - App Layout

Create:

- `src/routes/+layout.svelte` app shell
- Center content + left nav + optional right context panel
- responsive drawer behavior on mobile

Routes to implement:

- `/`
- `/chat`
- `/chat/[id]`
- `/agents`
- `/agents/[id]`
- `/tasks`
- `/tasks/[id]`
- `/memory`
- `/settings`

## Phase 3: Chat System

### Step 7 - OpenRouter Integration

Create:

- `src/lib/server/llm/openrouter.ts`
  - completion + stream helpers
  - model mapping strategy (fast/powerful/cheap)
- `src/lib/server/llm/tools.ts`
  - tool schema definitions
  - tool dispatch executor

### Step 8 - Chat Remote Functions

Create `src/lib/chat/chat.remote.ts`:

- `getConversations` query
- `getConversation` query
- `createConversation` command
- `deleteConversation` command
- `editMessage` command (fork from edit point)
- `deleteMessagesAfter` command (jump-back fork)
- `getMessageStats` query

### Step 8a - SSE Streaming Endpoint (Only Exception)

Create `src/routes/chat/[id]/stream/+server.ts`:

- Accepts new message payload
- Streams assistant response tokens
- Emits events: `delta`, `tool_call`, `tool_result`, `metrics`, `done`
- Handles tool-call loop
- Persists final assistant message + metrics
- Supports regeneration flow

### Step 8b - Chat UX Components

Create:

- `src/routes/chat/+page.svelte` conversation index
- `src/routes/chat/[id]/+page.svelte` chat detail
- `src/lib/components/chat/MessageBubble.svelte`
- `src/lib/components/chat/ToolCallCard.svelte`
- `src/lib/components/chat/ContextWindow.svelte`
- `src/lib/components/chat/ConversationTimeline.svelte`
- `src/lib/components/chat/ChatInput.svelte`

Required UX details:

- edit + regenerate on message level
- tool calls visible and inspectable
- model picker in header/input
- context bar with token breakdown and compaction
- timeline jump-back for branching conversations
- per-message metrics footer

## Phase 4: Agent Tools & Integrations

### Step 9 - SearXNG Web Search

Create:

- `src/lib/server/tools/search.ts`
- `src/lib/search/search.remote.ts`

Capabilities:

- query SearXNG JSON API
- normalize result cards
- expose as tool and direct UI query

### Step 10 - AIO Sandbox Integration

Install `@agent-infra/sandbox` and create:

- `src/lib/server/tools/sandbox.ts`
- `src/lib/sandbox/sandbox.remote.ts`

Capabilities:

- shell execution
- file read/write
- language code execution
- browser screenshot/navigation
- sandbox health check

### Step 11 - Git Tooling for Review

Create:

- `src/lib/server/tools/git.ts`
- `src/lib/tasks/review.remote.ts`

Flow:

- branch per task
- diff retrieval
- changed file list
- approve (merge), reject (discard), request revision

## Phase 5: Memory System

### Step 12 - Storage & Retrieval

Create:

- `src/lib/server/memory/store.ts`
- `src/lib/memory/memory.remote.ts`

Features:

- create memory + embeddings
- hybrid semantic + full-text retrieval
- relation traversal
- access bumping
- forgetting curve and pruning
- pinning important memories

### Step 13 - Memory Extraction

Create `src/lib/server/memory/extract.ts`:

- extract high-signal facts from chat/runs
- deduplicate via similarity
- create relation edges

### Step 14 - Dream Cycle (Sleep-Time Compute)

Create:

- `src/lib/server/memory/dream.ts`
- `src/lib/server/memory/context.ts`
- `src/lib/memory/dream.remote.ts`

Dream cycle pipeline:

1. process unhandled interactions
2. deep extraction
3. deduplicate/merge
4. contradiction resolution
5. relation enrichment
6. decay + prune
7. summary report

## Phase 6: Agent Orchestration

### Step 15 - Agent Engine & Scheduler

Create:

- `src/lib/server/agents/engine.ts`
- `src/lib/server/agents/scheduler.ts`
- `src/lib/agents/agents.remote.ts`

Features:

- lifecycle control
- tool execution loop
- delegation
- queue + priorities + concurrency limits

### Step 16 - Agent Management UI

Create:

- `src/routes/agents/+page.svelte`
- `src/routes/agents/[id]/+page.svelte`
- `src/routes/agents/new/+page.svelte`

### Step 17 - Task Board + Review UI

Create:

- `src/lib/tasks/tasks.remote.ts`
- `src/routes/tasks/+page.svelte`
- `src/routes/tasks/[id]/+page.svelte`

Features:

- kanban state transitions
- assignment and prioritization
- integrated code review actions

## Phase 7: PWA & Notifications

### Step 18 - PWA Setup

Create:

- `src/service-worker.ts`
- `static/manifest.json`
- service worker registration in layout

### Step 19 - Push Notifications

Create:

- `src/lib/server/notifications/push.ts`
- `src/lib/notifications/notifications.remote.ts`

Notify on:

- task completed/review-ready
- agent needs input
- dream cycle reports
- agent failures

## Phase 7b: Docker & TrueNAS Deployment

### Step 20 - Dockerfile

Create multi-stage `Dockerfile` (bun builder + slim runtime).

### Step 21 - Docker Compose

Create `docker-compose.yml`:

- `drokbot` service
- optional `db` service with pgvector image
- persistent volumes
- local network reachability for SearXNG and Sandbox

### Step 22 - TrueNAS Deployment Guidance

Document in README:

- Custom App deployment
- required environment variables
- HTTPS/proxy guidance
- `ORIGIN` correctness for adapter-node and security

## Phase 8: Dashboard & Product Polish

### Step 23 - Dashboard

Create:

- `src/lib/dashboard/dashboard.remote.ts`
- `src/routes/+page.svelte`

### Step 24 - Memory Explorer Pages

Create:

- `src/routes/memory/+page.svelte`
- `src/routes/memory/[id]/+page.svelte`

### Step 25 - Settings

Create:

- `src/lib/settings/settings.remote.ts`
- `src/routes/settings/+page.svelte`

## Phase 9: Testing

### Step 26 - Playwright E2E

Create:

- `playwright.config.ts`
- `tests/auth.spec.ts`
- `tests/chat.spec.ts`
- `tests/agents.spec.ts`
- `tests/tasks.spec.ts`
- `tests/memory.spec.ts`
- `tests/pwa.spec.ts`

## Remote Function Modules (Target Inventory)

- `src/lib/chat/chat.remote.ts`
- `src/lib/agents/agents.remote.ts`
- `src/lib/tasks/tasks.remote.ts`
- `src/lib/tasks/review.remote.ts`
- `src/lib/memory/memory.remote.ts`
- `src/lib/memory/dream.remote.ts`
- `src/lib/search/search.remote.ts`
- `src/lib/sandbox/sandbox.remote.ts`
- `src/lib/notifications/notifications.remote.ts`
- `src/lib/settings/settings.remote.ts`
- `src/lib/dashboard/dashboard.remote.ts`
- `src/routes/login/data.remote.ts`
- `src/lib/server/auth.remote.ts`

## Verification Checklist

1. App boots with `bun run dev`.
2. Auth redirects and session handling work.
3. Chat can stream, persist, and regenerate.
4. Tool cards show search/sandbox activity.
5. Agent can run task autonomously.
6. Task branch diff can be reviewed and approved/rejected.
7. Memory extraction and search return useful results.
8. Dream cycle runs and writes summary.
9. PWA install + service worker + push notifications work.
10. Playwright suite passes.
11. Docker image builds.
12. Docker compose stack starts cleanly.
13. TrueNAS deployment serves app successfully.

## Decisions Locked

- Remote functions everywhere possible.
- SSE used only for streaming chat output.
- No `+page.server.ts`/`+layout.server.ts` route data loading pattern.
- Adapter-node for self-hosted Docker runtime.
- Single-user v1 with secure cookie auth.
- Memory system follows storage/extraction/retrieval/consolidation model from project memory spec.
