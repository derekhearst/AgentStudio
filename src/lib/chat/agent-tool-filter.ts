/**
 * Pure agent tool-policy resolver + filter.
 *
 * Lives in a non-server module so unit tests can import it without pulling in `$lib/db.server`
 * (which transitively imports `$app/environment`, unresolvable in the Playwright Node test
 * runner). The runtime calls these functions from chat-stream after fetching the agent row.
 *
 * Two policy shapes are supported:
 *  - `unrestricted`: no filtering (Chat, Autonomous built-ins; all user-created agents).
 *  - `readOnly`:     allowlist of tool names (Research + Plan built-ins). Allow-list shape so
 *                    newly added tools fail closed for these agents until explicitly audited.
 *
 * Malformed or missing config defaults to `unrestricted` — tool restrictions are opt-in;
 * agents without an explicit policy keep the legacy "all tools" surface.
 */

export type AgentToolPolicy = { kind: 'unrestricted' } | { kind: 'readOnly'; allow: ReadonlySet<string> }

export type AgentConfigLike = {
	toolPolicy?:
		| { kind?: string; allow?: unknown }
		| null
		| undefined
} | null | undefined

export function resolveAgentToolPolicy(config: AgentConfigLike): AgentToolPolicy {
	const raw = config?.toolPolicy
	if (!raw || typeof raw !== 'object') return { kind: 'unrestricted' }
	if (raw.kind === 'readOnly' && Array.isArray(raw.allow)) {
		const allow = new Set(raw.allow.filter((v): v is string => typeof v === 'string'))
		return { kind: 'readOnly', allow }
	}
	return { kind: 'unrestricted' }
}

export function filterToolsByAgentPolicy<T extends { function: { name: string } }>(
	tools: T[],
	policy: AgentToolPolicy,
): T[] {
	if (policy.kind === 'unrestricted') return tools
	return tools.filter((tool) => policy.allow.has(tool.function.name))
}

export function isToolAllowedByPolicy(toolName: string, policy: AgentToolPolicy): boolean {
	if (policy.kind === 'unrestricted') return true
	return policy.allow.has(toolName)
}
