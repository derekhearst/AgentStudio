# Auth Plan

Status: active

## Overview

Auth is currently specified in detail but has no implementation plan that sequences bootstrap, WebAuthn ceremony reliability, and session lifecycle hardening. This plan defines phased delivery for secure, operable auth behavior without coupling to unrelated feature domains.

> **Depends on:** `docs/structure/plan.md` (domain boundaries), `docs/ui/plan.md` (auth UX states), `docs/observability/plan.md` (security event visibility).

> **See also:** [spec.md](spec.md) — full data model and behavior contracts.

## Why this matters

- **Auth failures are product failures.** If identity flows are brittle, every domain becomes unreachable.
- **Recovery paths are part of security.** Claim expiry, ceremony errors, and session invalidation must be deterministic.
- **Auditability protects operators and users.** Sensitive auth transitions need clear event trails.

## Current state

- Passkey/WebAuthn architecture is defined in spec but delivery sequencing is undocumented.
- Bootstrap claim flow exists conceptually but lacks explicit rollout and rollback checkpoints.
- Session management guarantees are described but not tracked through phased verification.

## Desired state

- Bootstrap claim, passkey registration/authentication, and session revocation flows are implementation-ready and test-gated.
- Admin lifecycle actions (create, disable, role change) are documented with explicit safeguards.
- Auth events are auditable and observable without exposing secrets.

## Phases

### Phase 1 — Bootstrap and claim flow hardening

- Formalize startup claim generation/expiry behavior.
- Define replay-protection checks and failure messaging.
- Add operational runbook notes for expired/consumed claim recovery.

### Phase 2 — WebAuthn ceremony reliability

- Define challenge issuance, expiry, and one-time consumption invariants.
- Standardize retry/recovery behavior for device/browser incompatibility cases.
- Ensure counter validation and credential state transitions are explicit.

### Phase 3 — Session lifecycle and revocation

- Document session creation, refresh/rotation strategy (if any), and explicit sign-out semantics.
- Add admin-forced session invalidation behavior for disabled/deleted users.
- Define session-expiry UX and server-side enforcement points.

### Phase 4 — Admin user lifecycle

- Sequence create/invite/claim/disable/reactivate workflows.
- Document role-change safeguards and audit expectations.
- Add guardrails for destructive user operations.

### Phase 5 — Observability and incident readiness

- Emit auth domain events for login success/failure, claim use, and session revocation.
- Define alert thresholds for repeated failures and suspicious patterns.
- Add incident checklist references for auth outages.

## Verification

- Bootstrap claim is single-use and expires as documented.
- Passkey registration/authentication survives normal device/browser variance with deterministic error handling.
- Disabled users cannot authenticate and all existing sessions are invalidated.
- Admin role checks are enforced server-side on all protected surfaces.

## Rewrite Authority

The current implementation is a baseline, not a constraint. This domain may be rewritten, restyled, reorganized, or replaced as needed to achieve the target product quality. No code path is off-limits if behavior contracts, safety controls, tests, and documentation remain correct.

## UI Contract

Implementation in this domain must comply with [../ui/plan.md](../ui/plan.md) and [../ui/spec.md](../ui/spec.md), with explicit auth UX criteria.

- Desktop and mobile login flows must expose the same security guarantees.
- Challenge pending and session-expired states must be explicit and recoverable.
- Destructive admin actions require confirmation and consequence messaging.

## Completion

- Template: YYYY-MM-DD - Completed in <PR/commit> - <one-line outcome>
- Pending.
