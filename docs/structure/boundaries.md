# Module ownership boundaries

This is the cheat-sheet for "where does X live?" — written so future contributors (human or AI) don't have to re-derive the layering by reading the code. When a domain's responsibilities are unclear, the resulting code drifts: chat pages reach into runtime internals, tool handlers grow database queries, and pure helpers get tangled with side effects.

The codebase has converged on a few clean separations. Keep them.

---

## Message lifecycle: `chat/` vs `runtime/` vs `llm/`

A chat message goes through three distinct layers. Each owns one thing and stays out of the others' way.

### `src/lib/llm/`
The narrow LLM-provider surface. Only this module knows OpenRouter exists.
- `chat.server.ts` — `streamChat()`, `chat()`, `compactMessages()`, `shouldCompact()`. Speaks the OpenRouter SDK; everything else takes back provider-agnostic results.
- `models.server.ts`, `model-capabilities.ts` — model registry + per-model capability metadata (audio modalities, reasoning support, etc).
- `video-generation.server.ts` — async video-job submission.

**Rule of thumb:** if you're touching `OpenAI`, `openrouter`, `claude-sonnet-4`, model strings, or token-streaming primitives — it lives here.

### `src/lib/runtime/`
The provider-agnostic agent loop.
- `loop.server.ts` — `runChatLoop()`. Drives streaming, multi-round tool execution, approval gates, sub-agent dispatch. Calls `streamChat()` from `llm/`.
- `tool-handlers.server.ts` — per-tool-call dispatch (ask_user, run_subagent, normal tool). Owns the emit / pushBlock / approval-await flow.
- `types.ts` — `Session`, `RunChatLoopInput`, `LoopMessage`. The contract every caller (chat stream, automation, sub-agent) implements.
- `agent-definition.server.ts` — slot assembly + workspace context resolution.
- `session/` — SSE-backed and detached `Session` implementations.

**Rule of thumb:** if you're orchestrating "send a message, run tools, get the response back" without caring whether it goes over SSE or runs in the background — it lives here. The runtime never imports `chat/` or anything UI-shaped.

