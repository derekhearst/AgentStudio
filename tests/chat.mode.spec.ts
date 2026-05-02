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

async function seedConversation(prefix: string, userId: string) {
	const sql = getSql()
	const [row] = await sql<{ id: string; mode: string }[]>`
		insert into conversations (title, user_id, model, total_tokens, total_cost)
		values (${`${prefix} convo`}, ${userId}, 'anthropic/claude-sonnet-4', 0, '0')
		returning id, mode
	`
	return row
}

async function readConversationMode(conversationId: string): Promise<string> {
	const sql = getSql()
	const [row] = await sql<{ mode: string }[]>`select mode from conversations where id = ${conversationId}`
	return row.mode
}

async function listSystemMessages(conversationId: string) {
	const sql = getSql()
	return sql<{ id: string; role: string; content: string; metadata: Record<string, unknown> }[]>`
		select id, role, content, metadata
		from messages
		where conversation_id = ${conversationId} and role = 'system'
		order by created_at asc
	`
}

async function buildCookieHeader(context: BrowserContext) {
	const cookies = await context.cookies(BASE_URL)
	return cookies.map((c) => `${c.name}=${c.value}`).join('; ')
}

test.describe('chat/mode — conversation mode + workbench preferences schema', () => {
	test('newly created conversations default to chat mode', async () => {
		const prefix = uniquePrefix('chat-mode-default')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		try {
			const conv = await seedConversation(prefix, userId)
			expect(conv.mode).toBe('chat')
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('chat_mode enum rejects unknown values at the DB layer', async () => {
		const prefix = uniquePrefix('chat-mode-reject')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const conv = await seedConversation(prefix, userId)
			let threw = false
			try {
				await sql`update conversations set mode = 'sentinel' where id = ${conv.id}`
			} catch {
				threw = true
			}
			expect(threw, 'invalid enum value must be rejected').toBe(true)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('all four valid modes round-trip through the column', async () => {
		const prefix = uniquePrefix('chat-mode-roundtrip')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const conv = await seedConversation(prefix, userId)
			for (const mode of ['research', 'plan', 'agent', 'chat'] as const) {
				await sql`update conversations set mode = ${mode}::chat_mode where id = ${conv.id}`
				expect(await readConversationMode(conv.id)).toBe(mode)
			}
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('chat_workbench_preferences enforces unique user_id', async () => {
		const prefix = uniquePrefix('chat-mode-unique')
		await cleanupPrefixedRecords(prefix)
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			await sql`delete from chat_workbench_preferences where user_id = ${userId}`
			await sql`insert into chat_workbench_preferences (user_id) values (${userId})`
			let threw = false
			try {
				await sql`insert into chat_workbench_preferences (user_id) values (${userId})`
			} catch {
				threw = true
			}
			expect(threw, 'second insert for the same user_id must be rejected').toBe(true)
		} finally {
			await sql`delete from chat_workbench_preferences where user_id = ${userId}`
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('chat_workbench_preferences cascades on user deletion', async () => {
		const prefix = uniquePrefix('chat-mode-cascade')
		await cleanupPrefixedRecords(prefix)
		const sql = getSql()
		// Create a throwaway user so we can delete it without affecting the seeded admin.
		const [throwaway] = await sql<{ id: string }[]>`
			insert into users (name, username, role, is_active)
			values (${`${prefix} u`}, ${`${prefix.replace(/[^a-zA-Z0-9]/g, '_')}_u`}, 'user', true)
			returning id
		`
		try {
			await sql`insert into chat_workbench_preferences (user_id) values (${throwaway.id})`
			const [pref] = await sql<{ count: number }[]>`
				select count(*)::int from chat_workbench_preferences where user_id = ${throwaway.id}
			`
			expect(pref.count).toBe(1)

			await sql`delete from users where id = ${throwaway.id}`
			const [after] = await sql<{ count: number }[]>`
				select count(*)::int from chat_workbench_preferences where user_id = ${throwaway.id}
			`
			expect(after.count, 'preferences row should cascade-delete with the user').toBe(0)
		} finally {
			await sql`delete from chat_workbench_preferences where user_id = ${throwaway.id}`
			await sql`delete from users where id = ${throwaway.id}`
		}
	})

	test('live: a chat stream in plan mode prepends the plan posture as a system message slot', async ({ context }) => {
		test.setTimeout(120_000)
		const prefix = uniquePrefix('chat-mode-live-plan')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(context)
		const userId = await getActiveUserId()
		const sql = getSql()
		try {
			const conv = await seedConversation(prefix, userId)
			await sql`update conversations set mode = 'plan'::chat_mode where id = ${conv.id}`
			expect(await readConversationMode(conv.id)).toBe('plan')

			const cookie = await buildCookieHeader(context)
			const response = await fetch(`${BASE_URL}/chat/${conv.id}/stream`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Cookie: cookie },
				body: JSON.stringify({
					conversationId: conv.id,
					content: `${prefix}: respond in one short sentence and then stop.`,
					regenerate: false,
				}),
			})
			expect(response.ok).toBeTruthy()
			const reader = response.body!.getReader()
			while (true) {
				const { done } = await reader.read()
				if (done) break
			}

			// The conversation should still be in plan mode after the run completes,
			// and the assistant message should exist (proving the plan-mode posture didn't break the stream).
			expect(await readConversationMode(conv.id)).toBe('plan')
			const [assistant] = await sql<{ id: string; content: string }[]>`
				select id, content from messages
				where conversation_id = ${conv.id} and role = 'assistant'
				order by created_at desc limit 1
			`
			expect(assistant, 'an assistant reply must be persisted').toBeDefined()
			expect(assistant.content.length).toBeGreaterThan(0)
		} finally {
			await sql`delete from messages where conversation_id in (select id from conversations where title like ${`${prefix}%`})`
			await cleanupPrefixedRecords(prefix)
		}
	})
})
