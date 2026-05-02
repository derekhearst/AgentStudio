# UI Plan

Status: active

> See also: [spec.md](spec.md), [../chat/plan.md](../chat/plan.md)

## Goal

Deliver an end-state app experience that feels polished and calm while supporting heavy multi-session agent work. Chat remains the primary surface, but all domains present coherent, consistent UI behaviors across desktop and mobile.

## Current State

- Strong foundation with dark glass look and green brand accents
- Chat list and work-product surfaces compete for the same right-side space
- Multi-session switching exists but lacks a dedicated running-sessions control surface
- Approvals and ask-user flows are functional but not consistently high quality
- Background visuals are generic and not intentionally branded
- No cross-domain UI contract system across domain specs/plans

## Phase 1 - UX architecture and contracts

Goal: lock IA and interaction contracts before visual implementation.

### 1.1 App shell definition

Define desktop and mobile shell rules:

- left rail (nav + running sessions + recent)
- center thread canvas
- right workbench panel for work products

### 1.2 Cross-domain UI contract template

Add a reusable "UI Contract" section template and require it in domain docs with UI surfaces.

### 1.3 Outcome metrics

Define measurable UX targets:

- session switch time
- approval resolution time
- artifact retrieval time
- interruption success rate

## Phase 2 - Multi-session command center

Goal: optimize for users running multiple agents/sessions concurrently.

### 2.1 Running sessions dock

Add a compact dock showing:

- status (queued/running/blocked/done)
- latest activity
- pending actions count
- quick-jump action

### 2.2 Quick switcher

Add keyboard-first session switcher with fuzzy search and status chips.

### 2.3 Session compactness controls

Add density toggle (compact/comfortable) stored per user.

## Phase 3 - Workbench panel for artifacts and plans

Goal: right-side real estate prioritizes outputs, not only chat list.

### 3.1 Mode-aware tabs

Implement mode-aware right panel with pinned tab behavior.

### 3.2 Typed output cards

Standardize rendering contracts for:

- plan proposal
- research report
- artifact version
- code diff
- evaluation findings
- pull request summary

### 3.3 Split view support

Enable split inspection for diff + evaluator or report + sources.

## Phase 4 - Confirmations, questions, and queueing

Goal: make blocking interactions obvious, fast, and consistent.

### 4.1 Unified action card component

Single component for ask_user, approvals, and policy confirmations.

### 4.2 Global action inbox

Cross-session list of pending actions with severity and age.

### 4.3 Interjection and message queue UI

During active runs, allow:

- send now as interjection
- queue for next safe point
- cancel queued message

## Phase 5 - Visual polish and motion system

Goal: distinctive visual identity with low distraction.

### 5.1 Tokenized visual system

Define tokens for:

- brand and semantic colors
- glass elevation layers
- spacing and typography scale
- motion durations and easing

### 5.2 Background themes

Implement selectable low-intensity themes:

- node-link network
- fluid gradient

Respect reduced-motion setting and low-power devices.

### 5.3 Microinteraction pass

Tune interaction feedback for:

- composer submit and queue state
- mode switches
- tab transitions
- approval action confirmations

## Phase 6 - Mobile parity

Goal: preserve critical workflow capability on mobile.

### 6.1 Bottom-sheet workbench

Map right-panel tabs into bottom-sheet stack.

### 6.2 Sticky blockers

Show blocking approval/question cards above composer when unresolved.

### 6.3 Performance and touch validation

Validate on mid-tier Android and iOS devices for smoothness and touch accuracy.

## Phase 7 - Hardening and UX evals

Goal: prove the UX improves task throughput and confidence.

### 7.1 Usability scenarios

Test scenarios:

- parallel sessions with one blocked and one running
- mid-run interjection with successful reroute
- finding latest artifact in under target time

### 7.2 Regression and telemetry gates

Add telemetry dashboards and automated checks for key UX metrics.

### 7.3 Accessibility review

Keyboard, screen reader, contrast, and reduced-motion audits.

## Rewrite Authority

The current implementation is a baseline, not a constraint. This domain may be rewritten, restyled, reorganized, or replaced as needed to achieve the target product quality. No code path is off-limits if behavior contracts, safety controls, tests, and documentation remain correct.

## UI Contract

Implementation in this domain must comply with [../ui/plan.md](../ui/plan.md) and [../ui/spec.md](../ui/spec.md).

- Include UX acceptance criteria for desktop and mobile behavior.
- Include compactness/density behavior where relevant.
- Include approval, question, and interruption flows where relevant.

## Dependencies

- ../chat/plan.md for mode-aware panel and inline cards
- ../runs/plan.md for run state and blocker events
- ../tasks/plan.md for plan lifecycle cards
- ../observability/plan.md for review inbox convergence
- ../projects/plan.md for artifact timeline surfaces
- ../research/plan.md for report/source rendering

## Completion

- Template: YYYY-MM-DD - Completed in <PR/commit> - <one-line outcome>
- Pending.
