/**
 * Built-in `agentstudio-guide` system skill.
 *
 * This is a virtual skill that doesn't live in the DB — it's synthesized at read
 * time so the onboarding/feature-map content travels with the app and doesn't
 * require a migration to update. The constants and helpers below are the source
 * of truth used by both `skills.server.ts` (CRUD/listing surface) and
 * `skills-files.server.ts` (file CRUD respecting the system read-only flag).
 */

export const SYSTEM_SKILL_ID = '00000000-0000-4000-8000-000000000042'
export const SYSTEM_SKILL_NAME = 'agentstudio-guide'
export const SYSTEM_SKILL_CREATED_AT = new Date('2026-01-01T00:00:00.000Z')

export const SYSTEM_SKILL_FILES = [
	{
		id: '00000000-0000-4000-8000-000000000043',
		name: 'quickstart.md',
		description: 'Best-practice workflow to get value quickly from AgentStudio.',
		content: `# AgentStudio Quickstart

## What this app is best at
- Conversational coding assistance across your local workspace
- Tool-driven task execution (files, shell, web, browser automation)
- Reusable skills for consistent responses
- Agent/task orchestration for larger work items

## Daily workflow
1. Open or create a chat from /chat.
2. Pick the model and reasoning effort appropriate for the task.
3. State your goal plus constraints (files, deadlines, style, no-go zones).
4. Ask for concrete outputs: code edits, tests, docs updates, and validation.
5. Review tool calls and diffs before finalizing.

## Prompting pattern that works
Use this format:
- Goal: what done looks like.
- Scope: exact files/routes/domains.
- Constraints: style, libraries, performance, security.
- Verification: tests/checks to run.

Example:
"Implement X in src/lib/foo and src/routes/bar, keep existing API shape, run relevant tests, and summarize risk."`,
		sortOrder: 0,
	},
	{
		id: '00000000-0000-4000-8000-000000000044',
		name: 'feature-map.md',
		description: 'High-level map of core product areas and when to use each.',
		content: `# Feature Map

## Chat
Use for interactive implementation, debugging, design iteration, and code reviews. The orchestrator chat is the primary interface.

## Skills
Use /skills to store repeatable instructions, standards, and domain playbooks.

## Agents
Use /agents to manage sub-agents and their configurations.

## Automations
Use /automations for scheduled and recurring agent workflows.

## Cost
Use /cost to track usage and budgets.

## Settings
Configure defaults (model, budgets, notifications, behavior preferences) in /settings.`,
		sortOrder: 1,
	},
	{
		id: '00000000-0000-4000-8000-000000000045',
		name: 'effectiveness-playbook.md',
		description: 'Tactics for higher-quality outputs with fewer iterations.',
		content: `# Effectiveness Playbook

## Be explicit about success criteria
- Include acceptance criteria and edge cases.
- Name exact files and expected behavior changes.

## Ask for verification every time
- Request tests/checks and what was validated.
- Ask for residual risks and follow-up recommendations.

## Use staged execution for bigger changes
1. Discovery and plan
2. Implementation
3. Validation
4. Summary with risks and next steps

## Prefer deterministic edits
- Ask for minimal, targeted changes.
- Avoid broad refactors unless requested.

## Build reusable knowledge
- Promote repeated guidance into /skills.

## Review mindset
When requesting review, prioritize bugs, regressions, and missing tests before style feedback.`,
		sortOrder: 2,
	},
] as const

export function isSystemSkillId(id: string) {
	return id === SYSTEM_SKILL_ID
}

export function isSystemSkillFileId(fileId: string) {
	return SYSTEM_SKILL_FILES.some((file) => file.id === fileId)
}

export function buildSystemSkill() {
	return {
		id: SYSTEM_SKILL_ID,
		name: SYSTEM_SKILL_NAME,
		description: 'Built-in guide for understanding AgentStudio features and using the app effectively.',
		content: 'This is a built-in, read-only onboarding skill that explains AgentStudio and how to use it effectively.',
		tags: ['onboarding', 'guide', 'agentstudio', 'best-practices'],
		enabled: true,
		accessCount: 0,
		lastAccessed: null as Date | null,
		descriptionEmbedding: null as number[] | null,
		descriptionEmbeddedAt: null as Date | null,
		category: 'domain' as string | null,
		sourceFile: null as string | null,
		createdAt: SYSTEM_SKILL_CREATED_AT,
		updatedAt: SYSTEM_SKILL_CREATED_AT,
		isSystem: true,
		fileCount: SYSTEM_SKILL_FILES.length,
		files: SYSTEM_SKILL_FILES.map((file) => ({
			...file,
			skillId: SYSTEM_SKILL_ID,
			createdAt: SYSTEM_SKILL_CREATED_AT,
			updatedAt: SYSTEM_SKILL_CREATED_AT,
		})),
	}
}

export function shouldIncludeSystemSkill(options?: { search?: string; enabled?: boolean }) {
	if (options?.enabled !== undefined && options.enabled !== true) return false
	if (!options?.search) return true

	const skill = buildSystemSkill()
	const q = options.search.trim().toLowerCase()
	if (!q) return true

	return (
		skill.name.toLowerCase().includes(q) ||
		skill.description.toLowerCase().includes(q) ||
		skill.tags.some((tag) => tag.toLowerCase().includes(q))
	)
}
