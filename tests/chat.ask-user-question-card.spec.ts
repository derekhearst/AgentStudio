import { randomUUID } from 'node:crypto'
import { expect, test, type Locator } from '@playwright/test'
import { authenticateContext, cleanupPrefixedRecords, getActiveUserId, getSql, seedConversation, uniquePrefix } from './helpers'
import { openAndSend, scriptHeldRun } from './chat-stream-script'
import { readAskQuestions } from '../src/lib/engine/ask-user-question'

/**
 * #4 — the question card, rebuilt around the SDK's AskUserQuestion: a header chip, option
 * cards (label, description, recommended badge), a sandboxed HTML preview of the option in
 * focus, multi-select, and a free-text "Other" that is always there.
 *
 * Every surface a question reaches is driven here: the live card in a turn (scripted — no
 * model), the saved transcript after a reload, the modal a reloaded page opens for a question
 * still waiting, and the /review inbox. Answers are keyed by question text throughout —
 * what the SDK takes back.
 */

const LAYOUT = {
	question: 'Which layout should the dashboard use?',
	header: 'Layout',
	multiSelect: false,
	options: [
		{ label: 'Sidebar (Recommended)', description: 'Navigation down the left edge', preview: '<div id="side-preview" style="display:flex">side</div>' },
		{ label: 'Top bar', description: 'Navigation across the top', preview: '<div id="top-preview">top</div>' },
		{ label: 'No navigation', description: 'A single page' },
	],
}

const FEATURES = {
	question: 'Which features should it ship with?',
	header: 'Features',
	multiSelect: true,
	options: [
		{ label: 'Search', description: 'Full-text search' },
		{ label: 'Export', description: 'CSV export' },
		{ label: 'Share', description: 'Share links' },
	],
}

/** The questions as the chat host records and sends them. */
const PENDING = readAskQuestions({ questions: [LAYOUT, FEATURES] })

/** Guards the layout bug mobile keeps catching: a flex child collapsing to zero width. */
async function expectReadableWidth(locator: Locator) {
	const box = await locator.boundingBox()
	expect(box?.width ?? 0).toBeGreaterThan(24)
}

