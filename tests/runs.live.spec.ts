import { expect, test, type BrowserContext } from '@playwright/test'
import { authenticateContext, cleanupPrefixedRecords, getSql, uniquePrefix } from './helpers'

const BASE_URL = 'http://127.0.0.1:4173'
const STREAM_TIMEOUT_MS = 90_000

type SseEvent = { id?: number; type: string; data: Record<string, unknown> }

async function buildCookieHeader(context: BrowserContext) {
	const cookies = await context.cookies(BASE_URL)
	return cookies.map((c) => `${c.name}=${c.value}`).join('; ')
}

async function readSseUntil(
	body: ReadableStream<Uint8Array>,
	predicate: (events: SseEvent[]) => boolean,
	options: { onEvent?: (event: SseEvent) => void; abort?: AbortController } = {},
): Promise<SseEvent[]> {
	const reader = body.getReader()
	const decoder = new TextDecoder()
	let buffer = ''
	const events: SseEvent[] = []
	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			buffer += decoder.decode(value, { stream: true })
			const frames = buffer.split('\n\n')
			buffer = frames.pop() ?? ''
			for (const frame of frames) {
				const lines = frame.split('\n')
				const idLine = lines.find((l) => l.startsWith('id: '))
				const eventLine = lines.find((l) => l.startsWith('event: '))
				const dataLine = lines.find((l) => l.startsWith('data: '))
				if (!eventLine || !dataLine) continue
				const id = idLine ? Number.parseInt(idLine.slice(4).trim(), 10) : undefined
				const ev: SseEvent = {
					id: Number.isFinite(id) ? (id as number) : undefined,
					type: eventLine.slice(7).trim(),
					data: JSON.parse(dataLine.slice(6)),
				}
				events.push(ev)
				options.onEvent?.(ev)
				if (predicate(events)) return events
			}
		}
	} finally {
		try {
			reader.releaseLock()
		} catch {
			// reader may already be cancelled
		}
	}
	return events
}

async function setApprovalRequiredTools(userId: string, tools: string[]) {
	const sql = getSql()
	await sql`
		update app_settings
		set tool_config = jsonb_set(coalesce(tool_config, '{}'::jsonb), '{approvalRequiredTools}', ${sql.json(tools)}, true),
		    updated_at = now()
		where user_id = ${userId}
	`
}

async function seedConversationOwnedBy(userId: string, prefix: string) {
	const sql = getSql()
	const [row] = await sql<{ id: string }[]>`
		insert into conversations (title, user_id, model, total_tokens, total_cost)
		values (${`${prefix} live`}, ${userId}, ${'anthropic/claude-sonnet-4'}, 0, '0')
		returning id
	`
	return row.id
}

async function getActiveUserId() {
	const sql = getSql()
	const [user] = await sql<{ id: string }[]>`
		select id from users
		where is_active = true and deleted_at is null
		order by case when role = 'admin' then 0 else 1 end, created_at asc
		limit 1
	`
	if (!user) throw new Error('No active user found')
	return user.id
}

async function readChatRun(conversationId: string) {
	const sql = getSql()
	const [row] = await sql<
		{
			id: string
			state: string
			pending_approvals: Array<{ token: string; toolName: string; decision?: string }>
			pending_questions: Array<{ token: string; answers?: Record<string, string> }>
			stream_blocks: Array<Record<string, unknown>>
			current_round: number
			next_event_seq: number
		}[]
	>`
		select id, state, pending_approvals, pending_questions, stream_blocks, current_round, next_event_seq
		from chat_runs
		where conversation_id = ${conversationId}
		order by created_at desc
		limit 1
	`
	return row
}

async function listRunEvents(runId: string) {
	const sql = getSql()
	return sql<{ seq: number; type: string; payload: Record<string, unknown> }[]>`
		select seq, type, payload from run_events where run_id = ${runId} order by seq asc
	`
}

type PersistedBlock = {
	kind: 'thinking' | 'text' | 'tool'
	content?: string
	name?: string
	arguments?: unknown
	result?: unknown
	success?: boolean
	executionMs?: number
	reasoningTokens?: number | null
}

type PersistedMessage = {
	id: string
	role: string
	content: string
	metadata: { blocks?: PersistedBlock[] } & Record<string, unknown>
	tool_calls: Array<Record<string, unknown>>
	created_at: Date
}

async function listConversationMessages(conversationId: string): Promise<PersistedMessage[]> {
	const sql = getSql()
	return sql<PersistedMessage[]>`
		select id, role, content, metadata, tool_calls, created_at
		from messages
		where conversation_id = ${conversationId}
		order by created_at asc
	`
}

