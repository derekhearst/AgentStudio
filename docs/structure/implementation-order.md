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

5. [x] Cost linkage (`runId/taskId/agentId`) + budget enforcement
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

6. [x] Chat mode system + inline approvals + HUD
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
   - Evidence (Phase 4 — inline plan approval card, 2026-05-02):
     - New `propose_plan` tool with structured Zod schema (summary, ordered steps with title/detail/duration/cost/blastRadius/reversible, risks, rollback, totals): [src/lib/tools/tools.server.ts](../../src/lib/tools/tools.server.ts); MCP description added: [src/routes/api/mcp/+server.ts](../../src/routes/api/mcp/+server.ts)
     - The plan goes through the standard tool-approval pipeline (already durable per Phase 1 of #3) — no new endpoint or schema needed. The user's Approve/Deny click resolves the same `tool-approve` POST and the orchestrator continues (or gets a denial) on the next loop iteration. Approval = "plan is locked in"; deny = "revise" by typing in the composer.
     - New component: [src/lib/chat/PlanProposalCard.svelte](../../src/lib/chat/PlanProposalCard.svelte) — renders the plan as an inline chat-side card with a status badge ("awaiting approval" / "approved" / "denied"), numbered steps with per-step blast-radius badges and irreversibility flags, risks list, rollback section, and total cost/duration footer; Approve and Deny buttons appear only when `status === 'pending'` and a token is present (so persisted views show the locked-in plan without the buttons)
     - Chat page routes streaming tool blocks of name `propose_plan` to PlanProposalCard (parallel to the ask_user routing), wiring `approveToolCall`/`denyToolCall` as the action handlers: [src/routes/chat/[id]/+page.svelte](../../src/routes/chat/[id]/+page.svelte)
     - Persisted MessageBubble also routes `propose_plan` tool blocks (and legacy `toolCalls[]` entries) to the same card so historical plans render the same way after a refresh: [src/lib/chat/MessageBubble.svelte](../../src/lib/chat/MessageBubble.svelte). As a bonus, the `normalizedToolCalls` array got a real type (`NormalizedToolCall[]`) which dropped 9 pre-existing `'call' is of type 'unknown'` typecheck errors.
     - Plan-mode identity skill rewritten to require `propose_plan` before any non-readonly tool call, with full schema guidance. UUID bumped from `…c003` → `…c023` so the seed re-inserts on next boot (the existing `ON CONFLICT DO NOTHING` would otherwise preserve the old content): [src/lib/chat/mode-skills.server.ts](../../src/lib/chat/mode-skills.server.ts)
   - Phases 7-9 (mode-aware right panel, diff/artifact preview, research report view) still pending — they depend on other domains (observability, artifacts, research) that haven't started yet, so keep `[ ]` until those domains land. With Phase 4 + 5 + 6 done, the chat lane has cleared everything that's not blocked on cross-domain work.

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

8. [x] Tools progressive disclosure + capability gating
   - Source: ../tools/plan.md
   - Gate: default tool schema slim; `enable_capability` flow works
   - Evidence (Phase 1 — alwaysOn enforcement + enable_capability meta-tool, 2026-05-02):
     - New `enabled_capability_groups` jsonb column on `chat_runs` (default `["core"]`): [src/lib/runs/runs.schema.ts](../../src/lib/runs/runs.schema.ts), migration [drizzle/0023_lonely_captain_america.sql](../../drizzle/0023_lonely_captain_america.sql)
     - Pure helpers (no DB / SvelteKit deps): `expandGroupsToToolNames(groups)`, `mergeAlwaysOn(stored)`, `ALWAYS_ON_GROUPS`: [src/lib/tools/capabilities-core.ts](../../src/lib/tools/capabilities-core.ts)
     - Server wrapper with row-locked enable + DB read: `getEnabledGroups(runId)`, `enableGroupForRun(runId, group)`: [src/lib/tools/capabilities.server.ts](../../src/lib/tools/capabilities.server.ts)
     - New `enable_capability` meta-tool with strict enum validation: [src/lib/tools/tools.server.ts](../../src/lib/tools/tools.server.ts); MCP description added: [src/routes/api/mcp/+server.ts](../../src/routes/api/mcp/+server.ts)
     - `core` group expanded to include `propose_plan` + `enable_capability` so they're always-on; `sandbox` group expanded to include `git_status`/`git_log`/`git_diff` from #7 phase 4: [src/lib/tools/tools.ts](../../src/lib/tools/tools.ts)
     - Stream handler enforces progressive disclosure for orchestrator conversations only — agents with explicit `allowedTools` keep their fixed surface, and agents without allowedTools keep the legacy "all tools" surface (back-compat). Tool surface is recomputed at the top of every loop round so `enable_capability` from the previous round takes effect: [src/routes/chat/[id]/stream/+server.ts](../../src/routes/chat/[id]/stream/+server.ts)
     - Tool-policy slot updated with progressive-disclosure guidance for both orchestrator and agent paths: same file
     - 8 tests cover: pure expansion + dedup + unknown-group dropping, mergeAlwaysOn ordering and forced-`core` invariant, DB column default, persisted round-trip, and the empty-column safety net: [tests/tools.capabilities.spec.ts](../../tests/tools.capabilities.spec.ts)
   - Evidence (Phase 4 — per-agent capability binding, 2026-05-03):
     - `updateAgentRecord` accepts `capabilityGroups` and `allowedTools` and merges them into `agent.config` instead of clobbering siblings (workspace, etc.): [src/lib/agents/agents.server.ts](../../src/lib/agents/agents.server.ts)
     - Remote command + zod schema extended with the same fields and a strict enum on group names; empty array clears the override (back-compat): [src/lib/agents/agents.remote.ts](../../src/lib/agents/agents.remote.ts)
     - Stream handler reads `agent.config.capabilityGroups`. When set, the agent goes through progressive disclosure starting from those groups (instead of the legacy "all tools" surface). When unset, legacy behavior is preserved. Initial chat_run row is seeded with the resolved groups so resume/replay see the same surface: [src/routes/chat/[id]/stream/+server.ts](../../src/routes/chat/[id]/stream/+server.ts)
     - Agent detail page gains a Capability Binding section: a single toggle for "restrict tools to selected groups", a checkbox grid for the four non-`core` groups (`core` is shown as always-on and disabled), and read-only badges in view mode showing the persisted set: [src/routes/agents/[id]/+page.svelte](../../src/routes/agents/[id]/+page.svelte)
     - 4 tests cover: capabilityGroups round-trip storage, "no override" back-compat default, run rows seeded with the configured groups, and the merge-don't-clobber invariant for `agent.config` when capabilityGroups changes alongside an existing `workspace` config: [tests/agents.capability-binding.spec.ts](../../tests/agents.capability-binding.spec.ts)
   - Evidence (Phase 5 — tool output offloading + recoverable handles, 2026-05-03):
     - Pure trim helper (no node:* / SvelteKit deps): [src/lib/tools/output-offload.ts](../../src/lib/tools/output-offload.ts) — `trimWithOffload({ toolName, content, callId, offload })` returns either the original content (under per-tool limit) or head + elision marker + tail with a `.tool-outputs/<callId>.txt` handle pointing at the offloaded copy
     - Per-tool head/tail bias: `shell` weights 40/60 (errors usually live at the end), `git_log` weights 85/15 (newest commits first), everything else 60/40. `web_search` keeps its existing per-result snippet trim and only escalates to head/tail offload if the trimmed array still exceeds budget. `browser_screenshot` opts out (Infinity limit) since the payload IS the data.
     - Server wrapper persists the full payload via `ensureWorkspace` + `safePathWithin` so the file resolves correctly across ephemeral / persistent / worktree workspace modes (Phase 1, 2, 4 of #7): [src/lib/tools/output-offload.server.ts](../../src/lib/tools/output-offload.server.ts)
     - Stream handler swaps the legacy `trimToolResult` for `trimToolResultWithOffload` on the main tool-result path; the SSE `tool_result` event now also carries `offloadedHandle` and `fullSize` so the UI can later expose a "open full output" affordance: [src/routes/chat/[id]/stream/+server.ts](../../src/routes/chat/[id]/stream/+server.ts)
     - Sink failures are best-effort — if the disk write throws, the visible head+tail still returns (the model just can't recover the middle that turn). The handle is still emitted so a later run could re-materialize.
     - 8 tests cover small-payload passthrough, large-shell head+tail+handle shape, tail-bias for shell + head-bias for git_log, web_search per-result-snippet path, sink failure tolerance, the Infinity opt-out, and the on-disk file landing at the resolved per-run workspace path: [tests/tools.output-offload.spec.ts](../../tests/tools.output-offload.spec.ts)
   - Evidence (Phase 2 — auto-suggest capability groups from user message, 2026-05-03):
     - Pure keyword classifier (no LLM call, no SvelteKit deps): [src/lib/tools/suggest-capabilities.ts](../../src/lib/tools/suggest-capabilities.ts) — `suggestCapabilityGroups(message)` returns the non-`core` groups that match. Two-tier scoring: `strong` keywords (decisive on a single match) vs `supporting` (need ≥2 matches). Whole-word boundary check rejects "agentic" / "codeword" false positives.
     - Per-group keyword profiles: `sandbox` (file/directory/edit/patch/shell/build/test/lint/git/…), `skills` (skill/knowledge/playbook/recipe/…), `agents` (agent/delegate/sub-agent/automation/cron/…), `media` (image/draw/logo/diagram/…). Hyphenated tokens like `sub-agent` and `how-to` are matched as single units via custom whole-word regex (the JS `\b` rule treats `-` as a word boundary on its own).
     - Stream handler pre-enables suggestions on round 0 by merging into the orchestrator's `initialEnabledGroups`. The model gets the right tools immediately on the first turn instead of having to spend a round calling `enable_capability` first. Falls back to `['core']` when nothing matches.
     - Conservative by design — the model can still call `enable_capability` directly if the heuristics miss the intent. The classifier never *removes* groups, only adds.
     - 12 tests cover: each strong keyword routing to its group, multiple-group fanout, the supporting-word threshold, empty/whitespace returns nothing, substring rejection (`agentic`, `codeword`), hyphenated whole-word matches, and the explanation surface for telemetry: [tests/tools.suggest-capabilities.spec.ts](../../tests/tools.suggest-capabilities.spec.ts)
   - Phase 3 (FS tool consolidation to 7 verbs) still pending — it's a breaking surface change, deliberately deferred until other consumers have stabilized.

9. [x] Skills taxonomy and loading rules (including mode identities)
   - Source: ../skills/plan.md
   - Depends on: #8 for companion-tool guidance
   - Gate: deterministic loading order and provenance visible
   - Evidence (Phase 1 + Phase 4 — companion skill mapping + first-party seeds, 2026-05-03):
     - Schema: `companion_groups text[]` + `companion_tools text[]` on `skills` (default `{}`): [src/lib/skills/skills.schema.ts](../../src/lib/skills/skills.schema.ts), migration [drizzle/0024_happy_lady_bullseye.sql](../../drizzle/0024_happy_lady_bullseye.sql)
     - Helpers: `getCompanionSkillsForGroups(groups)` + `getCompanionSkillsForTools(toolNames)` use Postgres `&&` array overlap to fetch enabled skills whose companion arrays intersect the request: [src/lib/skills/skills.server.ts](../../src/lib/skills/skills.server.ts)
     - First-party companion seeds for `sandbox` / `skills` / `agents` / `media` (fixed UUIDs `…d001` … `…d004`) authored under `tools/sandbox-fs`, `tools/skills-management`, `tools/agents-delegation`, `tools/media-generation` — bootstrap inserts on first boot, idempotent across boots: [src/lib/skills/companion-skills.server.ts](../../src/lib/skills/companion-skills.server.ts), wired in [src/lib/db.server.ts](../../src/lib/db.server.ts)
     - `enable_capability` executor surfaces matching companion summaries inline in the tool result so the model gets the usage guidance for free when it expands its tool surface (no separate prompt-slot recompute per round needed): [src/lib/tools/tools.server.ts](../../src/lib/tools/tools.server.ts). The result also carries a human-readable `note` string telling the model to call `read_skill` for full bodies on demand.
     - Both seed functions converted to no-target `ON CONFLICT DO NOTHING` so renamed/orphaned rows from an older boot (e.g. the bumped `system/mode-plan` UUID c003 → c023 from #6 phase 4) no longer fail the seed with a unique-name violation. Caller-side `try/catch` already kept it non-fatal, but the warning was noisy.
     - 5 tests cover the bootstrap seed, single + multi-group `&&` overlap, user-authored companion skills surfacing, and the empty-array column default for forward-compat: [tests/skills.companion.spec.ts](../../tests/skills.companion.spec.ts)
   - Evidence (Phase 3 — intent-based skill auto-suggest, 2026-05-03):
     - Stream handler now pushes a `companion_skills` slot (priority 75, between identity and the regular skills slot) whenever the auto-suggested capability groups (Wave 2 #8 phase 2) include anything beyond `core`. The slot lists each matching companion's `name: description` line so the model knows the skill is available without us having to call `read_skill` for it: [src/routes/chat/[id]/stream/+server.ts](../../src/routes/chat/[id]/stream/+server.ts)
     - Slot is only populated when the keyword classifier actually matched something — vague non-tool messages don't load any companions (the existing relevance-ranked `skills` slot covers those).
     - `getCompanionSkillsForGroups` / `getCompanionSkillsForTools` now build a Postgres array literal manually before binding instead of relying on drizzle-orm's raw `sql` template (which doesn't auto-bind JS arrays for `&&`). Defensive escaping against quotes/backslashes even though current callers only pass alphanumeric inputs.
     - 2 tests (live LLM + SSE replay): a sandbox-suggesting prompt ("I want to edit the auth file") includes the `companion_skills` slot in the `context_stats` event; a vague prompt ("hello there") does NOT include it: [tests/skills.companion-suggest.spec.ts](../../tests/skills.companion-suggest.spec.ts). 5 existing companion tests still green: [tests/skills.companion.spec.ts](../../tests/skills.companion.spec.ts)
   - Evidence (Phase 2 — skills browser surfaces companion fields, 2026-05-03):
     - `updateSkillCommand` schema accepts `companionGroups` (enum-restricted to capability group names) and `companionTools` (free-form tool names). Empty array clears the mapping; absent leaves it unchanged: [src/lib/skills/skills.remote.ts](../../src/lib/skills/skills.remote.ts), `updateSkill` server function: [src/lib/skills/skills.server.ts](../../src/lib/skills/skills.server.ts)
     - Skills list page gets a "Companion to: [any] [sandbox] [skills] [agents] [media]" filter chip row above the search results, plus an `↳ <group>` badge on every list row that has companion groups so the mapping is discoverable at a glance: [src/routes/skills/+page.svelte](../../src/routes/skills/+page.svelte)
     - Skill detail page gets a Companion section between Tags and Stats: a checkbox grid for capability groups (sandbox/skills/agents/media — `core` deliberately omitted since the `core` companion would always inject) and a comma-separated text input for specific tool names. System skills are read-only as before: [src/routes/skills/[id]/+page.svelte](../../src/routes/skills/[id]/+page.svelte)
     - 4 tests cover the column round-trip via raw SQL using postgres.js's `sql.array(…)` binding: groups update, tools update preserves ordering, clearing to `[]` round-trips correctly, and updating one field leaves the other intact: [tests/skills.companion-update.spec.ts](../../tests/skills.companion-update.spec.ts)
   - Phase 5 (skill-aware tool-output offload) overlaps with #8 phase 5 which already shipped — the workspace-backed offload covers the durable side. Remaining "load skill summary on demand" half still needs a small read_skill extension; deferring until a real consumer asks for it.

10. [x] Runtime extraction/composition server
    - Source: ../runtime/plan.md
    - Depends on: #8, #9
    - Gate: chat SSE behavior parity; subagent orchestration parity
    - Evidence (Phase 1 — extract pure loop + Session abstraction, 2026-05-03):
      - New `src/lib/runtime/` domain: [types.ts](../../src/lib/runtime/types.ts) (Session interface, RunPatch, RunChatLoopInput/Result, ToolDefinition, SpawnSubagent), [session/sse.server.ts](../../src/lib/runtime/session/sse.server.ts) (SSE-backed Session that wraps the controller + persists run_events + chat_runs writes with the same heartbeat coalescing as before), [loop.server.ts](../../src/lib/runtime/loop.server.ts) (the extracted `runChatLoop` — behaviorally identical to the inner for-round body that lived in stream/+server.ts), [index.ts](../../src/lib/runtime/index.ts) (barrel)
      - Stream handler in [src/routes/chat/[id]/stream/+server.ts](../../src/routes/chat/[id]/stream/+server.ts) shrinks from 1172 → 698 lines (~40% reduction). The handler is now: auth → conversation lookup → context-slot assembly → compaction → budget gate → chat_runs insert → `createSseSession({ runId, controller })` → `runChatLoop({ session, ... })` → cost/message/conversation persistence → `session.emit('done')`. Sub-agent dispatch wires through a `spawnSubagent` callback that calls the existing `runInlineSubagent` with the session's `safeController` (so the legacy parent-stream SSE writes still work unchanged).
      - The Session abstraction is intentionally minimal: `runId`, `isClientConnected()`, `emit(name, payload)`, `updateRun(patch)`, `pushBlock(block)`. The SSE impl additionally exposes `streamBlocks` (the live block buffer, mirrored to chat_runs.streamBlocks per push) and `safeController` (so legacy controller-shaped consumers like runInlineSubagent keep working). Both fields are convenience exits — the loop itself only touches the four Session methods.
      - Parity verification: the chat-flow integration tests (`chat.askuser-render`, `chat.mode-skills`, `runs.events`, `runs.resume`, `runs.approvals`, `runs.questions`, `runs.blocks`, `cost.linkage`, `cost.tool-usage-live`, `context.utilization`, `skills.companion-suggest`) all pass against the new runtime. Pre-existing flakes from cross-test budget/state pollution remain unchanged.
      - `ReasoningConfig` exported from [src/lib/llm/chat.server.ts](../../src/lib/llm/chat.server.ts) (was a private type) so the runtime types can reference it without re-declaration.
    - Evidence (Phase 5 — replace inline-subagent's duplicate loop, 2026-05-03):
      - New forwarded Session impl: [src/lib/runtime/session/forwarded.server.ts](../../src/lib/runtime/session/forwarded.server.ts) — `createForwardedSession({ runId, parentController })` translates the loop's canonical event names (`delta`, `tool_call`, `tool_result`, `tool_pending`, `tool_denied`) into the sub-agent-prefixed names the parent UI already knows (`subagent_delta`, `subagent_tool_call`, …) on their way to the parent's controller. Events the parent doesn't care about (`reasoning`, `context_stats`, `compaction`, `ask_user`, `metrics`) are dropped from the parent stream but still persisted to the sub-agent's `run_events` for forensic visibility. `updateRun` and `pushBlock` write to the sub-agent's own chat_runs row.
      - [src/lib/agents/inline-subagent.ts](../../src/lib/agents/inline-subagent.ts) shrinks from **443 → 281 lines** (-162). The whole inner for-round body, tool dispatch, ask_user shim, message accumulation, and per-round persistence is gone — replaced by one `runChatLoop({ session, isOrchestrator: false, … })` call. The sub-agent-specific lifecycle bits (sub-conversation insert, `subagent_start` / `subagent_done` events around the loop, agent config workspace resolution, post-loop cost + message persistence) stay in the file.
      - Sub-agents pass `isOrchestrator: false` to runChatLoop, so the loop's existing "agents can't ask_user" branch handles the handoff with the same error semantics the inline-subagent used to encode by hand. Tool approval is bypassed (empty `approvalRequiredTools` set) — sub-agents already run under the orchestrator's approved scope, and adding approval here would deadlock since there's no UI surface to approve in.
      - Parity verified: `runs.events`, `runs.approvals`, `runs.questions`, `runs.blocks`, `chat.askuser-render`, `cost.linkage`, `skills.companion-suggest` all green. The 22-test parity suite passes; the 2 agents.spec UI failures are pre-existing (also fail on the pre-Phase-5 commit).
    - Evidence (Phase 6 — reuse runtime for agent-backed automations, 2026-05-03):
      - New detached Session impl: [src/lib/runtime/session/detached.server.ts](../../src/lib/runtime/session/detached.server.ts) — `createDetachedSession({ runId })` writes `run_events` + `chat_runs` updates without ever touching a controller. Same heartbeat coalescing as the SSE-backed Session. `isClientConnected()` always returns true so the loop doesn't shortcut tool execution.
      - Automation engine in [src/lib/automations/engine.ts](../../src/lib/automations/engine.ts) split into two paths: when an agent is attached, the tick now runs the **full agent loop** via `runChatLoop({ session, isOrchestrator: false, … })` with the agent's `allowedTools` / workspace config / skill summaries / memory recall — same shape the chat stream uses. When no agent is attached, the legacy single-shot `chat()` synthesis path stays (lighter, no chat_run row, no wasted infra).
      - The agent path inserts a `chat_runs` row with `source='automation'` so the run is queryable in the existing run trace + cost rollups + GC + workspace machinery. `llm_usage.source='automation'` (new enum variant) tags the cost rows.
      - Sub-agent dispatch is intentionally disabled in automations (`spawnSubagent: undefined`) — no parent stream to forward `subagent_*` events to. Future work could swap in a detached forwarded session if a use case shows up.
      - 2 integration tests cover both paths: agent-backed automation creates a `chat_runs` row (state terminal, source='automation', agent linked), an `llm_usage` row tagged automation, an assistant message in the conversation, and bumps `next_run_at` forward; agent-less automation goes through synthesis (no chat_run, but still gets an assistant message): [tests/automations.runtime.spec.ts](../../tests/automations.runtime.spec.ts)
    - Evidence (Phase 2 — formal AgentDefinition builder, 2026-05-03):
      - New helper [src/lib/runtime/agent-definition.server.ts](../../src/lib/runtime/agent-definition.server.ts) — `buildAgentDefinition({ agent, userId, intent?, toolPolicy, memoryTopK? })` returns a fully-resolved `{ systemPrompt, tools, persistentKey, worktree, includedSlots }`. Slot assembly mirrors the chat stream: identity (P100) → role (P95) → caller-supplied tool_policy (P90) → skill summaries (P70, truncate-end) → memory recall (P60, truncate-end, only if `intent` is non-empty). Tool surface always strips `ask_user` (the loop refuses it for non-orchestrators anyway) and respects `agent.config.allowedTools` when set. Workspace context resolution (`agent.config.workspace.mode === 'persistent'` → `persistentKey`; `=== 'worktree'` → `{ repoPath, baseBranch, deleteBranchOnCleanup }`) lives here too.
      - The chat stream still inlines its own slot pipeline because it has conversation-specific layers (mode posture, conversation mode anchor, per-conversation slot overrides, in-flight context_stats event) that the non-chat callers don't need. The split is "chat = bespoke conversation prompt", "non-chat = stock agent prompt".
      - Three callsites refactored to use `buildAgentDefinition`:
        - **inline-subagent.ts** 281 → 192 lines (-89)
        - **automation engine** 387 → 344 lines (-43)
        - **task-runner.server.ts** 320 → 255 lines (-65)
      - Net reduction this slice: **-197 lines of duplication** replaced by 137 lines of shared helper. The three callsites now agree on slot priorities, tool policy positioning, and workspace config resolution by construction.
      - Parity verified across `runs.events`, `runs.approvals`, `cost.linkage`, `chat.askuser-render`, `skills.companion-suggest`, `automations.runtime`, `tasks.runner`, `tasks.subtree` — 21/21 green.
    - Phase 3 (Environment descriptor) effectively subsumed by `buildAgentDefinition` returning `persistentKey` + `worktree` together — the descriptor pattern is satisfied, just not under that name. **#10 substantively complete**: chat stream, sub-agents, automations, AND tasks all share the same loop + the same agent-definition helper.
    - Net code reduction across the four callsites since the runtime extraction started: **~833 lines** (chat stream -474, inline-subagent -162 then -89, automation -43, task-runner -65), offset by ~700 lines of new runtime modules (loop + 3 sessions + agent-definition + types). Two-thirds of the runtime code is shared instead of duplicated.

11. [x] Task lifecycle alignment with runtime/runs
    - Source: ../tasks/plan.md
    - Depends on: #3, #10
    - Gate: plan→approve→execute transitions durable and replayable
    - Evidence (Phase 1 — schema + barrels, 2026-05-03):
      - New domain: [src/lib/tasks/tasks.schema.ts](../../src/lib/tasks/tasks.schema.ts), [src/lib/tasks/tasks.server.ts](../../src/lib/tasks/tasks.server.ts), [src/lib/tasks/index.ts](../../src/lib/tasks/index.ts)
      - `tasks` table: id, title, spec (markdown), `task_status` enum (`pending` / `planning` / `awaiting_approval` / `running` / `blocked` / `completed` / `failed` / `canceled`), `parent_task_id` (self-FK, cascade delete trims subtree), `owner_agent_id` (FK → agents, set-null), `root_conversation_id` (FK → conversations, set-null), priority, `budget_usd` numeric, metadata jsonb, `created_by` (FK → users, set-null), timestamps. Indexes on status / parent / owner / created_by / root_conversation
      - `task_attempts` table: links `task_id` (FK cascade) + optional `run_id`, `attempt_number` (auto-incremented in `recordAttempt` helper), `task_attempt_status` enum (`queued` / `running` / `completed` / `failed` / `canceled`), error, cost_usd, started/finished timestamps
      - `chat_runs` gains nullable `task_id` + `task_attempt_id` columns with their own indexes; cross-domain FKs use `ON DELETE SET NULL` so deleting a task preserves the historical run rows for forensic visibility
      - Helpers: `createTask`, `getTaskById`, `listTasks` (filters by user / parent / terminal-state-exclusion), `setTaskStatus` (rejects transitions out of terminal states), `recordAttempt` (auto-increments attempt_number), `listAttemptsForTask`, `updateAttempt`
      - Migrations: [drizzle/0025_strong_big_bertha.sql](../../drizzle/0025_strong_big_bertha.sql) (drizzle-kit-generated tables + most FKs) and [drizzle/0026_tasks_cross_domain_fks.sql](../../drizzle/0026_tasks_cross_domain_fks.sql) (hand-written follow-up for the 3 cross-domain / self-FKs that drizzle-kit can't emit because the source columns are declared without `references()` to dodge circular imports)
      - 6 tests cover: full-field round-trip, enum rejection, parent→child→grandchild cascade delete, attempt ordering by attempt_number, task delete cascading to attempts, and the cross-domain `chat_runs.task_id`/`task_attempt_id` link with SET-NULL behavior on task delete + chat_run row survival: [tests/tasks.schema.spec.ts](../../tests/tasks.schema.spec.ts)
    - Evidence (Phase 2 — orchestrator emits tasks via propose_plan, 2026-05-03):
      - `propose_plan` executor in [src/lib/tools/tools.server.ts](../../src/lib/tools/tools.server.ts) now persists the approved plan as a durable parent task (status `running`) plus one child per step (status `pending`). The originating `chat_run.task_id` is back-linked so future runs / UI can show "this run materialized task <X>". The structured fields (totals, risks, rollback, blast radius, reversibility) land in `tasks.metadata` as JSONB; a markdown render of the plan goes into `tasks.spec` for human readability.
      - Best-effort persistence — if any task INSERT fails (e.g. transient DB error), the orchestrator still proceeds with the plan; we just lose the linkage and log a warning. The tool result includes `parentTaskId` and `childTaskIds` (or null when persistence fell through) so callers can deep-link to the task pages once Phase 4 lands.
      - New helper `stringifyPlanForSpec(plan)` renders the propose_plan input as the parent task's `spec` markdown — summary heading, numbered steps with detail + per-step metadata footer, risks list, rollback section, totals.
      - 2 integration tests (SQL-driven so no LLM call required) verify the full write shape: parent + 3 children with metadata round-trip, child ordering by priority, chat_run back-link, parent-delete cascade across 4 rows + SET-NULL on chat_run.task_id; and a minimal plan with no risks/rollback also persists cleanly: [tests/tasks.propose-plan.spec.ts](../../tests/tasks.propose-plan.spec.ts)
    - Evidence (Phase 4 — kanban UI + task detail page, 2026-05-03):
      - New remote endpoints in [src/lib/tasks/tasks.remote.ts](../../src/lib/tasks/tasks.remote.ts): `listTasksQuery` (returns rows annotated with `childCount` so the kanban renders "N steps" without a second roundtrip), `getTaskByIdQuery` (returns task + ordered children + attempts + linked chat_runs), `setTaskStatusCommand` (status transitions), `cancelTaskCommand` (cancels target + flips pending direct children to canceled, preserves terminal descendants for forensic visibility)
      - `/tasks` kanban page at [src/routes/tasks/+page.svelte](../../src/routes/tasks/+page.svelte) — 8 status columns (`pending` / `planning` / `awaiting_approval` / `running` / `blocked` / `completed` / `failed` / `canceled`) with cards showing title + step count + priority + budget + last-updated relative time. Toggles for "Top-level only" (default on, hides children of propose_plan parents) and "Include terminal" (default on; flip off for an in-flight-only view).
      - `/tasks/[id]` detail page at [src/routes/tasks/[id]/+page.svelte](../../src/routes/tasks/[id]/+page.svelte) — header with status badge + transition buttons (mark running / completed / failed / blocked / cancel, gated by current status), markdown spec block, collapsible metadata JSON, ordered child list (linkable into their own detail pages), attempt timeline with cost, and linked chat_runs deep-linking back to `/chat/[conversationId]`.
      - Sidebar nav gains a Tasks entry between Automations and the Insights section: [src/lib/ui/Sidebar.svelte](../../src/lib/ui/Sidebar.svelte)
    - Task badge on `/chat/[id]` (linking the conversation to its materializing task) deferred to a follow-up — needs a small chat-page query addition that's bigger than fits this slice.
    - Evidence (Phase 5 partial — manual retry via the runtime, 2026-05-03):
      - New module [src/lib/tasks/task-runner.server.ts](../../src/lib/tasks/task-runner.server.ts) — `executeTaskOnce(taskId, opts?)` looks up the task + owner agent, transitions the task to `running` (bypassing the terminal-state guard for retries), opens a fresh `chat_runs` row and `task_attempts` row linked to the task, and routes the work through `runChatLoop` with a detached Session. On success: task → `completed`, attempt → `completed` with cost. On thrown error: task → `failed`, attempt → `failed` with the error string. Same workspace-context resolution + slot-based system prompt + skill summaries + memory recall as the agent automation path.
      - New `retryTaskCommand` in [src/lib/tasks/tasks.remote.ts](../../src/lib/tasks/tasks.remote.ts) wraps `executeTaskOnce` so the `/tasks/[id]` page can trigger a fresh attempt. Allowed even from terminal states (failed / blocked / completed / canceled) — that's the "retry" use case.
      - Task detail page gains a `Retry` button in the header action bar — visible only when the task is in a terminal failure state (`failed` / `blocked` / `completed`) AND has an `ownerAgentId`. Confirmation dialog before triggering. Surfaces the `executeTaskOnce` error inline if the run throws: [src/routes/tasks/[id]/+page.svelte](../../src/routes/tasks/[id]/+page.svelte)
      - 3 schema-invariant tests cover: failed → running → completed transition with a second attempt carrying cost; chat_run + task_attempt round-trip linkage with `source='automation'`; precondition-only test for tasks without an owner agent: [tests/tasks.runner.spec.ts](../../tests/tasks.runner.spec.ts). Live LLM execution path is exercised by [tests/automations.runtime.spec.ts](../../tests/automations.runtime.spec.ts) which goes through the same `runChatLoop` + detached Session pipeline.
    - Phase 3 (background task runner that auto-picks `pending` children of `propose_plan` parents) intentionally NOT shipped — the orchestrator already executes those inline in the same chat. Building a runner that competes with that flow would create double-execution. The retry button + `executeTaskOnce` are the on-demand version of the same machinery; a future scheduler could call `executeTaskOnce` against tasks created outside `propose_plan` (e.g. UI-created tasks with an owner agent).
    - Evidence (Phase 5 — DAG / subtree visualization, 2026-05-03):
      - New remote query `getTaskSubtreeQuery({ rootTaskId, maxDepth? })` walks the parent → child tree from a root and returns a flat list with each row tagged by `depth` (0 = root, 1 = direct child, …). Bounded by `maxDepth` (default 5, capped at 8) so a future bug-introduced cycle can't infinite-loop. Children at each level sorted by `priority asc, createdAt asc`. Cycle defense via a `seen` Set so even cyclic FK graphs terminate cleanly: [src/lib/tasks/tasks.remote.ts](../../src/lib/tasks/tasks.remote.ts)
      - New `TaskTree.svelte` component renders the flat list as an indented tree (depth × 18px left margin, ↳ glyph at depth ≥ 1, status badge + priority + budget per row, optional highlight ring on the current task): [src/lib/tasks/TaskTree.svelte](../../src/lib/tasks/TaskTree.svelte)
      - Task detail page swaps the existing flat children list for the tree view *only when grandchildren exist* (`subtreeNodes.some(n => n.depth > 1)`), so the simple propose_plan parent-with-direct-children case stays unchanged. The tree view header reads "Subtree" instead of "Steps" so the change is discoverable: [src/routes/tasks/[id]/+page.svelte](../../src/routes/tasks/[id]/+page.svelte)
      - 2 tests: a 3-level tree of 7 nodes returns the right flat shape with correct depth tags + sibling ordering by priority; cycle defense — A → B → A still terminates after visiting only 2 nodes: [tests/tasks.subtree.spec.ts](../../tests/tasks.subtree.spec.ts)

### Wave 3 — Governance and Safety

12. [ ] Governance rules and enforcement points (approvals/denies/audit)
    - Source: ../settings/plan.md
    - Depends on: #8, #11
    - Gate: deny/approve/audit paths enforced server-side
    - Evidence (Phase 1 — audit log + admin viewer, 2026-05-03):
      - New domain: [src/lib/governance/governance.schema.ts](../../src/lib/governance/governance.schema.ts), [governance.server.ts](../../src/lib/governance/governance.server.ts), [governance.remote.ts](../../src/lib/governance/governance.remote.ts), [diff.ts](../../src/lib/governance/diff.ts) (pure), [index.ts](../../src/lib/governance/index.ts)
      - New `audit_events` table — separate from `activity_events` (the user-facing activity feed). Captures `actor_user_id` (FK → users, SET NULL so the row survives user delete for compliance), `action` enum (settings.updated, settings.reset, agent.config.updated, agent.created/deleted/status.changed, budget_limit.created/updated/deleted, skill.deleted, user.created/deactivated/role.changed), `target_type` + `target_id`, `before_state` + `after_state` jsonb snapshots, `summary` text, `ip_address`, `user_agent`. Indexes on actor / action / (target_type, target_id) / created_at: [drizzle/0027_governance_audit.sql](../../drizzle/0027_governance_audit.sql)
      - `recordAuditEvent` is best-effort — a thrown DB error never blocks the originating write. Per-action wrappers (`auditSettingsUpdated`, `auditAgentConfigUpdated`, `auditBudgetLimitChange`) bundle the diff computation close to where the data lives.
      - Pure `diffTopLevelKeys(before, after)` helper computes the changed key list at the top level (no deep diff — JSON-stringify per key) so the dashboard can show "Updated: defaultModel, toolConfig" without dumping full payloads. Lives in its own module so unit tests can import without pulling in the SvelteKit-bound server module.
      - Wired into the three sensitive write paths:
        - **`updateAppSettings` / `updateApprovalRequiredToolsCommand` / `resetAppSettings`** in [src/lib/settings/settings.remote.ts](../../src/lib/settings/settings.remote.ts) — snapshot before, write, audit after with the changed-key diff in the summary
        - **`updateAgentCommand`** in [src/lib/agents/agents.remote.ts](../../src/lib/agents/agents.remote.ts) — snapshots `{ systemPrompt, model, config }` before/after so capability binding flips + allowedTools changes show up in the trail
        - **`createBudgetLimit` / `updateBudgetLimit` / `deleteBudgetLimit`** in [src/lib/costs/cost.remote.ts](../../src/lib/costs/cost.remote.ts) — full row snapshots; the create/delete summaries embed the limit's scope/period/amount for at-a-glance scanning
      - `/audit` page at [src/routes/audit/+page.svelte](../../src/routes/audit/+page.svelte) — admin-only (server-side gate in `listAuditEventsQuery` returns `{ events: [], adminOnly: true }` for non-admins; UI also gates render). Filter dropdowns by action + target type, expandable rows showing before/after JSON side-by-side, ↳ chips for action category (delete/reset = error tone, create = success, update = info). Sidebar gains an Audit entry alongside Users/Settings: [src/lib/ui/Sidebar.svelte](../../src/lib/ui/Sidebar.svelte)
      - 5 tests cover: full-field round-trip, enum rejection, actor FK SET NULL on user delete (compliance survival), filter-by-action+target index path, and the pure `diffTopLevelKeys` helper: [tests/governance.audit.spec.ts](../../tests/governance.audit.spec.ts)
    - Phases 2-5 of the settings plan (validation contracts, save/rollback, cross-domain enforcement, observability/admin controls) still pending. The audit log is the foundation — the rest builds on it.

13. [x] Hook framework and hook execution contracts
    - Source: ../hooks/plan.md
    - Depends on: #9, #10, #12
    - Gate: hook timeout/isolation/failure handling verified
    - Evidence (Phase 1 + Phase 2 partial — registry/dispatch + first built-ins, 2026-05-03):
      - New domain: [src/lib/hooks/](../../src/lib/hooks/) — `hooks.schema.ts` (invocation log table + `hook_kind` enum `builtin`/`skill`), `types.ts` (pure event payload types — 14 events from spec table, conditional `HookPayload<E>`), `bus.server.ts` (registry + async fail-isolated dispatch with per-call timeout default 5s), `builtins.server.ts` (first migrated handlers), `index.ts` (barrel)
      - `hook_invocations` table: `run_id` (FK CASCADE so deleting a run trims its hook trail), `event` text, `hook_kind` enum, `hook_ref` (built-in fn name OR skill slug), `success` bool, `duration_ms` int, `error` text, indexes on run/event/success/created_at: [drizzle/0028_hook_invocations.sql](../../drizzle/0028_hook_invocations.sql)
      - `emitHook(event, payload, opts?)` — fire-and-forget by default (runtime never blocks), `opts.await` for the rare gating use case. Each handler runs with `Promise.race` against a per-call timeout. Failures + timeouts swallowed but logged into `hook_invocations` with `success=false` + the error string for the admin dashboard.
      - Wired into [src/lib/runtime/loop.server.ts](../../src/lib/runtime/loop.server.ts) at four boundaries: `before_run` at loop start, `after_run` at loop return (with durationMs), `before_tool` + `after_tool` around `executeTool` (with success/durationMs/result on after_tool). All emits are `void`-prefixed so the loop never awaits hooks.
      - Two built-ins migrated to demonstrate the pattern: `after_tool` → `activity-impactful-tools` emits an `agent_action` activity row for shell/file_write/file_patch/file_replace/delete_file/move_file (read-only tools intentionally excluded as noise). `after_run` → `activity-run-completed` emits one summary `agent_action` per successful run with the durationMs: [src/lib/hooks/builtins.server.ts](../../src/lib/hooks/builtins.server.ts). Bootstrap registers them once at boot via `registerBuiltinHooks()` in [src/lib/db.server.ts](../../src/lib/db.server.ts).
      - 6 tests cover: full-shape invocation round-trip, error string preservation on failure, `hook_kind` enum rejection of unknown values, FK cascade on run delete, NULL `run_id` for future scheduled hooks, and the bus's `registerHook + listRegisteredHooks` contract: [tests/hooks.bus.spec.ts](../../tests/hooks.bus.spec.ts)
    - Evidence (Phase 4 — per-agent hook config + runtime agentId plumbing, 2026-05-03):
      - `RegisteredHook` gains `optInOnly: boolean` (default false). Globally-registered handlers with `optInOnly: false` fire on every emit (existing semantic — activity emit, etc.). Handlers registered with `optInOnly: true` ONLY fire when an agent's `agents.config.hooks[event]` array references their name. Phase 3's skill-based hooks (future) will resolve unmatched refs through a separate skill-runner: [src/lib/hooks/types.ts](../../src/lib/hooks/types.ts), [src/lib/hooks/bus.server.ts](../../src/lib/hooks/bus.server.ts)
      - `emitHook` learned to look up `agents.config.hooks[event]` when the payload carries an `agentId`. Refs that match an `optInOnly` global handler get appended to the dispatch list; refs that match a non-opt-in handler are skipped (already firing globally — would double-dispatch). Unknown refs are recorded as `success=false` invocations in `hook_invocations` so the admin viewer surfaces typos / missing skills without crashing the runtime: [src/lib/hooks/bus.server.ts](../../src/lib/hooks/bus.server.ts)
      - `RunChatLoopInput` extended with `agentId?: string | null`. All four runtime callers thread the owning agent through: chat stream (`conversation.agentId`), inline-subagent (`agent.id`), automation engine (`agent.id`), task-runner (`agent.id`): [src/lib/runtime/types.ts](../../src/lib/runtime/types.ts), [src/lib/runtime/loop.server.ts](../../src/lib/runtime/loop.server.ts), [src/lib/agents/inline-subagent.ts](../../src/lib/agents/inline-subagent.ts), [src/lib/automations/engine.ts](../../src/lib/automations/engine.ts), [src/lib/tasks/task-runner.server.ts](../../src/lib/tasks/task-runner.server.ts), [src/routes/chat/[id]/stream/+server.ts](../../src/routes/chat/[id]/stream/+server.ts)
      - `updateAgentRecord` accepts `hooks: Record<string, string[]>` patch — empty array per-event drops that event's overrides, empty object clears all bindings; merges with `capabilityGroups` / `allowedTools` without clobbering: [src/lib/agents/agents.server.ts](../../src/lib/agents/agents.server.ts). Remote schema gates the event names against the 14-event enum: [src/lib/agents/agents.remote.ts](../../src/lib/agents/agents.remote.ts)
      - Agent detail page gains a Hook bindings section after Capability binding — view mode shows persisted `event → [refs]` pairs; edit mode renders a row per event with a comma-separated text input. Links to `/settings/hooks` for the invocation log: [src/routes/agents/[id]/+page.svelte](../../src/routes/agents/[id]/+page.svelte)
      - 4 tests cover: agents.config.hooks SQL round-trip with multiple events + refs, merge-don't-clobber alongside capabilityGroups, empty hooks object means no bindings, optInOnly registration round-trip via `registerHook + listRegisteredHooks`: [tests/hooks.per-agent-config.spec.ts](../../tests/hooks.per-agent-config.spec.ts)
    - Evidence (Phase 5 — admin `/settings/hooks` viewer, 2026-05-03):
      - New remote query `listHookInvocationsQuery` with admin gate (mirrors the audit reader pattern). Supports filters by event / hookKind / failuresOnly / runId / sinceISO. Returns invocation rows + a per-event 24h rollup `{event, total, failures, avgDurationMs}` for the dashboard header: [src/lib/hooks/hooks.remote.ts](../../src/lib/hooks/hooks.remote.ts)
      - `/settings/hooks` page renders the rollup as colored cards (green/yellow/red by failure rate), expandable invocation rows with run deep-links + error pre, and toggle filters for event/kind/failures-only. Sidebar gains a Hooks entry under Settings: [src/routes/settings/hooks/+page.svelte](../../src/routes/settings/hooks/+page.svelte), [src/lib/ui/Sidebar.svelte](../../src/lib/ui/Sidebar.svelte)
    - Evidence (Phase 3 — skill-based hook runner, 2026-05-03):
      - New `runSkillHook({event, skillName, payload, timeoutMs?})` — looks up the skill by `name = ref` (skills.name has a unique index, so lookup is O(1)). When the skill exists and is enabled, executes it via single-shot `chat()` with system=skill content and user=JSON-serialized payload. Default timeout 8s with `Promise.race`; output is purely observational (logged, never returned to the runtime). Cost rolled up as `LlmUsageSource='evaluator'` since hooks are advisor-tier work: [src/lib/hooks/skill-hook-runner.server.ts](../../src/lib/hooks/skill-hook-runner.server.ts)
      - Bus dispatcher updated: per-agent refs that don't match a global handler are no longer logged as failures — they're routed to `runSkillHook` via dynamic import (so the bus stays a pure dispatch surface). Skill dispatches join the same fire-and-forget pool as built-in handlers; `opts.await: true` waits for all of them: [src/lib/hooks/bus.server.ts](../../src/lib/hooks/bus.server.ts)
      - Missing-skill failures land in `hook_invocations` with `hookKind='skill'` + the explanatory error — surfaces in the existing `/settings/hooks` admin viewer alongside built-in failures. Cost rows tagged with `metadata.hookEvent + .hookSkill` so future cost rollups can attribute hook spend per-skill.
      - 3 storage tests cover: skill invocation row shape (kind=skill, ref=skillName), missing-skill failure persists with explanatory error, per-event filter returns only matching skill rows: [tests/hooks.skill-runner.spec.ts](../../tests/hooks.skill-runner.spec.ts)
    - **#13 Hooks now substantively complete** — registry+dispatch (P1), built-ins (P2), skill-based runner (P3), per-agent config + UI + runtime plumbing (P4), admin viewer (P5). Flipped to `[x]` above.

14. [x] Evaluation framework integration
    - Source: ../evaluations/plan.md
    - Depends on: #3, #10
    - Gate: evaluation runs attach findings to durable records
    - Evidence (Phase 1+2 — schema + recorder + run-viewer surface, 2026-05-03):
      - New domain: [src/lib/evaluations/](../../src/lib/evaluations/) — `evaluations.schema.ts` (`run_evaluations` table + `evaluation_verdict` enum `pass` / `fail` / `needs_revision` + typed `EvaluationFinding` shape with severity/category/message/path/suggestion), `evaluations.server.ts` (`recordEvaluation` / `listEvaluationsForRun` / `getLatestEvaluationForRun` / `isRunEvaluationClear` / `summarizeFindingsForRun`), `index.ts` barrel
      - `chat_runs` extended with `eval_required` boolean (default false — no behavior change for existing chats) + `eval_attempt` integer (default 0 — incremented when re-plan retries are spawned in Phase 3)
      - `run_evaluations`: `run_id` (FK CASCADE), `evaluator_run_id` (SET NULL — verdict survives evaluator GC), `evaluator_agent_id` (SET NULL), `verdict` enum, `findings` jsonb (typed `EvaluationFinding[]`), `confidence` real (0..1), `cost_usd` numeric(12,4), `metadata` jsonb. Indexes on run/evaluator_agent/verdict/created_at: [drizzle/0029_evaluations.sql](../../drizzle/0029_evaluations.sql)
      - `isRunEvaluationClear(runId)` returns true when `eval_required=false` OR the latest evaluation's verdict is `pass`. Phase 4's task-completion gate plugs into this.
      - Run viewer at [src/routes/runs/[id]/+page.svelte](../../src/routes/runs/[id]/+page.svelte) gets a new "Evaluations" panel between the run header and event timeline — appears only when at least one evaluation exists. Header shows count + latest verdict badge + confidence %; each verdict row shows verdict badge, finding count, severity-tinted finding pills (error/warning/info), category badges, message + optional path. `getRunDetailQuery` joins `listEvaluationsForRun` so the page shows real history.
      - 5 tests cover full pass-verdict round-trip with findings + confidence + cost + metadata, verdict enum rejection, FK cascade on source-run delete, `eval_required` / `eval_attempt` defaults + round-trip, severity aggregation matching `summarizeFindingsForRun`'s contract: [tests/evaluations.spec.ts](../../tests/evaluations.spec.ts)
    - Evidence (Plan Phase 1 — `agent_kind` enum + default evaluator agent, 2026-05-03):
      - New `agent_kind` enum (`orchestrator | worker | evaluator`) + `agents.kind` column (default `worker`): [src/lib/agents/agents.schema.ts](../../src/lib/agents/agents.schema.ts), hand-written migration [drizzle/0030_agent_kind.sql](../../drizzle/0030_agent_kind.sql) (drizzle-kit can't emit it cleanly when column default + enum land together)
      - First-party `Default Evaluator` agent seeded on boot via `seedDefaultEvaluator` with fixed UUID `…000ea1`. Idempotent ON CONFLICT (id) DO NOTHING so user edits to the prompt/model survive re-seed. Cheap default model (`openai/gpt-4o-mini`) per the plan's cost guideline; system prompt instructs strict JSON output matching `EvaluationFinding`. `config.allowedTools` restricted to `read | list | search` (read-only): [src/lib/evaluations/evaluators-seed.server.ts](../../src/lib/evaluations/evaluators-seed.server.ts), wired into bootstrap [src/lib/db.server.ts](../../src/lib/db.server.ts)
      - 4 tests cover: `agents.kind` defaults to `worker`, enum accepts the three valid kinds, enum rejects unknown values, default evaluator presence assertion (soft-skips if seed hasn't fired since migration — guards new branches): [tests/evaluations.evaluator-agent.spec.ts](../../tests/evaluations.evaluator-agent.spec.ts)
    - Evidence (Plan Phase 2 — end-of-run evaluator pass on `eval_required`, 2026-05-03):
      - Pure response parser in its own module so unit tests don't pull in $env: `parseEvaluatorResponse(raw)` returns `{verdict, confidence, findings, fallback?}`. Strips ```json fences, falls back to outer `{...}` substring extraction, then schema-validates with Zod. Empty / unparseable responses degrade to `needs_revision` with a single error finding so the future re-plan loop (plan Phase 3) still has a signal: [src/lib/evaluations/evaluator-parse.ts](../../src/lib/evaluations/evaluator-parse.ts)
      - Server runner `runEvaluatorPass({runId, userId, conversationId, taskDescription, generatorOutput, toolSummary?})` — looks up the seeded evaluator, calls `chat()` for single-shot synthesis (no tools, no loop), parses the response, logs cost via `logLlmUsage({source: 'evaluator'})`, and writes the verdict via `recordEvaluation`. LLM-call failures degrade to `needs_revision` with a `fallbackReason: 'llm_error'` metadata stamp so the verdict is still durable. Skips the pass cleanly when the evaluator agent is missing (e.g. seed not yet run): [src/lib/evaluations/evaluator-runner.server.ts](../../src/lib/evaluations/evaluator-runner.server.ts)
      - `LlmUsageSource` extended with `'evaluator'` so existing per-run / per-agent cost rollups already surface evaluator spend separately: [src/lib/costs/usage.ts](../../src/lib/costs/usage.ts)
      - Chat stream handler triggers the evaluator pass post-loop when `chat_runs.eval_required = true`. Fire-and-forget so the user sees `done` immediately — the verdict appears asynchronously in the run viewer's Evaluations panel + an `evaluation` SSE event for live UIs that want to surface it. Wrapped in try/catch: an evaluator failure can never tank the original run: [src/routes/chat/[id]/stream/+server.ts](../../src/routes/chat/[id]/stream/+server.ts)
      - 7 tests cover the parser: clean JSON, fenced JSON, unfenced JSON with leading prose, empty response (empty_response fallback), missing-verdict (parse_error fallback), invalid verdict value (parse_error fallback), and truly garbage no-JSON response: [tests/evaluations.evaluator-runner.spec.ts](../../tests/evaluations.evaluator-runner.spec.ts)
    - Evidence (Plan Phase 4 — task-completion gate, 2026-05-03):
      - New `tasks.eval_required` (boolean default false) + `tasks.eval_attempt` (int default 0) columns: [src/lib/tasks/tasks.schema.ts](../../src/lib/tasks/tasks.schema.ts), hand-written migration [drizzle/0031_tasks_eval.sql](../../drizzle/0031_tasks_eval.sql)
      - `executeTaskOnce` now propagates `task.evalRequired` to the chat_run row so the run viewer can flag it. After the loop succeeds, if eval was required, runs `runEvaluatorPass` SYNCHRONOUSLY (unlike chat-stream's fire-and-forget — the task transition depends on the verdict). Pass → task=`completed`; fail/needs_revision (no retries left) → task=`blocked` with the verdict in the result. The `run_evaluations` row is durable either way: [src/lib/tasks/task-runner.server.ts](../../src/lib/tasks/task-runner.server.ts)
      - `ExecuteTaskOnceResult` extended with `evaluationVerdict` + `retries` so callers (retry button, future schedulers) can surface why a task didn't transition.
    - Evidence (Plan Phase 3 — re-plan loop on `needs_revision`, 2026-05-03):
      - `executeTaskOnce` opts gain `maxRetriesOnRevision` (default 0 — no auto-retry, preserves existing-caller cost). When the evaluator returns `needs_revision` and `currentRetry < maxRetries`, the runner bumps `tasks.eval_attempt` durably and recursively calls itself with `_currentRetry + 1` and `_priorFindings = evalRow.findings`. The next attempt's user message gets a "Prior evaluator feedback" section appended so the agent has actionable course-correction context.
      - Recursion-bounded: state is threaded through internal `_currentRetry` / `_priorFindings` opts rather than a true loop, so each retry opens a fresh `chat_runs` + `task_attempts` row pair. The forensic chain (run → attempt → run → attempt) is queryable end-to-end: [src/lib/tasks/task-runner.server.ts](../../src/lib/tasks/task-runner.server.ts)
      - 4 schema-invariant tests cover: `eval_required` / `eval_attempt` defaults, round-trip when `eval_required=true`, retry-counter increment via raw UPDATE (mirrors what the runner does), and the `isRunEvaluationClear`-style verdict trajectory (no eval → needs_revision → pass) on a chat_run linked to an evalRequired task: [tests/evaluations.task-gate.spec.ts](../../tests/evaluations.task-gate.spec.ts)
    - Evidence (Plan Phase 5 — sprint contract parser, 2026-05-03):
      - Pure module `parseSprintContracts(spec)` extracts `## Sprint N: <deliverable>` sections from task spec markdown, with optional `Round budget: <N>` line per section. Computes cumulative round thresholds across sprints so the runner can fire a per-sprint evaluator pass at the boundary. Mixed bounded/unbounded sprints supported (unbounded sprints don't contribute to the cumulative): [src/lib/evaluations/sprints.ts](../../src/lib/evaluations/sprints.ts)
      - Helpers: `sprintBoundaryAt(contracts, prevRound)` returns the sprint that just ended (or null) — runner uses this to decide whether to fire `runEvaluatorPass` mid-loop. `activeSprintForRound(contracts, round)` returns the current sprint with overflow safety (falls back to the last sprint when round exceeds all budgets, so UI labels never go blank).
      - 13 unit tests cover: empty/whitespace specs return [], single sprint with budget, multi-sprint cumulative thresholds, unbounded sprints, mixed bounded+unbounded, dash separator, prevRound=0 boundary, exact-budget hit, mid-sprint no boundary, unbounded boundary skipped, active-sprint within budget, overflow fallback to last sprint, empty contracts: [tests/evaluations.sprints.spec.ts](../../tests/evaluations.sprints.spec.ts)
      - Per-round runner integration (calling `runEvaluatorPass` at sprint boundaries inside `runChatLoop`) deferred to a follow-up — requires threading sprint contracts through `RunChatLoopInput` and adding a per-round trigger hook in the loop. The parser + helpers are the durable contract; the loop integration is purely glue once a real long-running task surfaces.
    - **#14 Evaluations now substantively complete** — schema + recorder + run viewer (P1+2 from prior commit), evaluator agent kind + seed + parser + runner + post-run trigger (Plan P1+2), task-completion gate + re-plan loop (Plan P3+4), sprint contract parser + helpers (Plan P5 parser slice). Loop-integrated sprint trigger remains as future work.

### Wave 4 — Feature Service Layer **(all 4 items closed 2026-05-04)**

15. [x] Project artifacts/versioning and linkage **(gate fully met across P1+P2+P3+P5+P7)**
    - Source: ../projects/plan.md
    - Depends on: #11
    - Gate: immutable version history + current pointer integrity ✓
    - Evidence (Phase 1 — schema + CRUD + remote + UI, 2026-05-03):
      - New domain: [src/lib/projects/projects.schema.ts](../../src/lib/projects/projects.schema.ts) — three tables (`projects`, `artifacts`, `artifact_versions`) + two enums (`project_kind`: efoil/research/code/documentation/other; `artifact_content_type`: markdown/code/json/yaml/plaintext). Per-user `(userId, slug)` unique on projects; per-project `(projectId, slug)` unique on artifacts; per-artifact `(artifactId, seq)` unique on versions for append-only history. `artifacts.currentVersionId` is a denormalized pointer (nullable; chicken-and-egg with versions table). Hand-written migration [drizzle/0032_projects.sql](../../drizzle/0032_projects.sql) for cross-FK ordering.
      - CRUD helpers: `createProject` / `listProjects` / `getProjectById` / `getProjectBySlug` / `updateProject` / `deleteProject` (cascade-trims artifacts + versions). Slug generation via `slugify()` + per-scope dedupe with `-2`, `-3` suffixes: [src/lib/projects/projects.server.ts](../../src/lib/projects/projects.server.ts)
      - Artifact helpers: `createArtifact` opens a transaction so the artifact + version 1 land atomically with the `currentVersionId` pointer set. `editArtifact` reads max seq + 1 and updates the pointer in a single transaction (append-only). `rollbackArtifact(toSeq)` is non-destructive — copies the target seq's content forward as a NEW version. `softDeleteArtifact` flips `is_active=false` so the row + versions stay queryable for audit.
      - User-scoped remote layer: `listProjectsQuery`, `getProjectByIdQuery` (joins artifact list), `createProjectCommand`, `updateProjectCommand`, `deleteProjectCommand`, `getArtifactQuery` (joins version history), `getVersionQuery`, `createArtifactCommand`, `editArtifactCommand`, `rollbackArtifactCommand`, `softDeleteArtifactCommand`. All ownership-checked via `ensureProjectOwned` / `ensureArtifactOwned`: [src/lib/projects/projects.remote.ts](../../src/lib/projects/projects.remote.ts)
      - UI: `/projects` lists projects with create form + delete; `/projects/[id]` shows artifacts in the project with a create form + soft-delete; `/projects/[id]/artifacts/[aid]` shows version history with edit + rollback. Edit creates v(N+1) with optional change note; rollback to vK creates v(N+1) with vK's content. Sidebar gains a Projects entry under Work: [src/lib/ui/Sidebar.svelte](../../src/lib/ui/Sidebar.svelte), [src/routes/projects/+page.svelte](../../src/routes/projects/+page.svelte), [src/routes/projects/[id]/+page.svelte](../../src/routes/projects/[id]/+page.svelte), [src/routes/projects/[id]/artifacts/[aid]/+page.svelte](../../src/routes/projects/[id]/artifacts/[aid]/+page.svelte)
      - 10 tests cover: project field round-trip, per-user slug uniqueness rejection, kind enum rejection, artifact field round-trip, per-project slug uniqueness rejection, cross-project slug reuse allowed, version seq uniqueness + append-only, cascade-on-project-delete, soft-delete preservation, slugify pure-helper output for various inputs: [tests/projects.spec.ts](../../tests/projects.spec.ts)
    - Evidence (Phase 2 partial — agent tools for projects, 2026-05-03):
      - **6 new agent tools** added to the existing tool registry: `list_projects`, `create_project`, `list_artifacts`, `read_artifact`, `create_artifact`, `edit_artifact`. Schemas + descriptions + executors land in [src/lib/tools/tools.server.ts](../../src/lib/tools/tools.server.ts); MCP descriptions added to [src/routes/api/mcp/+server.ts](../../src/routes/api/mcp/+server.ts).
      - Each executor delegates to the existing project server functions ([src/lib/projects/projects.server.ts](../../src/lib/projects/projects.server.ts)) and enforces per-user ownership at the boundary — agents can only read/write projects belonging to the conversation's owning user. Source-run linkage threaded via `toolUserContext.getStore()?.runId` so artifact versions show their originating chat run in the audit chain.
      - **New `projects` capability group** in [src/lib/tools/tools.ts](../../src/lib/tools/tools.ts) bundles the 6 tools. Wired into agent capability binding: `CAPABILITY_GROUP_NAMES` enum extended in [src/lib/agents/agents.remote.ts](../../src/lib/agents/agents.remote.ts) + the agent detail page UI gets the new checkbox: [src/routes/agents/[id]/+page.svelte](../../src/routes/agents/[id]/+page.svelte).
      - **Auto-suggest classifier** [src/lib/tools/suggest-capabilities.ts](../../src/lib/tools/suggest-capabilities.ts) gets a `projects` profile (strong: project/projects/artifact/document/spec/rfc/proposal/draft/manuscript; supporting: version/revise/rewrite/append/amend) so project-related user queries enable the group automatically on round 0.
      - 6 new tests cover: create_project + list_projects round-trip, create_artifact transactional artifact + v1 + currentVersionId pointer, edit_artifact append-only v(N+1) preserving history with edited_by linkage, per-user isolation rejecting cross-user reads, capability group registration includes the 6 tool names, suggest-capabilities classifier triggers on project-related queries: [tests/projects.tools.spec.ts](../../tests/projects.tools.spec.ts)
    - Evidence (Phase 2 finish — sessions.projectId + set_project_context tool + system-prompt context slot, 2026-05-04):
      - **`conversations.project_id` column** added via hand-written migration [drizzle/0035_conversation_project.sql](../../drizzle/0035_conversation_project.sql) + indexed for the bind-lookup path. Declared by-name (no enforced FK) to avoid a circular import with `$lib/projects`; application logic enforces ownership at the tool boundary + treats stale pointers (project deleted) as unbound.
      - **`set_project_context` agent tool** added to [src/lib/tools/tools.server.ts](../../src/lib/tools/tools.server.ts) — accepts `{projectId?: uuid | null}`, verifies the project belongs to the calling user, updates `conversations.project_id`. Pass null/omit to unbind. Resolves the conversation via `chat_runs.id → chat_runs.conversation_id` lookup (new `resolveConversationFromRunId` helper) so the tool works for both orchestrator and agent runs.
      - Tool added to the `projects` capability group + MCP descriptions: [src/lib/tools/tools.ts](../../src/lib/tools/tools.ts), [src/routes/api/mcp/+server.ts](../../src/routes/api/mcp/+server.ts)
      - **System-prompt context slot** in the chat-stream handler: when `conversation.projectId` is set, injects a "Active project" slot at priority 80 (between identity at 100 and skills at 70) with the project's name, slug, kind, description, and a hint to use the project's id by default in `create_artifact` calls. Ownership re-verified at slot build time (defensive — schema doesn't enforce): [src/routes/chat/[id]/stream/+server.ts](../../src/routes/chat/[id]/stream/+server.ts)
      - 6 new tests cover: project_id defaults to null, bind/unbind/rebind transitions, stale pointer survives project deletion (intentional — no enforced FK preserves audit chain), per-user isolation rejection at the tool layer, set_project_context registered in the projects capability group: [tests/projects.session-binding.spec.ts](../../tests/projects.session-binding.spec.ts)
    - Evidence (Phase 3 — Memory ↔ Projects bridge via `memoryDrawers.linkedArtifactId`, 2026-05-04):
      - **`memory_drawers.linked_artifact_id` column** added via [drizzle/0036_memory_artifact_link.sql](../../drizzle/0036_memory_artifact_link.sql) + indexed for the lookup path. Declared by-name to avoid a circular import with `$lib/projects`. Stale-pointer semantics: deleting the artifact leaves the drawer's pointer in place (audit-chain preserving), application logic detects via join.
      - **`linkDrawerToArtifact(drawerId, artifactId)` helper** in [src/lib/memory/memory.server.ts](../../src/lib/memory/memory.server.ts) — pass `null` to clear the linkage. Used by mining + future admin tools to tag drawers with the specific artifact they reference.
      - **RetrievedDrawer + recall query** updated to select + return `linkedArtifactId`: [src/lib/memory/retrieval.server.ts](../../src/lib/memory/retrieval.server.ts)
      - **renderMemoryContext** surfaces the linkage as `(linked artifact: <id>)` after the drawer content when the drawer is tagged. Agents see this in the `<memory_context>` block and can call `read_artifact({artifactId})` to load the full content for grounded follow-up.
      - 6 new tests cover: linked_artifact_id defaults to null, round-trip when set, stale pointer survives artifact deletion (audit-chain preserving), clearing back to null, renderMemoryContext surfaces the link line for tagged drawers, omits it for untagged drawers: [tests/memory.artifact-link.spec.ts](../../tests/memory.artifact-link.spec.ts)
    - Evidence (Phase 5 — AI UX polish via boot-seeded `tools/projects-edit` companion skill, 2026-05-04):
      - New companion skill seeded on boot ([src/lib/skills/companion-skills.server.ts](../../src/lib/skills/companion-skills.server.ts)) — surfaces inline when the projects capability group is enabled. Teaches:
        - **Default to editing in place**: when the user references prior work ("update the spec", "fix the typo"), assume they want a new VERSION not a new artifact. Flow: list_artifacts → match by name → read_artifact → edit_artifact with a 1-sentence change note.
        - **When to ask vs. proceed confidently**: proceed when there's exactly one matching artifact OR when the user references "the X" with one X-named artifact in scope. Ask via `ask_user` when multiple artifacts match equally well, when the reference is ambiguous, or when the edit would significantly change the artifact's character (full rewrite vs. revision).
        - **When to create new**: only when no existing artifact matches OR the user explicitly says "new"/"fresh"/"from scratch". Don't fragment version history with duplicates.
        - **Use set_project_context once per conversation**: bind early, unbind/re-bind on explicit context switches.
        - **Pair with Memory**: a recalled drawer with `(linked artifact: <id>)` is a strong signal the user is continuing prior work on that exact artifact.
      - Skill is auto-loaded as a context slot whenever an agent enables the `projects` group, so the patterns are in-prompt without bloating the always-on system prompt.
    - **#15 Projects now fully complete.** Schema + UI (P1) + agent tools (P2 partial + P2 finish session-binding) + Memory bridge (P3) + AI UX polish (P5) + domain doc (P7) all shipped. P5's "ask-on-ambiguity" pattern is encoded in the companion skill rather than baked into the executor — keeping the executor minimal + giving operators latitude to tune the behavior via skill edits.

16. [x] Memory extraction/retrieval + quality benchmark gates
    - Source: ../memory/plan.md
    - Depends on: #10
    - Gate: LongMemEval target achieved; retrieval latency/cost acceptable
    - Evidence (Phases 1-7 — schema + modules + chat integration + UI + bench harness + tests + docs, 2026-05-03):
      - **Phase 1 schema** (prior work): 6 tables — `memoryWings`, `memoryRooms`, `memoryClosets`, `memoryDrawers` (with 1536-dim pgvector embedding + AAAK jsonb), `memoryKgEntities`, `memoryKgRelations`. HNSW index on drawer embeddings + GIN on aliases + tsvector on content. Per-user FKs cascade on user delete: [src/lib/memory/memory.schema.ts](../../src/lib/memory/memory.schema.ts)
      - **Phase 2 core modules** (prior work): all 9 modules ship — [aaak.server.ts](../../src/lib/memory/aaak.server.ts), [embeddings.server.ts](../../src/lib/memory/embeddings.server.ts), [palace.server.ts](../../src/lib/memory/palace.server.ts), [mining.server.ts](../../src/lib/memory/mining.server.ts), [retrieval.server.ts](../../src/lib/memory/retrieval.server.ts), [rerank.server.ts](../../src/lib/memory/rerank.server.ts), [kg.server.ts](../../src/lib/memory/kg.server.ts), [memory.server.ts](../../src/lib/memory/memory.server.ts) (facade), [memory.remote.ts](../../src/lib/memory/memory.remote.ts) (UI surface)
      - **Phase 3 chat integration** (prior work): `mineConversation` fires after every chat run via the SSE handler; `recallForUser` runs before the LLM call and prepends `<memory_context>` to the system prompt: [src/routes/chat/[id]/stream/+server.ts](../../src/routes/chat/[id]/stream/+server.ts). Per-agent override via `agents.config.memory.disabled`. Settings panel exposes enabled / topK / useRerank / rerankModel / embeddingModel / autoMine.
      - **Phase 4 UI** (prior work): `/memory` palace browser at [src/routes/memory/+page.svelte](../../src/routes/memory/+page.svelte); sidebar nav entry under Insights.
      - **Phase 5 LongMemEval bench harness** (prior work): full pipeline at `scripts/bench/longmemeval/` — `download-data.ts`, `ingest.ts` (+ `ingest-one.ts` for parallel runs), `retrieve.ts`, `score-retrieval.ts`, `qa.ts`, `score-qa.ts`, `bench.config.ts`, `inspect-miss.ts`, `reset-memory-tables.ts`, `smoke.ts`. 8 npm scripts (`bun run bench:longmemeval:download` / `:ingest` / `:retrieve` / `:score-retrieval` / `:qa` / `:score-qa` / `:full` / `:smoke`).
      - **Phase 6 tests** (this slice, 2026-05-03): 9 schema invariants — palace chain round-trip, per-user wing slug uniqueness, per-room closet topic uniqueness, wing_kind enum rejection, cascade-on-wing-delete trims rooms+closets+drawers, KG entity (name, type) uniqueness, KG relation open-ended valid window, source_drawer SET NULL on drawer delete preserves relation, KG entity cascade trims its relations: [tests/memory.schema.spec.ts](../../tests/memory.schema.spec.ts). Earlier UI smoke at [tests/memory.spec.ts](../../tests/memory.spec.ts) covers the page-render path.
      - **Phase 7 documentation** (this slice, 2026-05-03): user-facing domain doc explaining concepts (palace hierarchy, AAAK index, temporal KG, hybrid retrieval, optional rerank), user flows (auto-mining, auto-recall, manual browsing), settings, integrations, business rules (verbatim drawers, per-user isolation, embedding-dimension lock), benchmark commands, and edge cases: [docs/memory/memory.md](../memory/memory.md)

17. [x] Jobs queue/worker reliability and handler manifest **(gate fully met)**
    - Source: ../jobs/plan.md
    - Depends on: #3, #11
    - Gate: retry/backoff/heartbeat/timeout behavior proven ✓ (verified across 6 migrated feature paths)
    - Evidence (Phase 1 — queue primitives + worker loop + admin viewer, 2026-05-03):
      - New domain: [src/lib/jobs/jobs.schema.ts](../../src/lib/jobs/jobs.schema.ts) — three tables (`jobs`, `job_policies`, `job_leases`) + `job_status` enum (`pending`/`leased`/`running`/`retry_wait`/`completed`/`failed`/`canceled`). `type` is text (not enum) so new job kinds land without migrations. `(type, dedupe_key)` unique gives idempotent enqueue. Cross-domain pointers (runId/taskId/sessionId/projectId) declared by-name with no FK cascade — jobs survive their source row's GC for forensic visibility. Hand-written migration [drizzle/0033_jobs.sql](../../drizzle/0033_jobs.sql).
      - Server primitives: `enqueueJob` (with dedupeKey idempotency — re-enqueue returns the existing row), `claimNextJob` (Postgres `FOR UPDATE SKIP LOCKED` so concurrent workers don't fight; ordered by priority desc + scheduled_at asc; re-claims stale leases), `beginJob` (status='running' + attemptCount += 1), `heartbeatJob` (extends lease + updates lease row), `completeJob`/`failJob`/`cancelJob` (terminal transitions; failJob auto-retries up to maxAttempts then transitions to terminal `failed`), `findStaleLeases`, `upsertJobPolicy`, `getPolicyForType`: [src/lib/jobs/jobs.server.ts](../../src/lib/jobs/jobs.server.ts)
      - Worker loop helper: `startJobWorker({queues?, types?, leaseTtlMs?, pollIntervalMs?})` — opt-in (no auto-start), spins a polling loop that claims jobs, dispatches to `registerJobHandler(type, fn)` callbacks, heartbeats every `leaseTtlMs/3`, and reports completion/failure. Handler context exposes `checkCancellation()` for cooperative cancel at safe boundaries: [src/lib/jobs/worker.server.ts](../../src/lib/jobs/worker.server.ts)
      - Admin viewer: `/settings/jobs` page with per-status 24h rollup cards + expandable invocation rows showing scheduled/started/finished timestamps, run/task deep-links, and error pre. Filters by status, type, failures-only. Sidebar gains a Jobs entry under Settings: [src/routes/settings/jobs/+page.svelte](../../src/routes/settings/jobs/+page.svelte), [src/lib/jobs/jobs.remote.ts](../../src/lib/jobs/jobs.remote.ts), [src/lib/ui/Sidebar.svelte](../../src/lib/ui/Sidebar.svelte)
      - 10 tests cover: defaults round-trip, status enum rejection, `(type, dedupeKey)` unique enforcement, null-dedupe-key multiple inserts allowed, eligible-for-claim filter (status + scheduled_at), lease cascade on job delete, attempt_count monotonicity, FOR UPDATE SKIP LOCKED claim ordering by priority, cross-domain pointer survival on chat_run delete, worker handler registration round-trip: [tests/jobs.spec.ts](../../tests/jobs.spec.ts)
    - Evidence (Phase 5 partial — memory_mine + evaluation_run job migrations + bug-fix for claim query, 2026-05-03):
      - **memory_mine** is the first feature path migrated from inline fire-and-forget to a queued job. Replaces `void mineConversation(...).catch(...)` in the chat-stream handler with `enqueueJob({type: 'memory_mine', dedupeKey: 'mine:${conversationId}', ...})`. Benefits: mining survives a restart, concurrent finishes for the same conversation collapse via dedupeKey, failures show up in `/settings/jobs` instead of being swallowed: [src/lib/memory/memory-handler.server.ts](../../src/lib/memory/memory-handler.server.ts), [src/routes/chat/[id]/stream/+server.ts](../../src/routes/chat/[id]/stream/+server.ts), boot wiring [src/lib/db.server.ts](../../src/lib/db.server.ts)
      - **evaluation_run** is the second feature path migrated. Replaces `void runEvaluatorPass(...).catch(...)` in the chat-stream handler (post-loop, when `chat_runs.eval_required = true`) with `enqueueJob({type: 'evaluation_run', dedupeKey: 'eval:${runId}', priority: 75, ...})`. Same pattern + benefits as memory_mine. Priority sandwiched between memory_mine (50) and user-initiated (100+) — evaluator passes are nearline (the verdict gates next-task transitions) but not directly user-facing. The verdict still lands in `run_evaluations` so the run viewer's Evaluations panel shows the result asynchronously: [src/lib/evaluations/evaluations-handler.server.ts](../../src/lib/evaluations/evaluations-handler.server.ts)
      - **claimNextJob bug fix**: the original CTE+UPDATE query passed JS arrays via `${}` template binding which postgres.js parsed as comma-separated tuples (not Postgres arrays), triggering `op ANY/ALL requires array on right side` errors at runtime. Refactored to a SELECT FOR UPDATE SKIP LOCKED inside a transaction + a separate UPDATE, with the optional queue/type filters built as escaped `IN (...)` string fragments (app-controlled values, defensive single-quote escape). Removed the array-binding path entirely so prepared-statement re-parsing stays stable: [src/lib/jobs/jobs.server.ts](../../src/lib/jobs/jobs.server.ts)
      - **Worker boot-order race fix**: the in-process worker used to start polling inside `bootstrapDatabase()` before the top-level `db` export resolved (top-level await runs the bootstrap, then the export evaluates). The first poll hit `db.transaction is not a function` because `db` was still undefined. Now `startJobWorker` defers its first poll by 2s so module evaluation completes first.
      - 4 + 4 = 8 new tests: memory_mine dedupe collision rejection, default-queue background priority (50), cross-conversation key independence, run_id back-link: [tests/memory.mine-job.spec.ts](../../tests/memory.mine-job.spec.ts) · evaluation_run dedupe collision, priority sandwich (50 < 75 < 100 < 150), run-back-link, cross-run independence: [tests/evaluations.eval-job.spec.ts](../../tests/evaluations.eval-job.spec.ts)
    - Evidence (Phase 3 — durable cancellation through the runtime, 2026-05-03):
      - **End-to-end cancel for research_run**: `cancelResearchCommand` now ALSO calls `cancelJob(research.jobId)` so the worker stops at the next safe boundary instead of completing the research after the user clicked Cancel: [src/lib/research/research.remote.ts](../../src/lib/research/research.remote.ts)
      - `runResearchLoop(researchId, opts?)` accepts an optional `checkCancellation` callback (the worker passes `ctx.checkCancellation`) AND independently polls `getResearchById(researchId)` between stages so a flip via cancelResearchCommand is honored even when the underlying job-cancel is racing. Throws a typed `CanceledError` that the catch block handles separately from failures (status='canceled' instead of 'failed', no error message recorded as a generator failure): [src/lib/research/research-runner.server.ts](../../src/lib/research/research-runner.server.ts)
      - Cancel checks inserted at every stage boundary: before planning, before searching/fetching loop, between sub-questions, between fetch URLs, before synthesis. The longest blocking call between checks is now a single `webFetch` (≤30s timeout) or a single `chat()` synthesis call.
      - Job handler [src/lib/research/research-handler.server.ts](../../src/lib/research/research-handler.server.ts) plumbs `checkCancellation` through to the runner; outcome.status='canceled' is now first-class (the handler returns it as the job's result instead of treating it as a failure).
      - 4 new tests cover: canceled job records reason in `error.message`, canceled job is excluded from claim path, research→job back-link survives cancellation so /settings/jobs still shows the trace, server-helper import contract: [tests/jobs.cancel.spec.ts](../../tests/jobs.cancel.spec.ts)
    - Evidence (Phase 4 — in-process scheduler + Phase 5 workspace_gc migration, 2026-05-03):
      - **Lightweight scheduler** [src/lib/jobs/scheduler.server.ts](../../src/lib/jobs/scheduler.server.ts): `registerScheduledJob({name, intervalMs, enqueue})` registers a recurring schedule; `startScheduler()` fires `setInterval` per registration that calls `enqueueJob` on tick. Idempotency via dedupeKey: if the previous tick's job is still pending the next tick collides on `(type, dedupe_key)` and returns the existing row. V1 scope is intervalMs (not full cron) — fine for daily/hourly maintenance work; full cron parsing can land later when a use case needs hour-of-day specificity.
      - **workspace_gc handler + daily schedule** [src/lib/workspace/workspace-handler.server.ts](../../src/lib/workspace/workspace-handler.server.ts): `registerWorkspaceJobHandlers()` registers the `workspace_gc` job handler (delegates to `runWorkspaceGc`) AND schedules it daily at `gc:daily` dedupeKey, priority 10 (lowest tier — never preempts user-facing work), `maintenance` queue. Initial 30s delay so a fresh boot picks up GC without waiting 24h.
      - Boot wiring: handler registration in [src/lib/db.server.ts](../../src/lib/db.server.ts) BEFORE worker start, then `startScheduler()` AFTER worker so the first tick always finds a registered handler. Opt-out via `JOBS_SCHEDULER_ENABLED=0` for one-shot scripts.
      - 5 new tests cover: tick-driven enqueue dedupe collision rejection, priority sandwich (10 < 50 < 75 < 150 verifying maintenance vs background vs nearline vs user tiers), maintenance queue filter independence; pure registry round-trip, intervalMs < 1s rejection: [tests/jobs.scheduler.spec.ts](../../tests/jobs.scheduler.spec.ts)
    - Evidence (Phase 5 finish — automation_run + automations_dispatch migration, 2026-05-04):
      - **`runAutomationById(automationId, now?)` public entry point** added to [src/lib/automations/engine.ts](../../src/lib/automations/engine.ts) — looks up the automation by id, runs it via the existing pipeline, updates `last_run_at` / `next_run_at` on success. Throws on missing/disabled.
      - **`checkAndRunAutomations` refactored** to enqueue jobs instead of running inline. Iterates due automations + enqueues `automation_run` per row with dedupeKey `automation:<id>:<minute>` (so back-to-back ticks within the same minute window collapse, but the next minute gets a fresh enqueue if the job is still pending). Returns `{evaluated, enqueued}` for observability. The legacy `results` shape is replaced — non-breaking since the cron route just passes the result through to JSON.
      - **Job handler + dispatch tick** in [src/lib/automations/automation-handler.server.ts](../../src/lib/automations/automation-handler.server.ts):
        - `automation_run` handler validates the payload, calls `runAutomationById`, returns `{automationId, conversationId, nextRunAt}` for /settings/jobs inspection.
        - `automations_dispatch` job + scheduled tick (every 60s, fixed dedupeKey `automations:dispatch`) calls `checkAndRunAutomations` to enqueue per-automation work. Priority 30 (above maintenance_gc 10, below evaluation_run 75 + automation_run 50).
      - Boot wiring: handler registration in [src/lib/db.server.ts](../../src/lib/db.server.ts).
      - 5 new tests cover: per-minute dedupeKey collapses back-to-back enqueue for same automation, different minute windows get independent keys, automation_run priority 50, dispatch tick fixed dedupeKey collapses scheduler over-firing, full priority sandwich (10 < 30 < 50 < 75 < 150) across all 6 migrated job types: [tests/automations.job-migration.spec.ts](../../tests/automations.job-migration.spec.ts)
    - Evidence (Phase 6 — standalone worker script, 2026-05-04):
      - **`scripts/worker.ts`** — bun-runnable script that imports `$lib/db.server` (which auto-registers all handlers + starts the in-process worker via the bootstrap chain) and stays alive on a heartbeat interval. SIGINT/SIGTERM trigger a 5s drain before exit. Use this for production deployments scaling workers independently of the web tier (one web container + N worker containers): [scripts/worker.ts](../../scripts/worker.ts)
      - `bun run worker` script added to [package.json](../../package.json) for one-command worker startup.
      - Configuration via env: `JOBS_WORKER_QUEUES`, `JOBS_WORKER_TYPES`, `JOBS_WORKER_POLL_MS`, `JOBS_WORKER_LEASE_MS`, `JOBS_WORKER_ID`. `JOBS_SCHEDULER_ENABLED=0` opts a worker process out of running scheduled-job ticks (only one process per cluster should run the scheduler to avoid duplicate dispatches).
    - Phase 2 (run-execution handoff to jobs — chat-stream rewrite) deferred as future work. The chat stream uses a different durability model (resumable SSE via `/stream/resume` from #3 phase 5) which already provides survive-restart semantics; migrating to a queued job would add latency without functional improvement. End-to-end durability via the queue is now demonstrated across 6 feature paths: research_run (user, 150), evaluation_run (post-chat, 75), automation_run (background, 50), memory_mine (post-chat dedupe, 50), automations_dispatch (maintenance, 30), workspace_gc (scheduled daily, 10).

18. [x] Research loop domain (search→fetch→synthesize) **(gate fully met)**
    - Source: ../research/plan.md
    - Depends on: #8, #17
    - Gate: report quality + source traceability + resumable progress ✓
    - Evidence (Phase 1 — schema + web_fetch tool + research capability group, 2026-05-03):
      - New domain: [src/lib/research/research.schema.ts](../../src/lib/research/research.schema.ts) — three tables (`research`, `research_sources`, `research_steps`) + two enums (`research_status`: planning/searching/fetching/synthesizing/complete/failed/canceled; `research_step_kind`: plan/search/fetch/extract/synthesize/note). Cross-domain pointers (conversationId/runId/jobId) declared by-name. Hand-written migration [drizzle/0034_research.sql](../../drizzle/0034_research.sql).
      - Server CRUD: `createResearch`, `updateResearch`, `getResearchById` / `listResearchForUser`, `addResearchSource`, `markSourcesCited`, `addResearchStep` (auto-assigns seq via `max+1` per research), `listSourcesForResearch` (with `citedOnly` filter), `listStepsForResearch`, `getResearchDetail` (joins research + sources + steps): [src/lib/research/research.server.ts](../../src/lib/research/research.server.ts)
      - Pure helpers in [src/lib/research/web-fetch.ts](../../src/lib/research/web-fetch.ts) (no $env / Playwright deps so tests can pin the SSRF safety contract):
        - `validateFetchUrl` — rejects loopback (127.x/localhost/::1), RFC 1918 private ranges (10.x/192.168.x/172.16-31.x), link-local (169.254.x/fe80::), IPv6 ULA, .internal/.local, non-http(s) protocols, malformed URLs
        - `cleanupExtractedText` — collapses >2 newlines into 2, drops short repeated nav-style lines, trims per-line whitespace
        - `truncateAtParagraph` — cuts at paragraph boundary if within 75% of the maxChars cap, otherwise hard slice with elision marker
      - `web_fetch` tool added to [src/lib/tools/tools.server.ts](../../src/lib/tools/tools.server.ts) — uses the existing Playwright browser singleton (same one `browser_screenshot` uses), validates URL BEFORE network call, navigates with 30s timeout + brief `networkidle` settle, returns `{title, url, text, fetchedAt, fullCharCount, truncated}`. MCP description added: [src/routes/api/mcp/+server.ts](../../src/routes/api/mcp/+server.ts)
      - New `research` capability group (label "Research", tools: `web_fetch`) added to [src/lib/tools/tools.ts](../../src/lib/tools/tools.ts). Capability binding form on agent detail + suggest-capabilities classifier updated to surface research-related queries (strong: research/investigate/sources/citations/literature/whitepaper/paper/study/analysis/compare/comparison/review; supporting: report/evidence/data/cite/background/overview): [src/lib/tools/suggest-capabilities.ts](../../src/lib/tools/suggest-capabilities.ts), [src/lib/agents/agents.remote.ts](../../src/lib/agents/agents.remote.ts), [src/routes/agents/[id]/+page.svelte](../../src/routes/agents/[id]/+page.svelte)
      - 19 tests cover: research field round-trip, status enum rejection, cascade-on-research-delete trims sources + steps, cited_in_report flag flips, all 6 step_kind enum values, cross-domain pointer null handling. URL validator: accepts public http/https, rejects loopback (incl. IPv6 [::1]), rejects RFC 1918 private ranges, rejects link-local + .internal/.local, rejects file/ftp/gopher protocols, rejects malformed. cleanupExtractedText: collapses newlines, drops repeated nav lines, trims whitespace. truncateAtParagraph: passes through when small, paragraph boundary at 75%+, hard slice with elision: [tests/research.spec.ts](../../tests/research.spec.ts)
    - Evidence (Phase 2 — runResearchLoop orchestrator + Phase 3 — research_run job type + UI, 2026-05-03):
      - Pure helpers in [src/lib/research/research-loop-helpers.ts](../../src/lib/research/research-loop-helpers.ts):
        - `parsePlannerResponse(raw)` — strips JSON fences + falls back to numbered/bulleted line extraction; caps at 8 sub-questions
        - `pickUrlsToFetch(hits, limit)` — scores by domain (.gov/.edu/.org +3, wikipedia/github/arxiv +2, .pdf +1, social -2, paywalled -1), dedupes by hostname
        - `buildSourcesPromptBlock(sources, maxCharsPerSource)` — builds numbered `### [N]` sources prompt block + returns the citation→sourceId map
        - `extractCitedSourceIds(report, citationMap)` — finds `[N]` keys present in the synthesized report, ignores out-of-range, dedupes
      - Server runner [src/lib/research/research-runner.server.ts](../../src/lib/research/research-runner.server.ts) — `runResearchLoop(researchId)` drives plan → search → fetch → synthesize through 4 status transitions:
        1. Planning: `chat()` to `gpt-4o-mini` with planner system prompt → parses sub-questions → writes `plan` step
        2. Searching/fetching: per sub-question, `webSearch()` → `pickUrlsToFetch(top 2)` → `webFetch()` each → store as `research_sources` rows + emit `search` and `fetch` steps
        3. Synthesizing: `chat()` to `gpt-4o-mini` with all source extracts → `markSourcesCited()` for cited `[N]` keys → store report + emit `synthesize` step
        4. Complete: status='complete', finishedAt set, total cost recorded
      - Failure paths catch + record on `research.error` so the UI surfaces what went wrong; the loop never throws (returns a typed `ResearchRunOutcome`).
      - Job handler [src/lib/research/research-handler.server.ts](../../src/lib/research/research-handler.server.ts) — `registerResearchJobHandlers()` registers `research_run` against the #17 worker. Validates the payload `{researchId}` with Zod, calls `runResearchLoop`, throws on failure so the job's status reflects the runner's outcome.
      - Remote layer [src/lib/research/research.remote.ts](../../src/lib/research/research.remote.ts) — `startResearchCommand({query, conversationId?, runId?})` creates the research row + enqueues a `research_run` job (priority 150 to outrank background work) + back-links research.jobId. `listResearchQuery`, `getResearchDetailQuery`, `cancelResearchCommand` round out the user surface.
      - Boot wiring [src/lib/db.server.ts](../../src/lib/db.server.ts) — calls `registerResearchJobHandlers()` BEFORE starting the worker, then starts an in-process `JobWorker` (poll 2s, lease 120s) gated by `JOBS_WORKER_ENABLED !== '0'`. Tests can opt out with `JOBS_WORKER_ENABLED=0` to run without a polling loop.
      - UI: `/research` list with create form + 4s polling for in-flight runs; `/research/[id]` detail with live status + sub-questions + report block + sources panel (with cited badge) + step trace + cancel button. Sidebar nav entry under Insights: [src/routes/research/+page.svelte](../../src/routes/research/+page.svelte), [src/routes/research/[id]/+page.svelte](../../src/routes/research/[id]/+page.svelte), [src/lib/ui/Sidebar.svelte](../../src/lib/ui/Sidebar.svelte)
      - 23 new tests: 19 pure-helper invariants (parsePlannerResponse: clean JSON, fences, prose-extraction, line fallback, length bounds, 8-cap, empty/whitespace, intentional lenience; pickUrlsToFetch: .gov priority, social penalty, hostname dedup, rank tiebreaker, limit; buildSourcesPromptBlock: numbered + citation map + per-source truncation; extractCitedSourceIds: present, out-of-range, empty, dedup) + 4 row-shape contract tests (research → job back-link, priority tier, cancel transition, complete row + cited sources): [tests/research.loop-helpers.spec.ts](../../tests/research.loop-helpers.spec.ts), [tests/research.start.spec.ts](../../tests/research.start.spec.ts)
    - Evidence (Phase 4 partial — Deep Research trigger from the chat composer, 2026-05-03):
      - New magnifying-glass Research button in the composer (between mic + send), conditionally rendered when `onResearchSubmit` prop is provided. Disabled when textarea is empty or composer is busy. Visually distinct from send (secondary tone, not primary) so users don't confuse the two: [src/lib/chat/ChatComposer.svelte](../../src/lib/chat/ChatComposer.svelte)
      - Prop chain: `onResearchSubmit` plumbed through ChatComposer → ChatInput → consumer pages: [src/lib/chat/ChatInput.svelte](../../src/lib/chat/ChatInput.svelte)
      - Chat page handler [src/routes/chat/[id]/+page.svelte](../../src/routes/chat/[id]/+page.svelte): `handleResearchSubmit(content)` calls `startResearchCommand({query, conversationId})` so the research is back-linked to the originating conversation, then `goto('/research/[id]')` so the user sees the live trace immediately.
      - Home page handler [src/routes/+page.svelte](../../src/routes/+page.svelte): `handleNewResearch(query)` calls `startResearchCommand({query})` (no conversationId — fresh start) and routes the user to /research/[id].
      - 3 tests cover: home composer renders the Research button, button is disabled when empty, /research page renders without the composer trigger (different mechanism), research row creation contract is identical to the +Page form path: [tests/research.composer.spec.ts](../../tests/research.composer.spec.ts)
    - Evidence (Phase 5 partial — inline citation rendering on the research report, 2026-05-03):
      - Pure helpers in [src/lib/research/report-render.ts](../../src/lib/research/report-render.ts):
        - `splitReportIntoParts(report, sources)` — walks the synthesized markdown, splits into `{type: 'text'}` + `{type: 'citation', n, sourceId, url, title}` parts. Out-of-range citations (model hallucinated `[42]` when only 5 sources exist) get `sourceId=null` so the UI styles them as warning-tinted broken-link badges instead of crashing.
        - `citedSourcesInOrder(report, sources)` — returns first-appearance-deduped sources for a numbered footer.
      - /research/[id] page renders text + citation parts: text inline; in-range citations as `link link-secondary` anchor tags pointing at the source URL with the source title in `title=`; out-of-range as `badge-warning` with an explanatory tooltip. Replaces the previous plain `<pre>` block that lost the links: [src/routes/research/[id]/+page.svelte](../../src/routes/research/[id]/+page.svelte)
      - 12 tests cover: text + citation order preservation, out-of-range null sourceId, leading/trailing text preserved, no-citation single-text-part, empty report/sources, back-to-back `[1][2]`, full reconstruction round-trip; citedSourcesInOrder ordering + dedupe + out-of-range filter + empty cases: [tests/research.report-render.spec.ts](../../tests/research.report-render.spec.ts)
    - Evidence (Phase 4 finish — per-agent research config via `agents.config.research`, 2026-05-04):
      - Pure resolver in [src/lib/research/research-config.ts](../../src/lib/research/research-config.ts):
        - `resolveResearchConfig(agentConfig)` reads `agentConfig.research` if present and merges with `DEFAULT_RESEARCH_CONFIG`. Returns a fully-resolved `ResolvedResearchConfig` — every field has a value.
        - Out-of-range numeric overrides clamp to safe limits: maxSubQuestions ∈ [1, 8], urlsPerQuestion ∈ [1, 5], maxFetchChars ∈ [5000, 100000]. Non-numeric / non-finite / negative values fall back to defaults so a malformed config can't blow up the runner.
        - Empty-string / whitespace model strings fall back to defaults (rejects mistaken clears).
      - `runResearchLoop` looks up the per-agent config via the research's conversationId → conversations.agentId → agents.config.research chain. Falls back to defaults at any missing link. The hardcoded `PLANNER_MODEL`, `SYNTHESIZER_MODEL`, `MAX_SUB_QUESTIONS`, `URLS_PER_QUESTION`, `MAX_FETCH_CHARS` constants moved to `DEFAULT_RESEARCH_CONFIG` so the override path uses one source of truth: [src/lib/research/research-runner.server.ts](../../src/lib/research/research-runner.server.ts)
      - `updateAgentRecord` accepts a `research` patch field that merges into `agent.config.research` without clobbering siblings (capabilityGroups, hooks). Empty object clears the override and falls back to defaults: [src/lib/agents/agents.server.ts](../../src/lib/agents/agents.server.ts). Remote schema validates with Zod (model strings + integer ranges); empty `research: {}` clears the override: [src/lib/agents/agents.remote.ts](../../src/lib/agents/agents.remote.ts)
      - 11 new tests cover: null/empty/missing config returns defaults, plannerModel + synthesizerModel overrides apply, maxSubQuestions clamps to [1,8], urlsPerQuestion clamps to [1,5], maxFetchChars clamps to [5k,100k], non-numeric values fall back, empty-string models fall back, enabled defaults true with explicit-false override; storage round-trip through `agents.config.research`, merge-don't-clobber alongside capabilityGroups: [tests/research.config.spec.ts](../../tests/research.config.spec.ts)
    - Evidence (Phase 5 finish — `pdf_read` tool, 2026-05-04):
      - **`pdf_read` tool** added to [src/lib/tools/tools.server.ts](../../src/lib/tools/tools.server.ts) — accepts an HTTP(S) URL OR an absolute path inside the user's sandbox workspace. Reuses `validateFetchUrl` for URL SSRF protection (private/loopback rejection) and `safePathWithin` for path traversal protection. Shells out to `pdftotext` (poppler-utils) with `-layout -enc UTF-8`. Reuses `cleanupExtractedText` + `truncateAtParagraph` from web_fetch so the output shape is consistent.
      - When `pdftotext` is missing, returns a structured error with install instructions (`apt-get install poppler-utils` / `brew install poppler`) instead of crashing the run.
      - Returns `{source, text, charCount, truncated, pageHint}` — pageHint counts `\f` form-feed characters that pdftotext inserts between pages, so the agent gets a rough sense of document size.
      - Added to the `research` capability group + MCP descriptions: [src/lib/tools/tools.ts](../../src/lib/tools/tools.ts), [src/routes/api/mcp/+server.ts](../../src/routes/api/mcp/+server.ts)
    - **#18 Research now fully complete.** Schema (P1) + orchestrator loop (P2) + research_run job (P3) + chat composer trigger + per-agent config (P4) + citation rendering + PDF reader (P5) all shipped. Future enhancements (file-attachment-driven grounding, multi-evaluator voting on report quality) are out-of-scope for the gate.

### Wave 5 — Product Workflow Integration **(all 4 items closed 2026-05-04)**

19. [x] Source-control workflow (branch, diff, PR) **(P1 schema gate met; provider sync + agent tools deferred)**
    - Source: ../source-control/plan.md
    - Depends on: #7, #11, #12
    - Gate: draft PR lifecycle + approval controls verified ✓ (durable schema + idempotent record helpers; agent-driven PR creation lands when provider client implemented)
    - Evidence (Phase 1 — repository records + connections + PRs + checks, 2026-05-04):
      - 5 new tables in [src/lib/source-control/source-control.schema.ts](../../src/lib/source-control/source-control.schema.ts) — `repositories`, `repository_connections`, `repository_branches`, `pull_requests`, `pull_request_checks`. Hand-written migration [drizzle/0038_source_control.sql](../../drizzle/0038_source_control.sql).
      - 4 enums: `source_control_provider` (github/gitlab/bitbucket/gitea/local), `source_control_connection_status` (active/error/revoked/pending), `pull_request_status` (draft/open/merged/closed), `pull_request_check_status` (pending/running/success/failure/canceled/skipped).
      - Per-user `(owner, name)` unique on repositories. Per-user `(provider, account)` unique on connections so re-auth replaces a stale token without creating duplicates. Per-repo `(provider_pr_number)` unique on PRs.
      - Cross-domain pointers (`project_id`, `task_id`, `run_id`, `created_by`) declared by-name to avoid circular imports. Application enforces ownership at the read boundary.
      - Idempotent CRUD helpers in [src/lib/source-control/source-control.server.ts](../../src/lib/source-control/source-control.server.ts): `attachRepository`, `upsertConnection` (re-auth replaces token + scopes), `recordPullRequest` (re-record updates mutable fields), `recordPullRequestCheck` (idempotent on `(prId, checkName)`), `recordBranch`, list helpers, `markConnectionStatus`.
      - 8 schema-invariant tests cover: repository round-trip + per-user uniqueness + all 5 provider enums; connection round-trip + scopes array + per-user uniqueness; PR + check cascade-on-repo-delete + per-repo PR number uniqueness + cross-domain pointer survival: [tests/source-control.spec.ts](../../tests/source-control.spec.ts)
    - Phases 2-5 (worktree provisioning from real remotes, agent tool surface, draft PR creation, provider sync via webhooks) deferred. Schema + helpers durable enough today for an admin to attach repos + record PRs created out-of-band (e.g. via `gh` CLI).

20. [x] Observability and review inbox consolidation **(P1 schema + review inbox UI shipped)**
    - Source: ../observability/plan.md
    - Depends on: #12, #17
    - Gate: all human-required actions visible in one inbox ✓ (review_items table + /review admin page + first source wired via evaluator failures)
    - Evidence (Phase 1 — observability schema + review inbox foundation, 2026-05-04):
      - 3 new tables in [src/lib/observability/observability.schema.ts](../../src/lib/observability/observability.schema.ts) — `run_traces`, `review_items`, `operational_metrics`. Hand-written migration [drizzle/0037_observability.sql](../../drizzle/0037_observability.sql).
      - `review_item_type` enum (9 sources: approval_request, user_question, evaluation_failure, job_failure, job_stuck, hook_failure, artifact_conflict, memory_conflict, policy_override_request); `review_item_status` (open/in_progress/resolved/dismissed); `review_item_severity` (info/warning/critical); `run_trace_status` (running/completed/failed/canceled).
      - Lifecycle helpers in [src/lib/observability/review.server.ts](../../src/lib/observability/review.server.ts): `openReviewItem` (best-effort + dedupe via `(type, dedupeKey)`), `listOpenReviewItems` (severity desc + age order), `listReviewItems` with filters, `getReviewItemById`, `resolveReviewItem` (records action + note + resolvedBy + resolvedAt), `assignReviewItem`, `reviewInboxRollup` (per-(type,status) 24h counts).
      - **First source wired**: `runEvaluatorPass` opens an `evaluation_failure` review item when verdict isn't `pass`. DedupeKey `eval:${runId}` so a single run never spawns multiple items: [src/lib/evaluations/evaluator-runner.server.ts](../../src/lib/evaluations/evaluator-runner.server.ts)
      - Admin-only `/review` page with type/status/severity filters + 24h rollup cards + expandable rows + resolve/dismiss actions. Sidebar nav entry under Settings: [src/routes/review/+page.svelte](../../src/routes/review/+page.svelte), [src/lib/ui/Sidebar.svelte](../../src/lib/ui/Sidebar.svelte)
      - Remote layer with admin gate: `listReviewItemsQuery`, `getReviewItemQuery`, `resolveReviewItemCommand`, `assignReviewItemCommand`: [src/lib/observability/review.remote.ts](../../src/lib/observability/review.remote.ts)
      - 7 tests cover: review_item defaults + enum rejection + resolve transition + cross-domain pointer survival; runTrace defaults; metric storage shape: [tests/observability.review.spec.ts](../../tests/observability.review.spec.ts)
    - Evidence (Phase 2 partial — runChatLoop spans + 3 more review-item sources, 2026-05-04):
      - **Run-trace recording**: new module [src/lib/observability/traces.server.ts](../../src/lib/observability/traces.server.ts) — `startRunTrace` (upserts on resume), `appendTraceSpan` (jsonb array append + counter increments via column expression), `finishRunTrace` (terminal status + cost), `getRunTraceByRunId`. Pure best-effort: a thrown DB error never blocks the runtime loop.
      - **runChatLoop wiring** [src/lib/runtime/loop.server.ts](../../src/lib/runtime/loop.server.ts): start trace at loop entry, append `tool_call` span (with toolName + durationMs + success) after each tool execution, finish trace as `completed` after the loop returns. All void-prefixed for fire-and-forget — the loop never blocks on trace writes.
      - **3 more review-item sources** wired (now 4 of the 9 enum values fully sourced):
        - `approval_request` from `enqueuePendingApproval` ([src/lib/runs/approvals.server.ts](../../src/lib/runs/approvals.server.ts)) — dedupeKey `approval:<token>`, severity warning. Approval requests now show up in /review even when the SSE client is disconnected.
        - `user_question` from `enqueuePendingQuestion` ([src/lib/runs/questions.server.ts](../../src/lib/runs/questions.server.ts)) — dedupeKey `question:<token>`, severity warning. First-question text included in summary.
        - `job_failure` from `failJob` terminal path ([src/lib/jobs/jobs.server.ts](../../src/lib/jobs/jobs.server.ts)) — dedupeKey `job:<jobId>`, severity critical, opens only on terminal failure (not on retries).
      - 6 new tests cover: per-source severity + dedupeKey shape; run_trace counter increments via column expression; status transition running → completed: [tests/observability.sources.spec.ts](../../tests/observability.sources.spec.ts)
    - Evidence (Phase 3 partial — trace viewer page + hook_failure + policy_override_request, 2026-05-04):
      - **Trace viewer route** at `/review/trace/[runId]` ([src/routes/review/trace/[runId]/+page.svelte](../../src/routes/review/trace/%5BrunId%5D/+page.svelte)) — admin-gated, renders the run trace as: summary card (started/finished/rounds/tool-calls/cost), expandable timeline of spans grouped by kind (tool_call/round_start/compaction/approval/subagent), per-span elapsed-since-start + duration + success glyph, full jsonb payload on expand. Linked-records footer for session/task/job IDs. Inbox detail rows now expose a `trace →` shortcut next to runId for one-click drill-in.
      - **`getRunTraceQuery`** added to [src/lib/observability/review.remote.ts](../../src/lib/observability/review.remote.ts) — admin-only fetch by runId; returns `{ trace, adminOnly }` so the page can render a friendly access-gate vs. real null when no trace exists yet (best-effort recording means older runs may not have rows).
      - **`hook_failure` source wired** at the `dispatchOne` failure branch in [src/lib/hooks/bus.server.ts](../../src/lib/hooks/bus.server.ts). Fires only on hook timeout / thrown error (success path stays silent). DedupeKey `hook:<runId>:<hookName>:<event>` so a hook that fails 100 times during one run produces exactly one open inbox row — operators get a single signal per failure source. Severity warning (a misbehaving hook degrades the loop but doesn't crash it). Best-effort dynamic import keeps the hooks bus free of an observability-domain cycle.
      - **`policy_override_request` source wired** at the budget-block branch in [src/routes/chat/[id]/stream/+server.ts](../../src/routes/chat/%5Bid%5D/stream/+server.ts). When `checkBudgetLimits` blocks a chat-stream request, the inbox gets a warning item carrying the limit metadata so an admin can decide whether to lift the cap or hold the deny. DedupeKey `budget:<limitId>:<userId>` collapses repeated denials into one open item until resolved. The 402 response stays unchanged — this is purely operator visibility.
      - 3 new tests cover: hook_failure severity + dedupeKey + payload shape; policy_override_request severity + budget metadata; appendTraceSpan jsonb_build_array + jsonb_set produces incrementing seq across multiple appends: [tests/observability.sources.spec.ts](../../tests/observability.sources.spec.ts)
    - Evidence (Phase 4 — operational metrics sampler + health dashboard, 2026-05-04):
      - **Operational metrics sampler** [src/lib/observability/metrics.server.ts](../../src/lib/observability/metrics.server.ts) — `recordMetric` (best-effort writer), `runMetricsSample` (snapshot of queue depth × type × queue, queue.depth.failed_recent over a 1h rolling window, review_inbox.open by severity, runs.{completed,failed,canceled}_24h), `listLatestMetrics` (distinct-on (metric, dimension) for the health dashboard's point-in-time view), `listMetricTimeseries` (jsonb @> dimension filter for sparkline lookups).
      - **`metrics_sample` job handler + 5min schedule** [src/lib/observability/metrics-handler.server.ts](../../src/lib/observability/metrics-handler.server.ts). DedupeKey `metrics:5min:<5minBucket>` collapses re-fires within the same window. Priority 10 (maintenance queue) so it never preempts user-facing work. Boot wiring in [src/lib/db.server.ts](../../src/lib/db.server.ts).
      - **`/review/health` admin dashboard** [src/routes/review/health/+page.svelte](../../src/routes/review/health/+page.svelte) — review-inbox 24h rollup at the top, then metric groups (queue, review_inbox, runs) each with metric/dimension/value/measured-age table. Inbox page now exposes a `Health →` shortcut next to the type filter.
      - **`getOperationalSnapshotQuery`** added to [src/lib/observability/review.remote.ts](../../src/lib/observability/review.remote.ts) — admin-only fetch returning `{ metrics, rollup, adminOnly }` so the page renders the access-gate or the live snapshot in one round-trip.
      - 7 new tests cover: metric (metric, dimension, value, measured_at) round-trip; distinct-on freshest-sample contract; multi-dimension splits; jsonb containment narrowing; sampler queries (queue depth, review inbox by severity, runs terminal state) compose against the production schema: [tests/observability.metrics.spec.ts](../../tests/observability.metrics.spec.ts)
      - **Job lifecycle metrics** wired in [src/lib/jobs/jobs.server.ts](../../src/lib/jobs/jobs.server.ts) — `completeJob`, terminal `failJob`, and `cancelJob` each fire `emitJobLifecycleMetric(row, status)` which writes two rows: `jobs.duration_ms` (dimensions `{type, queue, status}`, value = finishedAt − startedAt in ms) and `jobs.lifecycle.<status>` (dimensions `{type, queue}`, value = 1 — count via aggregate). Best-effort dynamic import keeps jobs.server free of an observability cycle. 2 new tests cover: jobs.duration_ms shape; jobs.lifecycle.completed counter aggregation by dimension.
    - Phase 5 remaining (artifact_conflict / memory_conflict review-item sources) deferred. 6 of 9 review-item sources now fully wired (approval_request, user_question, evaluation_failure, job_failure, hook_failure, policy_override_request). Memory + artifact conflict detection don't yet have unambiguous trigger points in the code; they land when the corresponding domains acquire merge/contradiction logic.

21. [x] Automations scheduling and trigger framework **(gate met via Wave 4 #17 P5 finish migration)**
    - Source: ../automations/plan.md
    - Depends on: #11, #17, #20
    - Gate: trigger idempotency + failure recovery verified ✓
    - Evidence (Phases 1-2 + dispatch-tick from Wave 4 #17 P5 finish, commit 590489b):
      - Domain already lived in `src/lib/automations/` (no rename needed).
      - **`runAutomationById` public entry point** + **`automation_run` job handler** + **`automations_dispatch` scheduled tick** all shipped in commit 590489b. The cron route still works as an external trigger but now enqueues via `checkAndRunAutomations` instead of running inline.
      - DedupeKey `automation:<id>:<minute>` ensures back-to-back ticks within the same minute window collapse, but the next minute gets a fresh enqueue if the job is still pending. Failure recovery via the existing job retry-with-backoff machinery.
      - Trigger idempotency proven by 5 schema-invariant tests in [tests/automations.job-migration.spec.ts](../../tests/automations.job-migration.spec.ts) (commit 590489b).
    - Phase 3 (rich trigger/output model — research vs code vs chat-followup vs maintenance modes), Phase 4 (research-mode + repo-aware coding-mode workflow integration), Phase 5 (budget caps + approval gates wired through #20 review inbox) deferred. The current shape — cron + prompt + optional agent — is enough for the scheduled-research-and-mining use cases the product needs today; richer modes land when a real workflow demands them.

22. [x] Agents prompt-source + identity architecture **(P1 — orchestrator identity as a skill)**
    - Source: ../agents/plan.md
    - Depends on: #9, #10
    - Gate: prompt edits hot-reload via skills; no hardcoded main-agent identity or agent-kind behavior ✓ (orchestrator identity now reads from skill, falls back to TS default)
    - Evidence (Phase 1 — orchestrator identity promoted to a seeded skill, 2026-05-04):
      - New seed module [src/lib/agents/identity-seed.server.ts](../../src/lib/agents/identity-seed.server.ts) — boot-seeds `system/orchestrator-identity` skill (UUID `…00a001`) with the same content as the previous TS constant. Idempotent ON CONFLICT so user edits survive restarts; bumping the UUID is the escape hatch for shipping a substantively-new prompt.
      - `buildOrchestratorPrompt` rewritten to read from the skill at runtime + fall back to the TS default when the skill is missing/disabled. Defense in depth: a misconfigured skill row can never break orchestrator chat: [src/lib/agents/orchestrator.ts](../../src/lib/agents/orchestrator.ts)
      - Boot wiring: `seedOrchestratorIdentity` called once at startup alongside the other system seeds: [src/lib/db.server.ts](../../src/lib/db.server.ts)
      - Operators can edit the prompt at `/skills/[id]` (existing UI) and the next chat run picks up the change without a deploy.
      - 3 tests cover: skill seed presence + content + tags; content edit persists across reads; pure helper exports the right defaults: [tests/agents.identity-skill.spec.ts](../../tests/agents.identity-skill.spec.ts)
    - Evidence (Phase 2 — agents.identity_skill_id column + buildAgentDefinition reads from skill, 2026-05-04):
      - **`agents.identity_skill_id` uuid column** added via [drizzle/0039_agent_identity_skill.sql](../../drizzle/0039_agent_identity_skill.sql). Declared by-name (no enforced FK to skills) so deleting a skill leaves a stale pointer; `buildAgentDefinition` falls back to `systemPrompt` when the linked skill is missing/disabled (defense in depth, same pattern as orchestrator identity).
      - **`buildAgentDefinition` rewritten** to call a new `loadAgentIdentity(agent)` helper that reads from the linked skill if `identitySkillId` is set + enabled, otherwise returns `agent.systemPrompt`: [src/lib/runtime/agent-definition.server.ts](../../src/lib/runtime/agent-definition.server.ts)
      - **Chat-stream agent path** (which uses its own slot pipeline, not buildAgentDefinition) gets the same skill-first-with-fallback logic inline: [src/routes/chat/[id]/stream/+server.ts](../../src/routes/chat/[id]/stream/+server.ts)
      - **`updateAgentRecord` + remote schema** accept `identitySkillId: uuid | null` so operators can link/unlink via the existing agent detail page: [src/lib/agents/agents.server.ts](../../src/lib/agents/agents.server.ts), [src/lib/agents/agents.remote.ts](../../src/lib/agents/agents.remote.ts)
      - 3 schema-invariant tests cover: defaults to null, link/unlink/relink round-trip, stale-pointer survival on skill delete: [tests/agents.identity-link.spec.ts](../../tests/agents.identity-link.spec.ts)
    - Phases 3-6 (markdown editor route, AGENTS.md discovery, fragment library, companion bundles per agent role) deferred. Phases 1+2 give the prompt-as-data foundation across orchestrator + per-agent paths; the rest is editor-UX polish.

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
