import { expect, test } from '@playwright/test'
import {
	MAX_DIFF_LINES,
	MAX_STREAM_CHARS,
	MAX_TODO_ITEMS,
	appendStreamTail,
	hasToolResultDetails,
	toolResultDetails,
} from '../src/lib/engine/tool-result-details'

/**
 * #16 / #26 / #21 — distilling the SDK's `tool_use_result` into renderable payloads.
 *
 * Pure-function tests: `src/lib/engine/tool-result-details.ts` has no DB, no SvelteKit and
 * no I/O, so this spec runs without Postgres or a dev server (same arrangement as
 * `automations.cron.spec.ts`).
 *
 * What is pinned here:
 *   - the three shapes we distil, keyed off the built-in that produced them
 *   - the caps, because these payloads are persisted as jsonb on two tables and an
 *     uncapped `Write` would carry a whole file into the database on every turn
 *   - that an unknown tool, a missing payload or a malformed one yields `null` rather
 *     than throwing — this runs inside the stream loop, where an exception kills the turn
 *   - the difference between "nothing changed" and "we could not produce a diff", which
 *     the card renders as two different sentences
 */

/** A `structuredPatch` hunk in the SDK's shape. */
function hunk(lines: string[], newStart = 1) {
	return { oldStart: newStart, oldLines: lines.length, newStart, newLines: lines.length, lines }
}

test.describe('file edits', () => {
	test('Edit yields a diff with counts taken from the patch', () => {
		const details = toolResultDetails(
			'Edit',
			{
				filePath: '/w/src/app.ts',
				oldString: 'a',
				newString: 'b',
				originalFile: 'a\n',
				structuredPatch: [hunk([' context', '-a', '+b', '+c'], 10)],
			},
			{ file_path: '/w/src/app.ts' },
		)

		expect(details?.kind).toBe('file_edit')
		if (details?.kind !== 'file_edit') return
		expect(details.path).toBe('/w/src/app.ts')
		expect(details.tool).toBe('Edit')
		expect(details.changeType).toBe('update')
		expect(details.additions).toBe(2)
		expect(details.deletions).toBe(1)
		expect(details.unavailable).toBe('none')
		expect(details.truncated).toBe(false)
		expect(details.hunks[0].newStart).toBe(10)
	})

	test('git counts win over counted lines, because they describe the whole change', () => {
		// The point of the preference: hunks can be capped, gitDiff's totals cannot.
		const details = toolResultDetails('Edit', {
			filePath: '/w/a.ts',
			structuredPatch: [hunk(['+one'])],
			gitDiff: { filename: 'a.ts', status: 'modified', additions: 42, deletions: 7, changes: 49, patch: '' },
		})

		expect(details?.kind === 'file_edit' && details.additions).toBe(42)
		expect(details?.kind === 'file_edit' && details.deletions).toBe(7)
	})

	test('Write reports a create, and falls back to the call arguments for the path', () => {
		const details = toolResultDetails(
			'Write',
			{ type: 'create', originalFile: null, structuredPatch: [hunk(['+hello'])] },
			{ file_path: '/w/new.md' },
		)

		expect(details?.kind === 'file_edit' && details.changeType).toBe('create')
		expect(details?.kind === 'file_edit' && details.path).toBe('/w/new.md')
		// A create with no previous contents is not a missing diff.
		expect(details?.kind === 'file_edit' && details.unavailable).toBe('none')
	})

	test('an empty patch means "nothing changed" when the original is in hand', () => {
		const details = toolResultDetails('Write', {
			type: 'update',
			filePath: '/w/same.txt',
			originalFile: 'unchanged\n',
			structuredPatch: [],
		})

		expect(details?.kind === 'file_edit' && details.unavailable).toBe('no_change')
	})

	test('an empty patch with no original means the SDK could not diff it', () => {
		// The SDK documents `originalFile: null` on an update for contents too large to diff,
		// and an empty patch for a diff that timed out. Those are not "no change" and the card
		// must not claim they are.
		const details = toolResultDetails('Write', {
			type: 'update',
			filePath: '/w/huge.bin',
			originalFile: null,
			structuredPatch: [],
		})

		expect(details?.kind === 'file_edit' && details.unavailable).toBe('diff_missing')
	})

	test('hunks past the line budget are dropped whole, and flagged', () => {
		const big = Array.from({ length: MAX_DIFF_LINES }, (_, i) => `+line ${i}`)
		const details = toolResultDetails('Edit', {
			filePath: '/w/big.ts',
			structuredPatch: [hunk(big), hunk(['+one more'], 900)],
		})

		expect(details?.kind).toBe('file_edit')
		if (details?.kind !== 'file_edit') return
		expect(details.truncated).toBe(true)
		// The first hunk fits exactly; the second would overflow, so it is dropped entire
		// rather than cut in half.
		expect(details.hunks).toHaveLength(1)
		expect(details.hunks[0].lines).toHaveLength(MAX_DIFF_LINES)
	})

	test('a payload with no path at all is declined', () => {
		expect(toolResultDetails('Edit', { structuredPatch: [hunk(['+x'])] })).toBeNull()
	})
})

