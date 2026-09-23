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

A drawer also carries the flags a user sets on it:

| Field | Meaning |
| --- | --- |
| `pinned` | Always considered during recall, with a small score boost. |
| `neverRecall` | Browsable in the palace, excluded from every recall. |
| `editedAt` | Set when a human rewrote the mined text; blank means "as mined". |
| `sourceMessageId` | The chat message this drawer came from, so every memory links back to its origin. |

### Control records

Two supporting records exist purely so a user can manage what was remembered:

| Entity | What it is |
| --- | --- |
| **Exclusion rule** | A named pattern the miner checks before storing anything. Credential rules ship built in; users add their own. Tracks how many turns it has blocked and when it last fired. |
| **Recall event** | One row per drawer per recall, holding the query, the source (chat / agent / search / bench), the rank, and the semantic / keyword / temporal / pinned components of its score. Retained 30 days; deleted with its drawer. |

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
5. **Pin boost** — drawers the user pinned are added to the candidate pool regardless of distance and get a small additive bonus.

Drawers flagged **never recall** are removed from the candidate pool before any of this runs. Every drawer that survives carries its component scores back to the caller, which is what the palace uses to answer "why was this recalled?".

The top results get formatted into a `<memory_context>…</memory_context>` block prepended to the system prompt.

### Optional rerank

When `useRerank` is enabled in settings, the top 20 candidates are sent to a cheap reader model (default `anthropic/claude-haiku`) which promotes the best 5. This trades a small amount of latency for higher precision on ambiguous queries.

## User flows

### Automatic mining (after every exchange)

1. The user finishes a chat exchange (or the run completes naturally).
2. The system queues a background mining job for that conversation — the user sees their assistant reply immediately and never waits.
3. The job mines only what is new: turns that already have a drawer are skipped, and so are turns the user removed from memory (see **Managing what was remembered** below).
4. Mining extracts entities and topics via a small LLM call, then writes one drawer per new turn into the palace, computing AAAK indexes and embeddings inline.
5. An `agent_action` activity event of type `memory_mined` records what landed.

