# Workspace Plan

Status: active

## Overview

`SANDBOX_WORKSPACE/<userId>` is shared across every session, agent, and run for a given user. Any two parallel runs (let alone sub-agents) collide on the filesystem. Move to per-run isolated workspaces — the single most repeated pattern across orchestrators in the awesome-agent-harness list. The work lives in a new top-level domain `src/lib/workspace/` extracted from `tools/`.

> **Depends on:** `docs/structure/plan.md` Step 7 (extract `workspace/` from `tools/`).

> **See also:** [spec.md](spec.md) — full feature spec, data model, and behavior contracts.

## Why this matters (harness principles)

- **Corrections are cheap, waiting is expensive** — but only if parallel runs don't corrupt each other.
- **One agent, one worktree.** Vibe Kanban's enforced invariant.
- **Environment as a primitive.** Anthropic's Managed Agents post: environment template is independent of the brain.

## Reference repos & articles

- [Vibe Kanban](https://github.com/BloopAI/vibe-kanban) — git worktree per agent
- [Emdash](https://github.com/generalaction/emdash) — isolated worktrees, locally or SSH
- [Trellis](https://github.com/mindfold-ai/trellis) — git worktree-based parallel harness
- [Scion (Google)](https://github.com/GoogleCloudPlatform/scion) — container + worktree + creds per agent
- [Gas Town](https://github.com/gastownhall/gastown) — Docker-based with worktree isolation

## Current state in AgentStudio

- `SANDBOX_WORKSPACE` env var resolves to a single root in [src/lib/tools/tools.server.ts](../../src/lib/tools/tools.server.ts) (filesystem tools).
- All filesystem tools (`file_read`, `file_write`, `shell`, etc.) operate against `${SANDBOX_WORKSPACE}/${userId}/...`.
- No GC, no per-run lifecycle, no concept of "ephemeral" vs "persistent" workspaces.

## Target design

### Workspace path resolution

```
${SANDBOX_WORKSPACE}/<userId>/<runId>/        # ephemeral (default)
${SANDBOX_WORKSPACE}/<userId>/persistent/<key>/  # persistent (opt-in by Environment)
```

### Environment descriptor (from agents-runtime plan)

```ts
type Environment = {
	workspaceMode: 'ephemeral' | 'persistent' | 'worktree'
	workspaceRoot: string // resolved absolute path
	workspaceKey?: string // for persistent
	gitWorktree?: { repo: string; branch: string }
	ttlDays?: number // for ephemeral GC
}
```

### Lifecycle

1. **Run start** — runtime creates workspace dir (or `git worktree add`).
2. **Run end** — keep dir for inspection until TTL (default 7 days for ephemeral).
3. **GC job** — daily cleanup of expired ephemeral workspaces.
4. **Worktree mode** (advanced) — clone of repo per run, branch named after run, optional auto-PR on completion.

### Tool plumbing

All filesystem tools take `Environment` (not `userId`) when computing paths. The runtime injects it. Tools never look at the user directly.

## Implementation steps (phased)

### Phase 1 — Per-run ephemeral dirs

- Resolve workspace by `runId` not `userId`.
- Create on run start, leave for TTL.
- Update all FS tools in `tools.server.ts` to accept the resolved path.

### Phase 2 — Persistent workspace mode

- Allow agents to opt into a stable key (e.g., a long-running coding agent that wants a stable repo checkout).
- Stored on `agents.config.environment`.

### Phase 3 — GC job

- Daily cron (lift the existing automation engine's scheduler) deletes ephemeral workspaces older than TTL.
- Skip if `pinned: true` in run metadata.

### Phase 4 — Git worktree mode

- For runs attached to a repo, `git worktree add ../<runId> -b run/<runId>` instead of plain dir.
- Tool surface auto-detects worktree and exposes `git_*` helpers (read-only initially).

### Phase 5 — Optional container isolation

- Behind a flag, run shell tools inside a per-run container (Docker / Bun isolate). Out of scope for first cut but design with this in mind.

## Files to create / modify

- `src/lib/runtime/environment.server.ts` — calls into `workspace/` to resolve paths
- `src/lib/workspace/workspace.server.ts` (new) — create/destroy/resolve helpers
- `src/lib/workspace/gc.server.ts` (new) — daily cleanup
- `src/lib/workspace/worktree.server.ts` (new) — git worktree mode
- `src/lib/workspace/index.ts` (new barrel)
- `src/lib/tools/catalog/fs.server.ts` — paths from Environment, no longer resolves itself
- `src/lib/tools/catalog/shell.server.ts` — same
- `src/lib/automations/engine.ts` — schedule GC job
- `scripts/gc-workspaces.ts` (new) — manual GC CLI
- `docs/workspace/workspace.md` (domain doc once shipped)

## Migration / backward-compat

- Existing per-user dir becomes the default `persistent` workspace for legacy agents.
- Flag `WORKSPACE_PER_RUN=1` enables Phase 1 in non-prod first.
- Tools can fall back to user dir if Environment is absent (until runtime extraction is done).

## Verification

- Two parallel runs writing to `notes.md` produce two distinct files.
- After 7 days, ephemeral workspace removed; persistent untouched.
- E2E test: `tests/sandbox.isolation.spec.ts` — start two runs that each `file_write` the same path, assert no collision.

## Out of scope

- Container/VM isolation (Phase 5 is a stub).
- Network egress policy (separate doc).
- Cross-run data sharing primitives.

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



