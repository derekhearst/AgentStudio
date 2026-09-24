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

### 3. `settingSources` is never set — and that is the opposite of what I first wrote

**Corrected 2026-09-22.** This section originally said "the SDK defaults to loading none,
which means … we ignore its `CLAUDE.md`". That was wrong, and wrong in the dangerous
direction. I read it off a type declaration instead of testing it, and it was load-bearing
for a conclusion about isolation.

The SDK passes `--setting-sources` to the CLI **only when the option is set**, and documents
the omitted case as "all sources are loaded (matches CLI defaults)". Checked against
0.3.278 with the SDK's own `resolveSettings`, which reads the cascade without spawning the
CLI or needing a credential, against a directory containing a `.claude/settings.json`:

```
OMITTED  env: {"SMOKING_GUN":"loaded-from-repo"} | allow: ["Bash(rm -rf /)"]
EMPTY [] env: null                               | allow: null
```

So not setting the option never meant a project's `CLAUDE.md` was ignored. It meant every
run with a working directory merged in whatever `.claude/settings.json` was sitting there —
in an imported repo, authored by whoever wrote that repo — with `permissions.allow` and
`env` among the keys that came through. The CLI does filter an escalating
`permissions.defaultMode` out of repo-committed tiers (the SDK exposes the same filter as
`filterEscalatingDefaultMode`), but allow-rules and hooks are honoured.

**Fixed.** `settingSources` is now always explicit: `[]` by default, `['project']` for a
project whose committed configuration the operator has marked trusted
(`projects.settings_trusted`). `local` is never loaded — `.claude/settings.local.json` is
gitignored, so it does not arrive with a clone, it arrives by being written into the
sandbox, which the agent can do; trust cannot come from a file the untrusted party can
write. `user` is never loaded either. See `$lib/engine/setting-sources`.

That makes **#23** a trust gate rather than a feature switch, and it is a column plus a UI,
not the one option field I claimed. The per-issue note below is corrected to match.

The lesson worth keeping: a claim about a dependency's default that a security conclusion
rests on should be executed, not read. The check took two minutes.

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

**Fixed.** `search_tools` is no longer registered on the engine surface
(`ENGINE_EXCLUDED_TOOLS` in `src/lib/engine/builtin-tools.ts`) and both tool-policy
variants dropped the deferred-loading paragraphs. The old loop keeps its copy, because
gating is genuinely live there — `getToolDefinitions` filters by `toolDisclosure` tier, so
a subagent really does need the escape hatch until `$lib/runtime` goes with #5/#8.

**And the same defect, one level worse: `run_code` cannot run on the engine path at all.**
`runCodeTool` throws unless `toolUserContext` carries a `runtime` — it needs
`currentToolNames()` to decide what the script may call, and a `session` to route the
approvals its nested calls go through. The only code that ever supplies one is
`$lib/runtime/tool-handlers.server:359`. The engine passes a workspace with no runtime, so
every engine-path call ends at *"run_code requires runtime context … It can only be invoked
from inside the chat loop."*

It was registered anyway, with a ~1,200-character description — the longest in the registry
— shipping in the tool definitions of every request, and a wasted round every time the model
believed it. It is now excluded alongside `search_tools`. Note what this means for the
parity table above: **`run_code` is a `broken` row, not an `even` one.** "Every tool is
callable from inside the script" has not been true on this path since the engine migration.
Restoring it means giving the engine its own approval route for nested calls, which is a
piece of work in its own right, not a line change.

