# Activity Spec

## Overview

Activity is a lightweight audit log for significant user-facing events across AgentStudio. It powers the activity feed in the UI — a chronological stream of what happened, who did it, and what entity was affected. It is intentionally read-only and append-only: other domains write events into it, nobody edits or deletes them.

Above the feed, `/activity` opens with a **usage strip** (#38): the numbers that answer "what did the agents actually do this week?" — runs, tokens, automations, tool calls, the review inbox and budget headroom — plus a short list of things that look wrong. The same numbers can be sent every Monday as a **weekly usage digest**. Both are described under [Usage strip and weekly digest](#usage-strip-and-weekly-digest) below.

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

| Type                     | Triggered when                                          |
| ------------------------ | ------------------------------------------------------- |
| `task_created`           | A task is created                                       |
| `task_status_changed`    | A task moves to a new status                            |
| `agent_action`           | An agent completes a significant action                 |
| `chat_started`           | A chat conversation is started                          |
| `review_action`          | A review item is approved or denied                     |
| `skill_created`          | A skill is created                                      |
| `project_created`        | A project is created                                    |
| `project_status_changed` | A project moves to a new status                         |
| `memory_mined`           | Memory mining completed for a conversation              |
| `memory_conflict`        | Memory mining produced a conflicting entity or relation |
| `memory_updated`         | A user manually edited or deleted a memory entry        |

## Key Behaviors

- **Write via `emitActivity(type, summary, opts?)`** — all callers use this single function. It is fire-and-forget; failures should not block the calling operation.
- **Read via remote functions** — the activity feed is fetched by the `/activity` route using `listActivity()`, filtered by event type and capped at 200 rows (the page asks for the latest 100).
- **Agent actions come from the older agent loop only** — `agent_action` rows are written by the `after_tool` and `after_run` hooks, which fire in the loop used by agent-attached automations, monitor actions and PR fixes. Chat turns run on the Claude Agent SDK engine and write no `agent_action` rows, so a busy week of chatting shows little here. The usage strip above the feed is the place to see that work.
- **No mutations** — events are never updated or deleted. If a status change produces conflicting events, both are stored.
- **Entity links** — `entityId` + `entityType` together form a soft reference to another row. The activity feed uses these to render clickable deep-links to the affected object.

## Usage strip and weekly digest

### What the strip shows

The strip covers a rolling window — the last 24 hours, 7 days (the default) or 30 days, chosen with the switch at its top right. "Rolling" means it ends right now: "7 days" is the last 168 hours, not the calendar week, so the first morning of a week is not nearly empty.

| Tile | What it counts |
| --- | --- |
| Runs | Chat and agent runs started in the window, how many failed, and the failure rate. The rate leaves out runs the owner stopped and runs still going, and is not shown until at least 4 runs have finished. The failed count links to `/review`, which lists recent failures. |
| Tokens | Input + output tokens across every model call, with input, output and cache reads shown separately. Underneath: **metered** dollars. |
| Automation runs | Scheduled, manual and monitor-fired automation runs, how many failed, and what they cost. Failing automations are named and link to `/automations`. |
| Review inbox | Items waiting on a person right now, with how many are critical or warning. Not limited to the window: it is a to-do count. |
| Budget | How much of the tightest budget limit is spent, or **No limits set**. |
| Top models, Top agents | The three that used the most tokens. |
| Tool calls | Total calls and failures, and the five most-used tools. |

**Why tokens come first.** Claude models run on the Claude Code subscription and are recorded at $0 per turn. A dollar-first strip would make a busy week look free. Tokens are the real measure; dollars are labelled *metered* — what gateway models, OpenRouter calls and paid tools such as image and video generation actually charged. When any usage in the window came from the subscription, the strip marks the dollar figure and says so.

**Whose numbers.** Tokens, dollars, runs and tool calls are the whole instance's, the same as the cost panel on `/review`: AgentStudio has one owner, and background work such as embeddings and title generation records usage with no user attached. Automations, monitors and budget limits are the owner's.

### Needs a look

Above the tiles, a row of short warnings appears when something in the window looks wrong. It is hidden when there is nothing to say. Each rule has a floor so small numbers do not raise false alarms.

| Warning | When it appears | Severity |
| --- | --- | --- |
| Spend spike | Metered spend is more than **2×** the previous window of the same length **and** at least **$1** | Warning |
| Token spike | Input + output tokens are more than **2×** the previous window **and** at least **1M** | Warning |
| Run failure rate | At least **25%** of finished runs failed, with at least 4 finished | Warning |
| Automation switched off | The failure policy turned an automation off during the window after repeated failures | Critical |
| Automation newly failing | An automation failed in this window and had **no** failures in the previous one | Warning |
| Monitor never fired | A monitor reached its deadline, used up its checks, or gave up after errors during the window without ever firing | Warning |
| Monitor erroring | An active monitor's last **3** or more checks all errored | Warning |
| Budget near limit | A budget limit is **80%** spent (critical once it is over) | Warning / Critical |

The thresholds are first guesses and are easy to change: they are named constants at the top of `src/lib/costs/usage-digest.ts`.

### Budget headroom

The Budget tile reads the enforced budget limits — the same limits that can block a run — and computes spend exactly the way enforcement does, so the tile can never say "40% used" about a limit that is already blocking. Per-run limits are left out because they have no standing period. There is no screen for creating budget limits yet, so most instances show **No limits set**. The daily and monthly figures under Settings → Budget are a separate, display-only setting and are not shown here.

### The weekly digest

The same numbers and warnings can be sent every Monday at 9:00, as markdown, to the review inbox or to a chat thread.

1. On `/activity`, under the tiles, choose **Review inbox** or **Chat** next to "Get this every Monday".
2. This creates an ordinary maintenance automation called "Weekly usage digest", scheduled for Monday 09:00 in the browser's time zone. The strip then shows "Weekly digest on" with a link to manage it. If a digest already exists but is switched off, the buttons switch it back on (to the destination chosen); they never make a second one.
3. Each Monday the automation runs like any other: it appears in the automation's run history, and a failure is retried and reported the usual way.
4. To stop it, change the day, or delete it, use `/automations`.

What it costs and what it does not do:

- **No model is called.** The digest is written by code from the ledgers, so each run costs $0 and works with no model credentials at all. It restates numbers; it does not interpret them.
- **Nothing is turned on by deploying.** No digest exists until the owner presses the button. (Seeding one at startup would also bring it back after the owner deleted it.)
- In the review inbox, the digest is an "Automation summary" item; expanding it shows the markdown rendered. In chat, it is an assistant message in a thread that collects every week's digest.

A digest can also be written by hand on `/automations`: a **maintenance** automation whose prompt is exactly `{{usage_digest}}` is the digest. `{{usage_digest:30}}` covers the last 30 days instead (1 to 30; anything outside is clamped). Only a prompt that is the placeholder and nothing else counts — text around it would be an instruction for a model, and this path has none.

### Known gaps

- **Tool calls from the older agent loop are not counted.** Agent-attached automations, monitor actions and PR fixes still run tools through the older loop, which does not write tool-call rows. Chat turns (the SDK engine) are counted in full. The strip says this in its footnote.
- **Automation history is kept for 30 days**, which is why the longest window is 30 days.
- **Token counts are approximate across sources.** Chat turns record input tokens net of cache (cache is counted separately), while some OpenRouter paths count input including cache.

## Roles & Permissions

| Action                | Who can do it       |
| --------------------- | ------------------- |
| View activity feed    | Authenticated users |
| Filter by entity/type | Authenticated users |
| View the usage strip  | Authenticated users |
| Turn on the weekly digest | Authenticated users (the owner) |
| Write events          | Server-side only    |
| Delete/edit events    | Nobody              |

The feed is instance-wide (events have no owner), and reading it requires a signed-in session. The strip's queries check the session the same way.

## Integrations

Activity events are emitted by all major domains:

- `tasks/` on create and status change
- `agents/` on significant actions
- `chat/` on conversation start
- `observability/` on review approvals/denials
- `skills/` on skill creation
- `projects/` on create and status change
- `memory/` on mining completion, conflicts, and user edits

The usage strip reads other domains' ledgers rather than activity events: `llm_usage` and `tool_usage` (cost), `chat_runs` (runs), `automation_runs` and `automations`, `monitors`, `review_items` (observability) and `budget_limits`. See [../cost/spec.md](../cost/spec.md) and [../automations/spec.md](../automations/spec.md).

## Rewrite Authority

The current implementation is a baseline, not a constraint. This domain may be rewritten, restyled, reorganized, or replaced as needed to achieve the target product quality. No code path is off-limits if behavior contracts, safety controls, tests, and documentation remain correct.

## UI Contract

This domain follows the shared UX system in [../ui/spec.md](../ui/spec.md).

- Surfaces in this domain must align with the shared desktop/mobile shell patterns.
- Domain-specific states must be explicit in the UI (for example pending, running, blocked, completed) where applicable.
- Blocking user decisions must use the shared action-card and inbox patterns where applicable.
