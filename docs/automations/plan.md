# Automations Plan

Status: active

## Overview

AgentStudio already has an automation folder and UI, but the current implementation is a thin cron scheduler that appends a generated prompt into a chat conversation and calls the model inline. This plan upgrades automations into durable, jobs-backed agent workflows that can launch research tasks, coding tasks, maintenance runs, or chat follow-ups with budget, review, and output routing.

> **Depends on:** `docs/jobs/plan.md`, `docs/tasks/plan.md`, `docs/research/plan.md`, `docs/source-control/plan.md`, `docs/observability/plan.md`.

> **See also:** [spec.md](spec.md) - full feature spec, data model, and behavior contracts.

## Why this matters

Your competitor-scouting agent is fundamentally an automation product:

- Scheduled
- Long-running
- Research-heavy
- Optionally repository-aware
- Approval-gated
- Output needs to land in chat, tasks, projects, or pull requests

The current implementation is too lightweight for that workflow.

## Current state

Based on the current code:

- Schema is `description + cron + prompt + optional agent + conversation reuse`
- Execution is inline model call from the automation engine
- Cron endpoint directly checks and runs due automations
- There is no jobs integration
- There is no task creation
- There are no budget caps
- There is no review inbox integration
- There is no repository or pull request awareness

## Desired state

- Automations enqueue jobs instead of running inline.
- Automations can create tasks, research runs, or maintenance workflows.
- Output routing is explicit.
- Review and budget controls are durable.
- Automation history is inspectable.

## Phases

### Phase 1 - Rename and align the domain

**Goal:** Move from the current singular implementation to the future plural domain without breaking the app.

**Files to modify:**

- `src/lib/automation/` -> `src/lib/automations/`
- Temporary compatibility barrel in old path per structure plan
- `src/routes/automations/+page.svelte` imports

**Notes:**

- Preserve existing UI and commands during the rename.
- Treat current schema and server helpers as compatibility scaffolding.

**Verification:**

- Existing `/automations` page still loads after the rename.
- Existing create, update, delete flows still work.

---

### Phase 2 - Jobs-backed execution

**Goal:** Replace direct inline execution with durable jobs.

**Files to create:**

- `src/lib/automations/automations.schema.ts` - expanded automations schema plus `automationRuns` and `automationDeliveries`
- `src/lib/automations/automations.server.ts` - CRUD helpers and execution orchestration

**Files to modify:**

- `src/lib/automations/engine.ts` - become scheduler adapter that enqueues `automation_execute` jobs
- `src/lib/jobs/handlers/` - add automation execution handler
- `src/routes/api/cron/+server.ts` - enqueue due jobs instead of running the prompt inline

**Verification:**

- Due automation creates a job and an `automationRuns` row.
- Failed execution is visible as durable history, not just endpoint output.

---

### Phase 3 - Rich trigger and output model

**Goal:** Move from `cron + prompt replay` to typed workflow definitions.

**Files to modify:**

- Automations schema and UI
- Automations create and update commands

**New model elements:**

- Trigger type and trigger config
- Mode
- Output target
- Optional project and repository context
- Monthly budget cap

**Verification:**

- User can create a manual, cron, or event-driven automation.
- User can choose whether output lands in chat, task, artifact, or review.

---

### Phase 4 - Research and code workflow support

**Goal:** Make automations capable of launching the actual product workflows you want.

**Files to modify:**

- `src/lib/automations/automations.server.ts` - route execution by mode
- `src/lib/research/` - accept automation-triggered runs
- `src/lib/tasks/` - allow automation-created tasks
- `src/lib/source-control/` - allow repo-aware coding automations

**Modes:**

- `research` -> create research record or research task
- `code` -> create coding task against repo-backed environment
- `chat_followup` -> append into an existing session
- `maintenance` -> internal product housekeeping

**Verification:**

- Weekly research automation creates a research artifact or task.
- Repository-aware code automation creates a coding task instead of raw inline prompt replay.

---

### Phase 5 - Budget, approvals, and review integration

**Goal:** Ensure automations are governable.

**Files to modify:**

- `src/lib/policies/` - policy evaluation for automation-triggered actions
- `src/lib/observability/review.server.ts` - blocked automation and budget review items
- `/automations` UI - show budget, last failures, next run, review blockers

**Controls:**

- Monthly budget cap
- Approval before risky code execution
- Approval before push or pull request creation
- Retry failed run
- Run now
- Pause and resume

