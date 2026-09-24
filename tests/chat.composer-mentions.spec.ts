import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { getProjectPath } from '../src/lib/projects/project-fs.server'
import {
	authenticateContext,
	cleanupExtendedPrefix,
	getActiveUserId,
	getBuiltinChatAgentId,
	getSql,
	readEnvVar,
	seedProject,
	uniquePrefix,
	waitForHydration,
} from './helpers'
import { sse } from './chat-stream-script'
import { SUBSCRIPTION_MODEL_IDS } from '../src/lib/engine/model-backend'
import { claudeDisplayName } from '../src/lib/llm/engine-models'
// The Compact button's prompt (#24): the CLI's own `/compact`, not a request for a summary.
import { compactCommand as sdkCompactPrompt } from '../src/lib/chat/compact-command'

/**
 * #22 — `@` file mentions and the `/` command palette, driven through the chat page on both
 * a desktop and a phone viewport.
 *
 * No model is involved: `/chat/[id]/stream` is intercepted and only records what the page
 * sends, so "nothing was sent" and "this is what was sent" are both observable.
 */

type Seeded = { conversationId: string; projectPath: string | null }

async function seedChat(prefix: string, options: { withProject: boolean; model?: string }): Promise<Seeded> {
	const sql = getSql()
	const userId = await getActiveUserId()
	let projectId: string | null = null
	let projectPath: string | null = null
	if (options.withProject) {
		const project = await seedProject(prefix)
		projectId = project.id
		projectPath = getProjectPath(userId, project.id)
		await mkdir(join(projectPath, 'docs'), { recursive: true })
		await mkdir(join(projectPath, 'src'), { recursive: true })
		await writeFile(join(projectPath, 'docs', 'pinned-notes.md'), '# notes')
		await writeFile(join(projectPath, 'src', 'pin-table.ts'), 'export {}')
		await writeFile(join(projectPath, 'README.md'), '# readme')
	}
	const [row] = await sql<{ id: string }[]>`
		insert into conversations (user_id, agent_id, project_id, title, model, total_tokens, total_cost)
		values (${userId}, ${await getBuiltinChatAgentId()}, ${projectId}, ${`${prefix} convo`}, ${options.model ?? 'claude-sonnet-5'}, 0, '0')
		returning id
	`
	return { conversationId: row.id, projectPath }
}

async function cleanup(prefix: string, seeded: Seeded | null) {
	if (seeded?.projectPath) await rm(seeded.projectPath, { recursive: true, force: true }).catch(() => {})
	await cleanupExtendedPrefix(prefix)
}

/** Record every send instead of running a turn; each one ends at once. */
async function recordSends(page: Page, conversationId: string) {
	const sends: Array<{ content?: string }> = []
	await page.route(
		(url) => url.pathname === `/chat/${conversationId}/stream`,
		(route) => {
			sends.push(route.request().postDataJSON())
			return route.fulfill({
				status: 200,
				headers: { 'content-type': 'text/event-stream' },
				body: sse([{ id: 1, event: 'done', data: { error: 'scripted end' } }]),
			})
		},
	)
	return sends
}

async function openChat(page: Page, conversationId: string) {
	await page.goto(`/chat/${conversationId}`, { waitUntil: 'domcontentloaded' })
	const composer = page.getByPlaceholder('Message AgentStudio...')
	await composer.waitFor({ state: 'visible', timeout: 30_000 })
	await waitForHydration(page)
	return composer
}

const suggest = (page: Page) => page.getByTestId('composer-suggest')

/**
 * Hold every `@` search until `release()`, so a spec can act while the list is still loading.
 * The requests then go through to the real server.
 */
async function holdMentionSearches(page: Page) {
	let release!: () => void
	const held = new Promise<void>((resolve) => (release = resolve))
	await page.route('**/_app/remote/**', async (route) => {
		if (new URL(route.request().url()).pathname.endsWith('/searchWorkspaceFiles')) await held
		await route.fallback()
	})
	return release
}

/**
 * Whether the test server runs with an LLM gateway (#9). Without one (CI's posture) the
 * engine's model list is exactly the subscription's Claude models.
 */
