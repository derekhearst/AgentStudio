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

## Databases

The Postgres server holds one AgentStudio database per environment. Names follow one rule:
**`agentstudio<env>`, all lowercase**, so they never need quoting and can be told apart at a
glance.

| Database | Used by | Notes |
| --- | --- | --- |
| `agentstudioprod` | The live TrueNAS app `agentstudio` | Set through the app's `DATABASE_URL` environment variable. Can never be reset with `db:reset` or `db:bootstrap --reset`. |
| `agentstudiodev` | Local `bun run dev` and local Playwright runs | Holds the developer's own data as well as test data. The test suite only deletes rows whose names start with `E2E:`. |
| `agentstudio_ci` | GitHub Actions | A throwaway database in the CI job's own Postgres container, fresh on every run. |

Things worth knowing:

- **A typo creates a new, empty database.** On startup AgentStudio creates whatever database
  `DATABASE_URL` names if it does not exist yet. A misspelled name therefore comes up as a
  blank install that asks for setup, instead of failing. Every process logs
  `[db] Database ready (<name>)` at startup, so the log shows which database it is using.
- **Letter case matters.** Postgres treats `AgentStudio`, `AGENTSTUDIO` and `agentstudio` as
  three different databases, because AgentStudio quotes the name when it creates one. In SQL,
  a name that is not all lowercase has to be written in double quotes: an unquoted
  `DROP DATABASE AGENTSTUDIO` drops `agentstudio` instead. Keeping every name lowercase
  avoids the problem entirely.
- **Only dev, test and CI databases can be reset.** `bun run db:reset` and
  `bun run db:bootstrap --reset` refuse unless the name ends in `dev`, `test` or `ci`, and
  always refuse a name containing `prod`. They check before connecting to anything. There is
  no override: rename the database or use `psql` if a reset is really intended.
- **Older names.** Earlier versions of the app used `drokbot`, then `AGENTSTUDIO` (April 2026),
  then `AgentStudio`. Leftover databases with those names, and a lowercase `agentstudio`, may
  still exist on the server. Backing them up and removing them is tracked in GitHub issue #3.
  Inspect them with read-only `psql`; do not point the app at one "to take a look", because
  startup would try to migrate it.

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
2. Waits its turn: only one process migrates a given database at a time (see below).
3. Checks for a database that has tables but no migration history, and stops if it finds one
   it cannot safely handle (see "Databases without migration history").
4. Installs `pgcrypto` and `vector`.
5. Runs every pending migration via `drizzle-orm/postgres-js/migrator`.
6. Creates the owner account from `AUTH_PASSWORD` if there is none yet (see
   [`docs/auth/auth.md`](../auth/auth.md)), seeds built-in agents, registers job handlers and
   starts the job worker and scheduler (see [`docs/jobs/jobs.md`](../jobs/jobs.md)).

Drizzle decides what is "pending" by comparing the `when` timestamp of each journal entry
against the newest `created_at` already recorded in `drizzle.__drizzle_migrations`. Anything
with a newer timestamp runs; anything older is skipped. This is why journal timestamps must
only ever increase.

Startup never deletes data on its own. The one exception needs an explicit setting and is
described under "Databases without migration history".

### One process at a time

Several processes often start against the same database together: the web server and
`bun run worker`, or the dev server and the test server. Each used to apply the same new
migration at the same time, and the slower one failed on the tables and columns the faster
one had just created.

Now each process takes a Postgres advisory lock (a named lock that lives only as long as the
connection holding it) before step 3 and releases it after step 5. A second process logs
`Another process is migrating this database`, waits, and then finds nothing left to do. It
gives up with an error after ten minutes.

### When a migration fails

Every pending migration runs inside one transaction, so a failure leaves the database exactly
as it was. Startup stops with a message that names the database and the Postgres error. For
errors that usually mean schema drift (a missing or duplicate table, column, index or
constraint), the message also says what to do next. Nothing is dropped.

