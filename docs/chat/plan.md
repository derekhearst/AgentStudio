# Chat Plan

Status: active

> **See also:** [spec.md](spec.md)

## Goal

Deliver the chat workbench as described in the spec: four composer modes with mode-aware identity prompts, live run HUD, inline plan approvals, inline `ask_user` answers, diff/artifact preview, and research report view. Currently the chat route exists but is missing the mode system, structured approval cards, and most right-panel features.

## Current State

- `/chat/[id]` route + `/chat/[id]/stream` API exist
- Message list, basic composer, and skill attachment work
- Context assembly uses ad-hoc `systemSections[]` — no mode awareness
- No mode selector in composer
- No plan approval card — plans are rendered as plain text
- No live run HUD (run status fetched but not surfaced as HUD)
- No mode-aware right panel
- `chatWorkbenchPreferences` table does not exist
- `conversations.mode` column does not exist
- Approval/`ask_user` inline rendering is partial — no durable link to review inbox

## Phase 1 — Conversation mode column + preferences table

**Goal:** Persist mode selection so it survives page refresh and can be read by the stream handler.

### 1.1 Schema migration

```sql
ALTER TABLE conversations ADD COLUMN mode text NOT NULL DEFAULT 'chat'
  CHECK (mode IN ('chat', 'research', 'plan', 'agent'));

CREATE TABLE chat_workbench_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  default_mode text NOT NULL DEFAULT 'chat',
  show_right_panel boolean NOT NULL DEFAULT true,
  panel_layout jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);
```

### 1.2 Schema file

Add `conversations.mode` to `src/lib/sessions/sessions.schema.ts` (or equivalent). Create `chatWorkbenchPreferences` in a chat-owned schema module (for example `src/lib/chat/chat.workbench.schema.ts`).

### 1.3 Mode remote functions

- `getWorkbenchPreferences(userId)` — returns preferences, creating defaults if absent
- `setDefaultMode(userId, mode)` — upserts default mode
- `setConversationMode(conversationId, mode)` — updates mode, returns anchor message to inject

## Phase 2 — Mode selector UI + anchor messages

**Goal:** Users can switch mode in the composer. Mode switches inject a visible system anchor message so the model knows its posture changed.

### 2.1 Mode selector component

Small segmented control in the composer toolbar showing `Chat | Research | Plan | Agent`. Selected mode highlighted. Tooltip explains posture on hover.

### 2.2 Anchor message injection

When mode switches mid-conversation, write a `role: system` message to the conversation history:

```
[Mode changed to Plan] You are now in Plan mode. Propose a structured plan with success criteria before taking any actions.
```

This message is persisted and included in future context assembly so the model's posture is unambiguous after compaction.

### 2.3 Context assembly reads mode

The stream handler (`/chat/[id]/stream`) reads `conversations.mode` and includes the matching mode identity skill as the first system section, replacing the hardcoded `ORCHESTRATOR_IDENTITY` string. See [../context/plan.md](../context/plan.md) for slot-based assembly details.

## Phase 3 — Mode identity skills seeded on boot

**Goal:** Each mode's identity prompt is editable in the UI without a redeploy.

### 3.1 Seed function

On first boot, upsert four skills with fixed UUIDs (same DB-seeded pattern as `drokbot-guide`):

| Skill slug             | Description                                         |
| ---------------------- | --------------------------------------------------- |
| `system/mode-chat`     | Conversational, collaborative posture               |
| `system/mode-research` | Skeptical investigator, cites sources               |
| `system/mode-plan`     | Proposes before executing, Karpathy four principles |
| `system/mode-agent`    | Autonomous executor, minimal interruptions          |

Insert with `ON CONFLICT DO NOTHING` so user edits persist across restarts.

### 3.2 Mode skill loader

`loadModeIdentitySkill(mode)` — fetches skill content by slug, falls back to hardcoded string if not found (safety net only).

### 3.3 UI: mode identity editor

Settings → Modes → click mode → opens skill markdown editor backed by the seeded skill. Save updates the skill; next session picks it up.

## Phase 4 — Inline plan approval card

**Goal:** When the orchestrator produces a plan (structured JSON response), the chat thread renders it as an approval card instead of raw text.

### 4.1 Plan card message type

Define a `plan_proposal` message type (stored as `metadata.type = 'plan_proposal'` on the assistant message). Content includes:

