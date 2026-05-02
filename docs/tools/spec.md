# Tools Spec

## Overview

Tools are the hands of AgentStudio's agents. They are typed functions the model can call to interact with the outside world: read and write files, run shell commands, search the web, spawn sub-agents, and more. The tools domain defines what tools exist, how they are grouped, how they are disclosed to the model progressively, and how their outputs are managed in the context window.

## Data Model

Tools are defined in code (`src/lib/tools/catalog/`), not in the database. Their grouping and disclosure rules are the primary configuration surface.

### Capability groups

| Group      | `alwaysOn` | Tools included                                                                                    |
| ---------- | ---------- | ------------------------------------------------------------------------------------------------- |
| `core`     | yes        | `web_search`, `ask_user`, `list_automations`, `enable_capability`                                 |
| `sandbox`  | no         | `shell`, `file_read`, `file_write`, `file_patch`, `file_replace`, `list_directory`, `delete_file` |
| `browser`  | no         | `browser_screenshot`, `browser_click`, `browser_navigate`                                         |
| `agents`   | no         | `run_subagent`, `propose_plan`, `list_agents`                                                     |
| `skills`   | no         | `read_skill`, `list_skills`                                                                       |
| `projects` | no         | `create_project`, `open_artifact`, `save_artifact`, `list_artifacts`                              |
| `memory`   | no         | `recall_memory`, `save_note`                                                                      |
| `media`    | no         | `generate_image`, `describe_image`                                                                |

### Tool definition shape

Each tool is a typed object:

```ts
type ToolDefinition = {
	name: string
	description: string // Short (≤2 sentences). Detailed guidance lives in companion skills.
	parameters: JsonSchema
	capabilityGroup: string
	companionSkill?: string // Slug of the skill that explains how to use this tool
	alwaysOn?: boolean
	requiresApproval?: boolean // Default from capability group; overridable per-agent
	outputPolicy?: 'inline' | 'archive' | 'summarize' // How to handle the return value
}
```

## Features

### Progressive disclosure

Only `alwaysOn` tools are active at the start of a turn. Other capability groups are off until the model calls `enable_capability`. This keeps the active tool surface small:

- Target per turn: **8–12 active tools**
- Hard ceiling: **15 active tools**

When a capability group is enabled, the runtime:

1. Adds the group's tools to the active set for subsequent rounds
2. Emits a system message listing the newly available tools
3. Injects the companion skill summary for that group into the context

Capability groups persist for the duration of the run; they do not reset between rounds.

### `enable_capability` meta-tool

The only tool available for enabling other tools. Always active.

```
enable_capability(group: 'sandbox' | 'browser' | 'agents' | 'skills' | 'projects' | 'memory' | 'media')
→ Returns: list of newly available tools and a one-line summary of the companion skill
```

### Filesystem surface

The sandbox capability group exposes exactly 7 filesystem verbs, matching the surface Claude Code, Aider, and OpenCode converged on:

| Tool             | Description                                        |
| ---------------- | -------------------------------------------------- |
| `file_read`      | Read a file or range of lines                      |
| `file_write`     | Create or overwrite a file                         |
| `file_patch`     | Apply a unified diff to a file                     |
| `file_replace`   | Replace an exact string in a file                  |
| `list_directory` | List directory contents                            |
| `delete_file`    | Delete a file (requires approval by default)       |
| `shell`          | Run a shell command in the run's sandbox workspace |

There is no `move_file`, `file_info`, `search_files`, or other overlapping verb. Search is done via `shell` + `grep`/`find` or the `web_search` tool.

### Companion skills

Every non-trivial tool or capability group has a linked companion skill. The companion skill answers:

1. When should I use this tool?
2. When should I not use it?
3. Safe calling patterns and examples
4. How to verify the result

When a capability group is enabled, its companion skill summary is loaded. The full skill body is available via `read_skill` if the model needs more detail.

