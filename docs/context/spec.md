# Context Management Spec

## Overview

Context management is the discipline of deciding what information goes into the model's context window, in what order, at what token budget, and what happens when the window fills up. It is not a single feature — it is a cross-cutting concern that affects every LLM call in AgentStudio: chat streams, sub-agent runs, inline planners, memory extraction, evaluations, and research agents.

Good context management means the model always has the right information, never too much irrelevant noise, and never silently loses critical state when the window fills. Bad context management means the model hallucinates because a tool result was truncated, or burns tokens on skill summaries that have nothing to do with the current task.

This spec defines the **slot model**: a structured, named, budget-aware approach to assembling context, replacing the current ad-hoc `systemSections.push(...)` pattern.

## Concepts

### Context slot

A named region in the assembled system prompt with:

- A **name** (e.g. `identity`, `tool_policy`, `skills`, `memory`, `task_spec`)
- A **token budget** (hard max) or `unlimited`
- A **priority** (slots are dropped or truncated in reverse-priority order when total budget is exceeded)
- **Content** — a string, or a lazy loader that produces a string on demand
- A **truncation strategy** — `drop_slot`, `truncate_tail`, `truncate_head`, `summarize`

Slots are assembled in priority order. Before sending to the model, the system computes token totals and applies truncation from lowest priority downward until the target fits.

### Context budget

The total usable context = `modelContextWindow * (1 - reservedResponsePct)`. The reserved response portion ensures the model always has room to generate a full reply. Default: reserve 25%.

The **auto-compact threshold** is the point at which conversation history is compacted (summarized). Default: when history reaches 70% of usable context.

### Compaction

Compaction is the process of replacing older conversation turns with a summary to free up window space. The summary becomes a `system` message injected before the recent turns.

Compaction rules:

- Always keep the last N turns uncompacted (default: 8).
- The summary is produced by a fast, cheap model (configurable, default `gpt-4o-mini`).
- Tool call / tool result message pairs must be kept together when deciding what to compact or keep — never split a tool call from its result.
- Summary must preserve: decisions made, key facts, current task state, tool results that produced important data, user corrections.

### Progressive skill loading

Skills are not injected in full. Only a summary line per skill (name + description + file list) is injected at context assembly time. When the model needs a skill's content, it calls `read_skill` or `read_skill_file` to load it on demand. This keeps the base system prompt lean.

**Improvement over current state:** Skill summaries should also be relevance-filtered. At assembly time, embed the user's message and retrieve only the top-K semantically relevant skill summaries (default K=8). Irrelevant skills are not mentioned at all.

### Memory recall

Semantic search over the user's memory palace runs at request start, keyed on the incoming message. Top-K results (default 5) are injected as a `memory` slot. Memory recall happens before skill injection and before the model sees the message.

**Write-back:** After a run completes, a background job extracts new facts from the conversation and stores them in memory. This closes the loop so knowledge discovered mid-run is available in future runs.

### Tool result trimming

Historical tool results (from turns more than N messages ago) are truncated to a configurable character cap (default 400 chars) before sending to the model. The full result is stored in the DB and available for explicit retrieval but not re-sent automatically.

## Data Model

### `contextSlotConfigs` table

User-configurable overrides for slot budgets and behavior. Most slots have hardcoded defaults; this table stores per-user or per-agent overrides.

| Column        | Type      | Notes                                                    |
| ------------- | --------- | -------------------------------------------------------- |
| `id`          | uuid      | Primary key                                              |
| `userId`      | uuid      | FK to `users`                                            |
| `agentId`     | uuid?     | FK to `agents` — if null, applies to all agents for user |
| `slotName`    | text      | Slot identifier: `identity`, `skills`, `memory`, etc.    |
| `tokenBudget` | integer?  | Hard cap for this slot; null = use default               |
| `priority`    | integer?  | Override priority; null = use default                    |
| `enabled`     | boolean   | Whether this slot is included                            |
| `createdAt`   | timestamp |                                                          |
| `updatedAt`   | timestamp |                                                          |

### `compactionEvents` table

Audit log of every compaction that happened, for debugging and cost attribution.

| Column            | Type      | Notes                                        |
| ----------------- | --------- | -------------------------------------------- |
| `id`              | uuid      | Primary key                                  |
| `conversationId`  | uuid      | FK to `conversations`                        |
| `userId`          | uuid      | FK to `users`                                |
| `model`           | text      | Compaction model used                        |
| `originalTokens`  | integer   | Token count before compaction                |
| `compactedTokens` | integer   | Token count after compaction                 |
| `summaryText`     | text      | The generated summary                        |
| `turnsCompacted`  | integer   | Number of message turns that were summarized |
| `createdAt`       | timestamp |                                              |

### Settings: `contextConfig` (existing, extended)

The existing `contextConfig` jsonb in `settings` stores per-user context tuning. Extended fields:

