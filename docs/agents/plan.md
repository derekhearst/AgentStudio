# Agents Plan

Status: active

## Overview

`ORCHESTRATOR_IDENTITY` is a TypeScript constant ([src/lib/agents/orchestrator.ts](../../src/lib/agents/orchestrator.ts)). Agent system prompts live in the `agents` table but are only editable through a single textarea. There is no `AGENTS.md` boot loader and no way to version-control or reuse prompt fragments. Move all prompts into editable artifacts (skills + optional repo files) so the harness becomes its own system of record. After the Structure refactor, prompt composition lives in `src/lib/agents/identity.server.ts` (records-only `agents/` folder) and is consumed by `src/lib/runtime/definition.server.ts`. Companion skills should also become the place where tool-usage guidance and repeatable workflows live, rather than bloating agent identity prompts.

> **Depends on:** `docs/structure/plan.md` Steps 5–6 (runtime/ created, agents/ slimmed), `docs/skills/plan.md` (skill taxonomy + loading rules), `docs/tools/plan.md` (companion skills for capability groups).

> **See also:** [spec.md](spec.md) — full feature spec, data model, and behavior contracts.

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

Identity prompts should stay short. Detailed operating guidance for tools, workflows, and verification belongs in companion skills that runtime loads progressively.

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

### Phase 6 — Companion skill bundles for agents

- Define which companion skills each agent should suggest or auto-load by role.
- Example: coding agents prefer `tools/fs-editing`, `tools/run-verification`; evaluator agents prefer read-only review skills.
- Keep identity prompt stable while operational guidance evolves in separate skills.

## Files to create / modify

- `src/lib/runtime/definition.server.ts` — read identity from skill (was `agents/orchestrator.ts`)
- `src/lib/agents/agents.schema.ts` — `identitySkillId` column
- `src/lib/agents/identity.server.ts` (new) — composition + seeders
- `src/lib/skills/skills.server.ts` — boot seeder hook
- `src/lib/skills/skills.schema.ts` — support skill metadata needed for role/capability matching if missing
- `src/routes/agents/[id]/identity/+page.svelte` (new)
- `src/lib/agents/agent-source-loader.server.ts` (new) — `AGENTS.md` scan
- `src/hooks.server.ts` — kick off scanner on boot
- `docs/agents/agents.md` (domain doc once shipped)

## Migration / backward-compat

- Drizzle migration adds `identitySkillId` nullable.
- Backfill copies existing `agents.systemPrompt` into a new skill and links it.
- After a release, deprecate direct edits to `systemPrompt` (read-only, sourced from skill).

## Verification

- Edit orchestrator skill in UI → next chat uses new identity without restart.
- Drop an `AGENTS.md` in repo → boot scan upserts agent → visible in `/agents`.
- E2E: agent prompt change persists across restarts and matches skill content.
- Agent role regression: coding agent loads companion tool-skill summaries without inflating the base identity prompt.

### Phase 7 — Conversation Modes

Modes are session-level behavioral contracts. A mode governs the orchestrator's cognitive stance — how much it assumes, how collaborative vs. autonomous it is, which tools are available, and which companion skills auto-load. The mode's identity prompt is stored as a skill (editable), but the mode itself is a configuration bundle, not a skill.

**Four modes:**

| Mode       | Posture                                                                             | Assumption level             | Primary tools              |
| ---------- | ----------------------------------------------------------------------------------- | ---------------------------- | -------------------------- |
| `chat`     | Conversational partner — answers directly, minimal tool use                         | Low                          | core only                  |
| `research` | Skeptical investigator — surfaces uncertainty, cites sources, challenges premises   | Minimal — asks before acting | web, memory, read-only     |
| `plan`     | Structured proposer — proposes before executing, validates scope explicitly         | Medium — confirms intent     | plan tools, no write tools |
| `agent`    | Autonomous executor — proceeds on best interpretation, interrupts only for blockers | High — acts on judgment      | all tools                  |

**Key design rule:** A mode is not a skill. A mode's identity prompt is stored as a skill (so it's editable without code changes), but the mode bundles more than a prompt — it also carries tool policy and auto-loaded companion skills.

#### 7.1 Seed system mode identity skills

On boot, seed four skills if not present:

- `system/mode-chat` — collaborative conversationalist, Karpathy "Think Before Coding" principles, pushback license
- `system/mode-research` — skeptical investigator, always cites uncertainty, asks before proceeding, no write tools
- `system/mode-plan` — structured proposer, Karpathy full four principles, proposes plan with success criteria before any execution
- `system/mode-agent` — heads-down executor, minimal interruptions, still flags genuine blockers

Each skill is editable from the Skills UI — changing it changes the mode's behavior on the next turn, no redeploy.

#### 7.2 Add `mode` to `conversations`

```sql
ALTER TABLE conversations ADD COLUMN mode text NOT NULL DEFAULT 'chat'
  CHECK (mode IN ('chat', 'research', 'plan', 'agent'));
```

#### 7.3 Mode-aware identity loading in stream server

In `buildSystemPrompt`, load the mode identity skill instead of the hardcoded `ORCHESTRATOR_IDENTITY`:

```ts
const modeSkillName = `system/mode-${conversation.mode}`
const modeIdentity = (await loadSkillByName(modeSkillName)) ?? ORCHESTRATOR_IDENTITY_FALLBACK
```

Tool filtering also reads from the mode: research mode removes all write tools; plan mode removes execute tools but keeps plan tools.

#### 7.4 Mode switch anchor message

When the user switches mode mid-conversation, inject a system message as a semantic anchor:

```
[Mode switched: plan → agent]
Prior research and plan decisions are in the conversation above.
You are now in agent mode: execute the approved plan, surface blockers, minimize interruptions.
```

This tells the model its posture changed without requiring it to re-read everything.

#### 7.5 Mode selector in chat UI

See `docs/chat/spec.md` — mode selector lives in the composer. Default mode from `chatWorkbenchPreferences.defaultMode`.

#### 7.6 Update files

- `src/lib/agents/orchestrator.ts` — mode-aware identity loading
- `src/lib/chat/chat.schema.ts` — `mode` column on `conversations`
- `src/lib/agents/identity.server.ts` — `loadModeIdentity(mode, userId)` function
- `src/lib/skills/skills.server.ts` — boot seeder for four mode skills
- `src/routes/chat/[id]/stream/+server.ts` — pass mode to identity loader, filter tools by mode
- `drizzle/` — migration for `conversations.mode`

## Out of scope

- Git commits triggered by agents (a future "agent-as-author" feature).
- Multi-language prompt support.
- Prompt A/B testing (separate eval-tooling doc later).
- Per-user custom modes beyond the four system modes (post-v1).

## Rewrite Authority

The current implementation is a baseline, not a constraint. This domain may be rewritten, restyled, reorganized, or replaced as needed to achieve the target product quality. No code path is off-limits if behavior contracts, safety controls, tests, and documentation remain correct.

## UI Contract

Implementation in this domain must comply with [../ui/plan.md](../ui/plan.md) and [../ui/spec.md](../ui/spec.md), with explicit agent identity UX criteria.

- Desktop: mode presets, instruction previews, and skill attachments must be editable in one flow.
- Mobile: identity edits should be chunked into short sections with explicit confirmation.
- Blocking flows: policy-invalid agent configurations must prevent save and explain required fixes.
- Visual QA: mode selector states, profile editor forms, and skill attachment chips are snapshot-covered.

## Completion

- Template: YYYY-MM-DD - Completed in <PR/commit> - <one-line outcome>
- Pending.
