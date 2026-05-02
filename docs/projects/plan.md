# Projects Plan

Status: active

## Overview

Projects and Artifacts today do not exist as first-class entities in AgentStudio — artifacts are ephemeral SSE blocks, and project membership is implicit from mentions in chat. This creates your pain point: every edit spawns a new artifact, and membership drifts.

Implement durable Projects and Artifacts with stable identity, version history, and project membership. AI defaults to _editing the current artifact in place_ (creating a new version), never auto-creating duplicates. Paired with Memory (see [docs/memory/plan.md](../memory/plan.md)), Memory drawers can cite concrete artifact IDs for grounding and routing.

> **Depends on:** `docs/structure/plan.md` (new domains), `docs/chat/plan.md` (optional: chat/session linkage for audit trail).

> **See also:** [spec.md](spec.md) — full feature spec, data model, and behavior contracts.

## Current state in AgentStudio

- No `projects` or `artifacts` tables.
- Chat streaming emits artifact blocks (SSE) with inline content; no persistence.
- Sub-agents can spawn artifacts, but there is no parent-child tracking.
- User manually reassigns artifacts to projects in chat context.
- No versioning or edit history for files.

## Target design

### Three core tables

```ts
// src/lib/projects/projects.schema.ts
projects: {
  id: uuid primary key,
  name: text,
  slug: text unique per user,
  description: text | null,
  kind: enum('efoil', 'research', 'code', 'documentation', 'other'),
  userId: uuid fk → users,
  createdAt, updatedAt
}

artifacts: {
  id: uuid primary key,
  projectId: uuid fk → projects,
  name: text,                      // "Hydrofoil Assembly Guide"
  slug: text,                       // unique per project
  contentType: enum('markdown', 'code', 'json', 'yaml', 'plaintext'),
  currentVersionId: uuid fk → artifactVersions,  // denorm for quick access
  isActive: boolean default true,  // soft-delete
  createdAt, updatedAt
}

artifactVersions: {
  id: uuid primary key,
  artifactId: uuid fk → artifacts,
  seq: integer,                     // version number (1, 2, 3, ...)
  content: text,
  changeNote: text | null,          // user/agent-provided change summary
  editedBy: uuid | null,            // user ID (null = agent)
  sourceRunId: uuid | null,         // chat run that produced this version (audit)
  costUsd: numeric | null,          // LLM cost of this edit
  createdAt
}
```

### Session context

When a user opens or creates a project in chat, the session becomes "project-scoped":

- `sessions.projectId` nullable uuid
- `sessions.currentArtifactId` nullable uuid

### Lifecycle: default edit behavior

**User asks to edit or create:**

1. If `sessions.projectId` is set and the artifact exists → update current artifact, create new version.
2. If artifact does not exist but project is set → create artifact in project with version 1.
3. If no project context → ask user to pick/create project before creating new artifact.

**AI sees one artifact while editing:**

- During edit operations, tool loading resolves only `artifact.currentVersionId` for the selected artifact.
- Revision history is visible through explicit version API calls (`getVersionHistory`, `getVersion`).
- The model does not receive sibling artifact contents unless user asks for cross-artifact synthesis.

**Versions are immutable:** Versions are append-only; no edits to old versions. `artifactVersions.seq` is the canonical version number shown in the UI ("v2", "v3").

### Memory integration contract (without changing Memory plan)

This plan integrates with Memory via stable IDs and events while keeping Memory as retrieval infrastructure, not the artifact source of truth.

**Ownership boundary:**

- `projects` + `artifacts` + `artifactVersions` are the write source of truth.
- Memory stores references and retrieval snippets only.

**Write path:**

1. `edit_artifact` creates `artifactVersions.seq = N+1`.
2. Runtime emits `artifact_edited` with `{ projectId, artifactId, versionSeq, sourceRunId, changeNote }`.
3. Memory miner consumes that event asynchronously and creates a drawer linked to artifact/version.

**Read path:**

1. Memory retrieval may return drawers linked to artifacts.
2. Prompt formatter includes compact references (artifact name + version) but does not inline full historical versions by default.
3. If model decides to edit, it must target current artifact identity, not create a new artifact unless user intent is explicit.

**Idempotency rules:**

- Editing same artifact repeatedly in one session appends versions to one artifact ID.
- Replayed `artifact_edited` events must be deduped by `(artifactId, versionSeq)` in miner pipeline.
- Any fallback re-run of mining must not create duplicate drawers for same version key.

### Project context stickiness

**In chat:**

- User says "switch to efoil project" → `sessions.projectId = <efoil_id>`.
- User says "new artifact: Battery Spec" → created in efoil, `currentArtifactId = <battery_id>`.
- User says "update that" referring to Battery Spec → edits `<battery_id>`, creates version 2.
- If user switches projects without saying so, the AI should ask: "should I keep editing Battery Spec or start fresh in [other project]?"

**Sticky default:**

- Once a project is chosen, stay in it until explicitly switched or chat ends.
- Same for artifact: once an artifact is edited, further "update that" calls default to the same artifact.

