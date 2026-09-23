import { expect, test } from '@playwright/test'
import {
	codeFence,
	EXPORT_FORMAT,
	exportContentDisposition,
	exportConversationJson,
	exportConversationMarkdown,
	exportFileNames,
	type ExportInput,
	type ExportMessage,
} from '../src/lib/chat/conversation-export'
import { authenticateContext, cleanupPrefixedRecords, getActiveUserId, getSql, uniquePrefix } from './helpers'

/**
 * #18 — exporting one conversation.
 *
 * The first half is the formatter, pure: blocks in order, fences the content cannot close,
 * long output shortened in Markdown with a pointer to the JSON, and JSON with everything but
 * the owner's id. The second half is the download route: an attachment that is not cached,
 * 400 for an unknown format, 404 for someone else's conversation, and refused without a
 * session.
 */

const at = new Date('2026-09-23T14:02:00Z')

function message(overrides: Partial<ExportMessage>): ExportMessage {
	return {
		id: '00000000-0000-4000-8000-000000000001',
		sequence: 1,
		role: 'user',
		content: '',
		model: null,
		parentMessageId: null,
		createdAt: at,
		tokensIn: 0,
		tokensOut: 0,
		cost: '0',
		attachments: [],
		metadata: {},
		toolCalls: [],
		...overrides,
	}
}

function input(messages: ExportMessage[]): ExportInput {
	return {
		conversation: {
			id: '00000000-0000-4000-8000-0000000000aa',
			title: 'Fix the login page',
			category: null,
			model: 'claude-sonnet-5',
			agentId: null,
			projectId: null,
			permissionMode: 'default',
			totalTokens: 1234,
			totalCost: '0.0123',
			pinnedAt: at,
			archivedAt: null,
			createdAt: at,
			updatedAt: at,
		},
		agent: { id: '00000000-0000-4000-8000-0000000000bb', name: 'Chat' },
		messages,
		exportedAt: at,
	}
}

const EDIT_BLOCK = {
	kind: 'tool',
	name: 'Edit',
	arguments: { file_path: 'src/routes/login/+page.svelte', old_string: 'a', new_string: 'b' },
	result: 'ok',
	success: true,
	executionMs: 3,
	details: {
		kind: 'file_edit',
		tool: 'Edit',
		path: 'src/routes/login/+page.svelte',
		changeType: 'update',
		hunks: [{ oldStart: 4, oldLines: 1, newStart: 4, newLines: 1, lines: ['-old line', '+new line'] }],
		additions: 1,
		deletions: 1,
		unavailable: 'none',
		truncated: false,
	},
}

