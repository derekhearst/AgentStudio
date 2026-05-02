# Cost & Usage Metering Spec

## Overview

The cost domain tracks every token spent, every billable tool call made, and every dollar consumed by AgentStudio. It is the financial ledger of the system — giving users a clear picture of where money goes (which agents, which runs, which models), and giving the system the data it needs to enforce budget limits, fire alerts, and eventually enable billing if self-hosted AgentStudio is distributed as a service.

The current foundation (`llm_usage` table + cost summary query) tracks LLM spend per source and model. The gaps are: no linkage to the run or task that caused the spend, no budget caps, no alerting, and no tracking of external non-LLM costs. This spec extends that foundation.

## Data Model

### `llm_usage` table (existing, extended)

| Column      | Type      | Notes                                                                                                       |
| ----------- | --------- | ----------------------------------------------------------------------------------------------------------- |
| `id`        | uuid      | Primary key                                                                                                 |
| `userId`    | uuid?     | FK to `users` — owner (nullable for system-level calls)                                                     |
| `runId`     | uuid?     | FK to `runs` — which run caused this LLM call                                                               |
| `taskId`    | uuid?     | FK to `tasks` — which task the run belongs to                                                               |
| `agentId`   | uuid?     | FK to `agents` — which agent configuration was active                                                       |
| `source`    | text      | Logical source: `chat`, `agent_planner`, `agent_synthesis`, `subagent`, `titlegen`, `image_gen`, `memory_*` |
| `model`     | text      | Model ID as returned by provider                                                                            |
| `tokensIn`  | integer   | Prompt tokens                                                                                               |
| `tokensOut` | integer   | Completion tokens                                                                                           |
| `cost`      | numeric   | Computed cost in USD (18,12 precision)                                                                      |
| `metadata`  | jsonb     | Freeform context (conversation ID, tool name, etc.)                                                         |
| `createdAt` | timestamp |                                                                                                             |

### `tool_usage` table (new)

Tracks external tool-call costs that are not LLM token-based (web search credits, browser sessions, code execution minutes, etc.).

| Column      | Type      | Notes                                                          |
| ----------- | --------- | -------------------------------------------------------------- |
| `id`        | uuid      | Primary key                                                    |
| `userId`    | uuid?     | FK to `users`                                                  |
| `runId`     | uuid?     | FK to `runs`                                                   |
| `taskId`    | uuid?     | FK to `tasks`                                                  |
| `agentId`   | uuid?     | FK to `agents`                                                 |
| `toolName`  | text      | Tool identifier: `web_search`, `browser`, `code_exec`, etc.    |
| `provider`  | text?     | External provider if applicable (e.g. `serper`, `browserbase`) |
| `unitType`  | text      | `credit`, `second`, `call`, `mb`                               |
| `units`     | numeric   | Quantity consumed                                              |
| `cost`      | numeric   | Estimated cost in USD                                          |
| `metadata`  | jsonb     | Freeform                                                       |
| `createdAt` | timestamp |                                                                |

### `budget_limits` table (new)

Configurable spend caps that the system enforces before initiating new runs or LLM calls.

| Column      | Type      | Notes                                                           |
| ----------- | --------- | --------------------------------------------------------------- |
| `id`        | uuid      | Primary key                                                     |
| `userId`    | uuid      | FK to `users` — who this limit applies to                       |
| `scope`     | enum      | `global`, `project`, `agent`, `run`                             |
| `scopeId`   | uuid?     | FK to the scoped entity (project/agent/run); null for `global`  |
| `period`    | enum      | `day`, `week`, `month`, `run` — reset cadence                   |
| `limitUsd`  | numeric   | Hard cap in USD                                                 |
| `warnUsd`   | numeric?  | Optional warn threshold (fires notification but does not block) |
| `action`    | enum      | `block` or `notify_only`                                        |
| `enabled`   | boolean   | Whether this limit is currently enforced                        |
| `createdAt` | timestamp |                                                                 |
| `updatedAt` | timestamp |                                                                 |

### `budget_alerts` table (new)

Immutable log of every budget threshold event.

| Column           | Type       | Notes                                        |
| ---------------- | ---------- | -------------------------------------------- |
| `id`             | uuid       | Primary key                                  |
| `budgetLimitId`  | uuid       | FK to `budget_limits`                        |
| `userId`         | uuid       | FK to `users`                                |
| `triggerType`    | enum       | `warn`, `block`                              |
| `spendAtTrigger` | numeric    | Spend value (USD) that crossed the threshold |
| `limitUsd`       | numeric    | Limit value at time of trigger               |
| `period`         | enum       | Period that was evaluated                    |
| `resolvedAt`     | timestamp? | When the period reset or limit was raised    |
| `createdAt`      | timestamp  |                                              |

