# Source Control Plan

Status: active

## Overview

The workspace spec already allows worktree-mode execution, but the product does not yet model repositories, provider connections, pushes, or pull requests as durable first-class records. This plan adds a `source-control` domain so coding agents can operate on real repositories and create pull requests that users approve from inside AgentStudio.

> **Depends on:** `docs/workspace/plan.md` (worktree mode), `docs/tasks/plan.md` (plan approval), `docs/policies/plan.md` (push and merge permissions), `docs/observability/plan.md` (review handoff).

> **See also:** [spec.md](spec.md) - full feature spec, data model, and behavior contracts.

## Why this matters

Without a source control domain, agent coding ends at modified files in an isolated workspace. Your target product requires AgentStudio to own the delivery boundary: repository attachment, branch creation, commit drafting, push, pull request creation, and reviewer handoff.

## Current state

- Worktree mode exists in the workspace plan and spec.
- There is no repository connection model.
- There is no provider auth model.
- There are no push or pull request tools.
- There are no pull request records in the DB.
- There is no chat-native pull request review surface.

## Desired state

- Repositories and provider connections are durable records.
- Coding tasks can target a repository directly.
- The runtime can provision worktrees from a real remote.
- Push and pull request creation are approval-gated actions.
- Pull requests are linked to tasks, runs, review items, and evaluations.

## Phases

### Phase 1 - Repository records and provider connections

**Goal:** Store repository metadata and provider auth state.

**Files to create:**

- `src/lib/source-control/source-control.schema.ts` - `repositories`, `repositoryConnections`, `repositoryBranches`, `pullRequests`, `pullRequestChecks`
- `src/lib/source-control/source-control.server.ts` - CRUD helpers and provider adapters
- `src/lib/source-control/index.ts` - barrel
- `drizzle/NNNN_source_control.sql` - migration

**Files to modify:**

- `src/lib/db.server.ts` - register schema
- `src/routes/projects/` - allow repo attachment to a project

**Verification:**

- User can add a repository record with a valid provider connection.
- A revoked or invalid connection is stored as `status = 'error'` or `status = 'revoked'`.

---

### Phase 2 - Repo-backed workspace provisioning

**Goal:** Make worktree execution resolve against attached repositories.

**Files to modify:**

- `src/lib/workspace/worktree.server.ts` - clone or reuse local mirror, create worktree, check out generated branch
- `src/lib/runtime/environment.server.ts` - inject repo-backed workspace into environment when task or session is linked to a repository
- `src/lib/tasks/tasks.server.ts` - allow tasks to carry `repositoryId` in metadata or explicit column

**Behavior:**

- For repo-backed tasks, the workspace layer creates `agent/<taskId>` on first attempt and `agent/<taskId>/<attemptNumber>` on retry.
- The workspace record links to both the run and repository context.

**Verification:**

- Starting a repo-backed task creates a worktree against the configured default branch.
- Retry attempt creates a second branch instead of mutating the first.

---

### Phase 3 - Git-aware tools and commit draft flow

**Goal:** Give the orchestrator and coding worker a safe, typed source-control tool surface.

**Files to modify:**

- `src/lib/tools/tools.ts` - add `source_control` capability group
- `src/lib/tools/tools.server.ts` - implement:
  - `list_repositories`
  - `attach_repository`
  - `git_status`
  - `prepare_commit`
  - `push_branch`
  - `create_pull_request`
  - `list_pull_requests`
  - `get_pull_request`
- `src/lib/skills/` - add companion skill `tools/source-control`

**Commit draft flow:**

1. Agent finishes code changes
2. Agent calls `prepare_commit`
3. Runtime computes changed files, summary, evaluation notes, and verification notes
4. User approves or revises commit draft
5. Only then may `push_branch` or `create_pull_request` proceed

**Verification:**

- `prepare_commit` returns structured summary for a dirty worktree.
- `push_branch` is blocked by policy unless approved.

---

### Phase 4 - Pull request creation and review handoff

**Goal:** Create pull requests and surface them in AgentStudio review flows.

**Files to modify:**

- `src/lib/source-control/source-control.server.ts` - provider calls for draft pull request creation and status sync
- `src/lib/observability/review.server.ts` - create review items for pull-request-ready or failed-check cases
- Chat workbench route - render pull request cards and review actions

**Pull request body template:**

- Problem statement
- Approved plan
- Implementation summary
- Validation summary
- Evaluation verdict
- Known risks

**Verification:**

- Draft pull request can be created after push.
- Pull request row is linked to originating task and run.
- Review item appears when user attention is required.

---

### Phase 5 - Provider sync and merge state reconciliation

**Goal:** Keep AgentStudio in sync with provider status.

**Files to modify:**

- `src/lib/source-control/provider-sync.server.ts` - poll or webhook reconciliation
- `src/lib/jobs/handlers/` - background sync jobs

**Sync responsibilities:**

- Pull request open or closed state
- CI checks
- Merge conflict state
- Behind-base detection

**Verification:**

- Closing or merging a pull request on GitHub updates AgentStudio state.
- Failed CI check is reflected in `pullRequestChecks` and review UI.

## Verification

1. Import a repository and attach it to a project.
2. Approve a coding task against that repository.
3. Confirm a worktree branch is created.
4. Confirm push requires approval.
5. Confirm draft pull request is created and linked to the task.
6. Confirm the pull request appears in chat and review inbox.

## Completion

- Template: YYYY-MM-DD - Completed in <PR/commit> - <one-line outcome>
- Pending.


