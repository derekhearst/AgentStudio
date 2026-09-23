import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { authenticateContext, cleanupPrefixedRecords, getActiveUserId, getSql, pollDb, uniquePrefix, waitForHydration } from './helpers'
import { SNIPPET_START, SNIPPET_STOP } from '../src/lib/chat/conversation-search'

/**
 * #18 — searching conversations on the server.
 *
 * The index is written by the application's own message writes (`insertMessageWithSequence`
 * hands each committed row to the indexer), healed by the boot backfill, and searched with
 * Postgres full-text search. What is pinned:
 *   - a file path in a tool call finds the turn by its full path, its file name, a partial
 *     path, one segment, and a prefix of that segment while typing
 *   - prose finds it too, and the snippet carries the highlight markers
 *   - archived chats are left out unless asked for; another user's are never returned
 *   - a search of only stop words still finds titles
 *   - the backfill indexes a message written behind the indexer's back, and rewrites a row
 *     built by an older version of the rules
 *   - deleting a message deletes its search row
 *
 * Each run makes up its own file name, so matches from other specs or real data cannot
 * crowd it out of the results.
 */

/** A word the English stemmer leaves alone (consonants, no suffix it strips). */
function uniqueWord() {
	const letters = 'bcdfghjkmnpqrtvwxz'
	let word = 'zk'
	for (let i = 0; i < 7; i++) word += letters[Math.floor(Math.random() * letters.length)]
	return `${word}k`
}

async function seedConversation(title: string, userId: string | null, options: { archived?: boolean } = {}) {
	const sql = getSql()
	const [row] = await sql<{ id: string }[]>`
		insert into conversations (title, user_id, model, total_tokens, total_cost, archived_at)
		values (${title}, ${userId}, ${'anthropic/claude-sonnet-4'}, 0, '0', ${options.archived ? new Date() : null})
		returning id
	`
	return row.id
}

async function searchRowFor(messageId: string) {
	const sql = getSql()
	const [row] = await sql<{ body: string; builder_version: number }[]>`
		select body, builder_version from message_search where message_id = ${messageId}
	`
	return row ?? null
}

