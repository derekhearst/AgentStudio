# Automations Spec

## Overview

An automation is a durable, scheduled or event-triggered workflow that launches agent work without an active browser session. Automations are not just cron prompts. They are reusable execution recipes that bind together a trigger, an agent, an environment, optional project or repository context, output routing, review policy, and budget limits.

This domain upgrades the current cron-triggered prompt replay implementation into a proper orchestration surface for recurring research, scheduled maintenance, nightly repository checks, and continuous competitor scouting.

## Data Model

### `automations` table

| Column             | Type       | Notes                                              |
| ------------------ | ---------- | -------------------------------------------------- |
| `id`               | uuid       | Primary key                                        |
| `userId`           | uuid       | FK to `users` - owner                              |
| `name`             | text       | Display name                                       |
| `description`      | text       | Short description                                  |
| `triggerType`      | enum       | `cron`, `manual`, `webhook`, `event`               |
| `triggerConfig`    | jsonb      | Cron expression or trigger payload                 |
| `agentId`          | uuid?      | FK to `agents`; null = orchestrator                |
| `projectId`        | uuid?      | Optional FK to `projects`                          |
| `repositoryId`     | uuid?      | Optional FK to `repositories`                      |
| `mode`             | enum       | `research`, `code`, `chat_followup`, `maintenance` |
| `promptTemplate`   | text       | Durable instructions for the run                   |
| `enabled`          | boolean    |                                                    |
| `outputTarget`     | enum       | `chat_session`, `task`, `artifact`, `review_inbox` |
| `budgetUsdMonthly` | numeric?   | Optional monthly cap                               |
| `lastRunAt`        | timestamp? |                                                    |
| `nextRunAt`        | timestamp? |                                                    |
| `createdAt`        | timestamp  |                                                    |
| `updatedAt`        | timestamp  |                                                    |

### `automationRuns` table

| Column         | Type       | Notes                                                     |
| -------------- | ---------- | --------------------------------------------------------- |
| `id`           | uuid       | Primary key                                               |
| `automationId` | uuid       | FK to `automations`                                       |
| `jobId`        | uuid?      | FK to `jobs`                                              |
| `taskId`       | uuid?      | FK to `tasks`                                             |
| `runId`        | uuid?      | FK to `runs`                                              |
| `status`       | enum       | `scheduled`, `running`, `completed`, `failed`, `canceled` |
| `startedAt`    | timestamp? |                                                           |
| `finishedAt`   | timestamp? |                                                           |
| `summary`      | text?      | Short execution summary                                   |
| `error`        | jsonb?     | Failure details                                           |
| `createdAt`    | timestamp  |                                                           |

### `automationDeliveries` table

| Column            | Type      | Notes                                                        |
| ----------------- | --------- | ------------------------------------------------------------ |
| `id`              | uuid      | Primary key                                                  |
| `automationRunId` | uuid      | FK to `automationRuns`                                       |
| `targetType`      | enum      | `session`, `task`, `artifact`, `review_item`, `pull_request` |
| `targetId`        | uuid      | Target row ID                                                |
| `createdAt`       | timestamp |                                                              |

## Features

### Trigger types

Automations support:

- Cron schedules
- Manual "run now"
- Event triggers from first-party systems
- Webhook triggers for external systems

### Output routing

An automation can route its output to:

- An existing chat session
- A new task
- A project artifact
- The Review Inbox

This makes recurring research and recurring coding workflows first-class.

### Project and repository context

Automations can attach project or repository context so recurring runs are not context-free. Examples:

- Weekly "research competitor harness changes" automation writing into a research project
- Nightly "open dependency drift pull request" automation against a repo-backed project

### Budget controls

Automations can define monthly spend limits. If an execution would exceed the cap, the automation is blocked and a review item is created.

### Review policies

Automations can require human approval before:

- Executing a code task
- Pushing a branch
- Opening a pull request
- Publishing a report into a shared project

### Automation history

Users can inspect past automation runs, including summaries, failures, linked tasks, linked runs, and linked pull requests.

### Current implementation bridge

The current implementation in `src/lib/automation/` is treated as Phase 0 compatibility mode:

- `automation.schema.ts` becomes the basis for the future `automations` table migration
- `engine.ts` becomes a thin scheduler adapter that enqueues jobs instead of running inline
- `/automations` remains the management UI, but is expanded from prompt replay into full workflow definitions

### Research scout pattern

A first-class automation recipe exists for your stated goal:

- Trigger: weekly cron
- Mode: `research`
- Agent: research worker or orchestrator
- Output target: `task` or `artifact`
- Repository context: optional AgentStudio repo
- Follow-up: create review item if findings imply feature gaps or new plan draft

## Behavior Contracts

- Every automation execution produces an `automationRuns` row, even if it fails immediately.
- Automations execute through jobs, not inline HTTP handlers.
- Disabled automations do not enqueue new runs.
- Budget overage blocks execution and creates a review item.
- Automations are resumable only through underlying jobs, tasks, and runs primitives, not ad hoc engine state.
- An automation may write to multiple surfaces, but each delivery is recorded explicitly in `automationDeliveries`.

## Roles & Permissions

| Action                                             | Who can do it      |
| -------------------------------------------------- | ------------------ |
| Create automation                                  | Authenticated user |
| Enable or disable own automation                   | Owner user, admin  |
| View another user's automation                     | Admin only         |
| Resolve blocked automation budget or policy review | Owner user, admin  |
| Create org-wide automation                         | Admin only         |

## References

- [../jobs/spec.md](../jobs/spec.md) - background execution and scheduling
- [../research/spec.md](../research/spec.md) - deep research runs
- [../tasks/spec.md](../tasks/spec.md) - plan and approval flow
- [../source-control/spec.md](../source-control/spec.md) - repository-aware automations
- [../observability/spec.md](../observability/spec.md) - review items and failures
- **Current code:** `src/lib/automation/automation.schema.ts`, `src/lib/automation/engine.ts`, `src/routes/automations/+page.svelte`
