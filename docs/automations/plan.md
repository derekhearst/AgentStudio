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

## Completion

- Template: YYYY-MM-DD - Completed in <PR/commit> - <one-line outcome>
- Pending.


