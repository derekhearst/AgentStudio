# Jobs Spec

## Overview

The jobs domain is AgentStudio's durable background execution queue. It decouples the decision to do work from the request lifecycle that triggered it. Any feature that needs to run asynchronously, retry on failure, limit concurrency, or survive a process restart uses jobs: agent runs spawned from automations, memory mining, evaluation passes, workspace GC, artifact post-processing, and hook dispatches.

## Data Model

### `jobs` table

| Column           | Type       | Description                                                                                                                                |
| ---------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`             | uuid       | Primary key                                                                                                                                |
| `type`           | enum       | `run_execute`, `run_resume`, `task_dispatch`, `memory_mine`, `evaluation_execute`, `workspace_gc`, `artifact_postprocess`, `hook_dispatch` |
| `status`         | enum       | `pending`, `leased`, `running`, `retry_wait`, `completed`, `failed`, `canceled`                                                            |
| `priority`       | integer    | Lower = higher priority (default: 100)                                                                                                     |
| `queue`          | text       | `latency`, `default`, `bulk`, `maintenance`                                                                                                |
| `dedupeKey`      | text?      | If set, prevents duplicate jobs with the same key from being enqueued                                                                      |
| `scheduledAt`    | timestamp  | Earliest time the job can be picked up                                                                                                     |
| `leaseExpiresAt` | timestamp? | When the current lease expires; a worker that misses this loses the job                                                                    |
| `startedAt`      | timestamp? |                                                                                                                                            |
| `finishedAt`     | timestamp? |                                                                                                                                            |
| `attemptCount`   | integer    | Number of times this job has been attempted                                                                                                |
| `maxAttempts`    | integer    | Maximum allowed attempts before marking failed (default: 3)                                                                                |
| `payload`        | jsonb      | Job-type-specific input data                                                                                                               |
| `result`         | jsonb?     | Output from the last successful attempt                                                                                                    |
| `error`          | jsonb?     | Error details from the last failed attempt                                                                                                 |
| `runId`          | uuid?      | FK to `runs` — if job is executing a run                                                                                                   |
| `taskId`         | uuid?      | FK to `tasks` — if job is dispatching a task                                                                                               |
| `sessionId`      | uuid?      | FK to `sessions`                                                                                                                           |
| `projectId`      | uuid?      | FK to `projects`                                                                                                                           |
| `userId`         | uuid?      | FK to `users` — owner/initiator                                                                                                            |
| `createdAt`      | timestamp  |                                                                                                                                            |
| `updatedAt`      | timestamp  |                                                                                                                                            |

### `jobPolicies` table

Per-type retry and concurrency configuration.

| Column             | Type     | Description                                                   |
| ------------------ | -------- | ------------------------------------------------------------- |
| `id`               | uuid     | Primary key                                                   |
| `jobType`          | text     | Matches `jobs.type`                                           |
| `maxAttempts`      | integer  | Override for this job type                                    |
| `backoffMs`        | integer  | Initial backoff delay; doubles on each retry                  |
| `concurrencyKey`   | text?    | Template for grouping concurrent jobs (e.g., `user:{userId}`) |
| `concurrencyLimit` | integer? | Max simultaneous jobs with the same concurrency key           |
| `timeoutMs`        | integer  | Max execution time before the lease is expired                |

### `jobLeases` table

Lease records for in-flight jobs, used for distributed worker coordination.

| Column        | Type      | Description                               |
| ------------- | --------- | ----------------------------------------- |
| `id`          | uuid      | Primary key                               |
| `jobId`       | uuid      | FK to `jobs`                              |
| `workerId`    | text      | Identifier of the worker process          |
| `leasedAt`    | timestamp | When the lease was acquired               |
| `expiresAt`   | timestamp | When the lease must be renewed or expires |
| `heartbeatAt` | timestamp | Last heartbeat from the worker            |

## Features

### Four queues

| Queue         | Purpose                                           | Concurrency |
| ------------- | ------------------------------------------------- | ----------- |
| `latency`     | User-facing real-time runs and task dispatches    | High        |
| `default`     | Standard work: evaluation passes, hook dispatches | Medium      |
| `bulk`        | Memory mining, artifact post-processing           | Low         |
| `maintenance` | Workspace GC, metrics rollup                      | 1 at a time |

Workers pick from queues in priority order within each queue.

### Lease-based dequeue

A worker acquires a job by setting `status = leased` and writing a `jobLeases` row. The lease has a TTL. If the worker crashes or hangs, the lease expires and another worker picks up the job on the next scan. This prevents jobs from being stuck due to worker failure.

Workers renew their lease via heartbeat while the job is running.

### Retry with exponential backoff

When a job fails:

1. `attemptCount` is incremented
2. If `attemptCount < maxAttempts`: status → `retry_wait`, `scheduledAt` is set to `now() + backoffMs * 2^(attemptCount-1)`
3. If `attemptCount >= maxAttempts`: status → `failed`, a review item is created in the observability inbox

### Deduplication

Jobs with a `dedupeKey` are deduplicated at enqueue time. If a job with the same `dedupeKey` and a non-terminal status already exists, the new enqueue is a no-op and returns the existing job ID. Prevents double-mining a conversation when two hooks fire in quick succession.

### Concurrency limits

`jobPolicies.concurrencyKey` is a template string (`user:{userId}`, `session:{sessionId}`, etc.) that is expanded per job. Before leasing a job, the worker checks how many other jobs with the same expanded key are currently `leased` or `running`. If the count meets `concurrencyLimit`, the job waits.

### Job types

| Type                   | Triggered by                                 | Does                                              |
| ---------------------- | -------------------------------------------- | ------------------------------------------------- |
| `run_execute`          | Task dispatch, automation trigger            | Starts a new agent run via `runAgentLoop`         |
| `run_resume`           | Stale run recovery                           | Resumes a stuck run from its last cursor          |
| `task_dispatch`        | Orchestrator `propose_plan` approval         | Creates and dispatches child runs for a task      |
| `memory_mine`          | `after_run` built-in hook                    | Mines a completed session into memory wings       |
| `evaluation_execute`   | Run completion with `evalRequired`           | Runs an evaluator agent against the completed run |
| `workspace_gc`         | Daily schedule                               | Deletes expired ephemeral workspaces              |
| `artifact_postprocess` | `save_artifact` tool call                    | Generates embeddings, thumbnails, or summaries    |
| `hook_dispatch`        | Any hook event with a skill-based subscriber | Runs the hook skill as a subagent                 |

### Job management UI

`/jobs` — admin view of all jobs with filters by type, status, queue, user. Shows attempt count, last error, and scheduled time.
`/jobs/[id]` — job detail with payload, result, error, lease history, and linked run/task/session.

## Behavior Contracts

- A job in a terminal state (`completed`, `failed`, `canceled`) is never re-enqueued; a new job must be created.
- `jobs.status` transitions are one-way: `pending` → `leased` → `running` → (`retry_wait` | `completed` | `failed` | `canceled`). `retry_wait` → `pending` is the only backward transition.
- Deduplication is best-effort at enqueue time. If two workers try to lease the same job simultaneously, the database lease constraint prevents double-execution.
- A job's `payload` is immutable after creation. Retry attempts use the same payload.
- `canceled` jobs are soft-stopped: if a worker is already executing the job, it will finish the current execution unit but not commit a result.

## Roles & Permissions

| Action                    | Who can do it      |
| ------------------------- | ------------------ |
| View job queue (own jobs) | Authenticated user |
| View all jobs             | Admin only         |
| Cancel a pending job      | Owner user, admin  |
| Retry a failed job        | Admin only         |
| Adjust job policies       | Admin only         |

## Rewrite Authority

The current implementation is a baseline, not a constraint. This domain may be rewritten, restyled, reorganized, or replaced as needed to achieve the target product quality. No code path is off-limits if behavior contracts, safety controls, tests, and documentation remain correct.

## UI Contract

This domain follows the shared UX system in [../ui/spec.md](../ui/spec.md).

- Surfaces in this domain must align with the shared desktop/mobile shell patterns.
- Domain-specific states must be explicit in the UI (for example pending, running, blocked, completed) where applicable.
- Blocking user decisions must use the shared action-card and inbox patterns where applicable.

## References
- [LangGraph — LangChain](https://github.com/langchain-ai/langgraph) — durable checkpointed execution
- [Hive — aden-hive](https://github.com/aden-hive/hive) — outcome-driven task scheduling
- [Building Effective Agents — Anthropic](https://www.anthropic.com/research/building-effective-agents) — background execution patterns
- **Internal:** `src/lib/jobs/jobs.schema.ts`, `src/lib/jobs/jobs.server.ts`, `src/lib/jobs/worker.server.ts`, `src/routes/jobs/`

