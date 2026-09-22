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

/**
 * The real allow-list, loaded from the source.
 *
 * This file used to keep a hand-written copy of it. A test that builds a policy from its
 * own copy of the list is not testing the policy — it is testing that a Set behaves like
 * a Set, and it would stay green if someone added `Bash` to the real
 * `READ_ONLY_TOOL_NAMES`. For an allow-list whose whole job is to keep destructive tools
 * away from read-only agents, that is the one failure mode worth catching.
 */
async function readOnlyPolicy() {
	const { READ_ONLY_TOOL_NAMES } = await import('../src/lib/agents/builtin-agents.server')
	return { kind: 'readOnly' as const, allow: new Set(READ_ONLY_TOOL_NAMES) }
}


test.describe('agent-tool-policy — unrestricted policy', () => {
	test('unrestricted passes every tool through', async () => {
		const { filterToolsByAgentPolicy } = await import('../src/lib/chat/agent-tool-filter')
		const tools = [MOCK_TOOL('Bash'), MOCK_TOOL('Write'), MOCK_TOOL('push_branch')]
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
	test('readOnly strips destructive tools (Bash, Edit, push_branch)', async () => {
		// Note the absence of `Write`. It is allow-listed deliberately — the planner writes
		// its plan to a markdown file and hands off — and the next test asserts it survives.
		// Listing it here too was a straight contradiction between two neighbouring tests.
		const { filterToolsByAgentPolicy } = await import('../src/lib/chat/agent-tool-filter')
		const policy = await readOnlyPolicy()
		const tools = [
			MOCK_TOOL('Bash'),
			MOCK_TOOL('Edit'),
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

	test('readOnly keeps allow-listed tools (web_search, Read, Write, request_plan_approval)', async () => {
		const { filterToolsByAgentPolicy } = await import('../src/lib/chat/agent-tool-filter')
		const policy = await readOnlyPolicy()
		const tools = [
			MOCK_TOOL('web_search'),
			MOCK_TOOL('web_fetch'),
			MOCK_TOOL('Read'),
			MOCK_TOOL('Glob'),
			MOCK_TOOL('Grep'),
			MOCK_TOOL('list_my_repos'),
			MOCK_TOOL('list_pull_requests'),
			MOCK_TOOL('get_pull_request'),
			MOCK_TOOL('prepare_commit'),
			MOCK_TOOL('git_status'),
			MOCK_TOOL('list_skills'),
			MOCK_TOOL('read_skill'),
			MOCK_TOOL('Write'),
			MOCK_TOOL('request_plan_approval'),
			MOCK_TOOL('list_projects'),
			MOCK_TOOL('ask_user'),
		]
		expect(filterToolsByAgentPolicy(tools, policy).map((t) => t.function.name).sort()).toEqual(
			[
				'ask_user',
				'Read',
				'Write',
				'get_pull_request',
				'git_status',
				'Glob',
				'list_my_repos',
				'list_projects',
				'list_pull_requests',
				'list_skills',
				'prepare_commit',
				'read_skill',
				'request_plan_approval',
				'Grep',
				'web_fetch',
				'web_search',
			].sort(),
		)
	})

	test('readOnly fails closed for unknown tool names (allow-list semantics)', async () => {
		const { filterToolsByAgentPolicy, isToolAllowedByPolicy } = await import('../src/lib/chat/agent-tool-filter')
		const policy = await readOnlyPolicy()
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
		const config = { toolPolicy: { kind: 'readOnly', allow: ['web_search', 'Read'] } }
		const policy = resolveAgentToolPolicy(config)
		expect(policy.kind).toBe('readOnly')
		const tools = [MOCK_TOOL('web_search'), MOCK_TOOL('Bash'), MOCK_TOOL('Read')]
		expect(filterToolsByAgentPolicy(tools, policy).map((t) => t.function.name).sort()).toEqual([
			'Read',
			'web_search',
		])
	})
})

test.describe('agent-tool-policy — the real allow-list is not quietly widened', () => {
	test('READ_ONLY_TOOL_NAMES contains nothing that can change the world', async () => {
		const { READ_ONLY_TOOL_NAMES } = await import('../src/lib/agents/builtin-agents.server')

		// Named individually rather than pattern-matched: a regex over the list would drift
		// with naming conventions and quietly stop matching. These are the tools that edit
		// the filesystem, run commands, or change remote state.
		//
		// `Write` is deliberately absent from this list. It is the one write tool these
		// agents get, so the planner can put its plan on disk before handing off.
		const MUST_NOT_BE_ALLOWED = [
			'Bash',
			'Edit',
			'MultiEdit',
			'NotebookEdit',
			'delete_file',
			'move_file',
			'run_code',
			'push_branch',
			'create_pull_request',
			'clone_repository',
			'create_skill',
			'update_skill',
			'delete_skill',
			'create_agent',
			'update_agent',
			'delete_agent',
			'create_automation',
			'update_automation',
			'delete_automation',
			'create_project',
			'remember',
			'forget',
		]

		const leaked = MUST_NOT_BE_ALLOWED.filter((name) => READ_ONLY_TOOL_NAMES.includes(name))
		expect(leaked, 'a read-only agent must not be able to call these').toEqual([])
	})

	test('every allow-listed name is a tool that exists', async () => {
		// An allow-list entry that matches no real tool is dead weight, and usually a sign
		// the tool was renamed while the policy was not — which silently *removes* a
		// capability from Research and Plan rather than adding one. It found two on the
		// first run: `recall_memory` and `list_memory`, left behind from when memory recall
		// was a tool rather than context the engine injects.
		//
		// Two surfaces have to be checked, not one. `allToolNames` is the app's own
		// registry; the SDK's built-ins (Read, Write, Glob, Grep, Bash…) are allow-listed
		// by the same names but live in `engine/builtin-tools`. Those constants were moved
		// out of `options.server.ts` for this: importing that module from the Playwright
		// runtime fails on `$env`, and a test that cannot read the real list would have to
		// keep its own copy — the exact problem this file already had.
		const [{ READ_ONLY_TOOL_NAMES }, { allToolNames }, builtins] = await Promise.all([
			import('../src/lib/agents/builtin-agents.server'),
			import('../src/lib/tools/tool-schemas'),
			import('../src/lib/engine/builtin-tools'),
		])

		const known = new Set<string>([
			...allToolNames,
			...builtins.BUILTIN_FILE_TOOLS,
			...builtins.BUILTIN_SHELL_TOOLS,
		])
		const unknown = READ_ONLY_TOOL_NAMES.filter((name) => !known.has(name))
		expect(unknown, 'allow-listed tools that no longer exist').toEqual([])
	})
})
