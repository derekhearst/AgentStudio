// Type-only and relative, so the spec can import this from the plain Playwright loader.
import type { ToolName } from '../tools/tool-schemas'

/**
 * The registry tools an unattended old-loop run is offered: an automation with an agent
 * attached, a monitor's `start_conversation`, and a CI fix run — everything that goes
 * through `buildAgentDefinition`.
 *
 * This used to be the registry's "always loaded" tier (web_search, ask_user, run_code,
 * search_tools), with the rest of the registry reachable only through `search_tools`. #69
 * retired `run_code`, #8 deleted `search_tools` and the tier with it, and these runs never
 * got `ask_user` because nobody is there to answer — #4 then deleted it for the SDK's own
 * question tool, which only the chat engine has. That leaves `web_search`.
 *
 * Kept exactly that narrow on purpose. These runs have no approval surface, and deciding
 * what else they may do belongs to moving them onto the engine, not to deleting two tools.
 */
export const DETACHED_RUN_TOOLS: readonly ToolName[] = ['web_search']

/**
 * The tools for one run. An agent's `allowedTools` narrows the list and cannot widen it,
 * which is how it behaved when the list was the "always loaded" tier.
 */
export function detachedRunToolNames(allowedTools?: readonly string[] | null): ToolName[] {
	if (!allowedTools || allowedTools.length === 0) return [...DETACHED_RUN_TOOLS]
	return DETACHED_RUN_TOOLS.filter((name) => allowedTools.includes(name))
}
