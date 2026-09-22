# Parity backlog re-audit — 2026-09-22

Re-reads every open issue that came out of the Claude Desktop parity audit
([`claude-desktop-parity.md`](claude-desktop-parity.md)) against the code as it stands at
`e3a5d31`, and against the Agent SDK we actually have installed
(`@anthropic-ai/claude-agent-sdk@0.3.278`).

The original audit was written the day before the engine migration finished settling. Since
then #15 (SDK built-ins replace the in-house filesystem registry), #19 (permission modes),
#29 (preview pane) and #13 (artifacts removed) landed. Several of the remaining issues were
written for the world that existed before those, and describe work that is now either
unnecessary, already half-done by the SDK, or pointed at the wrong layer.

**The short version: most of wave 3 is not a feature backlog. It is one missing adapter.**

---

## Three findings that change the plan

### 1. The engine throws away every structured tool result

`src/lib/engine/stream.server.ts:344` reads a completed tool call like this:

```ts
if (msg.type === 'user') {
	for (const block of msg.message?.content ?? []) {
		if (block.type !== 'tool_result') continue
		const text = Array.isArray(raw) ? raw.map((c) => c.text ?? '').join('') : …
		blocks.push({ kind: 'tool', name: toolName, arguments: …, result: text, … })
```

It reads `message.content` — the text the *model* sees — and flattens it to a string. But
the SDK puts the typed output on a sibling field of the same message:

> `SDKUserMessage.tool_use_result?: unknown` — "Structured tool output — the tool's full
> Output object, not the string content sent to the model. The shape is per-tool, keyed by
> the matching tool_use block's name."

Nothing in `src/` references `tool_use_result`. So on every edit, the SDK hands us this
(`sdk-tools.d.ts`, `FileEditOutput`) and we drop it on the floor:

```ts
{ filePath, oldString, newString, originalFile,
  structuredPatch: [{ oldStart, oldLines, newStart, newLines, lines }],
  gitDiff?: { filename, status, additions, deletions, changes, patch } }
```

`FileWriteOutput` carries the same `structuredPatch` + `originalFile`. `BashOutput` carries
`stdout`, `stderr`, `interrupted`, `backgroundTaskId`, `persistedOutputPath`.
`TodoWriteOutput` carries `oldTodos` / `newTodos` with per-item status.

That means:

| Issue | What it asks for | Where the data already is |
| --- | --- | --- |
| #16 diff rendering | "the handler should return a `previousContent` … or a precomputed diff" | `FileEditOutput.structuredPatch`, `originalFile`, `gitDiff.patch` — already computed, already sent |
| #26 terminal output | stdout/stderr/exit code, not a JSON blob | `BashOutput.stdout` / `.stderr` / `.interrupted` |
| #21 todo list | "keep the latest list on the run" | `TodoWriteOutput.newTodos` |
| #35 background work | a handle for a backgrounded command | `BashOutput.backgroundTaskId` |

Four issues, one adapter. The shape of the fix is a typed block vocabulary: keep
`StreamBlock.kind` but add `file_edit`, `shell`, `todo` alongside `tool`, populate them from
`tool_use_result` keyed on tool name, and let `MessageBlocks.svelte`
(`src/lib/chat/MessageBlocks.svelte:54`) dispatch on kind the way it already does for
`thinking` and `subagent`. Everything that does not match a known shape keeps falling
through to `ToolCallCard`, so this is additive and nothing regresses.

Same problem on our own side of the fence: `buildToolServer`
(`src/lib/engine/tools.server.ts:110`) `JSON.stringify`s every in-house tool result into a
single text block, so even tools we wrote arrive at the UI as a string. If we are adding a
typed channel, in-house tools should ride it too.

### 2. We discard the `Query` handle, and with it most of the SDK's control plane

`stream.server.ts:278` casts the query straight to an iterable:

```ts
for await (const message of query({ prompt: input.prompt, options }) as AsyncIterable<SDKMessage>) {
```

The object returned by `query()` is a `Query` with methods we never call. From `sdk.d.ts`:

