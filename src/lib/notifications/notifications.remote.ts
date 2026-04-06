import { command, query } from '$app/server'
import { z } from 'zod'
import {
	createNotificationRecord,
	getVapidPublicKey,
	listNotifications,
	listPushSubscriptions,
	markNotificationRead,
	removePushSubscription,
	sendPushToAll,
	upsertPushSubscription,
} from '$lib/notifications/notifications.server'

const pushSubscriptionSchema = z.object({
	endpoint: z.string().url(),
	keys: z.object({
		p256dh: z.string().min(1),
		auth: z.string().min(1),
	}),
	deviceLabel: z.string().trim().max(120).optional(),
})

const endpointSchema = z.object({ endpoint: z.string().url() })

const sendNotificationSchema = z.object({
	title: z.string().trim().min(1).max(120),
	body: z.string().trim().min(1).max(500),
	url: z.string().trim().optional(),
	tag: z.string().trim().max(80).optional(),
})

const notificationIdSchema = z.object({
	notificationId: z.string().uuid(),
	read: z.boolean().optional(),
})

export const getPushPublicKey = query(async () => {
	return {
		publicKey: await getVapidPublicKey(),
	}
})

export const listSubscriptions = query(async () => {
	return listPushSubscriptions()
})

export const subscribePush = command(pushSubscriptionSchema, async (input) => {
	return upsertPushSubscription(input)
})

export const unsubscribePush = command(endpointSchema, async ({ endpoint }) => {
	return removePushSubscription(endpoint)
})

export const listNotificationFeed = query(async () => {
	return listNotifications(100)
})

export const markNotification = command(notificationIdSchema, async ({ notificationId, read }) => {
	return markNotificationRead(notificationId, read ?? true)
})

export const sendTestNotification = command(sendNotificationSchema, async (payload) => {
	const row = await createNotificationRecord(payload)
	const push = await sendPushToAll(payload)
	return { row, push }
})

