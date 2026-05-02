# UI Spec

## Overview

UI is a cross-cutting product domain that defines how AgentStudio should look, feel, and behave across chat, runs, tasks, research, approvals, and artifacts. It is not only visual styling. It defines interaction contracts for session switching, blocking actions, artifact presentation, and mobile behavior.

This domain exists to prevent fragmented UX across other domains. Backend domains own data and workflows; UI owns the human experience layer that presents those workflows clearly and consistently.

## Scope

UI covers:

- Information architecture and layout shells (desktop and mobile)
- Navigation patterns for multi-session work
- Interaction patterns for approvals, questions, and interruptions
- Artifact and output presentation standards
- Design tokens (color, typography, spacing, motion)
- Accessibility and performance constraints

UI does not own business entities. It composes data from chat, runs, tasks, reviewItems, projects, research, and source-control.

## Benchmark Findings (External Research)

The following patterns are grounded in public product docs and release notes:

### ChatGPT patterns

- Composer-level model and reasoning controls reduce context switching and improve task speed.
- Mobile uses a simplified sidebar and consolidated composer tools to preserve screen space.
- Deep research includes plan-first flow, progress tracking, and fullscreen report review.
- Users can interrupt long-running work and update direction without losing progress.
- Codex app supports multiple agents in parallel with isolated worktrees and reviewable diffs.
- File/library workflow saves generated and uploaded assets in reusable side surfaces.

Sources:

- https://help.openai.com/en/articles/6825453-chatgpt-release-notes

### Claude patterns

- Artifacts are displayed in a dedicated workspace window, not buried in chat text.
- Task delegation emphasizes approval before actions and explicit user control.
- Claude Code surfaces cross-device continuity and multi-surface operation (terminal, desktop, IDE, web).

Sources:

- https://www.anthropic.com/news/artifacts
- https://docs.anthropic.com/en/docs/claude-code/overview

### Gemini patterns

- Mobile assistant overlay keeps context from the current screen while staying lightweight.
- Multi-modal entry points (text, voice, image, camera) are first-class in the same interaction loop.
- In-chat file generation/export (doc, sheet, pdf, etc.) reduces copy/paste workflow friction.

Sources:

- https://support.google.com/gemini/answer/14554984
- https://support.google.com/gemini/answer/14579631
- https://blog.google/innovation-and-ai/products/gemini-app/generate-files-in-gemini/

## Target Experience Principles

1. Chat-first command center

- Chat is the primary control surface for planning, execution, review, and intervention.

2. Work products are first-class

- Plans, artifacts, reports, diffs, and PRs must be viewable in dedicated panes/cards.

3. Multi-session by default

- Users can run and monitor multiple sessions in parallel with fast switching.

4. Blocking actions are unmissable

- Approvals and questions have consistent UI cards and a global action inbox.

5. Visual polish without distraction

- Motion and backgrounds should provide atmosphere while preserving focus.

6. Mobile parity of capability

- Mobile can simplify layout, but cannot remove critical controls.

## Information Architecture

### Desktop shell

- Left rail: navigation + running sessions dock + recent sessions
- Center: chat thread + run HUD + composer + inline action cards
- Right workbench: mode-aware tabs for artifacts, plans, research, diffs, evaluations, PRs

### Mobile shell

- Bottom navigation for primary areas
- Thread-first canvas
- Right workbench becomes bottom sheet tabs
- Blocking approvals/questions appear as sticky cards above composer

## Interaction Contracts

### Session switching

- Must support one-click switch from running sessions dock
- Must support keyboard quick switcher
- Must show unread/pending action indicators per session

### Interruption and queueing

- User can interject during active run
- User can queue instruction for next safe point
- UI must distinguish immediate interjection vs queued follow-up

### Approval and question handling

- One shared action-card component for all blocking review items
- Resolve action from chat or inbox mutates same durable row
- Every blocking item shows age, severity, and owning run/session

### Artifact presentation

- Generated outputs render as typed cards (plan, report, diff, file, PR)
- Right panel is default home for deep inspection
- Artifact timeline must preserve previous versions

### Onboarding and empty states

- First-run users should get contextual starter prompts and mode guidance without modal overload.
- Empty states must direct users toward the next meaningful action (start chat, pick project, review pending blockers).
- Multi-session empty states must distinguish "no sessions" from "no active sessions".

### Failure, retry, and degraded states

- Every async surface must define loading, partial, failure, and retry behavior.
- Blocking action failures (approval submit, ask_user submit, queue send) must show explicit retry paths.
- Long-running run disruptions should preserve user intent and offer resume/recover options.

## Visual System

### Brand and color

- Preserve green brand as primary accent
- Define secondary accent and status palettes for readability
- Maintain high contrast in dark glass surfaces

### Background and motion

