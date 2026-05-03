import type { LlmMessage, ReasoningConfig } from '$lib/llm/chat.server'
import type { StreamBlock } from '$lib/runs/runs.schema'

/** OpenAI-style tool definition shape — same one streamChat accepts. */
export type ToolDefinition = {
	type: 'function'
	function: {
		name: string
		description: string
		parameters: Record<string, unknown>
	}
}

/**
 * Wave 2 #10 phase 1 — runtime types.
 *
 * The agent loop, after extraction, takes one transport-agnostic Session and a self-contained
 * RunPolicy. The chat stream wraps the Session with SSE + DB writes; future channels (automation
 * detached runs, sub-agent forwarded sessions) can supply their own Session impls without
 * touching the loop.
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
 * Transport-agnostic session that the loop emits events into and updates run state through.
 *
 * Two backings exist (or will exist):
 *   - SSE-backed (chat stream) — wraps a ReadableStream controller AND writes run_events + chat_runs.
 *   - Detached (automation / sub-agent) — writes run_events only, no SSE writes.
 *
 * The loop never reaches into either implementation; it just calls `emit` / `updateRun` / `pushBlock`.
 */
export type Session = {
	/** Stable run ID (matches chat_runs.id). */
	readonly runId: string
	/** Whether the SSE client is still connected. Detached sessions return true. */
	isClientConnected(): boolean
	/** Emit a structured event. SSE-backed sessions write to both the wire AND run_events. */
	emit(eventName: string, payload: unknown): Promise<void>
	/** Patch the chat_runs row with state / label / heartbeat / etc. No-op fields are skipped. */
	updateRun(patch: RunPatch): Promise<void>
	/** Append a new ordered block to chat_runs.streamBlocks (durable mirror of the live stream). */
	pushBlock(block: StreamBlock): Promise<void>
}

/**
 * Subagent invocation contract — supplied to the loop as a callback so the loop doesn't have to
 * import the agents domain. Returns the subagent's final-result string and the new conversation
 * ID for the UI to deep-link.
 */
export type SubagentRequest = {
	agentId: string
	task: string
	context?: string
}

export type SubagentResponse = {
	conversationId: string
	result: string
}

export type SpawnSubagent = (req: SubagentRequest) => Promise<SubagentResponse>

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
	/** Tool definitions to expose to the LLM on the FIRST round. Recomputed per-round via `computeTools`. */
	initialTools: ToolDefinition[]
	/**
	 * Re-compute the active tool surface at the start of each round. Used by progressive disclosure
	 * so an `enable_capability` call in round N takes effect in round N+1. Pass a function that
	 * returns the same value every time when progressive disclosure is off.
	 */
	computeTools: () => Promise<ToolDefinition[]>
	/** Pass-through to streamChat. */
	reasoningConfig?: ReasoningConfig
	/** Hard cap on tool rounds. The loop exits when the model stops calling tools or this is hit. */
	maxRounds: number
	/** Tools requiring explicit user approval (or the wildcard "*"). */
	approvalRequiredTools: ReadonlySet<string>
	/** True when this is the orchestrator (controls ask_user permission, run_subagent dispatch). */
	isOrchestrator: boolean
	/** Wave 3 #13 phase 4 — owning agent so per-agent hook config (`agents.config.hooks`) can dispatch. Null for unowned chat runs. */
	agentId?: string | null
	/** Workspace context — passed through to executeTool. */
	persistentKey: string | null
	worktree: { repoPath: string; baseBranch?: string; deleteBranchOnCleanup?: boolean } | null
	/** Sub-agent spawn callback (only used when the orchestrator calls run_subagent with an agentId). */
	spawnSubagent?: SpawnSubagent
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
	/** Ordered stream blocks (text / thinking / tool / subagent) for the persisted message metadata. */
	streamBlocks: StreamBlock[]
	/** Token usage summed across rounds. */
	promptTokens: number
	completionTokens: number
	/** First-token latency (ms since loop start). Null when the model produced no content. */
	firstTokenAt: number | null
	/** Whether the loop terminated because the model stopped calling tools (true) or hit MAX_ROUNDS (false). */
	finishedNaturally: boolean
}
