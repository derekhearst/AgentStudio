# Tasks Spec

## Overview

A task is the durable unit of user intent. It is the steerable thing — approved once, executed by the system to completion. A task can spawn multiple runs (attempts), have child tasks (sub-tasks), be assigned to a specific agent, and carry a cost budget. Tasks are the entity a user steers from the kanban view; runs are the execution records underneath.

## Data Model

### `tasks` table

| Column          | Type      | Description                                                                                         |
| --------------- | --------- | --------------------------------------------------------------------------------------------------- |
| `id`            | uuid      | Primary key                                                                                         |
| `title`         | text      | Short human-readable label                                                                          |
| `spec`          | text      | Durable markdown description of what should be accomplished                                         |
| `status`        | enum      | `pending`, `planning`, `awaiting_approval`, `running`, `blocked`, `completed`, `failed`, `canceled` |
| `parentTaskId`  | uuid?     | FK to parent task — enables task DAGs                                                               |
| `ownerAgentId`  | uuid?     | FK to `agents` — agent responsible for executing this task                                          |
| `rootSessionId` | uuid?     | FK to `sessions` — user-facing session that originated the task                                     |
| `projectId`     | uuid?     | FK to `projects` — project this task belongs to                                                     |
| `priority`      | integer   | Execution priority; higher = more urgent                                                            |
| `budgetUsd`     | numeric?  | Maximum allowed spend for this task across all attempts                                             |
| `metadata`      | jsonb     | Arbitrary metadata from the orchestrator or user                                                    |
| `createdBy`     | uuid      | FK to `users`                                                                                       |
| `createdAt`     | timestamp |                                                                                                     |
| `updatedAt`     | timestamp |                                                                                                     |

### `task_attempts` table

Each run that executes a task is recorded as an attempt.

| Column          | Type       | Description                                  |
| --------------- | ---------- | -------------------------------------------- |
| `id`            | uuid       | Primary key                                  |
| `taskId`        | uuid       | FK to `tasks`                                |
| `runId`         | uuid       | FK to `runs`                                 |
| `status`        | enum       | `running`, `completed`, `failed`, `canceled` |
| `attemptNumber` | integer    | 1-indexed ordinal within the task            |
| `startedAt`     | timestamp  |                                              |
| `finishedAt`    | timestamp? |                                              |
| `error`         | jsonb?     | Error details if failed                      |
| `costUsd`       | numeric?   | Cost for this attempt                        |

## Features

### Plan-first workflow

The orchestrator's `propose_plan` tool creates a task hierarchy (parent + child tasks) as a single atomic operation. Children are created in `pending` state. The plan is visible to the user before any execution begins.

### User approval gate

After the orchestrator proposes a plan, tasks sit in `awaiting_approval`. The user reviews and approves (or revises) from the `/tasks` view or from the chat session. Approval transitions the root task to `running` and children to `pending` (executed in dependency order).

### Multi-attempt execution

A failed attempt does not fail the task. The task transitions to `blocked`; the orchestrator or user can spawn a new attempt. Each attempt is a separate `runs` row with its own event log. Retry budgets (max attempts, max cost) are enforced before spawning a new attempt.

### Task DAG

Tasks can have parent-child relationships forming a directed acyclic graph. The orchestrator can spawn sub-tasks that run concurrently (via sub-agent runs) and report back. A parent task completes only after all children complete.

### Kanban view

The `/tasks` route presents tasks in status columns: `pending`, `running`, `blocked`, `completed`, `failed`. Each card shows the task title, assigned agent, current attempt number, and cost so far. Users can drag tasks between columns to manually override status.

### Task detail

The `/tasks/[id]` route shows:

- Full task spec (editable if status is `awaiting_approval`)
- Timeline of attempts with expandable run event logs
- Cost breakdown across attempts
- Child tasks with their own status

### Chat integration

When a user-facing chat session is attached to a task, the chat UI shows a task badge. Clicking it opens the task detail. The run backing the current chat is the task's latest attempt.

### Cost budget enforcement

Before spawning a new attempt, the system sums all prior attempt costs. If the total would exceed `tasks.budgetUsd`, the attempt is blocked and a review item is created in the observability inbox requesting budget approval.

### Canceled and failed states

- `canceled`: User or admin explicitly stopped the task. No further attempts are spawned.
- `failed`: All allowed attempts exhausted, or a non-retryable error was returned by the evaluator. Task is in a terminal state; user intervention is required to restart.

## Behavior Contracts

- A task in a terminal state (`completed`, `failed`, `canceled`) does not spawn new attempts.
- `task_attempts.attemptNumber` is gapless within a task, starting at 1.
- A task cannot transition from `completed` back to any non-terminal state.
- Child tasks must complete before the parent transitions to `completed`.
- The `spec` field is append-only once the task is past `awaiting_approval`; edits require creating a new task.
- Budget overage blocks execution; it does not silently continue.

## Roles & Permissions

| Action                    | Who can do it                               |
| ------------------------- | ------------------------------------------- |
| Propose a plan            | Orchestrator agent, admin                   |
| Approve or reject a plan  | Owner user, admin                           |
| Edit a task spec          | Owner user (while awaiting_approval), admin |
| Cancel a task             | Owner user, admin                           |
| View task details         | Owner user, admin                           |
| View another user's tasks | Admin only                                  |
| Override task status      | Admin only                                  |

## Rewrite Authority

The current implementation is a baseline, not a constraint. This domain may be rewritten, restyled, reorganized, or replaced as needed to achieve the target product quality. No code path is off-limits if behavior contracts, safety controls, tests, and documentation remain correct.

## UI Contract

This domain follows the shared UX system in [../ui/spec.md](../ui/spec.md).

- Surfaces in this domain must align with the shared desktop/mobile shell patterns.
- Domain-specific states must be explicit in the UI (for example pending, running, blocked, completed) where applicable.
- Blocking user decisions must use the shared action-card and inbox patterns where applicable.

## References
- [Symphony — OpenAI](https://github.com/openai/symphony) — Linear issue → isolated agent → PR model
- [Vibe Kanban — BloopAI](https://github.com/BloopAI/vibe-kanban) — kanban orchestrator, worktree-per-task
- [Chorus — AIDLC](https://github.com/Chorus-AIDLC/Chorus) — task DAGs and approval gates
- [Almirant](https://almirant.ai/) — structured lifecycle (plan → implement → review → deploy)
- [Harness Design for Long-Running Apps — Anthropic](https://www.anthropic.com/engineering/harness-design-long-running-apps) — planner/generator/evaluator loop
- **Internal:** `src/lib/tasks/tasks.schema.ts`, `src/lib/tasks/tasks.server.ts`, `src/routes/tasks/`

