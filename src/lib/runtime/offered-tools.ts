/**
 * The old loop runs only the tools it offered the model.
 *
 * A model can name any registry tool, whatever its tools array said, and `executeTool` runs
 * whatever it is handed. On the chat engine the SDK only dispatches what it registered; the
 * old loop had no such check. Its callers are unattended runs that pass no approval set,
 * having nobody to ask, so there the offered list was a suggestion and not a boundary: a
 * prompt-injected `web_search` result asking for `delete_file` or `create_automation` ran.
 *
 * Pure and dependency-free, so the spec can import it from the plain Playwright loader.
 */

/** The names a run offered, read off the definitions it sent the model. */
export function offeredToolNames(tools: readonly { function: { name: string } }[]): ReadonlySet<string> {
	return new Set(tools.map((tool) => tool.function.name))
}

/** Recorded on the refused call's block and tool-call entry. */
export const NOT_OFFERED_REASON = 'not available to this run'

/** What the model is told when it calls a tool it was not offered. */
export function notOfferedMessage(name: string): string {
	return `${name} is not available to this run. Use only the tools you were given.`
}
