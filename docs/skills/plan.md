# Skills System Plan

## Overview

AgentStudio already has a `src/lib/skills/` domain, but it does not yet have a matching product plan that defines what skills are for, how they relate to tools, or how they protect the context window. Add a first-class Skills plan so every new capability group or non-trivial tool ships with reusable guidance on when to use it, how to use it, and how to verify the result.

> **Depends on:** `docs/structure/plan.md` (`skills/`, `tools/`, `runtime/`), `docs/tools/plan.md` (progressive tool disclosure), `docs/agents/plan.md` (identity + prompt composition), `docs/hooks/plan.md` (hook-backed workflows).

> **See also:** [spec.md](spec.md) — full feature spec, data model, and behavior contracts.

## Why this matters

- **Skills are progressive disclosure for instructions.** They let the harness load specific knowledge only when relevant.
- **Tools without usage guidance are noisy.** The model needs more than a schema; it needs operating patterns.
- **Context rot is partly an instruction problem.** Repeating long tool guidance every turn wastes budget.

## Research findings

### Claude Code / Anthropic

- Anthropic recommends keeping broad always-on instructions short (`CLAUDE.md`) and moving task-specific or domain-specific guidance into `SKILL.md` files loaded on demand.
- Skills can encode domain knowledge or repeatable workflows.
- Subagents can get narrow tool sets and their own skill-specific context.
- Anthropic explicitly frames context as a scarce resource; skills help avoid bloating startup context.

### LangChain harness research

- The harness should include tools, skills, MCPs, hooks, and context engineering as separate primitives.
- Skills are a progressive disclosure primitive that reduce context rot when many tools or MCP servers exist.
- Tool outputs should be offloaded or summarized after use; raw output does not always belong in the live model context.

### Aider / OpenCode / Cline / Continue patterns

- Aider succeeds with a smaller active tool surface and strong conventions around file scope.
- OpenCode exposes a small set of agent modes (`build`, `plan`) rather than a huge per-turn tool list.
- Cline and Claude Code both lean on reusable repo instructions, skill-like fragments, and tool-specific conventions.
- Continue increasingly uses markdown-driven reusable checks and rules rather than treating every behavior as a custom tool.

## Target design

### What a skill is

A skill is a reusable markdown bundle that answers one of these questions:

1. **When should I use this tool or capability?**
2. **How should I use it safely and effectively?**
3. **How do I verify that it worked?**
4. **What should I avoid doing with it?**

### Skill categories

#### 1. Tool skills

Explain how to use one tool or one capability group.

Examples:
- `tools/fs-editing`
- `tools/browser-debugging`
- `tools/run-tests`
- `tools/project-artifacts`

These are the missing pieces the current plan set implies but does not define.

#### 2. Workflow skills

Encode repeatable multi-step flows.

Examples:
- `workflow/fix-failing-test`
- `workflow/review-pr`
- `workflow/create-agent`
- `workflow/add-memory-bench`

#### 3. Domain skills

Project-specific knowledge loaded when relevant.

Examples:
- `domain/agentstudio-runs`
- `domain/agentstudio-projects`
- `domain/longmemeval`

#### 4. Policy / safety skills

Human-readable usage rules that complement runtime enforcement.

Examples:
- `policy/tool-approvals`
- `policy/artifact-editing`
- `policy/memory-privacy`

### Tool-to-skill contract

Every non-trivial tool or capability group should have at least one companion skill.

| Tool / group | Companion skill requirement |
|---|---|
| `fs` / sandbox tools | how to inspect first, patch safely, verify changes |
| `shell` | how to scope commands, read output, rerun verification |
| `browser` | how to compare screenshots/logs and avoid noisy browsing |
| `skills` | how to search/select/apply skills |
| `agents` | how to delegate and what not to delegate |
| `projects` / `artifacts` | when to edit existing artifact vs create new |
| `memory` | when to recall, when to mine, what not to store |

### Recommended skill frontmatter

```md
---
name: tools/fs-editing
description: Safe file inspection and edit workflow for coding tasks
when_to_use:
  - editing files
  - investigating code paths
  - applying targeted patches
capability_groups:
  - sandbox
suggested_tools:
  - read
  - search
  - patch
  - run_in_terminal
verification:
  - run targeted test or check after edit
avoid:
  - loading many unrelated files
  - rewriting whole files for small changes
---
```

### Runtime behavior

