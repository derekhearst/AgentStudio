import { expect, test } from '@playwright/test'

/**
 * Wave 5 #22 phase 7 — mode-aware tool filtering.
 *
 * The full conversation mode integration (skills seeded, mode column, anchor messages,
 * mode selector UI) is exercised end-to-end in chat tests. Here we pin the contract that
 * gates safety: research + plan modes are read-only with respect to non-conversation
 * state, and the filter is allow-list shape (newly added tools fail closed until audited).
 */

const MOCK_TOOL = (name: string) => ({ type: 'function' as const, function: { name } })

test.describe('chat/mode-tool-filter — pass-through modes', () => {
	test('chat mode does not strip any tool', async () => {
		const { filterToolsByMode } = await import('../src/lib/chat/mode-filter')
		const tools = [MOCK_TOOL('shell'), MOCK_TOOL('file_write'), MOCK_TOOL('push_branch')]
		expect(filterToolsByMode(tools, 'chat')).toEqual(tools)
	})

	test('agent mode does not strip any tool', async () => {
		const { filterToolsByMode } = await import('../src/lib/chat/mode-filter')
		const tools = [MOCK_TOOL('shell'), MOCK_TOOL('file_write'), MOCK_TOOL('create_pull_request')]
		expect(filterToolsByMode(tools, 'agent')).toEqual(tools)
	})
})

test.describe('chat/mode-tool-filter — research mode', () => {
	test('strips destructive tools (shell, file_write, push_branch)', async () => {
		const { filterToolsByMode } = await import('../src/lib/chat/mode-filter')
		const tools = [
			MOCK_TOOL('shell'),
			MOCK_TOOL('file_write'),
			MOCK_TOOL('file_patch'),
			MOCK_TOOL('delete_file'),
			MOCK_TOOL('push_branch'),
			MOCK_TOOL('create_pull_request'),
			MOCK_TOOL('clone_repository'),
			MOCK_TOOL('create_artifact'),
			MOCK_TOOL('edit_artifact'),
			MOCK_TOOL('create_skill'),
			MOCK_TOOL('update_agent'),
			MOCK_TOOL('create_user'),
			MOCK_TOOL('create_automation'),
		]
		const filtered = filterToolsByMode(tools, 'research')
		expect(filtered).toHaveLength(0)
	})

	test('keeps read-only tools (web_search, file_read, list_my_repos, prepare_commit, propose_plan)', async () => {
		const { filterToolsByMode } = await import('../src/lib/chat/mode-filter')
		const tools = [
			MOCK_TOOL('web_search'),
			MOCK_TOOL('web_fetch'),
			MOCK_TOOL('file_read'),
			MOCK_TOOL('list_directory'),
			MOCK_TOOL('search_files'),
			MOCK_TOOL('list_my_repos'),
			MOCK_TOOL('list_pull_requests'),
			MOCK_TOOL('get_pull_request'),
			MOCK_TOOL('prepare_commit'),
			MOCK_TOOL('git_status'),
			MOCK_TOOL('list_skills'),
			MOCK_TOOL('read_skill'),
			MOCK_TOOL('list_artifacts'),
			MOCK_TOOL('read_artifact'),
			MOCK_TOOL('list_projects'),
			MOCK_TOOL('propose_plan'),
			MOCK_TOOL('ask_user'),
		]
		const filtered = filterToolsByMode(tools, 'research')
		expect(filtered.map((t) => t.function.name).sort()).toEqual(
			[
				'ask_user',
				'file_read',
				'get_pull_request',
				'git_status',
				'list_artifacts',
				'list_directory',
				'list_my_repos',
				'list_projects',
				'list_pull_requests',
				'list_skills',
				'prepare_commit',
				'propose_plan',
				'read_artifact',
				'read_skill',
				'search_files',
				'web_fetch',
				'web_search',
			].sort(),
		)
	})
})

test.describe('chat/mode-tool-filter — plan mode', () => {
	test('plan mode strips the same write tools as research', async () => {
		const { filterToolsByMode } = await import('../src/lib/chat/mode-filter')
		const tools = [
			MOCK_TOOL('shell'),
			MOCK_TOOL('file_write'),
			MOCK_TOOL('push_branch'),
			MOCK_TOOL('create_pull_request'),
		]
		expect(filterToolsByMode(tools, 'plan')).toHaveLength(0)
	})

	test('plan mode keeps propose_plan + read tools (the whole point of plan mode)', async () => {
		const { filterToolsByMode } = await import('../src/lib/chat/mode-filter')
		const tools = [
			MOCK_TOOL('propose_plan'),
			MOCK_TOOL('list_directory'),
			MOCK_TOOL('file_read'),
			MOCK_TOOL('shell'),
		]
		const filtered = filterToolsByMode(tools, 'plan').map((t) => t.function.name).sort()
		expect(filtered).toEqual(['file_read', 'list_directory', 'propose_plan'])
	})
})

test.describe('chat/mode-tool-filter — allow-list semantics', () => {
	test('unknown tool name fails closed in research/plan modes (not in allow-list = stripped)', async () => {
		const { filterToolsByMode } = await import('../src/lib/chat/mode-filter')
		const tools = [MOCK_TOOL('hypothetical_new_tool_added_later')]
		expect(filterToolsByMode(tools, 'research')).toEqual([])
		expect(filterToolsByMode(tools, 'plan')).toEqual([])
		// chat + agent: pass through (default-allow)
		expect(filterToolsByMode(tools, 'chat')).toEqual(tools)
		expect(filterToolsByMode(tools, 'agent')).toEqual(tools)
	})

	test('isToolAllowedInMode returns the same per-tool answer as the bulk filter', async () => {
		const { isToolAllowedInMode } = await import('../src/lib/chat/mode-filter')
		expect(isToolAllowedInMode('shell', 'research')).toBe(false)
		expect(isToolAllowedInMode('shell', 'plan')).toBe(false)
		expect(isToolAllowedInMode('shell', 'chat')).toBe(true)
		expect(isToolAllowedInMode('shell', 'agent')).toBe(true)
		expect(isToolAllowedInMode('web_search', 'research')).toBe(true)
		expect(isToolAllowedInMode('propose_plan', 'plan')).toBe(true)
	})

	test('getReadOnlyToolNames returns a sorted, non-empty list for the audit UI', async () => {
		const { getReadOnlyToolNames } = await import('../src/lib/chat/mode-filter')
		const names = getReadOnlyToolNames()
		expect(names.length).toBeGreaterThan(10)
		expect([...names]).toEqual([...names].sort())
		expect(names).toContain('web_search')
		expect(names).toContain('propose_plan')
		expect(names).not.toContain('shell')
		expect(names).not.toContain('push_branch')
	})
})
