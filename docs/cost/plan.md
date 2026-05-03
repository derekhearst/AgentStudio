# Cost Plan

Status: active

> **See also:** [spec.md](spec.md)

## Goal

Extend the existing `llm_usage` cost tracking so every dollar spent is traceable to a run, task, and agent. Add budget limits with enforcement. Add tool-call cost tracking. Deliver a complete cost dashboard.

## Current State

- `llm_usage` table exists with `source`, `model`, `tokensIn`, `tokensOut`, `cost`, `metadata`
- `logLlmUsage()` auto-prices from OpenRouter model catalog
- `getCostSummary` query with daily/weekly/monthly breakdowns by model and source
- `/cost` route exists but shows only model/source-level data
- No `runId`/`taskId`/`agentId` linkage
- No budget limits
- No tool-call cost tracking

## Phase 1 — Run/Task/Agent linkage (highest value)

**Goal:** Every LLM usage row is traceable to a run, task, and agent.

### 1.1 Schema migration

Add nullable columns to `llm_usage`:

```sql
ALTER TABLE llm_usage ADD COLUMN user_id uuid REFERENCES users(id);
ALTER TABLE llm_usage ADD COLUMN run_id uuid REFERENCES runs(id);
ALTER TABLE llm_usage ADD COLUMN task_id uuid REFERENCES tasks(id);
ALTER TABLE llm_usage ADD COLUMN agent_id uuid REFERENCES agents(id);
```

Add indexes on `run_id`, `task_id`, `agent_id` for query performance.

### 1.2 Schema file update

Update `usage.schema.ts` to add the four columns.

### 1.3 `logLlmUsage` update

Extend `LogInput` type with optional `userId`, `runId`, `taskId`, `agentId`. Pass through to the insert.

### 1.4 Call-site updates

Update every `logLlmUsage` call in the codebase to pass the available context:

- Agent/run execution paths pass `runId` + `agentId`
- Task-triggered runs also pass `taskId`
- Chat calls pass `userId`

### 1.5 Query updates

Extend `getCostSummary` to include:

- `byRun` — top N most expensive runs this period
- `byAgent` — spend per agent
- `byTask` — spend per task

## Phase 2 — Tool-call cost tracking

**Goal:** External tool costs (web search, browser, code execution) appear in the ledger.

### 2.1 `tool_usage` table

Create schema and migration for `tool_usage` (columns per spec).

### 2.2 `logToolUsage()` function

Mirror of `logLlmUsage` for tool calls. Accepts `toolName`, `unitType`, `units`, `cost` (or `costPerUnit` + computed), plus the same `runId`/`taskId`/`agentId` context.

### 2.3 Tool wrapper integration

Identify tools with real external costs and add `logToolUsage` calls in their wrappers. Start with:

- `web_search`
- `browser`
- `code_exec` (if metered)

### 2.4 Combined cost totals

Update `getCostSummary` to `UNION ALL` both tables so total spend = LLM + tools.

## Phase 3 — Budget limits

**Goal:** Users can set spending caps that the system enforces.

### 3.1 Schema

Create `budget_limits` and `budget_alerts` tables (per spec).

### 3.2 Budget check function

`checkBudgetLimits({ userId, projectId?, agentId?, estimatedCost })`:

1. Load all enabled limits for the user (global + project + agent)
2. For each, compute period spend from `llm_usage` + `tool_usage`
3. Return `{ allowed: boolean, warningsTriggered: BudgetLimit[], blockedBy: BudgetLimit | null }`

### 3.3 Pre-run enforcement

Call `checkBudgetLimits` before a new run is dispatched. If `allowed = false`, mark the run as `blocked` and surface in the Review Inbox.

### 3.4 Alert logging + notifications

When a warn or block threshold fires:

- Insert `budget_alerts` row
- Emit a notification via the notifications domain

### 3.5 Budget CRUD remote functions

