import { expect, test } from '@playwright/test'

/**
 * Wave 5 #19 phase 3 — local git introspection helpers.
 *
 * Pure-helper invariants for `git status` and `git diff --stat` parsing. No DB / network /
 * filesystem dependencies — the parsers run against fixed sample output we own, so the
 * tests pin the contract (branch + ahead/behind extraction, file-status decoding, rename
 * handling, summary-line totals) without needing a real git repository.
 */

test.describe('source-control/git-local — parseGitStatusOutput', () => {
	test('extracts branch + upstream + ahead/behind from the porcelain branch line', async () => {
		const { parseGitStatusOutput } = await import('../src/lib/source-control/git-local')
		const out = parseGitStatusOutput('## main...origin/main [ahead 2, behind 1]\n')
		expect(out.branch).toBe('main')
		expect(out.upstream).toBe('origin/main')
		expect(out.ahead).toBe(2)
		expect(out.behind).toBe(1)
		expect(out.dirty).toBe(false)
	})

	test('clean branch with upstream but no divergence returns 0/0', async () => {
		const { parseGitStatusOutput } = await import('../src/lib/source-control/git-local')
		const out = parseGitStatusOutput('## main...origin/main\n')
		expect(out.ahead).toBe(0)
		expect(out.behind).toBe(0)
	})

	test('detached HEAD reports null branch', async () => {
		const { parseGitStatusOutput } = await import('../src/lib/source-control/git-local')
		const out = parseGitStatusOutput('## HEAD (no branch)\n')
		expect(out.branch).toBeNull()
		expect(out.upstream).toBeNull()
	})

	test('decodes file rows with index + worktree status codes', async () => {
		const { parseGitStatusOutput } = await import('../src/lib/source-control/git-local')
		const out = parseGitStatusOutput(
			[
				'## feature/x...origin/main [ahead 3]',
				' M src/lib/foo.ts',
				'A  src/lib/new.ts',
				'?? scripts/scratch.sh',
				'D  removed.md',
				'',
			].join('\n'),
		)
		expect(out.dirty).toBe(true)
		expect(out.files).toHaveLength(4)
		expect(out.files[0]).toEqual({ path: 'src/lib/foo.ts', indexStatus: ' ', worktreeStatus: 'M' })
		expect(out.files[1]).toEqual({ path: 'src/lib/new.ts', indexStatus: 'A', worktreeStatus: ' ' })
		expect(out.files[2]).toEqual({ path: 'scripts/scratch.sh', indexStatus: '?', worktreeStatus: '?' })
		expect(out.files[3]).toEqual({ path: 'removed.md', indexStatus: 'D', worktreeStatus: ' ' })
	})

	test('rename rows expose both source and destination paths', async () => {
		const { parseGitStatusOutput } = await import('../src/lib/source-control/git-local')
		const out = parseGitStatusOutput(['## main', 'R  old/path.ts -> new/path.ts', ''].join('\n'))
		expect(out.files).toEqual([
			{ path: 'new/path.ts', renamedFrom: 'old/path.ts', indexStatus: 'R', worktreeStatus: ' ' },
		])
	})

	test('empty status output yields a clean summary', async () => {
		const { parseGitStatusOutput } = await import('../src/lib/source-control/git-local')
		const out = parseGitStatusOutput('')
		expect(out.dirty).toBe(false)
		expect(out.files).toEqual([])
		expect(out.branch).toBeNull()
	})
})

