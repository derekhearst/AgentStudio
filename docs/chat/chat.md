# Chat

## Overview

Chat is where the owner works with AgentStudio's agents. A **conversation** is one thread: a
title, the agent it is bound to, and an ordered history of messages. Each message the user
sends starts a **turn**, in which the agent answers and may use tools — read and edit files,
run commands, search the web, hand work to a subagent. Everything the turn did is kept on the
reply, so a conversation can be reread, searched and exported later.

This document covers what a conversation is and how the owner looks after the list of them:
pinning, archiving, renaming, deleting, searching and exporting. The live chat screen (the
composer, streaming, approvals, the right rail) is described in
[chat-console](../chat-console/chat-console.md) and, in older and partly out-of-date form, in
[spec.md](spec.md).

Audience: the owner, and anyone working on the chat code (`src/lib/chat/`).

## Key concepts

| Concept | What it is |
| --- | --- |
| **Conversation** | One chat thread. Has a title, an agent, a model, token and cost totals, and a *last activity* time that orders the list. |
| **Message** | One entry in a conversation: from the user, the assistant, or the system (a note such as "the conversation switched agents here"). An assistant message carries the **blocks** of its turn: text, thinking, tool calls with their arguments and results, subagent work and run notices. |
| **Pinned** | A conversation kept at the top of the sidebar. The pin records *when* it was pinned. |
| **Archived** | A conversation put away: hidden from the normal list, but kept whole. The archive records *when* it was archived. |
| **Search index** | For every message, the text it can be found by — see "Search" below. Kept in its own table beside the messages. |

## User flows

All of these start from the **"⋯" button on a conversation in the sidebar** (on a phone, in
the navigation drawer). On a computer the button, and a one-click **Archive** button, appear
when the pointer is over the row; on a touch screen the "⋯" button is always there. The menu
opens just below the row.

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
   as the **Stop** button would stop it, and the delete waits up to ten seconds for it to
   finish saving what it had done. Then the conversation is deleted.
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

- the text of every message, the owner's and the assistant's;
- attachment file names;
- **the work each turn did**: for every tool call, the tool's name, the file paths it read or
  changed, the commands it ran and their descriptions, short arguments (titles, names,
  queries), and web links it printed — so "the run where it touched `options.server.ts`" or
  "the one where it opened that pull request" can be found even though neither was ever said
  in words;
- what a subagent was asked to do and the start of its answer;
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
| **Markdown** | Reading, pasting into notes or an issue, handing to another model | A header (dates, agent, model, tokens, cost), then each message in order. Edits appear as diffs, commands with their output, checklists as checklists, subagent work as quotes, the model's thinking folded away. Very long tool output is shortened, with a note pointing to the JSON export. |
| **JSON** | Keeping a complete copy, or reading it with a program | Everything, unshortened: the conversation's details and every message with all of its blocks, tool arguments and results. The owner's account id is left out. |

## Roles and permissions

AgentStudio has a single owner. Every action here is limited to the signed-in owner's own
conversations:

- Pinning, archiving, renaming and deleting refuse a conversation that is not theirs.
- Search only ever returns their own conversations.
- An export link for a conversation that is not theirs answers "not found" — the same as a
  conversation that does not exist, so a link reveals nothing about whether it is real.
- Without a session, none of this is reachable: the pages redirect to sign-in, and the
  export download is refused.

## Business rules

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
  for a conversation that no longer exists, with nothing left to stop it. A delete waits at
  most ten seconds for the stopped turn to finish, then goes ahead regardless. A turn run by
  an automation in the background jobs worker cannot be reached this way (the same is true of
  Stop); it is short, and its writes simply fail once the conversation is gone.
- **What delete removes and what it keeps.** Deleting a conversation removes its messages,
  its run history (the turns, their events, approvals and evaluations) and its search index.
  The memories mined from it stay in the memory palace but lose their link back to the
  conversation. Cost records stay, so spending totals do not change; they lose their link to
  the run.
- **Search is kept up to date in the background.** A message is indexed right after it is
  saved; indexing never delays or fails a message. Anything missed — history from before
  search existed, or a message whose indexing failed — is indexed when the server next
  starts. When the rules for what is indexed change, the server rebuilds the index the same
  way. A message deleted while this catch-up is running is simply skipped; it does not stop
  the rest from being indexed.
- **The search extract is shown as plain text.** Highlighting is added by the app itself, so
  nothing in a message (for example, text that looks like HTML) can change how the page
  behaves.
- **Export files are never cached** by the browser or anything in between, and are always
  offered as a download rather than opened in the page.

## Integrations

- **PostgreSQL full-text search** (English) powers search: the index table holds the
  searchable text and a pre-parsed form of it, with an index that makes lookups fast.
- Export reads the conversation as AgentStudio stored it — the same record the chat screen
  shows — not the Claude Agent SDK's own session files.

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
| Data | `conversations.pinned_at`, `conversations.archived_at`, and the `message_search` table (migration `0079`) |
