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
 * Two keys on `messages.metadata` fix that, with no schema change:
 *
 * | Row       | Key            | What it holds                                                   |
 * | --------- | -------------- | --------------------------------------------------------------- |
 * | user      | `sdkTurn`      | the uuid its prompt carried into the transcript, the session, the working directory the run used, and whether files were checkpointed |
 * | assistant | `sdkTailUuid`  | the last transcript entry its turn wrote                        |
 *
 * A regenerate of a user row resumes the session cut after the previous assistant row's
 * `sdkTailUuid` — exactly the kept history — and sends the row's own text. A rewind restores
 * files to the user row's `sdkTurn.uuid` (`./rewind.server`).
 *
 * Pure, so a spec can pin every branch without a database or a CLI.
 */

import type { TurnAttempt, TurnAttemptPlan } from '$lib/engine/turn-input'

/** `messages.metadata` key on a user row. */
export const SDK_TURN_KEY = 'sdkTurn'
/** `messages.metadata` key on an assistant row. */
export const SDK_TAIL_KEY = 'sdkTailUuid'

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

/**
 * The kept history as text, for a fresh session that stands in for one we could not cut —
 * a conversation older than the join, or a cut the CLI refused. Most recent turns first to
 * survive the budget; tool calls are not in `messages.content`, so they are not here.
 * Null when there is nothing to keep.
 */
export function buildHistoryPreamble(rows: HistoryRow[], maxChars = PREAMBLE_MAX_CHARS): string | null {
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
	return [
		'[Earlier in this conversation — restored as text because the session could not be rewound to this point.]',
		'',
		`${omitted}${kept.join('\n\n')}`,
		'',
		'[End of the earlier conversation. The message to answer follows.]',
	].join('\n')
}

/** The previous assistant row, as far as the fork decision cares. */
export type ForkPoint = { sdkSessionId: string | null; sdkTailUuid: string | null }

/**
 * How a turn starts its SDK session.
 *
 * - A new message resumes the session as it is.
 * - An edit or regenerate cuts the session after the previous assistant row's tail, when
 *   that row belongs to the current session and recorded one. The fallback, used only if
 *   the CLI refuses the cut, is a fresh session primed with the kept history.
 * - Otherwise — the first message, a conversation older than the join, a turn that ended
 *   in a compaction — the edit starts a fresh session with that preamble straight away.
 *
 * `forkSession` is deliberately never used: a forked session starts without the file
 * history (`forkSession()`'s own doc says so), and keeping the same session id is what lets
 * a later rewind still find every checkpoint.
 */
export function resolveTurnResume(input: {
	regenerate: boolean
	sdkSessionId: string | null
	previousAssistant: ForkPoint | null
	keptHistory: HistoryRow[]
	mintUuid: () => string
}): TurnAttemptPlan {
	if (!input.regenerate) {
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
				preamble: null,
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
