import { emitActivity } from '$lib/activity/activity.server'
import { registerHook } from './bus.server'

/**
 * Wave 3 #13 phase 1/2 — built-in hooks.
 *
 * Registered once at boot. Each handler is a thin wrapper around a side-effect that used to
 * live inline at the emit point — pulling them out makes the pattern visible for future
 * skill-based hooks (Phase 3) to plug in alongside.
 *
 * Failures are fail-isolated by HookBus: a thrown error here never blocks the runtime, only
 * shows up in `hook_invocations.success = false`.
 */

const ACTIVITY_LOGGED_TOOLS = new Set(['shell', 'file_write', 'file_patch', 'file_replace', 'delete_file', 'move_file'])

let registered = false

export function registerBuiltinHooks(): void {
	if (registered) return
	registered = true

	// `after_tool`: emit an activity row for impactful filesystem / shell calls so the user-
	// facing activity feed shows what the agent did. Read-only tools (file_read, list_directory,
	// search_files, web_search, etc.) are intentionally excluded — they're noise in the feed.
	registerHook('after_tool', 'activity-impactful-tools', async (payload) => {
		if (!ACTIVITY_LOGGED_TOOLS.has(payload.toolName)) return
		const verb = payload.success ? 'ran' : 'failed running'
		await emitActivity('agent_action', `${verb} ${payload.toolName} (${payload.durationMs}ms)`, {
			entityId: payload.runId,
			entityType: 'run',
			metadata: {
				toolName: payload.toolName,
				success: payload.success,
				runId: payload.runId,
				conversationId: payload.conversationId,
			},
		})
	})

	// `after_run`: emit a single agent_action row when a run finishes successfully — gives the
	// activity feed a coarse-grained "agent X did some work" entry without per-tool noise. Skips
	// failed runs (those should be elevated to a different stream / notification path).
	registerHook('after_run', 'activity-run-completed', async (payload) => {
		if (!payload.success) return
		await emitActivity('agent_action', `Agent run completed in ${payload.durationMs}ms`, {
			entityId: payload.runId,
			entityType: 'run',
			metadata: {
				runId: payload.runId,
				conversationId: payload.conversationId,
				durationMs: payload.durationMs,
			},
		})
	})
}
