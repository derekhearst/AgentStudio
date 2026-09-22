import { expect, test } from '@playwright/test'

test('serves web manifest', async ({ request }) => {
	const response = await request.get('/manifest.json')
	expect(response.ok()).toBeTruthy()
	const manifest = await response.json()
	expect(manifest.name).toContain('AgentStudio')
	expect(manifest.display).toBe('standalone')
	expect(Array.isArray(manifest.icons)).toBeTruthy()
})

test('serves the generated service worker', async ({ request, baseURL }) => {
	const response = await request.get('/service-worker.js')
	expect(response.ok(), 'nothing was served at /service-worker.js — the app registers it').toBeTruthy()

	// In dev, SvelteKit serves a one-line ES-module stub that imports the real worker;
	// a build inlines it. Follow the stub so this asserts the same thing either way.
	let body = await response.text()
	const stub = body.match(/^import\s+'([^']+)';?\s*$/)
	if (stub) {
		const followed = await request.get(new URL(stub[1], baseURL ?? 'http://127.0.0.1:4173').href)
		expect(followed.ok(), `dev stub pointed at ${stub[1]}, which did not load`).toBeTruthy()
		body = await followed.text()
	}

	// The two handlers the push feature cannot work without: one to render an incoming
	// push, one to open the app when it is tapped.
	expect(body).toContain('push')
	expect(body).toContain('notificationclick')
})
