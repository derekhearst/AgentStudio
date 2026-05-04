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
	// load `agents.config.hooks[event]`. Refs that match a global `optInOnly: true` handler run
	// inline alongside the globals. Refs that match a non-opt-in handler are skipped (already
	// firing globally — would double-dispatch). Unmatched refs route to the skill-hook runner
	// (Phase 3) where they're treated as skill names.
	const agentHandlers: RegisteredHook[] = []
	const skillRefs: string[] = []
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
					skillRefs.push(ref)
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

	// Wave 3 #13 phase 3 — dispatch skill-based hooks via dynamic import so the bus stays a
	// pure dispatch surface and the skill runner only loads when actually needed.
	const skillDispatches: Promise<void>[] = []
	if (skillRefs.length > 0) {
		const skillRunPromise = (async () => {
			try {
				const { runSkillHook } = await import('./skill-hook-runner.server')
				await Promise.allSettled(
					skillRefs.map((skillName) => runSkillHook({ event, skillName, payload })),
				)
			} catch (err) {
				console.warn('[hooks/bus] failed to dispatch skill hooks', {
					event,
					refs: skillRefs,
					error: err instanceof Error ? err.message : String(err),
				})
			}
		})()
		skillDispatches.push(skillRunPromise)
	}

	if (allHandlers.length === 0 && skillDispatches.length === 0) return

	const builtinDispatches = allHandlers.map((h) => dispatchOne(event, payload, h))
	const allDispatches = [...builtinDispatches, ...skillDispatches]
	if (opts.await) {
		await Promise.allSettled(allDispatches)
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
	const runId = (payload as { runId?: string | null }).runId ?? null
	try {
		// `runId` is required on the payload (HookContext base) but typing is event-specific.
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

	// Wave 5 #20 — open a review item when a hook fails (timeout / thrown). Best-effort
	// dynamic import so the hooks bus stays free of an observability dependency cycle.
	// Dedupe per (runId, hookName, event) so a hook that fails repeatedly during one run
	// doesn't spawn dozens of inbox rows — operators get one signal per failure source.
	if (!success) {
		void (async () => {
			try {
				const { openReviewItem } = await import('$lib/observability/review.server')
				const dedupeKey = `hook:${runId ?? 'global'}:${hook.name}:${event}`
				await openReviewItem({
					type: 'hook_failure',
					severity: 'warning',
					summary: `Hook ${hook.name} failed on ${event}: ${errorMessage ?? 'unknown error'}`.slice(0, 500),
					payload: { hookName: hook.name, event, error: errorMessage, durationMs },
					runId,
					dedupeKey,
				})
			} catch (err) {
				console.warn('[hooks/bus] failed to open hook_failure review item', err)
			}
		})()
	}
}
