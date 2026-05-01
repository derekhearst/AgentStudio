# Agents Spec

## Overview

An agent is a named, configurable AI persona that the runtime can instantiate for a run. AgentStudio ships with one built-in orchestrator agent and supports any number of user-defined worker agents. Each agent has an identity (what it is), a model, a capability set (what tools it can use), and a set of companion skills (how it should use them). Agents are not code — they are editable records in the database, optionally sourced from a repo file.

## Data Model

### `agents` table

| Column            | Type      | Description                                                                   |
| ----------------- | --------- | ----------------------------------------------------------------------------- |
| `id`              | uuid      | Primary key                                                                   |
| `name`            | text      | Display name                                                                  |
| `slug`            | text      | URL-safe unique identifier                                                    |
| `role`            | text      | Short description of what this agent does                                     |
| `kind`            | enum      | `orchestrator`, `worker`, `evaluator`                                         |
| `identitySkillId` | uuid?     | FK to `skills` — linked skill whose content becomes the system prompt base    |
| `model`           | string    | Default OpenRouter model slug                                                 |
| `config`          | jsonb     | Extended config: capabilityGroups, hooks, memory overrides, environment, etc. |
| `isActive`        | boolean   | Whether the agent is available for new runs                                   |
| `sourceFile`      | text?     | Path to the `AGENT.md` repo file that seeded this record, if any              |
| `createdAt`       | timestamp |                                                                               |
| `updatedAt`       | timestamp |                                                                               |

### `config` jsonb shape

```json
{
	"capabilityGroups": ["core", "sandbox"],
	"hooks": { "after_run": ["hook/memory-capture"] },
	"memory": { "enabled": true, "topK": 5 },
	"environment": { "workspaceMode": "ephemeral", "networkPolicy": "restricted" },
	"companionSkills": ["tools/fs-editing", "tools/run-verification"]
}
```

## Features

### Three agent kinds

**Orchestrator** — the user-facing planner. Coordinates the overall session: proposes plans, spawns workers, asks the user questions. Only one orchestrator is active at a time per session. Has access to the `agents` capability group (can call `run_subagent`, `propose_plan`, `ask_user`).

**Worker** — executes a specific task or capability. Workers have narrow tool sets appropriate to their role (e.g., a coding worker gets `sandbox`; a research worker gets `web_search`). Workers are spawned by the orchestrator as sub-agent runs.

**Evaluator** — reviews completed work and returns a structured verdict. Evaluators use a cheap model, have read-only tools, and produce a `{ verdict, findings, confidence }` output. See the evaluations spec for full details.

### Identity as an editable skill

Each agent's system prompt is not a static text field. It is the content of a linked `skills` record (`agents.identitySkillId`). Editing the skill in the `/agents/[id]/identity` route updates the agent's behavior on the next run — no redeploy required.

The orchestrator's identity is seeded as a `system/orchestrator-identity` skill on first boot. It can be edited like any other skill.

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

- Coding worker: `["tools/fs-editing", "tools/run-verification", "workflow/fix-failing-test"]`
- Research worker: `["tools/web-search", "workflow/review-pr"]`
- Evaluator: `["workflow/review-pr", "domain/agentstudio-runs"]`

Full skill bodies are only loaded when the model calls `read_skill` or when a hook determines they are needed.

### AGENTS.md boot loader

On startup (or admin trigger), AgentStudio scans the repo root and `docs/agents/` for agent definition files:

- `AGENTS.md` at repo root → upserts the orchestrator identity skill
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

`config.memory.enabled` controls whether memory recall is injected at the start of the agent's runs. Memory recall is on by default for the orchestrator and off by default for evaluators.

### Agent management UI

`/agents` — list of all agents with kind badge, model, active status, and last used timestamp.
`/agents/[id]` — agent detail with tabs for: Identity (markdown editor), Config, Hooks, Skills, Runs.
`/agents/new` — create a new agent from a form or by pasting an AGENT.md.

## Behavior Contracts

- The orchestrator identity skill (`system/orchestrator-identity`) always exists. Boot seeder creates it if missing.
- Deleting an agent does not delete its historical runs. `agentId` on old runs becomes a dangling reference (soft delete only: `agents.isActive = false`).
- An evaluator agent must have read-only tools only. The runtime enforces this; if an evaluator's capability groups include write tools, those tools are removed from the active set.
- The assembled system prompt is frozen at run start. Editing the identity skill mid-run does not affect the current run.
- `agents.slug` is unique and immutable after creation. Renaming an agent creates a new slug; old runs reference the record by `id`, not slug.

## Roles & Permissions

| Action                      | Who can do it             |
| --------------------------- | ------------------------- |
| View agents                 | Authenticated user        |
| Create an agent             | Authenticated user, admin |
| Edit identity skill         | Owner user, admin         |
| Edit agent config           | Owner user, admin         |
| Activate / deactivate agent | Admin only                |
| Delete agent                | Admin only                |
| View another user's agents  | Admin only                |

## References

- [agents.md open standard](https://agents.md/) — project-level agent instructions format
- [AGENTS.md — OpenAI](https://openai.com/index/introducing-agents-md/) — boot loader concept
- [Skills Are Harness Engineering You Can Do in a Markdown File — ikangai](https://www.ikangai.com/skills-are-harness-engineering-you-can-do-in-a-markdown-file)
- [GitAgent](https://github.com/open-gitagent/gitagent) — `agent.yaml` + `SOUL.md` + `RULES.md` pattern
- [Spec Kit — GitHub](https://github.com/github/spec-kit) — structured spec generation
- **Internal:** `src/lib/agents/agents.schema.ts`, `src/lib/agents/identity.server.ts`, `src/lib/agents/orchestrator.ts`, `src/routes/agents/`
