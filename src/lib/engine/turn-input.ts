/**
 * How one chat turn enters an SDK session, and how the session is pointed at the right
 * place in its history first (#24, and the edit/regenerate fix).
 *
 * Three things live here, all pure so a spec can drive them without a CLI:
 *
 * - **A known uuid for every prompt.** The CLI keeps the `uuid` on a streamed
 *   `SDKUserMessage` as that message's transcript uuid (`ForkSessionOptions.upToMessageId`
 *   in `sdk.d.ts` says so), and its file checkpoints are keyed by it. Minting it here is
 *   what lets a `messages` row name the exact SDK message a later rewind goes back to. A
 *   string prompt gets a uuid the CLI makes up and never tells us, so every turn now uses
 *   the one-message streaming form. The SDK treats the two the same way: after the input
 *   ends it waits for the first result before closing stdin whenever the run has hooks,
 *   `canUseTool` or MCP servers — which every chat run does.
 * - **The transcript tail.** `resumeSessionAt` truncates a resumed session after a given
 *   chain entry. For an edited or regenerated turn that entry is the last one the turn
 *   before it wrote; `nextTranscriptTail` tracks it while the turn streams.
 * - **The fallback.** A truncating resume the CLI cannot honour (the uuid is behind a
 *   compaction boundary, say) fails before the model is called, with an error result whose
 *   text we can recognise. `runWithResumeFallback` then runs the turn once more on a fresh
 *   session, so an edit never dead-ends on a refusal that would repeat forever.
 */

import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

/** A content block of a user prompt. Structurally the attachments module's `SdkContentBlock`. */
type PromptBlock = { type: string; [key: string]: unknown }

/**
 * The prompt for one turn: a single user message carrying `uuid`, as the async iterable
 * `query()` takes for streaming input.
 *
 * Text-only turns keep a plain string as the message content. That is what the CLI reads
 * slash commands from — `/compact` has to arrive as text, not as a text block.
 */
export async function* userTurnMessages(
	content: string | PromptBlock[],
	uuid: string,
): AsyncGenerator<SDKUserMessage> {
	yield {
		type: 'user',
		message: { role: 'user', content } as unknown as SDKUserMessage['message'],
		parent_tool_use_id: null,
		uuid: uuid as SDKUserMessage['uuid'],
	}
}

/**
 * The transcript's last top-level chain entry after `msg`, given the one before it.
 *
 * Counts the main thread's assistant and user messages — the entries a later
 * `resumeSessionAt` can cut after. Everything else is left alone:
 *
 * - a subagent's messages (`parent_tool_use_id` set) live in the child's sidechain;
 * - a replay (`isReplay`) echoes an entry that is already in the chain;
 * - `stream_event`, `result` and the system notices are not chain entries at all.
 *
 * A compaction boundary clears the tail: nothing before it is a place a later resume can
 * cut to. The bundled CLI (0.3.278, checked against a stub Messages API) then streams the
 * summary it starts the session again from as main-thread `user` entries, and those set
 * the tail again — so an edit of the message after a `/compact` cuts right after the
 * summary and keeps it. A cut at an entry from before the boundary is refused with
 * "No message found with message.uuid", which `runWithResumeFallback` answers with a fresh
 * session; if a compaction ever ends a turn with nothing after it, the tail stays null and
 * the edit starts a fresh session straight away.
 */
export function nextTranscriptTail(current: string | null, msg: Record<string, unknown>): string | null {
	if (typeof msg.parent_tool_use_id === 'string' && msg.parent_tool_use_id.length > 0) return current
	if (msg.type === 'system' && msg.subtype === 'compact_boundary') return null
	if (msg.type !== 'assistant' && msg.type !== 'user') return current
	if (msg.isReplay === true) return current
	return typeof msg.uuid === 'string' && msg.uuid.length > 0 ? msg.uuid : current
}

/** How one attempt at a turn starts its SDK session. */
export type TurnAttempt = {
	/**
	 * - `continue`: an ordinary new message — resume the session where it is.
	 * - `fork`: an edit or regenerate — resume, cut after `resumeSessionAt`.
	 * - `fresh`: a new session, optionally primed with the kept history as text.
	 */
	kind: 'continue' | 'fork' | 'fresh'
	resumeSessionId?: string
	resumeSessionAt?: string
	/** Kept history, as text, for a fresh session that replaces one it could not cut. */
	preamble: string | null
	/** The uuid this attempt's user message carries into the transcript. */
	sdkUserUuid: string
}

/** The first attempt, and what to run instead if the CLI refuses its truncating resume. */
export type TurnAttemptPlan = { first: TurnAttempt; fallback: TurnAttempt | null }

/**
 * `options` with the session start `attempt` asks for, and nothing left over from another.
 *
 * `buildEngineOptions` already set `resume` for the first attempt; a fallback must drop it,
 * or the "fresh" session would resume the one it is replacing.
 */
export function withTurnResume(options: Options, attempt: TurnAttempt): Options {
	const { resume: _resume, resumeSessionAt: _at, ...rest } = options
	return {
		...rest,
		...(attempt.resumeSessionId ? { resume: attempt.resumeSessionId } : {}),
		...(attempt.resumeSessionId && attempt.resumeSessionAt ? { resumeSessionAt: attempt.resumeSessionAt } : {}),
	}
}

/**
 * Whether an error is the CLI refusing to resume — which happens at boot, before any
 * model call. The texts are the CLI's own (print-mode resume path, checked against the
 * bundled `claude` 0.3.278): a `resumeSessionAt` uuid that is not in the loaded chain, the
 * `resumeDropsTurn` guard, and a transcript that could not be loaded.
 */
export function isResumeRefusal(error: string | null | undefined): boolean {
	if (!error) return false
	return /No message found with message\.uuid|Resume rejected by --resume-drops-turn|Failed to resume session|No conversation found with session ID/i.test(
		error,
	)
}

/** The fields of a run summary the fallback decision reads. */
type AttemptOutcome = { error: string | null; text: string; blocks: unknown[] }

/**
 * Run a turn, and when its truncating resume is refused, run it once more on the fallback.
 *
 * Only a refusal that produced nothing is retried: text or a tool call means the turn really
 * ran, and running it again would repeat its side effects. Only once: the fallback does not
 * cut anything, so it cannot be refused the same way.
 */
export async function runWithResumeFallback<T extends AttemptOutcome>(
	plan: TurnAttemptPlan,
	run: (attempt: TurnAttempt) => Promise<T>,
	onFallback?: (reason: string) => void,
): Promise<T> {
	const fallback = plan.fallback
	let outcome: T
	try {
		outcome = await run(plan.first)
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		if (!fallback || !isResumeRefusal(message)) throw error
		onFallback?.(message)
		return run(fallback)
	}
	// A notice is the CLI talking about the session, not the turn doing anything.
	const producedNothing =
		outcome.text.trim().length === 0 &&
		outcome.blocks.every((block) => (block as { kind?: unknown } | null)?.kind === 'notice')
	if (fallback && producedNothing && isResumeRefusal(outcome.error)) {
		onFallback?.(outcome.error ?? '')
		return run(fallback)
	}
	return outcome
}
