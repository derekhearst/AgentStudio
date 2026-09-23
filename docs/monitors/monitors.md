# Monitors

## Overview

An automation answers "run this every so often". A monitor answers "watch for this, and do something when it happens": tell me when that vendor's status page changes, start a conversation when the build log says it finished, open an inbox item when a pull request's checks are all done.

Monitors are managed at **`/monitors`**. An agent can also leave one behind in the middle of a conversation — "the build is still running; I'll watch it and pick this up when it goes green" — with its `create_monitor` tool.

A monitor only ever looks while it watches. It observes through read-only tools, and the only thing it changes is what its action does, once, when the condition becomes true.

This page is the overview. [spec.md](spec.md) has the full detail: every field, every tool a monitor can observe with, and the reasoning behind each limit.

## Key concepts

| Concept | What it means |
| --- | --- |
| **Monitor** | A standing instruction: a condition, how often to check it, when to stop, and what to do when it comes true. |
| **Condition** | Either a **tool result** — run one read-only tool (fetch a page, read a file, list pull requests) and compare what comes back — or a **model question**, where a small model answers yes or no about what the tools found. |
| **Comparison** | For a tool result: *changed*, *equals*, *contains*, *matches* a pattern, *is not empty*, and their opposites. A *changed* monitor's first check only records a starting point. |
| **Action** | What happens when the condition comes true: **start a conversation**, open a **review item**, send a **push notification**, or **run an automation**. |
| **Interval** | How often to check: at least once a minute, at most once a day. |
| **Deadline** | When the monitor stops. Always set, at most 30 days away. |
| **Check budget** | How many checks it may make (200 by default, 2,000 at most). |
| **Status** | `active`, `paused`, `fired`, `expired`, `exhausted` (budget used up), `failed` (too many errors in a row) or `canceled`. |

## User flows

### Creating a monitor

1. The user fills in the form on `/monitors`, or an agent calls `create_monitor`.
2. The limits are applied: the interval, deadline and check budget are brought within their ranges. There is no "forever" — leaving the deadline out gives the 30-day maximum.
3. The first check happens on the next minute's pass, so a *changed* monitor records its starting point straight away.

If the monitor cannot be created — the 50-monitor limit is reached, an action is missing its setting, a tool argument is wrong — the form says so in plain words.

### Each check

1. Every minute a dispatcher finds the monitors that are due and queues a check for each, moving each one's next check a full interval ahead first so it is never checked twice at once.
2. The check observes the condition and records what it saw.
3. If the condition has just become true, the action runs. If it stays true, nothing more happens until it has gone false and come true again.
4. A **one-shot** monitor (the default) retires after its first action.

A check that fails — a page that would not load, a file that is missing — is recorded as an error, not as "the value is now empty", so an outage never looks like a change. The monitor backs off, and after five errors in a row it stops and opens a review item. A model question is checked against the owner's budget before any money is spent.

If the user pauses or cancels a monitor while a check is running, that check's result is thrown away and its action does not run.

### Extending

**Extend** (or the agent's `extend_monitor`) pushes the deadline out, measured from now and never past 30 days, and tops up the check budget. An expired or exhausted monitor becomes active again. A canceled one cannot be extended; create a new one.

## Roles and permissions

| Action | Who |
| --- | --- |
| Create, pause, check now, extend or cancel a monitor | Its owner (AgentStudio is single-user) |
| Create, list, extend or cancel monitors from a conversation | An agent, as the conversation's user, under the same limits |
| See what a monitor saw last and when it checks next | Its owner, on `/monitors` |

## Integrations

- **Job queue** — the minute-by-minute dispatcher and every check are jobs, visible in `/settings/jobs`. See [../jobs/jobs.md](../jobs/jobs.md).
- **Tools** — conditions observe through the same read-only tools an agent uses. The file tools (`Read`, `Grep`, `Glob`) look at the owner's own sandbox only.
- **Budgets** — model-question checks are checked against the owner's spend caps first; a blocked check spends nothing and opens a review item.
- **Review inbox, notifications, conversations, automations** — the four places an action can land.

## Business rules

- A monitor's condition cannot be edited; a different condition is a different monitor. Its name, interval, budget, one-shot setting and action can be.
- The deadline keeps running while a monitor is paused.
- An action runs once per change from false to true, never once per check.
- The monitor's state is saved before its action runs, so a crash can lose an action but can never run it twice.
- A model answer that is not a clear yes or no is an error, not a "no".
- File monitors stay inside the owner's sandbox. They do not follow symbolic links, read files over 2 MB, or return more than 1,000 results. A `Grep` check gives up after 10 seconds or rather than read more than 50 MB, so a badly written pattern cannot slow the rest of the app down.
- A user can have at most 50 monitors active or paused at once.
