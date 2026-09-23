# Runtime Spec

## Overview

The runtime is the transport-agnostic core of AgentStudio's agent loop. It owns the LLM call cycle, tool execution, context assembly, compaction, skill loading, output offloading, and event emission. It does not know about HTTP, SSE, WebSockets, or any other delivery channel. Any entry point — chat stream, automation, scheduled job, sub-agent spawn — constructs three primitives and hands them to `runAgentLoop`.

## Data Model

### AgentDefinition

The fully-resolved description of the agent for one run. Assembled once before the loop starts; the loop never re-reads tables.

| Field              | Type              | Description                                                    |
| ------------------ | ----------------- | -------------------------------------------------------------- |
| `id`               | string            | Agent record ID                                                |
| `systemPrompt`     | string            | Assembled from identity skill + role + skill summaries         |
| `model`            | string            | OpenRouter model slug                                          |
| `reasoning`        | ReasoningConfig?  | Extended thinking settings                                     |
| `toolAllowList`    | string[]?         | Explicit tool allow-list; null = use capability groups         |
| `capabilityGroups` | CapabilityGroup[] | Active groups for this run (first-party + `mcp/<slug>` groups) |

### Environment

The execution environment for one run. Constructed by `buildEnvironment`, which delegates to the workspace domain.

| Field                   | Type                             | Description                                                |
| ----------------------- | -------------------------------- | ---------------------------------------------------------- |
| `workspaceRoot`         | string                           | Absolute path to the run's sandbox directory               |
| `approvalRequiredTools` | Set\<string\>                    | Tools that require human approval before execution         |
| `mcpServers`            | McpServerRef[]                   | Resolved MCP servers assigned to this agent; empty if none |
| `envVars`               | Record\<string, string\>?        | Process-level env overrides                                |
| `networkPolicy`         | 'open' \| 'restricted' \| 'none' | Network access level for sandboxed tools                   |

`McpServerRef` carries the server ID, transport config, and decrypted auth credentials resolved at build time. The loop never reads `mcpServers` DB rows directly.

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

