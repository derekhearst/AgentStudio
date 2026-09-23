/**
 * A run's tool scope: which tools an agent with a fixed surface may call at all.
 *
 * ## Why this is not `Options.allowedTools`
 *
 * The scoped list used to go to the SDK as `allowedTools`. The SDK documents that option as
 * "tool names that are auto-allowed without prompting … To restrict which tools are
 * available, use the `tools` option instead", and the CLI says so again at runtime: "Bare
 * allowedTools entries auto-approve the whole tool before the callback is consulted." So the
 * list did the opposite of what it was for, twice over:
 *
 *   - every tool ON it skipped `canUseTool`, which is where workspace containment, plan-mode
 *     refusals and the mandatory-approval gate lived — the read-only Research agent could
 *     `Read('/proc/self/environ')`, and the Plan agent's `request_plan_approval` switched the
 *     conversation's agent with no approval card;
 *   - every tool OFF it stayed available, so the "read-only" agents could still `Edit` and
 *     run `Bash`.
 *
 * Now the scope restricts, in three places that each cover a surface the others cannot:
 *
 *   `Options.tools`     the SDK built-ins that exist for this run (`scopeBuiltinTools`)
 *   `buildToolServer`   the in-house tools our MCP server registers (`scope.inHouse`)
 *   the PreToolUse hook refuses anything else that reaches it (`isToolInScope`) — a tool the
 *                       SDK adds on its own, or one from another MCP server
 *
 * and nothing is ever auto-approved, so every call still meets the gate.
 *
 * Names are compared as the CLI calls the tools today (`canonicalToolName`). An agent's list
 * may say `Task` or `KillShell`; the CLI accepts those as aliases, but the call itself
 * arrives as `Agent` or `TaskStop`, and a scope holding only the old spelling refused it.
 *
 * Pure and dependency-free apart from the name lists, so a spec can import it.
 */

import { BUILTIN_TOOL_SET, SUBAGENT_TOOL, canonicalToolName } from './builtin-tools'

export type ToolScope = {
	/** Every tool the run may call, by bare canonical name (our own MCP namespace stripped). */
	readonly allowed: ReadonlySet<string>
	/** The SDK built-ins among them, canonical and in the order given — what `Options.tools` receives. */
	readonly builtins: readonly string[]
	/** Our own registry tools among them — what the in-process MCP server registers. */
	readonly inHouse: ReadonlySet<string>
}

function isBuiltin(name: string): boolean {
	return BUILTIN_TOOL_SET.has(name) || name === SUBAGENT_TOOL
}

/**
 * Resolve a scoped tool list, or null for an unscoped run (every tool).
 *
 * `delegation` is whether the run was given agents to delegate to. Delegation is only
 * reachable through `Agent` (formerly `Task`), so a scoped run that was given agents gets it
 * too — otherwise the definitions are described in the prompt and the tool that uses them is
 * missing. Being in scope does not approve it: a delegation is still gated like any other call.
 */
export function resolveToolScope(
	names: readonly string[] | null | undefined,
	options: { delegation: boolean },
): ToolScope | null {
	if (!names) return null
	const builtins: string[] = []
	const inHouse = new Set<string>()
	for (const raw of names) {
		const name = canonicalToolName(String(raw ?? '').trim())
		if (!name) continue
		if (isBuiltin(name)) {
			if (!builtins.includes(name)) builtins.push(name)
		} else {
			inHouse.add(name)
		}
	}
	if (options.delegation && !builtins.includes(SUBAGENT_TOOL)) builtins.push(SUBAGENT_TOOL)
	return { allowed: new Set([...builtins, ...inHouse]), builtins, inHouse }
}

/** True when the run may call `bareName`, under either spelling. An unscoped run may call anything. */
export function isToolInScope(scope: ToolScope | null | undefined, bareName: string): boolean {
	if (!scope) return true
	return scope.allowed.has(canonicalToolName(bareName))
}

/**
 * The `Options.tools` value for a run: the scoped built-ins, or undefined to leave the SDK's
 * default set in place. An empty array is meaningful — "no built-ins at all" — and is what a
 * scope made only of in-house tools gets.
 */
export function scopeBuiltinTools(scope: ToolScope | null | undefined): string[] | undefined {
	return scope ? [...scope.builtins] : undefined
}
