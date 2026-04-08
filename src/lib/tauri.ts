/**
 * Detect if running in Tauri native app
 */
export function isTauri(): boolean {
	return typeof window !== 'undefined' && window.__TAURI__ !== undefined
}

/**
 * Invoke a Tauri command
 */
export async function invoke<T = unknown>(cmd: string, args?: unknown): Promise<T> {
	if (!isTauri()) {
		throw new Error('Not running in Tauri context')
	}
	const tauri = window.__TAURI__
	if (!tauri) {
		throw new Error('Tauri bridge is unavailable')
	}
	return tauri.core.invoke(cmd, args)
}
