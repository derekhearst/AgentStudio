# Background Jobs

## Overview

Some work should not happen while a person waits for a page to load: running a scheduled automation, researching a question, memorizing a conversation, polling a pull request's CI, cleaning up old workspaces. AgentStudio puts that work on a **job queue** — a table of to-do items in the database — and a **worker** inside the server picks items off it one at a time and runs them.

Because the queue lives in the database, work survives a restart: a job queued before a deploy is still there after it. Every job's outcome is visible to the operator at **Settings → Jobs** (`/settings/jobs`).

This page describes how the queue behaves. The full data model is in [spec.md](spec.md); the build history is in [plan.md](plan.md).

## Key concepts

| Concept | What it means |
| --- | --- |
| **Job** | One piece of work, such as "run automation X" or "mine conversation Y". It has a type, a priority, a status, and the data the work needs. |
| **Status** | Where the job is in its life: `pending` (waiting), `leased` (a worker has picked it up), `running`, `retry_wait` (failed, will be tried again later), and the finished states `completed`, `failed`, `canceled`. |
| **Worker** | The loop that claims the next job and runs it. Every server process runs one, unless told not to. |
| **Lease** | A worker's claim on a job, valid for a couple of minutes and renewed every forty seconds or so while the work runs (a "heartbeat"). If the heartbeats stop, the lease lapses. |
| **Scheduler** | Queues the recurring jobs: the automation dispatcher every minute, the monitor dispatcher every minute, PR CI polling every few minutes, workspace cleanup daily, and so on. |
| **Dedupe key** | A label on a job that stops the same work being queued twice. See **Business rules**. |

## User flows

### A recurring job

1. Every minute, the scheduler queues an "automation dispatch" job.
2. The worker runs it. The dispatcher looks for automations that are due and queues one "automation run" job for each.
3. The worker runs each automation. When it succeeds, the automation's next run time moves forward.
4. A minute later the scheduler queues the next dispatch job, and the cycle repeats.

The same pattern drives monitor checks, PR CI polling and workspace cleanup.

### When a worker dies mid-job

1. A deploy, a crash or an out-of-memory kill stops the server while a job is running. Its heartbeats stop.
2. About two minutes later the job's lease lapses.
3. The next worker to look for work finds the job and runs it again, counting it as a new attempt.
4. Two exceptions. If the job has already used all its attempts, the handler is probably what is killing the server, so the job is marked **failed** instead of being handed to another worker, and a **Job stuck** item appears in the Review inbox. And if the lease lapsed more than an hour ago — a server that was off overnight — the job is marked failed rather than re-run against a world that has moved on. Those leftovers are recorded on the job itself (its error in `/settings/jobs` says what happened) rather than in the inbox, because a server coming back after a long gap can find dozens of them at once.

### Stopping a standalone worker

A deployment can run workers as separate processes (`bun run worker`) next to the web server. When such a process is asked to stop:

1. It stops the scheduler and stops picking up new jobs.
2. It waits for the job it is running to finish — up to 25 seconds by default.
3. It exits. If the job was still running at the deadline, it is abandoned; its lease lapses and another worker picks it up, as above.

Pressing Ctrl+C a second time exits immediately.

## Roles and permissions

| Action | Who |
| --- | --- |
| See every job, its status, attempts and last error (`/settings/jobs`) | Any signed-in user (AgentStudio is single-user) |
| Queue a job | The application itself; users queue jobs indirectly by pressing buttons such as **Run now** or **Mine pending** |
| Configure the worker | The operator, through environment variables (below) |

## Integrations

- **PostgreSQL** holds the queue. Workers claim jobs with a row lock that skips rows another worker already holds, so any number of workers can share one database without two of them picking up the same job at once. A job can still run twice: if its worker stops heartbeating — usually because it died, but a database outage longer than the lease does the same — another worker takes the job over (see **When a worker dies mid-job**).
- **Review inbox** — a job that fails for good opens a *Job failure* item; a job whose worker kept dying until it ran out of attempts opens a *Job stuck* item.
- **Metrics** — every finished job records its duration and outcome for the health dashboard.

## Business rules

### Dedupe: once while queued, or once ever

Most jobs carry a dedupe key. What it prevents depends on the job:

- **By default, a key only blocks a duplicate while the first job is still waiting or running.** If the automation dispatcher is already queued, the next minute's tick does not queue a second one. Once it has run, the key is free and the next tick queues a new one.
- **Some work must happen at most once, ever.** One run per automation time slot, one evaluation per chat run, one metrics sample per five-minute window, one "Fix it" run per failed-CI review item. These keys block a duplicate even after the first job has finished.

Until September 2026 every key behaved like the second kind. Since nothing deletes finished jobs, each recurring job with a fixed key ran exactly once for the life of the database: scheduled automations, monitor checks, PR CI polling, and memory mining all silently stopped after their first run.

A request that arrives while a matching job is already **running** folds into that job too — and a running job may have read its input before the request's data existed. Memory mining is the case that matters: a job mining a conversation keeps its key until the conversation has nothing left to mine, going round again if an exchange finished while it worked, and gives the key back (with its own id appended, so `/settings/jobs` still shows what it was) in the same step as that final check. After that, the next exchange gets a job of its own.

### An automation slot that the queue gave up on is skipped

Each scheduled run of an automation gets exactly one job. When an attempt fails, the automation queues its next attempt as a separate job and links to it, so a scheduled run can be a short chain of jobs. If the queue itself gives up on any job in that chain — the worker running it kept dying, its lease lapsed during a long outage, or someone canceled it from `/settings/jobs` — the automation's own failure handling never ran, so nothing moved its schedule on. The dispatcher follows the chain to its newest job, sees that nothing is left to run while the automation is still due, and skips that slot. The automation carries on from its next scheduled time.

### Worker configuration

These environment variables configure every worker, the web server's included. All are optional.

| Variable | What it does | Default |
| --- | --- | --- |
| `JOBS_WORKER_ENABLED` | `0` runs no worker (and no scheduler) in this process | on |
| `JOBS_SCHEDULER_ENABLED` | `0` runs no scheduler in this process. With several workers, only one should run the scheduler | on |
| `JOBS_WORKER_QUEUES` | Comma-separated queues this worker takes jobs from, e.g. `maintenance` | every queue |
| `JOBS_WORKER_TYPES` | Comma-separated job types this worker runs. Types it has no handler for are ignored | every type |
| `JOBS_WORKER_POLL_MS` | How long an idle worker waits before looking again | 2000 |
| `JOBS_WORKER_LEASE_MS` | How long a lease lasts without a heartbeat (minimum 5000) | 120000 |
| `JOBS_WORKER_ID` | The worker's name in the lease history | host name plus a random suffix |
| `JOBS_WORKER_DRAIN_MS` | How long a standalone worker waits for its running job when asked to stop | 25000 |

### Development note

In development, editing a schema file or a job handler makes the dev server reload the database module. Each reload now reuses the same database connection pool and stops the previous worker and scheduler before starting new ones, so edits to a job handler take effect and connections do not pile up.
