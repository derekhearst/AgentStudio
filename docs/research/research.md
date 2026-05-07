# Research

## Overview

The Research domain lets a user kick off a thorough, cited investigation that runs in the background while they keep working. The user switches the chat to the **Research agent**, asks a substantive question, reviews the proposed sub-questions in the right sidebar, clicks **Approve**, and ~10–15 minutes later receives a notification with a finished, cited report stored as an artifact.

Two flows produce a research run today:

1. **Agent-driven (primary)** — User asks the Research agent a question; it calls `propose_research_plan` with sub-questions; the user approves in the sidebar; a background research job runs.
2. **Direct (legacy)** — Programmatic callers (automations, the `/research` index page form) invoke `startResearchCommand` to enqueue a run without an approval gate. The orchestrator generates its own sub-questions in this path.

Both flows converge on the same orchestrator (`runResearchLoop`) and the same `research` row, so the trace UI and artifact feed see one unified shape.

## Key concepts and entities

- **Research run** — One investigation, top-level row in the `research` table. Carries status, the sub-question plan, the final report, cumulative cost, and links back to the originating conversation and chat run.
- **Sub-questions** — A list of 4–8 concrete, googleable questions that decompose the user's query. Either user-approved (agent-driven flow) or planner-generated (direct flow).
- **Research source** — Each web page or PDF the orchestrator fetched. Stores the extracted text (capped at ~50k characters), title, URL, and a flag that flips to `true` once the synthesis stage cites the source in the final report.
- **Research step** — Append-only trace of every action: plan generated, search issued, page fetched, reflection round, synthesis emitted. Drives the live trace UI.
- **Cited report** — The final markdown deliverable. Contains an executive summary, 4–8 thematic sections, inline `[N]` citations resolving to `researchSources`, and a sources list at the bottom.
- **Notification** — Fires on successful completion: an in-app `notifications` row plus, when VAPID keys are configured, a web push to subscribed devices linking to `/research/{id}`.

## Status lifecycle

`planning → searching → fetching → reflecting → synthesizing → complete`

Failure transitions to `failed` (with `error` populated). User cancellation transitions to `canceled`. The runner re-checks the row's status at every safe boundary, so a cancel mid-flight stops at the next phase boundary rather than burning the rest of the budget.

## User flows

### A) Agent-driven plan-then-approve

