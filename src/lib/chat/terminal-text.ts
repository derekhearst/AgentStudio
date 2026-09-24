/**
 * Terminal output, made readable as plain text (#26).
 *
 * Commands write for a terminal: colour codes, hyperlinks, window titles, and progress bars
 * that redraw one line with a carriage return. The shell card shows text, so all of that is
 * taken out rather than rendered — half-supported colour reads worse than none, and nothing
 * in this workload emits colour worth keeping.
 *
 * Pure, with no `$lib` imports, so specs can load it directly.
 */

/** CSI: colours and cursor movement, with any parameter bytes (`38:2:…` truecolour, `?25l`, `>4;2m`). */
const CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g
/** OSC: hyperlinks (`ESC]8;;url ESC\`), window titles — ended by BEL or ST. */
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g
/** Character-set selection (`ESC(B`, which `tput sgr0` prints) and the two-byte escapes. */
const SHORT_ESCAPE = /\u001b[()*+][0-9A-Za-z]|\u001b[=>78cDEHMNOZ]/g
/** Whatever control characters are left, a lone ESC included — never `\n` or `\t`. */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

/**
 * What a bare carriage return leaves on screen: the cursor goes back to the start of the
 * line and what follows overwrites what was there. `10%\r50%\r100%` is `100%`.
 */
function overwriteLine(line: string): string {
	if (!line.includes('\r')) return line
	return line.split('\r').reduce((screen, segment) => segment + screen.slice(segment.length), '')
}

/**
 * Strip escapes and control characters, and resolve carriage-return redraws.
 *
 * `clipped` says the text is the tail of something longer, cut at an arbitrary character. Its
 * first line is then a fragment, and can start with half an escape sequence — `[31m` with its
 * ESC cut off — that no pattern here can tell from real text. So that line is dropped, as long
 * as there is a line after it; the card already says earlier output was trimmed.
 */
export function cleanTerminalText(text: string, options: { clipped?: boolean } = {}): string {
	if (!text) return ''
	let source = text
	if (options.clipped) {
		const firstBreak = source.indexOf('\n')
		if (firstBreak >= 0 && firstBreak < source.length - 1) source = source.slice(firstBreak + 1)
	}
	const stripped = source.replace(OSC, '').replace(CSI, '').replace(SHORT_ESCAPE, '')
	// CRLF is a line break, not a redraw.
	const lines = stripped.replace(/\r\n/g, '\n').split('\n').map(overwriteLine)
	return lines.join('\n').replace(CONTROL, '')
}

export type LinePreview = {
	/** The text to show. */
	shown: string
	/** Lines left out at the top. */
	hidden: number
	/** Lines in the whole text. A trailing newline does not start another. */
	total: number
}

/** The last `limit` lines of `text` — where a command explains how it ended. */
export function tailLines(text: string, limit: number): LinePreview {
	if (!text) return { shown: '', hidden: 0, total: 0 }
	const body = text.endsWith('\n') ? text.slice(0, -1) : text
	const lines = body.split('\n')
	if (lines.length <= limit) return { shown: text, hidden: 0, total: lines.length }
	return { shown: lines.slice(-limit).join('\n'), hidden: lines.length - limit, total: lines.length }
}
