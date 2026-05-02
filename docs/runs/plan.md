# Runs Plan

Status: active

## Overview

Make every agent run survive process restarts, browser reloads, and SSE disconnects. Today the harness depends on in-memory `Map`s and live promises for tool approval, `ask_user`, and streaming partials — any pod restart drops a run on the floor and any reload shows nothing until the SSE pipe reconnects. The state primitive must move into the database.

> **See also:** [spec.md](spec.md) — full feature spec, data model, and behavior contracts.

## Why this matters (harness principles)

- **State is a primitive.** LangChain's "Anatomy of an Agent Harness" lists durable, resumable, observable state as the first thing a harness must own.
- **Stateful session decoupled from brain/hands.** Anthropic's Managed Agents post treats the event log as an independent primitive.
- **Corrections are cheap, waiting is expensive.** OpenAI's harness engineering principle assumes runs that don't silently die mid-flight.

## Reference repos & articles

- [The Anatomy of an Agent Harness — LangChain](https://blog.langchain.com/the-anatomy-of-an-agent-harness/)
- [The Design of Claude Managed Agents — Anthropic](https://www.anthropic.com/engineering/managed-agents)
- [OpenClaw](https://github.com/openclaw/openclaw) — runtime with persistent session management
- [Zylos](https://github.com/zylos-ai/zylos-core) — persistent agent harness with tiered state
- [Honcho](https://github.com/plastic-labs/honcho) — agent state memory library

## Current state in AgentStudio

- `chatRuns` table exists ([src/lib/chat/chat.schema.ts](../../src/lib/chat/chat.schema.ts)) and tracks `state`, `lastDelta`, `lastHeartbeatAt`, but it is the only durable signal.
- `requestApproval` and `requestUserQuestions` in [src/lib/tools/tools.server.ts](../../src/lib/tools/tools.server.ts) resolve via in-memory promises keyed by token.
- [src/lib/agents/streaming-state.server.ts](../../src/lib/agents/streaming-state.server.ts) is a `Map` with a 30s staleness window.
- The big stream loop in [src/routes/chat/[id]/stream/+server.ts](../../src/routes/chat/[id]/stream/+server.ts) buffers `streamBlocks` only in memory; nothing is persisted until the run ends.
- Restarting the server while a run waits on approval or `ask_user` orphans the run forever.

> **Note:** This plan assumes `docs/structure/plan.md` Step 3 (extract `runs/` from `chat/`) has landed. Final paths use `src/lib/runs/`. If the rename has not happened yet, apply the changes inside `src/lib/chat/` and migrate them with the Structure refactor.

## Target design

### Schema additions on `runs`

| Column             | Type          | Purpose                                                                   |
| ------------------ | ------------- | ------------------------------------------------------------------------- | ---- | -------------------------------- |
| `pendingApprovals` | `jsonb` array | Outstanding tool approval requests `{token, toolName, args, requestedAt}` |
| `pendingQuestions` | `jsonb` array | Outstanding `ask_user` requests `{token, questions, requestedAt}`         |
| `streamBlocks`     | `jsonb` array | Ordered blocks (`thinking                                                 | text | tool`) appended as the loop runs |
| `currentRound`     | `integer`     | Tool loop round counter for resume                                        |
| `cursor`           | `jsonb`       | Loop pointer (last persisted message index, last tool call)               |

### New tables

- `run_events` (append-only): `{id, runId, seq, type, payload, createdAt}` — the canonical event log used to drive both live SSE and resume reads. Lives in `src/lib/runs/events.server.ts`.

### Behavior

1. Every SSE event the loop emits is also `INSERT`ed into `run_events` in the same transaction as state mutation.
2. Approvals/questions become DB rows. Resolution is by `UPDATE` on the run row (`pendingApprovals`/`pendingQuestions`) — the loop polls (or LISTEN/NOTIFY) for the answer.
3. Reconnect endpoint `GET /chat/[id]/stream/resume?since=<seq>` replays `run_events` past the cursor and then attaches to live updates.
4. In-memory `Map` is removed.

## Implementation steps (phased)

### Phase 1 — Persist pending approvals

- Migration: add `pendingApprovals` jsonb on `chatRuns`.
- Replace `requestApproval` promise registry with: insert pending row → poll/LISTEN until `approved`/`denied` → clear row.
- Approve/deny `+server.ts` endpoints update DB rather than calling in-memory resolvers.

### Phase 2 — Persist pending questions

- Migration: add `pendingQuestions` jsonb.
- Same pattern as Phase 1 for `ask_user`.

### Phase 3 — Persist incremental stream blocks

- Migration: add `streamBlocks` jsonb + `currentRound`.
- Loop appends to DB after each block instead of only at run end.

### Phase 4 — Run event log

- New `run_events` table with seq + payload.
- Loop dual-writes events (DB + SSE).

### Phase 5 — Resume endpoint

- `GET /chat/[id]/stream/resume?since=<seq>` replays events.
- Client detects disconnect and resumes seamlessly.

### Phase 6 — Drop in-memory state

- Delete [streaming-state.server.ts](../../src/lib/agents/streaming-state.server.ts).
- Replace any consumer with a query on `chat_runs` + `run_events`.

## Files to create / modify

- `src/lib/runs/runs.schema.ts` — schema columns + new `runEvents` table
- `src/lib/runs/runs.server.ts` — resume helpers, event append, polling helpers
- `src/lib/runs/events.server.ts` (new) — append-only event log
- `src/lib/runs/resume.server.ts` (new) — pure resume reader
- `src/lib/tools/tools.server.ts` — replace approval/question registries
- `src/routes/chat/[id]/stream/+server.ts` — emit-and-persist (transport only after Runtime extraction)
- `src/routes/chat/[id]/stream/resume/+server.ts` (new) — replay endpoint
- `src/routes/chat/[id]/tool-approve/+server.ts` — DB update instead of in-mem resolve
- `src/routes/chat/[id]/ask-user/+server.ts` — same
- `src/lib/agents/streaming-state.server.ts` — delete in Phase 6

## Migration / backward-compat

- Drizzle migration adds new columns nullable / default `[]`.
- A boot job marks any `running` run with stale heartbeat (>5 min) as `failed` so legacy in-flight runs don't block the queue.
- Feature flag `RESUMABLE_RUNS` gates Phase 5/6 until tested.

## Verification

- Manual: start a long run, kill the dev server, restart, reload `/chat/[id]` → run continues from last event.
- Manual: trigger tool approval, refresh the page, approve from a fresh tab → loop resumes.
- E2E test: `tests/runs.resume.spec.ts` — start streaming run, abort the SSE connection, reconnect, assert events replay and run completes.
- DB check: no orphaned `pendingApprovals` after a successful run.

## Out of scope

- Multi-pod coordination / leader election (single-process polling is sufficient at current scale).
- Cross-user run sharing.
- Replacing SSE with WebSockets.

## Completion

- Template: YYYY-MM-DD - Completed in <PR/commit> - <one-line outcome>
- Pending.


