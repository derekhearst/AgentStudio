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
	return window.__TAURI__.core.invoke(cmd, args)
}
