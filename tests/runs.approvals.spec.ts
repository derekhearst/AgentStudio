import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { authenticateContext, cleanupPrefixedRecords, getSql, uniquePrefix } from './helpers'

type RunRow = {
	id: string
	state: string
	pending_approvals: Array<{
		token: string
		toolName: string
		args: unknown
		requestedAt: string
		decision?: 'approved' | 'denied'
		decidedAt?: string
	}>
}

async function seedConversation(prefix: string) {
	const sql = getSql()
	const [user] = await sql<{ id: string }[]>`
		select id from users
		where is_active = true and deleted_at is null
		order by case when role = 'admin' then 0 else 1 end, created_at asc
		limit 1
	`
	if (!user) throw new Error('No active user found for seeding')

	const [conversation] = await sql<{ id: string }[]>`
		insert into conversations (title, user_id, model, total_tokens, total_cost)
		values (${`${prefix} Conversation`}, ${user.id}, ${'anthropic/claude-sonnet-4'}, 0, '0')
		returning id
	`

	const [run] = await sql<{ id: string }[]>`
		insert into chat_runs (conversation_id, user_id, state, source, label)
		values (${conversation.id}, ${user.id}, 'waiting_tool_approval', 'chat_stream', ${`${prefix} run`})
		returning id
	`

	return { userId: user.id, conversationId: conversation.id, runId: run.id }
}

async function readRun(runId: string): Promise<RunRow | null> {
	const sql = getSql()
	const [row] = await sql<RunRow[]>`
		select id, state, pending_approvals from chat_runs where id = ${runId}
	`
	return row ?? null
}

test.describe('runs/approvals — pending tool approvals are persistent', () => {
	test('approve via endpoint records decision on the chat_runs row', async ({ context }) => {
		const prefix = uniquePrefix('runs-approvals-approve')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(context)

		const sql = getSql()
		const seeded = await seedConversation(prefix)
		const token = randomUUID()

		try {
			await sql`
				update chat_runs
				set pending_approvals = ${sql.json([
					{
						token,
						toolName: 'shell',
						args: { command: 'echo hi' },
						requestedAt: new Date().toISOString(),
					},
				])}
				where id = ${seeded.runId}
			`

			const response = await context.request.post(`/chat/${seeded.conversationId}/tool-approve`, {
				data: { token, approved: true },
			})
			expect(response.ok(), 'tool-approve should succeed').toBeTruthy()
			expect(await response.json()).toEqual({ resolved: true })

			const row = await readRun(seeded.runId)
			expect(row, 'run row should exist').not.toBeNull()
			const entry = row!.pending_approvals.find((e) => e.token === token)
			expect(entry, 'approval entry should still be present until awaiter clears it').toBeDefined()
			expect(entry!.decision).toBe('approved')
			expect(entry!.decidedAt).toBeTruthy()
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('deny via endpoint records denied decision', async ({ context }) => {
		const prefix = uniquePrefix('runs-approvals-deny')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(context)

		const sql = getSql()
		const seeded = await seedConversation(prefix)
		const token = randomUUID()

		try {
			await sql`
				update chat_runs
				set pending_approvals = ${sql.json([
					{
						token,
						toolName: 'web_fetch',
						args: { url: 'https://example.com' },
						requestedAt: new Date().toISOString(),
					},
				])}
				where id = ${seeded.runId}
			`

			const response = await context.request.post(`/chat/${seeded.conversationId}/tool-approve`, {
				data: { token, approved: false },
			})
			expect(response.ok()).toBeTruthy()
			expect(await response.json()).toEqual({ resolved: true })

			const row = await readRun(seeded.runId)
			const entry = row!.pending_approvals.find((e) => e.token === token)
			expect(entry?.decision).toBe('denied')
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('unknown token returns resolved=false without mutating state', async ({ context }) => {
		const prefix = uniquePrefix('runs-approvals-unknown')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(context)

		const seeded = await seedConversation(prefix)
		const unknownToken = randomUUID()

		try {
			const response = await context.request.post(`/chat/${seeded.conversationId}/tool-approve`, {
				data: { token: unknownToken, approved: true },
			})
			expect(response.ok()).toBeTruthy()
			expect(await response.json()).toEqual({ resolved: false })

			const row = await readRun(seeded.runId)
			expect(row!.pending_approvals).toEqual([])
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('second approve on already-decided entry returns resolved=false', async ({ context }) => {
		const prefix = uniquePrefix('runs-approvals-double')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(context)

		const sql = getSql()
		const seeded = await seedConversation(prefix)
		const token = randomUUID()

		try {
			await sql`
				update chat_runs
				set pending_approvals = ${sql.json([
					{
						token,
						toolName: 'shell',
						args: {},
						requestedAt: new Date().toISOString(),
					},
				])}
				where id = ${seeded.runId}
			`

			const first = await context.request.post(`/chat/${seeded.conversationId}/tool-approve`, {
				data: { token, approved: true },
			})
			expect(await first.json()).toEqual({ resolved: true })

			const second = await context.request.post(`/chat/${seeded.conversationId}/tool-approve`, {
				data: { token, approved: false },
			})
			expect(await second.json()).toEqual({ resolved: false })

			const row = await readRun(seeded.runId)
			const entry = row!.pending_approvals.find((e) => e.token === token)
			expect(entry?.decision, 'first decision wins').toBe('approved')
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})
