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

### CI watch (issue #20)

Opening a pull request is not the end of the job. Once a PR is recorded, AgentStudio keeps
an eye on its continuous-integration checks, tells the operator when one goes red, and
offers to hand the failure straight back to the agent that wrote the code.

**How a check is observed.** There are two triggers and they share all of their logic:

| Trigger     | When it applies                             | Cost                                 |
| ----------- | ------------------------------------------- | ------------------------------------ |
| Webhook     | A `check_run` delivery arrives at `/api/webhooks/github` | Free and immediate. Preferred. |
| Polling     | Every few minutes, for every watched PR     | 2–3 GitHub API calls per PR per poll |

Polling is the fallback for installations with no webhook configured. Both paths write the
same `pull_request_checks` row through the same idempotent upsert, so a PR covered by both
is reconciled twice and recorded once.

**What gets watched.** A pull request is watched when all of the following hold. There is no
separate watch record — watchability is derived from the PR row itself, so nothing has to
remember to stop.

| Condition                       | Why                                                      |
| ------------------------------- | -------------------------------------------------------- |
| Status is `open` or `draft`     | A merged or closed PR is done; the watch retires with it. |
| The repository is a GitHub repo | Other providers have no checks integration yet.           |
| The PR was opened under 14 days ago | An abandoned PR is not a standing API bill.           |
| The repo owner has an active GitHub connection | Polling needs a token.                    |

**When the operator hears about it.** A failing check opens a `pull_request_checks_failed`
review item plus a notification, but only on the transition into failure for a given commit.
A check that stays red is observed quietly on every subsequent poll; one that flaps red →
green → red on the same commit produces one further row, not one per poll. A failure on a
*new* commit is treated as new news and gets its own row, because the author pushed
something and it still broke.

The review item carries the failing check name, the commit, a link to the provider's check
page, the check's own summary, and a tail of the job log where one is available.

**Redaction.** Every piece of CI-authored text on this path is scrubbed before it is stored
or displayed — the log tail, the check's summary, the check's *title* (which becomes the
inbox headline and is therefore the most visible spot of all), the provider link, the
notification body, and the prompt seeded into the fix run. The scrub is idempotent, so it
is applied at each hop rather than trusted to have happened upstream.

| Shape                                              | Result                                    |
| -------------------------------------------------- | ----------------------------------------- |
| `ghp_` / `gho_` / `ghs_` / `github_pat_` tokens     | replaced wholesale                        |
| `Authorization: Bearer …`                           | value replaced                            |
| `SOMETHING_SECRET=…`, `api_key=…`, `password=…`     | value replaced                            |
| `scheme://user:password@host` (any scheme)          | password replaced; scheme, user, host kept |
| AWS access key ids (`AKIA…` / `ASIA…`)              | replaced wholesale                        |

The connection-string case is the one that matters most here. A failing migration or
test-setup step echoing `DATABASE_URL` is the single most likely way a live credential
reaches the review inbox through this feature, and a password inside a URL is invisible to
every `key=value` pattern. Only the password component is removed — the scheme, user and
host stay, because "cannot reach postgres as derek at 192.168.0.2" is the actual
information in that log line and an excerpt that destroyed it would be useless for the
thing it exists to explain.

Redaction is bounded in the other direction too: ordinary build output must survive intact.
An excerpt that eats the assertion message is worse than no excerpt, because it looks like
it worked. `tests/source-control.pr-checks.spec.ts` pins both directions — the credential
shapes above, and a set of innocent shapes (test failures, stack traces, `ECONNREFUSED`,
registry URLs, tsc diagnostics) that must come back byte-identical. Any future tightening
has to keep that guard green.

**Fixing it.** The review item renders a "Fix it" button. Pressing it queues a `pr_fix` job
that seeds the failure into the conversation the pull request came from — `pull_requests.runId`
points at the originating run, which points at the conversation — so the agent picks the
problem up with the branch, the plan and the reasoning it already had, rather than starting
cold. If that conversation is gone, a new one is opened instead.

Each failure gets exactly one fix run: pressing the button again on the same review item
hands back the first run rather than starting another. So the button checks that the pull
request belongs to the person pressing it *before* anything is queued — otherwise a press
that was always going to be refused would use up the item's one run. And the message after
a press says what really happened: a run was queued, an earlier run already finished (its
reply is in the conversation), or an earlier run already failed (Settings → Jobs has why).

This is deliberately a button and not an automatic response. Much of red CI is a flake, an
outage, or a failure that was already on the base branch, and none of those are worth
spending an agent run on unasked. The seeded prompt tells the agent to diagnose before
editing and to stop and say so if the failure is unrelated to the branch. The fix run also
cannot push or re-open the PR itself: `push_branch` and `create_pull_request` refuse to run
outside an interactive chat run, so the last step stays a human's.

**Job types.** `pr_watch_dispatch` (scheduled tick, one indexed query), `pr_watch` (poll one
PR), `pr_fix` (run the seeded fix). All three are ordinary durable jobs, so leases,
heartbeats, retries and forensics in `/settings/jobs` come for free.

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
- CI watching stops the moment a pull request merges or closes, and in any case within 14 days of the PR being opened.
- A failing check notifies once per (pull request, check, commit). Re-observing the same failure is silent.
- Every CI-authored string — log excerpt, check summary, check title, details URL, notification body, seeded prompt — is redacted before storage or display. Redaction is idempotent and applied at each hop rather than trusted upstream.
- Redaction covers credentials embedded in connection strings (`scheme://user:password@host`), not only `key=value` shapes, and keeps the scheme, user and host so the line stays diagnosable.
- Redaction must not touch ordinary build output. A spec pins innocent log shapes as byte-identical; tightening a pattern without keeping that green is a regression.
- A fix run is started by a human pressing "Fix it", never automatically by a red check.
- "Fix it" is refused, and queues nothing, unless the pull request's repository belongs to the person pressing it (repositories from before per-user ownership have no owner and stay fixable). The job checks ownership again when it runs.
- The GitHub connect link can say where to land afterwards (`?return=`), but only a path on this site is accepted. A full URL, a `//host` shorthand or anything that normalises to one sends the user to `/projects` instead. The value is checked again when GitHub sends the user back, because it travels in a cookie the browser controls.

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
