/**
 * #19 — per-conversation permission mode.
 *
 * The pure half: no database, no SvelteKit, no `node:` imports, no `$lib` aliases, so the
 * unit spec (`tests/engine.permission-mode.spec.ts`) can import it directly without a dev
 * server or Postgres — same arrangement as `$lib/monitors/condition` and
 * `$lib/chat/agent-tool-filter`.
 *
 * Approval used to be a single global, per-tool setting: `settings.toolConfig.approvalRequiredTools`
 * plus the `MANDATORY_APPROVAL_TOOLS` allowlist. That says nothing about *this* session. A
 * conversation now also carries a mode, persisted on `conversations.permission_mode` and
 * changeable mid-session:
 *
 *   default            today's behaviour — the per-tool settings decide.
 *   plan               no writes. Every mutating capability is denied with a message telling
 *                      the model to produce a plan instead.
 *   acceptEdits        file edits are auto-approved; everything else is still gated.
 *   bypassPermissions  everything is auto-approved EXCEPT the mandatory-approval tools.
 *
 * ── The invariant ──────────────────────────────────────────────────────────────────────
 *
 * The mandatory-approval tools (`push_branch`, `create_pull_request`, `request_plan_approval`)
 * are gated in EVERY mode, bypass included. `resolveToolGate` checks that capability first and
 * returns before any mode branch runs, and `tests/engine.permission-mode.spec.ts` pins it
 * across the full mode × settings cross product. Nothing below this line may reorder that.
 *
 * ── Capabilities, not tool names ───────────────────────────────────────────────────────
 *
 * Issue #15 replaces the in-house tool registry with the SDK's built-in tools, which renames
 * every literal the approval layer keys on. So the gate keys on a *capability set* derived
 * from the tool name, and `TOOL_CAPABILITY_RULES` carries both the in-house names and the
 * SDK's built-in names. An unrecognised tool falls through to `mutate`, which fails closed:
 * denied in plan mode, never auto-approved in acceptEdits.
 */

// ─────────── Modes ───────────

export const PERMISSION_MODES = ['default', 'plan', 'acceptEdits', 'bypassPermissions'] as const

export type ConversationPermissionMode = (typeof PERMISSION_MODES)[number]

export const PERMISSION_MODE_LABELS: Record<ConversationPermissionMode, string> = {
	default: 'Ask',
	plan: 'Plan only',
	acceptEdits: 'Accept edits',
	bypassPermissions: 'Bypass',
}

export const PERMISSION_MODE_DESCRIPTIONS: Record<ConversationPermissionMode, string> = {
	default: 'Per-tool approval settings decide what needs a confirmation.',
	plan: 'Read-only. Writes and side effects are refused; the agent produces a plan instead.',
	acceptEdits: 'File edits run without asking. Everything else is still gated.',
	bypassPermissions:
		'Nothing is gated except pushes, pull requests and plan handoffs. Leave this on and the agent acts unsupervised.',
}

/** The one mode that needs an explicit confirmation before it can be set. */
export const CONFIRM_REQUIRED_MODES: readonly ConversationPermissionMode[] = ['bypassPermissions']

export function requiresExplicitConfirm(mode: ConversationPermissionMode): boolean {
	return CONFIRM_REQUIRED_MODES.includes(mode)
}

export function isPermissionMode(value: unknown): value is ConversationPermissionMode {
	return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value)
}

/** Fail closed: anything unrecognised is `default`, never a looser mode. */
export function normalizePermissionMode(value: unknown): ConversationPermissionMode {
	return isPermissionMode(value) ? value : 'default'
}

// ─────────── Run surface ───────────

/**
 * Mirrors `chat_run_source` in `$lib/runs/runs.schema`. Duplicated as a string union rather
 * than imported so this module stays free of `$lib` (and therefore of drizzle).
 */
export type RunSurface = 'chat_stream' | 'agent_subagent' | 'automation'

