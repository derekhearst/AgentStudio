import type { AudioOutputConfig, CacheControl, ChatPlugin, LlmMessage, ReasoningConfig } from '$lib/llm/chat.server'
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
	 * so a `search_tools` call in round N takes effect in round N+1. Pass a function that
	 * returns the same value every time when deferred loading is off.
	 */
	computeTools: () => Promise<ToolDefinition[]>
	/** Pass-through to streamChat. */
	reasoningConfig?: ReasoningConfig
	/**
	 * Pass-through to streamChat for OpenRouter plugin slots. Used by the chat stream to enable
	 * the `file-parser` plugin (PDF OCR engine) when the user attaches a PDF.
	 */
	chatPlugins?: ChatPlugin[]
	/**
	 * Output modalities. When `'audio'` is included, the model emits spoken audio inline with
	 * text via `delta.audio` SSE chunks. Requires a model that lists `audio` in its
	 * outputModalities (see `modelCapabilities`).
	 */
	modalities?: Array<'text' | 'audio'>
	/** Audio output configuration. Required when `modalities` includes `'audio'`. */
	audio?: AudioOutputConfig
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
	/**
	 * Project ID when the conversation is bound to a project (`conversations.project_id`).
	 * Triggers project-scoped workspace resolution: the agent's cwd lands inside
	 * `<sandbox>/<userId>/projects/<projectId>` instead of an ephemeral run dir.
	 */
	projectId: string | null
	/** Sub-agent spawn callback (only used when the orchestrator calls run_subagent with an agentId). */
	spawnSubagent?: SpawnSubagent
	/**
	 * Tool Search Tool side-effect channel. The `search_tools` handler invokes this with the
	 * names of tools it matched; the runtime adds them to the per-run loaded set so the next
	 * round's `computeTools()` includes them. No-op when the caller doesn't supply one (e.g.
	 * detached automation runs that pre-bind their tool surface).
	 */
	loadSearchableTools?: (toolNames: string[]) => void
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