## Features

### LLM usage linkage

Every `logLlmUsage` call accepts optional `runId`, `taskId`, and `agentId`. These are passed through from the runtime execution context so that:

- Cost per run is computable from `SELECT SUM(cost) FROM llm_usage WHERE runId = ?`
- Cost per task is computable as the sum across all run IDs for the task
- Cost per agent is computable for capacity planning

The `source` field remains as a finer-grained sub-label within a run (e.g. the planner call vs. the synthesis call).

### Tool-call cost tracking

When a tool call invokes a paid external service (web search, browser, code execution), the tool wrapper emits a `tool_usage` row with the estimated cost. Costs default to configured per-unit estimates and can be overridden by actual provider-returned cost if available.

### Cost summary

The existing `getCostSummary` query is extended to support:

- Breakdown by `runId` — "most expensive runs this month"
- Breakdown by `agentId` — "most expensive agents this month"
- Breakdown by `taskId` — "cost per task"
- Combined LLM + tool spend for total cost

### Budget limit enforcement

Before starting a new run (or before a new LLM call inside a run), the system checks whether any applicable budget limit would be exceeded:

1. Compute current period spend for all limits that apply to the user/project/agent
2. If projected spend + current spend > `limitUsd` and `action` = `block`: reject with a clear error, surface in the Review Inbox
3. If projected spend + current spend > `warnUsd`: fire a notification but allow the call to proceed
4. Log a `budget_alerts` row for each threshold event

Limits are evaluated in order: `run` → `agent` → `project` → `global`. The most restrictive blocking limit wins.

### Budget alert notifications

When a limit fires, the notifications domain receives a `budget_limit_warn` or `budget_limit_block` event. This surfaces:

- A notification in the app
- Optionally a webhook if configured

### Cost dashboard

The `/cost` route shows:

- Total spend this period with period selector (day / week / month)
- Spend by model, source, agent, run, task
- Budget limits and current utilization for each
- Alert history
- Export as CSV

### Provider reconciliation (future)

A reconciliation job can import actual spend from OpenRouter (or other provider) invoices and compare against internal estimates. Discrepancies are flagged. This is tracked as a future improvement.

## Behavior Contracts

- A `budget_limit` with `action = block` prevents a run from starting if it would exceed the cap; it does not interrupt a run already in progress (runs complete once started, but no new calls are initiated after the limit is crossed mid-run).
- `budget_alerts` rows are append-only. They are never deleted.
- `tool_usage` cost values are estimates unless the provider returns an authoritative value.
- Period resets are calendar-based (UTC midnight, Monday, first of month) and do not retroactively un-block prior blocked runs.
- `llm_usage` and `tool_usage` rows are never deleted (they are the billing ledger).
- If `logLlmUsage` fails to insert, the LLM call still succeeds — cost tracking is best-effort and must not block the critical path.

## Roles & Permissions

| Action                       | Who can do it             |
| ---------------------------- | ------------------------- |
| View own cost summary        | Any authenticated user    |
| Configure own budget limits  | Any authenticated user    |
| View another user's spend    | Admin only                |
| Override or delete cost rows | Admin only (audit logged) |
| Export cost data             | Any authenticated user    |

## Rewrite Authority

The current implementation is a baseline, not a constraint. This domain may be rewritten, restyled, reorganized, or replaced as needed to achieve the target product quality. No code path is off-limits if behavior contracts, safety controls, tests, and documentation remain correct.

## UI Contract

This domain follows the shared UX system in [../ui/spec.md](../ui/spec.md).

- Surfaces in this domain must align with the shared desktop/mobile shell patterns.
- Domain-specific states must be explicit in the UI (for example pending, running, blocked, completed) where applicable.
- Blocking user decisions must use the shared action-card and inbox patterns where applicable.

## References
- [../runs/spec.md](../runs/spec.md) — run context passed to usage logging
- [../tasks/spec.md](../tasks/spec.md) — task context for cost rollups
- [../agents/spec.md](../agents/spec.md) — agent-level budget limits
- [../observability/spec.md](../observability/spec.md) — notifications and review inbox for budget alerts
- [../policies/spec.md](../policies/spec.md) — policy-driven spend controls