Earlier versions "recovered" from those errors by dropping every table and running the
migrations again, on any process that was not explicitly marked as production. That included
`bun run dev`, `bun run worker` and a production build started without `NODE_ENV`. A drift
error happens again on a freshly built schema, so the result was an empty database and the
same error.

### Databases without migration history

A database with tables but nothing recorded in `drizzle.__drizzle_migrations` is one of three
things: an AgentStudio database from before migrations existed, a restored backup that left
out the `drizzle` schema, or a database that belongs to something else. Startup treats them
the same way in every environment, production included:

| What the database holds | What happens |
| --- | --- |
| Nothing except Postgres extensions | A normal first start. The migrations build everything. |
| Anything AgentStudio does not recognise: another application's tables, or any view, function, standalone sequence, custom type or unfamiliar enum | Startup refuses and lists what it found. Nothing is changed. Give AgentStudio a database of its own. |
| Only AgentStudio's tables and enums, including its core tables (`users`, `conversations`, `messages`, `agents`, `skills`) | Startup refuses and explains, unless `DB_ALLOW_LEGACY_SCHEMA_RESET=1` is set. With that setting it drops the `public` and `drizzle` schemas and rebuilds them, deleting every row. Set it for one start, then remove it. |

"Recognised" means a table or enum name that appears in the Drizzle schema or in any migration
file, including names that later migrations removed. An empty `drizzle.__drizzle_migrations`
table on its own (left behind when a first-ever migration fails) does not count as existing
data.

If the database is a restore of an AgentStudio backup, do not use the setting. Restore the
`drizzle` schema as well: a `pg_dump` taken with `-n public` leaves it out.

### When startup cannot reach the database

Postgres is often still starting when the app starts, for example after the TrueNAS host
reboots. Startup retries connection failures with growing waits for about two and a half
minutes.

If startup still fails, or fails for any other reason, the app no longer pretends to be
healthy:

- The web server answers every request with an error until the problem is fixed. Thirty
  seconds after a failure, the next request triggers a fresh attempt, so the app recovers by
  itself once Postgres is back.
- `bun run worker` exits, so its container's restart policy tries again. It also exits if
  its job worker fails to start, rather than sitting idle.
- `bun run db:reset` and `bun run db:bootstrap` exit with an error code instead of reporting
  success.

`/api/health` also reports `jobWorker`: `running`, `disabled` (when `JOBS_WORKER_ENABLED=0`),
`pending` (until startup reaches the worker) or `failed`. A failed worker marks the deploy as
degraded (HTTP 503), because pages still load while queued memory mining, evaluations and
automations never run.

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

When that work happens, read the generated SQL carefully. `drizzle-kit` writes statements such
as `DROP INDEX "repositories_project_idx"` without `IF EXISTS`, and on a real database the
object usually does not exist under the name the schema expects. Such a migration fails at
startup. It stops the app with an explanation rather than damaging anything (see "When a
migration fails"), but it has to be edited to apply cleanly to existing databases.

## Local database commands

| Command | What it does |
| --- | --- |
| `bun run db:generate` | Diff the schema against the snapshot head and write a migration |
| `bun run db:check` | Validate the migration folder and snapshot chain |
| `bun run db:migrate` | Apply pending migrations to `DATABASE_URL` |
| `bun run db:studio` | Open Drizzle Studio |
| `bun run db:reset` | Drop the target database and rerun the full bootstrap. Only for names ending in `dev`, `test` or `ci`; never a name containing `prod` |
| `bun run db:bootstrap` | Run the bootstrap, then create the owner and the sandbox folder (see [`docs/auth/auth.md`](../auth/auth.md)). `--reset` drops the database first, under the same name rule as `db:reset` |

`db:check` needs its dialect and out-folder passed explicitly; `drizzle-kit check` misparses
`drizzle.config.ts` and reports a spurious AWS Data API error otherwise. The script in
`package.json` already does this.

Avoid `db:push` against any database you care about — it compares the live database to the
schema and will happily drop the undeclared indexes listed above.
