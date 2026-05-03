import { eq } from 'drizzle-orm'
import { db } from '$lib/db.server'
import { agents } from '$lib/agents/agents.schema'
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
	opts: { timeoutMs?: number; optInOnly?: boolean } = {},
): void {
	const list = registry.get(event) ?? []
	list.push({
		event,
		name,
		handler: handler as HookHandler,
		timeoutMs: opts.timeoutMs,
		optInOnly: opts.optInOnly ?? false,
	})
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
	const globalHandlers = registry.get(event) ?? []

	// Wave 3 #13 phase 4 — per-agent hook config dispatch. When the payload carries an `agentId`,
	// load `agents.config.hooks[event]`. Refs are skill slugs (Phase 3 skill-runner picks them up
	// once that lands) OR opt-in built-in names that are registered as `optInOnly: true` (so they
	// don't fire globally — only when an agent explicitly binds them). Refs that match a global
	// `optInOnly: false` handler are skipped here because that handler already fires for every emit
	// — binding them per-agent would dispatch twice. Unknown refs are recorded as a failed
	// invocation so the admin viewer surfaces the typo without crashing the runtime.
	const agentHandlers: RegisteredHook[] = []
	const unmatchedRefs: string[] = []
	const agentId = (payload as { agentId?: string | null }).agentId ?? null
	if (agentId) {
		try {
			const [row] = await db.select({ config: agents.config }).from(agents).where(eq(agents.id, agentId)).limit(1)
			const cfg = (row?.config ?? {}) as { hooks?: Record<string, string[]> }
			const refs = cfg.hooks?.[event] ?? []
			for (const ref of refs) {
				const match = globalHandlers.find((h) => h.name === ref)
				if (match && match.optInOnly) {
					agentHandlers.push(match)
				} else if (!match) {
					unmatchedRefs.push(ref)
				}
				// match && !optInOnly → already firing globally, skip to avoid double-dispatch.
			}
		} catch (err) {
			console.warn('[hooks/bus] failed to resolve per-agent hooks', {
				event,
				agentId,
				error: err instanceof Error ? err.message : String(err),
			})
		}
	}

	const allHandlers = [...globalHandlers, ...agentHandlers]

	// Log unmatched refs as failed invocations so the admin viewer shows the typo / missing skill.
	for (const ref of unmatchedRefs) {
		void logUnmatchedHookRef(event, ref, agentId, (payload as { runId?: string | null }).runId ?? null)
	}

	if (allHandlers.length === 0) return

	const dispatches = allHandlers.map((h) => dispatchOne(event, payload, h))
	if (opts.await) {
		await Promise.allSettled(dispatches)
	}
	// fire-and-forget: don't await; let them run in the background.
}

async function logUnmatchedHookRef(
	event: HookEvent,
	hookRef: string,
	_agentId: string | null,
	runId: string | null,
): Promise<void> {
	try {
		await db.insert(hookInvocations).values({
			runId,
			event,
			hookKind: 'builtin',
			hookRef,
			success: false,
			durationMs: 0,
			error: `unknown hook ref "${hookRef}" — not registered globally; if this is a skill slug, Phase 3 skill-runner will pick it up later`,
		})
	} catch (err) {
		console.warn('[hooks/bus] failed to log unmatched ref', {
			event,
			hookRef,
			error: err instanceof Error ? err.message : String(err),
		})
	}
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
