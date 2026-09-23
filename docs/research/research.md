# Research

## Overview

The Research domain runs a thorough, cited investigation in the background. A research run breaks the question into sub-questions, searches the web, reads the most promising pages, looks for gaps, and writes a cited markdown report. A run takes roughly 10–15 minutes and ends with a notification.

A background research run starts in one of two ways today:

1. **A research-mode automation** — an automation whose mode is **Research** opens a research run on its schedule, with the automation's prompt as the question. This is the way most runs start.
2. **The `startResearchCommand` server call** — it opens a run for the signed-in user and returns its id straight away. The chat composer has a **Research** button that calls it, but the button only appears when a page switches it on, and neither the home page nor the chat page does at the moment. So today this path is reached only programmatically.

The **Research agent** in the chat is a separate feature. It writes a research plan to a markdown file and asks the user to approve it. On approval, the conversation switches to the agent the plan names, and that agent carries out the plan inside the chat with its own tools. That handoff does **not** start a background research run. See flow D below.

Earlier versions of this doc described a `propose_research_plan` tool with Approve and Decline buttons in the sidebar that started a background run from the approved sub-questions. That tool is not in the code.

## Key concepts and entities

- **Research run** — One investigation. It is the top-level row in the `research` table. It carries the status, the sub-question plan, the final report, the total cost, and links back to the conversation and chat run it belongs to.
- **Sub-questions** — 4–8 concrete, searchable questions that break the user's question down. The planner writes them at the start of the run.
- **Research source** — One web page or PDF the run fetched. It stores the extracted text (capped at about 50,000 characters), the title and the URL. A flag turns on when the final report cites the source.
- **Research step** — An append-only record of each action: plan written, search issued, page fetched, reflection round, report written. It drives the live trace on the run's page.
- **Cited report** — The final markdown deliverable: an executive summary, 4–8 thematic sections, inline `[N]` citations that point at research sources, and a source list at the bottom.
- **Notification** — Sent when a run completes: an in-app notification plus, when push is set up, a web push to the user's devices that opens `/research/{id}`.

## Status lifecycle

`planning → searching → reflecting → synthesizing → complete`

A run goes back to `searching` for each reflection round that finds gaps. (The status list also has `fetching`, which the runner does not use: pages are read as part of `searching`.) A failure moves the run to `failed` and records the error. The user's Cancel moves it to `canceled`. The runner checks the row at every safe point between phases, so a Cancel stops the run at the next one instead of spending the rest of the budget.

`complete`, `failed` and `canceled` are final. A run in one of them is never run again, and a run gets a single attempt: a failed run stays failed, where the user can see it, instead of being quietly retried.

A Cancel is never overwritten. The runner only writes to a run that is still going, and it checks for a Cancel again once the report has been written. A Cancel pressed while the report is being written leaves the run canceled, with no report saved and no "Research complete" notification.

Before 2026-09-23:

- A canceled run was recorded as failed and then retried to completion, report, cost and "Research complete" notification included.
- A Cancel pressed while the report was being written was lost. The run saved its report over it and announced itself complete.
- A failed run was retried up to twice, on top of the first attempt's plan, sources and error, while the open page had already stopped watching.
- No run could finish. Every run failed at its first model call (the planner was sent a model id OpenRouter does not know), and a run past that would have failed at its last step: marking the sources its report cited sent the database a query it refuses, whenever the report cited anything.

## User flows

### A) A research-mode automation starts a run

1. The automation's schedule comes due, or the user clicks **Run now**.
2. The budget check runs first. If a budget limit blocks new work, the automation is skipped and the user is alerted.
3. The automation opens a research run with its prompt as the question, linked to the automation's conversation, and queues it as a background job.
4. The job worker picks the run up and works through the phases below.

### B) What a run does

1. **Plan** — The planner model writes 4–8 sub-questions.
2. **Search and read** — For each sub-question, the run searches the web and reads the best few pages, several sub-questions at a time.
3. **Reflect** — The model looks at what has been read so far and names any gaps. Each gap gets its own search-and-read pass. This repeats up to three times, and stops early when no gaps are left or the source cap is reached.
4. **Write the report** — The model writes the cited report from all the sources. The sources it cites are marked as cited.
5. **Finish** — The run is marked complete and the user is notified.

### C) Following and cancelling a run

