# Memory Spec

## Overview

AgentStudio's memory system gives agents persistent, searchable knowledge that survives across conversations. It is a hierarchical palace structure (Wings → Rooms → Closets → Drawers) backed by pgvector for semantic retrieval, a temporal knowledge graph for entity and relation tracking, and a hybrid retrieval pipeline that combines vector similarity, keyword matching, and temporal proximity. Memory is mined automatically from completed conversations and recalled at the start of relevant turns.

## Data Model

### Palace structure

Memory is organized in a strict four-level hierarchy that mirrors how humans associate knowledge.

```
Wing (a person, project, or topic)
  └── Room (a conversation / time slice)
        └── Closet (a topic within the conversation)
              └── Drawer (a verbatim message or note)
```

### `memoryWings` table

| Column      | Type      | Description                                                          |
| ----------- | --------- | -------------------------------------------------------------------- |
| `id`        | uuid      | Primary key                                                          |
| `userId`    | uuid      | FK to `users` — owner                                                |
| `agentId`   | uuid?     | FK to `agents` — if wing is agent-scoped                             |
| `kind`      | enum      | `person`, `project`, `topic`                                         |
| `name`      | text      | Display name (e.g., "Alice", "eFoil Project", "TypeScript Patterns") |
| `slug`      | text      | Unique per user                                                      |
| `aliases`   | text[]    | Alternative names for this wing (matched during mining)              |
| `createdAt` | timestamp |                                                                      |

### `memoryRooms` table

| Column           | Type      | Description                                               |
| ---------------- | --------- | --------------------------------------------------------- |
| `id`             | uuid      | Primary key                                               |
| `wingId`         | uuid      | FK to `memoryWings`                                       |
| `label`          | text      | Human-readable label (e.g., "Conversation on 2026-04-28") |
| `conversationId` | uuid?     | FK to `sessions` — source conversation                    |
| `occurredAt`     | timestamp | When the conversation happened                            |
| `summary`        | text      | AI-generated summary of this room's content               |

### `memoryClosets` table

| Column    | Type | Description                       |
| --------- | ---- | --------------------------------- |
| `id`      | uuid | Primary key                       |
| `roomId`  | uuid | FK to `memoryRooms`               |
| `topic`   | text | Topic label for this closet       |
| `summary` | text | Summary of drawers in this closet |

### `memoryDrawers` table

The atomic unit of memory. One drawer per verbatim message or note.

| Column            | Type         | Description                                          |
| ----------------- | ------------ | ---------------------------------------------------- |
| `id`              | uuid         | Primary key                                          |
| `closetId`        | uuid         | FK to `memoryClosets`                                |
| `content`         | text         | Verbatim message or note content                     |
| `role`            | enum         | `user`, `assistant`, `system`, `note`                |
| `embedding`       | vector(1536) | OpenAI text-embedding-3-small vector                 |
| `aaak`            | jsonb        | AAAK index pointer: `§ W-042/R-11/D-007` + tag lines |
| `tokenCount`      | integer      | Token count of `content`                             |
| `sourceMessageId` | uuid?        | FK to the original session message if applicable     |
| `createdAt`       | timestamp    |                                                      |

### `memoryKgEntities` table

Entities extracted from conversations and stored in the knowledge graph.

| Column       | Type  | Description                                                 |
| ------------ | ----- | ----------------------------------------------------------- |
| `id`         | uuid  | Primary key                                                 |
| `userId`     | uuid  | FK to `users`                                               |
| `name`       | text  | Entity name                                                 |
| `type`       | text  | Entity type (person, project, technology, preference, etc.) |
| `attributes` | jsonb | Structured attributes for this entity                       |

### `memoryKgRelations` table

Temporal relations between entities.

| Column           | Type       | Description                                              |
| ---------------- | ---------- | -------------------------------------------------------- |
| `id`             | uuid       | Primary key                                              |
| `userId`         | uuid       | FK to `users`                                            |
| `fromEntityId`   | uuid       | FK to `memoryKgEntities`                                 |
| `toEntityId`     | uuid       | FK to `memoryKgEntities`                                 |
| `relation`       | text       | Relation type (e.g., `prefers`, `works_on`, `dislikes`)  |
| `validFrom`      | timestamp  | When this relation became true                           |
| `validTo`        | timestamp? | When this relation was superseded (null = still true)    |
| `sourceDrawerId` | uuid?      | FK to `memoryDrawers` — where this relation was inferred |
| `confidence`     | numeric    | 0.0–1.0 confidence score                                 |

## Features

### Automatic memory mining

When a chat session ends (run reaches `completed`), the `after_run` built-in hook enqueues a `memory_mine` job. The job:

1. Loads the completed session's messages
2. Calls a small LLM (gpt-4o-mini) to extract entities, relations, and topics from the conversation
3. Upserts `memoryWings`, `memoryRooms`, and `memoryClosets` (matching by slug/alias)
4. Creates `memoryDrawers` with verbatim content + embeddings + AAAK indexes
5. Updates the temporal knowledge graph with new or superseded relations

Mining is idempotent: re-mining the same session produces the same drawers (deduped by `sourceMessageId`).

### AAAK index

Every drawer has an AAAK (Associative Addressable Access Key) pointer that provides a compressed location reference:

