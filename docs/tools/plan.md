# Tools Plan

Status: active

## Overview

The `capabilityGroups` registry in [src/lib/tools/tools.ts](../../src/lib/tools/tools.ts) already declares `core/sandbox/skills/agents/media` with `alwaysOn` flags, but at runtime every non-excluded tool is loaded on every turn — the flag is never consulted. The result is ~25 tools in the prompt every round, mostly unused. Wire progressive disclosure (only `alwaysOn` by default + a meta-tool to enable groups), trim the filesystem surface to ~7 verbs to match what Claude Code, Aider, and OpenCode converged on, and formally pair tools with skills so usage guidance is loaded progressively too.

> **Depends on:** `docs/structure/plan.md` Step 8 (split `tools/catalog/` by family), `docs/skills/plan.md` (companion skills + context loading rules).

> **See also:** [spec.md](spec.md) — full feature spec, data model, and behavior contracts.

## Why this matters (harness principles)

- **Fewer, more expressive tools beat sprawling toolkits.** Anthropic's "Seeing Like an Agent" central claim.
- **Progressive disclosure outperforms upfront loading.** OpenAI and Anthropic guidance converge here.
- **Token efficiency.** GenericAgent reports 6× efficiency gains from learned/scoped capabilities.
- **Tool outputs must not dominate context.** Anthropic and LangChain both call out output offloading/compaction as a first-class harness concern.

## Reference repos & articles