| Method | What it gives us | Issue it closes or shrinks |
| --- | --- | --- |
| `rewindFiles(userMessageId, { dryRun })` | restores files to their state at a user message, with a dry-run preview and link-safety refusals — paired with the `enableFileCheckpointing` option | **#24**, entirely |
| `getContextUsage()` | the CLI's real context accounting | replaces the `chars/4` estimate + hardcoded 900-token floors in `src/lib/chat/context-metrics.ts` |
| `supportedCommands()` | the live slash-command list, pushed again on change via `commands_changed` | **#22** (the `/` half) |
| `supportedAgents()` | subagents visible to the session | **#5**, **#32** |
| `setMcpServers(servers)` | add/remove MCP servers on a live session | **#17** |
| `backgroundTasks()` / `stopTask(id)` | list and kill background tasks | **#35** |
| `setModel()`, `setPermissionMode` | mid-turn switches without restarting the session | today both need a new turn |

And the message union we ignore. `stream.server.ts` handles exactly five cases
(`thinking_tokens`, `stream_event`, `assistant`, `user`, `result`). `SDKMessage` has
thirty-odd, including:

- `background_tasks_changed` — "Every live background task after the change. REPLACE
  semantics" → **#35's rail panel, verbatim**
- `task_notification` — `{ status: 'completed' | 'failed' | 'stopped', summary, usage }` →
  **#35's completion frame, verbatim**
- `compact_boundary` — the UI currently has no idea when the session compacted
- `tool_progress` — elapsed-time heartbeats per call (note: *no* partial output, so it is
  a spinner, not a stream)
- `permission_denied`, `api_retry`, `model_refusal_fallback` — all currently invisible, all
  things that make a run look mysteriously stuck

Keeping the handle is a real refactor — the stream route is request-scoped and the handle
wants to live as long as the conversation — but it is the single change that unlocks the
most rows, and it is the one piece of infrastructure work I would do before any of the
feature issues.

### 3. `settingSources` is never set, so the repo's own configuration is invisible

No occurrence of `settingSources` in `src/`. The SDK defaults to loading none, which means
for a project whose working directory is a real repo we ignore its `CLAUDE.md`, its
`.claude/commands/`, its `.claude/skills/` and its `.claude/settings.json`.

That is most of **#23**, and it is one option field rather than a schema change. See the
per-issue note below for what remains after that.

---

## Two live defects found on the way

Neither has an issue yet. Both are small and both are the kind of thing that quietly makes
runs worse.

**The tool-policy slot tells the model a lie on every single run.**
`src/lib/chat/stream-slots.server.ts:190` ships this into the system prompt of every chat:

> "A small core (web_search, ask_user, run_code, search_tools) is always available. The rest
> of the registry is gated behind `search_tools`. … call `search_tools(query)` once — it
> loads the matched tools so they appear in your tools array on the NEXT round."

Deferred loading was implemented in the *old* loop — the `loadSearchableTools` callback
lives in `src/lib/runtime/loop.server.ts:250`. On the engine path `buildToolServer` registers
`allToolNames` unconditionally, so every tool is already present on round one. The model is
being told to spend a round unlocking tools it already has, and told that capabilities it
holds are unavailable until it asks. The line about "file edits" is doubly stale: file edits
are built-ins now and were never in that registry.

Fix is a choice, not a puzzle: either delete `search_tools` and this slot text from the
engine path, or re-implement gating for real against the MCP server. Given the whole
registry is ~50 tools and the built-ins carry the hot path now, I would delete it.

**The per-tool-call cost ledger covers three tools.** `logToolUsage` has exactly two callers
outside its own module — `handlers/web.server.ts:27` and `handlers/media.server.ts:41`.
Built-in `Read` / `Write` / `Edit` / `Bash` calls never reach `onExecuted`
(`src/lib/engine/tools.server.ts:100` only fires for in-house MCP tools), so since #15 the
filesystem and shell surface — the majority of calls in a coding session — writes no ledger
row at all. The parity doc still scores "session cost accounting" as a **win**; per-run token
accounting still works, but the per-tool-call ledger is now thin enough that #38's "spend by
tool" digest would be misleading if built on it today.

---

## Issue by issue

Verdicts: **as filed** (the issue is right, build it), **rebuild** (right problem, wrong
plan), **fold** (belongs inside another issue), **delete** (close it).

