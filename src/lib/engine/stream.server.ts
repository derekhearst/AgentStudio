/**
 * Translates a Claude Agent SDK run into AgentStudio's SSE event protocol.
 *
 * This replaces the old hand-written loop in `$lib/runtime`. The wire contract
 * is unchanged, so the existing chat page and `sse-consumer` keep working:
 *
 *   delta         { content }
 *   reasoning     { content }
 *   tool_pending  { id, name, arguments, token? }
 *   tool_call     { id, name, arguments }
 *   tool_result   { id, name, success, executionMs, result }
 *   tool_denied   { id }
 *   done          { ... }
 *
 * Every frame carries a monotonic `id:` so the resume endpoint can replay from
 * a sequence number, exactly as before.
 */

import { query, type PermissionResult, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { encodeSseFrame } from '$lib/runtime/sse-codec'
import { bareToolName } from './tools.server'
import type { Options } from '@anthropic-ai/claude-agent-sdk'

export type ApprovalDecision = { allow: true } | { allow: false; reason: string }

export type EngineRunInput = {
	prompt: string
	options: Options
	/**
	 * Decide whether a tool may run. Return a promise that settles when the user
	 * answers — the SDK holds the turn open while it's pending, which is what
	 * replaces the old pendingApprovals jsonb round-trip.
	 *
	 * Omit to auto-approve everything (the old "auto-approve mode").
	 */
	requestApproval?: (call: { id: string; name: string; input: Record<string, unknown> }) => Promise<ApprovalDecision>
	/** Called once the SDK reports its session id, so the run row can store it for resume. */
	onSessionId?: (sessionId: string) => void
	/** Called with the final assistant text so the caller can persist the message. */
	onComplete?: (summary: { text: string; sessionId: string | null }) => void
}

type Emit = (event: string, payload: unknown) => void

/**
 * Drive one run and push SSE frames into `controller`.
 */
export async function runEngineStream(
	controller: ReadableStreamDefaultController<Uint8Array>,
	input: EngineRunInput,
): Promise<void> {
	let seq = 0
	const emit: Emit = (event, payload) => {
		seq += 1
		controller.enqueue(encodeSseFrame(event, payload, seq))
	}

	let sessionId: string | null = null
	let finalText = ''
	// tool_use id → bare name, so tool_result frames can report the name the UI knows.
	const toolNames = new Map<string, string>()

	/*
	 * canUseTool is called with (name, input) but NOT the tool_use id, while the
	 * UI keys its blocks on that id. The assistant message carrying the tool_use
	 * block always arrives first, so record id by name+input there and look it up
	 * here. Without this the pending block and the call block get different ids
	 * and the UI renders the same tool twice.
	 */
	const idByCall = new Map<string, string[]>()
	const callKey = (name: string, args: unknown) => `${name}:${JSON.stringify(args ?? {})}`
	const takeToolUseId = (name: string, args: unknown): string | null => {
		const queue = idByCall.get(callKey(name, args))
		return queue && queue.length > 0 ? (queue.shift() ?? null) : null
	}

	const approvalsEnabled = Boolean(input.requestApproval)

	const options: Options = {
		...input.options,
		...(input.requestApproval
			? {
					canUseTool: async (toolName, toolInput, { signal }): Promise<PermissionResult> => {
						const name = bareToolName(toolName)
						const id = takeToolUseId(name, toolInput) ?? `pending-${name}-${seq}`

						const decision = await Promise.race([
							input.requestApproval!({ id, name, input: toolInput }),
							new Promise<ApprovalDecision>((resolve) => {
								signal.addEventListener('abort', () => resolve({ allow: false, reason: 'Run aborted' }), {
									once: true,
								})
							}),
						])

						if (!decision.allow) {
							emit('tool_denied', { id })
							return { behavior: 'deny', message: decision.reason }
						}
						// Moves the UI's pending block to "executing" using the same id.
						emit('tool_call', { id, name, arguments: JSON.stringify(toolInput) })
						return { behavior: 'allow' }
					},
				}
			: {}),
	}

	for await (const message of query({ prompt: input.prompt, options }) as AsyncIterable<SDKMessage>) {
		const msg = message as Record<string, any>

		if (typeof msg.session_id === 'string' && !sessionId) {
			sessionId = msg.session_id
			input.onSessionId?.(sessionId)
		}

		// Token-level text and thinking, from includePartialMessages.
		if (msg.type === 'stream_event') {
			const ev = msg.event as Record<string, any> | undefined
			if (ev?.type === 'content_block_delta') {
				const delta = ev.delta as Record<string, any>
				if (delta?.type === 'text_delta' && delta.text) {
					finalText += delta.text
					emit('delta', { content: delta.text })
				}
				if (delta?.type === 'thinking_delta' && delta.thinking) {
					emit('reasoning', { content: delta.thinking })
				}
			}
			continue
		}

		if (msg.type === 'assistant') {
			for (const block of msg.message?.content ?? []) {
				if (block.type !== 'tool_use') continue
				const name = bareToolName(String(block.name))
				const id = String(block.id)
				toolNames.set(id, name)

				if (approvalsEnabled) {
					// Park the id for canUseTool and show the block as awaiting approval.
					// The tool_call frame is emitted from canUseTool once approved.
					const key = callKey(name, block.input)
					idByCall.set(key, [...(idByCall.get(key) ?? []), id])
					emit('tool_pending', { id, name, arguments: JSON.stringify(block.input ?? {}) })
				} else {
					emit('tool_call', { id, name, arguments: JSON.stringify(block.input ?? {}) })
				}
			}
			continue
		}

		if (msg.type === 'user') {
			for (const block of msg.message?.content ?? []) {
				if (block.type !== 'tool_result') continue
				const id = String(block.tool_use_id)
				const raw = block.content
				const text = Array.isArray(raw)
					? raw.map((c: { text?: string }) => c.text ?? '').join('')
					: typeof raw === 'string'
						? raw
						: JSON.stringify(raw ?? null)
				emit('tool_result', {
					id,
					name: toolNames.get(id) ?? 'unknown',
					success: block.is_error !== true,
					executionMs: null,
					result: text,
				})
			}
			continue
		}

		if (msg.type === 'result') {
			// `result` is the SDK's end-of-run marker; anything it reports as an
			// error should surface rather than looking like a clean finish.
			if (msg.is_error) {
				emit('done', { error: String(msg.result ?? 'Run failed'), sessionId })
				input.onComplete?.({ text: finalText, sessionId })
				return
			}
		}
	}

	emit('done', { sessionId })
	input.onComplete?.({ text: finalText, sessionId })
}