1. User opens a chat, picks the **Research** agent in the AgentSelector.
2. User types a substantive question and sends it.
3. The Research agent generates a plan via the `propose_research_plan` tool (summary + 4–8 sub-questions + optional rationale).
4. The chat runtime pauses on the `propose_research_plan` tool call (it's in `MANDATORY_APPROVAL_TOOLS`). The plan appears in the right sidebar with **Approve** and **Decline** buttons.
5. The user picks one of three paths:
   - **Approve** — The tool unblocks; the handler creates a `research` row with `plan` pre-seeded, enqueues a `research_run` job, and returns a tool result with the new `researchId`. The agent emits a one-line "Research started" message; the sidebar flips to the Running state and starts polling the detail query every 3 seconds.
   - **Decline** — The tool unblocks with a denied result. The agent reads "Tool execution was denied by user" and waits for the user's next input.
   - **Reply in the chat** — The composer detects a pending plan, automatically calls Decline, then sends the user's reply as the next turn. The agent reads the feedback (along with the denied tool result) and proposes a revised plan.
6. While the run is in flight, the sidebar shows the live status, sub-question list, source count, and a Cancel button. The user can navigate to `/research/[id]` for the full live trace.
7. When the orchestrator hits `complete`, the job handler writes a notification row and (when configured) sends a web push to the user's subscribed devices. The sidebar flips to the Complete state with an "Open report" link. The cited report is also visible in `/artifacts` as a research-typed item.

### B) Direct creation (legacy / programmatic)

1. A caller invokes `startResearchCommand({ query, conversationId?, runId?, model? })` — used by the `/research` index page's form, automations, and any other server-side entry point that doesn't go through the chat agent.
2. A `research` row is created with empty `plan` and a `research_run` job is enqueued.
3. The orchestrator runs all five phases including the planner LLM call (since `plan` is empty).
4. Same completion path as the agent-driven flow.

### C) Discussion of completed reports

The Research agent isn't only an initiator — once a report is in the conversation context, the agent answers follow-up questions about the findings without re-proposing a plan. It cites sources, distinguishes "established / contested / speculative" claims, and surfaces disagreements between sources rather than flattening them.

## Roles and permissions

- **Owner (per row)** — Set on creation from the requesting user. All read/cancel operations enforce ownership at the remote-function boundary; cross-user access returns 403-equivalent errors.
- **Research agent** — Has read-only tool access (`READ_ONLY_TOOL_NAMES` allowlist). Can call `propose_research_plan`, `web_search`, `web_fetch`, `pdf_read`, and other read-only tools. Cannot edit files, write artifacts, or run shell — for those, the user switches to the Chat or Autonomous agent.
- **Mandatory approval** — `propose_research_plan` is in `MANDATORY_APPROVAL_TOOLS`, meaning the runtime requires explicit user approval regardless of per-user `approvalRequiredTools` settings. In detached/automation runs without an approval surface, the tool fails closed.
- **Job worker** — Picks up `research_run` jobs from the durable queue and runs `runResearchLoop`. Cancellation flows through both the worker's `checkCancellation` callback and a direct check of the `research.status` column on every phase boundary.

## Integrations

- **LLM (chat.server / OpenRouter)** — Used in three phases: planner (only when `plan` is empty), reflection (per round), and synthesizer. Cost is logged per-call to the usage ledger; the cumulative spend is rolled up onto `research.costUsd`.
- **Web search + fetch** — `web_search` returns ~8 hits per sub-question; `web_fetch` reads up to `maxFetchChars` per page. Fan-out is capped at `PARALLEL_FETCH_CONCURRENCY × urlsPerQuestion` so wall-clock stays sane.
- **Job queue (`jobs` table)** — `research_run` is the registered handler. Priority defaults to 150 (above background work). Lease/heartbeat lifecycle is the standard durable-job pattern.
- **Notifications (`notifications`, `pushSubscriptions` tables)** — In-app row created on every successful completion; web push fires when VAPID keys are present.
- **Artifacts feed (`/artifacts`)** — Reads research rows directly and projects them as `kind: 'research'` items. No separate artifact row is created; the research detail page at `/research/[id]` is the canonical view.

## Business rules

- **Plan size**: 2–12 sub-questions accepted by the tool schema; the orchestrator caps at `config.maxSubQuestions` (default 8) on the planner-generated path.
- **Sub-question shape**: each must be 1–300 characters and concrete (the agent's identity skill instructs it to avoid vague "what is X?" questions).
- **Source cap**: the reflection loop bails when `researchSources` count reaches `config.maxTotalSources` (default 32) so a model that hallucinates infinite gaps can't run away with the cost.
- **Reflection rounds**: capped at `config.maxReflectionRounds` (default 3). An empty gap list ends the loop early.
- **Per-source extracted text cap**: ~50k chars by default (`config.maxFetchChars`). Content beyond is truncated; the source row sets `truncated=true`.
- **Cited only**: the synthesizer is required to cite every factual claim with `[N]`. Sources not referenced in the final report stay with `citedInReport=false` in the table — useful for audit / improvement, hidden from the artifact feed by default.
- **Pre-seeded plan**: when `research.plan` is non-empty at the start of `runResearchLoop`, Phase 1 is skipped and the plan is used as-is. Recorded as a step with `payload.phase = 'preapproved'` so the trace UI is honest about source.
- **Refine-via-reply**: while a `propose_research_plan` is awaiting approval, sending a chat message in the composer auto-Declines the plan first. The agent receives a "denied" tool result followed by the user's new turn and can propose a revised plan in the next round.
- **Cancellation**: idempotent — `cancelResearchCommand` flips `research.status` and cancels the underlying `research_run` job. The runner notices both signals at the next safe boundary.
- **Notification on success only**: failed/canceled runs do NOT fire a notification (the user already knows; the sidebar shows the failure state if open).
