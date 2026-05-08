import { expect, test } from '@playwright/test'
import { authenticateContext, getSql } from './helpers'

/**
 * Built-in agents seeder.
 *
 * The four agents (chat / research / plan / autonomous) are seeded by `seedBuiltinAgents`
 * with stable UUIDs. Persona text lives in `agents.system_prompt` (no longer in a separate
 * `system/mode-*` skill); `identity_skill_id` is always NULL after migration 0059.
 *
 * Source of truth for IDs: src/lib/agents/builtin-agents.server.ts.
 */

const BUILTIN_AGENT_IDS = {
	chat: '00000000-0000-4000-8000-0000000a6e71',
	research: '00000000-0000-4000-8000-0000000a6e72',
	plan: '00000000-0000-4000-8000-0000000a6e73',
	autonomous: '00000000-0000-4000-8000-0000000a6e74',
} as const

async function ensureBootstrap(page: { goto: (url: string) => Promise<unknown> }) {
	// Hitting the index forces SvelteKit to evaluate db.server.ts, which seeds the agents.
	await page.goto('/')
}

test.describe('agents/builtin — four built-in agents are seeded with stable IDs', () => {
	test('all four built-in agents exist with builtin_key and identity_skill_id NULL', async ({ page, context }) => {
		test.setTimeout(60_000)
		await authenticateContext(context)
		await ensureBootstrap(page)

		const sql = getSql()
		const rows = await sql<
			{ id: string; name: string; builtin_key: string; identity_skill_id: string | null; role: string; system_prompt: string }[]
		>`
			select id::text as id, name, builtin_key, identity_skill_id::text as identity_skill_id, role, system_prompt
			from agents
			where builtin_key is not null
			order by builtin_key
		`
		expect(rows.length, 'all four built-in agents must be seeded').toBe(4)
		const byKey = Object.fromEntries(rows.map((r) => [r.builtin_key, r]))
		expect(byKey.chat?.id).toBe(BUILTIN_AGENT_IDS.chat)
		expect(byKey.research?.id).toBe(BUILTIN_AGENT_IDS.research)
		expect(byKey.plan?.id).toBe(BUILTIN_AGENT_IDS.plan)
		expect(byKey.autonomous?.id).toBe(BUILTIN_AGENT_IDS.autonomous)

		// All built-ins now use system_prompt directly — identity_skill_id is always NULL.
		expect(byKey.chat?.identity_skill_id).toBeNull()
		expect(byKey.research?.identity_skill_id).toBeNull()
		expect(byKey.plan?.identity_skill_id).toBeNull()
		expect(byKey.autonomous?.identity_skill_id).toBeNull()

		// system_prompt must contain the canonical persona text, not the migration-0055
		// 'Seeded at boot.' placeholder.
		for (const row of rows) {
			expect(row.system_prompt, `${row.builtin_key} system_prompt must not be the placeholder`).not.toBe(
				'Seeded at boot.',
			)
			expect(row.system_prompt.length, `${row.builtin_key} system_prompt should be substantial`).toBeGreaterThan(100)
		}
		expect(byKey.chat?.system_prompt).toContain('# Agent: Chat')
		expect(byKey.research?.system_prompt).toContain('# Agent: Research')
		expect(byKey.plan?.system_prompt).toContain('# Agent: Plan')
		expect(byKey.autonomous?.system_prompt).toContain('# Agent: Autonomous')

		expect(byKey.chat?.name).toBe('Chat')
		expect(byKey.research?.name).toBe('Research')
		expect(byKey.plan?.name).toBe('Plan')
		expect(byKey.autonomous?.name).toBe('Autonomous')
	})

	test('no system/ skills remain in the database', async ({ page, context }) => {
		test.setTimeout(60_000)
		await authenticateContext(context)
		await ensureBootstrap(page)

		const sql = getSql()
		const [{ count }] = await sql<{ count: number }[]>`
			select count(*)::int as count from skills where name like 'system/%'
		`
		expect(count, 'no skill rows should match the system/ namespace').toBe(0)
	})

	test('built-in agents carry expected toolPolicy in config jsonb', async ({ page, context }) => {
		test.setTimeout(60_000)
		await authenticateContext(context)
		await ensureBootstrap(page)

		const sql = getSql()
		const rows = await sql<{ builtin_key: string; config: { toolPolicy?: { kind?: string; allow?: string[] } } }[]>`
			select builtin_key, config from agents where builtin_key is not null
		`
		const byKey = Object.fromEntries(rows.map((r) => [r.builtin_key, r.config]))
		expect(byKey.chat?.toolPolicy?.kind).toBe('unrestricted')
		expect(byKey.autonomous?.toolPolicy?.kind).toBe('unrestricted')
		expect(byKey.research?.toolPolicy?.kind).toBe('readOnly')
		expect(byKey.plan?.toolPolicy?.kind).toBe('readOnly')
		// Read-only agents must keep the artifact authoring + handoff tools (the whole point)
		// and the read tools.
		expect(byKey.research?.toolPolicy?.allow).toContain('present_artifact')
		expect(byKey.research?.toolPolicy?.allow).toContain('request_plan_approval')
		expect(byKey.research?.toolPolicy?.allow).toContain('web_search')
		expect(byKey.research?.toolPolicy?.allow).toContain('file_read')
		expect(byKey.research?.toolPolicy?.allow).not.toContain('shell')
		expect(byKey.plan?.toolPolicy?.allow).toContain('create_artifact')
		expect(byKey.plan?.toolPolicy?.allow).toContain('present_artifact')
		expect(byKey.plan?.toolPolicy?.allow).toContain('request_plan_approval')
	})

	test('built-in agents carry an anchor_prompt sentence persisted on agent flips', async ({ page, context }) => {
		test.setTimeout(60_000)
		await authenticateContext(context)
		await ensureBootstrap(page)

		const sql = getSql()
		const rows = await sql<{ builtin_key: string; anchor_prompt: string | null }[]>`
			select builtin_key, anchor_prompt from agents where builtin_key is not null
		`
		for (const row of rows) {
			expect(row.anchor_prompt, `${row.builtin_key} anchor_prompt must be seeded`).toBeTruthy()
			expect(row.anchor_prompt!).toContain(`[Agent changed to`)
		}
	})

	test('placeholder system_prompt gets healed on re-seed', async ({ page, context }) => {
		test.setTimeout(60_000)
		await authenticateContext(context)
		await ensureBootstrap(page)

		const sql = getSql()
		// Force the placeholder back into the chat agent and re-trigger the seed by hitting /.
		await sql`update agents set system_prompt = 'Seeded at boot.' where id::text = ${BUILTIN_AGENT_IDS.chat}`
		await ensureBootstrap(page)

		const [row] = await sql<{ system_prompt: string }[]>`
			select system_prompt from agents where id::text = ${BUILTIN_AGENT_IDS.chat}
		`
		expect(row.system_prompt, 'placeholder must be healed on next boot').not.toBe('Seeded at boot.')
		expect(row.system_prompt).toContain('# Agent: Chat')
	})

	test('user-edited system_prompt survives re-seed', async ({ page, context }) => {
		test.setTimeout(60_000)
		await authenticateContext(context)
		await ensureBootstrap(page)

		const sql = getSql()
		const customContent = `# Custom edit — should not be overwritten`
		const [original] = await sql<{ system_prompt: string }[]>`
			select system_prompt from agents where id::text = ${BUILTIN_AGENT_IDS.plan}
		`
		try {
			await sql`update agents set system_prompt = ${customContent} where id::text = ${BUILTIN_AGENT_IDS.plan}`

			// Re-trigger the seed.
			await ensureBootstrap(page)

			const [row] = await sql<{ system_prompt: string }[]>`
				select system_prompt from agents where id::text = ${BUILTIN_AGENT_IDS.plan}
			`
			expect(row.system_prompt, 'user edit must survive re-seed').toBe(customContent)
		} finally {
			// Restore the canonical content so subsequent tests see it. The healing path only
			// triggers when the value is the placeholder; an explicit restore avoids leaking
			// the custom content into other tests in this file.
			await sql`update agents set system_prompt = ${original.system_prompt} where id::text = ${BUILTIN_AGENT_IDS.plan}`
		}
	})
})
