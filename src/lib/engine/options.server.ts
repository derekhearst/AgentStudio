/**
 * Turns a chat run's model choice into Claude Agent SDK options.
 *
 * Two backends, one engine:
 *
 *   Claude      → no env override. The SDK spawns the Claude Code CLI, which
 *                 uses its own OAuth login, so these runs are on the
 *                 subscription and cost nothing per token.
 *
 *   Everything  → ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN pointed at a gateway
 *   else          that serves the Anthropic Messages API (LiteLLM et al). Same
 *                 agent loop, same tools, different model behind it.
 *
 * The two are mutually exclusive per run: a gateway authenticates with its own
 * key, so a proxied run is not on the subscription. That's a per-conversation
 * switch, not something to blend.
 */

import type { EffortLevel, Options, ThinkingConfig } from '@anthropic-ai/claude-agent-sdk'
import { env } from '$env/dynamic/private'
import { buildToolServer, ENGINE_MCP_SERVER, qualifiedToolName, type ToolServerContext } from './tools.server'
import {
	resolveEffectivePermissionMode,
	sdkPermissionModeFor,
	type ConversationPermissionMode,
	type EffectivePermissionMode,
	type RunSurface,
} from './permission-mode'

/** Models that run natively on the Claude Code CLI login. */
const CLAUDE_MODEL_PREFIXES = ['claude-', 'opus', 'sonnet', 'haiku']

/**
 * Strip an OpenRouter-style vendor prefix.
 *
 * Conversations created before the engine migration carry ids like
 * `anthropic/claude-sonnet-4`, because everything used to be routed through
 * OpenRouter. The Agent SDK wants the bare id. Without this, every pre-existing
 * Claude conversation looks like a third-party model and fails closed on the
 * gateway path.
 */
export function normalizeModelId(model: string): string {
	const slash = model.indexOf('/')
	if (slash === -1) return model
	const vendor = model.slice(0, slash).toLowerCase()
	return vendor === 'anthropic' ? model.slice(slash + 1) : model
}

export function isClaudeModel(model: string): boolean {
	const normalized = normalizeModelId(model).toLowerCase()
	return CLAUDE_MODEL_PREFIXES.some((p) => normalized.startsWith(p))
}

/** AgentStudio's six-level control mapped onto the SDK's five effort levels. */
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

const EFFORT_MAP: Record<Exclude<ReasoningEffort, 'none'>, EffortLevel> = {
	minimal: 'low',
	low: 'low',
	medium: 'medium',
	high: 'high',
	xhigh: 'xhigh',
}

/**
 * Current models take `thinking: {type:'adaptive'}` and control depth with
 * `effort`; the fixed token-budget form is deprecated. 'none' turns thinking
 * off outright, which also means no `reasoning` frames reach the UI.
 */
export function resolveThinking(effort: ReasoningEffort | undefined): {
	thinking: ThinkingConfig
	effort?: EffortLevel
} {
	if (!effort || effort === 'none') return { thinking: { type: 'disabled' } }
	// `display` defaults to 'omitted' on current models, which streams thinking
	// blocks with empty text — the UI would show a long pause and no reasoning.
	// 'summarized' is what makes the `reasoning` frames carry content.
	return { thinking: { type: 'adaptive', display: 'summarized' }, effort: EFFORT_MAP[effort] }
}

export type EngineOptionsInput = {
	model: string
	reasoningEffort?: ReasoningEffort
	tools: ToolServerContext
	/** Tool names (bare) the run is allowed to call. Omit for all of them. */
	allowedTools?: string[]
	systemPrompt?: string
	/**
	 * The conversation's own mode (`conversations.permission_mode`). Not the SDK's union —
	 * `sdkPermissionModeFor` decides what the SDK is actually told, and deliberately never
	 * emits `bypassPermissions`, because that would stop `canUseTool` being called and take
	 * the mandatory-approval gate with it. See `./permission-mode`.
	 */
	permissionMode?: ConversationPermissionMode
	/**
	 * `chat_runs.source` for this run. `bypassPermissions` is refused on anything but
	 * `chat_stream`, the same way `push_branch` is.
	 */
	runSource?: RunSurface
	maxTurns?: number
	cwd?: string
	/** Resume a prior SDK session instead of starting a new one. */
	resumeSessionId?: string
}

