-- Single-user auth simplification.
--
-- Replaces passkey-only WebAuthn + bootstrap-claim flow with username + password (Argon2id).
-- AgentStudio is a single-user self-hosted instance, so the multi-user, admin/role, and
-- soft-delete machinery is removed. The existing user row (if any) is preserved with
-- password_hash NULL — the app's hooks redirect to /setup until a password is set.

-- Drop tables that supported passkey + bootstrap flows. Foreign keys cascade off users.id.
DROP TABLE IF EXISTS "user_passkeys";
DROP TABLE IF EXISTS "auth_challenges";
DROP TABLE IF EXISTS "bootstrap_claims";
--> statement-breakpoint

-- Drop enums that backed those tables (auth_challenge_purpose) and the role concept.
-- audit_action retains the user.* values intentionally — old rows survive, no new ones written.
DROP TYPE IF EXISTS "auth_challenge_purpose";
--> statement-breakpoint

-- Drop legacy user columns. role/is_active/deleted_at/claimed_at are now meaningless.
ALTER TABLE "users" DROP COLUMN IF EXISTS "role";
ALTER TABLE "users" DROP COLUMN IF EXISTS "is_active";
ALTER TABLE "users" DROP COLUMN IF EXISTS "deleted_at";
ALTER TABLE "users" DROP COLUMN IF EXISTS "claimed_at";
DROP TYPE IF EXISTS "user_role";
--> statement-breakpoint

-- Add the password hash column (nullable so existing user rows survive; /setup will fill it).
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_hash" text;
--> statement-breakpoint

-- Enforce singleton: only one row may ever exist in users. Index on a constant expression
-- means every row's index key is the same, so the unique constraint is global.
CREATE UNIQUE INDEX IF NOT EXISTS "users_singleton" ON "users" ((true));
