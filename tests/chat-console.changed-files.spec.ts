import { expect, test } from '@playwright/test'
import { changedFilesInThread, collectChangedFiles } from '../src/lib/chat-console/changed-files'

/**
 * #14 — the rail's Files tab: "changed in this chat".
 *
 * Pure-function tests: `changed-files.ts` has no DB, no SvelteKit and no I/O (only a type
 * import), so this runs without Postgres or a dev server, like
 * `engine.tool-result-details.spec.ts`.
 *
 * What is pinned here:
 *   - one row per file, with the +/- counts of every edit to it added up
 *   - a file created at any point in the chat stays "new"
 *   - newest first, by the most recent edit
 *   - a block the live stream and a saved list both hold is counted once
 *   - only successful `file_edit` blocks count: other tools, failed or denied calls,
 *     malformed details and writes that changed nothing are left out
 *   - the thread fold: the live turn counts until the message it was saved as has loaded
 */

function edit(
	path: string,
	additions: number,
	deletions: number,
	extra: { changeType?: 'create' | 'update'; unavailable?: 'none' | 'no_change' | 'diff_missing'; tool?: string } = {},
) {
	return {
		kind: 'file_edit' as const,
		tool: extra.tool ?? 'Edit',
		path,
		changeType: extra.changeType ?? 'update',
		hunks: [],
		additions,
		deletions,
		unavailable: extra.unavailable ?? 'none',
		truncated: false,
	}
}

/** A saved tool block: no id, `success` rather than a status. */
function saved(details: unknown, success = true) {
	return { kind: 'tool', name: 'Edit', arguments: {}, result: '', success, executionMs: 0, details }
}

/** A live tool block: an id and a status. */
function live(id: string, details: unknown, status = 'completed') {
	return { kind: 'tool', id, name: 'Edit', arguments: '{}', status, details }
}

test.describe('collectChangedFiles', () => {
	test('groups edits by path and adds up their counts', () => {
		const files = collectChangedFiles([
			[saved(edit('/w/src/app.ts', 3, 1)), saved(edit('/w/README.md', 2, 0))],
			[saved(edit('/w/src/app.ts', 4, 2))],
		])
		const app = files.find((f) => f.path === '/w/src/app.ts')
		expect(files).toHaveLength(2)
		expect(app).toMatchObject({ name: 'app.ts', dir: '/w/src/', additions: 7, deletions: 3, edits: 2, changeType: 'update' })
	})

	test('a file created anywhere in the chat stays new', () => {
		const [file] = collectChangedFiles([
			[saved(edit('/w/new.ts', 10, 0, { changeType: 'create', tool: 'Write' }))],
			[saved(edit('/w/new.ts', 1, 1))],
		])
		expect(file.changeType).toBe('create')
		expect(file.edits).toBe(2)
	})

	test('orders files by their most recent edit, newest first', () => {
		const files = collectChangedFiles([
			[saved(edit('/w/a.ts', 1, 0)), saved(edit('/w/b.ts', 1, 0))],
			[saved(edit('/w/c.ts', 1, 0))],
			[saved(edit('/w/a.ts', 1, 0))],
		])
		expect(files.map((f) => f.name)).toEqual(['a.ts', 'c.ts', 'b.ts'])
	})

	test('counts a block two lists hold once, by its id', () => {
		const block = live('toolu_1', edit('/w/a.ts', 5, 2))
		const [file] = collectChangedFiles([[block], [block, live('toolu_2', edit('/w/a.ts', 1, 0))]])
		expect(file).toMatchObject({ additions: 6, deletions: 2, edits: 2 })
	})

	test('leaves out other tools, failures, malformed details and no-op writes', () => {
		const files = collectChangedFiles([
			[
				{ kind: 'text', content: 'hello' },
				{ kind: 'tool', name: 'Bash', details: { kind: 'shell', command: 'ls', stdout: '', stderr: '' } },
				saved(edit('/w/failed.ts', 9, 9), false),
				live('toolu_d', edit('/w/denied.ts', 9, 9), 'denied'),
				live('toolu_f', edit('/w/failed-live.ts', 9, 9), 'failed'),
				saved({ kind: 'file_edit' }),
				saved({ kind: 'file_edit', path: '   ' }),
				saved(null),
				saved('not an object'),
				saved(edit('/w/same.ts', 0, 0, { tool: 'Write', unavailable: 'no_change' })),
				null,
				undefined,
				saved(edit('/w/kept.ts', 1, 0)),
			],
			null,
			undefined,
		] as never)
		expect(files.map((f) => f.path)).toEqual(['/w/kept.ts'])
	})

	test('treats a missing or nonsense count as zero', () => {
		const [file] = collectChangedFiles([[saved({ ...edit('/w/a.ts', 0, 0), additions: 'many', deletions: -4 })]])
		expect(file).toMatchObject({ additions: 0, deletions: 0 })
	})

	test('merges one file written with either separator, and shows the latest spelling', () => {
		const files = collectChangedFiles([
			[saved(edit('C:\\w\\src\\app.ts', 1, 0))],
			[saved(edit('C:/w/src/app.ts', 2, 0))],
		])
		expect(files).toHaveLength(1)
		expect(files[0]).toMatchObject({ path: 'C:/w/src/app.ts', name: 'app.ts', dir: 'C:/w/src/', additions: 3 })
	})

	test('a bare file name has no directory', () => {
		const [file] = collectChangedFiles([[saved(edit('notes.md', 1, 0))]])
		expect(file).toMatchObject({ name: 'notes.md', dir: '' })
	})
})

test.describe('changedFilesInThread', () => {
	const messages = [
		{ id: 'm1', metadata: { blocks: [saved(edit('/w/a.ts', 2, 0))] } },
		{ id: 'm2', metadata: null },
		{ id: 'm3' },
		{ id: 'm4', metadata: { blocks: 'not a list' } },
	]

	test('reads saved messages and the live turn together', () => {
		const files = changedFilesInThread({
			messages,
			liveBlocks: [live('toolu_1', edit('/w/b.ts', 1, 0))],
			liveMessageId: null,
		})
		expect(files.map((f) => f.name)).toEqual(['b.ts', 'a.ts'])
	})

	test('keeps counting the live turn until the message it was saved as has loaded', () => {
		const liveBlocks = [live('toolu_1', edit('/w/b.ts', 1, 0))]
		// `done` named the message, but the refetch has not brought it in yet.
		expect(changedFilesInThread({ messages, liveBlocks, liveMessageId: 'm9' }).map((f) => f.name)).toEqual(['b.ts', 'a.ts'])

		// Now it has: the saved copy counts, the live copy does not count a second time.
		const withSaved = [...messages, { id: 'm9', metadata: { blocks: [saved(edit('/w/b.ts', 1, 0))] } }]
		const files = changedFilesInThread({ messages: withSaved, liveBlocks, liveMessageId: 'm9' })
		expect(files.find((f) => f.name === 'b.ts')).toMatchObject({ additions: 1, edits: 1 })
	})

	test('an empty chat has no changed files', () => {
		expect(changedFilesInThread({ messages: [], liveBlocks: [], liveMessageId: null })).toEqual([])
	})
})
