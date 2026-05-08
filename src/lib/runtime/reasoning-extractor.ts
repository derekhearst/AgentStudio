/**
 * OpenRouter `reasoning_details` decoder.
 *
 * Models stream reasoning content as an array of typed deltas:
 *   - `reasoning.text`      — visible chain-of-thought text (Anthropic, Gemini, etc.)
 *   - `reasoning.summary`   — model-summarized reasoning (some o1/o3-style models)
 *   - `reasoning.encrypted` — encrypted reasoning the provider doesn't expose; we surface
 *                             a placeholder so the UI shows "Reasoning hidden" rather than
 *                             silently dropping it.
 *
 * The extractor is a pure function so the chat loop's reasoning-stream branch can be
 * unit-tested independently of streaming I/O.
 */

export type ReasoningDetail = {
	type?: string | null
	text?: string | null
	summary?: string | null
	data?: string | null
	[key: string]: unknown
}

export function extractReasoningFragment(details: ReasoningDetail[] | undefined): string {
	if (!details?.length) return ''
	return details
		.map((detail) => {
			switch (detail.type) {
				case 'reasoning.text':
					return typeof detail.text === 'string' ? detail.text : ''
				case 'reasoning.summary':
					return typeof detail.summary === 'string' ? detail.summary : ''
				case 'reasoning.encrypted':
					return '[Reasoning hidden by provider]'
				default:
					return typeof detail.text === 'string' ? detail.text : ''
			}
		})
		.join('')
}
