# Chat Console

## Overview

The chat console is the shell around a conversation: the left sidebar (navigation and
recent chats), the centre thread, and the right rail. It is what the user actually looks
at all day, so the rail's job is to hold whatever is worth keeping in view *next to* the
conversation rather than scrolled away inside it: a file or page to look at, and the files
the agent changed. When there is nothing to show it stays out of the way as a thin strip.

Audience: anyone touching the chat screen. Code lives in `src/lib/chat-console/`.

## The sidebar's recent chats

The sidebar stays on screen for the whole visit, so its list of recent chats has to keep
itself current. It does: a new chat appears when it is created, its generated title
replaces "New conversation" once it is written, and the order follows the latest activity.
The sidebar already keeps a live connection open to show which chats are running; that
connection also reports, at most every couple of seconds, when the list has changed, and
the list is then reloaded. So a chat started in another tab, on another device or by an
automation shows up too. The recent list on the new-chat page follows the same signal.
If the server cannot check the list for a moment (for example while the database
reconnects), the sidebar keeps the list it has and the running-chat indicators carry on;
the check is simply tried again a couple of seconds later.

Opening another chat from the sidebar gives that chat a fresh page. Nothing the previous
chat was doing (a reply streaming in, its tool cards, its Stop button, an error and its
Retry) carries over. See "Switching conversations mid-turn" in the chat spec.

## The right rail

The rail sits to the right of a conversation. It only appears on a chat: the home page
has no conversation, so it has no rail.

It has two tabs.

| Tab | What it shows |
| --- | --- |
| **Preview** | A file or a web page, opened on demand. |
| **Files** | Every file the agent changed in this chat. Click one to open it in Preview. |

### Collapsed until it is needed

On a desktop or tablet screen the rail starts **folded to a thin strip** at the right edge,
so the conversation gets the width. The strip has three buttons: expand, Preview and Files.
The Preview button shows a dot when something is open, and the Files button shows how many
files have changed.

The rail expands when:

- something opens a preview: "Open file" on an edit card, the preview chip on a tool call,
  or a row in Files;
- you click one of the strip's buttons;
- you left it expanded last time.

It folds back to the strip when you click the collapse button at the end of its tab bar,
or when you close the preview (with nothing open there is nothing to show).

Whether the rail is expanded is **remembered for you, across all your chats and devices**.
It is saved with your workbench preferences, not with the chat, so opening a new chat keeps
the rail the way you left it.

Each browser also keeps its own copy of that choice, so when you reload a chat the rail
appears the way you left it straight away, instead of starting as the strip and then
jumping open a moment later. Your saved preference still has the last word: if you folded
the rail on another device, it folds here too as soon as the preference loads.

On a tablet, the rail button in the chat's header expands or folds the rail. Its name
changes to say which it will do next ("Expand chat rail" or "Collapse chat rail"), and
screen readers are told whether the rail is open.

When you expand or fold the rail from the keyboard, focus stays in the rail. The button you
pressed is replaced, so focus moves to the one that took its place: the tab you asked for,
the collapse button, or the strip's expand button. Opening a file from Files puts focus on
the Preview tab, and closing the preview puts it back on the rail.

### On a phone

On a phone the rail is not beside the conversation. The rail button in the chat's header
opens it as a drawer from the right, with the same two tabs. The drawer is opened and closed
by hand, so it always shows the full rail and has no collapse button.

Nothing you do on a phone changes the expanded-or-folded preference. Switching tabs in the
drawer, opening a file from an edit card or from Files, and closing the preview all leave
it alone, so your desktop rail stays the way you left it there.

### Files: changed in this chat

Files lists what the agent actually edited or created in this conversation. It is built
from the edit cards already in the thread, so it needs no source control and works in any
workspace, including the many that are not git repositories.

| Column | Meaning |
| --- | --- |
| Name, then folder | The file, with its folder dimmed beside it. Hover for the full path. |
| **new** | The file was created in this chat. |
| +N / −N | Lines added and removed, added up over every edit to the file in this chat. A zero count is left out. |

The most recently changed file is at the top. Edits made while a reply is still streaming
appear as they happen. An edit that failed or was refused is not listed, and neither is a
write that left the file exactly as it was. Edits made inside a sub-agent are not listed.

A file the agent **created** is always listed and marked **new**, with every line it wrote
counted as added — even an empty file, which is still a change. Its card in the thread
shows what was written, as added lines, instead of saying nothing changed. A very large
new file shows only its beginning on the card, with a note that the rest was cut. In chats
from before this was fixed, a created file is still listed as new, but without a line
count, and its card asks you to open the file to see it.

### Where everything else went

The rail used to have four tabs and a stats strip. Issue #14 removed what was empty most of
the time or repeated what is shown elsewhere:

| Was | Now |
| --- | --- |
| **Research** tab (research runs started from this chat) | The research run's own page. Its Back button and breadcrumb lead to the chat it came from. |
| **Activity** tab (tool calls in this turn and earlier ones) | The run's own page, `/runs/<id>`, which has every tool call and event. Open it from **Run → Timeline** in a reply's stats popover, or by clicking the **running** chip at the top of the chat while a turn runs. |
| Stats strip: context and cost | The top of the chat on every screen size: the context ring (hover for the breakdown and a Compact button) and the metered cost, when there is any. On a desktop both sit in the bar above the thread. On a tablet or phone the ring is in the chat's header, and the cost is beside it on a tablet and in the row of chips under the header on a phone. |
| Stats strip: tokens and latency | Per reply, in the reply's stats popover. |
| Files placeholder ("main · clean", Switch, Pull) | The real Files tab above. |

