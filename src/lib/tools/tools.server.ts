/**
 * Tool registry barrel + the central `executeTool` dispatcher.
 *
 * Per-tool handlers live in `handlers/<domain>.server.ts` and are merged into a single
 * `TOOL_HANDLERS` map in `handlers/index.ts`. `executeTool` runs the matched handler
 * inside the `toolUserContext` AsyncLocalStorage so handlers can read the per-run
 * workspace + runtime context without it being threaded through every call.
 *
 * Convenience wrappers (webSearch / webFetch / pdfRead / generateImage) are re-exported
 * here so external callers (research-runner, MCP endpoint, etc.) keep their existing
 * imports.
 */

import { z } from 'zod'
import {
	toolSchemas,
	toolDescriptions,
	toolExamples,
	toolDisclosure,
	allToolNames,
	normalizeToolName,
	type ToolName,
} from './tool-schemas'
import {
	toolUserContext,
	type WorktreeStoreConfig,
	type ToolRuntimeContext,
} from './sandbox.server'
import { stat } from 'node:fs/promises'
import { getSandboxRoot } from '$lib/server/config'
import { TOOL_HANDLERS } from './handlers'
import type { ToolCall, ToolCallWithContext } from './tool-call'

// Re-export the registered tool implementations that are also imported directly by
// non-loop callers (research-runner, etc).
export { webSearch } from './web-search.server'
export { generateImage } from './image-gen.server'
export { webFetch, pdfRead } from './web-fetch.server'
export { browserClose } from './sandbox-browser.server'
export { toolSchemas, allToolNames, type ToolName } from './tool-schemas'
export type { ToolCall, ToolCallWithContext } from './tool-call'
export { normalizeToolName }

/** Read the sandbox root and verify it's a directory. Surfaced via /settings. */
export async function getSandboxStatus() {
	const workspace = getSandboxRoot()
	try {
		const s = await stat(workspace)
		return {
			success: s.isDirectory(),
			message: s.isDirectory()
				? 'Sandbox workspace accessible'
				: 'Sandbox workspace path is not a directory',
			stats: { workspace, isDirectory: s.isDirectory() },
		}
	} catch {
		return {
			success: false,
			message: `Sandbox workspace not found: ${workspace}`,
			stats: null,
		}
	}
}

function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
	return z.toJSONSchema(schema) as Record<string, unknown>
}

/**
 * Build OpenAI-style tool definitions. When `onlyTools` is passed, the result is filtered to
 * exactly that set (used for agents with a fixed `allowedTools` policy). Otherwise we apply the
 * Tool Search Tool tier filter:
 *
 *   - `disclosure: 'always'` tools are always included.
 *   - `disclosure: 'searchable'` tools are included only if their name is in `loadedSearchable`,
 *     which the runtime maintains per-run (search_tools side-effect → next-round refresh).
 *
 * Pass `tierFilter: false` to ignore tiers entirely (returns the whole registry — currently used
 * by the MCP endpoint, which exposes the full surface to external clients).
 */
export function getToolDefinitions(
	onlyTools?: ToolName[],
	options?: { tierFilter?: boolean; loadedSearchable?: ReadonlySet<string> },
) {
	const tierFilter = options?.tierFilter !== false
	const loadedSearchable = options?.loadedSearchable

	const entries = onlyTools
		? Object.entries(toolSchemas).filter(([name]) => onlyTools.includes(name as ToolName))
		: Object.entries(toolSchemas).filter(([name]) => {
				if (!tierFilter) return true
				const tier = toolDisclosure[name as ToolName]
				if (tier === 'always') return true
				if (tier === 'searchable') return loadedSearchable?.has(name) ?? false
				return false
			})

	return entries.map(([name, schema]) => {
		const examples = toolExamples[name as ToolName]
		return {
			type: 'function' as const,
			function: {
				name,
				description: toolDescriptions[name as ToolName],
				parameters: zodToJsonSchema(schema),
				// Anthropic-style `input_examples`. Other providers ignore unknown fields.
				// OpenRouter forwards extras on tool defs through to the upstream provider.
				...(examples && examples.length > 0 ? { input_examples: examples } : {}),
			},
		}
	})
}

export type WorkspaceOptions = {
	persistentKey?: string | null
	worktree?: WorktreeStoreConfig | null
	/**
	 * Project ID for project-bound chat runs. The chat-loop entry point reads this from
	 * `conversations.projectId` and passes it through. Surfaces in the AsyncLocalStorage
	 * so workspace resolution lands the cwd at `<sandbox>/<userId>/projects/<projectId>`.
	 */
	projectId?: string | null
	/**
	 * Optional runtime hooks for tools that need to dispatch nested calls (currently `run_code`).
	 * The loop populates this; standalone callers (MCP HTTP endpoint, automations) pass nothing
	 * and run_code falls back to a no-session, empty-approval-set, all-tools-enabled mode.
	 */
	runtime?: ToolRuntimeContext | null
}

/**
 * Central tool execution. Looks up the handler in the `TOOL_HANDLERS` dispatch table,
 * runs it inside the per-call `toolUserContext` so handlers can read the per-run
 * workspace + runtime context. Catches handler exceptions and converts them into the
 * standard `success: false` shape.
 */
export async function executeTool(
	call: ToolCall,
	userId: string,
	runId?: string | null,
	workspace?: WorkspaceOptions,
) {
	return toolUserContext.run(
		{
			userId,
			runId: runId ?? null,
			persistentKey: workspace?.persistentKey ?? null,
			worktree: workspace?.worktree ?? null,
			projectId: workspace?.projectId ?? null,
			runtime: workspace?.runtime ?? null,
		},
		async () => {
			const startedAt = Date.now()
			const normalizedName = normalizeToolName(call.name)
			if (!normalizedName) {
				return {
					success: false,
					tool: call.name,
					error: `Unknown tool: ${call.name}`,
					executionMs: Date.now() - startedAt,
				}
			}
			const handler = TOOL_HANDLERS[normalizedName]
			if (!handler) {
				return {
					success: false,
					tool: normalizedName,
					error: `Tool is not implemented: ${normalizedName}`,
					executionMs: Date.now() - startedAt,
				}
			}
			const normalizedCall: ToolCall = { name: normalizedName, arguments: call.arguments }
			try {
				return await handler(normalizedCall, {
					userId,
					runId: runId ?? null,
					startedAt,
				})
			} catch (error) {
				return {
					success: false,
					tool: normalizedName,
					error: error instanceof Error ? error.message : 'Tool execution failed',
					executionMs: Date.now() - startedAt,
				}
			}
		},
	)
}

export type AskUserQuestion = z.infer<typeof toolSchemas.ask_user>['questions'][number]
export type AskUserAnswers = Record<string, string>
