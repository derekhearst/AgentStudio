import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { authenticateContext, cleanupPrefixedRecords, getActiveUserId, seedConversation, uniquePrefix } from './helpers'
import { openAndSend, scriptBusyRun, scriptDroppedRun } from './chat-stream-script'
import { approvalAnswerProblem } from '../src/lib/chat/run-controls'

/**
 * #129 — Stop is a request; a dropped connection is not a stop.
 *
 * The stream's `cancel` used to interrupt the run whenever the connection went away, so a
 * reload, a network blip or a proxy's idle timeout cut the turn short, and the page's
 * automatic resume could only replay the truncated remains. The server no longer does that
 * (`runs.lifecycle.spec.ts` covers `stopChatRun`), so Stop has to say so itself.
 */

test('a dropped stream resumes without stopping the run; Stop asks the server to', async ({ page }) => {
	test.setTimeout(90_000)
	const prefix = uniquePrefix('chat-stop-run')
	await cleanupPrefixedRecords(prefix)
	await authenticateContext(page.context())
	const conv = await seedConversation(prefix, { userId: await getActiveUserId() })
	const runId = randomUUID()
	const { seen, release } = await scriptDroppedRun(page, conv.id, runId)

	try {
		await openAndSend(page, conv.id, `${prefix} start a dev server`)

		// The connection dropped and the page picked the run back up — no stop was sent.
		await expect.poll(() => seen.resumes, { timeout: 30_000 }).toBe(1)
		expect(seen.stops).toEqual([])

		await page.getByRole('button', { name: 'Stop generating' }).filter({ visible: true }).first().click()
		await expect.poll(() => seen.stops.length).toBe(1)
		// The run the stream named in its first frame.
		expect(seen.stops[0]).toEqual({ runId })
	} finally {
		release()
		await page.unrouteAll({ behavior: 'ignoreErrors' })
		await cleanupPrefixedRecords(prefix)
	}
})

test('a send refused because a turn is running attaches to that turn, and Stop names it', async ({ page }) => {
	// A turn now outlives the page that started it. A second one on the same SDK session would
	// run beside it, so the server refuses the send (409 with the live run's id); the page
	// follows the live turn from its first frame instead, with its Stop button.
	test.setTimeout(90_000)
	const prefix = uniquePrefix('chat-busy-run')
	await cleanupPrefixedRecords(prefix)
	await authenticateContext(page.context())
	const conv = await seedConversation(prefix, { userId: await getActiveUserId() })
	const runId = randomUUID()
	const { seen, release } = await scriptBusyRun(page, conv.id, runId)

	try {
		await openAndSend(page, conv.id, `${prefix} one more thing`)

		await expect.poll(() => seen.resumes.length, { timeout: 30_000 }).toBe(1)
		expect(seen.sends).toBe(1)
		// From the start of that run, not wherever the latest run in the conversation is.
		expect(seen.resumes[0]).toEqual({ since: '0', runId })
		await expect(page.getByText(/already running in this conversation/).first()).toBeVisible()

		await page.getByRole('button', { name: 'Stop generating' }).filter({ visible: true }).first().click()
		await expect.poll(() => seen.stops.length).toBe(1)
		expect(seen.stops[0]).toEqual({ runId })
	} finally {
		release()
		await page.unrouteAll({ behavior: 'ignoreErrors' })
		await cleanupPrefixedRecords(prefix)
	}
})

test('an Allow or Deny answer counts only when the server recorded it', () => {
	// `/tool-approve` answers an unknown token with a 200 and `resolved: false`; the card used
	// to show "approved" anyway while the call waited out its timeout as a denial.
	expect(approvalAnswerProblem(true, 200, { resolved: true })).toBeNull()
	expect(approvalAnswerProblem(true, 200, { resolved: false })).toMatch(/no longer waiting/)
	expect(approvalAnswerProblem(true, 200, null)).toMatch(/no longer waiting/)
	expect(approvalAnswerProblem(false, 500, { error: 'boom' })).toMatch(/status 500/)
})
