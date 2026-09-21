import { error, type RequestHandler } from '@sveltejs/kit'
import { PreviewError, readRawBytes, resolveConversationWorkspace } from '$lib/chat-console/preview.server'

/**
 * #29 — raw bytes for the rail preview (images and PDFs only).
 *
 * Everything this route serves is agent-written content, so:
 *   - the path is resolved through the conversation's sandbox workspace and
 *     validated with `safePathWithin`; absolute paths outside the caller's own
 *     `<sandbox>/<userId>` tree are refused;
 *   - only an image/PDF allowlist is served. HTML and SVG are deliberately not
 *     here — serving them inline from our origin would be same-origin script
 *     execution for whatever the agent (or a page it scraped) wrote;
 *   - `nosniff` plus an explicit `Content-Type` stops the browser from
 *     upgrading a mislabelled file into something executable.
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized')

	const conversationId = url.searchParams.get('conversationId')
	const path = url.searchParams.get('path')
	if (!conversationId || !path) throw error(400, 'conversationId and path are required')

	try {
		const workspace = await resolveConversationWorkspace(conversationId, locals.user.id)
		const file = await readRawBytes(workspace, path)

		const headers: Record<string, string> = {
			'Content-Type': file.contentType,
			'Content-Length': String(file.body.byteLength),
			'X-Content-Type-Options': 'nosniff',
			// Workspace files are per-user and mutate under the agent's feet; a shared
			// cache must never hold them and a reload must see the new bytes.
			'Cache-Control': 'private, no-store',
			'Content-Disposition': `inline; filename="${encodeURIComponent(file.filename)}"`,
		}
		if (file.sandboxed) {
			headers['Content-Security-Policy'] = "default-src 'none'; sandbox"
		}

		return new Response(new Uint8Array(file.body), { headers })
	} catch (err) {
		if (err instanceof PreviewError) throw error(err.status, err.message)
		const message = err instanceof Error ? err.message : String(err)
		if (/escapes sandbox workspace/i.test(message)) throw error(403, 'Path is outside this chat’s workspace')
		throw error(500, 'Preview failed')
	}
}
