/**
 * The join between AgentStudio's `messages` rows and the SDK transcript, and what a turn
 * does with it (#24, and the edit/regenerate fix).
 *
 * The conversation lives in the SDK session (`conversations.sdk_session_id`); the rows are
 * our copy of it. Edit and regenerate change the rows, and used to leave the session alone:
 * the next turn resumed the full, unedited transcript and sent the literal word
 * "regenerate" into it. The model never saw the edited text, and the reply the user threw
 * away stayed in its context.
 *
 * Three keys on `messages.metadata` fix that, with no schema change:
 *
 * | Row       | Key             | What it holds                                                   |
 * | --------- | --------------- | --------------------------------------------------------------- |
 * | user      | `sdkTurn`       | the uuid its prompt carried into the transcript, the session, the working directory the run used, and whether files were checkpointed |
 * | assistant | `sdkTailUuid`   | the last transcript entry its turn wrote                        |
 * | user      | `sdkCutPending` | an edit or regenerate cut the rows back to this one, and no turn has cut the session to match yet |
 *
 * A regenerate of a user row resumes the session cut after the previous assistant row's
 * `sdkTailUuid` — exactly the kept history — and sends the row's own text. So does the next
 * ordinary message while a cut is pending: an edit whose reply never started (the request
 * failed, the server restarted) must not leave the next message talking to the unedited
 * session. A rewind restores files to the user row's `sdkTurn.uuid` (`./rewind.server`).
 *
 * Pure, so a spec can pin every branch without a database or a CLI.
 */

import type { TurnAttempt, TurnAttemptPlan } from '$lib/engine/turn-input'

/** `messages.metadata` key on a user row. */
export const SDK_TURN_KEY = 'sdkTurn'
/** `messages.metadata` key on an assistant row. */
export const SDK_TAIL_KEY = 'sdkTailUuid'
/**
 * `messages.metadata` key on a user row: an edit or regenerate cut the rows back to it, and
 * the SDK session still holds the turns it dropped. Set with the cut; cleared when a turn
 * records its join, because by then that turn's session starts from the cut (or afresh).
 */
export const SDK_CUT_PENDING_KEY = 'sdkCutPending'

/** Where one user row sits in the SDK transcript. */
export type TurnJoin = {
	/** The transcript uuid of the prompt — and the id its file checkpoint is keyed by. */
	uuid: string
	/** The SDK session the prompt went into. */
	sessionId: string
	/** The working directory the run used. A rewind must use the same one: the CLI stores paths under it relative to it. */
	cwd: string
	/** Whether the run backed up files before changing them, so there is anything to rewind to. */
	checkpointed: boolean
}

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0

/** The user row's join, or null when it has none (it predates this, or its turn never started). */
export function readTurnJoin(metadata: unknown): TurnJoin | null {
	if (!metadata || typeof metadata !== 'object') return null
	const raw = (metadata as Record<string, unknown>)[SDK_TURN_KEY]
	if (!raw || typeof raw !== 'object') return null
	const join = raw as Record<string, unknown>
	if (!isNonEmptyString(join.uuid) || !isNonEmptyString(join.sessionId) || !isNonEmptyString(join.cwd)) return null
	return { uuid: join.uuid, sessionId: join.sessionId, cwd: join.cwd, checkpointed: join.checkpointed === true }
}

/** Whether an edit or regenerate cut the rows back to this user row and the session has not followed yet. */
export function hasPendingCut(metadata: unknown): boolean {
	if (!metadata || typeof metadata !== 'object') return false
	return (metadata as Record<string, unknown>)[SDK_CUT_PENDING_KEY] === true
}

/** The assistant row's transcript tail, or null. */
export function readTailUuid(metadata: unknown): string | null {
	if (!metadata || typeof metadata !== 'object') return null
	const tail = (metadata as Record<string, unknown>)[SDK_TAIL_KEY]
	return isNonEmptyString(tail) ? tail : null
}

/**
 * Whether a run's workspace outlives it, which is when checkpointing its files is worth
 * anything. Mirrors `resolveWorkspaceRoot`'s priority: an agent's persistent directory
 * wins; a worktree is per run; a project's checkout is stable; a bare chat gets a fresh
 * `runs/<runId>` directory every turn, so there is never anything to go back to.
 */
export function supportsFileCheckpoints(ctx: {
	persistentKey?: string | null
	worktree?: unknown
	projectId?: string | null
}): boolean {
	if (ctx.persistentKey) return true
	if (ctx.worktree) return false
	return Boolean(ctx.projectId)
}

/** A kept row, as the preamble reads it. */
export type HistoryRow = { role: string; content: string }

/** The preamble's size budget. A fallback, not a replay: the most recent turns matter most. */
export const PREAMBLE_MAX_CHARS = 24_000
const PREAMBLE_ROW_MAX_CHARS = 4_000

/** The rows as "User: …" / "Assistant: …" turns, the most recent kept within `maxChars`. Null when there are none. */
function formatTurns(rows: HistoryRow[], maxChars: number): string | null {
	const turns = rows
		.filter((row) => (row.role === 'user' || row.role === 'assistant') && row.content.trim().length > 0)
		.map((row) => {
			const text = row.content.trim()
			const clipped = text.length > PREAMBLE_ROW_MAX_CHARS ? `${text.slice(0, PREAMBLE_ROW_MAX_CHARS)} […]` : text
			return `${row.role === 'user' ? 'User' : 'Assistant'}: ${clipped}`
		})
	if (turns.length === 0) return null

	const kept: string[] = []
	let used = 0
	for (let i = turns.length - 1; i >= 0; i--) {
		if (used + turns[i].length > maxChars && kept.length > 0) break
		kept.unshift(turns[i])
		used += turns[i].length
	}
	const omitted = kept.length < turns.length ? '(Earlier messages omitted.)\n\n' : ''
	return `${omitted}${kept.join('\n\n')}`
}

