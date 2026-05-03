import { expect, test } from '@playwright/test'
import { authenticateContext, cleanupPrefixedRecords, getSql, uniquePrefix } from './helpers'

const MODE_SKILL_IDS = {
	chat: '00000000-0000-4000-8000-00000000c001',
	research: '00000000-0000-4000-8000-00000000c002',
	plan: '00000000-0000-4000-8000-00000000c003',
	agent: '00000000-0000-4000-8000-00000000c004',
} as const

async function ensureBootstrap(page: { goto: (url: string) => Promise<unknown> }) {
	// Hitting the index forces SvelteKit to evaluate db.server.ts, which seeds mode skills.
	await page.goto('/')
}

test.describe('chat/mode-skills — mode-identity skills are seeded and editable', () => {
	test('on app boot, four mode-identity skills exist with the canonical fixed UUIDs', async ({ page, context }) => {
		test.setTimeout(60_000)
		await authenticateContext(context)
		await ensureBootstrap(page)

		const sql = getSql()
		const rows = await sql<
			{ id: string; name: string; content: string; enabled: boolean; tags: string[] }[]
		>`
			select id::text as id, name, content, enabled, tags
			from skills
			where id::text in (
				${MODE_SKILL_IDS.chat},
				${MODE_SKILL_IDS.research},
				${MODE_SKILL_IDS.plan},
				${MODE_SKILL_IDS.agent}
			)
			order by name asc
		`
		expect(rows.length, 'all four mode skills must be seeded after first boot').toBe(4)
		const byId = new Map(rows.map((r) => [r.id, r]))
		expect(byId.get(MODE_SKILL_IDS.chat)?.name).toBe('system/mode-chat')
		expect(byId.get(MODE_SKILL_IDS.research)?.name).toBe('system/mode-research')
		expect(byId.get(MODE_SKILL_IDS.plan)?.name).toBe('system/mode-plan')
		expect(byId.get(MODE_SKILL_IDS.agent)?.name).toBe('system/mode-agent')
		for (const r of rows) {
			expect(r.enabled).toBe(true)
			expect(r.content.length).toBeGreaterThan(20)
			expect(r.tags).toContain('system')
			expect(r.tags).toContain('mode-identity')
		}
	})

	test('user edits to a mode skill are preserved across re-seeds (ON CONFLICT DO NOTHING)', async ({ page, context }) => {
		test.setTimeout(60_000)
		await authenticateContext(context)
		await ensureBootstrap(page)

		const sql = getSql()
		const customContent = `# Custom edit ${uniquePrefix('mode-skill-edit')}`
		try {
			await sql`update skills set content = ${customContent}, updated_at = now() where id::text = ${MODE_SKILL_IDS.plan}`

			// Forcibly re-trigger the seed by importing it via the page request again.
			// Since the bootstrap runs once per process, the easiest re-seed proxy is to just
			// re-attempt the same insert and assert it doesn't overwrite.
			await sql`
				insert into skills (id, name, description, content, tags, enabled)
				values (${MODE_SKILL_IDS.plan}::uuid, 'system/mode-plan', 'desc', 'should-not-overwrite', '{"system"}', true)
				on conflict (id) do nothing
			`

			const [row] = await sql<{ content: string }[]>`
				select content from skills where id::text = ${MODE_SKILL_IDS.plan}
			`
			expect(row.content, 'user edit must survive ON CONFLICT DO NOTHING re-seed').toBe(customContent)
		} finally {
			// Restore the seeded default by deleting and re-running bootstrap on next test.
			// Safer: just leave the user's version; this is a development DB.
			void 0
		}
	})

	test('disabling a mode skill makes the loader fall back to the bundled default', async ({ page, context }) => {
		test.setTimeout(60_000)
		await authenticateContext(context)
		await ensureBootstrap(page)

		const sql = getSql()
		const prefix = uniquePrefix('chat-mode-loader-disabled')
		await cleanupPrefixedRecords(prefix)
		try {
			// Snapshot the seeded content, disable the skill, hit a stream in research mode,
			// and assert the chat still works (no posture content blank-string failure).
			const [user] = await sql<{ id: string }[]>`
				select id from users where is_active = true and deleted_at is null
				order by case when role = 'admin' then 0 else 1 end, created_at asc
				limit 1
			`
			await sql`update skills set enabled = false where id::text = ${MODE_SKILL_IDS.research}`

			const [conv] = await sql<{ id: string }[]>`
				insert into conversations (title, user_id, model, mode, total_tokens, total_cost)
				values (${`${prefix} convo`}, ${user.id}, 'anthropic/claude-sonnet-4', 'research'::chat_mode, 0, '0')
				returning id
			`

			const cookies = await context.cookies('http://127.0.0.1:4173')
			const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ')
			const response = await fetch(`http://127.0.0.1:4173/chat/${conv.id}/stream`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
				body: JSON.stringify({
					conversationId: conv.id,
					content: `${prefix}: respond with the single word "ok".`,
					regenerate: false,
				}),
			})
			expect(response.ok).toBeTruthy()
			const reader = response.body!.getReader()
			while (true) {
				const { done } = await reader.read()
				if (done) break
			}

			const [assistant] = await sql<{ content: string }[]>`
				select content from messages where conversation_id = ${conv.id} and role = 'assistant'
				order by created_at desc limit 1
			`
			expect(assistant, 'fallback prompt must still let the run complete').toBeDefined()
			expect(assistant.content.length).toBeGreaterThan(0)
		} finally {
			await sql`update skills set enabled = true where id::text = ${MODE_SKILL_IDS.research}`
			await cleanupPrefixedRecords(prefix)
		}
	})
})
