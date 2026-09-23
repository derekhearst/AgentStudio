/**
 * The names of the SDK's built-in tools, as data.
 *
 * Kept out of `options.server.ts` so they can be read without pulling in `$env` and the
 * rest of the server surface. Three layers have to agree with these names: the
 * containment guard in `./workspace-guard`, which knows how each one names its path
 * argument; the read-only agent allow-list in `$lib/agents/builtin-agents.server`; and
 * the option builder itself. A test that checks those agree has to be able to import
 * them, and importing the server module from the Playwright runtime fails on `$env`.
 */

/** Built-in SDK tools that replaced the in-house filesystem registry entries (#15). */
export const BUILTIN_FILE_TOOLS = ['Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep'] as const

/**
 * `TaskStop` is what the CLI calls `KillShell` now (see `LEGACY_TOOL_NAMES`). `BashOutput`
 * no longer exists in the bundled CLI at all — a background command's output is read with
 * `Read` — and stays listed only so an agent configured with it keeps validating.
 */
export const BUILTIN_SHELL_TOOLS = ['Bash', 'BashOutput', 'KillShell', 'TaskStop'] as const

/**
 * Built-ins we deliberately refuse, because an in-house tool does the same job *and* more.
 *
 * `WebSearch` / `WebFetch`: ours route through the self-hosted SearXNG at `SEARXNG_URL`
 * and write a `logToolUsage` row per call with an operator-tunable per-call cost. The SDK's
 * are billed server-side and invisible to the ledger, so letting both exist would silently
 * move spend off the books depending on which one the model happened to pick.
 */
export const DISALLOWED_BUILTIN_TOOLS = ['WebSearch', 'WebFetch'] as const

/**
 * The CLI's current name for each built-in it has renamed, keyed by the old name.
 *
 * The same table the SDK applies to permission rules (`Task` → `Agent` and so on in
 * `sdk.mjs`), and the CLI resolves the old names as aliases when it builds its tool list.
 * What it does not do is rename a call: the model calls the tool by its current name, so a
 * PreToolUse hook and `canUseTool` are handed `Agent`, never `Task`. Anything of ours that
 * compares a call's name against a configured list has to compare canonical names, or a
 * scope that says `Task` refuses every delegation.
 */
export const LEGACY_TOOL_NAMES: Readonly<Record<string, string>> = {
	Task: 'Agent',
	KillShell: 'TaskStop',
	KillBash: 'TaskStop',
}

/** A tool name as the CLI calls it today — `Task` → `Agent`; anything else unchanged. */
export function canonicalToolName(name: string): string {
	return Object.hasOwn(LEGACY_TOOL_NAMES, name) ? LEGACY_TOOL_NAMES[name] : name
}

/**
 * The SDK's delegation tool — the one way an `Options.agents` definition is reached (#5).
 *
 * `Agent`, not `Task`: the bundled CLI renamed it and keeps `Task` only as an alias, so a
 * delegation arrives at the hook as `Agent`. Named here rather than inlined because the
 * tool scope adds it to a run that was given agents, and the capability rules classify it.
 */
export const SUBAGENT_TOOL = 'Agent'

/** Membership test so an allowlist can carry both surfaces without qualifying built-ins. */
export const BUILTIN_TOOL_SET: ReadonlySet<string> = new Set<string>([
	...BUILTIN_FILE_TOOLS,
	...BUILTIN_SHELL_TOOLS,
	'NotebookEdit',
	'TodoWrite',
])

/**
 * Registry tools the engine deliberately does not expose.
 *
 * `run_subagent` is excluded because it has been replaced, not removed. Delegation is the
 * SDK's `Task` tool now, against the agents `./agent-definitions.server` describes in the
 * system prompt. The in-house tool dispatched by `agentId` — a uuid nothing ever put in the
 * model's context — so it could name an agent only by guessing one; the SDK's names every
 * agent it offers. Keeping both would give the model two ways to delegate, one of which
 * renders a nested transcript and one of which does not.
 *
 * `search_tools` and `run_code` used to be listed here as well. Both could only work inside
 * the old loop — deferred loading and a script's nested tool calls — and both were deleted
 * from the registry instead (#8, #69): hidden here, they were still offered by everything
 * else that lists the registry, the settings approval list and the MCP endpoint included.
 */
export const ENGINE_EXCLUDED_TOOLS: ReadonlySet<string> = new Set(['run_subagent'])

/**
 * Registry tools the host renders itself, so the engine must not emit tool frames for them.
 * `ask_user` blocks on `onAskUser`, which mints its own `ask_user` frame and card.
 *
 * `./stream.server` hands them over before either gate — the PreToolUse hook and
 * `canUseTool` — so no approval setting or permission mode ever reaches them. Here rather
 * than there so the settings approval list and the MCP endpoint can leave them out without
 * keeping a copy of their own.
 */
export const HOST_OWNED_TOOLS: ReadonlySet<string> = new Set(['ask_user'])
