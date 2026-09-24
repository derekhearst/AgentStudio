# Chat Spec

## Overview

Chat is AgentStudio's primary user interface: a chat-first control plane for planning, executing, inspecting, and approving agent work. It is not just a message list. It is the unified surface where users choose work mode, review plans, watch live progress, inspect artifacts and diffs, answer agent questions, approve risky actions, and review pull requests without leaving the chat flow.

This domain exists because the runtime, tasks, runs, research, projects, and review inbox specs define backend primitives, but users still need one coherent UI shell that turns those primitives into a product comparable to Claude, Gemini, and long-running agent apps.

## Sessions vs. Runs

A **session** is the persistent conversation container visible to the user — it has a title, a mode, and an ordered message history that spans the entire lifetime of a chat thread. Sessions survive indefinitely and are the unit users see in the sidebar.

A **run** is one discrete agent execution that happens _inside_ a session. Sending a message in agent mode starts a run; that run completes (or fails), and its output messages are appended to the session. The next message starts a new run. A single session typically contains many runs over its lifetime.

|                  | Session                           | Run                                           |
| ---------------- | --------------------------------- | --------------------------------------------- |
| Owned by         | `chat` domain                     | `runs` domain                                 |
| Lifetime         | Indefinite — user deletes it      | One agent loop execution                      |
| Created by       | User opening or continuing a chat | Each user message in agent/plan/research mode |
| 1:N relationship | One session → many runs           | One run → one session                         |
| Message history  | `sessionMessages` (all turns)     | `run_events` (events during that execution)   |
| User sees        | Sidebar thread                    | Live HUD + trace in right panel               |

## Data Model

Chat owns the `sessions` table — the canonical record of a user-facing conversation. Every run, task, research session, and review item that originates from a conversation carries a `sessionId` FK back to this table.

### `sessions` table

| Column              | Type      | Notes                                                                                           |
| ------------------- | --------- | ----------------------------------------------------------------------------------------------- |
| `id`                | uuid      | Primary key                                                                                     |
| `userId`            | uuid      | FK to `users` — owner                                                                           |
| `title`             | text?     | Auto-generated or user-edited title                                                             |
| `mode`              | enum      | `chat`, `research`, `plan`, `agent` — current active mode                                       |
| `projectId`         | uuid?     | FK to `projects` — project currently in scope for this session                                  |
| `currentArtifactId` | uuid?     | FK to `artifacts` — artifact the agent edits by default                                         |
| `taskId`            | uuid?     | FK to `tasks` — task this session is driving, if any                                            |
| `agentId`           | uuid?     | FK to `agents` — optional pinned main agent for this session (null = use scoped `main` binding) |
| `createdAt`         | timestamp |                                                                                                 |
| `updatedAt`         | timestamp |                                                                                                 |

### `sessionMessages` table

The ordered message history for a session. Append-only.

| Column      | Type      | Notes                                                                |
| ----------- | --------- | -------------------------------------------------------------------- |
| `id`        | uuid      | Primary key                                                          |
| `sessionId` | uuid      | FK to `sessions`                                                     |
| `runId`     | uuid?     | FK to `runs` — which run produced this message (null for user turns) |
| `role`      | enum      | `user`, `assistant`, `system`, `tool`                                |
| `content`   | jsonb     | Message content blocks (text, image, tool_call, tool_result, etc.)   |
| `seq`       | integer   | Monotonic sequence number within the session                         |
| `createdAt` | timestamp |                                                                      |

### `chatWorkbenchPreferences` table

| Column           | Type      | Notes                               |
| ---------------- | --------- | ----------------------------------- |
| `id`             | uuid      | Primary key                         |
| `userId`         | uuid      | FK to `users`                       |
| `defaultMode`    | enum      | `chat`, `research`, `plan`, `agent` |
| `showRightPanel` | boolean   |                                     |
| `panelLayout`    | jsonb     | Widths, collapse state, tab pinning |
| `createdAt`      | timestamp |                                     |
| `updatedAt`      | timestamp |                                     |

## Features

### Composer modes

The composer supports four explicit modes, each representing a distinct cognitive stance. `sessions.mode` records the current mode and is updated on each switch. Mode switches are recorded as system messages in `sessionMessages` so the model understands its posture has changed.

