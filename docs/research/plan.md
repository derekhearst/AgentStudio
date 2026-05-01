# Deep Research — Plan

## Overview

AgentStudio's current `web_search` tool returns 8 result snippets from SearXNG. There is no tool to read the full content of a URL, no PDF reader, no citation tracking, no plan-first orchestration, and no async research job type. This plan adds the `research` domain so agents can conduct multi-step, evidence-gathered, cited research matching the depth of OpenAI Deep Research and Gemini Deep Research.

> **Depends on:** `docs/jobs/plan.md` (background job execution, `research` queue), `docs/runs/plan.md` (durable run state + SSE streaming), `docs/tools/plan.md` (capability groups, progressive tool loading), `docs/skills/plan.md` (research orchestrator skill).

> **See also:** [spec.md](spec.md) — full feature spec, data model, and behavior contracts.

## Why this matters

A plain `web_search` returning 8 snippets is research scaffolding, not research. Users doing competitive analysis, due diligence, literature review, or policy research need the agent to actually read pages, cross-reference sources, and synthesize findings — not just list URLs. OpenAI and Google both treat deep research as their flagship agentic showcase feature. It's the most visible demonstration that an agent can do sustained, independent knowledge work.

## Current state

| Capability | Status |
|---|---|
| `web_search` (SearXNG, 8 results) | ✅ exists |
| `browser_screenshot` (Playwright) | ✅ exists, vision only |
| Full-text page reader (`web_fetch`) | ❌ missing |
| PDF text extractor (`pdf_read`) | ❌ missing |
| Research plan generation | ❌ missing |
| Search–fetch–synthesize loop | ❌ missing |
| Citation tracking (`researchSources`) | ❌ missing |
| Report artifact generation | ❌ missing |
| Research capability group | ❌ missing |
| `research` job type | ❌ missing |
| Research progress SSE events | ❌ missing |
| Per-agent research config | ❌ missing |

## Desired state

- New domain: `src/lib/research/` with schema, server logic, and job handler.
- Two new tools: `web_fetch`, `pdf_read` in a new `research` capability group.
- Research orchestrator skill in `src/lib/skills/` that governs the search–fetch–synthesize loop.
- New `research` job type in the jobs worker.
- SSE events for research progress streamed through the existing run SSE pipe.
- UI: research mode toggle in chat composer, sidebar progress panel, rendered report in chat.

## Phases

### Phase 1 — Data model + `web_fetch` tool

**Goal:** Store research runs and fetch page text. No loop yet.

**Files to create:**
- `src/lib/research/research.schema.ts` — Drizzle schema: `research`, `researchSources`, `researchSteps` tables.
- `drizzle/NNNN_research.sql` — migration (generated via `bunx drizzle-kit generate`).

**Files to modify:**
- `src/lib/tools/tools.server.ts` — add `web_fetch` implementation using Playwright (reuse existing browser setup) + `pdf_read` using `pdftotext` shell fallback.
- `src/lib/tools/tools.ts` — add `research` capability group with `web_fetch`, `pdf_read`; keep `web_search` in `core` but reference it in the group description.

**`web_fetch` implementation:**
```
1. Take URL input (validated, http/https only, no private IPs)
2. Call Playwright page.goto(url, { waitUntil: 'networkidle' })
3. Extract text via page.textContent('body') - same Playwright instance as browser_screenshot
4. Strip boilerplate (nav/footer/ads heuristic: remove elements with role=navigation, role=banner, role=complementary)
5. Truncate to 50 000 chars at paragraph boundary
6. Return { title, url: page.url(), text, fetchedAt }
```

**`pdf_read` implementation:**
```
1. If path starts with http/https: download to tmpDir via fetch(), save as .pdf
2. Run: bun exec "pdftotext <file> -" (pdftotext from poppler-utils)
3. Fallback: use pdf-parse npm package via shell if pdftotext unavailable
4. Truncate to 100 000 chars
5. Return { title: filename, url, text, fetchedAt }
```

**Verification:**
- `web_fetch('https://example.com')` returns text containing "Example Domain"
- `web_fetch` with a private IP throws "Blocked: private address"
- `pdf_read` on a PDF URL returns non-empty text

---

### Phase 2 — Research orchestrator skill + loop

**Goal:** Agent can perform a multi-step research run driven by a skill, storing all steps.

**Files to create:**
- `src/lib/research/research.server.ts` — `createResearch()`, `updateResearch()`, `addResearchSource()`, `addResearchStep()`, `getResearch()`.
- `src/lib/skills/` — add a built-in skill `research-orchestrator` (Markdown file): defines the plan-first loop protocol, citation format rules, loop termination conditions, and report Markdown template.

**Loop protocol (encoded in the skill):**
```
1. Call plan_research(query) → array of sub-questions (stored in research.plan)
2. For each sub-question:
   a. web_search(sub-question-derived query) → results
   b. Select up to 3 URLs (prefer .gov/.edu/.org, avoid paywalled)
   c. web_fetch(url) for each selected URL → store in researchSources
   d. Extract relevant passages for the sub-question
   e. Update running synthesis notes
3. After all sub-questions: generate final report using synthesis notes + source list
4. Return report
```

