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
| **broken** | we appear to have it and it does not work |
| **absent** | we have nothing |
| **n/a** | deliberately not competing |

---

## Agentic work — the part that matters most here

This is the Cowork comparison, and it is the one I got wrong in the first draft: I had us "ahead of Claude" on scheduling. Cowork has had scheduled recurring tasks since Feb 2026, and since July 2026 they run server-side with no device online.

| Feature | Verdict | Ours | Theirs |
| --- | --- | --- | --- |
| Recurring scheduled runs | **behind** (#30, #31) | cron only, and the parser handles no ranges or lists, so `0 9 * * 1-5` is unschedulable; times are UTC wall-clock, so "9am" fires at 3am here; no run-now, no history, no retry, silent on failure | Cowork scheduled + on-demand tasks |
| Runs with the laptop closed | **win** | the NAS *is* the always-on host; nothing depends on a local device | Cowork runs remotely in beta; earlier it needed the desktop VM |
| Durable job queue with leases and retries | **win** | real queue, heartbeats, cancellation, `/settings/jobs` | not exposed to the user |
| Budget enforcement | **win** | daily/monthly caps that actually block a run before it spends | plan limits, no per-workflow budget |
| Unattended failure surfacing | **win** | `/review` inbox with dedupe, plus web push | notifications only |
| Long-horizon monitoring | **absent** (#33) | nothing watches an external condition between runs | Monitor tool with deadlines |
| Multi-agent orchestration | **behind** (#5, #32) | `run_subagent`, one level, serial, no fan-out or concurrency cap | workflow scripts, concurrency limits, agent map, forked sessions |
| Delegate from a phone | **behind** | the web UI is responsive and push works | persistent agent thread on mobile, Cowork on web + mobile |
| Subagent output treated as data, not instructions | **behind** (#34) | child output is inlined into the parent transcript verbatim | indented so it cannot pass as the session's own instructions |

## Code

| Feature | Verdict | Ours | Theirs |
| --- | --- | --- | --- |
| Agent SDK session loop, resume | **even** | `$lib/engine`, session id persisted per conversation | same SDK |
| Streaming with thinking | **even** | `delta` + `reasoning` frames, adaptive thinking, effort picker | same |
| Tool approval | **behind** | per-tool global settings + mandatory-approval list | per-session modes, path-scoped deny rules, per-model effort caps, auto-mode classifier |
| Permission modes (plan / acceptEdits / bypass) | **absent** (#19) | hardcoded `default`; the Plan agent is a persona, not a mode | four modes, switchable mid-session |
| Diff rendering | **far behind** (#16) | raw JSON in a tool card | inline diffs with per-hunk accept/reject |
| Checkpoints and rewind | **far behind** (#24) | rewinds the transcript only; files stay written | auto-checkpoint per turn, Esc-Esc or `/rewind`, restore code / conversation / both |
| Todo list | **absent** (#21) | nothing consumes it | pinned, updated in place |
| Terminal / command output | **far behind** (#26) | JSON-escaped blob in a card, nothing streams | streamed terminal output |
| Git worktrees | **absent** | one working directory per project | worktree-per-agent with cleanup safety |
| Repo import and clone | **win** | first-class: import creates a project, clones into a sandbox, sidecar repo row | you point it at a directory |
| Commit / push / PR | **even** | approval-gated tools, PR recorded and surfaced in `/review` | same, plus richer GitHub triggers |
| Code review of a PR | **absent** | — | `/ultrareview`, merge-aware follow-up reviews |
| CI watch and fix | **absent** (#20) | PR is opened, then nothing looks at it again | cloud sessions react to CI |
| Hooks | **even** | `/settings/hooks`, event bus, skill hooks | same idea, dialog-managed |
| Background tasks | **behind** (#35) | the job queue backgrounds automations and research; inside a chat turn a long command blocks the turn | background bash that survives turns, with a completion notice |
| Session cost accounting | **win** | per-run rows, `/activity`, `/runs/[id]`, ledger per tool call. Caveat: #15 means built-in tool calls miss the ledger entirely | session cost in a dialog |

## Chat

| Feature | Verdict | Ours | Theirs |
| --- | --- | --- | --- |
| Streaming, thinking, model picker | **even** | | |
| Web search + fetch | **even** | `web_search`, `web_fetch`, `pdf_read` | same |
| Code execution | **even** | `run_code` in Bun, sandboxed, and every tool is callable from inside the script — better for fan-out, no chart output | analysis tool / sandboxed Python, renders charts |
| File attachments | **broken** (#36) | upload, attach, persist, render — and the engine path never passes them to the model | images, PDFs, office docs, with extraction |
| Voice dictation | **even** | record → `/api/transcribe`; no live transcript while speaking | same |
| Text-to-speech | **far behind** (#27) | endpoint + setting exist, nothing calls them | shipped |
| Deep research | **even** | approval-gated plan, background run, cited report. Worse in one way: the loop is a fixed pipeline, so a run cannot be steered mid-flight — only approved or denied up front | agentic, steerable |
| Memory | **win** | Memory Palace: wing/room/closet/drawer, hybrid vector + tsvector + temporal recall, mining pipeline | categorized entries, Topics editor, sensitive-topics exclusion — better *managed*, thinner retrieval |
| Memory management UI | **behind** (#37) | `/memory` browses; nothing edits, deletes or excludes | Topics editor, per-item delete, sensitive-topic exclusion |
| Skills | **even** | full CRUD, skill hooks, agent identity skills. No packaging or sharing, which only matters with a second user | same, plus a marketplace and `claude plugin eval` |
| Plugins / marketplace | **absent** | — | plugin system, marketplace, admin controls, `claude plugin eval` |
| Connect external MCP servers | **absent** (#17) | we *serve* MCP at `/api/mcp`, we cannot consume one | first-class, OAuth, `/mcp`, managed policies |
| Connectors (Slack, M365, Salesforce…) | **absent** | — | write-capable connectors, Claude Tag for Slack |
| Computer use | **far behind** | `browser_screenshot` only | screen access, click, navigate (research preview) |
| Artifacts / side-panel documents | **n/a** | removed in #13 — files on disk and git instead | versioned, publishable, in-place draft editing |
| Preview a file or a website in a side panel | **absent** (#29) | the right rail shows research runs or nothing | artifact + document preview |
| Inline charts and visualizations | **absent** | markdown only | interactive charts, diagrams, Claude Design |
| Conversation rename | **even** | `updateConversationMeta` | same |
| Pin / archive / folders | **absent** (#18) | delete only | full |
| Search across conversations | **far behind** (#18) | client-side filter over loaded rows | server-side across all history |
| Export a conversation | **absent** (#18) | — | export |
| Temporary / incognito chat | **n/a** | delete covers it here | incognito |
| Usage digest | **absent** (#38) | `/activity` is raw rows | smart reports, monthly recap |
| Image generation | **win** | `image_generate` | — |
| Video generation | **win** | `video_generate` with async job polling | — |

---

## Where we actually stand

**We win on being a server.** Always-on host, durable queue, budgets that block before they spend, a review inbox, real cost ledgers, image and video generation. That is infrastructure Anthropic has no reason to build for one user, and it is why this project exists. Cowork closed the scheduling gap but cannot enforce a monthly dollar cap or show a per-tool-call ledger.

**We are even on the core loop.** Same SDK, same models, same thinking, same research shape.

**The evens are thinner than they look.** Three of them hide a real disadvantage: research runs on a fixed pipeline that cannot be steered once approved; `run_code` has no chart output; dictation has no live transcript. And the one former "even" that was actually a lie is scheduling — the cron parser rejects `0 9 * * 1-5`, and what it does accept runs on UTC, so a 9am job fires at 3am here.

**We are far behind on the session surface.** Diffs, checkpoints, terminal output, todo list, permission modes — five things that turn a long run from opaque to legible.

**We are not in the game on the ecosystem.** MCP consumption, plugins, connectors, computer use. #17 is the one that matters: it lets other people's work count as ours.

**One thing is outright broken.** Attachments (#36) upload, persist and render, and the engine never passes them to the model.

---

## Target: every category at even or better

Ordered for how this box is used — NAS host, repeating jobs, files rarely opened locally — and grouped so the work can run in parallel. Full breakdown and file ownership in [#39](https://github.com/derekhearst/AgentStudio/issues/39).

**Wave 1 — correctness. Things that are wrong, not missing.**

| | | |
| --- | --- | --- |
| [#36](https://github.com/derekhearst/AgentStudio/issues/36) | attachments never reach the model | broken → even |
| [#30](https://github.com/derekhearst/AgentStudio/issues/30) | cron is UTC-only and rejects ranges and lists | behind → even |
| [#15](https://github.com/derekhearst/AgentStudio/issues/15) | two tool surfaces, so half the calls dodge approval and cost | invisible correctness |
| [#34](https://github.com/derekhearst/AgentStudio/issues/34) | subagent output inlined as if it were our own reasoning | injection surface |

**Wave 2 — the categories to win.**

| | | |
| --- | --- | --- |
| [#31](https://github.com/derekhearst/AgentStudio/issues/31) | automation history, run-now, retry, failure surfacing | scheduling → win |
| [#33](https://github.com/derekhearst/AgentStudio/issues/33) | long-horizon monitors: watch a condition, act when it changes | absent → win |
| [#5](https://github.com/derekhearst/AgentStudio/issues/5) → [#32](https://github.com/derekhearst/AgentStudio/issues/32) | SDK subagents, then fan-out with a concurrency cap | orchestration → win |
| [#20](https://github.com/derekhearst/AgentStudio/issues/20) | CI watch, built on #33 rather than its own poller | absent → win |

**Wave 3 — the session surface.**

[#29](https://github.com/derekhearst/AgentStudio/issues/29) preview pane · [#19](https://github.com/derekhearst/AgentStudio/issues/19) permission modes · [#24](https://github.com/derekhearst/AgentStudio/issues/24) filesystem checkpoints · [#21](https://github.com/derekhearst/AgentStudio/issues/21) todo list · [#16](https://github.com/derekhearst/AgentStudio/issues/16) diff view · [#26](https://github.com/derekhearst/AgentStudio/issues/26) terminal output · [#35](https://github.com/derekhearst/AgentStudio/issues/35) background work in a turn

**Wave 4 — the long tail.**

[#17](https://github.com/derekhearst/AgentStudio/issues/17) external MCP · [#18](https://github.com/derekhearst/AgentStudio/issues/18) conversation search, pin, archive, export · [#37](https://github.com/derekhearst/AgentStudio/issues/37) memory management · [#38](https://github.com/derekhearst/AgentStudio/issues/38) usage digest · [#22](https://github.com/derekhearst/AgentStudio/issues/22) slash commands and `@`-mentions · [#23](https://github.com/derekhearst/AgentStudio/issues/23) project instructions · [#27](https://github.com/derekhearst/AgentStudio/issues/27) the dead TTS endpoint

**Deferred on purpose:** artifacts (#13, removed), incognito chat (delete covers it), remote control (the web UI is reachable anywhere), plugin marketplace and connector governance (no second user), computer use (large, and the browser tools cover the real cases), inline charts and Claude Design (worth revisiting only if the reports get visual).
