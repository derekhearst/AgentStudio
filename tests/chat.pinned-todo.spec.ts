import { expect, test } from '@playwright/test'
import { authenticateContext, cleanupPrefixedRecords, getActiveUserId, getSql, uniquePrefix } from './helpers'
import { pinnedTodoListFrom } from '../src/lib/chat/pinned-todo'

/**
 * #21 — the pinned checklist above the composer.
 *
 * `TodoListCard` already renders a `TodoWrite` inline, where the update happened. That is
 * the wrong place to read a plan *from*: it scrolls away the moment the model says anything
 * after it, and a task spanning several turns leaves several of them buried at several
 * depths. `conversations.todo_list` holds the latest one and `PinnedTodoPanel` shows it.
 *
 * Seeds the column directly rather than driving a run, so the rendering is deterministic
 * and needs no model — same arrangement as `chat.tool-call-render.spec.ts`. What the live
 * path adds on top is one frame assignment, covered by the engine's own specs.
 */

const TODOS = [
	{ content: 'Read the failing spec', status: 'completed', activeForm: 'Reading the failing spec' },
	{ content: 'Fix the off-by-one', status: 'in_progress', activeForm: 'Fixing the off-by-one' },
	{ content: 'Run the suite', status: 'pending', activeForm: 'Running the suite' },
]

async function seedConversationWithTodos(prefix: string, items: unknown[] | null) {
	const sql = getSql()
	const userId = await getActiveUserId()
	const todoList = items ? { items, updatedAt: new Date().toISOString(), runId: null } : null
	const [conversation] = await sql<{ id: string }[]>`
		insert into conversations (title, user_id, model, total_tokens, total_cost, todo_list)
		values (
			${`${prefix} convo`},
			${userId},
			'anthropic/claude-sonnet-4',
			0,
			'0',
			${todoList ? sql.json(todoList as never) : null}
		)
		returning id
	`
	return conversation
}

test.describe('chat/pinned-todo — the latest checklist stays visible', () => {
	test('the panel shows the active item and the count, and expands to the whole list', async ({ page }) => {
		test.setTimeout(60_000)
		const prefix = uniquePrefix('pinned-todo')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(page.context())

		try {
			const conv = await seedConversationWithTodos(prefix, TODOS)

			await page.goto('/', { waitUntil: 'domcontentloaded' })
			await page.goto(`/chat/${conv.id}`, { waitUntil: 'domcontentloaded' })

			const panel = page.getByTestId('pinned-todo')
			await panel.waitFor({ state: 'visible', timeout: 30_000 })

			// Collapsed, it is one line: what the agent is doing, and how far along it is.
			// The active item's `activeForm` beats a bare count, which is why it is preferred.
			await expect(panel).toContainText('Fixing the off-by-one')
			await expect(panel).toContainText('1/3')
			// The rest of the plan is not on screen until asked for — the panel sits in the
			// composer's space, and an open ten-item list would push the input off a phone.
			await expect(panel).not.toContainText('Run the suite')

			await panel.getByRole('button', { expanded: false }).click()
			await expect(panel).toContainText('Read the failing spec')
			await expect(panel).toContainText('Run the suite')
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('dismissing clears the column, so a reload does not pin it back', async ({ page }) => {
		test.setTimeout(60_000)
		const prefix = uniquePrefix('pinned-todo-dismiss')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(page.context())

		try {
			const conv = await seedConversationWithTodos(prefix, TODOS)

			await page.goto('/', { waitUntil: 'domcontentloaded' })
			await page.goto(`/chat/${conv.id}`, { waitUntil: 'domcontentloaded' })

			const panel = page.getByTestId('pinned-todo')
			await panel.waitFor({ state: 'visible', timeout: 30_000 })
			await panel.getByRole('button', { name: 'Dismiss this checklist' }).click()
			await expect(panel).toBeHidden()

			// The column, not just the view: `TodoWrite` only ever replaces a list, so a
			// dismissal that left the row alone would pin the same list back on every open.
			const sql = getSql()
			await expect
				.poll(
					async () => {
						const [row] = await sql<{ todo_list: unknown }[]>`
							select todo_list from conversations where id = ${conv.id}
						`
						return row?.todo_list ?? null
					},
					{ timeout: 15_000 },
				)
				.toBeNull()

			await page.reload({ waitUntil: 'domcontentloaded' })
			await expect(page.getByTestId('pinned-todo')).toHaveCount(0)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('a conversation that never wrote a plan shows no panel', async ({ page }) => {
		test.setTimeout(60_000)
		const prefix = uniquePrefix('pinned-todo-absent')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(page.context())

		try {
			const conv = await seedConversationWithTodos(prefix, null)

			await page.goto('/', { waitUntil: 'domcontentloaded' })
			await page.goto(`/chat/${conv.id}`, { waitUntil: 'domcontentloaded' })
			await page.waitForSelector('textarea, [contenteditable]', { state: 'visible', timeout: 30_000 })

			await expect(page.getByTestId('pinned-todo')).toHaveCount(0)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})

test.describe('chat/pinned-todo — whose list gets pinned', () => {
	test('only the parent\'s TodoWrite becomes the pinned checklist (#133)', () => {
		const details = {
			kind: 'todo' as const,
			items: [{ content: 'Plan', status: 'pending' as const, activeForm: 'Planning' }],
			completed: 0,
			total: 1,
			truncated: false,
		}
		const at = new Date('2026-09-22T00:00:00Z')

		expect(pinnedTodoListFrom({ details }, 'run-1', at)).toEqual({
			items: details.items,
			updatedAt: at.toISOString(),
			runId: 'run-1',
		})
		// A delegated agent's own sub-steps must not replace the parent's plan.
		expect(pinnedTodoListFrom({ details, subagentId: 'task-1' }, 'run-1', at)).toBeNull()
		expect(pinnedTodoListFrom({}, 'run-1', at)).toBeNull()
	})
})
