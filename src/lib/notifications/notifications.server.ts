import webpush from 'web-push'
import { and, desc, eq } from 'drizzle-orm'
import { env } from '$env/dynamic/private'
import { db } from '$lib/db.server'
import { notifications, pushSubscriptions } from '$lib/notifications/notifications.schema'

type SubscriptionInput = {
	endpoint: string
	keys: {
		p256dh: string
		auth: string
	}
	deviceLabel?: string
	userId?: string | null
}

type PushPayload = {
	title: string
	body: string
	url?: string
	tag?: string
}

let configured = false

function ensurePushConfigured() {
	if (configured) return
	if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
		throw new Error('VAPID keys are not configured')
	}

	webpush.setVapidDetails(
		env.ORIGIN ? `${env.ORIGIN}` : 'mailto:drokbot@localhost',
		env.VAPID_PUBLIC_KEY,
		env.VAPID_PRIVATE_KEY,
	)
	configured = true
}

export async function getVapidPublicKey() {
	if (!env.VAPID_PUBLIC_KEY) {
		throw new Error('VAPID_PUBLIC_KEY is not configured')
	}
	return env.VAPID_PUBLIC_KEY
}

export async function upsertPushSubscription(input: SubscriptionInput) {
	const [existing] = await db
		.select()
		.from(pushSubscriptions)
		.where(and(eq(pushSubscriptions.endpoint, input.endpoint)))
		.limit(1)

	if (existing) {
		const [updated] = await db
			.update(pushSubscriptions)
			.set({
				keys: input.keys,
				deviceLabel: input.deviceLabel ?? existing.deviceLabel,
				userId: input.userId ?? existing.userId,
				updatedAt: new Date(),
			})
			.where(eq(pushSubscriptions.id, existing.id))
			.returning()
		return updated
	}

	const [created] = await db
		.insert(pushSubscriptions)
		.values({
			endpoint: input.endpoint,
			keys: input.keys,
			deviceLabel: input.deviceLabel,
			userId: input.userId ?? null,
			updatedAt: new Date(),
		})
		.returning()

	return created
}

export async function removePushSubscription(endpoint: string) {
	await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint))
	return { ok: true }
}

export async function listPushSubscriptions() {
	return db.select().from(pushSubscriptions).orderBy(desc(pushSubscriptions.updatedAt)).limit(100)
}

export async function createNotificationRecord(payload: PushPayload, userId?: string | null) {
	const [created] = await db
		.insert(notifications)
		.values({
			title: payload.title,
			body: payload.body,
			url: payload.url,
			userId: userId ?? null,
		})
		.returning()
	return created
}

export async function listNotifications(limit = 100) {
	return db
		.select()
		.from(notifications)
		.orderBy(desc(notifications.createdAt))
		.limit(Math.max(1, Math.min(limit, 500)))
}

export async function markNotificationRead(notificationId: string, read = true) {
	const [updated] = await db.update(notifications).set({ read }).where(eq(notifications.id, notificationId)).returning()
	return updated
}

export async function sendPushToAll(payload: PushPayload) {
	ensurePushConfigured()
	const subscriptions = await listPushSubscriptions()
	let delivered = 0
	let failed = 0

	for (const subscription of subscriptions) {
		try {
			await webpush.sendNotification(
				{
					endpoint: subscription.endpoint,
					keys: subscription.keys,
				},
				JSON.stringify(payload),
			)
			delivered += 1
		} catch {
			failed += 1
		}
	}

	return {
		delivered,
		failed,
		total: subscriptions.length,
	}
}
