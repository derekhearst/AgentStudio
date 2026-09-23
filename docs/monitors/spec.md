# Monitors Spec

## Overview

An automation answers **"run this every N."** A monitor answers **"watch for X and act when it happens."**

That second question is the one an always-on, self-hosted box should be good at, and until now nothing in AgentStudio could express it. A monitor is a standing instruction someone left behind: a condition to observe, how often to look, a date it stops mattering, and what to do the moment the answer changes.

Who uses it:

- **An operator**, from `/monitors` — "tell me when that vendor's status page changes."
- **An agent, mid-conversation**, via the `create_monitor` tool — "I can't answer that yet because the build is still running. I'll leave a monitor on it and start a conversation when it goes green."

Monitors deliberately cannot change anything while they watch. They observe with a read-only tool allowlist, and the only writes they make happen on the firing edge, through one of four explicit actions.

## Key concepts

### The monitor

| Field                    | Meaning                                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------------------------- |
| `name`                   | Short label shown in the UI and in whatever the action produces                                        |
| `status`                 | `active`, `paused`, `fired`, `expired`, `exhausted`, `failed`, `canceled`                              |
| `conditionKind`          | `tool_result` or `model_question` — see below                                                          |
| `condition`              | The stored condition; its shape depends on the kind                                                    |
| `action` / `actionConfig`| What happens on the firing edge                                                                        |
| `intervalSeconds`        | How often to check. Floor of 60 seconds, ceiling of 24 hours                                           |
| `deadlineAt`             | When the monitor stops. Never empty; at most 30 days out                                               |
| `maxChecks` / `checkCount` | The spend cap and how much of it has been used                                                       |
| `lastObservation`        | What was seen last time — the value, a hash of it, when, and whether the condition held                |
| `conditionMet`           | The debounce latch. True while the condition is satisfied                                              |
| `oneShot`                | Retire after the first fire. Default true                                                              |
| `consecutiveErrors` / `lastError` | The error budget                                                                              |

### Two kinds of condition

**`tool_result`** runs one read-only tool on each check, optionally narrows the result with a dotted path, and compares it:

- `changed` — fires when the value differs from the last observation. **The first check only records a baseline and never fires**; without that rule every monitor would fire the instant it was created.
- `equals`, `not_equals`, `contains`, `not_contains`, `matches` (regex), `not_empty` — test the value directly.

Narrowing matters. A whole `web_fetch` result carries a `fetchedAt` timestamp that changes every single check, so `extract: "text"` is usually what you want. The creation form suggests `text` for `web_fetch` only; for every other tool it starts empty, meaning "compare the whole result".

Two rules about what a comparison sees:

- **It sees the whole value.** Only the first 4,000 characters of an observation are stored and shown as the last observation, to keep the row small. The comparison itself reads everything the tool returned, so "does not contain *Out of stock*" is judged against the whole page, not just its top.
- **A missing path is an error.** If `extract` names a field the tool's result does not have — `text` on a pull-request list, say — the check fails with "extract path … was not found" rather than quietly observing the word `null` on every check. It goes down the normal error path, so a monitor pointed at the wrong field retires as `failed` after five checks and says why. A field that is present but empty (`null`) is still a real observation.

**`model_question`** fetches context with the same read-only tools, then asks a cheap model a yes/no question about it — "have all the checks on this PR finished?", "does this page now mention a shipping date?". This is what makes monitors general, and it is the only part that costs money per check, so it is gated (below).

Observable tools, all read-only:

| Tool | What a monitor sees |
| ---- | ------------------- |
| `web_fetch` | A page: `{ title, url, text, fetchedAt }` |
| `web_search` | Search results |
| `Read` | The text of one file (or the lines asked for with `offset` / `limit`), as plain text — compare it directly, no `extract` needed |
| `Grep` | Files containing a pattern — as a list of paths (the default), one entry per matching line (`output_mode: "content"`), or a count per file (`"count"`) |
| `Glob` | Paths matching a pattern such as `reports/*.pdf`, sorted |
| `file_info` | A file's size and modified time |
| `list_pull_requests`, `get_pull_request` | Pull requests on a connected repository |
| `list_projects` | The user's projects |

Anything that writes — `Bash`, `Write`, `push_branch` — is absent by construction, and the schema rejects it.

**Files.** `Read`, `Grep` and `Glob` take the same arguments an agent passes them, and look at the owner's whole sandbox: paths are relative to it, so a project's build log is `projects/<project id>/build.log`. Nothing outside the sandbox can be reached: `Read` refuses a symbolic link that points outside it, and `Glob` and `Grep` do not follow symbolic links at all — they neither list one nor look inside it, even when the pattern names it. A file over 2 MB is not read, and at most 1,000 results come back. An argument the monitor does not support is rejected when the monitor is created, rather than ignored on every check.

