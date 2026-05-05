-- Drop the deprecated `app_settings.dream_config` column.
--
-- Background: dream-run config has been removed (background memory work now
-- lives in the memory domain). The column was kept around as legacy compat
-- after the application stopped reading/writing it; this migration removes it
-- entirely.
--
-- Also strips the `dreamSummary` key from the `notification_prefs` JSONB blob
-- on every existing row, so a `select notification_prefs from app_settings`
-- no longer surfaces the dead key. This is non-destructive — the matching key
-- on the application side was already removed in the prior settings cleanup.

ALTER TABLE "app_settings" DROP COLUMN IF EXISTS "dream_config";
--> statement-breakpoint
UPDATE "app_settings"
   SET "notification_prefs" = "notification_prefs" - 'dreamSummary'
 WHERE "notification_prefs" ? 'dreamSummary';
