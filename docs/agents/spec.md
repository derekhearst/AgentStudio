# Agents Spec

> **Plain-English guide:** [agents.md](agents.md) — what agents are, pausing and resuming, and which tools the built-ins get.

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
| `status`          | enum      | `active`, `idle` or `paused`. Only `paused` changes behaviour — see below     |
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

### Delegation and fan-out (#5, #32)

There is no category routing. (An earlier draft of this spec described an `agentCategoryBindings` resolver; it was never built.) An orchestrator run is handed up to 12 custom agents as the SDK's `Options.agents` (`loadSubagentRoster` in `src/lib/engine/agent-definitions.server.ts`), and the model delegates by calling the SDK's `Agent` tool (called `Task` by older CLIs) with the agent's key as `subagent_type`. A fan-out is several `Agent` calls in one assistant message; the CLI runs them as one parallel batch and returns their results in order.

**Admission.** Every delegation passes `src/lib/engine/delegation-gate.ts`, called from the engine's PreToolUse hook. The hook is used rather than `canUseTool` because the CLI's `Agent` tool answers its own permission check with "allow" in the modes we run, so `canUseTool` is not consulted for it; a PreToolUse hook fires for every call and its answer is binding. The gate:

| Rule | Behaviour |
| ---- | --------- |
| Foreground | `run_in_background` is rewritten to `false`. A background child in a one-shot query is held back and killed at the CLI's print-mode ceiling, and reports only a token total. |
| Cap | At most `MAX_CONCURRENT_SUBAGENTS` (4) children hold a slot at once. The next call is denied with "wait for the running children to finish, then delegate the rest". It is refused rather than queued: a hook that waited would be timed out by the CLI, and a timed-out hook lets the call through. The slot is reserved before the budget check awaits, so a parallel batch cannot all see the same free slot. |
| One level | A call whose hook input carries `agent_id` (made inside a child) is refused. `Agent`, `Task`, `Workflow` and `SendMessage` are also in every definition's `disallowedTools`. |
| Budget | The child is checked with `enforceBudgetGuard` scoped to its own agent (`src/lib/chat/stream-delegation.server.ts`) before it starts, bounded at 10 seconds. A block, a throw or a timeout is a refusal. |
| Isolation, mode | `isolation` is stripped: `worktree` would branch the run's checkout into a copy nothing merges back or cleans up, outside what the containment guard and the approval cards know about, and `remote` always runs in the background. `mode` is stripped (the SDK documents it as ignored). |
| Model | Stripped when the parent runs on the gateway: the tool only takes Claude aliases, which the gateway cannot serve. A Claude parent keeps it. |
| Plan mode | `Agent` is classified as a mutation (`permission-mode.ts`), so plan mode refuses the call before it takes a slot. |

Any surprise inside the gate is a refusal with a reason, never a call waved through. `Workflow`, the CLI's scripted fan-out, is in `DISALLOWED_BUILTIN_TOOLS`, since its agents are not `Agent` calls and would bypass the gate. So is `SendMessage`: in the bundled CLI it also resumes an agent that has finished or been stopped ("Resuming agent …"), which would restart a child outside any `Agent` call, with no slot, no budget check and no card.

**When a slot comes back.** Only when the child's card closes: its typed result, an error result, or the turn ending. A launch placeholder (`async_launched`, `remote_launched`) does not free it. The rewrite sets the call's `run_in_background`, but the bundled CLI also backgrounds a child whose agent definition says `background: true` (it computes "run async" as the call's wish **or** the definition's `background` flag), and a trusted project's `.claude/agents/` can say so. That child keeps its slot, and its card stays open, until its `task_notification` (matched by `tool_use_id`) says how it ended. The cap therefore holds whatever a definition asks for. A definition's own `isolation` is honoured by the CLI the same way; it is the trusted project's own configuration, and only the call's `isolation` is stripped. Refusing every `subagent_type` outside our roster was considered and rejected: a trusted project's own agents are a feature (#23), and a project file can reuse a built-in agent's name anyway.

