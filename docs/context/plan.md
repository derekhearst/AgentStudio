# Context Plan

Status: active

> **See also:** [spec.md](spec.md)

## Goal

Replace the ad-hoc `systemSections.push(...)` pattern with a structured, slot-based context assembly pipeline. Improve compaction correctness, token estimation accuracy, and relevance-filtered skill injection. Add memory write-back and a context utilization indicator in the UI.

## Current State

- System prompt assembled by pushing strings into `systemSections[]` in `src/routes/chat/[id]/stream/+server.ts`
- Compaction in `src/lib/chat/chat.server.ts`: `shouldCompact` / `compactMessages` — heuristic token estimate, keeps last 6 turns, no tool-pair integrity
- Skill summaries: all skills injected every request, no relevance filter
- Memory: recalled at request start, no write-back after run
- Tool result trimming: `trimHistoricalToolResults` in `src/lib/chat/chat.ts`
- Token estimation: `estimateTokens` — almost certainly `chars / 4` heuristic
- Sub-agents: start with blank slate (`systemPrompt` + task only)
- No context utilization indicator in UI

## Phase 1 — Slot-based assembly (refactor, no behavior change)

**Goal:** Extract context assembly into a reusable `buildContextSlots` function without changing what gets injected. This makes subsequent phases testable.

### 1.1 Create `src/lib/context/slots.server.ts`

Define `ContextSlot` type and `assembleSystemPrompt(slots, budgetTokens)`:

- Each slot has `name`, `priority`, `content`, `tokenBudget`, `truncationStrategy`
- Assembly sums tokens, drops/truncates lowest-priority slots to fit budget
- Returns `{ systemPrompt: string, droppedSlots: string[], truncatedSlots: string[] }`

### 1.2 Migrate stream server to use slots

Replace `systemSections[]` in `src/routes/chat/[id]/stream/+server.ts` with slot objects:

- `identity` (priority 100)
- `tool_policy` (priority 90)
- `skills` (priority 70)
- `memory` (priority 60)

No behavior change in this step — just structural refactor.

### 1.3 Unit tests

Test `assembleSystemPrompt` with slots that exceed budget, verify correct drop order and truncation.

## Phase 2 — Token estimation accuracy

**Goal:** Accurate token counts so compaction fires at the right time.

### 2.1 Evaluate tiktoken WASM / js-tiktoken

Try `js-tiktoken` (pure JS, no native deps) for `cl100k_base` (GPT-4) and `o200k_base` (GPT-4o). Check bundle size impact — if acceptable, use it as the primary estimator.

### 2.2 Update `estimateTokens` in `src/lib/tools/tools.ts`

Add model-specific tokenizer with fallback to `chars / 4` for unknown models. Log when falling back.

### 2.3 Update `estimateMessageTokens` in `chat.server.ts`

Use the updated estimator. Include overhead for role, tool name, and JSON structure in tool messages (approx +20 tokens per tool call).

## Phase 3 — Compaction correctness

**Goal:** Compaction never splits tool call pairs; summary quality improves.

### 3.1 Tool pair integrity

In `compactMessages`, when partitioning messages into "early" (to summarize) and "recent" (to keep):

1. Walk from the split point backward until the boundary falls between a non-tool pair
2. If a `tool` result message is at the boundary, include its preceding `tool_call` in the keep set

### 3.2 Better summarization prompt

Update the compaction system prompt to:

- Explicitly instruct: preserve tool call outcomes with their names and key result values
- Preserve user corrections and explicit preferences
- Output structured sections: `## Decisions`, `## Key Facts`, `## Task State`, `## Tool Results`

### 3.3 `compactionEvents` table + migration

Add the table (per spec). Log every compaction: model, tokens before/after, turns compacted, summary text.

### 3.4 Increase `KEEP_RECENT_MESSAGES` default

Change from 6 to 8 turns.

## Phase 4 — Relevance-filtered skill injection

**Goal:** Only inject skills relevant to the current query.

### 4.1 Skill embedding index

When a skill or skill file is saved, embed its description + name. Store embedding in `skill_embeddings` table (or reuse the memory embedding infrastructure if compatible).

### 4.2 `listRelevantSkillSummaries(query, topK)`

New function in `skills.server.ts` that:

1. Embeds the query
2. Cosine-searches skill embeddings
3. Returns top-K skill summaries

Falls back to `listSkillSummaries()` (all skills) if no embedding model is configured.

### 4.3 Use in stream server

Replace `await listSkillSummaries()` with `await listRelevantSkillSummaries(body.content, skillTopK)` in both the main chat stream and inline sub-agent runner.