/**
 * The kept history as text, for a fresh session that stands in for one we could not cut —
 * a conversation older than the join, or a cut the CLI refused. Most recent turns first to
 * survive the budget; tool calls are not in `messages.content`, so they are not here.
 * Null when there is nothing to keep.
 */
export function buildHistoryPreamble(rows: HistoryRow[], maxChars = PREAMBLE_MAX_CHARS): string | null {
	const turns = formatTurns(rows, maxChars)
	if (!turns) return null
	return [
		'[Earlier in this conversation — restored as text because the session could not be rewound to this point.]',
		'',
		turns,
		'',
		'[End of the earlier conversation. The message to answer follows.]',
	].join('\n')
}

/**
 * The user rows after the last reply: sent, but never answered in the session a cut goes
 * back to. Usually there are none. There are some when an edit's reply never started and the
 * user wrote again, or when a turn failed before it saved a reply.
 */
export function unansweredTail(rows: HistoryRow[]): HistoryRow[] {
	let lastReply = -1
	for (let i = rows.length - 1; i >= 0; i--) {
		if (rows[i].role === 'assistant') {
			lastReply = i
			break
		}
	}
	return rows.slice(lastReply + 1).filter((row) => row.role === 'user')
}

/**
 * The unanswered user rows as text, for a turn resumed at the last reply. The cut session
 * holds everything up to that reply; these are what the page shows between it and the turn.
 */
export function buildUnansweredPreamble(rows: HistoryRow[], maxChars = PREAMBLE_MAX_CHARS): string | null {
	const turns = formatTurns(
		rows.filter((row) => row.role === 'user'),
		maxChars,
	)
	if (!turns) return null
	return [
		'[Earlier messages in this conversation that did not get a reply:]',
		'',
		turns,
		'',
		'[End of the earlier messages. The message to answer follows.]',
	].join('\n')
}

/**
 * Whether a turn's text is a CLI slash command such as `/compact`. The CLI only reads a
 * command from the very start of the prompt, so nothing may go in front of one.
 */
export function isSlashCommand(text: string): boolean {
	return /^\/[A-Za-z]/.test(text.trimStart())
}

/** The previous assistant row, as far as the fork decision cares. */
export type ForkPoint = { sdkSessionId: string | null; sdkTailUuid: string | null }

/**
 * How a turn starts its SDK session.
 *
 * - A new message resumes the session as it is.
 * - A cut — an edit or regenerate, or the next message after an edit whose reply never
 *   started — resumes the session cut after the previous assistant row's tail, when that row
 *   belongs to the current session and recorded one. User rows between that reply and the
 *   turn (`unanswered`) go in front of the text, since the cut session never saw them. The
 *   fallback, used only if the CLI refuses the cut, is a fresh session primed with the kept
 *   history.
 * - Otherwise — the first message, a conversation older than the join, a turn that ended
 *   in a compaction — the cut starts a fresh session with that preamble straight away.
 *
 * `forkSession` is deliberately never used: a forked session starts without the file
 * history (`forkSession()`'s own doc says so), and keeping the same session id is what lets
 * a later rewind still find every checkpoint.
 */
export function resolveTurnResume(input: {
	/** The session must be cut back to the kept history first. */
	cut: boolean
	sdkSessionId: string | null
	previousAssistant: ForkPoint | null
	/** Every kept user and assistant row before the turn, oldest first. */
	keptHistory: HistoryRow[]
	/** The kept user rows after `previousAssistant` (`unansweredTail`). Empty for a slash command. */
	unanswered?: HistoryRow[]
	mintUuid: () => string
}): TurnAttemptPlan {
	if (!input.cut) {
		return {
			first: {
				kind: 'continue',
				...(input.sdkSessionId ? { resumeSessionId: input.sdkSessionId } : {}),
				preamble: null,
				sdkUserUuid: input.mintUuid(),
			},
			fallback: null,
		}
	}

	const fresh = (): TurnAttempt => ({
		kind: 'fresh',
		preamble: buildHistoryPreamble(input.keptHistory),
		sdkUserUuid: input.mintUuid(),
	})

	const point = input.previousAssistant
	if (input.sdkSessionId && point?.sdkTailUuid && point.sdkSessionId === input.sdkSessionId) {
		return {
			first: {
				kind: 'fork',
				resumeSessionId: input.sdkSessionId,
				resumeSessionAt: point.sdkTailUuid,
				preamble: buildUnansweredPreamble(input.unanswered ?? []),
				sdkUserUuid: input.mintUuid(),
			},
			fallback: fresh(),
		}
	}
	return { first: fresh(), fallback: null }
}

/** A prompt as `prepareAttachmentPrompt` returns it. */
type PreparedContent<Block> = { text: string; content: Block[] | null }

/**
 * The content an attempt sends: the prepared prompt with the preamble, if any, in front.
 * Content blocks (images) stay blocks; the preamble joins the first text block.
 */
export function turnPromptContent<Block extends { type: string }>(
	prepared: PreparedContent<Block>,
	preamble: string | null,
): string | Block[] {
	if (!prepared.content) return preamble ? `${preamble}\n\n${prepared.text}` : prepared.text
	if (!preamble) return prepared.content
	const blocks = [...prepared.content]
	const first = blocks.findIndex((block) => block.type === 'text')
	if (first === -1) return [{ type: 'text', text: preamble } as unknown as Block, ...blocks]
	const block = blocks[first] as unknown as { type: 'text'; text: string }
	blocks[first] = { ...block, text: `${preamble}\n\n${block.text}` } as unknown as Block
	return blocks
}
