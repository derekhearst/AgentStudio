# Source Control & Pull Requests Spec

## Overview

The source control domain makes repositories, branches, commits, and pull requests first-class objects in AgentStudio. It is the bridge between isolated coding workspaces and real software delivery. Agents can attach a repository, create a task-scoped branch, make commits inside an isolated worktree, push the branch to a configured provider, and open a draft or ready-for-review pull request for the user to approve.

This domain exists so AgentStudio can own the full loop for coding work: chat request -> plan approval -> repo checkout -> implementation -> evaluation -> pull request creation -> human review. It turns "optional git behavior inside a workspace" into a durable, reviewable product surface.

## Data Model

### `repositories` table

| Column          | Type      | Notes                             |
| --------------- | --------- | --------------------------------- |
| `id`            | uuid      | Primary key                       |
| `userId`        | uuid      | FK to `users` - owner             |
| `provider`      | enum      | `github`, `gitlab`, `generic_git` |
| `name`          | text      | Display name                      |
| `remoteUrl`     | text      | Canonical clone URL               |
| `defaultBranch` | text      | Usually `main` or `master`        |
| `connectionId`  | uuid?     | FK to `repositoryConnections`     |
| `projectId`     | uuid?     | Optional FK to `projects`         |
| `createdAt`     | timestamp |                                   |
| `updatedAt`     | timestamp |                                   |

### `repositoryConnections` table

| Column         | Type      | Notes                                        |
| -------------- | --------- | -------------------------------------------- |
| `id`           | uuid      | Primary key                                  |
| `userId`       | uuid      | FK to `users` - owner                        |
| `provider`     | enum      | `github`, `gitlab`                           |
| `authMode`     | enum      | `github_app`, `oauth`, `pat`                 |
| `accountLabel` | text      | Human-readable account or installation label |
| `scopes`       | jsonb     | Granted scopes summary                       |
| `status`       | enum      | `active`, `revoked`, `error`                 |
| `createdAt`    | timestamp |                                              |
| `updatedAt`    | timestamp |                                              |

### `repositoryBranches` table

| Column         | Type      | Notes                                     |
| -------------- | --------- | ----------------------------------------- |
| `id`           | uuid      | Primary key                               |
| `repositoryId` | uuid      | FK to `repositories`                      |
| `taskId`       | uuid?     | FK to `tasks`                             |
| `runId`        | uuid?     | FK to `runs`                              |
| `name`         | text      | Generated branch name                     |
| `baseBranch`   | text      | Source branch                             |
| `status`       | enum      | `active`, `pushed`, `merged`, `abandoned` |
| `createdAt`    | timestamp |                                           |
| `updatedAt`    | timestamp |                                           |

### `pullRequests` table

| Column             | Type      | Notes                               |
| ------------------ | --------- | ----------------------------------- |
| `id`               | uuid      | Primary key                         |
| `repositoryId`     | uuid      | FK to `repositories`                |
| `branchId`         | uuid      | FK to `repositoryBranches`          |
| `taskId`           | uuid?     | FK to `tasks`                       |
| `runId`            | uuid?     | FK to `runs`                        |
| `providerPrId`     | text      | Provider-side identifier            |
| `number`           | integer?  | PR number if available              |
| `title`            | text      | Pull request title                  |
| `body`             | text      | Markdown body                       |
| `baseBranch`       | text      | Target branch                       |
| `headBranch`       | text      | Source branch                       |
| `status`           | enum      | `draft`, `open`, `merged`, `closed` |
| `url`              | text      | Canonical provider URL              |
| `createdByAgentId` | uuid?     | FK to `agents`                      |
| `createdAt`        | timestamp |                                     |
| `updatedAt`        | timestamp |                                     |

### `pullRequestChecks` table

| Column            | Type      | Notes                                                |
| ----------------- | --------- | ---------------------------------------------------- |
| `id`              | uuid      | Primary key                                          |
| `pullRequestId`   | uuid      | FK to `pullRequests`                                 |
| `providerCheckId` | text?     | Provider-side identifier                             |
| `name`            | text      | Check name                                           |
| `status`          | enum      | `pending`, `running`, `passed`, `failed`, `canceled` |
| `summary`         | text?     | Short human-readable summary                         |
| `detailsUrl`      | text?     | Provider details page                                |
| `createdAt`       | timestamp |                                                      |
| `updatedAt`       | timestamp |                                                      |

## Features

### Repository attachment

A user can connect a repository to AgentStudio in two ways:

