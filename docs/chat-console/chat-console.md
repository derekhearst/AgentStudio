# Chat Console

## Overview

The chat console is the shell around a conversation: the left sidebar (navigation and
recent chats), the centre thread, and the right rail. It is what the user actually looks
at all day, so the rail's job is to hold whatever is worth keeping in view *next to* the
conversation rather than scrolled away inside it.

Audience: anyone touching the chat screen. Code lives in `src/lib/chat-console/`.

## The right rail

The rail has four tabs.

| Tab | What it shows |
| --- | --- |
| **Preview** | A file or a web page, opened on demand. The default tab. |
| Research | Research runs started from this conversation, with live progress. |
| Files | Source-control state for the conversation's workspace. |
| Activity | Tool calls in the current turn, then recent earlier ones. |

Below the tabs sits a permanent strip with context usage, token count, cost and latency.

Preview is the default because the rail used to open on a tab that said "No research runs
for this chat yet" nearly every time. Preview's empty state is an input box, so the panel
is useful even when nothing is running.

Preview was added as a fourth tab rather than replacing Files: Files is a placeholder for
source-control integration, which is a separate piece of work, and "what changed in the
repo" is a different question from "show me this thing".

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

Three ways:

1. **Type it.** The box at the top of the tab takes a file path (relative to the chat's
   workspace, or absolute inside it) or a full `https://` URL. A bare `localhost:5173`
   counts as a URL; anything else without a scheme is treated as a path, because
   `notes.md` and a domain name are otherwise indistinguishable.
2. **Click a tool call.** Expanding a tool call in the thread shows a preview chip for any
   file path in its arguments and any link it produced.
3. **Reopen the chat.** The rail restores whatever was last being looked at.

### Rail state follows the conversation

The active tab and the open file or URL are stored per conversation in
`chat_rail_preview`, keyed by conversation id and owned by a user. Closing a chat and
coming back later puts the same thing back on screen. Nothing is remembered across
conversations — each chat has its own.

## Roles and permissions

Single-user application. Every preview read is scoped to the signed-in user: a request for
a conversation that is not theirs is refused, and file paths are resolved inside that
user's own sandbox tree.

## Business rules and safety

These are the constraints that matter, and why:

- **A preview can only read the chat's workspace.** The preview endpoint rebuilds the same
  sandbox workspace the agent's file tools use (persistent key, git worktree, project, or
  the conversation's latest run, in that order) and validates every path against
  `<sandbox>/<user id>`. A path that resolves outside it is refused. There is no way to
  ask the preview for an arbitrary file on the server.
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
  executed, and links and images that are not `http(s)` are dropped. A start-up self-check
  proves the sanitizer is active; if it ever is not, markdown falls back to plain source.

## Integrations

- `src/lib/workspace/workspace.server.ts` — workspace resolution and path containment.
- `src/lib/tools/sandbox.server.ts` — the same workspace the agent's file tools use.
- `/api/preview/raw` — image and PDF bytes for the rail.
