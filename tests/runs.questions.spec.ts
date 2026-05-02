import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { authenticateContext, cleanupPrefixedRecords, getSql, uniquePrefix } from './helpers'

type RunRow = {
	id: string
	state: string
	pending_questions: Array<{
		token: string
		questions: Array<{
			header: string
			question: string
			options: Array<{ label: string; description?: string; recommended?: boolean }>
			allowFreeformInput: boolean
		}>
		requestedAt: string
		answers?: Record<string, string>
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
		values (${conversation.id}, ${user.id}, 'waiting_user_input', 'chat_stream', ${`${prefix} run`})
		returning id
	`

	return { userId: user.id, conversationId: conversation.id, runId: run.id }
}

async function readRun(runId: string): Promise<RunRow | null> {
	const sql = getSql()
	const [row] = await sql<RunRow[]>`
		select id, state, pending_questions from chat_runs where id = ${runId}
	`
	return row ?? null
}

const sampleQuestions = [
	{
		header: 'Mode',
		question: 'How should we proceed?',
		options: [
			{ label: 'Plan first', description: 'Outline before implementing' },
			{ label: 'Implement now', description: 'Skip planning' },
		],
		allowFreeformInput: false,
	},
]

test.describe('runs/questions — pending ask_user is persistent', () => {
	test('answer via endpoint records answers on the chat_runs row', async ({ context }) => {
		const prefix = uniquePrefix('runs-questions-answer')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(context)

		const sql = getSql()
		const seeded = await seedConversation(prefix)
		const token = randomUUID()

		try {
			await sql`
				update chat_runs
				set pending_questions = ${sql.json([
					{
						token,
						questions: sampleQuestions,
						requestedAt: new Date().toISOString(),
					},
				])}
				where id = ${seeded.runId}
			`

			const response = await context.request.post(`/chat/${seeded.conversationId}/ask-user`, {
				data: { token, answers: { Mode: 'Plan first' } },
			})
			expect(response.ok()).toBeTruthy()
			expect(await response.json()).toEqual({ resolved: true })

			const row = await readRun(seeded.runId)
			const entry = row!.pending_questions.find((e) => e.token === token)
			expect(entry, 'entry should still be present until awaiter clears it').toBeDefined()
			expect(entry!.answers).toEqual({ Mode: 'Plan first' })
			expect(entry!.decidedAt).toBeTruthy()
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('empty answers payload is rejected', async ({ context }) => {
		const prefix = uniquePrefix('runs-questions-empty')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(context)

		const seeded = await seedConversation(prefix)
		const token = randomUUID()

		try {
			const response = await context.request.post(`/chat/${seeded.conversationId}/ask-user`, {
				data: { token, answers: { '': '' } },
			})
			expect(response.status()).toBe(400)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('unknown token returns resolved=false', async ({ context }) => {
		const prefix = uniquePrefix('runs-questions-unknown')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(context)

		const seeded = await seedConversation(prefix)

		try {
			const response = await context.request.post(`/chat/${seeded.conversationId}/ask-user`, {
				data: { token: randomUUID(), answers: { Mode: 'Plan first' } },
			})
			expect(response.ok()).toBeTruthy()
			expect(await response.json()).toEqual({ resolved: false })
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('second answer on already-decided entry returns resolved=false', async ({ context }) => {
		const prefix = uniquePrefix('runs-questions-double')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(context)

		const sql = getSql()
		const seeded = await seedConversation(prefix)
		const token = randomUUID()

		try {
			await sql`
				update chat_runs
				set pending_questions = ${sql.json([
					{
						token,
						questions: sampleQuestions,
						requestedAt: new Date().toISOString(),
					},
				])}
				where id = ${seeded.runId}
			`

			const first = await context.request.post(`/chat/${seeded.conversationId}/ask-user`, {
				data: { token, answers: { Mode: 'Plan first' } },
			})
			expect(await first.json()).toEqual({ resolved: true })

			const second = await context.request.post(`/chat/${seeded.conversationId}/ask-user`, {
				data: { token, answers: { Mode: 'Implement now' } },
			})
			expect(await second.json()).toEqual({ resolved: false })

			const row = await readRun(seeded.runId)
			const entry = row!.pending_questions.find((e) => e.token === token)
			expect(entry?.answers, 'first answer wins').toEqual({ Mode: 'Plan first' })
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})