### Conflict resolution

If a user in project A is editing Artifact X and a sub-agent in project B tries to create an artifact with the same name, they are **separate entities** (different `projectId`). No collision.

If a user says "add this to my efoil project" and an artifact already exists in efoil with the same slug, **prompt for confirmation:**

- Append version to current artifact?
- Overwrite (create new)?
- Create with a new name?

## Files to create / modify

- `src/lib/projects/projects.schema.ts` (new)
- `src/lib/projects/projects.server.ts` (new) — CRUD, slug generation, context switching
- `src/lib/projects/projects.remote.ts` (new) — SvelteKit remote for UI
- `src/lib/projects/index.ts` (new barrel)
- `src/lib/artifacts/artifacts.schema.ts` (new)
- `src/lib/artifacts/artifacts.server.ts` (new) — create/update/get, version management
- `src/lib/artifacts/artifacts.remote.ts` (new) — SvelteKit remote for preview + history
- `src/lib/artifacts/index.ts` (new barrel)
- `src/lib/sessions/sessions.schema.ts` — add `projectId`, `currentArtifactId` (note: already exists per Structure plan)
- `src/lib/memory/memory.schema.ts` — add `linkedArtifactId`, `linkedArtifactVersion` to `memoryDrawers` (Phase 1)
- `src/lib/memory/mining.server.ts` — auto-create drawer when artifact is edited (Phase 3)
- `src/lib/runtime/loop.server.ts` — set `session.projectId` if artifact edit happens; call mining hook
- `src/lib/tools/catalog/meta.server.ts` — new tool `set_project_context`, `create_artifact`, `edit_artifact`
- `src/routes/projects/+page.svelte` (new) — project list, create, rename, delete
- `src/routes/projects/[id]/+page.svelte` (new) — project detail, artifact list, settings
- `src/routes/projects/[id]/artifacts/[aid]/+page.svelte` (new) — artifact viewer + version history browser
- `src/routes/chat/[id]/context-panel.svelte` (new or extend) — show current project + artifact in sidebar
- `docs/projects/projects.md` (new domain doc once shipped)

## Phases

### Phase 1 — Schema + core CRUD (standalone)

1. Create `projects.schema.ts` and `artifacts.schema.ts` with Drizzle.
2. Generate migration: `bunx drizzle-kit generate "add projects and artifacts"`.
3. Implement `projects.server.ts`: `createProject`, `getProject`, `listProjects`, `updateProject`, `deleteProject`.
4. Implement `artifacts.server.ts`:
   - `createArtifact(projectId, name, content, contentType)` → generates version 1.
   - `editArtifact(artifactId, newContent, changeNote)` → creates new version, updates `currentVersionId`.
   - `getArtifact(id)` → loads latest version.
   - `getVersionHistory(artifactId)` → list all versions.
   - `rollback(artifactId, toSeq)` → creates a new version copying old seq (non-destructive).
5. Barrel exports.

### Phase 2 — Chat integration (Phase 1 dependent)

1. Add `projectId`, `currentArtifactId` to `sessions` schema (likely already done in Structure refactor).
2. In `src/lib/tools/catalog/meta.server.ts`:
   - `set_project_context(projectNameOrId)` → updates session.projectId.
   - `create_artifact(name, content, contentType, changeNote)` → calls `artifacts.server.ts` in current project.
   - `edit_artifact(artifactIdOrName, newContent, changeNote)` → routes to same artifact by default if in project context.
3. In `src/lib/runtime/loop.server.ts`:
   - After artifact tool execution, set `session.projectId` and `session.currentArtifactId`.
   - Emit `artifact_edited` event with artifact ID and version seq.
4. Implement `projects.remote.ts` and `artifacts.remote.ts` for UI queries.

### Phase 3 — Memory bridge (Phase 1 + Memory plan implementation dependent)

Do not execute this phase until the memory workstream has merged its schema/modules.

1. In `memoryDrawers` schema, add:
   - `linkedArtifactId` uuid | null
   - `linkedArtifactVersion` integer | null
2. In `memory/mining.server.ts`, when creating a drawer from a message that references an artifact, set these fields.
3. Add a hook in `src/lib/runtime/loop.server.ts` that calls `memoryMine` after artifact edits, creating a drawer with the change note and artifact link.
4. Update Memory recall formatter to emit artifact references like: "see Hydrofoil Assembly (v3) in efoil project".

### Phase 4 — UI surface (Phases 1–3 dependent)

1. `src/routes/projects/+page.svelte` — list, create, quick actions.
2. `src/routes/projects/[id]/+page.svelte` — project overview, artifact browser, settings.
3. `src/routes/projects/[id]/artifacts/[aid]/+page.svelte` — artifact viewer with syntax highlight, version selector, revision timeline, rollback button.
4. `src/routes/chat/[id]/context-panel.svelte` — sidebar showing:
   - Current project (if any) with change-project button.
   - Current artifact (if any) with artifact list dropdown.
   - Quick link to artifact detail page.
