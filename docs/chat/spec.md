# Chat Spec

## Overview

Chat is AgentStudio's primary user interface: a chat-first control plane for planning, executing, inspecting, and approving agent work. It is not just a message list. It is the unified surface where users choose work mode, review plans, watch live progress, inspect artifacts and diffs, answer agent questions, approve risky actions, and review pull requests without leaving the chat flow.

This domain exists because the runtime, tasks, runs, research, projects, and review inbox specs define backend primitives, but users still need one coherent UI shell that turns those primitives into a product comparable to Claude, Gemini, and long-running agent apps.

## Sessions vs. Runs

A **session** is the persistent conversation container visible to the user — it has a title, a mode, and an ordered message history that spans the entire lifetime of a chat thread. Sessions survive indefinitely and are the unit users see in the sidebar.

A **run** is one discrete agent execution that happens _inside_ a session. Sending a message in agent mode starts a run; that run completes (or fails), and its output messages are appended to the session. The next message starts a new run. A single session typically contains many runs over its lifetime.

|                  | Session                           | Run                                           |
| ---------------- | --------------------------------- | --------------------------------------------- |
| Owned by         | `chat` domain                     | `runs` domain                                 |
| Lifetime         | Indefinite — user deletes it      | One agent loop execution                      |
| Created by       | User opening or continuing a chat | Each user message in agent/plan/research mode |
| 1:N relationship | One session → many runs           | One run → one session                         |
| Message history  | `sessionMessages` (all turns)     | `run_events` (events during that execution)   |
| User sees        | Sidebar thread                    | Live HUD + trace in right panel               |

## Data Model

Chat owns the `sessions` table — the canonical record of a user-facing conversation. Every run, task, research session, and review item that originates from a conversation carries a `sessionId` FK back to this table.

### `sessions` table

| Column              | Type      | Notes                                                                                           |
| ------------------- | --------- | ----------------------------------------------------------------------------------------------- |
| `id`                | uuid      | Primary key                                                                                     |
| `userId`            | uuid      | FK to `users` — owner                                                                           |
| `title`             | text?     | Auto-generated or user-edited title                                                             |
| `mode`              | enum      | `chat`, `research`, `plan`, `agent` — current active mode                                       |
| `projectId`         | uuid?     | FK to `projects` — project currently in scope for this session                                  |
| `currentArtifactId` | uuid?     | FK to `artifacts` — artifact the agent edits by default                                         |
| `taskId`            | uuid?     | FK to `tasks` — task this session is driving, if any                                            |
| `agentId`           | uuid?     | FK to `agents` — optional pinned main agent for this session (null = use scoped `main` binding) |
| `createdAt`         | timestamp |                                                                                                 |
| `updatedAt`         | timestamp |                                                                                                 |

### `sessionMessages` table

The ordered message history for a session. Append-only.

| Column      | Type      | Notes                                                                |
| ----------- | --------- | -------------------------------------------------------------------- |
| `id`        | uuid      | Primary key                                                          |
| `sessionId` | uuid      | FK to `sessions`                                                     |
| `runId`     | uuid?     | FK to `runs` — which run produced this message (null for user turns) |
| `role`      | enum      | `user`, `assistant`, `system`, `tool`                                |
| `content`   | jsonb     | Message content blocks (text, image, tool_call, tool_result, etc.)   |
| `seq`       | integer   | Monotonic sequence number within the session                         |
| `createdAt` | timestamp |                                                                      |

### `chatWorkbenchPreferences` table

| Column           | Type      | Notes                               |
| ---------------- | --------- | ----------------------------------- |
| `id`             | uuid      | Primary key                         |
| `userId`         | uuid      | FK to `users`                       |
| `defaultMode`    | enum      | `chat`, `research`, `plan`, `agent` |
| `showRightPanel` | boolean   |                                     |
| `panelLayout`    | jsonb     | Widths, collapse state, tab pinning |
| `createdAt`      | timestamp |                                     |
| `updatedAt`      | timestamp |                                     |

