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

import type { Options, PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import { env } from '$env/dynamic/private'
import { buildToolServer, ENGINE_MCP_SERVER, qualifiedToolName, type ToolServerContext } from './tools.server'

/** Models that run natively on the Claude Code CLI login. */
const CLAUDE_MODEL_PREFIXES = ['claude-', 'opus', 'sonnet', 'haiku']

export function isClaudeModel(model: string): boolean {
	const normalized = model.toLowerCase()
	return CLAUDE_MODEL_PREFIXES.some((p) => normalized.startsWith(p))
}

export type EngineOptionsInput = {
	model: string
	tools: ToolServerContext
	/** Tool names (bare) the run is allowed to call. Omit for all of them. */
	allowedTools?: string[]
	systemPrompt?: string
	permissionMode?: PermissionMode
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

export function buildEngineOptions(input: EngineOptionsInput): Options {
	const claude = isClaudeModel(input.model)
	const proxyEnv = claude ? undefined : gatewayEnv(input.model)

	if (!claude && !proxyEnv) throw new GatewayNotConfiguredError(input.model)

	return {
		model: input.model,
		mcpServers: { [ENGINE_MCP_SERVER]: buildToolServer(input.tools) },
		...(input.allowedTools ? { allowedTools: input.allowedTools.map(qualifiedToolName) } : {}),
		...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
		permissionMode: input.permissionMode ?? 'default',
		maxTurns: input.maxTurns ?? 64,
		...(input.cwd ? { cwd: input.cwd } : {}),
		...(input.resumeSessionId ? { resume: input.resumeSessionId } : {}),
		// Needed for token-level `delta` frames; without it text only arrives in
		// whole-message chunks and the UI loses its typing effect.
		includePartialMessages: true,
		...(proxyEnv ? { env: proxyEnv } : {}),
	}
}
