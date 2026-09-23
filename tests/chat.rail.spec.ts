import { expect, test, type Page } from '@playwright/test'
import {
	acquireGlobalStateLock,
	authenticateContext,
	cleanupPrefixedRecords,
	getActiveUserId,
	getSql,
	pollDb,
	uniquePrefix,
} from './helpers'

/**
 * #14 — the chat's right rail: Preview + Files, folded to a strip until it is needed.
 *
 * Seeds a conversation whose saved assistant reply carries `Edit` / `Write` blocks with
 * `file_edit` details — the shape the engine persists on `messages.metadata.blocks` — so
 * the Files tab has something real to list without a model round-trip.
 *
 * Whether the rail is expanded is a per-user preference (`chat_workbench_preferences.
 * panel_layout.railOpen`), so the desktop tests that read or write it hold a lock and put
 * the user's own value back afterwards. The phone tests only open the drawer, which neither
 * reads nor writes it.
 */

const RAIL_LOCK = 'chat-rail-open-preference'

async function seedChatWithEdits(prefix: string, extra?: { runId?: string }) {
	const sql = getSql()
	const userId = await getActiveUserId()
	const [conversation] = await sql<{ id: string }[]>`
		insert into conversations (title, user_id, model, total_tokens, total_cost)
		values (${`${prefix} convo`}, ${userId}, 'anthropic/claude-sonnet-4', 0, '0.0123')
		returning id
	`
	const [userMsg] = await sql<{ id: string }[]>`
		insert into messages (conversation_id, role, content, model, metadata, tool_calls, sequence)
		values (${conversation.id}, 'user', ${`${prefix} prompt`}, 'anthropic/claude-sonnet-4', '{}'::jsonb, '[]'::jsonb, 1)
		returning id
	`
	const fileEdit = (path: string, additions: number, deletions: number, changeType: 'create' | 'update', tool: string) => ({
		kind: 'tool',
		name: tool,
		arguments: { file_path: path },
		result: 'ok',
		success: true,
		executionMs: 0,
		details: {
			kind: 'file_edit',
			tool,
			path,
			changeType,
			hunks: [],
			additions,
			deletions,
			unavailable: 'none',
			truncated: false,
		},
	})
	const blocks = [
		fileEdit('src/lib/rail-demo/widget.ts', 5, 2, 'update', 'Edit'),
		fileEdit('notes/rail-plan.md', 12, 0, 'create', 'Write'),
		fileEdit('src/lib/rail-demo/widget.ts', 3, 1, 'update', 'Edit'),
		{ kind: 'text', content: `${prefix} done` },
	]
	const metadata = { blocks, ...(extra?.runId ? { runId: extra.runId } : {}) }
	await sql`
		insert into messages (conversation_id, role, content, model, parent_message_id, metadata, tool_calls, sequence)
		values (
			${conversation.id}, 'assistant', ${`${prefix} done`}, 'anthropic/claude-sonnet-4', ${userMsg.id},
			${sql.json(metadata as never)}, '[]'::jsonb, 2
		)
	`
	return conversation
}

async function readRailOpenPref(): Promise<{ exists: boolean; panelLayout: unknown }> {
	const userId = await getActiveUserId()
	const rows = await getSql()<{ panel_layout: unknown }[]>`
		select panel_layout from chat_workbench_preferences where user_id = ${userId}
	`
	return { exists: rows.length > 0, panelLayout: rows[0]?.panel_layout ?? null }
}

async function setRailOpenPref(open: boolean) {
	const userId = await getActiveUserId()
	await getSql()`
		insert into chat_workbench_preferences (user_id, panel_layout)
		values (${userId}, ${getSql().json({ railOpen: open } as never)})
		on conflict (user_id) do update
		set panel_layout = coalesce(chat_workbench_preferences.panel_layout, '{}'::jsonb) || jsonb_build_object('railOpen', ${open}::boolean)
	`
}

async function waitForRailOpenPref(open: boolean) {
	await pollDb(
		readRailOpenPref,
		(v) => (v.panelLayout as { railOpen?: boolean } | null)?.railOpen === open,
		{ description: `panel_layout.railOpen = ${open}` },
	)
}

/** The desktop column. The phone drawer renders the same component, hidden at this width. */
function columnRail(page: Page) {
	return page.locator('.console-grid > .console-rail')
}

/** Messages load client-side, so the seeded reply on screen also means the page has hydrated. */
async function openChat(page: Page, id: string, prefix: string) {
	await page.goto(`/chat/${id}`, { waitUntil: 'domcontentloaded' })
	await expect(page.getByText(`${prefix} done`).first()).toBeVisible({ timeout: 30_000 })
}

