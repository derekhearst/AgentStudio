# Projects & Artifacts Spec

## Overview

A project is a named container for related work. An artifact is a named, versioned document or file that lives inside a project. When an agent edits an artifact, it creates a new version — it never overwrites previous versions. The AI defaults to editing the current artifact in place when a project is in scope; it never silently creates a duplicate.

## Data Model

### `projects` table

| Column        | Type      | Description                                            |
| ------------- | --------- | ------------------------------------------------------ |
| `id`          | uuid      | Primary key                                            |
| `name`        | text      | Display name                                           |
| `slug`        | text      | Unique per user, URL-safe                              |
| `description` | text?     | Short description of the project's purpose             |
| `kind`        | enum      | `research`, `code`, `documentation`, `design`, `other` |
| `userId`      | uuid      | FK to `users` — owner                                  |
| `createdAt`   | timestamp |                                                        |
| `updatedAt`   | timestamp |                                                        |

### `artifacts` table

| Column             | Type      | Description                                             |
| ------------------ | --------- | ------------------------------------------------------- |
| `id`               | uuid      | Primary key                                             |
| `projectId`        | uuid      | FK to `projects`                                        |
| `name`             | text      | Display name (e.g., "Hydrofoil Assembly Guide")         |
| `slug`             | text      | Unique per project, URL-safe                            |
| `contentType`      | enum      | `markdown`, `code`, `json`, `yaml`, `plaintext`         |
| `currentVersionId` | uuid      | FK to `artifactVersions` — denormalized for fast access |
| `isActive`         | boolean   | Soft-delete flag (true = not deleted)                   |
| `createdAt`        | timestamp |                                                         |
| `updatedAt`        | timestamp |                                                         |

### `artifactVersions` table

| Column        | Type      | Description                                                       |
| ------------- | --------- | ----------------------------------------------------------------- |
| `id`          | uuid      | Primary key                                                       |
| `artifactId`  | uuid      | FK to `artifacts`                                                 |
| `seq`         | integer   | Version number (1, 2, 3 ...) — shown to users as "v1", "v2", etc. |
| `content`     | text      | Full content of this version                                      |
| `changeNote`  | text?     | Human or agent-provided summary of what changed                   |
| `editedBy`    | uuid?     | FK to `users` — null if edited by an agent                        |
| `sourceRunId` | uuid?     | FK to `runs` — which run produced this version                    |
| `costUsd`     | numeric?  | LLM cost of this edit (when agent-produced)                       |
| `createdAt`   | timestamp |                                                                   |

Versions are immutable after creation. `artifactVersions` rows are never updated.

### Session context

| Column              | Lives on   | Description                                    |
| ------------------- | ---------- | ---------------------------------------------- |
| `projectId`         | `sessions` | The project currently in scope for the session |
| `currentArtifactId` | `sessions` | The artifact the agent should edit by default  |

## Features

### Default edit behavior

When a project is in scope (`sessions.projectId` is set):

1. If the artifact exists → agent edits the current artifact, creating a new version (no duplicate)
2. If the artifact does not exist but a project is set → create artifact in the project with version 1
3. If no project is in scope → agent asks the user to pick or create a project before creating an artifact

The agent never auto-creates a duplicate artifact when one already exists in the project.

### One artifact in focus

During edit operations, the runtime provides only the current version's content to the agent. Sibling artifacts in the project are not injected into the context unless the user explicitly requests cross-artifact work.

Version history is accessible via tool calls (`get_version_history`, `get_version`) but is not pre-loaded.

### Immutable version history

Every save creates a new `artifactVersions` row. Old versions cannot be edited. The UI shows the full version list as an ordered timeline. Users can restore an old version by making it the `currentVersionId` — this creates a new version that copies the old content (it does not destroy intermediate versions).

### Project tools (via `projects` capability group)

| Tool                  | Description                                                |
| --------------------- | ---------------------------------------------------------- |
| `create_project`      | Create a new project and set it as session scope           |
| `open_artifact`       | Load an artifact into session scope as `currentArtifactId` |
| `save_artifact`       | Save the current edit as a new version                     |
| `list_artifacts`      | List all artifacts in the current project                  |
| `get_version`         | Retrieve a specific version's content                      |
| `get_version_history` | List version summary for an artifact                       |

### Project UI

`/projects` — grid of all projects.
`/projects/[slug]` — artifact list with name, content type, version count, last edited.
`/projects/[slug]/[artifact-slug]` — artifact viewer and editor with version timeline sidebar.

### Memory integration

Memory drawers can reference specific artifact versions. A memory entry like "User prefers v3 layout of the assembly guide" includes a pointer to `artifactVersions.id = v3`. This grounds the memory in a concrete, retrievable artifact rather than a vague description.

The memory domain reads `artifactVersions` but does not write to it. Projects and memory are separate domains with a one-way reference link.

### Artifact SSE streaming

When an agent is producing or editing an artifact, the content streams into the chat UI in real time via SSE. The final streamed content is committed as a new `artifactVersions` row at the end of the run round. Partial content during streaming is held in `runs.streamBlocks`, not in `artifactVersions`.

## Behavior Contracts

- `artifacts.slug` is unique within a project. Duplicate slugs in the same project are rejected.
- `artifactVersions.seq` values within an artifact are gapless integers starting at 1.
- `artifactVersions` rows are never deleted or updated after insertion. The full history is always recoverable.
- `artifacts.currentVersionId` always points to the most recently saved version. It can be updated to restore an old version (which internally creates a new version with copied content).
- An artifact with `isActive = false` is not visible in `list_artifacts` but its versions are retained for audit.
- A project cannot be deleted if it has active artifacts. Artifacts must be soft-deleted first.

## Roles & Permissions

| Action                      | Who can do it                               |
| --------------------------- | ------------------------------------------- |
| Create a project            | Authenticated user                          |
| Create or edit an artifact  | Owner user, agent with project scope, admin |
| View artifact versions      | Owner user, admin                           |
| Restore an old version      | Owner user, admin                           |
| Delete (soft) an artifact   | Owner user, admin                           |
| Share a project             | Owner user (with resource ACL)              |
| View another user's project | Admin only, or via ACL grant                |

## References

- [Artifacts — Anthropic Claude](https://www.anthropic.com/news/artifacts) — first-class artifact model in Claude
- [Harness Design for Long-Running Apps — Anthropic](https://www.anthropic.com/engineering/harness-design-long-running-apps) — durable artifacts as sprint deliverables
- [Spec Kit — GitHub](https://github.com/github/spec-kit) — versioned structured artifacts
- **Internal:** `src/lib/projects/projects.schema.ts`, `src/lib/projects/projects.server.ts`, `src/routes/projects/`
