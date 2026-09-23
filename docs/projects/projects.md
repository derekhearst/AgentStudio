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

- **none** — no repository. The project still gets a directory the first time something is written for it: a knowledge file, or a file an agent writes during a chat bound to the project.
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
2. Pick a tab for how it should exist on disk:
   - **Empty** — no repository,
   - **Local repo** — a new local repository,
   - **From GitHub** or **From URL** — an import from the connected GitHub account or a clone URL.
3. Give it a name and a kind. Switching tabs keeps what you have typed. (The form used to reset on every tab change and jump back to **Empty**, so only empty projects could be created.)
4. On save the project appears in the list. Imported projects clone in the background; a failed clone rolls the whole thing back.

### Add knowledge files

1. Open the project and use the knowledge panel to upload a file — a datasheet, a spec, an exported thread.
2. The file is stored in the project's directory under `.agentstudio/knowledge/`, and the agent is told its name in every chat bound to the project. It reads the file with its normal file tools.
3. Remove a file from the same panel.

A project holds up to 50 knowledge files of up to 20MB each. The server itself refuses any upload larger than its `BODY_SIZE_LIMIT` setting, which the production image sets to 25MB. An upload over that limit is refused with a message that names the limit and the setting, rather than the old, misleading "Expected a multipart upload". Before the image set it, the server's default of 512KB applied, and every file over half a megabyte failed.

### Work in a project

1. Open the project. The detail page shows the repo view: branch, status, and the file tree for projects that have one. Projects with `repo_kind = none` show an empty state instead.
2. In chat, bind the conversation to the project (or let the agent call `set_project_context`). From then on the agent's system prompt names the project, and it writes files into that working directory rather than anywhere else.
3. History and diffs come from git — `git_status`, `git_log`, `git_diff`, `prepare_commit`, and, with explicit operator approval, `push_branch` and `create_pull_request`.

### Pull and push from the Repo tab

1. **Pull latest** fetches every branch from the remote and fast-forwards the checked-out branch when it is behind. If it cannot move the branch without losing something — local commits the remote does not have, edits the update would overwrite — it leaves the branch alone and the message under the buttons says why. The remote's branches are recorded either way.
2. **Push** sends a branch to GitHub under the same name. The **--force-with-lease** box replaces the branch on GitHub only if nobody else has pushed to it since AgentStudio last pulled or pushed it; if someone has, the push is refused with a hint saying why. This works for a local project with no GitHub `origin` too: AgentStudio keeps its own record of what it last pushed where. A branch AgentStudio has never pulled or pushed is never force-pushed over.
3. **Commit** uses the repository's own name and email, or `AgentStudio <agentstudio@local>` when the repository has none — the server's own git settings are never used.

All of this runs through the same hardened git runner as the agent's tools, so settings the agent writes into the project's `.git` folder (or a submodule's) that would run a program are switched off rather than obeyed. Settings that would send the GitHub token elsewhere make pull and push refuse to run. When the runner cannot read the settings in full, it refuses the command rather than run it unprotected; the Repo tab then shows no status for the project until the settings are fixed. See [Running git safely](../source-control/spec.md#running-git-safely), including the one gap that remains.

### Trust a project's own configuration

A repository can carry configuration for the agent: `CLAUDE.md` instructions, `.claude/` commands and skills, and a `.claude/settings.json` that can grant permissions and run hooks. None of it is loaded until the operator marks the project **trusted** on its detail page.

1. Review the repository's `.claude/` folder and `CLAUDE.md`.
2. Turn trust on. From the next turn, chats bound to the project load that configuration.
3. Turn it off at any time; the next turn runs isolated again.

Trust only applies when the chat is actually working in the project's own folder. An agent configured with its own persistent or worktree folder does not pick up the project's configuration.

Once trusted, the agent cannot quietly rewrite what was reviewed. Changing `.claude/settings.json`, the `.claude/` hooks, commands, agents or skills, `.mcp.json`, or `CLAUDE.md` with a file tool always shows an approval card first. Shell commands cannot change the top-level copies of these files at all: the sandbox makes them read-only. A `CLAUDE.md` inside a subfolder is covered by the approval card only.

### Delete a project

Delete from the `/projects` list. Deleting removes the database row and the project's directory with everything in it — the repository if there is one, knowledge files, and anything the agent wrote there. This applies to every kind of project; a project with no repository used to keep its directory, and its knowledge files stayed on disk for good. There is no soft delete for projects.

The confirmation says what goes with the project, for every kind: a project with no repository warns that its files, knowledge files and anything agents wrote there will be removed, and a local or imported project adds its git repository to that list.

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
- **Git is hardened** — every git command the server runs in a project folder switches off the settings in that folder that could run a program or redirect the GitHub token. The agent can write to `.git`; the server does not trust it.
- **Trust is opt-in** — a cloned repository's own agent configuration never loads until the operator trusts the project, and changes the agent makes to that configuration always need approval.

## Edge cases

- **Legacy `none` projects** — projects created before repos existed may have no directory yet. They still list and bind fine; the directory appears when something is first written for the project.
- **Clone timeouts** — a large import can take tens of seconds. The row is inserted first and rolled back on failure, so a timeout shows as "project disappeared" rather than a half-cloned directory.
- **Deleting a user** — cascades through their projects. Sandbox directories are removed by the project delete path, not by the database.
- **A repo that links out of itself** — an imported repo can contain symbolic links, and so can anything the agent's shell creates. If the project's `.agentstudio` knowledge folder turns out to be a link to somewhere outside the project, knowledge uploads and deletes are refused and the knowledge list shows as empty. The same check stops the "keep knowledge out of git" note from being written through a linked `.git/info` folder.

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