| Field                     | Type    | Default       | Description                                         |
| ------------------------- | ------- | ------------- | --------------------------------------------------- |
| `reservedResponsePct`     | number  | 25            | % of context window reserved for model output       |
| `autoCompactThresholdPct` | number  | 70            | % of usable context that triggers compaction        |
| `compactionModel`         | string  | `gpt-4o-mini` | Model to use for summarization                      |
| `keepRecentTurns`         | integer | 8             | Turns to keep uncompacted                           |
| `maxHistoricalToolChars`  | integer | 400           | Char cap for old tool results                       |
| `skillTopK`               | integer | 8             | Max skill summaries injected after relevance filter |
| `memoryTopK`              | integer | 5             | Memory recall results injected                      |
| `memoryWriteBackEnabled`  | boolean | true          | Whether facts are extracted after each run          |

## Features

### Slot-based system prompt assembly

Replace `systemSections.push(...)` with a structured slot registry:

```
[identity]       priority=100  budget=2000   strategy=truncate_tail
[tool_policy]    priority=90   budget=500    strategy=drop_slot
[task_spec]      priority=85   budget=4000   strategy=truncate_tail
[skills]         priority=70   budget=1500   strategy=drop_slot
[memory]         priority=60   budget=800    strategy=truncate_tail
[custom_context] priority=50   budget=2000   strategy=summarize
```

Assembly:

1. Populate all slots
2. Sum token estimates
3. If total > budget: drop or truncate lowest-priority slots until fit
4. Join and inject as system message

### Token estimation accuracy

Replace the `chars / 4` heuristic with a proper tokenizer (tiktoken or equivalent) for models where the library is available. Fall back to the heuristic for unknown models. Accurate token counts prevent compaction firing too late and prevent context overflow.

### Tool call pair integrity

When deciding what to compact, treat `(assistant tool_call message, tool result message)` pairs as atomic units. Never compact the `tool_call` without compacting its result, and never leave a dangling `tool` result message without its preceding `tool_call`.

### Relevance-filtered skill injection

At assembly time:

1. Embed the user's message (or use a keyword fallback if no embedding model is configured)
2. Score all skill summaries against the embedding
3. Inject the top-K results only
4. The model can still call `list_skills` to discover others

### Memory write-back

After each run that produces an assistant message, a background job runs `extractMemoryFacts(conversationId)`:

1. Pass the conversation turns to the memory extraction model
2. Parse structured facts
3. Store facts in the memory palace with deduplication

This is a best-effort background operation — it must not block the response stream.

### Context window indicator

The chat UI shows a live token utilization indicator:

- Green: < 50% full
- Yellow: 50–80% full
- Orange: 80–90% full
- Red: > 90% (compaction imminent or just happened)

Shows: estimated tokens used / context window size. Compaction events show as a visual marker in the conversation timeline.

### Sub-agent context injection

Sub-agents currently start with a blank slate (only their `systemPrompt` + the task message). Extended sub-agent context should include:

- The parent task spec (if the run originated from a task)
- Relevant memory recalled for the task description
- The parent conversation ID for traceability

### Configurable slot overrides

Advanced users can override slot budgets, enable/disable slots, and change compaction model via settings UI. Per-agent slot config allows giving a coding agent a large `task_spec` budget while a chat agent keeps it minimal.

## Behavior Contracts

- The system message is **always** assembled fresh on every request — it is never cached between turns.
- Compaction **never** splits a tool call from its result.
- Compaction **never** discards the most recent `keepRecentTurns` turns.
- Skill summaries injected into context must match what `list_skills` would return — no stale index.
- Memory write-back is fire-and-forget; failure must be logged but must not affect the response.
- If token estimation is unavailable for a model, the system falls back to the chars/4 heuristic and logs a warning.
- Context slot truncation must log the slot name and how many tokens were trimmed for observability.
- A run that fails due to a context overflow error should retry once with forced compaction before surfacing the error to the user.

## Roles & Permissions

| Action                                  | Who can do it          |
| --------------------------------------- | ---------------------- |
| View context window utilization in chat | Any authenticated user |
| Configure `contextConfig` settings      | Any authenticated user |
| Configure per-agent slot overrides      | Any authenticated user |
| View `compactionEvents` for own convs   | Any authenticated user |
| View `compactionEvents` for all users   | Admin only             |
| Disable memory write-back globally      | Admin only             |

## Rewrite Authority

The current implementation is a baseline, not a constraint. This domain may be rewritten, restyled, reorganized, or replaced as needed to achieve the target product quality. No code path is off-limits if behavior contracts, safety controls, tests, and documentation remain correct.

## UI Contract

This domain follows the shared UX system in [../ui/spec.md](../ui/spec.md).

- Surfaces in this domain must align with the shared desktop/mobile shell patterns.
- Domain-specific states must be explicit in the UI (for example pending, running, blocked, completed) where applicable.
- Blocking user decisions must use the shared action-card and inbox patterns where applicable.

## References
- [../memory/spec.md](../memory/spec.md) — memory palace and recall
- [../skills/spec.md](../skills/spec.md) — skill loading and summaries
- [../agents/spec.md](../agents/spec.md) — agent identity and system prompts
- [../runs/spec.md](../runs/spec.md) — run context and sub-agent execution
- [../chat/spec.md](../chat/spec.md) — conversation UI and context indicator
- [Anthropic Model Context Protocol](https://www.anthropic.com/news/model-context-protocol) — structured context design
- [Managing Claude's context window — Anthropic docs](https://docs.anthropic.com/en/docs/build-with-claude/context-windows)