**Verification:**

- Budget overage blocks a scheduled automation and creates a review item.
- Approval-gated repository automation waits for human confirmation before creating a pull request.

## Verification

1. Create a weekly research automation for competitor harness updates.
2. Confirm it enqueues a job instead of running inline.
3. Confirm the run creates a research record and final report.
4. Confirm monthly budget overage blocks a future run.
5. Confirm a repository-aware code automation can open a draft pull request only after approval.

## Rewrite Authority

The current implementation is a baseline, not a constraint. This domain may be rewritten, restyled, reorganized, or replaced as needed to achieve the target product quality. No code path is off-limits if behavior contracts, safety controls, tests, and documentation remain correct.

## UI Contract

Implementation in this domain must comply with [../ui/plan.md](../ui/plan.md) and [../ui/spec.md](../ui/spec.md).

- Include UX acceptance criteria for desktop and mobile behavior.
- Include compactness/density behavior where relevant.
- Include approval, question, and interruption flows where relevant.

## Completion

- 2026-05-05 — Wave 5 #21 phase 4 finish (code-mode dispatch) — `runCodeModeAutomation` in [src/lib/automations/engine.ts](../../src/lib/automations/engine.ts) creates a task carrying `repository_id` forward when an automation has `mode='code'` + `repositoryId` + `agentId`. The task runner provisions the per-attempt worktree (Wave 5 #19 P2 finish). Destructive tools refuse in non-chat_stream contexts so code-mode automations queue work for human review and never auto-push. New `automations.repository_id` column via [drizzle/0045_automation_repository_id.sql](../../drizzle/0045_automation_repository_id.sql); `createAutomationCommand` / `updateAutomationCommand` now accept `mode` + `outputTarget` + `repositoryId`. 5 contract tests in [tests/automations.code-mode.spec.ts](../../tests/automations.code-mode.spec.ts). **Wave 5 #21 is fully closed.**
- 2026-05-04 — Wave 5 #21 phase 4 (output routing) — `routeMaintenanceOutput` in [src/lib/automations/engine.ts](../../src/lib/automations/engine.ts) wires every `automation_output_target` enum value for maintenance-mode runs: `chat_session` (default) appends the summary as an assistant message into the automation's conversation; `review_inbox` opens an `automation_summary` review item (deduped per-hour by automation id); `task` creates a pending task with the summary as the spec; `artifact` writes a versioned artifact when the conversation has a bound project (skipped + logged with a structured marker if no project is bound). New review_item enum value via [drizzle/0043_automation_summary_enum.sql](../../drizzle/0043_automation_summary_enum.sql); `/review` filter dropdown gets an "Automation summary" entry. 4 contract tests in [tests/automations.output-routing.spec.ts](../../tests/automations.output-routing.spec.ts).
- 2026-05-04 — Wave 5 #21 phase 4 (mode dispatch slice) — `runAutomationById` now branches on `automation.mode`. Research mode creates a `research` row + enqueues a `research_run` job (Wave 4 #18 orchestrator owns the report write); maintenance mode runs an LLM synthesis without persisting messages (operators inspect via lifecycle metrics); code mode falls through to chat_followup with an info log until #19 P2 finish lands the worktree integration. Lifecycle metrics emit with `mode` + `outputTarget` dimensions so /review/health distinguishes throughput by mode. See `runResearchModeAutomation` + `runMaintenanceModeAutomation` in [src/lib/automations/engine.ts](../../src/lib/automations/engine.ts); 3 dispatch tests in [tests/automations.mode-dispatch.spec.ts](../../tests/automations.mode-dispatch.spec.ts).
- 2026-05-04 — Wave 5 #21 phase 5 (budget gate slice) — `runAutomationById` pre-checks `checkBudgetLimits` before doing any work; blocked runs persist a `block` budget_alert, open a `policy_override_request` review item (deduped by `budget:<limitId>:<userId>:<automationId>`), advance the schedule, and emit an `automations.lifecycle.blocked` metric. See [src/lib/automations/engine.ts](../../src/lib/automations/engine.ts) `handleAutomationBudgetBlocked`. 3 tests in [tests/automations.budget-gate.spec.ts](../../tests/automations.budget-gate.spec.ts). Approval gates (per-automation `requireApproval` flag) remain deferred — the budget side of P5 is the concrete operator-visible surface today; per-action approvals (push, PR) belong with the source-control write-tools work in #19.