5. Extend `src/routes/+layout.svelte` with projects nav (quick switcher).

### Phase 5 — AI UX polish (Phases 1–4 dependent)

1. Implement confident-artifact-selection heuristic: if user says "update that", AI queries last-edited artifact in session and uses it directly.
2. Implement ask-on-ambiguity: if AI detects multiple possible artifacts, ask user before proceeding.
3. Add artifact-suggest-on-create: when AI wants to create new artifact outside a project, suggest creating a project first.
4. Implement conflict-resolution flow: if artifact name collision, offer append/overwrite/rename options.

### Phase 6 — Tests (Phases 1–5 dependent)

1. `tests/projects.spec.ts`:
   - Create project → slug is unique and URL-safe.
   - Create artifact in project → version 1 is created, `currentVersionId` set.
   - Edit artifact → version 2 created, `currentVersionId` updated, version 1 unchanged.
   - Rollback → new version copies old version content, seq increments.
   - Delete project → artifacts soft-deleted (isActive = false).
2. `tests/chat-projects.spec.ts` (Playwright):
   - Chat session in project context → artifact created in correct project.
   - Switch project → next artifact created in new project.
   - Edit artifact → reflected on artifact detail page with correct version history.
3. `tests/memory-artifacts.spec.ts`:
   - Artifact edit → drawer created in project wing with linked artifact ID.
   - Memory recall → artifact link in formatted context.

### Phase 7 — Documentation (parallel with Phase 6)

1. `docs/projects/projects.md` — domain doc covering:
   - Concepts: projects, artifacts, versions, project context, stickiness.
   - User flows: create project, add artifact, edit artifact, view history, rollback.
   - AI flows: default edit behavior, artifact selection heuristic, conflict resolution.
   - Integration: Memory bridge, how artifacts are cited in recalls.
   - Business rules: slug uniqueness per project, version immutability, soft-delete policy.
2. Update root `README.md` with Projects section.

## Verification

1. `bunx drizzle-kit generate` produces clean migration; `docker compose up` applies without error.
2. `bun run check` — TypeScript + Svelte clean.
3. `bun run test:e2e` — existing suite green; new `tests/projects.spec.ts` and `tests/chat-projects.spec.ts` pass.
4. Manual:
   - Create efoil project → open `/projects/efoil`.
   - Start chat in efoil context.
   - Say "create artifact: Assembly Guide" → artifact appears in project.
   - Say "update that, add section on waterproofing" → version 2 created, history shows both.
   - Switch project → new artifact created in new project, efoil Assembly Guide unchanged.
   - Revert to efoil project, open Assembly Guide → can see all versions, click v1 to see original, rollback creates v3 with v1 content.
5. Artifact detail page shows linked Memory drawers (if Memory Phase 3 shipped).

## Scope boundaries

- **Included**: Projects CRUD, Artifacts with version history, project context stickiness, Memory integration, full UI (list, detail, history, rollback), AI tools for artifact creation/editing, tests, docs.
- **Excluded** (for v1): Artifact branching (fork as new artifact, rebase onto parent); collaborative editing (multiplayer cursors); artifact templates; project templates; export/import; artifact sharing/publishing.

## Integration with existing plans

- **Structure plan** — Projects and Artifacts are new domains, follow same `src/lib/{domain}/` barrel pattern.
- **Memory plan** — Artifacts integrate as linked references in drawers; auto-mining on edit enriches project context.
- **Chat integration** — Tools in `meta.server.ts` for artifact operations; session stickiness via `projectId` and `currentArtifactId`.
- **Runtime plan** — Artifact edits emit events to mining hook; cost logged to `artifactVersions.costUsd`.

## Key design decisions

1. **Immutable versions**: Never edit old versions; always append. Non-destructive rollback via copy.
2. **Default edit semantics**: If in project context and user says "update", assume current artifact unless ambiguous.
3. **No auto-project inference**: User or AI must explicitly set project context; don't infer from conversation topic.
4. **Memory bridge**: Artifacts are first-class; Memory augments via references, not vice versa.
5. **Slug uniqueness**: Per project (not global), simplifies routing and mental model.

## Rewrite Authority

The current implementation is a baseline, not a constraint. This domain may be rewritten, restyled, reorganized, or replaced as needed to achieve the target product quality. No code path is off-limits if behavior contracts, safety controls, tests, and documentation remain correct.

## UI Contract

Implementation in this domain must comply with [../ui/plan.md](../ui/plan.md) and [../ui/spec.md](../ui/spec.md), with explicit projects/worktree UX criteria.

- Desktop: projects list + detail + worktree status must remain navigable without leaving the main shell.
- Mobile: project detail and worktree controls should use progressive disclosure and avoid overflowing metadata.
- Blocking actions: archive/delete/reset branch flows require confirmation and clear rollback/recovery messaging.
- Visual QA: project list states and worktree conflict badges are included in regression snapshots.

## Completion

- Template: YYYY-MM-DD - Completed in <PR/commit> - <one-line outcome>
- Pending.
