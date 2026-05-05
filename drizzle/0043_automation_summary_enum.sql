-- Wave 5 #21 phase 4 (output routing) — `automation_summary` review-item source.
--
-- When a maintenance-mode automation's `outputTarget = review_inbox`, the engine opens a
-- review item carrying the summary so an operator sees the result in /review without
-- monitoring chat. Reusing `policy_override_request` would mix budget-block telemetry
-- with maintenance summaries; a dedicated value keeps the inbox's per-source filtering
-- meaningful for both surfaces.
--
-- Same non-blocking ALTER TYPE pattern as the `pull_request_ready` value (0042).

ALTER TYPE "review_item_type" ADD VALUE IF NOT EXISTS 'automation_summary';