test.describe('shell', () => {
	test('Bash yields separated streams and the command from its arguments', () => {
		const details = toolResultDetails(
			'Bash',
			{ stdout: 'ok\n', stderr: '', interrupted: false },
			{ command: 'bun run check', description: 'Typecheck the project' },
		)

		expect(details?.kind).toBe('shell')
		if (details?.kind !== 'shell') return
		expect(details.command).toBe('bun run check')
		expect(details.description).toBe('Typecheck the project')
		expect(details.stdout).toBe('ok\n')
		expect(details.interrupted).toBe(false)
		expect(details.backgroundTaskId).toBeNull()
		expect(details.truncated).toBe(false)
	})

	test('a backgrounded command carries its handle instead of pretending to be finished', () => {
		const details = toolResultDetails(
			'Bash',
			{ stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'task_42', timedOutAfterMs: 120_000 },
			{ command: 'bun run dev', run_in_background: true },
		)

		expect(details?.kind === 'shell' && details.backgroundTaskId).toBe('task_42')
		expect(details?.kind === 'shell' && details.timedOutAfterMs).toBe(120_000)
	})

	test('over-long output keeps the tail, where a failing command explains itself', () => {
		const stdout = `${'x'.repeat(MAX_STREAM_CHARS)}FAILED HERE`
		const details = toolResultDetails('Bash', { stdout, stderr: '', interrupted: false })

		expect(details?.kind).toBe('shell')
		if (details?.kind !== 'shell') return
		expect(details.truncated).toBe(true)
		expect(details.stdout).toHaveLength(MAX_STREAM_CHARS)
		expect(details.stdout.endsWith('FAILED HERE')).toBe(true)
	})

	test('an interrupted command says so', () => {
		const details = toolResultDetails('Bash', { stdout: 'partial', stderr: '', interrupted: true })
		expect(details?.kind === 'shell' && details.interrupted).toBe(true)
	})

	test('a payload carrying none of the known fields is declined', () => {
		// Something else wearing the name is not a shell result.
		expect(toolResultDetails('Bash', { somethingElse: true })).toBeNull()
	})

	test('a failed command is still a terminal, with the exit code the CLI reported (#26)', () => {
		// A non-zero exit makes the CLI throw: there is no BashOutput, only its error text —
		// `Exit code N` on the first line, then the command's merged output.
		const details = toolResultDetails(
			'Bash',
			'Error: Exit code 2\nnpm ERR! Missing script: "tset"\n',
			{ command: 'npm run tset', description: 'Run the tests' },
		)
		expect(details?.kind).toBe('shell')
		if (details?.kind !== 'shell') return
		expect(details.exitCode).toBe(2)
		expect(details.command).toBe('npm run tset')
		expect(details.stdout).toBe('npm ERR! Missing script: "tset"\n')
		expect(details.stderr).toBe('')

		// The same text inside the model-facing wrapper reads the same way.
		const wrapped = toolResultDetails('Bash', '<tool_use_error>Exit code 1\nboom</tool_use_error>', {})
		expect(wrapped?.kind === 'shell' && wrapped.exitCode).toBe(1)
		expect(wrapped?.kind === 'shell' && wrapped.stdout).toBe('boom')
	})

	test('an error that is not a command exiting stays on the generic card', () => {
		expect(toolResultDetails('Bash', 'Error: Path is outside this run\'s workspace: /etc', {})).toBeNull()
		// "Exit code" later in the text is the command talking, not the CLI.
		expect(toolResultDetails('Bash', 'Error: something\nExit code 3', {})).toBeNull()
	})

	test("the CLI's reading of a special exit code is kept", () => {
		const details = toolResultDetails('Bash', {
			stdout: '',
			stderr: '',
			interrupted: false,
			returnCodeInterpretation: 'No matches found',
		})
		expect(details?.kind === 'shell' && details.returnCodeInterpretation).toBe('No matches found')
	})

	test('live output grows the same tail the result keeps', () => {
		expect(appendStreamTail('ab', 'cd')).toEqual({ text: 'abcd', truncated: false })
		const grown = appendStreamTail('x'.repeat(MAX_STREAM_CHARS), 'END')
		expect(grown.truncated).toBe(true)
		expect(grown.text).toHaveLength(MAX_STREAM_CHARS)
		expect(grown.text.endsWith('END')).toBe(true)
	})

	test('only Bash is a terminal: the removed polling tools and TaskStop are not (#35)', () => {
		const streams = { stdout: 'x', stderr: '', interrupted: false }
		expect(toolResultDetails('BashOutput', streams)).toBeNull()
		expect(toolResultDetails('KillShell', streams)).toBeNull()
		// TaskStop's own output has no streams to show.
		expect(toolResultDetails('TaskStop', { message: 'Stopped', task_id: 'b1', task_type: 'local_bash' })).toBeNull()
	})
})