test.describe('conversation export — the formatter', () => {
	test('Markdown has a header and each message with its blocks in order', () => {
		const md = exportConversationMarkdown(
			input([
				message({ sequence: 1, role: 'user', content: 'Why does login fail?' }),
				message({
					id: '00000000-0000-4000-8000-000000000002',
					sequence: 2,
					role: 'assistant',
					model: 'claude-sonnet-5',
					content: 'Found it.',
					metadata: {
						blocks: [
							{ kind: 'thinking', content: 'Check the form action.' },
							{ kind: 'text', content: 'Found it.' },
							EDIT_BLOCK,
							{
								kind: 'tool',
								name: 'Bash',
								arguments: { command: 'bun run check' },
								result: '0 errors',
								success: true,
								executionMs: 900,
								details: { kind: 'shell', tool: 'Bash', command: 'bun run check', description: 'Type-check', stdout: '0 errors', stderr: '', interrupted: false, backgroundTaskId: null, timedOutAfterMs: null, persistedOutputPath: null, truncated: false },
							},
							{ kind: 'subagent', agentId: 't', agentName: 'Researcher', conversationId: null, task: 'read the docs', content: 'The docs say X.', success: true },
							{ kind: 'notice', notice: { kind: 'compacted', level: 'info', title: 'Earlier messages were summarised', detail: null, persist: true } },
						],
					},
				}),
			]),
		)

		expect(md).toContain('# Fix the login page')
		expect(md).toContain('- Exported: 2026-09-23 14:02 UTC')
		expect(md).toContain('- Agent: Chat')
		expect(md).toContain('- Tokens: 1,234 · Cost: $0.0123')
		expect(md).toContain('- Status: Pinned')
		expect(md).toContain('## You · 2026-09-23 14:02 UTC\n\nWhy does login fail?')
		expect(md).toContain('## Assistant (claude-sonnet-5) · 2026-09-23 14:02 UTC')
		expect(md).toContain('<details><summary>Thinking</summary>')
		expect(md).toContain('**Tool · Edit** `src/routes/login/+page.svelte` (+1 −1) ✓')
		expect(md).toContain('```diff\n@@ -4,1 +4,1 @@\n-old line\n+new line\n```')
		expect(md).toContain('**Tool · Bash** ✓ — Type-check')
		expect(md).toContain('```sh\n$ bun run check\n```')
		expect(md).toContain('> **Subagent · Researcher** — read the docs')
		expect(md).toContain('_Earlier messages were summarised_')

		// Blocks keep their order, and the text is not repeated from `content`.
		const order = ['Thinking', 'Found it.', '**Tool · Edit**', '**Tool · Bash**', 'Subagent · Researcher', 'Earlier messages']
		const positions = order.map((needle) => md.indexOf(needle))
		expect(positions.every((p) => p > 0)).toBe(true)
		expect([...positions].sort((a, b) => a - b)).toEqual(positions)
		expect(md.split('Found it.').length - 1).toBe(1)
	})

	test('a fence is longer than any run of backticks inside it', () => {
		const inner = 'before\n````\nnested fence\n````\nafter'
		const fenced = codeFence(inner, 'text')
		expect(fenced.startsWith('`````text\n')).toBe(true)
		expect(fenced.endsWith('\n`````')).toBe(true)
		expect(codeFence('no ticks')).toBe('```\nno ticks\n```')

		// And through the formatter: tool output with a fence of its own cannot close ours.
		const md = exportConversationMarkdown(
			input([
				message({
					role: 'assistant',
					metadata: { blocks: [{ kind: 'tool', name: 'Read', arguments: { file_path: 'README.md' }, result: 'x\n```\n# not a heading\n```', success: true, executionMs: 1 }] },
				}),
			]),
		)
		expect(md).toContain('````text\nx\n```\n# not a heading\n```\n````')
	})

	test('long tool output is shortened in Markdown and kept whole in JSON', () => {
		const long = 'line\n'.repeat(2000)
		const data = input([
			message({
				role: 'assistant',
				metadata: { blocks: [{ kind: 'tool', name: 'Read', arguments: { file_path: 'big.log' }, result: long, success: true, executionMs: 1 }] },
			}),
		])
		const md = exportConversationMarkdown(data)
		expect(md).toContain('(truncated — see the JSON export for the full output)')
		expect(md.length).toBeLessThan(long.length)

		const json = exportConversationJson(data)
		const blocks = (json.messages[0].metadata as { blocks: Array<{ result: string }> }).blocks
		expect(blocks[0].result).toBe(long)
	})

	test('JSON carries every message and block, and not the owner', () => {
		const data = input([
			message({ role: 'user', content: 'hi', attachments: [{ id: 'a', filename: 'shot.png', mimeType: 'image/png', size: 2048, url: '/u/a' }] }),
			message({ id: '00000000-0000-4000-8000-000000000002', sequence: 2, role: 'assistant', content: 'done', metadata: { blocks: [EDIT_BLOCK] } }),
		])
		const json = exportConversationJson(data)
		expect(json.format).toBe(EXPORT_FORMAT)
		expect(json.version).toBe(1)
		expect(json.exportedAt).toBe(at.toISOString())
		expect(json.conversation).toMatchObject({ title: 'Fix the login page', agent: { name: 'Chat' }, pinnedAt: at.toISOString() })
		expect(JSON.stringify(json)).not.toContain('userId')
		expect(json.messages).toHaveLength(2)
		expect(json.messages[1].metadata).toEqual({ blocks: [EDIT_BLOCK] })
		expect(json.messages[0].attachments[0].filename).toBe('shot.png')

		expect(exportConversationMarkdown(data)).toContain('- `shot.png` (image/png, 2.0 KB)')
	})

	test('an agent switch shows as a note, not as the instructions it carried', () => {
		const md = exportConversationMarkdown(
			input([message({ role: 'system', content: '[Agent changed to Plan] You are now acting as Plan. Secret rules.', metadata: { type: 'agent_anchor' } })]),
		)
		expect(md).toContain('_The conversation switched agents here._')
		expect(md).not.toContain('Secret rules')
	})

	test('file names: an ASCII slug and the readable title, both dated', () => {
		const names = exportFileNames('Fix the "login" page: café/2', at, 'md')
		expect(names.ascii).toBe('fix-the-login-page-cafe-2-2026-09-23.md')
		expect(names.utf8).toBe('Fix the login page café 2-2026-09-23.md')
		expect(exportFileNames('???', at, 'json').ascii).toBe('conversation-2026-09-23.json')
		expect(exportContentDisposition(names)).toBe(
			`attachment; filename="fix-the-login-page-cafe-2-2026-09-23.md"; filename*=UTF-8''Fix%20the%20login%20page%20caf%C3%A9%202-2026-09-23.md`,
		)
	})
})

