import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import {
	authenticateContext,
	cleanupPrefixedRecords,
	getActiveUserId,
	getSql,
	seedConversation,
	uniquePrefix,
	waitForHydration,
} from './helpers'
import { sse } from './chat-stream-script'
import { resolveWorkspaceRoot } from '../src/lib/workspace/workspace.server'

/**
 * Edit and Regenerate on the chat page, and the "also restore files" question they ask
 * first (#24).
 *
 * The run itself is scripted in the browser, so no model is involved. What matters is what
 * the page sends: never the placeholder word "regenerate" as a prompt — the server answers
 * the (edited) row itself — and nothing at all when the user cancels.
 *
 * The restore question is only asked when the message has a file checkpoint. A restorable
 * preview needs a real session on disk, which is `engine.rewind.spec.ts`'s job; here the
 * checkpoint points at a session the CLI does not have, so the preview comes back blocked
 * with the CLI's reason, which is the dialog's other face — it says why, and lets the user go
 * on without restoring.
 */

type Send = { content?: string; regenerate?: boolean }

async function scriptStream(page: Page, conversationId: string) {
	const sends: Send[] = []
	await page.route(
		(url) => url.pathname === `/chat/${conversationId}/stream`,
		(route) => {
			sends.push(route.request().postDataJSON() as Send)
			return route.fulfill({
				status: 200,
				headers: { 'content-type': 'text/event-stream' },
				body: sse([{ id: 1, event: 'done', data: { error: 'scripted end' } }]),
			})
		},
	)
	return sends
}

async function rows(conversationId: string) {
	return getSql()<{ role: string; content: string }[]>`
		select role, content from messages where conversation_id = ${conversationId} order by sequence
	`
}

async function open(page: Page, conversationId: string) {
	await page.goto(`/chat/${conversationId}`, { waitUntil: 'domcontentloaded' })
	await waitForHydration(page)
}

const visible = (page: Page, name: string) => page.getByRole('button', { name }).filter({ visible: true }).first()

test('with no file checkpoint, Regenerate goes straight on and sends no prompt of its own', async ({ page }) => {
	test.setTimeout(90_000)
	const prefix = uniquePrefix('chat-regen-plain')
	await cleanupPrefixedRecords(prefix)
	await authenticateContext(page.context())
	const conversation = await seedConversation(prefix, {
		userId: await getActiveUserId(),
		userMessage: `${prefix} What is 2+2?`,
		assistantMessage: `${prefix} 4`,
	})
	const sends = await scriptStream(page, conversation.id)

	try {
		await open(page, conversation.id)
		await visible(page, 'Regenerate response').click()

		await expect.poll(() => sends.length, { timeout: 30_000 }).toBe(1)
		expect(sends[0]).toMatchObject({ regenerate: true, content: '' })
		await expect(page.getByTestId('rewind-dialog')).toHaveCount(0)
		expect(await rows(conversation.id)).toEqual([{ role: 'user', content: `${prefix} What is 2+2?` }])
	} finally {
		await page.unrouteAll({ behavior: 'ignoreErrors' })
		await cleanupPrefixedRecords(prefix)
	}
})

test('a checkpoint that cannot be used: the dialog says why, Cancel keeps the edit, Continue goes on without restoring', async ({
	page,
}) => {
	test.setTimeout(120_000)
	const prefix = uniquePrefix('chat-edit-restore')
	await cleanupPrefixedRecords(prefix)
	await authenticateContext(page.context())
	const userId = await getActiveUserId()
	const conversation = await seedConversation(prefix, {
		userId,
		userMessage: `${prefix} What is 2+2?`,
		assistantMessage: `${prefix} 4`,
	})
	// A workspace inside this user's sandbox, resolved the way the server resolves it.
	const cwd = resolveWorkspaceRoot({ userId, projectId: randomUUID(), sandboxRoot: process.env.SANDBOX_WORKSPACE })
	mkdirSync(cwd, { recursive: true })
	const sessionId = randomUUID()
	const sql = getSql()
	await sql`update conversations set sdk_session_id = ${sessionId} where id = ${conversation.id}`
	await sql`
		update messages set metadata = ${sql.json({ sdkTurn: { uuid: randomUUID(), sessionId, cwd, checkpointed: true } } as never)}
		where conversation_id = ${conversation.id} and role = 'user'
	`
	const sends = await scriptStream(page, conversation.id)
	const before = await rows(conversation.id)

	try {
		await open(page, conversation.id)
		await visible(page, 'Edit message').click()
		const editor = page.locator('textarea.console-msg__edit-ta').filter({ visible: true })
		await editor.fill(`${prefix} What is 3+3?`)
		await visible(page, 'Save & regenerate').click()

		// The CLI has no such session, so the preview comes back with its reason.
		const dialog = page.getByTestId('rewind-dialog')
		await expect(dialog).toBeVisible({ timeout: 60_000 })
		await expect(dialog).toContainText("The files can't be restored for this message")
		await expect(dialog.getByTestId('rewind-restore')).toHaveCount(0)
		// Fits a phone: the whole box and its buttons stay on screen.
		const box = await dialog.locator('.modal-box').boundingBox()
		const viewport = page.viewportSize()!
		expect(box!.x).toBeGreaterThanOrEqual(0)
		expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1)
		await expect(dialog.getByTestId('rewind-continue')).toBeInViewport()

		// Cancel: nothing happens, and the edit is still there to try again.
		await dialog.getByRole('button', { name: 'Cancel' }).click()
		await expect(dialog).toHaveCount(0)
		await expect(editor).toHaveValue(`${prefix} What is 3+3?`)
		expect(sends).toEqual([])
		expect(await rows(conversation.id)).toEqual(before)

		await visible(page, 'Save & regenerate').click()
		await expect(dialog).toBeVisible({ timeout: 60_000 })
		await dialog.getByTestId('rewind-continue').click()

		await expect.poll(() => sends.length, { timeout: 30_000 }).toBe(1)
		expect(sends[0]).toMatchObject({ regenerate: true, content: '' })
		expect(await rows(conversation.id)).toEqual([{ role: 'user', content: `${prefix} What is 3+3?` }])
	} finally {
		await page.unrouteAll({ behavior: 'ignoreErrors' })
		await cleanupPrefixedRecords(prefix)
		try {
			rmSync(cwd, { recursive: true, force: true })
		} catch {
			// Windows keeps it while the CLI the preview started is still exiting; it is empty.
		}
	}
})
