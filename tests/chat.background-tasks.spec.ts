import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { authenticateContext, cleanupPrefixedRecords, getActiveUserId, seedConversation, uniquePrefix } from './helpers'
import { openAndSend, scriptDroppedRun, SCRIPTED_TASK } from './chat-stream-script'
import { stopTaskProblem } from '../src/lib/chat/run-controls'

/**
 * #132 — background-task chips belong to the run that started them.
 *
 * The chips were only reset when a new turn started, so after a turn ended — which ends the
 * CLI session and the commands it started — a pulsing "npm run dev" chip stayed in the
 * header with a stop button for a process that was gone. That button then did nothing and
 * said nothing: `/stop-task` answers a refusal with a 200 and `stopped: false`, and the
 * page ignored the body.
 */

test('chips go when the stream ends, and a refused stop is shown', async ({ page }) => {
	test.setTimeout(90_000)
	const prefix = uniquePrefix('chat-bg-tasks')
	await cleanupPrefixedRecords(prefix)
	await authenticateContext(page.context())
	const conv = await seedConversation(prefix, { userId: await getActiveUserId() })
	const { release } = await scriptDroppedRun(page, conv.id, randomUUID())
	await page.route(
		(url) => url.pathname === `/chat/${conv.id}/stop-task`,
		(route) => route.fulfill({ json: { stopped: false, reason: 'not_reachable' } }),
	)

	try {
		await openAndSend(page, conv.id, `${prefix} start a dev server`)

		const chip = page
			.getByRole('button', { name: `Stop background task: ${SCRIPTED_TASK.description}` })
			.filter({ visible: true })
		await expect(chip).toHaveCount(1, { timeout: 30_000 })

		await chip.click()
		await expect(page.getByTestId('background-task-notice')).toContainText('not reachable')
		// A refusal for a run that is still going leaves the chip: the SDK says when a task is gone.
		await expect(chip).toHaveCount(1)

		// The run ends, and the tasks it owned end with it.
		release()
		await expect(chip).toHaveCount(0, { timeout: 30_000 })
	} finally {
		release()
		await page.unrouteAll({ behavior: 'ignoreErrors' })
		await cleanupPrefixedRecords(prefix)
	}
})

test('stopTaskProblem explains each refusal, and whether the task can still be running', () => {
	expect(stopTaskProblem(true, { stopped: true })).toBeNull()
	expect(stopTaskProblem(true, { stopped: false, reason: 'run_not_active' })?.taskGone).toBe(true)
	expect(stopTaskProblem(true, { stopped: false, reason: 'not_reachable' })?.taskGone).toBe(false)
	expect(stopTaskProblem(true, { stopped: false, reason: 'stop_failed' })?.message).toMatch(/could not be stopped/)
	expect(stopTaskProblem(false, { error: 'boom' })?.message).toMatch(/Could not stop/)
	expect(stopTaskProblem(false, null)?.taskGone).toBe(false)
})
