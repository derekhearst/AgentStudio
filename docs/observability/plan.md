# Observability Plan

Status: active

## Overview

As AgentStudio gains runs, jobs, hooks, memory, evaluations, projects, and artifacts, failures will stop being obvious from the chat UI alone. Add a first-class `observability/` domain to capture traces, costs, decisions, failures, and review items. Pair it with a unified Review Inbox so humans can handle approvals, evaluator failures, blocked tasks, job incidents, memory conflicts, and artifact ambiguity from one place.

> **Depends on:** `docs/structure/plan.md` (`runs/`, `hooks/`, `evaluations/`, `activity/`), `docs/jobs/plan.md` (worker/job states), `docs/policies/plan.md` (decision logs), `docs/projects/plan.md` (artifact conflicts), `docs/memory/plan.md` (post-merge for memory-specific review items).

> **See also:** [spec.md](spec.md) — full feature spec, data model, and behavior contracts.

## Why this matters

- **Agent systems become opaque quickly.** Without traces and queues for human review, you lose the ability to debug or trust the system.
- **Approvals should not be scattered.** One inbox should show everything waiting on a human.
- **Cost and failure need a control plane.** Product quality depends on seeing what the harness is doing, not guessing.

## Current state in AgentStudio

- Activity events exist, but there is no unified trace or incident model.
- Approvals and user questions are route-level flows, not inbox items.
- Evaluator failures, stuck jobs, hook failures, and artifact conflicts have no common review surface.
- Cost is tracked, but not tied into an operational dashboard.

## Target design

### Two connected concerns

1. **Observability** — traces, metrics, logs, cost, policy decisions, queue health.
2. **Review Inbox** — every human-required action in one queue.

### Core tables

```ts
// src/lib/observability/observability.schema.ts
runTraces: {
  id: uuid primary key,
  runId: uuid,
  sessionId: uuid,
  taskId: uuid | null,
  jobId: uuid | null,
  trace: jsonb,                   // normalized step timeline
  startedAt: timestamp,
  finishedAt: timestamp | null,
  status: enum('running', 'completed', 'failed', 'canceled')
}

reviewItems: {
  id: uuid primary key,
  type: enum(
    'approval_request',
    'user_question',
    'evaluation_failure',
    'job_failure',
    'job_stuck',
    'hook_failure',
    'artifact_conflict',
    'memory_conflict',
    'policy_override_request'
  ),
  status: enum('open', 'in_progress', 'resolved', 'dismissed'),
  severity: enum('info', 'warning', 'critical'),
  runId: uuid | null,
  sessionId: uuid | null,
  taskId: uuid | null,
  jobId: uuid | null,
  projectId: uuid | null,
  artifactId: uuid | null,
  payload: jsonb,
  assignedTo: uuid | null,
  resolvedBy: uuid | null,
  resolvedAt: timestamp | null,
  createdAt, updatedAt
}

operationalMetrics: {
  id: uuid primary key,
  metric: text,
  dimension: jsonb,
  value: numeric,
  measuredAt: timestamp
}
```

### What gets traced

- runtime rounds
- tool calls and latency
- approvals and user questions
- policy decisions
- compaction events
- evaluator runs and findings
- job claims, heartbeats, retries, failures
- artifact edits and version creation
- memory mining and recall latency

### Review Inbox item sources

- `approval_request`: approval-gated tool calls
- `user_question`: `ask_user` requests
- `evaluation_failure`: evaluator returns fail or needs revision
- `job_failure` / `job_stuck`: queue incidents
- `hook_failure`: failed first-party or skill hook
- `artifact_conflict`: ambiguous edit target, duplicate slug, rollback conflict
- `memory_conflict`: duplicate mining, bad link, unresolved recall disagreement
- `policy_override_request`: user or admin asks to override a deny

## Integration with existing plans

- **Runs** emit trace timeline and state transitions.
- **Jobs** emit worker/lease/retry events and create review items for stuck work.
- **Policies** contribute decision logs and override requests.
- **Evaluations** generate review items on fail/needs_revision.
- **Projects** generate artifact conflict items.
- **Memory** can later generate mining/recall conflict items, but only after memory merge.
- **Hooks** emit failure telemetry and optional review items.

## Files to create / modify

- `src/lib/observability/observability.schema.ts` (new)
- `src/lib/observability/traces.server.ts` (new)
- `src/lib/observability/review.server.ts` (new)
- `src/lib/observability/metrics.server.ts` (new)
- `src/lib/observability/index.ts` (new barrel)
- `src/lib/runtime/loop.server.ts` — emit trace spans
- `src/lib/jobs/worker.server.ts` — emit job operational events
- `src/lib/policies/decisions.server.ts` — feed review items where needed
- `src/lib/evaluations/evaluations.server.ts` — open review items for non-pass verdicts
- `src/lib/projects/artifacts.server.ts` — open artifact conflict review items
- `src/routes/review/+page.svelte` (new) — unified inbox
- `src/routes/review/[id]/+page.svelte` (new) — item detail and resolution
- `src/routes/observability/+page.svelte` (new) — dashboards
- `src/routes/observability/runs/[id]/+page.svelte` (new) — run trace viewer
- `docs/observability/observability.md` (new domain doc once shipped)

## Phases

### Phase 1 — Trace model and review items

1. Add `runTraces`, `reviewItems`, `operationalMetrics` tables.
2. Implement trace append helpers and review item lifecycle.
3. Add a thin dashboard showing open review counts and recent failures.

### Phase 2 — Runtime and job instrumentation

1. Runtime emits spans for rounds/tools/compaction/approval.
2. Jobs emit claim, heartbeat, retry, timeout, failure events.
3. Build run trace page and queue health page.

### Phase 3 — Unified review inbox

1. Convert approval requests and user questions into review items.
2. Add evaluator failure and job failure review items.
3. Add assignment, severity, and resolution actions.

### Phase 4 — Cost, latency, and quality dashboards

1. Aggregate per-agent, per-model, per-tool cost.
2. Track P50/P95 latency for runs, jobs, memory recall, evaluations.
3. Surface retry rates, failure rates, and policy-deny rates.

### Phase 5 — Product-specific review flows

1. Add artifact conflict resolution.
2. Add policy override workflow.
3. Add memory conflict items after memory merge.

## Verification

1. Failed evaluator run appears in Review Inbox with trace link.
2. Stuck job creates critical review item and queue health alert.
3. Approval request can be resolved from inbox, not only from chat route.
4. Run trace shows ordered rounds/tool calls with latency and cost.
5. Dashboard answers: what failed, why, how much it cost, and who needs to act.

## Scope boundaries

- **Included**: traces, dashboards, review inbox, incident/review lifecycle, operational metrics.
- **Excluded**: external APM vendors, distributed tracing standards, pager/on-call integration, BI warehouse exports.

## Key design decisions

1. Observability and review are one domain because detection without action is incomplete.
2. Review Inbox is the single human control plane for approvals and failures.
3. Trace events should be normalized enough for dashboards, not raw unbounded logs only.
4. Operational metrics should come from domain events, not hand-maintained counters.
5. Any state that requires human action should become a review item.

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



