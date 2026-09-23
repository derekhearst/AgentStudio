import { expect, test } from '@playwright/test'
import { authenticateContext, getSql, uniquePrefix } from './helpers'

/**
 * Built-in agents seeder.
 *
 * The four agents (chat / research / plan / autonomous) are seeded by `seedBuiltinAgents`
 * with stable UUIDs. Persona text lives in `agents.system_prompt` (no longer in a separate
 * `system/mode-*` skill). Migration 0059 unlinked those; an operator may since have promoted
 * a built-in's persona to an identity skill of their own, and a re-seed keeps that link.
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

/**
 * Re-run the seeder directly.
 *
 * The two re-seed tests below used to do this by hitting `/` a second time, on the theory
 * that it "re-triggers the seed". It does not: seeding happens once when the server
 * process evaluates `db.server.ts`, so a second request is a no-op and both tests only
 * ever passed when Playwright had just cold-booted a server and this file happened to be
 * the first to touch it. Against a warm server they always failed.
 */
async function reseedBuiltinAgents() {
	const [{ seedBuiltinAgents }, { db }] = await Promise.all([
		import('../src/lib/agents/builtin-agents.server'),
		import('../src/lib/db.server'),
	])
	await seedBuiltinAgents(db)
}

test.describe('agents/builtin — four built-in agents are seeded with stable IDs', () => {
	test('all four built-in agents exist with builtin_key and no link to a system/ skill', async ({ page, context }) => {
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

		// No built-in points at a legacy system/ skill or at one that is gone. A link the
		// operator made (Promote to skill on the identity page) is theirs to keep.
		const linked = rows.map((r) => r.identity_skill_id).filter((id): id is string => id !== null)
		if (linked.length > 0) {
			const skillRows = await sql<{ id: string; name: string }[]>`
				select id::text as id, name from skills where id::text in ${sql(linked)}
			`
			const nameById = new Map(skillRows.map((r) => [r.id, r.name]))
			for (const id of linked) {
				expect(nameById.has(id), `identity skill ${id} must exist`).toBe(true)
				expect(nameById.get(id)!.startsWith('system/')).toBe(false)
			}
		}

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
		// The seeder spec below links a throwaway `system/E2E:` skill for a moment; that one is
		// not a leftover of the removed namespace.
		const [{ count }] = await sql<{ count: number }[]>`
			select count(*)::int as count from skills where name like 'system/%' and name not like 'system/E2E:%'
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
		// Read-only agents must keep the plan authoring + handoff tools (the whole point)
		// and the read tools. `Write` is their one write tool: the plan is a file.
		expect(byKey.research?.toolPolicy?.allow).toContain('Write')
		expect(byKey.research?.toolPolicy?.allow).toContain('request_plan_approval')
		expect(byKey.research?.toolPolicy?.allow).toContain('web_search')
		expect(byKey.research?.toolPolicy?.allow).toContain('Read')
		expect(byKey.research?.toolPolicy?.allow).not.toContain('Bash')
		expect(byKey.plan?.toolPolicy?.allow).toContain('Write')
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

	// Desktop only: both of these mutate one shared row and assert on it, so running them
	// concurrently in two projects makes each one's restore race the other's assertion.
	// They exercise server-side seeding, not layout, so a second viewport proves nothing.
	test('placeholder system_prompt gets healed on re-seed', async ({ page, context }, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'database behaviour; one project is enough')
		test.setTimeout(60_000)
		await authenticateContext(context)
		await ensureBootstrap(page)

		const sql = getSql()
		// Force the placeholder back into the chat agent, then re-run the seeder.
		await sql`update agents set system_prompt = 'Seeded at boot.' where id::text = ${BUILTIN_AGENT_IDS.chat}`
		await reseedBuiltinAgents()

		const [row] = await sql<{ system_prompt: string }[]>`
			select system_prompt from agents where id::text = ${BUILTIN_AGENT_IDS.chat}
		`
		expect(row.system_prompt, 'placeholder must be healed on next boot').not.toBe('Seeded at boot.')
		expect(row.system_prompt).toContain('# Agent: Chat')
	})

	test('user-edited system_prompt survives re-seed', async ({ page, context }, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'database behaviour; one project is enough')
		test.setTimeout(60_000)
		await authenticateContext(context)
		await ensureBootstrap(page)

		const sql = getSql()
		const customContent = `# Custom edit — should not be overwritten`
		try {
			await sql`update agents set system_prompt = ${customContent} where id::text = ${BUILTIN_AGENT_IDS.plan}`

			await reseedBuiltinAgents()

			const [row] = await sql<{ system_prompt: string }[]>`
				select system_prompt from agents where id::text = ${BUILTIN_AGENT_IDS.plan}
			`
			expect(row.system_prompt, 'user edit must survive re-seed').toBe(customContent)
		} finally {
			// Restore by healing rather than by writing `original` back. If a previous run
			// died between the update and the restore, `original` is itself the custom
			// string and writing it back would keep the database poisoned forever — which
			// is exactly what happened: a later assertion failed on a 41-character prompt.
			// Setting the placeholder and re-seeding always lands on the canonical text.
			await sql`update agents set system_prompt = 'Seeded at boot.' where id::text = ${BUILTIN_AGENT_IDS.plan}`
			await reseedBuiltinAgents()
		}
	})

	/*
	 * Every boot runs the seeder, and every deploy is a boot. It used to replace the whole
	 * config with `{ toolPolicy }` and null the identity link, so a deploy undid the
	 * operator's hook bindings, research overrides and promoted identity skill on each
	 * built-in. Only the tool policy is the seeder's to refresh.
	 */
	test('operator config and a linked identity skill survive a re-seed; the tool policy is refreshed', async ({ page, context }, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'database behaviour; one project is enough')
		test.setTimeout(60_000)
		await authenticateContext(context)
		await ensureBootstrap(page)

		const sql = getSql()
		const prefix = uniquePrefix('builtin-reseed')
		const original = await readPlanRow()
		try {
			const [skill] = await sql<{ id: string }[]>`
				insert into skills (name, description, content, enabled)
				values (${`${prefix}-identity`}, 'Plan identity', 'You plan.', true)
				returning id::text as id
			`
			const operatorConfig = {
				hooks: { after_run: [`${prefix}-hook`] },
				research: { enabled: false },
				// A stale policy the seeder must overwrite.
				toolPolicy: { kind: 'unrestricted' },
			}
			await sql`
				update agents
				set config = config || ${sql.json(operatorConfig)}, identity_skill_id = ${skill.id}
				where id::text = ${BUILTIN_AGENT_IDS.plan}
			`

			await reseedBuiltinAgents()

			const after = await readPlanRow()
			expect(after.config.hooks).toEqual(operatorConfig.hooks)
			expect(after.config.research).toEqual(operatorConfig.research)
			expect((after.config.toolPolicy as { kind?: string }).kind, 'the tool policy is code-owned').toBe('readOnly')
			expect(after.identity_skill_id, 'an operator identity skill stays linked').toBe(skill.id)

			// A link to a skill that no longer exists is healed rather than left dangling.
			await sql`delete from skills where id::text = ${skill.id}`
			await reseedBuiltinAgents()
			expect((await readPlanRow()).identity_skill_id).toBeNull()

			// So is a link to the removed system/ namespace.
			const [legacy] = await sql<{ id: string }[]>`
				insert into skills (name, description, content, enabled)
				values (${`system/${prefix}`}, 'legacy mode skill', 'old', true)
				returning id::text as id
			`
			await sql`update agents set identity_skill_id = ${legacy.id} where id::text = ${BUILTIN_AGENT_IDS.plan}`
			await reseedBuiltinAgents()
			expect((await readPlanRow()).identity_skill_id).toBeNull()
		} finally {
			// Put back what the operator had, minus anything a crashed earlier run left behind.
			const restoredHooks = stripTestHookRefs(original.config.hooks)
			const restored = { ...original.config }
			if (restoredHooks) restored.hooks = restoredHooks
			else delete restored.hooks
			const keepLink =
				original.identity_skill_id &&
				(await sql`select 1 from skills where id::text = ${original.identity_skill_id} and name not like 'E2E:%'`).length > 0
			await sql`
				update agents
				set config = ${sql.json(restored as Parameters<typeof sql.json>[0])},
					identity_skill_id = ${keepLink ? original.identity_skill_id : null}
				where id::text = ${BUILTIN_AGENT_IDS.plan}
			`
			await sql`delete from skills where name like ${`${prefix}%`} or name like ${`system/${prefix}%`}`
			await reseedBuiltinAgents()
		}
	})
})

async function readPlanRow() {
	const sql = getSql()
	const [row] = await sql<{ config: Record<string, unknown>; identity_skill_id: string | null }[]>`
		select config, identity_skill_id::text as identity_skill_id from agents where id::text = ${BUILTIN_AGENT_IDS.plan}
	`
	return row
}

/** Hook bindings without refs a test wrote (they carry the `E2E:` prefix); null when none remain. */
function stripTestHookRefs(hooks: unknown): Record<string, string[]> | null {
	if (!hooks || typeof hooks !== 'object') return null
	const kept: Record<string, string[]> = {}
	for (const [event, refs] of Object.entries(hooks as Record<string, unknown>)) {
		if (!Array.isArray(refs)) continue
		const real = refs.filter((ref): ref is string => typeof ref === 'string' && !ref.startsWith('E2E:'))
		if (real.length > 0) kept[event] = real
	}
	return Object.keys(kept).length > 0 ? kept : null
}
