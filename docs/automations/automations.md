# Automations

## Overview

An automation is a prompt that runs on a schedule without anyone at the keyboard: "every weekday at 9, summarize what changed in the project", "every Sunday night, research what competitors shipped". The user writes the prompt, picks a schedule and a time zone, and AgentStudio runs it on the server — the laptop can be closed.

Automations are managed at **`/automations`**. Each one shows as a card with its schedule, its last few runs, and buttons to run it now, switch it off or on, duplicate it or delete it.

This page describes how automations behave. The data model and design history are in [spec.md](spec.md) and [plan.md](plan.md); the job queue that runs them is described in [../jobs/jobs.md](../jobs/jobs.md).

## Key concepts

| Concept | What it means |
| --- | --- |
| **Automation** | A saved prompt plus when to run it. Belongs to one user. |
| **Schedule** | A standard five-field cron line (`0 9 * * 1-5` is "weekdays at 9"), read in the automation's own time zone. |
| **Slot** | One scheduled moment — "Tuesday 09:00". The automation's `nextRunAt` is the next slot. |
| **Mode** | What a run does. **Chat follow-up** writes the prompt into a conversation and has the model (or an attached agent) reply. **Research** starts a research report on the prompt. **Maintenance** runs the prompt and routes a summary somewhere. |
| **Conversation mode** | For chat follow-up: a **new conversation each run**, or **reuse** one conversation as a running log. A run sees the last 12 messages of its conversation. |
| **Output target** | Where the result lands: the automation's **chat session** (the default) or the **Review inbox**. |
| **Run** | One attempt at a slot, recorded in the run history with its status (`running`, `completed`, `failed`, `blocked`), trigger (scheduled or manual), attempt number, duration, cost, and a link to what it produced. |
| **Failure streak** | How many scheduled slots in a row ended in failure. Five in a row switches the automation off. |

## User flows

### Creating an automation

1. On `/automations` the user fills in a description, the prompt, a schedule and a time zone (the browser's own is pre-selected), and optionally an agent, a mode and an output target.
2. The schedule is checked as it is saved. A typo is rejected with a message naming the field, for example "Invalid cron day-of-week field "FUNDAY"".
3. The automation's first slot is worked out from the schedule, and the card appears.

**Duplicate** copies an existing card's settings into the form, so a variation can be made without retyping.

### A scheduled run

1. Every minute, a dispatcher looks for switched-on automations whose next slot has arrived, and queues one run for each.
2. A worker picks the run up and executes it in the automation's mode.
3. When it succeeds, the run is recorded, the failure streak resets, and the next slot is worked out from the schedule.
4. The card's history shows the run, with a link to the conversation or research report it produced.

Each slot gets exactly one run, however many times the dispatcher sees it due while that run and its retries play out.

### When a run fails

1. The first attempt fails: the automation waits 1 minute and tries again.
2. The second attempt fails: it waits 5 minutes and tries again.
3. The third attempt fails: the automation gives up on that slot. The slot counts as one failure in the streak, the next slot is scheduled, a **review item** opens in the Review inbox, and a notification is sent.
4. After five failed slots in a row, the automation is switched off and marked **auto-disabled**, so a broken automation stops spending money. Its card turns red and shows the error.

If the job queue itself gives up on an attempt — the server kept dying while running it, the server was down so long that the attempt was abandoned, or someone canceled it in `/settings/jobs` — the automation's own failure handling never runs. The dispatcher notices on its next pass that nothing is left to run for that slot, skips it, and carries on from the next one. That skip is logged; the queue's own records say what happened to the attempt.

### Run now

1. The user presses **Run now** on a card.
2. A manual run is queued and executes shortly after, even if the automation is switched off — that is how a fix is verified before switching it back on.
3. The run appears in the history as a manual run. The schedule is not touched: pressing the button at 09:58 does not push a 10:00 run to tomorrow, and a manual research run does not use up the next scheduled report.

Manual runs are not retried and do not count toward the failure streak; the person who pressed the button can press it again.

### Switching an automation off

Switching an automation off stops new runs. A retry that was already waiting is skipped when its turn comes — quietly, without a failure notification, because nothing failed. Switching it back on works out a fresh next slot from the schedule, so it does not fire immediately for a slot that passed while it was off.

## Roles and permissions

| Action | Who |
| --- | --- |
| Create, edit, run, duplicate, switch off or delete an automation | Its owner (AgentStudio is single-user) |
| Create, list, change or delete automations from a conversation | An agent, through its automation tools, acting as the conversation's user |
| See an automation's run history | Its owner |
| Lift a budget block that stopped a run | Its owner, from the Review inbox |

A monitor can trigger an existing automation (see [../monitors/spec.md](../monitors/spec.md)).

## Integrations

- **Job queue** — every run is a job, so runs survive a restart and show up in `/settings/jobs`. See [../jobs/jobs.md](../jobs/jobs.md).
- **Chat and agents** — chat follow-up runs write into conversations and can use an attached agent.
- **Research** — research mode starts a research report and links it to the automation's conversation.
- **Budgets** — before each run, the owner's spend caps are checked. A run that would exceed a blocking cap is not executed; it is recorded as **blocked**, the slot moves on, and a review item lets the owner lift or keep the cap.
- **Review inbox and notifications** — failures, budget blocks and maintenance summaries routed to the inbox appear there; failures also send a notification.
- **Monitors** — a monitor's "run an automation" action queues a run of an existing, switched-on automation.

## Business rules

- A schedule keeps its wall-clock time across daylight saving: a 9am automation is 9am in winter and summer. A slot inside the skipped spring-forward hour runs once when the clock jumps; one inside the repeated fall-back hour runs once, on the first pass.
- `@reboot` is not accepted — automations have no boot event.
- One run per slot. Retries belong to the slot they are retrying.
- Giving up on a slot moves the schedule on; it never gives up on the automation until five slots in a row have failed.
- A disabled automation is never queued by the scheduler, but can always be run by hand.
- Run history is kept for 30 days.
