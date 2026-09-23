/**
 * Translates a Claude Agent SDK run into AgentStudio's SSE event protocol.
 *
 * This replaces the old hand-written loop in `$lib/runtime`. The wire contract
 * is unchanged, so the existing chat page and `sse-consumer` keep working:
 *
 *   delta         { content }
 *   reasoning     { content }
 *   tool_pending  { id, name, arguments, token?, subagentId? }
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

import {
	query,
	type HookCallback,
	type PermissionResult,
	type SDKMessage,
	type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { bareToolName } from './tools.server'
import { resolveBashPolicy, type BashPolicy } from './workspace-guard'
import { realPathEscape } from './workspace-realpath.server'
import type { ConversationPermissionMode } from './permission-mode'
import { decideToolCall, type ToolDecisionContext } from './tool-decision'
import type { ToolScope } from './tool-scope'
import { toolResultDetails, type ToolResultDetails } from './tool-result-details'
import { interpretSdkMessage } from './sdk-notices'
import type { EngineQueryHandle } from './run-registry.server'
import type { StreamBlock } from '$lib/runs/runs.schema'
import type { Options } from '@anthropic-ai/claude-agent-sdk'

export type ApprovalDecision = { allow: true } | { allow: false; reason: string }

/**
 * The slice of the SDK's `Query` this loop actually uses.
 *
 * Exists so the message source can be substituted. Everything the engine learns about a run
 * arrives as `SDKMessage`s — the typed tool results behind `./tool-result-details`, the
 * notices behind `./sdk-notices`, and the `parent_tool_use_id` routing below — and none of
 * it could be tested while `runEngineStream` constructed its own `query()`. A spec can now
 * hand it a scripted stream and assert on the frames and blocks that come out.
 *
 * The control methods are optional because a test double has nothing to control. The real
 * `Query` implements all of them, so the production path is unchanged.
 */
export type EngineQuerySource = AsyncIterable<SDKMessage> & {
	interrupt?: () => Promise<unknown>
	stopTask?: (taskId: string) => Promise<unknown>
	getContextUsage?: () => Promise<unknown>
	close?: () => void
}

