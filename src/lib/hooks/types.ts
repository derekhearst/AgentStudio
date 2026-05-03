/**
 * Wave 3 #13 phase 1 — hook event payload types.
 *
 * Pure (no DB / SvelteKit deps) so the types can be imported anywhere — runtime, builtin
 * implementations, future skill-based hook runner. Each event's payload mirrors the spec
 * table in docs/hooks/plan.md.
 */

export type HookEvent =
	| 'before_run'
	| 'after_run'
	| 'before_round'
	| 'after_round'
	| 'before_tool'
	| 'after_tool'
	| 'on_compact'
	| 'on_evaluator'
	| 'on_subagent_spawn'
	| 'on_approval_required'
	| 'on_user_question'
	| 'on_run_failed'
	| 'on_skill_loaded'
	| 'on_tool_output_archived'

export type HookContext = {
	runId: string
	conversationId: string
	userId: string
	agentId: string | null
}

export type HookPayload<E extends HookEvent> = E extends 'before_run'
	? HookContext & { source: string }
	: E extends 'after_run'
		? HookContext & { costUsd: number | null; durationMs: number; success: boolean }
		: E extends 'before_round'
			? HookContext & { round: number; messageCount: number }
			: E extends 'after_round'
				? HookContext & { round: number; contentLen: number; toolCallCount: number }
				: E extends 'before_tool'
					? HookContext & { toolName: string; args: unknown }
					: E extends 'after_tool'
						? HookContext & {
								toolName: string
								args: unknown
								result: unknown
								success: boolean
								durationMs: number
							}
						: E extends 'on_compact'
							? HookContext & { tokensBefore: number; tokensAfter: number; summary: string | null }
							: E extends 'on_subagent_spawn'
								? HookContext & { childAgentId: string; task: string }
								: E extends 'on_approval_required'
									? HookContext & { toolName: string; args: unknown; token: string }
									: E extends 'on_user_question'
										? HookContext & { token: string; questionCount: number }
										: E extends 'on_run_failed'
											? HookContext & { error: string }
											: E extends 'on_skill_loaded'
												? HookContext & { skillSlug: string; loadKind: 'summary' | 'body' | 'file' }
												: E extends 'on_tool_output_archived'
													? HookContext & { toolName: string; handle: string; fullSize: number }
													: HookContext

export type HookHandler<E extends HookEvent = HookEvent> = (
	payload: HookPayload<E>,
) => void | Promise<void>

export type RegisteredHook = {
	event: HookEvent
	name: string // for the invocation log
	handler: HookHandler
	timeoutMs?: number
}
