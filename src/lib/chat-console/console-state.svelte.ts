// Console shell — shared $state runes store.
// The chat detail page writes here so the right rail (rendered above the page in the
// layout tree) can read it without prop drilling.
//
// #14 cut this down to what the rail still shows. The Activity tab, the Research tab and the
// stats footer are gone: tool activity lives on the run page (/runs/[id]), and the context
// ring and cost sit in the chat's own topbar, so none of that has to cross the layout.

import type { ChangedFile } from './changed-files';

export const consoleState = $state({
	conversationId: null as string | null,
	/** The Files tab: what the agent changed in this chat, newest first. */
	changedFiles: [] as ChangedFile[],
});

/**
 * Forget the conversation — called when its chat page goes away.
 *
 * Pass the id the page was showing. The next chat page can mount before the previous one is
 * torn down, and by then the store already belongs to the new chat; a reset keyed on the old
 * id leaves it alone instead of blanking the rail under the chat that just opened.
 */
export function resetConsoleState(conversationId?: string | null) {
	if (conversationId !== undefined && consoleState.conversationId !== (conversationId || null)) return;
	consoleState.conversationId = null;
	consoleState.changedFiles = [];
}
