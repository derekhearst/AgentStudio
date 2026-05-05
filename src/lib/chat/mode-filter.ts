import type { ChatMode } from '$lib/sessions/sessions.schema'

/**
 * Wave 5 #22 phase 7 — pure mode-aware tool filtering.
 *
 * Lives in a non-server file so unit tests can import it without pulling in `$lib/db.server`
 * (which transitively imports `$app/environment`, unresolvable in the Playwright Node test
 * runner). `mode.server.ts` re-exports these so existing call sites are unaffected.
 *
 * Research + Plan modes are explicitly read-only-with-asks: the model must surface
 * findings/proposals to the user instead of taking destructive actions. We strip any tool
 * that mutates state outside the active conversation. Chat + Agent modes pass through
 * unfiltered — their posture is handled by the system prompt slot, not by tool removal.
 *
 * The list is allow-list rather than deny-list so a newly added tool defaults to "stripped
 * in research/plan" until it's audited and added here. Failing closed is the correct
 * default for a feature whose entire job is to prevent silent side-effects.
 */

const MODE_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
	// Always-on essentials (core capability group).
	'ask_user',
	'propose_plan',
	'enable_capability',
	'web_search',
	// Sandbox: read-only inspection.
	'file_read',
	'list_directory',
	'search_files',
	'file_info',
	'browser_screenshot',
	'web_fetch',
	'pdf_read',
	'git_status',
	'git_log',
	'git_diff',
	// Skills: read-only.
	'list_skills',
	'read_skill',
	'read_skill_file',
	// Source control: read-only + the structured commit-draft helper.
	'list_my_repos',
	'list_pull_requests',
	'get_pull_request',
	'prepare_commit',
	// Projects + artifacts: read-only.
	'list_projects',
	'list_artifacts',
	'read_artifact',
	// Automations: read-only.
	'list_automations',
	// Memory: read-only retrieval.
	'recall_memory',
	'list_memory',
])

export function filterToolsByMode<T extends { function: { name: string } }>(
	tools: T[],
	mode: ChatMode,
): T[] {
	if (mode === 'chat' || mode === 'agent') return tools
	return tools.filter((tool) => MODE_READ_ONLY_TOOLS.has(tool.function.name))
}

export function isToolAllowedInMode(toolName: string, mode: ChatMode): boolean {
	if (mode === 'chat' || mode === 'agent') return true
	return MODE_READ_ONLY_TOOLS.has(toolName)
}

/** Exposed for tests + the future settings UI that shows operators what each mode permits. */
export function getReadOnlyToolNames(): readonly string[] {
	return [...MODE_READ_ONLY_TOOLS].sort()
}
