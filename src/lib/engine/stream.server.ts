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
 *   tool_result   { id, name, success, executionMs, result, details? }
 *   tool_denied   { id }
 *   tool_progress { id, elapsedSeconds }
 *   notice        { kind, level, title, detail, persist }
 *   background_tasks { tasks: [{ id, type, description }] }
 *   done          { ... }
 *
 * Every frame carries a monotonic `id:` so the resume endpoint can replay from
 * a sequence number, exactly as before.
 *
 * `notice`, `background_tasks` and `tool_progress` carry what the loop used to discard —
 * see `./sdk-notices`. A client that does not know them ignores unknown frames, as it
 * always has.
 *
 * `details` is the SDK's typed tool output, distilled by
 * `./tool-result-details` for the built-ins whose result is worth rendering as something
 * other than a JSON blob — a diff, a terminal, a todo list (#16, #26, #21). It is optional
 * on purpose, so a consumer that does not know about it, or a block persisted before it
 * existed, still has the `result` string it always had.
 */

import { query, type PermissionResult, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { bareToolName } from './tools.server'
import { guardWorkspaceAccess, resolveBashPolicy, type BashPolicy } from './workspace-guard'
import { resolveToolGate, type ConversationPermissionMode, type ToolGateDecision } from './permission-mode'
import { toolResultDetails } from './tool-result-details'
import { interpretSdkMessage } from './sdk-notices'
import type { EngineQueryHandle } from './run-registry.server'
import type { StreamBlock } from '$lib/runs/runs.schema'
import type { Options } from '@anthropic-ai/claude-agent-sdk'

export type ApprovalDecision = { allow: true } | { allow: false; reason: string }

/**
 * Tools the host renders itself, so the engine must not emit tool frames for them.
 * `ask_user` blocks on `onAskUser`, which mints its own `ask_user` frame and card.
 */
const HOST_OWNED_TOOLS = new Set(['ask_user'])

export type EngineRunInput = {
	/**
	 * A plain string for a text-only turn, or an async iterable of user messages
	 * when the turn carries content blocks. The SDK only accepts non-string
	 * content (images) in streaming-input mode, which is what the iterable form
	 * selects — see `attachments.server.ts`.
	 */
	prompt: string | AsyncIterable<SDKUserMessage>
	options: Options
	/**
	 * Decide whether a tool may run. Return a promise that settles when the user
	 * answers — the SDK holds the turn open while it's pending, which is what
	 * replaces the old pendingApprovals jsonb round-trip.
	 *
	 * Omit to auto-approve everything (the old "auto-approve mode").
	 */
	requestApproval?: (call: { id: string; name: string; input: Record<string, unknown> }) => Promise<ApprovalDecision>
	/**
	 * Whether the per-tool *settings* alone require human approval — i.e. the tool is in
	 * `settings.toolConfig.approvalRequiredTools` (or the `'*'` wildcard), unioned with
	 * `MANDATORY_APPROVAL_TOOLS`.
	 *
	 * This is only one input to the decision now: `permissionMode` composes with it in
	 * `resolveToolGate`, which is what actually decides allow / ask / deny. Tools the gate
	 * would auto-allow get no `tool_pending` block — the SDK does not always call
	 * `canUseTool`, so showing everything as pending leaves blocks that never resolve.
	 */
	requiresApproval?: (toolName: string) => boolean
	/**
	 * #19 — the conversation's permission mode. Decides, together with `requiresApproval`,
	 * whether each call is allowed outright, routed through `requestApproval`, or refused.
	 * The mandatory-approval tools are routed through `requestApproval` in every mode,
	 * including `bypassPermissions`; see `./permission-mode`.
	 */
	permissionMode?: ConversationPermissionMode
	/**
	 * Absolute path of the run's workspace. Every built-in filesystem call is confined to
	 * it — see `./workspace-guard`. Omit only for runs that touch no filesystem; omitting
	 * it disables containment, so it is not a default to reach for.
	 */
	workspaceRoot?: string | null
	/**
	 * How `Bash` is contained here. Defaults to the host's capability: the OS sandbox on
	 * Linux, human approval anywhere it is unavailable, because a command string cannot
	 * be checked for containment by reading it.
	 */
	bashPolicy?: BashPolicy
	/** Called once the SDK reports its session id, so the conversation can store it for resume. */
	onSessionId?: (sessionId: string) => void
	/**
	 * Called once, synchronously, with a handle on the live SDK session.
	 *
	 * The `Query` returned by `query()` is a control channel as well as an iterable —
	 * `interrupt()` and friends are control requests written to the CLI's stdin while the
	 * turn runs. Handing it to the caller is what lets a *different* request stop this one;
	 * see `./run-registry.server`. The handle stops working once the turn ends, which is
	 * why the registry entry is released in the caller's `finally`.
	 */
	onHandle?: (handle: EngineQueryHandle) => void
	/**
	 * Writes one frame. Owned by the caller because sequence ids come from
	 * `chat_runs.nextEventSeq` via `appendRunEvent` — the same counter the resume
	 * endpoint replays against — and `delta`/`reasoning` are deliberately not
	 * persisted, so they carry no id at all.
	 */
	emit: (event: string, payload: unknown) => Promise<void>
}

export type EngineUsage = {
	inputTokens: number
	outputTokens: number
	cacheCreationTokens: number
	cacheReadTokens: number
	/**
	 * The SDK's own cost estimate. Zero (or meaningless) for subscription runs,
	 * which is why Claude runs are accounted in tokens rather than dollars.
	 *
	 * Caveat: on a resumed session the SDK reports this cumulatively across the
	 * whole transcript, so it is only safe to treat as a per-turn figure for
	 * gateway runs, where we start fresh sessions.
	 */
	costUsd: number
}

export type EngineRunSummary = {
	text: string
	sessionId: string | null
	usage: EngineUsage
	durationMs: number
	numTurns: number
	error: string | null
	/**
	 * The run's content as ordered blocks, for `chat_runs.streamBlocks` and the
	 * assistant message metadata. Assembled here because this is the only place
	 * that sees text, thinking and tool activity interleaved in order.
	 */
	blocks: StreamBlock[]
	/** Time to first token, straight from the SDK result. */
	ttftMs: number | null
	/**
	 * Thinking tokens, accumulated from the SDK's `thinking_tokens` system
	 * frames. The SDK calls these estimates, so treat them as such.
	 */
	reasoningTokens: number
}

/**
 * Drive one run, emitting frames through the caller's `emit`.
 *
 * Does NOT emit `done` — the caller owns that, because the client expects
 * `done` to carry the persisted `messageId`, which only exists after the
 * summary returned here has been written to the database.
 */
export async function runEngineStream(input: EngineRunInput): Promise<EngineRunSummary> {
	const emit = input.emit

	let sessionId: string | null = null
	let finalText = ''
	let reasoningTokens = 0

	/*
	 * Blocks are accumulated alongside the frames. Consecutive deltas of the same
	 * kind coalesce into one block so the persisted shape matches what the UI
	 * assembles client-side rather than one block per token.
	 */
	const blocks: StreamBlock[] = []
	const appendContent = (kind: 'text' | 'thinking', content: string) => {
		const last = blocks[blocks.length - 1]
		if (last && last.kind === kind) last.content += content
		else blocks.push(kind === 'text' ? { kind, content } : { kind, content })
	}
	// tool_use id → bare name, so tool_result frames can report the name the UI knows.
	const toolNames = new Map<string, string>()
	const toolInputs = new Map<string, unknown>()

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

	const permissionMode: ConversationPermissionMode = input.permissionMode ?? 'default'
	const approvalsEnabled = Boolean(input.requestApproval)

	/**
	 * One decision point, shared by the pending-block predicate below and by `canUseTool`,
	 * so the block the user sees and the answer the SDK gets can never disagree.
	 */
	const gateFor = (name: string): ToolGateDecision =>
		resolveToolGate({
			mode: permissionMode,
			toolName: name,
			settingsRequiresApproval: input.requiresApproval?.(name) ?? true,
		})

	/** True when the call will reach `canUseTool` with something other than a straight allow. */
	const needsApproval = (name: string) => gateFor(name).gate !== 'allow'
	// Tools whose `tool_call` frame has already gone out, so the approval path
	// doesn't emit a second one.
	const callEmitted = new Set<string>()

	/**
	 * Workspace containment (#15). The SDK's built-in Read/Write/Edit/Bash call the
	 * filesystem directly, so `canUseTool` is the only place left that can keep them
	 * inside the run's workspace — `cwd` is a working directory, not a jail.
	 *
	 * `workspaceRoot` being absent means the run has no workspace to be confined to
	 * (a synthesis path with no filesystem work), and the guard stands down.
	 */
	const workspaceRoot = input.workspaceRoot ?? null
	const bashPolicy: BashPolicy = input.bashPolicy ?? resolveBashPolicy({})

	// `canUseTool` is installed whenever anything could be gated. A non-default mode gates
	// on its own — plan mode refuses writes even in a run with no approval surface at all.
	// Containment forces it on regardless: without it, a default-mode run with approvals
	// disabled would install no hook at all, and the built-ins would reach the host
	// filesystem unchecked. That is the one case that must never be optimised away.
	const gatingEnabled = approvalsEnabled || permissionMode !== 'default' || workspaceRoot !== null

	const options: Options = {
		...input.options,
		...(gatingEnabled
			? {
					canUseTool: async (toolName, toolInput, { signal }): Promise<PermissionResult> => {
						const name = bareToolName(toolName)
						// The host owns ask_user end to end (see the assistant branch below): it
						// renders its own card, so no tool_call / tool_pending frame may go out.
						if (HOST_OWNED_TOOLS.has(name)) return { behavior: 'allow' }

						const id = takeToolUseId(name, toolInput) ?? `pending-${name}-${Date.now()}`

						// ── Containment first. No permission mode may waive it, including
						// bypassPermissions: a mode says how much the operator trusts the
						// agent, never whether it may leave its workspace.
						const containment = workspaceRoot
							? guardWorkspaceAccess({ toolName: name, toolInput, workspaceRoot, bashPolicy })
							: ({ verdict: 'allow' } as const)

						const gate =
							containment.verdict === 'deny'
								? ({ gate: 'deny', reason: containment.reason } as const)
								: containment.verdict === 'ask'
									? ({ gate: 'ask', reason: containment.reason } as const)
									: gateFor(name)

						/** Moves the UI's pending block to "executing" using the same id. */
						const allow = async (): Promise<PermissionResult> => {
							if (!callEmitted.has(id)) {
								callEmitted.add(id)
								await emit('tool_call', { id, name, arguments: JSON.stringify(toolInput) })
							}
							return { behavior: 'allow' }
						}
						const deny = async (message: string): Promise<PermissionResult> => {
							await emit('tool_denied', { id })
							return { behavior: 'deny', message }
						}

						if (gate.gate === 'allow') return allow()
						if (gate.gate === 'deny') return deny(gate.reason ?? 'Refused by the conversation permission mode.')

						// gate === 'ask'. Without an approval surface there is nobody to ask, so the
						// call fails closed — the same posture `push_branch` takes in a detached run.
						if (!input.requestApproval) {
							return deny(
								gate.reason ??
									`${name} requires operator approval and this run has no approval surface.`,
							)
						}

						const decision = await Promise.race([
							input.requestApproval({ id, name, input: toolInput }),
							new Promise<ApprovalDecision>((resolve) => {
								signal.addEventListener('abort', () => resolve({ allow: false, reason: 'Run aborted' }), {
									once: true,
								})
							}),
						])

						if (!decision.allow) return deny(decision.reason)
						return allow()
					},
				}
			: {}),
	}

	/*
	 * Keep the object `query()` returns, rather than casting it straight to an iterable.
	 *
	 * It is both the message stream and the session's control channel: `interrupt()`,
	 * `stopTask()` and `getContextUsage()` are control requests written to the CLI's stdin
	 * while the turn is in flight. The SDK always spawns the CLI with
	 * `--input-format stream-json` and only closes stdin once the *first result* of a
	 * string-prompt turn arrives, so these work for the whole run and stop working the
	 * moment it ends — which is exactly the window a stop button cares about.
	 *
	 * The handle deliberately exposes no way to pull messages. A second consumer calling
	 * `next()` on this iterator would steal frames from the loop below.
	 */
	const session = query({ prompt: input.prompt, options })

	input.onHandle?.({
		interrupt: async () => {
			await session.interrupt()
		},
		stopTask: async (taskId: string) => {
			await session.stopTask(taskId)
		},
		getContextUsage: async () => {
			try {
				return await session.getContextUsage()
			} catch {
				// Reading the context is never worth failing a turn over.
				return null
			}
		},
	})

	try {
		for await (const message of session as AsyncIterable<SDKMessage>) {
			const msg = message as Record<string, any>

			if (typeof msg.session_id === 'string' && !sessionId) {
				sessionId = msg.session_id
				input.onSessionId?.(sessionId)
			}

			if (msg.type === 'system' && msg.subtype === 'thinking_tokens') {
				reasoningTokens = typeof msg.estimated_tokens === 'number' ? msg.estimated_tokens : reasoningTokens
				continue
			}

			/*
			 * Everything the loop used to drop on the floor: compaction boundaries, API
			 * retries, model fallbacks, permission refusals, rate limits, background-task
			 * activity and per-call progress. `interpretSdkMessage` returns null for every
			 * message handled below, so this is safe here and keeps the branches that follow
			 * unchanged.
			 */
			const interpreted = interpretSdkMessage(msg)
			if (interpreted) {
				if (interpreted.kind === 'notice') {
					// Persisted notices become blocks so a reloaded transcript still explains
					// itself; the transient ones are live-only. See `./sdk-notices`.
					if (interpreted.notice.persist) blocks.push({ kind: 'notice', notice: interpreted.notice })
					await emit('notice', interpreted.notice)
				} else if (interpreted.kind === 'background_tasks') {
					// REPLACE semantics — the payload is the whole live set.
					await emit('background_tasks', { tasks: interpreted.tasks })
				} else {
					await emit('tool_progress', {
						id: interpreted.toolUseId,
						elapsedSeconds: interpreted.elapsedSeconds,
					})
				}
				continue
			}

			// Token-level text and thinking, from includePartialMessages.
			if (msg.type === 'stream_event') {
				const ev = msg.event as Record<string, any> | undefined
				if (ev?.type === 'content_block_delta') {
					const delta = ev.delta as Record<string, any>
					if (delta?.type === 'text_delta' && delta.text) {
						finalText += delta.text
						appendContent('text', delta.text)
						await emit('delta', { content: delta.text })
					}
					if (delta?.type === 'thinking_delta' && delta.thinking) {
						appendContent('thinking', delta.thinking)
						await emit('reasoning', { content: delta.thinking })
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
					toolInputs.set(id, block.input ?? null)

					if (name === 'ask_user') {
						// The host's onAskUser owns this one: it mints the answer token,
						// emits the `ask_user` frame and blocks until the user replies.
						// Emitting a tool_call here would render it as an ordinary
						// collapsed tool block alongside the card.
						continue
					}

					// Park the id for canUseTool unconditionally. The SDK calls canUseTool for MCP
					// tools whether or not we want to gate them, and an unparked call would mint a
					// synthetic `pending-*` id there — emitting a second tool_call frame the UI
					// renders as a duplicate, and a tool_denied the UI cannot match to a block.
					const key = callKey(name, block.input)
					idByCall.set(key, [...(idByCall.get(key) ?? []), id])

					if (needsApproval(name)) {
						// Show the block as awaiting approval; the tool_call frame is emitted from
						// canUseTool once approved (or a tool_denied if it is refused).
						await emit('tool_pending', { id, name, arguments: JSON.stringify(block.input ?? {}) })
					} else {
						callEmitted.add(id)
						await emit('tool_call', { id, name, arguments: JSON.stringify(block.input ?? {}) })
					}
				}
				continue
			}

			if (msg.type === 'user') {
				/**
				 * `tool_use_result` carries the tool's full typed Output object — the diff behind an
				 * `Edit`, the streams behind a `Bash`, the list behind a `TodoWrite` — while
				 * `message.content` carries only the text the model reads. It sits on the message
				 * rather than on the block, so it is only attributable when the message answers
				 * exactly one call; with two we would be guessing which one it describes, and a
				 * diff rendered against the wrong file is worse than no diff.
				 */
				// `content` is a MessageParam's, so it is a string as legitimately as it is an array
				// of blocks — `.filter` on the string form would throw and take the turn with it.
				const content = Array.isArray(msg.message?.content) ? msg.message.content : []
				const resultBlocks = content.filter((b: { type?: string }) => b?.type === 'tool_result')
				const structured = resultBlocks.length === 1 ? msg.tool_use_result : undefined

				for (const block of msg.message?.content ?? []) {
					if (block.type !== 'tool_result') continue
					const id = String(block.tool_use_id)
					const raw = block.content
					const text = Array.isArray(raw)
						? raw.map((c: { text?: string }) => c.text ?? '').join('')
						: typeof raw === 'string'
							? raw
							: JSON.stringify(raw ?? null)
					const toolName = toolNames.get(id) ?? 'unknown'
					const toolArguments = toolInputs.get(id) ?? null
					const details = toolResultDetails(toolName, structured, toolArguments)
					blocks.push({
						kind: 'tool',
						name: toolName,
						arguments: toolArguments,
						result: text,
						success: block.is_error !== true,
						executionMs: 0,
						...(details ? { details } : {}),
					})
					await emit('tool_result', {
						id,
						name: toolName,
						success: block.is_error !== true,
						executionMs: null,
						result: text,
						...(details ? { details } : {}),
					})
				}
				continue
			}

			if (msg.type === 'result') {
				const u = (msg.usage ?? {}) as Record<string, number>
				for (let i = blocks.length - 1; i >= 0; i--) {
					const b = blocks[i]
					if (b.kind === 'thinking') {
						b.reasoningTokens = reasoningTokens
						break
					}
				}
				return {
					text: finalText,
					sessionId,
					usage: {
						inputTokens: u.input_tokens ?? 0,
						outputTokens: u.output_tokens ?? 0,
						cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
						cacheReadTokens: u.cache_read_input_tokens ?? 0,
						costUsd: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : 0,
					},
					durationMs: typeof msg.duration_ms === 'number' ? msg.duration_ms : 0,
					numTurns: typeof msg.num_turns === 'number' ? msg.num_turns : 0,
					error: msg.is_error ? String(msg.result ?? 'Run failed') : null,
					blocks,
					ttftMs: typeof msg.ttft_ms === 'number' ? msg.ttft_ms : null,
					reasoningTokens,
				}
			}
		}

		// The iterator ended without a `result` message — treat as a completed run
		// with no usage rather than inventing numbers.
		return {
			text: finalText,
			sessionId,
			usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: 0 },
			durationMs: 0,
			numTurns: 0,
			error: null,
			blocks,
			ttftMs: null,
			reasoningTokens,
		}
	} finally {
		/*
		 * Tear the CLI down on every exit path, including the `return` from inside the loop
		 * and an interrupt that ends the turn early. Returning from a `for await` already
		 * calls the iterator's `return()`, and the SDK's cleanup is idempotent, so this is
		 * belt-and-braces against an exception path that skips it and leaves a child process
		 * holding the workspace.
		 */
		try {
			session.close()
		} catch {
			// Already gone. Nothing to do and nothing worth logging.
		}
	}
}
