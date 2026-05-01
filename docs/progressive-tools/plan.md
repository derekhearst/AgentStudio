# Progressive Tool Disclosure Plan

## Overview

The `capabilityGroups` registry in [src/lib/tools/tools.ts](../../src/lib/tools/tools.ts) already declares `core/sandbox/skills/agents/media` with `alwaysOn` flags, but at runtime every non-excluded tool is loaded on every turn — the flag is never consulted. The result is ~25 tools in the prompt every round, mostly unused. Wire progressive disclosure (only `alwaysOn` by default + a meta-tool to enable groups), and trim the filesystem surface to ~7 verbs to match what Claude Code, Aider, and OpenCode converged on.

## Why this matters (harness principles)

- **Fewer, more expressive tools beat sprawling toolkits.** Anthropic's "Seeing Like an Agent" central claim.
- **Progressive disclosure outperforms upfront loading.** OpenAI's Harness Engineering post.
- **Token efficiency.** GenericAgent reports 6× efficiency gains from learned/scoped capabilities.

## Reference repos & articles

- [Lessons from Building Claude Code: Seeing Like an Agent — Thariq](https://x.com/trq212/status/2027463795355095314)
- [How the Claude Code Team Designs Agent Tools](https://www.anup.io/how-the-claude-code-team-designs-agent-tools/)
- [Deep Agents (LangChain)](https://github.com/langchain-ai/deepagents) — progressive disclosure via planning + subagents
- [DeerFlow 2.0](https://github.com/bytedance/deer-flow) — skill system with on-demand loading
- [Harness Engineering — OpenAI](https://openai.com/index/harness-engineering/)
- [GenericAgent](https://github.com/lsdefine/GenericAgent) — token efficiency from scoped capabilities

## Current state in AgentStudio

- [tools.ts](../../src/lib/tools/tools.ts) defines `capabilityGroups` with `alwaysOn` but the streaming handler ignores it:
  ```ts
  let tools = getToolDefinitions()
    .filter((tool) => (isOrchestrator ? true : tool.function.name !== 'ask_user'))
    .filter((tool) => scopedAgentTools ? scopedAgentTools.includes(...) : !DREAMING_ONLY_TOOLS.has(...))
  ```
- FS surface today: `shell`, `file_read`, `file_write`, `file_patch`, `file_replace`, `list_directory`, `delete_file`, `move_file`, `search_files`, `file_info`, `browser_screenshot` (11 verbs, several overlapping).
- Skills already use progressive disclosure correctly (summary up front, content via `read_skill`) — that pattern is the model.

## Target design

### Default tool load

Only `alwaysOn` group tools are exposed by default. For orchestrator: `core` (`web_search`, `ask_user`, `list_automations`) + `enable_capability` meta-tool. Agents inherit their `agent.config.capabilityGroups`.

### `enable_capability` meta-tool

```ts
{
  name: 'enable_capability',
  description: 'Enable a capability group. Returns the new tools available.',
  parameters: { group: 'sandbox' | 'skills' | 'agents' | 'media' }
}
```

When called, the runtime adds the group's tools to the active set for subsequent rounds and emits a system message: `"Capability 'sandbox' enabled. Tools available: shell, file_read, ..."`.

### Heuristic auto-enable (optional)

A cheap classifier inspects the user message:

- "code", "file", "directory", "edit" → suggest `sandbox`
- "skill", "knowledge", "instructions" → suggest `skills`
- "agent", "delegate", "task", "schedule" → suggest `agents`
- "image", "render", "draw" → suggest `media`

Suggestions appear as a system hint; the model still has to call `enable_capability`.

### Trimmed FS surface

Collapse to **7 verbs**:

| Keep     | Replaces                                                       |
| -------- | -------------------------------------------------------------- |
| `read`   | `file_read`                                                    |
| `write`  | `file_write`                                                   |
| `patch`  | `file_patch`, `file_replace` (replace becomes a flag on patch) |
| `list`   | `list_directory`, `file_info` (info becomes a flag)            |
| `search` | `search_files`                                                 |
| `move`   | `move_file`                                                    |
| `delete` | `delete_file`                                                  |

`shell` stays (its own thing). `browser_screenshot` moves to a new `browser` capability group.

### Per-agent tool budget

`agent.config.toolBudget`: max tools loaded per round (default 12). If groups + base exceed it, runtime warns.

## Implementation steps (phased)

### Phase 1 — Enforce `alwaysOn`

- In `+server.ts` (or runtime loop after extraction), filter to only `alwaysOn` groups by default.
- Add `enable_capability` meta-tool.
- Track `enabledGroups` on the run (jsonb).

### Phase 2 — Auto-suggest

- Cheap classifier (`gpt-4o-mini` or keyword pre-pass) annotates the system prompt with suggested groups.

### Phase 3 — FS tool consolidation

- Add new `read/write/patch/list/search/move/delete` tools (with `path`-prefixed args).
- Old names become aliases that proxy + emit deprecation warning in result metadata.
- After 1 release, remove old names.

### Phase 4 — Per-agent capability binding

- `agents.config.capabilityGroups` (string[]) replaces ad-hoc allowedTools where it makes sense.
- UI in agent detail page to toggle groups.

### Phase 5 — Telemetry

- Log per-tool call counts per agent to data warehouse (already partially done via `messages.toolCalls`).
- Identify and prune unused tools.

## Files to create / modify

- `src/lib/tools/tools.ts` — add meta-tool, enforce alwaysOn
- `src/lib/tools/tools.server.ts` — implement `enable_capability`, register new FS verbs
- `src/lib/tools/fs.server.ts` (new) — consolidated FS impl
- `src/lib/agents/runtime/loop.ts` — track enabledGroups on run
- `src/lib/chat/chat.schema.ts` — `enabledGroups` jsonb on `chatRuns`
- `src/lib/agents/agents.schema.ts` — `capabilityGroups` text[] on agent config
- `src/routes/agents/[id]/+page.svelte` — capability toggles UI
- `docs/progressive-tools/progressive-tools.md` (domain doc once shipped)

## Migration / backward-compat

- Old FS tool names alias to new ones for one release; warning in tool result.
- Existing agents with `allowedTools` keep working; new `capabilityGroups` field is additive.
- Default for legacy agents: enable `core` + `sandbox` to match current behavior.

## Verification

- Token-count regression: orchestrator system prompt + tool defs shrinks ≥ 40% on a typical first turn.
- E2E: orchestrator without `sandbox` enabled cannot call `read`/`write` until it calls `enable_capability`.
- Manual: ask an open-ended question — model gets only `core` tools, not the FS surface.

## Out of scope

- MCP-based tool dynamic discovery (separate doc).
- Streaming tool result truncation policy (already handled in `chat.ts`).
- Tool composition/macros.
