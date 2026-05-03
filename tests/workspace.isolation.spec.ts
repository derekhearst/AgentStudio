import { resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { resolveWorkspaceRoot, safePathWithin } from '../src/lib/workspace/workspace.server'

const ROOT = '/test-sandbox'

test.describe('workspace/isolation — per-run workspace resolution', () => {
	test('with runId resolves to <root>/<userId>/runs/<runId>', () => {
		const r = resolveWorkspaceRoot({ userId: 'user-123', runId: 'run-abc', sandboxRoot: ROOT })
		expect(r).toBe(resolve(ROOT, 'user-123', 'runs', 'run-abc'))
	})

	test('without runId resolves to legacy <root>/<userId>', () => {
		const r = resolveWorkspaceRoot({ userId: 'user-123', sandboxRoot: ROOT })
		expect(r).toBe(resolve(ROOT, 'user-123'))
	})

	test('two distinct runs for the same user resolve to distinct directories', () => {
		const a = resolveWorkspaceRoot({ userId: 'u1', runId: 'r1', sandboxRoot: ROOT })
		const b = resolveWorkspaceRoot({ userId: 'u1', runId: 'r2', sandboxRoot: ROOT })
		expect(a).not.toBe(b)
		expect(a.endsWith('r1')).toBe(true)
		expect(b.endsWith('r2')).toBe(true)
	})

	test('the legacy user-root and a run-scoped path share a common parent', () => {
		const userRoot = resolveWorkspaceRoot({ userId: 'u9', sandboxRoot: ROOT })
		const runRoot = resolveWorkspaceRoot({ userId: 'u9', runId: 'rX', sandboxRoot: ROOT })
		expect(runRoot.startsWith(userRoot)).toBe(true)
	})

	test('rejects userIds that contain path-traversal characters', () => {
		expect(() => resolveWorkspaceRoot({ userId: '../etc', sandboxRoot: ROOT })).toThrow(/Invalid userId/)
		expect(() => resolveWorkspaceRoot({ userId: 'a/b', sandboxRoot: ROOT })).toThrow(/Invalid userId/)
	})

	test('rejects runIds that contain path-traversal characters', () => {
		expect(() => resolveWorkspaceRoot({ userId: 'u1', runId: '../escape', sandboxRoot: ROOT })).toThrow(/Invalid runId/)
		expect(() => resolveWorkspaceRoot({ userId: 'u1', runId: 'a/b', sandboxRoot: ROOT })).toThrow(/Invalid runId/)
	})

	test('safePathWithin allows paths inside the workspace and rejects escapes', () => {
		const root = resolveWorkspaceRoot({ userId: 'u1', runId: 'r1', sandboxRoot: ROOT })
		expect(safePathWithin(root, 'notes.md')).toBe(resolve(root, 'notes.md'))
		expect(safePathWithin(root, 'sub/dir/file.txt')).toBe(resolve(root, 'sub/dir/file.txt'))
		expect(() => safePathWithin(root, '../escape.txt')).toThrow(/Path escapes sandbox workspace/)
		expect(() => safePathWithin(root, '../../../../etc/passwd')).toThrow(/Path escapes sandbox workspace/)
	})

	test('an empty/missing runId falls back to user-scope (back-compat for unmigrated callers)', () => {
		const noRun = resolveWorkspaceRoot({ userId: 'u', runId: null, sandboxRoot: ROOT })
		const undef = resolveWorkspaceRoot({ userId: 'u', runId: undefined, sandboxRoot: ROOT })
		const userOnly = resolveWorkspaceRoot({ userId: 'u', sandboxRoot: ROOT })
		expect(noRun).toBe(userOnly)
		expect(undef).toBe(userOnly)
	})

	test('falls back to a default root when sandboxRoot is omitted', () => {
		const r = resolveWorkspaceRoot({ userId: 'u', runId: 'r' })
		expect(r.endsWith(resolve('/workspace/users', 'u', 'runs', 'r'))).toBe(true)
	})

	test('persistentKey resolves to <root>/<userId>/persistent/<key> (Phase 2)', () => {
		const r = resolveWorkspaceRoot({ userId: 'u1', persistentKey: 'main-repo', sandboxRoot: ROOT })
		expect(r).toBe(resolve(ROOT, 'u1', 'persistent', 'main-repo'))
	})

	test('persistentKey takes precedence over runId when both are set', () => {
		const r = resolveWorkspaceRoot({ userId: 'u1', runId: 'r1', persistentKey: 'pinned', sandboxRoot: ROOT })
		expect(r).toBe(resolve(ROOT, 'u1', 'persistent', 'pinned'))
	})

	test('two runs sharing a persistentKey resolve to the SAME directory (data survives)', () => {
		const a = resolveWorkspaceRoot({ userId: 'u1', runId: 'r-a', persistentKey: 'main', sandboxRoot: ROOT })
		const b = resolveWorkspaceRoot({ userId: 'u1', runId: 'r-b', persistentKey: 'main', sandboxRoot: ROOT })
		expect(a).toBe(b)
	})

	test('rejects persistentKey with traversal characters', () => {
		expect(() => resolveWorkspaceRoot({ userId: 'u1', persistentKey: '../escape', sandboxRoot: ROOT })).toThrow(
			/Invalid persistentKey/,
		)
		expect(() => resolveWorkspaceRoot({ userId: 'u1', persistentKey: 'a/b', sandboxRoot: ROOT })).toThrow(
			/Invalid persistentKey/,
		)
	})
})
