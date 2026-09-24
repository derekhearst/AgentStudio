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
 * - `/compact` is the context meter's Compact button, which sends the CLI's own `/compact`
 *   (`$lib/chat/compact-command`, #24): the SDK summarises and restarts the session from it.
 * - `/research <question>` is the page's Deep Research trigger.
 * - `/plan` flips the permission-mode chip between Plan only and Ask, through the same
 *   command the chip calls. It never switches to Bypass, which needs the chip's confirm.
 *
 * The message box can be open while a reply is still running: an ask_user question pauses the
 * turn and hands the box back. `/compact` and `/plan` then say why they cannot run, as their
 * buttons are disabled (the chip) or do nothing (Compact) until the reply ends.
 */
export function buildChatPageCommands(input: {
	conversationId: string
	/** A reply is running on this page, paused on a question or not. */
	streaming: () => boolean
	permissionMode: () => unknown
	onPermissionModeChange: (mode: ConversationPermissionMode) => void
	compact: () => Promise<void> | void
	research: (question: string) => Promise<void> | void
}): ComposerCommand[] {
	return [
		compactCommand(input.compact, { replyRunning: input.streaming }),
		researchCommand(input.research),
		planModeCommand({
			current: input.permissionMode,
			replyRunning: input.streaming,
			async setMode(mode) {
				await setConversationPermissionMode({ conversationId: input.conversationId, mode, confirmed: false })
				input.onPermissionModeChange(mode)
			},
		}),
	]
}
