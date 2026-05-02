# Chat Spec

## Overview

Chat is AgentStudio's primary user interface: a chat-first control plane for planning, executing, inspecting, and approving agent work. It is not just a message list. It is the unified surface where users choose work mode, review plans, watch live progress, inspect artifacts and diffs, answer agent questions, approve risky actions, and review pull requests without leaving the chat flow.

This domain exists because the runtime, tasks, runs, research, projects, and review inbox specs define backend primitives, but users still need one coherent UI shell that turns those primitives into a product comparable to Claude, Gemini, and long-running agent apps.

## Data Model

Chat is primarily a composition domain. It reads from:

- `sessions`
- `runs`
- `tasks`
- `reviewItems`
- `research`
- `artifactVersions`
- `pullRequests`

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

### `conversations.mode` column (extended)

The `conversations` table (owned by the chat domain) carries a `mode` column (`chat | research | plan | agent`) that records the active mode at the time of each session. Mode switches are recorded as system messages in the conversation history.

## Features

### Composer modes

The composer supports four explicit modes, each representing a distinct cognitive stance:

| Mode       | Intent                                                                                       | Assumption level |
| ---------- | -------------------------------------------------------------------------------------------- | ---------------- |
| `chat`     | Conversational — direct answers, minimal tool use, collaborative pushback                    | Low              |
| `research` | Skeptical investigation — surfaces uncertainty, cites sources, asks before acting            | Minimal          |
| `plan`     | Structured proposal — produces a plan with success criteria before any execution             | Medium           |
| `agent`    | Autonomous execution — proceeds on best interpretation, interrupts only for genuine blockers | High             |

Mode selection affects the orchestrator's identity prompt (loaded from an editable skill), which tools are available, which companion skills auto-load, and which right-panel UI is shown. Modes are **not** skills — the identity prompt backing each mode is stored as a skill so it can be edited without code changes, but the mode itself is a session-level behavioral contract.

The mode selector appears in the composer toolbar. Switching mode mid-conversation injects a system anchor message so the model understands its posture has changed. Context (prior messages, plans, research findings) is always preserved across mode switches.

Default mode is set in `chatWorkbenchPreferences.defaultMode`. The intended workflow is:

```
Research mode → surface findings, challenge the premise
    ↓ user satisfied with direction
Plan mode → propose implementation with success criteria
    ↓ user approves plan
Agent mode → execute, minimal interruptions
```

### Plan approval inline

When the orchestrator proposes a plan, the chat thread renders it as a structured approval card:

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

### Mode-aware right panel

The right panel is mode-aware.

**Chat mode:** session details, linked task, linked project.

**Research mode:** source list, plan steps, progress events, report outline.

**Code mode:** changed files, diff summary, workspace info, evaluator status, pull request status.

**Review mode:** review items, pull request metadata, findings, approval controls.

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

## Roles & Permissions

| Action                           | Who can do it      |
| -------------------------------- | ------------------ |
| View own workbench sessions      | Authenticated user |
| Approve own plan or tool request | Owner user, admin  |
| Resolve another user's item      | Admin only         |
| View admin observability panes   | Admin only         |

## References

- [../tasks/spec.md](../tasks/spec.md) - plan approval and task steering
- [../runs/spec.md](../runs/spec.md) - durable run state and blockers
- [../research/spec.md](../research/spec.md) - deep research progress and report rendering
- [../observability/spec.md](../observability/spec.md) - review inbox and human-required actions
- [../projects/spec.md](../projects/spec.md) - artifacts and version history
- [../source-control/spec.md](../source-control/spec.md) - pull request review objects