### `src/lib/chat/`
The persistence + UI-side layer. Everything that's *about* a conversation but not *driving* it.
- `chat.ts` — pure transforms (renderMarkdown, trimToolResult).
- `chat.server.ts` — re-exports of the LLM helpers used by the chat domain.
- `chat.remote.ts` — SvelteKit remote functions for the chat page (createConversation, getConversation, deleteMessagesAfter, etc).
- `streaming-blocks.ts` — pure transforms over `StreamingBlock[]` (the chat page's per-message state machine).
- `streaming-interpolation.ts` — typewriter-animation step functions.
- `streaming-events.ts` (in streaming-blocks.ts) — SSE event → block mutation transforms.
- `stream-prep.server.ts` + `stream-slots.server.ts` + `stream-persistence.server.ts` — pre-stream + post-stream helpers used by `routes/chat/[id]/stream/+server.ts`.
- `*.svelte` — the message bubbles, tool cards, ask-user modal, etc.

**Rule of thumb:** if you're handling a chat message in flight at the page layer (rendering, persistence, optimistic updates) — it lives here. The chat layer imports from `runtime/` and `llm/`, never the reverse.

The dependency direction is strict: `chat/` → `runtime/` → `llm/`. A function in `runtime/` that needs to know about chat-specific persistence (e.g. `persistAssistantMessage`) is misplaced — it belongs in `chat/`.

---

## `automations/` vs `jobs/`

Both are scheduled execution. The split is who initiated the schedule.

### `src/lib/automations/`
**User-facing recurring agent prompts.** A user creates an automation in `/automations`, sets a cron expression, picks a mode (`chat_followup`, `research`, `maintenance`), and the system fires it on the schedule.
- `automation.schema.ts` — the `automations` table.
- `engine.ts` — `runAutomationById()` (the public dispatcher) + `checkAndRunAutomations()` (cron tick → enqueue).
- `chat-followup-mode.server.ts`, `maintenance-mode.server.ts`, etc. — per-mode dispatch.

### `src/lib/jobs/`
**System-initiated background tasks.** Memory mining, research orchestration, evaluator passes, automation execution itself. Anything the platform queues for a worker to consume.
- `jobs.schema.ts` — the `jobs` + `job_leases` + `job_policies` tables.
- `jobs.server.ts` — the durable queue (enqueue / claim / heartbeat / complete / fail).
- `worker.server.ts` — the in-process worker loop.

**The interaction:** automations enqueue jobs of type `automation_run`, which the worker picks up and routes through `runAutomationById()`. Automations are the *what*; jobs are the *how*.

**Rule of thumb:** if it's a thing the user explicitly scheduled, it's in `automations/`. If it's a queue, lease, or worker primitive, it's in `jobs/`.

---

## `memory/` pipeline

Memory has four distinct phases that easily get tangled. They run in this order:

1. **Palace** (`memory.schema.ts`, `memory.server.ts`) — the data model. Wings (top-level subjects), rooms (one per day-conversation pair), closets (per-turn topics), drawers (the actual memorized snippets). All CRUD lives in `memory.server.ts`.

2. **Mining** (`memory-mining.server.ts`, `memory-handler.server.ts`) — extracts wings/rooms/closets/drawers from finished conversations via a small LLM call. Triggered by the `memory_mine` job after a chat completes (or manually from `/memory`).

3. **Embeddings + KG** (`memory-embeddings.server.ts`, `memory-kg.server.ts`) — every drawer gets a 1536-dim vector + an AAAK (people/locations/events/items/topics) index built from the rest of the schema.

4. **Recall** (`memory-recall.server.ts`) — the inverse: take a user query, find the most relevant drawers, format them as system-prompt context. Called from `stream-slots.server.ts:buildMemoryRecallSlot()`.

5. **Reorganize** (`reorganize.server.ts`) — operator-triggered cleanup: merge near-duplicate wings, consolidate closets, backfill missing embeddings.

**Rule of thumb:** new memory features almost always belong in *one* of these phases — picking the wrong one couples concerns that should stay independent. Recall doesn't write; mining doesn't read recall results; reorganize doesn't run during normal chat flow.

---

## `tools/` (handlers + sandbox)

The tool surface is a registry + a dispatch table.

- `tool-schemas.ts` — the source of truth: every tool's name, Zod schema, description, examples, disclosure tier ('always' loaded vs 'searchable'). Adding a new tool starts here.
- `tools.server.ts` — the barrel + `executeTool()` dispatcher. Reads the dispatch table and runs the matched handler.
- `handlers/<domain>.server.ts` — one file per logical group (filesystem, web, projects, media, source-control, agents-automations, skills, meta). Each file exports a `Record<string, ToolHandler>` that gets merged into the table.
- `sandbox.server.ts` + `sandbox-fs.server.ts` + `sandbox-browser.server.ts` — the per-tool primitives (workspace, shell, fs ops, headless Chrome). Handlers compose these.

**Rule of thumb:** when adding a tool:
1. Define it in `tool-schemas.ts` (schema + description + tier).
2. Implement the handler in the appropriate `handlers/<domain>.server.ts` file (or create a new domain file if it's truly new territory).
3. The dispatcher picks it up automatically via the `TOOL_HANDLERS` map.

You should never need to touch `executeTool()` itself.

---

## `runtime/` vs `chat/[id]/stream/+server.ts`

The chat-stream POST handler is *not* the runtime. It's an adapter.

- The route handler does pre-flight work that's specific to the interactive chat surface: resolve the model + reasoning config from the user's settings, build the system prompt slots, gate on budget caps, write the initial chat_run row, etc. Most of that is in `chat/stream-prep.server.ts` + `chat/stream-slots.server.ts` + `chat/stream-persistence.server.ts`.
- It then hands off to `runChatLoop()`. The runtime does the actual generation + tool execution.
- After the loop returns, the handler does post-flight: persist the assistant message, log cost, kick off memory mining + evaluator jobs.

**Rule of thumb:** if it's "what does the chat-stream endpoint specifically need", it's in `chat/`. If it's "how does the agent loop work", it's in `runtime/`. New code should rarely live in the route handler itself; that file should read like a list of helper calls.

Automation runs and inline sub-agents go through `runChatLoop()` too — they import `runtime/` directly without going through the chat route.

---

## When in doubt

The dependency arrows point one direction. If you find yourself wanting to import "up" — a `runtime/` module pulling from `chat/`, a `llm/` module pulling from `runtime/`, an `observability/` module pulling from a domain it observes — the design is wrong. Move the function down to where it belongs, or define the contract you need as a callback / interface and let the upstream caller fulfill it.
