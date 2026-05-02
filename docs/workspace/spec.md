# Workspace Spec

## Overview

The workspace is the isolated filesystem and execution environment for a single agent run. Every run gets its own workspace directory; no two runs share a filesystem path by default. The workspace domain owns path resolution, lifecycle management (creation, TTL-based cleanup), and the plumbing that connects workspace paths to all filesystem and shell tools.

## Data Model

### `workspaces` table

| Column      | Type       | Description                                                       |
| ----------- | ---------- | ----------------------------------------------------------------- |
| `id`        | uuid       | Primary key                                                       |
| `runId`     | uuid?      | FK to `runs` (null for persistent workspaces with no active run)  |
| `userId`    | uuid       | FK to `users` — owner                                             |
| `mode`      | enum       | `ephemeral`, `persistent`, `worktree`                             |
| `key`       | text?      | Stable key for persistent workspaces (e.g., agent slug + project) |
| `path`      | text       | Absolute filesystem path                                          |
| `gitRepo`   | text?      | Git repo URL for worktree mode                                    |
| `gitBranch` | text?      | Branch name for worktree mode                                     |
| `pinned`    | boolean    | If true, GC will not delete even after TTL                        |
| `expiresAt` | timestamp? | When the ephemeral workspace will be garbage collected            |
| `createdAt` | timestamp  |                                                                   |
| `deletedAt` | timestamp? | Soft-delete timestamp set by GC                                   |

## Features

### Three workspace modes

**Ephemeral (default)** — a directory created for the run and deleted after a TTL (default: 7 days). All filesystem and shell tools operate inside this directory. When the run ends, the workspace is kept for inspection until TTL elapses. Ephemeral workspaces are isolated: two simultaneous runs for the same user cannot collide.

**Persistent** — a stable directory keyed by a combination of `userId` and a string key (e.g., `coding-agent/my-project`). Lives across runs. Useful for long-running agents that need a consistent repo checkout. Opted into via `agents.config.environment.workspaceMode = 'persistent'`.

**Worktree** — a git worktree created from a configured repo URL, checked out to a branch named after the run. On run completion, the worktree can optionally be pushed and a PR created. Matches the Vibe Kanban pattern of one worktree per agent task.

### Path resolution

All filesystem tools receive the resolved `Environment.workspaceRoot` from the runtime, not a raw user ID or username. Tools cannot construct their own paths; they only receive what the runtime injects.

Path layout:

```
${SANDBOX_WORKSPACE}/<userId>/runs/<runId>/          # ephemeral
${SANDBOX_WORKSPACE}/<userId>/persistent/<key>/      # persistent
${SANDBOX_WORKSPACE}/<userId>/worktrees/<runId>/     # worktree
```

Tools cannot traverse above the workspace root. Any path that resolves outside the root returns a `WORKSPACE_ESCAPE` error.

### Workspace creation

Created at run start by `buildEnvironment`. The runtime calls `createWorkspace(runId, userId, mode)` which:

1. Creates the directory (or git worktree)
2. Writes a `workspaces` record
3. Returns the resolved absolute path

If the workspace already exists for a persistent key, it is returned as-is.

### Garbage collection

A daily scheduled job (`workspace_gc`) scans `workspaces` where:

- `mode = 'ephemeral'`
- `pinned = false`
- `expiresAt < now()`

It removes the directory and sets `deletedAt`. GC does not touch persistent or worktree workspaces unless explicitly requested.

Admins can extend TTL or pin a workspace from the workspace inspection UI.

### Workspace inspection

Admins and run owners can browse a workspace's contents from `/runs/[id]/workspace`. This is a read-only file browser showing the files created during the run. Useful for debugging tool call results.

### Environment variables

The `Environment` descriptor can include `envVars` that are injected into the shell subprocess when the `shell` tool runs. These are scoped to the run and not inherited from the app process.

Sensitive values (API keys, secrets) should come from the policies domain's secret management, not from plaintext `envVars`. The runtime redacts known secret patterns from tool output before it enters the context window.

### Network policy

The `Environment.networkPolicy` field controls what the `shell` tool can reach:

- `open` — no restrictions (default for trusted users)
- `restricted` — only allowlisted domains/IPs (enforced at the network level, not by the tool itself)
- `none` — no outbound network (useful for pure file-processing runs)

## Behavior Contracts

- Workspace creation is idempotent for persistent workspaces: calling `createWorkspace` with the same key twice returns the same path.
- Workspace paths are never user-controlled strings. They are constructed solely from `userId`, `runId`, and `key` values from the DB.
- A file path that escapes the workspace root is rejected before the tool executes.
- GC never deletes a pinned workspace, regardless of TTL.
- Worktree branches follow the naming convention `agent/<runId>`. Branch names are not configurable by the agent.
- `envVars` are applied only to the shell subprocess, not to the app process or other tools.

## Roles & Permissions

| Action                          | Who can do it    |
| ------------------------------- | ---------------- |
| Create workspace (on run start) | Runtime (system) |
| Browse workspace contents       | Run owner, admin |
| Pin workspace                   | Run owner, admin |
| Extend workspace TTL            | Run owner, admin |
| Delete a workspace              | Admin only       |
| View another user's workspace   | Admin only       |

## Rewrite Authority

The current implementation is a baseline, not a constraint. This domain may be rewritten, restyled, reorganized, or replaced as needed to achieve the target product quality. No code path is off-limits if behavior contracts, safety controls, tests, and documentation remain correct.

## UI Contract

This domain follows the shared UX system in [../ui/spec.md](../ui/spec.md).

- Surfaces in this domain must align with the shared desktop/mobile shell patterns.
- Domain-specific states must be explicit in the UI (for example pending, running, blocked, completed) where applicable.
- Blocking user decisions must use the shared action-card and inbox patterns where applicable.

## References
- [Vibe Kanban — BloopAI](https://github.com/BloopAI/vibe-kanban) — one git worktree per agent task
- [Emdash — generalaction](https://github.com/generalaction/emdash) — isolated worktrees locally or via SSH
- [Trellis — mindfold-ai](https://github.com/mindfold-ai/trellis) — git worktree-based parallel harness
- [Scion — Google Cloud](https://github.com/GoogleCloudPlatform/scion) — container + worktree + credential isolation per agent
- [The Design of Claude Managed Agents — Anthropic](https://www.anthropic.com/engineering/managed-agents) — Environment as an independent primitive
- **Internal:** `src/lib/workspace/workspace.server.ts`, `src/lib/tools/tools.server.ts` (path injection), `src/routes/runs/[id]/workspace/`

