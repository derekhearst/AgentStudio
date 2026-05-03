# Master Implementation Order

## Purpose

This is the execution-order backlog for all planned domain work. It is optimized for autonomous agent execution with clear dependency gates and explicit parallel lanes.

## Ground Rules

- Do not start a wave until the previous wave gate is green.
- Within a wave, run independent lanes in parallel.
- Every lane must ship tests and docs updates before marking done.
- Favor thin vertical slices over broad partially-done refactors.
- Existing implementation is not a constraint: domains may be rewritten, restyled, or reorganized as needed to reach the target quality bar.

## Wave Map (Critical Path)

| Wave | Outcome                             | Domains                                            | Parallel Lanes |
| ---- | ----------------------------------- | -------------------------------------------------- | -------------- |
| 0    | Repo structure stable               | structure, llm, ui                                 | 3              |
| 1    | Core execution state stable         | runs, context, cost, chat, workspace               | 4              |
| 2    | Runtime composition stable          | tools, skills, runtime, tasks                      | 3              |
| 3    | Governance controls stable          | settings, hooks, evaluations                       | 3              |
| 4    | Feature services stable             | projects, memory, jobs, research                   | 4              |
| 5    | End-to-end product workflows stable | source-control, observability, automations, agents | 4              |

---

## Master TODO Backlog

### Completion Protocol (Required For Every TODO)

When any TODO item is finished, perform all closeout steps below before calling it done:

- [ ] Mark the TODO in this file from `[ ]` to `[x]`
- [ ] Update the domain plan file with a status line near the top:
  - `Status: active` while work is in progress
  - `Status: completed` when the plan is fully implemented
- [ ] Add a one-line completion note in the domain plan under a `Completion` section with date and PR/commit reference
- [ ] Ensure the domain is no longer listed as active in any lane or wave tracking notes

If any closeout checkbox is not done, the TODO is not complete.

### Wave 0 — Foundation

1. [x] Structure refactor (folders, imports, ownership boundaries)
   - Source: ../structure/plan.md
   - Blocks: all downstream waves
   - Gate: build/test passes; no unresolved imports; route parity verified
   - Evidence:
     - Domain rename slice completed: [src/lib/automations/index.ts](../../src/lib/automations/index.ts), [src/lib/costs/index.ts](../../src/lib/costs/index.ts)
     - Runs extraction slice completed: [src/lib/runs/index.ts](../../src/lib/runs/index.ts), [src/lib/runs/runs.server.ts](../../src/lib/runs/runs.server.ts), [src/lib/runs/runs.schema.ts](../../src/lib/runs/runs.schema.ts)
   - Run schema ownership moved out of chat into runs: [src/lib/runs/runs.schema.ts](../../src/lib/runs/runs.schema.ts)
   - Run schema imports updated at call sites: [src/lib/chat/chat.remote.ts](../../src/lib/chat/chat.remote.ts), [src/lib/agents/inline-subagent.ts](../../src/lib/agents/inline-subagent.ts), [src/routes/chat/[id]/stream/+server.ts](../../src/routes/chat/[id]/stream/+server.ts)
   - Schema-level conversation/message dependencies moved behind sessions: [src/lib/runs/runs.schema.ts](../../src/lib/runs/runs.schema.ts), [src/lib/automations/automation.schema.ts](../../src/lib/automations/automation.schema.ts), [src/lib/memory/memory.schema.ts](../../src/lib/memory/memory.schema.ts), [src/lib/db.server.ts](../../src/lib/db.server.ts)
   - DB schema registration includes runs + sessions: [src/lib/db.server.ts](../../src/lib/db.server.ts)
   - Sessions scaffold started for chat split: [src/lib/sessions/index.ts](../../src/lib/sessions/index.ts), [src/lib/sessions/sessions.schema.ts](../../src/lib/sessions/sessions.schema.ts)
   - Session schema ownership handoff completed: [src/lib/sessions/sessions.schema.ts](../../src/lib/sessions/sessions.schema.ts)
   - Session imports moved in core flows: [src/lib/chat/chat.remote.ts](../../src/lib/chat/chat.remote.ts), [src/lib/agents/inline-subagent.ts](../../src/lib/agents/inline-subagent.ts), [src/lib/automations/engine.ts](../../src/lib/automations/engine.ts), [src/routes/chat/[id]/stream/+server.ts](../../src/routes/chat/[id]/stream/+server.ts), [src/lib/agents/agents.server.ts](../../src/lib/agents/agents.server.ts), [src/lib/costs/cost.remote.ts](../../src/lib/costs/cost.remote.ts), [src/lib/memory/memory.server.ts](../../src/lib/memory/memory.server.ts), [src/lib/memory/retrieval.server.ts](../../src/lib/memory/retrieval.server.ts), [src/routes/api/mcp/+server.ts](../../src/routes/api/mcp/+server.ts)
     - Compatibility shims removed after call-site migration: src/lib/chat/chat.schema.ts, src/lib/chat/runs.server.ts (deleted)
     - Monitor routes moved to runs domain: [src/routes/api/chat/monitor/+server.ts](../../src/routes/api/chat/monitor/+server.ts), [src/routes/api/agents/monitor/+server.ts](../../src/routes/api/agents/monitor/+server.ts)

