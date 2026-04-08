import { invoke as tauriInvoke } from '@tauri-apps/api/core'

/**
 * Detect if running in Tauri native app
 */
export function isTauri(): boolean {
	return (
		typeof window !== 'undefined' &&
		(typeof window.__TAURI_INTERNALS__ !== 'undefined' || typeof window.__TAURI__ !== 'undefined')
	)
}

/**
 * Invoke a Tauri command
 */
export async function invoke<T = unknown>(cmd: string, args?: unknown): Promise<T> {
	if (!isTauri()) {
		throw new Error('Not running in Tauri context')
	}
	return tauriInvoke<T>(cmd, args as Record<string, unknown> | undefined)
}