/** The only surface with an operator on the other end who can answer an approval prompt. */
export const INTERACTIVE_RUN_SURFACE: RunSurface = 'chat_stream'

export type EffectivePermissionMode = {
	mode: ConversationPermissionMode
	/** True when the requested mode was refused and something stricter was substituted. */
	downgraded: boolean
	/** Operator-facing explanation for the downgrade, null when nothing was refused. */
	reason: string | null
}

/**
 * Refuse `bypassPermissions` outside an interactive chat run.
 *
 * This is the same rule `push_branch` / `create_pull_request` already enforce in
 * `$lib/tools/handlers/source-control.server.ts` (`assertInteractiveChatSurface`): a run whose
 * `chat_runs.source` is not `chat_stream` — a detached sub-agent or an automation on a timer —
 * has no operator to approve anything, so the dangerous option is not available to it. The
 * wording deliberately echoes that helper's.
 *
 * A downgrade, not a hard error: the automation still runs, it just runs under `default`.
 */
export function resolveEffectivePermissionMode(input: {
	requested: unknown
	runSource: RunSurface | string | null | undefined
}): EffectivePermissionMode {
	const requested = normalizePermissionMode(input.requested)
	if (requested !== 'bypassPermissions') return { mode: requested, downgraded: false, reason: null }
	if (input.runSource === INTERACTIVE_RUN_SURFACE) {
		return { mode: requested, downgraded: false, reason: null }
	}
	return {
		mode: 'default',
		downgraded: true,
		reason: `bypassPermissions cannot run in a ${input.runSource ?? 'detached'} context. It requires operator approval through an interactive chat run; this run falls back to the default permission mode.`,
	}
}

// ─────────── Capabilities ───────────

/**
 * What a tool can do, as far as the approval layer cares.
 *
 * A tool carries a *set* of these: `file_write` is both `write-file` (so acceptEdits can
 * auto-approve it) and `plan-authoring` (so plan mode can let the Plan agent write the plan
 * file it has to hand to `request_plan_approval`).
 */
export type ToolCapability =
	/** Observes the world without changing it. */
	| 'read'
	/** Creates, edits, moves or deletes a file in the workspace. */
	| 'write-file'
	/** Any other side effect: a shell command, an HTTP write, a row in the database. */
	| 'mutate'
	/** Blast radius outside AgentStudio. Gated in every mode — see the invariant above. */
	| 'mandatory-approval'
	/** Part of the write-a-plan → hand-off loop, so plan mode has to leave a door open. */
	| 'plan-authoring'
	/**
	 * Served by an MCP server that is not ours (#17). Carries no assumption about what the
	 * tool does, because nothing here can know: the server chose both its own namespace and
	 * its tool names.
	 */
	| 'external'

export type ToolCapabilityRule = {
	/** Matched against the bare tool name, case-insensitively. */
	match: RegExp
	capabilities: readonly ToolCapability[]
	note?: string
}

/**
 * Ordered — first match wins. Each rule lists the in-house registry names AND the SDK
 * built-in names #15 will swap them for, so the classification survives the rename without
 * anyone having to remember this file exists.
 */
