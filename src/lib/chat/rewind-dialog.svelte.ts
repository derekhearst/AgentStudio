/**
 * #24 — the "also restore files" question an edit or regenerate asks first.
 *
 * Same shape as `confirmDialog`: an awaitable call, and one host component
 * (`RewindPreviewDialog.svelte`) that reads the pending request from module state. The chat
 * page's handlers stay one `await` longer and nothing else.
 *
 * The question is only asked when there is something to answer. A message with no file
 * checkpoint (a chat with no project, an older message), or one whose turn changed no
 * files, goes straight on without restoring — the option is simply not there.
 */

import { previewRewind } from './chat.remote'
import { shouldOfferRestore, type RewindPreview } from './rewind-preview'

export type RestoreChoice = {
	restoreFiles: boolean
	/** The user ticked "overwrite the uncommitted changes" for an imported repository. */
	acknowledgeUncommitted: boolean
}

export type RewindAction = 'edit' | 'regenerate'

type PendingRestore = {
	action: RewindAction
	preview: RewindPreview
	resolve: (choice: RestoreChoice | null) => void
}

export const rewindDialogState = $state<{ pending: PendingRestore | null; checking: boolean }>({
	pending: null,
	checking: false,
})

const NO_RESTORE: RestoreChoice = { restoreFiles: false, acknowledgeUncommitted: false }

/**
 * Ask whether to restore files along with an edit or regenerate at `messageId`.
 *
 * Resolves to the choice, or null when the user cancels — in which case nothing at all
 * should happen. A preview that cannot be fetched goes on without restoring: leaving the
 * files as they are never loses anything.
 */
export async function chooseFileRestore(messageId: string, action: RewindAction): Promise<RestoreChoice | null> {
	let preview: RewindPreview
	rewindDialogState.checking = true
	try {
		preview = await previewRewind({ messageId })
	} catch (error) {
		console.warn('[chat/ui] file restore preview failed', error)
		return NO_RESTORE
	} finally {
		rewindDialogState.checking = false
	}
	if (!shouldOfferRestore(preview)) return NO_RESTORE

	return new Promise<RestoreChoice | null>((resolve) => {
		// A second request while one is open would strand the first. Cancelling it is the safe answer.
		rewindDialogState.pending?.resolve(null)
		rewindDialogState.pending = { action, preview, resolve }
	})
}

/** Called by the host component with the user's answer; null cancels. */
export function settleFileRestore(choice: RestoreChoice | null): void {
	const pending = rewindDialogState.pending
	if (!pending) return
	rewindDialogState.pending = null
	pending.resolve(choice)
}