function expectGaplessSeq(events: SseEvent[]) {
	const withSeq = events.filter((e) => e.id !== undefined).map((e) => e.id as number)
	expect(withSeq.length).toBeGreaterThan(0)
	for (let i = 1; i < withSeq.length; i++) {
		expect(withSeq[i], `seq must monotonically increase (saw ${withSeq[i - 1]} then ${withSeq[i]})`).toBe(
			withSeq[i - 1] + 1,
		)
	}
}

async function postChatStream(cookie: string, conversationId: string, content: string, signal?: AbortSignal) {
	const response = await fetch(`${BASE_URL}/chat/${conversationId}/stream`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Cookie: cookie },
		body: JSON.stringify({ conversationId, content, regenerate: false }),
		signal,
	})
	if (!response.ok || !response.body) {
		const text = await response.text().catch(() => '')
		throw new Error(`stream POST failed: ${response.status} ${text.slice(0, 200)}`)
	}
	return response.body as ReadableStream<Uint8Array>
}

async function getResumeStream(cookie: string, conversationId: string, since: number, signal?: AbortSignal) {
	const response = await fetch(`${BASE_URL}/chat/${conversationId}/stream/resume?since=${since}`, {
		headers: { Cookie: cookie },
		signal,
	})
	if (!response.ok || !response.body) {
		const text = await response.text().catch(() => '')
		throw new Error(`resume GET failed: ${response.status} ${text.slice(0, 200)}`)
	}
	return response.body as ReadableStream<Uint8Array>
}