/**
 * Gateway env for non-Claude models. Returns undefined when the gateway isn't
 * configured, so the caller can fail loudly rather than silently falling back
 * to Claude and billing the wrong backend.
 */
function gatewayEnv(model: string): Record<string, string> | undefined {
	const baseUrl = env.LLM_GATEWAY_URL
	const token = env.LLM_GATEWAY_TOKEN
	if (!baseUrl || !token) return undefined

	return {
		...(process.env as Record<string, string>),
		ANTHROPIC_BASE_URL: baseUrl,
		ANTHROPIC_AUTH_TOKEN: token,
		ANTHROPIC_MODEL: model,
	}
}

export class GatewayNotConfiguredError extends Error {
	constructor(model: string) {
		super(
			`Model "${model}" needs an Anthropic-compatible gateway, but LLM_GATEWAY_URL / LLM_GATEWAY_TOKEN are not set.`,
		)
		this.name = 'GatewayNotConfiguredError'
	}
}

/**
 * Resolve the mode this run may actually use. Re-exported from the pure module so callers
 * have one import, and called again inside `buildEngineOptions` so a caller that forgets to
 * resolve still cannot smuggle `bypassPermissions` into an automation run.
 */
export function resolveRunPermissionMode(input: {
	requested: unknown
	runSource: RunSurface | string | null | undefined
}): EffectivePermissionMode {
	return resolveEffectivePermissionMode(input)
}

/**
 * Built-in SDK tools that replaced the in-house filesystem and shell registry entries (#15).
 *
 * Kept as data rather than inferred, because two layers have to agree with it: the
 * containment guard in `./workspace-guard`, which knows how each one names its path
 * argument, and the read-only agent allowlist.
 */
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

/** Membership test so the allowlist can carry both surfaces without qualifying built-ins. */
const BUILTIN_TOOL_SET: ReadonlySet<string> = new Set<string>([
	...BUILTIN_FILE_TOOLS,
	...BUILTIN_SHELL_TOOLS,
	'NotebookEdit',
	'TodoWrite',
])

export function buildEngineOptions(input: EngineOptionsInput): Options {
	const claude = isClaudeModel(input.model)
	const sdkModel = claude ? normalizeModelId(input.model) : input.model
	const proxyEnv = claude ? undefined : gatewayEnv(input.model)

	if (!claude && !proxyEnv) throw new GatewayNotConfiguredError(input.model)

	const { thinking, effort } = resolveThinking(input.reasoningEffort)

	// Second application of the same rule the caller should already have applied. Idempotent,
	// and it means no future caller can hand the SDK a bypass it is not entitled to.
	const effectiveMode = resolveEffectivePermissionMode({
		requested: input.permissionMode,
		runSource: input.runSource ?? 'chat_stream',
	})

	return {
		model: sdkModel,
		thinking,
		...(effort ? { effort } : {}),
		mcpServers: { [ENGINE_MCP_SERVER]: buildToolServer(input.tools) },
		// A scoped run names its in-house tools (MCP-qualified) plus the built-ins it may
		// use. An unscoped run omits allowedTools entirely, which is how the SDK expresses
		// "everything" — the built-ins are the filesystem surface now, so they must not be
		// filtered out by an allowlist that only knows MCP names.
		...(input.allowedTools
			? {
					allowedTools: [
						...input.allowedTools
							.filter((name) => !BUILTIN_TOOL_SET.has(name))
							.map(qualifiedToolName),
						...input.allowedTools.filter((name) => BUILTIN_TOOL_SET.has(name)),
					],
				}
			: {}),
		disallowedTools: [...DISALLOWED_BUILTIN_TOOLS],
		...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
		permissionMode: sdkPermissionModeFor(effectiveMode.mode),
		maxTurns: input.maxTurns ?? 64,
		...(input.cwd ? { cwd: input.cwd } : {}),
		...(input.resumeSessionId ? { resume: input.resumeSessionId } : {}),
		// Needed for token-level `delta` frames; without it text only arrives in
		// whole-message chunks and the UI loses its typing effect.
		includePartialMessages: true,
		...(proxyEnv ? { env: proxyEnv } : {}),
	}
}
