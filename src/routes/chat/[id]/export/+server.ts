import { error, type RequestHandler } from '@sveltejs/kit'
import { loadConversationForExport } from '$lib/chat/conversation-export.server'
import {
	exportContentDisposition,
	exportConversationJson,
	exportConversationMarkdown,
	exportFileNames,
} from '$lib/chat/conversation-export'

/**
 * #18 — download one conversation: `?format=md` (a readable transcript) or `?format=json`
 * (everything, unshortened).
 *
 * Someone else's conversation answers 404, the same as one that does not exist, so a
 * conversation id says nothing about whether it is real. The session check is here as well
 * as in the hook, so this route stays private if the hook's public-path list ever widens.
 */
export const GET: RequestHandler = async ({ params, url, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized')

	const format = url.searchParams.get('format') ?? 'md'
	if (format !== 'md' && format !== 'json') throw error(400, 'format must be md or json')

	const data = await loadConversationForExport(locals.user.id, params.id ?? '')
	if (!data) throw error(404, 'Conversation not found')

	const exportedAt = new Date()
	const names = exportFileNames(data.conversation.title, exportedAt, format)
	const body =
		format === 'md'
			? exportConversationMarkdown({ ...data, exportedAt })
			: `${JSON.stringify(exportConversationJson({ ...data, exportedAt }), null, 2)}\n`

	return new Response(body, {
		headers: {
			'Content-Type': format === 'md' ? 'text/markdown; charset=utf-8' : 'application/json; charset=utf-8',
			'Content-Disposition': exportContentDisposition(names),
			// Private transcript: never in a shared cache, never reused for a later download.
			'Cache-Control': 'private, no-store',
			'X-Content-Type-Options': 'nosniff',
		},
	})
}