**Grep limits.** A `Grep` pattern is a JavaScript regular expression, and the model may have written it. A badly written one can take practically forever on the wrong text, so the search runs apart from the rest of the server. A check gives up after 10 seconds, or rather than read more than 50 MB across all files, and only the first 10,000 characters of a very long line are searched. Hitting the time or size limit fails the check with a message saying which, and suggesting a narrower pattern, path or glob; the rest of the app is not slowed down by it.

**No git tools.** `git_status`, `git_log` and `git_diff` only work inside a per-run git worktree, and a monitor has neither a run nor a worktree, so they are not offered. A monitor created before this change that still names one of them — or one of the file tools' old names, `file_read`, `search_files` and `list_directory` — fails its checks with a message saying the tool can no longer be observed, and should be canceled and recreated.

### Four actions

| Action               | What it does                                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `start_conversation` | Opens a conversation seeded with the configured prompt plus what was observed, and runs the agent on it detached |
| `review_item`        | Opens a `monitor_fired` item in the review inbox                                                                  |
| `push`               | Writes an in-app notification row and sends a web push                                                            |
| `run_automation`     | Runs one of the owner's own automations once (see Business rules)                                                 |

## User flows

### Creating a monitor

1. An operator fills the form on `/monitors`, or an agent calls `create_monitor`.
2. The caps are applied at creation: the interval is clamped, the deadline is clamped to at most 30 days from now, and the check budget is clamped. There is no way to ask for "forever" — omitting the deadline yields the maximum, not the absence of one.
3. `nextCheckAt` is set to now, so the first check lands on the next dispatch tick and the baseline is recorded immediately.

If the monitor cannot be created, the form says why in plain words — the 50-monitor ceiling has been reached, an action is missing its setting (a prompt, an automation), or a tool argument is wrong — rather than a generic failure. The same goes for Extend on a canceled monitor and Check now on one that is not active.

### Each check

1. A scheduled job, `monitors_dispatch`, runs every 60 seconds. It first retires anything past its deadline, then finds monitors whose next check is due.
2. For each, it **claims** the monitor — pushing `nextCheckAt` one interval forward in a single conditional update — and enqueues a `monitor_check` job. A check that outruns the tick interval therefore cannot be dispatched twice while it is still running.
3. The `monitor_check` handler observes the condition, then does exactly one of four things:

| Outcome     | What happens                                                                                                                                                      |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **false**   | Record the observation, clear the latch, reschedule. Routine.                                                                                                       |
| **true**    | Record the observation, set the latch, increment the fire counter, then run the action.                                                                             |
| **error**   | Record the error, back off geometrically (2× per consecutive error, capped at 8×), and **leave the last observation untouched**.                                    |
| **blocked** | A budget cap would have been crossed. Nothing was spent, no check is counted, and a `policy_override_request` is opened so an operator can lift the cap or hold it. |

The error case deserves its own note: treating a failed fetch as "the value is now empty" would read as a change and fire the action during an outage. So an errored check never overwrites the baseline. After five consecutive errors the monitor retires as `failed` and opens a review item.

**A cancel or pause during a check wins.** A check can take several seconds, and the monitor is not locked while it runs. If the user cancels or pauses the monitor in that window — or a second check of the same monitor (say, a "Check now" alongside the scheduled one) finishes first — the slower check's result is thrown away: nothing is recorded, nothing is counted against the budget, no review item opens and the action does not run.

### Firing

Firing is **edge-triggered**. The action runs on the false→true transition only. A condition that stays true for a week produces one action, not one per check; when the condition goes false again the monitor re-arms.

State is written to the database *before* the action runs. That ordering is deliberate: a crash mid-dispatch can lose an action, but it can never double-fire, because the latch and fire counter are already committed and a retried job sees an edge that has already been consumed. Actions themselves never throw — a failed action falls back to a critical review item so the observation is never silently lost.

### Extending

Extension is explicit, by design. `extend_monitor` (tool) or the Extend button (UI) pushes the deadline out **measured from now** and re-clamped to the 30-day ceiling, so repeated extensions cannot compound into an immortal monitor, and tops up the check budget. A monitor that expired or exhausted its budget becomes active again if the extension leaves it with both time and budget. A canceled monitor cannot be extended — create a new one.

## What stops a monitor running forever

In the order they bite:

