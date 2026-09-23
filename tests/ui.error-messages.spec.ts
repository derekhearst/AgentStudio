import { expect, test } from '@playwright/test'
import { error as httpError, isHttpError } from '@sveltejs/kit'
import { getActiveUserId } from './helpers'

/**
 * A problem the user can fix reaches the form in the user's words.
 *
 * Monitor and automation server functions reported user-fixable problems — the 50-monitor
 * cap, a missing action setting, `Invalid cron hour field "25": …` — as plain Errors. A remote
 * command answers a plain Error with SvelteKit's 500 "Internal Error", and the client gets an
 * `HttpError`, which is not an `Error`, so every page fell through to its fallback: "Unable
 * to create the monitor.", "Failed to create automation. Check values and try again." The
 * cron parser's detailed messages existed "so the UI can show something better" and never
 * reached it.
 *
 * Pinned in three places: the server throws `UserInputError`; `withUserInputErrors` turns it
 * into a 400 carrying the message and leaves other errors alone; `describeError` shows a 4xx
 * message and keeps the page's fallback for a 5xx. The UI half is in
 * crud/automations.crud.spec.ts.
 */

test.describe('user-input errors — server side', () => {
	test('withUserInputErrors answers a UserInputError with a 400 that carries its message', async () => {
		const { UserInputError, withUserInputErrors } = await import('../src/lib/server/user-input-error')
		const thrown = await withUserInputErrors(async () => {
			throw new UserInputError('monitor limit reached — cancel one first')
		}).catch((err: unknown) => err)
		expect(isHttpError(thrown, 400)).toBe(true)
		expect((thrown as { body: { message: string } }).body.message).toBe('monitor limit reached — cancel one first')

		// Anything else is not the user's to fix and stays a server error.
		const internal = new Error('connection refused')
		await expect(withUserInputErrors(async () => Promise.reject(internal))).rejects.toBe(internal)
		expect(await withUserInputErrors(async () => 42)).toBe(42)
	})

	test('an automation with an impossible schedule is refused with the parser’s own words', async () => {
		const { UserInputError } = await import('../src/lib/server/user-input-error')
		const { createAutomationRecord } = await import('../src/lib/automations/automation.server')
		const refused = await createAutomationRecord({
			userId: await getActiveUserId(),
			description: 'never saved',
			cronExpression: '0 25 * * *',
			prompt: 'never saved',
		}).catch((err: unknown) => err)
		expect(refused).toBeInstanceOf(UserInputError)
		expect((refused as Error).message).toMatch(/hour field "25"/)
	})

	test('a monitor missing its action setting is refused as the user’s to fix', async () => {
		const { UserInputError } = await import('../src/lib/server/user-input-error')
		const { createMonitor } = await import('../src/lib/monitors/monitors.server')
		const refused = await createMonitor({
			userId: await getActiveUserId(),
			name: 'never saved',
			condition: { kind: 'tool_result', tool: 'web_fetch', args: { url: 'https://example.com' }, compare: 'changed' },
			action: 'run_automation',
			actionConfig: {},
		}).catch((err: unknown) => err)
		expect(refused).toBeInstanceOf(UserInputError)
		expect((refused as Error).message).toContain('automationId')
	})
})

test.describe('user-input errors — what the page shows', () => {
	const capture = (run: () => never): unknown => {
		try {
			run()
		} catch (err) {
			return err
		}
	}

	test('a 4xx shows its message, a 5xx keeps the page’s own wording', async () => {
		const { describeError } = await import('../src/lib/ui/error-message')
		const badRequest = capture(() => httpError(400, 'Invalid cron hour field "25": value 25 is out of range 0-23'))
		expect(describeError(badRequest, 'Failed to create automation.')).toBe(
			'Invalid cron hour field "25": value 25 is out of range 0-23',
		)
		const internal = capture(() => httpError(500, 'Internal Error'))
		expect(describeError(internal, 'Failed to create automation.')).toBe('Failed to create automation.')
	})

	test('an Error raised in the page is shown as is, and anything else falls back', async () => {
		const { describeError } = await import('../src/lib/ui/error-message')
		expect(describeError(new Error('Arguments must be valid JSON'), 'fallback')).toBe('Arguments must be valid JSON')
		expect(describeError('a string', 'fallback')).toBe('fallback')
		expect(describeError(undefined, 'fallback')).toBe('fallback')
	})
})