### 4.4 Setting

Add `skillTopK` (default 8) to `contextConfig` in settings. Add UI control in Settings → Context.

## Phase 5 — Memory write-back

**Goal:** Facts discovered in a run are stored in memory after the run completes.

### 5.1 `extractMemoryAfterRun(conversationId, userId)`

New function in `src/lib/memory/memory.server.ts` (or new file):

1. Load the last N turns of the conversation
2. Call memory extraction model (same as existing extraction pipeline)
3. Store facts with deduplication

### 5.2 Trigger after chat stream completes

In the stream server, after the final assistant message is saved, fire `extractMemoryAfterRun` as a `void` background call (non-blocking).

### 5.3 Respect `memoryWriteBackEnabled` setting

Check the setting before triggering extraction. Default: enabled.

## Phase 6 — Sub-agent context enrichment

**Goal:** Sub-agents get parent task context and relevant memory.

### 6.1 Pass `taskId` and `taskSpec` to `runInlineSubagent`

If the parent run has a task attached, include the task spec as a `task_spec` slot in the sub-agent's system prompt.

### 6.2 Memory recall for sub-agents

Run memory recall against the sub-agent's task description before building its context. Inject as a `memory` slot.

### 6.3 Parent conversation traceability

Already stored in `metadata.parentConversationId` — no change needed.

## Phase 7 — Context utilization UI

**Goal:** Users can see how full the context window is.

### 7.1 Return context stats in stream response

At the start of the stream (before first token), emit an SSE event `context_stats`:

```json
{ "tokenEstimate": 12400, "contextWindow": 200000, "didCompact": false, "droppedSlots": [] }
```

### 7.2 Context window indicator component

In the chat UI (near model selector or message input), show:

- Token bar: `████████░░░░ 12,400 / 200,000`
- Color coding: green / yellow / orange / red
- Tooltip on hover: slot breakdown (identity: 800t, skills: 400t, memory: 200t, history: 11,000t)

### 7.3 Compaction event marker

When `didCompact = true`, show a subtle divider in the conversation timeline: "Context compacted — earlier history summarized."

## Phase 8 — Per-agent slot config (advanced)

**Goal:** Different agent types get different context budgets.

### 8.1 `contextSlotConfigs` table + migration

Add the table per spec.

### 8.2 Slot assembly reads overrides

Before building slots, load any `contextSlotConfigs` rows for the user + agentId and apply overrides to the default slot definitions.

### 8.3 Settings UI

In `/agents/[id]/settings`, add a "Context" tab with slot budget controls.

## Acceptance Criteria

- [ ] `assembleSystemPrompt` exists as a standalone function with unit tests
- [ ] Token estimation uses tiktoken (or equivalent) for known models; falls back gracefully
- [ ] Compaction never splits a tool call from its result
- [ ] Compaction events are logged to `compactionEvents`
- [ ] Skill summaries are filtered by relevance; only top-K are injected
- [ ] Memory write-back fires after every completed run (non-blocking)
- [ ] Sub-agents receive task spec and recalled memory when available
- [ ] Chat UI shows token utilization bar that updates after each turn
- [ ] Compaction is visually marked in the conversation timeline

## Files to create / modify

- `src/lib/context/slots.server.ts` (new) — slot type, assembly, truncation
- `src/lib/context/index.ts` (new) — re-exports
- `src/routes/chat/[id]/stream/+server.ts` — migrate to slots, emit `context_stats`
- `src/lib/agents/inline-subagent.ts` — slot-based assembly, memory + task context
- `src/lib/chat/chat.server.ts` — compaction tool-pair integrity, improved prompt, log events
- `src/lib/tools/tools.ts` — accurate `estimateTokens`
- `src/lib/skills/skills.server.ts` — `listRelevantSkillSummaries`
- `src/lib/memory/memory.server.ts` — `extractMemoryAfterRun`
- `src/lib/sessions/sessions.schema.ts` — add `compactionEvents` table
- `src/lib/context/context.schema.ts` (new) — `contextSlotConfigs` table
- `drizzle/` — migrations for `compaction_events`, `context_slot_configs`
- `src/lib/chat/ContextWindow.svelte` — token bar + compaction marker

## Completion

