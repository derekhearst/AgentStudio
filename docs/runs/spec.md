# Runs Spec

## Overview

A run is the durable, resumable record of one agent execution attempt. Every message exchanged, every tool call made, every approval requested, and every SSE event emitted during an agent loop is captured in the run and its associated event log. Runs survive process restarts, browser reloads, and SSE disconnects. The run is the canonical source of truth for what happened during an agent execution.

**Run vs. session:** A session (owned by the chat domain) is the long-lived conversation container a user sees in the sidebar. A run is a single agent execution _within_ that session — one user message triggers one run, which completes and writes its output messages back to the session's `sessionMessages`. A session accumulates many runs over its lifetime; a run always belongs to exactly one session.

## Data Model

### `runs` table

| Column             | Type       | Description                                                                                     |
| ------------------ | ---------- | ----------------------------------------------------------------------------------------------- |
| `id`               | uuid       | Primary key                                                                                     |
| `sessionId`        | uuid       | FK to `sessions` — the user-facing conversation context                                         |
| `taskId`           | uuid?      | FK to `tasks` — set when this run is executing a task                                           |
| `taskAttemptId`    | uuid?      | FK to `task_attempts` — ordinal attempt for the task                                            |
| `parentRunId`      | uuid?      | FK to parent `runs` for sub-agent runs                                                          |
| `agentId`          | uuid?      | FK to `agents` — agent executing this run                                                       |
| `model`            | string     | Model slug used                                                                                 |
| `state`            | enum       | `pending`, `running`, `awaiting_approval`, `awaiting_answer`, `completed`, `failed`, `canceled` |
| `pendingApprovals` | jsonb[]    | Outstanding tool approval requests (token, toolName, args, requestedAt)                         |
| `pendingQuestions` | jsonb[]    | Outstanding questions from the agent (token, questions, requestedAt, then answers and decidedAt) |
| `streamBlocks`     | jsonb[]    | Incremental content blocks appended as the loop runs                                            |
| `currentRound`     | integer    | Tool loop round counter for resume                                                              |
| `cursor`           | jsonb      | Loop resume pointer (last persisted message index, last tool call)                              |
| `costUsd`          | numeric    | Cumulative cost as of last update                                                               |
| `lastHeartbeatAt`  | timestamp  | Refreshed (with `updatedAt`) at most every 30 seconds while the run produces output             |
| `finishedAt`       | timestamp? | When the run entered a terminal state                                                           |
| `error`            | jsonb?     | Error details if state = `failed`                                                               |
| `evalRequired`     | boolean    | Whether an evaluator pass is required before marking completed                                  |
| `mcpServerIds`     | uuid[]     | MCP servers that were active for this run (snapshot at run start)                               |
| `metadata`         | jsonb      | Arbitrary runtime metadata                                                                      |
| `createdAt`        | timestamp  |                                                                                                 |

### `run_events` table

Append-only event log. Every SSE event the runtime emits is also written here in the same database transaction.

| Column      | Type      | Description                                                      |
| ----------- | --------- | ---------------------------------------------------------------- |
| `id`        | uuid      | Primary key                                                      |
| `runId`     | uuid      | FK to `runs`                                                     |
| `seq`       | integer   | Monotonic sequence number within the run                         |
| `type`      | string    | Event type (e.g., `text_delta`, `tool_call`, `approval_request`) |
| `payload`   | jsonb     | Event-specific data                                              |
| `createdAt` | timestamp |                                                                  |

## Features

### Durable state

Run state is always in the database, never only in memory. In-memory promise registries for approvals and user questions do not exist. Resolution happens by reading and updating the `runs` row. A process crash during an approval wait leaves the run in `awaiting_approval` state; the next boot can detect and resume it.

### Append-only event log

Every event the runtime emits is written to `run_events` in the same transaction as the state update that caused it. The event log is the source of truth for:

- Reconstructing what happened in a run (debugging, audit)
- Resuming a run from mid-point (reconnect, restart)
- Replaying events to late-joining observers

### Resumable streaming

A chat run does not depend on the browser staying connected. If the page reloads, the network drops for a moment, or a proxy closes an idle connection, the run keeps working on the server and keeps writing its events.

A client that disconnects from a run's SSE stream can reconnect via `GET /chat/[id]/stream/resume?since=<seq>`, and the chat page does so on its own (up to three attempts). The server replays all `run_events` with `seq > since` and then follows the run until it ends. The request can name the run with `runId`; without it, the server follows the conversation's most recently updated run. When the reader of a resumed stream goes away, the server stops following at once instead of checking the database until the run ends.

