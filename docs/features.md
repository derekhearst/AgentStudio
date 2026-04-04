# DrokBot — Feature Contract

> Self-hosted autonomous AI agent platform. Chat, code, search, learn — from any device.

## Overview

DrokBot is a SvelteKit PWA that provides a personal, self-hosted AI agent you can chat with on the web and on mobile. Think Paperclip or OpenClaw, but yours — running on your TrueNAS server, talking to your LLMs, learning from every interaction.

**Single user, full control, zero cloud dependencies.**

---

## Core Features

### 1. Chat Interface

- Real-time streaming responses via SSE
- Per-message metrics: model used, tokens in/out, cost, TTFT, total time, tokens/sec
- **Message editing** — edit any user message to fork the conversation from that point
- **Regeneration** — re-run any assistant response with the same or different model
- **Jump-back-in-time** — click any point in the conversation timeline to fork from there
- **Context window indicator** — VS Code-style token usage bar with breakdown by category (system prompt, memories, tool definitions, chat messages, tool results) and a "Compact Context" button for auto-summarization
- **Model picker** — select model per conversation, overridable per message
- **Tool call visibility** — collapsible cards for each tool invocation showing input, output, and execution time; special inline rendering for web search results

### 2. Autonomous Agents

- Create named agents with custom roles, system prompts, and model assignments
- Agents execute tasks autonomously with access to all tools (search, code, files, browser)
- Agent lifecycle management: start, pause, resume, stop
- Parent-child agent delegation for complex multi-step work
- Per-run metrics tracking: token usage, cost, execution logs

### 3. Task Board & Code Review

- Kanban-style task board (pending → running → review → completed/failed)
- Tasks assigned to agents with priority ordering
- **Git-based code review**: each task gets its own branch, in-app diff viewer, approve/reject/request-revision workflow
- Task activity timeline showing agent actions and status changes

### 4. Memory System (Sleep-Time Compute)

Four interconnected pillars based on the sleep-time compute concept:

- **Storage** — PostgreSQL + pgvector. Every memory is a concise factual statement with: category, importance score, vector embedding, access count, timestamps, and typed relations to other memories (supports, contradicts, depends_on, part_of). One database, one source of truth.
- **Extraction** — Automatic knowledge capture from conversations and agent runs. Detects user corrections, explicit decisions, repeated patterns, project/people/tech references. Lightweight extraction after each conversation; deeper extraction during dream cycles.
- **Retrieval** — Multi-strategy context assembly: vector similarity search, importance weighting, recency bias, and knowledge graph traversal. Relevant memories are injected into system prompts so the model feels like it genuinely knows you.
- **Consolidation (Dream Cycle)** — Periodic background process that deeply extracts knowledge from recent interactions, merges duplicates, resolves contradictions, creates cross-memory relations, applies a forgetting curve, and prunes decayed memories. Configurable frequency and aggressiveness. Manual trigger available.

### 5. Web Search (SearXNG)

- Privacy-respecting metasearch via self-hosted SearXNG instance
- Available as an agent tool and as a standalone search panel in the UI
- Structured results: title, URL, snippet

### 6. Code Sandbox (AIO Sandbox)

- Shell command execution, file read/write, code execution in multiple languages
- Browser automation and screenshots
- Available as agent tools and as direct UI commands
- Sandboxed environment — safe for autonomous agent use

### 7. PWA & Push Notifications

- Installable on mobile and desktop via Progressive Web App
- Offline app shell caching
- Web Push notifications (VAPID, no Firebase) for:
  - Agent task completed / ready for review
  - Agent needs human input
  - Dream cycle summary
  - Agent errors

### 8. Dashboard

- Recent conversations, active agents, tasks needing review
- Unread notifications, memory stats, cost overview
- Single efficient query loads all dashboard data

### 9. Memory Explorer

- Search and browse all memories with category filters and importance sorting
- Semantic search via vector similarity
- Memory detail view with relation graph and access history
- Manual edit, pin (disable decay), and delete

### 10. Settings

- Default model selection
- Notification preferences
- Dream cycle configuration (frequency, aggressiveness)
- Theme (light/dark)

---

## Architecture

### Tech Stack

| Layer      | Technology                         |
| ---------- | ---------------------------------- |
| Framework  | SvelteKit (Svelte 5, runes)        |
| Styling    | TailwindCSS v4 + DaisyUI           |
| Database   | PostgreSQL 16 + pgvector           |
| ORM        | Drizzle ORM (postgres.js driver)   |
| LLM        | OpenRouter SDK (multi-model)       |
| Search     | SearXNG (self-hosted)              |
| Sandbox    | AIO Sandbox (self-hosted)          |
| Deployment | Docker (adapter-node, bun runtime) |
| Testing    | Playwright E2E                     |

