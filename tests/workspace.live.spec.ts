import { resolve } from 'node:path'
import { stat, readFile, rm } from 'node:fs/promises'
import { expect, test, type BrowserContext } from '@playwright/test'
import { authenticateContext, cleanupPrefixedRecords, getSql, uniquePrefix } from './helpers'

const BASE_URL = 'http://127.0.0.1:4173'
const STREAM_TIMEOUT_MS = 90_000

async function buildCookieHeader(context: BrowserContext) {
	const cookies = await context.cookies(BASE_URL)
	return cookies.map((c) => `${c.name}=${c.value}`).join('; ')
}

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

async function setApprovalRequiredTools(userId: string, tools: string[]) {
	const sql = getSql()
	await sql`
		update app_settings
		set tool_config = jsonb_set(coalesce(tool_config, '{}'::jsonb), '{approvalRequiredTools}', ${sql.json(tools)}, true),
		    updated_at = now()
		where user_id = ${userId}
	`
}

async function readChatRunId(conversationId: string): Promise<string> {
	const sql = getSql()
	const [row] = await sql<{ id: string }[]>`
		select id from chat_runs where conversation_id = ${conversationId} order by created_at desc limit 1
	`
	if (!row) throw new Error('No chat_run row for conversation')
	return row.id
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path)
		return true
	} catch {
		return false
	}
}

test.describe('workspace/live — per-run sandbox isolation through chat stream', () => {
	test.describe.configure({ mode: 'serial' })

	test('a file_write tool call lands in <sandbox>/<userId>/runs/<runId>/, not the legacy user dir', async ({
		context,
	}) => {
		test.setTimeout(STREAM_TIMEOUT_MS * 2)
		const prefix = uniquePrefix('workspace-live')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(context)
		const userId = await getActiveUserId()
		// Disable approval so the LLM can call shell without intervention.
		await setApprovalRequiredTools(userId, [])

		const sql = getSql()
		const [conv] = await sql<{ id: string }[]>`
			insert into conversations (title, user_id, model, total_tokens, total_cost)
			values (${`${prefix} ws`}, ${userId}, 'anthropic/claude-sonnet-4', 0, '0')
			returning id
		`

		const sandboxRoot = process.env.SANDBOX_WORKSPACE || '.sandbox'
		const fileName = `${prefix.replace(/[^a-zA-Z0-9_-]/g, '_')}.txt`
		const fileContent = `${prefix}-content`
		const cookie = await buildCookieHeader(context)
		const abort = new AbortController()
		try {
			const response = await fetch(`${BASE_URL}/chat/${conv.id}/stream`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Cookie: cookie },
				body: JSON.stringify({
					conversationId: conv.id,
					content: `Use the file_write tool exactly once to write a file. path: "${fileName}", content: "${fileContent}". Do not produce any other tool calls or text first.`,
					regenerate: false,
				}),
				signal: abort.signal,
			})
			expect(response.ok).toBeTruthy()
			expect(response.body).toBeTruthy()
			// Drain to completion so the tool call actually runs.
			const reader = response.body!.getReader()
			const decoder = new TextDecoder()
			let buf = ''
			const eventTypes: string[] = []
			while (true) {
				const { done, value } = await reader.read()
				if (done) break
				buf += decoder.decode(value, { stream: true })
				const frames = buf.split('\n\n')
				buf = frames.pop() ?? ''
				for (const frame of frames) {
					const eventLine = frame.split('\n').find((l) => l.startsWith('event: '))
					if (eventLine) eventTypes.push(eventLine.slice(7).trim())
				}
			}
			// Sanity check: the SSE stream should have emitted a tool_result.
			expect(eventTypes).toContain('tool_call')
			expect(eventTypes).toContain('tool_result')

			const runId = await readChatRunId(conv.id)
			const expectedPerRun = resolve(process.cwd(), sandboxRoot, userId, 'runs', runId, fileName)
			const legacyUserPath = resolve(process.cwd(), sandboxRoot, userId, fileName)

			expect(await exists(expectedPerRun), `expected file at per-run path: ${expectedPerRun}`).toBe(true)
			expect(await exists(legacyUserPath), `file should NOT be at legacy user path: ${legacyUserPath}`).toBe(false)

			const written = await readFile(expectedPerRun, 'utf-8')
			expect(written).toContain(fileContent)
		} finally {
			abort.abort()
			// Clean up the per-run dir so the worktree's .sandbox stays tidy.
			try {
				const runId = await readChatRunId(conv.id).catch(() => null)
				if (runId) {
					const dir = resolve(process.cwd(), sandboxRoot, userId, 'runs', runId)
					await rm(dir, { recursive: true, force: true })
				}
			} catch {
				// best-effort
			}
			await cleanupPrefixedRecords(prefix)
		}
	})
})