| Mode       | Intent                                                                                       | Assumption level |
| ---------- | -------------------------------------------------------------------------------------------- | ---------------- |
| `chat`     | Conversational — direct answers, minimal tool use, collaborative pushback                    | Low              |
| `research` | Skeptical investigation — surfaces uncertainty, cites sources, asks before acting            | Minimal          |
| `plan`     | Structured proposal — produces a plan with success criteria before any execution             | Medium           |
| `agent`    | Autonomous execution — proceeds on best interpretation, interrupts only for genuine blockers | High             |

Mode selection affects the main agent's identity prompt (loaded from an editable skill), which tools are available, which companion skills auto-load, and which right-panel UI is shown. Modes are **not** skills — the identity prompt backing each mode is stored as a skill so it can be edited without code changes, but the mode itself is a session-level behavioral contract stored in `sessions.mode`.

The mode selector appears in the composer toolbar. Switching mode mid-conversation injects a system anchor message so the model understands its posture has changed. Context (prior messages, plans, research findings) is always preserved across mode switches.

Default mode is set in `chatWorkbenchPreferences.defaultMode`. The intended workflow is:

```
Research mode → surface findings, challenge the premise
    ↓ user satisfied with direction
Plan mode → propose implementation with success criteria
    ↓ user approves plan
Agent mode → execute, minimal interruptions
```

### Message attachments

A user can attach files to a chat message from the composer. Each file is uploaded first, stored on the server, and recorded on the message so it survives a reload. When the message is sent, the attachment is delivered to the model in one of three ways, chosen by file type:

| Attachment type                         | How the model receives it                                                                                                    |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| PNG, JPEG, GIF, WebP images             | Sent inline with the message, so the model literally sees the picture                                                          |
| PDFs                                     | Saved into the agent's sandbox workspace; the message tells the agent the path and the agent reads it with the PDF reader tool |
| Small text files (txt, csv, json, md)   | Their contents are pasted into the message directly, so no tool call is needed                                                 |
| Spreadsheets and other files            | Saved into the agent's sandbox workspace and announced by path, so the agent's file tools can open them                        |
| Video                                    | Saved into the workspace, but the model cannot watch it — the user is warned                                                   |

Rules that keep this honest:

1. A single image is capped at roughly 3.7 MB of original file size. Larger images are refused with a warning asking the user to resize, because sending them would fail at the model boundary.
2. If a file cannot be delivered — wrong image format, too large, unreadable from storage, no workspace to stage it in, or a missing reader tool — the assistant's reply opens with a short "Attachment warning" block naming the file and the reason. The warning is saved with the message, so it is still there after a reload.
3. The same rules apply whether the conversation is on a Claude model or a third-party model routed through the gateway. A gateway model that cannot see images will simply not use them; nothing about the delivery path changes.
4. Files attached on the new-chat page (`/`) go with the first message, exactly as if they had been attached inside the conversation. The new-chat page used to upload them, show them, and then send only the text.

### Starting a conversation from the new-chat page

The new-chat page (`/`) greets the owner by the display name they gave during first-run setup ("Good morning, Alex"). If no name was given, the greeting is just "Good morning".

Sending from the new-chat page works like this:

1. The page creates the conversation and adds it to the sidebar straight away.
2. It opens the conversation, handing over the typed message and any attached files.
3. The conversation page waits until it has loaded the conversation, then removes the message from the address bar and sends it.

The order matters. The message leaves the address bar before the reply starts, so reloading the page or restoring the tab while the reply streams does not send it a second time. It also leaves the browser history, so going to another page and pressing Back returns to the conversation without the message, even when the first send failed before anything was saved. A conversation that already has messages, or a turn already running, never gets the handed-over message again. And moving to another page while the first reply streams keeps you there: the conversation page no longer jumps back to the chat when the reply finishes.

Attached files are handed over inside the open tab, not through the address. If the tab is reloaded before the message is sent, the files are not attached. They stay uploaded and can be attached again.

### Session list, filtering, and grouping

The left session list is the primary navigation surface for chat history.

The list stays current on its own. A new chat appears as soon as it is created, the generated title replaces "New conversation" a moment after the first reply, and the order follows the most recent activity. This works for chats started in another tab, on another device, or by an automation too: the page's live-status connection reports when the list has changed, at most every couple of seconds, and the list is reloaded.