### Data Flow Pattern

- **Remote functions** (`query`/`command`/`form`) for ALL data operations — no `+page.server.ts` files
- **SSE streaming** only for chat message streaming (`/chat/[id]/stream/+server.ts`)
- `experimental.remoteFunctions: true` and `experimental.async: true` in svelte.config.js
- `getRequestEvent()` inside remote functions for cookie/auth access

### Infrastructure

| Service     | Address                     |
| ----------- | --------------------------- |
| PostgreSQL  | 192.168.0.2:5432            |
| SearXNG     | 192.168.0.2:8070            |
| AIO Sandbox | 192.168.0.2:8060            |
| DrokBot     | Docker container, port 3000 |

### Auth

- Simple cookie-based auth (single user, password from env var)
- httpOnly secure cookies, constant-time password comparison
- `hooks.server.ts` guard redirects unauthenticated requests to `/login`

### Route Map

| Route          | Purpose                   |
| -------------- | ------------------------- |
| `/`            | Dashboard                 |
| `/login`       | Authentication            |
| `/chat`        | Conversation list         |
| `/chat/[id]`   | Individual conversation   |
| `/agents`      | Agent management          |
| `/agents/[id]` | Agent detail/config       |
| `/tasks`       | Task board (kanban)       |
| `/tasks/[id]`  | Task detail + code review |
| `/memory`      | Memory explorer           |
| `/memory/[id]` | Memory detail             |
| `/settings`    | Configuration             |

---

## Scope Boundaries

**In scope (v1):**

- Full chat with streaming, editing, forking, metrics
- Autonomous agent creation and execution
- Task management with git-based code review
- 4-pillar memory system with dream cycles
- Web search, code sandbox, browser automation
- PWA with push notifications
- Docker deployment for TrueNAS
- Playwright E2E tests

**Out of scope (future):**

- Voice input/output
- Integrated IDE (sandbox handles code execution)
- Cost dashboard / billing

* Smart model routing — auto-select cheap vs frontier models based on query complexity, budget-aware downgrade
* Cost dashboard — daily/weekly/monthly spend by model, per-conversation cost, tool cost breakdown, budget alerts
* Agent run trace viewer — full step-by-step visualization of autonomous task runs with tool calls, timing, and cost per step
* Svelte artifact system — interactive components rendered inline in chat, with promotion workflow to permanent features
* Interactive browse mode — split UI with live browser viewport for watching agent navigate, Stagehand + Playwright
* MCP endpoint — expose tools and memory as MCP server so external clients can connect
* Scheduled agent templates — pre-built configs for common loops (repo monitoring, competitor research, feed summaries)
* A2A protocol support — agent-to-agent communication standard for structured handoffs between research and coding agents
* Image generation — Flux/SDXL models via OpenRouter or Replicate API inline in chat
* File uploads with vision — drag in PDFs, images, spreadsheets for model analysis
* Self-improvement loop — research agent finds features, coding agent implements them, user approves via task board
* Agent teams — persistent collaborative groups with shared objectives, role-based coordination, dependency-aware scheduling, shared context/artifacts, and team-level observability. Multiple teams run concurrently across different domains.
* Design generation — agent produces multiple wireframe/UI variations as Svelte artifacts for user selection on the task board, chosen design feeds back into implementation
* Repo management — self-improvement team also handles GitHub releases, README updates, documentation generation, issue triage, demo assets, and community promotion
* Task-level chat threads — scoped conversation on each task card for iterative feedback between user and agent
* Changes requested state — drag-back workflow with comment, agent iterates and resubmits
* Review type classification — heavy (code/features), quick (emails/drafts), informational (reports/alerts) with different UI experiences per type
* Review queue — mobile-first swipe interface for quick approvals, separate from full Kanban
* Pipeline view — horizontal swimlane showing team workflow stages end to end
* Project board — high-level view across teams with shipping timeline and cost/velocity metrics
* Activity feed — chronological stream of all agent activity across teams for passive monitoring
* Test runner service — sandbox runs Playwright against DrokBot, structured results on task runs
* Test recording artifacts — video and screenshots from test runs stored on task records for visual verification
* Test gate enforcement — failing tests block approval, passing tests required for auto-approve
* Agent-written tests — coding agent writes Playwright tests as part of every implementation task
