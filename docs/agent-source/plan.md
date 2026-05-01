# Agent Source — Prompts as Editable Artifacts Plan

## Overview

`ORCHESTRATOR_IDENTITY` is a TypeScript constant ([src/lib/agents/orchestrator.ts](../../src/lib/agents/orchestrator.ts)). Agent system prompts live in the `agents` table but are only editable through a single textarea. There is no `AGENTS.md` boot loader and no way to version-control or reuse prompt fragments. Move all prompts into editable artifacts (skills + optional repo files) so the harness becomes its own system of record.

## Why this matters (harness principles)

- **Repository knowledge is the system of record.** OpenAI's first principle.
- **AGENTS.md is a table of contents, not an encyclopedia.**
- **Skills are harness engineering you can do in a markdown file.** ikangai's framing.
- **The harness must evolve with the model.** Editable prompts = editable harness.

## Reference repos & articles

- [agents.md](https://agents.md/) — open standard for project-level agent instructions
- [AGENTS.md — OpenAI](https://openai.com/index/introducing-agents-md/)
- [GitAgent](https://github.com/open-gitagent/gitagent) — `agent.yaml` + `SOUL.md` + `RULES.md`
- [Spec Kit — GitHub](https://github.com/github/spec-kit) — generates structured specs
- [Skills Are Harness Engineering You Can Do in a Markdown File — ikangai](https://www.ikangai.com/skills-are-harness-engineering-you-can-do-in-a-markdown-file)
- [Compound Engineering Plugin](https://github.com/EveryInc/compound-engineering-plugin) — cross-agent unified harness interface

## Current state in AgentStudio

- Orchestrator identity hard-coded in [orchestrator.ts](../../src/lib/agents/orchestrator.ts).
- Agent system prompts: single text column, edited via [src/routes/agents/[id]/+page.svelte](../../src/routes/agents).
- Skills system already exists ([src/lib/skills](../../src/lib/skills)) — parent skill + files, ideal substrate for prompt fragments.
- No `AGENTS.md` discovery.
- Per-prompt edits require a deploy if they live in TS.

## Target design

### Promote prompts to skills

- Orchestrator identity → a `system/orchestrator-identity` skill (auto-seeded on first boot).
- Each agent's system prompt → either:
  - A skill named `agent/<slug>/identity` with one or more files, OR
  - A direct foreign key `agents.identitySkillId` referencing a skill.
- Composition: agent prompt = `identity` skill content + role + policies + tools summary, assembled at runtime.

### `AGENTS.md` boot loader (optional)

On startup (or admin trigger), scan repo root + `docs/agents/`:

- `AGENTS.md` → upserts/overrides the orchestrator identity.
- `docs/agents/<slug>/AGENT.md` → upserts the agent definition for `<slug>`.

YAML frontmatter:

```yaml
---
name: Codex Worker
role: Coding agent for refactor tasks
model: anthropic/claude-sonnet-4
capabilityGroups: [core, sandbox, skills]
---
```

Last-write-wins between DB and repo controlled by `AGENT_SOURCE_PRIORITY=repo|db`.

### Live editor UI

`/agents/[id]/identity` route opens a markdown editor backed by the linked skill. Save → updates skill → next run picks up the change without redeploy.

### Composition order at runtime

1. Identity skill content
2. Role description (`agents.role`)
3. Active task spec (if attached)
4. Skill summaries (existing pattern)
5. Tool usage policies (auto)
6. Capability groups summary (auto)

## Implementation steps (phased)

### Phase 1 — Move orchestrator identity into a skill

- Seeder creates `system/orchestrator-identity` skill with current TS string.
- `buildOrchestratorPrompt` reads from skill; falls back to TS constant if missing.

### Phase 2 — Link agents to identity skills

- Add `agents.identitySkillId` (uuid, nullable).
- New agent flow creates a paired skill.
- Existing agents: migration copies `systemPrompt` into a new skill and links it.

### Phase 3 — Markdown editor route

- `/agents/[id]/identity` — markdown editor + preview.
- Backed by skill remote functions.

### Phase 4 — `AGENTS.md` discovery

- Boot scanner reads repo root + `docs/agents/`.
- Upserts agents/skills with priority flag.

### Phase 5 — Prompt fragment library

- Reusable fragments (e.g., "tool usage policy", "approval policy") as skills.
- Identity skill can `@import` fragments by name.

## Files to create / modify

- `src/lib/agents/orchestrator.ts` — read identity from skill
- `src/lib/agents/agents.schema.ts` — `identitySkillId` column
- `src/lib/agents/identity.server.ts` (new) — composition + seeders
- `src/lib/skills/skills.server.ts` — boot seeder hook
- `src/routes/agents/[id]/identity/+page.svelte` (new)
- `src/lib/agents/agent-source-loader.server.ts` (new) — `AGENTS.md` scan
- `src/hooks.server.ts` — kick off scanner on boot
- `docs/agent-source/agent-source.md` (domain doc once shipped)

## Migration / backward-compat

- Drizzle migration adds `identitySkillId` nullable.
- Backfill copies existing `agents.systemPrompt` into a new skill and links it.
- After a release, deprecate direct edits to `systemPrompt` (read-only, sourced from skill).

## Verification

- Edit orchestrator skill in UI → next chat uses new identity without restart.
- Drop an `AGENTS.md` in repo → boot scan upserts agent → visible in `/agents`.
- E2E: agent prompt change persists across restarts and matches skill content.

## Out of scope

- Git commits triggered by agents (a future "agent-as-author" feature).
- Multi-language prompt support.
- Prompt A/B testing (separate eval-tooling doc later).
