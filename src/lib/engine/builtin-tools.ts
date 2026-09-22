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

export const BUILTIN_SHELL_TOOLS = ['Bash', 'BashOutput', 'KillShell'] as const

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
 * The SDK's delegation tool — the one way an `Options.agents` definition is reached (#5).
 *
 * Named here rather than inlined because three places have to agree on it: the option
 * builder adds it to a scoped run's allowlist, the capability rules classify it, and the
 * stream loop reads a call to it as the start of a child transcript.
 */
export const SUBAGENT_TOOL = 'Task'

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
 * `search_tools` implements deferred loading — "only a small core is in your tools array;
 * call this to load the rest". That is real on the *old* loop, where `getToolDefinitions`
 * filters by `toolDisclosure` tier and the runtime maintains a per-run loaded set. It has
 * never been real here: `buildToolServer` registers the whole registry on round one, and
 * the callback the handler needs (`ctx.runtime.loadSearchableTools`) is only ever supplied
 * by `$lib/runtime/loop.server`.
 *
 * So on this path the tool could only ever tell the model it had "loaded N tools for the
 * next round" that were already in its tools array — costing a round, a tool definition in
 * every request, and the model's trust in what its prompt tells it. Unregistering it here
 * leaves the old loop's copy working, because subagents there genuinely need the escape
 * hatch; when `$lib/runtime` goes (#5, #8) the tool goes with it.
 *
 * `run_code` is excluded for a blunter reason: on this path it cannot run at all.
 * `runCodeTool` throws unless `toolUserContext` carries a `runtime` — it needs
 * `currentToolNames()` to decide what the script may call and a `session` to route the
 * approvals those nested calls go through — and the only code that ever supplies one is
 * `$lib/runtime/tool-handlers.server`. The engine passes a workspace with no runtime, so
 * every engine-path invocation ends at "run_code requires runtime context … It can only be
 * invoked from inside the chat loop."
 *
 * Registering it anyway cost a round every time the model believed the ~1,200-character
 * description advertising it, and cost that description in the tool definitions of every
 * single request. Unregistering does not remove a capability; it stops advertising one that
 * was never here. Restoring it properly means giving the engine path its own approval route
 * for nested calls, which is its own piece of work.
 *
 * `run_subagent` is excluded because it has been replaced, not removed. Delegation is the
 * SDK's `Task` tool now, against the agents `./agent-definitions.server` describes in the
 * system prompt. The in-house tool dispatched by `agentId` — a uuid nothing ever put in the
 * model's context — so it could name an agent only by guessing one; the SDK's names every
 * agent it offers. Keeping both would give the model two ways to delegate, one of which
 * renders a nested transcript and one of which does not.
 */
export const ENGINE_EXCLUDED_TOOLS: ReadonlySet<string> = new Set(['search_tools', 'run_code', 'run_subagent'])