export type CreateEngineQuery = (params: {
	prompt: string | AsyncIterable<SDKUserMessage>
	options: Options
}) => EngineQuerySource

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
	 * Omit when nobody can answer: a call that needs approval is then refused rather than
	 * left waiting, and its pending card carries no token.
	 */
	requestApproval?: (call: { id: string; name: string; input: Record<string, unknown> }) => Promise<ApprovalDecision>
	/**
	 * The token an operator's Allow/Deny answer for a call must carry — the same one
	 * `requestApproval` waits on. It goes out on the call's `tool_pending` frame, which is
	 * the only way the chat's approval card learns it: the card renders its buttons only
	 * when the frame has one, so without this every approval waited out its timeout and was
	 * recorded as the user's denial.
	 */
	approvalToken?: (toolUseId: string) => string
	/**
	 * The agent's fixed tool surface (`./tool-scope`). A call outside it is refused before
	 * anything else is considered. Omit for every tool.
	 */
	toolScope?: ToolScope | null
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
	 * Called for every tool call that completes, successfully or not.
	 *
	 * Exists so the caller can write the usage ledger. The engine cannot do it itself: it
	 * has no `userId` or `agentId`, deliberately — it translates a run, it does not own who
	 * the run belongs to.
	 *
	 * Fire-and-forget. A failed ledger write must never fail a turn.
	 */
	onToolResult?: (result: {
		name: string
		success: boolean
		/** The typed result, when the tool has a shape we distil. Lets the ledger record a path or a command. */
		details?: ToolResultDetails
	}) => void
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
	 * Where the message stream comes from. Defaults to the SDK's `query()`.
	 *
	 * Only a spec passes this. See `EngineQuerySource` for why the seam exists.
	 */
	createQuery?: CreateEngineQuery
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
	 * The UI keys its blocks on the tool_use id, and the permission callbacks have to emit
	 * frames against the same id or the pending block and the call block render as two
	 * tools. The hook and current `canUseTool` both receive it; for an SDK whose
	 * `canUseTool` does not, the assistant branch records the id by name+input and the
	 * callback looks it up (`claimToolUseId`).
	 */
	/*
	 * ── Subagent routing (#5) ───────────────────────────────────────────────────────────
	 *
	 * The SDK runs a subagent inside the same message stream and marks everything it
	 * produces with `parent_tool_use_id` — the id of the `Task` call that started it. That
	 * holds for tool_use and tool_result blocks even at the default
	 * `forwardSubagentText: false`, and for `stream_event` deltas when text forwarding is on.
	 *
	 * The loop used to ignore the field entirely, so a child's tool calls landed in the
	 * parent's blocks and a child's prose streamed into the parent's answer — a delegated
	 * agent's output read as the parent's own, which is the thing #34 exists to prevent.
	 *
	 * Child activity now accumulates on its own `subagent` block and goes out on the
	 * `subagent_*` frames the chat page has always known how to render and has never been
	 * sent. Note what deliberately does NOT change: the PreToolUse hook and `canUseTool` still
	 * see every child call, so containment and the approval gate apply to a subagent exactly
	 * as to the parent. A mode says how much the operator trusts the agent; delegation is not
	 * a way around it.
	 *
	 * A child call that needs approval gets the same inline Allow/Deny card a parent call
	 * does: a `tool_pending` frame with its token, marked with `subagentId`. Nothing else
	 * could answer it — the dock and HUD that once read `chat_runs.pendingApprovals` are
	 * gone — so without the card the run sat in `waiting_tool_approval` for five minutes and
	 * the call was recorded as the user's denial. The card is resolved like any other (a
	 * `tool_call`, then a `tool_result` or `tool_denied`), so it never dangles; the child's
	 * result still goes to the child's block, and the persisted transcript keeps the call in
	 * the subagent card only.
	 */
	/** `Task` tool_use id → the agent key the parent asked for, read off the call's input. */
	const subagentNames = new Map<string, string>()
	/** `Task` tool_use id → the task the parent handed it, for the child card's header. */
	const subagentTasks = new Map<string, string>()
	/** tool_use id of a subagent's call → the `Task` call it belongs to. */
	const childParents = new Map<string, string>()
	/** `Task` tool_use id → its block, so repeated child messages append to one place. */
	const subagentBlocks = new Map<string, Extract<StreamBlock, { kind: 'subagent' }>>()

	/** Fetch or open the block for a subagent, emitting `subagent_start` the first time. */
	const subagentBlockFor = async (taskId: string) => {
		const existing = subagentBlocks.get(taskId)
		if (existing) return existing
		const agentName = subagentNames.get(taskId) ?? 'subagent'
		const task = subagentTasks.get(taskId) ?? ''
		const block: Extract<StreamBlock, { kind: 'subagent' }> = {
			kind: 'subagent',
			agentId: taskId,
			agentName,
			// SDK subagents have no child conversation row to link to.
			conversationId: null,
			task,
			content: '',
			success: true,
		}
		subagentBlocks.set(taskId, block)
		blocks.push(block)
		await emit('subagent_start', {
			agentId: taskId,
			agentName,
			conversationId: null,
			task,
		})
		return block
	}

	const idByCall = new Map<string, string[]>()
	const callKey = (name: string, args: unknown) => `${name}:${JSON.stringify(args ?? {})}`
	/**
	 * The id the UI keys this call's block on. Current SDKs hand `canUseTool` the tool_use id
	 * directly; the name+input lookup is the fallback for one that does not, and a known id is
	 * taken out of the queue so the fallback cannot hand it to a different call later.
	 */
	const claimToolUseId = (name: string, args: unknown, known?: string): string => {
		const queue = idByCall.get(callKey(name, args))
		if (known) {
			const at = queue?.indexOf(known) ?? -1
			if (queue && at >= 0) queue.splice(at, 1)
			return known
		}
		return queue?.shift() ?? `pending-${name}-${Date.now()}`
	}

	const permissionMode: ConversationPermissionMode = input.permissionMode ?? 'default'

	/**
	 * Workspace containment (#15). The SDK's built-in Read/Write/Edit/Bash call the
	 * filesystem directly, so the gate below is the only thing that can keep them inside the
	 * run's workspace — `cwd` is a working directory, not a jail.
	 *
	 * `workspaceRoot` being absent means the run has no workspace to be confined to
	 * (a synthesis path with no filesystem work), and the guard stands down.
	 */
	const workspaceRoot = input.workspaceRoot ?? null
	const bashPolicy: BashPolicy = input.bashPolicy ?? resolveBashPolicy({})

	/**
	 * One decision, shared by the PreToolUse hook, `canUseTool` and the frame the assistant
	 * branch sends, so the block the user sees and the answer the SDK gets cannot disagree.
	 * See `./tool-decision` for how scope, containment and the permission gate compose.
	 */
	const decisionContext: ToolDecisionContext = {
		mode: permissionMode,
		settingsRequiresApproval: (name) => input.requiresApproval?.(name) ?? true,
		workspaceRoot,
		bashPolicy,
		scope: input.toolScope ?? null,
		// Read off what the SDK is actually told, so it cannot drift from `settingSources`.
		projectConfigLoaded: (input.options.settingSources ?? []).includes('project'),
	}
	const decide = (name: string, args: unknown) => decideToolCall(decisionContext, name, args)
	/**
	 * `decide`, plus the one check that needs the filesystem: whether a path the lexical guard
	 * allowed really leads out of the workspace through a link. Used wherever a call is about
	 * to be let through, not for the frame the assistant branch sends.
	 */
	const decideBeforeRunning = async (name: string, args: unknown) => {
		const decision = decide(name, args)
		if (decision.gate === 'deny' || !workspaceRoot) return decision
		const escape = await realPathEscape(name, args, workspaceRoot)
		return escape
			? { gate: 'deny' as const, reason: `Path leads outside this run's workspace through a link: ${escape}` }
			: decision
	}

	// Tools whose `tool_call` frame has already gone out, so the approval path
	// doesn't emit a second one.
	const callEmitted = new Set<string>()
	/** Calls with a `tool_pending` card in the parent's transcript, child calls included. */
	const pendingShown = new Set<string>()

	/**
	 * The SDK reads the CLI's output on its own schedule: the permission callbacks for a call
	 * can start while this loop is still awaiting the frame write for the assistant message
	 * that announced it. A `tool_denied` that overtook its `tool_pending` would leave a card
	 * waiting forever, so the callbacks wait here for the announcement — briefly, since it is
	 * normally already done, and never indefinitely.
	 */
	const ANNOUNCE_WAIT_MS = 2_000
	const announcements = new Map<string, { settled: Promise<void>; resolve: () => void }>()
	const announcementFor = (id: string) => {
		let entry = announcements.get(id)
		if (!entry) {
			let resolve: () => void = () => {}
			const settled = new Promise<void>((r) => (resolve = r))
			entry = { settled, resolve }
			announcements.set(id, entry)
		}
		return entry
	}
	const awaitAnnouncement = async (id: string) => {
		let timer: ReturnType<typeof setTimeout> | undefined
		await Promise.race([
			announcementFor(id).settled,
			new Promise<void>((r) => (timer = setTimeout(r, ANNOUNCE_WAIT_MS))),
		])
		clearTimeout(timer)
	}

	/** A pending card. Carries the approval token only when someone can actually answer it. */
	const emitPending = async (id: string, name: string, args: unknown, askable: boolean) => {
		pendingShown.add(id)
		const token = askable && input.requestApproval ? input.approvalToken?.(id) : undefined
		const subagentId = childParents.get(id)
		await emit('tool_pending', {
			id,
			name,
			arguments: JSON.stringify(args ?? {}),
			...(token ? { token } : {}),
			...(subagentId ? { subagentId } : {}),
		})
	}

	/** Whether the parent's transcript has a block for this call that a frame has to resolve. */
	const hasParentBlock = (id: string) => !childParents.has(id) || pendingShown.has(id)

	const emitDenied = async (id: string) => {
		if (hasParentBlock(id)) await emit('tool_denied', { id })
	}

	/*
	 * Every call meets the decision before the SDK's own permission pipeline does.
	 *
	 * `canUseTool` alone is not enough: the SDK consults it last, after allow rules
	 * (`allowedTools`, a trusted project's `permissions.allow`) and after its own modes
	 * (`acceptEdits` auto-approves edits inside the working directory). Any of those
	 * approved a call without our gate ever hearing of it. A PreToolUse hook runs first, and
	 * the SDK treats its answer as binding: 'deny' refuses, and 'ask' goes to `canUseTool`
	 * whatever the rules and modes would have said. 'allow' is never returned — a call the
	 * gate allows is left to the normal pipeline, which may still refuse it on its own terms.
	 * The hook fires for a subagent's calls too, so delegation is no way around it.
	 */
	const preToolUse: HookCallback = async (hookInput, toolUseId) => {
		if (hookInput.hook_event_name !== 'PreToolUse') return {}
		const name = bareToolName(hookInput.tool_name)
		// The host owns ask_user end to end (see the assistant branch below).
		if (HOST_OWNED_TOOLS.has(name)) return {}

		const decision = await decideBeforeRunning(name, hookInput.tool_input)
		if (decision.gate === 'allow') return {}

		if (decision.gate === 'deny') {
			const id = hookInput.tool_use_id || toolUseId
			if (id) {
				await awaitAnnouncement(id)
				await emitDenied(id)
			}
			return {
				hookSpecificOutput: {
					hookEventName: 'PreToolUse',
					permissionDecision: 'deny',
					permissionDecisionReason: decision.reason ?? 'Refused by the conversation permission mode.',
				},
			}
		}
		return {
			hookSpecificOutput: {
				hookEventName: 'PreToolUse',
				permissionDecision: 'ask',
				...(decision.reason ? { permissionDecisionReason: decision.reason } : {}),
			},
		}
	}

	const options: Options = {
		...input.options,
		hooks: {
			...input.options.hooks,
			PreToolUse: [{ hooks: [preToolUse] }, ...(input.options.hooks?.PreToolUse ?? [])],
		},
		// Always installed. The hook above routes every 'ask' here, and a run with nobody to
		// answer still needs this to refuse rather than hang.
		canUseTool: async (toolName, toolInput, { signal, toolUseID }): Promise<PermissionResult> => {
			const name = bareToolName(toolName)
			// The host owns ask_user end to end (see the assistant branch below): it
			// renders its own card, so no tool_call / tool_pending frame may go out.
			if (HOST_OWNED_TOOLS.has(name)) return { behavior: 'allow' }

			const id = claimToolUseId(name, toolInput, toolUseID)
			if (toolUseID) await awaitAnnouncement(id)

			const gate = await decideBeforeRunning(name, toolInput)

			/** Moves the UI's pending block to "executing" using the same id. */
			const allow = async (): Promise<PermissionResult> => {
				if (!callEmitted.has(id)) {
					callEmitted.add(id)
					// A child's call was already announced as `subagent_tool_call` when its
					// tool_use block arrived; a `tool_call` here would put it in the parent's
					// transcript as well — unless it has an approval card there to resolve.
					if (hasParentBlock(id)) {
						await emit('tool_call', { id, name, arguments: JSON.stringify(toolInput) })
					}
				}
				return { behavior: 'allow' }
			}
			const deny = async (message: string): Promise<PermissionResult> => {
				await emitDenied(id)
				return { behavior: 'deny', message }
			}

			if (gate.gate === 'allow') return allow()
			if (gate.gate === 'deny') return deny(gate.reason ?? 'Refused by the conversation permission mode.')

			// gate === 'ask'. Without an approval surface there is nobody to ask, so the
			// call fails closed — the same posture `push_branch` takes in a detached run.
			if (!input.requestApproval) {
				return deny(gate.reason ?? `${name} requires operator approval and this run has no approval surface.`)
			}

			// Normally the assistant branch already showed the card. If it decided differently
			// (the SDK normalised the input in between), show one now: an approval nobody can
			// see is the failure this exists to prevent.
			if (!pendingShown.has(id)) await emitPending(id, name, toolInput, true)

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
	const createQuery: CreateEngineQuery =
		input.createQuery ?? ((params) => query(params) as EngineQuerySource)
	const session = createQuery({ prompt: input.prompt, options })

	input.onHandle?.({
		interrupt: async () => {
			await session.interrupt?.()
		},
		stopTask: async (taskId: string) => {
			await session.stopTask?.(taskId)
		},
		getContextUsage: async () => {
			try {
				return (await session.getContextUsage?.()) ?? null
			} catch {
				// Reading the context is never worth failing a turn over.
				return null
			}
		},
	})

	try {
		for await (const message of session) {
			const msg = message as Record<string, any>
			/** Non-null when this message was produced inside a subagent — see the note above. */
			const parentToolUseId =
				typeof msg.parent_tool_use_id === 'string' && msg.parent_tool_use_id.length > 0
					? msg.parent_tool_use_id
					: null

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
					if (parentToolUseId) {
						// Child text goes to the child's block. Not to `finalText`, which becomes the
						// assistant message: a subagent's prose is an observation the parent reads,
						// never the reply the user is shown.
						if (delta?.type === 'text_delta' && delta.text) {
							const child = await subagentBlockFor(parentToolUseId)
							child.content += delta.text
							await emit('subagent_delta', {
								agentId: parentToolUseId,
								conversationId: null,
								content: delta.text,
							})
						}
						// Child thinking is dropped rather than rendered: it is the child's reasoning
						// about its own task, and interleaving it with the parent's would be noise.
						continue
					}
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

					/*
					 * A `Task` call names the agent it is delegating to. Recorded here, on the
					 * PARENT's message, because the child's own messages carry only the id — this
					 * is the one place the two are seen together.
					 */
					if (!parentToolUseId) {
						const taskInput = block.input as Record<string, unknown> | null
						const subagentType = taskInput?.subagent_type
						if (typeof subagentType === 'string' && subagentType.length > 0) {
							subagentNames.set(id, subagentType)
						}
						// `description` is the short label; `prompt` is the full instruction. The card
						// wants the label.
						const taskLabel = taskInput?.description ?? taskInput?.prompt
						if (typeof taskLabel === 'string' && taskLabel.length > 0) {
							subagentTasks.set(id, taskLabel.slice(0, 200))
						}
					}

					if (parentToolUseId) {
						// A child's call. Still parked for `canUseTool`, so containment and the
						// approval gate run on it exactly as they would on the parent's — only the
						// frame it produces differs.
						childParents.set(id, parentToolUseId)
						toolInputs.set(id, block.input ?? null)
						idByCall.set(callKey(name, block.input), [
							...(idByCall.get(callKey(name, block.input)) ?? []),
							id,
						])
						await subagentBlockFor(parentToolUseId)
						await emit('subagent_tool_call', {
							agentId: parentToolUseId,
							conversationId: null,
							name,
						})
						// One that needs an answer gets a card the operator can answer — see the
						// subagent note above. One that is refused or allowed outright needs none.
						if (decide(name, block.input).gate === 'ask' && input.requestApproval) {
							await emitPending(id, name, block.input, true)
						}
						announcementFor(id).resolve()
						continue
					}
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

					const decision = decide(name, block.input)
					if (decision.gate === 'allow') {
						callEmitted.add(id)
						await emit('tool_call', { id, name, arguments: JSON.stringify(block.input ?? {}) })
					} else {
						// Show the block as awaiting approval — with the token that lets the card
						// answer it — or, for a refusal, as the block the `tool_denied` resolves.
						// The tool_call frame is emitted once approved.
						await emitPending(id, name, block.input, decision.gate === 'ask')
					}
					announcementFor(id).resolve()
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

					if (parentToolUseId) {
						// The child's result belongs to the child's block. The ledger still counts it:
						// a subagent's tool call is work this run did, and `onToolResult` records
						// calls rather than attributing them to a transcript position.
						const child = await subagentBlockFor(parentToolUseId)
						if (block.is_error === true) child.success = false
						await emit('subagent_tool_result', {
							agentId: parentToolUseId,
							conversationId: null,
							name: toolName,
							success: block.is_error !== true,
						})
						// Close the approval card this call had in the parent's transcript, if any.
						// Not a block: the persisted transcript keeps the call in the child's card.
						if (pendingShown.has(id)) {
							await emit('tool_result', {
								id,
								name: toolName,
								success: block.is_error !== true,
								executionMs: null,
								result: text,
								...(details ? { details } : {}),
							})
						}
						input.onToolResult?.({
							name: toolName,
							success: block.is_error !== true,
							...(details ? { details } : {}),
						})
						continue
					}

					// A `Task` result closes the child it started.
					if (subagentBlocks.has(id)) {
						const child = subagentBlocks.get(id)!
						if (block.is_error === true) child.success = false
						await emit('subagent_done', { agentId: id, conversationId: null })
					}
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

					// After the frame, so a slow ledger write cannot delay what the user sees.
					input.onToolResult?.({
						name: toolName,
						success: block.is_error !== true,
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
			session.close?.()
		} catch {
			// Already gone. Nothing to do and nothing worth logging.
		}
	}
}