export const TOOL_CAPABILITY_RULES: readonly ToolCapabilityRule[] = [
	// 1. Mandatory approval. Checked first so nothing below can reclassify these.
	//    In-house: push_branch, create_pull_request, request_plan_approval.
	//    #15 has no built-in equivalent — a push becomes a `Bash` call, which is why the
	//    handlers also refuse outside an interactive run (defence in depth, not the gate).
	{
		match: /^(push_branch|create_pull_request|request_plan_approval)$/i,
		capabilities: ['mutate', 'mandatory-approval', 'plan-authoring'],
		note: 'MANDATORY_APPROVAL_TOOLS — gated in every mode, bypass included.',
	},
	{
		match: /(^|_)(push)(_|$)|^(create|open)_pull_request$|plan_approval/i,
		capabilities: ['mutate', 'mandatory-approval'],
		note: 'Shape-match fallback so a rename inside the same family stays mandatory.',
	},

	// 2. Plan authoring. `file_write` is the one write a read-only posture gets, exactly as
	//    READ_ONLY_TOOL_NAMES in $lib/agents/builtin-agents.server.ts already allows it: the
	//    Plan agent has to put PLAN.md on disk before request_plan_approval can point at it.
	{
		match: /^(file_write|write|exit_?plan_?mode)$/i,
		capabilities: ['write-file', 'mutate', 'plan-authoring'],
		note: 'file_write (in-house) / Write, ExitPlanMode (#15 built-ins).',
	},

	// 3. Read-only. Before the write rules so `file_read` is not caught by /^file_/.
	{
		match: /^(file_read|file_info|list_directory|search_files|web_search|web_fetch|pdf_read|browser_screenshot|git_status|git_log|git_diff|search_tools|ask_user)$/i,
		capabilities: ['read'],
	},
	{
		match: /^(read|glob|grep|websearch|webfetch|notebookread|todoread)$/i,
		capabilities: ['read'],
		note: '#15 built-ins.',
	},
	{
		match: /^(list|get|read|search|describe|show|inspect|count|fetch)_/i,
		capabilities: ['read'],
		note: 'Naming-convention fallback: list_*/get_*/read_* are read-only by construction.',
	},

	// 3b. Delegation — `Agent`, which the CLI still also answers to as `Task`, so both are
	//     matched. Deliberately NOT read-only, though a delegation does nothing by
	//     itself: what it costs is decided by the child, and the child's own calls are only
	//     gated if they reach `canUseTool` — which this codebase has not established they
	//     do. `sdkPermissionModeFor` hands the SDK 'default' in plan mode, so nothing else
	//     is enforcing read-only either. Classifying delegation as a mutation means plan
	//     mode refuses it outright rather than allowing a channel whose contents it cannot
	//     see. Revisit as `read` once a child's tool call is observed reaching the gate.
	{
		match: /^(task|agent)$/i,
		capabilities: ['mutate'],
		note: 'SUBAGENT_TOOL — delegation is only as read-only as the agent it delegates to.',
	},

	// 4. File edits — what acceptEdits auto-approves.
	{
		match: /^(file_patch|file_replace|delete_file|move_file|copy_file)$/i,
		capabilities: ['write-file', 'mutate'],
	},
	{
		match: /^(edit|multiedit|notebookedit|applypatch|apply_patch)$/i,
		capabilities: ['write-file', 'mutate'],
		note: '#15 built-ins.',
	},
	{
		match: /(^|_)(write|edit|patch)(_|$)/i,
		capabilities: ['write-file', 'mutate'],
		note: 'Shape-match fallback for renamed file-mutating tools.',
	},
]

/**
 * Our own in-process MCP server's name. Must match `ENGINE_MCP_SERVER` in
 * `./tools.server`, and is duplicated rather than imported because that module reaches the
 * database and this one is imported by specs that run without one.
 */
export const OWN_MCP_SERVER = 'agentstudio'

/**
 * Split an MCP-qualified tool name into the server that serves it and the bare name.
 *
 * `server` is null for an unqualified name (an SDK built-in such as `Write`).
 */
export function parseToolNamespace(name: string): { server: string | null; bare: string } {
	const match = /^mcp__(.+?)__(.+)$/.exec(String(name ?? ''))
	if (match) return { server: match[1], bare: match[2] }
	return { server: null, bare: String(name ?? '') }
}

/** True when the name belongs to an MCP server that is not ours — see `'external'`. */
export function isExternalToolName(name: string): boolean {
	const { server } = parseToolNamespace(name)
	return server !== null && server !== OWN_MCP_SERVER
}