2. [x] LLM consolidation (`openrouter.server.ts` + `models/` → `llm/`)
   - Source: ../llm/plan.md
   - Parallel with: #1 after target folders exist
   - Gate: all LLM callers moved; model list + chat streaming parity
   - Evidence:
     - New llm domain: [src/lib/llm/index.ts](../../src/lib/llm/index.ts), [src/lib/llm/chat.server.ts](../../src/lib/llm/chat.server.ts), [src/lib/llm/models.server.ts](../../src/lib/llm/models.server.ts), [src/lib/llm/models.remote.ts](../../src/lib/llm/models.remote.ts), [src/lib/llm/ModelSelector.svelte](../../src/lib/llm/ModelSelector.svelte)
     - Representative callers updated: [src/routes/chat/[id]/stream/+server.ts](../../src/routes/chat/[id]/stream/+server.ts), [src/lib/chat/chat.server.ts](../../src/lib/chat/chat.server.ts), [src/lib/memory/mining.server.ts](../../src/lib/memory/mining.server.ts), [src/lib/tools/tools.server.ts](../../src/lib/tools/tools.server.ts)
   - Legacy files removed (git diff evidence): openrouter.server.ts and models/\* were deleted in this migration.
     - Plan closeout: [docs/llm/plan.md](../llm/plan.md)

UX-1. [x] UI platform and interaction system (cross-cutting) - Source: ../ui/plan.md - Starts in Wave 0 and continues through Wave 5 - Blocks: final UX acceptance for #6, #15, #18, #19, #20, #22 - Gate: desktop/mobile shell, action cards, and multi-session UX contracts implemented - Evidence: - Shell contract documented: [docs/ui/spec.md](../ui/spec.md) — Shell Implementation Contract - UI contract template added: [docs/ui/spec.md](../ui/spec.md) — Domain Integration Contracts - Running sessions dock: [src/lib/ui/RunningSessionsDock.svelte](../../src/lib/ui/RunningSessionsDock.svelte) - Unified action card: [src/lib/ui/ActionCard.svelte](../../src/lib/ui/ActionCard.svelte) - Dock wired into sidebar: [src/lib/ui/Sidebar.svelte](../../src/lib/ui/Sidebar.svelte)

### Wave 1 — Core Runtime Inputs/Outputs

3. [x] Runs durability and resume semantics
   - Source: ../runs/plan.md
   - Gate: pause/resume/retry pass; blocked-state recovery proven
   - Evidence (Phase 1 — persist pending tool approvals, 2026-05-02):
     - Schema column added: [src/lib/runs/runs.schema.ts](../../src/lib/runs/runs.schema.ts) (`pendingApprovals` jsonb)
     - Drizzle migration: [drizzle/0013_silky_blizzard.sql](../../drizzle/0013_silky_blizzard.sql)
     - New module with row-locked helpers: [src/lib/runs/approvals.server.ts](../../src/lib/runs/approvals.server.ts)
     - In-memory approval registry removed: [src/lib/tools/tools.server.ts](../../src/lib/tools/tools.server.ts), [src/lib/tools/index.ts](../../src/lib/tools/index.ts)
     - Stream loop rewired: [src/routes/chat/[id]/stream/+server.ts](../../src/routes/chat/[id]/stream/+server.ts)
     - Approve/deny endpoint rewired: [src/routes/chat/[id]/tool-approve/+server.ts](../../src/routes/chat/[id]/tool-approve/+server.ts)
     - Integration tests: [tests/runs.approvals.spec.ts](../../tests/runs.approvals.spec.ts)
   - Evidence (Phase 2 — persist pending `ask_user` questions, 2026-05-02):
     - Schema column added: [src/lib/runs/runs.schema.ts](../../src/lib/runs/runs.schema.ts) (`pendingQuestions` jsonb)
     - Drizzle migration: [drizzle/0014_zippy_adam_destine.sql](../../drizzle/0014_zippy_adam_destine.sql)
     - New module with row-locked helpers: [src/lib/runs/questions.server.ts](../../src/lib/runs/questions.server.ts)
     - In-memory question registry removed: [src/lib/tools/tools.server.ts](../../src/lib/tools/tools.server.ts)
     - Stream loop rewired: [src/routes/chat/[id]/stream/+server.ts](../../src/routes/chat/[id]/stream/+server.ts)
     - Answer endpoint rewired: [src/routes/chat/[id]/ask-user/+server.ts](../../src/routes/chat/[id]/ask-user/+server.ts)
     - Integration tests: [tests/runs.questions.spec.ts](../../tests/runs.questions.spec.ts)
   - Evidence (Phase 3 — persist incremental stream blocks + tool round counter, 2026-05-02):
     - Schema columns added: [src/lib/runs/runs.schema.ts](../../src/lib/runs/runs.schema.ts) (`streamBlocks` jsonb, `currentRound` integer, shared `StreamBlock` type)
     - Drizzle migration: [drizzle/0015_dizzy_the_anarchist.sql](../../drizzle/0015_dizzy_the_anarchist.sql)
     - New module: [src/lib/runs/blocks.server.ts](../../src/lib/runs/blocks.server.ts) (`persistRunBlocks` snapshot, `setRunRound`)
     - Stream loop mirrors blocks per push and bumps round counter: [src/routes/chat/[id]/stream/+server.ts](../../src/routes/chat/[id]/stream/+server.ts)
     - Integration tests: [tests/runs.blocks.spec.ts](../../tests/runs.blocks.spec.ts)
   - Evidence (Phase 4 — run event log, 2026-05-02):
     - New `run_events` table + `next_event_seq` counter: [src/lib/runs/runs.schema.ts](../../src/lib/runs/runs.schema.ts)
     - Drizzle migration: [drizzle/0016_previous_miracleman.sql](../../drizzle/0016_previous_miracleman.sql)
     - New module: [src/lib/runs/events.server.ts](../../src/lib/runs/events.server.ts) (`appendRunEvent` transactional insert, `listRunEvents` reader)
     - Stream emit is now async and dual-writes block-level events: [src/routes/chat/[id]/stream/+server.ts](../../src/routes/chat/[id]/stream/+server.ts) (per-token `delta`/`reasoning` events skip persistence — recoverable from `streamBlocks`)
     - Integration tests: [tests/runs.events.spec.ts](../../tests/runs.events.spec.ts)
   - Evidence (Phase 5 — resumable streaming, 2026-05-02):
     - New endpoint: [src/routes/chat/[id]/stream/resume/+server.ts](../../src/routes/chat/[id]/stream/resume/+server.ts) (replay past events, tail new ones until terminal state, emit synthetic `done`)
     - SSE frames carry seq: [src/routes/chat/[id]/stream/+server.ts](../../src/routes/chat/[id]/stream/+server.ts) (`sse(name, payload, seq)` writes `id:` line)
     - Client reconnects on disconnect: [src/routes/chat/[id]/+page.svelte](../../src/routes/chat/[id]/+page.svelte) (tracks `lastSeenSeq`, retries via resume up to 3 attempts)
     - Integration tests: [tests/runs.resume.spec.ts](../../tests/runs.resume.spec.ts)
   - Evidence (Phase 6 — drop in-memory state, 2026-05-02):
     - Deleted orphaned in-memory streaming registry: `src/lib/agents/streaming-state.server.ts` (no remaining consumers; runs domain is now fully durable in Postgres)

