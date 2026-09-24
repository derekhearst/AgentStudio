/**
 * Turns a chat run's model choice into Claude Agent SDK options.
 *
 * Two backends, one engine:
 *
 *   Claude      → no auth override. The SDK spawns the Claude Code CLI, which
 *                 uses its own OAuth login, so these runs are on the
 *                 subscription and cost nothing per token.
 *
 *   Everything  → ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN pointed at a gateway
 *   else          that serves the Anthropic Messages API (LiteLLM et al). Same
 *                 agent loop, same tools, different model behind it.
 *
 * Either way the CLI gets an allow-listed environment, never the server's own — see
 * `./engine-env`.
 *
 * The two are mutually exclusive per run: a gateway authenticates with its own
 * key, so a proxied run is not on the subscription. That's a per-conversation
 * switch, not something to blend.
 */

import type { EffortLevel, Options, ThinkingConfig } from '@anthropic-ai/claude-agent-sdk'
import { DISALLOWED_BUILTIN_TOOLS } from './builtin-tools'
import { resolveSettingSources } from './setting-sources'
import { buildEngineEnv, engineAuthEnvNames } from './engine-env'
import { engineSandboxSettings } from './engine-sandbox'
import { ASK_USER_QUESTION_SETTINGS, ASK_USER_QUESTION_TOOL_CONFIG } from './ask-user-question'
import { scopeBuiltinTools, type ToolScope } from './tool-scope'
import type { EngineAgentDefinition } from './agent-definitions'
import { env } from '$env/dynamic/private'
import { buildToolServer, ENGINE_MCP_SERVER, type ToolServerContext } from './tools.server'
import { bubblewrapAvailable } from '$lib/tools/sandbox-exec.server'
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
	/**
	 * The agent's fixed tool surface, from `./tool-scope`. Omit for every tool. This
	 * restricts; it is never handed to the SDK as `allowedTools`, which auto-approves.
	 */
	toolScope?: ToolScope | null
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
	/**
	 * Whether this run's project has its committed settings marked trusted
	 * (`projects.settings_trusted`). Decides whether the repo's `CLAUDE.md`, commands and
	 * skills load — and, inseparably, its `.claude/settings.json`. See `./setting-sources`.
	 *
	 * Omitted means untrusted, which is the posture every run had before this option
	 * existed in name, though not the one it had in fact.
	 */
	projectSettingsTrusted?: boolean | null
	/**
	 * The agents this run may delegate to, keyed by the name a `Task` call gives (#5).
	 * Built by `./agent-definitions.server`. Omitted or empty means no delegation — the
	 * SDK's own general-purpose agent is still reachable, but nothing of ours is.
	 */
	agents?: Record<string, EngineAgentDefinition>
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

	return buildEngineEnv(process.env, {
		ANTHROPIC_BASE_URL: baseUrl,
		ANTHROPIC_AUTH_TOKEN: token,
		ANTHROPIC_MODEL: model,
	})
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

// Built-in tool names live in `./builtin-tools` so they can be imported without `$env`.
// Re-exported because this module has always been where callers look for them.
export {
	BUILTIN_FILE_TOOLS,
	BUILTIN_SHELL_TOOLS,
	BUILTIN_TOOL_SET,
	DISALLOWED_BUILTIN_TOOLS,
	SUBAGENT_TOOL,
} from './builtin-tools'

/**
 * Whether the SDK's OS sandbox can run here. Linux only: it is built on bubblewrap, which
 * the production image installs and a developer box generally does not.
 *
 * `SANDBOX_DISABLED=1` is an escape hatch for debugging a container where bubblewrap is
 * present but broken. It downgrades Bash to approval-gated rather than unconfined, because
 * `resolveBashPolicy` reads the same signal.
 */
export function sandboxAvailable(): boolean {
	if (process.env.SANDBOX_DISABLED === '1') return false
	// Probe, never assume. A platform check said "linux, therefore sandboxed" and took
	// production chat down: `failIfUnavailable` defaults to true, so when bubblewrap could
	// not initialise inside the container every query() failed in under two seconds with no
	// output at all. `bubblewrapAvailable()` actually runs `bwrap --version` and caches it.
	return bubblewrapAvailable()
}

