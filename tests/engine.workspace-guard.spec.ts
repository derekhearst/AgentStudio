/**
 * Workspace containment for the SDK built-ins (#15).
 *
 * Pure — no database, no server — so it runs anywhere. Both directions are asserted on
 * purpose: a containment suite that only proves refusals passes just as happily when the
 * resolver is broken and refuses everything, which is a mistake this repo has already
 * made once today while reviewing this very guard.
 */

import { expect, test } from '@playwright/test'
import {
	guardWorkspaceAccess,
	isAgentConfigPath,
	isInside,
	resolveBashPolicy,
} from '../src/lib/engine/workspace-guard'

test('built-in filesystem calls are confined to the run workspace', () => {
	const WS = process.platform === 'win32' ? 'C:\\sandbox\\user-aaa' : '/sandbox/user-aaa'
	const SIB = process.platform === 'win32' ? 'C:\\sandbox\\user-bbb' : '/sandbox/user-bbb'
	const g = (toolName: string, toolInput: unknown, bashPolicy: 'sandboxed' | 'ask' | 'deny' = 'sandboxed') =>
	guardWorkspaceAccess({ toolName, toolInput, workspaceRoot: WS, bashPolicy })

	const check = (label: string, got: string, want: string) => expect(got, label).toBe(want)

	check('Read absolute outside', g('Read', { file_path: '/etc/passwd' }).verdict, 'deny')
	// Only meaningful on Windows: elsewhere `C:/Windows/win.ini` has no leading slash, so
	// it is a relative path that correctly resolves inside the workspace.
	if (process.platform === 'win32') {
		check('Read windows system', g('Read', { file_path: 'C:/Windows/win.ini' }).verdict, 'deny')
	}
	check('Read ../ traversal', g('Read', { file_path: '../../../etc/passwd' }).verdict, 'deny')
	check('Read sibling user', g('Read', { file_path: `${SIB}/secrets.txt` }).verdict, 'deny')
	check('Write outside', g('Write', { file_path: '/tmp/evil.sh', content: 'x' }).verdict, 'deny')
	check('Edit outside', g('Edit', { file_path: '/etc/hosts' }).verdict, 'deny')
	check('MultiEdit outside', g('MultiEdit', { file_path: '/etc/hosts' }).verdict, 'deny')
	check('NotebookEdit outside', g('NotebookEdit', { notebook_path: '/etc/x.ipynb' }).verdict, 'deny')
	check('Glob outside', g('Glob', { path: '/etc', pattern: '*' }).verdict, 'deny')
	check('Grep outside', g('Grep', { path: '/etc', pattern: 'root' }).verdict, 'deny')
	check('nested escape', g('Read', { file_path: 'sub/../../user-bbb/x' }).verdict, 'deny')
	// Prefix confusion: /sandbox/user-aaa-evil must NOT count as inside /sandbox/user-aaa.
	check('sibling sharing a prefix', g('Read', { file_path: `${WS}-evil/secret` }).verdict, 'deny')

	check('relative file', g('Read', { file_path: 'src/index.ts' }).verdict, 'allow')
	check('absolute inside', g('Write', { file_path: `${WS}/out.txt`, content: 'x' }).verdict, 'allow')
	check('workspace root itself', g('Glob', { path: WS, pattern: '**/*' }).verdict, 'allow')
	check('no path argument', g('Glob', { pattern: '**/*.ts' }).verdict, 'allow')
	check('unrelated tool', g('WebSearch', { query: 'x' }).verdict, 'allow')
	check('nested legit', g('Read', { file_path: './a/b/../c.txt' }).verdict, 'allow')

	check('Bash sandboxed', g('Bash', { command: 'rm -rf /' }, 'sandboxed').verdict, 'allow')
	check('Bash unsandboxed asks', g('Bash', { command: 'ls' }, 'ask').verdict, 'ask')
	check('Bash denied', g('Bash', { command: 'ls' }, 'deny').verdict, 'deny')

	check('linux with bwrap', resolveBashPolicy({ platform: 'linux', sandboxAvailable: true }), 'sandboxed')
	check('linux without bwrap', resolveBashPolicy({ platform: 'linux', sandboxAvailable: false }), 'ask')
	check('windows dev box', resolveBashPolicy({ platform: 'win32' }), 'ask')
	check('explicit override', resolveBashPolicy({ platform: 'linux', override: 'deny' }), 'deny')

	check('root is inside itself', String(isInside(WS, WS)), 'true')
	check('prefix is not inside', String(isInside(WS, `${WS}-evil`)), 'false')

})

