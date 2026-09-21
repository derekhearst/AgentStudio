import { expect, test } from '@playwright/test'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import {
	MAX_IMAGE_BYTES,
	formatAttachmentWarnings,
	prepareAttachmentPrompt,
	singleUserMessageStream,
	type AttachmentIo,
	type ChatAttachment,
} from '../src/lib/engine/attachments.server'
import { resolveUploadPath, safeAttachmentName } from '../src/lib/engine/attachment-io.server'

/**
 * #36 — attachments never reached the model on the engine path.
 *
 * These assert on the input constructed for the Claude Agent SDK rather than on
 * a model reply: the SDK's `query()` takes either a plain string (no images
 * possible) or an AsyncIterable<SDKUserMessage> whose `message` is an Anthropic
 * MessageParam, so "did the model receive the image" is answerable by consuming
 * that iterable. No database, no model call, no sandbox.
 */

const PNG_BYTES = Buffer.from(
	// 1x1 transparent PNG
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
	'base64',
)

function attachment(over: Partial<ChatAttachment> = {}): ChatAttachment {
	return {
		id: 'aaaabbbb-cccc-dddd-eeee-ffff00001111',
		filename: 'screenshot.png',
		mimeType: 'image/png',
		size: PNG_BYTES.length,
		url: '/api/upload/aaaabbbb.png',
		...over,
	}
}

function io(over: Partial<AttachmentIo> = {}): AttachmentIo {
	return {
		read: async () => PNG_BYTES,
		stage: async (a) => `attachments/stub-${a.filename}`,
		...over,
	}
}

async function collect(content: Parameters<typeof singleUserMessageStream>[0]) {
	const out: SDKUserMessage[] = []
	for await (const message of singleUserMessageStream(content)) out.push(message)
	return out
}

test.describe('engine/attachments — images reach the SDK', () => {
	test('an image attachment produces an image content block in the SDK user message', async () => {
		const prepared = await prepareAttachmentPrompt({
			text: "what's wrong here?",
			attachments: [attachment()],
			availableTools: null,
			io: io(),
		})

		expect(prepared.warnings).toEqual([])
		expect(prepared.content).not.toBeNull()

		// This is the payload query() is handed. Consume it exactly as the SDK would.
		const messages = await collect(prepared.content!)
		expect(messages).toHaveLength(1)
		expect(messages[0].type).toBe('user')
		expect(messages[0].parent_tool_use_id).toBeNull()

		const blocks = messages[0].message.content as Array<Record<string, any>>
		expect(Array.isArray(blocks)).toBe(true)
		expect(blocks[0]).toEqual({ type: 'text', text: "what's wrong here?" })

		const image = blocks.find((b) => b.type === 'image')
		expect(image, 'the image block must be present — this is the bug in #36').toBeTruthy()
		expect(image!.source.type).toBe('base64')
		expect(image!.source.media_type).toBe('image/png')
		expect(image!.source.data).toBe(PNG_BYTES.toString('base64'))
	})

	test('several images are labelled so the model can tell them apart', async () => {
		const prepared = await prepareAttachmentPrompt({
			text: 'compare these',
			attachments: [attachment({ filename: 'before.png' }), attachment({ id: 'x2', filename: 'after.png' })],
			availableTools: null,
			io: io(),
		})

		const blocks = (await collect(prepared.content!))[0].message.content as Array<Record<string, any>>
		expect(blocks.filter((b) => b.type === 'image')).toHaveLength(2)
		expect(blocks.some((b) => b.type === 'text' && b.text === 'Image: before.png')).toBe(true)
		expect(blocks.some((b) => b.type === 'text' && b.text === 'Image: after.png')).toBe(true)
	})

	test('a text-only turn stays on the plain string prompt', async () => {
		const prepared = await prepareAttachmentPrompt({
			text: 'hello',
			attachments: [],
			availableTools: null,
			io: io(),
		})
		expect(prepared.content).toBeNull()
		expect(prepared.text).toBe('hello')
		expect(prepared.warnings).toEqual([])
	})
})

