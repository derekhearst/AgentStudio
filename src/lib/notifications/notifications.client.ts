import { isTauri } from '$lib/tauri'

/**
 * Send a notification - uses native Tauri notifications if available, otherwise uses Web Push
 */
export async function sendNotification(options: { title: string; body: string; urls?: string[] }) {
	if (isTauri()) {
		// Use Tauri native notifications
		const { sendNotification } = await import('@tauri-apps/plugin-notification')
		await sendNotification({
			title: options.title,
			body: options.body,
		})
	} else {
		// Web Push is handled by service worker (now removed)
		// Keep this as a fallback for web version in the future if needed
		console.log('Notification (web):', options.title, options.body)
	}
}

/**
 * Show a simple toast-style notification
 */
export async function showToast(message: string, duration = 3000) {
	if (isTauri()) {
		const { sendNotification } = await import('@tauri-apps/plugin-notification')
		await sendNotification({
			title: 'DrokBot',
			body: message,
		})
	} else {
		console.log('Toast:', message)
	}
}
