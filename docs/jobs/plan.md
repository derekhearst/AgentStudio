# Jobs & Background Execution Plan

## Overview

AgentStudio can stream a run in-process, but it does not yet have a durable background execution model. That means long-running work, scheduled work, retries, resumable execution, and queued fan-out all remain fragile or tied to a single app process. Add a first-class `jobs/` domain so tasks, runs, automations, memory mining, evaluator passes, and project artifact processing can execute durably outside the request lifecycle.

> **Depends on:** `docs/structure/plan.md` (`runs/`, `tasks/`, `runtime/`), `docs/runs/plan.md` (event log + resume), `docs/projects/plan.md` (artifact edit events), `docs/memory/plan.md` (async mining jobs once memory work merges).

> **See also:** [spec.md](spec.md) — full feature spec, data model, and behavior contracts.

## Why this matters

- **Request lifecycles are the wrong place for durable work.** HTTP disconnects, app restarts, and process crashes should not kill work.
- **Agent apps need backpressure.** Without a queue, fan-out features become outages.
- **Retries and cancellation need explicit state.** These are job concerns, not runtime-loop concerns.

## Current state in AgentStudio

- Chat streaming is tied to route handlers and the app process.
- Some plans mention boot jobs or `setInterval` workers, but there is no dedicated queue model.
- Automations, evaluators, memory mining, and workspace GC all want background execution.
- Run state exists, but there is no separate scheduler/worker abstraction or retry policy table.

## Target design

### Domain boundary

`runs/` remains the durable execution record for an agent attempt.

`jobs/` is the orchestration layer that decides:
- what work should run
- when it should run
- where it should run
- whether it should retry
- how it should be canceled
- how concurrency limits are enforced

### Core tables

```ts
// src/lib/jobs/jobs.schema.ts
jobs: {
  id: uuid primary key,
  type: enum(
    'run_execute',
    'run_resume',
    'task_dispatch',
    'memory_mine',
    'evaluation_execute',
    'workspace_gc',
    'artifact_postprocess',
    'hook_dispatch'
  ),
  status: enum('pending', 'leased', 'running', 'retry_wait', 'completed', 'failed', 'canceled'),
  priority: int default 100,
  queue: text,                     // 'default', 'latency', 'bulk', 'maintenance'
  dedupeKey: text | null,
  scheduledAt: timestamp,
  leaseExpiresAt: timestamp | null,
  startedAt: timestamp | null,
  finishedAt: timestamp | null,
  attemptCount: int default 0,
  maxAttempts: int default 3,
  payload: jsonb,
  result: jsonb | null,
  error: jsonb | null,
  runId: uuid | null,
  taskId: uuid | null,
  sessionId: uuid | null,
  projectId: uuid | null,
  userId: uuid | null,
  createdAt, updatedAt
}

jobPolicies: {
  id: uuid primary key,
  jobType: text,
  maxAttempts: int,
  backoffMs: int,
  concurrencyKey: text | null,
  concurrencyLimit: int | null,
  timeoutMs: int,
  cancelBehavior: enum('best_effort', 'hard_timeout', 'never')
}

jobLeases: {
  id: uuid primary key,
  jobId: uuid fk → jobs,
  workerId: text,
  heartbeatAt: timestamp,
  expiresAt: timestamp,
  createdAt
}
```

### Worker model

1. API/server enqueues jobs transactionally alongside the source event.
2. Worker process claims jobs with `FOR UPDATE SKIP LOCKED`.
3. Worker emits heartbeat while running.
4. If worker dies, lease expires and job returns to `pending` or `retry_wait`.
5. Cancellation is stored durably and checked at safe runtime boundaries.

### Queue classes

- `latency`: user-visible nearline jobs like run resume, evaluator follow-up.
- `default`: normal background execution.
- `bulk`: imports, backfills, memory re-mining.
- `maintenance`: GC, cleanup, retention jobs.

### Idempotency model

- `dedupeKey` prevents duplicate enqueue for events like `artifact_edited:v7` or `memory_mine:session123`.
- Job handlers must be re-entrant.
- Output side effects should be guarded by source IDs or natural unique constraints.