const gatewayConfigured = ['LLM_GATEWAY_URL', 'LLM_GATEWAY_TOKEN'].every(
	(name) => Boolean((process.env[name] ?? readEnvVar(name))?.trim()),
)

/** A tap on a phone, a click on a desktop: the row has to take either without losing focus. */
async function pick(locator: ReturnType<Page['locator']>, testInfo: TestInfo) {
	if (testInfo.project.name === 'mobile') await locator.tap()
	else await locator.click()
}

test.describe('chat composer — @ mentions', () => {
	test('typing @ lists the project’s files; arrows and Enter insert the path and send nothing', async ({ page }) => {
		test.setTimeout(90_000)
		const prefix = uniquePrefix('composer-mention')
		let seeded: Seeded | null = null
		try {
			await authenticateContext(page.context())
			seeded = await seedChat(prefix, { withProject: true })
			const sends = await recordSends(page, seeded.conversationId)
			const composer = await openChat(page, seeded.conversationId)

			await composer.click()
			await composer.pressSequentially('see @pin')
			const list = page.getByRole('listbox', { name: /Files in this chat/ })
			await expect(list).toBeVisible({ timeout: 15_000 })
			const options = list.getByRole('option')
			await expect(options).toHaveCount(2)
			await expect(composer).toHaveAttribute('aria-controls', 'chat-composer-suggest')

			// ArrowDown moves the highlight; Enter takes the highlighted row, whichever it is.
			await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true')
			await composer.press('ArrowDown')
			await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true')
			await expect(composer).toHaveAttribute('aria-activedescendant', 'chat-composer-suggest-1')
			const second = (await options.nth(1).textContent()) ?? ''
			const path = second.includes('pinned-notes') ? 'docs/pinned-notes.md' : 'src/pin-table.ts'
			await composer.press('Enter')

			await expect(composer).toHaveValue(`see \`${path}\` `)
			await expect(suggest(page)).toHaveCount(0)
			// ArrowUp wraps from the top to the bottom.
			await composer.pressSequentially('@')
			await expect(list.getByRole('option').first()).toBeVisible({ timeout: 15_000 })
			await composer.press('ArrowUp')
			await expect(list.getByRole('option').last()).toHaveAttribute('aria-selected', 'true')
			await composer.press('Tab')
			await expect(composer).toHaveValue(/^see `.+` `.+` $/)
			expect(sends).toHaveLength(0)
		} finally {
			await cleanup(prefix, seeded)
		}
	})

	test('Escape closes the menu, and the next Enter sends the message as typed', async ({ page }) => {
		test.setTimeout(90_000)
		const prefix = uniquePrefix('composer-mention-esc')
		let seeded: Seeded | null = null
		try {
			await authenticateContext(page.context())
			seeded = await seedChat(prefix, { withProject: true })
			const sends = await recordSends(page, seeded.conversationId)
			const composer = await openChat(page, seeded.conversationId)

			await composer.click()
			await composer.pressSequentially('email me@example.com about @pin')
			await expect(page.getByRole('listbox')).toBeVisible({ timeout: 15_000 })
			await composer.press('Escape')
			await expect(suggest(page)).toHaveCount(0)
			// Moving the caret within the same token does not reopen what Escape closed.
			await composer.press('ArrowLeft')
			await expect(suggest(page)).toHaveCount(0)
			await composer.press('End')
			await composer.press('Enter')

			await expect.poll(() => sends.length, { timeout: 15_000 }).toBe(1)
			expect(sends[0].content).toBe('email me@example.com about @pin')
		} finally {
			await cleanup(prefix, seeded)
		}
	})

	test('the @ Context button opens the list, and a tap picks a file', async ({ page }, testInfo) => {
		test.setTimeout(90_000)
		const prefix = uniquePrefix('composer-mention-button')
		let seeded: Seeded | null = null
		try {
			await authenticateContext(page.context())
			seeded = await seedChat(prefix, { withProject: true })
			const sends = await recordSends(page, seeded.conversationId)
			const composer = await openChat(page, seeded.conversationId)

			await composer.fill('look at')
			// Desktop shows it in the composer row; a phone in the quick row above the box.
			await pick(page.getByRole('button', { name: '@ Context' }).filter({ visible: true }), testInfo)
			await expect(composer).toHaveValue('look at @')
			const list = page.getByRole('listbox')
			await expect(list).toBeVisible({ timeout: 15_000 })
			// An empty query: the top of the tree, folders first.
			await expect(list.getByRole('option').first()).toContainText('docs/')

			// The menu stays on screen, and a row's name keeps a usable width, even at phone width.
			// (Measured on the menu itself: the chat page's off-canvas drawers sit past the edge on purpose.)
			const viewport = page.viewportSize()!
			const box = (await suggest(page).boundingBox())!
			expect(box.x).toBeGreaterThanOrEqual(0)
			expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
			expect(box.y).toBeGreaterThanOrEqual(0)
			const label = list.locator('.console-suggest__label').first()
			expect((await label.boundingBox())?.width ?? 0).toBeGreaterThan(24)

			await composer.pressSequentially('READ')
			await expect(list.getByRole('option')).toHaveCount(1)
			await pick(list.getByRole('option').first(), testInfo)
			await expect(composer).toHaveValue('look at `README.md` ')
			await expect(composer).toBeFocused()
			expect(sends).toHaveLength(0)
		} finally {
			await cleanup(prefix, seeded)
		}
	})

	test('a chat with no project says why there is nothing to mention', async ({ page }) => {
		test.setTimeout(60_000)
		const prefix = uniquePrefix('composer-mention-unbound')
		let seeded: Seeded | null = null
		try {
			await authenticateContext(page.context())
			seeded = await seedChat(prefix, { withProject: false })
			const sends = await recordSends(page, seeded.conversationId)
			const composer = await openChat(page, seeded.conversationId)

			await composer.click()
			await composer.pressSequentially('@')
			await expect(suggest(page)).toContainText('Bind the chat to a project', { timeout: 15_000 })
			await expect(page.getByRole('listbox')).toHaveCount(0)
			// Nothing to pick, so Enter sends as typed.
			await composer.press('Enter')
			await expect.poll(() => sends.length, { timeout: 15_000 }).toBe(1)
		} finally {
			await cleanup(prefix, seeded)
		}
	})

	test('Enter while the file search is still loading waits for the list instead of sending', async ({ page }) => {
		test.setTimeout(90_000)
		const prefix = uniquePrefix('composer-mention-loading')
		let seeded: Seeded | null = null
		try {
			await authenticateContext(page.context())
			seeded = await seedChat(prefix, { withProject: true })
			const sends = await recordSends(page, seeded.conversationId)
			const release = await holdMentionSearches(page)
			const composer = await openChat(page, seeded.conversationId)

			await composer.click()
			await composer.pressSequentially('look at @READ')
			await expect(suggest(page)).toContainText('Searching…')
			// Neither key sends the half-typed mention, or takes focus away from the box.
			await composer.press('Enter')
			await composer.press('Tab')
			await page.waitForTimeout(300)
			expect(sends).toHaveLength(0)
			await expect(composer).toHaveValue('look at @READ')
			await expect(composer).toBeFocused()

			// Once the list arrives, Enter takes the file the user was waiting for.
			release()
			const list = page.getByRole('listbox', { name: /Files in this chat/ })
			await expect(list.getByRole('option')).toHaveCount(1, { timeout: 15_000 })
			await composer.press('Enter')
			await expect(composer).toHaveValue('look at `README.md` ')
			expect(sends).toHaveLength(0)
		} finally {
			await cleanup(prefix, seeded)
		}
	})

	test('Enter while an IME is composing neither sends nor picks', async ({ page }) => {
		test.setTimeout(60_000)
		const prefix = uniquePrefix('composer-ime')
		let seeded: Seeded | null = null
		try {
			await authenticateContext(page.context())
			seeded = await seedChat(prefix, { withProject: true })
			const sends = await recordSends(page, seeded.conversationId)
			const composer = await openChat(page, seeded.conversationId)

			await composer.click()
			await composer.pressSequentially('@pin')
			await expect(page.getByRole('listbox').getByRole('option').first()).toBeVisible({ timeout: 15_000 })
			const composingEnter = (el: HTMLElement) =>
				el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }))
			await composer.evaluate(composingEnter)
			await expect(composer).toHaveValue('@pin')

			await composer.press('Escape')
			await composer.evaluate(composingEnter)
			// keyCode 229 is how some browsers report a composing key instead.
			await composer.evaluate((el) =>
				el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true })),
			)
			await page.waitForTimeout(300)
			expect(sends).toHaveLength(0)
			await expect(composer).toHaveValue('@pin')
		} finally {
			await cleanup(prefix, seeded)
		}
	})
})

