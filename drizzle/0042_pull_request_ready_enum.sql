-- Wave 5 #19 phase 4 — `pull_request_ready` review-item source.
--
-- When the agent successfully calls `create_pull_request`, we open a review item so an
-- operator can spot the new PR in /review without monitoring chat. Adding a dedicated
-- enum value (vs. reusing `approval_request` or `policy_override_request`) keeps the
-- inbox UI's per-source filtering meaningful — operators can see "PRs my agents opened"
-- without sifting through unrelated approval prompts.
--
-- `ALTER TYPE ... ADD VALUE` is non-blocking on Postgres 12+ and idempotent via the
-- IF NOT EXISTS guard. Old rows are unaffected because they never carry this value.

ALTER TYPE "review_item_type" ADD VALUE IF NOT EXISTS 'pull_request_ready';