- A compact pointer like `§ W-042/R-11/D-007`
- Tag lines: `@p` (person), `@l` (location), `@e` (event), `@i` (item/object), `@t` (time)

AAAK pointers allow the retrieval pipeline to quickly filter drawers by associative tags without scanning all embeddings.

### Hybrid retrieval pipeline

When the agent needs to recall context, `recall(userId, query, opts)` runs a four-stage pipeline:

| Stage   | Method                                                                                |
| ------- | ------------------------------------------------------------------------------------- |
| Stage 1 | Cosine similarity on `embedding` vectors (pgvector `<=>` operator) — top-N candidates |
| Stage 2 | Keyword/BM25 boost using Postgres `tsvector` over `content` and AAAK tag lines        |
| Stage 3 | Temporal proximity boost: drawers closer in time to `question_date` score higher      |
| Stage 4 | Preference pattern boost: drawers matching the user's detected preference patterns    |

### LLM reranking (optional)

Top-20 candidates from the hybrid pipeline can be passed to a reader model (default: `anthropic/claude-haiku`) that re-ranks them by relevance to the specific query. Controlled by `appSettings.memoryRerank`. Adds latency but improves recall precision significantly.

### Recall injection

At the start of each user turn (before the LLM call), `recallForTurn(userId, userMessage)` retrieves the top-K drawers (default K=5) and injects them into the system prompt as a `<memory_context>` block:

```xml
<memory_context>
  [Drawer content, formatted with AAAK pointer and room/closet labels]
</memory_context>
```

Memory recall is on by default for the orchestrator. It can be disabled per-agent in `agents.config.memory.enabled = false`.

### Memory tools

Available when the `memory` capability group is enabled:

| Tool            | Description                                                           |
| --------------- | --------------------------------------------------------------------- |
| `recall_memory` | Query memory with a custom question; returns formatted drawer results |
| `save_note`     | Explicitly save a note as a new drawer without waiting for mining     |

### Memory palace browser UI

`/memory` — palace browser with a tree of Wings → Rooms → Closets → Drawers. Includes:

- Search box that runs the hybrid retrieval pipeline
- AAAK pointer preview per drawer
- Full drawer content view
- Delete control (soft-delete; marks drawer inactive)

### Artifact version grounding

Memory drawers can reference specific artifact versions. A drawer about a project artifact includes the `artifactVersionId` in its AAAK jsonb so recall results link directly to the specific version.

### Benchmark validation

Memory retrieval quality is measured by LongMemEval R@5 (retrieval recall @ 5 candidates). The benchmark runs via `bun run bench:longmemeval:*` scripts against the `longmemeval_s` dataset. Target: ≥96% R@5 raw (without reranking).

## Behavior Contracts

- Memory drawers are never updated after creation. Corrections create new drawers; old ones are soft-deleted.
- `memoryKgRelations` with `validTo = null` are the currently true relations. Superseded relations have `validTo` set; they are not deleted.
- Memory mining is async and does not block session completion or chat response.
- Memory recall injects at most `appSettings.memoryTopK` drawers into the context per turn. The cap prevents memory from consuming the entire context window.
- `save_note` creates a drawer immediately in the appropriate wing/closet (resolved from the current session's project context or a user-provided wing name). It does not require a room/closet to already exist; they are created if needed.
- Memory from one user is never accessible to another user. User isolation is enforced by `userId` on all palace tables.

## Roles & Permissions

| Action                      | Who can do it      |
| --------------------------- | ------------------ |
| View own memory palace      | Authenticated user |
| Search own memory           | Authenticated user |
| Delete a drawer             | Owner user, admin  |
| Configure memory settings   | Owner user, admin  |
| View another user's memory  | Admin only         |
| Disable memory for an agent | Owner user, admin  |
| Run LongMemEval benchmark   | Admin only (CLI)   |

## Rewrite Authority

The current implementation is a baseline, not a constraint. This domain may be rewritten, restyled, reorganized, or replaced as needed to achieve the target product quality. No code path is off-limits if behavior contracts, safety controls, tests, and documentation remain correct.

## UI Contract

This domain follows the shared UX system in [../ui/spec.md](../ui/spec.md).

- Surfaces in this domain must align with the shared desktop/mobile shell patterns.
- Domain-specific states must be explicit in the UI (for example pending, running, blocked, completed) where applicable.
- Blocking user decisions must use the shared action-card and inbox patterns where applicable.

## References
- [MemPalace](https://github.com/mempalace/mempalace) — hierarchical memory architecture (Wings/Rooms/Closets/Drawers) and AAAK index that AgentStudio's memory is ported from
- [LongMemEval — Xiaowu Liu et al.](https://github.com/xiaowu0162/LongMemEval) — long-context memory evaluation benchmark
- [Honcho — Plastic Labs](https://github.com/plastic-labs/honcho) — user-model memory for agents
- [Building Effective Agents — Anthropic](https://www.anthropic.com/research/building-effective-agents) — memory as a harness primitive
- [The Anatomy of an Agent Harness — LangChain](https://blog.langchain.com/the-anatomy-of-an-agent-harness/) — external memory integration patterns
- **Internal:** `src/lib/memory/memory.schema.ts`, `src/lib/memory/memory.server.ts`, `src/lib/memory/retrieval.server.ts`, `src/lib/memory/mining.server.ts`, `src/routes/memory/`, `scripts/bench/longmemeval/`

