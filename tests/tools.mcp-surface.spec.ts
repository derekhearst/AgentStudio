import { expect, test } from '@playwright/test'
import { authenticateContext, readEnvVar } from './helpers'
import { HOST_OWNED_TOOLS } from '../src/lib/engine/builtin-tools'
import { allToolNames } from '../src/lib/tools/tool-schemas'
import { CHAT_RUN_ONLY_TOOLS, MANDATORY_APPROVAL_TOOLS, mcpExposedToolNames } from '../src/lib/tools/tools'

/**
 * `/api/mcp` offers only the tools that can run there.
 *
 * The endpoint calls a tool with no chat run behind it. It used to list the whole registry,
 * so it advertised tools that always refuse without a run (#69 triage, step 0.3): `ask_user`
 * ("must be handled by chat streaming flow"), the mandatory-approval tools (nobody to press
 * Allow) and `set_project_context` (no conversation to bind).
 *
 * The first block is pure. The second calls the endpoint; nothing it calls writes.
 */

test.describe('mcp surface — which registry tools are offered', () => {
	test('the chat-run-only tools are named, and are real registry tools', () => {
		expect([...CHAT_RUN_ONLY_TOOLS].sort()).toEqual(
			['ask_user', 'create_pull_request', 'push_branch', 'request_plan_approval', 'set_project_context'].sort(),
		)
		// A stale name here would quietly re-expose the renamed tool.
		for (const name of CHAT_RUN_ONLY_TOOLS) expect(allToolNames, name).toContain(name)
	})

	test('they are derived from the engine and approval sets, not copied', () => {
		for (const name of HOST_OWNED_TOOLS) expect(CHAT_RUN_ONLY_TOOLS.has(name), name).toBe(true)
		for (const name of MANDATORY_APPROVAL_TOOLS) expect(CHAT_RUN_ONLY_TOOLS.has(name), name).toBe(true)
	})

	test('everything else in the registry stays exposed', () => {
		const exposed = mcpExposedToolNames()
		expect(exposed).toEqual(allToolNames.filter((name) => !CHAT_RUN_ONLY_TOOLS.has(name)))
		// run_subagent is off the chat engine (delegation is the SDK's Agent tool) but is a
		// stateless model call that works without a run, so MCP keeps it.
		for (const name of ['web_search', 'web_fetch', 'run_subagent', 'list_projects']) {
			expect(exposed, name).toContain(name)
		}
	})
})

test.describe('mcp surface — the endpoint', () => {
	async function rpc(page: import('@playwright/test').Page, method: string, params?: Record<string, unknown>) {
		const key = readEnvVar('MCP_API_KEY') ?? process.env.MCP_API_KEY
		const response = await page.request.post('/api/mcp', {
			data: { jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) },
			headers: key ? { Authorization: `Bearer ${key}` } : {},
		})
		expect(response.status()).toBe(200)
		return (await response.json()) as {
			result?: { tools?: Array<{ name: string }> }
			error?: { code: number; message: string }
		}
	}

	test('tools/list leaves out the chat-run-only tools', async ({ page }) => {
		await authenticateContext(page.context())
		const body = await rpc(page, 'tools/list')
		const names = (body.result?.tools ?? []).map((t) => t.name).sort()
		expect(names).toEqual([...mcpExposedToolNames()].sort())
		for (const name of CHAT_RUN_ONLY_TOOLS) expect(names, name).not.toContain(name)
	})

	test('tools/call refuses them as invalid params, before any handler runs', async ({ page }) => {
		await authenticateContext(page.context())
		for (const name of ['ask_user', 'push_branch', 'set_project_context']) {
			const body = await rpc(page, 'tools/call', { name, arguments: {} })
			expect(body.error?.code, name).toBe(-32602)
			expect(body.error?.message, name).toContain('only runs inside a chat conversation')
		}
		const unknown = await rpc(page, 'tools/call', { name: 'no_such_tool', arguments: {} })
		expect(unknown.error?.code).toBe(-32602)
		expect(unknown.error?.message).toContain('Unknown tool')
	})
})
