# Deep Research — Spec

## Overview

Deep Research is an autonomous, long-horizon research capability that lets an agent answer complex questions by iteratively searching the web, reading full page content, and synthesizing a comprehensive, cited report — mirroring the "research analyst in minutes" pattern popularized by OpenAI Deep Research and Gemini Deep Research.

A user submits a research query. The agent first produces a structured **research plan** (a set of sub-questions). It then executes a **search–fetch–synthesize loop**: for each sub-question it issues web searches, selects the most relevant URLs, fetches full page text, extracts the relevant passages, and updates an internal working synthesis. After all sub-questions are covered the agent produces a **final report** with inline citations and a source list. The whole run executes as a background job, streaming progress events so the UI can show live status without blocking the chat thread.

---

## Data Model

### `research` table

| Column         | Type             | Notes                                                     |
| -------------- | ---------------- | --------------------------------------------------------- |
| `id`           | uuid PK          |                                                           |
| `userId`       | text FK → users  | owner                                                     |
| `agentId`      | text FK → agents | agent that ran the research                               |
| `runId`        | uuid FK → runs   | the run that spawned this                                 |
| `query`        | text             | original user query                                       |
| `status`       | enum             | `planning` `searching` `synthesizing` `complete` `failed` |
| `plan`         | jsonb            | array of `{ subQuestion, rationale }`                     |
| `report`       | text             | final Markdown report with inline citations               |
| `tokensBudget` | int              | max tokens the research loop may spend                    |
| `tokensUsed`   | int              | actual tokens consumed                                    |
| `searchCount`  | int              | total `web_search` calls made                             |
| `fetchCount`   | int              | total `web_fetch` calls made                              |
| `createdAt`    | timestamptz      |                                                           |
| `completedAt`  | timestamptz      | nullable                                                  |
| `errorMessage` | text             | nullable, set on failure                                  |

### `researchSources` table

| Column           | Type               | Notes                                          |
| ---------------- | ------------------ | ---------------------------------------------- |
| `id`             | uuid PK            |                                                |
| `researchId`     | uuid FK → research |                                                |
| `url`            | text               |                                                |
| `title`          | text               |                                                |
| `fetchedAt`      | timestamptz        |                                                |
| `contentSnippet` | text               | 500-char extract fed to the model              |
| `fullText`       | text               | full extracted page text, stored for re-use    |
| `relevanceScore` | float              | 0–1, LLM-judged relevance to the query         |
| `citedInReport`  | boolean            | whether the source appears in the final report |
| `subQuestion`    | text               | which sub-question this source helped answer   |

### `researchSteps` table

| Column       | Type               | Notes                                         |
| ------------ | ------------------ | --------------------------------------------- |
| `id`         | uuid PK            |                                               |
| `researchId` | uuid FK → research |                                               |
| `stepIndex`  | int                | ordering                                      |
| `stepType`   | enum               | `plan` `search` `fetch` `synthesize` `report` |
| `input`      | jsonb              | what was sent to the tool/model               |
| `output`     | jsonb              | what came back                                |
| `tokensUsed` | int                |                                               |
| `createdAt`  | timestamptz        |                                               |

---

## Features

### 1. Research Plan Generation

Before any searching begins the agent produces an explicit research plan. The plan is a list of 3–10 sub-questions that, when answered, fully address the original query. The plan is stored in `research.plan` and displayed to the user in the UI before execution starts, allowing the user to edit or approve it (optional approval gate, controlled per-agent).

### 2. `web_fetch` Tool

A new tool in the `research` capability group. Given a URL it returns the full readable text content of the page (HTML stripped, JS rendered if needed via Playwright). Returns:

- `title` — page title
- `text` — extracted readable text (up to 50k chars)
- `url` — final URL after redirects
- `fetchedAt` — timestamp

Content extraction uses Playwright's `page.textContent('body')` with fallback to a bare HTTP GET + HTML-strip. Hard limit: 50 000 chars; content is truncated at paragraph boundaries. Robots.txt is respected (returns error if disallowed).

### 3. `pdf_read` Tool

Reads a PDF from a URL or sandbox file path and returns extracted text (via `pdftotext` or a JS PDF parser). Returns the same shape as `web_fetch`. Limit: 100 pages or 100k chars, whichever is hit first.

### 4. Search–Fetch–Synthesize Loop

The runtime executes the research loop as a `research` job type (see `jobs` domain). Each iteration:

1. **Search** — calls `web_search` with a sub-question-derived query; up to 10 results returned.
2. **Select** — model picks up to 3 URLs to read based on titles/snippets.
3. **Fetch** — calls `web_fetch` for each selected URL; content stored in `researchSources`.
4. **Extract** — model identifies the passages most relevant to the sub-question.
5. **Update synthesis** — model updates a running internal synthesis document.

The loop continues until all sub-questions are covered or the token budget is exhausted. The model may spawn additional searches if it determines a sub-question is still under-answered.

**Loop limits:**

- Max searches: 30 per research run
- Max fetches: 50 per research run
- Max token budget: configurable per agent (default 200k tokens)
- Max wall time: 10 minutes (configurable)

### 5. Report Generation

After the loop completes the agent synthesizes a final Markdown report:

- Executive summary paragraph
- Section per sub-question with findings
- Inline citations using `[N]` notation
- Numbered source list at the end with URL, title, and date fetched

The report is stored in `research.report` and surfaced as a chat message from the agent with the full Markdown rendered.

### 6. Source Deduplication