- `getBudgetLimits` — list user's limits
- `createBudgetLimit` — create new limit
- `updateBudgetLimit` — change threshold or action
- `deleteBudgetLimit` — disable/remove limit

## Phase 4 — Dashboard improvements

**Goal:** `/cost` route shows the full picture.

### 4.1 Run / agent / task drill-down

Add tabs or expandable sections to the cost page showing:

- Top 10 most expensive runs
- Top 10 most expensive agents
- Per-task cost if tasks are enabled

### 4.2 Budget limit UI

On the cost page, show each budget limit with:

- Current period spend vs. limit (progress bar)
- Warn threshold indicator
- Edit / delete actions

### 4.3 Alert history

Show recent `budget_alerts` rows with timestamp, threshold type, and spend at trigger.

### 4.4 CSV export

Add an export button that downloads the period's `llm_usage` + `tool_usage` as CSV.

## Phase 5 — Provider reconciliation (future)

Import actual OpenRouter billing data via their API and compare against internal `llm_usage` estimates. Surface discrepancies in the cost dashboard. Not required for v1.

## Acceptance Criteria

- [ ] `llm_usage` has `runId`, `taskId`, `agentId`, `userId` columns populated by all call sites
- [ ] `tool_usage` table exists and is written to by tool wrappers with external costs
- [ ] `getCostSummary` returns combined LLM + tool spend, with per-run and per-agent breakdowns
- [ ] Budget limits can be created, edited, and deleted from the UI
- [ ] A run is blocked (not started) if a `block` budget limit would be exceeded
- [ ] Budget warn/block events create `budget_alerts` rows and fire notifications
- [ ] `/cost` dashboard shows run-level and agent-level breakdowns
- [ ] CSV export works for any selected period

## Rewrite Authority

The current implementation is a baseline, not a constraint. This domain may be rewritten, restyled, reorganized, or replaced as needed to achieve the target product quality. No code path is off-limits if behavior contracts, safety controls, tests, and documentation remain correct.

## UI Contract

Implementation in this domain must comply with [../ui/plan.md](../ui/plan.md) and [../ui/spec.md](../ui/spec.md).

- Include UX acceptance criteria for desktop and mobile behavior.
- Include compactness/density behavior where relevant.
- Include approval, question, and interruption flows where relevant.

## Completion
- Template: YYYY-MM-DD - Completed in <PR/commit> - <one-line outcome>
- 2026-05-02 — Phase 1 (run/task/agent/user linkage on `llm_usage`) shipped on branch `claude/nervous-kapitsa-18255e`. Schema gained `user_id` (FK users), `run_id` (FK chat_runs), `agent_id` (FK agents), and `task_id` (no FK yet — back-populated when item #11 lands), all on-delete-set-null with btree indexes. `LogInput` accepts the four optional fields; `logLlmUsage` writes them through. Chat stream, inline sub-agent, and automation engine call sites now pass full context. `getCostSummary` returns three new rollups: top runs, top agents, top tasks. Memory-side call sites (embeddings/mining/rerank) and title-gen still pass null IDs — plumbing those will require signature changes up the call chain and is left to a follow-up.
- 2026-05-02 — Phase 2 (tool-usage ledger) shipped on branch `claude/nervous-kapitsa-18255e`. New `tool_usage` table mirroring `llm_usage`'s context FKs (user/run/agent/task) plus `tool_name`, optional `provider`, `unit_type` (credit/second/call/mb), `units`, `cost`, freeform metadata, and indexes for all the rollup paths. New `logToolUsage(input)` helper accepts either a direct `cost` or computes from `units * costPerUnit`. `getCostSummary` extended with `toolSpend`, `toolCallCount`, `byTool` (per-tool/provider/unit-type breakdown), and a `combinedSpend` total = LLM + tool. No tool wrappers are instrumented yet — that's a per-tool opt-in (web_search/browser/code_exec) when their per-unit costs are known. Phases 3-5 (budget limits, dashboard UI, provider reconciliation) still pending.



