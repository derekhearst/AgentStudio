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
| `source`    | text      | Logical source: `chat`, `agent_planner`, `agent_synthesis`, `subagent`, `titlegen`, `image_gen`, `memory_*`, `tts` |
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

### What a chat turn records

Each chat turn writes one `llm_usage` row, and the same figures go on the assistant message and into the conversation's totals. That row covers **this turn and everything it did**:

- **Every model call counts.** The main agent's calls, the calls of any subagent it handed work to, and the calls the agent makes to compress a long conversation. Before 2026-09-23 only the main agent was counted, so a turn that delegated its heavy lifting looked almost free.
- **Only this turn counts.** A conversation keeps one agent session across all its turns, and the agent reports usage as a running total for that whole session. The turn's figure is that running total minus the running total at the end of the previous turn, which is saved with the previous reply (`metadata.sessionUsage` on the assistant message). Before 2026-09-23 the running total itself was logged, so turn five recorded turns one to five again — and budget limits, which add these rows up, blocked users long before they had really spent the limit.
- **Claude models** run on the Claude Code subscription: tokens are recorded and the cost is always zero. **Gateway models** record the agent's own cost estimate for the turn.

Edge cases:

| Situation | What is recorded |
| --- | --- |
| First turn of a conversation | The whole running total — it is all this turn |
| No previous total to subtract (an older conversation's first turn after this change, or a session the agent forked) | Only the main agent's tokens; a gateway turn is priced from the model price table. Delegated work is undercounted once, rather than every earlier turn being counted again |
| The running total went down (the session's history had no totals saved) | The reported figure, as this turn's own |
| A turn that failed before its reply was saved | Nothing for that turn; its usage is included in the next turn's figure |

### Delegated children (#32)

A turn that handed work to other agents writes one extra row for each child that spent anything, with source `subagent`. The turn's total does not change: the children's share is moved out of the parent's row onto their own.

| Field | Value on a child's row |
| --- | --- |
| `source` | `subagent` |
| `runId` | The parent's run, so cost per run still adds up in one query |
| `agentId` | The child's own agent. A child with no agent row of ours (the SDK's built-in helper agents) is charged to the parent's agent |
| `model` | The model the child ended on, else the parent's |
| Tokens | Everything the child's model calls used, added up (see below) |
| `cost` | Zero on the Claude subscription, like the parent's row. On the gateway, priced from the model catalogue |
| `metadata` | `conversationId`, `toolUseId` (the delegation call), `subagentType`, `sdkAgentId`, `subscription`, `status` (how the child ended), `usageBasis` and, when the calls were counted, `modelCalls` |

How the numbers fit together:

1. The SDK reports the whole turn's usage, children included, in the result's per-model totals. That is the turn figure described above.
2. The app adds up each child's own spend as the child works. Every model call the child makes reaches the app with its token counts, and the app adds them up per child, counting each call once. `usageBasis` is `model_calls` for such a row.
3. The SDK's own per-child figure is not used on its own. In the installed SDK (bundled CLI 2.1.278), the usage in a child's result is only its **last model call**, not everything it spent. A child that made 30 calls would be charged for one. The app uses that figure alone only when it saw none of the child's calls, and then `usageBasis` is `final_call`.
4. Each child's tokens (and, on the gateway, its cost) are subtracted from the parent's `chat` row. Nothing is counted twice. If a figure ever comes up short, the difference stays on the parent's row, which is where all of it was before.
5. When the turn figure is the main agent's alone (a resumed session with no previous total to subtract), the children were never in it, so their rows are added rather than carved out.
6. A child that failed or was stopped partway still gets a row for what it spent before it ended. A child that was refused before it started spent nothing and gets no row.
7. A child's row is written as soon as the child finishes, not when the turn ends. The parent's row is written when the turn ends, as before.

The assistant message and the conversation total still show the whole turn: the parent's row plus its children's. The child's cost and token count are also shown on its card in the chat.

What changes for anyone reading the ledger: agent-scoped budget limits now see what an agent spent as a delegate, and `/activity` shows `subagent` as a source.

### Calls the ledger cannot price

Model calls made through OpenRouter (research, memory, reranking, monitors, the evaluator) are priced from OpenRouter's model catalogue, which the app downloads once an hour. The app stores Anthropic models the way the Agent SDK names them (`claude-sonnet-5`); OpenRouter lists them as `anthropic/claude-sonnet-5`, so every OpenRouter call and every price lookup translates the name first (see [../llm/spec.md](../llm/spec.md)).

If a call cannot be priced, the ledger says so rather than recording it as free:

| Situation | What happens |
| --- | --- |
| The hourly catalogue download fails, but an earlier copy exists | The earlier copy keeps pricing calls. The download is tried again in five minutes |
| No copy has ever loaded | The call is written with cost 0 and `metadata.unpriced = 'catalogue_unavailable'`. The download is tried again in a minute |
| The model is not in the catalogue | The call is written with cost 0 and `metadata.unpriced = 'model_not_in_catalogue'` |

Each unpriced case logs a warning, at most once an hour per model and reason. No price is ever guessed. The cost summary counts unpriced calls, and /review says how many calls are missing from its total. Before 2026-09-23 both cases wrote cost 0 with no flag and no log, so the calls were invisible to budget limits.

### What read-aloud records

Each chunk of a reply read aloud writes one row with source `tts` (shown as "Read Aloud"). Speech is billed per character and OpenRouter sends no cost with the audio, so the cost is characters × the model's per-character price from OpenRouter's speech catalogue, and `tokensIn` holds the character count. A model the catalogue does not price, or a chunk read while the speech catalogue cannot be fetched, is recorded at $0 with `metadata.priced = false` and the same `metadata.unpriced` reason as any other unpriced call (above), so /review counts it among the calls missing from its total. Read-aloud is checked against budget limits before each chunk, like a chat turn, and records the same budget alerts: a warning at a limit's warning line and a block alert when a limit refuses a chunk. A chunk the listener stopped after OpenRouter already had it is still finished and recorded, because OpenRouter charges for it either way. See [../speech/speech.md](../speech/speech.md).

### Tool-call cost tracking

When a tool call invokes a paid external service (web search, browser, code execution), the tool wrapper emits a `tool_usage` row with the estimated cost. Costs default to configured per-unit estimates and can be overridden by actual provider-returned cost if available.

**Image and video generation** record their spend in `tool_usage` too, so budget limits and the cost pages count it:

- A generated image with a cost writes one `image_generate` credit row. (Before 2026-09-23 the cost was kept on the image only.)
- A video job writes a `video_generate` row with `metadata.costStatus = 'pending'` when it is submitted. The first thing to see the job end fills in the cost: the tool itself, the `/api/video-jobs` status page, or the `video_cost_reconcile` job, which checks pending jobs every ten minutes. A row is only ever settled once. A job that completes without a reported cost is marked unpriced. A job nobody sees finish within 48 hours is marked `abandoned` and a warning is logged. (Before, a job that outlasted the tool's wait was billed and never recorded.)

### Tool-call counts

Every tool call a chat turn makes — reading a file, editing one, running a command — also writes a `tool_usage` row with unit `call` and a cost of **$0**. These rows record that the call happened (and, for edits and commands, which file or command), not what it cost: a local call spends no money, and its real price is the tokens already counted for the turn. Because budget limits add up `cost`, these rows can never move a limit. A paid tool writes both a `call` row and a row carrying its spend; anything that counts calls counts only the `call` rows.

Not yet counted: tool calls made through the older agent loop, which agent-attached automations, monitor actions and PR fixes still use.

### Usage strip and weekly digest (#38)

The usage strip on `/activity` and the optional weekly usage digest are built from these ledgers; see [../activity/spec.md](../activity/spec.md#usage-strip-and-weekly-digest) for what they show. Four things about them belong to this domain:

- **Tokens lead, dollars are "metered".** Claude runs record $0 (above), so the digest reports tokens first and labels dollars as metered spend — what gateway models, OpenRouter calls and paid tools charged.
- **Budget headroom reads spend the way enforcement does.** The strip's Budget tile uses the same per-limit spend calculation as the check that blocks runs, over the same period, so the two cannot disagree. It only shows limits that enforcement applies: global limits, and agent limits that name an agent. Per-run limits, project limits (nothing enforces those yet) and agent limits with no agent are left out. The Settings → Budget daily and monthly limits are among them (see below); the tile brings them up to date with Settings before it reads, as the check does.
- **Budget limits do not block the digest.** It spends nothing, so the automation budget check is skipped for it; that way it can still report a limit that is blocking everything else.
- **The digest itself costs nothing.** It is rendered by code with no model call and records a run cost of $0.

### Cost summary

The existing `getCostSummary` query is extended to support:

- Breakdown by `runId` — "most expensive runs this month"
- Breakdown by `agentId` — "most expensive agents this month"
- Breakdown by `taskId` — "cost per task"
- Combined LLM + tool spend for total cost

### Budget limit enforcement

Before starting a new run (or before a new LLM call inside a run), the system checks whether any applicable budget limit would be exceeded.

**Hard limit** — configured by setting `limitUsd` and `enabled = true` on a `budget_limits` row. When `enabled = false`, the row is stored but not enforced; the user can toggle it back on without recreating it. When `action = 'block'` and the projected spend would exceed `limitUsd`, the run is rejected with a clear error and a `budget_exceeded` review item is created in the observability inbox.

**Soft cap (warn threshold)** — configured by setting `warnUsd` on the same row (can exist without a hard limit by setting `action = 'notify_only'`). When current spend crosses `warnUsd`, a notification fires but the run is allowed to proceed. A `budget_alerts` row is written for the warn event.

**Limits from Settings → Budget** — the daily and monthly limits on the Settings page are budget limits like any other. Each becomes a global `block` limit for its period with a warning at 80% of the limit. The server keeps these rows in step with the Settings fields whenever settings are saved or reset, and before every budget check. It only touches the rows it created (their ids are kept in the settings' `budgetConfig.limitIds`). Clearing a limit in Settings switches its row off instead of deleting it, so the alert history stays. A settings save waits while the server is recording a new limit row, so saving settings at the same moment a chat checks its budget never loses track of that row. A lost row would go on blocking at its old amount after the limit was raised or cleared. Before 2026-09-23 the Settings limits were only drawn as progress bars in /review, and nothing enforced them.

**Delegated children (#32)** — each child an agent hands work to is checked before it starts, with the same check a chat turn passes, scoped to the child's own agent. The parent's check only looked at the parent's agent, so without this a fan-out could walk straight through a limit set on the agents it delegates to. A blocked child records the same alert and review item a blocked chat does, and the parent is told the budget is exhausted and not to retry. A check that fails or takes longer than 10 seconds refuses the child.

What the check counts: everything spent before the turn, plus every child of this turn that has already finished, because a child's ledger row is written the moment it finishes. So an agent that hands out work in waves (four children, then four more, and so on) is stopped once the finished waves have reached the limit, not only on its next turn. Two things are not counted yet when a child is checked: its siblings that are still running, and the parent's own model calls in this turn, whose row is written when the turn ends. A single wave can therefore go past a limit by what that wave spends. On the Claude subscription every row costs $0, so a dollar limit never blocks a child there.

Enforcement order: `run` → `agent` → `project` → `global`. The most restrictive blocking limit among all active limits wins. Warn thresholds are evaluated independently, so several limits can warn at the same check. Each one still alerts only once per period (see below).

A hard limit with `action = 'block'` **does not interrupt a run already in progress** — the check happens at run-start and at each new LLM call initiation. If the limit is crossed mid-run, no new LLM calls are made after the threshold is detected, and the run fails with a `budget_exceeded` error.

### Budget alert notifications

When a limit reaches its warning level or its limit, a `budget_alerts` row is written and the user is notified in the app and by push. Each alert is written, and notified, once per limit, kind (warn or block) and period, however many runs are checked after it. Chat runs, automation runs and read-aloud all record warnings, and a block alert when a limit refuses them. Budget alerts are sent whatever the notification switches in Settings say: the user turns them off by clearing the limit.

A block alert records the spend that tripped the limit. Before 2026-09-23 both callers recorded the limit itself, so every block alert said spend and limit were equal and hid how far over it went.

The /review spend bars count tool spend as well as model spend, the same total the limits are checked against.

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

What is enforced today: the cost summary and the day/month budget status require signing in. They report the whole instance's spend rather than one user's, on purpose — background work such as embeddings, title generation and memory mining records usage with no user attached, so a per-user filter would under-report the real bill, and AgentStudio has a single owner. Budget limits and alerts are per user.

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
- [../observability/spec.md](../observability/spec.md) — `budget_exceeded` review items are written to the observability inbox; run traces show per-call cost inline
