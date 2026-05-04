/**
 * Wave 5 #22 phase 6 — role-based companion suggestions.
 *
 * Pure helper (no DB / SvelteKit deps). Inspects an agent's `role` text and returns the
 * non-`core` capability groups that look natural for that role. Operators decide whether to
 * bind them via the existing capability-binding UI on `/agents/[id]` — this module only
 * surfaces the suggestion, never auto-mutates the agent record.
 *
 * Intentionally narrow: matches against the role string only, not the full identity prompt.
 * The role is a short label ("Coding agent for refactor tasks", "Read-only critic", …) so a
 * keyword scan is enough to pick the obvious bundles. Mirrors the message-classifier shape
 * from `suggest-capabilities.ts` so the two are easy to reason about together.
 */

const ROLE_GROUP_KEYWORDS: Record<string, string[]> = {
	sandbox: [
		'code',
		'coder',
		'coding',
		'engineer',
		'engineering',
		'developer',
		'dev',
		'refactor',
		'refactoring',
		'build',
		'builder',
		'implementer',
		'implementation',
		'shell',
		'fix',
		'debug',
		'debugger',
		'qa',
		'test',
		'tester',
		'testing',
	],
	skills: ['playbook', 'guide', 'reference', 'instructions', 'how-to', 'curator', 'librarian'],
	agents: [
		'orchestrator',
		'orchestration',
		'planner',
		'planning',
		'delegator',
		'manager',
		'coordinator',
		'scheduler',
		'automation',
	],
	media: ['designer', 'design', 'illustrator', 'illustration', 'visual', 'graphic', 'logo', 'icon', 'mockup'],
	research: [
		'research',
		'researcher',
		'investigator',
		'investigation',
		'analyst',
		'analysis',
		'reviewer',
		'review',
		'critic',
		'reader',
		'reading',
	],
	projects: [
		'writer',
		'editor',
		'author',
		'authoring',
		'documentation',
		'docs',
		'spec',
		'specification',
		'rfc',
		'proposal',
		'manuscript',
		'draft',
	],
}

export const ROLE_COMPANION_GROUP_NAMES = Object.keys(ROLE_GROUP_KEYWORDS) as ReadonlyArray<string>

export type RoleCompanionSuggestion = {
	group: string
	matchedKeywords: string[]
}

export function suggestCompanionsForRole(role: string): RoleCompanionSuggestion[] {
	const text = (role ?? '').toLowerCase()
	if (text.trim().length === 0) return []
	const out: RoleCompanionSuggestion[] = []
	for (const [group, words] of Object.entries(ROLE_GROUP_KEYWORDS)) {
		const matched = words.filter((w) => containsWord(text, w))
		if (matched.length > 0) {
			out.push({ group, matchedKeywords: matched })
		}
	}
	return out
}

export function suggestCompanionGroupsForRole(role: string): string[] {
	return suggestCompanionsForRole(role).map((s) => s.group)
}

function containsWord(haystack: string, needle: string): boolean {
	const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
	const re = new RegExp(`(?:^|[^a-z0-9_])${escaped}(?:$|[^a-z0-9_])`, 'i')
	return re.test(haystack)
}