Each row shows a snippet of the conversation's latest reply. Only the listed conversations' latest replies are read, one per conversation. The list used to read every reply ever written, by every user, on every page load.

- Users can filter the list by agent so they can quickly switch between sessions associated with different agent personalities.
- The filter supports two scopes:
  - **Main agent filter**: sessions whose effective main agent matches the selected agent (resolved from `sessions.agentId` or scoped main binding).
  - **Participating agent filter**: sessions where the selected agent appeared in any run in that session (including subagent runs).
- Users can group sessions by project. Group headers are project names; sessions with no project appear under `No Project`.

### Session run tree view

Each session row can be expanded into a run hierarchy tree derived from `runs.parentRunId`:

- Root node is the session's top-level run.
- Child nodes are spawned subagent runs.
- Each node shows agent name, run state, and timestamp.
- Selecting a node opens that run's trace/HUD context while staying in the same session.

The tree is read-only navigation metadata. It does not create a separate conversation thread; all user-visible conversation messages remain in the session.

### Plan approval inline

When the main agent proposes a plan, the chat thread renders it as a structured approval card:

- Summary
- Task graph or sub-task list
- Estimated cost and time
- Approve
- Request revision
- Cancel

Users do not need to leave chat to approve the next step.

### Live run HUD

The workbench shows a live run HUD with:

- Active agent
- Current round
- Running tool
- Subagents in progress
- Token and cost budget
- Pending approvals
- Blocked state reasons

### Right panel

The right panel is always visible and uses the same set of tabs in all modes. Tab content adapts to what is relevant for the current mode and active run. The panel is partially implemented; some tabs are functional, others are planned.

| Tab         | Agent mode                                                                                | Research mode                 | Plan mode                     | Chat mode              |
| ----------- | ----------------------------------------------------------------------------------------- | ----------------------------- | ----------------------------- | ---------------------- |
| **Files**   | Changed files list, unified diff preview                                                  | Read-only file browser        | Read-only file browser        | Read-only file browser |
| **Run HUD** | Agent, round, active tool, subagents, token+cost budget, pending approvals, blocked state | Progress events, source count | Plan graph, estimate summary  | —                      |
| **Memory**  | Context window inspector, active memory refs                                              | Active memory refs            | Active memory refs            | Active memory refs     |
| **Task**    | Linked task, sub-tasks, approval controls, evaluator status                               | Linked task                   | Linked task, success criteria | Linked task            |
| **PR**      | Pull request status, diff summary, pending review items                                   | —                             | —                             | —                      |

On mobile, the right panel collapses into a bottom sheet tab drawer.

### Inline approvals and answers

Approval requests and `ask_user` questions render inline in the thread, but are also reflected in the global Review Inbox. Resolving from either place updates the same durable state.

### Command output

When the agent runs a shell command, the reply shows it as a small terminal instead of a generic tool card. It looks the same while the turn runs and after a reload.

- The first line is the command. Below it is what the command printed, in a fixed-width font with its line breaks kept. Normal output and error output are shown separately; error output is red.
- Colour codes, terminal links, window titles and redrawn progress bars are cleaned out, so the text reads as plain text. A progress bar that redraws itself on one line shows only its last state (`100%`, not `10% 50% 100%`).
- Long output opens on its **last 20 lines**, because that is where a command says how it went. **Show all N lines** opens the rest and **Show last 20 lines** folds it back. **Copy output** always copies everything.
- The card opens on its own when there is output, when the command failed, or when it ran in the background.
- One badge says how it ended: `exit 2` for a command that failed with an exit code, `failed`, `interrupted`, `timed out`, or no badge for a command that succeeded. Claude Code only reports an exit code for a failed command and for a finished background command, so a successful ordinary command shows no badge rather than `exit 0`.
- Some commands use an exit code to mean something other than failure (for example, `grep` returns 1 when it finds nothing). When Claude Code explains the code ("No matches found"), the card shows the explanation.
- Each stream keeps its last 16,000 characters. When earlier output was cut, the card says so.

### Background commands

The agent can start a command in the background, such as a dev server, a watcher or a long build, and keep working while it runs.

