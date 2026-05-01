# Skills Spec

## Overview

A skill is a reusable markdown bundle that teaches an agent how to use a tool, execute a workflow, or apply domain knowledge — without bloating the base system prompt. Skills are the progressive disclosure mechanism for instructions. They load on demand, not on every turn. The skills domain manages creation, retrieval, versioning, and runtime loading of all skill content.

## Data Model

### `skills` table

| Column       | Type      | Description                                                            |
| ------------ | --------- | ---------------------------------------------------------------------- |
| `id`         | uuid      | Primary key                                                            |
| `slug`       | text      | Unique identifier, namespaced: `tools/fs-editing`, `workflow/fix-test` |
| `category`   | enum      | `tool`, `workflow`, `domain`, `policy`, `identity`, `hook`             |
| `title`      | text      | Human-readable display name                                            |
| `summary`    | text      | One or two sentences; injected into system prompts by default          |
| `content`    | text      | Full markdown body; loaded on demand via `read_skill`                  |
| `version`    | integer   | Monotonic version counter, incremented on every edit                   |
| `isActive`   | boolean   | Whether this skill is available for runtime loading                    |
| `sourceFile` | text?     | Path to a SKILL.md repo file that seeded this record, if any           |
| `createdBy`  | uuid?     | FK to `users` (null for system-seeded skills)                          |
| `createdAt`  | timestamp |                                                                        |
| `updatedAt`  | timestamp |                                                                        |

### `skill_files` table (optional companion files)

Some skills have associated files (code snippets, templates, reference docs).

| Column      | Type      | Description    |
| ----------- | --------- | -------------- |
| `id`        | uuid      | Primary key    |
| `skillId`   | uuid      | FK to `skills` |
| `name`      | text      | Filename       |
| `content`   | text      | File content   |
| `createdAt` | timestamp |                |

## Features

### Skill categories

#### Tool skills

Teach the model how to use a specific tool or capability group safely and effectively.

| Slug                      | Covers                                          |
| ------------------------- | ----------------------------------------------- |
| `tools/fs-editing`        | When and how to edit files; patch vs. replace   |
| `tools/run-verification`  | How to verify shell commands succeeded          |
| `tools/browser-debugging` | How to use browser tools without infinite loops |
| `tools/delegation`        | When and how to spawn sub-agents                |
| `tools/project-artifacts` | Creating, opening, and versioning artifacts     |
| `tools/memory-recall`     | How to phrase recall queries effectively        |

#### Workflow skills

Encode repeatable multi-step processes the model should follow.

| Slug                        | Covers                                            |
| --------------------------- | ------------------------------------------------- |
| `workflow/fix-failing-test` | Diagnose → patch → verify cycle for test failures |
| `workflow/review-pr`        | Structured code review checklist                  |
| `workflow/create-agent`     | How to scaffold a new agent definition            |
| `workflow/add-memory-bench` | How to run and interpret LongMemEval benchmarks   |

#### Domain skills

Project-specific knowledge loaded when the topic is relevant.

| Slug                          | Covers                                         |
| ----------------------------- | ---------------------------------------------- |
| `domain/agentstudio-runs`     | AgentStudio's run/session/task model           |
| `domain/agentstudio-projects` | How projects and artifacts work in AgentStudio |
| `domain/longmemeval`          | LongMemEval dataset structure and scoring      |

#### Policy and safety skills

Behavioral guardrails that apply across tools and workflows.

| Slug                       | Covers                                   |
| -------------------------- | ---------------------------------------- |
| `policy/destructive-ops`   | Rules for destructive file/db operations |
| `policy/approval-patterns` | When to ask for approval vs. proceed     |

#### Identity skills

System prompt bases for agent roles. Linked via `agents.identitySkillId`.

| Slug                           | Covers                                   |
| ------------------------------ | ---------------------------------------- |
| `system/orchestrator-identity` | Orchestrator persona and operating rules |
| `agent/<slug>/identity`        | Per-agent identity content               |

#### Hook skills