/**
 * Strip our own MCP namespace (`mcp__agentstudio__file_write` → `file_write`).
 *
 * Deliberately only ours. It used to strip *any* `mcp__*__` namespace, which meant a tool
 * from someone else's server could be renamed into one of our classifications: a server
 * publishing `mcp__whatever__file_read` had its name reduced to `file_read`, matched the
 * in-house read rule, and was classified read-only — in plan mode, allowed. A server picks
 * its own namespace and its own tool names, so a name is not evidence about behaviour, and
 * the capability rules below describe tools we wrote. See #17.
 */
export function stripToolNamespace(name: string): string {
	const { server, bare } = parseToolNamespace(name)
	return server === OWN_MCP_SERVER ? bare : String(name ?? '')
}

/**
 * Classify a tool. Unknown names fall through to `mutate`, which fails closed: denied in
 * plan mode and never auto-approved by acceptEdits.
 */
export function toolCapabilities(toolName: string): ReadonlySet<ToolCapability> {
	// Checked before the rules, not after: the rules match on shape, and a name from another
	// server is chosen by that server. `mutate` rides along so every mode that fails closed
	// on an unclassified tool keeps doing so.
	if (isExternalToolName(toolName)) return new Set<ToolCapability>(['external', 'mutate'])

	const bare = stripToolNamespace(String(toolName ?? '')).trim()
	for (const rule of TOOL_CAPABILITY_RULES) {
		if (rule.match.test(bare)) return new Set(rule.capabilities)
	}
	return new Set<ToolCapability>(['mutate'])
}

export function hasCapability(toolName: string, capability: ToolCapability): boolean {
	return toolCapabilities(toolName).has(capability)
}

/** Convenience for the callers that only care about the invariant. */
export function isMandatoryApprovalTool(toolName: string): boolean {
	return hasCapability(toolName, 'mandatory-approval')
}

// ─────────── The gate ───────────

export type ToolGate =
	/** Run it, no prompt. */
	| 'allow'
	/** Route it through the operator approval round-trip. */
	| 'ask'
	/** Refuse without asking; `reason` goes back to the model as the tool error. */
	| 'deny'

export type ToolGateDecision = {
	gate: ToolGate
	/** Present for `deny`, and for the mandatory case so the UI can say why it is unskippable. */
	reason: string | null
}

export type ToolGateInput = {
	mode: ConversationPermissionMode
	toolName: string
	/**
	 * What the per-tool settings alone would say: `settings.toolConfig.approvalRequiredTools`
	 * (or the `'*'` wildcard) as computed by `buildApprovalRequiredSet`. The mode composes
	 * with this rather than replacing it.
	 */
	settingsRequiresApproval: boolean
}

const MANDATORY_REASON =
	'This tool always requires operator approval, in every permission mode — its blast radius reaches outside AgentStudio.'

const EXTERNAL_REASON =
	'This tool comes from an MCP server you connected, not from AgentStudio. Nothing here can tell what it does from its name, so it asks every time.'

/**
 * The single decision point. Every caller — `canUseTool`, the pending-block predicate, the
 * HUD — derives its behaviour from this so there is one place to read and one place to test.
 */
