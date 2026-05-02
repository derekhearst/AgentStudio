# Activity Spec

## Overview

Activity is a lightweight audit log for significant user-facing events across AgentStudio. It powers the activity feed in the UI — a chronological stream of what happened, who did it, and what entity was affected. It is intentionally read-only and append-only: other domains write events into it, nobody edits or deletes them.

## Data Model

### `activityEvents` table

| Column       | Type            | Notes                                          |
| ------------ | --------------- | ---------------------------------------------- |
| `id`         | uuid            | Primary key                                    |
| `type`       | enum            | See event types below                          |
| `entityId`   | text (nullable) | ID of the affected entity (task, agent, etc.)  |
| `entityType` | text (nullable) | Type label matching `entityId` (e.g. `"task"`) |
| `summary`    | text            | Human-readable one-line description            |
| `metadata`   | jsonb           | Arbitrary event details                        |
| `createdAt`  | timestamptz     | When the event occurred                        |

> Note: `activityEvents` does not carry `userId`. Events are global. If per-user filtering is needed, it should be added as an optional column in a future migration.

### Event types

| Type                     | Triggered when                          |
| ------------------------ | --------------------------------------- |
| `task_created`           | A task is created                       |
| `task_status_changed`    | A task moves to a new status            |
| `agent_action`           | An agent completes a significant action |
| `chat_started`           | A chat conversation is started          |
| `review_action`          | A review item is approved or denied     |
| `skill_created`          | A skill is created                      |
| `project_created`        | A project is created                    |
| `project_status_changed` | A project moves to a new status         |
| `goal_created`           | A goal is created                       |
| `strategy_submitted`     | A strategy is submitted for review      |
| `strategy_approved`      | A strategy is approved                  |
| `strategy_rejected`      | A strategy is rejected                  |

## Key Behaviors

- **Write via `emitActivity(type, summary, opts?)`** — all callers use this single function. It is fire-and-forget; failures should not block the calling operation.
- **Read via remote functions** — the activity feed is fetched by the `/activity` route using `listActivityEvents()` with optional filters (type, entityType, date range, pagination).
- **No mutations** — events are never updated or deleted. If a status change produces conflicting events, both are stored.
- **Entity links** — `entityId` + `entityType` together form a soft reference to another row. The activity feed uses these to render clickable deep-links to the affected object.

## Roles & Permissions

| Action                | Who can do it       |
| --------------------- | ------------------- |
| View activity feed    | Authenticated users |
| Filter by entity/type | Authenticated users |
| Write events          | Server-side only    |
| Delete/edit events    | Nobody              |

## Integrations

Activity events are emitted by all major domains:

- `tasks/` on create and status change
- `agents/` on significant actions
- `chat/` on conversation start
- `observability/` on review approvals/denials
- `skills/` on skill creation
- `projects/` on create and status change
