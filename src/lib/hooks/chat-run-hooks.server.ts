import { emitHook } from './bus.server'
import type { HookContext, HookEvent, HookPayload } from './types'
import { logger } from '$lib/observability/logger'

/**
 * The hook bus, on the chat path.
 *
 * `emitHook` was only ever called by the old runtime loop, which now serves automations,
 * monitors and PR fixes. Every interactive chat runs on the Agent SDK engine instead
 * (`runEngineStream`), and nothing there touched the bus — so an agent's hook bindings and
 * the built-in activity hooks never fired for a chat, although the agent editor says the
 * built-ins "fire automatically". `Bash`, `Write` and `Edit` are the SDK's own tools and
 * never pass through our tool registry either, so there was no seam lower down to use.
 *
 * The seam is the chat's own frame stream. Every frame the route sends goes through one
 * `emit`, and the frames already say what happened: a `tool_call` when a call is cleared to
 * run, a `tool_result` when it finishes. So a hook fires for exactly the tool calls the
 * transcript shows, with the arguments the model sent and the result it read back:
 *
 *   before_run            the turn starts
 *   before_tool           a `tool_call` frame — the call was allowed, or approved
 *   after_tool            its `tool_result`, timed from the `tool_call`
 *   on_approval_required  a `tool_pending` frame that carries an answer token
 *   on_user_question      an `ask_user` frame
 *   after_run             the turn ends, with its cost; `success: false` when it failed
 *   on_run_failed         the turn failed, with the error
 *
 * A delegated subagent's own calls are not the parent's tool calls, and are not reported as
 * them. (Its approval card is: the operator is being asked in this run either way.)
 *
 * Everything is fire-and-forget, as on the old loop: a slow or failing hook never holds up
 * or fails the turn. `agentId` is the agent the turn ran as — the default Chat agent when
 * the conversation names none — because that is whose `config.hooks` the bus reads.
 */

type Emit = <E extends HookEvent>(event: E, payload: HookPayload<E>) => Promise<void>

export type ChatRunHooks = ReturnType<typeof createChatRunHooks>

export function createChatRunHooks(context: HookContext, emit: Emit = emitHook) {
	/** tool_use id → the call as its `tool_call` frame described it. */
	const running = new Map<string, { toolName: string; args: unknown; startedAt: number }>()
	/** Calls a subagent made, known by the `subagentId` on their approval card. */
	const subagentCalls = new Set<string>()
	let runStartedAt = Date.now()
	let finished = false

	const fire = <E extends HookEvent>(event: E, payload: HookPayload<E>) => {
		try {
			void emit(event, payload).catch((error) => warn(event, error))
		} catch (error) {
			warn(event, error)
		}
	}
	const warn = (event: HookEvent, error: unknown) =>
		logger.warn('[hooks/chat] emit failed', {
			event,
			runId: context.runId,
			error: error instanceof Error ? error.message : String(error),
		})

	return {
		/** The turn is starting. */
		runStarted() {
			runStartedAt = Date.now()
			fire('before_run', { ...context, source: 'chat_stream' })
		},

		/** Every frame the route sends. Only the ones listed above mean anything here. */
		frame(event: string, payload: unknown) {
			const frame = (payload ?? {}) as Record<string, unknown>
			const id = typeof frame.id === 'string' ? frame.id : null

			if (event === 'ask_user') {
				if (typeof frame.token !== 'string') return
				const questions = Array.isArray(frame.questions) ? frame.questions : []
				fire('on_user_question', { ...context, token: frame.token, questionCount: questions.length })
				return
			}
			if (!id) return

			if (event === 'tool_pending') {
				if (typeof frame.subagentId === 'string') subagentCalls.add(id)
				if (typeof frame.token === 'string') {
					fire('on_approval_required', {
						...context,
						toolName: String(frame.name ?? 'unknown'),
						args: parseArguments(frame.arguments),
						token: frame.token,
					})
				}
				return
			}

			if (event === 'tool_call') {
				if (subagentCalls.has(id) || running.has(id)) return
				const call = { toolName: String(frame.name ?? 'unknown'), args: parseArguments(frame.arguments), startedAt: Date.now() }
				running.set(id, call)
				fire('before_tool', { ...context, toolName: call.toolName, args: call.args })
				return
			}

			if (event === 'tool_result') {
				const call = running.get(id)
				if (!call) return
				running.delete(id)
				fire('after_tool', {
					...context,
					toolName: call.toolName,
					args: call.args,
					result: frame.result ?? null,
					success: frame.success !== false,
					durationMs: Date.now() - call.startedAt,
				})
				return
			}

			if (event === 'tool_denied') running.delete(id)
		},

		/** The turn is over. Only the first call counts. */
		runFinished(outcome: { success: boolean; costUsd: number | null; error?: string | null }) {
			if (finished) return
			finished = true
			fire('after_run', {
				...context,
				costUsd: outcome.costUsd,
				durationMs: Date.now() - runStartedAt,
				success: outcome.success,
			})
			if (!outcome.success) fire('on_run_failed', { ...context, error: outcome.error || 'The run failed.' })
		},
	}
}

/** A frame carries the arguments as the JSON string the model sent. */
function parseArguments(raw: unknown): unknown {
	if (typeof raw !== 'string') return raw ?? null
	try {
		return JSON.parse(raw)
	} catch {
		return raw
	}
}
