/**
 * The whole allow / ask / deny decision for one tool call, in one place.
 *
 * Three things decide a call, and they used to be composed in two places that had drifted
 * apart: the engine's pending-block predicate consulted only the permission gate, while
 * `canUseTool` also applied containment — so a `Bash` call waiting on approval (no
 * bubblewrap on the host) was shown as already executing, and never got an Allow/Deny card.
 * Every caller now asks this function:
 *
 *   the PreToolUse hook   enforces it before the SDK's own allow rules and modes
 *   `canUseTool`          routes an 'ask' to the operator
 *   the assistant branch  decides which frame the UI gets (`tool_pending` or `tool_call`)
 *
 * Composition is by strictness, never by order of arrival: any 'deny' wins, then any 'ask',
 * and only a unanimous 'allow' allows. That keeps the invariants of each part intact when
 * they meet — containment cannot be waived by a mode (a mode says how much the operator
 * trusts the agent, never whether it may leave its workspace), and a mode's refusal is not
 * softened to a question by containment either: plan mode still refuses an unconfinable
 * `Bash` rather than asking about it.
 *
 * No database, no SvelteKit, so the spec can drive it directly. The one thing it reads is the
 * filesystem, through containment, which follows links to see where a path really leads.
 */

import { guardWorkspaceAccess, type BashPolicy, type GuardDecision } from './workspace-guard'
import { OWN_MCP_SERVER, resolveToolGate, type ConversationPermissionMode, type ToolGateDecision } from './permission-mode'
import { isToolInScope, type ToolScope } from './tool-scope'
import { connectorCallVerdict, type McpProvenance, type RunMcpConnectors } from './mcp-connectors'
import { HOST_OWNED_TOOLS } from './builtin-tools'

export type ToolDecisionContext = {
	mode: ConversationPermissionMode
	/** Whether the per-tool settings alone require approval for this (bare) name. */
	settingsRequiresApproval: (bareName: string) => boolean
	/** The run's workspace. Null only for a run that touches no filesystem — see the engine. */
	workspaceRoot: string | null
	bashPolicy: BashPolicy
	/** The agent's fixed tool surface, or null for every tool. */
	scope?: ToolScope | null
	/** Whether the project's committed `.claude/` configuration is loaded for this run. */
	projectConfigLoaded?: boolean
	/**
	 * The connectors this run was given (#17, `./mcp-connectors`) — an empty map when it was
	 * given none. With a map, a call to any other external server is refused and a call to one
	 * of these follows its row's per-tool policy. Omitted keeps the posture from before
	 * connectors existed: every external tool asks.
	 */
	connectors?: RunMcpConnectors | null
}

function outOfScopeReason(name: string): string {
	return `${name} is not available to this agent. Its tool list is fixed; use one of the tools you were given.`
}

/**
 * Decide one call. `bareName` has our own MCP namespace stripped; anyone else's is kept.
 *
 * `provenance` is the SDK's report of which MCP server the call belongs to (`canUseTool`'s
 * `mcpServer`, the hook's `mcp_server`): null when the SDK reported none, undefined when
 * nothing has been reported yet — see `connectorCallVerdict`.
 */
export function decideToolCall(
	ctx: ToolDecisionContext,
	bareName: string,
	toolInput: unknown,
	provenance?: McpProvenance | null,
): ToolGateDecision {
	if (!isToolInScope(ctx.scope, bareName)) return { gate: 'deny', reason: outOfScopeReason(bareName) }

	// Our own server is the one in-process server we register, so the SDK reports it as `sdk`.
	// Our name from anywhere else is a configured server wearing it (#17). Checked before the
	// host-owned exemption below, which is keyed on a bare name that such a call would share.
	if (provenance && provenance.name === OWN_MCP_SERVER && provenance.source !== 'sdk') {
		return {
			gate: 'deny',
			reason: "This call names AgentStudio's own tool server but came from a different one, so it is refused.",
		}
	}
	const connector = ctx.connectors ? connectorCallVerdict(ctx.connectors, bareName, provenance) : null
	if (connector?.kind === 'refused') return { gate: 'deny', reason: connector.reason }

	// A question to the user (#4) is answered by the user, in its own card: there is nothing
	// for an approval setting or a mode to add, and plan mode is exactly when it is wanted.
	// `canUseTool` hands it to the host before this answer is ever acted on. A connector's
	// tool never lands here: its name keeps its `mcp__<server>__` prefix.
	if (HOST_OWNED_TOOLS.has(bareName)) return { gate: 'allow', reason: null }

	const containment: GuardDecision = ctx.workspaceRoot
		? guardWorkspaceAccess({
				toolName: bareName,
				toolInput,
				workspaceRoot: ctx.workspaceRoot,
				bashPolicy: ctx.bashPolicy,
				projectConfigLoaded: ctx.projectConfigLoaded,
			})
		: { verdict: 'allow' }

	const gate = resolveToolGate({
		mode: ctx.mode,
		toolName: bareName,
		settingsRequiresApproval: ctx.settingsRequiresApproval(bareName),
		...(connector?.kind === 'policy' ? { externalPolicy: connector.policy } : {}),
	})

	if (containment.verdict === 'deny') return { gate: 'deny', reason: containment.reason }
	if (gate.gate === 'deny') return gate
	if (containment.verdict === 'ask') {
		// The gate's own reason wins when it has one — the mandatory-approval explanation is
		// the more important thing for the operator to read.
		return { gate: 'ask', reason: gate.gate === 'ask' && gate.reason ? gate.reason : containment.reason }
	}
	return gate
}