1. `/research/{id}` shows the run's status, sub-questions, sources and live trace. It refreshes every few seconds while the run is going and stops once it has ended.
2. The page has a **Cancel** button. Cancelling marks the run canceled and cancels its background job. The run stops at its next safe point and stays canceled.
3. In a chat linked to runs (for example the automation's conversation), the right-hand console's **Research** tab lists the chat's five most recent runs with their status and progress.
4. `/research` lists recent runs alongside generated images.
5. When a run fails, its error shows on its page and its job shows as failed in the review inbox. No notification is sent.

### D) The Research agent in the chat (no background run)

1. The user switches the chat to the **Research** agent and asks a substantive question.
2. The agent writes a plan (summary, 4–8 sub-questions, optional rationale) to a markdown file such as `RESEARCH-PLAN.md`, and posts it in its reply.
3. The agent calls `request_plan_approval` with the file's path and the agent that should carry the plan out. An approval card appears in the chat.
4. If the user approves, the conversation switches to that agent, which reads the plan file and works through it in the chat. If the user denies, they usually reply with feedback and the agent rewrites the plan.
5. For quick lookups, or follow-up questions about a finished report, the agent answers directly. It cites sources, separates established, contested and speculative claims, and points out where sources disagree.

## Roles and permissions

- **Owner (per run)** — Set from the user who started the run (for an automation, the automation's owner). Viewing and cancelling check ownership at the server; another user's run is refused.
- **Research agent** — Read-only tool access: web search, web fetch, PDF reading, and reading files. Its one write tool is there so it can write its plan file. It cannot run shell commands.
- **Plan approval** — `request_plan_approval` always needs the user's explicit approval, whatever the user's own approval settings say. In an automation or other unattended run, where no one can approve, the tool refuses.
- **Job worker** — Picks up `research_run` jobs and runs them. A run notices a Cancel either on its own row or on its job. The row is checked first, since that is where the user's Cancel lands. Only a real Cancel ends the run as canceled; a database error during the check is a failure.

## Integrations

- **LLM (OpenRouter)** — Used for the plan, each reflection round, and the report. Each call is logged to the usage ledger, and the total is kept on the run as its cost. The default planner and report model is stored as `claude-sonnet-5`, the Agent SDK's name for it, and is sent to OpenRouter as `anthropic/claude-sonnet-5` (see [../llm/spec.md](../llm/spec.md)). A model chosen for the run is translated the same way.
- **Web search and fetch** — Search returns about 8 results per sub-question; each page read is capped at the run's character limit. Reading is spread across a small, fixed number of parallel requests so a run finishes in reasonable time.
- **Job queue (`jobs` table)** — `research_run` is the registered job. Runs started by the user have priority 150; automation runs have priority 100. Every research job is queued with one attempt. When a run fails, its job fails and shows in the review inbox as a job failure.
- **Automations** — A research-mode automation opens the run and links it to the automation's conversation. It goes through the same budget check as every automation first.
- **Notifications** — An in-app notification on every completed run, plus a web push when push keys are configured. Both are skipped when the user has switched off "Task completed" in Settings → Notifications.
- **Research feed (`/research`)** — Lists research runs alongside generated images. `/research/{id}` is the canonical page for a run.

## Business rules

- **Plan size**: the planner's sub-questions are capped at 8 by default (`maxSubQuestions`), and never more than 12. A plan with no sub-questions fails the run.
- **Source cap**: reflection stops once a run has 150 sources by default (`maxTotalSources`), so a model that keeps finding gaps cannot run up the cost.
- **Reflection rounds**: at most 3 by default (`maxReflectionRounds`). A round that finds no gaps ends reflection early.
- **Page text cap**: about 50,000 characters per page by default (`maxFetchChars`). Anything longer is cut off, and the page's step in the trace records that it was.
- **Cite everything**: the report must cite every factual claim with `[N]`. Sources the report does not cite stay in the table, marked not cited, for review.
- **Each page once**: a URL is fetched once per run. Sub-questions and gap searches often find the same pages; each is fetched and stored once, and a page reached through two links after redirects is kept once.
- **Saved plan**: if a run already has sub-questions when it starts, the planning step is skipped and the saved plan is used. The trace records it as a saved plan, not an approved one. Nothing starts a run with a plan today: the only way a run gets one before planning is an earlier attempt's planner, and a job left running when its worker stopped is not picked up again. The path is kept for when it is.
- **Per-agent settings**: when the run's conversation has an agent with research settings, those settings replace the defaults above. A model chosen for the run replaces the planner and report model.
- **Cancellation**: repeat Cancels are harmless. Cancel marks the run canceled and cancels its job. The run stops at its next safe point, including just after the report is written. The run stays canceled and the job stays canceled: a canceled job is never completed, failed or retried afterwards.
- **Notify on success only**: failed and canceled runs send no notification, and a run is only announced after it has actually been saved as complete.
