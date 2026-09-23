import type { CacheControl, LlmMessage, ReasoningConfig } from '$lib/llm/chat.server'
import type { StreamBlock } from '$lib/runs/runs.schema'

/** OpenAI-style tool definition shape — same one streamChat accepts. */
export type ToolDefinition = {
	type: 'function'
	function: {
		name: string
		description: string
		parameters: Record<string, unknown>
	}
	/**
	 * Optional Anthropic ephemeral cache marker. Set on the LAST tool def in the array to cache
	 * the tools prefix. Ignored by non-Anthropic providers. Note: camelCase here matches the
	 * OpenRouter SDK input shape; the SDK converts to `cache_control` on the wire.
	 */
	cacheControl?: CacheControl
}

/**
 * Wave 2 #10 phase 1 — runtime types.
 *
 * The loop takes one Session and a self-contained input. Since the chat stream moved to the
 * Agent SDK engine, its only callers are unattended runs (automations with an agent, a
 * monitor's start_conversation, CI fix runs), all on the detached Session.
 */

export type RunStateName =
	| 'queued'
	| 'running'
	| 'waiting_tool_approval'
	| 'waiting_user_input'
	| 'waiting_plan_decision'
	| 'completed'
	| 'failed'
	| 'canceled'

export type RunPatch = {
	state?: RunStateName
	label?: string | null
	lastDelta?: string | null
	error?: string | null
	heartbeat?: boolean
	finished?: boolean
}

/**
 * Loop-side message shape — superset of LlmMessage with optional tool-call linkage. Mirrors the
 * legacy `LoopMessage` in stream/+server.ts so the extraction is a 1-for-1 swap.
 */
export type LoopMessage = LlmMessage & {
	toolCalls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
	toolCallId?: string
}

/**
 * The session the loop emits events into and updates run state through. The one backing is
 * the detached session (`./session/detached.server`): it writes run_events and chat_runs and
 * has no client. The SSE-backed and forwarded sessions went with the chat stream and the
 * in-house subagents (#8).
 *
 * The loop never reaches into the implementation; it just calls `emit` / `updateRun` / `pushBlock`.
 */
export type Session = {
	/** Stable run ID (matches chat_runs.id). */
	readonly runId: string
	/** Whether a client is still connected. Detached sessions return true. */
	isClientConnected(): boolean
	/** Emit a structured event into run_events. */
	emit(eventName: string, payload: unknown): Promise<void>
	/** Patch the chat_runs row with state / label / heartbeat / etc. No-op fields are skipped. */
	updateRun(patch: RunPatch): Promise<void>
	/** Append a new ordered block to chat_runs.streamBlocks (durable mirror of the live stream). */
	pushBlock(block: StreamBlock): Promise<void>
}

/**
 * Inputs the loop needs from the caller. Most are pre-resolved (agent definition, environment,
 * tool surface) so the loop itself stays focused on the orchestration semantics.
 */
export type RunChatLoopInput = {
	session: Session
	userId: string
	conversationId: string
	model: string
	initialMessages: LoopMessage[]
	/** Tool definitions exposed to the LLM, the same on every round. */
	tools: ToolDefinition[]
	/** Pass-through to streamChat. */
	reasoningConfig?: ReasoningConfig
	/** Hard cap on tool rounds. The loop exits when the model stops calling tools or this is hit. */
	maxRounds: number
	/** Tools requiring explicit user approval (or the wildcard "*"). */
	approvalRequiredTools: ReadonlySet<string>
	/** True when this is the orchestrator (controls ask_user permission). */
	isOrchestrator: boolean
	/** Wave 3 #13 phase 4 — owning agent so per-agent hook config (`agents.config.hooks`) can dispatch. Null for unowned chat runs. */
	agentId?: string | null
	/** Workspace context — passed through to executeTool. */
	persistentKey: string | null
	worktree: { repoPath: string; baseBranch?: string; deleteBranchOnCleanup?: boolean } | null
	/**
	 * Project ID when the conversation is bound to a project (`conversations.project_id`).
	 * Triggers project-scoped workspace resolution: the agent's cwd lands inside
	 * `<sandbox>/<userId>/projects/<projectId>` instead of an ephemeral run dir.
	 */
	projectId: string | null
}

export type RunChatLoopResult = {
	/** All assistant text content concatenated across rounds (used for the persisted message). */
	finalText: string
	/** All assistant reasoning concatenated across rounds. */
	finalReasoning: string
	/** Reasoning token count from the most recent chunk that reported it. */
	reasoningTokens: number | null
	/** All tool calls executed — used for activity emit + cost rollups. */
	toolCalls: Array<Record<string, unknown>>
	/** Ordered stream blocks (text / thinking / tool) for the persisted message metadata. */
	streamBlocks: StreamBlock[]
	/** Token usage summed across rounds. */
	promptTokens: number
	completionTokens: number
	/**
	 * Anthropic prompt-caching stats (zero on non-Anthropic providers). cacheCreationInputTokens
	 * = tokens written to the cache this turn (charged at +25% over base input); cacheReadInputTokens
	 * = tokens read from cache this turn (charged at 10% of base input).
	 */
	cacheCreationInputTokens: number
	cacheReadInputTokens: number
	/** First-token latency (ms since loop start). Null when the model produced no content. */
	firstTokenAt: number | null
	/** Whether the loop terminated because the model stopped calling tools (true) or hit MAX_ROUNDS (false). */
	finishedNaturally: boolean
}