## Features

### Composer modes

The composer supports four explicit modes, each representing a distinct cognitive stance. `sessions.mode` records the current mode and is updated on each switch. Mode switches are recorded as system messages in `sessionMessages` so the model understands its posture has changed.

| Mode       | Intent                                                                                       | Assumption level |
| ---------- | -------------------------------------------------------------------------------------------- | ---------------- |
| `chat`     | Conversational — direct answers, minimal tool use, collaborative pushback                    | Low              |
| `research` | Skeptical investigation — surfaces uncertainty, cites sources, asks before acting            | Minimal          |
| `plan`     | Structured proposal — produces a plan with success criteria before any execution             | Medium           |
| `agent`    | Autonomous execution — proceeds on best interpretation, interrupts only for genuine blockers | High             |

Mode selection affects the main agent's identity prompt (loaded from an editable skill), which tools are available, which companion skills auto-load, and which right-panel UI is shown. Modes are **not** skills — the identity prompt backing each mode is stored as a skill so it can be edited without code changes, but the mode itself is a session-level behavioral contract stored in `sessions.mode`.

The mode selector appears in the composer toolbar. Switching mode mid-conversation injects a system anchor message so the model understands its posture has changed. Context (prior messages, plans, research findings) is always preserved across mode switches.

Default mode is set in `chatWorkbenchPreferences.defaultMode`. The intended workflow is:

```
Research mode → surface findings, challenge the premise
    ↓ user satisfied with direction
Plan mode → propose implementation with success criteria
    ↓ user approves plan
Agent mode → execute, minimal interruptions
```

### Session list, filtering, and grouping

The left session list is the primary navigation surface for chat history.

- Users can filter the list by agent so they can quickly switch between sessions associated with different agent personalities.
- The filter supports two scopes:
  - **Main agent filter**: sessions whose effective main agent matches the selected agent (resolved from `sessions.agentId` or scoped main binding).
  - **Participating agent filter**: sessions where the selected agent appeared in any run in that session (including subagent runs).
- Users can group sessions by project. Group headers are project names; sessions with no project appear under `No Project`.

### Session run tree view

Each session row can be expanded into a run hierarchy tree derived from `runs.parentRunId`:

- Root node is the session's top-level run.
- Child nodes are spawned subagent runs.
- Each node shows agent name, run state, and timestamp.
- Selecting a node opens that run's trace/HUD context while staying in the same session.

The tree is read-only navigation metadata. It does not create a separate conversation thread; all user-visible conversation messages remain in the session.

### Plan approval inline

When the main agent proposes a plan, the chat thread renders it as a structured approval card:

- Summary
- Task graph or sub-task list
- Estimated cost and time
- Approve
- Request revision
- Cancel

Users do not need to leave chat to approve the next step.

### Live run HUD

The workbench shows a live run HUD with:

- Active agent
- Current round
- Running tool
- Subagents in progress
- Token and cost budget
- Pending approvals
- Blocked state reasons

### Right panel

The right panel is always visible and uses the same set of tabs in all modes. Tab content adapts to what is relevant for the current mode and active run. The panel is partially implemented; some tabs are functional, others are planned.

| Tab         | Agent mode                                                                                | Research mode                 | Plan mode                     | Chat mode              |
| ----------- | ----------------------------------------------------------------------------------------- | ----------------------------- | ----------------------------- | ---------------------- |
| **Files**   | Changed files list, unified diff preview                                                  | Read-only file browser        | Read-only file browser        | Read-only file browser |
| **Run HUD** | Agent, round, active tool, subagents, token+cost budget, pending approvals, blocked state | Progress events, source count | Plan graph, estimate summary  | —                      |
| **Memory**  | Context window inspector, active memory refs                                              | Active memory refs            | Active memory refs            | Active memory refs     |
| **Task**    | Linked task, sub-tasks, approval controls, evaluator status                               | Linked task                   | Linked task, success criteria | Linked task            |
| **PR**      | Pull request status, diff summary, pending review items                                   | —                             | —                             | —                      |

