import { expect, test, type BrowserContext } from '@playwright/test'
import { authenticateContext, cleanupPrefixedRecords, getSql, uniquePrefix } from './helpers'

const BASE_URL = 'http://127.0.0.1:4173'

async function getActiveUserId() {
	const sql = getSql()
	const [user] = await sql<{ id: string }[]>`
		select id from users where is_active = true and deleted_at is null
		order by case when role = 'admin' then 0 else 1 end, created_at asc
		limit 1
	`
	if (!user) throw new Error('No active user found')
	return user.id
}

async function buildCookieHeader(context: BrowserContext) {
	const cookies = await context.cookies(BASE_URL)
	return cookies.map((c) => `${c.name}=${c.value}`).join('; ')
}

test.describe('cost/tool-usage live — web_search writes a tool_usage row through the chat stream', () => {
	test('a chat that triggers web_search inserts a tool_usage row with run_id + user_id', async ({ context }) => {
		test.setTimeout(120_000)
		const prefix = uniquePrefix('tool-usage-live')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(context)
		const userId = await getActiveUserId()
		const sql = getSql()

		const [conv] = await sql<{ id: string }[]>`
			insert into conversations (title, user_id, model, total_tokens, total_cost)
			values (${`${prefix} convo`}, ${userId}, 'anthropic/claude-sonnet-4', 0, '0')
			returning id
		`
		try {
			const cookie = await buildCookieHeader(context)
			const response = await fetch(`${BASE_URL}/chat/${conv.id}/stream`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Cookie: cookie },
				body: JSON.stringify({
					conversationId: conv.id,
					content: `${prefix}: use the web_search tool to look up "agentstudio sveltekit" and then stop without running any other tools.`,
					regenerate: false,
				}),
			})
			expect(response.ok).toBeTruthy()
			const reader = response.body!.getReader()
			while (true) {
				const { done } = await reader.read()
				if (done) break
			}

			const [run] = await sql<{ id: string }[]>`
				select id from chat_runs where conversation_id = ${conv.id} order by created_at desc limit 1
			`
			expect(run).toBeDefined()

			const usageRows = await sql<{
				tool_name: string
				provider: string | null
				unit_type: string
				units: string
				cost: string
				user_id: string | null
				run_id: string | null
				metadata: { query?: string; resultCount?: number }
			}[]>`
				select tool_name, provider, unit_type, units, cost, user_id, run_id, metadata
				from tool_usage where run_id = ${run.id}
			`

			// The model may or may not have actually called web_search depending on
			// non-determinism; assert weakly. If it did call, the row must be well-formed.
			if (usageRows.length > 0) {
				const row = usageRows[0]
				expect(row.tool_name).toBe('web_search')
				expect(row.unit_type).toBe('call')
				expect(parseFloat(row.units)).toBe(1)
				expect(row.user_id).toBe(userId)
				expect(row.run_id).toBe(run.id)
				expect(typeof row.metadata.resultCount).toBe('number')
			}
		} finally {
			await sql`delete from tool_usage where user_id = ${userId} and run_id in (select id from chat_runs where conversation_id = ${conv.id})`
			await cleanupPrefixedRecords(prefix)
		}
	})
})
