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

async function readContextStats(response: Response): Promise<Record<string, unknown> | null> {
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
	return contextStats
}

test.describe('skills/companion-suggest — auto-suggest pulls in companion summaries', () => {
	test('a sandbox-suggesting message pulls in the sandbox companion skill on round 0', async ({ context }) => {
		test.setTimeout(120_000)
		const prefix = uniquePrefix('companion-suggest-sandbox')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(context)
		const userId = await getActiveUserId()
		const sql = getSql()

		// Touch / so bootstrapDatabase seeds the companion skills before we query them.
		await fetch(BASE_URL + '/')

		const [conv] = await sql<{ id: string }[]>`
			insert into conversations (title, user_id, model, total_tokens, total_cost)
			values (${`${prefix} convo`}, ${userId}, 'anthropic/claude-sonnet-4', 0, '0')
			returning id
		`
		try {
			const cookie = await buildCookieHeader(context)
			// Strong sandbox keyword ("file", "edit") in the message → suggestCapabilityGroups
			// returns ['sandbox'] → companion lookup → tools/sandbox-fs surfaces in
			// `companion_skills` slot.
			const response = await fetch(`${BASE_URL}/chat/${conv.id}/stream`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Cookie: cookie },
				body: JSON.stringify({
					conversationId: conv.id,
					content: `${prefix}: I want to edit the auth file. Respond with the single word "ok".`,
					regenerate: false,
				}),
			})
			expect(response.ok).toBeTruthy()
			const stats = await readContextStats(response)
			expect(stats, 'context_stats must arrive').not.toBeNull()
			const includedSlots = (stats!.includedSlots ?? []) as string[]
			expect(includedSlots, 'companion_skills slot must be included when sandbox is suggested').toContain(
				'companion_skills',
			)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('a vague non-tool message does NOT add the companion_skills slot', async ({ context }) => {
		test.setTimeout(120_000)
		const prefix = uniquePrefix('companion-suggest-noop')
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
			// No tool-relevant keywords → suggested is empty → companion_skills NOT pushed.
			const response = await fetch(`${BASE_URL}/chat/${conv.id}/stream`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Cookie: cookie },
				body: JSON.stringify({
					conversationId: conv.id,
					content: `${prefix}: hello there. respond with the single word "ok".`,
					regenerate: false,
				}),
			})
			expect(response.ok).toBeTruthy()
			const stats = await readContextStats(response)
			const includedSlots = (stats?.includedSlots ?? []) as string[]
			expect(includedSlots, 'companion_skills slot should be absent when no group suggested').not.toContain(
				'companion_skills',
			)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})