test.describe('todos', () => {
	test('TodoWrite yields the post-update list with a completed count', () => {
		const details = toolResultDetails('TodoWrite', {
			oldTodos: [],
			newTodos: [
				{ content: 'Read the code', status: 'completed', activeForm: 'Reading the code' },
				{ content: 'Write the adapter', status: 'in_progress', activeForm: 'Writing the adapter' },
				{ content: 'Render it', status: 'pending', activeForm: 'Rendering it' },
			],
		})

		expect(details?.kind).toBe('todo')
		if (details?.kind !== 'todo') return
		expect(details.total).toBe(3)
		expect(details.completed).toBe(1)
		expect(details.items[1].activeForm).toBe('Writing the adapter')
		expect(details.truncated).toBe(false)
	})

	test('the call arguments stand in when the output omits the list', () => {
		const details = toolResultDetails('TodoWrite', {}, { todos: [{ content: 'Only in args', status: 'pending' }] })

		expect(details?.kind === 'todo' && details.total).toBe(1)
		expect(details?.kind === 'todo' && details.items[0].activeForm).toBeNull()
	})

	test('an unrecognised status degrades to pending rather than rendering nothing', () => {
		const details = toolResultDetails('TodoWrite', {
			newTodos: [{ content: 'Odd one', status: 'blocked', activeForm: '' }],
		})

		expect(details?.kind === 'todo' && details.items[0].status).toBe('pending')
	})

	test('a runaway list is capped and flagged', () => {
		const newTodos = Array.from({ length: MAX_TODO_ITEMS + 5 }, (_, i) => ({
			content: `item ${i}`,
			status: 'pending',
			activeForm: '',
		}))
		const details = toolResultDetails('TodoWrite', { newTodos })

		expect(details?.kind === 'todo' && details.total).toBe(MAX_TODO_ITEMS)
		expect(details?.kind === 'todo' && details.truncated).toBe(true)
	})

	test('an empty list is declined — there is nothing to render', () => {
		expect(toolResultDetails('TodoWrite', { newTodos: [] })).toBeNull()
	})
})

test.describe('falling back to the generic card', () => {
	test('tools we do not distil are declined by name alone', () => {
		expect(hasToolResultDetails('web_search')).toBe(false)
		expect(hasToolResultDetails('Read')).toBe(false)
		expect(hasToolResultDetails('Edit')).toBe(true)
		expect(toolResultDetails('web_search', { results: [] })).toBeNull()
		expect(toolResultDetails('run_code', { returnValue: 1 })).toBeNull()
	})

	test('a missing or malformed payload never throws', () => {
		// The engine calls this for every completed tool call. An exception here would take
		// the whole turn with it, so every one of these must be a quiet null.
		for (const payload of [undefined, null, 'a string', 42, [], { structuredPatch: 'not an array' }]) {
			expect(() => toolResultDetails('Edit', payload)).not.toThrow()
			expect(() => toolResultDetails('Bash', payload)).not.toThrow()
			expect(() => toolResultDetails('TodoWrite', payload)).not.toThrow()
		}

		expect(toolResultDetails('Edit', undefined)).toBeNull()
		expect(toolResultDetails('Bash', null)).toBeNull()
		expect(toolResultDetails('TodoWrite', 'nope')).toBeNull()
	})

	test('hunks with no usable lines are skipped rather than rendered empty', () => {
		const details = toolResultDetails('Edit', {
			filePath: '/w/a.ts',
			originalFile: 'x',
			structuredPatch: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 0, lines: [] }, hunk(['+kept'])],
		})

		expect(details?.kind === 'file_edit' && details.hunks).toHaveLength(1)
		expect(details?.kind === 'file_edit' && details.hunks[0].lines[0]).toBe('+kept')
	})
})
