/**
 * Turns a chat message's attachments into something the Claude Agent SDK will
 * actually deliver to the model.
 *
 * Background: the engine migration (#36) moved chat onto `query()` but kept
 * starting every run with `prompt: body.content ?? ''` — a bare string. The
 * Agent SDK's single-message input mode has no way to carry an image, so every
 * attachment was uploaded, persisted, rendered in the composer, and then
 * dropped on the floor with no warning.
 *
 * How each kind is delivered now:
 *
 *   image/*        Inlined as an Anthropic `image` content block (base64). The
 *                  SDK only accepts content blocks in STREAMING INPUT mode
 *                  (`prompt` as an AsyncIterable<SDKUserMessage>), so a turn
 *                  carrying an image switches the prompt to that form. Verified
 *                  against the installed SDK's own types — `SDKUserMessage.message`
 *                  is an Anthropic Messages API `MessageParam`, so the block
 *                  shape is `{ type:'image', source:{ type:'base64', media_type, data } }`.
 *
 *   application/pdf  Staged into the run's sandbox workspace and handed to the
 *                  agent as a path, not as inlined bytes. Reasons: `pdf_read`
 *                  already accepts a workspace path and shells out to pdftotext,
 *                  so the text arrives clean and only when the agent wants it;
 *                  inlining a 20 MB PDF as base64 would ride along in every
 *                  subsequent turn of a resumed SDK session; and `document`
 *                  blocks are not something the CLI/gateway path is documented
 *                  to accept, whereas a file on disk works identically for
 *                  Claude-native and gateway runs.
 *
 *   small text     text/plain, text/csv and application/json under
 *                  INLINE_TEXT_LIMIT are inlined directly as text — cheaper and
 *                  more reliable than making the agent spend a tool call.
 *
 *   everything else  Staged into the workspace and announced by path.
 *
 *   video/*        Cannot be interpreted by the model on this path at all. It
 *                  still gets staged (so tools can operate on the file) but the
 *                  user is warned rather than left guessing.
 *
 * Anything that cannot be delivered produces a `warnings` entry. The caller is
 * responsible for putting those in front of the user — silently dropping an
 * attachment is the bug this module exists to kill, so every branch that fails
 * to deliver must warn.
 */

import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

export type ChatAttachment = {
	id: string
	filename: string
	mimeType: string
	size: number
	url: string
}

/** The subset of Anthropic content blocks this module emits. */
export type SdkContentBlock =
	| { type: 'text'; text: string }
	| {
			type: 'image'
			source: { type: 'base64'; media_type: SupportedImageType; data: string }
	  }

/** Image media types the Messages API accepts. The upload endpoint allows exactly these. */
export const SUPPORTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
export type SupportedImageType = (typeof SUPPORTED_IMAGE_TYPES)[number]

/**
 * Raw bytes above which an image is refused rather than sent. Base64 inflates by
 * ~4/3 and the API caps a single image at 5 MB encoded, so 3.75 MB raw is the
 * real ceiling. Upload accepts 20 MB, so this is reachable in practice.
 */
export const MAX_IMAGE_BYTES = 3_750_000

/** Text-ish attachments at or below this size are inlined instead of staged. */
export const INLINE_TEXT_LIMIT = 32_000

const INLINE_TEXT_TYPES = new Set(['text/plain', 'text/csv', 'application/json', 'text/markdown'])

/**
 * Filesystem seam. The chat route supplies the real implementations; tests
 * supply fakes so the constructed SDK input can be asserted without a disk, a
 * database or a model call.
 */
export type AttachmentIo = {
	/** Read an uploaded attachment's bytes. */
	read: (attachment: ChatAttachment) => Promise<Buffer>
	/**
	 * Copy the attachment into the run's sandbox workspace. Returns the
	 * workspace-relative path the agent's tools take, or null when this run has
	 * no usable workspace.
	 */
	stage: ((attachment: ChatAttachment, bytes: Buffer) => Promise<string | null>) | null
}

export type PrepareAttachmentsInput = {
	/** The user's typed message. */
	text: string
	attachments: ChatAttachment[] | undefined
	/**
	 * Tool names this run is allowed to call, or null for "unrestricted". Used to
	 * avoid telling the agent to `pdf_read` a file it has no `pdf_read` for.
	 */
	availableTools: ReadonlySet<string> | null
	io: AttachmentIo
}

