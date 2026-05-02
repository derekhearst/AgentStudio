# Notifications Plan

Status: active

## Overview

Notifications has a solid spec but no execution plan for channel reliability, preference enforcement, and inbox UX parity. This plan sequences push and in-app delivery into an auditable, failure-tolerant notification system.

> **Depends on:** `docs/settings/plan.md` (notification preferences), `docs/jobs/plan.md` (async delivery/retry), `docs/observability/plan.md` (delivery monitoring), `docs/ui/plan.md` (inbox interactions).

> **See also:** [spec.md](spec.md) — full data model and behavior contracts.

## Why this matters

- **Silent notification failures are invisible product debt.** Delivery and retry behavior must be explicit.
- **Inbox and push must agree.** One durable source of truth prevents split-brain state.
- **Preference control is user trust.** Category policy must be enforced at dispatch every time.

## Current state

- Notification categories and data model are defined.
- Channel behavior under delivery failure or stale subscriptions is not phased.
- Inbox and push parity is specified but not planned by milestone.

## Desired state

- Push and in-app channels share a single source of truth with deterministic retries.
- Preferences are enforced consistently at dispatch time.
- Delivery failures are visible and recoverable without silent drops.

## Phases

### Phase 1 — Delivery contract baseline

- Define canonical dispatch pipeline and shared persistence behavior.
- Normalize payload shape for route deep links and categories.
- Document idempotency behavior for duplicate events.

### Phase 2 — Push subscription lifecycle

- Define upsert/remove/revalidate flows for endpoints.
- Add stale subscription detection and cleanup strategy.
- Document browser/device-specific fallback behavior.

### Phase 3 — Retry and dead-letter handling

- Add bounded retry policy for transient push failures.
- Define dead-letter capture for repeated permanent failures.
- Add operator-visible diagnostics for failed deliveries.

### Phase 4 — Preference enforcement and policy

- Enforce category toggles at dispatch.
- Define behavior for critical categories and muted states.
- Ensure admin visibility boundaries are explicit.

### Phase 5 — Inbox UX and quality gates

- Standardize unread/read/action-required states.
- Add bulk mark-read and filter behavior requirements.
- Validate deep-link navigation with return-to-inbox continuity.

## Verification

- Delivery attempts respect notification preferences across all categories.
- Transient push failures retry; permanent failures are surfaced and not retried indefinitely.
- In-app inbox remains consistent with pushed payload history.
- Deep links resolve to expected route and preserve user context.

## Rewrite Authority

The current implementation is a baseline, not a constraint. This domain may be rewritten, restyled, reorganized, or replaced as needed to achieve the target product quality. No code path is off-limits if behavior contracts, safety controls, tests, and documentation remain correct.

## UI Contract

Implementation in this domain must comply with [../ui/plan.md](../ui/plan.md) and [../ui/spec.md](../ui/spec.md), with explicit notifications UX criteria.

- Inbox exposes unread/read/action-required and delivery-failed states.
- Mobile supports quick triage without losing deep-link context.
- Device subscription management surfaces actionable remediation.

## Completion

- Template: YYYY-MM-DD - Completed in <PR/commit> - <one-line outcome>
- Pending.