export function resolveToolGate(input: ToolGateInput): ToolGateDecision {
	const capabilities = toolCapabilities(input.toolName)

	// ── The invariant. Nothing below may run before this. ──
	if (capabilities.has('mandatory-approval')) {
		return { gate: 'ask', reason: MANDATORY_REASON }
	}

	/*
	 * A tool from someone else's MCP server is always asked about (#17).
	 *
	 * Without this it fell to `settingsGate`, which allows unless the operator listed the
	 * tool in `approvalRequiredTools` — and they cannot list what they have never seen, as
	 * the settings UI enumerates our registry. So the default for a third-party tool would
	 * have been "run it". Asking is the only honest default for code we did not write and
	 * cannot classify.
	 *
	 * Two modes are excluded because they have a deliberate answer of their own, and both
	 * are stated here rather than left to fall out of the ordering:
	 *
	 *   plan               denies it below. An external tool carries `mutate` and not
	 *                      `read`, and plan mode refusing a possible write outright is
	 *                      stronger than asking about it.
	 *   bypassPermissions  allows it. That is what the mode is for, and it is already
	 *                      refused outside an interactive chat run.
	 *
	 * Written as an exclusion list rather than an inclusion list on purpose: a mode added
	 * later lands on `ask` rather than inheriting the settings gate's `allow`.
	 */
	if (capabilities.has('external') && input.mode !== 'plan' && input.mode !== 'bypassPermissions') {
		return { gate: 'ask', reason: EXTERNAL_REASON }
	}

	const settingsGate: ToolGateDecision = input.settingsRequiresApproval
		? { gate: 'ask', reason: null }
		: { gate: 'allow', reason: null }

	switch (input.mode) {
		case 'plan': {
			if (capabilities.has('read')) return settingsGate
			// The plan file itself is surfaced for approval rather than refused — plan mode has
			// to be able to hand a path to request_plan_approval — but it is never silent.
			if (capabilities.has('plan-authoring')) {
				return {
					gate: 'ask',
					reason: 'Plan mode is active: the only write it allows is the plan file, and it still needs your approval.',
				}
			}
			return {
				gate: 'deny',
				reason: `Plan mode is active for this conversation: "${stripToolNamespace(input.toolName)}" would change something, so it is refused. Write the plan out and ask the user to approve it (or to switch the conversation off plan mode) before acting.`,
			}
		}
		case 'acceptEdits':
			if (capabilities.has('write-file')) return { gate: 'allow', reason: null }
			return settingsGate
		case 'bypassPermissions':
			return { gate: 'allow', reason: null }
		case 'default':
		default:
			return settingsGate
	}
}

// ─────────── SDK mapping ───────────

/** The subset of the SDK's `PermissionMode` union this app is willing to emit. */
export type SdkPermissionMode = 'default' | 'acceptEdits' | 'plan'

/**
 * Map a conversation mode onto the mode handed to the Claude Agent SDK.
 *
 * `resolveToolGate` is the enforcement point, and it only gets a say through `canUseTool`.
 * So the rule here is: never hand the SDK a mode that would stop `canUseTool` being called
 * for a mandatory-approval tool.
 *
 *   default            → 'default'.
 *   plan               → 'default'. The SDK's plan mode enforces read-only over its *built-in*
 *                        tools; every AgentStudio tool is an MCP tool it knows nothing about,
 *                        and its auto-deny would also refuse the plan-file write the Plan agent
 *                        needs. Our gate denies every mutating capability instead, MCP tools
 *                        included. #15 should revisit this once the built-ins are the surface.
 *   acceptEdits        → 'acceptEdits'. Safe to pass through: the SDK only auto-accepts file
 *                        edits, and no mandatory-approval tool is a file edit.
 *   bypassPermissions  → 'default'. Passing it through would skip the permission prompt
 *                        entirely, `canUseTool` would never be called, and the mandatory gate
 *                        would silently vanish. The bypass is applied in `resolveToolGate`,
 *                        which auto-allows everything except the mandatory tools.
 *
 * Consequence worth stating out loud: this function never returns 'bypassPermissions', so
 * `allowDangerouslySkipPermissions` is never needed. The unit spec pins that.
 */
export function sdkPermissionModeFor(mode: ConversationPermissionMode): SdkPermissionMode {
	switch (mode) {
		case 'acceptEdits':
			return 'acceptEdits'
		case 'plan':
		case 'bypassPermissions':
		case 'default':
		default:
			return 'default'
	}
}

/** Short operator-facing summary, for the run HUD badge tooltip and the mode picker. */
export function describePermissionMode(mode: ConversationPermissionMode): string {
	return PERMISSION_MODE_DESCRIPTIONS[mode] ?? PERMISSION_MODE_DESCRIPTIONS.default
}