## Integration with existing plans

- **Runs**: `run_execute` jobs create or resume `runs`; `runs` remain the source of execution truth.
- **Tasks**: task approval enqueues child dispatch jobs rather than running inline.
- **Evaluations**: evaluator runs become jobs in `latency` queue.
- **Projects**: artifact edit events can enqueue post-processing or indexing jobs.
- **Memory**: post-run mining becomes a job, but only after memory work merges.
- **Workspace**: GC moves out of ad hoc timers into maintenance jobs.
- **Hooks**: expensive hooks can graduate from inline execution to queued dispatch.

## Files to create / modify

- `src/lib/jobs/jobs.schema.ts` (new)
- `src/lib/jobs/jobs.server.ts` (new) — enqueue, cancel, lease, retry, heartbeat
- `src/lib/jobs/worker.server.ts` (new) — polling loop / dispatcher
- `src/lib/jobs/handlers/` (new) — typed handlers by job type
- `src/lib/jobs/policies.server.ts` (new) — retry and concurrency policy resolution
- `src/lib/jobs/index.ts` (new barrel)
- `src/lib/runtime/loop.server.ts` — cancellation checkpoints, heartbeat hooks
- `src/lib/tasks/tasks.server.ts` — enqueue dispatch jobs instead of inline scheduling
- `src/lib/runs/runs.server.ts` — handoff from route to `run_execute`
- `src/lib/automations/engine.ts` — schedule jobs instead of running work inline
- `src/lib/workspace/gc.server.ts` — convert to maintenance job handler
- `src/routes/api/jobs/[id]/cancel/+server.ts` (new)
- `src/routes/settings/jobs/+page.svelte` (new) — queue health, stuck jobs, retry UI
- `docs/jobs/jobs.md` (new domain doc once shipped)

## Phases

### Phase 1 — Queue primitives

1. Add `jobs`, `jobPolicies`, `jobLeases` tables.
2. Implement enqueue + lease + heartbeat + retry helpers.
3. Build one worker loop in-process behind a flag.

### Phase 2 — Run execution handoff

1. Route handlers stop owning long-lived execution.
2. User action creates `run_execute` job.
3. Worker starts runtime loop and writes to `runs`/`run_events`.

### Phase 3 — Cancellation + retries

1. Add durable cancel API.
2. Runtime loop checks job cancel token at round/tool boundaries.
3. Retry policy moves to `jobPolicies`.

### Phase 4 — Scheduler and delayed work

1. Support `scheduledAt` for automations, retries, maintenance.
2. Add cron-like registration for first-party jobs.
3. Move workspace GC and stale-run cleanup into scheduled jobs.

### Phase 5 — Feature migration

1. Task dispatch uses jobs.
2. Evaluations use jobs.
3. Artifact post-process uses jobs.
4. Memory mining uses jobs after memory merge.

### Phase 6 — Worker separation

1. Split worker from web process.
2. Add worker health and concurrency controls.
3. Add deployment guidance for one web + N worker topology.

## Verification

1. Kill worker mid-run → lease expires → job is retried or marked failed per policy.
2. Cancel a long run → runtime exits at safe boundary and `jobs.status = canceled`.
3. Schedule an automation 5 minutes out → it executes without an active browser session.
4. Queue flood test: 100 memory mining jobs do not block user-facing `latency` queue.
5. `bun run check` and targeted integration tests for enqueue/lease/retry pass.

## Scope boundaries

- **Included**: durable queue, retries, heartbeats, cancellation, scheduling, worker loop, job policies, admin UI.
- **Excluded**: distributed queue infrastructure outside Postgres for v1, per-tenant rate billing, external workflow engines (Temporal, Quartz, BullMQ).

## Key design decisions

1. `runs` are not the queue; `jobs` schedule and supervise runs.
2. Postgres is sufficient for v1; avoid external infra until scale proves otherwise.
3. Cancellation is cooperative, not thread-kill style.
4. Queue separation by latency class is required before heavy memory/evaluation workloads land.
5. Every background feature must declare idempotency before being queued.