test.describe('chat rail — desktop column', () => {
	let prefix = ''
	let conversationId = ''
	let release: (() => Promise<void>) | null = null
	let original: { exists: boolean; panelLayout: unknown } | null = null

	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'the rail is a column on desktop; the phone drawer is covered below')
		test.setTimeout(90_000)
		release = await acquireGlobalStateLock(RAIL_LOCK)
		original = await readRailOpenPref()
		await setRailOpenPref(false)
		prefix = uniquePrefix('rail-col')
		await cleanupPrefixedRecords(prefix)
		conversationId = (await seedChatWithEdits(prefix, { runId: '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b' })).id
		await authenticateContext(page.context())
	})

	test.afterEach(async ({ page }) => {
		try {
			// Nothing left on the page may still save the preference after it is restored.
			await page.close()
			if (prefix) await cleanupPrefixedRecords(prefix)
			if (original) {
				const userId = await getActiveUserId()
				await getSql()`
					update chat_workbench_preferences
					set panel_layout = ${original.panelLayout === null ? null : getSql().json(original.panelLayout as never)}
					where user_id = ${userId}
				`
			}
		} finally {
			original = null
			await release?.()
			release = null
		}
	})

	test('starts as a strip with only Preview and Files, and the topbar carries the context ring', async ({ page }) => {
		await openChat(page, conversationId, prefix)
		const rail = columnRail(page)
		await expect(rail).toHaveClass(/is-collapsed/)
		await expect(rail.getByRole('button', { name: 'Expand rail' })).toBeVisible()
		await expect(rail.getByRole('button', { name: 'Show Preview' })).toBeVisible()
		// Three edits to two files: the badge counts files, not edits.
		await expect(rail.getByTestId('rail-files-count')).toHaveText('2')
		await expect(rail).not.toContainText(/Research|Activity|Tokens|Latency/)

		// The strip really is narrow — the thread gets the width back.
		const box = await rail.boundingBox()
		expect(box?.width ?? 0).toBeLessThanOrEqual(48)

		// Context ring and metered cost moved into the desktop topbar (they were the rail's footer).
		const topbar = page.locator('.console-topbar')
		await expect(topbar.locator('[aria-label^="Context window usage"]')).toBeVisible()
		await expect(topbar.getByText('$0.0123')).toBeVisible()
	})

	test('Files lists what the agent changed, and a row opens it in Preview', async ({ page }) => {
		await openChat(page, conversationId, prefix)
		const rail = columnRail(page)
		await rail.getByRole('button', { name: 'Show Files' }).click()

		await expect(rail).not.toHaveClass(/is-collapsed/)
		await expect(rail.getByRole('tab')).toHaveText(['Preview', 'Files 2'])
		await expect(rail.getByRole('tab', { name: /Files/ })).toHaveAttribute('aria-selected', 'true')
		await expect(rail.getByText('Changed in this chat')).toBeVisible()

		const rows = rail.locator('.console-files__row')
		await expect(rows).toHaveCount(2)
		// Newest first: widget.ts was edited again after the plan was written.
		const widget = rows.nth(0)
		await expect(widget.locator('.console-files__name')).toHaveText('widget.ts')
		await expect(widget.locator('.console-files__dir')).toHaveText('src/lib/rail-demo/')
		await expect(widget.locator('.console-files__stat.is-add')).toHaveText('+8')
		await expect(widget.locator('.console-files__stat.is-del')).toHaveText('−3')
		await expect(widget.locator('.console-files__new')).toHaveCount(0)
		const plan = rows.nth(1)
		await expect(plan.locator('.console-files__name')).toHaveText('rail-plan.md')
		await expect(plan.locator('.console-files__new')).toHaveText('new')
		// Like the diff card, a zero count is left out rather than shown as "−0".
		await expect(plan.locator('.console-files__stat.is-add')).toHaveText('+12')
		await expect(plan.locator('.console-files__stat.is-del')).toHaveCount(0)

		await plan.click()
		await expect(rail.getByRole('tab', { name: 'Preview' })).toHaveAttribute('aria-selected', 'true')
		await expect(rail.locator('.console-prev__bar')).toContainText('notes/rail-plan.md')

		// Expanding is remembered for this viewer.
		await waitForRailOpenPref(true)
	})

	test('the viewer’s expanded or collapsed choice survives a reload', async ({ page }) => {
		await openChat(page, conversationId, prefix)
		const rail = columnRail(page)
		await expect(rail).toHaveClass(/is-collapsed/)

		await rail.getByRole('button', { name: 'Expand rail' }).click()
		await expect(rail.getByRole('button', { name: 'Collapse rail' })).toBeVisible()
		await waitForRailOpenPref(true)

		await openChat(page, conversationId, prefix)
		await expect(rail.getByRole('button', { name: 'Collapse rail' })).toBeVisible()
		await expect(rail).not.toHaveClass(/is-collapsed/)

		await rail.getByRole('button', { name: 'Collapse rail' }).click()
		await expect(rail).toHaveClass(/is-collapsed/)
		await waitForRailOpenPref(false)

		await openChat(page, conversationId, prefix)
		await expect(rail.getByRole('button', { name: 'Expand rail' })).toBeVisible()
	})

	test('a stored Research tab from before #14 reopens on Preview with its file', async ({ page }) => {
		const userId = await getActiveUserId()
		await getSql()`
			insert into chat_rail_preview (conversation_id, user_id, tab, kind, target)
			values (${conversationId}, ${userId}, 'Research', 'file', 'notes/rail-plan.md')
		`
		await openChat(page, conversationId, prefix)
		const rail = columnRail(page)
		// Still folded (the viewer left it that way), but the strip says something is open.
		await expect(rail).toHaveClass(/is-collapsed/)
		await expect(rail.locator('.console-rail__strip-dot')).toBeVisible()

		await rail.getByRole('button', { name: 'Show Preview' }).click()
		await expect(rail.getByRole('tab', { name: 'Preview' })).toHaveAttribute('aria-selected', 'true')
		await expect(rail.locator('.console-prev__bar')).toContainText('notes/rail-plan.md')
		await waitForRailOpenPref(true)
	})

	test('closing the preview folds the rail back to its strip', async ({ page }) => {
		await openChat(page, conversationId, prefix)
		const rail = columnRail(page)
		await rail.getByRole('button', { name: 'Show Files' }).click()
		await rail.locator('.console-files__row').first().click()
		await expect(rail.locator('.console-prev__bar')).toBeVisible()
		await waitForRailOpenPref(true)

		await rail.getByRole('button', { name: 'Close preview' }).click()
		await expect(rail).toHaveClass(/is-collapsed/)
		await waitForRailOpenPref(false)
	})

	test('on a tablet-width window the header button expands and folds the column', async ({ page }) => {
		await page.setViewportSize({ width: 1024, height: 800 })
		await openChat(page, conversationId, prefix)
		const rail = columnRail(page)
		await expect(rail).toHaveClass(/is-collapsed/)

		const headerButton = page.getByRole('button', { name: 'Open chat rail' }).filter({ visible: true })
		await headerButton.click()
		await expect(rail).not.toHaveClass(/is-collapsed/)
		await waitForRailOpenPref(true)
		await headerButton.click()
		await expect(rail).toHaveClass(/is-collapsed/)
		await waitForRailOpenPref(false)
	})

	test('a reply links to its run, where the tool timeline lives now', async ({ page }) => {
		await openChat(page, conversationId, prefix)
		await page.getByRole('button', { name: 'Message stats' }).last().click()
		const link = page.getByRole('link', { name: 'Timeline' })
		await expect(link).toBeVisible()
		await expect(link).toHaveAttribute('href', '/runs/6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b')
	})
})