**The budget check within a turn.** Each child's ledger row is written the moment its card closes (the engine's `onSubagentDone`, wired to `createSubagentLedger` in `src/lib/costs/subagent-ledger.server.ts`), so the next child's `enforceBudgetGuard` sees every child of the turn that has already finished. Siblings still running and the parent's own calls in the turn are not in the figure until they are booked.

**Verified in the installed SDK (0.3.278, bundled CLI 2.1.278).** From the typings: `AgentInput` (`sdk-tools.d.ts`) carries `subagent_type`, `model`, `run_in_background`, `isolation` and `mode`; `AgentOutput` is `completed` (with `content`, `totalTokens`, `totalDurationMs`, `totalToolUseCount`, `usage`, `resolvedModel`) or an `async_launched` / `remote_launched` placeholder; `PreToolUseHookInput` carries `agent_id` only inside a subagent; `result.usage` is the main loop only while `modelUsage` covers subagents. From the bundled CLI: a PreToolUse `updatedInput` with no `permissionDecision` is applied as a plain input change; `AgentOutput.usage` and `totalTokens` describe the child's last model call, not its whole spend; a foreground child runs on the parent turn's own abort controller while a background one gets a fresh one; on an interrupt, the CLI answers every tool call still running (a child included) with an error result of its own (`[Request interrupted by user for tool use]`, or a synthetic cancellation from `StreamingToolExecutor.createSyntheticErrorMessage`) before the turn's `result`; and each assistant message of a model call (one per content block) is yielded as soon as its block ends, carrying the usage known at that moment, while the call's final output count is patched onto those same objects when `message_delta` arrives. Whether a forwarded copy carries the final count therefore depends on when it is written out, which is why the tally below takes the larger report rather than the first or the last.

