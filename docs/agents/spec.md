# Agents Spec

## Overview

An agent is a named, configurable AI persona that the runtime can instantiate for a run. AgentStudio uses one unified agent catalog for everything: the main chat agent, category-routed subagents (coding, UI design, research, etc.), and evaluator runs. Each agent has an identity (what it is), a model, a capability set (what tools it can use), and a set of companion skills (how it should use them). Agents are not code — they are editable records in the database, optionally sourced from a repo file.

## Data Model

### `agents` table

| Column            | Type      | Description                                                                   |
| ----------------- | --------- | ----------------------------------------------------------------------------- |
| `id`              | uuid      | Primary key                                                                   |
| `name`            | text      | Display name                                                                  |
| `slug`            | text      | URL-safe unique identifier                                                    |
| `role`            | text      | Short description of what this agent does                                     |
| `identitySkillId` | uuid?     | FK to `skills` — linked skill whose content becomes the system prompt base    |
| `model`           | string    | Default OpenRouter model slug                                                 |
| `config`          | jsonb     | Extended config: capabilityGroups, hooks, memory overrides, environment, etc. |
| `tags`            | text[]    | Optional labels for filtering (e.g., `coding`, `ui_design`, `eval`)           |
| `isActive`        | boolean   | Whether the agent is available for new runs                                   |
| `sourceFile`      | text?     | Path to the `AGENT.md` repo file that seeded this record, if any              |
| `createdAt`       | timestamp |                                                                               |
| `updatedAt`       | timestamp |                                                                               |

### `agentRoleBindings` table

Workspace-level bindings that decide which agent fills core runtime roles.

| Column      | Type      | Description                                                  |
| ----------- | --------- | ------------------------------------------------------------ |
| `id`        | uuid      | Primary key                                                  |
| `scope`     | enum      | `workspace`, `project`                                       |
| `scopeId`   | uuid?     | Null for workspace scope; FK to `projects` for project scope |
| `role`      | enum      | `main`, `evaluator`                                          |
| `agentId`   | uuid      | FK to `agents`                                               |
| `createdAt` | timestamp |                                                              |
| `updatedAt` | timestamp |                                                              |

### `agentCategoryBindings` table

Category routing from orchestration intent to candidate agents.

| Column      | Type      | Description                                                                           |
| ----------- | --------- | ------------------------------------------------------------------------------------- |
| `id`        | uuid      | Primary key                                                                           |
| `scope`     | enum      | `workspace`, `project`                                                                |
| `scopeId`   | uuid?     | Null for workspace scope; FK to `projects` for project scope                          |
| `category`  | enum      | `coding`, `ui_design`, `research`, `debugging`, `refactor`, `testing`, `docs`, `data` |
| `agentId`   | uuid      | FK to `agents`                                                                        |
| `priority`  | integer   | Lower number wins when multiple agents are mapped                                     |
| `createdAt` | timestamp |                                                                                       |
| `updatedAt` | timestamp |                                                                                       |

### `config` jsonb shape

```json
{
	"capabilityGroups": ["core", "sandbox"],
	"hooks": { "after_run": ["hook/memory-capture"] },
	"memory": { "enabled": true, "topK": 5 },
	"environment": { "workspaceMode": "ephemeral", "networkPolicy": "restricted" },
	"companionSkills": ["tools/fs-editing", "tools/run-verification"],
	"categories": ["coding", "refactor"],
	"defaultEvaluatorCandidate": false
}
```

## Features

### Unified catalog: main, category workers, evaluator

All agents are first-class rows in one list and use the same configuration surface (identity skill, model, capabilities, companion skills).

- The **main agent** is selected through `agentRoleBindings(role = 'main')` and powers the chat session's agent execution posture.
- **Category workers** are selected through `agentCategoryBindings` (for categories like coding or UI design) when the main agent spawns subagents.
- The **evaluator agent** is selected through `agentRoleBindings(role = 'evaluator')`.

No `agents.kind` field is required to determine runtime behavior.

### Identity as an editable skill

Each agent's system prompt is not a static text field. It is the content of a linked `skills` record (`agents.identitySkillId`). Editing the skill in the `/agents/[id]/identity` route updates the agent's behavior on the next run — no redeploy required.

The main agent's identity is edited in the exact same way as every other agent identity.

### Prompt composition order

At runtime, the `buildAgentDefinition` function assembles the system prompt in this exact order:

1. Identity skill content
2. Role description (`agents.role`)
3. Active task spec (if the run is task-attached)
4. Companion skill summaries (short excerpts, not full bodies)
5. Tool usage policies (injected automatically)
6. Capability groups summary

Identity prompts are intentionally short. Detailed how-to guidance for tools, workflows, and verification belongs in companion skills loaded progressively.

### Companion skills

`config.companionSkills` lists skill slugs that should have their summaries pre-loaded into the system prompt for this agent. Examples:

- Coding profile: `["tools/fs-editing", "tools/run-verification", "workflow/fix-failing-test"]`
- Research profile: `["tools/web-search", "workflow/review-pr"]`
- Evaluator profile: `["workflow/review-pr", "domain/agentstudio-runs"]`

