import { skills } from '$lib/skills/skills.schema'
import type { db } from '$lib/db.server'

type DbLike = typeof db

/**
 * First-party companion skills for the four built-in capability groups, seeded with fixed UUIDs
 * (`…d001` … `…d004`). When the run enables a group via `enable_capability`, the matching
 * skill's summary is surfaced inline in the tool result so the model knows when/how to use the
 * new tools without bloating the prompt with full bodies.
 *
 * `ON CONFLICT DO NOTHING` keeps the seed idempotent and preserves any user edits across boots.
 * To force a content refresh, bump the UUID (same pattern as mode-skills).
 */
const COMPANION_SKILL_DEFAULTS: Array<{
	id: string
	name: string
	description: string
	content: string
	companionGroups: string[]
	companionTools: string[]
	tags: string[]
}> = [
	{
		id: '00000000-0000-4000-8000-00000000d001',
		name: 'tools/sandbox-fs',
		description: 'How to safely inspect and edit files in the sandbox workspace.',
		content: `# Companion: Coding Sandbox

Use the sandbox tools (\`shell\`, \`file_read\`, \`file_write\`, \`file_patch\`, \`file_replace\`, \`list_directory\`, \`search_files\`, \`file_info\`, \`move_file\`, \`delete_file\`, \`browser_screenshot\`, and the read-only \`git_status\`/\`git_log\`/\`git_diff\` in worktree mode) to investigate and modify code in an isolated per-run workspace.

## When to reach for which verb

- \`search_files\` first — locate a target by symbol/string before reading whole files. Cheaper than \`list_directory\` + multiple \`file_read\`s.
- \`file_read\` with a line range — never paste 1000-line files into context. Use the \`startLine\`/\`endLine\` args.
- \`file_replace\` for targeted edits where you know an exact unique string. The default unique-match guard makes the edit retry-safe.
- \`file_patch\` for multi-line / multi-hunk diffs. Generate a clean unified diff; tabs and trailing whitespace must match.
- \`shell\` for tooling that has no first-class wrapper (test runners, linters, package installs). Each shell call is sandboxed: \`HOME\`, \`TMPDIR\`, npm/bun caches all redirect inside the workspace.

## Safety rules

- Run reversible reads (\`search_files\`, \`file_read\`, \`list_directory\`, \`git_status\`/\`log\`/\`diff\`) freely. They cost almost nothing.
- Avoid \`delete_file\` and \`move_file\` until you've verified the target exists and you understand what depends on it.
- After a non-trivial edit, run a verification step (test, type-check, build) via \`shell\`. Don't claim "done" without checking.
- The workspace is per-run by default; nothing leaks across runs unless the agent is configured for persistent or worktree mode.

## When NOT to use

- For pure information lookups, prefer \`web_search\` over scraping local copies.
- Don't enable this group "just in case" — the prompt cost is real.
`,
		companionGroups: ['sandbox'],
		companionTools: [
			'shell',
			'file_read',
			'file_write',
			'file_patch',
			'file_replace',
			'list_directory',
			'search_files',
		],
		tags: ['system', 'companion', 'sandbox'],
	},
	{
		id: '00000000-0000-4000-8000-00000000d002',
		name: 'tools/skills-management',
		description: 'How to discover, read, and author reusable skill bundles.',
		content: `# Companion: Skills Management

Skills are reusable knowledge bundles loaded progressively — only summaries are in the prompt by default; full bodies require \`read_skill\`.

## Reading skills

- The system prompt already lists the available skill summaries (name + description + nested-file names). Don't call \`list_skills\` unless the summary list looks stale or filtered.
- Call \`read_skill(name)\` only when a skill is clearly relevant to the current step. The body costs tokens — load on demand.
- Use \`read_skill_file(skillName, fileName)\` for nested files (examples, sub-topics) after you've seen they exist in the parent skill's listing.

## Authoring skills

- Keep main \`content\` under ~8KB. Long expansions belong in nested files.
- A good skill answers: when to use it, when not to use it, safe calling patterns, verification expectations.
- Set \`companionGroups\` / \`companionTools\` when the skill teaches usage of a capability or specific tools — that's how it gets auto-surfaced when the model enables that group.

## Avoid

- Don't dump tutorial-length prose into a skill. Summaries get loaded broadly; bodies get loaded specifically.
- Don't create a skill for one-off knowledge — that belongs in the conversation, not the global skill registry.
`,
		companionGroups: ['skills'],
		companionTools: ['list_skills', 'read_skill', 'read_skill_file', 'create_skill', 'update_skill'],
		tags: ['system', 'companion', 'skills'],
	},
	{
		id: '00000000-0000-4000-8000-00000000d003',
		name: 'tools/agents-delegation',
		description: 'How to delegate work to sub-agents and schedule recurring automations.',
		content: `# Companion: Agents & Delegation

Use \`run_subagent\` for delegating a focused chunk of work to a stateless or named sub-agent. Use \`create_automation\` for recurring scheduled work.

## When to delegate via \`run_subagent\`

- The task has a clear, narrow scope and well-defined output (e.g. "search the codebase for X and return the top 3 matches with snippets").
- You want to protect your main context from a verbose intermediate result (the sub-agent's transcript stays in the sub-conversation; only the final result comes back).
- You can pass the relevant context in the \`task\` + \`context\` args — sub-agents don't see your conversation history.

## When NOT to delegate

- For a one-line lookup or a single tool call you can do directly.
- When you need iterative back-and-forth — the sub-agent runs to completion in one turn.

## Automations (\`create_automation\` etc.)

- Cron expressions are 5-field standard (\`minute hour day month weekday\`). Confirm the schedule with the user before creating.
- \`conversationMode: 'reuse'\` resumes the same agent conversation each tick; \`'new_each_run'\` starts fresh. Default to \`'new_each_run'\` unless the user explicitly wants conversational continuity.
- Use \`list_automations\` (in \`core\`) to inspect existing schedules before adding a new one — duplicates are easy to make.

## Avoid

- Spinning up a sub-agent to "think more" — that's just adding round-trips.
- Creating automations the user didn't ask for.
`,
		companionGroups: ['agents'],
		companionTools: ['run_subagent', 'create_automation', 'update_automation', 'delete_automation'],
		tags: ['system', 'companion', 'agents'],
	},
	{
		id: '00000000-0000-4000-8000-00000000d004',
		name: 'tools/media-generation',
		description: 'When and how to generate images.',
		content: `# Companion: Image Generation

\`image_generate\` produces a single image from a text prompt. It's slow (several seconds) and not free.

## When to use

- The user explicitly asks for an image, illustration, diagram, or visual asset.
- You're producing a placeholder (mockup, hero image) and the user is okay with generative output.

## Prompting tips

- Be specific about subject, style, composition, and lighting in one prompt. Iterating in the chat is expensive.
- For technical diagrams, prefer asking the user if they'd rather have a Mermaid/PlantUML/SVG source — generated images can't be edited, sources can.

## Avoid

- Don't generate images speculatively. The user has to wait and pay.
- Don't try to use it for text rendering or precise typography — current models are unreliable for these.
`,
		companionGroups: ['media'],
		companionTools: ['image_generate'],
		tags: ['system', 'companion', 'media'],
	},
]

export async function seedCompanionSkills(dbInstance: DbLike): Promise<{ inserted: number }> {
	const now = new Date()
	const values = COMPANION_SKILL_DEFAULTS.map((d) => ({
		id: d.id,
		name: d.name,
		description: d.description,
		content: d.content,
		tags: d.tags,
		enabled: true,
		companionGroups: d.companionGroups,
		companionTools: d.companionTools,
		createdAt: now,
		updatedAt: now,
	}))
	// Use a no-target ON CONFLICT DO NOTHING so we tolerate either the id PK collision (preserves
	// user edits across boots) OR the name uniqueness collision (handles a renamed/orphaned row
	// from an old boot that had a different UUID).
	const inserted = await dbInstance
		.insert(skills)
		.values(values)
		.onConflictDoNothing()
		.returning({ id: skills.id })
	return { inserted: inserted.length }
}