export type PreparedPrompt = {
	/**
	 * The prompt text, with any staged-file notes appended. Used directly when
	 * `content` is null.
	 */
	text: string
	/**
	 * Content blocks for streaming-input mode. Non-null only when at least one
	 * attachment has to ride inline (today: images) — a text-only turn stays on
	 * the simpler single-message string path so nothing else changes.
	 */
	content: SdkContentBlock[] | null
	/** One entry per attachment that could not be delivered as the user expected. */
	warnings: string[]
}

function normalizeMime(attachment: ChatAttachment): string {
	const declared = (attachment.mimeType ?? '').trim().toLowerCase()
	if (declared) return declared
	const ext = attachment.filename.split('.').pop()?.toLowerCase() ?? ''
	const byExt: Record<string, string> = {
		png: 'image/png',
		jpg: 'image/jpeg',
		jpeg: 'image/jpeg',
		gif: 'image/gif',
		webp: 'image/webp',
		pdf: 'application/pdf',
		txt: 'text/plain',
		md: 'text/markdown',
		csv: 'text/csv',
		json: 'application/json',
	}
	return byExt[ext] ?? 'application/octet-stream'
}

function isSupportedImage(mime: string): mime is SupportedImageType {
	return (SUPPORTED_IMAGE_TYPES as readonly string[]).includes(mime)
}

function describe(attachment: ChatAttachment, mime: string): string {
	return `${attachment.filename || attachment.id} (${mime})`
}

/**
 * Build the SDK prompt for one user turn.
 *
 * Never throws: a read or staging failure becomes a warning, because losing the
 * whole turn over an unreadable upload is worse than answering without it — as
 * long as the user is told.
 */
