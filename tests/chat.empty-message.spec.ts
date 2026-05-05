import { expect, test } from '@playwright/test'
import { authenticateContext, cleanupPrefixedRecords, getActiveAdminUserId, getSql, uniquePrefix } from './helpers'

/**
 * An empty assistant message (no content, no toolCalls, no metadata.blocks — or where every
 * saved block has nothing renderable) used to render as a bordered placeholder bubble. The
 * guard in MessageBubble now skips the whole article when there's nothing meaningful inside.
 */

async function seedConversationWithMessages(prefix: string) {
	const sql = getSql()
	const userId = await getActiveAdminUserId()

	const [conversation] = await sql<{ id: string }[]>`
		insert into conversations (title, user_id, model, total_tokens, total_cost)
		values (${`${prefix} chat`}, ${userId}, ${'anthropic/claude-sonnet-4'}, 0, '0')
		returning id
	`

	// Real user prompt.
	await sql`
		insert into messages (conversation_id, role, content, model, metadata, tool_calls)
		values (${conversation.id}, 'user', 'real user prompt', ${'anthropic/claude-sonnet-4'}, '{}'::jsonb, '[]'::jsonb)
	`

	// Real assistant reply with text content — should always render.
	await sql`
		insert into messages (conversation_id, role, content, model, metadata, tool_calls)
		values (
			${conversation.id},
			'assistant',
			${'real assistant reply text'},
			${'anthropic/claude-sonnet-4'},
			${sql.json({ blocks: [{ kind: 'text', content: 'real assistant reply text' }] })},
			'[]'::jsonb
		)
	`

	// Three "empty" assistant messages of different shapes, each of which used to leak through:
	//   1. content='', toolCalls=[], metadata.blocks=null
	//   2. content=' ' (whitespace only), toolCalls=[], metadata.blocks=undefined
	//   3. content='', toolCalls=[], metadata.blocks=[{kind:'text', content:''}, {kind:'thinking', content:'  '}]
	await sql`
		insert into messages (conversation_id, role, content, model, metadata, tool_calls)
		values (${conversation.id}, 'assistant', '', ${'anthropic/claude-sonnet-4'}, '{}'::jsonb, '[]'::jsonb)
	`
	await sql`
		insert into messages (conversation_id, role, content, model, metadata, tool_calls)
		values (${conversation.id}, 'assistant', '   ', ${'anthropic/claude-sonnet-4'}, '{}'::jsonb, '[]'::jsonb)
	`
	await sql`
		insert into messages (conversation_id, role, content, model, metadata, tool_calls)
		values (
			${conversation.id},
			'assistant',
			'',
			${'anthropic/claude-sonnet-4'},
			${sql.json({ blocks: [{ kind: 'text', content: '' }, { kind: 'thinking', content: '  ' }] })},
			'[]'::jsonb
		)
	`

	return { conversationId: conversation.id }
}

test.describe('chat/empty-message — render suppression', () => {
	test('empty assistant messages do not render an article in the timeline', async ({ page }) => {
		test.setTimeout(60_000)
		const prefix = uniquePrefix('chat-empty')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(page.context())

		try {
			const seeded = await seedConversationWithMessages(prefix)

			await page.goto('/', { waitUntil: 'domcontentloaded' })
			await page.goto(`/chat/${seeded.conversationId}`, { waitUntil: 'domcontentloaded' })

			// Wait for the real exchange to render so we know the timeline finished hydrating.
			await page.getByText('real user prompt', { exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
			await page.getByText('real assistant reply text', { exact: false }).waitFor({ state: 'visible' })

			// The user prompt + the real assistant reply should be the only two articles in the
			// scrollable message list. The 3 empty assistants must not render an <article>.
			const main = page.getByRole('main')
			const articleCount = await main.locator('article.chat-message').count()
			expect(articleCount, 'only the user prompt + the one real assistant article should render').toBe(2)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})
