# Projects

## Overview

Projects are durable containers for the work a user produces with their agents. A project is a name, a kind, and — for most projects — a real working directory on disk that the agent reads from and writes to. Think of it as an organizing layer on top of conversation transcripts: chats are about figuring things out, projects are where the resulting files live.

Projects are user-scoped (each user sees only their own), are browsed from the `/projects` page, and can be created or listed by agents via `list_projects` / `create_project`. A conversation can be *bound* to a project with `set_project_context`, which puts the project into the agent's system prompt so it knows where to work by default.

> **Historical note.** Projects used to also own **artifacts** — named documents stored as database rows with append-only version history, edited through a dedicated UI and five agent tools. That layer was removed: the agent writes real files into the project's working directory, and git is the version history. Nothing reads the old `artifacts` / `artifact_versions` tables any more and migration `0063_drop_artifacts.sql` drops them.

## Key concepts

| Concept    | What it represents                                                       | Example                                        |
| ---------- | ------------------------------------------------------------------------ | ---------------------------------------------- |
| Project    | A container — a bucket for related work, usually with a repo on disk      | "Efoil rebuild", "Tax research", "Blog drafts" |
| Repo kind  | Whether the project has a filesystem footprint and where it came from     | `none`, `local`, `imported`                    |
| Repository | Sidecar row for an imported project: provider, owner, name, clone URL     | `github / derekhearst / AgentStudio`           |

### Repo kinds

Every project carries a `repo_kind`:

- **none** — database row only, no directory on disk. Useful as a label/grouping; the agent has nowhere project-specific to write.
- **local** — `git init`'d at the project's sandbox path (`<SANDBOX_WORKSPACE>/<userId>/projects/<projectId>`) with a README and an initial commit. No remote.
- **imported** — cloned from a remote (GitHub or any plain clone URL) into the same sandbox path, paired with a `repositories` sidecar row remembering where it came from.

Filesystem work happens *after* the database insert commits. If the `git init` or clone fails, the project row is deleted again and the directory cleaned up — a failed import leaves nothing behind.

### Project kinds

Projects are tagged with a kind for filtering and convention:

- **efoil** — hardware tinkering / project notes
- **research** — investigation, source-gathering, analysis
- **code** — code drafts, architecture sketches
- **documentation** — user-facing docs, README content
- **other** — anything else

Kinds don't change behavior; they make the project list easier to scan and let future automations target by kind.

### Slugs

Project names are auto-converted to URL-safe slugs (lowercase, dashes, no special characters). A slug is unique per user, so two users can both have a `notes` project. Collisions append `-2`, `-3` and so on. Once created, a project's slug doesn't change even if the name does, so links stay valid.

## User flows

### Create a project

1. Open `/projects` and click **+ New project**.
2. Give it a name and a kind, then pick how it should exist on disk:
   - no repo (database row only),
   - a new local repo, or
   - an import from the connected GitHub account or a clone URL.
3. On save the project appears in the list. Imported projects clone in the background; a failed clone rolls the whole thing back.

### Work in a project

1. Open the project. The detail page shows the repo view: branch, status, and the file tree for projects that have one. Projects with `repo_kind = none` show an empty state instead.
2. In chat, bind the conversation to the project (or let the agent call `set_project_context`). From then on the agent's system prompt names the project, and it writes files into that working directory rather than anywhere else.
3. History and diffs come from git — `git_status`, `git_log`, `git_diff`, `prepare_commit`, and, with explicit operator approval, `push_branch` and `create_pull_request`.

### Trust a project's own configuration

A repository can carry configuration for the agent: `CLAUDE.md` instructions, `.claude/` commands and skills, and a `.claude/settings.json` that can grant permissions and run hooks. None of it is loaded until the operator marks the project **trusted** on its detail page.

1. Review the repository's `.claude/` folder and `CLAUDE.md`.
2. Turn trust on. From the next turn, chats bound to the project load that configuration.
3. Turn it off at any time; the next turn runs isolated again.

Trust only applies when the chat is actually working in the project's own folder. An agent configured with its own persistent or worktree folder does not pick up the project's configuration.

Once trusted, the agent cannot quietly rewrite what was reviewed: changing `.claude/settings.json`, the `.claude/` hooks, commands, agents or skills, `.mcp.json`, or `CLAUDE.md` always shows an approval card first.

### Delete a project

Delete from the `/projects` list. Deleting removes the database row, and for `local` / `imported` projects the sandbox directory with it. There is no soft delete for projects.

## Roles & permissions

- **All authenticated users** — see and manage their own projects; nothing is shared cross-user.
- **Agents** — read and write only projects belonging to the conversation's owning user. Cross-user access is rejected at the tool boundary.
- **Admins** — same as users for their own projects; no special cross-user access, because projects are private by design.

## Agent tools

- `list_projects` — browse the user's projects to find context.
- `create_project` — start a new project (slug auto-generated and deduped per user).
- `set_project_context` — bind or unbind the current conversation's project.
- `clone_repository` — ad-hoc clone of a connected repo outside any project (legacy layout; prefer importing a project).

Everything else the agent does inside a project goes through the ordinary filesystem, search and git tools.

## Integrations

- **Chat domain** — the bound project is injected as a system-prompt context slot, so the agent has continuous awareness of which project is in scope.
- **Source control domain** — imported projects own a `repositories` sidecar row; pull requests opened by the agent are recorded against it and surface in `/review`.
- **Cost domain** — tool usage inside a run is attributed to that run, so project work rolls up alongside chat token cost.

## Business rules

- **Per-user isolation** — every project carries a `user_id` FK with cascade-on-user-delete. Agents enforce ownership at the tool boundary; the database enforces it via the FK.
- **Filesystem after commit** — repo creation never happens inside the database transaction. A failure compensates by deleting the row and the directory.
- **Imports need a source** — `repoMode: 'imported'` without a `source` is rejected outright rather than leaving a half-made project.
- **Slug stability** — a project's slug is fixed at creation.
- **Trust is opt-in** — a cloned repository's own agent configuration never loads until the operator trusts the project, and changes the agent makes to that configuration always need approval.

## Edge cases

- **Legacy `none` projects** — projects created before repos existed have no directory. They still list and bind fine; the agent simply has no project-local place to write.
- **Clone timeouts** — a large import can take tens of seconds. The row is inserted first and rolled back on failure, so a timeout shows as "project disappeared" rather than a half-cloned directory.
- **Deleting a user** — cascades through their projects. Sandbox directories are removed by the project delete path, not by the database.

## Data model summary

```
projects (
  id, name, slug, description, kind,
  user_id (FK → users CASCADE),
  repo_kind ('none' | 'local' | 'imported'),
  repo_local_path, default_branch,
  last_pulled_at, last_imported_at,
  created_at, updated_at
)
```

Imported projects additionally have a row in `repositories` (source-control domain) carrying provider, owner, name and clone URL.
