-- Wave 3 #14 evaluations plan phase 3+4 — task-level evaluation gating + retry counter.
-- Hand-written for parity with the rest of the Wave 3 chain.
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "eval_required" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "eval_attempt" integer NOT NULL DEFAULT 0;
