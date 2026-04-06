import { command, query } from '$app/server'
import { z } from 'zod'
import {
	createNotificationRecord,
	getVapidPublicKey,
	listNotifications,
	listPushSubscriptions,
	markNotificationRead,
	removePushSubscriptionForUser,
	sendPushToAll,
	upsertPushSubscription,
} from '$lib/notifications/notifications.server'
import { requireAuthenticatedRequestUser } from '$lib/auth/auth.server'

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
	const user = requireAuthenticatedRequestUser()
	return listPushSubscriptions(user.id)
})

export const subscribePush = command(pushSubscriptionSchema, async (input) => {
	const user = requireAuthenticatedRequestUser()
	return upsertPushSubscription({ ...input, userId: user.id })
})

export const unsubscribePush = command(endpointSchema, async ({ endpoint }) => {
	const user = requireAuthenticatedRequestUser()
	return removePushSubscriptionForUser(endpoint, user.id)
})

export const listNotificationFeed = query(async () => {
	const user = requireAuthenticatedRequestUser()
	return listNotifications(100, user.id)
})

export const markNotification = command(notificationIdSchema, async ({ notificationId, read }) => {
	const user = requireAuthenticatedRequestUser()
	return markNotificationRead(notificationId, read ?? true, user.id)
})

export const sendTestNotification = command(sendNotificationSchema, async (payload) => {
	const user = requireAuthenticatedRequestUser()
	const row = await createNotificationRecord(payload, user.id)
	const push = await sendPushToAll(payload, user.id)
	return { row, push }
})

