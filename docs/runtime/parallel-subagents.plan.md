# Parallel Sub-Agents Plan

## Overview

`run_subagent` today blocks the parent stream: [runInlineSubagent](../../src/lib/agents/inline-subagent.ts) runs synchronously inside the parent's controller, emits nested SSE events, and returns the result string before the parent continues. This precludes parallelism and forces the parent loop to wait. Replace with detached child runs joined by an event bus, so the parent can fan out N children and the UI can render the run tree.

> **Depends on:** `docs/runs/plan.md` (run_events log), `docs/runtime/plan.md` (Session abstraction), `docs/structure/plan.md` (`runtime/` folder, `sessions.kind` discriminator).

## Why this matters (harness principles)

- **Corrections are cheap, waiting is expensive.** The whole point of orchestrators is throughput.
- **Cheap executor + expensive advisor.** Anthropic's multi-agent coordination patterns assume parallel cheap workers.
- **One agent, one worktree.** Parallelism without isolation corrupts state.

## Reference repos & articles

- [Scion (Google)](https://github.com/GoogleCloudPlatform/scion) — concurrent isolated processes per agent
- [Composio Agent Orchestrator](https://github.com/ComposioHQ/agent-orchestrator) — parallel coding agents in worktrees
- [ruflo](https://github.com/ruflo-ai/ruflo) — swarm mode for parallel Claude Code agents
- [Oh My Claude Code (Ultrapilot)](https://github.com/Yeachan-Heo/oh-my-claudecode) — 5 Claude Code instances in parallel worktrees
- [Trellis](https://github.com/mindfold-ai/trellis) — worktree-based parallel harness
- [Multi-Agent Coordination Patterns — Anthropic](https://claude.com/blog/multi-agent-coordination-patterns)

## Current state in AgentStudio

- `run_subagent` tool path in [src/routes/chat/[id]/stream/+server.ts](../../src/routes/chat/[id]/stream/+server.ts) calls `runInlineSubagent` synchronously and forwards events.
- Sub-agent has its own `chatRuns` row but no `parentRunId` linkage.
- Sub-agent shares the parent's workspace (no isolation).
- Parent waits for child to complete before continuing — no fan-out, no cancellation.

## Target design

### Schema

`runs` adds `parentRunId uuid null`. Child sessions are created with `kind = 'agent_subagent'`, `parentSessionId = <parent>`, `visibleToUser = false`.

### Tool surface

`run_subagent` becomes async-by-default:

- Returns immediately with `{ childRunId, status: 'running' }`.
- Parent can call `await_subagents([childRunId, ...])` to join, with `mode: 'all' | 'any' | 'race'`.
- Or fire-and-forget for background work.

### Event forwarding

- Child run writes to `run_events` (per Runs plan).
- Parent SSE handler subscribes to child `run_events` and emits `subagent_event` envelopes.
- The chat UI renders a collapsible tree per parent run.

### Spawning

```ts
// src/lib/runtime/spawn.server.ts
async function spawnSubagent(parent: Session, step: SubagentStep): Promise<{ childRunId: string }> {
	const childSessionId = await createSession({
		kind: 'agent_subagent',
		parentSessionId: parent.sessionId,
		visibleToUser: false,
		agentId: step.agentId,
	})
	const childRunId = await createRun({ sessionId: childSessionId, parentRunId: parent.runId })
	const childDef = await buildAgentDefinition({ agentId: step.agentId })
	const childEnv = await buildEnvironment({ runId: childRunId, workspaceMode: 'ephemeral' })
	const childSession = makeDetachedSession({ runId: childRunId, sessionId: childSessionId, parentRunId: parent.runId })
	// Run in background — do not await
	void runAgentLoop({ definition: childDef, environment: childEnv, session: childSession })
	return { childRunId }
}
```

### UI

- Parent message renders sub-agent cards with status, last delta, expand to child timeline.
- `/chat/[childId]` is reachable for full inspection.
- Cancel / pause buttons on each child.

## Implementation steps (phased)

### Phase 1 — Schema + linkage

- Add `parentRunId` to `chatRuns`.
- Backfill any existing inline-subagent runs (best effort via metadata).

### Phase 2 — Detached spawn

- Replace `runInlineSubagent` body with `spawnSubagent`.
- Parent emits `subagent_started { childRunId }` and continues.

### Phase 3 — Event forwarding

- Parent SSE subscribes (LISTEN/NOTIFY or polling) to child `run_events`.
- Forwards as namespaced events to client.

### Phase 4 — `await_subagents` tool

- Tool blocks until specified children reach a terminal state.
- Modes: `all`, `any`, `race`.

### Phase 5 — Fan-out demos

- Document patterns (research swarm, parallel codegen, voting evaluator).
- Add cost cap per parent run to prevent runaway swarms.

### Phase 6 — Tree UI

- Collapsible run-tree component in chat detail.
- Status, cost, duration per node.

## Files to create / modify

- `src/lib/runs/runs.schema.ts` — `parentRunId`
- `src/lib/sessions/sessions.schema.ts` — `kind`, `parentSessionId`, `visibleToUser` (already from Structure plan)
- `src/lib/runtime/spawn.server.ts` (new) — `spawnSubagent`, `awaitSubagents`
- `src/lib/agents/inline-subagent.ts` — DELETED after migration
- `src/lib/tools/catalog/meta.server.ts` — `run_subagent` returns childRunId; new `await_subagents` tool
- `src/routes/chat/[id]/stream/+server.ts` — subscribe to child events via `run_events`
- `src/lib/sessions/components/SubagentBlockCard.svelte` — show status + link to child
- `src/lib/sessions/components/RunTree.svelte` (new)

## Migration / backward-compat

- Old assistant messages stored inline subagent results as text — keep rendering them.
- Feature flag `PARALLEL_SUBAGENTS` defaults off until Phase 4 lands.

## Verification

- E2E: orchestrator spawns 3 research sub-agents in parallel; total wall time ≈ slowest child, not sum.
- DB check: each child has `parentRunId` and a unique workspace dir.
- UI: tree expands and live-updates.
- Cost cap test: parent budget exceeded → outstanding children canceled.

## Out of scope

- Cross-process distributed scheduling.
- Inter-agent direct messaging beyond parent ↔ child (covered by hooks/runtime later).
- Voting/consensus algorithms (a separate "evaluator" plan handles critic patterns).