**Files to modify:**
- `src/lib/research/research.server.ts` — add loop runner function `runResearchLoop(researchId)` that executes steps 1–3 above, calling tools through the existing tool execution layer.

**Verification:**
- Manually trigger `runResearchLoop` for a test research ID; check `researchSteps` rows are created for each search + fetch.
- `research.status` transitions: `planning` → `searching` → `synthesizing` → `complete`.

---

### Phase 3 — Research job type

**Goal:** The loop runs as a background job, not blocking the request.

**Files to modify:**
- `src/lib/jobs/jobs.server.ts` (or wherever the job worker lives) — add `research` job type handler that calls `runResearchLoop(payload.researchId)`.
- `src/lib/jobs/jobs.schema.ts` — ensure `jobType` enum includes `'research'`.
- `src/routes/api/chat/+server.ts` (or the runtime loop) — when research is triggered, create a `research` record + enqueue a `research` job instead of running inline.

**SSE events:**
Add to the run event emitter inside `runResearchLoop`:
```ts
emit({ type: 'research:planning', subQuestions: plan })
emit({ type: 'research:search', query, resultCount })
emit({ type: 'research:fetch', url, title })
emit({ type: 'research:synthesizing', subQuestion })
emit({ type: 'research:complete', researchId, sourceCount })
```

**Verification:**
- Submit a research query via chat; confirm a `research` job appears in the jobs table with status `pending` then `running` then `complete`.
- SSE sidebar shows live progress events.

---

### Phase 4 — Trigger modes + per-agent config

**Goal:** Users can explicitly invoke research; orchestrators can invoke it autonomously.

**Files to modify:**
- `src/routes/chat/+page.svelte` — add "Deep Research" toggle button in the composer (similar to Claude's mode selector). When active, sets a `researchMode: true` flag on the message payload.
- `src/routes/api/chat/+server.ts` — if `researchMode` flag is set, create research record and enqueue job immediately without entering the normal agent loop.
- `src/lib/agents/agents.schema.ts` — add `researchConfig` JSONB column to `agents` table (see spec for shape).
- `src/lib/tools/tools.server.ts` — expose `create_research` as an agent tool in the `agents` capability group so the orchestrator can trigger research programmatically.

**Verification:**
- Toggle "Deep Research" in composer, send a query → research job enqueued, progress sidebar appears.
- Orchestrator agent with research capability can call `create_research` and receive the `researchId` back.

---

### Phase 5 — Report UI + file grounding

**Goal:** Final report is rendered beautifully in chat; users can attach PDFs as context.

**Files to modify:**
- Chat message renderer — detect `role: assistant` messages with `type: research_report` metadata; render with a collapsible sources section and numbered citation links.
- `src/routes/chat/+page.svelte` — support file attachment for research context (PDF, CSV, TXT); files are uploaded to sandbox workspace and paths passed to `runResearchLoop`.
- `runResearchLoop` — if `grounding files` present, read them via `pdf_read`/`file_read` as the first "sources" before web searching.

**Verification:**
- Attach a PDF, run research → PDF content appears as source #1 with `url = file://...`.
- Final report renders in chat with `[1]`, `[2]` inline citations and a "Sources" collapsible at the bottom.

---

## Files to create (summary)

| File | Purpose |
|---|---|
| `src/lib/research/research.schema.ts` | Drizzle schema: `research`, `researchSources`, `researchSteps` |
| `src/lib/research/research.server.ts` | CRUD helpers + `runResearchLoop()` |
| `src/lib/research/index.ts` | Public exports |
| `drizzle/NNNN_research.sql` | DB migration |

## Files to modify (summary)

| File | Change |
|---|---|
| `src/lib/tools/tools.ts` | Add `research` capability group (`web_fetch`, `pdf_read`) |
| `src/lib/tools/tools.server.ts` | Implement `web_fetch`, `pdf_read` tool handlers |
| `src/lib/agents/agents.schema.ts` | Add `researchConfig` JSONB column |
| Jobs worker | Add `research` job type handler |
| Chat API server | Route `researchMode` flag to research job |
| Chat composer UI | Add Deep Research toggle |
| Chat message renderer | Research report rendering with citations |

## Dependencies to install

```bash
# pdf-parse for PDF text extraction (fallback if pdftotext not available)
bun add pdf-parse
bun add -D @types/pdf-parse
```

pdftotext (from poppler-utils) should be available in the Docker image — add to Dockerfile if missing:
```dockerfile
RUN apt-get install -y poppler-utils
```

## Verification (end-to-end)

1. Send "Research the current state of open-source LLM fine-tuning tools" with Deep Research mode on.
2. Confirm: `research` job appears; sidebar shows planning → searching → fetching → synthesizing → complete.
3. Confirm: final report appears in chat with multiple sections, inline citations `[1]`, `[2]`, etc., and a numbered source list.
4. Confirm: `researchSources` table has ≥5 rows with `citedInReport = true`.
5. Confirm: total token cost tracked in `research.tokensUsed` and surfaced in the cost domain.
