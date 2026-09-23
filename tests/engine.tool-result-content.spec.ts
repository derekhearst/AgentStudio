import { expect, test } from '@playwright/test'
import { toolResultContent, toolResultText } from '../src/lib/engine/tool-result-content'

/**
 * #46 — browser_screenshot's image reaches the model as an image, not as base64 text.
 *
 * Pure-function tests: `src/lib/engine/tool-result-content.ts` has no SDK import and no I/O.
 *
 * What is pinned:
 *   - an `{ mimeType: 'image/…', imageBase64 }` result becomes a short text block plus an MCP
 *     image block, and the base64 is kept out of the text channel
 *   - every other result is still one JSON text block, exactly as before
 *   - on the way back, the SDK's Anthropic-format image block is folded into the JSON string
 *     the transcript stores and the tool card renders (`{ …, imageBase64 }`)
 *   - only for browser_screenshot: an image from any other tool (the SDK's `Read` on a PNG, an
 *     external MCP server) is dropped from the stored text exactly as it was before, instead
 *     of landing in the transcript, the card and the context count as base64
 */

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

test.describe('tool result → MCP content', () => {
	test('an image result becomes a caption plus an image block', () => {
		const content = toolResultContent({ url: 'https://example.com/', title: 'Example', mimeType: 'image/png', imageBase64: PNG })
		expect(content).toHaveLength(2)
		expect(content[1]).toEqual({ type: 'image', data: PNG, mimeType: 'image/png' })
		const caption = content[0]
		expect(caption.type).toBe('text')
		if (caption.type !== 'text') return
		expect(JSON.parse(caption.text)).toEqual({ url: 'https://example.com/', title: 'Example', mimeType: 'image/png' })
		// The whole point: no base64 in the text the model reads.
		expect(caption.text).not.toContain(PNG)
	})

	test('everything else is still a single JSON text block', () => {
		expect(toolResultContent({ a: 1 })).toEqual([{ type: 'text', text: '{"a":1}' }])
		expect(toolResultContent('plain')).toEqual([{ type: 'text', text: 'plain' }])
		expect(toolResultContent(null)).toEqual([{ type: 'text', text: 'null' }])
		expect(toolResultContent(undefined)).toEqual([{ type: 'text', text: 'null' }])
		expect(toolResultContent([1, 2])).toEqual([{ type: 'text', text: '[1,2]' }])
	})

	test('something that only looks like an image stays text', () => {
		for (const result of [
			{ mimeType: 'application/pdf', imageBase64: PNG },
			{ mimeType: 'image/png', imageBase64: '' },
			{ mimeType: 'image/png' },
			{ imageBase64: PNG },
		]) {
			const content = toolResultContent(result)
			expect(content, JSON.stringify(result).slice(0, 60)).toHaveLength(1)
			expect(content[0].type).toBe('text')
		}
	})
})

test.describe('SDK tool_result → transcript text', () => {
	test('text-only content is joined exactly as before', () => {
		for (const tool of ['web_fetch', 'browser_screenshot', 'Read']) {
			expect(toolResultText('already a string', tool)).toBe('already a string')
			expect(toolResultText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], tool)).toBe('ab')
			expect(toolResultText(null, tool)).toBe('null')
			expect(toolResultText({ x: 1 }, tool)).toBe('{"x":1}')
		}
	})

	test('an Anthropic image block is folded back into the JSON the tool card renders', () => {
		const text = toolResultText(
			[
				{ type: 'text', text: '{"url":"https://example.com/","mimeType":"image/png"}' },
				{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
			],
			'browser_screenshot',
		)
		const parsed = JSON.parse(text)
		expect(parsed).toEqual({ url: 'https://example.com/', mimeType: 'image/png', imageBase64: PNG })
	})

	test('an MCP-shaped image block is understood too', () => {
		const parsed = JSON.parse(toolResultText([{ type: 'image', data: PNG, mimeType: 'image/jpeg' }], 'browser_screenshot'))
		expect(parsed).toEqual({ mimeType: 'image/jpeg', imageBase64: PNG })
	})

	test('round trip: what goes out as an image comes back as the same pixels', () => {
		const sent = toolResultContent({ url: 'https://example.com/', title: 'Example', mimeType: 'image/png', imageBase64: PNG })
		// What the SDK hands back for that content: text blocks as-is, images in Anthropic form.
		const returned = sent.map((block) =>
			block.type === 'image'
				? { type: 'image', source: { type: 'base64', media_type: block.mimeType, data: block.data } }
				: block,
		)
		expect(JSON.parse(toolResultText(returned, 'browser_screenshot'))).toEqual({
			url: 'https://example.com/',
			title: 'Example',
			mimeType: 'image/png',
			imageBase64: PNG,
		})
	})
})

test.describe('images from every other tool stay out of the transcript text', () => {
	const anthropicImage = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }

	test("the SDK's Read on a PNG (an image block, no caption) is stored as '' — as before", () => {
		expect(toolResultText([anthropicImage], 'Read')).toBe('')
	})

	test("an external MCP tool's image is dropped and its text kept — as before", () => {
		const text = toolResultText([{ type: 'text', text: 'captured' }, anthropicImage], 'mcp__other__screenshot')
		expect(text).toBe('captured')
		expect(text).not.toContain(PNG)
	})

	test('even when its caption looks like ours', () => {
		// Same shape browser_screenshot sends, from someone else's server: still not folded.
		const blocks = [{ type: 'text', text: '{"mimeType":"image/png"}' }, anthropicImage]
		expect(toolResultText(blocks, 'mcp__other__browser_screenshot')).toBe('{"mimeType":"image/png"}')
		expect(toolResultText(blocks, 'unknown')).toBe('{"mimeType":"image/png"}')
	})
})
