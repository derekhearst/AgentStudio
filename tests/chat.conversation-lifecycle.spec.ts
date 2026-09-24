import { randomUUID } from 'node:crypto'
import { expect, test, type Locator, type Page } from '@playwright/test'
import {
	answerConfirmDialog,
	authenticateContext,
	cleanupPrefixedRecords,
	getActiveUserId,
	getSql,
	uniquePrefix,
	waitForHydration,
} from './helpers'

/**
 * #18 — pin, archive, rename and delete.
 *
 * The rules live on the server and are pinned there first: pinning unarchives, archiving
 * unpins, neither reorders the list (`updated_at` stays put), the default list leaves the
 * archive out and always carries every pinned chat, and a message the user sends brings an
 * archived chat back. Then the sidebar: the row menu does each of these, pinned chats sit in
 * their own group on top, the Archived view finds and restores a chat, delete asks first and
 * leaves the chat that was open, and on a phone the menu button is there without hovering.
 * On a phone the home page's "Recent chats" are the latest chats, not the pinned ones the
 * server lists first.
 */

async function seedConversation(title: string, userId: string | null) {
	const sql = getSql()
	const [row] = await sql<{ id: string }[]>`
		insert into conversations (title, user_id, model, total_tokens, total_cost)
		values (${title}, ${userId}, ${'anthropic/claude-sonnet-4'}, 0, '0')
		returning id
	`
	return row.id
}

async function lifecycleRow(id: string) {
	const sql = getSql()
	const [row] = await sql<{ pinned_at: Date | null; archived_at: Date | null; updated_at: Date; title: string }[]>`
		select pinned_at, archived_at, updated_at, title from conversations where id = ${id}
	`
	return row ?? null
}

