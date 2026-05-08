-- Merge source-control into projects.
--
-- Every project now has its own sandboxed working directory + git repo. Local-only projects
-- are git-init'd at <SANDBOX_WORKSPACE>/<userId>/projects/<projectId>; imported projects are
-- cloned to the same path. The standalone /source-control page is going away — its repo
-- list, import flow, connection cards, and detail panel all move to /projects.
--
-- Schema decision: keep `repositories` as a 1:1 sidecar to `projects` (provider/owner/name/
-- cloneUrl + the FK target for branches/PRs/checks). Adding repo-shape fields directly to
-- `projects` would force every project to carry a pile of nullable columns; the sidecar lets
-- non-repo projects skip them entirely.
--
-- Migration is destructive for the `repositories` table — we wipe everything because there
-- is no production data to preserve, and the old import layout (one clone per <owner>/<repo>
-- per user) doesn't map cleanly to the new layout (one clone per project_id). On-disk dirs
-- under `<userId>/repos/...` are left dangling for the operator to `rm -rf` separately.

-- ─────────── Projects gain repo-shape columns ───────────

ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "repo_kind" text NOT NULL DEFAULT 'none';
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "repo_local_path" text;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "default_branch" text;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "last_pulled_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "last_imported_at" timestamptz;
--> statement-breakpoint

-- ─────────── Wipe legacy repository data ───────────
--
-- Cascade trims branches, PRs, and PR checks via existing FKs. Connections survive (they're
-- per-user OAuth state, not per-repo). The on-disk dirs at <userId>/repos/<owner>/<repo>
-- are left dangling — they're the operator's problem to clean up.

DELETE FROM "repositories";
--> statement-breakpoint

-- ─────────── Enforce 1:1 between projects and repositories ───────────
--
-- A project can have at most one repository sidecar row. Partial unique index so projects
-- without a sidecar (the `repo_kind='none'` case) don't trip a NULL conflict.

DROP INDEX IF EXISTS "repositories_project_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "repositories_project_unique"
	ON "repositories" ("project_id") WHERE "project_id" IS NOT NULL;
