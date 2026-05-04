-- Wave 5 #21 phase 3 — automation rich trigger/output model (initial increment).
--
-- Adds two enums + two columns to automations so the next iteration of the runner can
-- dispatch by mode and route output by target. Existing automations default to
-- mode='chat_followup' + output_target='chat_session' (the current behavior). Subsequent
-- phases (4-5) wire research/code mode handlers + push the output targets through to
-- task creation, artifacts, and review-item creation.
--
-- Both enums are additive — new modes / targets land via a follow-up migration when the
-- corresponding behavior is wired. The column defaults preserve backward-compatibility
-- so seeded automations keep their current execution semantics until an operator opts in.

CREATE TYPE "automation_mode" AS ENUM ('chat_followup', 'research', 'code', 'maintenance');
--> statement-breakpoint
CREATE TYPE "automation_output_target" AS ENUM ('chat_session', 'task', 'artifact', 'review_inbox');
--> statement-breakpoint
ALTER TABLE "automations"
	ADD COLUMN IF NOT EXISTS "mode" automation_mode NOT NULL DEFAULT 'chat_followup';
--> statement-breakpoint
ALTER TABLE "automations"
	ADD COLUMN IF NOT EXISTS "output_target" automation_output_target NOT NULL DEFAULT 'chat_session';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "automations_mode_idx" ON "automations" USING btree ("mode");
