/**
 * Handing a first message from the page that creates a conversation to the conversation's
 * own page, which sends it.
 *
 * The prompt travels as `/chat/[id]?prompt=…`. That URL used to keep the prompt until the
 * whole first reply had finished, so reloading or restoring the tab while it streamed sent
 * the prompt a second time (#75). The chat page now takes it out of the URL before sending.
 *
 * Attachments cannot ride in the URL, and the home page dropped them (#59): the composer
 * uploaded the file, showed its pill, and then only the text went on. They wait here,
 * in memory and keyed by the new conversation, until that page sends the prompt. A reload
 * in between loses them — but the upload itself is not lost, and it can be attached again.
 */

export type HandoffAttachment = {
	id: string
	filename: string
	mimeType: string
	size: number
	url: string
}

const pendingAttachments = new Map<string, HandoffAttachment[]>()

/** Keep attachments for the conversation's page to send with its first prompt. */
export function handOffAttachments(conversationId: string, attachments: HandoffAttachment[]): void {
	if (attachments.length > 0) pendingAttachments.set(conversationId, [...attachments])
}

/** The attachments handed to this conversation, at most once. */
export function takeHandedOffAttachments(conversationId: string): HandoffAttachment[] {
	const attachments = pendingAttachments.get(conversationId) ?? []
	pendingAttachments.delete(conversationId)
	return attachments
}

/** The same address without its `prompt` parameter. */
export function withoutPromptParam(url: URL): URL {
	const next = new URL(url)
	next.searchParams.delete('prompt')
	return next
}