export async function prepareAttachmentPrompt(input: PrepareAttachmentsInput): Promise<PreparedPrompt> {
	const attachments = input.attachments ?? []
	const baseText = input.text ?? ''
	if (attachments.length === 0) return { text: baseText, content: null, warnings: [] }

	const warnings: string[] = []
	const images: Array<{ label: string; block: SdkContentBlock }> = []
	/** Bullet lines pointing the agent at files staged in its workspace. */
	const notes: string[] = []
	/** Whole small files pasted straight into the prompt. */
	const inlined: string[] = []

	const canUse = (tool: string) => input.availableTools === null || input.availableTools.has(tool)

	/** Stage into the workspace, or warn and return null. Always warns on failure. */
	const stageOrWarn = async (
		attachment: ChatAttachment,
		mime: string,
		bytes: Buffer,
	): Promise<string | null> => {
		if (input.io.stage) {
			try {
				const staged = await input.io.stage(attachment, bytes)
				if (staged) return staged
			} catch (error) {
				warnings.push(
					`${describe(attachment, mime)} was not sent to the model — writing it to the agent workspace failed: ${
						error instanceof Error ? error.message : String(error)
					}`,
				)
				return null
			}
		}
		warnings.push(
			`${describe(attachment, mime)} was not sent to the model — this run has no agent workspace to place the file in.`,
		)
		return null
	}

	for (const attachment of attachments) {
		const mime = normalizeMime(attachment)

		let bytes: Buffer
		try {
			bytes = await input.io.read(attachment)
		} catch (error) {
			warnings.push(
				`${describe(attachment, mime)} could not be read from storage and was not sent to the model: ${
					error instanceof Error ? error.message : String(error)
				}`,
			)
			continue
		}

		// ── Images: inline, the whole point of the fix ─────────────────────────
		if (mime.startsWith('image/')) {
			if (!isSupportedImage(mime)) {
				warnings.push(
					`${describe(attachment, mime)} was not sent to the model — only PNG, JPEG, GIF and WebP images can be viewed.`,
				)
				continue
			}
			if (bytes.length > MAX_IMAGE_BYTES) {
				warnings.push(
					`${describe(attachment, mime)} is ${Math.round(bytes.length / 1024)} KB, over the ${Math.round(
						MAX_IMAGE_BYTES / 1024,
					)} KB per-image limit, so it was not sent to the model. Resize it and attach it again.`,
				)
				continue
			}
			images.push({
				label: attachment.filename || attachment.id,
				block: {
					type: 'image',
					source: { type: 'base64', media_type: mime, data: bytes.toString('base64') },
				},
			})
			continue
		}

		// ── PDFs: hand over a workspace path, let pdf_read do the extraction ───
		if (mime === 'application/pdf') {
			const path = await stageOrWarn(attachment, mime, bytes)
			if (!path) continue
			if (canUse('pdf_read')) {
				notes.push(`- \`${path}\` — PDF "${attachment.filename}". Read it with the \`pdf_read\` tool.`)
			} else {
				warnings.push(
					`${describe(attachment, mime)} was placed in the agent workspace at \`${path}\`, but this agent is not allowed to use the \`pdf_read\` tool, so it cannot read the contents.`,
				)
				notes.push(`- \`${path}\` — PDF "${attachment.filename}" (no PDF reader tool available).`)
			}
			continue
		}

		// ── Small text-ish files: inline them, no tool call needed ─────────────
		if (INLINE_TEXT_TYPES.has(mime) && bytes.length <= INLINE_TEXT_LIMIT) {
			inlined.push(
				`Attached file "${attachment.filename}" (${mime}):\n\n\`\`\`\n${bytes.toString('utf8')}\n\`\`\``,
			)
			continue
		}

		// ── Everything else: stage and announce the path ───────────────────────
		const path = await stageOrWarn(attachment, mime, bytes)
		if (!path) continue
		if (mime.startsWith('video/')) {
			// Staged so tools can touch it, but no model on this path watches video.
			warnings.push(
				`${describe(attachment, mime)} cannot be watched by the model. It was saved to the agent workspace at \`${path}\` so tools can operate on it, but its visual content was not sent.`,
			)
			notes.push(`- \`${path}\` — video "${attachment.filename}". The model cannot view it directly.`)
			continue
		}
		if (canUse('file_read')) {
			notes.push(`- \`${path}\` — attached file "${attachment.filename}" (${mime}). Read it with \`file_read\`.`)
		} else {
			warnings.push(
				`${describe(attachment, mime)} was placed in the agent workspace at \`${path}\`, but this agent has no file-reading tool, so it cannot open it.`,
			)
			notes.push(`- \`${path}\` — attached file "${attachment.filename}" (${mime}).`)
		}
	}

	const sections = [baseText]
	if (notes.length > 0) sections.push(`Attached files, saved in your workspace:\n${notes.join('\n')}`)
	sections.push(...inlined)
	const text = sections.filter((s) => s.trim().length > 0).join('\n\n')

	if (images.length === 0) return { text, content: null, warnings }

	const content: SdkContentBlock[] = [{ type: 'text', text: text || '(no message text)' }]
	for (const image of images) {
		// Labelling matters once there is more than one: without it the model has
		// no way to say which picture it is talking about.
		if (images.length > 1) content.push({ type: 'text', text: `Image: ${image.label}` })
		content.push(image.block)
	}

	return { text, content, warnings }
}

/**
 * Wrap content blocks as the one-message async iterable `query()` wants.
 *
 * Streaming input mode is the only mode that accepts non-string content, and a
 * generator that yields once and returns closes the input stream, so the run
 * behaves like the single-shot call it replaces.
 */
export async function* singleUserMessageStream(
	content: SdkContentBlock[],
): AsyncGenerator<SDKUserMessage> {
	const message = { role: 'user' as const, content } satisfies { role: 'user'; content: SdkContentBlock[] }
	yield {
		type: 'user',
		message: message as unknown as SDKUserMessage['message'],
		parent_tool_use_id: null,
	}
}

/**
 * Render warnings as the markdown notice that goes in front of the user.
 *
 * The chat page has no generic notice channel, so this is prepended to the
 * assistant turn (streamed as a `delta` and persisted with the message) — which
 * means the warning survives a reload rather than vanishing with the stream.
 */
export function formatAttachmentWarnings(warnings: string[]): string {
	if (warnings.length === 0) return ''
	const lines = warnings.map((w) => `> - ${w}`).join('\n')
	return `> **Attachment warning**\n>\n${lines}\n\n`
}
