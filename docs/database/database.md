# Database & Migrations

## Overview

AgentStudio stores everything in a single PostgreSQL database (with the `pgcrypto` and
`vector` extensions). The shape of that database is described twice, in two places that
must agree:

1. **The Drizzle schema** — TypeScript files at `src/lib/{domain}/*.schema.ts`. This is the
   source of truth the application code reads and writes through.
2. **The migration chain** — numbered SQL files in `drizzle/`, replayed in order to build a
   database from nothing.

`drizzle-kit generate` is the tool that keeps those two in sync: it compares the TypeScript
schema against a recorded *snapshot* of "what the migrations have built so far" and writes a
new SQL migration for the difference. When that tool works, a schema change that never made
it into SQL gets caught immediately. When it doesn't work, the two drift apart silently.

## Key concepts

| Thing | Where | What it is |
| --- | --- | --- |
| Schema modules | `src/lib/**/*.schema.ts` | Table/column/index definitions in TypeScript |
| Migrations | `drizzle/NNNN_name.sql` | Ordered SQL applied to build or upgrade a database |
| Journal | `drizzle/meta/_journal.json` | The ordered list of migrations and their timestamps |
| Snapshots | `drizzle/meta/NNNN_snapshot.json` | Point-in-time pictures of the schema, used only by `drizzle-kit generate` |

The important distinction: **the runtime migrator only reads the journal and the `.sql`
files.** Snapshots are consumed exclusively by `drizzle-kit generate`. Deleting, adding, or
rewriting a snapshot cannot change what happens when a database is migrated.

## How migrations are applied

The application migrates itself at boot — there is no separate deploy step.
`src/lib/db/bootstrap.server.ts` runs on server start and:

1. Creates the target database if it does not exist.
2. Resets the app schemas if the database has AgentStudio tables but no recorded migration
   history (legacy unmanaged state).
3. Installs `pgcrypto` and `vector`.
4. Runs every pending migration via `drizzle-orm/postgres-js/migrator`.
5. Seeds built-in agents and registers job handlers.

Drizzle decides what is "pending" by comparing the `when` timestamp of each journal entry
against the newest `created_at` already recorded in `drizzle.__drizzle_migrations`. Anything
with a newer timestamp runs; anything older is skipped. This is why journal timestamps must
only ever increase.

## Adding a schema change

1. Edit the relevant `src/lib/{domain}/*.schema.ts`.
2. Run `bun run db:generate`. Drizzle writes a new `drizzle/NNNN_*.sql`, a matching
   `drizzle/meta/NNNN_snapshot.json`, and appends a journal entry with a real timestamp.
3. Read the generated SQL. If it is destructive or needs a data backfill, edit it — but keep
   the generated snapshot and journal entry.
4. Run `bun run db:check` to confirm the migration folder is still internally consistent.

**Do not hand-write migrations and hand-edit the journal.** That is what broke the tooling
before (see below). If a migration genuinely cannot be expressed in the Drizzle schema —
a partial index, a data backfill, a one-off `UPDATE` — generate an empty migration and fill
it in, so the snapshot chain still advances.

## The 2026 snapshot rebaseline

For a long stretch of this repo's history, migrations were hand-written and journal entries
were hand-edited with invented timestamps. Two things rotted as a result:

- `drizzle/meta/0026_snapshot.json` through `0040_snapshot.json` were byte-identical copies
  of `0025_snapshot.json`. Sixteen files claimed the same parent, which `drizzle-kit` rejects
  as a collision — so `bun run db:generate` refused to run at all.
- No snapshots were ever written for `0041`–`0064`, so even without the collision the newest
  snapshot described the schema as it stood 39 migrations ago.

The repair **rebaselined the snapshot head** rather than trying to reconstruct 39 snapshots
that were never taken:

- The 15 duplicate snapshots were deleted.
- A single accurate snapshot, `drizzle/meta/0064_snapshot.json`, was generated from the
  current TypeScript schema and linked to `0025_snapshot.json` as its parent.
- Every `.sql` migration and every journal entry was left untouched.

Consequences to know about:

- **All 65 migrations remain and remain replayable.** A fresh database still builds itself by
  running `0000` through `0064` in order.
- **No deployed database is affected.** Snapshots are not read by the migrator.
- **Snapshots `0026`–`0063` do not exist.** `drizzle-kit` tolerates gaps (this repo already
  had one at `0009`/`0010`), but it means you cannot ask Drizzle to diff two historical
  points inside that range. History before `0026` and the head at `0064` are intact.

## Known schema drift

Because `generate` was unusable for 39 migrations, the hand-written SQL and the TypeScript
schema fell slightly out of step. A fresh replay of the chain produces a database whose
tables and columns match the schema exactly — but with these extras and omissions:

| Object | State | Origin |
| --- | --- | --- |
| `memory_chunks` table | In the database, not in any schema module | `0010_chunked_museum.sql`; unreferenced by any code |
| `chat_runs_active_updated_idx` | In the database, not in the schema | `0046` — deliberate partial index |
| `messages_conv_seq_uniq` | In the database, not in the schema | `0047` |
| `conversations_project_idx` | In the database, not in the schema | `0035` |
| `agents_identity_skill_idx` | In the database, not in the schema | `0039` |
| `skills_category_idx` | In the database, not in the schema | `0054` |
| `repositories_project_unique` | Unique index in the database; the schema declares a plain `repositories_project_idx` | `0060` |
| `job_policies` unique on `job_type` | Postgres-generated name `..._key`; Drizzle expects `..._unique` | early migration |
| `chat_workbench_preferences` FK on `default_agent_id` | Postgres-generated name `..._fkey`; Drizzle expects `..._agents_id_fk` | early migration |

None of these are column-level differences and none affect application behaviour today, but
they mean `bun run db:push` would propose destructive changes. Closing the gap requires both
schema declarations and a migration, so it is tracked separately rather than bundled into the
tooling repair.

## Local database commands

| Command | What it does |
| --- | --- |
| `bun run db:generate` | Diff the schema against the snapshot head and write a migration |
| `bun run db:check` | Validate the migration folder and snapshot chain |
| `bun run db:migrate` | Apply pending migrations to `DATABASE_URL` |
| `bun run db:studio` | Open Drizzle Studio |
| `bun run db:reset` | Drop the target database and rerun the full bootstrap |

`db:check` needs its dialect and out-folder passed explicitly; `drizzle-kit check` misparses
`drizzle.config.ts` and reports a spurious AWS Data API error otherwise. The script in
`package.json` already does this.

Avoid `db:push` against any database you care about — it compares the live database to the
schema and will happily drop the undeclared indexes listed above.