1. Agent starts with short always-on instructions only.
2. Runtime exposes only default capability groups.
3. If the agent enables a capability group or expresses intent matching a skill trigger, runtime can:
   - suggest relevant skills, or
   - load a short skill summary into context.
4. Full skill content is loaded only when chosen or clearly relevant.

This makes skills the instruction analogue of progressive tool disclosure.

## Context strategy around tools and skills

### Three-layer context model

#### Layer 1 — Live context

What the model sees now:
- current user turn
- active task/run state
- short tool definitions for active tools only
- current skill summaries
- compact recent tool observations

#### Layer 2 — Session log

What is durably stored but not always injected:
- full tool outputs
- run events
- approval events
- artifact/version events
- summaries/checkpoints

#### Layer 3 — Retrieval surfaces

What can be recalled on demand:
- memory drawers
- artifact history
- prior run summaries
- raw tool output handles or stored files
- skill bodies and companion examples

### Tool output policy

For larger outputs, do not keep the full payload in live context indefinitely.

Default behavior:
1. Keep full tool result in immediate observation for the next reasoning step when small.
2. If result exceeds threshold, keep:
   - short summary
   - head excerpt
   - tail excerpt
   - pointer/handle to full output stored in session log or workspace file
3. Allow the model to explicitly re-open the full output later.

This follows the same pattern described in Anthropic and LangChain harness guidance.

### Skill output policy

Skill content should also be layered:
- summary first
- detailed body on demand
- examples only when needed

A skill should not dump an entire tutorial into context on first load.

## Files to create / modify

- `src/lib/skills/skills.schema.ts` — add frontmatter fields if missing (`whenToUse`, `capabilityGroups`, `suggestedTools`, `verification`, `avoid`)
- `src/lib/skills/skills.server.ts` — trigger matching, summary extraction, tool-to-skill lookup
- `src/lib/skills/skills.remote.ts` — UI query for browsing and invoking skills
- `src/lib/skills/index.ts` — barrel updates
- `src/lib/tools/tools.ts` — optional mapping from tools/capability groups to companion skills
- `src/lib/runtime/definition.server.ts` — compose skill summaries into prompt only when relevant
- `src/lib/runtime/loop.server.ts` — context policy for loading skill summaries/full bodies
- `src/routes/skills/+page.svelte` (new) — skills browser and authoring surface
- `src/routes/skills/[id]/+page.svelte` (new) — skill detail, linked tools, usage examples
- `docs/skills/skills.md` (new domain doc once shipped)

## Phases

### Phase 1 — Define the skill model

1. Formalize skill metadata/frontmatter.
2. Distinguish summary vs full body.
3. Add companion-skill mapping for tool groups.

### Phase 2 — Skills browser and authoring

1. Add docs/UI surface for browsing skills.
2. Show linked tools and linked capability groups.
3. Let users edit or seed project-specific skills.

### Phase 3 — Runtime loading

1. Load only skill summaries by default.
2. Add `read_skill` / `load_skill_detail` flow if needed.
3. Auto-suggest skills based on intent + enabled capability group.

### Phase 4 — Companion skills for core tools

Ship first-party skills for:
- file editing
- shell usage
- browser debugging
- run verification
- project artifact editing
- delegation/subagents

### Phase 5 — Skill-aware context policy

1. Add thresholds for when to summarize tool outputs.
2. Store raw output outside live context.
3. Allow rehydration of raw output or prior skill details on demand.

## Verification

1. Adding a new capability group requires a companion skill before merge.
2. A new agent session loads short skill summaries, not whole skill bodies.
3. Large tool outputs are summarized with retrievable raw payload preserved.
4. E2E: agent asked to edit code uses `tools/fs-editing` guidance and runs verification after patching.
5. Token usage on first turn decreases versus loading broad instructions/tool lore up front.

## Scope boundaries

- **Included**: skill taxonomy, tool-to-skill mapping, skill metadata, runtime loading rules, context policy, UI/browser, first-party core skills.
- **Excluded**: MCP marketplace packaging, external skill sharing, automatic skill generation from traces, full tutorial content generation.

## Key design decisions

1. Skills are reusable instructions, not hidden tools.
2. Every important tool needs a skill, but not every skill needs a tool.
3. Skills should be loaded progressively, just like tools.
4. Large tool outputs belong in durable storage first and live context second.
5. Tool design, skill design, and context design must be planned together, not separately.
