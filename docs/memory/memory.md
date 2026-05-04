# Memory

## Overview

Memory is AgentStudio's long-term recall system. It captures what the user and agents talked about, organizes it into a hierarchical "palace" structure, and surfaces relevant slices on every new turn so the assistant doesn't start each conversation from scratch.

Memory runs automatically. After each conversation reaches a stopping point, the system mines the exchange into structured memories. On the user's next message, it pulls the most relevant memories back in as context. Users can browse, search, and prune their memory palace from the `/memory` page.

The design is ported from MemPalace — see [docs/memory/spec.md](spec.md) for the full data-model contract and [docs/memory/plan.md](plan.md) for the build sequence.

## Key concepts

### The Palace hierarchy

Memories are stored in a four-level tree:

| Level   | What it represents                                                  | Example                                              |
| ------- | ------------------------------------------------------------------- | ---------------------------------------------------- |
| Wing    | A subject — a person, project, topic, or agent                       | "Efoil rebuild", "Derek", "tax research"             |
| Room    | A time-slice within a wing (typically one conversation)              | "2026-04-30 evening session"                         |
| Closet  | A topic discussed during that time-slice                             | "Battery wiring options"                             |
| Drawer  | One verbatim message or note within that topic                       | "I tried a 12-AWG silicone wire and it overheated…"  |

The hierarchy is pre-built so the model isn't reasoning over a flat blob of past chats — it gets pre-grouped, time-stamped slices that are easy to filter.

### AAAK index

Each drawer carries an "AAAK pointer" — a compressed reference like `§ W-042/R-11/D-007` plus a few semantic tags (`@p` for people, `@l` for locations, `@e` for events, `@i` for items, `@t` for time). The pointer lets the model cite a memory by ID instead of regurgitating it, which keeps the assistant's responses tight and traceable.

### Temporal knowledge graph

Alongside the palace, memory tracks **entities** (people, projects, items) and **relations** between them (Derek `owns` efoil, efoil `has_battery` 12V20Ah). Relations carry a validity window — `validFrom` and an optional `validTo` — so swap-outs and changes are recorded as new relations rather than overwrites. Querying the timeline of an entity returns the full history.

### Embeddings + hybrid retrieval

Drawers carry a 1536-dimension embedding (OpenAI `text-embedding-3-small`). When the user asks something new, recall combines four signals:

1. **Semantic similarity** — cosine match on embeddings via pgvector HNSW.
2. **Keyword boost** — Postgres full-text search over drawer content + AAAK tags.
3. **Temporal proximity** — recent drawers ranked higher than old ones for time-sensitive queries.
4. **Preference patterns** — recurring user choices boost relevance for matching topics.

The top results get formatted into a `<memory_context>…</memory_context>` block prepended to the system prompt.

### Optional rerank

When `useRerank` is enabled in settings, the top 20 candidates are sent to a cheap reader model (default `anthropic/claude-haiku`) which promotes the best 5. This trades a small amount of latency for higher precision on ambiguous queries.

## User flows

### Automatic mining (after every conversation)

1. The user finishes a chat exchange (or the run completes naturally).
2. The system kicks off `mineConversation(conversationId)` in the background — the user sees their assistant reply immediately and never waits.
3. Mining extracts entities and topics via a small LLM call, then writes one drawer per turn into the palace, computing AAAK indexes and embeddings inline.
4. An `agent_action` activity event of type `memory_mined` records what landed.

### Automatic recall (on every user message)

1. The user types a message and submits.
2. Before the model is called, `recallForUser(userId, message, { topK })` runs.
3. The retrieval pipeline returns the top-K drawers ranked by hybrid score.
4. The drawers are rendered into a compact memory context block (`<memory_context>…</memory_context>`) and prepended to the system prompt.
5. The model now has the relevant past context and can answer with continuity.

### Manual palace browsing (`/memory`)

The Memory page shows the palace tree (wings → rooms → closets → drawers), a search box that runs the same retrieval pipeline against arbitrary queries, an AAAK preview for each drawer, and a delete control for surgical pruning.

### Settings

Users can configure memory behavior under Settings → Memory:

