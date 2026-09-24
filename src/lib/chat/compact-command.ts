/**
 * Finding 80 — "Compact Conversation", and the compaction before a switch to a model with a
 * smaller context window, run the CLI's own `/compact`.
 *
 * Both used to send an ordinary message asking the model for a summary. The SDK session
 * then carried that summary on top of the full history it was meant to replace, so the
 * context grew instead of shrinking. `/compact` summarises and starts the session again
 * from the summary; the turn shows a "Context compacted" notice.
 *
 * The command has to be the whole prompt, as plain text: the CLI reads a slash command only
 * from the very start of it (`userTurnMessages` keeps text-only prompts a string for this).
 */

/** What `/compact` is told to keep. */
export const COMPACT_INSTRUCTIONS =
	'Preserve all requirements, decisions, open tasks, constraints, and the latest user intent.'

/** The prompt for a compaction; `handoff` when it runs before a switch to a smaller model. */
export function compactCommand(options: { handoff?: boolean } = {}): string {
	const handoff = options.handoff ? ' This is a handoff to a model with a smaller context window.' : ''
	return `/compact ${COMPACT_INSTRUCTIONS}${handoff}`
}

const shortModelName = (model: string) => model.split('/').at(-1) ?? model

/** The notice after compacting before a model switch: honest about a compaction that failed. */
export function compactSwitchNotice(input: { failed: boolean; from: string; to: string }): string {
	return input.failed
		? `Compacting before the switch to ${shortModelName(input.to)} failed; the full conversation is still in context.`
		: `Compacted the conversation on ${shortModelName(input.from)} before switching to ${shortModelName(input.to)}.`
}
