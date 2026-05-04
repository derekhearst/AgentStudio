import type { CapabilityGroup } from './tools'

/**
 * Wave 2 #8 phase 2 — auto-suggest classifier.
 *
 * Inspect a user message and return the set of non-`core` capability groups that look immediately
 * relevant. The stream handler pre-enables these on round 0 so the model doesn't have to spend a
 * round calling `enable_capability` before getting useful tools.
 *
 * Pure & deterministic: keyword heuristics with whole-word matching (regex `\b…\b`) over a
 * lowercased copy of the message. Falls through to an empty list when nothing strong matches —
 * the caller still gets `core` as the always-on baseline, and the model can still call
 * `enable_capability` directly if needed.
 *
 * Conservative on purpose: a single weak hit shouldn't expand the surface. Intent words are
 * grouped into "strong" (decisive on a single match) and "supporting" (needs at least two for
 * the group to be suggested) categories.
 *
 * No LLM call. A future Phase 2 follow-up could add a tiny GPT-4o-mini classifier for ambiguous
 * cases, but the keyword pass alone covers the obvious 80% without latency cost.
 */

type WordList = readonly string[]

type GroupHeuristic = {
	group: Exclude<CapabilityGroup, 'core'>
	/** Decisive on a single whole-word match. */
	strong: WordList
	/** Need >=2 matches for the group to fire. */
	supporting: WordList
}

const HEURISTICS: GroupHeuristic[] = [
	{
		group: 'sandbox',
		strong: [
			'code',
			'file',
			'files',
			'directory',
			'folder',
			'edit',
			'patch',
			'diff',
			'shell',
			'bash',
			'terminal',
			'command',
			'build',
			'compile',
			'test',
			'tests',
			'lint',
			'typecheck',
			'install',
			'npm',
			'bun',
			'git',
			'commit',
			'branch',
			'refactor',
			'debug',
			'screenshot',
			'browse',
		],
		supporting: ['run', 'open', 'check', 'fix', 'add', 'change', 'modify', 'replace'],
	},
	{
		group: 'skills',
		strong: ['skill', 'skills', 'knowledge', 'guide', 'instructions', 'playbook', 'recipe', 'how-to'],
		supporting: ['document', 'reference', 'note'],
	},
	{
		group: 'agents',
		strong: [
			'agent',
			'agents',
			'delegate',
			'delegation',
			'subagent',
			'sub-agent',
			'automation',
			'automate',
			'schedule',
			'cron',
			'recurring',
		],
		supporting: ['task', 'tasks', 'job', 'jobs', 'pipeline'],
	},
	{
		group: 'media',
		strong: [
			'image',
			'images',
			'picture',
			'photo',
			'illustration',
			'render',
			'draw',
			'sketch',
			'logo',
			'icon',
			'thumbnail',
			'mockup',
			'diagram',
		],
		supporting: ['visual', 'graphic', 'art'],
	},
	{
		group: 'research',
		strong: [
			'research',
			'investigate',
			'sources',
			'citations',
			'literature',
			'whitepaper',
			'paper',
			'study',
			'analysis',
			'compare',
			'comparison',
			'review',
		],
		supporting: ['report', 'evidence', 'data', 'cite', 'background', 'overview'],
	},
	{
		group: 'projects',
		strong: [
			'project',
			'projects',
			'artifact',
			'artifacts',
			'document',
			'doc',
			'documentation',
			'spec',
			'rfc',
			'proposal',
			'draft',
			'manuscript',
		],
		supporting: ['version', 'revise', 'rewrite', 'continue', 'append', 'amend'],
	},
	{
		group: 'source_control',
		strong: [
			'repo',
			'repos',
			'repository',
			'repositories',
			'github',
			'gitlab',
			'bitbucket',
			'pull-request',
			'pull-requests',
			'pr',
			'prs',
		],
		supporting: ['fork', 'clone', 'merge', 'rebase', 'remote'],
	},
]

const STRONG_THRESHOLD = 1
const SUPPORTING_THRESHOLD = 2

export type SuggestionExplanation = {
	group: Exclude<CapabilityGroup, 'core'>
	matchedStrong: string[]
	matchedSupporting: string[]
}

/**
 * Return the set of non-`core` capability groups whose keyword profile matches the message.
 * `core` is never returned here — it's always enabled by default at the schema level.
 */
export function suggestCapabilityGroups(message: string): Array<Exclude<CapabilityGroup, 'core'>> {
	return suggestCapabilityGroupsExplained(message).map((s) => s.group)
}

/**
 * Same as `suggestCapabilityGroups` but also returns which keywords fired for each group, so
 * tests + telemetry + future-you-debugging-a-false-positive can see the reasoning.
 */
export function suggestCapabilityGroupsExplained(message: string): SuggestionExplanation[] {
	const text = (message ?? '').toLowerCase()
	if (text.trim().length === 0) return []

	const out: SuggestionExplanation[] = []
	for (const heuristic of HEURISTICS) {
		const matchedStrong = heuristic.strong.filter((w) => containsWord(text, w))
		const matchedSupporting = heuristic.supporting.filter((w) => containsWord(text, w))
		if (matchedStrong.length >= STRONG_THRESHOLD || matchedSupporting.length >= SUPPORTING_THRESHOLD) {
			out.push({ group: heuristic.group, matchedStrong, matchedSupporting })
		}
	}
	return out
}

function containsWord(haystack: string, needle: string): boolean {
	// `\b` doesn't behave well around hyphens — escape the needle and bound it with non-word lookarounds.
	const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
	const re = new RegExp(`(?:^|[^a-z0-9_])${escaped}(?:$|[^a-z0-9_])`, 'i')
	return re.test(haystack)
}
