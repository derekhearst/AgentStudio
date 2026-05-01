# Memory Implementation TODO

Tracking porting MemPalace memory + LongMemEval validation into AgentStudio. See [plan.md](plan.md) for full details.

## Phase 0 — Reference clones ✅

- [x] Add `vendor/` and `data/longmemeval/` to `.gitignore`
- [x] Clone `MemPalace/mempalace` to `vendor/mempalace`
- [x] Clone `xiaowu0162/LongMemEval` to `vendor/LongMemEval`
- [x] Skim canonical reference files

## Phase 1 — Schema & storage ✅

- [x] `src/lib/memory/memory.schema.ts` with wings/rooms/closets/drawers/kg tables
- [x] `drizzle/0011_memory_palace.sql` migration with HNSW + tsvector GIN indexes
- [x] `drizzle/0012_dapper_cerebro.sql` adds `app_settings.memory_config`
- [x] Auto-bootstrap via `db.server.ts`

## Phase 2 — Core memory modules ✅

- [x] `embeddings.server.ts` (1536-dim, openai/text-embedding-3-small)
- [x] `aaak.server.ts` (encode/decode + slugify)
- [x] `palace.server.ts` (slugify + getOrCreate Wing/Room/Closet)
- [x] `mining.server.ts` (LLM extraction → drawers, GPT-4o-mini)
- [x] `retrieval.server.ts` (hybrid semantic + keyword + temporal)
- [x] `rerank.server.ts` (Claude Haiku 4 reranker)
- [x] `kg.server.ts` (entities + relations with validity windows)
- [x] `memory.server.ts` facade (recallForUser + mineConversation + renderMemoryContext)
- [x] `memory.remote.ts` (browser-callable queries + delete command)

## Phase 3 — Chat integration ✅

- [x] Memory recall + `<memory_context>` injection in `routes/chat/[id]/stream/+server.ts`
- [x] Auto-mine on conversation completion (with sourceMessageId dedup)
- [x] `memoryConfig` settings (enabled/autoMine/topK/useRerank/rerankModel/embeddingModel)

## Phase 4 — UI ✅

- [x] `src/routes/memory/+page.svelte` — 4-column palace browser + search
- [x] Settings → Memory Palace section
- [x] Sidebar nav entry

## Phase 5 — LongMemEval harness ✅

- [x] `bench.config.ts` (datasets, paths, synthetic UUIDs, runId)
- [x] `download-data.ts` (HuggingFace cleaned datasets)
- [x] `ingest.ts` (haystack_sessions → mineSession)
- [x] `retrieve.ts` (per-question recall + session metrics)
- [x] `score-retrieval.ts` (R@5/10, NDCG@5/10)
- [x] `qa.ts` (RAG generation, default Claude Sonnet 4)
- [x] `score-qa.ts` (GPT-4o judge ported from `evaluate_qa.py`)
- [x] `smoke.ts` (chained ingest → retrieve → score-retrieval driver)
- [x] `bench:longmemeval:*` scripts wired in `package.json`

## Phase 6 — Tests ✅

- [x] `src/lib/memory/aaak.server.test.ts` — 6 `bun test` unit tests passing
- [x] `tests/memory.spec.ts` — Playwright UI smoke (palace browser + settings panel)

## Phase 7 — Docs ✅

- [x] `docs/memory/memory.md` (domain doc — pipeline, schema, bench)
- [x] README updated with Memory Palace section + bench commands

## Verification

- [x] `bun run check` → memory modules clean (1 unrelated pre-existing `bun:test` types warning)
- [x] `bun test src/lib/memory/aaak.server.test.ts` → 6/6 pass
- [x] `bun run bench:longmemeval:download` → oracle (15MB), s (277MB), m (2.7GB) downloaded
- [x] `bun run bench:longmemeval:ingest --dataset=oracle --limit=1` → 36 drawers persisted
- [x] `bun run bench:longmemeval:retrieve --dataset=oracle --limit=1` → jsonl produced
- [x] `bun run bench:longmemeval:score-retrieval` → R@5=1.0 / NDCG@5=1.0 (n=1)
- [x] `bun run bench:longmemeval:smoke --dataset=oracle --limit=3` → end-to-end OK, R@5=1.0 (n=3)
- [ ] Full oracle R@5 parity check vs. MemPalace publication (large run, manual)
