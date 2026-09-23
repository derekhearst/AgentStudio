/**
 * Keeping the cached conversation list current (#79).
 *
 * The sidebar and the home page read `getConversations`, a remote query cached for the
 * session. Nothing refreshed it, so a new chat never appeared in either, its generated title
 * never replaced "New conversation", and the order never moved until a hard reload. The chat
 * monitor (`/api/chat/monitor`) now also sends a named event carrying a fingerprint of the
 * list (`conversationListVersion`), and a page that shows the list refreshes the query when
 * that fingerprint moves.
 *
 * Shared by the server route (the event name) and the browser, so it imports nothing.
 */

export const CONVERSATION_LIST_EVENT = 'conversations'

/**
 * The last fingerprint any listener in this tab acted on. Module-wide, so the sidebar and
 * the home page — both listening on the home page — refresh the shared query once, not twice.
 */
let lastSeen: string | null = null

/**
 * Call `refresh` whenever the monitor reports a changed list. The first fingerprint a tab
 * sees refreshes too: the list was read a moment before the monitor connected, and a chat
 * created in between would otherwise wait for the next change to show.
 */
export function onConversationListChange(source: EventSource, refresh: () => Promise<unknown>): () => void {
	const listener = (event: MessageEvent) => {
		let version: unknown
		try {
			version = (JSON.parse(event.data) as { version?: unknown }).version
		} catch {
			return
		}
		if (typeof version !== 'string' || version === lastSeen) return
		lastSeen = version
		void refresh().catch(() => {})
	}
	source.addEventListener(CONVERSATION_LIST_EVENT, listener)
	return () => source.removeEventListener(CONVERSATION_LIST_EVENT, listener)
}