**Cancellation.** Stop calls `interrupt()` on the run's handle, which aborts the parent turn and, through the shared abort controller, every foreground child; the engine's `close()` then ends the CLI process. `perTaskStopAffordance` is never declared, so even a background task would be killed by the interrupt. The engine records that it sent the interrupt, and an error result for a delegation after that (or one carrying the CLI's interrupt text) closes the card as `stopped` rather than `failed`.

**The card.** Each delegation opens a `subagent` stream block at the parent's `Agent` call (`src/lib/engine/subagent-block.ts`), so a refused child still has a card. The delegation gets no `tool` block of its own. The child's messages, routed by `parent_tool_use_id`, build an ordered transcript on the block (`src/lib/engine/subagent-transcript.ts`, capped at 200 entries and 20,000 characters). The delegation's typed result closes it with `details` (`SubagentDetails` in `tool-result-details.ts`); a card still open when the turn ends is closed as `stopped`. The block's `usage` is what the child spent over all its model calls (`src/lib/engine/subagent-usage.ts`): each forwarded child assistant message and each `message_start` / `message_delta` stream event is counted per `message.id`, every field taking the larger of the reports for the same call (so a call split over several messages counts once, and a provisional output count is replaced by the final one when either reaches the stream), and the typed result's `usage` is folded in as the last call. The card's token count and the ledger row both read it. All new block fields are optional jsonb, so no migration.

**Cost.** See [../cost/spec.md](../cost/spec.md): one `subagent` ledger row per child that spent anything, for all its calls, written when its card closes and carved out of the parent's row.

**Not built.** Child `chat_runs` rows (and with them a run-tree view), a per-child stop control, and worktree isolation for a child, which needs a merge-back and cleanup story first.

### Subagent output is data, not instructions

A subagent may read a web page, a repo file, an issue body or a PR comment, so anything it returns can contain text an attacker wrote. Before a child's result reaches the parent, the system wraps it in a `<subagent_result>` marker that says "a child agent reported this". Any marker the child wrote itself is escaped, so a child cannot close the wrapper and make the rest of its output look like the parent's own thinking. The parent's system prompt states the matching rule: everything inside the marker is an observation, and an instruction found inside one is content to report on, never a command to obey.

### Agent status: Available or Paused (#66)

`agents.status` is shown and changed as two states. `paused` is Paused; `active` and `idle` are both Available, because nothing reads the difference between them. The rule lives in `src/lib/agents/agent-status.ts` and every reader uses it:

- **Delegation.** A paused agent is left out of `Options.agents` (`loadSubagentDefinitions`).
- **Automations.** `runAutomationById` skips a run whose automation is assigned to a paused agent, for every trigger. The attempt is recorded as `blocked` with the reason; a scheduled tick still advances `nextRunAt`. It is not a failure and does not touch the failure streak.
- **Monitors.** A `start_conversation` action refuses to run a paused agent, and falls back to a review item.
- **Direct chat** is not affected.

Only user-created agents may be paused (`builtinKey IS NULL` and `kind <> 'evaluator'`). Built-ins are never delegates, so a pause would only stop their automations, which a per-automation switch already does; evaluators run whatever their status. The server refuses both (`setAgentPaused`, shared by the `setAgentPausedCommand` remote command and the `pause_agent` / `resume_agent` tools). Resuming is always allowed, so a built-in paused before the rule existed is not stranded. Resume writes `active`; resuming an agent that is not paused is a no-op. Every change is audited as `agent.status.changed` with the acting user (null for the model's tools).

The orchestrator prompt used to carry its own roster of `status = 'active'` agents, which disagreed with `Options.agents` (on a fresh install it listed only the Default Evaluator). It now points at the SDK's `Agent` tool description, which lists exactly the offered agents.

### Built-in agents and their tools (#67)

Research and Plan share one allow-list, `READ_ONLY_TOOL_NAMES`, and it includes `Write`. This is decided, not inherited: both personas write their plan to a markdown file (`RESEARCH-PLAN.md`, `PLAN.md`) and hand off with `request_plan_approval`, which reads the plan from disk. Dropping `Write` from Research would break its handoff. Chat and Autonomous are unrestricted; a custom agent's `config.allowedTools`, when set, is its whole surface. The scope is enforced by `src/lib/engine/tool-scope.ts`.

### Agent management UI

`/agents` — list of all agents with model, status (Available / Paused), usage figures, and an inline Pause / Resume for custom agents.
`/agents/[id]` — agent detail with tabs for: Identity (markdown editor), Config, Hooks, Skills, Runs. Pause / Resume sits in the page header for custom agents; built-ins and evaluators show a label instead. While the agent is running, a **Live session** banner shows the latest text it has written and a **Watch live** link to the conversation; a run that has started but not written anything yet shows an empty preview. An id that does not exist, or is not a valid id at all, shows "Agent not found." with a link back to the list.
`/agents/new` — opens a guided **Create agent** chat: an agent asks what the new agent should do and then writes it. The page swaps itself for the chat in the browser history, so **Back** from the chat returns to wherever you came from rather than starting another chat (each start is a new conversation and a paid model run). If the chat cannot be started, the page says why and links back to the list. There is no form or AGENT.md paste box; to add an agent from a file, put its `AGENT.md` under `docs/agents/<slug>/` (see above).

## Behavior Contracts

- Exactly one active `main` binding exists per scope (`workspace` or `project`).
- At most one active `evaluator` binding exists per scope (`workspace` or `project`).
- Deleting an agent does not delete its historical runs. `agentId` on old runs becomes a dangling reference (soft delete only). Pausing is not deletion: a paused agent keeps its history and can be chatted with.
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
| Pause / resume agent        | Owner (custom agents only) |
| Delete agent                | Admin only                |
| View another user's agents  | Admin only                |

What is enforced today (AgentStudio has a single owner and no admin tier): viewing the agent catalogue requires signing in, because agent records carry their system prompts. The catalogue itself is shared, but the figures shown with each agent — session count, spend, recent conversations and the automations bound to it — are the viewer's own.

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
