# Claude Desktop parity audit

Snapshot: 2026-09-21, against AgentStudio at `c793c53` (post artifacts + Azure removal).

Claude Desktop is two products in one window: the **chat** tab (claude.ai) and the **Code** tab (Claude Code sessions). AgentStudio competes with both — it is a custom UI over the same Claude Agent SDK that powers Code, with a chat workbench on top. This audit walks both sides feature by feature and marks each one.

Legend: **have** · **partial** — exists but materially thinner · **gap** — nothing equivalent · **n/a** — deliberately not wanted here.

---

## Chat tab

| Feature | AgentStudio | Notes |
| --- | --- | --- |
| Streaming replies with token-level deltas | have | SSE with `delta` frames and typing interpolation |
| Extended thinking, summarized | have | `thinking: adaptive`, effort picker in the composer |
| Model picker per conversation | have | Claude ids direct; others need the gateway (#9) |
| Web search | have | `web_search` tool |
| Web fetch / page reading | have | `web_fetch`, `pdf_read` |
| Code execution | have | `run_code` (Bun sandbox), `shell` |
| Image generation | have | `image_generate`; video too, which Claude has no equivalent for |
| File attachments | have | upload endpoint + composer attachments |
| Voice dictation | have | record → `/api/transcribe` |
| Text-to-speech playback | partial | `/api/tts` exists but nothing in the UI calls it |
| Deep research with citations | have | `/research`, approval-gated plan → background run |
| Memory across conversations | have | Memory Palace, richer than Claude's |
| Skills | have | full CRUD at `/skills`, plus skill hooks |
| Artifacts / side-panel documents | n/a | removed on purpose (#13); files on disk instead |
| Projects with instructions + knowledge | partial | projects are repos; no per-project instruction block or uploaded knowledge base |
| Connect external MCP servers | gap | AgentStudio *serves* MCP at `/api/mcp` but cannot consume one |
| Conversation rename | have | `updateConversationMeta` |
| Conversation pin / archive / folders | gap | delete is the only lifecycle action |
| Search across all conversations | partial | client-side filter over loaded titles + last message only |
| Share or export a conversation | gap | no export path at all |
| Incognito / temporary chat | gap | every conversation is mined into memory |
| Writing styles / output styles | gap | agent system prompts are the only lever |
| Usage and cost surfaced in chat | partial | HUD shows context %; spend lives in `/activity` and budget settings |
| Scheduled / recurring runs | have | `/automations` with cron, ahead of Claude here |
| Push notifications on completion | have | web push + in-app |

## Code tab

| Feature | AgentStudio | Notes |
| --- | --- | --- |
| Agent SDK session loop | have | `$lib/engine`, resume via stored session id |
| Session list, live run dock | have | sidebar recents + `RunningSessionsDock` |
| Per-tool approval gates | have | `canUseTool` + per-user approval settings |
| Permission modes (plan / acceptEdits / bypass) | gap | only `default`; the Plan agent approximates plan mode via a different mechanism |
| Plan → implement handoff | have | `request_plan_approval` flips the bound agent |
| Subagents | partial | in-house `run_subagent`; SDK-native subagents pending (#5) |
| Built-in filesystem + shell tools | partial | in-house registry *and* the SDK's built-ins are both live; transcripts show `ToolSearch` next to `web_search` |
| Diff view for edits | gap | tool results render as raw JSON in a card |
| Todo list rendering | gap | nothing consumes `TodoWrite` |
| Checkpoints / rewind | partial | edit-message + `deleteMessagesAfter` rewinds the transcript, not the filesystem |
| Terminal panel | gap | `shell` output only appears inside a tool card |
| Git worktrees / branch per session | gap | one working directory per project |
| Repo import + clone | have | `/projects` import flow (GitHub or clone URL) |
| Commit / push / open PR | have | `prepare_commit`, `push_branch`, `create_pull_request`, all approval-gated |
| CI status + auto-fix after a PR | gap | PR lands in `/review`, then nothing watches it |
| Hooks | have | `/settings/hooks`, bus + builtins |
| Slash commands | gap | no command palette in the composer |
| `@`-file mentions | gap | paths are typed by hand |
| Context auto-compaction | have | threshold-based, plus manual compact |
| Cost / token accounting per run | have | `/activity`, `/runs/[id]`, budget gates |
| Session transcript export | gap | no export |
| Remote control / hand off to another device | n/a | single-user self-hosted; the web UI is already reachable anywhere |
| Background tasks | have | durable job queue + automations |

---

## What actually matters

Ranked by what a single self-hosted operator would feel first:

1. **Two tool surfaces at once** (#15). The SDK's built-ins and the in-house registry are both exposed. Pick one.
2. **No diff view** (#16). The most-used thing Claude Code renders is the one thing a code session here cannot show.
3. **No external MCP** (#17). Every integration has to be written into the tool registry by hand.
4. **Conversation management** (#18). No pin, archive, export, or real search once the list gets long.
5. **Per-session permission mode** (#19). Per-tool settings are global; a session cannot be "just plan" or "just go".
6. **CI after the PR** (#20). The agent can open a pull request and then loses interest in it.

The rest: #21 todo list, #22 slash commands + `@`-mentions, #23 project instructions + knowledge, #24 filesystem checkpoints, #25 temporary chats, #26 shell output as a terminal, #27 the unused TTS endpoint. #28 tracks them all.
