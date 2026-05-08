/**
 * Web-facing tool handlers: search, fetch, PDF read, browser screenshot.
 *
 * `web_search` logs a per-call usage row so operators can budget paid-search backends
 * (SearXNG defaults to $0/call). The other handlers delegate to `web-fetch.server.ts`
 * and `sandbox-browser.server.ts`.
 */

import { toolSchemas } from '../tool-schemas'
import { webSearch } from '../web-search.server'
import { webFetch, pdfRead } from '../web-fetch.server'
import { sandboxBrowserNavigate, sandboxBrowserScreenshot, toolUserContext } from '../sandbox.server'
import { getSearchCostPerCall, getSearxngUrl } from '$lib/server/config'
import { logToolUsage } from '$lib/costs/usage'
import { logger } from '$lib/observability/logger'
import type { ToolHandler } from '../handler-types'

export const webHandlers: Record<string, ToolHandler> = {
	web_search: async (call, { startedAt }) => {
		const input = toolSchemas.web_search.parse(call.arguments)
		const ctx = toolUserContext.getStore()
		const result = await webSearch(input.query)
		// Phase 2 ledger: log every web_search as 1 call. SEARCH_COST_PER_CALL_USD lets
		// operators set a per-call cost (e.g. for paid backends like Serper); SearXNG is
		// self-hosted so cost defaults to 0 but the call count is still tracked.
		const costPerCall = getSearchCostPerCall()
		void logToolUsage({
			toolName: 'web_search',
			provider: getSearxngUrl() ? 'searxng' : null,
			unitType: 'call',
			units: 1,
			cost: costPerCall,
			userId: ctx?.userId ?? null,
			runId: ctx?.runId ?? null,
			metadata: { query: input.query.slice(0, 240), resultCount: result.length },
		}).catch((err) => logger.warn('[tool-usage] web_search log failed', { err }))
		return {
			success: true,
			tool: call.name,
			input,
			result,
			executionMs: Date.now() - startedAt,
		}
	},

	browser_screenshot: async (call, { startedAt }) => {
		const input = toolSchemas.browser_screenshot.parse(call.arguments)
		if (input.url) {
			await sandboxBrowserNavigate(input.url)
		}
		const buffer = await sandboxBrowserScreenshot()
		return {
			success: true,
			tool: call.name,
			input,
			result: {
				mimeType: 'image/png',
				imageBase64: buffer.toString('base64'),
			},
			executionMs: Date.now() - startedAt,
		}
	},

	web_fetch: async (call, { startedAt }) => {
		const input = toolSchemas.web_fetch.parse(call.arguments)
		const result = await webFetch(input.url, input.maxChars)
		return {
			success: true,
			tool: call.name,
			input,
			result,
			executionMs: Date.now() - startedAt,
		}
	},

	pdf_read: async (call, { startedAt }) => {
		const input = toolSchemas.pdf_read.parse(call.arguments)
		const result = await pdfRead(input.source, input.maxChars)
		return {
			success: true,
			tool: call.name,
			input,
			result,
			executionMs: Date.now() - startedAt,
		}
	},
}