1. The command's card opens straight away with a **live** badge. What the command prints appears in the card about once a second. The card follows the newest line, unless you have scrolled up to read something.
2. A chip in the header shows each running background command, with a button to stop it.
3. When the command finishes, the badge changes to how it ended: its exit code (`exit 0`, `exit 2`), or `finished`, `failed` or `stopped`. A notice in the transcript says it finished.
4. **Background commands end with the turn.** When the agent finishes its reply, every command it started is stopped, because the Claude Code process that ran them is closed after each turn. A command still running at that point is marked **ended with turn**, its card says "Stopped when the turn ended", and one notice in the transcript lists the commands that were stopped. The header chips clear at the same moment.
5. The agent is told this in its instructions. It should finish any work that needs the command in the same reply, and never tell you a server is still running after it has answered. It is also told that it cannot open the command's output file itself (the file is outside its workspace), and to copy output into its workspace, for example with `tee`, when it needs to read it.

A page that is reloaded mid-turn picks the card up again from the next piece of output. If it missed some output in between, the card says earlier output is missing. When the command ends, the card shows the final output that was saved with the reply.

**Deleting a conversation stops it first.** If a turn is still running when a conversation is deleted, that turn is stopped, and every background command it started goes with it. Then the conversation is deleted. Before, the conversation disappeared but its turn and commands kept running, with nothing left in the app that could stop them.

Rules:

