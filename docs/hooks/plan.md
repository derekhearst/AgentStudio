# Lifecycle Hooks Plan

## Overview

There is no way today to extend harness behavior without editing `+server.ts`. OpenCode's 44 lifecycle hooks and the popular "Oh My OpenCode/Codex/Claude Code" projects exist precisely because users want to instrument and customize the harness without forking it. Add a typed hook surface — `before_run`, `after_run`, `before_tool`, `after_tool`, `on_compact`, `on_evaluator`, etc. — that any agent (or the orchestrator) can subscribe to.

## Why this matters (harness principles)

- **Composable primitives over opinionated workflows.** Anthropic's "Building Effective Agents".
- **The harness must evolve with the model.** Hooks let users tune the harness without code changes.
- **Mechanical architecture enforcement.** Hooks are where structural lints and quality gates run.

## Reference repos & articles

- [OpenCode (44 lifecycle hooks)](https://github.com/sst/opencode)
- [Oh My OpenCode](https://github.com/code-yeongyu/oh-my-opencode) — performance harness
- [Oh My Codex](https://github.com/Yeachan-Heo/oh-my-codex) — hooks + agent teams + HUD
- [Everything Claude Code](https://github.com/affaan-m/everything-claude-code) — skills/instincts/memory hooks
- [Composio Agent Orchestrator](https://github.com/ComposioHQ/agent-orchestrator)
- [Get-shit-done](https://github.com/gsd-build/get-shit-done) — meta-prompting hooks

## Current state in AgentStudio

- No hook surface exists.
- Cross-cutting concerns (compaction, approval, activity emit) are inlined in [src/routes/chat/[id]/stream/+server.ts](../../src/routes/chat/[id]/stream/+server.ts).
- [src/lib/activity/activity.server.ts](../../src/lib/activity/activity.server.ts) emits events but has no programmable consumers.

## Target design

### Hook events (initial set)

| Event                  | Payload                                                  | When                  |
| ---------------------- | -------------------------------------------------------- | --------------------- |
| `before_run`           | `{ runId, definition, environment, conversationId }`     | Before loop starts    |
| `after_run`            | `{ runId, result, costUsd, durationMs }`                 | After loop ends       |
| `before_round`         | `{ runId, round, messages }`                             | Before each LLM round |
| `after_round`          | `{ runId, round, content, toolCalls }`                   | After each LLM round  |
| `before_tool`          | `{ runId, toolName, args }`                              | Before tool execution |
| `after_tool`           | `{ runId, toolName, args, result, success, durationMs }` | After tool execution  |
| `on_compact`           | `{ runId, before, after, summary }`                      | On context compaction |
| `on_evaluator`         | `{ runId, verdict, findings }`                           | On evaluator result   |
| `on_subagent_spawn`    | `{ parentRunId, childRunId, agentId }`                   | On `run_subagent`     |
| `on_approval_required` | `{ runId, toolName, args, token }`                       | On pending approval   |
| `on_user_question`     | `{ runId, questions, token }`                            | On `ask_user`         |
| `on_run_failed`        | `{ runId, error }`                                       | On error              |

### Hook implementations

Two backends, both selectable:

1. **TypeScript hooks** — registered programmatically (`registerHook('after_tool', fn)`), live in `src/lib/hooks/builtins/`. For first-party features (activity emit, cost tracking, telemetry).
2. **Skill-based hooks** — a skill named `hook/<event>` whose content is executed as a subagent task. Lets users write hooks in markdown without touching code.

Hook execution rules:

- Sandbox-isolated (per-hook scratch dir).
- Timeout (default 5s for fast hooks; configurable for `after_run`).
- Failure isolated — a failing hook never fails the run.
- Output captured in `hook_invocations` table for audit.

### Per-agent hook config

`agents.config.hooks`: `{ [event]: ['hook-skill-slug', ...] }`

### Built-in hooks (migrated from inline code)

- `before_run`: capability auto-suggest (from progressive-tools plan).
- `after_run`: activity emit + cost log + memory capture (from memory plan).
- `on_compact`: emit notification if compaction lost critical info (LLM check).
- `after_tool`: telemetry / failure pattern detection.

## Implementation steps (phased)

### Phase 1 — Registry + dispatch

- `HookBus` with `registerHook(event, handler)` and `emit(event, payload)`.
- Wire into runtime loop emit points.
- All-async, fail-isolated, timeout-bounded.

### Phase 2 — Migrate built-ins

- Move activity emit / cost log / memory capture from inline → hooks.
- Verify identical observable behavior.

### Phase 3 — Skill-based hooks

- Hook lookup: skills with `hook/<event>` prefix.
- Execution path: spawn cheap subagent with hook content as system prompt + payload as user message.
- Result optionally posted back into the run as a system note.

### Phase 4 — Per-agent config

- `agents.config.hooks` jsonb.
- UI in agent detail page to bind hook skills.

### Phase 5 — Audit + UI

- `hook_invocations` table (event, hookId, success, durationMs, error).
- Admin route `/settings/hooks` shows recent invocations.

## Schema

```ts
hookInvocations: {
  id, runId, event (text), hookKind (enum: 'builtin' | 'skill'),
  hookRef (text — fn name or skill slug), success (bool),
  durationMs (int), error (text | null), createdAt
}
```

## Files to create / modify

- `src/lib/hooks/bus.ts` (new) — registry + dispatch
- `src/lib/hooks/types.ts` (new) — event payload types
- `src/lib/hooks/builtins/` (new) — migrated built-ins
- `src/lib/hooks/hooks.schema.ts` (new) — invocation log
- `src/lib/hooks/skill-hook-runner.ts` (new) — Phase 3
- `src/lib/agents/runtime/loop.ts` — emit hook events at every boundary
- `src/lib/agents/agents.schema.ts` — `config.hooks` shape
- `src/routes/settings/hooks/+page.svelte` (new)
- `src/routes/agents/[id]/hooks/+page.svelte` (new)
- `docs/hooks/hooks.md` (domain doc once shipped)

## Migration / backward-compat

- All migrated built-ins preserve their existing side effects (activity rows, cost logs).
- Skill hooks default off until explicitly bound on an agent.
- Hook failures never propagate — bug in a hook can't break a run.

## Verification

- Unit: registry dispatches in registration order; failure of one hook doesn't block others.
- E2E: bind a `after_tool` skill hook → invoke `read` tool → hook output appears in `hook_invocations`.
- Performance: hook overhead < 5% on a tool-heavy run.

## Out of scope

- Hooks running outside the host process (queues / lambdas).
- Conditional hooks (filter expressions) — start with all-or-nothing per agent.
- Hook marketplace / sharing across instances.