**Coming back to a running turn.** When the chat page opens — after a reload, or when the user returns to the conversation — it checks whether a turn is still running there. If one is, the page attaches to it from its first event:

1. The conversation data names the live run.
2. The page opens `stream/resume?since=0&runId=<id>` and shows the turn as streaming, with its tool cards, any approval cards still waiting, and the **Stop** button.
3. It then follows the turn live until it ends, and the saved reply replaces the live view.

Text the agent wrote before the page attached is not part of the replay (text is streamed, not saved event by event); it appears with the saved reply when the turn ends. A page attaches to a given run at most once, so a turn that cannot be followed is not retried in a loop.

### One turn at a time

A conversation has at most one chat turn running. Because a turn keeps going when the page that started it goes away, a second message could otherwise start a second agent on the same session while the first is still working — both writing to one history and both saving a reply.

- Sending a message while a turn is running is refused with `409` and the running turn's `runId`. Nothing is saved: not the message, not a new run. The page says the message was not sent, keeps it for Retry, and attaches to the running turn.
- "Running" means a chat turn this server is actually working on. A turn left marked as running by a server restart is not waited out: the next message marks it canceled ("Abandoned: the server restarted while this turn was running") and goes ahead. Runs started by automations are not affected.

### Stopping a run

The chat's **Stop** button sends its own request, `POST /chat/[id]/stop`. Losing the connection is not a stop — until 2026-09-23 it was, so a reload or a network blip cut the turn short and the automatic reconnect could only replay what was left.

To stop a turn you are no longer watching, open its conversation: the page attaches to the running turn (see above) and shows **Stop**.

1. The server looks up the live runs in that conversation that belong to the person asking — or only the one run the request names.
2. It interrupts each one it is running.
3. The turn ends the ordinary way: whatever the agent produced so far is saved as its reply, and its usage is recorded.

The answer is `stopped: true`, or `stopped: false` with a reason: `run_not_active` when the turn had already finished, `not_reachable` when no process on this server is running it.

A Stop that arrives while the turn is still being set up — its workspace being prepared, before the agent has started — is remembered, and the agent is interrupted the moment it starts.

Dismissing a run (`dismissStuckRun`) is different: it marks the run canceled straight away and interrupts it too. Nothing in the UI offers it at the moment; the running-sessions dock that did was removed.

### Why a run failed

A failed run's `error` holds the reason the agent gave — for example that it reached its limit of turns, or the text of a startup failure — rather than a generic "Run failed". The same text reaches the chat.

### Pending approvals

When a tool requires approval:

1. A pending approval entry is written to `runs.pendingApprovals`
2. The runtime loop suspends via `session.pendingApproval`
3. The approve/deny endpoint updates `runs.pendingApprovals` in the DB
4. The loop detects the update (poll or LISTEN/NOTIFY) and continues

The chat's Allow / Deny card can appear a moment before step 1 has happened. An answer that arrives in that gap waits up to three seconds for the approval to be written instead of being lost. If the answer still does not land (`resolved: false` — the approval timed out, or was answered elsewhere), the card keeps its buttons and says so, instead of showing the call as approved.

### Pending user questions

A question from the agent (the SDK's AskUserQuestion, #4) follows the same pattern as approvals: written to `runs.pendingQuestions`, resolved via the answer endpoint or /review, and the run moves to `waiting_user_input` while it waits.

- Each entry keeps the questions as the card shows them — header, question text, options with descriptions, the recommended marker, any HTML previews, and whether several choices are allowed — so a reloaded page and the /review inbox show the same card. It is JSON, so none of this needed a migration.
- Answers are recorded keyed by each question's text, which is what the SDK takes back. An entry left by the retired `ask_user` is keyed by its header instead, and still reads.
- The token is `<run id>:ask:<tool call id>`, one per question call.
- The run waits five minutes, then the agent is told nobody answered. A Stop ends the wait at once and closes the question's inbox item.

### Approvals and questions in the review inbox

Each pending approval and each question from the agent also opens an item in the /review inbox, so a user who is not watching the chat can find it (and, after a minute, gets a "Needs input" notification). The item can be answered from /review — Approve, Deny, or the answer card — with the same effect as answering in the chat.

The item closes by itself when the prompt is settled: answered in either place (resolved, with who answered), timed out after five minutes (dismissed), or left behind by a run that ended or was reaped (dismissed by the check that runs with the reaper every five minutes). Before 2026-09-23 these items were never closed, and answering one in /review did not reach the run.

### Incremental block persistence

As the loop runs, content blocks (`thinking`, `text`, `tool_call`, `tool_result`) are appended to `runs.streamBlocks` after each block is finalized. This allows the state of a live run to be inspected from outside the stream.

### Sub-agent runs

A sub-agent run is a `runs` row with `parentRunId` set. Its events forward to the parent's event bus (the parent's SSE stream receives child events with a `childRunId` label). The parent run is not in a terminal state while children are running.

