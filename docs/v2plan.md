# DrokBot v2 — Feature Roadmap

> 25 features across 8 phases. Each phase builds on the previous, grouped by dependency and domain.

## Implementation Status

| Feature                        | Status         |
| ------------------------------ | -------------- |
| A1. Cost Dashboard             | ✅ Done        |
| A2. Agent Run Trace Viewer     | ✅ Done        |
| A3. Activity Feed              | ✅ Done        |
| B1. Changes Requested State    | ✅ Done        |
| B2. Task-Level Chat Threads    | ✅ Done        |
| B3. Review Type Classification | ✅ Done        |
| B4. Review Queue               | ✅ Done        |
| C1. Smart Model Routing        | ✅ Done        |
| C2. Scheduled Agent Templates  | ❌ Not started |
| C3. Self-Improvement Loop      | ❌ Not started |
| D1. File Uploads + Vision      | ✅ Done        |
| D2. Image Generation           | ✅ Done        |
| D3. Svelte Artifact System     | ❌ Not started |
| D4. Design Generation          | ❌ Not started |
| E1. A2A Protocol               | ❌ Not started |
| E2. Agent Teams                | ❌ Not started |
| F1. Test Runner Service        | ❌ Not started |
| F2. Test Recording Artifacts   | ❌ Not started |
| F3. Test Gate Enforcement      | ❌ Not started |
| F4. Agent-Written Tests        | ❌ Not started |
| G1. MCP Endpoint               | ✅ Done        |
| G2. Interactive Browse Mode    | ✅ Done        |
| G3. Pipeline View              | ❌ Not started |
| G4. Project Board              | ❌ Not started |
| H1. Repo Management            | ❌ Not started |

## Phase Overview

| Phase | Name                            | Features                                                                     | Dependencies                    |
| ----- | ------------------------------- | ---------------------------------------------------------------------------- | ------------------------------- |
| **A** | Data Foundation & Observability | Cost Dashboard, Agent Run Trace Viewer, Activity Feed                        | None (standalone)               |
| **B** | Enhanced Task Workflow          | Changes Requested, Task Chat Threads, Review Types, Review Queue             | None (standalone)               |
| **C** | Agent Intelligence              | Smart Model Routing, Scheduled Agent Templates, Self-Improvement Loop        | Phase A                         |
| **D** | Content & Media                 | File Uploads + Vision, Image Generation, Svelte Artifacts, Design Generation | D4 needs D3 + B                 |
| **E** | Agent Collaboration             | A2A Protocol, Agent Teams                                                    | Phase C                         |
| **F** | Testing Infrastructure          | Test Runner, Test Recording, Test Gates, Agent-Written Tests                 | Phase B, F1 first               |
| **G** | Visualization & External        | MCP Endpoint, Interactive Browse, Pipeline View, Project Board               | G1/G2 standalone, G3/G4 need E2 |
| **H** | Self-Management Capstone        | Repo Management                                                              | Phases C + E + F                |

**Can start in parallel:** A, B, D1/D2, G1, G2

---

## Phase A: Data Foundation & Observability

### A1. Cost Dashboard

- Aggregate `messages.cost`, `conversations.totalCost`, `agentRuns.cost` into daily/weekly/monthly views
- New route `/dashboard/cost` with model-level breakdown, per-conversation cost, tool cost
- Budget alerts: add `budget` fields to `appSettings` (daily/monthly limits), push notify at 80%/100%
- Lightweight chart library (Chart.js or similar)

### A2. Agent Run Trace Viewer

- Build step-by-step timeline from existing `agentRuns.logs` JSONB array
- New route `/agents/[id]/runs/[runId]`: tool call I/O, timing waterfall, cost per step, delegation arrows
- Collapsible tree view for parent→child delegation chains
- Link from task detail to associated run traces

### A3. Activity Feed

- Chronological stream: task status changes, agent actions, memory ops, dream cycles, chat starts
- New DB table `activityEvents(id, type, entityId, entityType, summary, metadata, createdAt)`
- Route `/activity` with infinite scroll + type filters
- Reusable dashboard widget

---

## Phase B: Enhanced Task Workflow

### B1. Changes Requested State

- Add `changes_requested` to `taskStatusEnum`
- "Request Changes" button with comment → new `taskComments` table
- Agent picks up `changes_requested` tasks, re-reads comment, iterates, resubmits to `review`
- Scheduler treats `changes_requested` like `pending`

### B2. Task-Level Chat Threads

