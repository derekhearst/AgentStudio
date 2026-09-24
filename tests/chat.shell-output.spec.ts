import { expect, test } from '@playwright/test'
import { cleanTerminalText, tailLines } from '../src/lib/chat/terminal-text'
import {
	applyShellOutput,
	applyShellTaskDone,
	getSerializableBlocksForMetadata,
	type StreamingBlock,
	type ToolBlock,
} from '../src/lib/chat/streaming-blocks'
import { MAX_STREAM_CHARS, type ShellDetails } from '../src/lib/engine/tool-result-details'

/**
 * #26 / #35 — the shell card's text, and how a live background command's card is built up.
 *
 * Pure: the card's rendering rules and the page's frame handlers, without a page. What the
 * card looks like is `chat.shell-output-render.spec.ts`.
 */

const ESC = '\u001b'

test.describe('terminal text', () => {
	test('colour, truecolour and private-mode escapes are stripped', () => {
		expect(cleanTerminalText(`${ESC}[31mred${ESC}[0m plain`)).toBe('red plain')
		expect(cleanTerminalText(`${ESC}[38:2:255:0:0mtrue${ESC}[m`)).toBe('true')
		expect(cleanTerminalText(`${ESC}[>4;2mkeys${ESC}[?25l`)).toBe('keys')
	})

	test('hyperlinks and window titles are stripped, their text kept', () => {
		expect(cleanTerminalText(`${ESC}]8;;https://example.com${ESC}\\link${ESC}]8;;${ESC}\\`)).toBe('link')
		expect(cleanTerminalText(`${ESC}]0;my title\u0007after`)).toBe('after')
	})

	test('the charset reset tput sgr0 prints is stripped', () => {
		expect(cleanTerminalText(`bold${ESC}(B${ESC}[m done`)).toBe('bold done')
	})

	test('a progress bar redrawn with carriage returns shows its last state', () => {
		expect(cleanTerminalText('10%\r50%\r100%\ndone\n')).toBe('100%\ndone\n')
		// What a terminal shows: a shorter redraw leaves the rest of the longer line.
		expect(cleanTerminalText('abcdef\rXY')).toBe('XYcdef')
		// A trailing carriage return moves the cursor and erases nothing.
		expect(cleanTerminalText('ready\r')).toBe('ready')
	})

	test('CRLF is a line break, not a redraw', () => {
		expect(cleanTerminalText('one\r\ntwo\r\n')).toBe('one\ntwo\n')
	})

	test('a tail cut mid-escape loses its fragment of a first line, not the rest', () => {
		// The ESC was cut off with the head, so `[31m` is no longer an escape anything can spot.
		expect(cleanTerminalText('[31mred start\nnext line\n', { clipped: true })).toBe('next line\n')
		expect(cleanTerminalText('[31mred start\nnext line\n')).toBe('[31mred start\nnext line\n')
		// A single line with nothing after it is all there is: kept.
		expect(cleanTerminalText('one long line', { clipped: true })).toBe('one long line')
	})

	test('the last lines are what a long output shows first', () => {
		const text = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
		const preview = tailLines(text, 20)
		expect(preview.total).toBe(40)
		expect(preview.hidden).toBe(20)
		expect(preview.shown.split('\n')[0]).toBe('line 21')
		expect(preview.shown.endsWith('line 40')).toBe(true)
		expect(tailLines('a\nb\n', 20)).toEqual({ shown: 'a\nb\n', hidden: 0, total: 2 })
		expect(tailLines('', 20)).toEqual({ shown: '', hidden: 0, total: 0 })
	})
})

function shellBlock(overrides: Partial<ShellDetails> = {}): ToolBlock {
	return {
		kind: 'tool',
		id: 'bg1',
		name: 'Bash',
		arguments: '{"command":"npm run dev","run_in_background":true}',
		status: 'completed',
		expanded: true,
		details: {
			kind: 'shell',
			tool: 'Bash',
			command: 'npm run dev',
			description: null,
			stdout: '',
			stderr: '',
			interrupted: false,
			backgroundTaskId: 'b1',
			timedOutAfterMs: null,
			persistedOutputPath: null,
			truncated: false,
			background: { status: 'running' },
			...overrides,
		},
	}
}

const detailsOf = (blocks: StreamingBlock[]) => {
	const block = blocks[0]
	if (block.kind !== 'tool' || block.details?.kind !== 'shell') throw new Error('not a shell block')
	return block.details
}