export function buildEngineOptions(input: EngineOptionsInput): Options {
	const claude = isClaudeModel(input.model)
	const sdkModel = claude ? normalizeModelId(input.model) : input.model
	const proxyEnv = claude ? undefined : gatewayEnv(input.model)

	if (!claude && !proxyEnv) throw new GatewayNotConfiguredError(input.model)
	const cliEnv = proxyEnv ?? buildEngineEnv(process.env)
	const cliAuthEnv = engineAuthEnvNames(cliEnv)
	const scopedBuiltins = scopeBuiltinTools(input.toolScope)

	const { thinking, effort } = resolveThinking(input.reasoningEffort)

	const agents = input.agents && Object.keys(input.agents).length > 0 ? input.agents : null

	// Second application of the same rule the caller should already have applied. Idempotent,
	// and it means no future caller can hand the SDK a bypass it is not entitled to.
	const effectiveMode = resolveEffectivePermissionMode({
		requested: input.permissionMode,
		runSource: input.runSource ?? 'chat_stream',
	})

	const settingSources = resolveSettingSources({
		settingsTrusted: input.projectSettingsTrusted,
		hasWorkspace: Boolean(input.cwd),
	})

	return {
		model: sdkModel,
		thinking,
		...(effort ? { effort } : {}),
		mcpServers: { [ENGINE_MCP_SERVER]: buildToolServer(input.tools, input.toolScope?.inHouse) },
		/*
		 * A scoped run restricts: `tools` is the SDK's availability list for its built-ins, and
		 * the MCP server above registers only the scoped in-house tools. `allowedTools` is
		 * never set — the SDK treats it as "auto-approve without asking", which skipped every
		 * gate for the very tools a read-only agent was scoped to. See `./tool-scope`.
		 */
		...(scopedBuiltins ? { tools: scopedBuiltins } : {}),
		disallowedTools: [...DISALLOWED_BUILTIN_TOOLS],
		/*
		 * Always set, never omitted. The SDK reads an omitted `settingSources` as "load
		 * everything", so leaving it off silently merged any repo-committed
		 * `.claude/settings.json` — `permissions.allow` and `env` included — into every run
		 * with a working directory. `./setting-sources` explains what each tier means here
		 * and why `local` and `user` are never among them.
		 */
		settingSources,
		...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
		permissionMode: sdkPermissionModeFor(effectiveMode.mode),
		/**
		 * OS-level confinement for Bash (#15). A command string cannot be checked for
		 * containment by reading it, so this is the only thing that actually confines one;
		 * `workspace-guard.ts` asks for approval instead wherever it is unavailable.
		 *
		 * `failIfUnavailable` is left at its default (true): if bubblewrap is missing the
		 * run fails loudly rather than quietly executing unsandboxed, which is the whole
		 * point. Enabled only on Linux — the image installs bubblewrap, a developer's
		 * machine may not have it, and a hard failure there would block local work.
		 *
		 * What the sandbox allows is `./engine-sandbox`'s, including the trusted project's
		 * configuration a shell may not rewrite.
		 */
		...(sandboxAvailable()
			? {
					sandbox: engineSandboxSettings({
						authEnvNames: cliAuthEnv,
						protectedProjectRoot: settingSources.includes('project') && input.cwd ? input.cwd : null,
					}),
				}
			: {}),
		maxTurns: input.maxTurns ?? 64,
		...(input.cwd ? { cwd: input.cwd } : {}),
		...(input.resumeSessionId ? { resume: input.resumeSessionId } : {}),
		// Needed for token-level `delta` frames; without it text only arrives in
		// whole-message chunks and the UI loses its typing effect.
		includePartialMessages: true,
		...(agents ? { agents } : {}),
		/*
		 * Without this the SDK forwards only a subagent's tool_use/tool_result blocks —
		 * "enough for a heartbeat counter", as its own docs put it. The subagent card shows
		 * what a delegated agent said, which is the half that is omitted by default; the
		 * routing in `./stream.server` keeps it out of the parent's reply.
		 *
		 * Set unconditionally rather than only when `agents` is non-empty: the SDK's own
		 * general-purpose agent is reachable through `Task` whether or not we define any,
		 * so a child transcript can appear either way.
		 */
		forwardSubagentText: true,
		/*
		 * #4 — the SDK's own AskUserQuestion, answered by the chat's question card through
		 * `canUseTool` (`./ask-user-question`): HTML option previews, and a question that never
		 * answers itself (`askUserQuestionTimeout: 'never'`, a Settings field, not an Option).
		 */
		toolConfig: ASK_USER_QUESTION_TOOL_CONFIG,
		settings: ASK_USER_QUESTION_SETTINGS,
		// Always set: omitted, the SDK hands the CLI the server's whole environment.
		env: cliEnv,
	}
}