Skill-backed hook implementations. Named `hook/<event-name>`.

| Slug                    | Covers                                       |
| ----------------------- | -------------------------------------------- |
| `hook/after-run-notify` | Custom notification logic for run completion |
| `hook/memory-capture`   | Memory mining trigger on run completion      |

### Summary vs. full body loading

Every skill has a `summary` field and a `content` field. The runtime loads them differently:

| What                      | When                                                                       |
| ------------------------- | -------------------------------------------------------------------------- |
| `summary` (1–2 sentences) | Automatically, for all companion skills listed in `config.companionSkills` |
| Full `content`            | On demand, when the model calls `read_skill(slug)` or a hook forces it     |

The model calls `read_skill` when it needs the full operating guide. This keeps initial context lean.

### `read_skill` tool

Available whenever the `skills` capability group is enabled:

```
read_skill(slug: string) → Returns the full content of the skill
list_skills(category?: string) → Returns all active skills with their summaries
```

### Skill editor UI

`/skills` — paginated list of all skills grouped by category, with search.
`/skills/[slug]` — full-page markdown editor for the skill content and summary. Saving increments `version` and takes effect on the next skill load.
`/skills/new` — create a skill with a slug, category, summary, and body.

### Repo file boot loader

On startup, AgentStudio scans for `SKILL.md` files in the repo (configurable scan paths, e.g., `docs/**`). Each file's YAML frontmatter declares the slug and category; the body becomes the content. Existing DB records are upserted if the file's slug matches.

```yaml
---
slug: tools/fs-editing
category: tool
title: Filesystem Editing
summary: Teaches the agent when to use file_patch vs. file_replace and how to verify edits succeeded.
---
```

Priority: controlled by `SKILL_SOURCE_PRIORITY=repo|db` (default: `db`).

### Companion skill requirement for new capability groups

When a new capability group is added to the system, a companion tool skill for that group is required before the group is considered "complete." This is enforced by convention and checked in CI.

### Hook-backed skills

Skill slugs starting with `hook/` are treated as hook implementations. When a hook fires for the matching event, the skill body is submitted as a prompt to a lightweight subagent that executes it and returns output to `hook_invocations`.

## Behavior Contracts

- `skills.slug` is unique and immutable after creation. Renaming a slug creates a new skill; the old slug remains available.
- Editing a skill body increments `version` and takes effect on the next runtime load; it does not affect in-progress runs.
- A skill with `isActive = false` is not returned by `list_skills` and is not loaded by the runtime.
- Identity skills cannot be deleted while linked to an active agent; they must be unlinked first.
- `summary` is required and must be ≤200 characters. This is enforced on save.
- Skills are not versioned with immutable history (unlike artifact versions). The `version` counter tracks how many times the skill was edited; old content is not retained.

## Roles & Permissions

| Action             | Who can do it             |
| ------------------ | ------------------------- |
| View skills        | Authenticated user        |
| Read skill content | Authenticated user        |
| Create a skill     | Authenticated user, admin |
| Edit a skill       | Owner user, admin         |
| Delete a skill     | Admin only                |
| View system skills | Admin only (edit)         |

## References

- [Skills Are Harness Engineering You Can Do in a Markdown File — ikangai](https://www.ikangai.com/skills-are-harness-engineering-you-can-do-in-a-markdown-file) — central framing
- [Claude Code CLAUDE.md and SKILL.md conventions — Anthropic](https://www.anthropic.com/engineering/claude-code-best-practices) — progressive disclosure of instructions
- [DeerFlow 2.0 — ByteDance](https://github.com/bytedance/deer-flow) — on-demand skill loading
- [Everything Claude Code](https://github.com/affaan-m/everything-claude-code) — skills/instincts patterns
- [The Anatomy of an Agent Harness — LangChain](https://blog.langchain.com/the-anatomy-of-an-agent-harness/) — skills as progressive disclosure primitive
- **Internal:** `src/lib/skills/`, `src/lib/skills/skills.schema.ts`, `src/lib/skills/skills.server.ts`, `src/routes/skills/`
