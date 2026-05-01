# Observability Spec

## Overview

The observability domain captures everything that happens in AgentStudio at an operational level: traces of every run, cost and latency metrics, policy decisions, job health, and hook invocations. It also hosts the unified Review Inbox — a single queue where humans handle everything waiting on their attention: tool approvals, user questions, evaluator failures, stuck jobs, artifact conflicts, policy override requests, and memory conflicts.

## Data Model

### `runTraces` table

A normalized step timeline for each run, optimized for display and querying.

| Column       | Type       | Description                                                                         |
| ------------ | ---------- | ----------------------------------------------------------------------------------- |
| `id`         | uuid       | Primary key                                                                         |
| `runId`      | uuid       | FK to `runs`                                                                        |
| `sessionId`  | uuid       | FK to `sessions`                                                                    |
| `taskId`     | uuid?      | FK to `tasks`                                                                       |
| `jobId`      | uuid?      | FK to `jobs`                                                                        |
| `trace`      | jsonb      | Normalized step timeline: `[{type, name, startMs, endMs, tokens, costUsd, error?}]` |
| `startedAt`  | timestamp  |                                                                                     |
| `finishedAt` | timestamp? |                                                                                     |
| `status`     | enum       | `running`, `completed`, `failed`, `canceled`                                        |

### `reviewItems` table

The Review Inbox. Every human-required action creates a row here.

