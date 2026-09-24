# Research

## Overview

The Research domain covers two ways of getting a thorough, cited answer to a question.

1. **Research in a chat (primary)** — The user switches the chat to the **Research agent** and asks a substantive question. The Research agent writes a research plan to a file, posts it, and asks the user to approve handing the work to another agent — the Chat agent unless the user asks for a different one. On approval the conversation switches to that agent, which reads the plan and carries out the research in the chat, with web search, page reading and PDF reading, and answers with citations.
2. **Background research runs** — A run breaks the question into sub-questions, searches the web, reads the most promising pages, looks for gaps, and writes a cited markdown report. It takes roughly 10–15 minutes, and the user is notified when it is done and reads the report at `/research/{id}`.

A background research run starts in one of two ways today:

1. **A research-mode automation** — an automation whose mode is **Research** opens a research run on its schedule, with the automation's prompt as the question. This is the way most runs start.
2. **The `startResearchCommand` server call** — it opens a run for the signed-in user and returns its id straight away. The chat composer has a **Research** button that calls it, but the button only appears when a page switches it on, and neither the home page nor the chat page does at the moment. So today this path is reached only programmatically.

The two kinds of research do not overlap: approving a Research agent's plan does not start a background run, and a background run never asks for approval.

The Research agent hands off exactly the way the Plan agent does. See [Agents — Hand a plan over from Plan or Research](../agents/agents.md#hand-a-plan-over-from-plan-or-research) for the shared handoff, and [Agents — Built-in agents and their tools](../agents/agents.md#built-in-agents-and-their-tools) for what it may use.

The Research agent used to have its own `propose_research_plan` tool: the plan appeared in the right sidebar with Approve and Decline, and approving started a background run. That tool and its sidebar flow are gone; the Research agent now writes a plan file and hands off like Plan. There is no separate "research runner" agent.

## Key concepts and entities

- **Research plan file** — The markdown file the Research agent writes, usually `RESEARCH-PLAN.md`. It holds a one- or two-sentence summary, 4–8 concrete sub-questions and an optional rationale. The agent also posts the plan in its reply, so the user can read it without opening the file.
- **Handoff** — The Research agent's call to `request_plan_approval` with the plan file and the full id of the agent that should do the research. The user approves or denies it on a card in the chat.
- **Research run** — One background investigation, a row in the `research` table. It carries the status, the sub-question plan, the final report, the total cost, and links back to the conversation and chat run it belongs to. Only background runs create one; research done in a chat lives in the conversation.
- **Sub-questions** — 4–8 concrete, searchable questions that break the user's question down. In a chat the Research agent writes them into its plan file. In a background run the planner writes them at the start of the run.
- **Research source** — One web page or PDF a background run fetched. It stores the extracted text (capped at about 50,000 characters), the title and the URL. A flag turns on when the final report cites the source.
- **Research step** — An append-only record of each action in a background run: plan written, search issued, page fetched, reflection round, report written. It drives the live trace on the run's page.
- **Cited report** — The final markdown deliverable of a background run: an executive summary, 4–8 thematic sections, inline `[N]` citations that point at research sources, and a source list at the bottom.
- **Notification** — Sent when a background run completes: an in-app notification plus, when push is set up, a web push to the user's devices that opens `/research/{id}`.

## Status lifecycle (background runs)

`planning → searching → reflecting → synthesizing → complete`

A run goes back to `searching` for each reflection round that finds gaps. (The status list also has `fetching`, which the runner does not use: pages are read as part of `searching`.) A failure moves the run to `failed` and records the error. The user's Cancel moves it to `canceled`. The runner checks the row at every safe point between phases, so a Cancel stops the run at the next one instead of spending the rest of the budget.

`complete`, `failed` and `canceled` are final. A run in one of them is never run again: a failed run stays failed, where the user can see it, instead of being quietly retried. The one second chance a run gets is for a worker that stops mid-run, in a deploy or a crash. Another worker then picks the run up where it left off, from the plan and pages the first attempt saved (see [Background Jobs — when a worker dies mid-job](../jobs/jobs.md#when-a-worker-dies-mid-job)).

A Cancel is never overwritten. The runner only writes to a run that is still going, and it checks for a Cancel again once the report has been written. A Cancel pressed while the report is being written leaves the run canceled, with no report saved and no "Research complete" notification.

Before 2026-09-23:

- A canceled run was recorded as failed and then retried to completion, report, cost and "Research complete" notification included.
- A Cancel pressed while the report was being written was lost. The run saved its report over it and announced itself complete.
- A failed run was retried up to twice, on top of the first attempt's plan, sources and error, while the open page had already stopped watching.
- No run could finish. Every run failed at its first model call (the planner was sent a model id OpenRouter does not know), and a run past that would have failed at its last step: marking the sources its report cited sent the database a query it refuses, whenever the report cited anything.

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

### B) Discussion of completed reports

The Research agent isn't only an initiator. Once a report or earlier findings are in the conversation, it answers follow-up questions directly without writing a new plan. It cites sources, separates established, contested and speculative claims, and points out where sources disagree rather than flattening them.

### C) A research-mode automation starts a background run

1. The automation's schedule comes due, or the user clicks **Run now**.
2. The budget check runs first. If a budget limit blocks new work, the automation is skipped and the user is alerted.
3. The automation opens a research run with its prompt as the question, linked to the automation's conversation, and queues it as a background job at priority 100. (`startResearchCommand({ query, conversationId?, runId?, model? })` does the same for an interactive caller, at priority 150.)
4. The job worker picks the run up and works through the phases below.

### D) What a background run does

1. **Plan** — The planner model writes 4–8 sub-questions.
2. **Search and read** — For each sub-question, the run searches the web and reads the best few pages, several sub-questions at a time.
3. **Reflect** — The model looks at what has been read so far and names any gaps. Each gap gets its own search-and-read pass. This repeats up to three times, and stops early when no gaps are left or the source cap is reached.
4. **Write the report** — The model writes the cited report from all the sources. The sources it cites are marked as cited.
5. **Finish** — The run is marked complete and the user is notified. The report is at `/research/{id}` and listed on `/research`. If the run is linked to a conversation, that page's **Back** button and breadcrumb lead to the chat. The chat itself no longer lists its research runs: its right-hand rail lost the **Research** tab in #14, and the report is not posted into the chat.

### E) Following and cancelling a background run

1. `/research/{id}` shows the run's status, sub-questions, sources and live trace. It refreshes every few seconds while the run is going and stops once it has ended.
2. The page has a **Cancel** button. Cancelling marks the run canceled and cancels its background job. The run stops at its next safe point and stays canceled.
3. `/research` lists recent runs alongside generated images.
4. When a run fails, its error shows on its page and its job shows as failed in the review inbox. No notification is sent.

## Roles and permissions

- **Owner (per run)** — Set from the user who started the run (for an automation, the automation's owner). Viewing and cancelling check ownership at the server; another user's run is refused.
- **Research agent** — Shares one allow-list of tools with the Plan agent (`READ_ONLY_TOOL_NAMES`): `web_search`, `web_fetch`, `pdf_read`, reading and searching files, `list_agents` and other read-only tools. On top of those it has `Write`, so it can write its plan file (a deliberate decision, issue #67), and `request_plan_approval`. It cannot run shell commands, edit files in place, push code or open pull requests.
- **Handoff approval** — `request_plan_approval` is in `MANDATORY_APPROVAL_TOOLS`, so the user must approve every handoff, in every permission mode. In automation runs and other runs with nobody to approve, it fails closed.
- **The agent that does the research** — Usually Chat, which has full tool access. Its own approval settings apply to what it does after the handoff.
- **Job worker** — Picks up `research_run` jobs and runs them. A run notices a Cancel either on its own row or on its job. The row is checked first, since that is where the user's Cancel lands. Only a real Cancel ends the run as canceled. A database error during the check is a failure, and so is finding that the queue took the job back after the worker's lease lapsed.

## Integrations

- **LLM (OpenRouter)** — Background runs use it for the plan, each reflection round, and the report. Each call is logged to the usage ledger, and the total is kept on the run as its cost. The default planner and report model is stored as `claude-sonnet-5`, the Agent SDK's name for it, and is sent to OpenRouter as `anthropic/claude-sonnet-5` (see [../llm/spec.md](../llm/spec.md#model-ids)). A model chosen for the run is translated the same way. Research in a chat is ordinary chat turns, billed like any other.
- **Web search and fetch** — Search returns about 8 results per sub-question; each page read is capped at the run's character limit. Reading is spread across a small, fixed number of parallel requests so a run finishes in reasonable time.
- **Job queue (`jobs` table)** — `research_run` is the registered job. Runs started by the user have priority 150; automation runs have priority 100, so a scheduled report never gets ahead of one the user started. Every research job is queued with two attempts, and the second is only used when the worker running the first stops mid-run. A run that failed is not run again: its job's second attempt ends at once with the same error, and the job then shows in the review inbox as a job failure.
- **Automations** — A research-mode automation opens the run and links it to the automation's conversation. It goes through the same budget check as every automation first.
- **Notifications** — An in-app notification on every completed run, plus a web push when push keys are configured. Both are skipped when the user has switched off "Task completed" in Settings → Notifications.
- **Research feed (`/research`)** — Lists research runs alongside generated images. `/research/{id}` is the canonical page for a run.
- **Agents** — The Research agent's handoff uses the agents domain's `request_plan_approval` and `list_agents`; see [docs/agents/agents.md](../agents/agents.md).

## Business rules

- **Plan first, act after approval**: in a chat, the Research agent writes and posts a plan and waits for approval before any research is carried out. The agent that does the work starts by reading the approved plan file.
- **Every handoff is approved by the user**: there is no setting that skips the approval card, and a run with no one to approve it cannot hand off.
- **The plan file must exist**: approving a handoff whose plan file was never written fails, and the conversation stays with the Research agent.
- **Sub-question count**: the Research agent is told to write 4–8 sub-questions; this is guidance, not enforced. A background run's planner is capped at 8 by default (`maxSubQuestions`), and never more than 12. A plan with no sub-questions fails the run.
- **Sub-question shape**: each should be concrete and searchable; the agent's instructions steer it away from vague "what is X?" questions.
- **Source cap**: a background run's reflection stops once it has 150 sources by default (`maxTotalSources`), so a model that keeps finding gaps cannot run up the cost.
- **Reflection rounds**: at most 3 by default (`maxReflectionRounds`). A round that finds no gaps ends reflection early.
- **Page text cap**: about 50,000 characters per page by default (`maxFetchChars`). Anything longer is cut off, and the page's step in the trace records that it was.
- **Cite everything**: a background run's report must cite every factual claim with `[N]`. Sources the report does not cite stay in the table, marked not cited, for review.
- **Each page once**: a URL is fetched once per run. Sub-questions and gap searches often find the same pages; each is fetched and stored once, and a page reached through two links after redirects is kept once.
- **Public web only**: pages are read through the same safety check as the `web_fetch` tool (see [tools spec — Web access safety](../tools/spec.md#web-access-safety-the-egress-guard)). A search result that points at, or redirects to, a private, local or cloud-metadata address is not read and does not become a source. Each page is read in its own throwaway browser session, so pages read side by side cannot mix.
- **Saved plan**: if a run already has sub-questions when it starts, the planning step is skipped and the saved plan is used. The trace records it as a saved plan, not an approved one. Nothing starts a run with a plan today: a run has one before planning only when an earlier attempt's worker stopped mid-way (a deploy or a crash) and another worker picked the run up again. The pages that attempt already read are not read again.
- **Per-agent settings**: when the run's conversation has an agent with research settings, those settings replace the defaults above. A model chosen for the run replaces the planner and report model.
- **Cancellation**: repeat Cancels are harmless. Cancel marks the run canceled and cancels its job. The run stops at its next safe point, including just after the report is written. The run stays canceled and the job stays canceled: a canceled job is never completed, failed or retried afterwards.
- **Notify on success only**: failed and canceled runs send no notification, and a run is only announced after it has actually been saved as complete.