test.describe('engine/attachments — PDFs go through the workspace', () => {
	test('a PDF is staged and announced by path for pdf_read', async () => {
		const staged: string[] = []
		const prepared = await prepareAttachmentPrompt({
			text: 'summarise this',
			attachments: [attachment({ filename: 'spec.pdf', mimeType: 'application/pdf' })],
			availableTools: new Set(['pdf_read', 'file_read']),
			io: io({
				stage: async (a) => {
					staged.push(a.filename)
					return 'attachments/aaaabbbb-spec.pdf'
				},
			}),
		})

		expect(staged).toEqual(['spec.pdf'])
		expect(prepared.warnings).toEqual([])
		// No image, so no need for streaming-input mode — the path rides in the text.
		expect(prepared.content).toBeNull()
		expect(prepared.text).toContain('attachments/aaaabbbb-spec.pdf')
		expect(prepared.text).toContain('pdf_read')
	})

	test('a PDF warns instead of dropping silently when the agent has no pdf_read', async () => {
		const prepared = await prepareAttachmentPrompt({
			text: 'summarise this',
			attachments: [attachment({ filename: 'spec.pdf', mimeType: 'application/pdf' })],
			availableTools: new Set(['web_search']),
			io: io(),
		})
		expect(prepared.warnings).toHaveLength(1)
		expect(prepared.warnings[0]).toContain('pdf_read')
	})

	test('a PDF warns when the run has no workspace to stage into', async () => {
		const prepared = await prepareAttachmentPrompt({
			text: 'summarise this',
			attachments: [attachment({ filename: 'spec.pdf', mimeType: 'application/pdf' })],
			availableTools: null,
			io: io({ stage: null }),
		})
		expect(prepared.warnings).toHaveLength(1)
		expect(prepared.warnings[0]).toContain('no agent workspace')
	})
})

test.describe('engine/attachments — nothing is dropped silently', () => {
	test('an oversized image warns rather than vanishing', async () => {
		const prepared = await prepareAttachmentPrompt({
			text: 'look',
			attachments: [attachment()],
			availableTools: null,
			io: io({ read: async () => Buffer.alloc(MAX_IMAGE_BYTES + 1) }),
		})
		expect(prepared.content).toBeNull()
		expect(prepared.warnings).toHaveLength(1)
		expect(prepared.warnings[0]).toContain('limit')
	})

	test('an unsupported image format warns', async () => {
		const prepared = await prepareAttachmentPrompt({
			text: 'look',
			attachments: [attachment({ filename: 'scan.tiff', mimeType: 'image/tiff' })],
			availableTools: null,
			io: io(),
		})
		expect(prepared.content).toBeNull()
		expect(prepared.warnings[0]).toContain('scan.tiff')
	})

	test('a video warns that the model cannot watch it', async () => {
		const prepared = await prepareAttachmentPrompt({
			text: 'what happens here',
			attachments: [attachment({ filename: 'clip.mp4', mimeType: 'video/mp4' })],
			availableTools: null,
			io: io(),
		})
		expect(prepared.warnings).toHaveLength(1)
		expect(prepared.warnings[0]).toContain('cannot be watched')
	})

	test('an unreadable upload warns instead of failing the turn', async () => {
		const prepared = await prepareAttachmentPrompt({
			text: 'look',
			attachments: [attachment()],
			availableTools: null,
			io: io({
				read: async () => {
					throw new Error('ENOENT')
				},
			}),
		})
		expect(prepared.content).toBeNull()
		expect(prepared.warnings[0]).toContain('ENOENT')
	})

	test('a failed staging write warns', async () => {
		const prepared = await prepareAttachmentPrompt({
			text: 'read this',
			attachments: [attachment({ filename: 'spec.pdf', mimeType: 'application/pdf' })],
			availableTools: null,
			io: io({
				stage: async () => {
					throw new Error('EACCES')
				},
			}),
		})
		expect(prepared.warnings[0]).toContain('EACCES')
	})

	test('warnings render as a markdown notice for the assistant turn', () => {
		expect(formatAttachmentWarnings([])).toBe('')
		const notice = formatAttachmentWarnings(['clip.mp4 (video/mp4) cannot be watched by the model.'])
		expect(notice).toContain('Attachment warning')
		expect(notice).toContain('clip.mp4')
		expect(notice.endsWith('\n\n')).toBe(true)
	})
})

test.describe('engine/attachments — small text files are inlined', () => {
	test('a small csv is inlined into the prompt text', async () => {
		const prepared = await prepareAttachmentPrompt({
			text: 'chart this',
			attachments: [attachment({ filename: 'data.csv', mimeType: 'text/csv' })],
			availableTools: null,
			io: io({ read: async () => Buffer.from('a,b\n1,2\n', 'utf8') }),
		})
		expect(prepared.warnings).toEqual([])
		expect(prepared.text).toContain('a,b')
	})
})

test.describe('engine/attachments — upload path resolution', () => {
	test('only /api/upload/<safe-name> urls resolve', () => {
		expect(() => resolveUploadPath('/api/upload/abc.png')).not.toThrow()
		expect(() => resolveUploadPath('https://evil.example/x.png')).toThrow()
		expect(() => resolveUploadPath('/api/upload/../../etc/passwd')).toThrow()
		expect(() => resolveUploadPath('/etc/passwd')).toThrow()
	})

	test('workspace filenames are sanitised', () => {
		expect(safeAttachmentName(attachment({ id: 'abcd1234', filename: '../../evil .pdf' }))).toBe(
			'abcd1234-evil_.pdf',
		)
	})
})