- [Lessons from Building Claude Code: Seeing Like an Agent — Thariq](https://x.com/trq212/status/2027463795355095314)
- [How the Claude Code Team Designs Agent Tools](https://www.anup.io/how-the-claude-code-team-designs-agent-tools/)
- [Best Practices for Claude Code — Anthropic](https://www.anthropic.com/engineering/claude-code-best-practices)
- [Scaling Managed Agents: Decoupling the brain from the hands — Anthropic](https://www.anthropic.com/engineering/managed-agents)
- [Deep Agents (LangChain)](https://github.com/langchain-ai/deepagents) — progressive disclosure via planning + subagents
- [The Anatomy of an Agent Harness — LangChain](https://blog.langchain.com/the-anatomy-of-an-agent-harness/) — tool call offloading, skills as progressive disclosure
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
- Tool outputs currently flow back into the run context too literally; there is no formal head/tail/summary/offload policy in this plan.

## Target design

### Recommended active tool budget

Research from Claude Code, Aider, OpenCode, and LangChain points in the same direction: keep the active per-turn tool surface small.

- Target: **8–12 active tools** in a normal coding turn
- Hard ceiling: **15 active tools** before we consider the context overloaded
- Strategy: expose core tools always, capability groups on demand, and detailed operating guidance through skills rather than repeating it in every tool description

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

### Companion skills for tools

Every non-trivial tool or capability group gets a linked skill that explains:

1. when to use it
2. when not to use it
3. safe calling patterns
4. verification expectations

Examples:

- `sandbox` → `tools/fs-editing`, `tools/run-verification`
- `browser` → `tools/browser-debugging`
- `agents` → `tools/delegation`
- `projects` / `artifacts` → `tools/project-artifacts`

Runtime behavior:

- enabling a capability group may inject only a **short skill summary**
- full skill bodies are loaded only when the model explicitly asks or the task clearly requires them

This keeps tool schemas concise while still teaching the model how to use the tool well.

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

### Tool output context lifecycle

Tool output policy should be designed with context management in mind, not as an afterthought.

#### Small outputs

- Keep inline in the next reasoning step.
- Preserve in `run_events` as the durable source of truth.

#### Large outputs

If output exceeds threshold:

1. Store the **full raw output** in durable storage (run event payload, workspace file, or artifact-like blob).
2. Return to the model only:
  - a short summary
  - head excerpt
  - tail excerpt
  - a pointer/handle for reopening the full result
3. Allow the model to request the full payload later via explicit follow-up tooling.

This matches Anthropic's context-management guidance and LangChain's tool-offloading guidance.

#### After-use compaction

- Old tool outputs should be compacted preferentially before higher-value user/task state.
- The session log remains durable; the live context window does not need to remain a literal transcript of every tool result forever.

### Per-agent tool budget

`agent.config.toolBudget`: max tools loaded per round (default 12). If groups + base exceed it, runtime warns.

## Implementation steps (phased)

### Phase 1 — Enforce `alwaysOn`

- In `+server.ts` (or runtime loop after extraction), filter to only `alwaysOn` groups by default.
- Add `enable_capability` meta-tool.
- Track `enabledGroups` on the run (jsonb).
- Add runtime enforcement of active tool count budget.

### Phase 2 — Auto-suggest

- Cheap classifier (`gpt-4o-mini` or keyword pre-pass) annotates the system prompt with suggested groups.
- Suggested groups also surface companion skill summaries.

### Phase 3 — FS tool consolidation

- Add new `read/write/patch/list/search/move/delete` tools (with `path`-prefixed args).
- Old names become aliases that proxy + emit deprecation warning in result metadata.
- After 1 release, remove old names.

### Phase 4 — Per-agent capability binding

- `agents.config.capabilityGroups` (string[]) replaces ad-hoc allowedTools where it makes sense.
- UI in agent detail page to toggle groups.

### Phase 5 — Tool/skill contract

- Add mapping from capability groups and selected tools to companion skills.
- Add UI / metadata showing "recommended skill for this tool".
- Require new first-party tools to ship with at least one companion skill before merge.

### Phase 6 — Tool output context policy

- Add thresholds for inline vs summarized tool output.
- Persist raw large outputs outside the live model window.
- Add explicit reopen/read-full-output flow.

### Phase 7 — Telemetry

- Log per-tool call counts per agent to data warehouse (already partially done via `messages.toolCalls`).
- Identify and prune unused tools.
- Track large-output rate, reopen rate, and summary-vs-raw effectiveness.

## Files to create / modify

- `src/lib/tools/tools.ts` — add meta-tool registration, enforce alwaysOn
- `src/lib/tools/tools.server.ts` — implement `enable_capability` dispatch
- `src/lib/tools/catalog/fs.server.ts` (new) — consolidated `read/write/patch/list/search/move/delete`
- `src/lib/tools/catalog/meta.server.ts` — `enable_capability`
- `src/lib/skills/skills.server.ts` — companion skill lookup + summary loading
- `src/lib/runtime/loop.server.ts` — track `enabledGroups` on run
- `src/lib/runs/runs.schema.ts` — `enabledGroups` jsonb on `runs`
- `src/lib/agents/agents.schema.ts` — `capabilityGroups` text[] on agent config
- `src/routes/agents/[id]/+page.svelte` — capability toggles UI
- `src/lib/runtime/session/sse.server.ts` or equivalent — emit summarized vs raw tool output payloads
- `docs/tools/tools.md` (domain doc once shipped)

## Migration / backward-compat

- Old FS tool names alias to new ones for one release; warning in tool result.
- Existing agents with `allowedTools` keep working; new `capabilityGroups` field is additive.
- Default for legacy agents: enable `core` + `sandbox` to match current behavior.

## Verification

- Token-count regression: orchestrator system prompt + tool defs shrinks ≥ 40% on a typical first turn.
- E2E: orchestrator without `sandbox` enabled cannot call `read`/`write` until it calls `enable_capability`.
- Manual: ask an open-ended question — model gets only `core` tools, not the FS surface.
- Large-output test: command with >10KB output returns summary + pointer, while raw output remains recoverable.
- Skill contract test: enabling `sandbox` also makes `tools/fs-editing` summary available without loading the whole skill body.

## Out of scope

- MCP-based tool dynamic discovery (separate doc).
- Tool composition/macros.

## Rewrite Authority

The current implementation is a baseline, not a constraint. This domain may be rewritten, restyled, reorganized, or replaced as needed to achieve the target product quality. No code path is off-limits if behavior contracts, safety controls, tests, and documentation remain correct.

## UI Contract

Implementation in this domain must comply with [../ui/plan.md](../ui/plan.md) and [../ui/spec.md](../ui/spec.md).

- Include UX acceptance criteria for desktop and mobile behavior.
- Include compactness/density behavior where relevant.
- Include approval, question, and interruption flows where relevant.

## Completion
- Template: YYYY-MM-DD - Completed in <PR/commit> - <one-line outcome>
- Pending.



