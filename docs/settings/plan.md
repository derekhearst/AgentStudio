# Settings Plan

Status: active

## Overview

Settings is defined by spec but has no phased plan for schema normalization, domain ownership boundaries, or UX save semantics. This plan turns settings into a stable cross-domain contract with explicit validation, migration, and recovery behavior.

> **Depends on:** `docs/structure/plan.md` (domain ownership boundaries), `docs/ui/plan.md` (settings UX), `docs/cost/plan.md`, `docs/context/plan.md`, `docs/memory/plan.md`, `docs/notifications/plan.md` (consumer domains).

> **See also:** [spec.md](spec.md) — full data model and behavior contracts.

## Why this matters

- **Settings is the control plane.** Cost, context, memory, and notification behavior all depend on it.
- **Unsafe merges create hidden regressions.** Partial updates and nested JSON rules must be explicit.
- **Users need reversible changes.** Save and rollback behavior is part of product trust.

## Current state

- Settings fields are documented but change sequencing and compatibility strategy are not.
- Cross-domain ownership of fields is implied, not explicitly enforced.
- Save semantics and rollback behavior are not phased in implementation guidance.

## Desired state

- Each settings section has a clear owning domain and validation contract.
- Changes are safe under partial failure and preserve prior known-good values.
- UX supports section-scoped edits with explicit unsaved/saving/error states.

## Phases

### Phase 1 — Ownership map and schema baseline

- Define ownership for each settings block (cost, context, memory, notifications, tools, appearance, dream).
- Document compatibility rules for deprecated fields.
- Establish migration strategy for shape changes.

### Phase 2 — Validation and update contracts

- Define schema validation for each JSON block.
- Standardize partial update semantics and conflict handling.
- Document defaulting behavior on missing/invalid values.

### Phase 3 — Save/rollback behavior

- Define optimistic update policy by section.
- Add rollback strategy for failed writes.
- Ensure section-level dirty-state tracking and navigation guards.

### Phase 4 — Cross-domain enforcement

- Ensure consuming domains read via settings access contract, not ad hoc queries.
- Add compatibility tests for budget/context/memory/tool-policy consumers.
- Document change-impact checklist for new settings fields.

### Phase 5 — Observability and admin controls

- Record settings-change audit events for sensitive fields.
- Add admin read/update path rules and safeguards.
- Define troubleshooting workflow for misconfiguration incidents.

## Verification

- Invalid settings payloads are rejected deterministically with actionable errors.
- Partial updates do not silently clobber unrelated blocks.
- Consumer domains observe updated settings without inconsistent intermediate state.
- Sensitive settings changes are auditable.

## Rewrite Authority

The current implementation is a baseline, not a constraint. This domain may be rewritten, restyled, reorganized, or replaced as needed to achieve the target product quality. No code path is off-limits if behavior contracts, safety controls, tests, and documentation remain correct.

## UI Contract

Implementation in this domain must comply with [../ui/plan.md](../ui/plan.md) and [../ui/spec.md](../ui/spec.md), with explicit settings UX criteria.

- Section-scoped unsaved/saving/saved/error states are visible.
- Mobile behavior preserves section-level validation and save controls.
- Risky settings changes require confirmation with impact text.

## Completion

- Template: YYYY-MM-DD - Completed in <PR/commit> - <one-line outcome>
- Pending.