If the same URL is encountered across multiple sub-question searches, only one fetch is performed; the stored `fullText` is reused. Deduplication is by normalized URL (scheme/host/path stripped of query params unless they are semantically significant).

### 7. Progress Streaming

The research job emits SSE events visible in the chat sidebar while running:

- `research:planning` — plan generated, listing sub-questions
- `research:search` — search issued, query shown
- `research:fetch` — URL being fetched, title shown
- `research:synthesizing` — synthesis pass running
- `research:complete` — report ready
- `research:failed` — error with message

### 8. Research Capability Group

Tools are organized into a new `research` capability group:

| Tool         | Description                                               |
| ------------ | --------------------------------------------------------- |
| `web_search` | Search the web (already in `core`) — also referenced here |
| `web_fetch`  | Fetch full text of a URL                                  |
| `pdf_read`   | Extract text from a PDF (URL or sandbox path)             |

The group is `alwaysOn: false`. The research orchestrator skill enables it at the start of every research run.

### 9. Async Execution via Jobs

Research runs are enqueued as a `research` job type in the `research` queue (medium priority). The job persists a `researchId` in its payload. A background worker picks it up, executes the full loop, and updates `research.status` throughout. The chat run associated with the research is kept open (status `running`) until the job completes, at which point the final report is appended as an assistant message and the run is closed.

### 10. Research Trigger

Research is triggered in two ways:

1. **Explicit** — user selects a "Deep Research" mode in the chat composer before sending (analogous to Claude/Gemini's mode toggle). The agent immediately routes the message to the research orchestrator.
2. **Implicit** — the orchestrator agent detects that the query warrants deep research (e.g., "write a comprehensive report on…", "research all options for…") and decides to invoke the research capability autonomously via `run_subagent`.

### 11. File Grounding

Users can attach files (PDFs, CSVs, text documents) as research context. Attached files are read via `pdf_read` or `file_read` at the start of the loop and treated as additional sources with `url = file://<filename>`.

### 12. Per-Agent Research Config

Each agent record can carry a `researchConfig` JSONB field:

```jsonc
{
	"maxSearches": 20,
	"maxFetches": 30,
	"tokenBudget": 150000,
	"requirePlanApproval": false,
	"allowedDomains": [], // empty = unrestricted
	"blockedDomains": [],
}
```

---

## Behavior Contracts

- **Planning is always done first.** The model never starts searching before producing a plan; the plan is written to `research.plan` before any `web_search` call.
- **Source deduplication is enforced by the runtime**, not by the model. The model cannot fetch the same normalized URL twice in a single research run.
- **Token budget is a hard cap.** If `tokensUsed` exceeds `tokenBudget` the loop terminates immediately and the report is synthesized from whatever has been gathered so far.
- **Wall-time limit is enforced by the job runner.** If the job exceeds `maxWallTimeMs` the job is failed with `errorMessage = "Research timed out after X minutes"`.
- **Robots.txt is respected.** `web_fetch` checks the robots.txt for the target domain before fetching. Disallowed URLs return an error result; the model is informed and must choose a different source.
- **Citations are verified.** Each `[N]` citation in the final report must map to a `researchSources` row with `citedInReport = true`. The report generation prompt explicitly lists all available source IDs and titles.
- **Research runs are isolated per run.** Two concurrent research jobs for different users or runs do not share source caches.
- **Report is append-only after generation.** Once `research.status = complete` the `report` column is never overwritten; follow-up research creates a new `research` record.

---

## Roles & Permissions

| Role                 | Capability                                                                     |
| -------------------- | ------------------------------------------------------------------------------ |
| User                 | Submit research queries, view own research records and reports                 |
| Agent (orchestrator) | Trigger research jobs, read any research record in their scope                 |
| Admin                | View all research records, cancel stuck jobs, adjust per-agent research config |

---

## Rewrite Authority

The current implementation is a baseline, not a constraint. This domain may be rewritten, restyled, reorganized, or replaced as needed to achieve the target product quality. No code path is off-limits if behavior contracts, safety controls, tests, and documentation remain correct.

## UI Contract

This domain follows [../ui/spec.md](../ui/spec.md) and defines plan-first research interactions.

- Surfaces: research setup card, source queue, progress timeline, citation viewer, and report artifact preview.
- States and badges: planning, sourcing, synthesizing, blocked-for-input, report-ready, and failed-source.
- Blocking actions: source approval or policy exceptions must route through action cards and review items.
- Mobile behavior: source and citation views collapse into tabbed sheets with persistent report actions.

## References

- [OpenAI Deep Research announcement](https://openai.com/index/introducing-deep-research/) — multi-step RL-trained browsing + Python tool use, 5–30 min async, full citations
- [Gemini Deep Research](https://blog.google/products/gemini/google-gemini-deep-research/) — plan-first, iterative browse, Markdown report export
- [Gemini Deep Research Max](https://blog.google/innovation-and-ai/models-and-research/gemini-models/next-generation-gemini-deep-research/) — MCP support, native charts, two tiers (fast/max), asynchronous background workflows
- [docs/jobs/spec.md](../jobs/spec.md) — job queue, lease-based execution, retry backoff
- [docs/runs/spec.md](../runs/spec.md) — durable run state, SSE streaming, resumable
- [docs/tools/spec.md](../tools/spec.md) — capability groups, progressive disclosure, companion skills
- [docs/tasks/spec.md](../tasks/spec.md) — task DAG, approval gate
- [docs/observability/spec.md](../observability/spec.md) — Review Inbox, run traces, cost tracking