1. Identity skill content (from the resolved run agent's `identitySkillId`; main agent comes from session pin or scoped `main` binding)
2. Agent role description
3. Active task spec (if `session.taskId` is set)
4. Companion skill summaries relevant to the current capability groups
5. Tool usage guidance (injected from companion skills, not a separate policies domain)
6. Capability group summary (including any `mcp/<slug>` groups)

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

### MCP server lifecycle

For each `McpServerRef` in `environment.mcpServers`:

1. At run start, `buildEnvironment` opens connections to all assigned MCP servers (spawns stdio process or opens SSE/HTTP client).
2. Each connected server has its tools registered as a `mcp/<slug>` capability group in `definition.capabilityGroups`.
3. When the model calls `enable_capability('mcp/github')`, the runtime activates that group and injects the server's tool descriptions.
4. MCP tool calls are proxied: the runtime strips the `<slug>__` prefix, forwards the call to the server, and returns the result through the normal tool output pipeline (including size-cap archival).
5. At run end (or on error), all stdio processes spawned for this run are terminated.

If a server fails to connect at run start, its capability group is silently omitted — the run proceeds without it. A `hook_failure`-level event is emitted.

### Approval gating

If a tool is in `environment.approvalRequiredTools`, the loop suspends via `session.pendingApproval` before executing. The suspension is durable — the loop can resume after a process restart because approvals are persisted in the `runs` table, not held in memory.

### Permission mode (per conversation)

Per-tool approval settings say what always needs a confirmation; the permission mode says how much *this session* is trusted. It is stored on `conversations.permission_mode`, changed from the chat header at any point, and picked up by the next turn. The two compose in `resolveToolGate` (`src/lib/engine/permission-mode.ts`), which is the single decision point for allow / ask / deny.

| Mode                | What it does                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------------- |
| `default`           | The per-tool settings decide. Unchanged behaviour.                                              |
| `plan`              | Read-only. Anything that would change something is refused with a message telling the agent to plan instead. The plan file itself is the one exception and is surfaced for approval. |
| `acceptEdits`       | File edits run without asking. Everything else is still gated.                                  |
| `bypassPermissions` | Everything is auto-approved **except** the mandatory-approval tools. Needs an explicit confirm, and is refused outside an interactive chat run. |

Two rules hold in every mode, including bypass:

1. **The mandatory-approval tools stay gated.** `push_branch`, `create_pull_request` and `request_plan_approval` are classified `mandatory-approval`, which `resolveToolGate` checks before any mode branch runs.
2. **The SDK is never told `bypassPermissions`.** That mode stops the SDK calling `canUseTool`, which is where AgentStudio asks the operator — so the bypass is applied in our own gate and the SDK is left on `default`. `sdkPermissionModeFor` owns that mapping.

`bypassPermissions` is refused on any run whose `chat_runs.source` is not `chat_stream` — a detached sub-agent or an automation on a timer has no operator to approve anything. This is the same rule `push_branch` enforces in `assertInteractiveChatSurface`; here it downgrades the run to `default` rather than failing it.

Tools are classified by **capability**, not by literal name (`TOOL_CAPABILITY_RULES`), so issue #15's swap to the SDK's built-in tools does not silently un-gate anything: the rules already carry `Write` / `Edit` / `MultiEdit` / `NotebookEdit` alongside `file_write` / `file_patch`, and an unrecognised tool falls through to `mutate`, which fails closed.

The mode is orthogonal to the bound **agent**. The Plan agent changes the persona (write a plan, hand off via `request_plan_approval`); `plan` mode changes what the runtime permits. Running both is the strict case, and it works: plan mode leaves the plan-file write and the handoff available, as approvals.

### How every tool call is checked (chat runs)

Chat runs execute on the Claude Agent SDK. Before any tool runs — the agent's own or one a delegated subagent makes — AgentStudio answers one question: allow, ask the operator, or refuse. Three checks feed that answer, and the strictest one wins:

1. **The agent's tool list.** An agent with a fixed list (the Research and Plan built-ins, or a custom agent with `allowedTools`) can only call what is on it. Tools that are not listed are not offered to the model at all, and a call to one is refused. An agent that was given other agents to delegate to also gets the delegation tool, `Agent`. Tool names are compared as Claude Code calls them today: a list that says `Task` (the old name for `Agent`) or `KillShell` (now `TaskStop`) still works. Until 2026-09-23 it did not, and every delegation by the Research and Plan agents was refused.
2. **Workspace containment.** File tools must stay inside the run's workspace — judged by where a path really leads, so a link inside the workspace that points out of it does not count as inside. Shell commands run inside the operating-system sandbox where the host has one, and need approval where it does not. A request to run a command outside the sandbox is always refused.
3. **The permission mode and per-tool settings**, as described above. The mandatory-approval tools always ask.

Being on an agent's list approves nothing — a listed tool still goes through containment and approval. The check runs *before* the SDK's own shortcuts (its allow rules, a trusted project's `permissions.allow`, its auto-accept for edits), so none of them can skip it.

When the answer is "ask", the chat shows an **Allow / Deny card** for the call. The card carries the token the operator's answer is matched against. This works for a delegated subagent's calls too: the card appears in the conversation, marked as belonging to that subagent, and closes when the subagent's call finishes. A run with nobody to answer (an automation) refuses the call instead of waiting.

**The agent's own configuration needs approval to change.** Writing, moving or deleting these files always asks, in every mode:

| File | Why |
| --- | --- |
| `.claude/settings.json`, `.claude/settings.local.json` | permissions, environment and hooks — hooks run outside the sandbox |
| `.claude/hooks/`, `.claude/commands/`, `.claude/agents/`, `.claude/skills/` | what the agent can be told to do |
| `.mcp.json` | which tool servers connect |
| `CLAUDE.md`, `CLAUDE.local.md` | only for a trusted project, where they are part of every prompt |

**The agent process gets a minimal environment.** The Claude Code process that runs a chat turn does not inherit the server's environment, so a shell command cannot print the database URL or any other server secret. It receives only:

| Passed | Examples |
| --- | --- |
| What a process needs to run | `PATH`, `HOME`, `TMPDIR`, locale (`LANG`, `LC_*`), and on Windows `USERPROFILE`, `SystemRoot`, `APPDATA` and similar |
| How to reach the network | `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE` |
| Its own login | `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_OAUTH_TOKEN` |
| For gateway models only | `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`, set from `LLM_GATEWAY_URL` / `LLM_GATEWAY_TOKEN` |

Inside the sandbox, the login variables are hidden from shell commands as well.

### Sub-agent spawning

A sub-agent run is a `runAgentLoop` call with:

- Its own `AgentDefinition` resolved from category bindings (for example `coding` or `ui_design`)
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
- Tool execution policy is resolved from runtime settings and capability-level approval rules before execution. The runtime enforces the resolved decision.

## Rewrite Authority

The current implementation is a baseline, not a constraint. This domain may be rewritten, restyled, reorganized, or replaced as needed to achieve the target product quality. No code path is off-limits if behavior contracts, safety controls, tests, and documentation remain correct.

## UI Contract

This domain follows the shared UX system in [../ui/spec.md](../ui/spec.md).

- Surfaces in this domain must align with the shared desktop/mobile shell patterns.
- Domain-specific states must be explicit in the UI (for example pending, running, blocked, completed) where applicable.
- Blocking user decisions must use the shared action-card and inbox patterns where applicable.

## References

- [The Design of Claude Managed Agents — Anthropic](https://www.anthropic.com/engineering/managed-agents) — brain/hands/session primitive decoupling
- [Building Effective Agents — Anthropic](https://www.anthropic.com/research/building-effective-agents) — composable primitives over opinionated workflows
- [How the Claude Code Team Designs Agent Tools](https://www.anup.io/how-the-claude-code-team-designs-agent-tools/) — tool surface + output policy
- [The Anatomy of an Agent Harness — LangChain](https://blog.langchain.com/the-anatomy-of-an-agent-harness/) — durable event log, context offloading
- [LangGraph](https://github.com/langchain-ai/langgraph) — graph-based runtime reference
- **Internal:** `src/lib/runtime/loop.server.ts`, `src/lib/runtime/types.ts`, `src/lib/runtime/definition.server.ts`
