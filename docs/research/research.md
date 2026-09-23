# Research

## Overview

The Research domain covers two ways of getting a thorough, cited answer to a question.

1. **Research in a chat (primary)** — The user switches the chat to the **Research agent** and asks a substantive question. The Research agent writes a research plan to a file, posts it, and asks the user to approve handing the work to another agent — the Chat agent unless the user asks for a different one. On approval the conversation switches to that agent, which reads the plan and carries out the research in the chat, with web search, page reading and PDF reading, and answers with citations.
2. **Background research runs** — A research-mode automation (or any caller of `startResearchCommand`) creates a research run. A background job plans sub-questions, searches, reads pages, looks for gaps and writes a cited report. The user gets a notification when it is done and reads the report at `/research/{id}`.

The two do not overlap: approving a Research agent's plan does not start a background run, and a background run never asks for approval.

The Research agent hands off exactly the way the Plan agent does. See [Agents — Hand a plan over from Plan or Research](../agents/agents.md#hand-a-plan-over-from-plan-or-research) for the shared handoff, and [Agents — Built-in agents and their tools](../agents/agents.md#built-in-agents-and-their-tools) for what it may use.

The Research agent used to have its own `propose_research_plan` tool: the plan appeared in the right sidebar with Approve and Decline, and approving started a background run. That tool and its sidebar flow are gone; the Research agent now writes a plan file and hands off like Plan. There is no separate "research runner" agent.

## Key concepts and entities

- **Research plan file** — The markdown file the Research agent writes, usually `RESEARCH-PLAN.md`. It holds a one- or two-sentence summary, 4–8 concrete sub-questions and an optional rationale. The agent also posts the plan in its reply, so the user can read it without opening the file.
- **Handoff** — The Research agent's call to `request_plan_approval` with the plan file and the full id of the agent that should do the research. The user approves or denies it on a card in the chat.
- **Research run** — One background investigation, a row in the `research` table. Carries status, the sub-question plan, the final report, cumulative cost, and links back to the originating conversation and chat run. Only background runs create one; research done in a chat lives in the conversation.
- **Sub-questions** — 4–8 concrete, searchable questions that break the user's question down. In a chat the Research agent writes them into its plan file. In a background run the planner step generates them.
- **Research source** — Each web page or PDF a background run fetched. Stores the extracted text (capped at ~50k characters), title, URL, and a flag that flips to `true` once the synthesis stage cites the source in the final report.
- **Research step** — Append-only trace of every action in a background run: plan generated, search issued, page fetched, reflection round, synthesis emitted. Drives the live trace UI.
- **Cited report** — The final markdown deliverable of a background run. Contains an executive summary, 4–8 thematic sections, inline `[N]` citations resolving to `researchSources`, and a sources list at the bottom.
- **Notification** — Fires when a background run completes: an in-app `notifications` row plus, when VAPID keys are configured, a web push to subscribed devices linking to `/research/{id}`.

## Status lifecycle (background runs)

`planning → searching → fetching → reflecting → synthesizing → complete`

Failure transitions to `failed` (with `error` populated). User cancellation transitions to `canceled`. The runner re-checks the row's status at every safe boundary, so a cancel mid-flight stops at the next phase boundary rather than burning the rest of the budget.

## User flows

### A) Research in a chat: plan, approve, hand off

1. The user opens a chat and picks the **Research** agent in the agent selector.
2. The user asks a substantive question.
3. The Research agent writes its plan to a markdown file with `Write` — usually `RESEARCH-PLAN.md` — and posts the same plan in its reply.
4. It calls `request_plan_approval` with the file's path and the full id of the agent that should carry out the research. That is the Chat agent unless the user asked for another one. The Chat agent's id is always given to it; for any other agent it looks the id up with `list_agents`.
5. An approval card appears in the chat. It always appears, whatever the chat's approval settings.
   - **Approve** — The plan file is read (the handoff fails if the file does not exist), the conversation switches to the chosen agent, and a note in the conversation tells that agent which plan file was approved. That agent reads the plan and does the research in the chat, using `web_search`, `web_fetch` and `pdf_read`, then answers with citations.
   - **Deny** — The Research agent stays. The user usually replies with what to change; the agent rewrites the plan file and asks again.
6. The research and its answer stay in the conversation. No research run is created, nothing is added to `/research`, and no notification is sent.

For a trivial lookup (a definition, a current price, a single fact) the Research agent skips the plan and answers directly with `web_search`. It does the same when the user asks for a quick answer.

### B) Background research run

1. A **research-mode automation** fires, on its schedule or from **Run now**. It creates a `research` row with the automation's prompt as the question, links it to the automation's conversation, and queues a `research_run` job at priority 100.
   `startResearchCommand({ query, conversationId?, runId?, model? })` does the same for an interactive caller, at priority 150. The chat composer has a **Research** button built to call it, but the chat page does not currently turn that button on.
2. The job worker runs the orchestrator (`runResearchLoop`): it plans sub-questions, searches for each, reads the best pages, looks for gaps and searches again, then writes the cited report.
3. When the run completes, the user gets an in-app notification and, when configured, a web push. The report is at `/research/{id}` and listed on `/research`. If the run is linked to a conversation, that page's **Back** button and breadcrumb lead to the chat. The chat itself no longer lists its research runs: its right-hand rail lost the **Research** tab in #14, and the report is not posted into the chat.

### C) Discussion of completed reports

The Research agent isn't only an initiator. Once a report or earlier findings are in the conversation, it answers follow-up questions directly without writing a new plan. It cites sources, distinguishes "established / contested / speculative" claims, and surfaces disagreements between sources rather than flattening them.

## Roles and permissions

- **Owner (per row)** — Set on creation from the requesting user. All read and cancel operations on research runs enforce ownership at the remote-function boundary; cross-user access returns 403-equivalent errors.
- **Research agent** — Shares one allow-list of tools with the Plan agent (`READ_ONLY_TOOL_NAMES`): `web_search`, `web_fetch`, `pdf_read`, reading and searching files, `list_agents` and other read-only tools. On top of those it has `Write`, so it can write its plan file (a deliberate decision, issue #67), and `request_plan_approval`. It cannot run shell commands, edit files in place, push code or open pull requests.
- **Handoff approval** — `request_plan_approval` is in `MANDATORY_APPROVAL_TOOLS`, so the user must approve every handoff, in every permission mode. In automation runs and other runs with nobody to approve, it fails closed.
- **The agent that does the research** — Usually Chat, which has full tool access. Its own approval settings apply to what it does after the handoff.
- **Job worker** — Picks up `research_run` jobs from the durable queue and runs `runResearchLoop`. Cancellation flows through both the worker's `checkCancellation` callback and a direct check of the `research.status` column on every phase boundary.

## Integrations

- **LLM (chat.server / OpenRouter)** — Background runs use it in three phases: planner, reflection (per round), and synthesizer. Cost is logged per call to the usage ledger; the cumulative spend is rolled up onto `research.costUsd`. Research in a chat is ordinary chat turns, billed like any other.
- **Web search + fetch** — `web_search` returns ~8 hits per sub-question; `web_fetch` reads up to `maxFetchChars` per page. In a background run, fan-out is capped at `PARALLEL_FETCH_CONCURRENCY × urlsPerQuestion` so wall-clock stays sane.
- **Job queue (`jobs` table)** — `research_run` is the registered handler. Interactive runs use priority 150 and research-mode automations 100, so a scheduled report never gets ahead of one the user started. Lease/heartbeat lifecycle is the standard durable-job pattern.
- **Notifications (`notifications`, `pushSubscriptions` tables)** — In-app row created on every successful background run; web push fires when VAPID keys are present.
- **Research feed (`/research`)** — Reads research rows directly and projects them as `kind: 'research'` items alongside generated images. The research detail page at `/research/[id]` is the canonical view of a run.
- **Agents** — The Research agent's handoff uses the agents domain's `request_plan_approval` and `list_agents`; see [docs/agents/agents.md](../agents/agents.md).

## Business rules

- **Plan first, act after approval**: in a chat, the Research agent writes and posts a plan and waits for approval before any research is carried out. The agent that does the work starts by reading the approved plan file.
- **Every handoff is approved by the user**: there is no setting that skips the approval card, and a run with no one to approve it cannot hand off.
- **The plan file must exist**: approving a handoff whose plan file was never written fails, and the conversation stays with the Research agent.
- **Sub-question count**: the Research agent is told to write 4–8 sub-questions; this is guidance, not enforced. A background run's planner is capped at `config.maxSubQuestions` (default 8).
- **Sub-question shape**: each should be concrete and searchable; the agent's instructions steer it away from vague "what is X?" questions.
- **Source cap**: a background run's reflection loop stops when `researchSources` reaches `config.maxTotalSources` (default 32), so a model that keeps finding gaps can't run away with the cost.
- **Reflection rounds**: capped at `config.maxReflectionRounds` (default 3). An empty gap list ends the loop early.
- **Per-source extracted text cap**: ~50k chars by default (`config.maxFetchChars`). Content beyond is truncated; the source row sets `truncated=true`.
- **Public web only**: page reads go through the same egress guard as the `web_fetch` tool (see [tools spec — Web access safety](../tools/spec.md#web-access-safety-the-egress-guard)). A search hit that points at, or redirects to, a private, loopback or cloud-metadata address fails that fetch instead of becoming a source. Each page is read in its own throwaway browser session, so parallel fetches cannot mix up each other's pages.
- **Cited only**: a background run's synthesizer must cite every factual claim with `[N]`. Sources not referenced in the final report stay with `citedInReport=false` in the table — useful for audit and improvement, hidden from the report by default.
- **Pre-seeded plan**: when a research row already has sub-questions at the start of `runResearchLoop`, the planner step is skipped and those are used, recorded as a step with `payload.phase = 'preapproved'`. Nothing creates such a row today; the removed `propose_research_plan` flow did.
- **Cancellation**: idempotent — `cancelResearchCommand` flips `research.status` and cancels the underlying `research_run` job. The runner notices both signals at the next safe boundary.
- **Notification on success only**: failed and canceled background runs do not send a notification.