test.describe('the live card (#35)', () => {
	test('output is added in order; a reset starts the card over', () => {
		let blocks: StreamingBlock[] = [shellBlock({ stdout: 'placeholder' })]
		blocks = applyShellOutput(blocks, { id: 'bg1', chunk: 'one\n', reset: true, from: 0, to: 4 })
		blocks = applyShellOutput(blocks, { id: 'bg1', chunk: 'two\n', reset: false, from: 4, to: 8 })
		expect(detailsOf(blocks).stdout).toBe('one\ntwo\n')
		expect(detailsOf(blocks).truncated).toBe(false)

		blocks = applyShellOutput(blocks, { id: 'bg1', chunk: 'fresh\n', reset: true, from: 0, to: 6 })
		expect(detailsOf(blocks).stdout).toBe('fresh\n')
	})

	test('the card keeps the same tail the server does', () => {
		let blocks: StreamingBlock[] = [shellBlock({ stdout: 'x'.repeat(MAX_STREAM_CHARS - 2) })]
		blocks = applyShellOutput(blocks, { id: 'bg1', chunk: 'END', from: 0, to: 3 })
		expect(detailsOf(blocks).stdout).toHaveLength(MAX_STREAM_CHARS)
		expect(detailsOf(blocks).stdout.endsWith('END')).toBe(true)
		expect(detailsOf(blocks).truncated).toBe(true)
	})

	test('a saved checkpoint the card already has changes nothing; one that overlaps adds only what is new', () => {
		let blocks: StreamingBlock[] = [shellBlock()]
		blocks = applyShellOutput(blocks, { id: 'bg1', chunk: 'one\n', reset: true, from: 0, to: 4 })
		blocks = applyShellOutput(blocks, { id: 'bg1', chunk: 'two\n', reset: false, from: 4, to: 8 })

		// A connected page gets the checkpoint of what it already has, just after it.
		expect(applyShellOutput(blocks, { id: 'bg1', chunk: 'two\n', reset: false, from: 4, to: 8 })).toEqual(blocks)
		const sameReset = applyShellOutput(blocks, { id: 'bg1', chunk: 'one\ntwo\n', reset: true, from: 0, to: 8 })
		expect(detailsOf(sameReset)).toMatchObject({ stdout: 'one\ntwo\n', truncated: false })

		// A page that reconnected has up to 8; the replayed checkpoint covers 4 to 12.
		const caughtUp = applyShellOutput(blocks, { id: 'bg1', chunk: 'two\nsix\n', reset: false, from: 4, to: 12 })
		expect(detailsOf(caughtUp)).toMatchObject({ stdout: 'one\ntwo\nsix\n', truncated: false })
	})

	test('a chunk that does not start where the card left off marks the output as a tail', () => {
		// Output the page never saw: a chunk cut to the cap, or frames lost on the way.
		let blocks: StreamingBlock[] = [shellBlock()]
		blocks = applyShellOutput(blocks, { id: 'bg1', chunk: 'late\n', reset: false, from: 900, to: 905 })
		expect(detailsOf(blocks).stdout).toBe('late\n')
		expect(detailsOf(blocks).truncated).toBe(true)
	})

	test('a settled card takes the final output and ignores anything after it', () => {
		let blocks: StreamingBlock[] = [shellBlock({ stdout: 'partial' })]
		blocks = applyShellTaskDone(blocks, { id: 'bg1', status: 'completed', exitCode: 0, stdout: 'all of it\n', truncated: false })
		expect(detailsOf(blocks)).toMatchObject({ stdout: 'all of it\n', exitCode: 0, background: { status: 'completed' } })

		blocks = applyShellOutput(blocks, { id: 'bg1', chunk: 'stray', from: 10, to: 15 })
		expect(detailsOf(blocks).stdout).toBe('all of it\n')
		expect(detailsOf(blocks).background).toEqual({ status: 'completed' })
	})

	test('frames for another call, or with no status, change nothing', () => {
		const blocks: StreamingBlock[] = [shellBlock({ stdout: 'mine' })]
		expect(applyShellOutput(blocks, { id: 'other', chunk: 'x' })).toEqual(blocks)
		expect(applyShellTaskDone(blocks, { id: 'other', status: 'completed' })).toEqual(blocks)
		expect(applyShellTaskDone(blocks, { id: 'bg1' })).toEqual(blocks)
	})

	test('a card still running when the page saves a partial is saved as ended with the turn', () => {
		// The page only saves blocks itself once the turn is over (Stop, an error), and a
		// background command does not outlive its turn.
		const saved = getSerializableBlocksForMetadata([shellBlock({ stdout: 'up\n' })])
		expect((saved[0].details as ShellDetails).background).toEqual({ status: 'ended_with_turn' })
		expect((saved[0].details as ShellDetails).stdout).toBe('up\n')
	})
})