test.describe('runs/live — durable runs through real LLM calls', () => {
	test.describe.configure({ mode: 'serial' })

	test('approval flow persists, resolves via endpoint, and emits gapless events', async ({ context }) => {
		test.setTimeout(STREAM_TIMEOUT_MS + 30_000)
		const prefix = uniquePrefix('runs-live-approval')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(context)
		const userId = await getActiveUserId()
		await setApprovalRequiredTools(userId, ['*'])

		const conversationId = await seedConversationOwnedBy(userId, prefix)
		const prompt = `Use the shell tool to run the command \`echo "${prefix}-payload"\`. Do not produce any other tool calls or text first.`

		const cookie = await buildCookieHeader(context)
		const abort = new AbortController()
		try {
			const body = await postChatStream(cookie, conversationId, prompt, abort.signal)
			let pendingToken: string | null = null
			const collectedEvents: SseEvent[] = []
			await readSseUntil(
				body,
				(events) => {
					const last = events[events.length - 1]
					if (last?.type === 'tool_pending' && typeof last.data.token === 'string') {
						pendingToken = last.data.token
						return true
					}
					return false
				},
				{ onEvent: (e) => collectedEvents.push(e) },
			)
			expect(pendingToken, 'expected tool_pending event with token').toBeTruthy()

			const runMid = await readChatRun(conversationId)
			expect(runMid.state).toBe('waiting_tool_approval')
			expect(runMid.pending_approvals.find((e) => e.token === pendingToken)).toMatchObject({
				toolName: 'shell',
			})
			expect(runMid.pending_approvals.find((e) => e.token === pendingToken)?.decision).toBeUndefined()
			expect(runMid.next_event_seq).toBeGreaterThan(0)

			const approveRes = await context.request.post(`/chat/${conversationId}/tool-approve`, {
				data: { token: pendingToken, approved: true },
			})
			expect(await approveRes.json()).toEqual({ resolved: true })

			await readSseUntil(
				body,
				(events) => events.some((e) => e.type === 'done'),
				{ onEvent: (e) => collectedEvents.push(e) },
			)

			const runFinal = await readChatRun(conversationId)
			expect(runFinal.pending_approvals).toEqual([])
			expect(runFinal.stream_blocks.length).toBeGreaterThan(0)
			expect(runFinal.stream_blocks.some((b) => b.kind === 'tool')).toBeTruthy()
			expect(['running', 'completed']).toContain(runFinal.state)
			expect(runFinal.current_round).toBeGreaterThanOrEqual(1)

			const events = await listRunEvents(runFinal.id)
			expect(events.length).toBeGreaterThan(0)
			expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1))
			expect(events.some((e) => e.type === 'tool_pending')).toBeTruthy()
			expect(events.some((e) => e.type === 'tool_call')).toBeTruthy()
			expect(events.some((e) => e.type === 'tool_result')).toBeTruthy()
			expect(events.some((e) => e.type === 'done')).toBeTruthy()
			expect(events.every((e) => e.type !== 'delta' && e.type !== 'reasoning')).toBeTruthy()

			// SSE order: every event with a seq id must be a strict +1 over the previous one,
			// and the SSE-observed order must match the persisted run_events order.
			expectGaplessSeq(collectedEvents)
			const sseTypesWithSeq = collectedEvents.filter((e) => e.id !== undefined).map((e) => e.type)
			expect(sseTypesWithSeq).toEqual(events.map((e) => e.type))

			// Post-render: the assistant message must contain the streamed blocks in the same order,
			// and the user prompt must still be there (nothing got deleted).
			const persisted = await listConversationMessages(conversationId)
			const userMsg = persisted.find((m) => m.role === 'user')
			expect(userMsg, 'original user prompt must be retained').toBeDefined()
			expect(userMsg!.content).toContain(`${prefix}-payload`)

			const assistantMsg = persisted.find((m) => m.role === 'assistant')
			expect(assistantMsg, 'assistant message must be persisted on done').toBeDefined()
			const persistedBlocks = assistantMsg!.metadata.blocks ?? []
			expect(persistedBlocks.length).toEqual(runFinal.stream_blocks.length)
			expect(persistedBlocks.map((b) => b.kind)).toEqual(runFinal.stream_blocks.map((b) => b.kind))
			expect(persistedBlocks.some((b) => b.kind === 'tool' && b.name === 'shell')).toBeTruthy()
			const shellBlock = persistedBlocks.find((b) => b.kind === 'tool' && b.name === 'shell')!
			expect(shellBlock.success).toBe(true)
			expect(assistantMsg!.tool_calls.some((tc) => tc.name === 'shell')).toBeTruthy()
		} finally {
			abort.abort()
			await setApprovalRequiredTools(userId, [])
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('ask_user flow persists, resolves via endpoint, and emits a gapless event log', async ({ context }) => {
		test.setTimeout(STREAM_TIMEOUT_MS + 30_000)
		const prefix = uniquePrefix('runs-live-askuser')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(context)
		const userId = await getActiveUserId()
		await setApprovalRequiredTools(userId, [])

		const conversationId = await seedConversationOwnedBy(userId, prefix)
		const prompt = `Use the ask_user tool exactly once to ask me which color I prefer with options "red" and "blue". Header should be "Color". Do not write any other text first.`

		const cookie = await buildCookieHeader(context)
		const abort = new AbortController()
		try {
			const body = await postChatStream(cookie, conversationId, prompt, abort.signal)
			let questionToken: string | null = null
			const collected: SseEvent[] = []
			await readSseUntil(
				body,
				(events) => {
					const last = events[events.length - 1]
					if (last?.type === 'ask_user' && typeof last.data.token === 'string') {
						questionToken = last.data.token
						return true
					}
					return false
				},
				{ onEvent: (e) => collected.push(e) },
			)
			expect(questionToken, 'expected ask_user event with token').toBeTruthy()

			const runMid = await readChatRun(conversationId)
			expect(runMid.state).toBe('waiting_user_input')
			expect(runMid.pending_questions.find((e) => e.token === questionToken)).toBeDefined()
			expect(runMid.pending_questions.find((e) => e.token === questionToken)?.answers).toBeUndefined()

			const answerRes = await context.request.post(`/chat/${conversationId}/ask-user`, {
				data: { token: questionToken, answers: { Color: 'blue' } },
			})
			expect(await answerRes.json()).toEqual({ resolved: true })

			await readSseUntil(
				body,
				(events) => events.some((e) => e.type === 'done'),
				{ onEvent: (e) => collected.push(e) },
			)

			const runFinal = await readChatRun(conversationId)
			expect(runFinal.pending_questions).toEqual([])
			expect(runFinal.stream_blocks.some((b) => b.kind === 'tool' && b.name === 'ask_user')).toBeTruthy()

			const events = await listRunEvents(runFinal.id)
			expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1))
			expect(events.some((e) => e.type === 'ask_user')).toBeTruthy()
			expect(events.some((e) => e.type === 'tool_result')).toBeTruthy()
			expect(events.some((e) => e.type === 'done')).toBeTruthy()

			// SSE-observed order matches persisted event log order.
			expectGaplessSeq(collected)
			const sseTypesWithSeq = collected.filter((e) => e.id !== undefined).map((e) => e.type)
			expect(sseTypesWithSeq).toEqual(events.map((e) => e.type))

			// Question + answer must remain visible in the persisted assistant message
			// (this is what users see if they reload the chat — the question should not vanish).
			const persisted = await listConversationMessages(conversationId)
			const userMsg = persisted.find((m) => m.role === 'user')
			expect(userMsg, 'original user prompt must be retained').toBeDefined()

			const assistantMsg = persisted.find((m) => m.role === 'assistant')
			expect(assistantMsg).toBeDefined()
			const persistedBlocks = assistantMsg!.metadata.blocks ?? []
			const askBlock = persistedBlocks.find((b) => b.kind === 'tool' && b.name === 'ask_user')
			expect(askBlock, 'ask_user must remain visible as a tool block in the saved message').toBeDefined()

			const askArgs = askBlock!.arguments as { questions?: Array<{ header?: string }> }
			expect(askArgs.questions?.[0]?.header).toBe('Color')

			const askResult = askBlock!.result as { answers?: Record<string, string>; timedOut?: boolean }
			expect(askResult.answers).toEqual({ Color: 'blue' })
			expect(askResult.timedOut).toBe(false)
			expect(askBlock!.success).toBe(true)

			// Persisted streamBlocks (run row) and rendered blocks (message row) agree on order.
			expect(persistedBlocks.map((b) => b.kind)).toEqual(runFinal.stream_blocks.map((b) => b.kind))
			expect(persistedBlocks.length).toBeGreaterThan(0)
		} finally {
			abort.abort()
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('resume endpoint replays missed events while a run waits for approval', async ({ context }) => {
		test.setTimeout(STREAM_TIMEOUT_MS + 30_000)
		const prefix = uniquePrefix('runs-live-resume')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(context)
		const userId = await getActiveUserId()
		await setApprovalRequiredTools(userId, ['*'])

		const conversationId = await seedConversationOwnedBy(userId, prefix)
		const prompt = `Use the shell tool to run \`echo "${prefix}-resume"\`. No other output first.`

		const cookie = await buildCookieHeader(context)
		const initialAbort = new AbortController()
		const resumeAbort = new AbortController()
		try {
			const initialBody = await postChatStream(cookie, conversationId, prompt, initialAbort.signal)
			let pendingToken: string | null = null
			let lastSeqFromInitial = 0
			await readSseUntil(initialBody, (events) => {
				const last = events[events.length - 1]
				if (last?.id !== undefined) lastSeqFromInitial = last.id
				if (last?.type === 'tool_pending' && typeof last.data.token === 'string') {
					pendingToken = last.data.token
					return true
				}
				return false
			})
			expect(pendingToken).toBeTruthy()
			expect(lastSeqFromInitial).toBeGreaterThan(0)

			// Drop the initial SSE reader (simulates the client losing the stream),
			// then approve the tool and let /resume tail to completion.
			initialAbort.abort()

			const approveRes = await context.request.post(`/chat/${conversationId}/tool-approve`, {
				data: { token: pendingToken, approved: true },
			})
			expect(await approveRes.json()).toEqual({ resolved: true })

			const resumeBody = await getResumeStream(
				cookie,
				conversationId,
				lastSeqFromInitial,
				resumeAbort.signal,
			)

			const replayEvents: SseEvent[] = []
			await readSseUntil(
				resumeBody,
				(events) => events.some((e) => e.type === 'done'),
				{ onEvent: (e) => replayEvents.push(e) },
			)

			expect(replayEvents.length).toBeGreaterThan(0)
			for (const ev of replayEvents) {
				if (ev.id !== undefined) expect(ev.id).toBeGreaterThan(lastSeqFromInitial)
			}
			// Replayed events must be in seq order (no duplicates, no skips on the resumed segment).
			const replaySeqs = replayEvents.filter((e) => e.id !== undefined).map((e) => e.id as number)
			for (let i = 1; i < replaySeqs.length; i++) {
				expect(replaySeqs[i]).toBe(replaySeqs[i - 1] + 1)
			}
			expect(replayEvents.some((e) => e.type === 'tool_call')).toBeTruthy()
			expect(replayEvents.some((e) => e.type === 'tool_result')).toBeTruthy()
			expect(replayEvents[replayEvents.length - 1].type).toBe('done')

			const runFinal = await readChatRun(conversationId)
			expect(runFinal.pending_approvals).toEqual([])

			// Combined initial + replayed seq covers the full event log without gaps,
			// and the persisted assistant message exists with non-empty blocks.
			const allEvents = await listRunEvents(runFinal.id)
			expect(allEvents.map((e) => e.seq)).toEqual(allEvents.map((_, i) => i + 1))
			const persisted = await listConversationMessages(conversationId)
			expect(persisted.some((m) => m.role === 'user')).toBeTruthy()
			const assistantMsg = persisted.find((m) => m.role === 'assistant')
			expect(assistantMsg).toBeDefined()
			expect((assistantMsg!.metadata.blocks ?? []).length).toBeGreaterThan(0)
		} finally {
			resumeAbort.abort()
			await setApprovalRequiredTools(userId, [])
			await cleanupPrefixedRecords(prefix)
		}
	})
})