| Column       | Type       | Description                                                                                                                                                              |
| ------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`         | uuid       | Primary key                                                                                                                                                              |
| `type`       | enum       | `approval_request`, `user_question`, `evaluation_failure`, `job_failure`, `job_stuck`, `hook_failure`, `artifact_conflict`, `memory_conflict`, `policy_override_request` |
| `status`     | enum       | `open`, `in_progress`, `resolved`, `dismissed`                                                                                                                           |
| `severity`   | enum       | `info`, `warning`, `critical`                                                                                                                                            |
| `runId`      | uuid?      | FK to `runs`                                                                                                                                                             |
| `sessionId`  | uuid?      | FK to `sessions`                                                                                                                                                         |
| `taskId`     | uuid?      | FK to `tasks`                                                                                                                                                            |
| `jobId`      | uuid?      | FK to `jobs`                                                                                                                                                             |
| `projectId`  | uuid?      | FK to `projects`                                                                                                                                                         |
| `artifactId` | uuid?      | FK to `artifacts`                                                                                                                                                        |
| `payload`    | jsonb      | Type-specific context and data needed to resolve the item                                                                                                                |
| `assignedTo` | uuid?      | FK to `users` — optional assignment                                                                                                                                      |
| `resolvedBy` | uuid?      | FK to `users`                                                                                                                                                            |
| `resolvedAt` | timestamp? |                                                                                                                                                                          |
| `createdAt`  | timestamp  |                                                                                                                                                                          |
| `updatedAt`  | timestamp  |                                                                                                                                                                          |

### `operationalMetrics` table

Time-series metrics storage. Rolled up from run events, job logs, and hook invocations.

| Column       | Type      | Description                                          |
| ------------ | --------- | ---------------------------------------------------- |
| `id`         | uuid      | Primary key                                          |
| `metric`     | text      | Metric name (e.g., `run.cost_usd`, `job.latency_ms`) |
| `dimension`  | jsonb     | Dimension labels (agentId, jobType, queue, etc.)     |
| `value`      | numeric   | Metric value                                         |
| `measuredAt` | timestamp | Measurement timestamp                                |

## Features

### Unified Review Inbox

`/review` is the primary inbox for human-required actions. Items are sorted by severity (critical first) then by age. The inbox unifies:

| Item type                 | Severity | Triggered by                                             |
| ------------------------- | -------- | -------------------------------------------------------- |
| `approval_request`        | critical | Tool call requires human approval                        |
| `user_question`           | critical | `ask_user` tool call waiting for answer                  |
| `evaluation_failure`      | warning  | Evaluator returned `fail` verdict                        |
| `job_failure`             | warning  | Job exhausted all retry attempts                         |
| `job_stuck`               | warning  | Job in `running` state with expired lease                |
| `hook_failure`            | info     | A hook invocation returned an error                      |
| `artifact_conflict`       | warning  | Two runs attempted concurrent artifact edits             |
| `memory_conflict`         | info     | Memory mining produced a conflicting entity/relation     |
| `policy_override_request` | critical | An actor requested a policy exception requiring approval |

### Inbox actions

Each item type has a resolution action appropriate to the item:

- **Approval request** — Approve or Deny buttons with optional comment. Resolution unblocks the run.
- **User question** — Text input area to answer the agent's questions. Resolution unblocks the run.
- **Evaluation failure** — View findings, choose: Retry task (spawns new attempt), Mark resolved (accept failure), Override to passed.
- **Job failure** — View error, choose: Retry job, Cancel job, Dismiss.
- **Artifact conflict** — View both versions, choose which to keep, merge manually, or open the artifact editor.

### Run traces

`/runs/[id]/trace` shows the step timeline for a run: each LLM call (with token counts and cost), each tool call (with duration and success/failure), each compaction event, and each hook invocation. Timeline is scrollable and expandable.

### Operational dashboard

`/observability` shows:

- Active runs count by status
- Recent run costs (last 24h, 7d, 30d)
- Job queue depths by queue name
- Hook invocation failure rates
- Average run latency by agent
- Policy decision breakdown (allow/deny/approval rates)

### Cost tracking

Every LLM call, embedding call, and memory mining pass is attributed to a `runId` and aggregated into `runs.costUsd`. The cost dashboard shows:

- Total cost by user, agent, and model
- Cost per run and cost per task
- Day-over-day change
- Top 10 most expensive runs in the last 7 days

### Metric collection

Metrics are written by:

- The runtime (after each LLM call: tokens in, tokens out, cost, latency)
- The jobs worker (after each job: latency, success/failure)
- The hooks system (after each hook invocation: latency, success/failure)
- The policy engine (each decision: allow/deny/approval)

Raw `run_events` are the source of truth; `operationalMetrics` is a pre-aggregated read view.

### Notification routing

Review items with severity `critical` trigger a notification:

- In-app badge on the `/review` nav item
- (Optionally) webhook or email notification based on user settings

## Behavior Contracts

- `reviewItems` rows are never deleted; they are resolved or dismissed. The full history is always available.
- A `critical` review item that is unresolved for longer than the configured SLA threshold escalates to admin notification.
- `runTraces` are built from `run_events` by a background job after the run completes. They may lag by seconds after run completion.
- `operationalMetrics` rows are retained for 90 days by default (configurable per metric).
- Dismissing a review item does not take the associated action — it only removes it from the open inbox. A dismissed approval request means the tool call is denied.

## Roles & Permissions

| Action                              | Who can do it      |
| ----------------------------------- | ------------------ |
| View own review inbox               | Authenticated user |
| Resolve own approval/question items | Owner user, admin  |
| View all open items                 | Admin only         |
| Resolve items assigned to others    | Admin only         |
| View run traces                     | Run owner, admin   |
| View operational dashboard          | Admin only         |
| View cost breakdown (own)           | Authenticated user |
| View cost breakdown (all users)     | Admin only         |

## References

- [The Anatomy of an Agent Harness — LangChain](https://blog.langchain.com/the-anatomy-of-an-agent-harness/) — observability as a harness primitive
- [Harness Engineering Is Cybernetics — George](https://x.com/odysseus0z/article/2030416758138634583) — sensing and feedback loops
- [Oh My Codex — HUD pattern](https://github.com/Yeachan-Heo/oh-my-codex) — unified status + action surface
- [Hive — aden-hive](https://github.com/aden-hive/hive) — outcome-driven checkpoints and review
- **Internal:** `src/lib/observability/observability.schema.ts`, `src/lib/activity/activity.server.ts`, `src/routes/review/`, `src/routes/observability/`
