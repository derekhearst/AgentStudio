# Chat

## Overview

Chat is where you talk to an agent. Each conversation is a list of messages in AgentStudio's database, and behind it sits a Claude Agent SDK session: the SDK's own record of the conversation, which is what the model actually reads on every turn. The full feature spec (composer, attachments, tool cards, approvals, the right rail and so on) is [spec.md](spec.md). This page covers the parts of chat that change a conversation after the fact:

- **Edit** a message you sent, and get a new reply to the edited text.
- **Regenerate** the last reply.
- **Also restore files**: when you edit or regenerate, put the files the dropped replies changed back the way they were (#24).
- **Compact** a long conversation so it takes less of the model's context.

## Key concepts

| Concept | What it means |
| --- | --- |
| Message row | One message in the `messages` table: your text, or the agent's reply. What the page shows. |
| SDK session | The Claude Agent SDK's transcript of the conversation (`conversations.sdk_session_id`). What the model sees. Each turn resumes it. |
| Transcript join | Where a message row sits in the SDK transcript, recorded on the row's `metadata` (see below). How an edit knows where to cut, and how a restore knows which checkpoint to go back to. |
| File checkpoint | A backup the SDK takes of a file just before the agent's file tools (Write, Edit, MultiEdit, NotebookEdit) change it, keyed by the message that started the turn. |
| Restore | Putting files back to how they were at one of your messages, from those backups. Files the agent created after that point are deleted. |

### The transcript join

No schema change: three keys on `messages.metadata`.

| Row | Key | What it holds |
| --- | --- | --- |
| Your message | `sdkTurn` | The id the message carried into the SDK transcript, the SDK session it went into, the working directory the run used, and whether files were checkpointed on that turn. |
| The agent's reply | `sdkTailUuid` | The last transcript entry that turn wrote — the point an edit of the *next* message cuts back to. |
| Your message | `sdkCutPending` | Set when an edit or regenerate cuts the conversation back to this message. It means the SDK session still holds the replies that were dropped. It is cleared as soon as a new turn starts on a session that has been cut to match (or on a fresh one). |

AgentStudio chooses the id each message carries into the transcript, rather than letting the SDK make one up, so it knows it in advance. Messages from before this change have no join; they still work, as described under business rules.

## User flows

### Editing a message

1. You click the pencil on one of your messages, change the text, and click **Save & regenerate**. (The pencil is hidden while a reply is being written.)
2. If the dropped replies changed files that can be restored, the **restore dialog** opens (below). Otherwise the edit goes straight on.
3. If you chose to restore files, the files are restored first. If that fails, nothing else happens: the conversation is left exactly as it was and the error says so, so you can try again or go on without restoring.
4. Your message is updated and everything after it is deleted.
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

**Compact Conversation** (in the context panel) sends the SDK's own `/compact` command. The SDK summarises the conversation and starts the session again from that summary, so the next turns really do use less context; the reply shows a "Context compacted" notice.

When you switch to a model with a smaller context window and the conversation would fill more of it than the auto-compact threshold in settings, the page runs the same `/compact` first, then switches. The notice after the switch says whether compaction ran or failed.

Before this change both sent an ordinary message asking the model for a summary. The session then carried that summary on top of the full history, so the context grew instead of shrinking, and the notice claimed a compaction that had not happened.

## Roles & permissions

| Action | Who can do it |
| --- | --- |
| Edit or regenerate a message | The conversation's owner |
| Preview or restore files | The conversation's owner, for a message in their own conversation, in a working directory inside their own sandbox |
| Restore over uncommitted changes in an imported repository | The owner, after ticking the explicit overwrite box; the server checks it again |

## Integrations

**Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk` 0.3.278). What each piece relies on, and how it was verified rather than assumed:

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

**Git.** For a project with a repository, the restore preview runs `git status` in the project's checkout to mark files with uncommitted changes. A restore never runs git: it rewrites file contents only, so it cannot remove a commit. A commit the agent made after the checkpoint stays in history (and on the remote if it was pushed), and the restored files then show as uncommitted changes.

## Business rules

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

## Where it lives

| Piece | File |
| --- | --- |
| Turn planning: text, attachments and how the session starts | `src/lib/chat/turn-plan.ts`, `src/lib/chat/turn-plan.server.ts` |
| The prompt's own id, the transcript tail, the refused-cut fallback | `src/lib/engine/turn-input.ts` |
| Edit and regenerate on the rows, and the pending-cut mark | `src/lib/chat/message-branch.server.ts` |
| The `/compact` prompt and the model-switch notice | `src/lib/chat/compact-command.ts` |
| Restore preview and restore, with the guards | `src/lib/chat/rewind.server.ts`, `src/lib/chat/rewind-plan.ts`, `src/lib/chat/rewind-preview.ts` |
| The short-lived SDK session a restore runs in | `src/lib/engine/rewind.server.ts` |
| The dialog | `src/lib/chat/RewindPreviewDialog.svelte`, `src/lib/chat/rewind-dialog.svelte.ts` |

Follow-up, not done here: deleting a conversation does not yet delete its SDK transcript or file backups.
