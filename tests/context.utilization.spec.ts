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

test.describe('context/utilization — context_stats SSE event', () => {
	test('chat stream emits a context_stats event with token estimate + slot info', async ({ context }) => {
		test.setTimeout(120_000)
		const prefix = uniquePrefix('context-utilization')
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
					content: `${prefix}: respond with the single word "ok".`,
					regenerate: false,
				}),
			})
			expect(response.ok).toBeTruthy()

			const reader = response.body!.getReader()
			const decoder = new TextDecoder()
			let buffer = ''
			let contextStats: Record<string, unknown> | null = null
			while (true) {
				const { done, value } = await reader.read()
				if (done) break
				buffer += decoder.decode(value, { stream: true })
				const frames = buffer.split('\n\n')
				buffer = frames.pop() ?? ''
				for (const frame of frames) {
					const lines = frame.split('\n')
					const eventLine = lines.find((l) => l.startsWith('event: '))
					const dataLine = lines.find((l) => l.startsWith('data: '))
					if (!eventLine || !dataLine) continue
					if (eventLine.slice(7).trim() === 'context_stats') {
						contextStats = JSON.parse(dataLine.slice(6))
					}
				}
			}

			expect(contextStats, 'context_stats event must be emitted').not.toBeNull()
			const stats = contextStats as {
				tokenEstimate?: number
				contextWindow?: number
				didCompact?: boolean
				includedSlots?: string[]
				droppedSlots?: string[]
				truncatedSlots?: string[]
				systemPromptTokens?: number
			}
			expect(typeof stats.tokenEstimate).toBe('number')
			expect(stats.tokenEstimate!).toBeGreaterThan(0)
			expect(typeof stats.contextWindow).toBe('number')
			expect(stats.contextWindow!).toBeGreaterThan(0)
			expect(stats.didCompact).toBe(false)
			expect(Array.isArray(stats.includedSlots)).toBe(true)
			expect(stats.includedSlots).toContain('identity')
			expect(stats.includedSlots).toContain('tool_policy')
			expect(Array.isArray(stats.droppedSlots)).toBe(true)
			expect(Array.isArray(stats.truncatedSlots)).toBe(true)
			expect(typeof stats.systemPromptTokens).toBe('number')
			expect(stats.systemPromptTokens!).toBeGreaterThan(0)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})