## Preview

### What it can show

| Type | Rendering |
| --- | --- |
| Markdown (`.md`, `.markdown`, `.mdx`) | Rendered, with headings, tables, links and highlighted code fences |
| Code and config | Syntax highlighted, with line numbers. ~25 languages, loaded on demand |
| Plain text, logs, CSV | Monospaced with line numbers |
| Images (png, jpg, gif, webp, avif, bmp, ico) | Inline |
| PDF | Paged in the browser's own PDF viewer |
| A directory | A clickable listing; click an entry to open it |
| A web page | An iframe, with the full URL shown above it |

Preview is **read-only**. Editing is the agent's job — there is no save button.

SVG files are shown as source rather than rendered, and any other binary file is refused
with a note rather than dumped as garbage. Text files over 512 KB show their first 512 KB
and say so.

### Opening something

Four ways:

1. **Type it.** The box at the top of the tab takes a file path (relative to the chat's
   workspace, or absolute inside it) or a full `https://` URL. A bare `localhost:5173`
   counts as a URL; anything else without a scheme is treated as a path, because
   `notes.md` and a domain name are otherwise indistinguishable.
2. **Click a tool call.** Expanding a tool call in the thread shows a preview chip for any
   file path in its arguments and any link it produced. An edit card has an "Open file"
   button.
3. **Click a row in Files.**
4. **Reopen the chat.** The rail restores whatever was last being looked at.

Any of the first three also expands a folded rail and switches it to Preview, even when
that file is already the one open.

### What is remembered, and where

| What | Remembered for | Stored in |
| --- | --- | --- |
| The active tab and the open file or URL | Each conversation separately | `chat_rail_preview`, one row per conversation, owned by its user |
| Expanded or folded | You, across every chat | `chat_workbench_preferences.panel_layout.railOpen` (absent means folded), with a copy in the browser's local storage so a reload shows it at once; only changes made on a desktop or tablet screen are saved |
| The rail's width | This browser | The browser's local storage |

Closing a chat and coming back later puts the same file or page back in Preview. If the rail
is folded, the Preview button on the strip shows a dot so you can tell something is open.
A conversation stored with a tab that no longer exists (Research or Activity, from
before issue #14) opens on Preview.

Opening another chat clears the rail at once and then loads that chat's own selection, so
the previous chat's file never shows under the new one, even when you switch quickly.

## Roles and permissions

Single-user application. Every preview read is scoped to the signed-in user: a request for
a conversation that is not theirs is refused, and file paths are resolved inside that
user's own sandbox tree. The expanded/folded preference takes no conversation at all: a
user can only read and change their own.

## Business rules and safety

These are the constraints that matter, and why:

- **A preview can only read the chat's workspace.** The preview endpoint rebuilds the same
  sandbox workspace the agent's file tools use (persistent key, git worktree, project, or
  the conversation's latest run, in that order) and validates every path against
  `<sandbox>/<user id>`. A path that resolves outside it is refused. There is no way to
  ask the preview for an arbitrary file on the server.
- **Symbolic links are followed before the check, not after.** A link inside the
  workspace can point anywhere on the server (the agent's shell can make one, and an
  imported repo can contain one). The preview judges where a path really leads, so a
  link to `/`, to the server's environment file, or to another user's folder is refused
  like any other outside path. Folder listings leave links out.
- **A path is re-checked every time.** A stored selection is validated on read exactly like
  a freshly typed one, so an old or hand-edited row cannot widen access.
- **Only images and PDFs are served as raw bytes.** HTML and SVG from the workspace are
  never served as documents from the app's own origin — an agent-written page served that
  way could run scripts as the app. They are shown as source instead.
- **A URL found in a tool result is never loaded on its own.** Tool output is influenced by
  whatever the agent read, including web pages. Such a URL appears as a proposal that
  shows the address and waits for a click. Only a URL the user typed loads directly.
- **The URL is always visible** above the frame, so it is never ambiguous what is loaded.
- **Framed pages are sandboxed.** Scripts and forms are allowed; a page on the app's own
  origin additionally loses `allow-same-origin` so it cannot script the app.
- **Previewed markdown is sanitized.** Raw HTML in the file is escaped rather than
  executed, and links and images that are not `http(s)` are dropped. That includes text
  that follows an inline `<code>`, `<kbd>` or `<pre>` tag, which the markdown library
  would otherwise pass through untouched. A start-up self-check runs a set of hostile
  samples through the renderer; if any gets through, markdown falls back to plain source.
  The chat transcript uses the same rules (see the chat spec).

## Integrations

- `src/lib/workspace/workspace.server.ts` — workspace resolution and path containment.
- `src/lib/tools/sandbox.server.ts` — the same workspace the agent's file tools use.
- `/api/preview/raw` — image and PDF bytes for the rail.
- `src/lib/engine/tool-result-details.ts` — the `file_edit` details (path, change type,
  +/- counts) that the Files tab adds up.
- `/runs/<id>` — a run's full event timeline, which replaced the Activity tab.