test.describe('conversation export — the download route', () => {
	test('a signed-in owner downloads Markdown and JSON as attachments that are not cached', async ({ page }) => {
		const sql = getSql()
		const userId = await getActiveUserId()
		const prefix = uniquePrefix('conv-export')
		await authenticateContext(page.context())

		try {
			const [conversation] = await sql<{ id: string }[]>`
				insert into conversations (title, user_id, model, total_tokens, total_cost)
				values (${`${prefix} Export me`}, ${userId}, ${'anthropic/claude-sonnet-4'}, 10, '0')
				returning id
			`
			await sql`
				insert into messages (conversation_id, role, content, metadata, tool_calls, sequence)
				values
					(${conversation.id}, 'user', 'please edit it', '{}'::jsonb, '[]'::jsonb, 1),
					(${conversation.id}, 'assistant', 'edited', ${sql.json({ blocks: [{ kind: 'text', content: 'edited' }, EDIT_BLOCK] })}, '[]'::jsonb, 2)
			`

			const md = await page.request.get(`/chat/${conversation.id}/export?format=md`)
			expect(md.status()).toBe(200)
			const mdHeaders = md.headers()
			expect(mdHeaders['content-type']).toContain('text/markdown')
			expect(mdHeaders['content-disposition']).toMatch(/^attachment; filename="[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.md"; filename\*=UTF-8''/)
			expect(mdHeaders['cache-control']).toBe('private, no-store')
			expect(mdHeaders['x-content-type-options']).toBe('nosniff')
			const mdBody = await md.text()
			expect(mdBody).toContain(`# ${prefix} Export me`)
			expect(mdBody).toContain('please edit it')
			expect(mdBody).toContain('**Tool · Edit** `src/routes/login/+page.svelte`')

			const json = await page.request.get(`/chat/${conversation.id}/export?format=json`)
			expect(json.status()).toBe(200)
			expect(json.headers()['content-type']).toContain('application/json')
			expect(json.headers()['content-disposition']).toContain('.json"')
			const doc = (await json.json()) as { format: string; conversation: Record<string, unknown>; messages: Array<{ role: string; metadata: unknown }> }
			expect(doc.format).toBe(EXPORT_FORMAT)
			expect(doc.conversation.id).toBe(conversation.id)
			expect(doc.conversation).not.toHaveProperty('userId')
			expect(doc.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
			expect(doc.messages[1].metadata).toMatchObject({ blocks: [{ kind: 'text' }, { kind: 'tool', name: 'Edit' }] })
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('an unknown format is refused', async ({ page }) => {
		const prefix = uniquePrefix('conv-export-format')
		await authenticateContext(page.context())
		const sql = getSql()
		const userId = await getActiveUserId()
		try {
			const [conversation] = await sql<{ id: string }[]>`
				insert into conversations (title, user_id, model, total_tokens, total_cost)
				values (${`${prefix} chat`}, ${userId}, ${'anthropic/claude-sonnet-4'}, 0, '0')
				returning id
			`
			const response = await page.request.get(`/chat/${conversation.id}/export?format=xml`)
			expect(response.status()).toBe(400)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test("someone else's conversation, or no conversation at all, is not found", async ({ page }) => {
		const prefix = uniquePrefix('conv-export-foreign')
		await authenticateContext(page.context())
		const sql = getSql()
		try {
			// No owner: not the signed-in user's, which is all the route may know.
			const [foreign] = await sql<{ id: string }[]>`
				insert into conversations (title, user_id, model, total_tokens, total_cost)
				values (${`${prefix} not yours`}, ${null}, ${'anthropic/claude-sonnet-4'}, 0, '0')
				returning id
			`
			expect((await page.request.get(`/chat/${foreign.id}/export?format=md`)).status()).toBe(404)
			expect((await page.request.get('/chat/00000000-0000-4000-8000-000000000000/export?format=json')).status()).toBe(404)
			expect((await page.request.get('/chat/not-a-uuid/export?format=md')).status()).toBe(404)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('without a session the download is refused', async ({ playwright }) => {
		const context = await playwright.request.newContext()
		try {
			const response = await context.get('/chat/00000000-0000-4000-8000-000000000000/export?format=md', { maxRedirects: 0 })
			// The hook's redirect to /login answers first; the route's own 401 is the backstop.
			expect([401, 302, 303]).toContain(response.status())
		} finally {
			await context.dispose()
		}
	})
})
