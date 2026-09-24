import { expect, test, type Page } from '@playwright/test'
import { toolResultDetails } from '../src/lib/engine/tool-result-details'
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
 * `file_edit` details, so the Files tab has something real to list without a model
 * round-trip. The details are made by the engine's own `toolResultDetails` from the payload
 * the Agent SDK returns for each tool — for the created file, no patch and no original — so
 * they are exactly what `messages.metadata.blocks` holds in production.
 *
 * Whether the rail is expanded is a per-user preference (`chat_workbench_preferences.
 * panel_layout.railOpen`), shared by every test that signs in as the test user. So every
 * test here that can change it or asserts on it — the phone drawer's included, which checks
 * the drawer leaves it alone — holds a lock and puts the user's own value back afterwards.
 */

const RAIL_LOCK = 'chat-rail-open-preference'

/** The rail's remote functions, as the page requests them: `/_app/remote/<hash>/<name>`. */
const RAIL_OPEN_QUERY = /\/remote\/[^/?]+\/getRailOpen(?:[?#]|$)/
const RAIL_OPEN_COMMAND = /\/remote\/[^/?]+\/setRailOpen(?:[?#]|$)/

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
	const toolBlock = (tool: string, path: string, sdkResult: Record<string, unknown>) => ({
		kind: 'tool',
		name: tool,
		arguments: { file_path: path },
		result: 'ok',
		success: true,
		executionMs: 0,
		details: toolResultDetails(tool, sdkResult, { file_path: path }),
	})
	/** An `Edit` as the SDK answers one: a patch of `deletions` removed and `additions` added lines. */
	const edit = (path: string, additions: number, deletions: number) =>
		toolBlock('Edit', path, {
			filePath: path,
			oldString: 'old',
			newString: 'new',
			originalFile: 'old\n',
			structuredPatch: [
				{
					oldStart: 1,
					oldLines: deletions,
					newStart: 1,
					newLines: additions,
					lines: [
						...Array.from({ length: deletions }, (_, i) => `-old ${i}`),
						...Array.from({ length: additions }, (_, i) => `+new ${i}`),
					],
				},
			],
			userModified: false,
			replaceAll: false,
		})
	/** A `Write` that created a file, as the SDK answers one: no patch and no original. */
	const create = (path: string, lineCount: number) =>
		toolBlock('Write', path, {
			type: 'create',
			filePath: path,
			content: Array.from({ length: lineCount }, (_, i) => `line ${i + 1}\n`).join(''),
			structuredPatch: [],
			originalFile: null,
		})
	const blocks = [
		edit('src/lib/rail-demo/widget.ts', 5, 2),
		create('notes/rail-plan.md', 12),
		edit('src/lib/rail-demo/widget.ts', 3, 1),
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

/**
 * Hold the preference for one test: take the lock, remember the user's own value and start
 * from folded. The returned restore puts that value back and releases the lock — close the
 * page first, so nothing left on it can still save over the restored value.
 */
async function holdRailOpenPref(): Promise<() => Promise<void>> {
	const release = await acquireGlobalStateLock(RAIL_LOCK)
	try {
		const original = await readRailOpenPref()
		await setRailOpenPref(false)
		return async () => {
			try {
				const userId = await getActiveUserId()
				if (!original.exists) {
					// The user had no preferences row, so this test made it. Take the key back out,
					// and drop the row only if nothing else has been saved on it since.
					await getSql()`
						update chat_workbench_preferences
						set panel_layout = panel_layout - 'railOpen'
						where user_id = ${userId}
					`
					await getSql()`
						delete from chat_workbench_preferences
						where user_id = ${userId}
							and default_agent_id is null
							and show_right_panel = true
							and coalesce(panel_layout, '{}'::jsonb) = '{}'::jsonb
					`
				} else {
					await getSql()`
						update chat_workbench_preferences
						set panel_layout = ${original.panelLayout === null ? null : getSql().json(original.panelLayout as never)}
						where user_id = ${userId}
					`
				}
			} finally {
				await release()
			}
		}
	} catch (error) {
		await release()
		throw error
	}
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
	let restorePref: (() => Promise<void>) | null = null

	test.beforeEach(async ({ page }, testInfo) => {
		test.skip(testInfo.project.name !== 'desktop', 'the rail is a column on desktop; the phone drawer is covered below')
		test.setTimeout(90_000)
		restorePref = await holdRailOpenPref()
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
		} finally {
			await restorePref?.()
			restorePref = null
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

		// The thread's card for the new file shows what was written, not "No changes".
		const card = page.locator('.console-diff').filter({ hasText: 'rail-plan.md' })
		await expect(card.locator('.console-diff__verb')).toHaveText('Created')
		await expect(card.locator('.console-diff__line.is-add')).toHaveCount(12)
		await expect(card).not.toContainText('No changes')

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

	test('an expanded rail comes back on the first render after a reload; the stored preference still wins', async ({
		page,
	}) => {
		await openChat(page, conversationId, prefix)
		const rail = columnRail(page)
		await rail.getByRole('button', { name: 'Expand rail' }).click()
		await expect(rail).not.toHaveClass(/is-collapsed/)
		await waitForRailOpenPref(true)

		// Another device folds it. This browser still remembers it expanded.
		await setRailOpenPref(false)

		// Hold the stored preference back, so what renders before it arrives can be checked.
		let releaseQuery: () => void = () => {}
		const held = new Promise<void>((resolve) => (releaseQuery = resolve))
		let queried = 0
		await page.route(RAIL_OPEN_QUERY, async (route) => {
			queried++
			await held
			await route.continue()
		})
		try {
			await openChat(page, conversationId, prefix)
			await expect.poll(() => queried).toBeGreaterThan(0)
			// No longer the strip first and a ~320px jump of the thread when the preference arrives.
			await expect(rail).not.toHaveClass(/is-collapsed/)
			expect((await rail.boundingBox())?.width ?? 0).toBeGreaterThan(200)
		} finally {
			releaseQuery()
		}
		// The database is the source of truth: once it answers, the rail folds.
		await expect(rail).toHaveClass(/is-collapsed/)
		await page.unroute(RAIL_OPEN_QUERY)

		// This browser's copy follows it, so the next load starts folded before the query answers.
		queried = 0
		await page.route(RAIL_OPEN_QUERY, () => {
			queried++ // never answered
		})
		await openChat(page, conversationId, prefix)
		await expect.poll(() => queried).toBeGreaterThan(0)
		await expect(rail).toHaveClass(/is-collapsed/)
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

	test('on a tablet-width window the header button expands and folds the column, and says which', async ({ page }) => {
		await page.setViewportSize({ width: 1024, height: 800 })
		await openChat(page, conversationId, prefix)
		const rail = columnRail(page)
		await expect(rail).toHaveClass(/is-collapsed/)

		// This width has neither the desktop topbar nor the phone's chips row, so the header
		// carries the metered cost itself, once.
		await expect(page.getByText('$0.0123').filter({ visible: true })).toHaveCount(1)

		const expand = page.getByRole('button', { name: 'Expand chat rail' }).filter({ visible: true })
		await expect(expand).toHaveAttribute('aria-expanded', 'false')
		await expand.click()
		await expect(rail).not.toHaveClass(/is-collapsed/)
		await waitForRailOpenPref(true)

		// The same button, now named for what it will do next.
		const collapse = page.getByRole('button', { name: 'Collapse chat rail' }).filter({ visible: true })
		await expect(collapse).toHaveAttribute('aria-expanded', 'true')
		await expect(collapse).toBeFocused()
		await collapse.click()
		await expect(rail).toHaveClass(/is-collapsed/)
		await expect(expand).toHaveAttribute('aria-expanded', 'false')
		await waitForRailOpenPref(false)
	})

	test('keyboard focus follows the rail as it expands and folds', async ({ page }) => {
		await openChat(page, conversationId, prefix)
		const rail = columnRail(page)
		const expand = rail.getByRole('button', { name: 'Expand rail' })
		const collapse = rail.getByRole('button', { name: 'Collapse rail' })

		// Each of these buttons is replaced by the other when pressed; focus goes with it
		// rather than dropping to the page.
		await expand.focus()
		await page.keyboard.press('Enter')
		await expect(collapse).toBeFocused()
		await page.keyboard.press('Enter')
		await expect(expand).toBeFocused()

		// A strip button lands on the tab it asked for.
		await rail.getByRole('button', { name: 'Show Files' }).focus()
		await page.keyboard.press('Enter')
		await expect(rail.getByRole('tab', { name: /Files/ })).toBeFocused()

		// Opening a file replaces the Files list with the preview: focus lands on its tab.
		await rail.locator('.console-files__row').first().focus()
		await page.keyboard.press('Enter')
		await expect(rail.getByRole('tab', { name: 'Preview' })).toBeFocused()
		await expect(rail.locator('.console-prev__bar')).toBeVisible()

		// Closing the preview folds the rail: focus lands on the strip's expand button.
		await rail.getByRole('button', { name: 'Close preview' }).focus()
		await page.keyboard.press('Enter')
		await expect(rail).toHaveClass(/is-collapsed/)
		await expect(expand).toBeFocused()
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
		const restorePref = await holdRailOpenPref()
		await authenticateContext(page.context())
		const railOpenWrites: string[] = []
		page.on('request', (request) => {
			if (RAIL_OPEN_COMMAND.test(request.url())) railOpenWrites.push(request.url())
		})
		try {
			const conversation = await seedChatWithEdits(prefix)
			await openChat(page, conversation.id, prefix)

			// The desktop column is hidden at this width.
			await expect(columnRail(page)).toBeHidden()

			// The cost shows once, in the chips row under the header.
			await expect(page.getByText('$0.0123').filter({ visible: true })).toHaveCount(1)

			const railButton = page.getByRole('button', { name: 'Open chat rail' }).filter({ visible: true })
			await expect(railButton).toHaveAttribute('aria-expanded', 'false')
			await railButton.click()
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

			// Nothing done in the drawer touches the fold, which belongs to the desktop column:
			// not the Files tab, not opening a file, not closing it. The selection is saved on the
			// same 400ms debounce, scheduled after the fold's, so once it has landed any fold
			// write would already have been sent.
			await rows.first().click()
			await expect(drawer.locator('.console-prev__bar')).toContainText('src/lib/rail-demo/widget.ts')
			const railPreviewRow = () => getSql()<{ kind: string; target: string | null }[]>`
				select kind, target from chat_rail_preview where conversation_id = ${conversation.id}
			`
			await pollDb(railPreviewRow, (r) => r[0]?.target === 'src/lib/rail-demo/widget.ts', {
				description: 'the drawer saved the open file',
			})
			await drawer.getByRole('button', { name: 'Close preview' }).click()
			await pollDb(railPreviewRow, (r) => r[0]?.kind === 'none', { description: 'the drawer saved the closed preview' })

			expect(railOpenWrites).toEqual([])
			const stored = await readRailOpenPref()
			expect((stored.panelLayout as { railOpen?: boolean } | null)?.railOpen).toBe(false)
		} finally {
			await page.close()
			await cleanupPrefixedRecords(prefix)
			await restorePref()
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
