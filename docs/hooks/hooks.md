# Hooks

This page describes hooks in plain English. The fuller design, including events that are planned but not yet raised anywhere, is in [spec.md](spec.md); the build history is in [plan.md](plan.md).

## Overview

A hook is a small piece of work that runs when something happens during an agent's run: a run starts, a tool is used, a run ends. Hooks watch; they never change or stop the run. A hook that fails or is slow is recorded and otherwise ignored, so it can never break a chat or an automation.

The owner sees every hook that ran, and whether it worked, at `/settings/hooks`.

## Key concepts

### Two kinds of hook

| Kind | What it is | Who sets it up |
| ---- | ---------- | -------------- |
| Built-in | Part of the app. Most run for every agent. | The app, at startup |
| Skill hook | A skill whose instructions are sent, with the event's details, to a small model. Its answer is recorded. | The owner, by binding the skill's name to an event on an agent |

A built-in can also be **opt-in**: it exists, but runs only for an agent that binds it by name.

### Bindings

Each agent's page has a **Hook bindings** section. For each event you list the hooks that should run for that agent: skill names, or the names of opt-in built-ins. Bindings add to the built-ins that run for everyone; they never switch those off.

### Built-in hooks today

| Hook | Event | What it does |
| ---- | ----- | ------------ |
| `activity-impactful-tools` | after a tool | Adds a line to the activity feed when an agent runs `Bash`, `Write`, `Edit`, `delete_file` or `move_file`, e.g. "ran Bash (120ms)". Read-only tools are left out, because they are noise in the feed. |
| `activity-run-completed` | after a run | Adds one "Agent run completed" line to the activity feed when a run finishes successfully. |

## Where hooks run

Hooks run for chats and for background work alike.

| Event | In a chat | In automations, monitors and PR fixes |
| ----- | --------- | ------------------------------------- |
| `before_run` | When the turn starts | When the run starts |
| `before_tool` | When a tool call is cleared to run — straight away, or once you approve it | Before each tool call |
| `after_tool` | When the call finishes, with its result, whether it worked, and how long it took | After each tool call |
| `on_approval_required` | When an approval card appears | — |
| `on_user_question` | When the agent asks you a question | — |
| `after_run` | When the turn ends, with its cost, and whether it succeeded | When the run ends |
| `on_run_failed` | When the turn fails, with the error | — |

The other events in the binding editor (`before_round`, `on_compact`, `on_skill_loaded` and so on) are not raised anywhere yet, so binding them does nothing for now.

In a chat, a tool call is reported exactly as it appears in the conversation, including the built-in `Bash`, `Write` and `Edit`. When the agent hands work to another agent, that agent's own tool calls are not reported as the chat agent's, but an approval card it raises is. The hand-off itself is the chat agent's call and is reported as the `Agent` tool: `before_tool` when the child starts, `after_tool` when it finishes, with the child's final report as the result. A hand-off that was refused (for example because four children were already running) is reported as a failed call with the reason.

The agent a chat hook runs for is the agent the conversation uses. A conversation that names no agent uses the built-in Chat agent, so the Chat agent's bindings apply to it.

Before this, hooks only ran for automations, monitors and PR fixes. Interactive chats never raised an event, so agent bindings and the activity lines above did nothing for chats, although the agent page said the built-ins fired automatically.

## User flows

### Bind a hook to an agent

1. Open the agent at `/agents/[id]` and press **Edit** in its configuration panel.
2. Under **Hook bindings**, type the hook names for an event, separated by commas — for example `hook/failure-detector` under `after_tool`.
3. Save. The next event of that kind on that agent runs the hook.
4. Check `/settings/hooks` to see each time it ran, how long it took, and any error.

### See what hooks did

`/settings/hooks` lists recent hook runs with the event, the hook's name, whether it worked and how long it took. A built-in hook that fails also opens an item in the review inbox, once per run and hook, so a broken hook is noticed without flooding the inbox.

## Roles & permissions

AgentStudio has a single owner. The owner binds hooks on any agent and sees every hook run. New built-in hooks can only be added in code.

## Business rules

- A hook never blocks, changes or fails the run it watches. It runs in the background with a time limit (5 seconds for built-ins, 8 for skill hooks).
- Every hook run is recorded, successful or not — including a built-in that looked at the event and had nothing to do, such as `activity-impactful-tools` after a `Read`.
- Records are kept for 14 days and then deleted by the daily log clean-up, the same one that trims the server log (`APP_LOGS_RETENTION_DAYS` changes both). Since chats raise hook events, every chat tool call adds records, and before this nothing ever removed them.
- An opt-in built-in runs only for agents that bind it. (Opt-in hooks used to run on every event, and twice for an agent that bound one.)
- A binding that names neither a built-in nor an existing, enabled skill is recorded as a failure with the reason, "skill not found" or "skill is disabled".
- A skill hook sees at most the first 4,000 characters of the event's details.
