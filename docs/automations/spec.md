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
| `consecutiveFailures` | integer | Failed ticks in a row; reset by any successful run |
| `disabledReason`   | text?      | `consecutive_failures` when the system switched it off; null when a person did |
| `createdAt`        | timestamp  |                                                    |
| `updatedAt`        | timestamp  |                                                    |

### `automationRuns` table

Shipped shape (migration `0065_automation_runs`). One row per **attempt**, opened when the
attempt starts and closed when it ends, so a run that dies mid-flight still leaves a trace.

| Column           | Type       | Notes                                                            |
| ---------------- | ---------- | ---------------------------------------------------------------- |
| `id`             | uuid       | Primary key                                                      |
| `automationId`   | uuid       | FK to `automations`, cascade delete                              |
| `userId`         | uuid?      | Owner at run time                                                |
| `status`         | text       | `running`, `completed`, `failed`, `blocked` (budget cap)         |
| `trigger`        | text       | `schedule` or `manual` ("Run now")                               |
| `attempt`        | integer    | 1-based; >1 means this attempt is a retry of a failed tick        |
| `mode`           | text       | Snapshot of the automation's mode at execution time              |
| `startedAt`      | timestamp  |                                                                  |
| `finishedAt`     | timestamp? |                                                                  |
| `durationMs`     | integer?   |                                                                  |
| `conversationId` | uuid?      | Chat conversation the run wrote into                             |
| `chatRunId`      | uuid?      | `chat_runs` row, when the agent loop produced one                |
| `researchId`     | uuid?      | Research run the tick launched                                   |
| `jobId`          | uuid?      | The `automation_run` job this attempt belongs to                 |
| `costUsd`        | numeric?   | Dollar cost, when the mode reports one                           |
| `error`          | text?      | Failure message                                                  |
| `outputExcerpt`  | text?      | First ~2k characters of the output                               |
| `createdAt`      | timestamp  |                                                                  |

A table rather than a join over `chat_runs`: a `chat_run` only exists for the agent-attached
`chat_followup` path, so maintenance ticks, research ticks, the no-agent synthesis path, and
every failure that happens before a mode handler is reached (budget block, missing agent,
bad cron expression) produce none at all. A join could only ever show a subset of runs, and
never the failures.

Rows are pruned at 30 days by the dispatch tick, which also reaps rows left in `running` by
a worker that restarted mid-tick.

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

### Cron schedules and time zones

A cron schedule is a wall-clock instruction, so every automation carries the zone it should
be read in. The `automations.timezone` column holds an IANA zone name (for example
`America/Boise`, the default) and the create form pre-selects the browser's own zone. The
automations list shows the zone beneath the expression, so "9am" is never ambiguous. Before
this existed, the server read every schedule against the container's clock, which is UTC —
a 9am automation actually ran at 3am Mountain.

The expression itself is a standard five-field crontab line:
`minute hour day-of-month month day-of-week`.

| Form                            | Example     | Means                                        |
| ------------------------------- | ----------- | -------------------------------------------- |
| Any value                       | `*`         | Every minute / hour / day                    |
| A literal                       | `9`         | Exactly 9                                    |
| A range                         | `1-5`       | Monday through Friday                        |
| A list                          | `1,3,5`     | Monday, Wednesday, Friday                    |
| A step                          | `*/15`      | Every 15 minutes                             |
| A step on a range               | `9-17/4`    | 9, 13 and 17                                 |
| A name                          | `MON`, `JAN`| Three-letter day and month names             |
| A wildcard synonym              | `?`         | Same as `*`, day fields only                 |
| An alias                        | `@daily`    | Also `@hourly`, `@weekly`, `@monthly`, `@yearly` |

When both the day-of-month and day-of-week fields are restricted, the automation runs when
**either** matches — the long-standing crontab convention. When one of them is `*`, both must
match. That is what makes `0 9 * * 1-5` mean "weekdays at 9" rather than "never".

`@reboot` is rejected: automations have no boot event to hang a schedule on. Anything the
parser cannot read is rejected with a message naming the field and the reason, for example
`Invalid cron day-of-week field "FUNDAY": unrecognized value "FUNDAY"`.

