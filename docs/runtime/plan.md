# Runtime Plan

Status: active

## Overview

The whole agent loop — history load, prompt assembly, compaction, tool execution, approval gating, sub-agent invocation, SSE emission, run state updates — lives inside one ~700-line `+server.ts`. This fuses _brain_ (model + prompt), _hands_ (tools + sandbox), and _session_ (event log) into one transport-coupled handler. Extract a transport-agnostic `AgentRuntime` (lives in `src/lib/runtime/`) so the same loop powers chat streams, automations, sub-agents, and future channel adapters (Slack, webhook, schedule). Runtime is also where tool loading, skill loading, and tool-output context policy should be enforced.

> **Depends on:** `docs/structure/plan.md` Steps 3–6 (runs extracted, sessions split, runtime folder created), `docs/tools/plan.md` (active tool budget + output policy), `docs/skills/plan.md` (progressive instruction loading).

> **See also:** [spec.md](spec.md) — full feature spec, data model, and behavior contracts.

## Why this matters (harness principles)

- **Brain / Hands / Session are independent primitives.** Anthropic's Managed Agents post is explicit: agent config + environment template + stateful session, decoupled.
- **The harness should evolve independently of the model and the transport.** Claude Code team's "seeing like an agent" lesson.
- **Composable primitives over opinionated workflows.** Anthropic's "Building Effective Agents".

## Reference repos & articles

- [The Design of Claude Managed Agents — Anthropic](https://www.anthropic.com/engineering/managed-agents)
- [Components of a Coding Agent — Sebastian Raschka](https://magazine.sebastianraschka.com/p/components-of-a-coding-agent)
- [OpenClaw](https://github.com/openclaw/openclaw) — runtime that orchestrates across channels
- [Microsoft Agent Framework](https://github.com/microsoft/agent-framework)
- [LangGraph](https://github.com/langchain-ai/langgraph) — graph-based runtime

## Current state in AgentStudio

- [src/routes/chat/[id]/stream/+server.ts](../../src/routes/chat/[id]/stream/+server.ts) is the loop and the transport.
- [src/lib/agents/inline-subagent.ts](../../src/lib/agents/inline-subagent.ts) is a near-duplicate of the loop for sub-agents.
- [src/lib/automation/engine.ts](../../src/lib/automation/engine.ts) likely re-implements pieces of the loop for scheduled runs.
- The orchestrator prompt builder lives in [src/lib/agents/orchestrator.ts](../../src/lib/agents/orchestrator.ts) but the calling code is duplicated.

## Target design

### Three primitives

```ts
// src/lib/runtime/types.ts
type AgentDefinition = {
	id: string
	systemPrompt: string // assembled (skills, identity, policies)
	model: string
	reasoning?: ReasoningConfig
	toolAllowList?: string[]
	capabilityGroups: CapabilityGroup[]
}

type Environment = {
	workspaceRoot: string // sandbox path (per-run, see workspace plan)
	approvalRequiredTools: Set<string>
	mcpServers?: McpServerRef[]
	envVars?: Record<string, string>
	networkPolicy?: 'open' | 'restricted' | 'none'
}

type Session = {
	runId: string
	sessionId: string // FK to sessions table
	taskId?: string
	parentRunId?: string
	emit: (event: RunEvent) => Promise<void> // dual-writes to SSE + run_events
	getMessages: () => Promise<LlmMessage[]>
	appendMessage: (m: LlmMessage) => Promise<void>
	pendingApproval: (req) => Promise<boolean>
	pendingQuestion: (req) => Promise<Answer[]>
}
```

### The loop

```ts
// src/lib/runtime/loop.server.ts
export async function runAgentLoop(args: {
	definition: AgentDefinition
	environment: Environment
	session: Session
}): Promise<RunResult>
```

`+server.ts` becomes a thin transport: build the three primitives, hand off to `runAgentLoop`, pipe `session.emit` into SSE.

### Reuse

- Chat stream → builds an SSE-backed Session (`runtime/session/sse.server.ts`).
- Automation engine → builds a detached Session (`runtime/session/detached.server.ts`) that emits to `run_events` only.
- Sub-agent → builds child Session whose `emit` is forwarded to the parent's event bus (see `docs/runtime/parallel-subagents.plan.md`).

## Implementation steps (phased)

### Phase 1 — Extract pure loop

- Move the `for (let round = 0; round <= MAX_TOOL_ROUNDS; round++)` block into `runAgentLoop()`.
- Replace direct `controller.enqueue(sse(...))` with `session.emit(...)`.
- `+server.ts` retains transport + Session construction only.

### Phase 2 — Define `AgentDefinition` builder

- `buildAgentDefinition(conversationId, user)` consolidates: orchestrator vs agent path, skill summaries, policies, tool allow-lists.
- Returns a fully-resolved object; loop never reads from `conversations`/`agents` tables directly.
- Only short, relevant skill summaries should be loaded by default; full skill bodies stay out of the live prompt unless explicitly requested or clearly needed.

### Phase 3 — Define `Environment` descriptor

- Resolves workspace root (depends on workspace plan).
- Reads approval set, capability groups.
- Stub MCP for future.

### Phase 4 — Tool and output context policy

- Runtime enforces the active tool budget from the tools plan.
- Large tool outputs are stored durably and returned to the model as summary + head/tail excerpts + pointer.
- Old tool outputs are compacted preferentially before higher-value user/task state.

### Phase 5 — Replace inline-subagent

- Sub-agents call `runAgentLoop` with their own Session (event-forwarded to parent).
- Delete the duplicated loop in `inline-subagent.ts`.

### Phase 6 — Reuse for automations

- Automation engine constructs Session that drops events into `run_events` only.
- Removes any duplicate loop logic in `automation/engine.ts`.

## Files to create / modify

- `src/lib/runtime/types.ts` (new)
- `src/lib/runtime/loop.server.ts` (new — extracted core)
- `src/lib/runtime/definition.server.ts` (new — builds AgentDefinition)
- `src/lib/runtime/environment.server.ts` (new — builds Environment, delegates to `workspace/`)
- `src/lib/skills/skills.server.ts` — summary extraction and relevant-skill lookup
- `src/lib/runtime/session/sse.server.ts` (new — SSE-backed Session)
- `src/lib/runtime/session/detached.server.ts` (new — for automations/subagents)
- `src/lib/runtime/session/types.ts` (new)
- `src/lib/runtime/index.ts` (barrel)
- `src/routes/chat/[id]/stream/+server.ts` — slimmed to transport
- `src/lib/agents/inline-subagent.ts` — DELETED (replaced by `runtime/spawn.server.ts`)
- `src/lib/automations/engine.ts` — uses runtime
- `docs/runtime/runtime.md` (domain doc once shipped)

## Migration / backward-compat

- Pure refactor: outward behavior should match. Keep both implementations behind a flag (`USE_NEW_RUNTIME`) for one release.
- Existing tests assert observable SSE shape; they pin behavior during the move.

## Verification

- All existing chat E2E tests pass without change.
- Unit tests on `runAgentLoop` with a fake Session (capture emitted events).
- Automation run uses the same loop and emits identical event stream into `run_events`.
- Large-output regression: oversized tool result is summarized in live context while raw payload remains recoverable.
- Skill-loading regression: runtime loads skill summaries for relevant capabilities without injecting entire skill bodies on first turn.

## Out of scope

- Replacing OpenRouter SDK.
- Streaming protocol changes (still SSE).
- Multi-region runtime distribution.

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