test.describe('conversation search', () => {
	test('a tool call is found by its path, file name, partial path, segment and prefix; prose too', async () => {
		const prefix = uniquePrefix('conv-search-path')
		const word = uniqueWord()
		const proseWord = uniqueWord()
		const userId = await getActiveUserId()
		const { insertMessageWithSequence } = await import('../src/lib/chat/insert-message.server')
		const { searchUserConversations } = await import('../src/lib/chat/message-search.server')

		try {
			const conversationId = await seedConversation(`${prefix} Engine work`, userId)
			const path = `src/lib/engine/${word}.server.ts`
			await insertMessageWithSequence({
				conversationId,
				role: 'user',
				content: `Please tidy the ${proseWord} options and ship it`,
			})
			const assistant = await insertMessageWithSequence({
				conversationId,
				role: 'assistant',
				content: 'Done.',
				metadata: {
					blocks: [
						{ kind: 'text', content: 'Done.' },
						{
							kind: 'tool',
							name: 'Edit',
							arguments: { file_path: path, old_string: 'x', new_string: 'y' },
							result: 'ok',
							success: true,
							executionMs: 2,
							details: { kind: 'file_edit', tool: 'Edit', path, changeType: 'update', hunks: [], additions: 1, deletions: 0, unavailable: 'none', truncated: false },
						},
					],
				},
			})

			// Indexed by the write itself, in the background.
			const row = await pollDb(() => searchRowFor(assistant.id), (r) => r !== null, { description: 'assistant message indexed' })
			expect(row!.body).toContain(path)

			for (const query of [path, `${word}.server.ts`, `engine/${word}.server.ts`, word, word.slice(0, -2)]) {
				const hits = await searchUserConversations(userId, query)
				const hit = hits.find((h) => h.conversationId === conversationId)
				expect(hit, `search for ${query}`).toBeTruthy()
				expect(hit!.match?.messageId, `search for ${query}`).toBe(assistant.id)
				expect(hit!.match?.snippet).toContain(SNIPPET_START)
				expect(hit!.match?.snippet).toContain(SNIPPET_STOP)
			}

			// Prose: the user's message, with its own date and role.
			const prose = await searchUserConversations(userId, `tidy ${proseWord} ship`)
			const proseHit = prose.find((h) => h.conversationId === conversationId)
			expect(proseHit?.match?.role).toBe('user')
			expect(proseHit?.match?.createdAt).toBeInstanceOf(Date)
			expect(proseHit?.title).toBe(`${prefix} Engine work`)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('archived chats only when asked for, and never another user’s', async () => {
		const prefix = uniquePrefix('conv-search-scope')
		const word = uniqueWord()
		const userId = await getActiveUserId()
		const { indexMessage, searchUserConversations } = await import('../src/lib/chat/message-search.server')
		const sql = getSql()

		try {
			const active = await seedConversation(`${prefix} active`, userId)
			const archived = await seedConversation(`${prefix} archived`, userId, { archived: true })
			const foreign = await seedConversation(`${prefix} foreign`, null)
			for (const conversationId of [active, archived, foreign]) {
				const [message] = await sql<{ id: string }[]>`
					insert into messages (conversation_id, role, content, metadata, tool_calls, sequence)
					values (${conversationId}, 'user', ${`about ${word}`}, '{}'::jsonb, '[]'::jsonb, 1)
					returning id
				`
				await indexMessage({ id: message.id, conversationId, role: 'user', content: `about ${word}` })
			}

			const ids = (hits: Array<{ conversationId: string }>) => hits.map((h) => h.conversationId)
			const defaultHits = await searchUserConversations(userId, word)
			expect(ids(defaultHits)).toContain(active)
			expect(ids(defaultHits)).not.toContain(archived)
			expect(ids(defaultHits)).not.toContain(foreign)

			const withArchive = await searchUserConversations(userId, word, { includeArchived: true })
			expect(ids(withArchive)).toContain(active)
			expect(ids(withArchive)).toContain(archived)
			expect(withArchive.find((h) => h.conversationId === archived)?.archived).toBe(true)
			expect(ids(withArchive)).not.toContain(foreign)

			// A stranger — any id that is not the owner — finds nothing of the owner's.
			expect(await searchUserConversations(randomUUID(), word, { includeArchived: true })).toEqual([])
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('titles match too, including a search of only stop words', async () => {
		const prefix = uniquePrefix('conv-search-title')
		const userId = await getActiveUserId()
		const { searchUserConversations } = await import('../src/lib/chat/message-search.server')

		try {
			const conversationId = await seedConversation(`${prefix} over the and under`, userId)
			// "the and" is nothing but stop words: no text query at all, titles only.
			const hits = await searchUserConversations(userId, 'the and', { limit: 50 })
			const hit = hits.find((h) => h.conversationId === conversationId)
			expect(hit).toMatchObject({ titleMatch: true, match: null })

			// Too short to search.
			expect(await searchUserConversations(userId, 'a')).toEqual([])
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('the backfill indexes what the writer missed and rebuilds rows from older rules', async () => {
		const prefix = uniquePrefix('conv-search-backfill')
		const word = uniqueWord()
		const userId = await getActiveUserId()
		const sql = getSql()
		const { backfillMessageSearch, searchUserConversations } = await import('../src/lib/chat/message-search.server')
		const { SEARCH_BUILDER_VERSION } = await import('../src/lib/chat/message-search-text')

		try {
			const conversationId = await seedConversation(`${prefix} backfill`, userId)
			// Written straight to the table, as history from before search existed was.
			const [missed] = await sql<{ id: string }[]>`
				insert into messages (conversation_id, role, content, metadata, tool_calls, sequence)
				values (${conversationId}, 'assistant', 'ran it', ${sql.json({ blocks: [{ kind: 'tool', name: 'Bash', arguments: { command: `./${word}.sh --all` }, result: 'x'.repeat(200_000), success: true, executionMs: 1 }] })}, '[]'::jsonb, 1)
				returning id
			`

			await backfillMessageSearch({ batchSize: 50 })
			const indexed = await searchRowFor(missed.id)
			expect(indexed?.builder_version).toBe(SEARCH_BUILDER_VERSION)
			expect(indexed?.body).toContain(`./${word}.sh --all`)
			expect(indexed?.body).not.toContain('x'.repeat(100))
			expect((await searchUserConversations(userId, `${word}.sh`)).map((h) => h.conversationId)).toContain(conversationId)

			// A row built by an older version of the rules is rebuilt.
			await sql`update message_search set builder_version = 0, body = 'stale' where message_id = ${missed.id}`
			await backfillMessageSearch({ batchSize: 50 })
			const rebuilt = await searchRowFor(missed.id)
			expect(rebuilt?.builder_version).toBe(SEARCH_BUILDER_VERSION)
			expect(rebuilt?.body).toContain(word)

			// Deleting the message takes its search row with it.
			await sql`delete from messages where id = ${missed.id}`
			expect(await searchRowFor(missed.id)).toBeNull()
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('re-indexing a message replaces what it is found by', async () => {
		const prefix = uniquePrefix('conv-search-reindex')
		const before = uniqueWord()
		const after = uniqueWord()
		const userId = await getActiveUserId()
		const sql = getSql()
		const { indexMessage, searchUserConversations } = await import('../src/lib/chat/message-search.server')

		try {
			const conversationId = await seedConversation(`${prefix} edited`, userId)
			const [message] = await sql<{ id: string }[]>`
				insert into messages (conversation_id, role, content, metadata, tool_calls, sequence)
				values (${conversationId}, 'user', ${before}, '{}'::jsonb, '[]'::jsonb, 1)
				returning id
			`
			await indexMessage({ id: message.id, conversationId, role: 'user', content: before })
			await indexMessage({ id: message.id, conversationId, role: 'user', content: after })

			const ids = async (q: string) => (await searchUserConversations(userId, q)).map((h) => h.conversationId)
			expect(await ids(after)).toContain(conversationId)
			expect(await ids(before)).not.toContain(conversationId)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})

test.describe('conversation search — the sidebar', () => {
	test('typing searches messages after a pause and shows the snippet', async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'the sidebar is desktop chrome; the drawer mounts the same component')
		test.setTimeout(60_000)
		const prefix = uniquePrefix('conv-search-ui')
		const word = uniqueWord()
		const userId = await getActiveUserId()
		const { indexMessage } = await import('../src/lib/chat/message-search.server')
		const sql = getSql()
		await authenticateContext(page.context())

		try {
			const conversationId = await seedConversation(`${prefix} Sidebar search`, userId)
			const [message] = await sql<{ id: string }[]>`
				insert into messages (conversation_id, role, content, metadata, tool_calls, sequence)
				values (${conversationId}, 'user', ${`fix R&D <3 ${word} now`}, '{}'::jsonb, '[]'::jsonb, 1)
				returning id
			`
			await indexMessage({ id: message.id, conversationId, role: 'user', content: `fix R&D <3 ${word} now` })

			await page.goto('/', { waitUntil: 'domcontentloaded' })
			await waitForHydration(page)
			const sidebar = page.locator('aside.console-sb')
			await sidebar.getByRole('textbox', { name: 'Search chats' }).fill(word)

			const results = sidebar.getByRole('region', { name: 'Search results in messages' })
			const hit = results.locator(`a.console-searchhit[href="/chat/${conversationId}"]`)
			await expect(hit).toBeVisible({ timeout: 15_000 })
			await expect(hit).toContainText(`${prefix} Sidebar search`)
			// The highlight is a <mark> and the rest is text: the snippet is never parsed as HTML.
			const snippet = hit.locator('.console-searchhit__snippet')
			await expect(snippet.locator('mark')).toHaveText(word)
			await expect(snippet).toContainText(`R&D <3 ${word} now`)
			await expect(snippet.locator('*')).toHaveCount(1)

			await hit.click()
			await expect(page).toHaveURL(new RegExp(`/chat/${conversationId}$`))
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})
