import { expect, test } from '@playwright/test'
import { authenticateContext, getSql, uniquePrefix } from './helpers'

/**
 * Built-in agents seeder (replaces the prior `chat.mode-skills` spec after the
 * modes-into-agents unification).
 *
 * The four mode personas (chat / research / plan / autonomous) are now first-class agent rows
 * seeded by `seedBuiltinAgents`. Each links to one of the existing mode-identity skill UUIDs
 * (c001 / c002 / c023 / c004) so user edits to those skills carry over to the new agents.
 *
 * Plan-mode UUID was previously bumped c003 → c023 when the plan-mode skill content was
 * rewritten to require `propose_plan` (Wave 1 #6 phase 4). Source of truth for IDs:
 * src/lib/agents/builtin-agents.server.ts.
 */

const BUILTIN_AGENT_IDS = {
	chat: '00000000-0000-4000-8000-0000000a6e71',
	research: '00000000-0000-4000-8000-0000000a6e72',
	plan: '00000000-0000-4000-8000-0000000a6e73',
	autonomous: '00000000-0000-4000-8000-0000000a6e74',
} as const

const IDENTITY_SKILL_IDS = {
	chat: '00000000-0000-4000-8000-00000000c001',
	research: '00000000-0000-4000-8000-00000000c002',
	plan: '00000000-0000-4000-8000-00000000c023',
	autonomous: '00000000-0000-4000-8000-00000000c004',
} as const

async function ensureBootstrap(page: { goto: (url: string) => Promise<unknown> }) {
	// Hitting the index forces SvelteKit to evaluate db.server.ts, which seeds the agents.
	await page.goto('/')
}

test.describe('agents/builtin — four built-in agents are seeded with stable IDs', () => {
	test('all four built-in agents exist with builtin_key + correct identity_skill_id', async ({ page, context }) => {
		test.setTimeout(60_000)
		await authenticateContext(context)
		await ensureBootstrap(page)

		const sql = getSql()
		const rows = await sql<
			{ id: string; name: string; builtin_key: string; identity_skill_id: string; role: string }[]
		>`
			select id::text as id, name, builtin_key, identity_skill_id::text as identity_skill_id, role
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

		expect(byKey.chat?.identity_skill_id).toBe(IDENTITY_SKILL_IDS.chat)
		expect(byKey.research?.identity_skill_id).toBe(IDENTITY_SKILL_IDS.research)
		expect(byKey.plan?.identity_skill_id).toBe(IDENTITY_SKILL_IDS.plan)
		expect(byKey.autonomous?.identity_skill_id).toBe(IDENTITY_SKILL_IDS.autonomous)

		expect(byKey.chat?.name).toBe('Chat')
		expect(byKey.research?.name).toBe('Research')
		expect(byKey.plan?.name).toBe('Plan')
		expect(byKey.autonomous?.name).toBe('Autonomous')
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

	test('user edits to a mode-identity skill survive re-seed (ON CONFLICT DO NOTHING)', async ({ page, context }) => {
		test.setTimeout(60_000)
		await authenticateContext(context)
		await ensureBootstrap(page)

		const sql = getSql()
		const customContent = `# Custom edit ${uniquePrefix('builtin-skill-edit')}`
		try {
			await sql`update skills set content = ${customContent}, updated_at = now() where id::text = ${IDENTITY_SKILL_IDS.plan}`

			// Re-attempt the seed insert and assert it doesn't overwrite.
			await sql`
				insert into skills (id, name, description, content, tags, enabled)
				values (${IDENTITY_SKILL_IDS.plan}::uuid, 'system/mode-plan', 'desc', 'should-not-overwrite', '{"system"}', true)
				on conflict (id) do nothing
			`

			const [row] = await sql<{ content: string }[]>`
				select content from skills where id::text = ${IDENTITY_SKILL_IDS.plan}
			`
			expect(row.content, 'user edit must survive ON CONFLICT DO NOTHING re-seed').toBe(customContent)
		} finally {
			// Leave the user's version — this is a development DB and the seeder only
			// inserts on first boot.
			void 0
		}
	})
})