- New `taskMessages(id, taskId, role, content, createdAt)` table
- Chat panel in task detail sidebar
- Agent system prompt includes task context + thread history

### B3. Review Type Classification

- Add `reviewType` enum: `heavy` (diff viewer), `quick` (inline preview), `informational` (read-only)
- Agent auto-classifies based on output type
- Different detail views per type

### B4. Review Queue

- Mobile-first swipe interface at `/review`
- Swipe right = approve, left = request changes, up = skip
- Badge count on nav

---

## Phase C: Agent Intelligence

### C1. Smart Model Routing

- `src/lib/server/llm/router.ts` — classify query complexity → cheap/frontier model
- Budget-aware downgrade near spending limits
- Configurable in settings

### C2. Scheduled Agent Templates

- Pre-built JSON configs (repo monitor, daily briefing, etc.)
- New `agentTemplates` table with cron-style scheduling
- Template browser at `/agents/templates`

### C3. Self-Improvement Loop

- Research Agent → creates tasks → Coding Agent implements → user approves
- All self-improvement tasks require manual review

---

## Phase D: Content & Media

### D1. File Uploads with Vision

- Upload endpoint `/api/upload` — images, PDFs, spreadsheets
- `attachments` JSONB on `messages` schema
- Vision models via OpenRouter, PDF extraction via sandbox

### D2. Image Generation

- Tool `image_generate(prompt, model, size)` via OpenRouter/Replicate
- Inline rendering in chat, cost tracking

### D3. Svelte Artifact System

- `:::artifact` fenced output → compile in sandbox → sandboxed iframe
- "Save as Component" promotion workflow → git PR

### D4. Design Generation

- Multiple wireframe variations as Svelte artifacts
- Gallery view on task board, selection feeds back into implementation
- Depends on D3 + Phase B

---

## Phase E: Agent Collaboration

### E1. A2A Protocol Support

- Structured agent-to-agent communication: `AgentCard`, `Task`, `Message`, `Artifact` types
- Protocol layer replaces raw delegation

### E2. Agent Teams

- `agentTeams` + `agentTeamMembers` tables
- Shared objectives, dependency-aware scheduling, team observability
- Multiple concurrent teams

---

## Phase F: Testing Infrastructure

### F1. Test Runner Service

- Sandbox runs Playwright, new `run_tests` agent tool
- Structured results stored on task records

### F2. Test Recording Artifacts

- Video + screenshots from test runs stored on tasks

### F3. Test Gate Enforcement

- Failing tests block approval (configurable strict/advisory)
- Depends on F1 + B3

### F4. Agent-Written Tests

- Coding agent writes Playwright tests per task
- Depends on F1 + C3

---

## Phase G: Visualization & External Integration

### G1. MCP Endpoint

- Expose tools + memory as MCP server at `/api/mcp`
- API key auth — standalone, anytime

### G2. Interactive Browse Mode

- Split UI: live browser viewport + agent chat via WebSocket
- User can intervene in viewport — standalone

### G3. Pipeline View

- Horizontal swimlanes at `/pipeline` — team workflow stages
- Depends on E2

### G4. Project Board

- High-level view at `/projects` — cost/velocity metrics, timeline
- Depends on E2 + G3

---

## Phase H: Self-Management Capstone

### H1. Repo Management

- GitHub API tool: releases, README updates, issue triage, changelog
- Agent templates for repo management tasks
- Depends on C3 + E2 + F2

---

## Dependency Graph

```
A (Observability)  ────→ C (Intelligence) ────→ E (Collaboration) ────→ G3/G4 (Pipeline/Project)
                                           ────→ H (Self-Management)

B (Task Workflow)  ────→ F3 (Test Gates)
                   ────→ D4 (Design Gen)

D3 (Artifacts)     ────→ D4 (Design Gen)

F1 (Test Runner)   ────→ F2/F3/F4

G1 (MCP), G2 (Browse) ────→ standalone (anytime)
```

## Verification Strategy

1. Each phase adds Playwright E2E tests for new routes/workflows
2. Schema changes via Drizzle migrations, validated with `bun run check`
3. All new external integrations must support `E2E_MOCK_EXTERNALS=1`
4. Manual smoke tests on mobile (PWA) and desktop

## Decisions

- Single user remains — no multi-user, no RBAC
- Docker-first — new services run inside/alongside the container
- OpenRouter primary — Replicate secondary for image gen
- No breaking schema changes — all additive
- Artifact sandboxing — iframes with strict CSP
- Self-improvement requires human approval — no auto-merge
