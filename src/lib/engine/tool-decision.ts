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
 * Pure: no database, no SvelteKit, so the spec can drive it directly.
 */

import { guardWorkspaceAccess, type BashPolicy, type GuardDecision } from './workspace-guard'
import { resolveToolGate, type ConversationPermissionMode, type ToolGateDecision } from './permission-mode'
import { isToolInScope, type ToolScope } from './tool-scope'

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
}

function outOfScopeReason(name: string): string {
	return `${name} is not available to this agent. Its tool list is fixed; use one of the tools you were given.`
}

/** Decide one call. `bareName` has our own MCP namespace stripped; anyone else's is kept. */
export function decideToolCall(ctx: ToolDecisionContext, bareName: string, toolInput: unknown): ToolGateDecision {
	if (!isToolInScope(ctx.scope, bareName)) return { gate: 'deny', reason: outOfScopeReason(bareName) }

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
