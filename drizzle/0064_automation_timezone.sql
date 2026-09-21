-- Per-automation time zone (issue #30).
--
-- A cron expression is a wall-clock schedule, so it is meaningless without a zone.
-- `computeNextRunAt` used to walk the process's local clock; the production container
-- sets no TZ and mounts no /etc/localtime, so "local" resolved to UTC and an automation
-- the UI showed as "9am" fired at 3am Mountain. The zone now lives on the row, so the
-- schedule no longer depends on where the process happens to run.
--
-- Backfill: every existing row gets the column default, 'America/Boise'. That is a
-- deliberate behaviour change for rows created before this migration -- they were
-- effectively scheduled in UTC, and they now fire at the hour their expression actually
-- reads. Re-point any row that genuinely wanted UTC with:
--   UPDATE automations SET timezone = 'UTC' WHERE id = '...';
-- next_run_at is left alone; it is re-derived in the target zone on the next run or the
-- next edit of the expression.

ALTER TABLE automations
	ADD COLUMN IF NOT EXISTS "timezone" text NOT NULL DEFAULT 'America/Boise';