- The live output is read by the server from the file Claude Code writes the command's output to. The server only reads that file if Claude Code's own message named it, it sits exactly where Claude Code keeps this session's output for this command (`…/<session id>/tasks/<task id>.output`), and it is a plain file rather than a link to somewhere else. A path the agent or the command wrote is never read. If anything about the file looks wrong, the card shows no live output, but it still shows how the command ended.
- The live pieces of output are not saved one by one. The reply saves the card's final output (its last 16,000 characters) and how the command ended, so a page that reconnects still ends up with both.
- Background commands started by a subagent are not followed. They belong to the subagent and end with its answer.
- When the agent stops one of its own background commands (Claude Code's `TaskStop` tool), the call is never held for approval, even on a machine without the shell sandbox where every command asks first: it can only stop a command this session started, and it names no file.

What this relies on, checked against the installed Agent SDK (0.3.278, bundled Claude Code 2.1.278):

- From the SDK's published types: `task_notification` reports a finished task with its task id, the id of the call that started it, `completed` / `failed` / `stopped`, a one-line summary and the output file's path. `background_tasks_changed` is the whole set of running tasks each time, and is not to be paired with the finish notices. There is no output for a running ordinary command (`tool_progress` carries elapsed seconds only). The old `BashOutput` / `TaskOutput` polling tools were removed; `BashOutput` is now only the name of the `Bash` result's shape. Without the `perTaskStopAffordance` option, which AgentStudio does not set, stopping a turn also kills its background tasks.
- Seen in Claude Code itself, not promised by the types, so a future update could change it: the "Output is being written to: …" sentence in a backgrounded command's result, the `<session id>/tasks/<task id>.output` file layout, `KillShell` and `KillBash` as old names for `TaskStop`, and a failed command's result starting with `Exit code N`. If any of these change, the cost is quiet cards (no live output, no exit code), never a failed turn.

### Diff and artifact preview

When a coding run changes files or saves artifacts, the workbench can show:

- Changed files list
- Unified diff preview
- Artifact version timeline
- Evaluator findings linked to files or deliverables

### Research report view

Research results render as:

- Executive summary
- Sectioned report
- Inline citations
- Clickable source drawer
- Plan-to-report trace

### Pull request review view

Pull requests render as first-class review objects:

- Title, branch, and status
- Diff summary
- Evaluation verdict
- Testing status
- Approve to open draft pull request
- Request changes back to agent

### Interrupt and redirect controls

Users can intervene mid-run from chat:

- Pause run
- Cancel run
- Answer question
- Approve or deny tool request
- Convert current conversation into a formal task
- Spawn follow-up research or evaluator pass

How the controls that exist today behave:

- **Stop** ends the current turn. The page asks the server to stop the run, and what the agent produced so far is kept as its reply. Reloading the page or losing the connection does **not** stop a run; it keeps working and the page reconnects on its own. See [../runs/spec.md](../runs/spec.md#stopping-a-run).
- **Coming back to a running turn.** Opening a conversation whose turn is still running — after a reload, or from another tab — shows that turn streaming again, with its tool and approval cards and the Stop button. Text written before you came back appears once the turn finishes.
- **One turn at a time.** A message sent while a turn is still running is not sent. The page says so, keeps the message for Retry, and shows the running turn instead.
- **Allow / Deny.** An approval card only shows a call as approved or denied once the server has recorded the answer. If it could not be recorded (the approval timed out, or was answered in another tab), the card keeps its buttons and says why.
- **Answering a question.** When the agent asks a question (`ask_user`), the answer only counts once the server has recorded it. If the question is no longer waiting (it timed out, was answered in another tab, or its turn ended), the page says so and shows the conversation as the server has it, rather than closing the question as if the answer had gone through. An answered question shows the answer under it straight away, and again after a reload. It no longer keeps a live Submit button that does nothing.
- **Switching conversations mid-turn.** Opening another conversation while a reply is streaming shows only the other conversation. Nothing from the first one comes along: not its reply, its tool cards, its Stop button, its error message or its Retry. Leaving is not a Stop. The first turn keeps running, saves its own reply, and shows again with Stop when you go back to it.
- **A turn that ends in an error.** Some turns end in an error after the reply was already saved, for example when the agent reaches its maximum number of steps or the model provider is overloaded. The page shows the error and keeps the one saved reply. It used to save a second, partial copy of the same reply.
- **Background tasks.** A command the agent starts in the background (a dev server, a watcher) shows as a chip in the header while the turn runs, with a button to stop it, and streams its output into its card (see [Background commands](#background-commands)). The chips go away when the turn ends, because ending a turn also ends the commands it started. If a stop does not work, a short message under the header says why — for example that the turn had already ended.
- **Pinned checklist.** The panel above the composer shows the main agent's latest plan. When the agent hands a step to a subagent, the subagent's own checklist does not replace it.

### Context meter

The context meter above the composer, and the same figure in the right rail, estimate how much of the model's context window the conversation fills. It adds up:

| Part | Where the figure comes from |
| --- | --- |
| System prompt | Measured by the server when it builds the prompt for a turn. Before any turn has run on the page, a fixed allowance stands in |
| Tool definitions | A fixed allowance |
| Messages | Estimated from the text of every message in the conversation |
| Tool results | Estimated from the saved output of every tool call. Each reply's output is counted once, from its saved steps when it has them |

Everything except the system prompt is an estimate (about four characters per token), so treat it as a guide. It used to show only the system prompt once a turn had run, so a long conversation looked nearly empty. That also mattered for model switching: when you switch to a model with a smaller window, the page asks the agent to summarise the conversation first if it would fill more of the new window than the auto-compact threshold in settings (72% by default), and that check uses this figure.

A reply saved after Stop or an error keeps its tool output in two places. The meter counts it once, so a stopped turn with a large command output does not read as twice its size or set off that summary early.

### Mobile and compact layout

On mobile, the right panel collapses into a bottom sheet or tab drawer. The workbench preserves the same actions, but prioritizes the thread and current blocker state.

### Reading replies aloud

Every assistant reply has a speaker button beside Copy. It reads the reply through `POST /api/tts`, skipping code blocks, and the same button stops it. An **Auto-read** switch above the composer (off by default, remembered per device) reads each new reply when its turn finishes. A turn that was stopped or failed is not read, and neither is a reply saved as "(no output)". The chat page only hands the switch its saved messages, whether a turn is running, its Stop flag and the error it is showing; playback lives in `src/lib/speech`. See [../speech/speech.md](../speech/speech.md).

### How replies are displayed safely

Assistant replies, thinking, subagent results and `ask_user` questions are written by the model, and the model may be repeating text it picked up from a web page, a repository or a tool result. Someone who plants instructions there can try to make the model write HTML that would run inside the app, or an image link that quietly sends data to their server the moment the reply is shown. So replies are displayed as formatted markdown, but under these rules:

| Content in a reply | What the reader sees |
| ------------------ | -------------------- |
| Headings, lists, tables, bold, links, code blocks | Formatted as usual; code blocks keep syntax highlighting |
| Simple formatting tags with no attributes (`<br>`, `<b>`, `<i>`, `<sup>`, `<sub>` and similar) | Formatted |
| Any other HTML (`<script>`, `<img>`, `<style>`, `<div>`, tags with attributes) | Shown as text, never run |
| A link to an `http`, `https` or `mailto` address, or a page inside the app | A normal link; outside links open in a new tab without telling the site where you came from |
| A link using any other scheme (`javascript:`, `data:` and so on) | Just the link text, with no link |
| An uploaded image (an attachment stored by the app) | Shown inline |
| Any other image, including other addresses inside the app | A link labelled "Image: …" that opens only if the reader clicks it |

Images are the one place where "inside the app" is not good enough. The browser fetches an image as soon as the reply is shown, with the reader's login, and without asking. An address inside the app that redirects somewhere else (or that changes something when it is visited) would turn that fetch into a leak or an unwanted action. So only the upload store, which just returns the stored file, is loaded automatically.

The renderer checks itself when the app starts by running a set of known attack samples through it. If any of them gets through (for example after a library upgrade changed how it works), replies are shown as plain text instead.

## Behavior Contracts

- A plan approval card is rendered from task state, not from transient chat text.
- Approval actions from chat and review inbox mutate the same durable records.
- A blocked run always shows its blocker reason in the HUD.
- Workbench mode affects defaults and UI chrome, not permissions by itself.
- The workbench remains usable on mobile with a collapsible context panel.
- A pull request card shown in chat is always backed by a durable `pullRequests` row.
- Session list agent filters are deterministic: identical filter inputs over unchanged data produce identical session ordering and counts.
- Project grouping never duplicates a session across groups; each session appears exactly once under its current `projectId` or `No Project`.
- Run tree nodes are derived from durable `runs` lineage (`id`, `parentRunId`, `sessionId`) and are never inferred from transient UI state.
- An attachment on a message is either delivered to the model or warned about on that message. There is no path that accepts a file and silently ignores it.
- A turn's reply is saved once. A reply the server saved is never saved again from the page as a partial copy, and a partial saved on Stop always goes into the conversation the turn belongs to.
- Messages keep their order when two writers add to a conversation at the same moment (a Stop saving what was written so far while the turn saves its final reply, or a background run). The one that loses the race takes the next position and is still saved.
- A staged attachment always lands in the same sandbox workspace the run's own tools resolve, so the path quoted to the agent is a path the agent can open.
- Nothing the model writes can run script in the app, and displaying a reply never loads any image except an uploaded attachment.

## Roles & Permissions

| Action                           | Who can do it      |
| -------------------------------- | ------------------ |
| View own workbench sessions      | Authenticated user |
| Approve own plan or tool request | Owner user, admin  |
| Resolve another user's item      | Admin only         |
| View admin observability panes   | Admin only         |

## Rewrite Authority

The current implementation is a baseline, not a constraint. This domain may be rewritten, restyled, reorganized, or replaced as needed to achieve the target product quality. No code path is off-limits if behavior contracts, safety controls, tests, and documentation remain correct.

## UI Contract

This domain follows [../ui/spec.md](../ui/spec.md) and defines the primary app-shell experience.

- Surfaces: session list (with agent filter, project grouping, and expandable run tree), chat thread canvas, composer, mode selector, live run HUD, inline action cards, and mode-aware right panel tabs.
- States and badges: running, blocked, needs-input, queued interjection, completed, failed, and pending approvals count.
- Blocking actions: plan approvals, tool approvals, and ask_user responses must resolve through durable review items.
- Mobile behavior: right panel collapses to bottom-sheet tabs; blocking cards remain visible near composer; session tree uses progressive disclosure to avoid deep nested panes.

## References

- [../ui/spec.md](../ui/spec.md) - cross-domain UX contracts, layout shells, and interaction standards
- [../tasks/spec.md](../tasks/spec.md) - plan approval and task steering
- [../runs/spec.md](../runs/spec.md) - durable run state and blockers
- [../research/spec.md](../research/spec.md) - deep research progress and report rendering
- [../observability/spec.md](../observability/spec.md) - review inbox and human-required actions
- [../projects/spec.md](../projects/spec.md) - artifacts and version history
- [../source-control/spec.md](../source-control/spec.md) - pull request review objects
