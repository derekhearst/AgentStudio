/**
 * Plain `ToolCall` type used by every handler module. Lives in its own file so handler
 * modules don't have to round-trip through the server-only `tools.server.ts` barrel just
 * to import this trivial shape (which would create a tangle of circular imports).
 */

import type { ToolName } from './tool-schemas'

export type ToolCall = {
	name: ToolName
	arguments: unknown
}

export type ToolCallWithContext = ToolCall & {
	conversationId?: string | null
	messageId?: string | null
}