test.describe('chat composer — / commands', () => {
	test('/ opens the palette; /plan switches the conversation to plan mode and back', async ({ page }) => {
		test.setTimeout(90_000)
		const prefix = uniquePrefix('composer-plan')
		let seeded: Seeded | null = null
		try {
			await authenticateContext(page.context())
			seeded = await seedChat(prefix, { withProject: false })
			const sends = await recordSends(page, seeded.conversationId)
			const composer = await openChat(page, seeded.conversationId)

			await composer.click()
			await composer.pressSequentially('/')
			const list = page.getByRole('listbox', { name: 'Commands' })
			await expect(list).toBeVisible()
			for (const name of ['/compact', '/model', '/research', '/plan', '/effort', '/attach']) {
				await expect(list.getByRole('option').filter({ hasText: name }).first()).toBeVisible()
			}

			await composer.pressSequentially('pla')
			await expect(list.getByRole('option').first()).toContainText('/plan')
			const switched = page.waitForResponse((r) => r.url().includes('setConversationPermissionMode') && r.ok())
			await composer.press('Enter')
			await switched

			await expect(composer).toHaveValue('')
			await expect(page.getByTestId('composer-notice')).toContainText('Plan mode is on')
			await expect(page.getByTestId('permission-mode-select').filter({ visible: true })).toHaveAttribute(
				'data-permission-mode',
				'plan',
			)
			const [row] = await getSql()<{ permission_mode: string }[]>`
				select permission_mode::text from conversations where id = ${seeded.conversationId}
			`
			expect(row.permission_mode).toBe('plan')

			// Typed in full and sent, it runs too — and toggles back.
			await composer.fill('/plan')
			await composer.press('Escape')
			const back = page.waitForResponse((r) => r.url().includes('setConversationPermissionMode') && r.ok())
			await composer.press('Enter')
			await back
			await expect(page.getByTestId('composer-notice')).toContainText('Plan mode is off')
			expect(sends).toHaveLength(0)
		} finally {
			await cleanup(prefix, seeded)
		}
	})

	test('/compact runs the same compaction turn as the Compact button', async ({ page }) => {
		test.setTimeout(90_000)
		const prefix = uniquePrefix('composer-compact')
		let seeded: Seeded | null = null
		try {
			await authenticateContext(page.context())
			seeded = await seedChat(prefix, { withProject: false })
			const sends = await recordSends(page, seeded.conversationId)
			const composer = await openChat(page, seeded.conversationId)

			await composer.click()
			await composer.pressSequentially('/compact')
			await expect(page.getByRole('listbox').getByRole('option').first()).toContainText('/compact')
			await composer.press('Enter')

			await expect.poll(() => sends.length, { timeout: 15_000 }).toBe(1)
			// The button's handler sends the CLI's own `/compact` (#24), so the palette does too.
			expect(sends[0].content).toBe(sdkCompactPrompt())
			await expect(composer).toHaveValue('')
		} finally {
			await cleanup(prefix, seeded)
		}
	})

	test('/effort opens a second list, and picking from it sets the reasoning effort', async ({ page }, testInfo) => {
		test.setTimeout(90_000)
		const prefix = uniquePrefix('composer-effort')
		let seeded: Seeded | null = null
		try {
			await authenticateContext(page.context())
			seeded = await seedChat(prefix, { withProject: false })
			const sends = await recordSends(page, seeded.conversationId)
			const composer = await openChat(page, seeded.conversationId)

			await composer.fill('keep this draft')
			await pick(page.getByRole('button', { name: '/ Commands' }).filter({ visible: true }), testInfo)
			await expect(composer).toHaveValue('/\nkeep this draft')
			await composer.pressSequentially('eff')
			await composer.press('Tab')
			await expect(composer).toHaveValue('/effort \nkeep this draft')

			const choices = page.getByRole('listbox', { name: /\/effort/ })
			await expect(choices.getByRole('option')).toHaveCount(6)
			// The list's long title ends in an ellipsis inside the menu, rather than running past a
			// phone's edge and pushing the loading dots out of view.
			const title = suggest(page).locator('.console-suggest__head > span').first()
			await expect(title).toHaveCSS('text-overflow', 'ellipsis')
			const menuBox = (await suggest(page).boundingBox())!
			const titleBox = (await title.boundingBox())!
			expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(menuBox.x + menuBox.width)
			await composer.pressSequentially('hi')
			await expect(choices.getByRole('option').first()).toContainText('high')
			await pick(choices.getByRole('option').first(), testInfo)

			// The draft comes back untouched, and the reasoning pill reflects the choice.
			await expect(composer).toHaveValue('keep this draft')
			await expect(page.getByRole('button', { name: 'Reasoning effort' }).filter({ visible: true })).toContainText(
				'reasoning:high',
			)
			await expect(page.getByTestId('composer-notice')).toContainText('Reasoning effort: high')
			expect(sends).toHaveLength(0)
		} finally {
			await cleanup(prefix, seeded)
		}
	})

	test('/model lists only the models that can run here, and starts on the current one however it is spelled', async ({
		page,
	}) => {
		test.setTimeout(90_000)
		// Stored in OpenRouter's spelling, as older conversations are: the engine list has it as
		// `claude-sonnet-4-5`, and it is still the current model (#9).
		const stored = 'anthropic/claude-sonnet-4.5'
		const currentName = claudeDisplayName('claude-sonnet-4-5')
		const prefix = uniquePrefix('composer-model')
		let seeded: Seeded | null = null
		try {
			await authenticateContext(page.context())
			seeded = await seedChat(prefix, { withProject: false, model: stored })
			const sends = await recordSends(page, seeded.conversationId)
			const composer = await openChat(page, seeded.conversationId)

			// The first /model on the page: the list opens before the composer has the models.
			await composer.click()
			await composer.pressSequentially('/model ')
			const list = page.getByRole('listbox', { name: /\/model/ })
			const options = list.getByRole('option')
			if (!gatewayConfigured) {
				// The same list as the model pill: the subscription's Claude models and nothing from
				// OpenRouter's catalogue, whose other rows would fail on the first message.
				await expect(options).toHaveCount(SUBSCRIPTION_MODEL_IDS.length, { timeout: 30_000 })
				await expect(list).not.toContainText('Gateway')
				await expect(list).not.toContainText('/')
			}
			// The current model is marked and highlighted once the list arrives, so Enter keeps it.
			const highlighted = list.locator('[aria-selected="true"]')
			await expect(highlighted).toHaveCount(1, { timeout: 30_000 })
			await expect(highlighted).toContainText(currentName)
			await expect(highlighted).toContainText('current')
			await composer.press('Enter')

			await expect(page.getByTestId('composer-notice')).toContainText(`Model: ${currentName}`)
			await expect(composer).toHaveValue('')
			expect(sends).toHaveLength(0)
		} finally {
			await cleanup(prefix, seeded)
		}
	})

	test('/effort on a non-Claude model says reasoning is off instead of opening its list', async ({ page }) => {
		test.setTimeout(90_000)
		const prefix = uniquePrefix('composer-effort-gateway')
		let seeded: Seeded | null = null
		try {
			await authenticateContext(page.context())
			// A gateway model runs with thinking off (#9), so the reasoning pill is disabled.
			seeded = await seedChat(prefix, { withProject: false, model: 'moonshotai/kimi-k2' })
			const sends = await recordSends(page, seeded.conversationId)
			const composer = await openChat(page, seeded.conversationId)
			await expect(page.getByRole('button', { name: 'Reasoning effort' }).filter({ visible: true })).toBeDisabled()

			// In the palette the command is listed but switched off, with the pill's reason.
			await composer.click()
			await composer.pressSequentially('/eff')
			const effortRow = page.getByRole('listbox', { name: 'Commands' }).getByRole('option', { name: /\/effort/ })
			await expect(effortRow).toHaveAttribute('aria-disabled', 'true')
			await expect(effortRow).toContainText('Reasoning is off for gateway models')

			// Typed out in full, it says why rather than opening the levels, and nothing is sent.
			await composer.pressSequentially('ort high')
			await expect(suggest(page)).toContainText('Reasoning is off for gateway models')
			await expect(page.getByRole('listbox', { name: /\/effort/ })).toHaveCount(0)
			await composer.press('Enter')
			await expect(page.getByTestId('composer-notice')).toContainText('Reasoning is off for gateway models')
			await expect(page.getByRole('button', { name: 'Reasoning effort' }).filter({ visible: true })).toContainText(
				'reasoning:off',
			)
			expect(sends).toHaveLength(0)
		} finally {
			await cleanup(prefix, seeded)
		}
	})

	test('/research takes the question on its line, and the draft below it stays', async ({ page }, testInfo) => {
		test.setTimeout(90_000)
		const prefix = uniquePrefix('composer-research')
		let seeded: Seeded | null = null
		try {
			await authenticateContext(page.context())
			seeded = await seedChat(prefix, { withProject: false })
			const sends = await recordSends(page, seeded.conversationId)
			// Record what research was asked, and refuse it, so no run starts and the page stays.
			const asked: string[] = []
			await page.route('**/_app/remote/**', async (route) => {
				if (new URL(route.request().url()).pathname.endsWith('/startResearchCommand')) {
					// The command's arguments travel base64url-encoded in `payload`.
					const { payload } = route.request().postDataJSON() as { payload: string }
					asked.push(Buffer.from(payload, 'base64url').toString('utf8'))
					await route.fulfill({
						status: 500,
						contentType: 'application/json',
						body: JSON.stringify({ type: 'error', status: 500, error: { message: 'Research is off in this test' } }),
					})
					return
				}
				await route.fallback()
			})
			const composer = await openChat(page, seeded.conversationId)

			await composer.fill('keep this draft')
			await pick(page.getByRole('button', { name: '/ Commands' }).filter({ visible: true }), testInfo)
			await composer.pressSequentially('resea')
			await composer.press('Tab')
			await expect(composer).toHaveValue('/research \nkeep this draft')
			await composer.pressSequentially('why is the sky blue')
			await composer.press('Enter')

			await expect.poll(() => asked.length, { timeout: 15_000 }).toBe(1)
			expect(asked[0]).toContain('why is the sky blue')
			expect(asked[0]).not.toContain('keep this draft')
			await expect(composer).toHaveValue('keep this draft')
			expect(sends).toHaveLength(0)
		} finally {
			await cleanup(prefix, seeded)
		}
	})

	test('a slash that is not a command is sent as typed', async ({ page }) => {
		test.setTimeout(60_000)
		const prefix = uniquePrefix('composer-not-command')
		let seeded: Seeded | null = null
		try {
			await authenticateContext(page.context())
			seeded = await seedChat(prefix, { withProject: false })
			const sends = await recordSends(page, seeded.conversationId)
			const composer = await openChat(page, seeded.conversationId)

			await composer.click()
			await composer.pressSequentially('/usr/bin is missing')
			await expect(suggest(page)).toHaveCount(0)
			await composer.press('Enter')
			await expect.poll(() => sends.length, { timeout: 15_000 }).toBe(1)
			expect(sends[0].content).toBe('/usr/bin is missing')

			// The scripted turn ends at once; wait for the box to come back before typing again.
			await expect(composer).toBeEnabled({ timeout: 15_000 })
			await expect(composer).toHaveValue('')
			await composer.click()
			await composer.pressSequentially('/zzz')
			await expect(suggest(page)).toContainText('No matching command')
			await composer.press('Enter')
			await expect.poll(() => sends.length, { timeout: 15_000 }).toBe(2)
			expect(sends[1].content).toBe('/zzz')
		} finally {
			await cleanup(prefix, seeded)
		}
	})
})