| # | Title | Verdict | One line |
| --- | --- | --- | --- |
| #16 | Render diffs for file edits | **rebuild** | the diff is already in `tool_use_result`; no handler changes needed |
| #26 | Shell output as a terminal | **rebuild** | same adapter; "stream it live" means background + poll, not a new transport |
| #21 | Render the todo list | **rebuild** | same adapter; render above the composer, not in the rail |
| #35 | Background work in a turn | **rebuild** | the SDK already does all of it; we render none of it |
| #24 | Filesystem checkpoints | **rebuild** | `enableFileCheckpointing` + `rewindFiles()`, not hand-rolled git stashes |
| #23 | Per-project instructions | **rebuild** | `settingSources: ['project']` is 90% of it |
| #17 | Connect external MCP servers | **as filed** | plumbing confirmed trivial; the policy layer is the actual work |
| #32 | Multi-agent orchestration | **rebuild** | use SDK `agents` + the Task tool instead of a bespoke fan-out tool |
| #5 | Port subagents to SDK subagents | **as filed** | keystone; do it first in its wave |
| #4 | Native AskUserQuestion | **as filed** | `toolConfig.askUserQuestion.previewFormat` confirmed present |
| #18 | Conversation pin/archive/search/export | **as filed**, trimmed | all four are cheap; make archive the default action, not delete |
| #22 | Slash commands and `@`-mentions | **split** | build `@` now; `/` should wait for `settingSources` |
| #38 | Usage digest | **rebuild** | fix the ledger first, then ship the header strip; the digest agent is the last 20% |
| #14 | Rethink the right sidebar | **rebuild** | #29 already fixed the "blank by default" complaint; what is left is deleting two tabs |
| #27 | Wire up or delete the TTS endpoint | **delete** | confirmed dead: no UI reference, and the setting the issue mentions does not exist |
| #9 | Gateway for non-Claude models | **as filed**, deprioritize | costs money and degrades tool fidelity to replace something that is currently free |
| #8 | Delete dead engine code | **as filed** | grows once #5 lands; `search_tools` joins the list |

### #16 — diffs

The issue plans handler changes to return `previousContent`. Those handlers no longer exist;
`Edit` / `Write` are CLI-side built-ins. Take `structuredPatch` from `tool_use_result` and
render it. `gitDiff.patch` is there too when the file is in a repo, with `additions` /
`deletions` counts for a collapsed header, which gives the "collapse to hunks, expand to
full file" behaviour almost for free.

One caveat worth designing around: `originalFile` is documented as null when the previous
content was too large to include, and `structuredPatch` empty when the diff timed out. The
card needs a graceful "diff unavailable, here is the path and the size" state rather than
rendering nothing.

### #26 — terminal

Everything except live streaming falls out of `BashOutput`. Live streaming does not: the
only per-call progress the SDK emits is `tool_progress`, which carries `elapsed_time_seconds`
and no output. The honest way to get output while a command runs is the background path —
`Bash({ run_in_background: true })` returns a `backgroundTaskId`, and `BashOutput` polls it
for what has arrived since. Which is #35. So these two issues should merge: one shell card,
two modes.

I would also drop "ANSI colour rendering" from the scope. Monospace, preserved newlines,
exit-code badge, copy button, collapse past ~20 lines; strip ANSI rather than render it, and
revisit only if something actually emits colour worth keeping.

### #21 — todo