test.describe('chat rail — phone drawer', () => {
	test('the header button opens a drawer that shows the rail, Files included', async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== 'mobile', 'the drawer only exists below the tablet breakpoint')
		test.setTimeout(90_000)
		const prefix = uniquePrefix('rail-drawer')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(page.context())
		try {
			const conversation = await seedChatWithEdits(prefix)
			await openChat(page, conversation.id, prefix)

			// The desktop column is hidden at this width.
			await expect(columnRail(page)).toBeHidden()

			await page.getByRole('button', { name: 'Open chat rail' }).filter({ visible: true }).click()
			const drawer = page.getByRole('dialog', { name: 'Chat rail drawer' })
			// This drawer used to open empty: the rule hiding the column hid it too.
			await expect(drawer.getByLabel('Open a file path or URL in the preview')).toBeVisible()
			// The drawer has no collapse control — it is closed by hand.
			await expect(drawer.getByRole('button', { name: 'Collapse rail' })).toHaveCount(0)

			await drawer.getByRole('tab', { name: /Files/ }).click()
			const rows = drawer.locator('.console-files__row')
			await expect(rows).toHaveCount(2)
			// On a narrow screen the name must keep real width next to the +/- counts.
			const name = rows.first().locator('.console-files__name')
			await expect(name).toHaveText('widget.ts')
			const box = await name.boundingBox()
			expect(box?.width ?? 0).toBeGreaterThan(20)
			await expect(rows.first().locator('.console-files__stat.is-add')).toBeVisible()
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})

test.describe('chat rail — where it does not appear', () => {
	test('the home page has no rail', async ({ page }) => {
		test.setTimeout(60_000)
		await authenticateContext(page.context())
		await page.goto('/', { waitUntil: 'domcontentloaded' })
		await expect(page.locator('.console-grid')).toBeVisible({ timeout: 30_000 })
		await expect(page.locator('.console-rail')).toHaveCount(0)
	})
})