4. [x] Context slot assembly + compaction invariants
   - Source: ../context/plan.md
   - Gate: token budget respected; tool call/result pair integrity preserved
   - Evidence (Phase 1 — slot-based system-prompt assembly, 2026-05-02):
     - New module: [src/lib/context/slots.server.ts](../../src/lib/context/slots.server.ts) — `ContextSlot`, `assembleSystemPrompt`
     - Barrel: [src/lib/context/index.ts](../../src/lib/context/index.ts)
     - Stream handler migrated from `systemSections[]` to slots: [src/routes/chat/[id]/stream/+server.ts](../../src/routes/chat/[id]/stream/+server.ts)
     - Unit tests: [tests/context.slots.spec.ts](../../tests/context.slots.spec.ts)
   - Evidence (Phase 3 — compaction tool-pair integrity, 2026-05-02):
     - New pure module: [src/lib/chat/compaction.ts](../../src/lib/chat/compaction.ts) — `findSafeSplitPoint`
     - `compactMessages` uses safe split, structured summary prompt, KEEP_RECENT_MESSAGES raised 6→8: [src/lib/chat/chat.server.ts](../../src/lib/chat/chat.server.ts)
     - Unit tests: [tests/context.compaction.spec.ts](../../tests/context.compaction.spec.ts)
   - Evidence (Phase 5 — memory write-back, already in place on this branch):
     - `mineConversation` runs after every completed run, gated by `memoryConfig.autoMine`: [src/routes/chat/[id]/stream/+server.ts](../../src/routes/chat/[id]/stream/+server.ts) line ~927
   - Evidence (Phase 6 — sub-agent context enrichment, 2026-05-02):
     - `runInlineSubagent` migrated to slot-based assembly + memory recall on task description: [src/lib/agents/inline-subagent.ts](../../src/lib/agents/inline-subagent.ts)
   - Evidence (Phase 2 — tokenizer accuracy, 2026-05-02):
     - js-tiktoken installed (`package.json` dependency)
     - `estimateTokensForModel(text, model)` with cached per-family encoders + fallback: [src/lib/tools/tools.ts](../../src/lib/tools/tools.ts)
     - `estimateMessageTokens(messages, model?)` adds per-message + per-tool-call overhead: [src/lib/chat/chat.server.ts](../../src/lib/chat/chat.server.ts)
     - `shouldCompact` and `compactMessages` thread the routedModel through; stream handler passes it: [src/routes/chat/[id]/stream/+server.ts](../../src/routes/chat/[id]/stream/+server.ts)
     - 8 unit tests covering fallback, model routing, known token counts, encoder caching: [tests/context.tokens.spec.ts](../../tests/context.tokens.spec.ts)
   - Evidence (Phase 7 — context utilization indicator, 2026-05-02):
     - Stream handler emits a `context_stats` SSE event after slot assembly (tokenEstimate, contextWindow, didCompact, included/dropped/truncated slots, systemPromptTokens): [src/routes/chat/[id]/stream/+server.ts](../../src/routes/chat/[id]/stream/+server.ts)
     - Chat client captures it into reactive state and the existing `ContextWindow` component reflects the tokenizer-accurate count: [src/routes/chat/[id]/+page.svelte](../../src/routes/chat/[id]/+page.svelte)
     - Live test verifying the event arrives with all fields: [tests/context.utilization.spec.ts](../../tests/context.utilization.spec.ts)
   - Evidence (Phase 4 — relevance-filtered skills, 2026-05-02):
     - Schema: `description_embedding` vector + `description_embedded_at` on skills: [src/lib/skills/skills.schema.ts](../../src/lib/skills/skills.schema.ts), migration [drizzle/0020_tense_tiger_shark.sql](../../drizzle/0020_tense_tiger_shark.sql)
     - `refreshSkillEmbedding`, `backfillSkillEmbeddings`, `listRelevantSkillSummaries`: [src/lib/skills/skills.server.ts](../../src/lib/skills/skills.server.ts)
     - Stream handler uses relevance + skillTopK setting (default 8): [src/routes/chat/[id]/stream/+server.ts](../../src/routes/chat/[id]/stream/+server.ts)
     - Bootstrap + cron tick run backfill: [src/lib/db.server.ts](../../src/lib/db.server.ts), [src/routes/api/cron/+server.ts](../../src/routes/api/cron/+server.ts)
     - Tests: cron-driven backfill, cosine ranking, unembedded skills surface: [tests/context.skill-relevance.spec.ts](../../tests/context.skill-relevance.spec.ts)
   - Evidence (Phase 8 — per-agent slot config, 2026-05-02):
     - New `context_slot_configs` table: [src/lib/context/context.schema.ts](../../src/lib/context/context.schema.ts), migration [drizzle/0021_pale_hiroim.sql](../../drizzle/0021_pale_hiroim.sql)
     - `loadSlotOverrides`, `upsertSlotOverride`, `deleteSlotOverride`: [src/lib/context/overrides.server.ts](../../src/lib/context/overrides.server.ts)
     - `applySlotOverrides` merges defaults with user/agent overrides: [src/lib/context/slots.server.ts](../../src/lib/context/slots.server.ts)
     - Stream handler applies overrides before assembly: [src/routes/chat/[id]/stream/+server.ts](../../src/routes/chat/[id]/stream/+server.ts)
     - Tests: 7 unit specs + 3 schema/cascade specs across [tests/context.slot-overrides.spec.ts](../../tests/context.slot-overrides.spec.ts) and [tests/context.slot-overrides-db.spec.ts](../../tests/context.slot-overrides-db.spec.ts)
   - **#4 Context now fully complete — flipped to `[x]` above.**

