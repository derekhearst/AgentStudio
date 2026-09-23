/**
 * Reading the user's answers back out of an `ask_user` tool result (#81).
 *
 * The host hands the model its answers as plain text, one `Header: answer` per question
 * (`fulfilAskUser` in the chat stream). That text is also what the transcript records as the
 * call's result, live and after a reload. The cards only understood a JSON
 * `{ answers: { … } }` result, which nothing produces any more, so an answered question never
 * showed its answer. Both shapes are read here; JSON wins when it is there.
 *
 * No imports on purpose: the transcript helpers load this in the plain Playwright loader too.
 */

/**
 * Split `Header: answer` lines back into answers, given the questions' headers.
 *
 * An answer may run over several lines, so a line belongs to the answer above it unless it
 * opens with a header that has not been answered yet. Longest headers are tried first, so
 * "Color scheme" is not read as "Color". Returns null when no header is found, which is
 * also what the "did not answer in time" result reads as.
 */
export function parseAskUserAnswerText(text: string, headers: string[]): Record<string, string> | null {
	const known = [...new Set(headers)].sort((a, b) => b.length - a.length)
	const answers: Record<string, string> = {}
	let current: string | null = null

	for (const line of text.split('\n')) {
		const header = known.find(
			(candidate) => !(candidate in answers) && (line.startsWith(`${candidate}: `) || line === `${candidate}:`),
		)
		if (header !== undefined) {
			current = header
			answers[header] = line.slice(header.length + 1).replace(/^ /, '')
		} else if (current !== null) {
			answers[current] += `\n${line}`
		}
	}

	const trimmed = Object.entries(answers)
		.map(([header, answer]) => [header, answer.trim()] as const)
		.filter(([, answer]) => answer.length > 0)
	return trimmed.length > 0 ? Object.fromEntries(trimmed) : null
}

/**
 * The answers an `ask_user` result carries, whichever shape it was saved in: a JSON object
 * (or its string) with an `answers` map, or the host's `Header: answer` text.
 */
export function readAskUserAnswers(result: unknown, headers: string[]): Record<string, string> | null {
	let record: unknown = result
	if (typeof result === 'string') {
		try {
			record = JSON.parse(result)
		} catch {
			return parseAskUserAnswerText(result, headers)
		}
	}
	const answers =
		record && typeof record === 'object' && !Array.isArray(record)
			? (record as Record<string, unknown>).answers
			: null
	if (answers && typeof answers === 'object' && !Array.isArray(answers)) {
		const out: Record<string, string> = {}
		for (const [header, value] of Object.entries(answers as Record<string, unknown>)) {
			if (typeof value === 'string') out[header] = value
		}
		return Object.keys(out).length > 0 ? out : null
	}
	return typeof result === 'string' ? parseAskUserAnswerText(result, headers) : null
}