### Stale run detection

While a chat run is producing anything — text, tool calls, or the progress pings the agent sends while a long command runs — it refreshes its record (`updatedAt` and `lastHeartbeatAt`) at most every 30 seconds.

A maintenance job (`runs_reap.5min`) cancels any run that is still marked active but has not been refreshed for an hour. It records the reason, clears pending approvals and questions, and interrupts the run if this server is still running it. So a run is only reaped when nothing has come out of it for an hour — a crashed process, or a session that is truly stuck — never just because it has been working for a long time. Until 2026-09-23 chat runs never refreshed their record, so every turn longer than an hour was cancelled mid-work.

A run that was reaped or dismissed **stays canceled**: when the interrupted turn winds down, its own final save no longer overwrites that with "completed". A turn that fails before the agent starts (for example, its workspace could not be created) is recorded as finished and failed at once, so it never reads as a turn still in progress.

### Evaluator gating

If `runs.evalRequired = true`, the runtime does not transition the run to `completed` after the generator finishes. Instead it waits for the evaluator child run to complete and pass. See the evaluations spec.

## Behavior Contracts

- `run_events.seq` values within a run are gapless integers starting from 1. Gaps indicate a consistency problem.
- `runs.state` transitions are: `pending` → `running` → (`awaiting_approval` | `awaiting_answer` | `completed` | `failed` | `canceled`). A run in a terminal state does not change state.
- Approval and question entries in `pendingApprovals` / `pendingQuestions` are removed when resolved; they are not left as resolved records (the event log holds the full history).
- `run_events` rows are never deleted or updated after insertion.
- A run's `costUsd` is updated after each LLM call; it is the cumulative total, not a per-call figure.
- A run that has been in `awaiting_approval` or `awaiting_answer` for longer than the agent's configured timeout is automatically transitioned to `failed`.

## Roles & Permissions

| Action                    | Who can do it                                           |
| ------------------------- | ------------------------------------------------------- |
| Start a run               | Authenticated user (via chat), automation worker, admin |
| View run state and events | Owner user, admin                                       |
| Approve a pending tool    | Owner user, admin                                       |
| Answer a pending question | Owner user, admin                                       |
| Cancel a run              | Owner user, admin                                       |
| Delete a run record       | Admin only                                              |
| View another user's runs  | Admin only                                              |

What is enforced today (AgentStudio has a single owner and no admin tier): the run detail view at `/runs/[id]` only finds runs recorded for the signed-in user. Any other id — another user's run, or one that does not exist — shows "Run not found", so the two cannot be told apart. A visitor without a session is refused before any run data is read.

## Rewrite Authority

The current implementation is a baseline, not a constraint. This domain may be rewritten, restyled, reorganized, or replaced as needed to achieve the target product quality. No code path is off-limits if behavior contracts, safety controls, tests, and documentation remain correct.

## UI Contract

This domain follows the shared UX system in [../ui/spec.md](../ui/spec.md).

- Surfaces in this domain must align with the shared desktop/mobile shell patterns.
- Domain-specific states must be explicit in the UI (for example pending, running, blocked, completed) where applicable.
- Blocking user decisions must use the shared action-card and inbox patterns where applicable.

## References

- [The Anatomy of an Agent Harness — LangChain](https://blog.langchain.com/the-anatomy-of-an-agent-harness/) — durable state, event log, resumability
- [The Design of Claude Managed Agents — Anthropic](https://www.anthropic.com/engineering/managed-agents) — stateful session as independent primitive
- [Honcho](https://github.com/plastic-labs/honcho) — agent state memory library
- [Zylos](https://github.com/zylos-ai/zylos-core) — persistent agent harness with tiered state
- **Internal:** `src/lib/runs/runs.schema.ts`, `src/lib/runs/events.server.ts`, `src/lib/runs/run-lifecycle.server.ts` (heartbeat, final save), `src/lib/runs/run-replay-stream.ts` (resume), `src/lib/runs/runs.server.ts` (reaper, dismiss, stop), `src/lib/runs/live-chat-run.server.ts` (one turn at a time), `src/lib/engine/run-registry.server.ts` (which runs this server is working on), `src/lib/sessions/sessions.schema.ts` (conversation/message owner)