5. [ ] Cost linkage (`runId/taskId/agentId`) + budget enforcement
   - Source: ../cost/plan.md
   - Depends on: #3
   - Gate: cost-by-run/task/agent dashboards query correctly
   - Evidence (Phase 1 — run/task/agent/user linkage on `llm_usage`, 2026-05-02):
     - Schema columns + FKs + indexes added: [src/lib/costs/usage.schema.ts](../../src/lib/costs/usage.schema.ts)
     - Drizzle migration: [drizzle/0017_magenta_the_call.sql](../../drizzle/0017_magenta_the_call.sql)
     - `LogInput` extended with optional `userId`/`runId`/`taskId`/`agentId`: [src/lib/costs/usage.ts](../../src/lib/costs/usage.ts)
     - Call-site updates pass full context: [src/routes/chat/[id]/stream/+server.ts](../../src/routes/chat/[id]/stream/+server.ts), [src/lib/agents/inline-subagent.ts](../../src/lib/agents/inline-subagent.ts), [src/lib/automations/engine.ts](../../src/lib/automations/engine.ts)
     - `getCostSummary` adds `byRun` / `byAgent` / `byTask` rollups: [src/lib/costs/cost.remote.ts](../../src/lib/costs/cost.remote.ts)
     - Integration tests including a live chat that asserts the populated row: [tests/cost.linkage.spec.ts](../../tests/cost.linkage.spec.ts)
   - Evidence (Phase 2 — tool-usage ledger, 2026-05-02):
     - New `tool_usage` table with same context FKs as `llm_usage`: [src/lib/costs/usage.schema.ts](../../src/lib/costs/usage.schema.ts)
     - Drizzle migration: [drizzle/0019_bitter_chamber.sql](../../drizzle/0019_bitter_chamber.sql)
     - `logToolUsage` helper (cost or units×costPerUnit): [src/lib/costs/usage.ts](../../src/lib/costs/usage.ts)
     - `getCostSummary` adds `toolSpend`, `toolCallCount`, `byTool`, `combinedSpend`: [src/lib/costs/cost.remote.ts](../../src/lib/costs/cost.remote.ts)
     - Tests: [tests/cost.tool-usage.spec.ts](../../tests/cost.tool-usage.spec.ts)
     - `web_search` instrumented in [src/lib/tools/tools.server.ts](../../src/lib/tools/tools.server.ts) — writes a `tool_usage` row per call (provider=searxng, cost from `SEARCH_COST_PER_CALL_USD` env)
     - Live test proving the chat → web_search → tool_usage row chain: [tests/cost.tool-usage-live.spec.ts](../../tests/cost.tool-usage-live.spec.ts)
   - Evidence (Phase 3 — budget limits + alerts, 2026-05-03):
     - New `budget_limits` and `budget_alerts` tables + 4 enums: [src/lib/costs/usage.schema.ts](../../src/lib/costs/usage.schema.ts), migration [drizzle/0022_polite_human_fly.sql](../../drizzle/0022_polite_human_fly.sql)
     - `checkBudgetLimits`, `recordBudgetAlert` (per-period idempotent): [src/lib/costs/budget.server.ts](../../src/lib/costs/budget.server.ts)
     - Stream handler enforces BEFORE chat_run insert; returns HTTP 402 with `budget_exceeded`: [src/routes/chat/[id]/stream/+server.ts](../../src/routes/chat/[id]/stream/+server.ts)
     - Tests cover schema round-trip, enum rejection, cascade-on-limit-delete, live-block (402 + alert + no orphan run), live-notify_only (run proceeds + warn alert): [tests/cost.budget.spec.ts](../../tests/cost.budget.spec.ts)
   - Evidence (Phase 4 — dashboard improvements, 2026-05-03):
     - `/cost` page gains LLM+tool combined panel, Top Runs, Top Agents, and Tool Spend table sections: [src/routes/cost/+page.svelte](../../src/routes/cost/+page.svelte)
     - 5 budget CRUD remote functions (`listBudgetLimits`, `createBudgetLimit`, `updateBudgetLimit`, `deleteBudgetLimit`, `listBudgetAlerts`): [src/lib/costs/cost.remote.ts](../../src/lib/costs/cost.remote.ts)
   - Phase 5 (provider reconciliation against OpenRouter invoices) still pending — flagged as future-work in the spec, not required for Wave 1 closure.

