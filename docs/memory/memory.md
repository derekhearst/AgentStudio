# Memory Palace

AgentStudio's long-term memory layer is a TypeScript port of [MemPalace](https://github.com/wcw9/mempalace) integrated directly into the codebase (no external dependency). Memories are mined from chat conversations, stored in Postgres + pgvector, and retrieved via hybrid (semantic + keyword + temporal) search before each user turn.

## Hierarchy

```
Wing      person | project | topic | agent
 └─ Room    one per (session, day)
     └─ Closet  groups turns sharing a topic
         └─ Drawer  one per turn — content + embedding + AAAK pointer
```

Plus a lightweight knowledge graph (`memory_kg_entities`, `memory_kg_relations`) with validity windows (`valid_from` / `valid_to`) so facts can be invalidated when overwritten.

## AAAK (Address-Anchored Annotated Key)

Every drawer has an AAAK pointer:

```
§ W-042/R-11/D-007
@p alice~bob
@l tokyo
@e conf-25
@i lemon-ginger-tea
@t 2024-08-15
```

This compresses navigation across the palace and gives us a deterministic keyword bag for retrieval boost. See [src/lib/memory/aaak.server.ts](../../src/lib/memory/aaak.server.ts).

## Pipeline

1. **Mining** — At conversation completion (or on-demand), [`mineConversation`](../../src/lib/memory/memory.server.ts) sends the transcript to `openai/gpt-4o-mini` (configurable) which returns the primary wing + per-turn topic/tags as strict JSON. Each turn is then embedded via `openai/text-embedding-3-small` (1536 dim) and inserted as a drawer. Already-mined messages are skipped via `source_message_id` dedup.
2. **Recall** — On every user turn, [`recallForUser`](../../src/lib/memory/memory.server.ts) computes a hybrid score:
   - semantic: `1 - (drawer.embedding <=> query)::vector`
   - keyword: `ts_rank(to_tsvector(content), to_tsquery(query))`
   - temporal: `exp(-Δdays / decayDays)`
   - preference boost: most-recent drawer per (closet, role) gets +0.05
     Final = `semantic * w_s + keyword * w_k + temporal * w_t + boost`. The top-K drawers are wrapped in a `<memory_context>` system block and prepended to the LLM call.
3. **(Optional) Rerank** — When `useRerank` is enabled, the top-`candidatePoolSize` (default 20) candidates are re-ranked by a cheap LLM (`anthropic/claude-haiku-4` by default) before the final `topK` are returned.
4. **Knowledge graph** — Mining can populate entities/relations with validity windows; queries respect `valid_from <= at AND (valid_to IS NULL OR valid_to > at)`.

## Settings

Per-user settings under **Settings → Memory Palace** (also exposed via `app_settings.memory_config`):

| Key              | Default                         | Notes                                        |
| ---------------- | ------------------------------- | -------------------------------------------- |
| `enabled`        | `true`                          | Inject memory context into chat.             |
| `autoMine`       | `true`                          | Mine conversations after each completed run. |
| `topK`           | `5`                             | Drawers injected into context.               |
| `useRerank`      | `false`                         | Toggle Claude Haiku reranking.               |
| `rerankModel`    | `anthropic/claude-haiku-4`      | Override the rerank model.                   |
| `embeddingModel` | `openai/text-embedding-3-small` | Embedding model (1536 dim assumed).          |

## Browser UI

The four-column browser at [/memory](../../src/routes/memory/+page.svelte) lets you walk Wings → Rooms → Closets → Drawers, run semantic search, and delete drawers individually. Drawers are also queryable through the remote endpoints in [src/lib/memory/memory.remote.ts](../../src/lib/memory/memory.remote.ts).

## LongMemEval bench harness

A full port of the LongMemEval evaluation lives under [scripts/bench/longmemeval/](../../scripts/bench/longmemeval/). It feeds every haystack session through the same `mineSession()` pipeline used in production, then queries with `recall()` and (optionally) `rerank()`.

```bash
# 1. download the three official cleaned datasets (~600MB)
bun run bench:longmemeval:download

# 2. ingest a slice; each instance is namespaced to a synthetic user UUID
bun run bench:longmemeval:ingest --dataset=oracle --runId=lme_smoke --limit=10

# 3. retrieve top-K drawers per question
bun run bench:longmemeval:retrieve --dataset=oracle --runId=lme_smoke --limit=10

# 4. score retrieval (mirrors print_retrieval_metrics.py)
bun run bench:longmemeval:score-retrieval --runId=lme_smoke

# 5. (optional) RAG QA + LLM judge
bun run bench:longmemeval:qa --dataset=oracle --runId=lme_smoke --limit=10
bun run bench:longmemeval:score-qa --dataset=oracle --runId=lme_smoke

# all-in-one smoke run
bun run bench:longmemeval:smoke --dataset=oracle --limit=5
```

Outputs:

- `retrieval_logs/<runId>.jsonl` — per-question retrieved drawers + session metrics
- `generation_logs/<runId>.jsonl` — RAG hypotheses
- `generation_logs/<runId>.jsonl.eval.jsonl` — judge labels

Both directories are gitignored.

## Schema

See [src/lib/memory/memory.schema.ts](../../src/lib/memory/memory.schema.ts) and migration [drizzle/0011_memory_palace.sql](../../drizzle/0011_memory_palace.sql) (+ [0012_dapper_cerebro.sql](../../drizzle/0012_dapper_cerebro.sql) for `app_settings.memory_config`). HNSW + tsvector GIN indexes are created automatically; pgvector and pgcrypto extensions are bootstrapped at app start in [src/lib/db.server.ts](../../src/lib/db.server.ts).

## Tests

- [src/lib/memory/aaak.server.test.ts](../../src/lib/memory/aaak.server.test.ts) — `bun test` unit tests for the AAAK encoder/decoder.
- [tests/memory.spec.ts](../../tests/memory.spec.ts) — Playwright UI smoke (palace browser + settings panel).
