import { expect, test } from '@playwright/test'

/**
 * Per-agent tool policy filter (replaces the prior `chat.mode-tool-filter` after the
 * modes-into-agents unification).
 *
 * The pure resolver lives in `agent-tool-filter.ts` so it can be tested without pulling
 * in `$lib/db.server`. Two policy shapes:
 *   - `unrestricted`: pass-through (Chat, Autonomous built-ins; all custom agents)
 *   - `readOnly`:     allow-list (Research, Plan built-ins). Allow-list shape so newly
 *                     added tools fail closed for those agents until explicitly audited.
 */

const MOCK_TOOL = (name: string) => ({ type: 'function' as const, function: { name } })

const READ_ONLY_ALLOW = [
	'ask_user',
	'search_tools',
	'web_search',
	// Plan/todo authoring + handoff tools — the planner needs to write artifacts.
	'create_artifact',
	'edit_artifact',
	'list_artifacts',
	'present_artifact',
	'request_plan_approval',
	'file_read',
	'list_directory',
	'search_files',
	'file_info',
	'browser_screenshot',
	'web_fetch',
	'pdf_read',
	'git_status',
	'git_log',
	'git_diff',
	'list_skills',
	'read_skill',
	'read_skill_file',
	'list_my_repos',
	'list_pull_requests',
	'get_pull_request',
	'prepare_commit',
	'list_projects',
	'read_artifact',
	'list_automations',
	'recall_memory',
	'list_memory',
]

test.describe('agent-tool-policy — unrestricted policy', () => {
	test('unrestricted passes every tool through', async () => {
		const { filterToolsByAgentPolicy } = await import('../src/lib/chat/agent-tool-filter')
		const tools = [MOCK_TOOL('shell'), MOCK_TOOL('file_write'), MOCK_TOOL('push_branch')]
		expect(filterToolsByAgentPolicy(tools, { kind: 'unrestricted' })).toEqual(tools)
	})

	test('resolveAgentToolPolicy defaults to unrestricted on missing/malformed config', async () => {
		const { resolveAgentToolPolicy } = await import('../src/lib/chat/agent-tool-filter')
		expect(resolveAgentToolPolicy(null).kind).toBe('unrestricted')
		expect(resolveAgentToolPolicy({}).kind).toBe('unrestricted')
		expect(resolveAgentToolPolicy({ toolPolicy: null }).kind).toBe('unrestricted')
		expect(resolveAgentToolPolicy({ toolPolicy: { kind: 'garbage' } }).kind).toBe('unrestricted')
	})
})

test.describe('agent-tool-policy — readOnly policy (Research / Plan built-ins)', () => {
	test('readOnly strips destructive tools (shell, file_write, push_branch)', async () => {
		const { filterToolsByAgentPolicy } = await import('../src/lib/chat/agent-tool-filter')
		const policy = { kind: 'readOnly' as const, allow: new Set(READ_ONLY_ALLOW) }
		const tools = [
			MOCK_TOOL('shell'),
			MOCK_TOOL('file_write'),
			MOCK_TOOL('file_patch'),
			MOCK_TOOL('delete_file'),
			MOCK_TOOL('push_branch'),
			MOCK_TOOL('create_pull_request'),
			MOCK_TOOL('clone_repository'),
			MOCK_TOOL('create_skill'),
			MOCK_TOOL('update_agent'),
			MOCK_TOOL('create_automation'),
		]
		expect(filterToolsByAgentPolicy(tools, policy)).toHaveLength(0)
	})

	test('readOnly keeps allow-listed tools (web_search, file_read, present_artifact, request_plan_approval)', async () => {
		const { filterToolsByAgentPolicy } = await import('../src/lib/chat/agent-tool-filter')
		const policy = { kind: 'readOnly' as const, allow: new Set(READ_ONLY_ALLOW) }
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
			MOCK_TOOL('create_artifact'),
			MOCK_TOOL('edit_artifact'),
			MOCK_TOOL('present_artifact'),
			MOCK_TOOL('request_plan_approval'),
			MOCK_TOOL('list_projects'),
			MOCK_TOOL('ask_user'),
		]
		expect(filterToolsByAgentPolicy(tools, policy).map((t) => t.function.name).sort()).toEqual(
			[
				'ask_user',
				'create_artifact',
				'edit_artifact',
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
				'present_artifact',
				'read_artifact',
				'read_skill',
				'request_plan_approval',
				'search_files',
				'web_fetch',
				'web_search',
			].sort(),
		)
	})

	test('readOnly fails closed for unknown tool names (allow-list semantics)', async () => {
		const { filterToolsByAgentPolicy, isToolAllowedByPolicy } = await import('../src/lib/chat/agent-tool-filter')
		const policy = { kind: 'readOnly' as const, allow: new Set(READ_ONLY_ALLOW) }
		const tools = [MOCK_TOOL('hypothetical_new_tool_added_later')]
		expect(filterToolsByAgentPolicy(tools, policy)).toEqual([])
		expect(isToolAllowedByPolicy('hypothetical_new_tool_added_later', policy)).toBe(false)
		// Unrestricted: pass through.
		expect(filterToolsByAgentPolicy(tools, { kind: 'unrestricted' })).toEqual(tools)
		expect(isToolAllowedByPolicy('hypothetical_new_tool_added_later', { kind: 'unrestricted' })).toBe(true)
	})
})

test.describe('agent-tool-policy — resolver round-trips JSON config', () => {
	test('resolveAgentToolPolicy parses readOnly config from agents.config.toolPolicy', async () => {
		const { resolveAgentToolPolicy, filterToolsByAgentPolicy } = await import('../src/lib/chat/agent-tool-filter')
		const config = { toolPolicy: { kind: 'readOnly', allow: ['web_search', 'file_read'] } }
		const policy = resolveAgentToolPolicy(config)
		expect(policy.kind).toBe('readOnly')
		const tools = [MOCK_TOOL('web_search'), MOCK_TOOL('shell'), MOCK_TOOL('file_read')]
		expect(filterToolsByAgentPolicy(tools, policy).map((t) => t.function.name).sort()).toEqual([
			'file_read',
			'web_search',
		])
	})
})