test.describe('conversation lifecycle — the rules', () => {
	test('pinning unarchives, archiving unpins, and neither moves updated_at', async () => {
		const prefix = uniquePrefix('conv-life-rules')
		const userId = await getActiveUserId()
		const { setConversationArchivedForUser, setConversationPinnedForUser } = await import(
			'../src/lib/chat/conversation-lifecycle.server'
		)

		try {
			const id = await seedConversation(`${prefix} chat`, userId)
			const before = await lifecycleRow(id)

			await setConversationPinnedForUser(userId, id, true)
			let row = await lifecycleRow(id)
			expect(row?.pinned_at).not.toBeNull()
			expect(row?.archived_at).toBeNull()

			await setConversationArchivedForUser(userId, id, true)
			row = await lifecycleRow(id)
			expect(row?.archived_at).not.toBeNull()
			expect(row?.pinned_at).toBeNull()

			await setConversationPinnedForUser(userId, id, true)
			row = await lifecycleRow(id)
			expect(row?.pinned_at).not.toBeNull()
			expect(row?.archived_at).toBeNull()

			await setConversationPinnedForUser(userId, id, false)
			await setConversationArchivedForUser(userId, id, false)
			row = await lifecycleRow(id)
			expect(row?.pinned_at).toBeNull()
			expect(row?.archived_at).toBeNull()

			expect(row?.updated_at.getTime()).toBe(before?.updated_at.getTime())
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test("another user's conversation cannot be pinned or archived", async () => {
		const prefix = uniquePrefix('conv-life-foreign')
		const userId = await getActiveUserId()
		const { setConversationArchivedForUser, setConversationPinnedForUser } = await import(
			'../src/lib/chat/conversation-lifecycle.server'
		)

		try {
			const id = await seedConversation(`${prefix} mine`, userId)
			const stranger = randomUUID()
			// Not found for them — the remote functions answer 404 — and nothing changes.
			expect(await setConversationPinnedForUser(stranger, id, true)).toBeNull()
			expect(await setConversationArchivedForUser(stranger, id, true)).toBeNull()
			const row = await lifecycleRow(id)
			expect(row?.pinned_at).toBeNull()
			expect(row?.archived_at).toBeNull()
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('the default list leaves the archive out and keeps every pinned chat; the archive lists it', async () => {
		const prefix = uniquePrefix('conv-life-list')
		const userId = await getActiveUserId()
		const sql = getSql()
		const { listArchivedConversations, listRecentConversations, conversationListVersion } = await import(
			'../src/lib/chat/conversation-list.server'
		)
		const { setConversationArchivedForUser, setConversationPinnedForUser } = await import(
			'../src/lib/chat/conversation-lifecycle.server'
		)

		try {
			const pinnedOld = await seedConversation(`${prefix} pinned long ago`, userId)
			// Older than anything the recent list would reach: only the pin keeps it listed.
			await sql`update conversations set updated_at = now() - interval '10 years' where id = ${pinnedOld}`
			const archived = await seedConversation(`${prefix} archived`, userId)
			const plain = await seedConversation(`${prefix} plain`, userId)
			await sql`
				insert into messages (conversation_id, role, content, metadata, tool_calls, sequence)
				values (${plain}, 'assistant', ${'r'.repeat(5000)}, '{}'::jsonb, '[]'::jsonb, 1)
			`

			const v0 = await conversationListVersion(userId)
			await setConversationPinnedForUser(userId, pinnedOld, true)
			const v1 = await conversationListVersion(userId)
			expect(v1).not.toBe(v0)
			await setConversationArchivedForUser(userId, archived, true)
			expect(await conversationListVersion(userId)).not.toBe(v1)

			// Room for one unpinned chat: the pinned one is listed anyway, first.
			const tight = await listRecentConversations(userId, 1)
			expect(tight.map((c) => c.id)).toContain(pinnedOld)
			expect(tight[0].pinnedAt).not.toBeNull()

			const recent = await listRecentConversations(userId)
			const ids = recent.map((c) => c.id)
			expect(ids).toContain(pinnedOld)
			expect(ids).toContain(plain)
			expect(ids).not.toContain(archived)
			// The preview is a line, not the whole reply.
			expect(recent.find((c) => c.id === plain)?.lastMessage).toHaveLength(280)

			const archive = await listArchivedConversations(userId)
			expect(archive.map((c) => c.id)).toContain(archived)
			expect(archive.map((c) => c.id)).not.toContain(plain)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('a message the user sends brings an archived chat back', async () => {
		const prefix = uniquePrefix('conv-life-unarchive')
		const userId = await getActiveUserId()
		const { setConversationArchivedForUser } = await import('../src/lib/chat/conversation-lifecycle.server')
		const { resolveParentMessage } = await import('../src/lib/chat/stream-persistence.server')
		const { insertMessageWithSequence } = await import('../src/lib/chat/insert-message.server')

		try {
			const id = await seedConversation(`${prefix} archived`, userId)
			await setConversationArchivedForUser(userId, id, true)

			// An automation writing into it does not.
			await insertMessageWithSequence({ conversationId: id, role: 'assistant', content: 'scheduled report' })
			expect((await lifecycleRow(id))?.archived_at).not.toBeNull()

			const result = await resolveParentMessage({ conversationId: id, body: { content: 'one more thing' }, model: 'claude-sonnet-5' })
			expect(result.ok).toBe(true)
			expect((await lifecycleRow(id))?.archived_at).toBeNull()
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})

/** The sidebar on a desktop, the navigation drawer on a phone. */
async function openNav(page: Page, isMobile: boolean): Promise<Locator> {
	if (!isMobile) return page.locator('aside.console-sb')
	await page.getByRole('button', { name: 'Open navigation' }).filter({ visible: true }).first().click()
	const drawer = page.getByRole('dialog', { name: 'Navigation drawer' })
	await expect(drawer).toBeVisible()
	return drawer
}

function chatItem(nav: Locator, id: string) {
	return nav.locator(`.console-chatitem[data-conversation-id="${id}"]`)
}

async function openRowMenu(nav: Locator, id: string) {
	const item = chatItem(nav, id)
	await item.hover()
	await item.getByRole('button', { name: /^Actions for / }).click()
	const menu = item.getByRole('menu')
	await expect(menu).toBeVisible()
	return menu
}

async function chooseStatus(nav: Locator, status: 'All' | 'Running' | 'Archived') {
	await nav.locator('.console-sb__filterbtn').click()
	await nav.getByRole('combobox', { name: 'Status' }).selectOption(status)
}

test.describe('conversation lifecycle — the sidebar', () => {
	test('pin, archive, find in the archive, unarchive, rename and export from the row menu', async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'desktop sidebar; the phone drawer is covered below')
		test.setTimeout(90_000)
		const prefix = uniquePrefix('conv-life-ui')
		const userId = await getActiveUserId()
		await authenticateContext(page.context())

		try {
			const id = await seedConversation(`${prefix} Lifecycle chat`, userId)
			await page.goto('/', { waitUntil: 'domcontentloaded' })
			await waitForHydration(page)
			const nav = await openNav(page, false)
			const item = chatItem(nav, id)
			await expect(item).toBeVisible({ timeout: 15_000 })

			// Pin: into the Pinned group, above everything else.
			await (await openRowMenu(nav, id)).getByRole('menuitem', { name: 'Pin to top' }).click()
			await expect(nav.locator('.console-chatgroup.is-pinned')).toBeVisible()
			await expect
				.poll(() =>
					nav.locator('.console-sb__chatlist').evaluate((list, wanted) => {
						const pinned: string[] = []
						let inPinned = false
						for (const el of Array.from(list.children)) {
							if (el.classList.contains('console-chatgroup')) inPinned = el.classList.contains('is-pinned')
							else if (inPinned && el instanceof HTMLElement && el.dataset.conversationId) pinned.push(el.dataset.conversationId)
						}
						return pinned.includes(wanted)
					}, id),
				)
				.toBe(true)
			expect((await lifecycleRow(id))?.pinned_at).not.toBeNull()

			// Rename.
			await (await openRowMenu(nav, id)).getByRole('menuitem', { name: 'Rename' }).click()
			const titleField = item.getByRole('textbox', { name: 'Conversation title' })
			await titleField.fill(`${prefix} Renamed chat`)
			await titleField.press('Enter')
			await expect(item.locator('a.console-chatrow')).toContainText(`${prefix} Renamed chat`)
			expect((await lifecycleRow(id))?.title).toBe(`${prefix} Renamed chat`)

			// Export: a real download from the menu.
			const menu = await openRowMenu(nav, id)
			const [download] = await Promise.all([
				page.waitForEvent('download'),
				menu.getByRole('menuitem', { name: 'Export as Markdown' }).click(),
			])
			expect(download.suggestedFilename()).toMatch(/-\d{4}-\d{2}-\d{2}\.md$/)

			// Archive — the one-click button on the row — takes it out of the list and the pin.
			await item.hover()
			await item.getByRole('button', { name: `Archive ${prefix} Renamed chat` }).click()
			await expect(chatItem(nav, id)).toHaveCount(0)
			const archivedRow = await lifecycleRow(id)
			expect(archivedRow?.archived_at).not.toBeNull()
			expect(archivedRow?.pinned_at).toBeNull()

			// The Archived view finds it, and Unarchive puts it back.
			await chooseStatus(nav, 'Archived')
			await expect(nav.getByText('Archived chats')).toBeVisible()
			await expect(chatItem(nav, id)).toBeVisible({ timeout: 15_000 })
			await (await openRowMenu(nav, id)).getByRole('menuitem', { name: 'Unarchive' }).click()
			await expect(chatItem(nav, id)).toHaveCount(0)
			await nav.getByRole('button', { name: 'Back to chats' }).click()
			await expect(chatItem(nav, id)).toBeVisible({ timeout: 15_000 })
			expect((await lifecycleRow(id))?.archived_at).toBeNull()
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('delete asks first, and deleting the open chat goes home', async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'desktop sidebar; the phone drawer is covered below')
		test.setTimeout(90_000)
		const prefix = uniquePrefix('conv-life-delete')
		const userId = await getActiveUserId()
		await authenticateContext(page.context())

		try {
			const id = await seedConversation(`${prefix} Doomed chat`, userId)
			await page.goto(`/chat/${id}`, { waitUntil: 'domcontentloaded' })
			await waitForHydration(page)
			const nav = await openNav(page, false)
			await expect(chatItem(nav, id)).toBeVisible({ timeout: 15_000 })

			// Declining changes nothing.
			await (await openRowMenu(nav, id)).getByRole('menuitem', { name: 'Delete…' }).click()
			await answerConfirmDialog(page, 'Delete', { decline: true })
			expect(await lifecycleRow(id)).not.toBeNull()

			await (await openRowMenu(nav, id)).getByRole('menuitem', { name: 'Delete…' }).click()
			await answerConfirmDialog(page, 'Delete')
			await expect(page).toHaveURL(/\/$/)
			await expect(chatItem(nav, id)).toHaveCount(0)
			expect(await lifecycleRow(id)).toBeNull()
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('on a phone the menu button is shown without hovering, and archive works from the drawer', async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== 'mobile', 'phone drawer')
		test.setTimeout(90_000)
		const prefix = uniquePrefix('conv-life-mobile')
		const userId = await getActiveUserId()
		await authenticateContext(page.context())

		try {
			const id = await seedConversation(`${prefix} Phone chat with a fairly long title that has to truncate`, userId)
			await page.goto('/', { waitUntil: 'domcontentloaded' })
			await waitForHydration(page)
			const nav = await openNav(page, true)
			const item = chatItem(nav, id)
			await expect(item).toBeVisible({ timeout: 15_000 })

			const button = item.getByRole('button', { name: /^Actions for / })
			await expect(button).toBeVisible()
			expect(await button.evaluate((el) => getComputedStyle(el.parentElement!).opacity)).toBe('1')
			// The title keeps real width beside the button rather than collapsing to nothing.
			expect(await item.locator('.console-chatrow .t').evaluate((el) => el.getBoundingClientRect().width)).toBeGreaterThan(80)

			await button.click()
			const menu = item.getByRole('menu')
			await expect(menu).toBeVisible()
			const box = await menu.boundingBox()
			const viewport = page.viewportSize()!
			expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1)

			await menu.getByRole('menuitem', { name: 'Archive' }).click()
			await expect(chatItem(nav, id)).toHaveCount(0)
			expect((await lifecycleRow(id))?.archived_at).not.toBeNull()
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('on a phone, the home page’s recent chats are the latest ones, not the pinned ones', async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== 'mobile', 'the home page lists recent chats only where the sidebar is hidden')
		test.setTimeout(60_000)
		const prefix = uniquePrefix('conv-life-home')
		const userId = await getActiveUserId()
		const sql = getSql()
		await authenticateContext(page.context())

		try {
			// Five chats pinned just now but quiet for years: the server lists them first.
			for (let i = 0; i < 5; i++) {
				const id = await seedConversation(`${prefix} pinned ${i}`, userId)
				await sql`update conversations set pinned_at = now(), updated_at = now() - interval '10 years' where id = ${id}`
			}
			// Five fresh ones, so there are always five newer than the pinned ones.
			for (let i = 0; i < 5; i++) await seedConversation(`${prefix} fresh ${i}`, userId)

			await page.goto('/', { waitUntil: 'domcontentloaded' })
			await waitForHydration(page)
			const heading = page.getByRole('heading', { name: 'Recent chats' })
			await expect(heading).toBeVisible({ timeout: 15_000 })
			const section = heading.locator('xpath=..')
			await expect(section.locator('a[href^="/chat/"]')).toHaveCount(5)
			await expect(section.getByText(`${prefix} pinned`)).toHaveCount(0)
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})
