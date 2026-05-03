import { db } from '$lib/db.server'
import { hookInvocations } from './hooks.schema'
import type { HookEvent, HookHandler, HookPayload, RegisteredHook } from './types'

/**
 * Wave 3 #13 phase 1 — HookBus.
 *
 * Module-level registry of `[event → handler[]]` plus async fail-isolated dispatch. Each
 * handler runs with a per-call timeout (default 5s). Failures and timeouts are swallowed but
 * logged into `hook_invocations` so the admin dashboard can see what fired and what didn't —
 * the runtime never blocks on a misbehaving hook.
 *
 * Dispatch is fire-and-forget by default — the runtime returns immediately and the hooks run
 * concurrently in the background. Pass `{ await: true }` for the rare case where the runtime
 * needs to wait (e.g. if a future Phase 3 skill-based hook should gate the next round).
 */

const DEFAULT_TIMEOUT_MS = 5000

const registry = new Map<HookEvent, RegisteredHook[]>()

export function registerHook<E extends HookEvent>(
	event: E,
	name: string,
	handler: HookHandler<E>,
	opts: { timeoutMs?: number } = {},
): void {
	const list = registry.get(event) ?? []
	list.push({ event, name, handler: handler as HookHandler, timeoutMs: opts.timeoutMs })
	registry.set(event, list)
}

export function listRegisteredHooks(event: HookEvent): RegisteredHook[] {
	return registry.get(event) ?? []
}

/**
 * Used in tests to swap out the registry between cases without leaking handlers across runs.
 * Production code should never call this.
 */
export function _resetHookRegistry(): void {
	registry.clear()
}

export type EmitOptions = {
	/** When true, dispatch awaits all handlers before returning. Default false. */
	await?: boolean
}

export async function emitHook<E extends HookEvent>(
	event: E,
	payload: HookPayload<E>,
	opts: EmitOptions = {},
): Promise<void> {
	const handlers = registry.get(event) ?? []
	if (handlers.length === 0) return

	const dispatches = handlers.map((h) => dispatchOne(event, payload, h))
	if (opts.await) {
		await Promise.allSettled(dispatches)
	}
	// fire-and-forget: don't await; let them run in the background.
}

async function dispatchOne<E extends HookEvent>(
	event: E,
	payload: HookPayload<E>,
	hook: RegisteredHook,
): Promise<void> {
	const startedAt = Date.now()
	const timeoutMs = hook.timeoutMs ?? DEFAULT_TIMEOUT_MS
	let success = true
	let errorMessage: string | null = null

	try {
		await Promise.race([
			Promise.resolve(hook.handler(payload as HookPayload<E>)),
			new Promise<void>((_, reject) =>
				setTimeout(() => reject(new Error(`Hook ${hook.name} timed out after ${timeoutMs}ms`)), timeoutMs),
			),
		])
	} catch (err) {
		success = false
		errorMessage = err instanceof Error ? err.message : String(err)
	}

	const durationMs = Date.now() - startedAt

	// Best-effort log. A failure to log is itself swallowed so the runtime never blocks.
	try {
		// `runId` is required on the payload (HookContext base) but typing is event-specific.
		const runId = (payload as { runId?: string | null }).runId ?? null
		await db.insert(hookInvocations).values({
			runId,
			event,
			hookKind: 'builtin',
			hookRef: hook.name,
			success,
			durationMs,
			error: errorMessage,
		})
	} catch (logErr) {
		console.warn('[hooks/bus] failed to log invocation', {
			event,
			hookName: hook.name,
			error: logErr instanceof Error ? logErr.message : String(logErr),
		})
	}
}
