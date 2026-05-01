# Policies Spec

## Overview

The policies domain is AgentStudio's unified permission and governance system. It replaces scattered booleans and ad hoc approval checks with a structured rule engine. Policies define what actors can do, to what resources, under what conditions — and they emit audit decisions for every consequential action. Resource ACLs control who can read or write specific projects, artifacts, and memory wings.

## Data Model

### `policies` table

A policy is a named rule that applies to an actor scope and a resource type.

| Column             | Type      | Description                                                                                                 |
| ------------------ | --------- | ----------------------------------------------------------------------------------------------------------- |
| `id`               | uuid      | Primary key                                                                                                 |
| `scope`            | enum      | `platform`, `org`, `user`, `agent`, `session`                                                               |
| `scopeId`          | uuid?     | ID of the scope subject (user ID, agent ID, session ID); null for platform                                  |
| `name`             | text      | Human-readable name                                                                                         |
| `effect`           | enum      | `allow`, `deny`, `require_approval`                                                                         |
| `resourceType`     | enum      | `tool`, `capability_group`, `network`, `workspace`, `artifact`, `project`, `memory`, `job`, `hook`, `agent` |
| `resourceSelector` | jsonb     | Selector for matching specific resources (tool name pattern, agent slug, etc.)                              |
| `conditions`       | jsonb     | Optional conditions: time-of-day, user roles, environment flags, etc.                                       |
| `priority`         | integer   | Higher priority policies take precedence (default: 100)                                                     |
| `enabled`          | boolean   | Quick enable/disable without deleting                                                                       |
| `createdAt`        | timestamp |                                                                                                             |
| `updatedAt`        | timestamp |                                                                                                             |

### `resourcePermissions` table

Object-level access control for specific projects, artifacts, and memory wings.

| Column          | Type      | Description                          |
| --------------- | --------- | ------------------------------------ |
| `id`            | uuid      | Primary key                          |
| `resourceType`  | enum      | `project`, `artifact`, `memory_wing` |
| `resourceId`    | uuid      | ID of the specific resource          |
| `principalType` | enum      | `user`, `agent`, `org_role`          |
| `principalId`   | uuid      | ID of the user/agent/role            |
| `permission`    | enum      | `read`, `write`, `admin`, `share`    |
| `createdAt`     | timestamp |                                      |

### `policyDecisions` table

Audit log of every policy decision made at runtime.

| Column            | Type      | Description                                                     |
| ----------------- | --------- | --------------------------------------------------------------- |
| `id`              | uuid      | Primary key                                                     |
| `runId`           | uuid?     | FK to `runs`                                                    |
| `jobId`           | uuid?     | FK to `jobs`                                                    |
| `sessionId`       | uuid?     | FK to `sessions`                                                |
| `actorType`       | enum      | `user`, `agent`, `worker`                                       |
| `actorId`         | uuid?     | ID of the acting entity                                         |
| `action`          | text      | What was being attempted (e.g., `tool:shell`, `artifact:write`) |
| `resourceType`    | text      | Resource category                                               |
| `resourceId`      | text?     | Specific resource ID if applicable                              |
| `outcome`         | enum      | `allowed`, `denied`, `approval_required`                        |
| `matchedPolicyId` | uuid?     | FK to `policies` — which rule matched                           |
| `createdAt`       | timestamp |                                                                 |

## Features

### Policy layers

Policies are evaluated in this order (highest priority wins):

1. **Platform policy** — global hard rules that cannot be overridden (e.g., deny all network access in production for untrusted agents)
2. **Org/workspace policy** — workspace-wide governance rules
3. **User policy** — user-specific overrides (e.g., a power user who can use unrestricted shell)
4. **Agent policy** — constraints specific to an agent identity (e.g., evaluator agents cannot call write tools)
5. **Session policy** — temporary reductions for a live session (e.g., disable web search for this session)
6. **Resource ACL** — object-level read/write checks

