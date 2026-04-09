# AgentStudio — Feature Contract

> Self-hosted autonomous AI agent platform. Chat, code, search, learn — from any device.

## Overview

AgentStudio is a SvelteKit PWA that provides a personal, self-hosted AI agent you can chat with on the web and on mobile — running on your TrueNAS server, talking to your LLMs, learning from every interaction.

**Single user, full control, zero cloud dependencies.**

---

## Core Features

### 1. Chat

- Real-time streaming responses
- Smooth character interpolation for streamed assistant text
- Visible thinking blocks with streamed reasoning details and thinking-token counts when the model provides them
- Spinner-first waiting state before first stream tokens arrive
- Per-message metrics (model, tokens, cost, latency)
- Message editing with inline composer-style UI, outside-click cancel, and save-to-regenerate flow
- Model picker per conversation
- Composer-level reasoning effort picker (`off`, `minimal`, `low`, `medium`, `high`, `max`) for supported models
- File attachments (images, PDFs, CSV, JSON, Excel)
- Artifact side panel (collapsed, panel, fullscreen modes)
- Auto-title generation
- Memory context auto-injection before each response
- Tool call visibility with collapsible cards
- ask_user prompt surface docked above the composer (inline dropdown, not modal)
- Multi-question ask_user flow with previous/next navigation and per-question focus
- Freeform bypass: typing in the composer resolves pending ask_user prompts directly
- Auto-scroll keeps following live output during both text streaming and tool call rendering
- User-canceled streams persist partial output so streamed content is not lost mid-response

### 2. Autonomous Agents

- Named agents with custom roles, system prompts, and model assignments
- Agent detail page supports editing each agent's model assignment and system prompt
- LLM-driven task execution with full tool access (search, code, files, browser)
- Agent lifecycle management (active, paused, idle)
- Parent-child delegation for multi-step work
- Per-run metrics: token usage, cost, execution logs
- Agent run trace viewer (step-by-step logs per run)
- Read-only agent listing page (creation and lifecycle managed via chat orchestrator)

### 3. Automations

- Visual automation board inspired by the agent cards: status badges, schedule telemetry, and quick action controls
- Two-column automation workspace with existing schedules on the left and a dedicated creation studio on the right
- Creation studio includes cron presets, agent targeting, conversation mode selection, and immediate enable toggle
- One-click duplicate from any existing automation to pre-fill a new automation draft
- Lifecycle actions in-page: enable/disable, delete, and jump to the linked conversation thread

### 4. Memory System

- Vector embeddings via pgvector for semantic search
- Hybrid retrieval: semantic similarity + keyword matching
- Typed memory relations (supports, contradicts, depends_on, part_of) with strength scores
- Automatic extraction from conversations and agent runs
- Dreaming Agent consolidation via automations: decay, prune, deduplicate, categorize, resolve contradictions
- Memory Palace foundation: wings, rooms, hall types, and closet/drawer metadata on memories
- Layered runtime memory loading in chat (L0 identity, L1 essential story, L2 topic recall)
- Memory explorer with search, category filters, importance sorting, relation graph
- Pin memories to disable decay

### 5. Artifacts

- 14 artifact types: markdown, code, config, image, SVG, Mermaid, HTML, Svelte, data table, chart, audio, video
- Automatic versioning on each update
- Gallery view (list, grid, fullscreen) with search and filters
- Linked to conversations and messages
- Delete control (pin, tag editing, category editing, and rollback removed — content managed via chat)

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
- Per-user workspace isolation (filesystem and shell tools run inside a user-scoped root)

### 8. Model Selection

- Uses the exact model selected by the user for each prompt
- Falls back to the default model from settings when no model is explicitly selected
- Configurable via settings

### 9. Cost Tracking

- Daily, weekly, and monthly spend views
- Per-model and per-conversation cost breakdowns
- Budget alerts with daily and monthly limits
- Progress bars for spend vs budget

### 10. Activity Feed

- Chronological event stream: agent action, memory created, consolidation run, chat started
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
- Theme (AgentStudio-night)
- Notification preferences
- Automation and tool approval configuration (plus memory consolidation controls via Dreaming Agent tools)
- Tool approval mode configuration: auto, confirm, plan-first
- Tool availability toggles by capability group (sandbox, artifacts, skills, agents, media)
- Budget configuration (daily and monthly limits)
- Context window configuration (reserved response, auto-compact threshold, compaction model)
- Push subscription management
- PWA install prompt

### 14. Skills

- Skill library for reusable instruction bundles used by chat and agents
- Nested skill files for focused, modular guidance
- Read-only browse-only skills page (creation and management via chat orchestrator)
- Built-in onboarding skill (`drokbot-guide`) visible in `/skills`

### 15. Authentication and User Management

- Multi-user account system with lowercase usernames
- WebAuthn passkey login and account claiming
- Native app webviews without WebAuthn support can hand off login to the system browser from `/login`
- First startup seeds an unclaimed `admin` account with a one-time bootstrap claim key
- Admin-only user management page for add/remove (soft-delete) accounts
- Server hook enforces authentication and admin-only routes (`/users`)

### 16. Database Bootstrap

- On startup, the server ensures the PostgreSQL database named in `DATABASE_URL` exists before handling requests
- Required extensions are installed automatically: `pgcrypto` for UUID defaults and `vector` for memory embeddings
- Bundled Drizzle SQL migrations are applied automatically on startup so container deploys do not require a separate manual migration step
- If the database has AgentStudio schema objects but no recorded Drizzle migrations, startup resets the app schemas and reapplies migrations from scratch

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
| `/users`                    | Admin user management           |
| `/chat`                     | Conversation list               |
| `/chat/[id]`                | Conversation detail + streaming |
| `/agents`                   | Agent browser (read-only)       |
| `/agents/[id]`              | Agent detail                    |
| `/agents/[id]/runs/[runId]` | Agent run trace                 |
| `/automations`              | Automation board + creation studio |
| `/skills`                   | Skills browser (read-only)      |
| `/skills/[id]`              | Skill detail + files            |
| `/memory`                   | Memory explorer (read-only)     |
| `/memory/[id]`              | Memory detail + relation graph  |
| `/artifacts`                | Artifact gallery (delete only)  |
| `/cost`                     | Cost tracking + budgets         |
| `/activity`                 | Activity event feed             |
| `/settings`                 | Configuration + tool toggles    |

## Responsive Breakpoint Contract

- mobile: default styles below 48rem (768px)
- tablet: `tablet:` utilities at 48rem and above
- desktop: `desktop:` utilities at 80rem (1280px) and above
- canonical breakpoint variables are defined in `src/routes/layout.css` and legacy aliases are mapped for compatibility