test.describe('the live question card', () => {
	test('chip, recommended badge, sandboxed preview, multi-select and Other — answered by question text', async ({ page }) => {
		test.setTimeout(90_000)
		const prefix = uniquePrefix('chat-auq-live')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(page.context())
		const conversation = await seedConversation(prefix, { userId: await getActiveUserId() })
		const runId = randomUUID()
		const token = `${runId}:ask:toolu_auq1`
		const { release } = await scriptHeldRun(page, conversation.id, [
			{ id: 1, event: 'context_stats', data: { runId, tokenEstimate: 10, contextWindow: 200_000 } },
			{ id: 2, event: 'ask_user', data: { id: 'toolu_auq1', name: 'AskUserQuestion', token, questions: PENDING } },
		])
		const posted: Array<{ token: string; answers: Record<string, string> }> = []
		await page.route(
			(url) => url.pathname === `/chat/${conversation.id}/ask-user`,
			(route) => {
				posted.push(route.request().postDataJSON())
				return route.fulfill({ json: { resolved: true } })
			},
		)

		try {
			await openAndSend(page, conversation.id, `${prefix} build it`)
			const card = page.getByRole('main').locator('.ask-user-card').first()
			await expect(card.getByText(LAYOUT.question)).toBeVisible({ timeout: 30_000 })

			// Header chip, and a counter because there are two questions.
			await expect(card.locator('.ask-question__chip')).toHaveText('Layout')
			await expect(card.getByText('Question 1/2')).toBeVisible()

			// "(Recommended)" is shown as a badge, not as part of the label.
			const sidebar = card.getByRole('button', { name: /^Sidebar/ })
			await expect(sidebar).toContainText('Recommended')
			await expect(card).not.toContainText('(Recommended)')
			await expectReadableWidth(sidebar.getByText('Sidebar', { exact: true }))
			await expectReadableWidth(card.getByText('Navigation down the left edge'))

			// The recommended option's preview shows first — in a frame with no permissions.
			const frame = card.locator('iframe')
			await expect(frame).toHaveAttribute('sandbox', '')
			await expect(frame).toHaveAttribute('srcdoc', /side-preview/)
			await expect(frame).toHaveAttribute('srcdoc', /Content-Security-Policy/)
			await expectReadableWidth(frame)
			// The preview's markup never reaches the page itself.
			await expect(page.locator('#side-preview')).toHaveCount(0)

			// Choosing an option shows its preview.
			await card.getByRole('button', { name: /^Top bar/ }).click()
			await expect(card.getByRole('button', { name: /^Top bar/ })).toHaveAttribute('aria-pressed', 'true')
			await expect(frame).toHaveAttribute('srcdoc', /top-preview/)

			await card.getByRole('button', { name: 'Next', exact: true }).click()

			// The multi-select question: no previews, so no frame.
			await expect(card.locator('.ask-question__chip')).toHaveText('Features')
			await expect(card.getByText('Choose any that apply')).toBeVisible()
			await expect(card.locator('iframe')).toHaveCount(0)
			const submit = card.getByRole('button', { name: 'Submit', exact: true })
			await expect(submit).toBeDisabled()
			await card.getByRole('button', { name: /^Share/ }).click()
			await card.getByRole('button', { name: /^Search/ }).click()
			await card.getByPlaceholder('Type your own answer').fill('Dark mode')
			await expect(card.getByRole('button', { name: /^Search/ })).toHaveAttribute('aria-pressed', 'true')
			await expect(card.getByRole('button', { name: /^Share/ })).toHaveAttribute('aria-pressed', 'true')
			await expect(submit).toBeEnabled()
			await submit.click()

			await expect.poll(() => posted.length).toBe(1)
			expect(posted[0]).toEqual({
				token,
				answers: { [LAYOUT.question]: 'Top bar', [FEATURES.question]: 'Search, Share, Dark mode' },
			})

			// Shown answered at once, each answer under its question.
			await expect(card.locator('.user-bubble', { hasText: 'Search, Share, Dark mode' })).toBeVisible()
			await expect(card.locator('.user-bubble', { hasText: /^Top bar$/ })).toBeVisible()
			await expect(card.getByRole('button', { name: 'Submit' })).toHaveCount(0)
		} finally {
			release()
			await page.unrouteAll({ behavior: 'ignoreErrors' })
			await cleanupPrefixedRecords(prefix)
		}
	})

	test("a single-select question answered with Other sends the text, and the call's result closes the card", async ({ page }) => {
		test.setTimeout(90_000)
		const prefix = uniquePrefix('chat-auq-other')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(page.context())
		const conversation = await seedConversation(prefix, { userId: await getActiveUserId() })
		const runId = randomUUID()
		const token = `${runId}:ask:toolu_auq2`
		const [layout] = PENDING
		const { release } = await scriptHeldRun(page, conversation.id, [
			{ id: 1, event: 'context_stats', data: { runId, tokenEstimate: 10, contextWindow: 200_000 } },
			{ id: 2, event: 'ask_user', data: { id: 'toolu_auq2', name: 'AskUserQuestion', token, questions: [layout] } },
		])
		const posted: Array<{ answers: Record<string, string> }> = []
		await page.route(
			(url) => url.pathname === `/chat/${conversation.id}/ask-user`,
			(route) => {
				posted.push(route.request().postDataJSON())
				return route.fulfill({ json: { resolved: true } })
			},
		)

		try {
			await openAndSend(page, conversation.id, `${prefix} lay it out`)
			const card = page.getByRole('main').locator('.ask-user-card').first()
			await expect(card.getByText(LAYOUT.question)).toBeVisible({ timeout: 30_000 })
			// One question: no counter.
			await expect(card.getByText(/Question \d\/\d/)).toHaveCount(0)

			const topBar = card.getByRole('button', { name: /^Top bar/ })
			const other = card.getByRole('button', { name: 'Other', exact: true })
			const submit = card.getByRole('button', { name: 'Submit', exact: true })
			await topBar.click()
			// Clicking "Other" itself chooses it: the option goes, the caret goes to the box, and
			// there is nothing to send until something is typed.
			await other.click()
			await expect(other).toHaveAttribute('aria-pressed', 'true')
			await expect(topBar).toHaveAttribute('aria-pressed', 'false')
			await expect(card.getByPlaceholder('Type your own answer')).toBeFocused()
			await expect(submit).toBeDisabled()
			await expectReadableWidth(other.getByText('Other', { exact: true }))

			// Back to the option; then typing in Other replaces it on a single-select question.
			await topBar.click()
			await expect(other).toHaveAttribute('aria-pressed', 'false')
			await card.getByPlaceholder('Type your own answer').fill('Tabs along the bottom')
			await expect(topBar).toHaveAttribute('aria-pressed', 'false')
			await expect(other).toHaveAttribute('aria-pressed', 'true')
			await submit.click()
			await expect.poll(() => posted.length).toBe(1)
			expect(posted[0].answers).toEqual({ [LAYOUT.question]: 'Tabs along the bottom' })
			await expect(card.locator('.user-bubble', { hasText: 'Tabs along the bottom' })).toBeVisible()
		} finally {
			release()
			await page.unrouteAll({ behavior: 'ignoreErrors' })
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('a keyboard user can choose an option and Tab past "Other" to Submit', async ({ page }) => {
		// Focusing "Other" used to choose it, which cleared the option on the way to Submit and
		// left the question unanswerable from the keyboard.
		test.setTimeout(90_000)
		const prefix = uniquePrefix('chat-auq-keys')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(page.context())
		const conversation = await seedConversation(prefix, { userId: await getActiveUserId() })
		const runId = randomUUID()
		const [layout] = PENDING
		const { release } = await scriptHeldRun(page, conversation.id, [
			{ id: 1, event: 'context_stats', data: { runId, tokenEstimate: 10, contextWindow: 200_000 } },
			{ id: 2, event: 'ask_user', data: { id: 'toolu_keys', name: 'AskUserQuestion', token: `${runId}:ask:toolu_keys`, questions: [layout] } },
		])
		const posted: Array<{ answers: Record<string, string> }> = []
		await page.route(
			(url) => url.pathname === `/chat/${conversation.id}/ask-user`,
			(route) => {
				posted.push(route.request().postDataJSON())
				return route.fulfill({ json: { resolved: true } })
			},
		)

		try {
			await openAndSend(page, conversation.id, `${prefix} lay it out`)
			const card = page.getByRole('main').locator('.ask-user-card').first()
			await expect(card.getByText(LAYOUT.question)).toBeVisible({ timeout: 30_000 })
			const topBar = card.getByRole('button', { name: /^Top bar/ })
			const otherBox = card.getByPlaceholder('Type your own answer')
			const submit = card.getByRole('button', { name: 'Submit', exact: true })

			await topBar.focus()
			await page.keyboard.press('Space')
			await expect(topBar).toHaveAttribute('aria-pressed', 'true')

			// Tab through the rest of the options, "Other", its box and the preview to Submit.
			let passedOtherBox = false
			for (let presses = 0; presses < 12; presses += 1) {
				if (await submit.evaluate((el) => el === document.activeElement)) break
				await page.keyboard.press('Tab')
				if (await otherBox.evaluate((el) => el === document.activeElement)) passedOtherBox = true
			}
			expect(passedOtherBox).toBe(true)
			await expect(submit).toBeFocused()
			await expect(topBar).toHaveAttribute('aria-pressed', 'true')
			await expect(card.getByRole('button', { name: 'Other', exact: true })).toHaveAttribute('aria-pressed', 'false')
			await expect(submit).toBeEnabled()

			await page.keyboard.press('Enter')
			await expect.poll(() => posted.length).toBe(1)
			expect(posted[0].answers).toEqual({ [LAYOUT.question]: 'Top bar' })
		} finally {
			release()
			await page.unrouteAll({ behavior: 'ignoreErrors' })
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('questions asked at once are each answered under their own token', async ({ page }) => {
		// The CLI runs AskUserQuestion calls concurrently, so one message can open several
		// cards. Each card answers for itself; the composer answers the newest one still open.
		test.setTimeout(90_000)
		const prefix = uniquePrefix('chat-auq-many')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(page.context())
		const conversation = await seedConversation(prefix, { userId: await getActiveUserId() })
		const runId = randomUUID()
		const [layout, features] = PENDING
		const [theme] = readAskQuestions({
			questions: [
				{
					question: 'Which theme should it start in?',
					header: 'Theme',
					multiSelect: false,
					options: [
						{ label: 'Light', description: 'Light background' },
						{ label: 'Dark', description: 'Dark background' },
					],
				},
			],
		})
		const token = (id: string) => `${runId}:ask:${id}`
		const { release } = await scriptHeldRun(page, conversation.id, [
			{ id: 1, event: 'context_stats', data: { runId, tokenEstimate: 10, contextWindow: 200_000 } },
			{ id: 2, event: 'ask_user', data: { id: 'toolu_m1', name: 'AskUserQuestion', token: token('toolu_m1'), questions: [layout] } },
			{ id: 3, event: 'ask_user', data: { id: 'toolu_m2', name: 'AskUserQuestion', token: token('toolu_m2'), questions: [features] } },
			{ id: 4, event: 'ask_user', data: { id: 'toolu_m3', name: 'AskUserQuestion', token: token('toolu_m3'), questions: [theme] } },
		])
		const posted: Array<{ token: string; answers: Record<string, string> }> = []
		await page.route(
			(url) => url.pathname === `/chat/${conversation.id}/ask-user`,
			(route) => {
				posted.push(route.request().postDataJSON())
				return route.fulfill({ json: { resolved: true } })
			},
		)

		try {
			await openAndSend(page, conversation.id, `${prefix} set it up`)
			const cards = page.getByRole('main').locator('.ask-user-card')
			await expect(cards).toHaveCount(3, { timeout: 30_000 })
			const [layoutCard, featuresCard, themeCard] = [cards.nth(0), cards.nth(1), cards.nth(2)]
			await expect(layoutCard.getByText(LAYOUT.question)).toBeVisible()

			// The oldest card answers under its own token, not the newest one's.
			await layoutCard.getByRole('button', { name: /^Top bar/ }).click()
			await layoutCard.getByRole('button', { name: 'Submit', exact: true }).click()
			await expect.poll(() => posted.length).toBe(1)
			expect(posted[0]).toEqual({ token: token('toolu_m1'), answers: { [LAYOUT.question]: 'Top bar' } })
			await expect(layoutCard.locator('.user-bubble', { hasText: /^Top bar$/ })).toBeVisible()
			// The others are still waiting.
			await expect(featuresCard.getByRole('button', { name: 'Submit', exact: true })).toBeVisible()
			await expect(themeCard.getByRole('button', { name: 'Submit', exact: true })).toBeVisible()

			// The newest card, answered on the card.
			await themeCard.getByRole('button', { name: /^Dark/ }).click()
			await themeCard.getByRole('button', { name: 'Submit', exact: true }).click()
			await expect.poll(() => posted.length).toBe(2)
			expect(posted[1]).toEqual({ token: token('toolu_m3'), answers: { [theme.question]: 'Dark' } })
			await expect(themeCard.locator('.user-bubble', { hasText: /^Dark$/ })).toBeVisible()

			// A reply in the composer goes to the one still open.
			const composer = page.getByPlaceholder('Message AgentStudio...')
			await composer.fill('Search')
			await page.getByRole('button', { name: /send message/i }).first().click()
			await expect.poll(() => posted.length).toBe(3)
			expect(posted[2]).toEqual({ token: token('toolu_m2'), answers: { Features: 'Search' } })
			await expect(featuresCard.locator('.user-bubble', { hasText: /^Search$/ })).toBeVisible()
		} finally {
			release()
			await page.unrouteAll({ behavior: 'ignoreErrors' })
			await cleanupPrefixedRecords(prefix)
		}
	})

	test("an answer that arrives only as the call's result still shows on the card", async ({ page }) => {
		test.setTimeout(90_000)
		const prefix = uniquePrefix('chat-auq-result')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(page.context())
		const conversation = await seedConversation(prefix, { userId: await getActiveUserId() })
		const runId = randomUUID()
		const [layout] = PENDING
		const { release } = await scriptHeldRun(page, conversation.id, [
			{ id: 1, event: 'context_stats', data: { runId, tokenEstimate: 10, contextWindow: 200_000 } },
			{ id: 2, event: 'ask_user', data: { id: 'toolu_auq3', name: 'AskUserQuestion', token: `${runId}:ask:toolu_auq3`, questions: [layout] } },
			// Answered from /review or another tab: the engine's result, under the same id, with
			// the answers distilled from the CLI's tool_use_result.
			{
				id: 3,
				event: 'tool_result',
				data: {
					id: 'toolu_auq3',
					name: 'AskUserQuestion',
					success: true,
					result: `User has answered your questions: "${LAYOUT.question}"="No navigation".`,
					details: { kind: 'ask_user_question', answers: { [LAYOUT.question]: 'No navigation' } },
				},
			},
		])

		try {
			await openAndSend(page, conversation.id, `${prefix} lay it out`)
			const main = page.getByRole('main')
			await expect(main.getByText(LAYOUT.question).first()).toBeVisible({ timeout: 30_000 })
			await expect(main.locator('.user-bubble', { hasText: /^No navigation$/ }).first()).toBeVisible()
			await expect(main.getByRole('button', { name: 'Submit' })).toHaveCount(0)
		} finally {
			release()
			await page.unrouteAll({ behavior: 'ignoreErrors' })
			await cleanupPrefixedRecords(prefix)
		}
	})
})

test('a saved AskUserQuestion shows its question and answer after a reload; an unanswered one says so', async ({ page }) => {
	test.setTimeout(60_000)
	const prefix = uniquePrefix('chat-auq-saved')
	await cleanupPrefixedRecords(prefix)
	await authenticateContext(page.context())
	const conversation = await seedConversation(prefix, { userId: await getActiveUserId() })
	// As the engine saves them: the model's input as arguments, the CLI's text as the result,
	// and the answers on `details`.
	const blocks = [
		{
			kind: 'tool',
			name: 'AskUserQuestion',
			arguments: { questions: [LAYOUT, FEATURES] },
			result: `User has answered your questions: "${LAYOUT.question}"="Top bar", "${FEATURES.question}"="Search, Export".`,
			success: true,
			executionMs: 0,
			details: { kind: 'ask_user_question', answers: { [LAYOUT.question]: 'Top bar', [FEATURES.question]: 'Search, Export' } },
		},
		{
			kind: 'tool',
			name: 'AskUserQuestion',
			arguments: { questions: [{ question: `${prefix} which colour?`, header: 'Colour', multiSelect: false, options: [{ label: 'Red', description: 'r' }, { label: 'Blue', description: 'b' }] }] },
			result: 'The user did not answer this question before the run stopped waiting.',
			success: false,
			executionMs: 0,
		},
		{ kind: 'text', content: `${prefix} built it` },
	]
	const sql = getSql()
	await sql`
		insert into messages (conversation_id, role, content, metadata, tool_calls, sequence)
		values (${conversation.id}, 'assistant', ${`${prefix} built it`}, ${sql.json({ blocks })}, '[]'::jsonb, 3)
	`

	try {
		await page.goto('/', { waitUntil: 'domcontentloaded' })
		await page.goto(`/chat/${conversation.id}`, { waitUntil: 'domcontentloaded' })
		const main = page.getByRole('main')
		await expect(main.getByText(`${prefix} built it`).first()).toBeVisible({ timeout: 30_000 })
		await expect(main.getByText(LAYOUT.question).first()).toBeVisible()
		await expect(main.locator('.user-bubble', { hasText: /^Top bar$/ }).first()).toBeVisible()
		await expect(main.locator('.user-bubble', { hasText: /^Search, Export$/ }).first()).toBeVisible()
		await expect(main.getByText(`${prefix} which colour?`).first()).toBeVisible()
		await expect(main.getByText('Not answered.').first()).toBeVisible()
		// A saved question is never a live form.
		await expect(main.getByRole('button', { name: 'Submit' })).toHaveCount(0)
	} finally {
		await cleanupPrefixedRecords(prefix)
	}
})

test('a question still waiting after a reload opens in the modal and is answered by question text', async ({ page }) => {
	test.setTimeout(60_000)
	const prefix = uniquePrefix('chat-auq-resume')
	await cleanupPrefixedRecords(prefix)
	await authenticateContext(page.context())
	const sql = getSql()
	const userId = await getActiveUserId()
	const conversation = await seedConversation(prefix, { userId, userMessage: `${prefix} pick features` })
	const token = `${randomUUID()}:ask:toolu_auq4`
	const [, features] = PENDING
	const [run] = await sql<{ id: string }[]>`
		insert into chat_runs (conversation_id, user_id, state, source, label, pending_questions)
		values (
			${conversation.id}, ${userId}, 'waiting_user_input', 'chat_stream', ${`${prefix} run`},
			${sql.json([{ token, questions: [features], requestedAt: new Date().toISOString() }])}
		)
		returning id
	`

	try {
		await page.goto('/', { waitUntil: 'domcontentloaded' })
		await page.goto(`/chat/${conversation.id}`, { waitUntil: 'domcontentloaded' })
		await page.getByText(`${prefix} pick features`, { exact: true }).waitFor({ state: 'visible', timeout: 30_000 })

		await expect(page.getByText(FEATURES.question).first()).toBeVisible({ timeout: 10_000 })
		await expect(page.locator('.ask-question__chip', { hasText: 'Features' }).first()).toBeVisible()
		await page.getByRole('button', { name: /^Export/ }).first().click()
		await page.getByRole('button', { name: /^Search/ }).first().click()

		const answered = page.waitForResponse(
			(r) => r.url().includes(`/chat/${conversation.id}/ask-user`) && r.status() === 200,
			{ timeout: 15_000 },
		)
		await page.getByRole('button', { name: /^Submit$/ }).first().click()
		expect((await (await answered).json()).resolved).toBe(true)

		const [row] = await sql<{ pending_questions: Array<{ token: string; answers?: Record<string, string> }> }[]>`
			select pending_questions from chat_runs where id = ${run.id}
		`
		const entry = row.pending_questions.find((e) => e.token === token)
		// Multi-select answers in option order, keyed by the question text the SDK takes back.
		expect(entry?.answers).toEqual({ [FEATURES.question]: 'Search, Export' })
	} finally {
		await cleanupPrefixedRecords(prefix)
	}
})

test('the /review inbox shows the same card — previews sandboxed — and its answer reaches the run', async ({ page }) => {
	test.setTimeout(60_000)
	const prefix = uniquePrefix('review-auq')
	await cleanupPrefixedRecords(prefix)
	await authenticateContext(page.context())
	const sql = getSql()
	const userId = await getActiveUserId()
	const conversation = await seedConversation(prefix, { userId })
	const token = `${randomUUID()}:ask:toolu_auq5`
	const [layout] = PENDING
	const [run] = await sql<{ id: string }[]>`
		insert into chat_runs (conversation_id, user_id, state, source, label, pending_questions)
		values (
			${conversation.id}, ${userId}, 'waiting_user_input', 'chat_stream', ${`${prefix} run`},
			${sql.json([{ token, questions: [layout], requestedAt: new Date().toISOString() }])}
		)
		returning id
	`
	const { openReviewItem } = await import('../src/lib/observability/review.server')
	await openReviewItem({
		type: 'user_question',
		summary: `${prefix} Agent asked: ${LAYOUT.question}`,
		payload: { token, questions: [layout] },
		runId: run.id,
		dedupeKey: `question:${token}`,
	})

	try {
		await page.goto('/review', { waitUntil: 'domcontentloaded' })
		await page.getByText(`${prefix} Agent asked`).first().click({ timeout: 30_000 })
		const card = page.locator('.ask-user-card').first()
		await expect(card.locator('.ask-question__chip')).toHaveText('Layout')
		await expect(card.locator('iframe')).toHaveAttribute('sandbox', '')
		await expect(card.locator('iframe')).toHaveAttribute('srcdoc', /side-preview/)
		await expect(page.locator('#side-preview')).toHaveCount(0)
		await expectReadableWidth(card.getByText('Navigation across the top'))

		await card.getByRole('button', { name: /^No navigation/ }).click()
		await card.getByRole('button', { name: 'Submit', exact: true }).click()

		await expect
			.poll(async () => {
				const [row] = await sql<{ pending_questions: Array<{ token: string; answers?: Record<string, string> }> }[]>`
					select pending_questions from chat_runs where id = ${run.id}
				`
				return row.pending_questions.find((e) => e.token === token)?.answers ?? null
			})
			.toEqual({ [LAYOUT.question]: 'No navigation' })
	} finally {
		await sql`delete from review_items where summary like ${`${prefix}%`}`
		await cleanupPrefixedRecords(prefix)
	}
})
