# Chat

## Overview

Chat is where the owner works with AgentStudio's agents. A **conversation** is one thread: a
title, the agent it is bound to, and an ordered history of messages. Each message the user
sends starts a **turn**, in which the agent answers and may use tools — read and edit files,
run commands, search the web, hand work to a subagent. Everything the turn did is kept on the
reply, so a conversation can be reread, searched and exported later.

Each conversation is a list of messages in AgentStudio's database, and behind it sits a
Claude Agent SDK session: the SDK's own record of the conversation, which is what the model
actually reads on every turn.

This document covers two things:

- **Looking after the list of conversations** (#18): pinning, archiving, renaming, deleting,
  searching and exporting.
- **Changing a conversation after the fact** (#24):
  - **Edit** a message you sent, and get a new reply to the edited text.
  - **Regenerate** the last reply.
  - **Also restore files**: when you edit or regenerate, put the files the dropped replies
    changed back the way they were.
  - **Compact** a long conversation so it takes less of the model's context.

The live chat screen (the composer, streaming, approvals, the right rail) is described in
[chat-console](../chat-console/chat-console.md), and the full feature spec (composer,
attachments, tool cards, approvals and so on) in [spec.md](spec.md).

Audience: the owner, and anyone working on the chat code (`src/lib/chat/`).

## Key concepts

| Concept | What it is |
| --- | --- |
| **Conversation** | One chat thread. Has a title, an agent, a model, token and cost totals, and a *last activity* time that orders the list. |
| **Message** | One entry in a conversation (a row in the `messages` table): from the user, the assistant, or the system (a note such as "the conversation switched agents here"). What the page shows. An assistant message carries the **blocks** of its turn: text, thinking, tool calls with their arguments and results, subagent work and run notices. |
| **Pinned** | A conversation kept at the top of the sidebar. The pin records *when* it was pinned. |
| **Archived** | A conversation put away: hidden from the normal list, but kept whole. The archive records *when* it was archived. |
| **Search index** | For every message, the text it can be found by — see "Search conversations" below. Kept in its own table beside the messages. |
| **SDK session** | The Claude Agent SDK's transcript of the conversation (`conversations.sdk_session_id`). What the model sees. Each turn resumes it. |
| **Transcript join** | Where a message row sits in the SDK transcript, recorded on the row's `metadata` (see below). How an edit knows where to cut, and how a restore knows which checkpoint to go back to. |
| **File checkpoint** | A backup the SDK takes of a file just before the agent's file tools (Write, Edit, MultiEdit, NotebookEdit) change it, keyed by the message that started the turn. |
| **Restore** | Putting files back to how they were at one of your messages, from those backups. Files the agent created after that point are deleted. |

### The transcript join

No schema change: three keys on `messages.metadata`.

| Row | Key | What it holds |
| --- | --- | --- |
| Your message | `sdkTurn` | The id the message carried into the SDK transcript, the SDK session it went into, the working directory the run used, and whether files were checkpointed on that turn. |
| The agent's reply | `sdkTailUuid` | The last transcript entry that turn wrote — the point an edit of the *next* message cuts back to. |
| Your message | `sdkCutPending` | Set when an edit or regenerate cuts the conversation back to this message. It means the SDK session still holds the replies that were dropped. It is cleared as soon as a new turn starts on a session that has been cut to match (or on a fresh one). |

AgentStudio chooses the id each message carries into the transcript, rather than letting the SDK make one up, so it knows it in advance. Messages from before this change have no join; they still work, as described under business rules.

## User flows

The first six flows start from the **"⋯" button on a conversation in the sidebar** (on a
phone, in the navigation drawer). On a computer the button, and a one-click **Archive**
button, appear when the pointer is over the row; on a touch screen the "⋯" button is always
there. The menu opens just below the row. Editing, regenerating and compacting happen in the
open conversation.

### Pin a conversation

1. Open the menu and choose **Pin to top**.
2. The conversation moves into a **Pinned** group above all the others. It stays there
   however old it gets, whichever way the list is grouped. The most recently pinned
   conversation is first in the group, whatever each one's last activity.
3. **Unpin** in the same menu puts it back in date order.

### Archive a conversation (the everyday way to tidy up)

1. Click the **Archive** button on the row, or choose **Archive** from the menu.
2. The conversation leaves the list. Nothing is deleted: its messages, run history, costs and
   the memories mined from it all stay.
3. To find it again, open the filter menu under the search box and set **Status** to
   **Archived**. The list shows archived conversations, most recently archived first, with a
   **Back to chats** link to return. In this view everything goes by when a conversation was
   archived, not when it was last used: grouped by date, one archived today sits under
   "Today" even if nobody had touched it for a month, and the time on each row is how long
   ago it was archived.
4. Choose **Unarchive** from its menu to put it back. It returns to its old place in the list.

A conversation also comes back on its own when the owner **sends a message in it** (for
example, by opening it from a search result and replying).

### Rename a conversation

1. Choose **Rename** from the menu.
2. Edit the title in the box that appears and press Enter (or **Save**). Escape cancels.

### Delete a conversation

1. Choose **Delete…** — the last item in the menu, in red.
2. A confirmation explains what is lost and suggests archiving instead. Confirm with
   **Delete**.
3. If the agent is still working in that conversation, its turn is stopped first, exactly
   as the **Stop** button would stop it — along with any commands it left running in the
   background and any subagents it delegated to — and the delete waits up to ten seconds
   for it to finish saving what it had done. Then the conversation is deleted.
4. If that conversation was open, the app goes to the new-chat page.

### Search conversations

1. Type in the **Search** box at the top of the sidebar.
2. The list filters instantly by title and latest reply, among the conversations already
   loaded.
3. A quarter of a second after typing stops (two characters or more), the server searches the
   whole history. Results appear under **In messages**: the conversation's title, an
   *archived* badge where it applies, when the matching message was written, and an extract
   with the matching words highlighted. A short message (up to 100 characters, such as
   "fix the login bug now") is shown whole; a longer one shows up to two short excerpts,
   each with the words either side of a match. Click one to open that conversation.
4. While the Archived view is open, search covers archived conversations too.

What search finds:

- the text of every message, the owner's and the assistant's (an edited message by what it
  says now);
- attachment file names;
- **the work each turn did**: for every tool call, the tool's name, the file paths it read or
  changed, the commands it ran and their descriptions, short arguments (titles, names,
  queries), and web links it printed — so "the run where it touched `options.server.ts`" or
  "the one where it opened that pull request" can be found even though neither was ever said
  in words;
- what a subagent was asked to do, the start of its answer (or its final report), and the
  tools it called with the files and commands they touched — so work the agent delegated is
  found the same way as work it did itself;
- conversation titles.

A file can be found by its full path (`src/lib/engine/options.server.ts`), by part of it
(`engine/options.server.ts`), by its name (`options.server.ts`) or by one piece of it
(`options`). Results start appearing while a word is still being typed (`optio` finds
`options`). Quotes search for an exact phrase, `or` finds either word, and a leading `-`
excludes a word.

What search deliberately does not look at: the full output of tools (a file that was read, a
long command output), the contents of files that were written or edited, the model's private
thinking, and system notes.

### Export a conversation

1. Choose **Export as Markdown** or **Export as JSON** from the menu.
2. The file downloads, named after the conversation and the date (for example
   `fix-the-login-page-2026-09-23.md`). Browsers that support it use the readable title
   instead, accents and emoji included, cut to its first 80 characters; a cut never splits
   an emoji in half.

| Format | What it is for | What it contains |
| --- | --- | --- |
| **Markdown** | Reading, pasting into notes or an issue, handing to another model | A header (dates, agent, model, tokens, cost), then each message in order. Edits appear as diffs, commands with their output, checklists as checklists, subagent work as quotes (with the subagent's own tool calls, and whether it was stopped), the model's thinking folded away. Very long tool output is shortened, with a note pointing to the JSON export. |
| **JSON** | Keeping a complete copy, or reading it with a program | Everything, unshortened: the conversation's details and every message with all of its blocks, tool arguments and results. The owner's account id is left out. |

### Editing a message

1. You click the pencil on one of your messages, change the text, and click **Save & regenerate**. (The pencil is hidden while a reply is being written.)
2. If the dropped replies changed files that can be restored, the **restore dialog** opens (below). Otherwise the edit goes straight on.
3. If you chose to restore files, the files are restored first. If that fails, nothing else happens: the conversation is left exactly as it was and the error says so, so you can try again or go on without restoring.
4. Your message is updated and everything after it is deleted. Search finds the message by its new text from then on.
5. A new reply is written. The model sees the conversation up to the reply before your message, followed by your edited text — nothing from the replies you dropped.

If step 5 never starts — the connection drops, the server fails or restarts before the reply begins — the edit is not lost. The message is marked as cut (`sdkCutPending`). Whatever you do next, **Retry** or simply sending a new message, cuts the session back the same way first. The model then sees the conversation as the page shows it, never the replies you dropped.

### Regenerating a reply

The same as editing the last message without changing it: the last reply is deleted and the model answers your message again, without seeing the reply it is replacing.

### The restore dialog

It shows:

- the files that would be restored, with the total lines added and removed;
- **Also restore these files to how they were before this message**, ticked by default;
- a warning on any file git reports as having uncommitted changes, because restoring overwrites them — including edits you made yourself;
- for a project imported from a remote repository, a second box, **Overwrite the uncommitted changes in these files**, which must be ticked before Continue works when any of the files has uncommitted changes;
- a reminder that only changes made with the agent's file tools are restored: changes made by shell commands, and commits or pushes, are not undone.

**Cancel** does nothing at all, and an edit stays open so you can try again. When a checkpoint exists but cannot be used right now (a reply is still being written, the conversation was compacted since, the backup has expired), the dialog says why and offers to continue without restoring.

The dialog does not appear when there is nothing to restore: a chat with no project, a message from before this feature, or a turn that did not change any files.

After a restore, the page warns you if some of the listed files were **not** put back. The SDK leaves a file alone when a link is in the way: a symlink or hard link at that path, or a folder that has moved since the message. The warning says how many files were restored and how many were left alone, and it stays until you dismiss it. The SDK can only find this out during the real restore, not the preview, so the dialog may have listed files that end up skipped.

### Compacting a conversation

**Compact Conversation** (in the context ring's popover in the chat header), or typing `/compact` in the message box, sends the SDK's own `/compact` command. The SDK summarises the conversation and starts the session again from that summary, so the next turns really do use less context; the reply shows a "Context compacted" notice.

When you switch to a model with a smaller context window and the conversation would fill more of it than the auto-compact threshold in settings, the page runs the same `/compact` first, then switches. The notice after the switch says whether compaction ran or failed.

Before this change both sent an ordinary message asking the model for a summary. The session then carried that summary on top of the full history, so the context grew instead of shrinking, and the notice claimed a compaction that had not happened.

## Roles and permissions

AgentStudio has a single owner. Every action here is limited to the signed-in owner's own
conversations:

- Pinning, archiving, renaming and deleting refuse a conversation that is not theirs.
- Search only ever returns their own conversations.
- An export link for a conversation that is not theirs answers "not found" — the same as a
  conversation that does not exist, so a link reveals nothing about whether it is real.
- Without a session, none of this is reachable: the pages redirect to sign-in, and the
  export download is refused.

| Action | Who can do it |
| --- | --- |
| Edit or regenerate a message | The conversation's owner |
| Preview or restore files | The conversation's owner, for a message in their own conversation, in a working directory inside their own sandbox |
| Restore over uncommitted changes in an imported repository | The owner, after ticking the explicit overwrite box; the server checks it again |

## Business rules

### The conversation list, search and export

- **Archive is the default way to tidy the list; delete is the exception.** Keeping a
  conversation costs nothing on a single-owner server, and delete cannot be undone.
- **A conversation is in exactly one place**: pinned, in the normal list, or archived.
  Pinning an archived conversation unarchives it; archiving a pinned one unpins it.
- **Pinning and archiving never reorder the list.** The list is ordered by last activity, and
  putting a conversation away is not activity. Unarchiving returns it to where it was. The
  one exception is the Pinned group, which is ordered by when each conversation was pinned.
  Choosing **Sort by Name** or **Project** applies inside the Pinned group too.
- **The home page's "Recent chats"** (shown on a phone, where the sidebar is hidden) are the
  five most recently active conversations, pinned or not. Pins do not push newer
  conversations off that short list.
- **Only the owner's own message brings an archived conversation back.** Automations and
  monitors that post into a conversation (a scheduled report, for example) do not — a chat
  archived on purpose should not reappear every time a job writes to it.
- **The normal list** shows every pinned conversation plus the 50 most recently active
  others; the archive shows up to 200, most recently archived first. Search reaches
  everything.
- **Other open tabs follow along**: pinning, archiving, deleting or a new chat elsewhere
  refreshes the sidebar within a couple of seconds. A rename shows in other tabs the next
  time that conversation has activity or the page is reloaded.
- **Deleting stops a running turn first.** Otherwise the agent could carry on using tools
  for a conversation that no longer exists, with nothing left to stop it: the CLI session,
  the commands it had put in the background (a dev server, a long build), and the subagents
  it had delegated to all end with the turn. A delete waits at most ten seconds for the
  stopped turn to finish, then goes ahead regardless. A turn run by an automation in the
  background jobs worker cannot be reached this way (the same is true of Stop); it is short,
  and its writes simply fail once the conversation is gone. An archived conversation is
  deleted the same way.
- **What delete removes and what it keeps.** Deleting a conversation removes its messages,
  its run history (the turns, their events, approvals and evaluations) and its search index.
  The memories mined from it stay in the memory palace but lose their link back to the
  conversation. Cost records stay, so spending totals do not change; they lose their link to
  the run. The SDK's own transcript and file backups on disk are not deleted yet (see the
  follow-up at the end).
- **Search is kept up to date in the background.** A message is indexed right after it is
  saved or edited; indexing never delays or fails a message. Anything missed — history from
  before search existed, or a message whose indexing failed — is indexed when the server
  next starts. When the rules for what is indexed change, the server rebuilds the index the
  same way. A message deleted while this catch-up is running is simply skipped; it does not
  stop the rest from being indexed. Replies an edit or regenerate drops take their search
  entries with them.
- **The search extract is shown as plain text.** Highlighting is added by the app itself, so
  nothing in a message (for example, text that looks like HTML) can change how the page
  behaves.
- **Export files are never cached** by the browser or anything in between, and are always
  offered as a download rather than opened in the page.

### Editing, regenerating and restoring files

**What the model sees after an edit or regenerate.** The page no longer sends the word "regenerate" as a prompt; the server answers the edited or regenerated message itself, using its stored text and attachments. How the SDK session is started:

| Situation | What happens |
| --- | --- |
| A new message | The session is resumed as it is. |
| A new message sent after an edit or regenerate whose reply never started | Treated like the edit: the session is cut back to the reply before the edited message. Any of your messages after that reply that never got an answer (the edited one, for example) are put in front of the new message as text, because the cut session never saw them. |
| Edit or regenerate, and the reply before it recorded where it ended | The session is resumed and cut right after that reply. Same session id. |
| Edit or regenerate of the first message | A fresh session; there is nothing before it to keep. |
| The reply before it predates this feature, belongs to an earlier session, or has no record of where it ended (a reply the page saved itself after a dropped connection) | A fresh session, primed with the kept conversation as text (up to about 24,000 characters, most recent first). Tool calls are not in that text. |
| The SDK refuses the cut (for example, it is from before a compaction) | Detected before the model is called; the turn runs once more on a fresh session primed as above. A turn that already produced anything is never re-run. |
| A slash command such as `/compact` sent while a cut is pending | The session is still cut, but nothing is put in front of the command, because the SDK only recognises a command at the very start of the message. Unanswered messages before it stay on the page but are not in the model's context. |

**When files are checkpointed.** Only when the run's working directory outlives the turn: a conversation in a project (any repository kind, including none), or an agent with a persistent workspace. A chat with no project gets a new, throwaway directory every turn, so there is never anything to go back to; the same goes for per-run worktrees.

**Restore guards,** all checked again on the server when you confirm, not taken from the preview:

- the message is yours, and its checkpoint belongs to the conversation's current SDK session;
- the working directory it recorded is inside your sandbox and still exists;
- no reply is being written in the conversation, and no other restore is running in it (a new message is refused while one is);
- every file the restore would touch is inside that working directory — if any is not, nothing is restored;
- the dry run is repeated just before the real restore, so the decision is made on what is on disk now;
- for an imported repository, uncommitted changes in any of the files need the explicit overwrite.

**Limits.**

- Changes made by shell commands, by AgentStudio's own tools (knowledge uploads, attachments), and by anything outside the agent's file tools are not checkpointed and are not restored.
- The Claude CLI removes old session files after 30 days by default; older messages then have no backup and the dialog says so.
- Compacting a conversation removes the backups for messages before the compaction.
- A restore overwrites the files as they are now. Git can show you which files have uncommitted changes, but not who made them.

## Integrations

- **PostgreSQL full-text search** (English) powers search: the index table holds the
  searchable text and a pre-parsed form of it, with an index that makes lookups fast.
- Export reads the conversation as AgentStudio stored it — the same record the chat screen
  shows — not the Claude Agent SDK's own session files.

**Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk` 0.3.278). What each piece of editing, regenerating and restoring relies on, and how it was verified rather than assumed:

| Behaviour | How it was checked |
| --- | --- |
| A message sent with our own id keeps that id in the transcript, and file checkpoints are keyed by it | Ran the bundled CLI against a stand-in Messages API: the transcript's user entries and `file-history-snapshot` entries carried exactly the ids we sent. |
| `enableFileCheckpointing` backs up files the Write tool changes, and `rewindFiles(id, { dryRun: true })` lists them (absolute paths) with line counts, without touching them | Same run: a file created in turn 2 was listed by a dry run to turn 2, and both turns' files by a dry run to turn 1. |
| `resume` + `resumeSessionAt` keeps the same session id and drops everything after the cut from what the model is sent | Same run: the model received turn 1 and the edited text, and nothing from turn 2. |
| After such a cut, the dropped message's checkpoint is gone and the kept ones still work | Same run. This is why files are restored *before* the new reply, never after. |
| A session with no prompt answers `rewindFiles` from the history it loads at start-up, with no model call | Automated: `tests/engine.rewind.spec.ts` runs the real CLI against a synthetic session on disk. |
| `/compact` sent as a plain-text message runs the SDK's compaction; the summary it writes after the boundary is a valid place to cut an edit | Stand-in API run: a `compact_boundary` came back, the next turn sent only the summary, and an edit cut after the summary kept it. |
| After a compaction, messages from before it have no checkpoint ("No file checkpoint found"), and a cut before it is refused ("No message found with message.uuid") before any model call | Stand-in API run. The refusal is recognised and the turn falls back to a fresh session. |
| `forkSession` copies no file history | The SDK's own documentation of `forkSession()`. Edits therefore never fork. |
| An interrupt with no `perTaskStopAffordance` declared also kills the session's background tasks | The SDK's own documentation (`sdk.d.ts`). This is how deleting a conversation stops the commands its turn left running. |

**Git.** For a project with a repository, the restore preview runs `git status` in the project's checkout to mark files with uncommitted changes. A restore never runs git: it rewrites file contents only, so it cannot remove a commit. A commit the agent made after the checkpoint stays in history (and on the remote if it was pushed), and the restored files then show as uncommitted changes.

## Where it lives

| Piece | Location |
| --- | --- |
| Pin, archive and unarchive-on-reply rules | `src/lib/chat/conversation-lifecycle.server.ts` |
| Delete, stopping a running turn first | `src/lib/chat/conversation-delete.server.ts` |
| The normal and archived lists | `src/lib/chat/conversation-list.server.ts` |
| The sidebar's order and grouping (pinned by pin time, archive by archive time) | `src/lib/chat/conversation-order.ts` |
| What a message is indexed by | `src/lib/chat/message-search-text.ts` |
| Turning a typed search into a query; highlight markers | `src/lib/chat/conversation-search.ts` |
| The index writer, boot backfill and search | `src/lib/chat/message-search.server.ts`, `message-search-sql.ts` |
| Export formats | `src/lib/chat/conversation-export.ts` |
| Export download | `GET /chat/[id]/export?format=md` or `?format=json` |
| Sidebar menu | `src/lib/chat-console/ConversationRowMenu.svelte` |
| Turn planning: text, attachments and how the session starts | `src/lib/chat/turn-plan.ts`, `src/lib/chat/turn-plan.server.ts` |
| The prompt's own id, the transcript tail, the refused-cut fallback | `src/lib/engine/turn-input.ts` |
| Edit and regenerate on the rows, the pending-cut mark, and re-indexing an edited message | `src/lib/chat/message-branch.server.ts` |
| The `/compact` prompt and the model-switch notice | `src/lib/chat/compact-command.ts` |
| Restore preview and restore, with the guards | `src/lib/chat/rewind.server.ts`, `src/lib/chat/rewind-plan.ts`, `src/lib/chat/rewind-preview.ts` |
| The short-lived SDK session a restore runs in | `src/lib/engine/rewind.server.ts` |
| The restore dialog | `src/lib/chat/RewindPreviewDialog.svelte`, `src/lib/chat/rewind-dialog.svelte.ts` |
| Data | `conversations.pinned_at`, `conversations.archived_at`, and the `message_search` table (migration `0079`); the transcript join lives on `messages.metadata` |

Follow-up, not done here: deleting a conversation does not yet delete its SDK transcript or file backups.
