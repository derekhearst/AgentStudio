# Tasks Layer Plan

## Overview

Today `conversations` does the work of three different concepts: a _task_ (the user's intent), a _run_ (one execution attempt), and a _thread_ (the message tape). Introduce an explicit `tasks` layer above conversations so the orchestrator can persist plans, the system can support multi-attempt retries, and the UI can offer kanban/DAG views like the rest of the orchestrator field.

## Why this matters (harness principles)

- **Repository knowledge is the system of record.** Plans must be durable artifacts, not transient SSE blocks.
- **Humans steer, agents execute.** A task is the steerable unit — approve once, run to completion.
- **Throughput.** Without a task entity, parallel sub-agent execution and retries have nowhere to live.

## Reference repos & articles

- [Symphony](https://github.com/openai/symphony) — OpenAI's reference task runner (Linear issue → isolated agent → PR)
- [Vibe Kanban](https://github.com/BloopAI/vibe-kanban) — kanban orchestrator with worktree-per-task
- [Chorus](https://github.com/Chorus-AIDLC/Chorus) — task DAGs and approval gates
- [Scion (Google)](https://github.com/GoogleCloudPlatform/scion) — task management as a pluggable module
- [Almirant](https://almirant.ai/) — structured task lifecycle (plan → implement → review → deploy)

## Current state in AgentStudio

- `conversations` table is the top-level unit; `chatRuns` is per-HTTP-stream.
- The orchestrator emits "plans" as inline assistant text — there is no DAG, no persistent step structure, no retry primitive.
- The route `/chat/[id]/plan-decide` exists but only handles one decision per stream.
- Sub-agents run inline ([inline-subagent.ts](../../src/lib/agents/inline-subagent.ts)) and produce ad-hoc child conversations with no parent linkage beyond `metadata.parentConversationId`.

## Target design

### Schema

```ts
// src/lib/tasks/tasks.schema.ts
tasks: {
  id: uuid,
  title: text,
  spec: text,                    // markdown — the durable description
  status: enum(pending, planning, awaiting_approval, running, blocked, completed, failed, canceled),
  parentTaskId: uuid | null,     // DAG parent (planner spawns children)
  ownerAgentId: uuid | null,     // responsible agent
  rootConversationId: uuid | null, // first conversation that produced the task
  priority: int,
  budgetUsd: numeric | null,
  metadata: jsonb,
  createdBy: uuid (user),
  createdAt, updatedAt
}

task_attempts: {
  id, taskId, runId (chatRuns.id), status, attemptNumber, startedAt, finishedAt, error, costUsd
}
```

`chatRuns` gains optional `taskId` + `taskAttemptId` columns.

### Behaviors

1. Orchestrator's `propose_plan` tool persists `tasks` rows (parent + children) instead of free-text.
2. User approves the plan → tasks become `running`; task runner spawns runs per task.
3. Each run is a `task_attempt`. A failed attempt leaves the task `blocked`; user/orchestrator can spawn a new attempt.
4. UI surfaces:
   - `/tasks` kanban view (status columns).
   - Task detail page with timeline of attempts and conversations.
   - Existing `/chat/[id]` shows the task badge if attached.

## Implementation steps (phased)

### Phase 1 — Schema + barrels

- Add `tasks` and `task_attempts` tables.
- Add nullable `taskId` / `taskAttemptId` to `chatRuns`.
- Domain barrel `src/lib/tasks/index.ts`, server fns, remote fns.

### Phase 2 — Orchestrator emits tasks

- Replace ad-hoc plan text with a `propose_plan` tool that writes task rows.
- `decide_plan` route flips status `awaiting_approval` → `running`.

### Phase 3 — Task runner

- Worker that picks `running` tasks → creates run → wires it to the conversation.
- For now: single-process `setInterval`, future: worker queue.

### Phase 4 — UI

- `/tasks` kanban (DaisyUI cards, drag is later — start with status filters).
- Task detail page with attempt history + cost.
- Task badge on chat detail.

### Phase 5 — Retries & DAG

- Retry button creates a new attempt referencing prior failure context.
- Parent → child DAG visualization.

## Files to create / modify

- `src/lib/tasks/tasks.schema.ts` (new)
- `src/lib/tasks/tasks.server.ts` (new)
- `src/lib/tasks/tasks.remote.ts` (new)
- `src/lib/tasks/index.ts` (new barrel)
- `src/lib/agents/orchestrator.ts` — wire `propose_plan` to task creation
- `src/lib/tools/tools.server.ts` — register task tools
- `src/lib/chat/chat.schema.ts` — `taskId` / `taskAttemptId` on `chatRuns`
- `src/routes/tasks/+page.svelte` (new)
- `src/routes/tasks/[id]/+page.svelte` (new)
- `src/routes/chat/[id]/plan-decide/+server.ts` — promote plan to tasks
- `docs/tasks/tasks.md` (new domain doc once shipped)

## Migration / backward-compat

- Existing conversations have no task; `taskId` is nullable so legacy chat keeps working.
- A backfill is unnecessary — tasks are forward-only.

## Verification

- E2E: ask the orchestrator to "build me a CSV export feature" → plan tool fires → tasks appear in `/tasks` → approve → run starts.
- Unit: task status transitions guarded (no `completed → running` without an attempt).
- Manual: kanban renders all states.

## Out of scope

- External issue tracker integration (Linear/GitHub) — separate doc later.
- Cross-user task assignment.
- Task scheduling beyond what `automations` already does.
