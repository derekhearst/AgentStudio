import { expect, test, type Page } from '@playwright/test'
import {
	answerConfirmDialog,
	authenticateContext,
	cleanupExtendedPrefix,
	getActiveUserId,
	getSql,
	seedProject,
	seedSkill,
	uniquePrefix,
	waitForHydration,
} from './helpers'

/**
 * A reload leaves what the page already shows on screen.
 *
 * Once pages started reloading from the server after every change (see
 * ui.fresh-reload.spec.ts), the reload became a real network round trip. The list pages
 * still swapped their whole list for a spinner while it ran, so acting on a card far down
 * the list threw the reader back to the top and rebuilt every card. And several pages
 * showed a failed reload *instead of* their content, so one lost request blanked a page
 * that had been fine a moment before.
 *
 * Holding or failing the page's own remote request is what makes both visible: the held
 * reload is the moment a spinner would paint, and the failed one is the moment content
 * would vanish.
 */

function remotePattern(name: string) {
	// Anchored on the function name so `listAgents` does not also catch `listAgentsForPicker`.
	return new RegExp(`/_app/remote/[^/]+/${name}(\\?|$)`)
}

async function failRemote(page: Page, name: string) {
	const pattern = remotePattern(name)
	await page.route(pattern, (route) => route.abort())
	return pattern
}

/** Hold every later request to `name` until `release()`; `arrived` settles when one is waiting. */
async function holdRemote(page: Page, name: string) {
	let release!: () => void
	const released = new Promise<void>((resolve) => (release = resolve))
	let markArrived!: () => void
	const arrived = new Promise<void>((resolve) => (markArrived = resolve))
	await page.route(remotePattern(name), async (route) => {
		markArrived()
		await released
		await route.continue()
	})
	return { arrived, release }
}

async function clickRefresh(page: Page) {
	const refresh = page.getByRole('button', { name: 'Refresh', exact: true })
	// Enabled means the previous load has finished; a click before that proves nothing.
	await expect(refresh).toBeEnabled({ timeout: 15_000 })
	await refresh.click()
}

const pageSpinner = (page: Page) => page.locator('.loading-spinner.loading-lg')

test.describe('a reload keeps the list on screen', () => {
	test('/automations: toggling a card keeps it, and its open History, in place', async ({ page }) => {
		const prefix = uniquePrefix('keep-automations')
		const sql = getSql()
		const userId = await getActiveUserId()
		const description = `${prefix} keep place`
		// Disabled, on a once-a-year schedule, so enabling it below never runs anything.
		await sql`
			insert into automations (user_id, description, cron_expression, prompt, enabled)
			values (${userId}, ${description}, '0 0 1 1 *', 'noop', false)
		`
		await authenticateContext(page.context())
		try {
			await page.goto('/automations')
			await waitForHydration(page)
			const card = page.locator('article').filter({ hasText: description }).first()
			await expect(card).toBeVisible({ timeout: 15_000 })
			await card.getByRole('button', { name: 'History', exact: true }).click()
			await expect(card.getByRole('button', { name: 'Hide history' })).toBeVisible()

			const held = await holdRemote(page, 'listAutomationsQuery')
			await card.getByRole('button', { name: 'Enable', exact: true }).click()
			await held.arrived

			// The reload is in flight: the list, not a spinner, is what shows.
			await expect(card).toBeVisible()
			await expect(pageSpinner(page)).toHaveCount(0)

			held.release()
			await expect(card.getByRole('button', { name: 'Disable', exact: true })).toBeVisible()
			// Still open: the card was updated, not torn down and rebuilt.
			await expect(card.getByRole('button', { name: 'Hide history' })).toBeVisible()
		} finally {
			await sql`delete from automations where description like ${`${prefix}%`}`
		}
	})

	test('/monitors: Refresh keeps the cards on screen while it loads', async ({ page }) => {
		const prefix = uniquePrefix('keep-monitors')
		const sql = getSql()
		const userId = await getActiveUserId()
		// Paused, with its next check a day out, so the dispatcher never runs it.
		await sql`
			insert into monitors (user_id, name, status, condition_kind, condition, action, deadline_at, next_check_at)
			values (
				${userId},
				${`${prefix} watched`},
				'paused',
				'tool_result',
				${sql.json({ kind: 'tool_result', tool: 'list_projects', args: {}, compare: 'changed' })},
				'review_item',
				now() + interval '1 day',
				now() + interval '1 day'
			)
		`
		await authenticateContext(page.context())
		try {
			await page.goto('/monitors')
			await waitForHydration(page)
			await expect(page.getByText(`${prefix} watched`)).toBeVisible({ timeout: 15_000 })

			const held = await holdRemote(page, 'listMonitorsQuery')
			await clickRefresh(page)
			await held.arrived

			await expect(page.getByText(`${prefix} watched`)).toBeVisible()
			await expect(pageSpinner(page)).toHaveCount(0)
			held.release()
			await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled()
		} finally {
			await sql`delete from monitors where name like ${`${prefix}%`}`
		}
	})

	test('/projects: deleting one project keeps the others on screen while it reloads', async ({ page }) => {
		const prefix = uniquePrefix('keep-projects')
		await cleanupExtendedPrefix(prefix)
		const doomed = await seedProject(prefix, { name: `${prefix} doomed` })
		const kept = await seedProject(prefix, { name: `${prefix} kept` })
		await authenticateContext(page.context())
		try {
			await page.goto('/projects')
			await waitForHydration(page)
			const doomedCard = page.locator('div.group').filter({ hasText: doomed.name }).first()
			const keptCard = page.locator('div.group').filter({ hasText: kept.name }).first()
			await expect(keptCard).toBeVisible({ timeout: 15_000 })

			const held = await holdRemote(page, 'listProjectsQuery')
			await doomedCard.getByRole('button', { name: 'Delete project' }).click()
			await answerConfirmDialog(page, 'Delete')
			await held.arrived

			await expect(keptCard).toBeVisible()
			await expect(pageSpinner(page)).toHaveCount(0)
			held.release()
			await expect(page.locator('div.group').filter({ hasText: doomed.name })).toHaveCount(0)
			await expect(keptCard).toBeVisible()
		} finally {
			await cleanupExtendedPrefix(prefix)
		}
	})
})

