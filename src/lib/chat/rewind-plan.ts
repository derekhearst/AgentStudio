/**
 * #24 — mapping the CLI's dry-run answer onto the preview the edit/regenerate dialog shows
 * (`./rewind-preview`). Server side only, for `node:path`; pure otherwise, so a spec can pin
 * it. The project's `git status` goes in alongside, as a set of paths.
 */

import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { RepoKind } from '$lib/projects/projects.schema'
import { blockedPreview, type RewindFile, type RewindPreview, type RewindResultLike } from './rewind-preview'

const toSlashes = (path: string) => path.split(sep).join('/')

/**
 * The workspace-relative path of `file`, or null when it is outside the workspace. The CLI
 * reports absolute paths; a relative one is taken against the workspace, as the CLI would.
 */
export function workspaceRelative(workspaceRoot: string, file: string): string | null {
	const root = resolve(workspaceRoot)
	const absolute = isAbsolute(file) ? resolve(file) : resolve(root, file)
	const rel = relative(root, absolute)
	if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
	return toSlashes(rel)
}

/**
 * The arguments `uncommittedPaths` runs git with. `-z` so a path with spaces or quotes comes
 * back as it is, `--untracked-files=all` so a new file inside a new directory is listed by
 * name rather than as the directory, `--no-renames` so every entry is exactly one path.
 */
export function uncommittedStatusArgs(repoPath: string): string[] {
	return ['-C', repoPath, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']
}

/**
 * The paths `git status --porcelain=v1 -z` lists: changed, staged, deleted and untracked
 * files alike, relative to the repository root. An untracked file counts — a restore that
 * deletes it deletes something git never had a copy of.
 */
export function parseUncommittedPaths(stdout: string): Set<string> {
	const paths = new Set<string>()
	for (const entry of stdout.split('\0')) {
		// "XY path": two status letters, a space, the path.
		if (entry.length > 3) paths.add(entry.slice(3))
	}
	return paths
}

/** Whether git lists `path`, or a directory it sits in (`dir/`, as git lists a whole new directory). */
function listedAsUncommitted(path: string, uncommitted: ReadonlySet<string>): boolean {
	if (uncommitted.has(path)) return true
	const parts = path.split('/')
	for (let i = 1; i < parts.length; i++) {
		if (uncommitted.has(`${parts.slice(0, i).join('/')}/`)) return true
	}
	return false
}

/**
 * The CLI's refusals, in the words the dialog uses. Its own text is kept for anything else:
 * an unfamiliar reason is still better than none.
 */
export function describeRewindRefusal(error: string | undefined): string {
	const text = error?.trim() ?? ''
	if (/no file checkpoint found/i.test(text)) {
		return 'There is no saved copy of the files from before this message. The conversation may have been compacted since, or the copy has expired.'
	}
	if (/file rewinding is not enabled/i.test(text)) return 'File checkpoints were not turned on for this message.'
	return text || 'These files cannot be restored.'
}

/**
 * Map a dry run onto the preview.
 *
 * `uncommittedPaths` is the set of workspace-relative paths `git status` lists, or null when
 * the workspace is not a git checkout (nothing to compare against).
 */
export function mapRewindPreview(input: {
	result: RewindResultLike
	workspaceRoot: string
	uncommittedPaths: ReadonlySet<string> | null
	repoKind: RepoKind | null
}): RewindPreview {
	const { result } = input
	if (!result.canRewind) return blockedPreview(describeRewindRefusal(result.error), input.repoKind)

	const files: RewindFile[] = []
	const outsideWorkspace: string[] = []
	for (const file of result.filesChanged ?? []) {
		const rel = workspaceRelative(input.workspaceRoot, file)
		if (rel === null) outsideWorkspace.push(file)
		else files.push({ path: rel, uncommitted: input.uncommittedPaths ? listedAsUncommitted(rel, input.uncommittedPaths) : false })
	}
	files.sort((a, b) => a.path.localeCompare(b.path))

	const outside = outsideWorkspace.length > 0
	return {
		available: true,
		reason: outside ? 'Some of these files are outside the workspace, so nothing will be restored.' : null,
		canRewind: !outside && files.length > 0,
		files,
		insertions: result.insertions ?? 0,
		deletions: result.deletions ?? 0,
		outsideWorkspace,
		repoKind: input.repoKind,
		requiresAcknowledge: input.repoKind === 'imported' && files.some((file) => file.uncommitted),
	}
}
