# AgentStudio vs Claude Desktop

Snapshot: 2026-09-21, AgentStudio at `a459c99`.

Claude Desktop is now three products in one window: **chat** (claude.ai), **Code** (Claude Code sessions), and **Cowork** — the agentic workspace for non-coding work, which is the one that competes most directly with what AgentStudio is for. AgentStudio is a custom UI over the same Claude Agent SDK that powers Code, with a chat workbench, a tool registry, a memory system and a cron scheduler on top.

This is a head-to-head: every row says who is actually better, not just who has the feature.

**Sources** (checked 2026-09-21, because my training data stops in May 2026 and both products moved a lot since): the [claude-code CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md), the [Claude apps release notes](https://support.claude.com/en/articles/12138966-release-notes), [checkpointing docs](https://docs.claude.com/en/docs/claude-code/checkpointing), and [Enabling Claude Code to work more autonomously](https://www.anthropic.com/news/enabling-claude-code-to-work-more-autonomously).

**Verdict scale**, from our side:

| | |
| --- | --- |
| **win** | we do it better, and the difference is real |
| **even** | different shapes, same outcome |
| **behind** | they do it better, but ours works |
| **far behind** | ours is a stub, or the gap changes what you can do |
| **absent** | we have nothing |
| **n/a** | deliberately not competing |

---

## Agentic work — the part that matters most here

This is the Cowork comparison, and it is the one I got wrong in the first draft: I had us "ahead of Claude" on scheduling. Cowork has had scheduled recurring tasks since Feb 2026, and since July 2026 they run server-side with no device online.

| Feature | Verdict | Ours | Theirs |
| --- | --- | --- | --- |
| Recurring scheduled runs | **even** | `/automations` with cron, per-automation model + agent + budget, maintenance/research/chat-followup modes | Cowork scheduled + on-demand tasks |
| Runs with the laptop closed | **win** | the NAS *is* the always-on host; nothing depends on a local device | Cowork runs remotely in beta; earlier it needed the desktop VM |
| Durable job queue with leases and retries | **win** | real queue, heartbeats, cancellation, `/settings/jobs` | not exposed to the user |
| Budget enforcement | **win** | daily/monthly caps that actually block a run before it spends | plan limits, no per-workflow budget |
| Unattended failure surfacing | **win** | `/review` inbox with dedupe, plus web push | notifications only |
| Long-horizon monitoring | **absent** | nothing watches an external condition between runs | Monitor tool with deadlines |
| Multi-agent orchestration | **behind** | `run_subagent`, one level, no fan-out control | workflow scripts, concurrency limits, agent map, forked sessions |
| Delegate from a phone | **behind** | the web UI is responsive and push works | persistent agent thread on mobile, Cowork on web + mobile |

## Code

| Feature | Verdict | Ours | Theirs |
| --- | --- | --- | --- |
| Agent SDK session loop, resume | **even** | `$lib/engine`, session id persisted per conversation | same SDK |
| Streaming with thinking | **even** | `delta` + `reasoning` frames, adaptive thinking, effort picker | same |
| Tool approval | **behind** | per-tool global settings + mandatory-approval list | per-session modes, path-scoped deny rules, per-model effort caps, auto-mode classifier |
| Permission modes (plan / acceptEdits / bypass) | **absent** | hardcoded `default`; the Plan agent is a persona, not a mode | four modes, switchable mid-session |
| Diff rendering | **far behind** | raw JSON in a tool card | inline diffs with per-hunk accept/reject |
| Checkpoints and rewind | **far behind** | rewinds the transcript only; files stay written | auto-checkpoint per turn, Esc-Esc or `/rewind`, restore code / conversation / both |
| Todo list | **absent** | nothing consumes it | pinned, updated in place |
| Terminal / command output | **far behind** | JSON-escaped blob in a card, nothing streams | streamed terminal output |
| Git worktrees | **absent** | one working directory per project | worktree-per-agent with cleanup safety |
| Repo import and clone | **win** | first-class: import creates a project, clones into a sandbox, sidecar repo row | you point it at a directory |
| Commit / push / PR | **even** | approval-gated tools, PR recorded and surfaced in `/review` | same, plus richer GitHub triggers |
| Code review of a PR | **absent** | — | `/ultrareview`, merge-aware follow-up reviews |
| CI watch and fix | **absent** | PR is opened, then nothing looks at it again | cloud sessions react to CI |
| Hooks | **even** | `/settings/hooks`, event bus, skill hooks | same idea, dialog-managed |
| Sub-agent output isolation | **behind** | subagent text is inlined into the transcript | indented result so it cannot pass as instructions |
| Background tasks | **even** | job queue | background bash + completion notices |
| Session cost accounting | **win** | per-run rows, `/activity`, `/runs/[id]`, ledger per tool call | session cost in a dialog |

## Chat

| Feature | Verdict | Ours | Theirs |
| --- | --- | --- | --- |
| Streaming, thinking, model picker | **even** | | |
| Web search + fetch | **even** | `web_search`, `web_fetch`, `pdf_read` | same |
| Code execution | **even** | `run_code` in Bun, sandboxed, tools callable from inside the script | analysis tool / sandboxed Python |
| File attachments | **behind** | upload + attach, no per-type handling | images, PDFs, office docs, with extraction |
| Voice dictation | **even** | record → `/api/transcribe` | same |
| Text-to-speech | **far behind** | endpoint + setting exist, nothing calls them | shipped |
| Deep research | **even** | approval-gated plan, background run, cited report | same shape |
| Memory | **win** | Memory Palace: wing/room/closet/drawer, hybrid vector + tsvector + temporal recall, mining pipeline | categorized entries, Topics editor, sensitive-topics exclusion — better *managed*, thinner retrieval |
| Memory management UI | **behind** | `/memory` browser | Topics editor, per-item delete, sensitive-topic exclusion |
| Skills | **even** | full CRUD, skill hooks, agent identity skills | same, plus a marketplace |
| Plugins / marketplace | **absent** | — | plugin system, marketplace, admin controls, `claude plugin eval` |
| Connect external MCP servers | **absent** | we *serve* MCP at `/api/mcp`, we cannot consume one | first-class, OAuth, `/mcp`, managed policies |
| Connectors (Slack, M365, Salesforce…) | **absent** | — | write-capable connectors, Claude Tag for Slack |
| Computer use | **far behind** | `browser_screenshot` only | screen access, click, navigate (research preview) |
| Artifacts / side-panel documents | **n/a** | removed in #13 — files on disk and git instead | versioned, publishable, in-place draft editing |
| Preview a file or a website in a side panel | **absent** | the right rail shows research runs or nothing (#29) | artifact + document preview |
| Inline charts and visualizations | **absent** | markdown only | interactive charts, diagrams, Claude Design |
| Conversation rename | **even** | `updateConversationMeta` | same |
| Pin / archive / folders | **absent** | delete only | full |
| Search across conversations | **far behind** | client-side filter over loaded rows | server-side across all history |
| Export a conversation | **absent** | — | export |
| Temporary / incognito chat | **n/a** | delete covers it here | incognito |
| Usage digest | **absent** | `/activity` is raw rows | smart reports, monthly recap |
| Image generation | **win** | `image_generate` | — |
| Video generation | **win** | `video_generate` with async job polling | — |

---

## Where we actually stand

**We win on being a server.** Always-on host, durable queue, budgets that block, a review inbox, real cost ledgers, image and video generation. Everything in that list is infrastructure Anthropic has no reason to build for a single user, and it is the reason this project exists. Cowork closed the scheduling gap but it cannot enforce a monthly dollar cap or show you a per-tool-call ledger.

**We are even on the core loop.** Same SDK, same models, same thinking, same research shape. Chat with an agent and the experience is comparable.

**We are far behind on the session surface.** Diffs, checkpoints, terminal output, todo list, permission modes — five things Claude Code does that turn a long run from opaque to legible. None are hard; together they are most of the felt difference.

**We are not in the game on the ecosystem.** MCP consumption, plugins, connectors, computer use. Each is a large build, and the first one (#17) unlocks the rest by letting someone else do the work.

---

## Ranked for how this box is actually used

Weighted for: the NAS is the host, repeating jobs are the point, you rarely open files locally, and the one thing you use a side panel for is previewing a file or a website.

1. **[#29](https://github.com/derekhearst/AgentStudio/issues/29) preview pane for files and websites** — the only side-panel feature you actually use, and we have nothing. Answers the open half of #14.
2. **[#15](https://github.com/derekhearst/AgentStudio/issues/15) two tool surfaces** — invisible but wrong: half the calls dodge approval settings and cost accounting.
3. **[#20](https://github.com/derekhearst/AgentStudio/issues/20) CI watch** — the unattended loop that closes without you, which is the whole premise of running this on a NAS.
4. **[#17](https://github.com/derekhearst/AgentStudio/issues/17) external MCP** — the one build that stops every future integration from being hand-written.
5. **[#19](https://github.com/derekhearst/AgentStudio/issues/19) per-session permission mode** — long autonomous runs need "just go" without loosening global settings.
6. **[#18](https://github.com/derekhearst/AgentStudio/issues/18) conversation search, pin, archive, export** — the pile only grows.
7. **[#24](https://github.com/derekhearst/AgentStudio/issues/24) filesystem checkpoints** — matters more, not less, when you let it run unattended.
8. **[#16](https://github.com/derekhearst/AgentStudio/issues/16) diff view** and **[#26](https://github.com/derekhearst/AgentStudio/issues/26) terminal output** — demoted from the first draft: they are for watching work you mostly do not watch.
9. **[#21](https://github.com/derekhearst/AgentStudio/issues/21) todo list**, **[#22](https://github.com/derekhearst/AgentStudio/issues/22) slash commands + `@`-mentions**, **[#23](https://github.com/derekhearst/AgentStudio/issues/23) project instructions**, **[#27](https://github.com/derekhearst/AgentStudio/issues/27) the dead TTS endpoint**.

Not chasing: artifacts (#13, removed on purpose), incognito chat (deleting a chat covers it), remote control and device handoff (the web UI is already reachable anywhere), plugin marketplaces and enterprise connector governance (no second user to govern).

Open question worth deciding before spending much: **Cowork is now the product this most resembles.** Where it overlaps — scheduled agentic work on your own files — Anthropic will keep shipping. The parts of AgentStudio that stay valuable are the ones tied to this being *your server*: budgets, ledgers, the review queue, cron with real job semantics, and tools Anthropic will not ship. Worth weighting the roadmap toward those instead of chasing session-surface parity.