- **Enabled** — turn auto-mining + recall on or off entirely.
- **Top-K** — how many drawers to inject per turn (default 5; higher = more context, more tokens).
- **Use rerank** — pass top-20 through a reader model for higher precision (small latency cost).
- **Rerank model** — defaults to `anthropic/claude-haiku-4.5`.
- **Embedding model** — defaults to `openai/text-embedding-3-small` (1536-dim, must match the pgvector column).
- **Auto-mine** — disable to make mining manual-only.

Per-agent override: `agents.config.memory` lets you disable recall for specific agents (e.g. the orchestrator) without affecting others.

## Roles & permissions

- **All authenticated users**: see + manage their own palace; settings are per-user.
- **Agents**: read recalled memories for the conversation's owning user; never write across user boundaries.
- **Admins**: same as users for their own palace; no special cross-user access (memory is private by design).

## Integrations

- **Chat domain** — automatic mining hook fires when a chat run reaches `completed`; recall runs in the chat stream entry point before the LLM call.
- **Settings domain** — memory behavior toggles live in `appSettings.memoryConfig` (enabled / topK / useRerank / rerankModel / embeddingModel / autoMine).
- **Activity domain** — every mining run emits an `agent_action` event so users can see what got remembered.
- **OpenRouter** — embeddings + entity-extraction LLM calls + optional rerank model all route through the existing OpenRouter client; cost rolls into the existing per-source breakdown (`memory_embed`, `memory_extract`, `memory_rerank`, `memory_qa`).

## Business rules

- **Verbatim-only drawers** — drawer content is never paraphrased. AAAK + embeddings are the index; the source text stays exact for auditability.
- **Per-user isolation** — every drawer/wing/entity is FK'd to a `userId` with cascade-on-delete. There's no shared memory pool.
- **Soft staleness on relations** — overwriting a relation creates a new row and bumps `validTo` on the old one rather than mutating it; the timeline is preserved.
- **Embedding-dimension lock** — the pgvector column is `vector(1536)`. Switching embedding models that change dimension requires a migration + reindex; the settings UI restricts choices to compatible models.
- **Mining cost cap** — each conversation incurs one small LLM call for entity extraction (default `openai/gpt-4o-mini` via OpenRouter) plus one embedding call per turn. These show up in the cost dashboard tagged `source='memory_extract'` and `source='memory_embed'`.

## Benchmark

The `/scripts/bench/longmemeval/` directory is a complete LongMemEval pipeline that ingests 500 long-context conversation instances from HuggingFace, runs the retrieval and QA stages through this implementation, and scores against the upstream baseline. The npm scripts:

- `bun run bench:longmemeval:download` — fetches `longmemeval_s_cleaned.json`, `longmemeval_oracle.json`, and `longmemeval_m_cleaned.json` into `data/longmemeval/`.
- `bun run bench:longmemeval:ingest` — replays haystack sessions through `mineConversation` per instance.
- `bun run bench:longmemeval:retrieve` — runs `recall` for each question; emits `retrieval_logs/{run_id}.jsonl`.
- `bun run bench:longmemeval:score-retrieval` — computes session-level R@5, R@10, turn-level recall (target ≥96% R@5).
- `bun run bench:longmemeval:qa` — RAG prompt + reader model; emits `generation_logs/{run_id}.jsonl`.
- `bun run bench:longmemeval:score-qa` — GPT-4o judge scoring per upstream `evaluate_qa.py`.
- `bun run bench:longmemeval:full` — end-to-end pipeline on `longmemeval_s`.
- `bun run bench:longmemeval:smoke` — 10-instance subset for fast smoke checks (gated by `RUN_LONGMEMEVAL=1`).

The benchmark uses an isolated test schema scoped per-run so it never pollutes the dev/prod database.

## Edge cases

- **Empty conversation** — mining no-ops; no drawers created.
- **No matching memories** — recall returns an empty context block (the `<memory_context>` element is omitted) so the model doesn't see "no memories found" filler.
- **Agent with `memory.disabled = true`** — recall is skipped for that agent's chats but mining still runs (so other agents in the same user's palace benefit).
- **Embedding API failure** — drawer is still written but with a null embedding; a backfill job (future work, queued onto the `#17` jobs system) re-embeds nullable rows.
- **Massive conversations (>50 turns)** — mining batches the entity-extraction call across windows of 8-10 turns to keep the LLM input bounded.
- **Duplicate detection** — wings/rooms/closets dedupe by slug + alias matching; mining the same conversation twice is idempotent.