- `summary` — one-line description
- `tasks` — ordered list with description and estimated cost/duration each
- `totalEstimatedCost` — USD cents
- `taskId` — FK to the pending task if one was created

### 4.2 Plan card component

Renders inline in the message list:

- Summary header
- Collapsible task list
- Cost + time estimate row
- Approve / Request revision / Cancel buttons

Actions call server mutations:

- Approve → transitions task to `approved`, triggers run creation
- Request revision → posts the revision text as a new user message
- Cancel → transitions task to `cancelled`

### 4.3 Orchestrator produces structured plans

Update the orchestrator's mode-plan identity prompt to output JSON plan proposals in a defined schema. The stream handler detects this schema and stores the message with `type = 'plan_proposal'`.

## Phase 5 — Live run HUD

**Goal:** While a run is active, the workbench shows a live status strip above the composer.

### 5.1 HUD data

Poll or subscribe to active run for current conversation. Show:

- Agent name
- Round N of max
- Current tool (if any)
- Subagent count
- Token and cost usage vs. budget
- Pending approval count
- Blocked state reason (if blocked)

### 5.2 HUD component

Collapsible strip pinned above the composer. Expands to full run detail. Links to `/runs/[id]` for full trace. Only visible when a run is active for this conversation.

### 5.3 Interrupt controls

Buttons in the HUD:

- Pause
- Cancel
- Answer question (if pending `ask_user`)

## Phase 6 — Inline `ask_user` and approval answers

**Goal:** `ask_user` questions and tool approval requests render as interactive message cards. Answering from chat updates the same durable review item so the review inbox stays consistent.

### 6.1 `ask_user` card

When the run writes a `reviewItems` row of type `ask_user`, the stream event pushes it to the chat client. Client renders an inline card with the question and a free-text input (or choice buttons if options are provided).

Submit → calls `resolveReviewItem(id, answer)` → run unblocks.

### 6.2 Tool approval card

For `tool_approval` review items, renders:

- Tool name + arguments
- Risk level badge
- Approve / Deny buttons

Both paths update `reviewItems.resolution` and unblock the run.

### 6.3 Durable linkage

The same `resolveReviewItem` function is used by both the chat card and the review inbox. State is always read from `reviewItems`, never from transient chat state.

## Phase 7 — Mode-aware right panel

**Goal:** The right panel content changes based on active mode, providing relevant context without switching pages.

### 7.1 Panel tabs by mode

| Mode     | Default tabs                                      |
| -------- | ------------------------------------------------- |
| Chat     | Session info, linked task, linked project         |
| Research | Source list, progress steps, report outline       |
| Plan     | Task graph, success criteria, estimated cost      |
| Agent    | Changed files, diff summary, evaluator status, PR |

### 7.2 Panel persistence

Panel open/closed state and active tab saved to `chatWorkbenchPreferences.panelLayout`.

### 7.3 Mobile collapse

On narrow viewports, right panel converts to a bottom sheet with the same tabs. Active tab badge-counts pending approvals.

## Phase 8 — Diff and artifact preview

**Goal:** When a run changes files or saves artifact versions, users can review them without leaving chat.

### 8.1 Changed files list

Right panel "Files" tab lists files changed in the active run. Click → opens diff viewer (unified diff inline or split view).

### 8.2 Artifact version timeline

If the run saved artifact versions, the right panel shows a version timeline. Click → previews content (markdown rendered, code syntax-highlighted).

### 8.3 Evaluator findings

If an evaluator ran, findings appear as inline annotations on the diff or as a collapsible list in the panel.

## Phase 9 — Research report view

**Goal:** Research results are first-class output in the chat thread, not just a text blob.

### 9.1 Research report card

When a research run completes, the final assistant message is tagged `type = 'research_report'`. Rendered as:

- Executive summary
- Collapsible sections with inline citations
- Source drawer (side panel or modal)
- Plan-to-report trace (which plan steps produced which sections)

### 9.2 Source drawer

Clicking a citation opens a side drawer with:

- Source URL, title, domain
- Fetched excerpt
- Credibility indicator

## Rewrite Authority

The current implementation is a baseline, not a constraint. This domain may be rewritten, restyled, reorganized, or replaced as needed to achieve the target product quality. No code path is off-limits if behavior contracts, safety controls, tests, and documentation remain correct.