6. [ ] Chat mode system + inline approvals + HUD
   - Source: ../chat/plan.md
   - Depends on: #3, #4
   - Gate: mode switch anchors persisted; approval cards mutate durable state
   - Evidence (Phase 1 + server half of Phase 2 — mode column, workbench prefs, anchor messages, mode-aware identity slot, 2026-05-02):
     - New `chat_mode` enum + `mode` column on conversations: [src/lib/sessions/sessions.schema.ts](../../src/lib/sessions/sessions.schema.ts)
     - New `chat_workbench_preferences` table: [src/lib/chat/chat.workbench.schema.ts](../../src/lib/chat/chat.workbench.schema.ts)
     - Drizzle migration: [drizzle/0018_foamy_santa_claus.sql](../../drizzle/0018_foamy_santa_claus.sql)
     - Mode helpers (`setConversationMode` writes system anchor message, `getWorkbenchPreferences` seeds defaults): [src/lib/chat/mode.server.ts](../../src/lib/chat/mode.server.ts)
     - Mode remote functions: [src/lib/chat/chat.remote.ts](../../src/lib/chat/chat.remote.ts)
     - Stream handler reads `conversation.mode` and prepends mode-posture slot: [src/routes/chat/[id]/stream/+server.ts](../../src/routes/chat/[id]/stream/+server.ts)
     - Schema constraint + behavior + live-LLM tests: [tests/chat.mode.spec.ts](../../tests/chat.mode.spec.ts)
   - Evidence (Phase 2 UI mode selector, 2026-05-02):
     - New component: [src/lib/chat/ModeSelector.svelte](../../src/lib/chat/ModeSelector.svelte)
     - Wired through composer + input + page: [src/lib/chat/ChatComposer.svelte](../../src/lib/chat/ChatComposer.svelte), [src/lib/chat/ChatInput.svelte](../../src/lib/chat/ChatInput.svelte), [src/routes/chat/[id]/+page.svelte](../../src/routes/chat/[id]/+page.svelte)
     - UI test verifies switch persists to DB + writes anchor message; same-mode pick is a no-op: [tests/chat.mode-selector.spec.ts](../../tests/chat.mode-selector.spec.ts)
   - Evidence (Phase 3 — mode identity skills seeded on boot, 2026-05-02):
     - New module: [src/lib/chat/mode-skills.server.ts](../../src/lib/chat/mode-skills.server.ts) (fixed UUIDs, `seedModeIdentitySkills(dbInstance)`, `loadModeIdentitySkill(mode)`)
     - Bootstrap seeds on first boot: [src/lib/db.server.ts](../../src/lib/db.server.ts)
     - Stream handler reads live posture content: [src/routes/chat/[id]/stream/+server.ts](../../src/routes/chat/[id]/stream/+server.ts)
     - Mode helper exposes loader: [src/lib/chat/mode.server.ts](../../src/lib/chat/mode.server.ts) (`getModePostureContent`)
     - Tests cover seed, ON CONFLICT preservation of user edits, and disabled-skill fallback through a live LLM stream: [tests/chat.mode-skills.spec.ts](../../tests/chat.mode-skills.spec.ts)
   - Evidence (Phase 5 — live run HUD above the composer, 2026-05-02):
     - New component: [src/lib/chat/RunHud.svelte](../../src/lib/chat/RunHud.svelte) — visible only when `streaming || pendingQuestion || pendingApprovalCount > 0`; renders status badge, mode badge, tool/sub-agent counts, compaction marker, token-window % (with raw counts in `title`), trace link, Cancel + Answer buttons
     - Status precedence: Waiting for your answer → Waiting for N approvals → Running &lt;tool&gt; → Generating → Idle (driven by props, derived inside the component)
     - Wired into chat page above ChatInput; consumes `liveContextStats` (now carrying `runId`) for the trace deep-link, derives pending-approval count from `streamingBlocks.kind === 'tool' && status === 'pending'`, and resets `liveContextStats` when a new stream starts so the HUD never shows stale runId or compacted flag from the previous turn: [src/routes/chat/[id]/+page.svelte](../../src/routes/chat/[id]/+page.svelte)
     - Stream emits `runId` on the `context_stats` SSE event so the HUD can deep-link the run: [src/routes/chat/[id]/stream/+server.ts](../../src/routes/chat/[id]/stream/+server.ts)
   - Evidence (Phase 6 — inline `ask_user` card replaces the modal as the primary surface, 2026-05-02):
     - New component: [src/lib/chat/AskUserCard.svelte](../../src/lib/chat/AskUserCard.svelte) — renders the active question as an assistant bubble with inline option buttons + freeform textarea (reuses `AskUserQuestionCard`), plus prev/next stepper for multi-question flows; once `status === 'completed'` and answers are present, transitions to a Q&A layout: question on the left as an assistant bubble, answer on the right as a user-style bubble (mirrors how the persisted `MessageBubble` renders the same exchange after the run finishes)
     - Chat page replaces the previous "questions render as plain assistant bubbles + modal pops" pattern with a single AskUserCard inline; the AskUserModal stays mounted as an escape hatch (HUD's "Answer" button toggles it), but `askUserModalOpen` no longer auto-flips on the `ask_user` event: [src/routes/chat/[id]/+page.svelte](../../src/routes/chat/[id]/+page.svelte)
     - New `getAskUserAnswersFromTool(block)` helper extracts the answers payload from the tool_result so the streaming card can switch to its answered state without waiting for a page reload; `getAskUserQuestionsFromTool` was extended to return the full question shape (options + allowFreeformInput), not just header/question
   - Phases 4, 7-9 (plan approval card, mode-aware right panel, diff/artifact preview, research report view) still pending — keep `[ ]` until full plan lands.

7. [x] Workspace sandbox baseline and task execution isolation
   - Source: ../workspace/plan.md
   - Gate: isolated workspaces proven with e2e checks (ephemeral, persistent, AND worktree modes all covered)
   - Evidence (Phase 1 — per-run ephemeral workspace dirs, 2026-05-02):
     - New module: [src/lib/workspace/workspace.server.ts](../../src/lib/workspace/workspace.server.ts) — `resolveWorkspaceRoot`, `safePathWithin`, `ensureWorkspace`
     - Barrel: [src/lib/workspace/index.ts](../../src/lib/workspace/index.ts)
     - `executeTool(call, userId, runId?)` accepts optional runId; AsyncLocalStorage now carries it: [src/lib/tools/tools.server.ts](../../src/lib/tools/tools.server.ts)
     - Call sites pass `run.id`: [src/routes/chat/[id]/stream/+server.ts](../../src/routes/chat/[id]/stream/+server.ts), [src/lib/agents/inline-subagent.ts](../../src/lib/agents/inline-subagent.ts)
     - Unit tests for path resolution + traversal rejection: [tests/workspace.isolation.spec.ts](../../tests/workspace.isolation.spec.ts)
     - Live test proving a `file_write` from chat lands in `<sandbox>/<userId>/runs/<runId>/`: [tests/workspace.live.spec.ts](../../tests/workspace.live.spec.ts)
   - Evidence (Phase 3 — workspace GC, 2026-05-02):
     - Pure GC core: [src/lib/workspace/gc-core.ts](../../src/lib/workspace/gc-core.ts) (`runWorkspaceGcCore` takes `lookupRuns` callback so it's unit-testable without `$env`)
     - Drizzle-backed wrapper: [src/lib/workspace/gc.server.ts](../../src/lib/workspace/gc.server.ts)
     - Cron tick runs GC after automations: [src/routes/api/cron/+server.ts](../../src/routes/api/cron/+server.ts)
     - Manual CLI: [scripts/gc-workspaces.ts](../../scripts/gc-workspaces.ts) (`--dry-run`, `--ttl-days N`)
     - Tests cover: TTL eviction, active-run skip, recent-finish skip, orphan-keep, legacy-untouched, dry-run, missing-root: [tests/workspace.gc.spec.ts](../../tests/workspace.gc.spec.ts)
   - Evidence (Phase 2 — persistent workspace mode, 2026-05-02):
     - `WorkspaceContext` gains `persistentKey`; `resolveWorkspaceRoot` picks `persistent/<key>/` when set: [src/lib/workspace/workspace.server.ts](../../src/lib/workspace/workspace.server.ts)
     - `executeTool(call, userId, runId?, { persistentKey? })` threads it through AsyncLocalStorage: [src/lib/tools/tools.server.ts](../../src/lib/tools/tools.server.ts)
     - Chat stream + sub-agent read `agent.config.workspace` and pass through: [src/routes/chat/[id]/stream/+server.ts](../../src/routes/chat/[id]/stream/+server.ts), [src/lib/agents/inline-subagent.ts](../../src/lib/agents/inline-subagent.ts)
     - Tests for path layout, precedence (persistent > runId), shared-dir-across-runs, traversal rejection: [tests/workspace.isolation.spec.ts](../../tests/workspace.isolation.spec.ts)
   - Evidence (Phase 4 — git-worktree workspace mode, 2026-05-02):
     - Pure git arg builder + porcelain parser (no node:child_process / SvelteKit deps): [src/lib/workspace/worktree-core.ts](../../src/lib/workspace/worktree-core.ts) — `buildWorktreeAddArgs`, `buildWorktreeRemoveArgs`, `buildBranchDeleteArgs`, `buildHeadBranchArgs`, `buildWorktreeListArgs`, `parseWorktreeList`; ref-validation rejects shell-escape attempts (`../`, spaces)
     - Server wrapper that shells out via `child_process.spawn` and exposes `ensureWorktree`, `cleanupWorktree`, `listWorktrees`, `detectHeadBranch` with an injectable `GitRunner` for tests: [src/lib/workspace/worktree.server.ts](../../src/lib/workspace/worktree.server.ts)
     - `WorkspaceContext` gains `worktree?: { repoPath, baseBranch?, deleteBranchOnCleanup? }`; `resolveWorkspaceRoot` returns `<sandbox>/<userId>/worktrees/<runId>` when worktree+runId present (precedence: persistentKey > worktree > runId > legacy); `ensureWorkspace` dispatches to `ensureWorktree` for that case: [src/lib/workspace/workspace.server.ts](../../src/lib/workspace/workspace.server.ts)
     - `executeTool(call, userId, runId?, { persistentKey?, worktree? })` threads worktree config through AsyncLocalStorage: [src/lib/tools/tools.server.ts](../../src/lib/tools/tools.server.ts)
     - Chat stream + sub-agent read `agent.config.workspace.mode === 'worktree'` (with `repoPath`, `baseBranch`, `deleteBranchOnCleanup`) and pass through: [src/routes/chat/[id]/stream/+server.ts](../../src/routes/chat/[id]/stream/+server.ts), [src/lib/agents/inline-subagent.ts](../../src/lib/agents/inline-subagent.ts)
     - GC core extended: scans `<userId>/worktrees/<runId>` alongside `<userId>/runs/<runId>`, results carry a `kind: 'run' | 'worktree'` discriminator, and a new `removeWorktree(path, runId)` hook deregisters the worktree from its parent repo before the rm fallback runs (errors are surfaced but don't block rm): [src/lib/workspace/gc-core.ts](../../src/lib/workspace/gc-core.ts); production wrapper supplies a real `git worktree remove --force` runner: [src/lib/workspace/gc.server.ts](../../src/lib/workspace/gc.server.ts)
     - Three new read-only tools available only when worktree config is set (auto-fail with a clear message otherwise): `git_status`, `git_log`, `git_diff` (with optional `--staged`, `ref`, `paths`): [src/lib/tools/tools.server.ts](../../src/lib/tools/tools.server.ts), MCP descriptions [src/routes/api/mcp/+server.ts](../../src/routes/api/mcp/+server.ts)
     - 13 tests cover: pure arg-builder shape + ref validation, porcelain parser (incl. detached HEAD), priority order in `resolveWorkspaceRoot`, real git integration (`ensureWorktree` creates + idempotent re-call, `cleanupWorktree` removes registration + branch, `ensureWorkspace` dispatches correctly), GC scanning both layouts and invoking the remove hook, GC error tolerance: [tests/workspace.worktree.spec.ts](../../tests/workspace.worktree.spec.ts)
   - Phase 5 (container isolation) is explicitly out-of-scope per [docs/workspace/plan.md](../workspace/plan.md) ("Behind a flag, run shell tools inside a per-run container … Out of scope for first cut but design with this in mind"). All in-scope phases (1-4) are landed and tested, so #7 is **flipped to `[x]`**.

### Wave 2 — Orchestration Core

8. [ ] Tools progressive disclosure + capability gating
   - Source: ../tools/plan.md
   - Gate: default tool schema slim; `enable_capability` flow works

9. [ ] Skills taxonomy and loading rules (including mode identities)
   - Source: ../skills/plan.md
   - Depends on: #8 for companion-tool guidance
   - Gate: deterministic loading order and provenance visible

10. [ ] Runtime extraction/composition server
    - Source: ../runtime/plan.md
    - Depends on: #8, #9
    - Gate: chat SSE behavior parity; subagent orchestration parity

11. [ ] Task lifecycle alignment with runtime/runs
    - Source: ../tasks/plan.md
    - Depends on: #3, #10
    - Gate: plan→approve→execute transitions durable and replayable

### Wave 3 — Governance and Safety

12. [ ] Governance rules and enforcement points (approvals/denies/audit)
    - Source: ../settings/plan.md
    - Depends on: #8, #11
    - Gate: deny/approve/audit paths enforced server-side

13. [ ] Hook framework and hook execution contracts
    - Source: ../hooks/plan.md
    - Depends on: #9, #10, #12
    - Gate: hook timeout/isolation/failure handling verified

14. [ ] Evaluation framework integration
    - Source: ../evaluations/plan.md
    - Depends on: #3, #10
    - Gate: evaluation runs attach findings to durable records

### Wave 4 — Feature Service Layer

15. [ ] Project artifacts/versioning and linkage
    - Source: ../projects/plan.md
    - Depends on: #11
    - Gate: immutable version history + current pointer integrity

16. [ ] Memory extraction/retrieval + quality benchmark gates
    - Source: ../memory/plan.md
    - Depends on: #10
    - Gate: LongMemEval target achieved; retrieval latency/cost acceptable

17. [ ] Jobs queue/worker reliability and handler manifest
    - Source: ../jobs/plan.md
    - Depends on: #3, #11
    - Gate: retry/backoff/heartbeat/timeout behavior proven

18. [ ] Research loop domain (search→fetch→synthesize)
    - Source: ../research/plan.md
    - Depends on: #8, #17
    - Gate: report quality + source traceability + resumable progress

### Wave 5 — Product Workflow Integration

19. [ ] Source-control workflow (branch, diff, PR)
    - Source: ../source-control/plan.md
    - Depends on: #7, #11, #12
    - Gate: draft PR lifecycle + approval controls verified

20. [ ] Observability and review inbox consolidation
    - Source: ../observability/plan.md
    - Depends on: #12, #17
    - Gate: all human-required actions visible in one inbox

21. [ ] Automations scheduling and trigger framework
    - Source: ../automations/plan.md
    - Depends on: #11, #17, #20
    - Gate: trigger idempotency + failure recovery verified

22. [ ] Agents prompt-source + identity architecture
    - Source: ../agents/plan.md
    - Depends on: #9, #10
    - Gate: prompt edits hot-reload via skills; no hardcoded main-agent identity or agent-kind behavior

---

## Parallel Execution Lanes

Use these lanes for multi-agent execution. A lane can run independently once its dependencies are green.

### Lane A — Foundation/Core

- Wave 0: #1 + #2
- Wave 1: #3 + #7
- Wave 2: #10 + #11

### Lane B — Prompt/Tooling

- Wave 1: #4
- Wave 2: #8 + #9
- Wave 3: #13
- Wave 5: #22

### Lane C — Cost/Governance/Review

- Wave 1: #5 + #6
- Wave 3: #12 + #14
- Wave 5: #20

### Lane D — Async/Feature Services

- Wave 4: #15 + #16 + #17 + #18
- Wave 5: #19 + #21

### Lane E — UX Platform (Cross-Wave)

- Wave 0–5: UX-1
- Feeds: #6 + #15 + #18 + #19 + #20 + #22

---

## Mandatory Gate Checklist (Do Not Skip)

### Gate G0 (after Wave 0)

- [ ] App boots without import errors
  - Evidence: latest diagnostics are clean for changed Wave 0 surfaces: [src/lib/runs/runs.server.ts](../../src/lib/runs/runs.server.ts), [src/lib/runs/runs.schema.ts](../../src/lib/runs/runs.schema.ts), [src/lib/sessions/sessions.schema.ts](../../src/lib/sessions/sessions.schema.ts), [src/routes/api/chat/monitor/+server.ts](../../src/routes/api/chat/monitor/+server.ts), [src/routes/api/agents/monitor/+server.ts](../../src/routes/api/agents/monitor/+server.ts)
  - Evidence: client/server import boundary fixed for llm barrel: [src/lib/llm/index.ts](../../src/lib/llm/index.ts), [src/lib/chat/RecentChats.svelte](../../src/lib/chat/RecentChats.svelte), [src/routes/chat/[id]/+page.svelte](../../src/routes/chat/[id]/+page.svelte)
- [ ] Playwright smoke tests pass
  - Evidence: Wave 0 smoke suite passes: [tests/wave0-smoke.spec.ts](../../tests/wave0-smoke.spec.ts) (2 passed) using [playwright.config.ts](../../playwright.config.ts).
  - Evidence: broader legacy UI-flow tests remain red and need modernization: [tests/chat.spec.ts](../../tests/chat.spec.ts), [tests/agents.spec.ts](../../tests/agents.spec.ts).
- [ ] No route regressions in chat, agents, settings
  - Evidence: route handlers updated and type-checked: [src/routes/api/chat/monitor/+server.ts](../../src/routes/api/chat/monitor/+server.ts), [src/routes/api/agents/monitor/+server.ts](../../src/routes/api/agents/monitor/+server.ts), [src/routes/chat/[id]/stream/+server.ts](../../src/routes/chat/[id]/stream/+server.ts), [src/routes/settings/+page.svelte](../../src/routes/settings/+page.svelte)
- [ ] UI shell contract approved (desktop + mobile IA + action-card standards)
  - Evidence: pending UX-1 implementation and approval artifacts. Reference plan: [docs/ui/plan.md](../ui/plan.md)

### Gate G1 (after Wave 1)

- [ ] Run resume works after restart
- [ ] Context compaction keeps tool-call/result integrity
- [ ] Mode switching persists and injects anchor messages
- [ ] Cost rollups by run/task/agent query correctly

### Gate G2 (after Wave 2)

- [ ] Runtime extraction preserves stream output contract
- [ ] Tool capability gating works with approvals
- [ ] Skills load deterministically by mode + context

### Gate G3 (after Wave 3)

- [ ] Governance denies/approvals are enforced and audited
- [ ] Hook failures cannot crash active runs
- [ ] Evaluations emit durable findings attached to run/task

### Gate G4 (after Wave 4)

- [ ] Jobs survive process restarts with no loss
- [ ] Memory quality benchmark target met
- [ ] Research reports include source trace and reproducible steps

### Gate G5 (release gate)

- [ ] PR workflow + review inbox + automations form one coherent loop
- [ ] Agent identity editing works without code deploy
- [ ] Docs/spec/plan are updated for all touched domains

---

## Agent Handoff Template

Use this when assigning a lane item to an autonomous coding agent.

1. Objective: implement TODO #<id> from docs/structure/implementation-order.md
2. Inputs: linked domain plan + linked domain spec
3. Constraints:
   - preserve existing behavior unless plan explicitly changes it
   - ship tests for changed paths
   - update docs when logic changes
4. Deliverables:
   - code changes
   - migrations (if any)
   - tests
   - brief change log with risks
5. Mandatory closeout:
   - mark TODO `[x]` in this file
   - update the domain plan status to `completed`
   - add completion note (date + PR/commit)
6. Done when: corresponding gate criteria and closeout checklist are satisfied

---

## Known Follow-ups

- Add jobs handler manifest section in jobs plan to remove ambiguity across queue consumers.
- Continue replacing any remaining generic UI Contract boilerplate in non-UX-critical domains.
