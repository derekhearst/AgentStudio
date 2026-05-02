# Evaluations Spec

## Overview

The evaluations domain closes the quality loop in AgentStudio's agent execution. After a generator agent finishes its work, an evaluator agent reviews the output, produces a structured verdict, and determines whether the run meets the task's acceptance criteria. A failing verdict can trigger a correction attempt (re-plan + new run) or block the task pending human review.

## Data Model

### `runEvaluations` table

| Column           | Type      | Description                                            |
| ---------------- | --------- | ------------------------------------------------------ |
| `id`             | uuid      | Primary key                                            |
| `runId`          | uuid      | FK to `runs` — the generator run being evaluated       |
| `taskId`         | uuid?     | FK to `tasks` — if evaluation is attached to a task    |
| `evaluatorRunId` | uuid      | FK to `runs` — the evaluator child run                 |
| `verdict`        | enum      | `pass`, `fail`, `needs_revision`                       |
| `confidence`     | numeric   | 0.0–1.0 confidence score from the evaluator model      |
| `findings`       | jsonb     | Array of `{severity, description, location?}` findings |
| `costUsd`        | numeric?  | Cost of the evaluator run                              |
| `createdAt`      | timestamp |                                                        |

### `sprintContracts` table

For long-running tasks, sprint contracts define intermediate deliverables and when they are checked.

| Column         | Type    | Description                                                      |
| -------------- | ------- | ---------------------------------------------------------------- |
| `id`           | uuid    | Primary key                                                      |
| `taskId`       | uuid    | FK to `tasks`                                                    |
| `round`        | integer | Tool loop round at which this sprint ends                        |
| `deliverable`  | text    | Markdown description of what must exist at this sprint boundary  |
| `verdict`      | enum?   | Filled in after evaluation: `pass`, `fail`, `needs_revision`     |
| `evaluationId` | uuid?   | FK to `runEvaluations` — the evaluation that checked this sprint |

## Features

### Evaluator agent kind

Evaluator agents are a distinct `agents.kind = 'evaluator'`. They differ from worker agents in three ways:

1. They run a cheap model by default (configurable, default: `openai/gpt-4o-mini`)
2. Their active tool set is restricted to read-only tools: `file_read`, `list_directory`, `web_search`
3. They produce a structured JSON output: `{ verdict, confidence, findings }`

A default evaluator agent is seeded on first boot. Users can create additional evaluators with different models or read-only skill configurations.

### Trigger conditions

An evaluator pass is triggered when any of these conditions are true:

| Condition              | What causes it                                                        |
| ---------------------- | --------------------------------------------------------------------- |
| End-of-task evaluation | Task transitions to `completed` and `evalRequired = true` on the task |
| End-of-run evaluation  | Run finishes and `runs.evalRequired = true`                           |
| Sprint boundary        | A long run reaches a round count defined in `sprintContracts`         |
| Manual trigger         | Admin or owner triggers evaluation on a completed run from the UI     |

### Evaluation flow

1. Generator run completes (or hits a sprint boundary)
2. A `evaluation_execute` job is enqueued for the run
3. The job spawns a child run using the evaluator agent:
   - System prompt includes the generator's task spec, the acceptance criteria, and the `pass`/`fail`/`needs_revision` output schema
   - Read-only context: final `streamBlocks`, workspace file listing, key tool outputs
4. Evaluator produces its verdict
5. The verdict is persisted in `runEvaluations`
6. Depending on the verdict:
   - `pass` → run and/or task transitions to `completed`
   - `needs_revision` → findings are appended to the session as a system message; a new run attempt is spawned (within retry budget)
   - `fail` → task transitions to `blocked`; a `evaluation_failure` review item is created in the observability inbox

### Re-plan loop

When verdict is `needs_revision` and retries remain:

1. The evaluator's findings are formatted as a system message: "The evaluator found the following issues: ..."
2. A new `task_attempts` row is created (attempt N+1)
3. A new run starts with the accumulated findings in context

Each retry is bounded by the task's `budgetUsd` and the agent's configured `maxAttempts`. Exhausting retries transitions the verdict handling to `fail`.

### Sprint contracts

For tasks expected to run many rounds (e.g., a multi-file refactor), sprint contracts define intermediate checkpoints:

- Sprint boundaries are defined on the task as `sprintContracts` rows
- When the generator run reaches a sprint's `round` count, the loop pauses and triggers an evaluator pass
- A `needs_revision` at a sprint boundary injects the findings and continues the generator in a new round (not a full new run)
- A `fail` at a sprint boundary transitions the task to `blocked` immediately

### Evaluator result UI

`/runs/[id]/evaluation` — shows the verdict badge, confidence score, and full findings list. If the run has multiple evaluation attempts (one per sprint), they appear as an ordered list.
`/tasks/[id]` — shows the task's current evaluation status alongside the attempt timeline.

### Manual evaluation

Admins and run owners can trigger an evaluator pass on any completed run from `/runs/[id]`. This creates a new `runEvaluations` row with `trigger = 'manual'` and does not affect the run's terminal state automatically — the human reviews the findings and decides whether to reopen the task.

## Behavior Contracts

- An evaluator run has `runs.evalRequired = false` — it is never itself subject to evaluation.
- Evaluator runs cannot call write tools. The runtime enforces this regardless of the evaluator agent's capability configuration.
- `runEvaluations.findings` is the authoritative output of an evaluator run. The evaluator's raw conversation is also available via the child run's event log.
- A `pass` verdict does not prevent subsequent manual evaluation.
- A task in `blocked` state due to evaluation failure requires a human action to restart (the system does not automatically retry a blocked task).
- Sprint contracts are defined at task creation time. Adding sprint contracts to a running task only applies to future sprint boundaries (not retroactively).

## Roles & Permissions

| Action                           | Who can do it                        |
| -------------------------------- | ------------------------------------ |
| Configure `evalRequired` on runs | Owner user, admin                    |
| Define sprint contracts          | Owner user (at task creation), admin |
| View evaluation results          | Run/task owner, admin                |
| Trigger manual evaluation        | Run owner, admin                     |
| Override a verdict (force pass)  | Admin only                           |
| Create an evaluator agent        | Admin only                           |

## Rewrite Authority

The current implementation is a baseline, not a constraint. This domain may be rewritten, restyled, reorganized, or replaced as needed to achieve the target product quality. No code path is off-limits if behavior contracts, safety controls, tests, and documentation remain correct.

## UI Contract

This domain follows the shared UX system in [../ui/spec.md](../ui/spec.md).

- Surfaces in this domain must align with the shared desktop/mobile shell patterns.
- Domain-specific states must be explicit in the UI (for example pending, running, blocked, completed) where applicable.
- Blocking user decisions must use the shared action-card and inbox patterns where applicable.

## References
- [Harness Design for Long-Running Application Development — Anthropic](https://www.anthropic.com/engineering/harness-design-long-running-apps) — planner/generator/evaluator pattern
- [Multi-Agent Coordination Patterns — Anthropic](https://claude.com/blog/multi-agent-coordination-patterns) — cheap executor + expensive advisor
- [Hive — aden-hive](https://github.com/aden-hive/hive) — outcome-driven checkpoints
- [Harness Engineering Is Cybernetics — George](https://x.com/odysseus0z/article/2030416758138634583) — evaluator as sensor
- [Meta-Harness — Yoonho Lee](https://yoonholee.com/meta-harness/) — Claude Code as harness optimizer
- **Internal:** `src/lib/evaluations/evaluations.schema.ts`, `src/lib/evaluations/evaluations.server.ts`, `src/routes/runs/[id]/evaluation/`