test.describe('a failed reload keeps the last good data under the error', () => {
	test('/activity: a failed Refresh leaves the events on screen', async ({ page }) => {
		const prefix = uniquePrefix('keep-activity')
		const sql = getSql()
		await sql`insert into activity_events (type, summary) values ('agent_action', ${`${prefix} activity row`})`
		await authenticateContext(page.context())
		try {
			await page.goto('/activity')
			await waitForHydration(page)
			await expect(page.getByText(`${prefix} activity row`)).toBeVisible({ timeout: 15_000 })

			await failRemote(page, 'listActivity')
			await clickRefresh(page)
			await expect(page.getByRole('alert').filter({ hasText: 'Failed to fetch' })).toBeVisible()
			await expect(page.getByText(`${prefix} activity row`)).toBeVisible()
		} finally {
			await sql`delete from activity_events where summary like ${`${prefix}%`}`
		}
	})

	test('/review/trace: a failed Refresh leaves the trace on screen', async ({ page }) => {
		const prefix = uniquePrefix('keep-trace')
		const sql = getSql()
		const toolName = `e2e_kept_${prefix.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(-8)}`
		// `run_traces.run_id` has no foreign key, so a bare uuid is a valid run for the viewer.
		const [{ run_id: runId }] = await sql<{ run_id: string }[]>`
			insert into run_traces (run_id, status, tool_call_count, trace)
			values (
				gen_random_uuid(),
				'running',
				1,
				${sql.json([{ seq: 1, kind: 'tool_call', toolName, startedAt: new Date().toISOString(), durationMs: 5, success: true }])}
			)
			returning run_id
		`
		await authenticateContext(page.context())
		try {
			await page.goto(`/review/trace/${runId}`)
			await waitForHydration(page)
			await expect(page.getByText(toolName).first()).toBeVisible({ timeout: 15_000 })

			await failRemote(page, 'getRunTraceQuery')
			await clickRefresh(page)
			await expect(page.getByRole('alert').filter({ hasText: 'Failed to fetch' })).toBeVisible()
			await expect(page.getByText(toolName).first()).toBeVisible()
		} finally {
			await sql`delete from run_traces where run_id = ${runId}`
		}
	})

	test('/skills/[id]: a reload that fails after an edit leaves the skill on screen', async ({ page }) => {
		const prefix = uniquePrefix('keep-skill')
		await cleanupExtendedPrefix(prefix)
		const seed = await seedSkill(prefix)
		await authenticateContext(page.context())
		try {
			await page.goto(`/skills/${seed.id}`)
			await waitForHydration(page)
			const heading = page.getByRole('heading', { level: 2, name: seed.name })
			await expect(heading).toBeVisible({ timeout: 15_000 })

			// The toggle itself goes through; only the reload after it fails.
			await failRemote(page, 'getSkillByIdQuery')
			await page.locator('input[type="checkbox"].toggle').first().click()
			await expect(page.getByRole('alert').filter({ hasText: 'Failed to fetch' })).toBeVisible()
			await expect(heading).toBeVisible()
		} finally {
			await cleanupExtendedPrefix(prefix)
		}
	})

	test('/projects: a failed delete leaves the projects on screen', async ({ page }) => {
		const prefix = uniquePrefix('keep-projects-fail')
		await cleanupExtendedPrefix(prefix)
		const project = await seedProject(prefix)
		await authenticateContext(page.context())
		try {
			await page.goto('/projects')
			await waitForHydration(page)
			const card = page.locator('div.group').filter({ hasText: project.name }).first()
			await expect(card).toBeVisible({ timeout: 15_000 })

			await failRemote(page, 'deleteProjectCommand')
			await card.getByRole('button', { name: 'Delete project' }).click()
			await answerConfirmDialog(page, 'Delete')
			// This error used to replace the whole grid.
			await expect(page.getByRole('alert').filter({ hasText: 'Failed to fetch' })).toBeVisible()
			await expect(card).toBeVisible()
		} finally {
			await cleanupExtendedPrefix(prefix)
		}
	})
})