## UI Contract

Implementation in this domain must comply with [../ui/plan.md](../ui/plan.md) and [../ui/spec.md](../ui/spec.md), with explicit chat-workbench criteria.

- Desktop shell: left rail + center thread + right workbench tabs must all function together for active runs.
- Mobile shell: right workbench behavior must collapse into bottom-sheet tabs without losing blocker controls.
- Blocking interactions: plan approvals, tool approvals, and ask_user prompts must use shared action-card patterns.
- Session operations: quick session switching and interjection queue controls must be available in the chat surface.
- Visual QA: chat shell, mode switcher, HUD, and action cards must be covered by visual regression checks.

## Dependencies

| Phase | Depends on                                                                              |
| ----- | --------------------------------------------------------------------------------------- |
| 3     | [../skills/plan.md](../skills/plan.md) — skill seeding pattern                          |
| 3     | [../agents/plan.md](../agents/plan.md) — mode identity skill loading                    |
| 2–3   | [../context/plan.md](../context/plan.md) — slot-based context assembly reads mode       |
| 4     | [../tasks/plan.md](../tasks/plan.md) — plan approval mutates task state                 |
| 5–6   | [../runs/plan.md](../runs/plan.md) — run status + review items                          |
| 8     | [../projects/plan.md](../projects/plan.md) — artifact versions                          |
| 9     | [../research/plan.md](../research/plan.md) — research report schema                     |
| 2–8   | [../ui/plan.md](../ui/plan.md) — shell layout, interaction contracts, and mobile parity |

## Completion

- Template: YYYY-MM-DD - Completed in <PR/commit> - <one-line outcome>
- 2026-05-02 — Phase 1 (conversation mode + workbench preferences) and the server half of Phase 2 (anchor message + mode-aware identity) shipped on branch `claude/nervous-kapitsa-18255e`. New `chat_mode` pgEnum (chat/research/plan/agent), `mode` column on `conversations` defaulting to `chat`, new `chat_workbench_preferences` table (one row per user, cascade on user delete) holding default mode + right-panel state + freeform panel layout. New `src/lib/chat/mode.server.ts` with `getWorkbenchPreferences`, `setDefaultMode`, `setShowRightPanel`, `setConversationMode` helpers; `setConversationMode` writes a system anchor message into the conversation history with `metadata.type = 'mode_anchor'` and is a no-op when the mode is unchanged. Stream handler now reads `conversation.mode` and prepends a mode-posture context slot (priority 95, between identity p100 and tool_policy p90) when the mode is non-chat. Mode remote functions (`getWorkbenchPreferences`, `setDefaultMode`, `setShowRightPanel`, `setConversationMode`, `listChatModes`) exposed in `chat.remote.ts`.
- 2026-05-02 — Phase 2 UI half (mode selector in composer toolbar) shipped on branch `claude/nervous-kapitsa-18255e`. New `src/lib/chat/ModeSelector.svelte` — small dropdown next to the model picker showing the four modes with descriptions on hover. Wired through `ChatInput.svelte` and `ChatComposer.svelte` props. The chat page reads `conversation.mode` from `getConversation`, calls `setConversationMode` on change, and applies an optimistic local state update so the composer re-renders immediately while the page refreshes its conversation snapshot in the background.
- 2026-05-02 — Phase 3 (mode identity skills seeded on boot) shipped on branch `claude/nervous-kapitsa-18255e`. New `src/lib/chat/mode-skills.server.ts` defines four fixed-UUID skills (system/mode-{chat,research,plan,agent}) with rich markdown posture content. `seedModeIdentitySkills(dbInstance)` upserts via `ON CONFLICT (id) DO NOTHING` so user edits persist across restarts. Wired into `bootstrapDatabase()` post-migration. New `loadModeIdentitySkill(mode)` returns DB content if the skill row is enabled and non-empty, falling back to the bundled default — so the system stays usable even if the seed didn't run or a skill was deleted. The stream handler now uses `getModePostureContent(mode)` (which calls the loader) for the mode-posture context slot, replacing the previous one-line anchor prompt. Anchor messages on mode flip still use the short one-liner. Phases 4-9 (plan approval card, run HUD, inline approval cards, mode-aware right panel, diff/artifact preview, research report view) still pending.
