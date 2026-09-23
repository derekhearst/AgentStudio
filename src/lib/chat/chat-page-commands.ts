import { setConversationPermissionMode } from '$lib/chat/chat.remote'
import type { ConversationPermissionMode } from '$lib/engine/permission-mode'
import {
	compactCommand,
	planModeCommand,
	researchCommand,
	type ComposerCommand,
} from '$lib/chat/composer-commands'

/**
 * #22 — the `/` commands only a conversation page can offer, wired to the handlers its own
 * buttons use. Kept out of the page so the page passes one prop.
 *
 * - `/compact` is the context meter's Compact button (a summarise-this-conversation turn).
 * - `/research <question>` is the page's Deep Research trigger.
 * - `/plan` flips the permission-mode chip between Plan only and Ask, through the same
 *   command the chip calls. It never switches to Bypass, which needs the chip's confirm.
 */
export function buildChatPageCommands(input: {
	conversationId: string
	permissionMode: () => unknown
	onPermissionModeChange: (mode: ConversationPermissionMode) => void
	compact: () => Promise<void> | void
	research: (question: string) => Promise<void> | void
}): ComposerCommand[] {
	return [
		compactCommand(input.compact),
		researchCommand(input.research),
		planModeCommand({
			current: input.permissionMode,
			async setMode(mode) {
				await setConversationPermissionMode({ conversationId: input.conversationId, mode, confirmed: false })
				input.onPermissionModeChange(mode)
			},
		}),
	]
}