test('Bash never runs outside the sandbox, whatever the policy says', () => {
	// The SDK honours `dangerouslyDisableSandbox` unless told otherwise, and a 'sandboxed'
	// policy used to allow every Bash call without looking at its input — so the flag took a
	// command straight out of bubblewrap with the server's secrets in its environment.
	const WS = process.platform === 'win32' ? 'C:\\sandbox\\user-aaa' : '/sandbox/user-aaa'
	for (const bashPolicy of ['sandboxed', 'ask', 'deny'] as const) {
		const escaped = guardWorkspaceAccess({
			toolName: 'Bash',
			toolInput: { command: 'env', dangerouslyDisableSandbox: true },
			workspaceRoot: WS,
			bashPolicy,
		})
		expect(escaped.verdict, bashPolicy).toBe('deny')
	}
	// The flag explicitly off changes nothing.
	expect(
		guardWorkspaceAccess({
			toolName: 'Bash',
			toolInput: { command: 'ls', dangerouslyDisableSandbox: false },
			workspaceRoot: WS,
			bashPolicy: 'sandboxed',
		}).verdict,
	).toBe('allow')
})

test.describe("the agent's own configuration needs approval to change", () => {
	// A trusted project's `.claude/settings.json` is loaded by the next run, and its hooks
	// run as the app user outside the sandbox. An agent that could rewrite it silently could
	// grant itself anything between turns.
	const WS = process.platform === 'win32' ? 'C:\\sandbox\\user-aaa' : '/sandbox/user-aaa'
	const g =(toolName: string, toolInput: unknown, projectConfigLoaded = false) =>
		guardWorkspaceAccess({ toolName, toolInput, workspaceRoot: WS, bashPolicy: 'sandboxed', projectConfigLoaded })

	test('settings, hooks, commands, agents, skills and .mcp.json ask, in every project', () => {
		const asks: Array<[string, unknown]> = [
			['Write', { file_path: '.claude/settings.json', content: '{}' }],
			['Edit', { file_path: '.claude/settings.local.json' }],
			['Write', { file_path: `${WS}/.claude/settings.json`, content: '{}' }],
			['Write', { file_path: '.claude/commands/deploy.md', content: 'x' }],
			['Write', { file_path: '.claude/agents/helper.md', content: 'x' }],
			['MultiEdit', { file_path: '.claude/skills/s/SKILL.md' }],
			['Write', { file_path: '.claude/hooks/pre.sh', content: 'x' }],
			['Write', { file_path: '.mcp.json', content: '{}' }],
			['NotebookEdit', { notebook_path: '.claude/settings.json' }],
			// Case must not matter on a case-insensitive filesystem.
			['Write', { file_path: '.Claude/Settings.json', content: '{}' }],
			// Our own move/delete reach the same files.
			['move_file', { fromPath: 'draft.json', toPath: '.claude/settings.json' }],
			['move_file', { fromPath: '.claude/settings.json', toPath: 'gone.json' }],
			['delete_file', { path: '.claude', recursive: true }],
		]
		for (const [tool, input] of asks) {
			expect(g(tool, input).verdict, `${tool} ${JSON.stringify(input)}`).toBe('ask')
		}
	})

	test('ordinary work in the workspace is untouched', () => {
		expect(g('Write', { file_path: 'PLAN.md', content: 'x' }).verdict).toBe('allow')
		expect(g('Write', { file_path: 'src/claude/settings.json', content: 'x' }).verdict).toBe('allow')
		expect(g('Write', { file_path: '.claude/notes.md', content: 'x' }).verdict).toBe('allow')
		// Reading configuration is not changing it.
		expect(g('Read', { file_path: '.claude/settings.json' }).verdict).toBe('allow')
		expect(g('Glob', { path: '.claude', pattern: '*' }).verdict).toBe('allow')
	})

	test('CLAUDE.md asks only when the project tier is actually loaded', () => {
		// Untrusted, it is just a file; trusted, it is part of every future prompt.
		expect(g('Write', { file_path: 'CLAUDE.md', content: 'x' }).verdict).toBe('allow')
		expect(g('Write', { file_path: 'CLAUDE.md', content: 'x' }, true).verdict).toBe('ask')
		expect(g('Edit', { file_path: 'pkg/CLAUDE.local.md' }, true).verdict).toBe('ask')
		expect(g('Write', { file_path: '.claude/CLAUDE.md', content: 'x' }, true).verdict).toBe('ask')
	})

	test('containment still comes first: outside the workspace is refused, not asked', () => {
		expect(g('Write', { file_path: '/etc/.claude/settings.json', content: 'x' }).verdict).toBe('deny')
	})

	test('a workspace that itself lives under a .claude directory is not configuration', () => {
		// This checkout's own worktrees live under `<repo>/.claude/worktrees/…`.
		const nested = process.platform === 'win32' ? 'C:\\repo\\.claude\\worktrees\\wt' : '/repo/.claude/worktrees/wt'
		expect(isAgentConfigPath(nested, `${nested}/src/index.ts`, true)).toBe(false)
		expect(isAgentConfigPath(nested, `${nested}/.claude/settings.json`, false)).toBe(true)
	})
})
