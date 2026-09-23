# Skills

This page describes skills in plain English. The full design is in [spec.md](spec.md); the build history is in [plan.md](plan.md).

## Overview

A skill is a reusable set of instructions an agent can pull in when it needs them: how to use a tool, how to carry out a workflow, or background knowledge about a subject. Agents are shown a one-line summary of the skills that look relevant, and read the whole skill only when they decide to. Skills are managed at `/skills`.

## Key concepts

| Concept | What it is |
| ------- | ---------- |
| Name | The skill's unique name, often with a namespace, e.g. `tools/sandbox-fs` or `agent/reviewer-1a2b3c4d/identity`. |
| Description | One or two sentences. This is what the agent sees before it opens the skill. |
| Body | The instructions themselves, in markdown. |
| Category | One of `tool`, `workflow`, `domain`, `policy`, `identity` or `hook`. Identity and hook skills are always offered to agents, whatever the relevance ranking says. |
| Tags | Free labels for searching and grouping. |
| Resource files | Extra files that belong to the skill — templates, checklists, reference notes — each with a name and an optional description. |

## User flows

### Export a skill

1. Open the skill at `/skills/[id]` and press **Export**.
2. The dialog shows the skill as a `SKILL.md` document — a short header with the name, description, category, tags and, if the skill is off, `enabled: false` — followed by its resource files.
3. **Copy all** copies the whole package: the `SKILL.md`, then each resource file between a pair of marker lines, `<!-- skill-resource {"name": …} -->` and `<!-- /skill-resource -->`.

### Import a skill

1. On `/skills`, open **Import**.
2. Paste a `SKILL.md` document, or a whole package copied with **Copy all**.
3. Choose what happens if a skill with the same name exists: fail, or overwrite it.
4. Import. The skill is created or updated, and its resource files are created, updated or removed to match the package.

Pasting a plain `SKILL.md` with no resource files leaves an existing skill's resource files alone.

## Roles & permissions

AgentStudio has a single owner. The owner can view, create, edit, import, export and delete skills. The built-in guide skill is read-only and cannot be overwritten by an import.

## Business rules

- Export followed by import gives back the same skill: the same description, body, category, tags, on/off state and resource files, however many times it is repeated.
- Before this was fixed, three things were lost on the way round:
  - the **category** was not exported, and an overwrite import cleared it, so an identity or hook skill stopped being always offered to agents;
  - the **resource files** were pasted back as part of the body, and their descriptions were dropped;
  - a **description with quotation marks** gained an extra backslash before each quote on every export and import.
- A pasted package is refused, with a reason, if a resource file has no closing marker line, has no name, or if there is stray text between resource files. Nothing is silently dropped.
- A resource file whose own content includes a line that is exactly `<!-- /skill-resource -->` cannot be carried in a package.
- The header accepts `name` and `description` (both required, the description at most 500 characters), `category`, `tags` and `enabled`. Other keys are ignored.
