# Policies Plan

Status: active

## Overview

AgentStudio has approval prompts and tool allow-lists, but it does not yet have a unified policy system. As the app gains background jobs, memory, projects, artifacts, hooks, multi-agent execution, and workspace isolation, policy decisions need to move out of scattered booleans and ad hoc checks into a first-class `policies/` domain. Add durable policies for tool access, network access, workspace access, artifact edits, project membership, admin overrides, and org-level governance.

> **Depends on:** `docs/structure/plan.md` (`runtime/`, `workspace/`, `tools/`, `agents/`), `docs/projects/plan.md` (artifact/project permissions), `docs/jobs/plan.md` (worker/admin controls), `docs/tools/plan.md` (capability groups).

> **See also:** [spec.md](spec.md) — full feature spec, data model, and behavior contracts.

## Why this matters

- **Approvals are not policy.** Approval is a UX step; policy is the rule system behind it.
- **Agent apps need governance.** Once artifacts, jobs, and memory exist, unrestricted access becomes a product risk.
- **Security should be mechanical.** The runtime should resolve capabilities from policy, not from prompt discipline.

## Current state in AgentStudio

- Tool approval exists, but rules are distributed across runtime/tools/settings.
- Workspace isolation plans mention network policy, but there is no separate policy model.
- Memory queries are user-scoped, but there is no generalized access model for projects/artifacts.
- No admin console for reviewing or overriding policy outcomes.

## Target design

### Policy layers

1. **Platform policy** — global defaults and hard denies.
2. **Organization policy** — workspace/team-wide governance.
3. **User policy** — user-specific overrides.
4. **Agent policy** — constraints for a specific agent identity.
5. **Session policy** — temporary scope reductions for a live session.
6. **Resource ACLs** — artifact/project/memory object access rules.

### Core tables

```ts
// src/lib/policies/policies.schema.ts
policies: {
  id: uuid primary key,
  scope: enum('platform', 'org', 'user', 'agent', 'session'),
  scopeId: uuid | null,
  name: text,
  effect: enum('allow', 'deny', 'require_approval'),
  resourceType: enum(
    'tool',
    'capability_group',
    'network',
    'workspace',
    'artifact',
    'project',
    'memory',
    'job',
    'hook',
    'agent'
  ),
  resourceSelector: jsonb,
  conditions: jsonb,
  priority: int default 100,
  enabled: boolean default true,
  createdAt, updatedAt
}

resourcePermissions: {
  id: uuid primary key,
  resourceType: enum('project', 'artifact', 'memory_wing'),
  resourceId: uuid,
  principalType: enum('user', 'agent', 'org_role'),
  principalId: uuid,
  permission: enum('read', 'write', 'admin', 'share'),
  createdAt
}

policyDecisions: {
  id: uuid primary key,
  runId: uuid | null,
  jobId: uuid | null,
  sessionId: uuid | null,
  actorType: enum('user', 'agent', 'worker'),
  actorId: uuid | null,
  action: text,
  resourceType: text,
  resourceId: text | null,
  decision: enum('allow', 'deny', 'require_approval'),
  matchedPolicyIds: uuid[],
  reason: text | null,
  createdAt
}
```

### Decision engine

A single resolver evaluates policy in this order:
1. hard deny
2. explicit resource ACL deny
3. explicit allow
4. approval requirement
5. fallback default deny for sensitive resources
6. fallback default allow for safe reads where configured

### Policy surfaces

- **Tools**: who can call what, under what approval mode.
- **Capability groups**: who can enable `sandbox`, `browser`, `shell`, etc.
- **Network**: open, restricted domains, or none.
- **Workspace**: ephemeral only, persistent allowed, worktree allowed.
- **Projects/artifacts**: who can read/edit/delete/share.
- **Memory**: who can recall or delete a memory wing/drawer.
- **Jobs**: who can enqueue, retry, cancel, inspect.
- **Hooks**: which hooks may run inline vs queued vs disabled.

## Integration with existing plans

- **Runtime** resolves tool and network permissions from policy engine before each action.
- **Tools** use policy decisions instead of hardcoded allow-lists.
- **Workspace** reads network/worktree policy.
- **Projects** enforce resource permissions on artifact/project operations.
- **Memory** remains user-owned by default, but policy governs admin and agent access.
- **Jobs** use policy for enqueue/retry/cancel/inspect capabilities.
- **Hooks** can be disabled or approval-gated by policy.

## Files to create / modify

- `src/lib/policies/policies.schema.ts` (new)
- `src/lib/policies/policies.server.ts` (new) — policy resolver
- `src/lib/policies/acl.server.ts` (new) — resource-level permission helpers
- `src/lib/policies/decisions.server.ts` (new) — audit logging for decisions
- `src/lib/policies/index.ts` (new barrel)
- `src/lib/runtime/environment.server.ts` — resolve network/tool/workspace policy
- `src/lib/tools/tools.server.ts` — ask policy resolver before execution
- `src/lib/projects/projects.server.ts` — enforce project access
- `src/lib/artifacts/artifacts.server.ts` — enforce edit/share/delete rules
- `src/lib/jobs/jobs.server.ts` — enforce enqueue/cancel/retry permissions
- `src/lib/memory/memory.remote.ts` — enforce access rules without changing storage ownership
- `src/routes/settings/policies/+page.svelte` (new)
- `src/routes/admin/policies/+page.svelte` (new)
- `src/routes/admin/policy-decisions/+page.svelte` (new)
- `docs/policies/policies.md` (new domain doc once shipped)

## Phases

### Phase 1 — Policy engine primitives

1. Add `policies`, `resourcePermissions`, `policyDecisions` tables.
2. Implement resolver and deterministic priority order.
3. Add audit logging for every decision.

### Phase 2 — Tool and workspace policy

1. Resolve tool calls through policy engine.
2. Move network/worktree rules into policy.
3. Replace ad hoc runtime settings with resolved environment policy.

### Phase 3 — Projects and artifacts ACLs

1. Add resource permission checks for projects and artifacts.
2. Support owner, editor, viewer, admin patterns.
3. Gate artifact rollback, delete, and share actions.

### Phase 4 — Jobs and admin controls

1. Gate who can inspect/cancel/retry jobs.
2. Add admin UI for force-cancel and policy override.
3. Add safe maintenance roles.

### Phase 5 — Session and agent scoping

1. Allow temporary session-level policy narrowing.
2. Support agent-specific profiles (read-only evaluator, no-network reviewer, etc.).
3. Add policy bundles selectable per agent.

## Verification

1. Read-only evaluator cannot call write tools even if prompt asks it to.
2. User without artifact write permission cannot edit current artifact.
3. Admin can cancel a stuck job; non-admin cannot.
4. Restricted-network agent cannot reach disallowed hosts.
5. Policy decision log shows matched rules for every denied action.

## Scope boundaries

- **Included**: policy engine, ACLs, decision logging, admin controls, tool/network/workspace/artifact/project/job rules.
- **Excluded**: SSO/enterprise SCIM, external IAM integration, legal retention policies, field-level encryption.

## Key design decisions

1. Policy resolution must be runtime-enforced, not prompt-enforced.
2. Resource ACLs and general policy rules are separate but composable.
3. Sensitive actions default deny unless explicitly allowed.
4. Every deny/approval outcome must be audit logged.
5. Admin override exists, but override actions are always visible in audit history.

## Completion

- Template: YYYY-MM-DD - Completed in <PR/commit> - <one-line outcome>
- Pending.