A `deny` at any layer blocks the action regardless of lower-priority `allow` rules.

### Decision engine

When the runtime is about to execute a tool call or access a resource, it calls `resolvePolicy(actor, action, resource)`. The engine:

1. Loads all matching policies ordered by priority + scope depth
2. Evaluates `conditions` (time, env flags, user roles)
3. Returns the first matching `effect`: `allow`, `deny`, or `require_approval`
4. Writes a `policyDecisions` row for the decision

The decision is cached per run for the same actor+action+resource triple (cache invalidated if policies are edited).

### Tool and capability policies

Common policy use cases for tools:

- **Deny `shell` for all agents except those with `trusted_shell` flag** — platform-level deny on `tool:shell` + user-level allow for specific users
- **Require approval for `delete_file`** — platform-level `require_approval` on `tool:delete_file`
- **Restrict evaluator agents to read-only tools** — agent-level deny on write capability groups

### Network policies

The `network` resource type covers outbound HTTP and DNS from the `shell` tool and any MCP server that makes external calls. Network policies can:

- Allow all (default for trusted users)
- Restrict to an allowlist of domains (specified in `resourceSelector.domains`)
- Deny all outbound

### Resource ACLs

Projects, artifacts, and memory wings can be shared with other users or agents by granting `resourcePermissions` entries. The owner always has `admin` permission. `admin` permission allows granting access to others.

| Permission | What it allows                                                  |
| ---------- | --------------------------------------------------------------- |
| `read`     | View content (artifact versions, memory drawers)                |
| `write`    | Edit content (create new artifact versions, add memory drawers) |
| `admin`    | All of the above + share with others + soft-delete              |
| `share`    | Grant `read` or `write` to others (but not `admin` or `share`)  |

### Approval flow integration

When a policy returns `require_approval`, the runtime suspends the tool call and creates a review item in the observability inbox. The approval flow is the same as tool-level approvals (see runs spec) — the job blocks until resolved.

### Policy admin UI

`/settings/policies` — list and edit all platform and org policies. Create new policies with a visual rule builder: scope, resource type, selector, effect, conditions.
`/settings/policies/decisions` — audit log of recent policy decisions, filterable by actor, resource, outcome.

## Behavior Contracts

- A `deny` outcome from any policy layer is final and cannot be overridden by lower-priority layers.
- Platform policies are managed only via admin access. User-level policy edits cannot override them.
- `policyDecisions` rows are append-only. The audit log is never modified.
- A missing policy (no matching rule) defaults to `allow` for users and agents with standard access. Platform defaults can be changed by admins.
- Session policies can only reduce permissions relative to the parent scopes — they cannot grant new permissions not already present at the user or agent level.
- Evaluator agents always run under a deny-all policy for write tool categories. This is enforced by the runtime, not only by policy configuration.

## Roles & Permissions

| Action                           | Who can do it         |
| -------------------------------- | --------------------- |
| View platform policies           | Admin only            |
| Create/edit platform policies    | Admin only            |
| Create/edit user-level policies  | Owner user, admin     |
| Create/edit agent-level policies | Owner user, admin     |
| View policy decision log         | Admin only            |
| Grant resource ACLs              | Resource owner, admin |
| Revoke resource ACLs             | Resource owner, admin |

## References

- [Scion — Google Cloud](https://github.com/GoogleCloudPlatform/scion) — per-agent credential + access model
- [Composio Agent Orchestrator](https://github.com/ComposioHQ/agent-orchestrator) — structured permission surface for agents
- [Building Effective Agents — Anthropic](https://www.anthropic.com/research/building-effective-agents) — mechanical safety controls
- [OWASP LLM Top 10](https://owasp.org/www-project-top-10-for-large-language-model-applications/) — injection, excessive agency, insecure output handling
- **Internal:** `src/lib/policies/policies.schema.ts`, `src/lib/policies/engine.server.ts`, `src/routes/settings/policies/`
