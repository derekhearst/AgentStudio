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

test('a home-directory path is refused: the SDK expands `~`, path.resolve does not', () => {
	const WS = process.platform === 'win32' ? 'C:\\sandbox\\user-aaa' : '/sandbox/user-aaa'
	// Nothing below needs the disk: every spelling resolves to itself.
	const g = (file_path: string) =>
		guardWorkspaceAccess({
			toolName: 'Read',
			toolInput: { file_path },
			workspaceRoot: WS,
			bashPolicy: 'sandboxed',
			resolveRealPath: (p) => p,
		}).verdict

	expect(g('~/.ssh/id_rsa')).toBe('deny')
	expect(g('~')).toBe('deny')
	expect(g('~root/.bashrc')).toBe('deny')
	// Not a home-directory prefix: a tilde further in, or an Office lock file.
	expect(g('notes/~/draft.md')).toBe('allow')
	expect(g('~$budget.xlsx')).toBe('allow')
})

test('a `..` argument is also resolved exactly as written, since the SDK may open it that way', () => {
	const WS = process.platform === 'win32' ? 'C:\\sandbox\\user-aaa' : '/sandbox/user-aaa'
	const HOST = process.platform === 'win32' ? 'C:\\host\\x' : '/host/x'
	const seen: string[] = []
	// Stands in for the disk: `link` is a symlink out of the workspace, so any spelling that
	// goes through it and then `..` lands outside. The normalised spelling never contains it.
	const resolveRealPath = (p: string) => {
		seen.push(p)
		return /link[\\/]\.\./.test(p) ? HOST : p
	}
	const g = (file_path: string) =>
		guardWorkspaceAccess({
			toolName: 'Write',
			toolInput: { file_path, content: 'x' },
			workspaceRoot: WS,
			bashPolicy: 'sandboxed',
			resolveRealPath,
		}).verdict

	expect(g('link/../x.txt')).toBe('deny')
	expect(seen.some((p) => /link[\\/]\.\./.test(p))).toBe(true)
	expect(g('dir/../x.txt')).toBe('allow')
	expect(g('x.txt')).toBe('allow')
})