| Capability group | Companion skill slug      |
| ---------------- | ------------------------- |
| `sandbox`        | `tools/fs-editing`        |
| `sandbox`        | `tools/run-verification`  |
| `browser`        | `tools/browser-debugging` |
| `agents`         | `tools/delegation`        |
| `projects`       | `tools/project-artifacts` |
| `memory`         | `tools/memory-recall`     |

### Tool output context policy

Tool outputs are not returned verbatim into the live model context when they exceed a size threshold (default: 4,000 tokens).

When a tool output exceeds the threshold:

1. The raw output is stored durably (run event log or blob store)
2. The model receives: a one-paragraph summary + first 20 lines + last 10 lines + a pointer handle
3. The model can call `read_output(handle, offset, length)` to retrieve a specific slice
4. The `on_tool_output_archived` hook event fires

Outputs that are under the threshold are returned inline.

### Approval policy

Tool calls that involve side effects (writes, deletes, shell commands) can be configured to require human approval before execution. The default approval requirement per tool is set in the tool definition and can be overridden:

- Per-capability-group in agent config
- Per-tool in agent config or session policy
- Platform-wide in the policies domain

Approval requests create a review inbox item and suspend the run durably (see runs spec).

### Tool sandboxing

All filesystem and shell tools operate against the run's isolated workspace directory (see workspace spec). They cannot access paths outside the workspace root. The shell tool runs in a subprocess with the workspace as the working directory and inherits only the environment variables declared in `environment.envVars`.

## Behavior Contracts

- A tool that does not exist in the active tool set for this turn cannot be called. If the model attempts it, the runtime returns a `tool_not_available` error and suggests `enable_capability`.
- `enable_capability` is idempotent — calling it for an already-enabled group is a no-op.
- Tool output archival happens before the next round begins. The model never sees an oversized raw output inline.
- Tool definition descriptions are ≤2 sentences. All extended guidance lives in companion skills. This is enforced in CI.
- `delete_file` and `shell` with destructive patterns (`rm -rf`, `DROP TABLE`, etc.) are flagged for approval unless the agent's policy explicitly permits them.

## Roles & Permissions

Tool access is governed by the policies domain. The tools domain enforces the active capability set; the policies domain determines what is allowed.

| Actor           | Default capability groups            |
| --------------- | ------------------------------------ |
| Orchestrator    | `core` only                          |
| Worker agent    | Per `agents.config.capabilityGroups` |
| Evaluator agent | `core` only (read-only tools)        |

## Rewrite Authority

The current implementation is a baseline, not a constraint. This domain may be rewritten, restyled, reorganized, or replaced as needed to achieve the target product quality. No code path is off-limits if behavior contracts, safety controls, tests, and documentation remain correct.

## UI Contract

This domain follows the shared UX system in [../ui/spec.md](../ui/spec.md).

- Surfaces in this domain must align with the shared desktop/mobile shell patterns.
- Domain-specific states must be explicit in the UI (for example pending, running, blocked, completed) where applicable.
- Blocking user decisions must use the shared action-card and inbox patterns where applicable.

## References
- [Lessons from Building Claude Code: Seeing Like an Agent — Thariq](https://x.com/trq212/status/2027463795355095314) — fewer, more expressive tools
- [How the Claude Code Team Designs Agent Tools](https://www.anup.io/how-the-claude-code-team-designs-agent-tools/)
- [Best Practices for Claude Code — Anthropic](https://www.anthropic.com/engineering/claude-code-best-practices)
- [Scaling Managed Agents — Anthropic](https://www.anthropic.com/engineering/managed-agents) — progressive disclosure
- [GenericAgent](https://github.com/lsdefine/GenericAgent) — 6× efficiency from scoped capabilities
- [DeerFlow 2.0](https://github.com/bytedance/deer-flow) — on-demand skill + tool loading
- **Internal:** `src/lib/tools/catalog/`, `src/lib/tools/tools.ts`, `src/lib/tools/tools.server.ts`

