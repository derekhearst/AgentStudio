# Structure Plan

Status: active

## Overview

`src/lib/agents/` today holds records, the agent loop, the orchestrator prompt, the inline sub-agent executor, and an in-memory stream registry — five different concerns. `src/lib/chat/` similarly conflates the message tape, runs, compaction, creation flow, and UI components. As the harness work in the other plans introduces `runtime`, `runs`, `tasks`, `workspace`, `hooks`, and `evaluations` as first-class primitives, the folder layout has to match the vocabulary or every other plan will land on shaky ground. This plan is the structural refactor that the other nine plans assume.

## Why this matters (harness principles)

- **Brain / Hands / Session are independent primitives.** Anthropic's Managed Agents post — folders should match.
- **Repository knowledge is the system of record.** A new contributor reading `docs/runs/plan.md` should find `src/lib/runs/`.
- **Composable primitives over opinionated workflows.** Decoupling lets each piece evolve without touching its neighbors.

## Reference repos & articles

- [The Anatomy of an Agent Harness — LangChain](https://blog.langchain.com/the-anatomy-of-an-agent-harness/) — state, tools, feedback, constraints as separate concerns
- [The Design of Claude Managed Agents — Anthropic](https://www.anthropic.com/engineering/managed-agents) — agent config + environment + session
- [Components of a Coding Agent — Sebastian Raschka](https://magazine.sebastianraschka.com/p/components-of-a-coding-agent) — model + loop + runtime split
- [Scion (Google)](https://github.com/GoogleCloudPlatform/scion) — pluggable orthogonal modules
- [Microsoft Agent Framework](https://github.com/microsoft/agent-framework) — structured orchestration boundaries

## Vocabulary decisions

### When a domain earns its own folder

A domain gets its own `src/lib/<domain>/` folder (and a matching `docs/<domain>/`) when it has **at least one** of:

- Its own DB tables with non-trivial state
- Its own async job, loop, or state machine logic
- Its own non-trivial server-side services that other domains call

This is why `research/` is a real domain (DB tables, job loop, tool group) while "research mode" and "research skill" are not — those are thin configurations inside `agents/` and `skills/` respectively. The docs and lib structure mirror each other: every `docs/<domain>/` should eventually have a `src/lib/<domain>/`.

### Term table

| Term              | Meaning                                                                                                                                            | Folder           |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| **Runtime**       | The agent loop + the Brain/Hands/Session primitives that drive it                                                                                  | `runtime/`       |
| **Session**       | Durable message tape + metadata. Many sessions can exist; only some are user-visible.                                                              | `sessions/`      |
| **Run**           | One execution attempt against a session (stream, retry, resume). Has state machine, cost, events.                                                  | `runs/`          |
| **Task**          | User intent / spec. May spawn one or more sessions.                                                                                                | `tasks/`         |
| **Conversation**  | Synonym for "user-facing session" — UI label only, not a folder.                                                                                   | (n/a)            |
| **Agent**         | Identity record (name, role, identity skill, model, capability bindings). Not the loop.                                                            | `agents/`        |
| **Environment**   | Per-run sandbox (workspace, tool allow-list, network policy).                                                                                      | `workspace/`     |
| **Hook**          | Lifecycle callback (`before_tool`, `after_run`, …).                                                                                                | `hooks/`         |
| **Evaluation**    | Critic verdict on a run/task.                                                                                                                      | `evaluations/`   |
| **Job**           | Durable background work item that schedules, retries, and supervises execution.                                                                    | `jobs/`          |
| **Memory**        | Cross-session durable knowledge with retrieval.                                                                                                    | `memory/`        |
| **Policy**        | Runtime-enforced access rules, approvals, ACLs, and admin overrides.                                                                               | `policies/`      |
| **Observability** | Traces, operational metrics, incidents, and the unified review inbox.                                                                              | `observability/` |
| **Skill**         | Composable markdown bundle, lazy-loaded.                                                                                                           | `skills/`        |
| **Tool**          | A callable capability surfaced to the LLM.                                                                                                         | `tools/`         |
| **Research**      | Autonomous search-fetch-synthesize loop, DB tables, job type, report output. Distinct from "research mode" (agents) and "research skill" (skills). | `research/`      |
| **Context**       | Slot-based system prompt assembly, compaction, token budgets. Has own schema (`compactionEvents`, `contextSlotConfigs`).                           | `context/`       |
| **LLM**           | Model provider adapter + model catalog.                                                                                                            | `llm/`           |

Why **`sessions/` not `conversations/`**: a sub-agent that the user never sees still has a message tape, runs, costs. That isn't a conversation in any normal sense — it's a session. "Conversation" is the UI label for sessions where `kind = 'user_chat'`.

Why **`runtime/` not `harness/`**: the awesome-agent-harness list uses "Agent Runtime" as the canonical category for this concern. `harness` is the discipline; `runtime` is the artifact.

## Current state

```
src/lib/
  activity/  agents/  assets/  auth/  automation/
  chat/  cost/  db.server.ts  memory/  models/
  notifications/  openrouter.server.ts  settings/
  skills/  state.svelte.ts  tauri.ts  tools/  ui/
```

Pain points:

- `agents/` mixes records (`agents.schema.ts`, `agents.server.ts`, `agents.remote.ts`) with runtime (`orchestrator.ts`, `inline-subagent.ts`, `streaming-state.server.ts`).
- `chat/` mixes the message tape (`chat.schema.ts`), durable runs (`chatRuns` rows + `runs.server.ts`), compaction, creation flow, and UI components.
- `tools/` mixes the catalog, the executor, and sandbox path resolution (workspace logic).
- `automation/` and `cost/` are singular while peers are plural — minor consistency issue.
- `models/` and `openrouter.server.ts` are split between a folder and a top-level file.

## Target structure

```
src/lib/
  # ── Harness core ─────────────────────────────────────────
  runtime/                # the agent loop + Brain/Hands/Session primitives
    loop.server.ts                # runAgentLoop()
    definition.server.ts          # AgentDefinition builder
    environment.server.ts         # Environment builder (delegates to workspace/)
    spawn.server.ts               # spawnSubagent / awaitSubagents
    session/
      sse.server.ts               # SSE-backed Session adapter
      detached.server.ts          # for automations + child runs
      types.ts                    # Session interface
    types.ts                      # AgentDefinition, Environment, RunResult
    index.ts

  sessions/               # durable message tape (was most of chat/)
    sessions.schema.ts            # sessions + messages tables
    sessions.server.ts
    sessions.remote.ts
    compaction.server.ts          # context compaction
    creation-flow.ts              # New Agent / New Skill seeded chats
    components/                   # MessageBubble, ChatInput, ContextWindow, etc.
    rendering.ts                  # was chat.ts (markdown, tool card copy)
    index.ts

  runs/                   # durable run state + events + resume
    runs.schema.ts                # chatRuns → runs + run_events + pending_*
    runs.server.ts
    runs.remote.ts
    events.server.ts              # append-only event log
    resume.server.ts              # replay + reconnect
    index.ts

  tasks/                  # task layer (new — see docs/tasks/plan.md)
    tasks.schema.ts               # tasks + task_attempts
    tasks.server.ts
    tasks.remote.ts
    index.ts

  jobs/                   # durable background execution + scheduling
    jobs.schema.ts
    jobs.server.ts
    worker.server.ts
    handlers/
    index.ts

  agents/                 # agent RECORDS only (slim)
    agents.schema.ts
    agents.server.ts
    agents.remote.ts
    identity.server.ts            # composes prompt from skill (see agents plan)
    index.ts

  # ── Capabilities ─────────────────────────────────────────
  tools/                  # catalog + executor + capability groups
    tools.ts                      # types + capabilityGroups registry
    tools.server.ts               # dispatch + executor
    catalog/
      web.server.ts
      fs.server.ts                # consolidated read/write/patch/list/search/move/delete
      shell.server.ts
      browser.server.ts
      image.server.ts
      meta.server.ts              # enable_capability, await_subagents
    index.ts

  workspace/              # per-run sandbox (extracted from tools/)
    workspace.server.ts           # path resolution + create/destroy
    gc.server.ts                  # daily cleanup of expired ephemeral roots
    worktree.server.ts            # optional git worktree mode
    index.ts

  mcp/                    # placeholder for MCP server registry (future)

  # ── Knowledge ────────────────────────────────────────────
  skills/                 # composable markdown bundles — see docs/skills/plan.md
  memory/                 # in flight — already named correctly

  # ── Lifecycle / instrumentation ──────────────────────────
  hooks/                  # see docs/hooks/plan.md
    bus.ts
    types.ts
    builtins/
    skill-hook-runner.ts
    hooks.schema.ts               # hook_invocations
    index.ts

  evaluations/            # see docs/evaluations/plan.md
    evaluations.schema.ts
    evaluations.server.ts
    index.ts

  observability/          # traces, dashboards, and review inbox
    observability.schema.ts
    traces.server.ts
    review.server.ts
    metrics.server.ts
    index.ts

  activity/               # event log — already fine

  # ── Docs-parallel domains (not yet built) ───────────────
  research/               # autonomous search-fetch-synthesize loop (see docs/research/spec.md)
    research.schema.ts            # research + researchSources + researchSteps
    research.server.ts
    research.remote.ts
    loop.server.ts                # search-fetch-synthesize loop logic
    index.ts

  context/                # slot-based context assembly + compaction (see docs/context/spec.md)
    slots.server.ts               # ContextSlot type + assembleSystemPrompt()
    compaction.server.ts          # moved from sessions/ once context/ exists
    context.schema.ts             # compactionEvents + contextSlotConfigs
    index.ts

  # ── Operations ───────────────────────────────────────────
  automations/            # renamed from automation/ for plural consistency
  costs/                  # renamed from cost/ for plural consistency
  notifications/
  policies/
  settings/
  auth/

  # ── Infra ────────────────────────────────────────────────
  llm/                    # consolidates openrouter.server.ts + models/
    openrouter.server.ts
    models.server.ts              # catalog + context windows
    types.ts                      # LlmMessage, ReasoningConfig
    index.ts

  db.server.ts
  state.svelte.ts
  tauri.ts
  ui/
  assets/
```

### Mental model

```
Task (intent)
  └─ Session (message tape; kind = user_chat | agent_subagent | automation | evaluator)
       └─ Run (one execution attempt; has state, events, cost)
            └─ run_events (append-only; resume primitive)
```

Tasks → Sessions is 1-to-many (a task can spawn the user's root session plus N subagent sessions).
Sessions → Runs is 1-to-many (regeneration, retry, resume produce new runs against the same session).
Runs → Events is 1-to-many (the event log).

### `sessions` schema additions

```ts
sessions: {
  ...                       // existing conversations columns
  kind: enum('user_chat', 'agent_subagent', 'automation', 'evaluator')
  parentSessionId: uuid | null
  visibleToUser: boolean default true     // false for child subagent sessions
}
```

The route `/chat/[id]` keeps its name (it's still the user's chat surface) but filters to `kind = 'user_chat' AND visibleToUser = true` for the recents list.

## Migration mechanics

The codebase imports through domain barrels (per `README.md` "Architecture Conventions"), which makes this much cheaper than it looks. Each step is a single PR-sized refactor with no behavior change and a green build.

### Step order (each independent and reversible)

1. **Trivial renames first** — `cost/` → `costs/`, `automation/` → `automations/`. Update imports.
2. **Extract `llm/`** — move `openrouter.server.ts` and `models/` under `llm/`.
3. **Extract `runs/` from `chat/`** — pull `chatRuns` schema + `runs.server.ts` out. Old `chat/index.ts` re-exports for one release.
4. **Split `chat/` → `sessions/`** — table rename `conversations` → `sessions`, file move + barrel forward. Add `kind`, `parentSessionId`, `visibleToUser` columns. Route `/chat/[id]` continues to work via filter.
5. **Create `runtime/`** — move `agents/orchestrator.ts` → `runtime/definition.server.ts`, `agents/inline-subagent.ts` → `runtime/spawn.server.ts`, delete `agents/streaming-state.server.ts` (replaced by `runs/events`).
6. **Slim `agents/`** — only records + `identity.server.ts` remain.
7. **Extract `workspace/`** from inside `tools/`.
8. **Split `tools/catalog/`** by family.
9. **Add `tasks/`, `hooks/`, `evaluations/`** as feature work (their own plan docs).
10. **Add `jobs/`, `policies/`, `observability/`** as second-wave product hardening domains.

Sequencing guard: `docs/projects/plan.md` Phase 3 (Memory bridge) executes only after the active Memory workstream has merged; ship Projects/Artifacts Phases 1-2 first.

### Rename + barrel pattern

For each move:

```ts
// src/lib/chat/index.ts (deprecated barrel — kept for one release)
export * from '../sessions'
export * from '../runs'
```

Imports update gradually; the build never breaks. A subsequent PR removes the deprecated barrel.

### Schema migrations

| Step   | Migration                                                                                                                                                                                           |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4      | `ALTER TABLE conversations RENAME TO sessions;` + add `kind`, `parent_session_id`, `visible_to_user` columns. Backfill `kind = 'user_chat'`, `visible_to_user = true`. Rename FK columns elsewhere. |
| 3      | `ALTER TABLE chat_runs RENAME TO runs;` + later additions from `docs/runs/plan.md`.                                                                                                                 |
| Others | Pure file moves — no migration.                                                                                                                                                                     |

Every other plan's schema work happens _after_ this refactor lands. For Projects integration, defer Memory-touching schema changes until the Memory plan implementation is complete.

## Cross-plan terminology updates

Once this lands, the other nine plan docs use:

| Old term                           | New term                                       |
| ---------------------------------- | ---------------------------------------------- |
| `conversations` (table)            | `sessions`                                     |
| "the conversation"                 | "the session" (when meaning the data)          |
| "chat" (route, UI)                 | unchanged where it means the UI                |
| `chat_runs`                        | `runs`                                         |
| `chatRuns` (TS)                    | `runs`                                         |
| `parentConversationId`             | `parentSessionId`                              |
| `agents/orchestrator.ts`           | `runtime/definition.server.ts`                 |
| `agents/inline-subagent.ts`        | `runtime/spawn.server.ts`                      |
| `agents/streaming-state.server.ts` | (deleted; replaced by `runs/events.server.ts`) |
| `lib/cost`                         | `lib/costs`                                    |
| `lib/automation`                   | `lib/automations`                              |
| `lib/openrouter.server.ts`         | `lib/llm/openrouter.server.ts`                 |
| `lib/models`                       | `lib/llm/models.server.ts`                     |

## Files to create / modify

This refactor mostly _moves_ files. Notable creations:

- `src/lib/runtime/types.ts` — `AgentDefinition`, `Environment`, `Session`, `RunResult`
- `src/lib/runtime/index.ts` — barrel
- `src/lib/sessions/index.ts` — barrel
- `src/lib/runs/index.ts` — barrel
- `src/lib/llm/index.ts` — barrel
- `src/lib/workspace/index.ts` — barrel
- `src/lib/chat/index.ts` — temporary deprecation shim
- `src/lib/agents/streaming-state.server.ts` — DELETE (after Step 5)

## Migration / backward-compat

- Each step is reversible until merged.
- Deprecation barrels live for exactly one release, then are removed in a follow-up PR.
- Schema renames are done with `RENAME TO` (cheap, atomic) — no copy-and-drop.
- A boot job rejects requests against legacy table names if they slip through.

## Verification

- After each step: `bun run check` passes; `bun run test:e2e` passes; the smoke route `/chat` and `/agents` render.
- Search the repo for the old import path; expect zero matches except in the deprecation barrels.
- Drizzle introspection diff is empty after schema renames (no accidental column changes).
- Performance unchanged (no extra DB queries from rename).

## Out of scope

- Splitting routes (e.g., `/chat` → `/sessions`). Routes are the user surface; keep them stable.
- Dependency injection / service container patterns.
- Testing framework changes.
- Multi-package monorepo split.

## Status

This plan is a prerequisite for the runtime, runs, tasks, workspace, runtime parallel-subagents, evaluations, hooks, tools, skills, agents, jobs, policies, and observability plans. Land Steps 1–6 before doing major work in those areas; remaining steps can interleave with feature plans.

## Completion

- Template: YYYY-MM-DD - Completed in <PR/commit> - <one-line outcome>
- Pending.


