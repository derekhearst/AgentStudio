/**
 * Cross-cutting runtime constants shared by approval/question pollers and the
 * resumable stream tail. Centralised so a tuning change applies in one place.
 */

export const POLL_INTERVAL_MS = 500

export const DECISION_TIMEOUT_MS = 5 * 60 * 1000