1. **The debounce latch** — one action per rising edge, not one per check.
2. **`oneShot`** — the default; the monitor retires the moment it fires.
3. **`maxChecks`** — the spend cap, default 200, hard ceiling 2,000, counted in checks actually performed.
4. **`deadlineAt`** — the wall-clock cap, at most 30 days, extended only on request.
5. **The error budget** — five consecutive failed checks and it stops asking.
6. **Per-user ceiling** — at most 50 active or paused monitors per user.

## Roles and permissions

Single-user deployment, so every monitor belongs to the user who created it and every read and write is scoped to that user. There is no admin-wide monitor view. An agent creating a monitor mid-conversation creates it as the conversation's user and is subject to the identical caps — nothing about the tool path is privileged.

## Cost control

The `model_question` path calls `checkBudgetLimits` **before** every model call, with the same user and agent scope the automation engine uses. If an applicable `block` cap would be crossed, no call is made, nothing is spent, no check is counted against the budget, and the monitor reschedules at its normal interval. Tokens that *are* spent are written to `llm_usage` with `source: 'monitor'`, so the next check's gate sees them and monitor spend is separable from automation spend in the cost dashboard.

The `tool_result` path costs nothing beyond whatever the tool itself costs, which is why it is the default and the one the tool description steers toward.

## Integrations

| System                    | How monitors use it                                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| `jobs/`                   | `monitors_dispatch` (scheduled, 60s) and `monitor_check` (per monitor) — leases, retries, forensics |
| `tools/`                  | Conditions observe through the normal `executeTool` path, so a monitor sees what an agent sees. The SDK file tools (`Read`, `Grep`, `Glob`) have no handler there — the engine gives them to the model directly — so the monitor runs those itself, read-only, over the owner's sandbox |
| `costs/budget.server`     | The gate on the model path                                                                          |
| `observability/review`    | `monitor_fired` items on the firing edge and on a retirement without firing                          |
| `notifications/`          | In-app rows plus web push for the `push` action                                                     |
| `runtime/`                | The detached agent loop behind `start_conversation`                                                 |
| `automations/`            | `run_automation` checks the automation is still the owner's and switched on, then enqueues `automation_run` by job type, without importing the engine |

## Business rules

- A monitor's **condition is immutable**. Name, interval, budget, one-shot and action config can be edited; a different condition is a different monitor.
- A `run_automation` monitor can only point at **one of its owner's own automations**. The automation is checked when the monitor is created, when its action config is edited, and again at the moment it fires (the automation may have been deleted in between). An automation that is missing or belongs to someone else is reported as "not found" either way.
- A monitor-fired automation run is recorded with the trigger **monitor**. It sits between a scheduled run and "Run now":
  - Like "Run now", it **does not move** the automation's next scheduled time.
  - Like a scheduled run, it **respects the off switch**. If the automation is switched off — by its owner, or automatically after repeated failures — the monitor does not run it: the action fails and falls back to a critical review item that says so, so the observation is not lost. If the automation is switched off after the run was queued, the run is skipped quietly (see the automations spec).
  - Like a scheduled run, a **failure is reported**: it is retried with the same backoff, then counts toward the automation's failure streak and opens a review item plus a notification. Nobody is watching a monitor-fired run, so a failure must not be silent.
- A monitor's deadline applies while paused. Pausing buys no extra lifetime.
- A `changed` monitor's first check is a baseline and never fires.
- An unparseable model answer is an **error**, not a "no" — silently reading it as "condition not met" would make a monitor quietly useless for the rest of its life.
- A tool reporting failure is an **error**, not an observation of nothing.
- Deleting a user cascades their monitors; deleting an agent nulls the monitor's agent pointer and the monitor keeps running.

## Surfaces

- **`/monitors`** — the list with what each monitor is watching, its last observation, next check, budget used, and deadline, plus Pause / Check now / Extend / Cancel, and a creation form. Monitors live here rather than under `/settings/jobs` because a monitor is a standing user intention with its own lifecycle, the same class of thing as an automation; `/settings/jobs` is the queue's forensic view and the `monitor_check` rows already show up there.
- **`/review`** — `monitor_fired` items.
- **`/settings/jobs`** — every check as a job row, with its result payload.

## Agent tools

| Tool             | Purpose                                                       |
| ---------------- | ------------------------------------------------------------- |
| `create_monitor` | Leave a watcher behind mid-conversation                        |
| `list_monitors`  | What am I already watching?                                    |
| `cancel_monitor` | Stop watching (terminal)                                       |
| `extend_monitor` | Push the deadline out and top up the budget, explicitly        |

`create_monitor` returns the expiry in its result and instructs the model to repeat it back — a monitor the user does not know is running is the failure mode worth designing against.