On mobile, the right panel collapses into a bottom sheet tab drawer.

### Inline approvals and answers

Approval requests and `ask_user` questions render inline in the thread, but are also reflected in the global Review Inbox. Resolving from either place updates the same durable state.

### Diff and artifact preview

When a coding run changes files or saves artifacts, the workbench can show:

- Changed files list
- Unified diff preview
- Artifact version timeline
- Evaluator findings linked to files or deliverables

### Research report view

Research results render as:

- Executive summary
- Sectioned report
- Inline citations
- Clickable source drawer
- Plan-to-report trace

### Pull request review view

Pull requests render as first-class review objects:

- Title, branch, and status
- Diff summary
- Evaluation verdict
- Testing status
- Approve to open draft pull request
- Request changes back to agent

### Interrupt and redirect controls

Users can intervene mid-run from chat:

- Pause run
- Cancel run
- Answer question
- Approve or deny tool request
- Convert current conversation into a formal task
- Spawn follow-up research or evaluator pass

### Mobile and compact layout

On mobile, the right panel collapses into a bottom sheet or tab drawer. The workbench preserves the same actions, but prioritizes the thread and current blocker state.

## Behavior Contracts

- A plan approval card is rendered from task state, not from transient chat text.
- Approval actions from chat and review inbox mutate the same durable records.
- A blocked run always shows its blocker reason in the HUD.
- Workbench mode affects defaults and UI chrome, not permissions by itself.
- The workbench remains usable on mobile with a collapsible context panel.
- A pull request card shown in chat is always backed by a durable `pullRequests` row.
- Session list agent filters are deterministic: identical filter inputs over unchanged data produce identical session ordering and counts.
- Project grouping never duplicates a session across groups; each session appears exactly once under its current `projectId` or `No Project`.
- Run tree nodes are derived from durable `runs` lineage (`id`, `parentRunId`, `sessionId`) and are never inferred from transient UI state.

## Roles & Permissions

| Action                           | Who can do it      |
| -------------------------------- | ------------------ |
| View own workbench sessions      | Authenticated user |
| Approve own plan or tool request | Owner user, admin  |
| Resolve another user's item      | Admin only         |
| View admin observability panes   | Admin only         |

## Rewrite Authority

The current implementation is a baseline, not a constraint. This domain may be rewritten, restyled, reorganized, or replaced as needed to achieve the target product quality. No code path is off-limits if behavior contracts, safety controls, tests, and documentation remain correct.

## UI Contract

This domain follows [../ui/spec.md](../ui/spec.md) and defines the primary app-shell experience.

- Surfaces: session list (with agent filter, project grouping, and expandable run tree), chat thread canvas, composer, mode selector, live run HUD, inline action cards, and mode-aware right panel tabs.
- States and badges: running, blocked, needs-input, queued interjection, completed, failed, and pending approvals count.
- Blocking actions: plan approvals, tool approvals, and ask_user responses must resolve through durable review items.
- Mobile behavior: right panel collapses to bottom-sheet tabs; blocking cards remain visible near composer; session tree uses progressive disclosure to avoid deep nested panes.

## References

- [../ui/spec.md](../ui/spec.md) - cross-domain UX contracts, layout shells, and interaction standards
- [../tasks/spec.md](../tasks/spec.md) - plan approval and task steering
- [../runs/spec.md](../runs/spec.md) - durable run state and blockers
- [../research/spec.md](../research/spec.md) - deep research progress and report rendering
- [../observability/spec.md](../observability/spec.md) - review inbox and human-required actions
- [../projects/spec.md](../projects/spec.md) - artifacts and version history
- [../source-control/spec.md](../source-control/spec.md) - pull request review objects
