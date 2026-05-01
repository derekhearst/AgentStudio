# Runtime Spec

## Overview

The runtime is the transport-agnostic core of AgentStudio's agent loop. It owns the LLM call cycle, tool execution, context assembly, compaction, skill loading, output offloading, and event emission. It does not know about HTTP, SSE, WebSockets, or any other delivery channel. Any entry point — chat stream, automation, scheduled job, sub-agent spawn — constructs three primitives and hands them to `runAgentLoop`.

## Data Model

### AgentDefinition

The fully-resolved description of the agent for one run. Assembled once before the loop starts; the loop never re-reads tables.

| Field              | Type              | Description                                                       |
| ------------------ | ----------------- | ----------------------------------------------------------------- |
| `id`               | string            | Agent record ID                                                   |
| `systemPrompt`     | string            | Assembled from identity skill + role + policies + skill summaries |
| `model`            | string            | OpenRouter model slug                                             |
| `reasoning`        | ReasoningConfig?  | Extended thinking settings                                        |
| `toolAllowList`    | string[]?         | Explicit tool allow-list; null = use capability groups            |
| `capabilityGroups` | CapabilityGroup[] | Active groups for this run                                        |

### Environment

The execution environment for one run. Constructed by `buildEnvironment`, which delegates to the workspace domain.

| Field                   | Type                             | Description                                        |
| ----------------------- | -------------------------------- | -------------------------------------------------- |
| `workspaceRoot`         | string                           | Absolute path to the run's sandbox directory       |
| `approvalRequiredTools` | Set\<string\>                    | Tools that require human approval before execution |
| `mcpServers`            | McpServerRef[]?                  | MCP server references for this run                 |
| `envVars`               | Record\<string, string\>?        | Process-level env overrides                        |
| `networkPolicy`         | 'open' \| 'restricted' \| 'none' | Network access level for sandboxed tools           |

### Session

A stateful event bus for one run. The Session is the only thing that touches SSE, database run state, or approval flows.

| Field             | Type                          | Description                                      |
| ----------------- | ----------------------------- | ------------------------------------------------ |
| `runId`           | string                        | FK to `runs`                                     |
| `sessionId`       | string                        | FK to `sessions`                                 |
| `taskId`          | string?                       | FK to `tasks` if run is task-attached            |
| `parentRunId`     | string?                       | FK to parent run for sub-agent sessions          |
| `emit`            | (event) => Promise\<void\>    | Dual-writes to SSE stream and `run_events` table |
| `getMessages`     | () => Promise\<LlmMessage[]\> | Loads current message history                    |
| `appendMessage`   | (m) => Promise\<void\>        | Persists a message                               |
| `pendingApproval` | (req) => Promise\<boolean\>   | Blocks until user approves or denies a tool call |
| `pendingQuestion` | (req) => Promise\<Answer[]\>  | Blocks until user answers via `ask_user`         |

## Features

### Single loop, multiple entry points

`runAgentLoop(definition, environment, session)` is the only entry point for agent execution. Chat streaming, automations, scheduled jobs, and sub-agent spawns all call the same function. The delivery channel is the caller's concern; the loop emits events through `session.emit`.

### Prompt assembly

Before the loop starts, the runtime assembles the system prompt in this order:

1. Identity skill content (from `agents.identitySkillId` linked skill)
2. Agent role description
3. Active task spec (if `session.taskId` is set)
4. Companion skill summaries relevant to the current capability groups
5. Tool usage policies (injected automatically from the policies domain)
6. Capability group summary

The loop never modifies the assembled system prompt mid-run.

### Active tool budget

- Default turn: 8–12 active tools maximum
- Hard ceiling: 15 active tools before the runtime considers context overloaded
- Only `alwaysOn` capability group tools are active at start; other groups are added when `enable_capability` is called
- Tool descriptions are kept short; operating guidance lives in companion skills

### Progressive skill loading

- Skill summaries (short) are included in the initial system prompt
- Full skill bodies are loaded into context only when the model calls `read_skill` or when a hook determines they are needed
- `on_skill_loaded` hook event fires when any skill body enters the context window

### Tool output context policy

Large tool outputs are not returned verbatim into the live model context:

1. Raw output is stored durably (in `run_events` or blob storage)
2. The model receives: a one-paragraph summary + the first and last N lines of output + a pointer it can use to request more
3. Old tool outputs are compacted preferentially before user messages or task state
4. `on_tool_output_archived` hook event fires when an output is offloaded

### Context compaction

When the context window approaches capacity:

1. Tool outputs are compacted first (replaced with their archived summaries)
2. Older assistant/tool turns beyond a rolling window are summarized
3. User messages and the current task spec are preserved as long as possible
4. `on_compact` hook event fires with before/after token counts and the compaction summary

### Approval gating

If a tool is in `environment.approvalRequiredTools`, the loop suspends via `session.pendingApproval` before executing. The suspension is durable — the loop can resume after a process restart because approvals are persisted in the `runs` table, not held in memory.

### Sub-agent spawning

A sub-agent run is a `runAgentLoop` call with:

- Its own `AgentDefinition` (narrower tools, different model)
- A child `Session` whose `emit` forwards events to the parent's event bus
- `parentRunId` set to the parent run

The parent run is not blocked during sub-agent execution; it awaits the child's `RunResult`.

### Hooks

The runtime fires typed hook events at every significant boundary:

| Point                 | Event                     |
| --------------------- | ------------------------- |
| Before loop start     | `before_run`              |
| After loop ends       | `after_run`               |
| Before each LLM round | `before_round`            |
| After each LLM round  | `after_round`             |
| Before tool execution | `before_tool`             |
| After tool execution  | `after_tool`              |
| On compaction         | `on_compact`              |
| On skill load         | `on_skill_loaded`         |
| On output offload     | `on_tool_output_archived` |
| On sub-agent spawn    | `on_subagent_spawn`       |

## Behavior Contracts

- The loop is idempotent with respect to `session.emit` — replaying events produces the same observable state.
- A failing hook never fails the run. Hook errors are logged and the loop continues.
- The assembled `AgentDefinition` is immutable for the duration of a run. Tool allow-lists and model cannot change mid-run.
- `runAgentLoop` returns a `RunResult` regardless of whether the run succeeds or fails. Errors are captured in the result, not thrown.
- The runtime never reads from agent/conversation tables directly inside the loop. All data was resolved during the pre-loop build step.
- Tool outputs that exceed the size threshold are archived before the next round begins, not lazily.

## Roles & Permissions

- Any authenticated user can start a run via a chat session.
- Automation engine starts runs as a system actor (no user session).
- Admin users can inspect live run state and terminate runs.
- Tool execution is governed by the policies domain, not by the runtime directly. The runtime delegates the decision; it does not make it.

## References

- [The Design of Claude Managed Agents — Anthropic](https://www.anthropic.com/engineering/managed-agents) — brain/hands/session primitive decoupling
- [Building Effective Agents — Anthropic](https://www.anthropic.com/research/building-effective-agents) — composable primitives over opinionated workflows
- [How the Claude Code Team Designs Agent Tools](https://www.anup.io/how-the-claude-code-team-designs-agent-tools/) — tool surface + output policy
- [The Anatomy of an Agent Harness — LangChain](https://blog.langchain.com/the-anatomy-of-an-agent-harness/) — durable event log, context offloading
- [LangGraph](https://github.com/langchain-ai/langgraph) — graph-based runtime reference
- **Internal:** `src/lib/runtime/loop.server.ts`, `src/lib/runtime/types.ts`, `src/lib/runtime/definition.server.ts`
