# DrokBot — Feature Contract

> Self-hosted autonomous AI agent platform. Chat, code, search, learn — from any device.

## Overview

DrokBot is a SvelteKit PWA that provides a personal, self-hosted AI agent you can chat with on the web and on mobile — running on your TrueNAS server, talking to your LLMs, learning from every interaction.

**Single user, full control, zero cloud dependencies.**

---

## Core Features

### 1. Chat

- Real-time streaming responses
- Smooth character interpolation for streamed assistant text
- Per-message metrics (model, tokens, cost, latency)
- Message editing and regeneration
- Model picker per conversation
- File attachments (images, PDFs, CSV, JSON, Excel)
- Artifact side panel (collapsed, panel, fullscreen modes)
- Auto-title generation
- Memory context auto-injection before each response
- Tool call visibility with collapsible cards
- Auto-scroll keeps following live output during both text streaming and tool call rendering

### 2. Autonomous Agents

- Named agents with custom roles, system prompts, and model assignments
- LLM-driven task execution with full tool access (search, code, files, browser)
- Agent lifecycle management (active, paused, idle)
- Parent-child delegation for multi-step work
- Per-run metrics: token usage, cost, execution logs
- Priority-based scheduler with concurrent queue
- Agent run trace viewer (step-by-step logs per run)

### 3. Task Board & Code Review

- Kanban board with six columns: pending, running, review, changes_requested, completed, failed
- Drag-drop reorder with priority slider (0–5)
- Git-based code review: auto-branch per task, in-app diff, approve/reject/request-changes
- Task-level chat threads for iterative feedback between user and agent
- Review type classification (heavy, quick, informational)
- Mobile-first review queue with swipe navigation

### 4. Memory System

- Vector embeddings via pgvector for semantic search
- Hybrid retrieval: semantic similarity + keyword matching
- Typed memory relations (supports, contradicts, depends_on, part_of) with strength scores
- Automatic extraction from conversations and agent runs
- Dream cycles: decay, prune, deduplicate, categorize, resolve contradictions
- Memory explorer with search, category filters, importance sorting, relation graph
- Pin memories to disable decay

### 5. Artifacts

- 14 artifact types: markdown, code, config, image, SVG, Mermaid, HTML, Svelte, data table, chart, audio, video
- Automatic versioning on each update
- Gallery view (list, grid, fullscreen) with search and filters
- Linked to conversations, messages, or tasks
- Pin and delete controls

### 6. Web Search

- Privacy-respecting metasearch via self-hosted SearXNG
- Available as an agent tool during task execution and chat
- Structured results: title, URL, snippet

### 7. Code Sandbox

- Shell execution with timeout and buffer limits
- File operations: read (full or line-range), write, unified-diff patch apply, deterministic string replace, delete, list, move/rename, content search, and metadata lookup
- Path-sandboxed to workspace directory (no directory traversal)
- Browser automation via Playwright (screenshots, navigation)
- Built into the Docker container (no external sandbox dependency)

### 8. Smart Model Routing

- Auto-routes queries to cheap, fast, or powerful models based on estimated complexity
- Budget-aware downgrade near spending limits
- Configurable via settings

### 9. Cost Tracking

- Daily, weekly, and monthly spend views
- Per-model and per-conversation cost breakdowns
- Budget alerts with daily and monthly limits
- Progress bars for spend vs budget

### 10. Dashboard

- Metric cards: conversations, messages, agents, tasks, memories, artifacts, notifications
- Click-through to each section
- Cost dashboard on a dedicated sub-page

### 11. Activity Feed

- Chronological event stream: task created, task status changed, agent action, memory created, dream cycle, chat started, review action
- Type filter pills and refresh
- Badge-coded entries with entity links

### 12. Notifications & PWA

- Installable on mobile and desktop as a Progressive Web App
- Offline app shell caching with stale cache cleanup
- Web Push notifications (VAPID, multi-device)
- In-app notification feed with read/unread markers
- Test notification sender in settings

### 13. Settings

- Default model selection
- Theme (drokbot-night)
- Notification preferences
- Dream cycle configuration (decay lambda, prune threshold)
- Budget configuration (daily and monthly limits)
- Push subscription management
- PWA install prompt

### 14. Authentication

- Single-user password-based login
- HMAC-SHA256 signed session tokens in httpOnly cookies
- Server hook guards all routes except `/login`

---

## Tech Stack

| Layer      | Technology                         |
| ---------- | ---------------------------------- |
| Framework  | SvelteKit (Svelte 5, runes)        |
| Styling    | TailwindCSS v4 + DaisyUI           |
| Database   | PostgreSQL + pgvector              |
| ORM        | Drizzle ORM (postgres.js driver)   |
| LLM        | OpenRouter SDK (multi-model)       |
| Search     | SearXNG (self-hosted)              |
| Sandbox    | Built-in (Playwright, bash)        |
| Deployment | Docker (adapter-node, bun runtime) |
| Testing    | Playwright E2E (mock + live modes) |

## Route Map

| Route                       | Purpose                         |
| --------------------------- | ------------------------------- |
| `/`                         | Home / chat launcher            |
| `/login`                    | Authentication                  |
| `/chat`                     | Conversation list               |
| `/chat/[id]`                | Conversation detail + streaming |
| `/agents`                   | Agent management + scheduler    |
| `/agents/[id]`              | Agent detail                    |
| `/agents/[id]/runs/[runId]` | Agent run trace                 |
| `/tasks`                    | Task board (kanban)             |
| `/tasks/[id]`               | Task detail                     |
| `/review`                   | Mobile review queue             |
| `/memory`                   | Memory explorer                 |
| `/memory/[id]`              | Memory detail + relation graph  |
| `/artifacts`                | Artifact gallery                |
| `/dashboard`                | System metrics                  |
| `/dashboard/cost`           | Cost tracking + budgets         |
| `/activity`                 | Activity event feed             |
| `/settings`                 | Configuration + notifications   |
