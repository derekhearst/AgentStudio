import { expect, test } from '@playwright/test'

test('serves web manifest', async ({ request }) => {
	const response = await request.get('/manifest.json')
	expect(response.ok()).toBeTruthy()
	const manifest = await response.json()
	expect(manifest.name).toContain('DrokBot')
	expect(manifest.display).toBe('standalone')
	expect(Array.isArray(manifest.icons)).toBeTruthy()
})

test('serves the generated service worker', async ({ request }) => {
	const response = await request.get('/service-worker.js')
	expect(response.ok()).toBeTruthy()
	const body = await response.text()
	expect(body).toContain('self')
	expect(body).toContain('notificationclick')
})