**Decided (#69), and both deleted (#8).** `run_code` was retired rather than restored. What
only it could do — call AgentStudio's own tools from inside a script — did not justify a
second approval gate kept in lockstep with `canUseTool`: the SDK's sandboxed `Bash` already
runs scripts in the workspace, and the model already makes independent tool calls in one
step. Both tools are now gone from the registry, not just from the engine, because an
exclusion left them on every other surface that lists the registry (the settings approval
list, `/api/mcp`). `search_tools` went with the always-loaded/searchable tier it existed
for, and the settings "Programmatic tool calling" toggle with `run_code`. `/api/mcp` also
stopped offering the tools that refuse without a chat run — `ask_user`, the
mandatory-approval tools and `set_project_context` (`mcpExposedToolNames` in
`src/lib/tools/tools.ts`) — and refuses a call to one before any handler runs.

That costs the old loop something, and it is worth saying where. Its unattended callers —
automations with an agent attached, a monitor's `start_conversation`, CI fix runs — were
offered the always-loaded tier, and `run_code` was their only way to touch files. They now
get `web_search` alone (`src/lib/runtime/detached-tools.ts`). Moving them onto the engine is
what gives them files and commands back, and it is also what lets `$lib/runtime` finally go.

**The per-tool-call cost ledger covers three tools.** `logToolUsage` has exactly two callers
outside its own module — `handlers/web.server.ts:27` and `handlers/media.server.ts:41`.
Built-in `Read` / `Write` / `Edit` / `Bash` calls never reach `onExecuted`
(`src/lib/engine/tools.server.ts:100` only fires for in-house MCP tools), so since #15 the
filesystem and shell surface — the majority of calls in a coding session — writes no ledger
row at all. The parity doc still scores "session cost accounting" as a **win**; per-run token
accounting still works, but the per-tool-call ledger is now thin enough that #38's "spend by
tool" digest would be misleading if built on it today.

**Fixed.** The engine reports every completed call to its caller (`onToolResult`) and the
chat route writes a row for each one — `unitType: 'call'`, cost zero, carrying the edited
path or the command string taken from the typed result.

Worth being precise about what that does and does not fix. These calls run locally and spend
no money; their real price is tokens, already accounted per run. So this restores **call
counts, not spend** — the same thing `web_search` has always done for the self-hosted SearXNG
backend ("cost defaults to 0 but the call count is still tracked"). Budget limits sum `cost`,
so a ledger full of zero-cost rows cannot move a limit, deliberately: inventing a price for a
local `Read` would corrupt the one number in this system that is allowed to block a run.

So #38's "most-used tools" and `/activity`'s picture of what happened are now answerable.
Its "spend by model / by agent / by automation" was always the `llm_usage` ledger's job and
is unaffected either way.

---

## Issue by issue

Verdicts: **as filed** (the issue is right, build it), **rebuild** (right problem, wrong
plan), **fold** (belongs inside another issue), **delete** (close it).

| # | Title | Verdict | One line |
| --- | --- | --- | --- |
| #16 | Render diffs for file edits | **rebuild** | the diff is already in `tool_use_result`; no handler changes needed |
| #26 | Shell output as a terminal | **rebuild** | same adapter; "stream it live" means background + poll, not a new transport |
| #21 | Render the todo list | **rebuild** — shipped | same adapter; pinned above the composer, kept on the conversation |
| #35 | Background work in a turn | **rebuild** — mostly shipped | chips, notices and a stop control land; the live output card is left, with #26 |
| #24 | Filesystem checkpoints | **rebuild** — shipped | `enableFileCheckpointing` + `rewindFiles()` through a short-lived control session; edit/regenerate now cut the SDK session too |
| #23 | Per-project instructions | **rebuild** — shipped | `settingSources` was 90% of it; instructions and the knowledge directory close the rest |
| #17 | Connect external MCP servers | **as filed** | plumbing confirmed trivial; the policy layer is the actual work |
| #32 | Multi-agent orchestration | **rebuild** | use SDK `agents` + the Task tool instead of a bespoke fan-out tool |
| #5 | Port subagents to SDK subagents | **as filed** — shipped | keystone; `Options.agents` + `Task`, `run_subagent` retired |
| #4 | Native AskUserQuestion | **as filed** | `toolConfig.askUserQuestion.previewFormat` confirmed present |
| #18 | Conversation pin/archive/search/export | **as filed**, trimmed | all four are cheap; make archive the default action, not delete |
| #22 | Slash commands and `@`-mentions | **split** | build `@` now; `/` should wait for `settingSources` |
| #38 | Usage digest | **rebuild** | fix the ledger first, then ship the header strip; the digest agent is the last 20% |
| #14 | Rethink the right sidebar | **rebuild** | #29 already fixed the "blank by default" complaint; what is left is deleting two tabs |
| #27 | Wire up or delete the TTS endpoint | **delete** → **finished** | confirmed dead: no UI reference, and the setting the issue mentions does not exist. The owner chose to finish it; see below |
| #9 | Gateway for non-Claude models | **as filed**, deprioritize | costs money and degrades tool fidelity to replace something that is currently free |
| #8 | Delete dead engine code | **as filed** — mostly done | stream-prep helpers, in-house compaction, `search_tools` and `run_code` (#69) deleted, and with them the modules nothing imported (the `$lib/tools` barrel, `chat/runs.server`, the tools and images remote modules) and the exports left without a caller (the tiktoken estimator and the `js-tiktoken` dependency, the settings prompt preview query, the agent tool-definition filter, the OpenRouter `plugins` option, the image lookups the images remote module left behind); the old loop stays while automations, monitors and CI fix runs call it |

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

**Shipped.** Both decisions stand. `conversations.todo_list` (migration `0072`) holds the
latest list, written from the stream's `onToolResult` where the distilled `TodoDetails`
already arrives, and emitted as a `todo_list` frame so a live run updates the panel without
a refetch — a persisted run event, so a reconnecting client replays it. `PinnedTodoPanel`
renders it collapsed to one line (the active item's `activeForm` plus a count) because it
sits in the composer's space and an open ten-item plan would push the input off a phone
screen. Dismissing clears the column and not just the view: `TodoWrite` only ever *replaces*
a list, so a dismissal that left the row alone would pin the same list back on every open.

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

**Partly shipped.** The handle is kept, `background_tasks_changed` and `task_notification`
are interpreted by `$lib/engine/sdk-notices` and the live set renders as chips in both
headers, and `POST /chat/[id]/stop-task` wires `Query.stopTask(id)` to a stop control on
each chip. Ownership is checked against `chat_runs` before the registry is touched — the
registry is keyed by run id alone and knows nothing about who owns a run, so the endpoint is
the only thing between a run id and a stranger's session.

What is left is the first bullet: reading `backgroundTaskId` off `BashOutput` and rendering a
*live* card rather than a finished one. `ShellDetails` already carries the id; what it needs
is a card that keeps polling `BashOutput`, which is the same piece of work as #26's live
output and should be done once, for both.

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

**Shipped (2026-09-23).** Both open questions were answered by running the bundled CLI
against a stand-in Messages API, and the answers are in [../chat/chat.md](../chat/chat.md#integrations):
the sandbox layout is tracked (paths come back absolute), but only for the SDK's file tools —
Bash and our own tools are not checkpointed; and a rewind never runs git, so it cannot drop a
commit. Imported repos with uncommitted changes in the files being restored need an explicit
overwrite, checked again on the server.

- **The join**, with no migration: every prompt is sent as a streamed `SDKUserMessage` with a
  uuid we mint, which the CLI keeps as the transcript uuid and keys its checkpoints by.
  `messages.metadata.sdkTurn` on the user row holds it with the session id and the run's cwd;
  `metadata.sdkTailUuid` on the reply holds the turn's last chain entry.
- **The rewind** is option A from the triage: `query()` resuming the session in the run's cwd
  with checkpointing on and an input that never yields, `rewindFiles(uuid, { dryRun: true })`
  for the preview, the real call on confirm, then `close()` — no model call, and it works after
  a restart, which finding 2's live handle would not have. Checkpointing is on only where the
  workspace outlives the turn (a project, or an agent's persistent key).
- **Worse than the issue said, and fixed with it:** edit and regenerate sent the literal prompt
  "regenerate" into the unedited session. They now send the row's own text and resume with
  `resumeSessionAt` at the previous reply's tail (same session id — `forkSession()` would lose
  the file history), falling back to a fresh session primed with the kept history when the cut
  is refused. "Compact Conversation" now runs the SDK's `/compact` instead of asking for a
  summary the session then carried on top of everything.
- **A cut that has to survive a failed request.** An edit or regenerate marks the row it cut
  back to (`metadata.sdkCutPending`). If the reply never starts, the next turn of any kind
  (Retry, or just a new message) still resumes at the previous reply's tail. Any unanswered
  user rows in between go in front of the new message as text. The mark is cleared when a
  turn records its join.
- **Partial restores are reported.** A real `rewindFiles` can leave files alone because a link
  is in the way (`RewindFilesResult.skippedLinks`; the dry run never reports these). The edit
  or regenerate result carries the count, and the page shows how many listed files were not
  put back.

Left for later: a "restore files only" action on a message, and deleting a conversation's
SDK transcript and file backups when the conversation is deleted.

### #23 — project instructions and knowledge

**Done, and not as scoped here — see the correction in finding 3.** Project settings were
already loading, because an omitted `settingSources` means "load everything". So this was
never "switch the feature on"; it was "decide, and gate the decision".

`settingSources` is now always explicit: `[]` unless the operator has marked the project's
committed configuration trusted, `['project']` when they have. That trusted side is the
feature this issue wanted — the repo's `CLAUDE.md`, commands and skills — and the untrusted
side is the isolation the rest of the app always assumed. `projects.settings_trusted` holds
the answer; the project page explains what trusting costs and asks twice before granting it.

What remains after that is genuinely small:
- ~~for `repo_kind = 'none'` projects there is no repo to read from — write the DB field to a
  `CLAUDE.md` inside the project's sandbox path instead of injecting it through a slot, so
  there is exactly one mechanism rather than two~~ **Reversed, and shipped the other way.**
  See below.
- ~~the knowledge directory is a directory plus a listing on the project page; no RAG, as
  filed~~ **Shipped**, as filed. `.agentstudio/knowledge/` inside the project's working
  directory, uploaded and removed from the project page, named (not read) in the project
  context slot. Three things the issue left open resolved on the way: repo-less projects
  need no special case, because `resolveWorkspaceRoot` already gives every project a
  directory whether or not it holds a checkout; the directory is hidden from git through
  `.git/info/exclude` rather than `.gitignore`, because in an imported project that file is
  somebody else's tracked file; and uploads are filtered by a denylist of executable
  extensions rather than an allowlist, since "knowledge" is open-ended and the only case
  worth refusing is a file that is interesting to run rather than to read.

**Instructions: shipped, and the "one mechanism" idea above was wrong.** `projects.instructions`
(migration `0073`) is edited on the project page and injected through the project-context
slot. Writing it out as a `CLAUDE.md` would have made it *depend on the trust flag*, because
`CLAUDE.md` only loads when `settingSources` includes `'project'` — so an operator's own
standing instructions would have silently stopped loading for any project whose repo config
they had not accepted. That is the one thing that must not be gated: "do I trust what this
repo committed" and "here is what I want the agent to know" are different questions, and
collapsing them into one mechanism collapses the answer too. Two mechanisms is correct here;
a repo's own `CLAUDE.md` still loads on the trusted path, and when both exist they compose.

Empty means none — a cleared textarea writes NULL rather than an empty heading into every
system prompt — and the field is capped at 8000 characters, because a project that wants to
carry more than that wants the knowledge directory, not a longer slot.

The security consequence is why it is a gate rather than a default: loading project settings
means a cloned repo can ship hooks and permission allow-rules, and `settingSources` offers
one tier for those and for `CLAUDE.md` together — they cannot be separated. Trust therefore
has to mean what it says. I did not take the earlier suggestion of defaulting it on for
`repo_kind = 'local'`: a `local` project's working directory is also where the agent writes,
so "we created it" is not the same as "a human wrote what is in it". Everything starts
untrusted.

Behaviour change to expect on deploy: a project whose `CLAUDE.md` was being honoured
silently stops being honoured until someone trusts it.

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

**Shipped (#5).** Steps 1 and 2 are done. `Options.agents` is built per run by
`$lib/engine/agent-definitions{,.server}`, `run_subagent` is off the engine surface, and
`inline-subagent.ts` is deleted. `forwardSubagentText` is on, so a child's prose arrives
and `stream.server.ts` routes it by `parent_tool_use_id` into `subagent_*` frames rather
than into the parent's reply — the defect #34 describes, closed structurally rather than by
a wrapper. Two things the work decided that the plan above did not anticipate:

- **`Task` is classified as a mutation**, so plan mode refuses to delegate. A `Task` call
  changes nothing by itself, but what it costs is decided by the child, and
  `sdkPermissionModeFor` hands the SDK `'default'` in plan mode — our `canUseTool` gate is
  the only thing enforcing read-only, and nothing here has established that a child's own
  calls reach it. Allowing delegation would be an unobserved channel out of a read-only
  mode. This is the cheapest thing on the list to revisit: observe one child tool call
  arriving at the gate and it becomes `read`.
- **A scoped agent's `allowedTools` has to be MCP-qualified.** The SDK reads a `tools` entry
  matching nothing as "this agent has no such tool", so bare in-house names would have left
  a scoped agent with a shorter surface than its config asked for, with no error anywhere.

Steps 3–5 (the concurrency cap, per-child budget, tree rendering from `tool_use_result`,
`stopTask` cancellation) are still open and belong with #32.

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

**Status (2026-09-23).** Step 1 shipped in e0c6234. The strip shipped on `/activity`
(`src/lib/costs/usage-digest*.ts`): runs, tokens first with metered dollars, automations,
most-used tools, the review inbox, budget headroom read from the enforced `budget_limits`,
and anomaly flags with fixed floors. The digest was built as the cheap version rather than
the agent run: the same numbers rendered to markdown by code, delivered through the existing
maintenance output routing, costing nothing, and opt-in from the strip — nothing posts on
deploy. A written narrative was not built. Still open: tool calls from the older runtime
loop (automations, monitors, PR fix) write no ledger rows. The Settings daily/monthly
budget figures, display-only when the strip shipped, became enforced budget limits the same
day, so once set they show as headroom instead of "No limits set".

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

**Landed** (finished rather than deleted, by the owner's decision): a speaker button on each
reply, an opt-in per-device auto-read for the hands-free case, and `ttsModel` / `ttsVoice`
settings picked from OpenRouter's speech catalogue. The hard-coded `openai/gpt-4o-mini-tts`
turned out not to exist on OpenRouter at all, so the endpoint could never have worked; the
default is now `hexgrad/kokoro-82m`. `/api/tts` is JSON-only with capped, validated input,
checks budget limits, and records catalogue-priced spend under `tts`. See
[`docs/speech/speech.md`](../speech/speech.md).

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
   while a command runs (#26, which is the background path in #35). The ledger gap was
   closed off the same field (e0c6234; see the "Fixed" note under the ledger finding).
2. **The handle** (finding 2) — keep `Query` alive per conversation. Unblocks the rest
   of #35, and real context accounting. (#24 turned out not to need it: a rewind opens its
   own short-lived control session, which also survives a restart — see the #24 section.)
3. **The two defects** — delete `search_tools` and its prompt text; account built-in tool
   calls. **Done**: both fixed, and `search_tools` has since been deleted outright (#8).
4. **#5, then #32 reshaped** — the orchestration keystone, which also deletes `$lib/runtime`
   (#8) and gets worktrees for free.
5. **#23 via `settingSources`**, then the `/` half of #22 on top of it.
6. **#17**, HTTP transport first.
7. The cheap independents whenever: ~~**#27 delete**~~ (finished instead), **#4**, **#18**, **#14**.

Rough shape of it: items 1–3 are maybe a week of work that makes five issues small, and four
of the open issues (#27 plus the obsolete halves of #24, #32 and #35) should be closed or
rewritten rather than built as filed.
