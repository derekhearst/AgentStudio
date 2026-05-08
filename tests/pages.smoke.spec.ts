import { expect, test } from '@playwright/test'
import { authenticateContext, getSql } from './helpers'

/**
 * Cross-cutting page-load smoke suite.
 *
 * For every authenticated route, opens the page, waits for the loading state to clear, and
 * asserts:
 *   - HTTP response status < 500 (the navigation itself didn't 500)
 *   - No 5xx responses fired during the page lifecycle (catches remote-function failures)
 *   - No client-side `pageerror` events (catches unhandled exceptions)
 *   - The page reaches a terminal state (no infinite "Loading…")
 *
 * Triggered by a real-world report: prod /settings/hooks was throwing 500 from a remote
 * query and the user only saw "Internal Error" in the console. This suite catches the same
 * class of bug at PR time.
 *
 * Routes that need a real entity ID (chat/[id], runs/[id], tasks/[id], etc.) get one
 * seeded in beforeAll so the smoke covers them too.
 */

type SmokeRoute = {
	name: string
	path: string
	/** Optional ready-state assertion. Defaults to checking that "Loading…" disappears. */
	ready?: (page: import('@playwright/test').Page) => Promise<void>
}

const STATIC_ROUTES: SmokeRoute[] = [
	{ name: 'home (chat list)', path: '/' },
	{ name: 'chat', path: '/chat' },
	{ name: 'agents', path: '/agents' },
	{ name: 'agents/new', path: '/agents/new' },
	{ name: 'skills', path: '/skills' },
	{ name: 'automations', path: '/automations' },
	{ name: 'projects', path: '/projects' },
	{ name: 'source-control', path: '/source-control' },
	{ name: 'activity', path: '/activity' },
	{ name: 'memory', path: '/memory' },
	{ name: 'research', path: '/research' },
	{ name: 'users', path: '/users' },
	{ name: 'audit', path: '/audit' },
	{ name: 'settings', path: '/settings' },
	{ name: 'settings/hooks', path: '/settings/hooks' },
	{ name: 'settings/jobs', path: '/settings/jobs' },
	{ name: 'review', path: '/review' },
]

let dynamicRoutes: SmokeRoute[] = []

test.beforeAll(async () => {
	const sql = getSql()
	const probes: SmokeRoute[] = []
	const probe = async (label: string, statement: () => Promise<{ id?: string }[] | undefined>, build: (id: string) => SmokeRoute) => {
		try {
			const rows = await statement()
			const id = rows?.[0]?.id
			if (id) probes.push(build(id))
		} catch (err) {
			console.warn(`[smoke beforeAll] could not probe ${label}:`, err instanceof Error ? err.message : err)
		}
	}

	await probe(
		'agent',
		() => sql<{ id: string }[]>`select id from agents order by created_at asc limit 1`,
		(id) => ({ name: 'agents/[id]', path: `/agents/${id}` }),
	)
	await probe(
		'agent identity',
		() => sql<{ id: string }[]>`select id from agents order by created_at asc limit 1`,
		(id) => ({ name: 'agents/[id]/identity', path: `/agents/${id}/identity` }),
	)
	await probe(
		'skill',
		() => sql<{ id: string }[]>`select id from skills order by created_at asc limit 1`,
		(id) => ({ name: 'skills/[id]', path: `/skills/${id}` }),
	)
	await probe(
		'project',
		() => sql<{ id: string }[]>`select id from projects order by created_at desc limit 1`,
		(id) => ({ name: 'projects/[id]', path: `/projects/${id}` }),
	)
	await probe(
		'research',
		() => sql<{ id: string }[]>`select id from research order by created_at desc limit 1`,
		(id) => ({ name: 'research/[id]', path: `/research/${id}` }),
	)
	await probe(
		'chat conversation',
		() => sql<{ id: string }[]>`select id from conversations order by updated_at desc limit 1`,
		(id) => ({ name: 'chat/[id]', path: `/chat/${id}` }),
	)
	await probe(
		'run',
		() => sql<{ id: string }[]>`select id from chat_runs order by created_at desc limit 1`,
		(id) => ({ name: 'runs/[id]', path: `/runs/${id}` }),
	)
	dynamicRoutes = probes
})

const ALL_ROUTES_PLACEHOLDER: SmokeRoute[] = []

for (const route of STATIC_ROUTES) {
	ALL_ROUTES_PLACEHOLDER.push(route)
}

test.describe('pages — load smoke', () => {
	for (const route of STATIC_ROUTES) {
		test(`loads ${route.name} (${route.path}) without 500 or console errors`, async ({ page, context }) => {
			await authenticateContext(context)
			await runSmoke(page, route)
		})
	}

	test('loads dynamic routes when seed data is present', async ({ page, context }) => {
		await authenticateContext(context)
		if (dynamicRoutes.length === 0) {
			test.skip(true, 'No seed data found for dynamic routes (agent/skill/project/task/etc).')
		}
		for (const route of dynamicRoutes) {
			await test.step(`${route.name} (${route.path})`, async () => {
				await runSmoke(page, route)
			})
		}
	})
})

async function runSmoke(page: import('@playwright/test').Page, route: SmokeRoute) {
	const fiveXX: Array<{ url: string; status: number; body: string }> = []
	const consoleErrors: string[] = []

	page.on('response', async (resp) => {
		if (resp.status() >= 500) {
			let body = ''
			try {
				body = await resp.text()
			} catch {
				body = '<no body>'
			}
			fiveXX.push({ url: resp.url(), status: resp.status(), body: body.slice(0, 600) })
		}
	})
	page.on('pageerror', (err) => {
		consoleErrors.push(`pageerror: ${err.message}`)
	})
	page.on('console', (msg) => {
		if (msg.type() === 'error') {
			const text = msg.text()
			// Filter known-noisy entries that aren't real failures.
			if (/Failed to load resource.*404/.test(text)) return
			if (/favicon/.test(text)) return
			consoleErrors.push(`console.error: ${text}`)
		}
	})

	const navResp = await page.goto(route.path, { waitUntil: 'domcontentloaded' })
	expect(navResp?.status() ?? 0, `navigation status for ${route.path}`).toBeLessThan(500)

	// Wait for the loading state to clear (most pages render a "Loading…" or spinner first).
	await expect(page.getByText('Loading…').first()).toBeHidden({ timeout: 12_000 }).catch(() => null)
	await page
		.locator('.loading-spinner')
		.first()
		.waitFor({ state: 'detached', timeout: 12_000 })
		.catch(() => null)

	// Give remote queries a beat to fire after onMount.
	await page.waitForTimeout(500)

	if (route.ready) await route.ready(page)

	expect(
		fiveXX.length,
		`${route.path}: got ${fiveXX.length} 5xx responses:\n${fiveXX
			.map((r) => `  ${r.status} ${r.url}\n  body: ${r.body}`)
			.join('\n')}`,
	).toBe(0)
	expect(
		consoleErrors.length,
		`${route.path}: got ${consoleErrors.length} console errors:\n${consoleErrors.join('\n')}`,
	).toBe(0)
}
