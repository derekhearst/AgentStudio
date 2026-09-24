import { expect, test } from '@playwright/test'

/**
 * Per-agent tool policy (replaces the prior `chat.mode-tool-filter` after the
 * modes-into-agents unification).
 *
 * The pure resolver lives in `agent-tool-filter.ts` so it can be tested without pulling
 * in `$lib/db.server`. Two policy shapes:
 *   - `unrestricted`: no scope (Chat, Autonomous built-ins; all custom agents)
 *   - `readOnly`:     allow-list (Research, Plan built-ins). Allow-list shape so newly
 *                     added tools fail closed for those agents until explicitly audited.
 *
 * The chat stream route resolves the bound agent's policy and hands a `readOnly` allow-list
 * to the engine as its tool scope, so what these tests read off `allow` is what the engine
 * lets the agent call. The module used to export a filter over OpenAI-style tool
 * definitions as well; its only caller was the old loop's tool assembly, deleted in #8.
 */

/**
 * The real allow-list, loaded from the source and resolved the way the stream route does it.
 *
 * This file used to keep a hand-written copy of it. A test that builds a policy from its
 * own copy of the list is not testing the policy — it is testing that a Set behaves like
 * a Set, and it would stay green if someone added `Bash` to the real
 * `READ_ONLY_TOOL_NAMES`. For an allow-list whose whole job is to keep destructive tools
 * away from read-only agents, that is the one failure mode worth catching.
 */
async function readOnlyPolicy() {
	const [{ READ_ONLY_TOOL_NAMES }, { resolveAgentToolPolicy }] = await Promise.all([
		import('../src/lib/agents/builtin-agents.server'),
		import('../src/lib/chat/agent-tool-filter'),
	])
	// The config the built-in Research and Plan agents are seeded with.
	const policy = resolveAgentToolPolicy({ toolPolicy: { kind: 'readOnly', allow: READ_ONLY_TOOL_NAMES } })
	if (policy.kind !== 'readOnly') throw new Error('the built-in read-only config did not resolve to readOnly')
	return policy
}

test.describe('agent-tool-policy — unrestricted policy', () => {
	test('resolveAgentToolPolicy defaults to unrestricted on missing/malformed config', async () => {
		const { resolveAgentToolPolicy } = await import('../src/lib/chat/agent-tool-filter')
		expect(resolveAgentToolPolicy(null).kind).toBe('unrestricted')
		expect(resolveAgentToolPolicy({}).kind).toBe('unrestricted')
		expect(resolveAgentToolPolicy({ toolPolicy: null }).kind).toBe('unrestricted')
		expect(resolveAgentToolPolicy({ toolPolicy: { kind: 'garbage' } }).kind).toBe('unrestricted')
		expect(resolveAgentToolPolicy({ toolPolicy: { kind: 'unrestricted' } }).kind).toBe('unrestricted')
	})

	test('a readOnly config without an allow array is not a readOnly policy', async () => {
		const { resolveAgentToolPolicy } = await import('../src/lib/chat/agent-tool-filter')
		expect(resolveAgentToolPolicy({ toolPolicy: { kind: 'readOnly' } }).kind).toBe('unrestricted')
		expect(resolveAgentToolPolicy({ toolPolicy: { kind: 'readOnly', allow: 'Read' } }).kind).toBe('unrestricted')
	})
})

test.describe('agent-tool-policy — readOnly policy (Research / Plan built-ins)', () => {
	test('readOnly leaves out destructive tools (Bash, Edit, push_branch)', async () => {
		// Note the absence of `Write`. It is allow-listed deliberately — the planner writes
		// its plan to a markdown file and hands off — and the next test asserts it survives.
		// Listing it here too was a straight contradiction between two neighbouring tests.
		const policy = await readOnlyPolicy()
		const destructive = [
			'Bash',
			'Edit',
			'delete_file',
			'push_branch',
			'create_pull_request',
			'clone_repository',
			'create_skill',
			'update_agent',
			'create_automation',
		]
		expect(destructive.filter((name) => policy.allow.has(name))).toEqual([])
	})

	test('readOnly keeps allow-listed tools (web_search, Read, Write, request_plan_approval)', async () => {
		const policy = await readOnlyPolicy()
		const kept = [
			// The SDK's question tool (#4), which replaced the in-house `ask_user`.
			'AskUserQuestion',
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
		]
		expect(kept.filter((name) => !policy.allow.has(name))).toEqual([])
	})

	test('readOnly fails closed for unknown tool names (allow-list semantics)', async () => {
		const policy = await readOnlyPolicy()
		expect(policy.allow.has('hypothetical_new_tool_added_later')).toBe(false)
	})
})

test.describe('agent-tool-policy — resolver round-trips JSON config', () => {
	test('resolveAgentToolPolicy parses readOnly config from agents.config.toolPolicy', async () => {
		const { resolveAgentToolPolicy } = await import('../src/lib/chat/agent-tool-filter')
		// Non-string entries in stored JSON are dropped rather than trusted.
		const config = { toolPolicy: { kind: 'readOnly', allow: ['web_search', 'Read', 42, null] } }
		const policy = resolveAgentToolPolicy(config)
		expect(policy.kind).toBe('readOnly')
		if (policy.kind !== 'readOnly') return
		expect([...policy.allow].sort()).toEqual(['Read', 'web_search'])
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

		// The whole built-in set: since #4 the question tool is the SDK's AskUserQuestion.
		const known = new Set<string>([...allToolNames, ...builtins.BUILTIN_TOOL_SET])
		const unknown = READ_ONLY_TOOL_NAMES.filter((name) => !known.has(name))
		expect(unknown, 'allow-listed tools that no longer exist').toEqual([])
	})
})