test.describe('source-control/git-local — parseGitDiffStatOutput', () => {
	test('extracts per-file insertions/deletions from the +/- bars', async () => {
		const { parseGitDiffStatOutput } = await import('../src/lib/source-control/git-local')
		const out = parseGitDiffStatOutput(
			[
				' src/lib/foo.ts |  6 +++---',
				' docs/notes.md  |  3 +++',
				' 2 files changed, 6 insertions(+), 3 deletions(-)',
				'',
			].join('\n'),
		)
		expect(out.filesChanged).toBe(2)
		expect(out.insertions).toBe(6)
		expect(out.deletions).toBe(3)
		expect(out.files).toEqual([
			{ path: 'src/lib/foo.ts', insertions: 3, deletions: 3 },
			{ path: 'docs/notes.md', insertions: 3, deletions: 0 },
		])
	})

	test('binary files appear with zero insertions/deletions', async () => {
		const { parseGitDiffStatOutput } = await import('../src/lib/source-control/git-local')
		const out = parseGitDiffStatOutput(
			[' static/icon.svg | Bin 0 -> 5489 bytes', ' 1 file changed, 0 insertions(+), 0 deletions(-)', ''].join('\n'),
		)
		expect(out.files).toEqual([{ path: 'static/icon.svg', insertions: 0, deletions: 0 }])
		expect(out.filesChanged).toBe(1)
	})

	test('empty output yields all-zero summary', async () => {
		const { parseGitDiffStatOutput } = await import('../src/lib/source-control/git-local')
		const out = parseGitDiffStatOutput('')
		expect(out).toEqual({ filesChanged: 0, insertions: 0, deletions: 0, files: [] })
	})

	test('summary line is authoritative over file-row inferred totals', async () => {
		const { parseGitDiffStatOutput } = await import('../src/lib/source-control/git-local')
		// File rows show 5 + signs combined, but the truncated summary says 12 — our
		// parser trusts the summary line so the dashboard reading matches `git`'s own.
		const out = parseGitDiffStatOutput(
			[
				' file-a.ts | 12 +++--',
				' file-b.ts |  3 +++',
				' 2 files changed, 12 insertions(+), 2 deletions(-)',
				'',
			].join('\n'),
		)
		expect(out.insertions).toBe(12)
		expect(out.deletions).toBe(2)
	})
})

test.describe('source-control/git-local — suggestCommitSubject', () => {
	test('docs-only changes suggest the docs scope', async () => {
		const { suggestCommitSubject, parseGitDiffStatOutput } = await import('../src/lib/source-control/git-local')
		const diff = parseGitDiffStatOutput(' docs/foo.md | 3 +++\n 1 file changed, 3 insertions(+)\n')
		expect(suggestCommitSubject(diff)).toBe('docs: update documentation')
	})

	test('test-only changes suggest the test scope', async () => {
		const { suggestCommitSubject, parseGitDiffStatOutput } = await import('../src/lib/source-control/git-local')
		const diff = parseGitDiffStatOutput(' tests/foo.spec.ts | 5 ++\n 1 file changed, 5 insertions(+)\n')
		expect(suggestCommitSubject(diff)).toBe('test: update tests')
	})

	test('mixed changes suggest a feat scope rooted at the first file\'s top dir', async () => {
		const { suggestCommitSubject, parseGitDiffStatOutput } = await import('../src/lib/source-control/git-local')
		const diff = parseGitDiffStatOutput(
			[' src/lib/foo.ts | 4 ++--', ' src/components/Bar.svelte | 2 +-', ' 2 files changed, 4 insertions(+), 2 deletions(-)', ''].join('\n'),
		)
		expect(suggestCommitSubject(diff)).toBe('feat: update src/lib (2 files)')
	})

	test('empty diff returns the no-changes marker', async () => {
		const { suggestCommitSubject, parseGitDiffStatOutput } = await import('../src/lib/source-control/git-local')
		const diff = parseGitDiffStatOutput('')
		expect(suggestCommitSubject(diff)).toBe('chore: (no working-tree changes)')
	})
})

test.describe('source-control/git-local — argv builders', () => {
	test('buildStatusArgs uses -C and porcelain v1 + branch', async () => {
		const { buildStatusArgs } = await import('../src/lib/source-control/git-local')
		expect(buildStatusArgs('/repo/here')).toEqual(['-C', '/repo/here', 'status', '--porcelain=v1', '--branch'])
	})

	test('buildDiffStatArgs targets HEAD without color', async () => {
		const { buildDiffStatArgs } = await import('../src/lib/source-control/git-local')
		expect(buildDiffStatArgs('/repo/here')).toEqual(['-C', '/repo/here', 'diff', '--stat', '--no-color', 'HEAD'])
	})
})
