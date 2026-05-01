# Hooks Spec

## Overview

Hooks are the extension surface of the AgentStudio runtime. They let you observe, instrument, and customize harness behavior at lifecycle boundaries without modifying the loop itself. Any agent, any user, or any built-in feature can subscribe to hooks. Hooks are isolated — a failing hook never fails the run.

## Data Model

### `hook_invocations` table

Audit log of every hook call, used for telemetry and debugging.

| Column       | Type      | Description                              |
| ------------ | --------- | ---------------------------------------- |
| `id`         | uuid      | Primary key                              |
| `runId`      | uuid?     | FK to `runs`                             |
| `jobId`      | uuid?     | FK to `jobs` (for job-lifecycle hooks)   |
| `event`      | text      | Hook event name (e.g., `after_tool`)     |
| `hookSlug`   | text      | Identifier of the hook that ran          |
| `durationMs` | integer   | Wall time for this invocation            |
| `success`    | boolean   | Whether the hook completed without error |
| `error`      | jsonb?    | Error details if `success = false`       |
| `output`     | jsonb?    | Hook return value if any                 |
| `createdAt`  | timestamp |                                          |

### Hook config on agents

`agents.config.hooks` is a map from event name to ordered list of hook slugs:

```json
{
	"after_run": ["hook/memory-capture", "hook/cost-alert"],
	"after_tool": ["hook/failure-detector"],
	"on_skill_loaded": ["hook/skill-telemetry"]
}
```

## Features

### Hook events

| Event                     | Payload fields                                                 | When                                     |
| ------------------------- | -------------------------------------------------------------- | ---------------------------------------- |
| `before_run`              | `runId`, `definition`, `environment`, `conversationId`         | Before the loop starts                   |
| `after_run`               | `runId`, `result`, `costUsd`, `durationMs`                     | After the loop ends (success or failure) |
| `before_round`            | `runId`, `round`, `messages`                                   | Before each LLM call                     |
| `after_round`             | `runId`, `round`, `content`, `toolCalls`                       | After each LLM call                      |
| `before_tool`             | `runId`, `toolName`, `args`                                    | Before tool execution                    |
| `after_tool`              | `runId`, `toolName`, `args`, `result`, `success`, `durationMs` | After tool execution                     |
| `on_compact`              | `runId`, `before`, `after`, `summary`                          | On context compaction                    |
| `on_evaluator`            | `runId`, `verdict`, `findings`                                 | On evaluator result                      |
| `on_subagent_spawn`       | `parentRunId`, `childRunId`, `agentId`                         | On `run_subagent` call                   |
| `on_approval_required`    | `runId`, `toolName`, `args`, `token`                           | On pending approval                      |
| `on_user_question`        | `runId`, `questions`, `token`                                  | On `ask_user` call                       |
| `on_run_failed`           | `runId`, `error`                                               | On run error                             |
| `on_skill_loaded`         | `runId`, `skillSlug`, `loadKind`                               | When a skill summary or body is loaded   |
| `on_tool_output_archived` | `runId`, `toolName`, `handle`, `wasSummarized`                 | When large tool output is offloaded      |

### Two hook backends

**TypeScript hooks** — registered programmatically via `registerHook(event, fn)`. Live in `src/lib/hooks/builtins/`. Used for first-party features: activity emit, cost tracking, telemetry, large-output archival. These are always on; they are not visible in the agent config.

**Skill-based hooks** — a skill named `hook/<event>` whose content is submitted as a prompt to a subagent. Lets users write hooks in markdown without touching TypeScript. Useful for custom post-processing, notification integrations, or compliance checks.

### Hook execution rules

- Hooks run after the triggering event; they cannot prevent the event that already happened.
- Exception: `before_run` and `before_tool` hooks can return an `abort: true` signal to stop the run or skip the tool call. This is the only blocking hook pattern.
- Each hook invocation runs in a sandbox with a configurable timeout (default: 5s for most events, 30s for `after_run`).
- Hook failures are logged to `hook_invocations` but do not propagate to the run. The run continues.
- Hooks within the same event fire in the order listed in `config.hooks`.

### Built-in hooks

These ship with AgentStudio and run for every agent unless explicitly disabled:

| Hook                    | Event             | What it does                                                       |
| ----------------------- | ----------------- | ------------------------------------------------------------------ |
| `capability-autoload`   | `before_run`      | Suggests enabling capability groups based on task spec keywords    |
| `activity-emit`         | `after_run`       | Writes an activity event for the UI activity feed                  |
| `cost-log`              | `after_run`       | Persists run cost to the cost domain                               |
| `memory-capture`        | `after_run`       | Enqueues a memory mining job for the completed session             |
| `compact-quality-check` | `on_compact`      | LLM check: did compaction lose critical context?                   |
| `tool-failure-detect`   | `after_tool`      | Pattern-matches tool errors and creates observability review items |
| `output-archival`       | `after_tool`      | Stores oversized outputs and emits `on_tool_output_archived`       |
| `skill-telemetry`       | `on_skill_loaded` | Records skill slug and load kind for prompt-bloat analysis         |

### Per-agent hook config

Each agent can add custom hooks on top of the built-ins via `config.hooks`. Order within an event: built-ins run first, then agent-specific hooks in array order.

### Hook management UI

`/settings/hooks` — global hook registry, enable/disable built-ins, view recent invocations.
`/agents/[id]/hooks` — per-agent hook overrides, custom hook slugs, invocation history.

## Behavior Contracts

- Built-in hooks cannot be removed from the registry; they can only be disabled per-agent or globally in settings.
- A skill-based hook is a fire-and-forget subagent run. Its output is logged but not returned to the parent loop.
- Hook invocation records are retained for 90 days by default (configurable).
- A hook that times out is marked `success = false` with an error of `TIMEOUT`; the run is not affected.
- `before_tool` abort signals must include a `reason` string that is emitted to the run event log.

## Roles & Permissions

| Action                          | Who can do it            |
| ------------------------------- | ------------------------ |
| View hook invocations           | Owner user, admin        |
| Add/remove per-agent hooks      | Owner user, admin        |
| Disable a built-in hook         | Admin only               |
| Register a new built-in hook    | Admin only (code change) |
| View another user's invocations | Admin only               |

## References

- [OpenCode (44 lifecycle hooks) — SST](https://github.com/sst/opencode) — reference for hook event taxonomy
- [Oh My OpenCode](https://github.com/code-yeongyu/oh-my-opencode) — performance harness built on hooks
- [Oh My Codex](https://github.com/Yeachan-Heo/oh-my-codex) — hooks + agent teams + HUD
- [Everything Claude Code](https://github.com/affaan-m/everything-claude-code) — skills/instincts/memory hooks
- [Building Effective Agents — Anthropic](https://www.anthropic.com/research/building-effective-agents) — composable primitives
- **Internal:** `src/lib/hooks/`, `src/lib/hooks/builtins/`, `src/lib/runtime/loop.server.ts`, `src/routes/settings/hooks/`
