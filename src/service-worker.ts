/// <reference types="@sveltejs/kit" />
/// <reference lib="webworker" />

/**
 * The service worker the app has been registering all along without ever shipping one.
 *
 * `+layout.svelte` calls `navigator.serviceWorker.register('/service-worker.js')` in
 * production, and nothing was there to serve — so every push subscription the settings
 * page created was undeliverable, and tapping a notification could not open the app.
 * The whole VAPID / subscription / feed stack was built against a missing endpoint.
 *
 * Deliberately small. Two jobs that actually matter here:
 *
 *   1. `push` — render the payload `sendPushToAll` sends.
 *   2. `notificationclick` — focus an open tab at that URL, or open one.
 *
 * Plus a conservative precache of the build output so a cold start is not blank. There
 * is no runtime caching of API responses: this app is a single-user console whose pages
 * are almost entirely live data, and serving a stale conversation or run from a cache
 * would be worse than failing honestly.
 */

import { build, files, version } from '$service-worker'

const sw = self as unknown as ServiceWorkerGlobalScope

const CACHE = `agentstudio-${version}`
/** Immutable build output plus static assets. Never API routes. */
const PRECACHE = [...build, ...files]

sw.addEventListener('install', (event) => {
	event.waitUntil(
		caches
			.open(CACHE)
			.then((cache) => cache.addAll(PRECACHE))
			.then(() => sw.skipWaiting()),
	)
})

sw.addEventListener('activate', (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
			.then(() => sw.clients.claim()),
	)
})

sw.addEventListener('fetch', (event) => {
	const request = event.request
	if (request.method !== 'GET') return

	const url = new URL(request.url)
	if (url.origin !== location.origin) return
	// Navigation and API requests always go to the network: this console shows live state.
	if (request.mode === 'navigate') return
	if (url.pathname.startsWith('/api/')) return

	const isPrecached = PRECACHE.includes(url.pathname)
	if (!isPrecached) return

	event.respondWith(
		caches.open(CACHE).then(async (cache) => {
			const cached = await cache.match(url.pathname)
			if (cached) return cached
			const response = await fetch(request)
			if (response.ok) cache.put(url.pathname, response.clone())
			return response
		}),
	)
})

type PushPayload = {
	title?: string
	body?: string
	url?: string
	tag?: string
}

sw.addEventListener('push', (event) => {
	let payload: PushPayload = {}
	try {
		payload = (event.data?.json() ?? {}) as PushPayload
	} catch {
		// A push with a non-JSON body is still worth surfacing rather than dropping.
		payload = { body: event.data?.text() }
	}

	const title = payload.title?.trim() || 'AgentStudio'
	event.waitUntil(
		sw.registration.showNotification(title, {
			body: payload.body ?? '',
			tag: payload.tag,
			// The click handler needs to know where to go, and `data` is the only channel
			// that survives the notification being shown and clicked later.
			data: { url: payload.url ?? '/' },
			icon: '/icon.svg',
			badge: '/icon.svg',
		}),
	)
})

sw.addEventListener('notificationclick', (event) => {
	event.notification.close()

	const target = new URL(
		(event.notification.data as { url?: string } | undefined)?.url ?? '/',
		sw.location.origin,
	)

	event.waitUntil(
		(async () => {
			const clients = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true })
			// Prefer an open tab on the same origin — opening a second window every time a
			// notification is tapped is how you end up with twelve of them.
			for (const client of clients) {
				if (new URL(client.url).origin !== target.origin) continue
				await client.focus()
				if ('navigate' in client) await client.navigate(target.href).catch(() => null)
				return
			}
			await sw.clients.openWindow(target.href)
		})(),
	)
})