Full skill bodies are only loaded when the model calls `read_skill` or when a hook determines they are needed.

### AGENTS.md boot loader

On startup (or admin trigger), AgentStudio scans the repo root and `docs/agents/` for agent definition files:

- `AGENTS.md` at repo root → optional defaults and seed identities
- `docs/agents/<slug>/AGENT.md` → upserts the agent record for `<slug>`

YAML frontmatter in the agent file:

```yaml
---
name: Codex Worker
role: Coding agent for TypeScript refactor tasks
model: anthropic/claude-sonnet-4
capabilityGroups: [core, sandbox, skills]
companionSkills: [tools/fs-editing, tools/run-verification]
---
```

The body of the file becomes the agent's identity skill content.

Priority when both DB and repo file exist: controlled by `AGENT_SOURCE_PRIORITY=repo|db` env var (default: `db`).

### Live identity editor

`/agents/[id]/identity` opens a full-page markdown editor backed by the agent's linked identity skill. Saving updates the skill record immediately. The next run started for this agent picks up the change.

### Per-agent hook configuration

`config.hooks` maps hook event names to arrays of hook skill slugs or built-in hook IDs. This lets individual agents have custom behavior at lifecycle boundaries without modifying the harness.

### Per-agent memory configuration

`config.memory.enabled` controls whether memory recall is injected at the start of the agent's runs. Defaults are profile-based (for example: on for main/coding agents, off for evaluator binding) and can be overridden per agent.

### Category-based subagent routing

When the main agent requests a subagent, it provides a category (`coding`, `ui_design`, `research`, etc.) rather than a hard-coded agent ID. Resolver order:

1. Project-scoped `agentCategoryBindings`
2. Workspace-scoped `agentCategoryBindings`
3. Main agent as fallback

Subagent runs are ephemeral execution instances, but they reuse persistent agent definitions by `agentId`.

### Agent management UI

`/agents` — list of all agents with model, active status, tags, and usage badges (`Main`, `Evaluator`, category assignments).
`/agents/[id]` — agent detail with tabs for: Identity (markdown editor), Config, Hooks, Skills, Runs.
`/agents/new` — create a new agent from a form or by pasting an AGENT.md.

## Behavior Contracts

- Exactly one active `main` binding exists per scope (`workspace` or `project`).
- At most one active `evaluator` binding exists per scope (`workspace` or `project`).
- Deleting an agent does not delete its historical runs. `agentId` on old runs becomes a dangling reference (soft delete only: `agents.isActive = false`).
- Evaluator safety is enforced by runtime policy, not by agent type metadata. If the evaluator binding points to an agent with write tools, write tools are removed from the active set for evaluation runs.
- The assembled system prompt is frozen at run start. Editing the identity skill mid-run does not affect the current run.
- `agents.slug` is unique and immutable after creation. Renaming an agent creates a new slug; old runs reference the record by `id`, not slug.

## Roles & Permissions

| Action                      | Who can do it             |
| --------------------------- | ------------------------- |
| View agents                 | Authenticated user        |
| Create an agent             | Authenticated user, admin |
| Edit identity skill         | Owner user, admin         |
| Edit agent config           | Owner user, admin         |
| Bind main/evaluator roles   | Admin only                |
| Bind category routing       | Admin only                |
| Activate / deactivate agent | Admin only                |
| Delete agent                | Admin only                |
| View another user's agents  | Admin only                |

## Rewrite Authority

The current implementation is a baseline, not a constraint. This domain may be rewritten, restyled, reorganized, or replaced as needed to achieve the target product quality. No code path is off-limits if behavior contracts, safety controls, tests, and documentation remain correct.

## UI Contract

This domain follows [../ui/spec.md](../ui/spec.md) and defines mode identity and skill attachment UX.

- Surfaces: mode preset picker, agent profile editor, skill attachment list, and tool access summaries.
- States and badges: active-default, overridden, missing-instructions, tool-restricted, and policy-blocked.
- Blocking actions: changing active mode identity or tool access must show impact summary before save.
- Mobile behavior: preset switch and identity editor use compact forms with explicit save/preview actions.

## References

- [agents.md open standard](https://agents.md/) — project-level agent instructions format
- [AGENTS.md — OpenAI](https://openai.com/index/introducing-agents-md/) — boot loader concept
- [Skills Are Harness Engineering You Can Do in a Markdown File — ikangai](https://www.ikangai.com/skills-are-harness-engineering-you-can-do-in-a-markdown-file)
- [GitAgent](https://github.com/open-gitagent/gitagent) — `agent.yaml` + `SOUL.md` + `RULES.md` pattern
- [Spec Kit — GitHub](https://github.com/github/spec-kit) — structured spec generation
- **Internal:** `src/lib/agents/agents.schema.ts`, `src/lib/agents/identity.server.ts`, `src/lib/agents/orchestrator.ts`, `src/routes/agents/`