- Template: YYYY-MM-DD - Completed in <PR/commit> - <one-line outcome>
- 2026-05-02 — Phase 1 (slot-based system-prompt assembly) shipped on branch `claude/nervous-kapitsa-18255e`. New `src/lib/context/slots.server.ts` exports `ContextSlot` and `assembleSystemPrompt(slots, budgetTokens?)` returning `{ systemPrompt, includedSlots, droppedSlots, truncatedSlots, estimatedTokens }`. The chat stream's `systemSections[]` array replaced with structured slots (`identity` p100, `tool_policy` p90, `skills` p70 truncatable, `memory` p60 truncatable). No behavior change when no budget is supplied — joined output is byte-identical to the previous `\n\n`-joined string.
- 2026-05-02 — Phase 3 (compaction tool-pair integrity) shipped on branch `claude/nervous-kapitsa-18255e`. New `src/lib/chat/compaction.ts` exports `findSafeSplitPoint(messages, desiredSplit)` — walks the boundary backward until it never lands on a tool result and never separates an assistant `toolCalls` message from its results. `compactMessages` now uses it to choose the split, and falls back to skipping compaction when the safe split leaves <4 early messages. Compaction summary prompt rewritten to explicitly preserve tool-call outcomes (tool names + key result values), user corrections, and explicit constraints, with structured output sections (`## Decisions`, `## Key Facts`, `## Task State`, `## Tool Results`). `KEEP_RECENT_MESSAGES` raised from 6 to 8 turns. 8 unit tests cover clean splits, mid-pair splits, multi-result sequences, completed-sequence boundaries, all-tool-history edge cases, and arbitrary-history fuzz.
- 2026-05-02 — Phase 5 (memory write-back) noted as already-complete on this branch via prior chat-stream work: every completed run runs `mineConversation` asynchronously when `memoryConfig.autoMine` is true (the default). Settings UI toggle exists. No additional code change in this slice — confirmed during Wave 1 audit.
- 2026-05-02 — Phase 6 (sub-agent context enrichment) shipped on branch `claude/nervous-kapitsa-18255e`. `runInlineSubagent` migrated from ad-hoc `systemSections[]` string-joining to the slot-based assembler (`identity` p100, `role` p95, `tool_policy` p90, `skills` p70 truncatable, `memory` p60 truncatable). Memory recall now runs against the sub-agent's task description before its system prompt is assembled, picking up the user's `memoryConfig.{enabled, topK, useRerank, rerankModel}` settings — sub-agents no longer start from a blank context slate when the user has relevant memory recorded. Failures fall through silently (catch + warn). The taskSpec part of Phase 6 is deferred until item #11 (tasks domain) ships.
- 2026-05-02 — Phase 2 (tokenizer accuracy) shipped on branch `claude/nervous-kapitsa-18255e`. New `estimateTokensForModel(text, model)` uses `js-tiktoken` (~150KB pure-JS, no WASM) for openai/* and o-series models with `cl100k_base`/`o200k_base` selection, and falls back to `cl100k_base` as a close-enough proxy for anthropic/google/mistral. Encoders are cached per family. Unknown models log once and fall back to chars/4. `estimateMessageTokens(messages, model?)` now takes the active model and adds per-message overhead (4 tokens for role framing) plus per-tool-call overhead (20 tokens for the structural wrapper) so compaction triggers at the right time for tool-heavy histories. `shouldCompact` and `compactMessages` thread the routedModel through.
- 2026-05-02 — Phase 7 (context utilization indicator) shipped on branch `claude/nervous-kapitsa-18255e`. The chat stream handler now emits a `context_stats` SSE event right after slot assembly, carrying `{ tokenEstimate, contextWindow, didCompact, includedSlots, droppedSlots, truncatedSlots, systemPromptTokens }`. The chat client captures it into a `liveContextStats` reactive state. `contextMetrics` derivation prefers the live SSE-supplied value over the chars/4-derived client estimate when present, so the existing `ContextWindow` component (already in the toolbar near the model picker) now reflects the tokenizer-accurate count from the server. No new component needed — wired into the existing one. Phases 4 (relevance-filtered skills), 8 (per-agent slot config) still pending.

## Rewrite Authority

The current implementation is a baseline, not a constraint. This domain may be rewritten, restyled, reorganized, or replaced as needed to achieve the target product quality. No code path is off-limits if behavior contracts, safety controls, tests, and documentation remain correct.

## UI Contract

Implementation in this domain must comply with [../ui/plan.md](../ui/plan.md) and [../ui/spec.md](../ui/spec.md).

- Include UX acceptance criteria for desktop and mobile behavior.
- Include compactness/density behavior where relevant.
- Include approval, question, and interruption flows where relevant.

## Completion

- Template: YYYY-MM-DD - Completed in <PR/commit> - <one-line outcome>
- Pending.
