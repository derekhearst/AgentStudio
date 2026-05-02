# Evaluations Plan

Status: active

## Overview

AgentStudio runs a single-pass loop: model → tool → model → done. There is no critic, no automated re-plan, no quality gate before a run is marked completed. Anthropic's long-running app harness explicitly uses **planner → generator → evaluator** with sprint contracts; without this loop, the agent has no cybernetic feedback. Add a configurable evaluator pass that runs after generator completion (or per sprint), produces structured findings, and optionally triggers a correction round.

> **Depends on:** `docs/structure/plan.md` (`evaluations/` folder, `runtime/`), `docs/runs/plan.md` (run events), `docs/runtime/parallel-subagents.plan.md` (detached child runs).

> **See also:** [spec.md](spec.md) — full feature spec, data model, and behavior contracts.

## Why this matters (harness principles)

- **Cybernetic feedback closes the loop.** Martin Fowler's framing: harness = governor (sensor + actuator).
- **Planner / Generator / Evaluator.** Anthropic's pattern for multi-hour autonomous coding.
- **Mechanical architecture enforcement.** OpenAI's principle — let machines, not humans, catch invariants.

## Reference repos & articles

- [Harness Design for Long-Running Application Development — Anthropic](https://www.anthropic.com/engineering/harness-design-long-running-apps)
- [Hive (Queen Agent)](https://github.com/aden-hive/hive) — outcome-driven framework with checkpoints
- [Meta-Harness](https://yoonholee.com/meta-harness/) — Claude Code as harness optimizer
- [Multi-Agent Coordination Patterns — Anthropic](https://claude.com/blog/multi-agent-coordination-patterns) — cheap executor + expensive advisor
- [Harness Engineering Is Cybernetics — George](https://x.com/odysseus0z/article/2030416758138634583)

## Current state in AgentStudio

- Generator loop in [src/routes/chat/[id]/stream/+server.ts](../../src/routes/chat/[id]/stream/+server.ts) runs to completion based on the model deciding it's done (no tool calls left).
- No critic, no auto-retry, no quality scoring.
- `automations` can re-run on schedule but not in response to evaluation outcomes.

## Target design

### Evaluator agent type

A specialized agent role with:

- Cheap model by default (`openai/gpt-4o-mini`) — cost optimization.
- Restricted tool set: read-only (`read`, `list`, `search`).
- Structured output schema: `{ verdict: 'pass' | 'fail' | 'needs_revision', findings: Finding[], confidence: number }`.

### Trigger conditions

1. **End-of-task evaluation** — run when a task transitions to `completed`, gating the final state behind evaluator pass.
2. **End-of-run evaluation** — for runs flagged `eval_required` (set by orchestrator or task spec).
3. **Sprint evaluation** — every N rounds for long-running runs.

### Re-plan loop

If verdict = `needs_revision`:

- Findings appended to the conversation as a system message.
- New attempt spawned (within budget cap, max retries default 2).

If verdict = `fail`:

- Task → `blocked`, user notified.

### Sprint contracts

Long runs (>50 rounds) define a sprint contract: "by round X, deliverable Y must exist." Evaluator checks at sprint boundaries.

## Implementation steps (phased)

### Phase 1 — Evaluator agent kind

- Add `agents.kind` enum: `'orchestrator' | 'worker' | 'evaluator'`.
- Seed a default evaluator agent on boot.
- Read-only tool binding.

### Phase 2 — End-of-run evaluation

- After generator finishes, if `runs.evalRequired`, spawn evaluator child run.
- Evaluator output stored in `run_evaluations` table.

### Phase 3 — Re-plan loop

- On `needs_revision` verdict + retries available, spawn new run with prior context + findings.
- Budget caps (cost USD, max retries) in agent config.

### Phase 4 — Task-level integration

- Tasks marked `completed` only after evaluator pass.
- `failed` after final retry exhaustion.

### Phase 5 — Sprint contracts

- Define sprint structure in task spec (markdown sections).
- Evaluator runs per sprint boundary.

## Schema

```ts
runEvaluations: {
  id, runId, evaluatorRunId, verdict (enum), findings (jsonb),
  confidence (real), costUsd (numeric), createdAt
}

// runs additions
evalRequired: boolean default false
evalAttempt: integer default 0
```

## Files to create / modify

- `src/lib/evaluations/evaluations.schema.ts` (new)
- `src/lib/evaluations/evaluations.server.ts` (new)
- `src/lib/evaluations/index.ts` (new barrel)
- `src/lib/agents/agents.schema.ts` — `kind` enum (`orchestrator | worker | evaluator`)
- `src/lib/runs/runs.schema.ts` — `evalRequired`, `evalAttempt`
- `src/lib/runtime/loop.server.ts` — wire post-run evaluation hook
- `src/lib/runtime/spawn.server.ts` — spawn evaluator child runs (kind = 'evaluator')
- `src/routes/chat/[id]/+page.svelte` — render evaluator findings
- `docs/evaluations/evaluations.md` (domain doc once shipped)

## Migration / backward-compat

- `evalRequired` defaults `false` — no behavior change for existing chats.
- Evaluator agent seeded once; users can disable in settings.

## Verification

- Manual: simulate a code task that produces broken output → evaluator flags it → automatic retry succeeds.
- Cost regression: evaluator stays under 10% of generator cost on average.
- E2E: a task with `evalRequired` does not reach `completed` without a passing evaluation.

## Out of scope

- Multi-evaluator voting / consensus.
- Human-in-the-loop evaluator with reviews UI (separate later).
- ML-based finding clustering.

## Completion

- Template: YYYY-MM-DD - Completed in <PR/commit> - <one-line outcome>
- Pending.