1. Import an external repo by URL and provider credentials.
2. Promote an existing code project into a repo-backed project.

Attached repositories become selectable from chat, task creation, automation creation, and project settings.

### Task-scoped worktree branches

When a code task runs against a repo-backed environment, the workspace domain creates a worktree from the repository's default branch and checks out a generated task branch.

Branch naming rules:

- Root task first attempt: `agent/<taskId>`
- Retry attempt: `agent/<taskId>/<attemptNumber>`
- Detached experiment or non-task run: `agent/run/<runId>`

The agent cannot choose arbitrary branch names.

### Commit drafting

Agents do not push raw dirty workspaces. Before push, the system computes a commit draft:

- Changed files list
- Generated commit title
- Generated commit body
- Diff summary
- Evaluation findings, if any
- Verification summary

The user can approve the commit draft from chat or review UI.

### Push and pull request creation

After approval, AgentStudio can:

1. Push the branch
2. Create a draft pull request
3. Attach task spec, approved plan summary, evaluation verdict, and testing summary to the pull request body

Pull request bodies include:

- Problem statement
- Approved plan summary
- Implementation summary
- Validation summary
- Reviewer notes and known risks

### Pull request status sync

AgentStudio synchronizes provider state back into its own DB:

- `draft`, `open`, `merged`, `closed`
- Latest CI status
- Reviewer comments count
- Merge conflict state
- Whether the branch is behind base

### Pull request review handoff

A pull request becomes a reviewable artifact in AgentStudio:

- Visible from chat
- Visible from the Review Inbox when human action is needed
- Linked to the originating task and run
- Can be sent back to the coding agent with feedback

### Repository import flow

The initial repo onboarding flow supports:

- Validate provider credentials
- Validate clone access
- Read repository metadata (default branch, provider slug)
- Optionally clone a persistent local mirror used for future worktrees

### Git-aware tools

A new `source_control` capability group exposes:

- `list_repositories`
- `attach_repository`
- `prepare_commit`
- `git_status`
- `push_branch`
- `create_pull_request`
- `list_pull_requests`
- `get_pull_request`

These tools are not always on. They are enabled only for repo-backed coding and review workflows.

## Behavior Contracts

- A push never happens without a repository connection that explicitly grants write access.
- A pull request is always associated with a task or run. Orphan PRs are not created.
- Branch names are runtime-generated and deterministic; agents cannot select arbitrary names.
- Draft pull request is the default. Moving to ready-for-review requires an explicit user or policy action.
- Merge is not implied by pull request creation. Merge is a separate approval action.
- Provider sync is eventually consistent; AgentStudio state may lag briefly but must reconcile automatically.
- A repository connection in `error` or `revoked` state blocks all write operations.
- Push, pull request creation, and merge are policy-evaluable actions and can require approval.

## Roles & Permissions

| Action                                    | Who can do it                                 |
| ----------------------------------------- | --------------------------------------------- |
| Connect a repository                      | Owner user, admin                             |
| Attach repository to project              | Owner user, admin                             |
| Create branch and worktree                | Runtime (system)                              |
| Push branch                               | Agent with policy approval, owner user, admin |
| Open pull request                         | Agent with policy approval, owner user, admin |
| Merge pull request                        | Owner user, admin                             |
| View another user's repository connection | Admin only                                    |

## Rewrite Authority

The current implementation is a baseline, not a constraint. This domain may be rewritten, restyled, reorganized, or replaced as needed to achieve the target product quality. No code path is off-limits if behavior contracts, safety controls, tests, and documentation remain correct.

## UI Contract

This domain follows [../ui/spec.md](../ui/spec.md) and defines branch/PR workflows.

- Surfaces: branch status panel, commit timeline, PR creation/review views, and merge readiness checks.
- States and badges: clean, dirty, conflicted, rebasing, review-requested, approved, and merge-blocked.
- Blocking actions: push, force-push, merge, and conflict resolution decisions must use explicit approval UI.
- Mobile behavior: PR and conflict details render as focused drill-down views with sticky resolve actions.

## References
- [../workspace/spec.md](../workspace/spec.md) - worktree environments
- [../tasks/spec.md](../tasks/spec.md) - task approval and attempts
- [../policies/spec.md](../policies/spec.md) - push and merge permissions
- [../observability/spec.md](../observability/spec.md) - review inbox and operational visibility
- [Symphony - OpenAI](https://github.com/openai/symphony) - issue to branch to PR workflow
- [Vibe Kanban - BloopAI](https://github.com/BloopAI/vibe-kanban) - worktree-per-task execution

