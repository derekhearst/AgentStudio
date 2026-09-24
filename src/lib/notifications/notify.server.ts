import { asc, eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { appSettings } from '$lib/settings/settings.schema'
import { logger } from '$lib/observability/logger'
import { createNotificationRecord, sendPushToAll, type PushPayload } from './notifications.server'

/**
 * The one way the server notifies a user: an in-app row plus web push, gated on the user's
 * notification settings.
 *
 * The three toggles in Settings → Notifications were saved and never read. Every place that
 * notified — research completion, automation failure, a failed CI check — wrote the row
 * and pushed regardless, so turning "Agent errors" off changed nothing. Each call site now
 * names its category here and a switched-off category is skipped, in-app row included.
 *
 * `category: null` is for a notification the user asked for directly rather than a kind
 * they can mute: a monitor whose action *is* "send a push", or a budget alert. Those have
 * their own on/off switch where they are configured.
 */

export type NotificationCategory = 'taskCompleted' | 'needsInput' | 'agentErrors'

export type NotifyResult =
	| { sent: true; notificationId: string | null; delivered: number; pushError?: string }
	| { sent: false; reason: 'category_off' }

/**
 * Whether the user wants this category. A user with no settings row yet, or a row saved
 * before a key existed, gets the default — on — exactly as the Settings page shows it.
 */
export async function isNotificationCategoryEnabled(userId: string, category: NotificationCategory): Promise<boolean> {
	const [row] = await db
		.select({ prefs: appSettings.notificationPrefs })
		.from(appSettings)
		.where(eq(appSettings.userId, userId))
		.orderBy(asc(appSettings.createdAt))
		.limit(1)
	const value = (row?.prefs as Partial<Record<NotificationCategory, unknown>> | undefined)?.[category]
	return value !== false
}

/**
 * Notify `userId`, unless they switched `category` off.
 *
 * Never throws: a notification is a side channel, and the work that triggered it has already
 * happened. A failed in-app write or push is logged and reported in the result. With no user
 * the row is written unowned (visible to the instance's owner) and nothing is pushed, which
 * is what the call sites did before this existed.
 */
export async function notifyUser(input: {
	userId: string | null | undefined
	category: NotificationCategory | null
	payload: PushPayload
}): Promise<NotifyResult> {
	const { userId, category, payload } = input
	if (userId && category) {
		try {
			if (!(await isNotificationCategoryEnabled(userId, category))) {
				return { sent: false, reason: 'category_off' }
			}
		} catch (err) {
			// Reading a preference must not be what silences a notification.
			logger.warn('[notifications] could not read notification settings; sending anyway', { err, category })
		}
	}

	let notificationId: string | null = null
	try {
		const row = await createNotificationRecord(payload, userId ?? null)
		notificationId = row?.id ?? null
	} catch (err) {
		logger.warn('[notifications] in-app notification write failed', { err, category, title: payload.title })
	}

	let delivered = 0
	let pushError: string | undefined
	if (userId) {
		try {
			delivered = (await sendPushToAll(payload, userId)).delivered
		} catch (err) {
			pushError = err instanceof Error ? err.message : String(err)
			logger.warn('[notifications] web push failed (non-fatal)', { err, category })
		}
	}
	return { sent: true, notificationId, delivered, ...(pushError ? { pushError } : {}) }
}
