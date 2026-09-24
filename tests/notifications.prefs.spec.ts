import { expect, test } from '@playwright/test'
import { acquireGlobalStateLock, getActiveUserId, getSql, uniquePrefix } from './helpers'

/**
 * The switches in Settings → Notifications decide what is sent.
 *
 * They were saved and never read: research completion, automation failures and failed CI
 * checks all wrote a notification and pushed it whatever the user had chosen, and nothing
 * at all sent "Needs input". Every sender now goes through `notifyUser`, which reads them.
 *
 * Settings are one shared row for the instance's single user, so each test holds the
 * `settings-state` lock and puts the switches back the way it found them.
 */

type Prefs = { taskCompleted: boolean; needsInput: boolean; agentErrors: boolean }

let release: (() => Promise<void>) | null = null
let original: Prefs | null = null

test.beforeEach(async () => {
	release = await acquireGlobalStateLock('settings-state')
	const { getOrCreateSettings } = await import('../src/lib/settings/settings.server')
	const settings = await getOrCreateSettings(await getActiveUserId())
	original = settings.notificationPrefs as Prefs
})

test.afterEach(async () => {
	if (original) {
		const sql = getSql()
		const userId = await getActiveUserId()
		await sql`update app_settings set notification_prefs = ${sql.json(original)} where user_id = ${userId}`
	}
	await release?.()
	release = null
})

async function setPrefs(prefs: Partial<Prefs>) {
	const sql = getSql()
	const userId = await getActiveUserId()
	await sql`
		update app_settings
		set notification_prefs = notification_prefs || ${sql.json(prefs)}::jsonb
		where user_id = ${userId}
	`
}

async function countNotifications(match: string) {
	const sql = getSql()
	const [{ count }] = await sql<{ count: number }[]>`
		select count(*)::int as count from notifications where title like ${`%${match}%`} or body like ${`%${match}%`}
	`
	return count
}

async function cleanupNotifications(match: string) {
	const sql = getSql()
	await sql`delete from notifications where title like ${`%${match}%`} or body like ${`%${match}%`}`
}

test.describe('notifications/prefs — notifyUser', () => {
	test('a switched-off category writes nothing, not even the in-app row', async () => {
		const prefix = uniquePrefix('notify-off')
		try {
			await setPrefs({ agentErrors: false })
			const { notifyUser } = await import('../src/lib/notifications/notify.server')
			const result = await notifyUser({
				userId: await getActiveUserId(),
				category: 'agentErrors',
				payload: { title: `${prefix} Automation run failed`, body: 'boom' },
			})
			expect(result).toEqual({ sent: false, reason: 'category_off' })
			expect(await countNotifications(prefix)).toBe(0)
		} finally {
			await cleanupNotifications(prefix)
		}
	})

	test('a switched-on category is sent, and other categories are unaffected by one being off', async () => {
		const prefix = uniquePrefix('notify-on')
		try {
			await setPrefs({ agentErrors: false, taskCompleted: true })
			const { notifyUser } = await import('../src/lib/notifications/notify.server')
			const result = await notifyUser({
				userId: await getActiveUserId(),
				category: 'taskCompleted',
				payload: { title: `${prefix} Research complete`, body: 'tides', url: '/research' },
			})
			expect(result.sent).toBe(true)
			expect(await countNotifications(prefix)).toBe(1)
		} finally {
			await cleanupNotifications(prefix)
		}
	})

	test('a notification the user set up directly is not muted by the switches', async () => {
		const prefix = uniquePrefix('notify-direct')
		try {
			await setPrefs({ taskCompleted: false, needsInput: false, agentErrors: false })
			const { notifyUser } = await import('../src/lib/notifications/notify.server')
			const result = await notifyUser({
				userId: await getActiveUserId(),
				category: null,
				payload: { title: `${prefix} Monitor: price drop`, body: 'fired' },
			})
			expect(result.sent).toBe(true)
			expect(await countNotifications(prefix)).toBe(1)
		} finally {
			await cleanupNotifications(prefix)
		}
	})
})

test.describe('notifications/prefs — needs input', () => {
	async function seedWaitingRun(prefix: string, token: string) {
		const sql = getSql()
		const userId = await getActiveUserId()
		const [conv] = await sql<{ id: string }[]>`
			insert into conversations (title, user_id, model, total_tokens, total_cost)
			values (${`${prefix} convo`}, ${userId}, 'claude-sonnet-5', 0, '0')
			returning id
		`
		const [run] = await sql<{ id: string }[]>`
			insert into chat_runs (conversation_id, user_id, state, pending_approvals)
			values (
				${conv.id}, ${userId}, 'waiting_tool_approval'::chat_run_state,
				${sql.json([{ token, toolName: 'Bash', args: {}, requestedAt: new Date().toISOString() }])}
			)
			returning id
		`
		return { conversationId: conv.id, runId: run.id }
	}

	async function cleanupRuns(prefix: string) {
		const sql = getSql()
		await sql`delete from conversations where title like ${`${prefix}%`}`
		await cleanupNotifications(prefix)
	}

	test('a run still waiting on an approval notifies its owner, linking to the chat', async () => {
		const prefix = uniquePrefix('needs-input-waiting')
		const sql = getSql()
		try {
			await setPrefs({ needsInput: true })
			const token = `${prefix}:t1`
			const { conversationId, runId } = await seedWaitingRun(prefix, token)
			const { notifyIfStillWaiting } = await import('../src/lib/runs/needs-input.server')

			const outcome = await notifyIfStillWaiting({ runId, token, kind: 'approval', summary: `${prefix} run Bash` })

			expect(outcome).toBe('notified')
			const [row] = await sql<{ title: string; url: string | null }[]>`
				select title, url from notifications where body like ${`%${prefix}%`}
			`
			expect(row.title).toBe('Approval needed')
			expect(row.url).toBe(`/chat/${conversationId}`)
		} finally {
			await cleanupRuns(prefix)
		}
	})

	test('an approval answered in the meantime sends nothing', async () => {
		const prefix = uniquePrefix('needs-input-answered')
		const sql = getSql()
		try {
			await setPrefs({ needsInput: true })
			const token = `${prefix}:t1`
			const { runId } = await seedWaitingRun(prefix, token)
			const { recordApprovalDecision } = await import('../src/lib/runs/approvals.server')
			await recordApprovalDecision(runId, token, true)
			const { notifyIfStillWaiting } = await import('../src/lib/runs/needs-input.server')

			expect(await notifyIfStillWaiting({ runId, token, kind: 'approval', summary: `${prefix} run Bash` })).toBe(
				'no_longer_waiting',
			)
			const [{ count }] = await sql<{ count: number }[]>`
				select count(*)::int as count from notifications where body like ${`%${prefix}%`}
			`
			expect(count).toBe(0)
		} finally {
			await cleanupRuns(prefix)
		}
	})

	test('"Needs input" switched off keeps a waiting run quiet', async () => {
		const prefix = uniquePrefix('needs-input-off')
		try {
			await setPrefs({ needsInput: false })
			const token = `${prefix}:t1`
			const { runId } = await seedWaitingRun(prefix, token)
			const { notifyIfStillWaiting } = await import('../src/lib/runs/needs-input.server')

			expect(await notifyIfStillWaiting({ runId, token, kind: 'approval', summary: `${prefix} run Bash` })).toBe(
				'category_off',
			)
			expect(await countNotifications(prefix)).toBe(0)
		} finally {
			await cleanupRuns(prefix)
		}
	})
})