`TodoWriteOutput` gives `oldTodos` and `newTodos`, so we get the delta for free. Two
decisions I would make differently from the issue: render it pinned above the composer
rather than in the rail (the rail is for preview now — see #14), and store the latest list on
the conversation rather than the run, so a task that spans several runs keeps one list.

### #35 — background work

The issue proposes growing our `shell` tool a `background: true` mode. Our `shell` tool is
gone; `Bash` is a built-in, and `BUILTIN_SHELL_TOOLS` already allow-lists
`['Bash', 'BashOutput', 'KillShell']` (`src/lib/engine/builtin-tools.ts:15`). The model can
already background a command today — we simply render the result as an opaque card and have
no way to kill anything.

What is actually missing:
- read `backgroundTaskId` off `BashOutput` and render a live card instead of a finished one
- handle `background_tasks_changed` (replace-semantics list) → the rail panel the issue asks for
- handle `task_notification` → the completion frame the issue asks for
- wire `query.stopTask(id)` to a kill button, and to conversation delete for cleanup

All four need finding 2 (keeping the handle). None need a tool change.

### #24 — checkpoints

Close the hand-rolled plan. `enableFileCheckpointing` plus `query.rewindFiles(userMessageId,
{ dryRun })` is the feature, including the "show what would be restored before doing it"
requirement — the dry run returns file change statistics without touching anything, and the
real call refuses to follow symlinks or cross-device links and reports how many files it
skipped.

Two things to verify before committing to it: that checkpointing tracks files under our
per-user sandbox layout, and how it interacts with `repo_kind = 'imported'` projects that
have their own git history (we do not want a rewind that silently discards a commit). For
`repo_kind = 'none'` projects there is nothing to restore, same as the issue says.

The remaining AgentStudio-side work is joining a `messages` row to the SDK user-message UUID
so "rewind to this message" has something to pass in — which is worth doing anyway, because
it is the same join `compact_boundary` and per-message context accounting want.

### #23 — project instructions and knowledge

`settingSources: ['project']` makes a repo's `CLAUDE.md`, commands and skills load the way
they do in Claude Code. That is the better default the issue itself guesses at, and it makes
an imported repo behave the way its own contributors expect.

What remains after that is genuinely small:
- for `repo_kind = 'none'` projects there is no repo to read from — write the DB field to a
  `CLAUDE.md` inside the project's sandbox path instead of injecting it through a slot, so
  there is exactly one mechanism rather than two
- the knowledge directory is a directory plus a listing on the project page; no RAG, as filed

Worth noting the security consequence before flipping it: loading project settings means a
cloned repo can ship hooks and permission rules. `settingSources` should be opt-in per
project, defaulting on for `local` and off for freshly `imported` until someone has looked at
it — the same posture Claude Code takes on trusting a new folder.

### #17 — external MCP servers

Confirmed as easy as the issue hopes at the engine boundary: `mcpServers` takes
`McpStdioServerConfig | McpSSEServerConfig | McpHttpServerConfig | McpSdkServerConfigWithInstance`,
and `query.setMcpServers()` can change them on a live session. Everything else in the issue
stands.

One correction: the issue suggests doing stdio first as the simpler case. Our production
image is `oven/bun:1` with no node and no python toolchain, so the `npx -y …` / `uvx …`
invocation that most stdio servers assume needs either image changes or `bunx` and a
tolerance for servers that do not run under Bun. HTTP/SSE servers need no image change at
all. I would do HTTP first and treat stdio as the case that needs a decision about what goes
in the image.

The real work, as the issue says, is that `mcp__<server>__<tool>` names arrive at layers that
assume the registry: `resolveToolGate`, the approval set, `logToolUsage`, and
`ToolCallCard`'s friendly labels. `McpServerProvenance.source` on the tool definition tells us
which config scope a server came from, which is the right thing to key trust on — never the
name or the prefix, both of which a server chooses for itself.

### #32 / #5 — orchestration

The issue is right that #5 comes first, and right to scope out a workflow scripting language.
But the fan-out primitive it describes — "a tool that takes a list of tasks and a per-task
prompt and runs them with a concurrency cap" — is a re-implementation of the SDK's `Task`
tool, which already takes `run_in_background`, reports through `task_notification`, and
offers `isolation: 'worktree'` (a temporary git worktree per agent — which is also the "git
worktrees: absent" row in the parity doc, closed for free).

Reshaped plan:
1. #5: map our `agents` rows into the SDK's `agents` option; delete `inline-subagent.ts`.
2. Fan-out becomes the model calling `Task` N times, backgrounded. No new tool.
3. The concurrency cap and the per-child budget check belong in `canUseTool` — refuse a
   `Task` call when N children are already live, or when the budget gate would fail for the
   child. That is the one place a cap can actually be enforced, and it is where #32's point 3
   (budget per child, not per parent) has to live regardless of how fan-out is expressed.
4. Tree rendering reads `tool_use_result` for `Task`, which the SDK documents as "the
   subagent's final report … plus run totals — render from it instead of parsing the
   tool_result text". Cost attribution per child comes from the same place.
5. Cancellation is `stopTask`.

Also worth checking during #5: unscoped runs pass no `allowedTools` at all
(`options.server.ts`), which means any built-in the CLI exposes is callable — `Task`
included, with no agent definitions and no ledger. Either define the agents or disallow the
tool; silently having it is the worst of the three.

### #4 — AskUserQuestion

Confirmed against the SDK: `toolConfig.askUserQuestion.previewFormat` and
`askUserQuestionTimeout: '60s' | '5m' | '10m' | 'never'` both exist. Build as filed. On the
timeout: `never` is the right default for a self-hosted single-user box where the operator
may be asleep — an auto-continue that picks an option unattended is exactly the failure this
app's `/review` inbox exists to avoid.

### #18 — conversation lifecycle

All four parts are cheap and worth doing. Two opinions:

- Make **archive** the primary action and demote delete. On a single-user box the cost of
  keeping a conversation is nil, and a deleted conversation takes its run rows, cost ledger
  and memory provenance with it.
- **Search** should index `messages.content` *and* the tool blocks. Half of what you go
  looking for months later is "the run where it touched `options.server.ts`", which lives in
  a tool argument, not in prose.

Export to Markdown is ~50 lines and does not need a design.

### #22 — composer

Split it. `@`-mentions are unambiguous value and the issue's plan is fine.

The `/` half I would hold. Building a bespoke palette for `/compact`, `/model`, `/agent` —
all of which are already buttons in the composer — is re-skinning. Once `settingSources`
lands (#23), `query.supportedCommands()` returns the real command list, including the repo's
own `.claude/commands/` and every skill, pushed live on change via `commands_changed`. A
palette over *that* is worth having; a palette over three buttons is not.

### #38 — usage digest

Right instinct, wrong order. The issue's own trap — "a digest nobody reads" — is the likely
outcome, and it would be built on a ledger that currently misses every built-in tool call.

Sequence I would use: fix the ledger so built-in calls are accounted (an `onExecuted`
equivalent driven off `tool_use_result`, which is finding 1 again), then ship the `/activity`
header strip, then decide whether anyone wants the prose digest. The strip is ~a day and is
on screen without waiting; the digest is an agent run that costs money every week to tell
you something you could have glanced at.

### #14 — the right sidebar

Half-resolved already: #29 made `Preview` the default tab
(`src/lib/chat-console/preview-state.svelte.ts:33`) and artifacts are gone, so the "large
panel saying No artifacts" complaint no longer reproduces.

What is left is that there are still four tabs for one job. I would keep Preview, delete the
Research tab (research runs have their own page, and the tab is empty in the overwhelming
majority of conversations), and move Activity into the run detail surface where the rest of
the run telemetry lives. That leaves Preview + Files, which is close enough to option 2 in
the issue to just be option 2. Collapse-by-default on top of that is a small extra step and I
would take it.

The one thing to add rather than remove: the background-task list from #35 has to live
somewhere, and the rail is the only surface with room.

### #27 — TTS

Delete. Verified: `src/lib/llm/tts.server.ts` has exactly one importer
(`src/routes/api/tts/+server.ts`), and no `.svelte` file in the repo references `tts` or
`/api/tts`. The issue says a model setting exists in Settings → Model & AI; it does not —
`settings.transcriptionModel` is for voice-*to*-text and is live. So this is a route and a
module, both unreachable, and the "finish it" option would mean building the setting too.

The reason to delete rather than finish: the only case TTS earns its keep is hands-free
listening, and the reply is already on screen. If that case ever turns up, it comes back as a
play button, and it comes back in a day.

### #9 — gateway

No change to the issue, but worth stating the economics plainly before anyone spends a week
on it: Claude runs are on the subscription and cost nothing per token; gateway runs cost
real money *and* degrade multi-step tool fidelity, which is the entire workload here. The
case for it is local/offline models or a specific cheap model for a specific job (the
monitor `model_question` checks are the obvious candidate), not general use. I would close it
unless one of those is the actual goal.

---

## Suggested order

1. **The adapter** (finding 1) — typed blocks from `tool_use_result`. Unblocks #16, #26, #21
   and half of #35, and fixes #38's ledger gap. Nothing else in wave 3 should start first.
   **Landed**: `src/lib/engine/tool-result-details.ts` distils `Edit` / `Write` / `Bash` /
   `TodoWrite` output onto an optional `details` field on the tool block, and the chat
   renders a diff, a terminal and a checklist from it. What is left of those three issues is
   placement rather than data — the pinned todo list above the composer (#21), live output
   while a command runs (#26, which is the background path in #35). The ledger gap is
   untouched and still wants the same field.
2. **The handle** (finding 2) — keep `Query` alive per conversation. Unblocks #24, the rest
   of #35, and real context accounting.
3. **The two defects** — delete `search_tools` and its prompt text; account built-in tool
   calls.
4. **#5, then #32 reshaped** — the orchestration keystone, which also deletes `$lib/runtime`
   (#8) and gets worktrees for free.
5. **#23 via `settingSources`**, then the `/` half of #22 on top of it.
6. **#17**, HTTP transport first.
7. The cheap independents whenever: **#27 delete**, **#4**, **#18**, **#14**.

Rough shape of it: items 1–3 are maybe a week of work that makes five issues small, and four
of the open issues (#27 plus the obsolete halves of #24, #32 and #35) should be closed or
rewritten rather than built as filed.
