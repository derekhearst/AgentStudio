/// <reference lib="webworker" />
import { build, files, version } from '$service-worker'

declare const self: ServiceWorkerGlobalScope

const CACHE = `AGENTSTUDIO-${version}`
const ASSETS = [...build, ...files]

self.addEventListener('install', (event) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(CACHE)
			await cache.addAll(ASSETS)
			await self.skipWaiting()
		})(),
	)
})

self.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			const names = await caches.keys()
			await Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)))
			await self.clients.claim()
		})(),
	)
})

self.addEventListener('fetch', (event) => {
	if (event.request.method !== 'GET') return

	event.respondWith(
		(async () => {
			const cached = await caches.match(event.request)
			if (cached) return cached

			try {
				const response = await fetch(event.request)
				if (response.ok && event.request.url.startsWith(self.location.origin)) {
					const cache = await caches.open(CACHE)
					cache.put(event.request, response.clone())
				}
				return response
			} catch {
				const fallback = await caches.match('/')
				if (fallback) return fallback
				throw new Error('Network request failed and no cache fallback available')
			}
		})(),
	)
})

self.addEventListener('push', (event) => {
	const payload = (() => {
		try {
			return event.data?.json() as { title?: string; body?: string; url?: string; tag?: string }
		} catch {
			return {
				title: 'AGENTSTUDIO',
				body: event.data?.text() ?? 'New event',
			}
		}
	})()

	const title = payload.title ?? 'AGENTSTUDIO notification'
	const body = payload.body ?? 'You have a new update.'

	event.waitUntil(
		self.registration.showNotification(title, {
			body,
			icon: '/icon.svg',
			badge: '/icon.svg',
			data: {
				url: payload.url ?? '/tasks',
			},
			tag: payload.tag ?? 'AGENTSTUDIO-notification',
		}),
	)
})

self.addEventListener('notificationclick', (event) => {
	event.notification.close()
	const url = (event.notification.data?.url as string | undefined) ?? '/'
	event.waitUntil(
		(async () => {
			const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
			for (const client of clients) {
				if ('focus' in client) {
					client.navigate(url)
					return client.focus()
				}
			}
			if (self.clients.openWindow) {
				return self.clients.openWindow(url)
			}
		})(),
	)
})
