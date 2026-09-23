import { listActiveChatRunsForUser } from '$lib/runs'
import { conversationListVersion } from '$lib/chat/conversation-list.server'
import { CONVERSATION_LIST_EVENT } from '$lib/chat/conversation-list-sync'
import { createSseMonitorHandler } from '$lib/runtime/monitor-factory.server'

// Live runs as the unnamed snapshots, plus a signal when the conversation list changed (#79).
export const GET = createSseMonitorHandler(listActiveChatRunsForUser, {
	version: { event: CONVERSATION_LIST_EVENT, read: conversationListVersion },
})
