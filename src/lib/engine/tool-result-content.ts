/**
 * How a tool's result crosses the MCP boundary into the model, and how the SDK's
 * `tool_result` comes back out as the text the transcript keeps.
 *
 * Most results are JSON and travel as one text block. An image result — anything shaped
 * `{ mimeType: 'image/…', imageBase64 }`, which today means `browser_screenshot` — travels as
 * an image block instead, next to a short text block with its other fields. Sent as text, a
 * screenshot was a few hundred kilobytes of base64 the model could not look at, which used
 * up the context or hit the SDK's output cap and gave the model nothing.
 *
 * On the way back the SDK hands us Anthropic-format blocks. The transcript and the tool card
 * still expect the single JSON string they always had, `{ …, mimeType, imageBase64 }`, so
 * `toolResultText` folds the image back into it.
 *
 * Pure — no SDK import, no I/O — so a spec can pin both directions.
 */

export type ToolResultContentBlock = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

type ImageResult = Record<string, unknown> & { mimeType: string; imageBase64: string }

function imageResult(result: unknown): ImageResult | null {
	if (!result || typeof result !== 'object' || Array.isArray(result)) return null
	const r = result as Record<string, unknown>
	if (typeof r.mimeType !== 'string' || !r.mimeType.startsWith('image/')) return null
	if (typeof r.imageBase64 !== 'string' || r.imageBase64.length === 0) return null
	return r as ImageResult
}

/** MCP content blocks for a successful tool result. */
export function toolResultContent(result: unknown): ToolResultContentBlock[] {
	const image = imageResult(result)
	if (image) {
		const { imageBase64, ...fields } = image
		return [
			{ type: 'text', text: JSON.stringify(fields) },
			{ type: 'image', data: imageBase64, mimeType: image.mimeType },
		]
	}
	return [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result ?? null) }]
}

/** The base64 image in a returned content block, in either the Anthropic or the MCP shape. */
function blockImage(block: unknown): { data: string; mimeType: string } | null {
	if (!block || typeof block !== 'object') return null
	const b = block as { type?: unknown; source?: { type?: unknown; data?: unknown; media_type?: unknown }; data?: unknown; mimeType?: unknown }
	if (b.type !== 'image') return null
	if (b.source?.type === 'base64' && typeof b.source.data === 'string' && typeof b.source.media_type === 'string') {
		return { data: b.source.data, mimeType: b.source.media_type }
	}
	if (typeof b.data === 'string' && typeof b.mimeType === 'string') return { data: b.data, mimeType: b.mimeType }
	return null
}

/** The transcript's text for one `tool_result` block's `content`. */
export function toolResultText(raw: unknown): string {
	if (typeof raw === 'string') return raw
	if (!Array.isArray(raw)) return JSON.stringify(raw ?? null)
	const text = raw.map((c: { text?: unknown }) => (typeof c?.text === 'string' ? c.text : '')).join('')
	const image = raw.map(blockImage).find((i) => i !== null)
	if (!image) return text

	let fields: Record<string, unknown> = {}
	try {
		const parsed: unknown = JSON.parse(text)
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) fields = parsed as Record<string, unknown>
	} catch {
		if (text) fields = { text }
	}
	return JSON.stringify({ ...fields, mimeType: image.mimeType, imageBase64: image.data })
}
