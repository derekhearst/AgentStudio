/**
 * #24 — the file-restore preview, as the server returns it and the edit/regenerate dialog
 * reads it. No imports with a runtime, so the browser can load it as well as a spec.
 */

import type { RepoKind } from '$lib/projects/projects.schema'

/** The CLI's answer to `rewindFiles`, as far as the preview reads it. */
export type RewindResultLike = {
	canRewind: boolean
	error?: string
	filesChanged?: string[]
	insertions?: number
	deletions?: number
	skippedLinks?: number
}

export type RewindFile = {
	/** Relative to the workspace, forward slashes. */
	path: string
	/** Git reports uncommitted changes in it — which may be the agent's, or the user's own. */
	uncommitted: boolean
}

export type RewindPreview = {
	/**
	 * Whether this message has a file checkpoint at all. False hides the option: a chat with
	 * no project, a message from before checkpointing, one from an earlier session.
	 */
	available: boolean
	/** Why the files cannot be restored, in plain words, when that is the case. */
	reason: string | null
	/** Whether restoring would do anything and is allowed to. */
	canRewind: boolean
	/** The files a restore would change back, or delete when the turn created them. */
	files: RewindFile[]
	insertions: number
	deletions: number
	/** Paths outside the workspace. Any at all and the restore is refused. */
	outsideWorkspace: string[]
	/** The project's repository kind, when the run stood in its checkout. */
	repoKind: RepoKind | null
	/**
	 * An imported repository with uncommitted changes in files the restore would overwrite.
	 * Restoring then needs an explicit "overwrite them" from the user, checked again on the
	 * server; it is never implied by the default.
	 */
	requiresAcknowledge: boolean
}

/** A preview for a message there is nothing to restore for. */
export function unavailablePreview(reason: string | null = null): RewindPreview {
	return {
		available: false,
		reason,
		canRewind: false,
		files: [],
		insertions: 0,
		deletions: 0,
		outsideWorkspace: [],
		repoKind: null,
		requiresAcknowledge: false,
	}
}

/** A checkpoint exists, but it cannot be used right now. The dialog explains; the restore is off. */
export function blockedPreview(reason: string, repoKind: RepoKind | null = null): RewindPreview {
	return { ...unavailablePreview(reason), available: true, repoKind }
}

/**
 * Whether the dialog is worth showing. Hidden when there is no checkpoint, and when the
 * checkpoint would restore nothing — a turn that changed no files. Shown when a restore is
 * possible, and when a checkpoint exists but cannot be used, so the user learns why.
 */
export function shouldOfferRestore(preview: RewindPreview): boolean {
	if (!preview.available) return false
	return preview.canRewind || preview.reason !== null
}

/** "Also restore files" starts ticked whenever there is something to restore. */
export function restoreByDefault(preview: RewindPreview): boolean {
	return preview.available && preview.canRewind
}

/**
 * Whether the dialog's Continue may be pressed. Restoring over uncommitted changes in an
 * imported repository needs the explicit "overwrite them" box as well; not restoring, or
 * restoring anywhere else, needs nothing more.
 */
export function canContinueRestore(preview: RewindPreview, choice: { restore: boolean; acknowledge: boolean }): boolean {
	if (!choice.restore) return true
	if (!preview.canRewind) return false
	return !preview.requiresAcknowledge || choice.acknowledge
}

/**
 * What to tell the user after a restore, or null when there is nothing to add. The CLI
 * leaves a tracked file alone when a link is in the way — a symlink or hard link at the
 * path, or a parent directory that moved — and only a real restore finds that out, so the
 * dialog may have listed files that were not put back.
 */
export function restoreOutcomeNotice(result: { filesRestored?: number; skippedLinks?: number }): string | null {
	const skipped = Math.max(0, result.skippedLinks ?? 0)
	if (skipped === 0) return null
	const restored = Math.max(0, result.filesRestored ?? 0)
	const total = restored + skipped
	const which =
		skipped === 1
			? 'One was not restored: it is a link, or its folder moved after this message.'
			: `${skipped} were not restored: they are links, or their folders moved after this message.`
	return `Restored ${restored} of ${total} ${total === 1 ? 'file' : 'files'}. ${which}`
}