- Support low-intensity animated background themes:
  - node-link network mode
  - fluid gradient mode
- Motion must be low-frequency, pause on reduced-motion preference, and avoid input interference

### Density and compactness

- Provide density presets: compact, comfortable
- Compact mode optimized for heavy multi-session users

## Accessibility

- Keyboard-navigable controls for all primary actions
- Visible focus states and screen-reader labels for action cards
- Motion reduction support
- Contrast compliance for text, status badges, and glass panels

## Performance Budgets

- Initial chat shell interactive under 2.0s on desktop broadband
- Session switch perceived latency under 250ms when data is cached
- Background animation CPU overhead under agreed threshold on mid-tier laptops

## Rollout and Safety Controls

- Major UI changes must be feature-flagged and reversible.
- New interaction patterns (queueing, action cards, panel changes) must support incremental rollout.
- UX telemetry should verify no regression in switch speed, approval resolution speed, and interruption success.

## Design QA and Visual Regression

- Define canonical screenshot baselines for key surfaces across desktop and mobile.
- Run visual regression checks for shell, composer, action cards, and workbench tabs.
- Maintain a design QA checklist for spacing, contrast, focus states, and animation behavior.

## Domain Integration Contracts

Every domain spec/plan that has UI surfaces should include a short "UI Contract" subsection that references this file and lists:

- surfaces it renders in
- states and badges it emits
- blocking actions and resolution paths
- mobile behavior adjustments

Generic boilerplate is not sufficient. Each domain must provide domain-specific entries.

### UI Contract Template (copy-paste into domain docs)

```markdown
## UI Contract

> References: [UI spec](../ui/spec.md)

| Field            | Value                                                                         |
| ---------------- | ----------------------------------------------------------------------------- |
| Primary surface  | e.g. left rail list item / chat inline card / right workbench tab             |
| Status badges    | e.g. running (green pulse) / blocked (orange) / done (ghost)                  |
| Blocking actions | e.g. ask_user card — resolved via ActionCard (ask_user type)                  |
| Mobile behavior  | e.g. surface appears in bottom-sheet tab; blocking card sticky above composer |
```

## Shell Implementation Contract

The following components implement the canonical desktop and mobile shells. Domain teams must not create parallel shell structures.

### Desktop (≥ `tablet` breakpoint)

| Zone             | Component                               | Notes                                                                                       |
| ---------------- | --------------------------------------- | ------------------------------------------------------------------------------------------- |
| Left rail        | `src/lib/ui/Sidebar.svelte`             | w-48 (tablet), w-56 (desktop). Contains nav groups, RunningSessionsDock, and settings link. |
| Running sessions | `src/lib/ui/RunningSessionsDock.svelte` | Renders inside left rail above settings. Live SSE from `/api/chat/monitor`.                 |
| Center canvas    | `<main>` in `src/routes/+layout.svelte` | Thread, HUD, composer. Responsive rounding on tablet+.                                      |
| Right workbench  | `src/lib/ui/SidePanel.svelte`           | 320 px aside panel. Mode-aware content (RecentChats, SkillStats, …).                        |

### Mobile (< `tablet` breakpoint)

| Zone               | Component                          | Notes                                   |
| ------------------ | ---------------------------------- | --------------------------------------- |
| Bottom nav         | `src/lib/ui/MobileNav.svelte`      | Hides on chat detail route (slide-off). |
| Full-screen canvas | `<main>` (full viewport)           | No border radius or padding on mobile.  |
| Right workbench    | Not shown inline; bottom sheet TBD | Phase 3.1 work.                         |

### Action cards

All blocking agent actions (ask_user, tool approval, confirmation) render via `src/lib/ui/ActionCard.svelte`. Domains invoke ActionCard with one of three `type` props:

- `ask_user` — question with options and optional freeform input
- `tool_approval` — tool name + args preview with Allow / Deny buttons
- `confirmation` — plain message with configurable confirm/cancel labels

## Rewrite Authority

The current implementation is a baseline, not a constraint. This domain may be rewritten, restyled, reorganized, or replaced as needed to achieve the target product quality. No code path is off-limits if behavior contracts, safety controls, tests, and documentation remain correct.

## UI Contract

This domain follows the shared UX system in [../ui/spec.md](../ui/spec.md).

- Surfaces in this domain must align with the shared desktop/mobile shell patterns.
- Domain-specific states must be explicit in the UI (for example pending, running, blocked, completed) where applicable.
- Blocking user decisions must use the shared action-card and inbox patterns where applicable.

## References

- ../chat/spec.md
- ../runs/spec.md
- ../research/spec.md
- ../projects/spec.md
- ../observability/spec.md
- ../source-control/spec.md

## Completion

- Template: YYYY-MM-DD - Completed in <PR/commit> - <one-line outcome>
- Pending.
