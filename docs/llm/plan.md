# LLM Plan

Status: completed

> **See also:** [spec.md](spec.md), [../structure/plan.md](../structure/plan.md)

## Goal

Consolidate `src/lib/openrouter.server.ts` and `src/lib/models/` into a single `src/lib/llm/` domain folder. This is a structural cleanup — no behavior changes. After the move, all callers import from `$lib/llm` instead of two separate paths.

## Current State

- `src/lib/openrouter.server.ts` — `streamChat()`, `LlmMessage`, `StreamOptions`, reasoning config
- `src/lib/models/models.ts` — `listModels()`, `getModel()`, `calculateCost()`, `ModelInfo`
- `src/lib/models/models.remote.ts` — client-callable wrappers for model list
- `src/lib/models/ModelSelector.svelte` — UI component
- `src/lib/models/index.ts` — re-exports
- Callers import from either `$lib/openrouter.server` or `$lib/models`

## Phase 1 — Create `llm/` folder and move files

**Goal:** All LLM code lives under `src/lib/llm/`.

### 1.1 Create target files

| Source                        | Target                     |
| ----------------------------- | -------------------------- |
| `openrouter.server.ts`        | `llm/chat.server.ts`       |
| `models/models.ts`            | `llm/models.server.ts`     |
| `models/models.remote.ts`     | `llm/models.remote.ts`     |
| `models/ModelSelector.svelte` | `llm/ModelSelector.svelte` |

Create `llm/index.ts` that re-exports the public API.

### 1.2 Update imports across codebase

Update every file that imports from `$lib/openrouter.server` or `$lib/models` to import from `$lib/llm` instead. Key call sites:

- `/chat/[id]/stream/+server.ts` — `streamChat`
- `src/lib/agents/orchestrator.ts` — `streamChat`
- `src/lib/cost/usage.ts` — `calculateCost`
- `src/lib/chat/chat.server.ts` — `streamChat`
- Any route that uses `ModelSelector` or `listModels`

### 1.3 Delete old locations

Remove `src/lib/openrouter.server.ts`, `src/lib/models/`.

## Phase 2 — Model cache improvements (optional)

**Goal:** Make the model catalog more resilient.

### 2.1 Stale-while-revalidate

Return cached models immediately if cache is < 2h old, refresh in background. Prevents cold-start latency on first request after TTL expires.

### 2.2 Capability index

Build an in-memory index: `{ supportsVision: string[], supportsTools: string[], supportsReasoning: string[] }` so callers can filter models by capability without scanning the full list.

## Rewrite Authority

The current implementation is a baseline, not a constraint. This domain may be rewritten, restyled, reorganized, or replaced as needed to achieve the target product quality. No code path is off-limits if behavior contracts, safety controls, tests, and documentation remain correct.

## UI Contract

Implementation in this domain must comply with [../ui/plan.md](../ui/plan.md) and [../ui/spec.md](../ui/spec.md).

- Include UX acceptance criteria for desktop and mobile behavior.
- Include compactness/density behavior where relevant.
- Include approval, question, and interruption flows where relevant.

## Dependencies

- [../structure/plan.md](../structure/plan.md) Step 2 — this is that step
- No other plans depend on this; it is a pure rename/consolidation

## Completion

- Template: YYYY-MM-DD - Completed in <PR/commit> - <one-line outcome>
- 2026-05-01 - Completed in local-uncommitted - Consolidated OpenRouter + model catalog + selector into `src/lib/llm/` and moved callers to `llm` imports.
