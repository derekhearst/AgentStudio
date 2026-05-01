# Plan: Port MemPalace memory into AgentStudio + LongMemEval validation

## TL;DR

Port MemPalace's hierarchical memory architecture (Wings → Rooms → Closets → Drawers + AAAK index + temporal knowledge graph + hybrid retrieval) directly into AgentStudio as a TypeScript/Drizzle/pgvector implementation — no Python dependency. Auto-mine on conversation end and retrieve on every user turn. Validate by porting LongMemEval's retrieval + QA evaluator and exposing them as `bun run bench:longmemeval:*` scripts that download the HuggingFace dataset, ingest, retrieve, score R@5, and run QA judging via GPT-4o through OpenRouter. Target: ≥96% R@5 raw on `longmemeval_s`.

## Decisions (confirmed)

- **Embeddings**: OpenAI/OpenRouter embeddings API (`text-embedding-3-small` @ 1536 dim).
- **Vector store**: pgvector on existing Postgres (extension already installed in `db.server.ts`).
- **Benchmark scope**: Both retrieval (R@5) and QA (GPT-4o judge), each behind its own npm script.
- **Integration**: Auto-mine on conversation end + retrieve top-K on each user turn (transparent, like MemPalace's auto-save hooks).

## Phases

### Phase 0 — Reference clones (read-only)

1. Clone `MemPalace/mempalace` and `xiaowu0162/LongMemEval` into a sibling `vendor/` folder (gitignored). Reference-only — never imported, never shipped.
2. Add `vendor/` to `.gitignore`.
3. Identify the canonical files we will port from:
   - `mempalace/mempalace/backends/base.py` — backend interface
   - `mempalace/mempalace/palace/` — wing/room/closet/drawer logic
   - `mempalace/mempalace/aaak/` — AAAK index encoder
   - `mempalace/mempalace/kg/` — temporal knowledge graph
   - `mempalace/mempalace/retrieval/` — hybrid + rerank pipeline
   - `mempalace/benchmarks/longmemeval_bench.py` — official bench harness
   - `LongMemEval/src/evaluation/evaluate_qa.py` — QA judge prompts/logic
   - `LongMemEval/src/retrieval/` — retrieval baselines for parity
   - `LongMemEval/src/evaluation/print_*_metrics.py` — scoring formulas

### Phase 1 — Schema and storage (depends on Phase 0)

1. Create `src/lib/memory/memory.schema.ts` with Drizzle tables:
   - `memoryWings` — id, userId, agentId (nullable), kind (`person|project|topic`), name, slug, aliases (text[]), createdAt
   - `memoryRooms` — id, wingId, label, conversationId (nullable), occurredAt (timestamp), summary
   - `memoryClosets` — id, roomId, topic, summary
   - `memoryDrawers` — id, closetId, content (text, verbatim), role (`user|assistant|system|note`), embedding (`vector(1536)`), aaak (jsonb), tokenCount, sourceMessageId (nullable), createdAt
   - `memoryKgEntities` — id, userId, name, type, attributes (jsonb)
   - `memoryKgRelations` — id, userId, fromEntityId, toEntityId, relation, validFrom, validTo (nullable), sourceDrawerId, confidence
   - Indexes: pgvector HNSW on `memoryDrawers.embedding`; b-tree on `(userId, occurredAt)`; GIN on `aliases` and `aaak`.
2. Generate migration with `bunx drizzle-kit generate` → `drizzle/0011_*.sql`. Hand-edit to add `CREATE INDEX ... USING hnsw` and any pgvector ops not emitted by drizzle-kit.
3. Confirm bootstrap in `src/lib/db.server.ts` picks the new schema (it already globs `src/lib/**/*.schema.ts`).

### Phase 2 — Core memory modules (Phase 1 dependent; sub-steps can run in parallel)

Create under `src/lib/memory/`:

1. `embeddings.server.ts` — `embed(texts: string[])` → vectors via OpenRouter embeddings endpoint; batched, retry on 429; logs to `llmUsage` with `source='memory_embed'`.
2. `aaak.server.ts` — Port AAAK encoder: emits compressed pointer like `§ W-042/R-11/D-007` with tag lines (`@p`, `@l`, `@e`, `@i`, `@t`). Pure function over a drawer + parent context.
3. `palace.server.ts` — Wing/Room/Closet creation + lookup: `getOrCreateWing(userId, kind, name)`, `getOrCreateRoom(wingId, occurredAt, conversationId)`, `getOrCreateCloset(roomId, topic)`. Slug + alias matching to dedupe.
4. `mining.server.ts` — Given a conversation (list of messages + dates), extract wings/rooms/closets and write **verbatim** drawers (one per turn for sweep-style mining). Includes:
   - Entity/topic extraction via small LLM call (gpt-4o-mini through OpenRouter) returning structured JSON.
   - Per-turn drawer creation + AAAK index generation + embedding.
5. `retrieval.server.ts` — Hybrid retrieval mirroring MemPalace's pipeline:
   - Stage 1: cosine top-N on embeddings (pgvector `<=>` operator).
   - Stage 2: keyword/BM25-ish boost using Postgres `tsvector` over `content` + `aaak`.
   - Stage 3: temporal proximity boost based on `question_date` vs `occurredAt`.
   - Stage 4: preference-pattern extraction (port from MemPalace).
   - Returns ranked drawer ids with scores.
6. `rerank.server.ts` — Optional LLM rerank: send top-20 candidates to a reader model (configurable, default `anthropic/claude-haiku`), return promoted top-5.
7. `kg.server.ts` — Temporal entity/relation CRUD: `add`, `query`, `invalidate(relationId, validTo)`, `timeline(entityId)`. Backed by `memoryKgEntities` + `memoryKgRelations`.
8. `memory.server.ts` — Facade: `mineConversation(conversationId)`, `recall(userId, query, opts)`, `wakeUpContext(userId, opts)` — the public surface used elsewhere.
9. `memory.remote.ts` — SvelteKit remote queries/commands for UI: `listWings`, `getDrawer`, `searchMemory`, `deleteDrawer`. Permission-gated to owning user.

### Phase 3 — Chat integration (Phase 2 dependent)

1. In `src/lib/chat/chat.server.ts`:
   - Add a hook called when a chat run reaches `completed` (or on `compactMessages`) → enqueue `mineConversation(conversationId)`. Run async, log to `activityEvents` with type `memory_mined`.
   - Add a `recallForTurn(userId, userMessage, opts)` helper that returns formatted memory context (drawers + AAAK indexes) to prepend to the system prompt.
2. In the chat streaming entry point (find via `streamChat` callers in `chat.remote.ts`), call `recallForTurn` before building the LLM message array; inject as a `system` message with a `<memory_context>...</memory_context>` block.
3. Add settings to `src/lib/settings/` `appSettings`: `memoryEnabled` (bool), `memoryTopK` (default 5), `memoryRerank` (bool), `memoryEmbeddingModel`.
4. Per-agent override: read `agents.config.memory` jsonb to disable for specific agents (e.g., orchestrator).

### Phase 4 — UI surface (parallel with Phase 5)

1. New route `src/routes/memory/+page.svelte` — palace browser: tree of wings → rooms → closets → drawers, search box, AAAK preview, delete control.
2. Settings panel section under `src/routes/settings/` — toggles for memoryEnabled, topK, rerank, embedding model.
3. Add nav entry in `src/routes/+layout.svelte`.

### Phase 5 — LongMemEval benchmark harness (Phase 2 dependent)

Create `scripts/bench/longmemeval/`:

1. `download-data.ts` — Fetches `longmemeval_s_cleaned.json`, `longmemeval_oracle.json`, `longmemeval_m_cleaned.json` from HuggingFace into `data/longmemeval/`. Skips if already present. Verifies SHA.
2. `ingest.ts` — For each of 500 instances: create an isolated user/namespace in a dedicated test database, replay `haystack_sessions` through `mineConversation` using `haystack_dates` as `occurredAt`. Parallelizable across instances.
3. `retrieve.ts` — For each instance, call `recall(userId, question, { topK: 5, useRerank: false })`; emit `retrieval_logs/{run_id}.jsonl` with `{ question_id, retrieved_session_ids, retrieved_turn_ids }`.
4. `score-retrieval.ts` — Port `LongMemEval/src/evaluation/print_retrieval_metrics.py`: compute session-level R@5, R@10, turn-level recall. Skip the 30 abstention instances. Print summary table by question type. Target: ≥96% R@5 raw on session granularity.
5. `qa.ts` — Build a RAG prompt from retrieved drawers (use `READING_METHOD=con` style: extract-then-reason), call configured reader model via `streamChat`, write `generation_logs/{run_id}.jsonl` with `{ question_id, hypothesis }`.
6. `score-qa.ts` — Port `LongMemEval/src/evaluation/evaluate_qa.py`: use GPT-4o through OpenRouter as the judge, autoeval label per question, aggregate by question_type. Re-uses the exact judge prompts from the upstream file for parity.
7. `bench.config.ts` — Shared config: model selections, top-K, rerank toggle, run id, output dirs.
8. Add npm scripts in `package.json`:
   - `bench:longmemeval:download`
   - `bench:longmemeval:ingest`
   - `bench:longmemeval:retrieve`
   - `bench:longmemeval:score-retrieval`
   - `bench:longmemeval:qa`
   - `bench:longmemeval:score-qa`
   - `bench:longmemeval:full` — runs the entire pipeline end-to-end on `longmemeval_s`

### Phase 6 — Tests (Phase 2/3 dependent)

1. `tests/memory.spec.ts` (Playwright + SQL helpers):
   - Mining a seeded 3-message conversation creates exactly 1 wing, 1 room, ≥1 closet, ≥3 drawers.
   - Recall returns the seeded drawer when queried with a paraphrase.
   - AAAK pointer round-trips (encode/decode preserves keys).
   - KG: add → query → invalidate → timeline returns expected validity window.
2. `tests/memory.chat.spec.ts`: end-to-end chat run injects memory context into the next turn (mock embeddings to keep deterministic).
3. `tests/longmemeval.bench.spec.ts` (gated by env `RUN_LONGMEMEVAL=1`, default skipped in CI): runs a 10-instance subset of `longmemeval_s` through the full pipeline and asserts R@5 ≥ 0.8 on the subset as a smoke check.
4. Update `bun run test:e2e` baseline; add `bun run bench:longmemeval:smoke` for the subset run.

### Phase 7 — Documentation (parallel with Phase 6)

1. `docs/memory/memory.md` — domain doc per the global CLAUDE.md guide: concepts (wings/rooms/closets/drawers), AAAK, mining, recall, KG, business rules.
2. Update root `README.md` with a Memory section + link.

## Relevant files

- `src/lib/memory/*` — entire new domain (NEW)
- `src/lib/chat/chat.server.ts` — hook mining on run completion + `recallForTurn` injection
- `src/lib/chat/chat.remote.ts` — call `recallForTurn` in the stream entrypoint
- `src/lib/settings/settings.schema.ts` (or equivalent) — add memory toggles to `appSettings`
- `src/lib/agents/agents.schema.ts` — `agents.config` jsonb already exists; reuse for per-agent memory toggle (no schema change)
- `src/lib/db.server.ts` — confirms pgvector + new schema autoload (no change beyond migration)
- `drizzle/0011_*.sql` — generated migration with hand-edited HNSW index (NEW)
- `scripts/bench/longmemeval/*` — full benchmark harness (NEW)
- `tests/memory*.spec.ts`, `tests/longmemeval.bench.spec.ts` (NEW)
- `package.json` — new bench scripts
- `docs/memory/memory.md`, `README.md` — docs

## Verification

1. `bunx drizzle-kit generate` produces a clean migration; `docker compose up` boots app and bootstrap applies migration without errors.
2. `bun run check` — TypeScript + Svelte clean.
3. `bun run test:e2e` — existing suite still green; new `tests/memory.spec.ts` passes.
4. Manual: open `/memory`, see wings populated after a real chat session ends.
5. `bun run bench:longmemeval:download` fetches all three JSON files, prints sizes.
6. `bun run bench:longmemeval:full` end-to-end on `longmemeval_s` prints a metrics table; assert R@5 ≥ 0.96 (raw target). If lower, iterate on retrieval (Phase 2 step 5) before declaring done.
7. `bun run bench:longmemeval:qa` + `score-qa` produces autoeval labels matching upstream format (cross-check 5 sample labels against running `evaluate_qa.py` directly in `vendor/LongMemEval`).
8. `RUN_LONGMEMEVAL=1 bun run test:e2e tests/longmemeval.bench.spec.ts` — smoke subset passes.

## Scope boundaries

- **Included**: Wings/Rooms/Closets/Drawers, AAAK index, temporal KG, hybrid retrieval (semantic + keyword + temporal), optional LLM rerank, auto-mining, recall injection, palace browser UI, full LongMemEval pipeline (retrieval + QA judge), unit + bench tests, docs.
- **Excluded** (deliberately): Claude Code hooks integration (we are not Claude Code), MCP server (29 tools) — not needed since memory is in-process; Tauri-specific persistence; ConvoMem / LoCoMo / MemBench benchmarks (single-benchmark validation only); migration of existing chat history into memory at deploy (one-shot script can be added later).

## Further considerations

1. **Embedding model dimension**: pgvector column dim must match the chosen embedding model. Using `text-embedding-3-small` (1536) fixed for v1 to keep indexes simple.
2. **Mining cost**: A small LLM call per session for entity extraction. Using `openai/gpt-4o-mini` via OpenRouter for parity with title generation.
3. **Test DB isolation for bench**: The 500 instances must not pollute the dev/prod database. Using a dedicated `longmemeval_<runid>` Postgres schema scoped per-run, dropped after.
