# Projects

## Overview

Projects are durable containers for the work the user produces with their agents. Each project holds named **artifacts** — documents, code files, specs, plans, anything the user wants to keep — and every edit creates a new version, so nothing is ever overwritten or lost. Think of it as an organizing layer on top of conversation transcripts: chats are about figuring things out, projects are about retaining what got figured out.

Projects are user-scoped (each user sees only their own), can be browsed and edited from the `/projects` page, and can be manipulated by agents via a small set of tools (`list_projects`, `read_artifact`, `create_artifact`, `edit_artifact`, etc.) when an agent's `projects` capability group is enabled.

## Key concepts

### The hierarchy

| Level             | What it represents                                                  | Example                                              |
| ----------------- | ------------------------------------------------------------------- | ---------------------------------------------------- |
| Project           | A container — a bucket for related work                              | "Efoil rebuild", "Tax research", "Blog drafts"       |
| Artifact          | A named document inside the project                                  | "Hydrofoil assembly guide", "Q3 expenses analysis"   |
| Version           | An immutable snapshot of an artifact at a moment in time             | v1, v2, v3 — each one an append-only edit            |

The `current_version_id` pointer on each artifact tracks which version is "live". Older versions are preserved forever; rollback creates a NEW version with the old content rather than reverting in place, so the timeline reads like an audit log.

### Project kinds

Projects are tagged with a kind for filtering and conventions:

- **efoil** — hardware tinkering / project notes
- **research** — investigation, source-gathering, analysis
- **code** — code drafts, architecture sketches
- **documentation** — user-facing docs, README content
- **other** — anything else

Kinds don't change behavior — they just make the project list easier to scan and let future automations target by kind.

### Content types

Each artifact carries a `content_type` so the UI knows how to render it:

- **markdown** (default) — most documents, with rich text formatting
- **code** — code snippets in any language, monospace render
- **json** / **yaml** — structured config or data
- **plaintext** — anything else

### Slugs

Project and artifact names are auto-converted to URL-safe slugs (lowercase, dashes, no special chars). Slugs are scoped:

- Project slug is unique per user (so two users can both have a `notes` project)
- Artifact slug is unique within its project (so two projects can both have a `readme` artifact)

Collisions append `-2`, `-3` etc. so renaming never breaks an existing URL.

## User flows

### Create and edit through the UI

1. Open `/projects`. Click **+ New project**, give it a name and kind.
2. Open the project. Click **+ New artifact**, give it a name + content type + initial content. The first version (v1) is saved.
3. Open the artifact. The current version is shown with the version history sidebar on the right.
4. Click **Edit**, type your changes, optionally add a change note, click **Save as v2**. The previous content stays preserved.
5. To revert: click any older version in the sidebar, then **Rollback to vN**. A new version is created with the older content; the in-between versions stay in the history.
6. To soft-delete: click **Soft delete** on an artifact. It disappears from the active list but the data + history are preserved (admin can flip `is_active` back true to recover).

### Edit through an agent

When an agent has the `projects` capability group enabled, it can use these tools as part of any conversation:

- `list_projects` — browse the user's existing projects to find context
- `create_project` — start a new project
- `list_artifacts(projectId)` — see what's in a project
- `read_artifact(artifactId)` — load an artifact's current content (use this BEFORE editing)
- `create_artifact(projectId, name, content)` — create a new artifact
- `edit_artifact(artifactId, content, changeNote)` — append a new version

Auto-suggest classifier surfaces the `projects` group when the user message mentions things like "project", "artifact", "document", "spec", "rfc", "draft" — so the agent gets the tools loaded automatically without having to call `enable_capability` first.

Each version edited by an agent is tagged with the originating chat run (`source_run_id`) so the audit chain points back to the conversation that produced the change.

## Roles & permissions

- **All authenticated users**: see + manage their own projects; nothing is shared cross-user.
- **Agents**: read/write only projects belonging to the conversation's owning user. Cross-user reads are explicitly rejected by the tool executor.
- **Admins**: same as users for their own projects; no special cross-user access (projects are private by design).

## Integrations

- **Chat domain** — agents get the project tools automatically when the `projects` capability group is enabled or auto-suggested.
- **Cost domain** — agent edits track `source_run_id` so the audit chain shows which run produced the version. Future work could surface cumulative cost-per-artifact in the UI.
- **Memory domain** — Phase 3 (still pending) will add `memoryDrawers.linkedArtifactId` so artifact references can be recalled in future conversations alongside the regular memory recall.
- **Sessions domain** — Phase 2 finish (still pending) will add `sessions.projectId` + a `set_project_context` tool so a conversation can be "bound" to a project for sticky context.

## Business rules

- **Append-only versioning** — `editArtifact` always creates a new version row with `seq = max+1` in a single transaction. The `current_version_id` pointer updates atomically. Old versions are never modified or deleted.
- **Rollback as forward-edit** — restoring v3 to a previous v1's content creates a NEW v4 with v1's content. The timeline preserves the full edit history including the rollback decision.
- **Per-user isolation** — every project carries a `user_id` FK with cascade-on-user-delete. Agents enforce ownership at the tool boundary; the database enforces it via the FK.
- **Soft delete only at the artifact level** — artifacts have an `is_active` boolean. Projects don't soft-delete (cascade-on-project-delete is real and removes everything). The list view filters `is_active=false` by default; pass `includeInactive` to see them.
- **Slug stability** — once an artifact is created, its slug doesn't change even if the name does. URLs stay valid forever.

## Edge cases

- **Empty content** — artifacts can have empty content (`""`) on v1 and any subsequent version. The UI renders an empty pre block; the API doesn't reject it.
- **Massive content** — there's no hard cap on `content` size (Postgres `text` column). The UI is reasonable up to a few hundred KB; beyond that the rendering will lag.
- **Concurrent edits** — `editArtifact` reads `max(seq)` then inserts `seq+1` in a transaction, so two concurrent edits get different seq numbers (no collision). The "current pointer" race is benign because both updates write a real version row — the pointer just points at whichever finished last.
- **Cascade chains** — deleting a user cascades through projects → artifacts → versions, removing everything. Deleting a project cascades through artifacts → versions. Deleting an individual version is not supported (would break the seq monotonicity contract).

## Data model summary

```
projects (
  id, name, slug, description, kind,
  user_id (FK → users CASCADE),
  created_at, updated_at
)

artifacts (
  id, project_id (FK → projects CASCADE),
  name, slug, content_type,
  current_version_id (denormalized pointer, nullable),
  is_active,
  created_at, updated_at
)

artifact_versions (
  id, artifact_id (FK → artifacts CASCADE),
  seq (unique per artifact, monotonic),
  content, change_note,
  edited_by (FK → users SET NULL),
  source_run_id (declared by-name, no FK to avoid cycle),
  cost_usd, created_at
)
```