A conversation holds at most one queued mining job at a time: if the user sends several messages while a job is still waiting, they all fold into that one job. If an exchange finishes while the job is already mining, the job goes round again for the new turns before it finishes — so the last exchange of a conversation is mined too, not left for an exchange that may never come. (It goes round at most five times; anything still left after that waits for the next exchange or **Mine pending**.) Once the job is done, the next exchange queues a fresh one. (Until September 2026 a conversation's mining job could only ever run once, so everything said after its first exchange was never memorized. **Mine pending** on the Memory page catches up any conversation left behind.)

### Mine pending

The **Mine pending** button on the Memory page queues a mining job for every conversation that still holds a turn the miner would pick up — a turn with some text, no drawer, and not removed by the user. It reports how many conversations it scanned and how many new jobs it queued; a conversation whose mining job was already waiting is not counted twice.

### Automatic recall (on every user message)

1. The user types a message and submits.
2. Before the model is called, `recallForUser(userId, message, { topK })` runs.
3. The retrieval pipeline returns the top-K drawers ranked by hybrid score.
4. The drawers are rendered into a compact memory context block (`<memory_context>…</memory_context>`) and prepended to the system prompt.
5. The model now has the relevant past context and can answer with continuity.

### Manual palace browsing (`/memory`)

The Memory page shows the palace tree (wings → rooms → closets → drawers), a search box that runs the same retrieval pipeline against arbitrary queries, an AAAK preview for each drawer, and a delete control for surgical pruning.

### Managing what was remembered

Browsing the palace is not the same as controlling it, and control is what makes a memory system trustworthy. The Memory page has a **Manage** dialog plus per-drawer controls that let a user undo or pre-empt anything the miner did.

#### Editing a drawer

Mining paraphrases, and a wrong paraphrase that gets recalled forever is worse than no memory at all. Open any drawer and choose **Edit** to rewrite it.

When the text changes, the system re-embeds the drawer in the same step so the vector and the text always agree. If the embedding service is unavailable, the system **clears** the vector rather than leaving the old one in place — a drawer with no vector drops out of semantic search (so it can never be matched on wording it no longer contains) and is picked back up automatically by the next **Reorganize** embedding backfill. The panel says so when this happens, and the drawer's metadata shows whether an embedding is present.

An edited drawer is stamped with an "edited" marker in the palace so a reader can tell a human correction from a mined paraphrase.

#### Pin and never-recall

Every drawer carries two independent flags:

| Flag | Meaning |
| --- | --- |
| **Pinned** | "Always consider this." The drawer is added to the recall candidate pool even when it falls outside the nearest-neighbour cut, and gets a small additive score boost (default `0.15`). |
| **Never recall** | "Remember that you know this, but never use it." The drawer stays visible and editable in the palace, but is excluded from every recall before scoring begins, so it can never reach a prompt. |

Never-recall is the softer alternative to deletion: the user keeps the record and the audit trail without the drawer influencing future answers.

#### Why was this recalled?

Every recall — from chat, from an agent, or from the palace search box — records the component scores it computed for each drawer it returned: semantic similarity, keyword rank, temporal proximity, any pinned boost, the final score, the rank, the query text, and the recall weights in force at the time.

Open a drawer and the **Why was this recalled?** section replays the most recent of those, so a bad recall can be diagnosed ("it won on keyword, not meaning") instead of guessed at. The log keeps 30 days and is pruned opportunistically; deleting a drawer deletes its provenance with it.

#### Forgetting a whole conversation

The **Manage → Mined conversations** tab lists every conversation that currently has memories, with its drawer and room counts. **Forget** deletes that conversation's rooms, which cascades through its closets to its drawers, and removes any wing left empty as a result.

The chat transcript itself is untouched, but everything it held at the moment of forgetting is marked as removed from memory, so neither the next exchange's mining run nor a **Mine pending** sweep brings it back. Messages sent in that conversation *after* forgetting are mined as usual.

#### Deleting a single drawer

Deleting a drawer works the same way: the message it came from is marked as removed, so the drawer does not reappear the next time the conversation is mined.

#### Exclusion rules

Exclusion rules are a deny list the miner checks **before** it calls the embedding provider and before it writes anything. A turn that matches an enabled rule is dropped entirely: it never leaves the process and never becomes a drawer. Ordering matters here — filtering after insert would mean the secret had already been embedded and stored.

Each rule has a name, a match kind (`regex` or `substring`), a pattern, an on/off switch, and a running count of how many turns it has blocked.

A turn a rule has blocked stays out of memory for good — it is marked so that later mining runs skip it, which also keeps the rule's count honest (one blocked turn counts once, not once per exchange). Disabling the rule afterwards does not bring earlier blocked turns back; it only stops blocking new ones.

A set of credential rules is built in and enabled for every user:

| Rule | Catches |
| --- | --- |
| Secret assignment | `password = …`, `API_KEY: …`, "my api key is …" |
| AWS access key id | `AKIA…` / `ASIA…` identifiers |
| Provider API key | `sk-` / `pk-` / `rk-` style keys (OpenAI, OpenRouter, Anthropic, Stripe) |
| GitHub token | `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_` tokens |
| Private key block | PEM-armoured private keys |
| JSON web token | three base64url segments in JWT shape |
| Connection string credentials | `scheme://user:password@host` URLs |

Built-in rules can be disabled or reworded but not deleted. Users can add their own for anything else they would rather not have remembered — a home address, a client name, a medical detail.

The Manage dialog includes a **tester**: paste something you would not want remembered and it reports which rule would block it (showing only a redacted fragment of the match, never the whole value). Nothing typed into the tester is stored.

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

- **Verbatim-only drawers** — mining never paraphrases; AAAK + embeddings are the index and the source text stays exact for auditability. The one exception is a deliberate human edit, which is stamped with an `editedAt` timestamp so the change is visible.
- **Text and vector must agree** — a drawer's embedding is derived from its content. Any write that changes content either writes a fresh embedding or writes none at all. A stale vector is never left behind, because it would make the drawer match wording it no longer contains while the UI showed something else.
- **Exclusion runs before embedding** — the deny list is evaluated on the raw turn before the extraction call and before the embedding call, so excluded content never leaves the process.
- **Never-recall is enforced in the query, not the ranking** — excluded drawers are filtered out of the candidate pool by the database predicate rather than scored to the bottom, so no scoring change can accidentally surface them.
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
- **Duplicate detection** — wings/rooms/closets dedupe by slug + alias matching; mining the same conversation twice is idempotent, because a turn that already has a drawer is skipped.
- **A turn that arrives while its conversation is being mined** — the running job has already read the conversation, so that turn waits for the next exchange's job (or a **Mine pending** sweep).
- **Every turn in a conversation is excluded** — mining reports the exclusion count and the rules that fired (visible on the job in `/settings/jobs`), so "nothing was mined" is distinguishable from "a rule blocked it".
- **A broken exclusion pattern** — a rule whose regex no longer compiles is logged and treated as never matching, rather than throwing and wedging the mining job. The rule editor validates patterns on save, so this only happens to rules written before a validation change.
- **Editing a drawer while the embedding provider is down** — the text is saved and the vector is cleared. The drawer keeps working in keyword search and stays browsable; **Reorganize** re-embeds it later.
- **Forgetting a conversation that spans several wings** — each wing that has rooms from that conversation loses those rooms; wings left with nothing are deleted, wings with other rooms survive.