**Daylight saving.** Schedules keep their wall-clock time across a transition, so a 9am
automation is 9am in both winter and summer. In the two edge hours:

- **Spring forward** — a schedule that lands in the hour that never happens (2am to 3am in
  Mountain time) runs once, at the moment the clock jumps, rather than being skipped for the day.
- **Fall back** — a schedule inside the hour that happens twice runs once, on the first pass,
  rather than firing twice.

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

Each card on `/automations` has a **History** disclosure listing the last ten runs: status,
when it started, how long it took, whether it was scheduled or a manual run, which retry
attempt it was, what it cost, and a link straight to the conversation or research run it
produced. A failed run shows its error; a successful one shows an excerpt of its output.

### Run now

Every card has a **Run now** button. It queues a manual `automation_run` job (priority above
the scheduled tier) rather than executing inline, because a tick can take minutes and a web
request must not be held open that long. Two guarantees:

1. **The schedule is not disturbed.** A manual run updates `lastRunAt` and the run history,
   and leaves `nextRunAt` exactly where it was. Pressing the button at 09:58 does not push a
   10:00 tick to tomorrow.
2. **A disabled automation can still be run.** That is the point: fix the cause, run once to
   verify, then switch it back on.

Double-clicking is harmless — manual runs within the same minute collapse into one job.

### Retries, backoff, and giving up

A failed tick is retried on an explicit escalating schedule rather than the queue's generic
per-type backoff, so an operator can see the policy:

| Event                       | What happens                       |
| --------------------------- | ---------------------------------- |
| Attempt 1 fails             | Wait 1 minute, try again           |
| Attempt 2 fails             | Wait 5 minutes, try again          |
| Attempt 3 fails             | Give up on this tick               |

Giving up rolls `nextRunAt` forward to the next scheduled slot — the system gives up on the
tick, not on the automation. Manual runs are never retried: a person is standing there and
can press the button again, and a manual failure does not count against the schedule's
failure streak.

### Failure surfacing

When a tick gives up, three things happen, for automations of **every** mode (not just the
maintenance mode that could already route to the inbox):

1. A **review item** opens in the Review Inbox (`job_failure`, payload
   `kind: 'automation_failure'`) carrying the automation, mode, attempt count, failure
   streak, and error. It is deduped per failure streak, so an automation failing every hour
   produces one inbox row, not one per hour. A successful run resets the streak, so the next
   breakage opens a fresh item.
2. A **notification** fires — an in-app notification row plus web push where configured.
3. The run is recorded in the history with its error.

### Disable after repeated failures

After **5 consecutive failed ticks** the automation is switched off and stamped
`disabledReason = 'consecutive_failures'`, so a permanently broken automation stops burning
budget. Because disabled automations are never enqueued, the spend stops immediately.

A system-disabled automation does not look like one the user turned off: the card's accent
bar turns red, the badge reads **auto-disabled** rather than "disabled", the failure streak
and last error are shown inline, and the page header counts how many rows are in that state.

Any successful run clears the streak and the stamp. Re-enabling from the UI also clears both
and re-derives `nextRunAt`, so the schedule genuinely resumes instead of sitting on a
timestamp in the past.

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

## Rewrite Authority

The current implementation is a baseline, not a constraint. This domain may be rewritten, restyled, reorganized, or replaced as needed to achieve the target product quality. No code path is off-limits if behavior contracts, safety controls, tests, and documentation remain correct.

## UI Contract

This domain follows the shared UX system in [../ui/spec.md](../ui/spec.md).

- Surfaces in this domain must align with the shared desktop/mobile shell patterns.
- Domain-specific states must be explicit in the UI (for example pending, running, blocked, completed) where applicable.
- Blocking user decisions must use the shared action-card and inbox patterns where applicable.

## References
- [../jobs/spec.md](../jobs/spec.md) - background execution and scheduling
- [../research/spec.md](../research/spec.md) - deep research runs
- [../tasks/spec.md](../tasks/spec.md) - plan and approval flow
- [../source-control/spec.md](../source-control/spec.md) - repository-aware automations
- [../observability/spec.md](../observability/spec.md) - review items and failures
- **Current code:** `src/lib/automation/automation.schema.ts`, `src/lib/automation/engine.ts`, `src/routes/automations/+page.svelte`

