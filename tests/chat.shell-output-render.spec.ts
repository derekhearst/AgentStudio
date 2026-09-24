import { randomUUID } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { authenticateContext, cleanupPrefixedRecords, getActiveUserId, getSql, seedConversation, uniquePrefix } from './helpers'
import { openAndSend, scriptHeldRun, type Frame } from './chat-stream-script'

/**
 * #26 / #35 — the shell card on the page.
 *
 * A live background command, driven by scripted frames (no model): the card opens live,
 * shows the newest lines of what the command printed with a control to show the rest, and
 * says how it ended — "ended with turn" when the reply finished first. And a saved failed
 * command, rendered from the transcript after a reload, with its exit code.
 */

const lines = (count: number) => Array.from({ length: count }, (_, i) => `row-${String(i + 1).padStart(2, '0')}`).join('\n') + '\n'

function shellDetails(overrides: Record<string, unknown> = {}) {
	return {
		kind: 'shell',
		tool: 'Bash',
		command: 'npm run dev',
		description: 'Start the dev server',
		stdout: '',
		stderr: '',
		interrupted: false,
		backgroundTaskId: 'b1',
		timedOutAfterMs: null,
		persistedOutputPath: null,
		truncated: false,
		...overrides,
	}
}

/** The frames of a turn that backgrounded `npm run dev` and has seen 40 lines of its output. */
function backgroundFrames(runId: string, extra: Frame[] = []): Frame[] {
	const output = lines(40)
	return [
		{ id: 1, event: 'context_stats', data: { runId, tokenEstimate: 10, contextWindow: 200_000 } },
		{
			id: 2,
			event: 'tool_call',
			data: { id: 'toolu_bg1', name: 'Bash', arguments: JSON.stringify({ command: 'npm run dev', run_in_background: true }) },
		},
		{
			id: 3,
			event: 'tool_result',
			data: {
				id: 'toolu_bg1',
				name: 'Bash',
				success: true,
				executionMs: null,
				result: 'Command running in background with ID: b1.',
				details: shellDetails({ background: { status: 'running' } }),
			},
		},
		// Live-only, so no sequence id — exactly as the server sends it.
		{ event: 'shell_output', data: { id: 'toolu_bg1', taskId: 'b1', chunk: output, reset: true, truncated: false, from: 0, to: output.length } },
		...extra,
	]
}

async function openCard(page: Page) {
	const card = page.getByTestId('shell-output-card').filter({ visible: true }).first()
	await expect(card).toBeVisible({ timeout: 30_000 })
	return card
}

test.describe('a background command on the page (#35)', () => {
	test('streams live, shows its newest lines, and expands to all of them', async ({ page }) => {
		test.setTimeout(90_000)
		const prefix = uniquePrefix('chat-shell-live')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(page.context())
		const conversation = await seedConversation(prefix, { userId: await getActiveUserId() })
		const { release } = await scriptHeldRun(page, conversation.id, backgroundFrames(randomUUID()))

		try {
			await openAndSend(page, conversation.id, `${prefix} start the dev server`)
			const card = await openCard(page)

			await expect(card).toHaveAttribute('data-status', 'running')
			await expect(card.locator('.console-term__badge')).toHaveText('live')
			await expect(card.getByText('row-40')).toBeVisible()
			// The first 20 lines wait behind the toggle.
			await expect(card.getByText('row-01')).toHaveCount(0)
			await expect(card.getByText('20 earlier lines hidden.')).toBeVisible()

			await card.getByRole('button', { name: 'Show all 40 lines' }).click()
			await expect(card.getByText(/row-01/)).toBeVisible()
			await expect(card.getByRole('button', { name: 'Show last 20 lines' })).toBeVisible()
			await expect(card.getByRole('button', { name: 'Copy output' })).toBeVisible()

			// The summary row still has room for the command on a phone.
			const command = card.locator('.console-term__cmd')
			expect((await command.boundingBox())?.width ?? 0).toBeGreaterThan(40)
		} finally {
			release()
			await page.unrouteAll({ behavior: 'ignoreErrors' })
			await cleanupPrefixedRecords(prefix)
		}
	})

	test('a command the turn outlived says it was stopped when the turn ended', async ({ page }) => {
		test.setTimeout(90_000)
		const prefix = uniquePrefix('chat-shell-ended')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(page.context())
		const conversation = await seedConversation(prefix, { userId: await getActiveUserId() })
		const final = lines(3)
		const { release } = await scriptHeldRun(
			page,
			conversation.id,
			backgroundFrames(randomUUID(), [
				{
					id: 4,
					event: 'shell_task_done',
					data: { id: 'toolu_bg1', taskId: 'b1', status: 'ended_with_turn', exitCode: null, stdout: final, truncated: false },
				},
			]),
		)

		try {
			await openAndSend(page, conversation.id, `${prefix} start the dev server`)
			const card = await openCard(page)

			await expect(card).toHaveAttribute('data-status', 'ended_with_turn')
			await expect(card.locator('.console-term__badge')).toHaveText('ended with turn')
			await expect(card.getByText(/Stopped when the turn ended/)).toBeVisible()
			// The final output replaced what the live frames built up.
			await expect(card.getByText(/row-03/)).toBeVisible()
			await expect(card.getByText('row-40')).toHaveCount(0)
		} finally {
			release()
			await page.unrouteAll({ behavior: 'ignoreErrors' })
			await cleanupPrefixedRecords(prefix)
		}
	})
})

test.describe('a saved shell card (#26)', () => {
	test('a failed command opens on its last lines with its exit code', async ({ page }) => {
		test.setTimeout(60_000)
		const prefix = uniquePrefix('chat-shell-saved')
		await cleanupPrefixedRecords(prefix)
		await authenticateContext(page.context())

		try {
			const conversation = await seedConversation(prefix, { userId: await getActiveUserId() })
			const sql = getSql()
			const blocks = [
				{
					kind: 'tool',
					name: 'Bash',
					arguments: { command: 'npm test' },
					result: 'Exit code 1',
					success: false,
					executionMs: 0,
					details: shellDetails({
						command: 'npm test',
						description: null,
						backgroundTaskId: null,
						stdout: `\u001b[31m${lines(25)}\u001b[0m`,
						exitCode: 1,
					}),
				},
				{ kind: 'text', content: `${prefix} the tests failed` },
			]
			await sql`
				update messages set metadata = ${sql.json({ blocks } as never)}
				where conversation_id = ${conversation.id} and role = 'assistant'
			`

			await page.goto('/', { waitUntil: 'domcontentloaded' })
			await page.goto(`/chat/${conversation.id}`, { waitUntil: 'domcontentloaded' })
			const card = await openCard(page)

			await expect(card).toHaveAttribute('open', '')
			await expect(card.locator('.console-term__badge')).toHaveText('exit 1')
			await expect(card.getByText(/row-25/)).toBeVisible()
			await expect(card.getByText('row-01')).toHaveCount(0)
			// Colour codes do not leak into the text.
			await expect(card.locator('pre').first()).not.toContainText('[31m')
		} finally {
			await cleanupPrefixedRecords(prefix)
		}
	})
})
